// The subagents extension: Prime Agent's `rlm.spawn` and friends, answered
// with Pi Durable child conversations. Each child is a copy of the parent's
// agent with its own kernel, owned by a background anchor task of the parent
// (see task.ts), and recorded in the parent's `standard.subagents` document.
// Spawning returns once that commit lands; `rlm.collect` waits on the
// document, bounded by its timeout. Nothing here keeps the parent's run busy.

import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import {
	configure,
	defineExtension,
	section,
	type AgentChange,
	type ConversationId,
	type Extension,
	type Harness,
} from "@earendil-works/pi-durable";
import type { HostRequestOrigin } from "../kernel/extension.ts";
import {
	anchorOf,
	collectRow,
	conversationIdOf,
	defaultName,
	findChild,
	labelOf,
	nameTaken,
	spawnHandle,
	SubagentsDoc,
	subagentRow,
	validateName,
	type SubagentRecord,
	type SubagentsState,
} from "./state.ts";
import { SubagentAnchor, TASK_LABEL } from "./task.ts";

export interface SubagentsOptions {
	/** The kernel state directory; a child's session dir is `<stateDir>/<conversation>`. */
	readonly stateDir: string;
	readonly models: Models;
	/** Deepest level that may exist; an agent at this depth cannot spawn. Default 3. */
	readonly maxDepth?: number;
}

export interface SubagentsExtension {
	readonly extension: Extension;
	attach(harness: Harness): void;
	/** `RLM_DEPTH` and `RLM_MAX_DEPTH` for a conversation's kernel. */
	kernelEnv(conversationId: ConversationId, context: Context): Promise<Record<string, string>>;
	/** Answers the kernel's `rlm.*` host requests. */
	hostRequest(origin: HostRequestOrigin, data: Record<string, unknown>, context: Context): Promise<unknown>;
}

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROGRESS_NOTE_INTERVAL_MS = 10_000;

const SPAWN_GUIDANCE = [
	"Delegate independent, self-contained work to subagents from the REPL: `child = await rlm.spawn('task', name='api-reviewer')`. It returns at admission, not completion, with `rlm_child_id`, `name`, `session_dir`, and `model`. A child is a copy of you with its own REPL; it does not see this conversation, so put everything it needs in the task.",
	"Names must be unique among your direct children. A child inherits your model and thinking level; pass `model=` only when a different model is explicitly needed, with an exact selector from `await rlm.find_models('query')`, and `thinking=` to change the reasoning level.",
	"Results come back only through `results = await rlm.collect(child, timeout_ms=60000)` (a handle, a name, a list of them, or nothing for all children). Each result has `status` (`running`, `done`, `error`, `cancelled`), `settled`, `answer_preview` (the child's final answer), and `error`. A timeout returns current snapshots, never an error; a finished child's result stays available until you delete it.",
	"Spawn independent children in separate calls before collecting so they run in parallel. Collect with a bounded timeout; when children are long-running, end your turn and collect in a later turn instead of busy-waiting. `await rlm.list_subagents()` recovers handles after a restart; `await rlm.delete_subagent(child)` stops and removes a child you no longer need.",
	"Delegate parallel, context-heavy research or independent work; do a single known lookup, edit, or command yourself. Have children write large outputs to files and read those files for fan-in.",
].join("\n");

function childGuidance(state: Readonly<SubagentsState>, name: string): string {
	return [
		`You are the subagent "${name}", spawned by a parent agent (depth ${state.depth}). Your task arrives labeled \`${TASK_LABEL}\`.`,
		"Your final answer is returned to the parent as is, so make it complete and self-contained. On long tasks, report brief progress with `await rlm.progress_note('...')`.",
	].join("\n");
}

