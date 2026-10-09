// The continual harness extension: Prime Agent's self-edited memory layer,
// hosted on Pi Durable. The entries live in Prime's `harness_state.json`
// files, shared with the kernel's `rlm.harness` calls. This extension renders
// them into the system prompt, keeps the refinement history in a document,
// and schedules the refinement task at turn boundaries and on request.

import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import {
	defineDoc,
	defineExtension,
	GenerationTask,
	hook,
	section,
	type ConversationId,
	type Extension,
	type Harness,
	type TaskId,
} from "@earendil-works/pi-durable";
import { createRefineTask, type RefineInput, type RefineResult } from "./refine.ts";
import { formatForPrompt, loadState, mergeStates, type HarnessScope, type RefinementResult } from "./state.ts";

export type ContinualState = {
	/** Applied refinements, newest last; the source for rollbacks and the refiner's history. */
	results: RefinementResult[];
	/** The live refinement task for this conversation, so at most one runs at a time. */
	pendingTaskId: number | null;
	turnsSinceReview: number;
};

export const ContinualDoc = defineDoc<ContinualState>({
	kind: "standard.continual",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ results: [], pendingTaskId: null, turnsSinceReview: 0 }),
});

export interface ContinualOptions {
	/** The kernel state directory; local state is `<stateDir>/<conversation>/harness`, global is `<stateDir>/agent/harness`. */
	readonly stateDir: string;
	/** Review for refinement every this many answered turns; 0 disables automatic refinement. Default 4. */
	readonly reviewEvery?: number;
}

export interface RefineRequest {
	scope?: HarnessScope;
	instructions?: string;
	rollbackId?: string;
	trigger?: string;
}

export interface ContinualExtension {
	readonly extension: Extension;
	/** Give the extension the open harness; needed to schedule tasks from hooks and host requests. */
	attach(harness: Harness): void;
	/** Start a refinement for a conversation; resolves to the task, or undefined if one is already running. */
	refine(conversationId: ConversationId, request: RefineRequest, context: Context): Promise<TaskId<RefineResult> | undefined>;
	/** Answers the kernel's `refine.run` and `refine.status` host requests. */
	hostRequest(conversationId: ConversationId, data: Record<string, unknown>, context: Context): Promise<unknown>;
}

const CONTINUAL_USAGE = [
	"The continual harness is your editable memory: prompt notes, memories, skills, and subagent specs that persist outside the transcript. Local entries belong to this conversation; global entries persist across conversations.",
	"Edit it from the REPL with `rlm.harness`: `rlm.harness.create_memory(title, content)`, `update_memory(id, ...)`, `delete_memory(id)`, and the same for `create_prompt_note`, `create_skill` (needs `reference={'type': 'python', 'import': ..., 'callable': ...}` and `arguments`), and `create_subagent`. `rlm.harness.overview()` lists everything; `rlm.harness.search(query)` finds entries. Pass `global_=True` only for stable cross-conversation lessons; `global` is a Python keyword, so `global_` is the argument name.",
	"Record what will matter later: a user preference or correction, a durable fact about the environment, a tactic that worked after a failure. Do not record one-off results. Entries shown in the next section are compact summaries; call `rlm.harness.get(kind, id)` when the detail matters.",
].join("\n");

