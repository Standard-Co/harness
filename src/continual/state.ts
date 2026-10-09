// Continual harness state: Prime Agent's editable layer of prompt notes,
// memories, skills, and subagent specs. The on-disk format is Prime's
// `harness_state.json`, so the Python runtime's `rlm.harness` calls and this
// host read and write the same file. Ported from Prime Agent's TypeScript
// refinement module.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-durable";

export type HarnessKind = "prompt" | "memory" | "skill" | "subagent";
export type HarnessScope = "local" | "global";
export type RefinementAction = "create" | "update" | "delete";

const KINDS: readonly HarnessKind[] = ["prompt", "memory", "skill", "subagent"];
export const STATE_FILE_NAME = "harness_state.json";

export type HarnessEntry = {
	id: string;
	kind: HarnessKind;
	title: string;
	content: string;
	path: string;
	scope: HarnessScope;
	reference: JsonObject;
	arguments: JsonObject;
	metadata: JsonObject;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
};

export type RefinementEvent = {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
};

export type HarnessState = {
	schema: number;
	entries: Record<HarnessKind, Record<string, HarnessEntry>>;
	refinements: RefinementEvent[];
	/** Entries of kinds this host does not refine (Prime's `factory`), preserved verbatim on save. */
	passthrough: JsonObject;
};

export type RefinementEdit = {
	action: RefinementAction;
	kind: HarnessKind;
	id: string | null;
	title: string | null;
	content: string | null;
	path: string | null;
	reference: JsonObject | null;
	arguments: JsonObject | null;
	metadata: JsonObject | null;
	reason: string | null;
};

export type RefinementProposal = {
	summary: string;
	rationale: string;
	expectedOutcome: string;
	edits: RefinementEdit[];
};

export type AppliedRefinementEdit = RefinementEdit & {
	id: string;
	before: HarnessEntry | null;
	after: HarnessEntry | null;
	applied: boolean;
	error: string | null;
};

export type RefinementResult = {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	scope: HarnessScope;
	rollbackOf: string | null;
};

function now(): string {
	return new Date().toISOString();
};

export function emptyState(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [], passthrough: {} };
};

export function slug(raw: string, fallback: string): string {
	const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return base.length > 0 ? base : fallback;
};

function record(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (JSON.parse(JSON.stringify(value)) as JsonObject) : {};
};

export function statePath(dir: string): string {
	return join(dir, STATE_FILE_NAME);
}

/** Load Prime's `harness_state.json`, tolerating a missing or torn file like the Python side does. */
export function loadState(dir: string, scope: HarnessScope): HarnessState {
	const state = emptyState();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(statePath(dir), "utf8"));
	} catch {
		return state;
	}
	const data = record(raw);
	const entries = record(data.entries);
	for (const [kind, kindEntries] of Object.entries(entries)) {
		if (!KINDS.includes(kind as HarnessKind)) {
			state.passthrough[kind] = kindEntries;
			continue;
		}
		for (const [id, rawEntry] of Object.entries(record(kindEntries))) {
			const entry = record(rawEntry);
			if (typeof entry.title !== "string" || typeof entry.content !== "string") continue;
			const version = typeof entry.version === "number" ? entry.version : Number.parseInt(String(entry.version ?? "1"), 10) || 1;
			state.entries[kind as HarnessKind][id] = {
				id,
				kind: kind as HarnessKind,
				title: entry.title,
				content: entry.content,
				path: typeof entry.path === "string" ? entry.path : "general",
				scope: entry.scope === "local" || entry.scope === "global" ? entry.scope : scope,
				reference: record(entry.reference),
				arguments: record(entry.arguments),
				metadata: record(entry.metadata),
				source: typeof entry.source === "string" ? entry.source : "agent",
				created_at: typeof entry.created_at === "string" ? entry.created_at : now(),
				updated_at: typeof entry.updated_at === "string" ? entry.updated_at : now(),
				version,
			};
		}
	}
	for (const rawEvent of Array.isArray(data.refinements) ? data.refinements : []) {
		const event = record(rawEvent);
		if (typeof event.id !== "string" || typeof event.trigger !== "string") continue;
		state.refinements.push({
			id: event.id,
			trigger: event.trigger,
			changes: Array.isArray(event.changes) ? event.changes.filter((c): c is string => typeof c === "string") : [],
			evidence: typeof event.evidence === "string" ? event.evidence : "",
			outcome: typeof event.outcome === "string" ? event.outcome : "",
			created_at: typeof event.created_at === "string" ? event.created_at : now(),
		});
	}
	return state;
}

