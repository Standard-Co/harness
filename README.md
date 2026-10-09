# Standard

RLM and Python execution inside [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

Standard is a harness for long-running agents. The durability core is Earendil's
Pi Durable: every model request and tool call is a checkpointed task, nothing is
shown before it is committed, and a restarted process continues from the last
checkpoint. The execution model is Prime Intellect's
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) RLM runtime: the
model works in one persistent Python REPL per conversation, keeps its context as
variables, and runs shell commands from there. Standard binds the two: the
kernel's namespace is snapshotted after every cell and recorded in the
transcript's documents, so the variables the model was working with survive a
process restart.

Both upstreams are dependencies, not forks. Pi Durable is pinned by exact
version. The Python runtime is Prime's `prime-agent-runtime` package, unchanged,
speaking its protocol 3 over newline-delimited JSON.

Standard ships one extension: the continual harness, Prime Agent's self-edited
memory layer. Prompt notes, memories, skills, and subagent specs live in Prime's
`harness_state.json` files, which the kernel's `rlm.harness` calls and this host
both read and write. The extension renders them into the system prompt before
each request and runs refinement as a two-phase durable task: `plan` makes one
model call and checkpoints the proposal, `apply` re-reads the file, rejects
edits whose entries changed meanwhile, writes the file, and records the result.
Automatic refinement goes through a review gate every few turns; the model can
also ask for one from the REPL.

Standard ships no model providers. A provider is a pi-ai `Provider` you pass
in, or a module you point the CLI at. The point is a small base that extends
cleanly: the kernel, subagents, and the continual harness are the whole thing,
and everything else, providers included, is yours.

What Standard does not ship: providers, a TUI, a chat CLI, channels, identity,
billing.

## Layout

- `src/kernel/process.ts`: client for one `python -m rlm.repl` process.
- `src/kernel/extension.ts`: the `kernel` extension. One `ipython` tool, a
  per-conversation kernel, the `standard.kernel` document that records the last
  good snapshot, and the prompt sections that explain the REPL to the model.
- `src/continual/state.ts`: Prime's state file format, prompt rendering, and
  proposal parsing, validation, apply with baseline check, and rollback.
- `src/continual/refine.ts`: the `standard.refine` task: review, plan, apply.
- `src/continual/extension.ts`: the `continual` extension: prompt sections, the
  `standard.continual` document with the refinement history, turn-boundary
  scheduling, and the kernel's `refine.run` and `refine.status` host requests.
- `src/subagents/`: the `subagents` extension. `rlm.spawn` from the REPL creates
  a child conversation, a copy of the parent's agent with its own kernel, owned
  by a background anchor task of the parent that delivers the task and records
  the answer in the parent's `standard.subagents` document. `rlm.collect`,
  `list_subagents`, `delete_subagent`, `rename`, `progress_note`, and
  `find_models` read and edit that document. Depth is capped by
  `maxSubagentDepth` (default 3).
- `src/host-requests.ts`: routes the kernel's host requests by type family
  (`refine.*`, `rlm.*`).
- `src/models.ts`: image input: `modelAcceptsImages()`, MIME sniffing, the
  per-image and per-cell caps, and reading an image file as pi-ai
  `ImageContent`.
- `src/harness.ts`: `openStandard()`, which opens Pi Durable on JSONL storage
  with the kernel extension installed.
- `bin/standard.ts`: `standard run "<prompt>" [--image <path>]...`, print mode.

## Run

