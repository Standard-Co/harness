#!/usr/bin/env -S node --experimental-strip-types
// standard run "<prompt>"   Submit one prompt to the root conversation and print the answer.
// Options: --dir <path> (default .standard)  --model <provider/model-id>  --cwd <path>

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { openStandard } from "../src/harness.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: "string", default: ".standard" },
		cwd: { type: "string", default: process.cwd() },
		model: { type: "string", default: process.env.STANDARD_MODEL ?? "casedev/casemark/core-potassium" },
		python: { type: "string", default: process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python") },
	},
});
const [command, ...rest] = positionals;
if (command !== "run" || rest.length === 0) {
	console.error('usage: standard run "<prompt>" [--dir .standard] [--model casedev/<id>] [--cwd <path>]');
	process.exit(2);
}

const context = BACKGROUND_CONTEXT;
const slash = values.model.indexOf("/");
const model = { provider: values.model.slice(0, slash), modelId: values.model.slice(slash + 1) };

const standard = await openStandard({ dir: values.dir, cwd: resolve(values.cwd), python: values.python }, context);
try {
	const root = await standard.harness.root(context, { agent: { model, cwd: resolve(values.cwd) } });
	standard.harness.resume();
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
} finally {
	await standard.close(context);
}
