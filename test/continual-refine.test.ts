import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ContinualDoc } from "../src/continual/extension.ts";
import { loadState } from "../src/continual/state.ts";
import { openStandard } from "../src/harness.ts";

const python = process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python");
const context = BACKGROUND_CONTEXT;

test("refine: plans with the model, writes Prime's state file, records the result, and the next prompt shows it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-refine-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const standard = await openStandard({ dir, cwd: dir, python, models, reviewEvery: 0 }, context);
		try {
			const root = await standard.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			faux.setResponses([
				fauxAssistantMessage("Noted: you prefer British spelling."),
				fauxAssistantMessage(
					JSON.stringify({
						summary: "Record the spelling preference",
						rationale: "The user stated a durable preference.",
						expectedOutcome: "Future output uses British spelling.",
						edits: [{ action: "create", kind: "memory", id: "british-spelling", title: "British spelling", content: "The user prefers British spelling in all written output." }],
					}),
				),
				fauxAssistantMessage("Colour it is."),
			]);
			await (await root.submit({ type: "input", content: "I prefer British spelling." }, context)).wait(context);

			const taskId = await standard.continual.refine(root.id, { scope: "local" }, context);
			assert.ok(taskId !== undefined);
			const settled = await standard.harness.waitForTask(taskId, context);
			assert.equal(settled.state.outcome.status, "completed");
			const result = settled.state.outcome.status === "completed" ? settled.state.outcome.result : undefined;
			assert.ok(result && !("skipped" in result));
			assert.equal(result.appliedEdits[0]?.applied, true);

			const file = join(dir, "kernel", String(root.id), "harness", "harness_state.json");
			assert.ok(existsSync(file), "Prime's harness_state.json was written");
			assert.equal(loadState(join(dir, "kernel", String(root.id), "harness"), "local").entries.memory["british-spelling"]?.version, 1);

			const doc = await standard.harness.snapshot(ContinualDoc, root.id, context);
			assert.equal(doc?.results.length, 1);
			assert.equal(doc?.pendingTaskId, null);

			// A second refinement while none is pending is allowed; the same request would be deduped only while live.
			await (await root.submit({ type: "input", content: "Spell colour." }, context)).wait(context);
			const { messages } = await root.context(context);
			const systems = messages.filter((m) => m.role === "system") as { sections?: Record<string, string | null> }[];
			const shown = systems.map((m) => m.sections?.["continual-harness"] ?? "").join("\n");
			assert.match(shown, /british-spelling/);
		} finally {
			await standard.close(context);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
