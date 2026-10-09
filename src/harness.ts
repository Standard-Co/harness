// Open a Standard harness: Pi Durable on JSONL storage, with the kernel,
// subagents, and continual harness installed. Standard ships no model
// providers; the caller passes a pi-ai catalog with its providers set.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Extension, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createContinualExtension, type ContinualExtension } from "./continual/extension.ts";
import { routeHostRequests } from "./host-requests.ts";
import { createKernelExtension } from "./kernel/extension.ts";
import { createSubagentsExtension, type SubagentsExtension } from "./subagents/extension.ts";

export interface StandardOptions {
	/** Where transcripts, documents, and kernel snapshots live. */
	readonly dir: string;
	/** Working directory for the kernel and tools. */
	readonly cwd: string;
	/** Python interpreter with prime-agent-runtime installed. */
	readonly python: string;
	/** pi-ai catalog with providers already set and, for dynamic catalogs, refreshed. */
	readonly models: MutableModels;
	readonly extensions?: readonly Extension[];
	/** Review for automatic refinement every N answered turns; 0 disables. Default 4. */
	readonly reviewEvery?: number;
	/** Deepest subagent level; an agent at this depth cannot spawn. Default 3. */
	readonly maxSubagentDepth?: number;
}

export interface Standard {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly models: MutableModels;
	readonly dir: string;
	readonly continual: ContinualExtension;
	readonly subagents: SubagentsExtension;
	close(context: Context): Promise<void>;
}

export async function openStandard(options: StandardOptions, context: Context): Promise<Standard> {
	const dir = resolve(options.dir);
	await mkdir(join(dir, "transcript"), { recursive: true });
	await mkdir(join(dir, "kernel"), { recursive: true });

	const { models } = options;

	// Core: the kernel and subagents. Bundled extension: the continual harness. Nothing else ships by default.
	const continual = createContinualExtension({ stateDir: join(dir, "kernel"), ...(options.reviewEvery === undefined ? {} : { reviewEvery: options.reviewEvery }) });
	const subagents = createSubagentsExtension({
		stateDir: join(dir, "kernel"),
		models,
		...(options.maxSubagentDepth === undefined ? {} : { maxDepth: options.maxSubagentDepth }),
	});
	const kernel = createKernelExtension({
		python: options.python,
		stateDir: join(dir, "kernel"),
		env: subagents.kernelEnv,
		hostRequest: routeHostRequests({
			refine: (origin, data, context) => continual.hostRequest(origin.conversationId, data, context),
			rlm: subagents.hostRequest,
		}),
	});
	const registry = createRegistry();
	registry.install(kernel.extension);
	registry.install(subagents.extension);
	registry.install(continual.extension);
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
	continual.attach(harness);
	subagents.attach(harness);

	return {
		harness,
		continual,
		subagents,
		registry,
		models,
		dir,
		close: async (closeContext) => {
			await kernel.shutdownAll();
			await harness.close(closeContext);
		},
	};
}
