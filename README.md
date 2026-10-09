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

What Standard does not ship: a TUI, a chat CLI, channels, identity, billing.

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
- `src/models.ts`: image input: `modelAcceptsImages()`, MIME sniffing, the
  per-image and per-cell caps, and reading an image file as pi-ai
  `ImageContent`.
- `src/providers/casedev.ts`: case.dev as a pi-ai provider, with the catalog's
  real context windows and output caps.
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
export CASEDEV_API_KEY=sk_case_...
node --experimental-strip-types bin/standard.ts run "Use Python to compute the 30th Fibonacci number and keep it in fib30."
node --experimental-strip-types bin/standard.ts run "What is fib30 squared?"
node --experimental-strip-types bin/standard.ts refine   # one refinement pass, prints the edits
node --experimental-strip-types bin/standard.ts state    # what the model sees
```

The second command runs in a new process. The answer comes from the restored
variable, not a recomputation.

State lives in `.standard/`: `transcript/` is the Pi Durable JSONL store,
`kernel/<conversation>/` holds the dill snapshot, its manifest, and the local
`harness/harness_state.json`; `kernel/agent/harness/` holds the global one.

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
inline in the transcript. Subagents are not wired yet. A forked conversation starts with
an empty local harness; the global one is shared.
