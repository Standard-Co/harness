import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openStandard } from "../src/harness.ts";
import { KernelDoc } from "../src/kernel/extension.ts";
import { readImageFile } from "../src/models.ts";

const python = process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python");
const context = BACKGROUND_CONTEXT;

// A cell that writes a 1x1 PNG with the standard library and shows it `times` times.
const showPixel = (times: number) => String.raw`
import struct, zlib
def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + _chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + _chunk(b"IEND", b"")
open("pixel.png", "wb").write(png)
for _ in range(${times}):
    show_image("pixel.png")
print("shown")
`;

const imagesIn = (messages: readonly Message[], role: Message["role"]): ImageContent[] =>
	messages.flatMap((m) => (m.role === role && Array.isArray(m.content) ? m.content.filter((c): c is ImageContent => c.type === "image") : []));

async function withStandard(models: ReturnType<typeof createModels>, run: (standard: Awaited<ReturnType<typeof openStandard>>, dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "standard-images-"));
	try {
		const standard = await openStandard({ dir, cwd: dir, python, models, reviewEvery: 0 }, context);
		try {
			await run(standard, dir);
		} finally {
			await standard.close(context);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("images: show_image in a cell reaches the transcript and the next model request, capped per cell", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let request: TranscriptContext | undefined;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code: showPixel(5) }), { stopReason: "toolUse" }),
		(ctx) => {
			request = ctx;
			return fauxAssistantMessage("A green pixel.");
		},
	]);
	await withStandard(models, async (standard, dir) => {
		const root = await standard.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dir } });
		const settled = await (await root.submit({ type: "input", content: "Show me the pixel." }, context)).wait(context);
		assert.equal(settled.status, "done");

		const { messages } = await root.context(context);
		const result = messages.find((m) => m.role === "toolResult");
		assert.ok(result && result.role === "toolResult");
		assert.equal(result.isError, false);
		const images = imagesIn([result], "toolResult");
		assert.equal(images.length, 4, "five shown, four kept");
		assert.equal(images[0]?.mimeType, "image/png");
		assert.ok(Buffer.from(images[0]!.data, "base64").subarray(1, 4).toString() === "PNG");
		const text = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
		assert.match(text, /shown/);
		assert.match(text, /at most 4 images per cell/);

		assert.ok(request, "the second model call happened");
		const sent = imagesIn(request.messages, "toolResult");
		assert.equal(sent.length, 4);
		assert.equal(sent[0]?.data, images[0]?.data);

		const kernel = await standard.harness.snapshot(KernelDoc, root.id, context);
		assert.ok(kernel?.savedNames.includes("png") && !kernel.savedNames.includes("show_image"), "show_image is a builtin, not a persisted variable");
	});
});

test("images: a text-only model gets a diagnostic and no image content", async () => {
	const faux = fauxProvider({ models: [{ id: "faux-text", input: ["text"] }] });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(fauxToolCall("ipython", { code: showPixel(1) }), { stopReason: "toolUse" }), fauxAssistantMessage("I cannot see it.")]);
	await withStandard(models, async (standard, dir) => {
		const root = await standard.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-text" }, cwd: dir } });
		await (await root.submit({ type: "input", content: "Show me the pixel." }, context)).wait(context);
		const { messages } = await root.context(context);
		const result = messages.find((m) => m.role === "toolResult");
		assert.ok(result && result.role === "toolResult");
		assert.equal(imagesIn(messages, "toolResult").length, 0);
		assert.match(JSON.stringify(result.content), /1 image\(s\) dropped: faux\/faux-text is text-only/);
		assert.match(JSON.stringify(result.content), /shown/);
	});
});

test("images: an image in user input reaches the model request", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let request: TranscriptContext | undefined;
	faux.setResponses([
		(ctx) => {
			request = ctx;
			return fauxAssistantMessage("A pixel.");
		},
	]);
	await withStandard(models, async (standard, dir) => {
		const { execFileSync } = await import("node:child_process");
		execFileSync(python, ["-c", showPixel(0).replace(/^print.*$/m, "")], { cwd: dir });
		const image = await readImageFile(join(dir, "pixel.png"));
		assert.equal(image.mimeType, "image/png");
		const root = await standard.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		await (await root.submit({ type: "input", content: [{ type: "text", text: "What is this?" }, image] }, context)).wait(context);
		assert.ok(request);
		assert.deepEqual(imagesIn(request.messages, "user"), [image]);
	});
});

test("images: an OpenAI-compatible wire request carries the cell's image as an image_url data URL", async () => {
	const bodies: Record<string, unknown>[] = [];
	const read = async (req: IncomingMessage) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		return raw;
	};
	const sse = (chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
	const chunk = (delta: object, finish: string | null) => ({ id: "c", object: "chat.completion.chunk", created: 0, model: "vision", choices: [{ index: 0, delta, finish_reason: finish }] });
	const server = createServer(async (req, res) => {
		if (req.url?.endsWith("/models")) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "vision", context_window: 100_000, max_tokens: 4_096, modalities: { input: ["text", "image"] } }] }));
			return;
		}
		bodies.push(JSON.parse(await read(req)));
		res.setHeader("content-type", "text/event-stream");
		if (bodies.length === 1) {
			const call = { index: 0, id: "call_1", type: "function", function: { name: "ipython", arguments: JSON.stringify({ code: showPixel(1) }) } };
			res.end(sse([chunk({ role: "assistant", tool_calls: [call] }, null), chunk({}, "tool_calls")]));
		} else {
			res.end(sse([chunk({ role: "assistant", content: "A green pixel." }, null), chunk({}, "stop")]));
		}
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "compat",
				name: "OpenAI-compatible test server",
				baseUrl,
				auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "sk_test" } }) } },
				models: [{ id: "vision", name: "vision", api: "openai-completions", provider: "compat", baseUrl, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096 }],
				api: openAICompletionsApi(),
			}),
		);
		await withStandard(models, async (standard, dir) => {
			const root = await standard.harness.root(context, { agent: { model: { provider: "compat", modelId: "vision" }, cwd: dir } });
			const settled = await (await root.submit({ type: "input", content: "Show me the pixel." }, context)).wait(context);
			assert.equal(settled.status, "done");
		});
		assert.equal(bodies.length, 2);
		const wire = JSON.stringify(bodies[1]);
		assert.match(wire, /"type":"image_url","image_url":\{"url":"data:image\/png;base64,iVBORw0KGgo/);
	} finally {
		server.close();
	}
});
