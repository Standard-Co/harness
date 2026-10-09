#!/usr/bin/env -S node --experimental-strip-types
// standard run "<prompt>"     Submit one prompt to the root conversation and print the answer.
// standard refine [note]      Run a continual-harness refinement on the root conversation and print the result.
// standard state              Print the continual harness entries the model sees.
// Options: --dir <path> (default .standard)  --model <provider/model-id>  --cwd <path>  --global (refine)

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { formatForPrompt, loadState, mergeStates } from "../src/continual/state.ts";
import { openStandard } from "../src/harness.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: "string", default: ".standard" },
		cwd: { type: "string", default: process.cwd() },
		model: { type: "string", default: process.env.STANDARD_MODEL ?? "casedev/casemark/core-potassium" },
		python: { type: "string", default: process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python") },
		global: { type: "boolean", default: false },
	},
});
const [command, ...rest] = positionals;
if (!(command === "run" && rest.length > 0) && command !== "refine" && command !== "state") {
	console.error('usage: standard run "<prompt>" | standard refine [note] [--global] | standard state   [--dir .standard] [--model casedev/<id>] [--cwd <path>]');
	process.exit(2);
}

const context = BACKGROUND_CONTEXT;
const slash = values.model.indexOf("/");
const model = { provider: values.model.slice(0, slash), modelId: values.model.slice(slash + 1) };

const standard = await openStandard({ dir: values.dir, cwd: resolve(values.cwd), python: values.python }, context);
try {
	const root = await standard.harness.root(context, { agent: { model, cwd: resolve(values.cwd) } });
	standard.harness.resume();
	if (command === "state") {
		const kernelDir = resolve(standard.dir, "kernel");
		const local = loadState(join(kernelDir, String(root.id), "harness"), "local");
		const global = loadState(join(kernelDir, "agent", "harness"), "global");
		console.log(formatForPrompt(mergeStates(global, local)) ?? "(no continual harness entries yet)");
	} else if (command === "refine") {
		const taskId = await standard.continual.refine(root.id, { scope: values.global ? "global" : "local", ...(rest.length > 0 ? { instructions: rest.join(" ") } : {}) }, context);
		if (taskId === undefined) {
			console.error("a refinement is already running");
			process.exitCode = 1;
		} else {
			const settled = await standard.harness.waitForTask(taskId, context);
			const outcome = settled.state.outcome;
			if (outcome.status !== "completed") {
				console.error(`refinement ${outcome.status}${"error" in outcome && outcome.error ? `: ${outcome.error.message}` : ""}`);
				process.exitCode = 1;
			} else if ("skipped" in outcome.result) {
				console.log(`skipped: ${outcome.result.rationale}`);
			} else {
				console.log(outcome.result.summary);
				for (const edit of outcome.result.appliedEdits) console.log(`  ${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}${edit.error ? ` (${edit.error})` : ""}`);
			}
		}
	} else {
	const submission = await root.submit({ type: "input", content: rest.join(" ") }, context);
	const settled = await submission.wait(context);
	if (settled.status === "done" && settled.type === "input") {
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const answer = entry?.model?.[0] as AssistantMessage | undefined;
		console.log(answer?.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") ?? "");
	} else {
		console.error(`unanswered: ${settled.status === "unanswered" ? `${settled.reason} ${settled.detail ?? ""}` : settled.status}`);
		process.exitCode = 1;
	}
	}
} finally {
	await standard.close(context);
}