/** Write the file atomically, in the shape the Python runtime reads. */
export function saveState(dir: string, state: HarnessState): void {
	mkdirSync(dir, { recursive: true });
	const target = statePath(dir);
	const data = {
		schema: 1,
		entries: { ...state.passthrough, ...state.entries },
		refinements: state.refinements,
	};
	const temp = join(dirname(target), `.${STATE_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
	renameSync(temp, target);
}

/** Global entries are read-only context for a local refinement; local entries win on id collisions. */
export function mergeStates(global: HarnessState, local: HarnessState): HarnessState {
	const merged = emptyState();
	for (const kind of KINDS) {
		merged.entries[kind] = { ...global.entries[kind], ...local.entries[kind] };
	}
	merged.refinements = [...global.refinements, ...local.refinements];
	return merged;
};

function compact(text: string, max: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
};

function sortedEntries(state: HarnessState, kind: HarnessKind): HarnessEntry[] {
	return Object.values(state.entries[kind]).sort((a, b) =>
		[a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")),
	);
}

/** The compact rendering that goes into the system prompt before each request. */
export function formatForPrompt(
	state: HarnessState,
	options: { maxEntriesPerKind?: number; maxRefinements?: number; maxContentLength?: number } = {},
): string | undefined {
	const maxEntriesPerKind = options.maxEntriesPerKind ?? 6;
	const maxRefinements = options.maxRefinements ?? 5;
	const maxContent = options.maxContentLength ?? 180;
	const total = KINDS.reduce((n, kind) => n + Object.keys(state.entries[kind]).length, 0);
	if (total === 0 && state.refinements.length === 0) return undefined;

	const lines: string[] = [];
	for (const kind of KINDS) {
		const entries = sortedEntries(state, kind);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, maxEntriesPerKind)) {
			const args = kind === "skill" && Object.keys(entry.arguments).length > 0 ? ` args=${compact(JSON.stringify(entry.arguments), maxContent)}` : "";
			const ref = kind === "skill" && Object.keys(entry.reference).length > 0 ? ` ref=${compact(JSON.stringify(entry.reference), maxContent)}` : "";
			lines.push(`- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${ref}${args}: ${compact(entry.content, maxContent)}`);
		}
		if (entries.length > maxEntriesPerKind) lines.push(`- +${entries.length - maxEntriesPerKind} more ${kind} entries`);
		lines.push("");
	}
	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compact(event.outcome, maxContent)}` : "";
		lines.push(`- [${event.id}] ${compact(event.trigger, maxContent)}: ${changes}${outcome}`);
	}
	return lines.join("\n").trim();
}

/** The fuller overview the refiner sees. */
export function overviewForRefiner(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of KINDS) {
		const entries = Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, 40)) {
			const args = kind === "skill" && Object.keys(entry.arguments).length > 0 ? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}` : "";
			const ref = kind === "skill" && Object.keys(entry.reference).length > 0 ? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}` : "";
			lines.push(`- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${ref}${args}: ${entry.content.replace(/\s+/g, " ").slice(0, 240)}`);
		}
		if (entries.length > 40) lines.push(`- +${entries.length - 40} more ${kind} entries`);
	}
	return lines.join("\n");
};

export function historyForRefiner(history: readonly RefinementResult[]): string {
	if (history.length === 0) return "No prior refinement history.";
	return history
		.slice(-20)
		.map((item) => {
			const edits = item.appliedEdits.map((e) => `${e.applied ? "applied" : "failed"} ${e.action} ${e.kind}:${e.id}`).join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
};

function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
};

const TRUNCATED = "the model stopped before completing its JSON object";

function parseCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		if (isIncompleteJson(candidate)) throw new Error(TRUNCATED);
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
};

export function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return parseCandidate(trimmed);
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return parseCandidate(fenced[1].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) throw new Error(TRUNCATED);
	throw new Error("the refiner did not return a JSON object");
};

export function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("refiner JSON must be an object");
	const data = value as JsonObject;
	const edits = Array.isArray(data.edits) ? data.edits : [];
	return {
		summary: typeof data.summary === "string" ? data.summary : "Refined continual harness state",
		rationale: typeof data.rationale === "string" ? data.rationale : "",
		expectedOutcome: typeof data.expectedOutcome === "string" ? data.expectedOutcome : "",
		edits: edits
			.filter((e): e is JsonObject => typeof e === "object" && e !== null)
			.map((e) => ({
				action: e.action as RefinementAction,
				kind: e.kind as HarnessKind,
				id: typeof e.id === "string" ? e.id : null,
				title: typeof e.title === "string" ? e.title : null,
				content: typeof e.content === "string" ? e.content : null,
				path: typeof e.path === "string" ? e.path : null,
				reference: e.reference !== undefined ? record(e.reference) : null,
				arguments: e.arguments !== undefined ? record(e.arguments) : null,
				metadata: e.metadata !== undefined ? record(e.metadata) : null,
				reason: typeof e.reason === "string" ? e.reason : null,
			})),
	};
};

