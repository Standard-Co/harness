import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyProposal, emptyState, loadState, parseProposal, rollbackProposal, saveState, type RefinementEdit } from "../src/continual/state.ts";

const edit = (partial: Partial<RefinementEdit> & Pick<RefinementEdit, "action" | "kind">): RefinementEdit => ({
	id: null, title: null, content: null, path: null, reference: null, arguments: null, metadata: null, reason: null, ...partial,
});

test("state: apply, baseline conflict, rollback, file round trip", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-state-"));
	try {
		const state = emptyState();
		const first = applyProposal(
			state,
			{ summary: "s", rationale: "r", expectedOutcome: "o", edits: [edit({ action: "create", kind: "memory", title: "British spelling", content: "Prefer British spelling." })] },
			{ id: "refine_1", scope: "local" },
		);
		assert.equal(first.appliedEdits[0]?.applied, true);
		assert.equal(first.appliedEdits[0]?.id, "british-spelling");
		assert.equal(state.entries.memory["british-spelling"]?.version, 1);

		// A plan made against an older baseline is rejected when the entry moved on.
		const baseline = JSON.parse(JSON.stringify(state));
		state.entries.memory["british-spelling"]!.content = "changed by the kernel meanwhile";
		const stale = applyProposal(
			state,
			{ summary: "s", rationale: "r", expectedOutcome: "o", edits: [edit({ action: "update", kind: "memory", id: "british-spelling", title: "x", content: "y" })] },
			{ id: "refine_2", scope: "local", baseline },
		);
		assert.equal(stale.appliedEdits[0]?.applied, false);
		assert.match(stale.appliedEdits[0]?.error ?? "", /changed during/);

		// Skills need a python reference.
		const badSkill = applyProposal(
			state,
			{ summary: "s", rationale: "r", expectedOutcome: "o", edits: [edit({ action: "create", kind: "skill", title: "t", content: "c", arguments: {} })] },
			{ id: "refine_3", scope: "local" },
		);
		assert.match(badSkill.appliedEdits[0]?.error ?? "", /python reference/);

		// Rollback restores the pre-refinement entry (here: deletes the created one).
		const rollback = applyProposal(state, rollbackProposal(first), { id: "refine_4", scope: "local", rollbackOf: first.id });
		assert.equal(rollback.appliedEdits[0]?.applied, true);
		assert.equal(state.entries.memory["british-spelling"], undefined);
		assert.equal(state.refinements.length, 4);

		saveState(dir, state);
		const reloaded = loadState(dir, "local");
		assert.equal(reloaded.refinements.length, 4);
		assert.deepEqual(Object.keys(reloaded.entries.memory), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("state: proposal parsing tolerates fences and prose, names truncation", () => {
	const fenced = parseProposal('Here you go:\n```json\n{"summary":"a","rationale":"b","expectedOutcome":"c","edits":[]}\n```');
	assert.equal(fenced.summary, "a");
	assert.throws(() => parseProposal('{"summary":"a","edits":[{"action":"create"'), /stopped before completing/);
});