Requires Node 22.19+, Python 3.11+, and [uv](https://docs.astral.sh/uv/).

```bash
npm install
uv venv -p 3.13 .venv
uv pip install -p .venv/bin/python \
  "prime-agent-runtime @ git+https://github.com/PrimeIntellect-ai/prime-agent@afe8d14c4#subdirectory=prime-agent-runtime" \
  dill
export STANDARD_PROVIDER=./my-provider.ts          # see Providers below
export STANDARD_MODEL=myprovider/some-model
node --experimental-strip-types bin/standard.ts run "Use Python to compute the 30th Fibonacci number and keep it in fib30."
node --experimental-strip-types bin/standard.ts run "What is fib30 squared?"
node --experimental-strip-types bin/standard.ts refine   # one refinement pass, prints the edits
node --experimental-strip-types bin/standard.ts state    # what the model sees
```

## Providers

A provider module is an ES module whose default export is a pi-ai `Provider`,
an array of them, or a function that receives the `Models` catalog. It must be
able to resolve `@earendil-works/pi-ai` from where it lives. An
OpenAI-compatible endpoint is about twenty lines:

```ts
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const baseUrl = "https://llm.example.com/v1";
const model: Model<"openai-completions"> = {
  id: "fast", name: "fast", api: "openai-completions", provider: "example", baseUrl,
  reasoning: false, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 32_000,
};
export default createProvider({
  id: "example", name: "Example", baseUrl,
  auth: { apiKey: envApiKeyAuth("Example key", ["EXAMPLE_API_KEY"]) },
  models: [model], api: openAICompletionsApi(),
});
```

pi-ai's built-in provider factories (`@earendil-works/pi-ai/providers/*`) work
the same way. From code, build the catalog yourself and pass it to
`openStandard({ models })`; `contextWindow` and `maxTokens` on each model are
what the harness uses for compaction, so set them from the real limits.

The second command runs in a new process. The answer comes from the restored
variable, not a recomputation.

State lives in `.standard/`: `transcript/` is the Pi Durable JSONL store,
`kernel/<conversation>/` holds the dill snapshot, its manifest, and the local
`harness/harness_state.json`; `kernel/agent/harness/` holds the global one.

## Container

```bash
scripts/build-image.sh            # builds standard-co/harness:<sha12> and :dev, then smoke-tests
docker volume create standard-state
docker run --rm -e EXAMPLE_API_KEY -v "$PWD/my-provider.ts:/work/my-provider.ts:ro" \
  -v standard-state:/work/.standard standard-co/harness:dev \
  run --provider /work/my-provider.ts --model example/fast \
  "Use Python to compute the 30th Fibonacci number and keep it in fib30."
docker run --rm -v standard-state:/work/.standard standard-co/harness:dev state
```

The image is `node:22-bookworm-slim` pinned by digest, Debian's Python 3.11,
and the harness at `/opt/standard` with production `node_modules` from
`package-lock.json`. The kernel venv at `/opt/standard/venv` holds
`prime-agent-runtime` built from the commit in the Dockerfile's
`PRIME_AGENT_COMMIT` plus `dill`, with every other Python package pinned by
hash in `docker/requirements.txt` (regenerate with the command in
`docker/requirements.in`). The build fails if Python, Node, the REPL's
protocol 3 handshake, or the CLI drift. `/opt/standard/manifest/` lists the
installed Debian, Python, and Node versions.

The container runs as the non-root `standard` user (uid 10001) in `/work`,
so the default `--dir .standard` is `/work/.standard`. Mount a volume there
to keep transcripts and kernel snapshots between runs.

## License

MIT. Placeholder until the license is decided.

## Status

Experimental. Pi Durable's API changes between releases and is pinned here.
Image input works in two directions. A cell calls `show_image(path_or_bytes)`
(a kernel builtin over Prime's `emit` display bridge), and the `ipython` tool
returns the image as an `ImageContent` part of its result: PNG, JPEG, GIF, or
WebP, MIME taken from the bytes, at most 5 MB base64 each and 4 per cell. A
text-only model gets a diagnostic instead. `standard run --image <path>`
attaches images to the prompt and refuses text-only models. Images are stored
inline in the transcript. Subagents report back only through `rlm.collect`;
there is no agent-to-agent messaging. A forked conversation starts with
an empty local harness; the global one is shared.
