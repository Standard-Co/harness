// The refinement task: a two-phase durable task that improves the continual
// harness from the conversation so far. `plan` makes one model call and
// checkpoints the proposal; `apply` re-reads the file, rejects edits whose
// entries changed meanwhile, writes the file, and records the result. A
// process that dies between the phases resumes at `apply` without planning
// twice.

import type { Context } from "@earendil-works/chord";
import type { Message, Model } from "@earendil-works/pi-ai";
import { defineTask } from "@earendil-works/pi-durable";
import {
	applyProposal,
	historyForRefiner,
	loadState,
	mergeStates,
	overviewForRefiner,
	parseProposal,
	rollbackProposal,
	saveState,
	type HarnessScope,
	type HarnessState,
	extractJsonObject,
	type RefinementProposal,
	type RefinementResult,
} from "./state.ts";

export type RefineInput = {
	scope: HarnessScope;
	trigger: string;
	/** Automatic checkpoints go through the review gate first. */
	auto: boolean;
	turnsSinceReview: number;
	instructions: string | null;
	rollbackId: string | null;
};

export type RefineResult = RefinementResult | { skipped: true; rationale: string };

export type RefineCheckpoint =
	| { phase: "review" }
	| { phase: "plan"; instructions: string | null }
	| { phase: "apply"; id: string; proposal: RefinementProposal; baseline: HarnessState; rollbackOf: string | null };

export interface RefineDirs {
	local(conversationId: number): string;
	global(): string;
}

export interface RefineHistory {
	read(conversationId: number, context: Context): Promise<readonly RefinementResult[]>;
	/** Called inside the task's terminal commit; must be idempotent by result id. */
	record(conversationId: number, result: RefinementResult, tx: unknown): Promise<void>;
}

const REFINEMENT_SYSTEM_PROMPT = `You are the continual harness refiner.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise create, update, or delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets the agent improve reusable behavior outside
the token history.

Components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: an installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python \`import\`, and a \`callable\` or \`call_pattern\`; they also MUST include an \`arguments\` object describing accepted inputs. Use \`{}\` for \`arguments\` only when the callable needs no inputs.
- subagent: reusable delegation specs: purpose, instructions, and when to invoke.

Scope and persistence policy:
- The default store is local to the current conversation. Use it for progress, active task state, temporary blockers, and facts that should not affect other conversations.
- Global edits must be stable cross-conversation lessons, durable user preferences, reusable skills or subagents, or tool and environment facts that should affect future conversations.
- Entry ids in the overview carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id in edits.
- All edits in one refinement apply only to the requested scope. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead if an override is needed.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component.

Use the trajectory, current state, and prior refinement history. Prefer small, evidence-backed edits. If prior refinements caused issues, roll back or replace the faulty entries. Output JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update",
      "content": "required for create/update",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

export const REVIEW_SYSTEM_PROMPT = `You are the automatic refinement review gate.

