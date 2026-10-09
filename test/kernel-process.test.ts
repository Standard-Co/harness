import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { KernelProcess } from "../src/kernel/process.ts";

const python = process.env.STANDARD_PYTHON ?? resolve(import.meta.dirname, "../.venv/bin/python");

test("kernel: execute, host_request, snapshot, restore", async () => {
	const dir = await mkdtemp(join(tmpdir(), "standard-kernel-"));
	const seen: Record<string, unknown>[] = [];
	const kernel = await KernelProcess.start({
		python,
		cwd: dir,
		hostRequest: async (data) => {
			seen.push(data);
			return { echo: data.type };
		},
	});
	try {
		const a = await kernel.execute("x = 41\nx + 1");
		assert.equal(a.status, "ok");
		assert.equal(a.text.trim(), "42");

		const b = await kernel.execute("from rlm.repl import host_request\nprint(await host_request({'type': 'ping'}))");
		assert.equal(b.status, "ok");
		assert.match(b.text, /echo.*ping/);
		assert.equal(seen[0]?.type, "ping");

		const c = await kernel.execute("1/0");
		assert.equal(c.status, "error");
		assert.equal(c.error?.ename, "ZeroDivisionError");

		const snap = await kernel.snapshot(join(dir, "s.dill"), join(dir, "s.json"));
		assert.equal(snap.status, "ok");
		assert.deepEqual(snap.saved, ["x"]);
	} finally {
		await kernel.shutdown();
	}

	const revived = await KernelProcess.start({ python, cwd: dir });
	try {
		const restored = await revived.restore(join(dir, "s.dill"));
		assert.equal(restored.status, "ok");
		assert.deepEqual(restored.restored, ["x"]);
		const d = await revived.execute("x");
		assert.equal(d.text.trim(), "41");
	} finally {
		await revived.shutdown();
		await rm(dir, { recursive: true, force: true });
	}
});
