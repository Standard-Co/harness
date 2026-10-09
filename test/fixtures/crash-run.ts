// Starts a run whose first tool call sleeps in the kernel, then waits to be killed.
// Usage: node --experimental-strip-types test/fixtures/crash-run.ts <dir> <python>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openStandard } from "../../src/harness.ts";

const [dir, python] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(
		[fauxToolCall("ipython", { code: `open(${JSON.stringify(join(dir, "started"))}, "w").write("1")\nimport time\ntime.sleep(60)` }, { id: "call-1" })],
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage("never reached"),
]);
const standard = await openStandard({ dir, cwd: dir, python, models }, context);
const root = await standard.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
writeFileSync(join(dir, "pid"), String(process.pid));
await (await root.submit({ type: "input", content: "sleep", requestId: "crash-1" }, context)).wait(context);
