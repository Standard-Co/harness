// The `standard.subagents` document and the reply shapes Prime's `rlm`
// module parses (prime-agent-runtime/src/rlm/__init__.py, `_parse_*`).

import { join } from "node:path";
import { defineDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";

export type SubagentStatus = "running" | "done" | "error" | "cancelled";

export type SubagentRecord = {
	childId: string;
	name: string;
	conversationId: number;
	anchorTaskId: number;
	/** The spawning call (`HostRequestOrigin.callKey`); a repeat of the same call returns this child. */
	spawnKey: string | null;
	/** `provider/modelId`. */
	model: string;
	/** First line of the task, for listings. */
	label: string;
	status: SubagentStatus;
	deleted: boolean;
	answer: string | null;
	error: string | null;
	progressNote: string | null;
	progressNoteAt: number | null;
	createdAt: number;
	updatedAt: number;
	settledAt: number | null;
};

export type SubagentsState = {
	/** This conversation's recursion depth: 0 for a top-level agent. */
	depth: number;
	/** Set on a child: who spawned it and its id there. */
	parent: { conversationId: number; childId: string } | null;
	/** This conversation's own name, for a top-level agent renamed from the REPL. */
	name: string | null;
	children: Record<string, SubagentRecord>;
};

export const SubagentsDoc = defineDoc<SubagentsState>({
	kind: "standard.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	// The children belong to the anchor tasks of the conversation that spawned them, not to its forks.
	fork: "initial",
	initial: () => ({ depth: 0, parent: null, name: null, children: {} }),
});

export const NAME_MAX_LENGTH = 64;

export function conversationIdOf(record: SubagentRecord): ConversationId {
	return record.conversationId as ConversationId;
}

export function anchorOf(record: SubagentRecord): TaskId {
	return record.anchorTaskId as TaskId;
}

export function sessionDir(stateDir: string, record: SubagentRecord): string {
	return join(stateDir, String(record.conversationId));
}

export function validateName(value: unknown): string {
	if (typeof value !== "string") throw new Error("name must be a string");
	const name = value.trim();
	if (name.length === 0) throw new Error("name must not be empty");
	if (name.length > NAME_MAX_LENGTH) throw new Error(`name must be at most ${NAME_MAX_LENGTH} characters`);
	if (/[\r\n\t]/.test(name)) throw new Error("name must be a single line");
	return name;
}

/** `subagent-<task slug>-<id suffix>`, like Prime's default child names. */
export function defaultName(prompt: string, childId: string): string {
	const suffix = childId.replace(/^sub-/, "");
	const slug = prompt
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const budget = Math.max(1, NAME_MAX_LENGTH - "subagent--".length - suffix.length);
	const part = (slug.length === 0 ? "worker" : slug.slice(0, budget)).replace(/-+$/, "");
	return `subagent-${part}-${suffix}`;
}

export function labelOf(prompt: string): string {
	const line = prompt.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Live (not deleted) children matching an id or a name. */
export function findChild(state: Readonly<SubagentsState> | undefined, selector: string): SubagentRecord | undefined {
	const live = Object.values(state?.children ?? {}).filter((child) => !child.deleted);
	return live.find((child) => child.childId === selector) ?? live.find((child) => child.name === selector);
}

export function nameTaken(state: Readonly<SubagentsState>, name: string, except?: string): boolean {
	return Object.values(state.children).some((child) => !child.deleted && child.name === name && child.childId !== except);
}

/** `rlm.spawn` reply: `_spawn_handle_from_payload`. */
export function spawnHandle(stateDir: string, record: SubagentRecord) {
	return { rlm_child_id: record.childId, name: record.name, session_dir: sessionDir(stateDir, record), model: record.model };
}

const durationOf = (record: SubagentRecord, now: number): number => (record.settledAt ?? now) - record.createdAt;

/** `rlm.list_subagents` and `rlm.delete_subagent` entry: `_subagent_from_payload`. Its status is running, completed, or error. */
export function subagentRow(stateDir: string, record: SubagentRecord, now: number) {
	return {
		rlm_child_id: record.childId,
		active_session_id: String(record.conversationId),
		session_id: String(record.conversationId),
		session_name: record.name,
		session_dir: sessionDir(stateDir, record),
		status: record.status === "running" ? "running" : record.status === "done" ? "completed" : "error",
		duration_ms: durationOf(record, now),
		answer_preview: record.answer,
		progress_note: record.progressNote,
		label: record.label,
		last_activity_at: record.updatedAt,
	};
}

/** `rlm.collect` entry: `_child_result_from_payload`. */
export function collectRow(stateDir: string, record: SubagentRecord, now: number) {
	return {
		rlm_child_id: record.childId,
		session_name: record.name,
		session_dir: sessionDir(stateDir, record),
		status: record.status,
		settled: record.status !== "running",
		answer_preview: record.answer,
		error: record.error,
		duration_ms: durationOf(record, now),
	};
}
