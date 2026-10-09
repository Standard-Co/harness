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

What Standard does not ship: a TUI, a chat CLI, channels, identity, billing.

## Layout

- `src/kernel/process.ts`: client for one `python -m rlm.repl` process.
- `src/kernel/extension.ts`: the `kernel` extension. One `ipython` tool, a
  per-conversation kernel, the `standard.kernel` document that records the last
  good snapshot, and the prompt sections that explain the REPL to the model.
- `src/providers/casedev.ts`: case.dev as a pi-ai provider, with the catalog's
  real context windows and output caps.
- `src/harness.ts`: `openStandard()`, which opens Pi Durable on JSONL storage
  with the kernel extension installed.
- `bin/standard.ts`: `standard run "<prompt>"`, print mode.

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
```

The second command runs in a new process. The answer comes from the restored
variable, not a recomputation.

State lives in `.standard/`: `transcript/` is the Pi Durable JSONL store,
`kernel/<conversation>/` holds the dill snapshot and its manifest.

## License

MIT. Placeholder until the license is decided.

## Status

Experimental. Pi Durable's API changes between releases and is pinned here.
Image input, subagents, and the continual harness are not wired yet.
