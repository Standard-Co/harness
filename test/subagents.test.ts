import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openStandard } from "../src/harness.ts";
import { SubagentsDoc } from "../src/subagents/state.ts";

const python = process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python");
const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * One scripted model for parent and children, answering each request by who asks and what came last: a child is
 * recognised by its prompt section, and a tool result is echoed back as the final answer.
 */
function script(parentCell: string, childCell?: string): FauxResponseFactory {
	return (request) => {
		const isChild = JSON.stringify(request).includes("You are the subagent");
		const last = request.messages.findLast((message) => message.role !== "system");
		if (last?.role === "toolResult") return fauxAssistantMessage(textOf(last).trim());
		const cell = isChild ? childCell : parentCell;
		if (cell === undefined) return fauxAssistantMessage("2, 3, and 5.");
		return fauxAssistantMessage([fauxToolCall("ipython", { code: cell })], { stopReason: "toolUse" });
	};
}

async function open(dir: string, steps: FauxResponseFactory, maxSubagentDepth?: number) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 20 }, () => steps));
	const standard = await openStandard({ dir, cwd: dir, python, models, reviewEvery: 0, ...(maxSubagentDepth === undefined ? {} : { maxSubagentDepth }) }, context);
	const root = await standard.harness.root(context, { agent: { model } });
	standard.harness.resume();
	return { standard, root };
}

async function ask(root: Awaited<ReturnType<typeof open>>["root"], content: string): Promise<string> {
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	assert.equal(settled.status, "done");
	const { messages } = await root.context(context);
	return textOf(messages.findLast((message) => message.role === "toolResult")).trim();
}

