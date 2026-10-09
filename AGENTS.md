# Agent instructions for Standard

Standard is RLM and Python execution inside Pi Durable. Assume the reader of
this file is an agent. Everything here is what you need to extend or change
the harness without reading the whole tree first.

## What this is

- **Pi Durable** (`@earendil-works/pi-durable`, pinned exact version) is the
  durability core: conversations, entries, documents, tasks, submissions,
  extensions. Read its README in `node_modules/@earendil-works/pi-durable/`
  and, for anything subtle, `docs/spec.md` in the same package. We never patch
  it, vendor it, or work around it. If Pi Durable cannot do something, the
  answer is an extension on top or a change upstream, not a fork.
- **prime-agent-runtime** is Prime Agent's Python REPL, installed unchanged
  from a pinned git commit into `.venv` (locally) or `/opt/standard/venv` (in
  the image). It speaks protocol 3 over newline-delimited JSON on stdin and
  stdout. The protocol is in the package: `rlm/repl.md`.
- **Standard** is the roughly 2,500 lines of TypeScript in `src/` and `bin/`
  that bind the two. That is the entire product. Keep it that size.

## Invariants

- No bloat. A change that adds a concept needs a reason the existing
  primitives cannot cover it. Prefer deleting to abstracting.
- No translation layers. Extensions use Pi Durable's types directly. Host
  requests use Prime's wire shapes directly. Do not wrap either.
- No providers ship. The harness never knows a vendor's name. Providers are
  pi-ai `Provider` objects passed in by the caller or loaded by the CLI from a
  module path.
- One bundled extension: the continual harness. Everything else in the
  registry is core (kernel, subagents) or belongs to the caller.
- State is Pi Durable's or Prime's. Transcript, documents, and tasks live in
  Pi Durable storage. Kernel namespace snapshots and continual harness entries
  live in Prime's file formats. Do not add a third store.
- Durability is not optional. A tool that has side effects is `replay:
  "unsafe"`. Anything that must happen exactly once carries a deterministic
  `requestId`. Multi-step work that must survive a crash is a `defineTask`
  with checkpoints, not a promise chain.
- No TUI, no chat CLI, no channels, no identity, no billing. `standard run`
  is print mode for checking that things work. Hosts drive the harness from
  code through `openStandard()`.

## Layout

```
bin/standard.ts            CLI: run | refine | state. Loads --provider modules.
src/harness.ts             openStandard(): storage, registry, env, wiring.
src/host-requests.ts       Routes the kernel's host_request events by type family.
src/kernel/process.ts      Client for one `python -m rlm.repl` process.
src/kernel/extension.ts    The `ipython` tool, one kernel per conversation,
                           the standard.kernel snapshot document, show_image().
src/subagents/             rlm.spawn / collect / list / delete / rename /
                           progress.note / find_models on task-owned children.
src/continual/             The continual harness: state file format, prompt
                           sections, the standard.refine task.
src/models.ts              Image input helpers; modelAcceptsImages().
test/                      node:test, faux provider, real kernels.
Dockerfile, scripts/       The pinned, self-verifying image.
```

## How it fits together

One conversation = one transcript + one Python kernel. The model has one tool,
`ipython`. A cell runs in the kernel; stdout, results, errors, and emitted
images come back as the tool result. After every cell the kernel's namespace
is snapshotted with dill and the path is recorded in the `standard.kernel`
document, so a restarted process restores it before the next cell. Python
code that needs the host (spawning a subagent, asking for a refinement) sends
a `host_request`; `src/host-requests.ts` routes it by its `type` prefix.

The system prompt is built from extension sections before each request. Pi
Durable only resends sections that changed, so a section must be
deterministic. Static text goes in its own section so it stays cached;
dynamic state goes in another.

State on disk, under `--dir` (default `.standard/`):

```
transcript/                       Pi Durable JSONL storage (greppable)
kernel/<conversation>/            kernel-state.dill + .json, harness/harness_state.json (local)
kernel/agent/harness/             harness_state.json (global, shared by all conversations)
```

## Extending

### A provider

A pi-ai `Provider`. For an OpenAI-compatible endpoint, `createProvider` with
`openAICompletionsApi()` and a static model list, or `fetchModels` for a
dynamic catalog. Set `contextWindow` and `maxTokens` from the real limits;
compaction depends on them. Set `input: ["text", "image"]` only if the model
really accepts images; the harness checks that before attaching any. From
code: `models.setProvider(p)`, `await models.refresh()`, then
`openStandard({ models })`. From the CLI: a module whose default export is
the provider, `--provider ./p.ts`. See the README's Providers section.

### A tool

`defineTool` inside `defineExtension`, installed into the registry via
`openStandard({ extensions })`. Declare `replay`. Read documents through
`api`, write them in `api.commit`. Do not reach into the kernel from a tool;
if the model needs Python, it already has `ipython`.

### A host request

Python calls `await rlm.repl.host_request({"type": "family.op", ...})`. Add a
handler for the family in `routeHostRequests` (wired in `src/harness.ts`). A
handler receives the origin (conversation, task, call) and returns a JSON
reply; a thrown error becomes a Python exception in the cell. Match the shape
Prime's parsers expect if the call comes from `rlm.*`; read
`prime-agent-runtime/src/rlm/__init__.py` for those.

### A durable task

`defineTask` with named phases. Each phase ends in `runtime.commit` returning
the next state. Do the effect between the intent commit and the outcome
commit, and make the phase idempotent from its checkpoint. Tasks belong to an
extension's `tasks` so they resume after a restart. `src/continual/refine.ts`
is the reference: review, plan (one model call, checkpointed), apply.

### A prompt section

`section(key, render)`. Deterministic output for a given committed state.
Return `undefined` to omit. Keep static guidance and dynamic state in
separate sections.

## Working here

- Run: `npx tsc --noEmit` and `node --experimental-strip-types --test test/*.test.ts`.
  Both must be clean before a commit. Tests use the faux provider and real
  kernels; they need `.venv` (see README).
- Tests cover guarantees, not features: crash recovery, exactly-once,
  restart safety, the wire format. Add a test when you add a guarantee.
  Delete tests that stop paying for themselves.
- Dependencies: none beyond pi-durable, pi-ai, chord, typebox. Adding one
  needs a reason in the commit message.
- Pinning: Pi Durable by exact version in `package.json`; the Python runtime
  by full commit in the Dockerfile and README. Bump deliberately, run the
  suite, note protocol changes.
- Style: tabs, small files, comments only where the reason is not obvious
  from the code. No `any` unless unavoidable. No inline imports.
- Commits: one change each, message says why. Do not push unless asked.
- The `notes.md` file is local and gitignored. Decisions that are not yet in
  code go there.
