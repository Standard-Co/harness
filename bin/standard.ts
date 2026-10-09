#!/usr/bin/env -S node --experimental-strip-types
// standard run "<prompt>"     Submit one prompt to the root conversation and print the answer.
// standard refine [note]      Run a continual-harness refinement on the root conversation and print the result.
// standard state              Print the continual harness entries the model sees.
// Options: --provider <module> (repeatable; or STANDARD_PROVIDER): an ES module whose default export is a pi-ai
//            Provider, an array of them, or a function (models) => void. Standard ships no providers.
//          --model <provider/model-id> (or STANDARD_MODEL)  --dir <path> (default .standard)  --cwd <path>
//          --global (refine)  --image <path> (run; repeatable): attach a PNG, JPEG, GIF, or WebP to the prompt

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Provider } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { formatForPrompt, loadState, mergeStates } from "../src/continual/state.ts";
import { openStandard } from "../src/harness.ts";
import { modelAcceptsImages, readImageFile } from "../src/models.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: "string", default: ".standard" },
		cwd: { type: "string", default: process.cwd() },
		model: { type: "string", default: process.env.STANDARD_MODEL ?? "" },
		provider: { type: "string", multiple: true, default: process.env.STANDARD_PROVIDER ? [process.env.STANDARD_PROVIDER] : [] },
		python: { type: "string", default: process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python") },
		global: { type: "boolean", default: false },
		image: { type: "string", multiple: true, default: [] },
	},
});
const [command, ...rest] = positionals;
if (!(command === "run" && rest.length > 0) && command !== "refine" && command !== "state") {
	console.error('usage: standard run "<prompt>" [--image <path>]... | standard refine [note] [--global] | standard state   --provider <module> --model <provider/id> [--dir .standard] [--cwd <path>]');
	process.exit(2);
}

const context = BACKGROUND_CONTEXT;
const needsModel = command !== "state";
if (needsModel && (values.model === "" || values.provider.length === 0)) {
	console.error("standard: --provider <module> and --model <provider/model-id> are required (or STANDARD_PROVIDER and STANDARD_MODEL)");
	process.exit(2);
}
const slash = values.model.indexOf("/");
const model = { provider: values.model.slice(0, slash), modelId: values.model.slice(slash + 1) };

// Providers come from modules you point at; nothing is bundled.
const models: MutableModels = createModels();
for (const path of values.provider) {
	const loaded = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
	const exported = loaded.default;
	if (typeof exported === "function") await (exported as (models: MutableModels) => void | Promise<void>)(models);
	else for (const provider of Array.isArray(exported) ? exported : [exported]) {
		if (typeof provider !== "object" || provider === null || !("id" in provider)) {
			console.error(`standard: ${path} does not default-export a pi-ai Provider, an array of them, or a function`);
			process.exit(2);
		}
		models.setProvider(provider as Provider);
	}
}
if (values.provider.length > 0) {
	const refreshed = await models.refresh();
	for (const [provider, error] of refreshed.errors) console.error(`standard: ${provider}: ${String(error)}`);
}

// Read attachments before opening anything, so a bad path fails fast.
let images: ImageContent[] = [];
try {
	images = await Promise.all(values.image.map((path) => readImageFile(resolve(path))));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}

const standard = await openStandard({ dir: values.dir, cwd: resolve(values.cwd), python: values.python, models }, context);
try {
	const root = await standard.harness.root(context, { agent: { ...(needsModel ? { model } : {}), cwd: resolve(values.cwd) } });
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
	} else if (images.length > 0 && !modelAcceptsImages(standard.models, model)) {
		const known = standard.models.getModel(model.provider, model.modelId) !== undefined;
		console.error(`${values.model} ${known ? "is text-only and cannot take --image" : "is not in the model catalog"}; choose a model with image input`);
		process.exitCode = 2;
	} else {
	const prompt = rest.join(" ");
	const content = images.length === 0 ? prompt : [{ type: "text" as const, text: prompt }, ...images];
	const submission = await root.submit({ type: "input", content }, context);
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
