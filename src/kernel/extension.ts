// The kernel extension: Prime Agent's RLM runtime as one Pi Durable tool.
//
// Each conversation owns one persistent Python REPL. The `ipython` tool runs
// a cell in it. After every cell the kernel's namespace is snapshotted with
// dill and the snapshot is recorded in a per-conversation document, so a
// restarted process revives the variables the model was working with. The
// snapshot binding is what makes the REPL durable in the Pi Durable sense:
// the transcript says what ran, the document says what state survived.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	section,
	type ConversationId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { KernelProcess } from "./process.ts";

export type KernelState = {
	/** Absolute path of the last good dill snapshot, or null before the first one. */
	snapshotPath: string | null;
	manifestPath: string | null;
	savedNames: string[];
	skippedNames: string[];
	/** Cells executed in this conversation, for the prompt and for diagnostics. */
	cells: number;
	/** Last snapshot failure, if any; cleared on the next success. */
	lastError: string | null;
};

export const KernelDoc = defineDoc<KernelState>({
	kind: "standard.kernel",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ snapshotPath: null, manifestPath: null, savedNames: [], skippedNames: [], cells: 0, lastError: null }),
});

export interface KernelExtensionOptions {
	readonly python: string;
	/** Directory for per-conversation snapshots. */
	readonly stateDir: string;
	/** Answers the kernel's `host_request` events for one conversation. Unhandled types fail the call inside Python. */
	readonly hostRequest?: (conversationId: ConversationId, data: Record<string, unknown>, context: Context) => Promise<unknown>;
	readonly snapshotCaps?: { maxBytes?: number; maxVariableBytes?: number };
}

// Mirrors Prime Agent's bootstrap cell: bind `rlm`, `bash`, and `mcp` in the
// namespace, or a stub that explains what is missing.
const BOOTSTRAP_CELL = `
import asyncio
import os as _standard_os
_standard_os.environ["NO_COLOR"] = "1"
try:
    import rlm as _standard_rlm_module
    rlm = _standard_rlm_module.rlm
    bash = _standard_rlm_module.bash
    import rlm.mcp as mcp
except Exception as _standard_rlm_error:
    _STANDARD_RLM_IMPORT_ERROR = str(_standard_rlm_error)
    class _StandardMissingRlm:
        def __getattr__(self, name):
            raise RuntimeError("prime-agent-runtime is not installed in this kernel: " + _STANDARD_RLM_IMPORT_ERROR)
    rlm = _StandardMissingRlm()
    def bash(command):
        raise RuntimeError("prime-agent-runtime is not installed in this kernel: " + _STANDARD_RLM_IMPORT_ERROR)
`.trim();

const TOOL_DESCRIPTION =
	"Execute Python code in a persistent Python REPL. Top-level `await` is supported. Variables, imports, and loaded data persist across calls and across sessions (objects that cannot be serialized are dropped and reported). Run shell commands with `await bash('cmd')`. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment, not the kernel's.";

const RUNTIME_SECTION = [
	"The `ipython` tool is your long-lived notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and shell commands. Keep intermediate results in named variables so you can revisit them without re-reading. Write small helper functions. State survives across turns and across sessions.",
	"",
	"Do not assume the REPL is the native runtime of the thing you are investigating. A repository, package, service, dataset, or API has its own environment and interface; evaluate it through that interface and use the REPL to coordinate and analyze what comes back. Do not install a project's dependencies into the kernel to make it import there.",
	"",
	"Shell commands run with `await bash('...')`. Each call is a throw-away subshell, so `cd`, `export`, and shell variables do not carry over; set `os.environ` or `os.chdir` in Python for state that should persist.",
	"",
	"When you are done, stop calling tools and state your final answer.",
].join("\n");

export interface KernelExtension {
	readonly extension: Extension;
	shutdownAll(): Promise<void>;
}

