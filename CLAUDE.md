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
| [`docs/architecture.md`](docs/architecture.md) | The annotated source tree, and the op path in detail: the one op whose input is rewritten, cross-field rules, the special return shapes, write serialization. |
| [`docs/subsystems.md`](docs/subsystems.md) | Panel version gating, the project scaffold, the house style, comp snapshots, the issue journal. |
| [`docs/guidance-system.md`](docs/guidance-system.md) | How agent guidance is written once and generated into every carrier. Read before touching anything under `src/guides/` or `src/prompts/`. |
| [`docs/fragile-areas-ae.md`](docs/fragile-areas-ae.md) | Measured After Effects and ExtendScript behaviour: undo, shapes, text, audio, mogrt, expressions, `run_jsx`. |
| [`docs/fragile-areas-bridge.md`](docs/fragile-areas-bridge.md) | The bridge, ports, CEP, the panel, and the screenshot pipeline. |
| [`docs/fragile-areas-server.md`](docs/fragile-areas-server.md) | Tool schemas and the MCP protocol, the journal's caches, packaging and binaries. |
| [`docs/verification-recipes.md`](docs/verification-recipes.md) | The 46 recipes run by hand against a live AE 2026. |

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

An MCP server that lets an LLM drive Adobe After Effects 2026: comps, layers, transforms, keyframes (with full interpolation/easing/tangent control), expressions, effects, text, shapes, masks, markers, footage import, audio cue placement, comp snapshots and diffs, Motion Graphics template export, one-off screenshots and contact sheets, bulk batches. 76 tools. macOS and Windows — the only two platforms AE runs on.

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
        │ HTTP POST /op  +  WS /events
        ▼  (127.0.0.1:7777)
packages/ae-panel (CEP extension, installed into AE)
        │ CSInterface.evalScript
        ▼
