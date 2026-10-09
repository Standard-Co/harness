// The anchor task: a background task of the parent conversation that owns one
// child conversation, delivers the spawn task to it, and records the answer in
// the parent's `standard.subagents` document. Being background, the parent's
// abort and idle waits stop at it; aborting it reaches the child's run. The
// delivery's request ID is derived from the child's id, so a task resumed
// after a restart finds its submission instead of sending the task again.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, defineTask } from "@earendil-works/pi-durable";
import { conversationIdOf, SubagentsDoc } from "./state.ts";

export type AnchorInput = { childId: string; prompt: string };
type AnchorState = { phase: "deliver" };

export const TASK_LABEL = "[task from parent]";

export const SubagentAnchor = defineTask<AnchorInput, AnchorState, null>({
	name: "standard.subagent",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { childId, prompt } = task.input;
			const record = (await runtime.snapshot(SubagentsDoc, runtime.conversationId, context))?.children[childId];
			const child = record === undefined ? undefined : await runtime.conversation(conversationIdOf(record), context);
			if (record === undefined || child === undefined) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: `subagent ${childId} has no conversation` } } }), context);
				return;
			}
			const submission = await child.submit({ type: "input", content: `${TASK_LABEL}\n\n${prompt}`, requestId: `rlm.spawn:${childId}` }, context);
			const settled = await submission.wait(context);
			await runtime.commit(async (tx) => {
				const current = (await tx.doc(SubagentsDoc, runtime.conversationId)).children[childId];
				if (current !== undefined && current.status === "running") {
					const now = runtime.now();
					if (settled.status === "done" && settled.type === "input") {
						const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
						current.status = "done";
						current.answer = (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
					} else if (settled.status === "unanswered" && settled.reason === "aborted") {
						current.status = "cancelled";
					} else {
						current.status = "error";
						current.error = settled.status === "unanswered" ? `${settled.reason}${settled.detail === undefined ? "" : `: ${JSON.stringify(settled.detail)}`}` : `unexpected settlement ${settled.status}`;
					}
					current.settledAt = now;
					current.updatedAt = now;
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const current = (await tx.doc(SubagentsDoc, runtime.conversationId)).children[task.input.childId];
			if (current !== undefined && current.status === "running") {
				current.status = "cancelled";
				current.settledAt = runtime.now();
				current.updatedAt = current.settledAt;
			}
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});