export function createKernelExtension(options: KernelExtensionOptions): KernelExtension {
	const kernels = new Map<ConversationId, Promise<KernelProcess>>();

	async function kernelFor(api: ToolExecutionApi, context: Context): Promise<KernelProcess> {
		const existing = kernels.get(api.conversationId);
		if (existing !== undefined) {
			const kernel = await existing;
			if (!kernel.closed) return kernel;
			kernels.delete(api.conversationId);
		}
		const starting = (async () => {
			const agent = await api.agent(context);
			const cwd = agent.cwd ?? process.cwd();
			const conversationDir = join(options.stateDir, String(api.conversationId));
			await mkdir(conversationDir, { recursive: true });
			const kernel = await KernelProcess.start({
				python: options.python,
				cwd,
				env: {
					RLM_SESSION_DIR: conversationDir,
					RLM_HARNESS_STATE_DIR: join(conversationDir, "harness"),
					PRIME_AGENT_CODING_AGENT_DIR: join(options.stateDir, "agent"),
					RLM_DEPTH: "0",
					RLM_MAX_DEPTH: "0",
				},
				hostRequest: options.hostRequest === undefined ? undefined : (data) => options.hostRequest!(api.conversationId, data, BACKGROUND),
			});
			const boot = await kernel.execute(BOOTSTRAP_CELL);
			if (boot.status !== "ok") {
				await kernel.shutdown();
				throw new Error(`kernel bootstrap failed: ${boot.text}`);
			}
			// Revive the namespace from the last committed snapshot, if the file still exists.
			const state = await api.snapshot(KernelDoc, api.conversationId, context);
			if (state?.snapshotPath && existsSync(state.snapshotPath)) {
				const restored = await kernel.restore(state.snapshotPath);
				if (restored.status !== "ok") api.diagnostic({ severity: "warn", message: `kernel state not restored: ${restored.reason ?? "unknown"}` });
				else if ((restored.failed?.length ?? 0) > 0) api.diagnostic({ severity: "info", message: `kernel state partially restored; failed: ${restored.failed!.join(", ")}` });
			}
			return kernel;
		})();
		kernels.set(api.conversationId, starting);
		try {
			return await starting;
		} catch (error) {
			kernels.delete(api.conversationId);
			throw error;
		}
	}

	const ipython = defineTool({
		name: "ipython",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			code: Type.String({ description: "Python code to execute in the persistent REPL." }),
		}),
		// A cell has arbitrary side effects; after a crash the model is told it was interrupted.
		replay: "unsafe",
		executionMode: "sequential",
		outputLimits: { maxBytes: 64 * 1024, maxLines: 2_000, retain: "head" },
		execute: async (args, api, context) => {
			const kernel = await kernelFor(api, context);
			const output = await kernel.execute(args.code);
			if (output.text.length > 0) api.output(output.text);

			// Snapshot the namespace and record it, so a restarted process can revive it.
			const conversationDir = join(options.stateDir, String(api.conversationId));
			const snapshotPath = join(conversationDir, "kernel-state.dill");
			const manifestPath = join(conversationDir, "kernel-state.json");
			const snapshot = await kernel.snapshot(snapshotPath, manifestPath, options.snapshotCaps);
			await api.commit(async (tx) => {
				const state = await tx.doc(KernelDoc, api.conversationId);
				state.cells += 1;
				if (snapshot.status === "ok") {
					state.snapshotPath = snapshotPath;
					state.manifestPath = manifestPath;
					state.savedNames = snapshot.saved ?? [];
					state.skippedNames = snapshot.skipped ?? [];
					state.lastError = null;
				} else {
					state.lastError = snapshot.reason ?? "snapshot failed";
				}
			}, context);
			if (snapshot.status !== "ok") {
				api.diagnostic({ severity: "warn", message: `kernel state not saved: ${snapshot.reason ?? "unknown"}` });
			} else if ((snapshot.skipped?.length ?? 0) > 0) {
				api.diagnostic({ severity: "info", message: `not persisted (too large or unpicklable): ${snapshot.skipped!.join(", ")}` });
			}

			if (output.status !== "ok") {
				return { isError: true, ...(output.text.length === 0 ? { content: [{ type: "text", text: output.error?.evalue ?? "cell failed" }] } : {}) };
			}
			return output.text.length === 0 ? { content: [{ type: "text", text: "(no output)" }] } : {};
		},
	});

	const extension = defineExtension({
		name: "kernel",
		tools: [ipython],
		sections: [
			section("runtime", () => RUNTIME_SECTION),
			section("kernel-state", async (input, context) => {
				const state = await input.read.snapshot(KernelDoc, input.conversationId, context);
				if (state === undefined || state.savedNames.length === 0) return undefined;
				return `Variables persisted from earlier work: ${state.savedNames.join(", ")}. They are available in the REPL.`;
			}),
		],
	});

	return {
		extension,
		shutdownAll: async () => {
			const running = [...kernels.values()];
			kernels.clear();
			await Promise.all(running.map(async (kernel) => (await kernel).shutdown().catch(() => undefined)));
		},
	};
}