ExtendScript inside AE  (bundle.jsx = concat of packages/jsx/*.jsx)
        │ AE scripting API
        ▼
After Effects
```

The MCP server is stateless except for an in-memory `JobManager`, the `SnapshotStore` and the write queue. The panel is the *only* thing that talks to AE; it holds a Promise-chain mutex around `evalScript` because ExtendScript is single-threaded and concurrent calls would interleave. That mutex is necessary and not sufficient — see [`docs/architecture.md`](docs/architecture.md).

## Source layout

One line each. The annotated version — why each file is the way it is — is in
[`docs/architecture.md`](docs/architecture.md).

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** zod schemas, `OpSchemas`, the `OpMutation` classification table, `crossField()`. |
| `packages/shared/src/ipc.ts` | HTTP envelope + WS event types. |
| `packages/jsx/*.jsx` | ExtendScript handlers, attached to the global `OPS` table. ES3-ish. |
| `packages/jsx/core.jsx` | JSON polyfill, `dispatch()` router, `withUndo()`, the `JOBS` table. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists; spend disproportionate care here. |
| `packages/jsx/snapshot.jsx` | The comp fingerprint and the diff of two of them. Pure, so testable with no AE. |
| `packages/jsx/batch.jsx` | `run_batch` — inline under 500 ops, otherwise a chunked job. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper, the resolution factor, contact-sheet tiles. |
| `packages/jsx/footage.jsx` | Import, footage layers, the SVG viewBox check, the shared solid/`usedIn` helpers. |
| `packages/jsx/audio.jsx` | `place_audio_cues` — plan, import, build, roll back. Statement order is load-bearing. |
| `packages/jsx/mogrt.jsx` | `export_mogrt` — preconditions first, dialogs suppressed, everything re-fetched afterwards. |
| `packages/jsx/raw.jsx` | `run_jsx` — the result serializer, library inlining, failure attribution. |
| `packages/jsx/helpers.jsx` | The helper scope a `run_jsx` script runs in. Listed by signature in the tool description — change both together. |
| `packages/jsx/style.jsx` | `get_house_style` / `set_house_style`, read beside the .aep over the bridge. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate, Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, the `evalScript` mutex, the job driver, port binding and the port file. |
| `packages/ae-panel/client/pngcodec.js` | 16→8-bit conversion, empty-frame detection, `inspectPngStructure`. |
| `packages/ae-panel/client/framereader.js` | Decides when After Effects has *finished* writing a frame. |
| `packages/ae-panel/client/contactsheet.js` | Tiles several frames into one labelled sheet. |
| `packages/ae-panel/client/framecache.js` | The window of delivered frames that makes a re-served render buffer visible. |
| `packages/ae-panel/client/mogrt.js` | Zip surgery + resample that replaces `thumb.png` in an exported `.mogrt`. |
| `packages/mcp-server/src/server.ts` | Tool registry, return-shape branching, error mapping, `toolInputSchema()`. |
| `…/tools/descriptions.ts` | All tool descriptions, written for an LLM reading the tool list cold. |
| `…/tools/runJsxSource.ts` | `scriptPath` and `libraries`. The **server** reads those files, never the panel. |
| `…/tools/whatsNew.ts` | The `since` filter on the whats-new topic: semver compare, splitter, version header. |
| `…/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing, port candidates, the panel-health test. |
| `…/bridge/writeQueue.ts` | The one-writer-at-a-time mutex, and `extendUntil` for a lease that outlives its call. |
| `…/jobs/manager.ts` | In-memory job table, `waitFor(jobId)`, the progress emitters `await_job` binds. |
| `…/snapshots/store.ts` | In-memory comp fingerprints; `missingMessage()` is why it is a class and not a `Map`. |
| `…/issues/journal.ts` | The two issue journals, the error-text matcher, version stamps, `archiveReason`. |
| `…/issues/failures.ts` | `annotateFailure` — the push half. Never throws, never masks the error. |
| `…/setup/{check,install,paths}.ts` | `check_setup` / `setup_panel`. Never touches the bridge client. |
| `…/setup/platform.ts` | **The only place macOS and Windows diverge.** |
| `…/setup/scaffold.ts` | **The one definition of what a project folder is.** Used by `init_project` and the CLI. |
| `…/cli/init.ts` | `npx … init <dir>`. Holds no templates of its own. |
| `…/style/summary.ts` | The house-style digest. Parses a markdown document nobody controls. |
| `…/guides/*.md` | **Source of truth for agent guidance.** Frontmatter + markdown; `after-effects.md` is the core. |
| `…/prompts/*.md` | Source of truth for user-invoked flows. |
| `…/generated/content.ts` | Generated. Never hand-edit — `build-guides.mjs --check` fails the build if you do. |
| `plugin/` | The Claude Code plugin: `.mcp.json` plus generated `skills/` and `commands/`. |
| `.claude-plugin/marketplace.json` | Marketplace catalog. |
| `scripts/bundle-jsx.mjs` | Concatenates `packages/jsx/*.jsx` into the panel bundle. Must stay a pure function of its sources. |
| `scripts/build-guides.mjs` | Generates every copy of the guidance prose. `--check` runs in CI. |
| `scripts/prepare-package.mjs` | `prepack` — esbuild the server to `bin/`, vendor the panel to `panel/`. |
| `scripts/install-panel.mjs` | Dev equivalent of `setup_panel`. |
| `scripts/build-mcpb.mjs` | The Claude Desktop bundle. |
| `scripts/build-binaries.mjs` | `bun build --compile`; every target is a *folder*, not a bare binary. |
| `scripts/sign-and-notarize.sh` | codesign then notarytool. Local-only; credentials from the environment. |
| `scripts/lib/setup.mjs` | Lets the dev scripts reuse the compiled setup module instead of a second copy. |

## Adding an op

Adding a new op = touching six places. In order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and an entry in `OpSchemas`. If two fields are alternatives ("exactly one of these"), declare it with `crossField()` rather than `.refine()` — a bare refinement is dropped by the converter and `tests/unit/schema-constraints.mjs` fails the build. See "Cross-field rules" in [`docs/architecture.md`](docs/architecture.md).
2. **Classification** — the `OpMutation` table at the bottom of the same file: `"write"`, `"read"` or `"server"`. `tests/unit/write-queue.mjs` fails the build if you skip it, on purpose — see "Serializing writes" in [`docs/architecture.md`](docs/architecture.md).
3. **ExtendScript handler** — add to the matching module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`. Use `noUndo(fn)` for read-only ops (skips the undo group wrapper).
4. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: add an entry keyed by op name. Write it for an LLM agent reading the tool list cold.
5. **Build** — `npm run build` rebuilds TS and concatenates the .jsx bundle.
6. **Reload in AE** (optional, dev only) — `curl -X POST http://127.0.0.1:7777/reload-jsx` re-`$.evalFile`s the bundle without restarting AE.

The `server.ts` tool registration loop reads `OpSchemas`, so no MCP-side wiring is needed unless the op needs special return packaging (vision = image content, run_batch = async envelope, jobs/* = server-resident) — or, in one case, special *input* packaging: `run_jsx` is rewritten between zod validation and the forward, so `scriptPath` becomes `code` and `libraries` become `{path, text}` before the panel ever sees them (`tools/runJsxSource.ts`).

Two things step 1 does not cover on its own, both in
[`docs/architecture.md`](docs/architecture.md): `run_jsx` is the one op whose
input is rewritten between validation and the forward, and a rule spanning two
fields (`"pass exactly one of these"`) is declared with `crossField()` rather
than `.refine()` — a bare refinement is dropped by the schema converter, so the
rule reaches the server and never the model.

## Conventions

- **ExtendScript is ES3-ish.** No `let`/`const`/arrow functions/template literals/`Object.keys`/destructuring in `packages/jsx/*.jsx`. AE 2026 has native JSON but `core.jsx` polyfills defensively.
- **Stable IDs.** `getCompById(id)` uses `app.project.itemByID`; `getLayerById(comp, layerId)` walks `comp.layers` matching `layer.id`. Never use `.index` as a long-lived identifier — it shifts when layers are reordered.
- **One undo step per request, and never one that spans two requests.** `dispatch()` wraps the handler in `withUndo()`, and `__beginUndoGroup` is the only thing allowed to call `app.beginUndoGroup` — everything groups through it, so `__UNDO_GROUPS` can count what was actually opened. `run_batch` manages its own undo (`__meta.noUndo = true`): one group for an inline batch, one per chunk for a long one. A group that opens in one `evalScript` and closes in another is not merely fragile — AE throws it away. See [`docs/fragile-areas-ae.md`](docs/fragile-areas-ae.md).
- **MCP server stdout is sacred.** All logs go to stderr via `util/logger.ts`. Touching `console.log` anywhere in mcp-server will corrupt the JSON-RPC stream.
- **Tool descriptions are written for LLMs.** Tell the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid. Screenshot descriptions especially must say "one-off, do NOT screenshot every frame."
- **Never report success for work that didn't happen.** An agent can only correct a failure it's told about, so a swallowed error is worse than a thrown one. `add_shape_content` is the reference case: it resolves every key first, and if any is unresolvable it removes the node it created and throws with the offending keys named, rather than leaving a half-built shape behind an `{ok:true}`. Schemas that accept free-form objects must be `.strict()` for the same reason — zod's default is to strip unknown keys silently.

## Rules that are easy to break silently

The full reasoning for each is one click away. What they have in common is that
breaking one produces a plausible success rather than an error.

- **Every op must be classified `write` / `read` / `server`** in `OpMutation`. There is no default — silence would classify it as a read, which is the bug the write queue exists to fix. The build fails if the tables disagree. → [architecture](docs/architecture.md)
- **A cross-field rule is declared once, with `crossField()`.** `.refine()` is dropped by the converter without a word. → [architecture](docs/architecture.md)
- **Every emitted tool schema must be valid draft 2020-12.** One invalid schema takes down *every* tool in the session, not just its own, so nothing goes into that emission pass unvalidated. → [server](docs/fragile-areas-server.md)
- **An undo group must open and close inside one `evalScript` call.** After Effects discards one that spans two, and nothing raises. → [AE](docs/fragile-areas-ae.md)
- **The panel does not update itself.** Gate on the *running* bundle hash, never the installed one; they diverge for the whole window between `setup_panel` and the next AE launch. → [subsystems](docs/subsystems.md)
- **Edit `src/guides/*.md` and `src/prompts/*.md`, never the generated outputs.** `plugin/skills/**`, `plugin/commands/**` and `src/generated/content.ts` are owned wholesale and overwritten by the next build. → [guidance](docs/guidance-system.md)
- **A bounded read must name what it left out.** Absent `include` means everything — except `find_layers`, where the bounded form is the promise. → [server](docs/fragile-areas-server.md)
- **Three bridge failures, three contradicting remedies.** Timeout, unreachable and write-queue-wait must never share a sentence: one forbids re-sending, one asks for it, one sends the reader to `check_setup`. → [bridge](docs/fragile-areas-bridge.md)
- **Measure After Effects; do not trust Adobe's documentation.** Undo groups across calls, `CompItem.posterTime`, `$.evalFile`'s scope and `Error.start`/`end` were all documented one way and behave another. → [recipes](docs/verification-recipes.md)
- **The .jsx bundle must stay a pure function of its sources** — no timestamps, no unsorted directory reads. Its hash is half the version gate. → [subsystems](docs/subsystems.md)
- **`ws` is always a real directory on disk**, in every packaging path. It can never be inlined. → [server](docs/fragile-areas-server.md)

## Build + run

```bash
npm install                 # workspaces hoist deps to root node_modules
npm run build               # tsc shared + mcp-server, concatenate jsx bundle
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

All `packages/jsx/*.jsx` is AE's own scripting API and is platform-neutral; never add platform branching there. Host differences are confined to `setup/platform.ts` (PlayerDebugMode via `defaults` vs `reg`, AE process via `pgrep` vs `tasklist`) and `cepExtensionsDir()` in `setup/paths.ts` (`~/Library/Application Support/...` vs `%APPDATA%\...`).

CI (`.github/workflows/ci.yml`) builds and smoke-tests on macos-latest and windows-latest: server starts, ≥70 tools, every emitted tool schema is valid draft 2020-12 and hides no cross-field constraint, `instructions`/prompts/resources are served and `$ARGUMENTS` substitutes, `check_setup` resolves paths, and both scaffold entry points write files and refuse to clobber. It cannot exercise the CEP install — no AE on a runner — so the Windows install path is the least-proven part of the project. macOS is the daily-driven platform.

## Releasing

`make release` is local-only and does the whole thing in one pass: bump → build → npm dry-run → `.mcpb` → binaries → codesign → notarize → commit → tag → push → `gh release create`. Pushing the tag is what triggers `release.yml`, which publishes to npm over OIDC; the GitHub release with its assets is created by the script itself.

Everything that can fail happens **before** the tag is pushed. A failed notarization costs a `git checkout -- .` and nothing else — that ordering is deliberate, so do not move the artifact build after the tag.

**Release notes are short and to the point: a list of fixes, and nothing else.** `release.sh` writes the install block and the changelog link on its own; what goes above them is one line per fix or addition, each naming its issue number and saying what changed in the words a user would recognise the problem by. No narrative, no explanation of why, no upgrade advice, no "known and filed" paragraph. The reasoning behind a change lives in the issue and in `whats-new.md`, which is written for agents; a release page is read by a person deciding whether to update, and a short list is what answers that. (Migs's rule, 2026-09-07.)

The Developer ID certificate stays on one machine and is never read by anything in this repo; `sign-and-notarize.sh` takes credentials from the environment only. A leaked certificate is revoked by Apple, and revocation stops *already-distributed* binaries from launching, which is why CI does not sign.

## Out of scope (v1)

- Render queue (queue + render + progress + cancel).
- Footage *replace* / relink. Import landed in 0.3.0 (`import_footage`) because issue #33's SVG check has nowhere else to live — the detection needs the file path and the imported item in the same call. Replace and relink are still out.
- AE preferences / settings changes (excluded by design — animation only).
- Code-signing the Windows binary (needs a separate certificate; SmartScreen warns on first run until then).
- MCP-over-HTTP straight from the CEP panel. It would remove the separate server process entirely, but the panel cannot install itself — `check_setup` and `setup_panel` exist precisely for when the panel is not there yet, so something still has to ship.