function validateEdit(edit: RefinementEdit, id: string): string | undefined {
	if (!["create", "update", "delete"].includes(edit.action)) return `unsupported action ${String(edit.action)}`;
	if (!KINDS.includes(edit.kind)) return `unsupported kind ${String(edit.kind)}`;
	if (edit.kind === "prompt" && id === "base_system_prompt") return "base system prompt is not editable";
	if (edit.action !== "create" && !edit.id) return `${edit.action} requires id`;
	if (edit.action !== "delete" && (!edit.title || !edit.content)) return `${edit.action} requires title and content`;
	if (edit.action !== "delete" && edit.kind === "skill") {
		if (edit.arguments === null) return `${edit.action} skill requires arguments`;
		const ref = edit.reference;
		if (!ref) return `${edit.action} skill requires python reference`;
		if (ref.type !== "python") return `${edit.action} skill reference.type must be python`;
		const hasImport = typeof ref.import === "string" && ref.import.length > 0;
		const hasCallable = (typeof ref.callable === "string" && ref.callable.length > 0) || (typeof ref.call_pattern === "string" && ref.call_pattern.length > 0);
		if (!hasImport) return `${edit.action} skill requires python import`;
		if (!hasCallable) return `${edit.action} skill requires callable or call_pattern`;
	}
	return undefined;
};

function clone<T>(value: T | undefined): T | null {
	return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Apply a proposal to `state` in place. An edit whose entry changed since
 * `baseline` was captured is rejected: the planner may have taken seconds,
 * and the kernel may have written the file meanwhile.
 */
export function applyProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: { id: string; scope: HarnessScope; baseline?: HarnessState; rollbackOf?: string | null },
): RefinementResult {
	const fail = (edit: RefinementEdit, id: string, error: string, before: HarnessEntry | null = null): AppliedRefinementEdit => ({ ...edit, id, before, after: null, applied: false, error });
	const applied: AppliedRefinementEdit[] = [];
	const touched = new Set<string>();
	for (const edit of proposal.edits) {
		const id = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : "");
		const invalid = validateEdit(edit, id);
		if (invalid) {
			applied.push(fail(edit, id, invalid));
			continue;
		}
		const records = state.entries[edit.kind];
		const before = clone(records[id]);
		const key = `${edit.kind}:${id}`;
		const baseline = clone(options.baseline?.entries[edit.kind][id]);
		if (options.baseline && !touched.has(key) && JSON.stringify(before) !== JSON.stringify(baseline)) {
			applied.push(fail(edit, id, "entry changed during refinement planning", before));
			continue;
		}
		if (edit.action === "delete") {
			if (!before) {
				applied.push(fail(edit, id, "entry not found"));
				continue;
			}
			delete records[id];
			touched.add(key);
			applied.push({ ...edit, id, before, after: null, applied: true, error: null });
			continue;
		}
		if (edit.action === "create" && before) {
			applied.push(fail(edit, id, "entry already exists", before));
			continue;
		}
		if (edit.action === "update" && !before) {
			applied.push(fail(edit, id, "entry not found"));
			continue;
		}
		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope,
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			metadata: edit.metadata ?? before?.metadata ?? {},
			source: "refine",
			created_at: before?.created_at ?? now(),
			updated_at: now(),
			version: before ? before.version + 1 : 1,
		};
		records[id] = after;
		touched.add(key);
		applied.push({ ...edit, id, before, after: clone(after), applied: true, error: null });
	}
	const changes = applied.filter((e) => e.applied).map((e) => `${e.action} ${e.kind}:${e.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now(),
	});
	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits: applied,
		scope: options.scope,
		rollbackOf: options.rollbackOf ?? null,
	};
};

export function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			edits.push({
				action: edit.after ? "update" : "create",
				kind: edit.kind,
				id: edit.id,
				title: edit.before.title,
				content: edit.before.content,
				path: edit.before.path,
				reference: edit.before.reference,
				arguments: edit.before.arguments,
				metadata: edit.before.metadata,
				reason: `Rollback ${target.id}`,
			});
		} else if (edit.after) {
			edits.push({ action: "delete", kind: edit.kind, id: edit.id, title: null, content: null, path: null, reference: null, arguments: null, metadata: null, reason: `Rollback ${target.id}` });
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores continual harness entries to their state before refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}