Decide whether this checkpoint should run a refinement. Refinement writes local continual harness state by default, so approve when the trajectory contains evidence useful to this conversation's future turns: a repeated failure, a reusable tactic, a durable fact or preference, a user correction that should persist, or an entry shown to be wrong.
Reject one-off noise, unsupported hypotheses, and transient tool outputs.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for the refiner if shouldRefine is true"
}`;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const p = part as { type?: string; text?: string; name?: string; arguments?: unknown; thinking?: string };
			if (p.type === "text") return p.text ?? "";
			if (p.type === "toolCall") return `[tool ${p.name ?? ""}] ${JSON.stringify(p.arguments ?? {})}`;
			return "";
		})
		.filter((t) => t.length > 0)
		.join("\n");
}

/** Plain-text transcript for the refiner, newest-last, trimmed from the front. */
export function serializeMessages(messages: readonly Message[], maxChars: number): string {
	const lines: string[] = [];
	for (const message of messages) {
		const m = message as { role: string; content?: unknown };
		if (m.role === "system") continue;
		const text = textOf(m.content);
		if (text.length === 0) continue;
		lines.push(`${m.role}: ${text}`);
	}
	return lines.join("\n\n").slice(-maxChars);
}

function responseText(response: { content: readonly { type: string; text?: string }[] }): string {
	return response.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

export function createRefineTask(dirs: RefineDirs, history: RefineHistory) {
	return defineTask<RefineInput, RefineCheckpoint, RefineResult>({
		name: "standard.refine",
		version: 1,
		initial: (input) => (input.auto ? { phase: "review" } : { phase: "plan", instructions: input.instructions }),
		phases: {
			review: async (task, runtime, context) => {
				const agent = await runtime.agent(context);
				const model = agent.model === undefined ? undefined : (runtime.models.getModel(agent.model.provider, agent.model.modelId) as Model<never> | undefined);
				if (model === undefined) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { skipped: true, rationale: "no model available" } } }), context);
					return;
				}
				const local = loadState(dirs.local(runtime.conversationId), "local");
				const global = loadState(dirs.global(), "global");
				const past = await history.read(runtime.conversationId, context);
				const view = await runtime.context(runtime.conversationId, context);
				const userPrompt = [
					`<trigger>\n${task.input.trigger}; ${task.input.turnsSinceReview ?? 0} turns since the last review\n</trigger>`,
					`<current_harness_state>\n${overviewForRefiner(mergeStates(global, local))}\n</current_harness_state>`,
					`<refinement_history>\n${historyForRefiner(past)}\n</refinement_history>`,
					`<conversation>\n${serializeMessages(view.messages, 40_000)}\n</conversation>`,
				].join("\n\n");
				const response = await runtime.models.completeSimple(
					model,
					{ systemPrompt: REVIEW_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }] },
					{ maxTokens: Math.min(model.maxTokens, 4_096), signal: runtime.signal },
				);
				if (response.stopReason === "error") throw new Error(`refinement review failed: ${response.errorMessage ?? "unknown error"}`);
				const value = extractJsonObject(responseText(response)) as { shouldRefine?: unknown; rationale?: unknown; instructions?: unknown };
				const rationale = typeof value.rationale === "string" ? value.rationale : "no rationale";
				if (value.shouldRefine !== true) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { skipped: true, rationale } } }), context);
					return;
				}
				const instructions = typeof value.instructions === "string" ? value.instructions : null;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "plan", instructions } }), context);
			},
			plan: async (task, runtime, context) => {
				const { scope } = task.input;
				const instructions = task.state.checkpoint.phase === "plan" ? task.state.checkpoint.instructions : null;
				const local = loadState(dirs.local(runtime.conversationId), "local");
				const global = loadState(dirs.global(), "global");
				const baseline = scope === "global" ? global : local;
				const past = await history.read(runtime.conversationId, context);
				const id = `refine_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;

				let proposal: RefinementProposal;
				let rollbackOf: string | null = null;
				if (task.input.rollbackId !== null) {
					const target = past.find((item) => item.id === task.input.rollbackId);
					if (target === undefined) {
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: `refinement ${task.input.rollbackId} not found` } } }), context);
						return;
					}
					proposal = rollbackProposal(target);
					rollbackOf = target.id;
				} else {
					const agent = await runtime.agent(context);
					const model = agent.model === undefined ? undefined : (runtime.models.getModel(agent.model.provider, agent.model.modelId) as Model<never> | undefined);
					if (model === undefined) {
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "no model available for refinement" } } }), context);
						return;
					}
					const view = await runtime.context(runtime.conversationId, context);
					const conversation = serializeMessages(view.messages, 80_000);
					const scopeInstruction =
						scope === "global"
							? "Requested refinement scope: global. Only propose stable cross-conversation edits, durable user preferences, reusable skills or subagents, or clearly reusable facts. Do not persist conversation-only progress globally."
							: "Requested refinement scope: local. Prefer local edits for current task progress, temporary blockers, and facts that are not clearly reusable across conversations. Global entries in the overview are read-only context.";
					const userPrompt = [
						`<current_harness_state>\n${overviewForRefiner(mergeStates(global, local))}\n</current_harness_state>`,
						`<refinement_history>\n${historyForRefiner(past)}\n</refinement_history>`,
						`<conversation>\n${conversation}\n</conversation>`,
						`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
						instructions ? `<refine_instructions>\n${instructions}\n</refine_instructions>` : "",
						"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
					]
						.filter((part) => part.length > 0)
						.join("\n\n");
					const response = await runtime.models.completeSimple(
						model,
						{ systemPrompt: REFINEMENT_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }] },
						{ maxTokens: Math.min(model.maxTokens, 32_000), signal: runtime.signal },
					);
					if (response.stopReason === "error") throw new Error(`refinement failed: ${response.errorMessage ?? "unknown error"}`);
					if (response.stopReason === "length") throw new Error("refinement failed: the model stopped before completing its JSON object");
					proposal = parseProposal(responseText(response));
				}
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "apply", id, proposal, baseline, rollbackOf } }),
					context,
				);
			},
			apply: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				if (checkpoint.phase !== "apply") throw new Error("apply phase reached without a plan");
				const { scope } = task.input;
				const dir = scope === "global" ? dirs.global() : dirs.local(runtime.conversationId);
				const state = loadState(dir, scope);
				const result = applyProposal(state, checkpoint.proposal, {
					id: checkpoint.id,
					scope,
					baseline: checkpoint.baseline,
					rollbackOf: checkpoint.rollbackOf,
				});
				// The file write is the effect; the terminal commit records it. A crash
				// between the two reapplies the same proposal against the same baseline,
				// which rejects the already-applied edits as "changed" and records that.
				saveState(dir, state);
				await runtime.commit(async (tx) => {
					await history.record(runtime.conversationId, result, tx);
					return { status: "terminal", outcome: { status: "completed", result } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}
