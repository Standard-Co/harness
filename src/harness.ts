// Open a Standard harness: Pi Durable on JSONL storage, with the Python
// kernel extension and the configured model providers installed.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Extension, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createKernelExtension } from "./kernel/extension.ts";
import { casedevProvider } from "./providers/casedev.ts";

export interface StandardOptions {
	/** Where transcripts, documents, and kernel snapshots live. */
	readonly dir: string;
	/** Working directory for the kernel and tools. */
	readonly cwd: string;
	/** Python interpreter with prime-agent-runtime installed. */
	readonly python: string;
	readonly models?: MutableModels;
	readonly extensions?: readonly Extension[];
}

export interface Standard {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly models: MutableModels;
	readonly dir: string;
	close(context: Context): Promise<void>;
}

export async function openStandard(options: StandardOptions, context: Context): Promise<Standard> {
	const dir = resolve(options.dir);
	await mkdir(join(dir, "transcript"), { recursive: true });
	await mkdir(join(dir, "kernel"), { recursive: true });

	const models = options.models ?? createModels();
	if (options.models === undefined) {
		models.setProvider(casedevProvider());
		const refreshed = await models.refresh({ providers: ["casedev"] });
		for (const [provider, error] of refreshed.errors) console.error(`[standard] ${provider}: ${String(error)}`);
	}

	const kernel = createKernelExtension({ python: options.python, stateDir: join(dir, "kernel") });
	const registry = createRegistry();
	registry.install(kernel.extension);
	for (const extension of options.extensions ?? []) registry.install(extension);

	const storage = await openNodeJsonlStorage(join(dir, "transcript"), context);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
			settings: { compaction: { reserveTokens: 16_384 } },
		},
		context,
	);

	return {
		harness,
		registry,
		models,
		dir,
		close: async (closeContext) => {
			await kernel.shutdownAll();
			await harness.close(closeContext);
		},
	};
}
