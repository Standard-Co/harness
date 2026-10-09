// A client for one `python -m rlm.repl` process: Prime Agent's REPL runtime,
// protocol 3. Newline-delimited JSON. Requests go in on stdin; events come
// back on the process's stdout. See prime-agent-runtime/src/rlm/repl.md.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export const KERNEL_PROTOCOL = 3;

export type KernelEvent =
	| { event: "ready"; protocol: number; python: string }
	| { event: "stdout" | "stderr"; id: string | null; text: string }
	| { event: "result"; id: string; text: string }
	| { event: "display"; id: string | null; data: Record<string, unknown> }
	| { event: "host_request"; id: string; data: Record<string, unknown> }
	| { event: "error"; id: string | null; ename: string; evalue: string; traceback: string[] }
	| { event: "done"; id: string; status: "ok" | "error"; [key: string]: unknown };

export interface CellOutput {
	readonly status: "ok" | "error";
	/** stdout/stderr/result/error text in arrival order. */
	readonly text: string;
	readonly displays: ReadonlyArray<Record<string, unknown>>;
	readonly error?: { ename: string; evalue: string; traceback: string[] };
}

export interface SnapshotResult {
	readonly status: "ok" | "error";
	readonly saved?: string[];
	readonly skipped?: string[];
	readonly pruned?: string[];
	readonly bytes?: number;
	readonly reason?: string;
}

export interface RestoreResult {
	readonly status: "ok" | "error";
	readonly restored?: string[];
	readonly failed?: string[];
	readonly reason?: string;
}

export type HostRequestHandler = (data: Record<string, unknown>) => Promise<unknown>;

export interface KernelOptions {
	readonly python: string;
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Answers `host_request` events. Unhandled types fail the call inside Python. */
	readonly hostRequest?: HostRequestHandler;
	/** Receives streaming text (stdout/stderr) while a cell runs. */
	readonly onOutput?: (text: string, stream: "stdout" | "stderr") => void;
}

interface Pending {
	readonly chunks: string[];
	readonly displays: Record<string, unknown>[];
	error?: { ename: string; evalue: string; traceback: string[] };
	resolve: (done: Extract<KernelEvent, { event: "done" }>) => void;
	reject: (error: Error) => void;
}

export class KernelProcess {
	readonly #child: ChildProcess;
	readonly #pending = new Map<string, Pending>();
	readonly #options: KernelOptions;
	#seq = 0;
	#ready: Promise<{ protocol: number; python: string }>;
	#exited: Promise<number | null>;
	#closed = false;