export function createContinualExtension(options: ContinualOptions): ContinualExtension {
	const reviewEvery = options.reviewEvery ?? 4;
	const dirs = {
		local: (conversationId: number) => join(options.stateDir, String(conversationId), "harness"),
		global: () => join(options.stateDir, "agent", "harness"),
	};
	let harness: Harness | undefined;

	const Refine = createRefineTask(dirs, {
		read: async (conversationId, context) => {
			if (harness === undefined) return [];
			const state = await harness.snapshot(ContinualDoc, conversationId as ConversationId, context);
			return state?.results ?? [];
		},
		record: async (conversationId, result, tx) => {
			const doc = await (tx as { doc(token: typeof ContinualDoc, id: ConversationId): Promise<ContinualState> }).doc(ContinualDoc, conversationId as ConversationId);
			if (!doc.results.some((item) => item.id === result.id)) doc.results.push(result);
			doc.pendingTaskId = null;
		},
	});

	async function schedule(conversationId: ConversationId, input: RefineInput, context: Context): Promise<TaskId<RefineResult> | undefined> {
		if (harness === undefined) throw new Error("continual extension is not attached to a harness");
		const conversation = await harness.conversation(conversationId, context);
		if (conversation === undefined) return undefined;
		return conversation.commit(async (tx) => {
			const doc = await tx.doc(ContinualDoc, conversationId);
			if (doc.pendingTaskId !== null) {
				const live = await tx.task(doc.pendingTaskId as TaskId);
				if (live !== undefined && live.state.status !== "terminal") return undefined;
			}
			const taskId = await tx.createTask(Refine, input, { ownership: { kind: "conversation" }, background: true });
			doc.pendingTaskId = taskId;
			doc.turnsSinceReview = 0;
			return taskId;
		}, context);
	}

	const extension = defineExtension({
		name: "continual",
		tasks: [Refine],
		sections: [
			// Static, so it stays in the provider's prompt cache. The entries render separately below.
			section("continual-harness-usage", () => CONTINUAL_USAGE),
			section("continual-harness", (input) => {
				const local = loadState(dirs.local(input.conversationId), "local");
				const global = loadState(dirs.global(), "global");
				return formatForPrompt(mergeStates(global, local));
			}),
		],
		hooks: [
			hook(GenerationTask, {
				onYield: (_answer, api) => {
					if (reviewEvery <= 0 || harness === undefined) return undefined;
					const target = harness;
					const conversationId = api.conversationId;
					// Not inside the hook: the turn's own commit must not wait on this.
					setImmediate(() => {
						void (async () => {
							const conversation = await target.conversation(conversationId, BACKGROUND);
							if (conversation === undefined) return;
							const due = await conversation.commit(async (tx) => {
								const doc = await tx.doc(ContinualDoc, conversationId);
								doc.turnsSinceReview += 1;
								return doc.turnsSinceReview >= reviewEvery ? doc.turnsSinceReview : 0;
							}, BACKGROUND);
							if (due > 0) await schedule(conversationId, { scope: "local", trigger: "turn_interval", auto: true, turnsSinceReview: due, instructions: null, rollbackId: null }, BACKGROUND);
						})().catch((error) => console.error(`[standard] continual: ${error instanceof Error ? error.message : String(error)}`));
					});
					return undefined;
				},
			}),
		],
	});

	return {
		extension,
		attach: (value) => {
			harness = value;
		},
		refine: (conversationId, request, context) =>
			schedule(
				conversationId,
				{
					scope: request.scope ?? "local",
					trigger: request.trigger ?? "requested",
					auto: false,
					turnsSinceReview: 0,
					instructions: request.instructions ?? null,
					rollbackId: request.rollbackId ?? null,
				},
				context,
			),
		hostRequest: async (conversationId, data, context) => {
			switch (data.type) {
				case "refine.run": {
					const taskId = await schedule(
						conversationId,
						{
							scope: data.global === true ? "global" : "local",
							trigger: "requested from REPL",
							auto: false,
							turnsSinceReview: 0,
							instructions: typeof data.instructions === "string" ? data.instructions : null,
							rollbackId: typeof data.rollback_id === "string" ? data.rollback_id : null,
						},
						context,
					);
					return { queued: taskId !== undefined, taskId: taskId ?? null };
				}
				case "refine.status": {
					const state = harness === undefined ? undefined : await harness.snapshot(ContinualDoc, conversationId, context);
					return { pending: state?.pendingTaskId ?? null, results: (state?.results ?? []).slice(-5) };
				}
				default:
					throw new Error(`host request ${String(data.type)} is not supported`);
			}
		},
	};
}

