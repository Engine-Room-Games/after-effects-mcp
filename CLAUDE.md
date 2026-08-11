# Claude development guide — after-effects-mcp

This file is for future Claude Code sessions working in this repo. Humans reading it: see `README.md` for the user-facing intro.

## What this project is

An MCP server that lets an LLM drive Adobe After Effects 2026: comps, layers, transforms, keyframes (with full interpolation/easing/tangent control), expressions, effects, text, shapes, masks, markers, one-off screenshots, bulk batches. 63 tools. macOS and Windows — the only two platforms AE runs on.

It ships three ways: as an npm package (`npx @engine-room/after-effects-mcp`), as a Claude Code plugin (this repo is also its marketplace), and as a git checkout for development.

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

The MCP server is stateless except for an in-memory `JobManager`. The panel is the *only* thing that talks to AE; it holds a Promise-chain mutex around `evalScript` because ExtendScript is single-threaded and concurrent calls would interleave.

## Source layout

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** Adding an op = adding a zod schema here. |
| `packages/shared/src/ipc.ts` | HTTP envelope + WS event types. |
| `packages/jsx/*.jsx` | ExtendScript handlers. Each module attaches functions to the global `OPS` table. ES3-ish — no `let`/`const`/arrow/templates. |
| `packages/jsx/core.jsx` | JSON polyfill, `dispatch(payloadJson)` router, `withUndo()` wrapper, `JOBS` table for chunked async. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists. Spend disproportionate care here. |
| `packages/jsx/batch.jsx` | `run_batch` for ≤100 ops inline; otherwise registers a job and yields chunks via `_continue_job`. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper. Returns a temp path; the panel base64-encodes. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate. Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, `evalScript` mutex, JSON envelope, job driver, PNG reader. |
| `packages/mcp-server/src/server.ts` | Tool registry, vision/async-envelope branching, error mapping. |
| `packages/mcp-server/src/tools/descriptions.ts` | All tool descriptions in one file — including the verbatim screenshot guidance. |
| `packages/mcp-server/src/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing. |
| `packages/mcp-server/src/jobs/manager.ts` | In-memory job table, `waitFor(jobId)` for the `await_job` tool. |
| `packages/mcp-server/src/issues/journal.ts` | The cross-session issue journal at `<project>/.ae-mcp/issues/`. Backs `log_issue` / `list_known_issues` / `mark_issue_reported`. The project folder is `process.cwd()`; a client that gives no usable one (Claude Desktop starts servers at `/`) falls back to `~/.after-effects-mcp`, reported as `scope: "home"` so the fallback is never silent. `AE_MCP_HOME` overrides the root (used by the CI check). |
| `packages/mcp-server/src/setup/{check,install,paths}.ts` | Backs `check_setup` / `setup_panel`. Never touches the bridge — it exists for the case where the panel isn't installed yet. |
| `packages/mcp-server/src/setup/platform.ts` | **The only place macOS and Windows diverge** (PlayerDebugMode storage, AE process detection). Plus `cepExtensionsDir()` in `paths.ts`. Keep platform branching here — do not scatter `process.platform` through the codebase. |
| `scripts/lib/setup.mjs` | Loads the compiled setup module so the dev scripts (`doctor`, `install-panel`, `enable-debug`) reuse the same platform logic the MCP tools use instead of keeping a second copy. |
| `packages/mcp-server/src/cli/init.ts` | `npx @engine-room/after-effects-mcp init <dir>` project scaffold. Templates are inline string constants so nothing extra has to be packaged. |
| `plugin/` | The Claude Code plugin: `.mcp.json` + `skills/{after-effects,ae-setup}` + `commands/report-ae-issue.md`. Skills carry tool knowledge only — never anyone's house style. |
| `.claude-plugin/marketplace.json` | Marketplace catalog. Users add this repo, then install `after-effects@engine-room`. |
| `scripts/bundle-jsx.mjs` | Concatenates `packages/jsx/*.jsx` in dependency order into `packages/ae-panel/jsx/bundle.jsx`. Run via `npm run build:jsx`. |
| `scripts/prepare-package.mjs` | `prepack` hook. esbuild-bundles the server to `bin/server.js` (inlining `@engineroom/shared`, which is never published separately) and vendors the panel to `panel/`. |
| `scripts/install-panel.mjs` | Dev equivalent of `setup_panel`. Copies (or symlinks with `--symlink`) the panel into `~/Library/Application Support/Adobe/CEP/extensions/`. |

## The op pipeline (in detail)

Adding a new op = touching five places. In order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and an entry in `OpSchemas`.
2. **ExtendScript handler** — add to the matching module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`. Use `noUndo(fn)` for read-only ops (skips the undo group wrapper).
3. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: add an entry keyed by op name. Write it for an LLM agent reading the tool list cold.
4. **Build** — `npm run build` rebuilds TS and concatenates the .jsx bundle.
5. **Reload in AE** (optional, dev only) — `curl -X POST http://127.0.0.1:7777/reload-jsx` re-`$.evalFile`s the bundle without restarting AE.

The `server.ts` tool registration loop reads `OpSchemas`, so no MCP-side wiring is needed unless the op needs special return packaging (vision = image content, run_batch = async envelope, jobs/* = server-resident).

## Special return shapes

- **Vision** (`screenshot_frame`, `screenshot_layer`): JSX returns `{path, width, height, time, compId, layerId?}`. Panel reads the PNG, base64-encodes, returns `{base64, bytes, ...}`. Server packages as MCP `image` content block.
- **Long batch** (`run_batch` >100 ops): JSX returns `{jobId, async:true, total}`. Panel drives `_continue_job` in chunks of 25 in the background, broadcasting `progress` events on WS. Server forwards WS progress as `notifications/progress` keyed by the request's `progressToken`.
- **Server-resident** (`await_job`, `get_job`, `cancel_job`, `check_setup`, `setup_panel`, `log_issue`, `list_known_issues`, `mark_issue_reported`): handled in `server.ts`; never forwarded to the panel (except `cancel_job`, which also sends `_cancel_job` to the bridge to set the JSX-side flag). They're still listed in `OpSchemas` so `tools/list` picks them up — membership in `SERVER_OPS` is what stops the forwarding.
- **Downsampled screenshots**: handled entirely in `vision.jsx`. `saveFrameToPng` *does* respect `CompItem.resolutionFactor` (measured: a 3840×2160 comp yields 1920×1080 at factor 2, 960×540 at factor 4), so `__saveFrameAt` sets the factor, renders, and restores it in a `finally`. That restore is not optional — a throw mid-render would otherwise leave the user's comp at reduced resolution. The panel reads the true dimensions out of the PNG's IHDR chunk rather than computing them, so reported size can never disagree with the image sent. An earlier version shelled out to `sips`; it was replaced because rendering smaller is faster than resampling and needs no external tool, which is what makes downsampling work on Windows.

## Conventions

- **ExtendScript is ES3-ish.** No `let`/`const`/arrow functions/template literals/`Object.keys`/destructuring in `packages/jsx/*.jsx`. AE 2026 has native JSON but `core.jsx` polyfills defensively.
- **Stable IDs.** `getCompById(id)` uses `app.project.itemByID`; `getLayerById(comp, layerId)` walks `comp.layers` matching `layer.id`. Never use `.index` as a long-lived identifier — it shifts when layers are reordered.
- **One undo step per request.** `dispatch()` wraps the handler in `app.beginUndoGroup`/`endUndoGroup`. Long batches manage their own undo manually (`run_batch.__meta.noUndo = true`).
- **MCP server stdout is sacred.** All logs go to stderr via `util/logger.ts`. Touching `console.log` anywhere in mcp-server will corrupt the JSON-RPC stream.
- **Tool descriptions are written for LLMs.** Tell the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid. Screenshot descriptions especially must say "one-off, do NOT screenshot every frame."
- **Never report success for work that didn't happen.** An agent can only correct a failure it's told about, so a swallowed error is worse than a thrown one. `add_shape_content` is the reference case: it resolves every key first, and if any is unresolvable it removes the node it created and throws with the offending keys named, rather than leaving a half-built shape behind an `{ok:true}`. Schemas that accept free-form objects must be `.strict()` for the same reason — zod's default is to strip unknown keys silently.

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
```

Publishing: `npm publish -w @engine-room/after-effects-mcp` (the `prepack` hook builds `bin/` and `panel/` first). The workspace root and `@engineroom/shared` stay private — `shared` is inlined into the bundle, so it is never published on its own. Verify a release by installing the tarball into an empty directory and running the binary; the published layout puts the panel at `<pkg>/panel`, which is a different path from the checkout's `packages/ae-panel`.

`build:jsx` writes both the source bundle and, if the panel is installed, the installed bundle at `~/Library/.../<bundleId>/jsx/bundle.jsx`. So `/reload-jsx` always sees fresh content — no manual `cp` step. (If you installed with `--symlink`, the installed path *is* the source path; the sync is a no-op.)

## Verification recipes (run by hand against a live AE 2026)

1. `list_comps` → JSON array, empty `[]` on fresh project.
2. `create_comp({name:"t", width:1920, height:1080, frameRate:30, duration:5})` → returns id.
3. `create_text_layer({compId, text:"hi"})`, then `add_keyframe` at t=0 left and t=2 right, then `screenshot_frame` at t=0/1/2 to confirm motion visually.
4. `add_effect({compId, layerId, matchName:"ADBE Gaussian Blur 2"})`, `set_effect_param({...paramName:"Blurriness", value:25})`.
5. `set_expression({propertyPath:["Effects","Gaussian Blur","Blurriness"], expression:"time*10"})`, then `get_layer_full` echoes the expression.
6. `run_batch` with 50 `create_solid_layer` ops, `transactional:true` → single undo step.
7. `run_batch` with 600 ops → returns `{jobId}` (inline cutoff is 500). With `progressToken` set, `notifications/progress` fire ~20/sec. Without it, `await_job(jobId)` resolves with the final result.
8. `run_jsx("app.project.activeItem.name")` → comp name. With deliberate error → structured `AeError` with line number.
9. `log_issue` twice with the same title → one file, `occurrences: 2`, `previouslyLogged: true`. `mark_issue_reported` then `log_issue` again → still `reported: true` (a new sighting must not un-report an entry).

## The issue journal

`log_issue` is how one session hands a hard-won workaround to the next, in the folder the work happened in. Four properties matter, and all four are things it would be easy to get wrong:

- **The folder ignores itself.** `ensureJournalDir` writes `.ae-mcp/.gitignore` containing `*` on first use. That is what keeps the journal untracked — not a rule in the project's `.gitignore`, which most of these folders do not have, and which the ones that do would have to remember to add.

- **The title is the identity.** It is slugified into the filename, so re-logging under the same title extends the entry rather than adding a near-duplicate. Agents are told to `list_known_issues` first for exactly this reason.
- **Reporting state belongs to the entry, not the sighting.** Re-logging a known problem preserves `reported`, `issueUrl` and `firstSeen`, and a `cause` worked out once survives a later sighting logged without one. Otherwise the user gets asked to report the same thing repeatedly, which is the fastest way to make them stop reading the offer.
- **The files are meant to be hand-edited.** `parse()` is deliberately forgiving: missing keys, reflowed text and deleted headings degrade one entry instead of failing the whole journal. A file with no recognised headings keeps its text as the symptom rather than being read as empty.

The user-facing half is the offer to report. It lives in three places by necessity, because not every client loads skills: the `log_issue` **tool description** carries the minimum (finish the work first, phrase it for a non-programmer, don't say "GitHub issue"), the **`after-effects` skill** carries the full protocol with an example, and **`/report-ae-issue`** carries the reporting flow. If you change the behaviour, change all three — plus the condensed command template in `cli/init.ts`, which is what non-plugin users get.

## Known fragile areas

- `saveFrameToPng` is community-known, not officially documented. Alpha edge cases reported on some comps. If it fails, fallback would be the render queue with PNG Sequence template (slow; deferred to v1.1).
- ExtendScript single-threading: `run_jsx` with a long synchronous loop will freeze AE's UI. Document for the agent in the tool description (already done).
- CEP manifest's `<AutoVisible>false</AutoVisible>` was unreliable in early CEP 12 builds. Current manifest uses `AutoVisible=true` with a small geometry — the panel still auto-loads invisibly enough; the user can dock the small status panel out of the way.
- CEP panels installed without signing require `PlayerDebugMode=1`. The user does this once via `npm run enable:debug` and a reboot.
- **Anthropic API requires JSON Schema draft 2020-12** for tool input schemas. `zod-to-json-schema` 3.x has no 2020-12 target — `openApi3` emits `nullable` (rejected) and `jsonSchema7` emits draft-07 tuple form `items:[...]` (rejected; 2020-12 wants `prefixItems`). `server.ts` uses `jsonSchema7` + `$refStrategy:"none"` + a `toDraft2020()` post-pass that rewrites tuples. Don't switch back to `openApi3`.
- **`setTemporalEaseAtKey` on spatial properties takes a single-element array**, regardless of 2D/3D — for Position/Anchor Point, the ease is along the motion path. Non-spatial multi-dim (Scale, Color) need one entry per dimension. `keyframes.jsx` branches on `prop.isSpatial`. If you ever see "Value array does not have 1 elements", a spatial property is being fed N entries.
- **`saveFrameToPng` is asynchronous.** It returns before the file is on disk, so anything reading the PNG must poll until the size settles. A cold render of a heavy 4K comp was measured taking over 15 seconds; the panel's wait is 120s because the original 5s silently failed screenshots that were merely still rendering.
- **`panelSourceDir()` must prefer the checkout over the vendored copy.** After any `npm pack`, a stale `packages/mcp-server/panel/` is left on disk (gitignored). If that were checked first, `setup_panel` in a dev checkout would install the stale copy instead of what you're editing. Order matters in `setup/paths.ts`.
- **esbuild preserves the entry point's hashbang.** Adding a `banner` with `#!/usr/bin/env node` produces a second one on line 2 and the published binary dies with a syntax error. `prepare-package.mjs` asserts there is exactly one.
- **`addText()` anchors point text at the bbox center**, not the baseline-left an agent would assume. `paragraphJustification: LEFT_JUSTIFY` doesn't move the anchor for point text. `create_text_layer` defaults `anchorAlign: "left"` so `position` semantically matches the visible left edge; pass `"center"`/`"right"`/`"none"` to override.

## Platform notes

Linux is impossible, not merely unimplemented — Adobe has never shipped AE for it.

All `packages/jsx/*.jsx` is AE's own scripting API and is platform-neutral; never add platform branching there. Host differences are confined to `setup/platform.ts` (PlayerDebugMode via `defaults` vs `reg`, AE process via `pgrep` vs `tasklist`) and `cepExtensionsDir()` in `setup/paths.ts` (`~/Library/Application Support/...` vs `%APPDATA%\...`).

CI (`.github/workflows/ci.yml`) builds and smoke-tests on macos-latest and windows-latest: server starts, ≥63 tools, `check_setup` resolves paths, scaffold writes files. It cannot exercise the CEP install — no AE on a runner — so the Windows install path is the least-proven part of the project. macOS is the daily-driven platform.

## Out of scope (v1)

- Render queue (queue + render + progress + cancel).
- Footage / asset import & replace.
- AE preferences / settings changes (excluded by design — animation only).
- Windows support (`install-panel.mjs` is mac-only; CEP layout differs on Windows).