test("subagents: a cell spawns and collects a child; a restart finds the same child and spawns nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-subagents-"));
	try {
		const spawnCell = [
			"child = await rlm.spawn('Name three primes.', name='primes')",
			"results = await rlm.collect(child, timeout_ms=20000)",
			"print(child.name, child.model, child.rlm_child_id)",
			"print(results[0].status, results[0].settled, results[0].answer_preview)",
		].join("\n");
		let childConversation: ConversationId;
		let spawnKey: string;
		let childId: string;
		{
			const { standard, root } = await open(dir, script(spawnCell));
			try {
				const output = await ask(root, "Delegate the primes.");
				assert.match(output, /^primes faux\/faux-1 sub-[0-9a-f]{8}$/m);
				assert.match(output, /^done True 2, 3, and 5\.$/m);

				const doc = await standard.harness.snapshot(SubagentsDoc, root.id, context);
				const children = Object.values(doc?.children ?? {});
				assert.equal(children.length, 1);
				const record = children[0]!;
				assert.equal(record.name, "primes");
				assert.equal(record.status, "done");
				assert.equal(record.answer, "2, 3, and 5.");
				assert.equal(record.model, "faux/faux-1");
				assert.ok(record.spawnKey !== null);
				childConversation = record.conversationId as ConversationId;
				spawnKey = record.spawnKey;
				childId = record.childId;

				const child = (await standard.harness.conversation(childConversation, context))!;
				assert.deepEqual((await child.agent(context)).model, model);
				assert.equal((await standard.harness.snapshot(SubagentsDoc, childConversation, context))?.depth, 1);
				const childMessages = (await child.context(context)).messages;
				assert.match(textOf(childMessages.find((message) => message.role === "user")), /^\[task from parent\]\n\nName three primes\.$/);
			} finally {
				await standard.close(context);
			}
		}

		{
			const listCell = "print([(s.session_name, s.status, s.answer_preview) for s in await rlm.list_subagents()])";
			const { standard, root } = await open(dir, script(listCell));
			try {
				await standard.harness.waitForIdle(context);
				assert.equal(await ask(root, "What subagents do I have?"), "[('primes', 'completed', '2, 3, and 5.')]");

				// The same spawning call again returns the child it made instead of making another.
				const again = (await standard.subagents.hostRequest(
					{ conversationId: root.id, callKey: spawnKey },
					{ type: "rlm.run", prompt: "Name three primes.", kwargs: { name: "primes" } },
					context,
				)) as { rlm_child_id: string };
				assert.equal(again.rlm_child_id, childId);
				const doc = await standard.harness.snapshot(SubagentsDoc, root.id, context);
				assert.equal(Object.keys(doc?.children ?? {}).length, 1);

				const child = (await standard.harness.conversation(childConversation, context))!;
				const users = (await child.context(context)).messages.filter((message) => message.role === "user");
				assert.equal(users.length, 1, "the task was delivered once");
			} finally {
				await standard.close(context);
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("subagents: a child still answering when the process stops answers once after the restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-subagents-"));
	try {
		const spawnCell = "child = await rlm.spawn('Name three primes.', name='slow')\nprint(child.name)";
		let started!: () => void;
		const childStarted = new Promise<void>((done) => {
			started = done;
		});
		// The child's first answer never arrives: it hangs until the harness closes.
		const parent = script(spawnCell);
		const hang: FauxResponseFactory = (request, options, state, fauxModel) => {
			if (!JSON.stringify(request).includes("You are the subagent")) return parent(request, options, state, fauxModel);
			started();
			return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("closed"))));
		};
		let anchor: number;
		{
			const { standard, root } = await open(dir, hang);
			try {
				// The parent's turn ends at admission; it does not wait for the child.
				assert.equal(await ask(root, "Delegate the primes."), "slow");
				await childStarted;
				const record = Object.values((await standard.harness.snapshot(SubagentsDoc, root.id, context))?.children ?? {})[0]!;
				assert.equal(record.status, "running");
				anchor = record.anchorTaskId;
			} finally {
				await standard.close(context);
			}
		}
		{
			const { standard, root } = await open(dir, script(spawnCell));
			try {
				await standard.harness.waitForTask(anchor as never, context);
				const record = Object.values((await standard.harness.snapshot(SubagentsDoc, root.id, context))?.children ?? {})[0]!;
				assert.equal(record.status, "done");
				assert.equal(record.answer, "2, 3, and 5.");
				const child = (await standard.harness.conversation(record.conversationId as ConversationId, context))!;
				const users = (await child.context(context)).messages.filter((message) => message.role === "user");
				assert.equal(users.length, 1, "the task was delivered once");
			} finally {
				await standard.close(context);
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("subagents: depth limit, sibling names, find_models, rename, delete", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-subagents-"));
	try {
		const parentCell = [
			"a = await rlm.spawn('Check your depth.', name='probe')",
			"try:",
			"    await rlm.spawn('Again.', name='probe')",
			"except Exception as e:",
			"    print('dup:', e)",
			"r = await rlm.collect('probe', timeout_ms=20000)",
			"print('answer:', r[0].answer_preview)",
			"print('models:', [m.selector for m in await rlm.find_models('faux')])",
			"print('renamed:', await rlm.rename('prober', session_id=a))",
			"d = await rlm.delete_subagent('prober')",
			"print('deleted:', d.session_name, d.status, len(await rlm.list_subagents()))",
		].join("\n");
		const childCell = [
			"import os",
			"print('depth', os.environ['RLM_DEPTH'], os.environ['RLM_MAX_DEPTH'])",
			"try:",
			"    await rlm.spawn('Deeper.', name='deeper')",
			"except Exception as e:",
			"    print('refused:', e)",
		].join("\n");
		const { standard, root } = await open(dir, script(parentCell, childCell), 1);
		try {
			const output = await ask(root, "Probe.");
			assert.match(output, /^dup: Agent name "probe" is unavailable/m);
			assert.match(output, /^answer: depth 1 1\nrefused: RLM recursion depth limit reached \(RLM_DEPTH=1, RLM_MAX_DEPTH=1\)/m);
			assert.match(output, /^models: \[.*'faux\/faux-1'.*\]$/m);
			assert.match(output, /^renamed: prober$/m);
			assert.match(output, /^deleted: prober completed 0$/m);

			const doc = await standard.harness.snapshot(SubagentsDoc, root.id, context);
			const records = Object.values(doc?.children ?? {});
			assert.equal(records.length, 1, "the refused spawns recorded nothing");
			assert.equal(records[0]?.deleted, true);
		} finally {
			await standard.close(context);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
