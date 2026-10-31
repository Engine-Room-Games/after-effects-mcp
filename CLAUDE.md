# Claude development guide — after-effects-mcp

This file is for future Claude Code sessions working in this repo. Humans reading it: see `README.md` for the user-facing intro.

**This file is the core, and it is loaded on every task.** It holds what is
needed to orient and what silently produces wrong output if you do not know it.
Everything else — the measured traps, the subsystem reasoning, the live-AE
recipes — sits behind it in `docs/`, opened when a task reaches that subject.
The same split the guides use, for the same reason: prose resident in every
session is a tax on every request the user ever makes.

| Read | When |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | The annotated source tree, and the op path in detail: the one op whose input is rewritten, cross-field rules, closed arguments and batch steps, the special return shapes, tool annotations, write serialization, the front desk, the tool switches. |
| [`docs/subsystems.md`](docs/subsystems.md) | Panel version gating and capabilities, the project scaffold, the house style, filesystem checks on the server, comp snapshots and checkpoints, the issue journal. |
| [`docs/guidance-system.md`](docs/guidance-system.md) | How agent guidance is written once and generated into every carrier. Read before touching anything under `src/guides/` or `src/prompts/`. |
| [`docs/fragile-areas-ae.md`](docs/fragile-areas-ae.md) | Measured After Effects and ExtendScript behaviour: undo, shapes, text, audio, mogrt, expressions, `run_jsx`. |
| [`docs/fragile-areas-bridge.md`](docs/fragile-areas-bridge.md) | The bridge, ports, CEP, the panel, and the screenshot pipeline. |
| [`docs/fragile-areas-server.md`](docs/fragile-areas-server.md) | Tool schemas and the MCP protocol, the journal's caches, packaging and binaries. |
| [`docs/verification-recipes.md`](docs/verification-recipes.md) | The 76 recipes run by hand against a live AE 2026. |

**Nothing in `docs/` is generated** — hand-written, like this file. The generated
prose is elsewhere and is called out below.

**Driving After Effects is not this file's subject.** `.mcp.json` connects this
server to any session opened in the repo, so that guidance is already available
on demand: call `ae_guide({topic})`, or read the sources under
`packages/mcp-server/src/guides/`. The division is that **the guides own how
After Effects behaves; `docs/` owns why this code is shaped the way it is.**
Where a fact belongs to both, the guide keeps the behaviour and the repo doc
keeps the reasoning and points at the topic — a second copy of the ease-arity
table is how that one went stale once already.

## What this project is

An MCP server that lets an LLM drive Adobe After Effects 2026: comps, layers, transforms, keyframes (with full interpolation/easing/tangent control), expressions, effects, text, shapes, masks, markers, footage import, audio cue placement, comp snapshots and diffs, Motion Graphics template export, rendering through the render queue, one-off screenshots and contact sheets, bulk batches, comp checkpoints with revert, the user's current selection, keyframe retiming and animation copy. 88 tools. macOS and Windows — the only two platforms AE runs on.

It ships five ways, and the ordering below is deliberate — it goes from least to most that the user has to already have installed:

| | For | Needs |
|---|---|---|
| `.mcpb` bundle | Claude Desktop | nothing — Desktop runs it on the Node it ships |
| Signed binary | any client, no Node | download and unzip |
| npm package | any client | Node 22+ |
| Claude Code plugin | Claude Code | this repo added as a marketplace |
| git checkout | development | the lot |

**Nothing here is Claude-only by design.** Skills and slash commands exist only in Claude's clients, so anything written only there reaches maybe half the users. The cross-cutting knowledge is carried by the MCP `instructions` field, MCP prompts, MCP resources and the `ae_guide` tool — all four are generated from the same source, and the Claude Code skills are one more generated output rather than the original. See [`docs/guidance-system.md`](docs/guidance-system.md).

## How the pieces talk