const selectorOf = (value: unknown, what: string): string => {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${what} must be a non-empty string`);
	return value.trim();
};

export function createSubagentsExtension(options: SubagentsOptions): SubagentsExtension {
	const maxDepth = options.maxDepth ?? 3;
	const { stateDir, models } = options;
	let attached: Harness | undefined;

	const harness = (): Harness => {
		if (attached === undefined) throw new Error("subagents extension is not attached to a harness");
		return attached;
	};
	const stateOf = async (conversationId: ConversationId, context: Context): Promise<Readonly<SubagentsState> | undefined> =>
		harness().snapshot(SubagentsDoc, conversationId, context);
	const requireChild = (state: Readonly<SubagentsState> | undefined, selector: string): SubagentRecord => {
		const child = findChild(state, selector);
		if (child === undefined) throw new Error(`no subagent "${selector}" under this agent`);
		return child;
	};

	async function spawn(origin: HostRequestOrigin, data: Record<string, unknown>, context: Context) {
		const parentId = origin.conversationId;
		const parent = await harness().conversation(parentId, context);
		if (parent === undefined) throw new Error(`conversation ${parentId} not found`);
		const self = await stateOf(parentId, context);
		const depth = self?.depth ?? 0;
		if (depth >= maxDepth) {
			throw new Error(`RLM recursion depth limit reached (RLM_DEPTH=${depth}, RLM_MAX_DEPTH=${maxDepth}): this agent cannot spawn subagents; do the work directly`);
		}
		// A repeat of the same call returns the child it already made.
		const repeat = origin.callKey === undefined ? undefined : Object.values(self?.children ?? {}).find((child) => child.spawnKey === origin.callKey);
		if (repeat !== undefined) return spawnHandle(stateDir, repeat);

		if (typeof data.prompt !== "string" || data.prompt.trim().length === 0) throw new Error("prompt must be a non-empty string");
		const prompt = data.prompt;
		const kwargs = (typeof data.kwargs === "object" && data.kwargs !== null ? data.kwargs : {}) as Record<string, unknown>;

		const agent = await parent.agent(context);
		const change: { model?: AgentChange["model"]; thinkingLevel?: AgentChange["thinkingLevel"] } = {};
		let modelRef = agent.model;
		if (kwargs.model !== undefined && kwargs.model !== null) {
			const selector = selectorOf(kwargs.model, "model");
			const slash = selector.indexOf("/");
			const ref = slash <= 0 ? undefined : { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
			if (ref === undefined || models.getModel(ref.provider, ref.modelId) === undefined) {
				throw new Error(`model "${selector}" is not available; pick an exact selector from rlm.find_models(), or omit model to inherit yours`);
			}
			modelRef = ref;
			change.model = ref;
		}
		if (modelRef === undefined) throw new Error("this agent has no model for a subagent to inherit; pass model=");
		if (kwargs.thinking !== undefined && kwargs.thinking !== null) {
			const level = selectorOf(kwargs.thinking, "thinking");
			if (!THINKING_LEVELS.includes(level)) throw new Error(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
			const model = models.getModel(modelRef.provider, modelRef.modelId);
			if (model !== undefined && !getSupportedThinkingLevels(model).includes(level as ModelThinkingLevel)) {
				throw new Error(`thinking level "${level}" is not supported by ${modelRef.provider}/${modelRef.modelId}`);
			}
			change.thinkingLevel = level as ModelThinkingLevel;
		}

		const childId = `sub-${(origin.callKey === undefined ? randomUUID().replace(/-/g, "") : createHash("sha256").update(`${parentId}:${origin.callKey}`).digest("hex")).slice(0, 8)}`;
		const name = kwargs.name === undefined || kwargs.name === null ? defaultName(prompt, childId) : validateName(kwargs.name);
		const now = Date.now();

		const created = await parent.commit(async (tx) => {
			const state = await tx.doc(SubagentsDoc, parentId);
			const existing = origin.callKey === undefined ? undefined : Object.values(state.children).find((child) => child.spawnKey === origin.callKey);
			if (existing !== undefined) return { record: { ...existing } };
			if (nameTaken(state, name)) return { error: `Agent name "${name}" is unavailable: a subagent of that name already exists under this parent` };
			const anchor = await tx.createTask(SubagentAnchor, { childId, prompt }, { ownership: { kind: "conversation" }, background: true });
			// Owned by a task of the parent: starts as a copy of the parent's agent.
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			if (change.model !== undefined || change.thinkingLevel !== undefined) await configure(tx, child.id, change);
			const childState = await tx.doc(SubagentsDoc, child.id);
			childState.depth = depth + 1;
			childState.parent = { conversationId: parentId, childId };
			const record: SubagentRecord = {
				childId,
				name,
				conversationId: child.id,
				anchorTaskId: anchor,
				spawnKey: origin.callKey ?? null,
				model: `${modelRef.provider}/${modelRef.modelId}`,
				label: labelOf(prompt),
				status: "running",
				deleted: false,
				answer: null,
				error: null,
				progressNote: null,
				progressNoteAt: null,
				createdAt: now,
				updatedAt: now,
				settledAt: null,
			};
			state.children[childId] = record;
			return { record };
		}, context);
		if ("error" in created) throw new Error(created.error);
		return spawnHandle(stateDir, created.record);
	}

	async function collect(origin: HostRequestOrigin, data: Record<string, unknown>, context: Context) {
		const parentId = origin.conversationId;
		const targets = Array.isArray(data.targets) ? data.targets.map((target) => selectorOf(target, "collect target")) : [];
		const timeoutMs = typeof data.timeout_ms === "number" && data.timeout_ms > 0 ? data.timeout_ms : 0;
		const select = (state: Readonly<SubagentsState> | undefined): SubagentRecord[] =>
			targets.length === 0 ? Object.values(state?.children ?? {}).filter((child) => !child.deleted) : targets.map((target) => requireChild(state, target));

		let selected = select(await stateOf(parentId, context));
		if (timeoutMs > 0 && selected.some((child) => child.status === "running")) {
			const ids = selected.map((child) => child.childId);
			const settledIn = (state: Readonly<SubagentsState> | null) => ids.every((id) => state?.children[id]?.status !== "running");
			const watch = await harness().watchDoc(SubagentsDoc, parentId, context);
			if (watch !== undefined) {
				let timer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						new Promise<void>((resolve) => {
							if (settledIn(watch.value)) resolve();
							watch.start(async (value) => {
								if (settledIn(value)) resolve();
							});
						}),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, timeoutMs);
						}),
						watch.closed,
					]);
				} finally {
					clearTimeout(timer);
					await watch.stop();
				}
			}
			selected = select(await stateOf(parentId, context));
		}
		const now = Date.now();
		return { results: selected.map((child) => collectRow(stateDir, child, now)) };
	}

	async function remove(origin: HostRequestOrigin, data: Record<string, unknown>, context: Context) {
		const parentId = origin.conversationId;
		const target = requireChild(await stateOf(parentId, context), selectorOf(data.target, "target"));
		const h = harness();
		const anchor = await h.getTask(anchorOf(target), context);
		if (anchor !== undefined && anchor.state.status !== "terminal") await h.abortTask(anchorOf(target), context);
		// Work started in the child after its anchor finished is not reached through the anchor.
		await (await h.conversation(conversationIdOf(target), context))?.abort(context);
		const record = await h.commit(async (tx) => {
			const current = (await tx.doc(SubagentsDoc, parentId)).children[target.childId]!;
			const now = Date.now();
			if (current.status === "running") {
				current.status = "cancelled";
				current.settledAt = now;
			}
			current.deleted = true;
			current.updatedAt = now;
			return { ...current };
		}, context);
		return { subagent: subagentRow(stateDir, record, Date.now()) };
	}

	async function rename(origin: HostRequestOrigin, data: Record<string, unknown>, context: Context) {
		const name = validateName(data.name);
		const self = await stateOf(origin.conversationId, context);
		// A child id, or this agent itself; a renamed child keeps its id.
		let parentId: ConversationId;
		let childId: string;
		if (data.session_id !== undefined && data.session_id !== null) {
			const selector = selectorOf(data.session_id, "session_id");
			const child = Object.values(self?.children ?? {}).find((each) => !each.deleted && (each.childId === selector || String(each.conversationId) === selector));
			if (child === undefined) throw new Error(`no subagent with id "${selector}" under this agent`);
			parentId = origin.conversationId;
			childId = child.childId;
		} else if (self?.parent != null) {
			parentId = self.parent.conversationId as ConversationId;
			childId = self.parent.childId;
		} else {
			await harness().commit(async (tx) => {
				(await tx.doc(SubagentsDoc, origin.conversationId)).name = name;
			}, context);
			return { name };
		}
		const error = await harness().commit(async (tx) => {
			const state = await tx.doc(SubagentsDoc, parentId);
			const record = state.children[childId];
			if (record === undefined || record.deleted) return `subagent ${childId} no longer exists`;
			if (nameTaken(state, name, childId)) return `Agent name "${name}" is unavailable: a sibling already has it`;
			record.name = name;
			record.updatedAt = Date.now();
			return undefined;
		}, context);
		if (error !== undefined) throw new Error(error);
		return { name };
	}

	async function progressNote(origin: HostRequestOrigin, data: Record<string, unknown>, context: Context) {
		const message = selectorOf(data.message, "message");
		const self = await stateOf(origin.conversationId, context);
		if (self?.parent == null) return { accepted: true };
		const parent = self.parent;
		return harness().commit(async (tx) => {
			const record = (await tx.doc(SubagentsDoc, parent.conversationId as ConversationId)).children[parent.childId];
			if (record === undefined) return { accepted: false };
			const now = Date.now();
			if (record.progressNoteAt !== null && now - record.progressNoteAt < PROGRESS_NOTE_INTERVAL_MS) {
				return { accepted: false, retry_after_ms: PROGRESS_NOTE_INTERVAL_MS - (now - record.progressNoteAt) };
			}
			record.progressNote = message;
			record.progressNoteAt = now;
			record.updatedAt = now;
			return { accepted: true };
		}, context);
	}

	async function findModels(data: Record<string, unknown>) {
		const query = typeof data.query === "string" ? data.query.trim().toLowerCase() : "";
		const limit = typeof data.limit === "number" && data.limit > 0 ? data.limit : 8;
		const available = await models.getAvailable();
		const matches = available
			.map((model) => ({ provider: model.provider, id: model.id, name: model.name || model.id, selector: `${model.provider}/${model.id}` }))
			.filter((model) => query.length === 0 || `${model.selector} ${model.name}`.toLowerCase().includes(query));
		return { models: matches.slice(0, limit) };
	}

	const extension = defineExtension({
		name: "subagents",
		tasks: [SubagentAnchor],
		sections: [
			section("subagents", async (input, context) => {
				const state = await input.read.snapshot(SubagentsDoc, input.conversationId, context);
				const depth = state?.depth ?? 0;
				const parts: string[] = [];
				if (state?.parent != null) {
					const parentState = await input.read.snapshot(SubagentsDoc, state.parent.conversationId as ConversationId, context);
					parts.push(childGuidance(state, parentState?.children[state.parent.childId]?.name ?? state.parent.childId));
				}
				parts.push(depth < maxDepth ? SPAWN_GUIDANCE : `You are at the maximum subagent depth (${maxDepth}) and cannot spawn subagents; do the work yourself.`);
				return parts.join("\n\n");
			}),
		],
	});

	return {
		extension,
		attach: (value) => {
			attached = value;
		},
		kernelEnv: async (conversationId, context) => {
			const state = attached === undefined ? undefined : await stateOf(conversationId, context);
			return { RLM_DEPTH: String(state?.depth ?? 0), RLM_MAX_DEPTH: String(maxDepth) };
		},
		hostRequest: async (origin, data, context) => {
			switch (data.type) {
				case "rlm.run":
					return spawn(origin, data, context);
				case "rlm.collect":
					return collect(origin, data, context);
				case "rlm.list_subagents": {
					const now = Date.now();
					const children = Object.values((await stateOf(origin.conversationId, context))?.children ?? {}).filter((child) => !child.deleted);
					return { subagents: children.map((child) => subagentRow(stateDir, child, now)) };
				}
				case "rlm.delete_subagent":
					return remove(origin, data, context);
				case "rlm.rename":
					return rename(origin, data, context);
				case "rlm.progress.note":
					return progressNote(origin, data, context);
				case "rlm.find_models":
					return findModels(data);
				default:
					throw new Error(`host request ${String(data.type)} is not supported by this host`);
			}
		},
	};
}