	private constructor(options: KernelOptions) {
		this.#options = options;
		this.#child = spawn(options.python, ["-m", "rlm.repl"], {
			cwd: options.cwd,
			env: { ...process.env, NO_COLOR: "1", PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid), ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let resolveReady!: (value: { protocol: number; python: string }) => void;
		let rejectReady!: (error: Error) => void;
		this.#ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		this.#exited = new Promise((resolve) => {
			this.#child.on("exit", (code) => {
				this.#closed = true;
				for (const pending of this.#pending.values()) pending.reject(new Error(`kernel exited (${code})`));
				this.#pending.clear();
				rejectReady(new Error(`kernel exited before ready (${code})`));
				resolve(code);
			});
		});
		this.#child.on("error", (error) => rejectReady(error));
		const lines = createInterface({ input: this.#child.stdout! });
		lines.on("line", (line) => this.#handle(line, resolveReady));
		// The kernel redirects its own fds 1 and 2 into the protocol, so stderr
		// here only carries interpreter-level noise.
		this.#child.stderr!.on("data", (chunk: Buffer) => this.#options.onOutput?.(chunk.toString(), "stderr"));
	}

	static async start(options: KernelOptions): Promise<KernelProcess> {
		const kernel = new KernelProcess(options);
		const ready = await kernel.#ready;
		if (ready.protocol !== KERNEL_PROTOCOL) {
			await kernel.shutdown();
			throw new Error(`kernel protocol ${ready.protocol}, expected ${KERNEL_PROTOCOL}`);
		}
		return kernel;
	}

	get closed(): boolean {
		return this.#closed;
	}

	#send(frame: Record<string, unknown>): void {
		if (this.#closed) throw new Error("kernel is closed");
		this.#child.stdin!.write(`${JSON.stringify(frame)}\n`);
	}

	#request(frame: Record<string, unknown>): Promise<Extract<KernelEvent, { event: "done" }>> {
		const id = `r${++this.#seq}`;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { chunks: [], displays: [], resolve, reject });
			this.#send({ ...frame, id });
		});
	}

	#handle(line: string, resolveReady: (value: { protocol: number; python: string }) => void): void {
		let event: KernelEvent;
		try {
			event = JSON.parse(line) as KernelEvent;
		} catch {
			this.#options.onOutput?.(line, "stderr");
			return;
		}
		switch (event.event) {
			case "ready":
				resolveReady({ protocol: event.protocol, python: event.python });
				return;
			case "stdout":
			case "stderr": {
				const pending = event.id === null ? this.#onlyPending() : this.#pending.get(event.id);
				pending?.chunks.push(event.text);
				this.#options.onOutput?.(event.text, event.event);
				return;
			}
			case "result":
				this.#pending.get(event.id)?.chunks.push(event.text.endsWith("\n") ? event.text : `${event.text}\n`);
				return;
			case "display": {
				const pending = event.id === null ? this.#onlyPending() : this.#pending.get(event.id);
				pending?.displays.push(event.data);
				return;
			}
			case "error": {
				const pending = event.id === null ? this.#onlyPending() : this.#pending.get(event.id);
				if (pending === undefined) return;
				pending.error = { ename: event.ename, evalue: event.evalue, traceback: event.traceback };
				pending.chunks.push(`${event.traceback.join("\n")}\n`);
				return;
			}
			case "host_request":
				void this.#answer(event.id, event.data);
				return;
			case "done": {
				const pending = this.#pending.get(event.id);
				if (pending === undefined) return;
				this.#pending.delete(event.id);
				pending.resolve(event);
				return;
			}
		}
	}

	/** Output with no cell id is attributed to the single in-flight cell, if there is exactly one. */
	#onlyPending(): Pending | undefined {
		return this.#pending.size === 1 ? this.#pending.values().next().value : undefined;
	}

	async #answer(id: string, data: Record<string, unknown>): Promise<void> {
		const handler = this.#options.hostRequest;
		let reply: Record<string, unknown>;
		try {
			if (handler === undefined) throw new Error(`host request ${String(data.type)} is not supported by this host`);
			reply = { status: "ok", result: await handler(data) };
		} catch (error) {
			reply = { status: "error", error: error instanceof Error ? error.message : String(error) };
		}
		if (!this.#closed) this.#send({ type: "host_reply", id, data: reply });
	}

	async execute(code: string): Promise<CellOutput> {
		const id = `r${++this.#seq}`;
		const pending: Pending = { chunks: [], displays: [], resolve: () => {}, reject: () => {} };
		const done = await new Promise<Extract<KernelEvent, { event: "done" }>>((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
			this.#pending.set(id, pending);
			this.#send({ type: "execute", code, id });
		});
		return {
			status: done.status,
			text: pending.chunks.join(""),
			displays: pending.displays,
			...(pending.error === undefined ? {} : { error: pending.error }),
		};
	}

	interrupt(): void {
		this.#send({ type: "interrupt" });
	}

	async snapshot(path: string, manifestPath: string, caps?: { maxBytes?: number; maxVariableBytes?: number }): Promise<SnapshotResult> {
		const done = await this.#request({
			type: "snapshot",
			path,
			manifest_path: manifestPath,
			...(caps?.maxBytes === undefined ? {} : { max_bytes: caps.maxBytes }),
			...(caps?.maxVariableBytes === undefined ? {} : { max_variable_bytes: caps.maxVariableBytes }),
		});
		return done as unknown as SnapshotResult;
	}

	async restore(path: string): Promise<RestoreResult> {
		return (await this.#request({ type: "restore", path })) as unknown as RestoreResult;
	}

	async listNames(): Promise<string[]> {
		const done = await this.#request({ type: "list_names" });
		return (done.names as string[] | undefined) ?? [];
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		try {
			this.#send({ type: "shutdown" });
		} catch {
			// already gone
		}
		const timer = setTimeout(() => this.#child.kill("SIGKILL"), 5_000);
		await this.#exited;
		clearTimeout(timer);
	}
}