```
Claude / MCP client
        │ stdio (JSON-RPC)
        ▼
packages/mcp-server (Node/TS)
        │ front desk (127.0.0.1:17777, run by the first server): one queue, every session
        │ HTTP POST /op  +  WS /events
        ▼  (127.0.0.1:7777)
packages/ae-panel (CEP extension, installed into AE)
        │ CSInterface.evalScript
        ▼
ExtendScript inside AE  (bundle.jsx = packages/jsx/*.jsx in one closure; one global, __AEMCP)
        │ AE scripting API
        ▼
After Effects
```

The MCP server is stateless except for an in-memory `JobManager` (with the `BatchDriver` feeding it), the `SnapshotStore`, the write queue, the shared stale-frame file and — in whichever server runs it — the front desk. The panel is the *only* thing that talks to AE; it holds a Promise-chain mutex around `evalScript` because ExtendScript is single-threaded and concurrent calls would interleave. That mutex is necessary and not sufficient — see [`docs/architecture.md`](docs/architecture.md).

**The server does everything that does not modify After Effects (issue #220).** The panel stalls while AE is busy and does not update itself — a change there costs the user `setup_panel` and an AE restart — while the server sees the same files as the same user. So filesystem preconditions (`files/destinations.ts`), the comp diff (`snapshots/diff.ts`), house-style I/O (`style/houseStyleFile.ts`), finishing screenshots and `.mogrt` thumbnails (`frames/`), the chunked `run_batch` loop (`jobs/batchDriver.ts`) and `run_jsx` assembly (`tools/runJsxAssembly.ts`) run in Node, and only there: since issue #243 the panel keeps no copy, and a panel that predates them is refused by the version gate. New work that needs only a path or a JSON value goes there too, not into `packages/jsx/` or `client/`.

## Source layout

One line each. The annotated version — why each file is the way it is — is in
[`docs/architecture.md`](docs/architecture.md).

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** zod schemas, `OpSchemas`, `crossField()`, and the tables: `OpMutation`, `InternalOpMutation`, `ServerOpEffect`, `OpDiskWrite`. |
| `packages/shared/src/jobs.ts` | Job states; `cancelling` is not terminal, the other three end states are sticky. |
| `packages/jsx/*.jsx` | ExtendScript handlers, attached to the `OPS` table inside the bundle's closure. ES3-ish. |
| `packages/jsx/core.jsx` | Private JSON, `dispatch()` router, `withUndo()`, the dialog guard and `aeWarnings`, the `JOBS` table. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists; spend disproportionate care here. |
| `packages/jsx/snapshot.jsx` | The comp fingerprint and the diff of two of them. Pure, so testable with no AE. |
| `packages/jsx/checkpoint.jsx` | `checkpoint_comp` / `revert_comp`. Restores *into* the original comp so its id never changes; copy-first, verified against the checkpoint. |
| `packages/jsx/selection.jsx` | `get_selection` — what the user has selected, capped, with the count of what was left out. |
| `packages/jsx/retime.jsx` | `retime_keyframes` / `copy_animation` — a key moved with every attribute; write order is load-bearing; read back after. |
| `packages/jsx/batch.jsx` | `run_batch` — inline under 500 ops, otherwise a chunked job whose cursor lives here: `_continue_job` runs one chunk, `_get_job` reads the cursor, an orphan is retired after 30 minutes. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper, the resolution factor, contact-sheet tiles; `_screenshot_*` return the temp paths for the server to finish. |
| `packages/jsx/footage.jsx` | Import, footage layers, the SVG viewBox check, the shared solid/`usedIn` helpers. |
| `packages/jsx/audio.jsx` | `place_audio_cues` — plan, import, build, roll back. Statement order is load-bearing. |
| `packages/jsx/mogrt.jsx` | `export_mogrt` (and `_export_mogrt`) — preconditions first, dialogs suppressed, everything re-fetched afterwards. |
| `packages/jsx/render.jsx` | The render queue: add/list/remove, and `_render_prepare`/`_render_save`/`_render_mark_done` — the halves of `render_queue` that need AE. The render itself is not here. |
| `…/render/aerender.ts` | `render_queue`'s job: one `aerender` process per item, progress off stdout, outputs verified on disk, cancel kills the tree. |
| `…/render/markDone.ts` | Unticks rendered items as one write; waits only briefly for the lock, and says per item when it could not. |
| `packages/jsx/raw.jsx` | `run_jsx` — assembly, library inlining, failure attribution, the undo-group guard, the result serializer — kept for older servers and `run_batch` steps; `_run_jsx` runs a script the server built and sends back the raw line for it to map. |
| `packages/jsx/values.jsx` | `__setValue` — every op's `setValue`; drops AE's false `invalid numeric result` throw only when the value read back landed (#129). |
| `packages/jsx/helpers.jsx` | The helper scope a `run_jsx` script runs in. Listed by signature in the tool description — change both together. |
| `packages/jsx/style.jsx` | `_project_path` — the .aep's path, so the server can read and write `house-style.md` itself; `get_house_style` / `set_house_style` are its fallback when it cannot reach the folder (macOS privacy). |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate, Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, the `evalScript` mutex, the `__AEMCP` check, port binding and the port file, `capabilities` on `/health`. |
| `packages/ae-panel/client/panelhash.js` | Hashes the panel's own files for `clientHash` on `/health`. Must agree byte for byte with `setup/panelHash.ts`. |
| `packages/mcp-server/src/server.ts` | Tool registry, return-shape branching, error mapping, `toolInputSchema()`. |
| `…/util/errors.ts` | Every bridge failure class and its message. The five never share a sentence; tests hold it. |
| `…/util/argsSafety.ts` | Refuses `__proto__`/`constructor`/`prototype` keys at any depth, for every op. |
| `…/tools/descriptions.ts` | All tool descriptions, written for an LLM reading the tool list cold. |
| `…/tools/runJsxSource.ts` | `scriptPath` and `libraries`. The **server** reads those files, never the panel. |
| `…/tools/runJsxAssembly.ts` | Port of raw.jsx's wrapper, undo rewrite, caution scan and line map, for a `server-run-jsx` panel. Byte-identical by `run-jsx-assembly.mjs`. |
| `…/tools/annotations.ts` | MCP read-only/destructive hints, derived from the tables in `schemas.ts` — never hand-kept per tool. |
| `…/tools/batchSteps.ts` | Each `run_batch` step validated against its tool's strict schema, parsed args forwarded; refuses ops that cannot be a step. |
| `…/tools/internalOps.ts` | **The one sender of internal `_` ops.** Typed over `InternalOpMutation`; refuses a `"write"` with no write lease held. |
| `…/tools/policy.ts` | Read-only mode and the `run_jsx` switch: which tools are offered, refused, and noted in the guidance. |
| `…/tools/whatsNew.ts` | The `since` filter on the whats-new topic: semver compare, splitter, version header. |
| `…/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing, port candidates, the panel-health test. |
| `…/bridge/panelGate.ts` | The version-gate verdict, cached and re-checked. |
| `…/bridge/writeQueue.ts` | The one-writer-at-a-time mutex, and `extendUntil` for a lease that outlives its call. |
| `…/frontdesk/line.ts` | `SessionLine` — every server's one way to AE: own queue, then the desk's lock; election, handover, what may be re-sent. |
| `…/frontdesk/{desk,lock,config,protocol}.ts` | The desk's loopback server, the cross-session lock, the port and `desk-<port>.json`, the wire format that keeps the bridge failures the same classes. |
| `…/jobs/manager.ts` | In-memory job table, `waitFor(jobId)`, the progress emitters `await_job` binds. |
| `…/jobs/batchDriver.ts` | Drives a chunked `run_batch`: one `_continue_job` per chunk under the batch's lease, a lost answer recovered from `_get_job`, never an op run twice, every stop saying how far it got. |
| `…/frames/pipeline.ts` | Screenshots, contact sheets and `.mogrt` thumbnails finished on the server: the completeness wait, normalising, the stale check, tiling, the zip patch. |
| `…/frames/{pngCodec,frameReader,frameCache,contactSheet,mogrtThumbnail}.ts` | Image finishing — PNG codec, frame readiness, contact sheets, `.mogrt` thumbnails. The only copy since #243; `image-parity.mjs` pins their outputs. |
| `…/frames/sharedFrameCache.ts` | The stale-frame window as a file per panel port (`frames-<port>.jsonl`), shared by every server on one AE; lines tagged per AE instance, writes under a lock. |
| `…/snapshots/store.ts` | In-memory comp fingerprints; `missingMessage()` is why it is a class and not a `Map`. |
| `…/snapshots/diff.ts` | `diff_comp`'s diff, a port of `snapshot.jsx`'s kept byte-identical by a parity test. Change one, change both. |
| `…/files/destinations.ts` | Filesystem preconditions for `export_mogrt`, `add_to_render_queue`, `import_footage`, ported from the jsx. Reads only. |
| `…/issues/journal.ts` | The two issue journals, the error-text matcher, version stamps, `archiveReason`. |
| `…/issues/failures.ts` | `annotateFailure` — the push half. Never throws, never masks the error. |
| `…/setup/{check,install,paths}.ts` | `check_setup` / `setup_panel`. Never touches the bridge client. |
| `…/setup/platform.ts` | **The only place macOS and Windows diverge.** |
| `…/setup/{panelVersion,panelHash,panelCapabilities}.ts` | The running-hash comparison — `bundleHash` for the ExtendScript, `clientHash` for every other panel file, signature files excluded; `capabilities` off `/health`. |
| `…/setup/scaffold.ts` | **The one definition of what a project folder is.** Used by `init_project` and the CLI. |
| `…/cli/init.ts` | `npx … init <dir>`. Holds no templates of its own. |
| `…/style/houseStyleFile.ts` | `house-style.md` read and written by the server, given the .aep path from `_project_path`. |
| `…/style/summary.ts` | The house-style digest. Parses a markdown document nobody controls. |
| `…/guides/*.md` | **Source of truth for agent guidance.** Frontmatter + markdown; `after-effects.md` is the core. |
| `…/prompts/*.md` | Source of truth for user-invoked flows. |
| `…/generated/content.ts` | Generated. Never hand-edit — `build-guides.mjs --check` fails the build if you do. |
| `plugin/` | The Claude Code plugin: `.mcp.json` plus generated `skills/` and `commands/`. |
| `.claude-plugin/marketplace.json` | Marketplace catalog. |
| `scripts/bundle-jsx.mjs` | Wraps `packages/jsx/*.jsx` in one closure publishing only `__AEMCP`, and refuses a bundle ExtendScript cannot parse. Must stay a pure function of its sources. |
| `scripts/lib/extendscript-syntax.mjs` | The ES5 parse, ES3 reserved-word and missing-built-in checks the bundle must pass. Node runs what AE refuses. |
| `scripts/build-guides.mjs` | Generates every copy of the guidance prose. `--check` runs in CI. |
| `scripts/prepare-package.mjs` | `prepack` — esbuild the server to `bin/`, vendor the panel to `panel/`. |
| `scripts/install-panel.mjs` | Dev equivalent of `setup_panel`. |
| `scripts/build-mcpb.mjs` | The Claude Desktop bundle. |
| `scripts/build-binaries.mjs` | `bun build --compile`; every target is a *folder*, not a bare binary. |
| `scripts/sign-and-notarize.sh` | codesign then notarytool. Local-only; credentials from the environment. |
| `scripts/lib/setup.mjs` | Lets the dev scripts reuse the compiled setup module instead of a second copy. |
| `scripts/lib/release-checks.mjs` | Notary verdict must be `Accepted`; every artifact smoke-run and must serve exactly `OpSchemas`' tools. |
| `tests/live/` | The live AE driver: scripted recipe fixtures against a fresh server from this checkout. Refuses without `--live` and a prefs backup. |

## Adding an op

Adding a new op = touching six places. In order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and an entry in `OpSchemas`. If two fields are alternatives ("exactly one of these"), declare it with `crossField()` rather than `.refine()` — a bare refinement is dropped by the converter and `tests/unit/schema-constraints.mjs` fails the build. See "Cross-field rules" in [`docs/architecture.md`](docs/architecture.md).
2. **Classification** — the `OpMutation` table at the bottom of the same file: `"write"`, `"read"` or `"server"`. `tests/unit/write-queue.mjs` fails the build if you skip it, on purpose — see "Serializing writes" in [`docs/architecture.md`](docs/architecture.md). The classification also decides read-only mode and the tool's MCP annotations (`tools/annotations.ts`, derived — never hand-set): a `"write"` is hidden in read-only mode, a `"read"` is offered, and a `"server"` op needs entries in `READ_ONLY_SERVER_OPS` (`tools/policy.ts`) and `ServerOpEffect` — the compiler insists. An op that writes a file on disk with no `overwrite` field goes in `OpDiskWrite`, or it is annotated non-destructive.
3. **ExtendScript handler** — add to the matching module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`. Use `noUndo(fn)` for read-only ops (skips the undo group wrapper). Every field the schema declares must be read off `args` — `tests/unit/schema-handler-contract.mjs` fails the build on one that is advertised and never read (a server-answered op needs a `SERVER_READERS` entry there). The bundle must pass `extendscript-syntax.mjs` too.
4. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: add an entry keyed by op name. Write it for an LLM agent reading the tool list cold. `tests/unit/tool-budget.mjs` caps its length and refuses issue numbers in it.
5. **Build** — `npm run build` rebuilds TS and the .jsx bundle.
6. **Reload in AE** (optional, dev only) — `curl -X POST -H "x-ae-mcp-token: $(cat ~/.engineroom-ae-mcp/token-7777)" http://127.0.0.1:7777/reload-jsx` re-`$.evalFile`s the bundle without restarting AE. The header is not optional: every route that reaches AE is authenticated (issue #106). It drops every `run_batch` job in flight, since the job table lives in the bundle.

The `server.ts` tool registration loop reads `OpSchemas`, so no MCP-side wiring is needed unless the op needs special return packaging (vision = image content, run_batch = async envelope the server may drive, jobs/* = server-resident, snapshots = half server-resident) — or, in one case, special *input* packaging: `run_jsx` is rewritten on the server between zod validation and the forward, so `scriptPath` becomes `code` and `libraries` become `{path, text}` (`tools/runJsxSource.ts`); on a `server-run-jsx` panel the server then builds the whole wrapper and sends `_run_jsx` with `built` (`tools/runJsxAssembly.ts`).

Two things step 1 does not cover on its own, both in
[`docs/architecture.md`](docs/architecture.md): `run_jsx` is the one op whose
input is rewritten between validation and the forward, and a rule spanning two
fields (`"pass exactly one of these"`) is declared with `crossField()` rather
than `.refine()` — a bare refinement is dropped by the schema converter, so the
rule reaches the server and never the model.

## Conventions

- **ExtendScript is ES3-ish.** No `let`/`const`/arrow functions/template literals/`Object.keys`/destructuring in `packages/jsx/*.jsx`, and no ES3 reserved word (`native`, `class`, …) as an identifier. The build refuses a bundle that breaks this (`scripts/lib/extendscript-syntax.mjs`) — the unit tests run the jsx under Node, which accepts all of it, while AE refuses the *whole* bundle for one line. `core.jsx` keeps a private JSON because the engine is shared and another script can replace the global one.
- **Stable IDs.** `getCompById(id)` uses `app.project.itemByID`; `getLayerById(comp, layerId)` walks `comp.layers` matching `layer.id`. Never use `.index` as a long-lived identifier — it shifts when layers are reordered.
- **One undo step per request, and never one that spans two requests.** `dispatch()` wraps the handler in `withUndo()`, and `__beginUndoGroup` is the only thing allowed to call `app.beginUndoGroup` — everything groups through it, so `__UNDO_GROUPS` can count what was actually opened. `run_batch` manages its own undo (`__meta.noUndo = true`): one group for an inline batch, one per chunk for a long one. A group that opens in one `evalScript` and closes in another is not merely fragile — AE throws it away. See [`docs/fragile-areas-ae.md`](docs/fragile-areas-ae.md).
- **MCP server stdout is sacred.** All logs go to stderr via `util/logger.ts`. Touching `console.log` anywhere in mcp-server will corrupt the JSON-RPC stream.
- **Tool descriptions are written for LLMs.** Tell the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid. Screenshot descriptions especially must say "one-off, do NOT screenshot every frame."
- **Never report success for work that didn't happen.** An agent can only correct a failure it's told about, so a swallowed error is worse than a thrown one. `add_shape_content` is the reference case: it resolves every key first, and if any is unresolvable it removes the node it created and throws with the offending keys named, rather than leaving a half-built shape behind an `{ok:true}`. For the same reason every op schema is closed at every depth by `StrictOpSchemas`, not by hand — zod's default is to strip unknown keys silently.

## Rules that are easy to break silently

The full reasoning for each is one click away. What they have in common is that
breaking one produces a plausible success rather than an error.

- **Every op must be classified `write` / `read` / `server`** in `OpMutation`. There is no default — silence would classify it as a read, which is the bug the write queue exists to fix. The build fails if the tables disagree. → [architecture](docs/architecture.md)
- **A switched-off tool is off at three doors: `tools/list`, `tools/call`, and a `run_batch` step.** Batch steps reach the ExtendScript `OPS` table by name, so `run_jsx` inside a batch is `run_jsx`. A new `"server"` op will not compile until `READ_ONLY_SERVER_OPS` decides it. And no op's args may carry `__proto__`/`constructor`/`prototype` keys (`util/argsSafety.ts`): ExtendScript may read the first as a prototype and see a value every server-side check missed. → [architecture](docs/architecture.md)
- **A cross-field rule is declared once, with `crossField()`.** `.refine()` is dropped by the converter without a word. → [architecture](docs/architecture.md)
- **Every emitted tool schema must be valid draft 2020-12.** One invalid schema takes down *every* tool in the session, not just its own, so nothing goes into that emission pass unvalidated. → [server](docs/fragile-areas-server.md)
- **An undo group must open and close inside one `evalScript` call.** After Effects discards one that spans two, and nothing raises. → [AE](docs/fragile-areas-ae.md)
- **The panel does not update itself.** Gate on the *running* hashes (`bundleHash` and `clientHash`), never the installed ones; they diverge for the whole window between `setup_panel` and the next AE launch. → [subsystems](docs/subsystems.md)
- **Edit `src/guides/*.md` and `src/prompts/*.md`, never the generated outputs.** `plugin/skills/**`, `plugin/commands/**` and `src/generated/content.ts` are owned wholesale and overwritten by the next build. → [guidance](docs/guidance-system.md)
- **A bounded read must name what it left out.** Absent `include` means everything — except `find_layers`, where the bounded form is the promise. → [server](docs/fragile-areas-server.md)
- **Five bridge failures, five contradicting remedies.** Timeout, unreachable, write-queue-wait, auth and reset must never share a sentence: a timeout forbids re-sending (it reached AE and may still run); a queue wait asks for it (nothing left the server); unreachable sends the reader to `check_setup`; auth says the panel refused on purpose and will again; a reset (`BridgeResetError`) was delivered then dropped — it may have run, so read back before re-sending. The auth one is the token every route but `/health` requires; CORS is not what gates it, and could not be. **The front desk adds no sixth kind:** a follower gets the leader's failure as the same class, a desk lost or stalled mid-write is a `FrontDeskLostError` (a reset), a write whose place was lost or whose forwarding window expired is a `DeskPlaceLostError` and a wait behind another session a `DeskWaitError` (both queue waits). A desk failure must never fall through to `BridgeUnreachableError`, which `runOp` re-sends. A desk refusal by HTTP status never reached AE: a 413 (too large) says split the work, any other status says re-sending is safe. → [bridge](docs/fragile-areas-bridge.md)
- **Several servers share one queue: the front desk.** The first server on an After Effects binds `127.0.0.1:17777` (`P+10000` under `AE_MCP_PORT=P`) and serializes every session's writes, holding a chunked `run_batch` end to end; the others forward through it. A write is re-sent only on proof it never reached the panel, and anything that reports how long a session waited is timed at the desk — the panel's clock stops while ExtendScript runs. Tests that spawn servers set `AE_MCP_FRONT_DESK=off` or a temp `HOME`, or they become a real session's desk. → [architecture](docs/architecture.md)
- **Internal `_` ops go through `internalSender` (`tools/internalOps.ts`), never `bridge.runOp` directly.** They are not tools, so they never pass the tool path's classification or write lease; the sender is typed over `InternalOpMutation` and refuses a `"write"` with no lease held. Sent any other way, an internal write can land between two chunks of another session's batch. → [subsystems](docs/subsystems.md)
- **Every op runs with AE's dialogs suppressed, and what AE said surfaces as `aeWarnings`.** `dispatch()` brackets the op in `beginSuppressDialogs`/`endSuppressDialogs(false)` and collects `app.onError` (PROBLEM severity dropped as handled). A non-object result is wrapped in a marked envelope the server unwraps; an op managing its own suppression opts out with `__meta.ownDialogs`. Dropping the warnings means a dialog nobody saw becomes a silent success. → [AE](docs/fragile-areas-ae.md)
- **`run_jsx`'s undo guard covers literal calls only.** `app.beginUndoGroup`/`app.endUndoGroup` written out in the script or a library are rewritten to counting stand-ins and balanced inside the call; replacing the methods on `app` was tried and AE ignores it. Through `eval`/`Function`/`$.evalFile`, an alias of `app` or a computed name, a call reaches AE uncounted; eval-like routes get a CAUTION on the result, nothing more. → [AE](docs/fragile-areas-ae.md)
- **An outdated panel is refused, never worked around.** Since #243 the server keeps no fallback for an old panel: a stale `bundleHash` or `clientHash`, or a panel missing a capability, gets the "run `setup_panel` and restart" message. A new panel feature ships with the panel change, and the hash moving is what gates it — do not add an old-path branch beside it. `server-drives-jobs` is still confirmed per call — the server asks with `__driver: "server"` and drives only an envelope answering `driver: "server"`, so two drivers can never share a job. → [subsystems](docs/subsystems.md)
- **Measure After Effects; do not trust Adobe's documentation.** Undo groups across calls, `CompItem.posterTime`, `$.evalFile`'s scope and `Error.start`/`end` were all documented one way and behave another. → [recipes](docs/verification-recipes.md)
- **The .jsx bundle must stay a pure function of its sources** — no timestamps, no unsorted directory reads. Its hash is half the version gate. → [subsystems](docs/subsystems.md)
- **`ws` is always a real directory on disk**, in every packaging path. It can never be inlined. → [server](docs/fragile-areas-server.md)

## Build + run

```bash
npm install                 # workspaces hoist deps to root node_modules
npm run build               # tsc shared + mcp-server, build + syntax-check the jsx bundle
npm run build:jsx           # only rebuild bundle.jsx (fast iteration)
npm run watch:ts            # tsc --watch for mcp-server
npm run doctor              # sanity checks (debug mode, install, port, AE running)
npm run inspect             # MCP Inspector UI against the server
npm run new:project <dir>   # scaffold a designer project folder
npm run pack:check          # build + `npm pack --dry-run` to preview the tarball
npm run build:guides        # regenerate skills/commands/content.ts from the md sources
npm run build:mcpb          # the Claude Desktop bundle -> dist-release/
npm run build:binaries      # bun-compiled standalone folders -> dist-release/
make artifacts              # both of the above, unsigned
```

Publishing: `npm publish -w @engine-room/after-effects-mcp` (the `prepack` hook builds `bin/` and `panel/` first). The workspace root and `@engineroom/shared` stay private — `shared` is inlined into the bundle, so it is never published on its own. Verify a release by installing the tarball into an empty directory and running the binary; the published layout puts the panel at `<pkg>/panel`, which is a different path from the checkout's `packages/ae-panel`.

`build:jsx` writes the source bundle. With `AE_MCP_SYNC_PANEL=1` it also writes the installed bundle at `~/Library/.../<bundleId>/jsx/bundle.jsx`, so `/reload-jsx` sees fresh content with no manual `cp` step. (If you installed with `--symlink`, the installed path *is* the source path; the sync is a no-op.)

That sync is **opt-in on purpose**. The installed bundle is one half of the panel version gate, so a plain `npm run build` writing it changes what a *live* AE session compares itself against — another session on the same machine, mid-project, gets told to restart After Effects by a build it never ran. Default-off means a build only ever touches the repo.

## Platform notes

Linux is impossible, not merely unimplemented — Adobe has never shipped AE for it.

All `packages/jsx/*.jsx` is AE's own scripting API and is platform-neutral; never add platform branching there. Host differences are confined to `setup/platform.ts` (PlayerDebugMode via `defaults` vs `reg`, AE process via `pgrep` vs `tasklist`, where `aerender` lives and how a render's process tree is stopped — process group vs `taskkill /T`) and `cepExtensionsDir()` in `setup/paths.ts` (`~/Library/Application Support/...` vs `%APPDATA%\...`).

CI (`.github/workflows/ci.yml`) builds and smoke-tests on macos-latest and windows-latest: server starts, serves exactly the tools `OpSchemas` defines, every emitted tool schema is valid draft 2020-12 and hides no cross-field constraint, `instructions`/prompts/resources are served and `$ARGUMENTS` substitutes, `check_setup` resolves paths, and both scaffold entry points write files and refuse to clobber. It cannot exercise the CEP install — no AE on a runner — so the Windows install path is the least-proven part of the project. macOS is the daily-driven platform.

## Releasing

`make release` is local-only and does the whole thing in one pass: bump → build → test → sign the panel once → npm tarball → `.mcpb` → binaries → codesign → notarize → smoke-run all three → commit → tag (its message records the tarball's SHA-256) → draft GitHub release with every asset → push → publish the draft. The npm tarball is packed by the script; publishing the release is what triggers `release.yml`, which downloads that tarball, refuses it unless it matches the digest in the tag, and publishes it to npm over OIDC — CI builds nothing and signs nothing. Every artifact carries the same signed panel (issue #182).

Everything that can fail happens **before** the tag is pushed. A failed notarization costs a `git checkout -- .` and nothing else — that ordering is deliberate, so do not move the artifact build after the tag.

**Release notes are short and to the point: a list of fixes, and nothing else.** `release.sh` writes the install block and the changelog link on its own; what goes above them is one line per fix or addition, each naming its issue number and saying what changed in the words a user would recognise the problem by. No narrative, no explanation of why, no upgrade advice, no "known and filed" paragraph. The reasoning behind a change lives in the issue and in `whats-new.md`, which is written for agents; a release page is read by a person deciding whether to update, and a short list is what answers that. (Migs's rule, 2026-09-07.)

The Developer ID certificate stays on one machine and is never read by anything in this repo; `sign-and-notarize.sh` takes credentials from the environment only. A leaked certificate is revoked by Apple, and revocation stops *already-distributed* binaries from launching, which is why CI does not sign.

## Out of scope (v1)

The render queue was on this list until issue #137. It landed as `render_queue` rendering through `aerender`, never `renderQueue.render()` and never Media Encoder — the reasoning is in [`docs/fragile-areas-ae.md`](docs/fragile-areas-ae.md#the-render-queue).

- Footage *replace* / relink. Import landed in 0.3.0 (`import_footage`) because issue #33's SVG check has nowhere else to live — the detection needs the file path and the imported item in the same call. Replace and relink are still out.
- AE preferences / settings changes (excluded by design — animation only).
- Code-signing the Windows binary (needs a separate certificate; SmartScreen warns on first run until then).
- MCP-over-HTTP straight from the CEP panel. It would remove the separate server process entirely, but the panel cannot install itself — `check_setup` and `setup_panel` exist precisely for when the panel is not there yet, so something still has to ship.
