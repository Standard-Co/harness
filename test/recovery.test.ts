import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openStandard } from "../src/harness.ts";

const python = process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python");
const context = BACKGROUND_CONTEXT;

test("a process killed mid-cell resumes, and the model is told the cell was interrupted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-recovery-"));
	try {
		const child = spawn(process.execPath, ["--experimental-strip-types", resolve(import.meta.dirname, "fixtures/crash-run.ts"), dir, python], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		const exited = new Promise<void>((done) => child.on("exit", () => done()));
		for (let i = 0; i < 300 && !existsSync(join(dir, "started")); i++) await sleep(100);
		assert.ok(existsSync(join(dir, "started")), "the cell started running");
		child.kill("SIGKILL");
		await exited;

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("The cell was interrupted; I will not retry it.")]);
		const standard = await openStandard({ dir, cwd: dir, python, models }, context);
		try {
			const root = await standard.harness.root(context);
			standard.harness.resume();
			// The same request ID finds the interrupted submission instead of submitting again.
			const submission = await root.submit({ type: "input", content: "sleep", requestId: "crash-1" }, context);
			const settled = await submission.wait(context);
			assert.equal(settled.status, "done");

			const { messages } = await root.context(context);
			const result = messages.find((m) => m.role === "toolResult");
			assert.ok(result, "a tool result was recorded for the interrupted cell");
			assert.equal(result.isError, true);
			const text = JSON.stringify(result.content);
			assert.match(text, /interrupted/i);
			assert.equal(messages.filter((m) => m.role === "toolResult").length, 1, "the unsafe cell did not rerun");
		} finally {
			await standard.close(context);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
