# Claude development guide — after-effects-mcp

This file is for future Claude Code sessions working in this repo. Humans reading it: see `README.md` for the user-facing intro.

## What this project is

An MCP server that lets an LLM drive Adobe After Effects 2026: comps, layers, transforms, keyframes (with full interpolation/easing/tangent control), expressions, effects, text, shapes, masks, markers, footage import, Motion Graphics template export, one-off screenshots, bulk batches. 70 tools. macOS and Windows — the only two platforms AE runs on.

It ships five ways, and the ordering below is deliberate — it goes from least to most that the user has to already have installed:

| | For | Needs |
|---|---|---|
| `.mcpb` bundle | Claude Desktop | nothing — Desktop runs it on the Node it ships |
| Signed binary | any client, no Node | download and unzip |
| npm package | any client | Node 22+ |
| Claude Code plugin | Claude Code | this repo added as a marketplace |
| git checkout | development | the lot |

**Nothing here is Claude-only by design.** Skills and slash commands exist only in Claude's clients, so anything written only there reaches maybe half the users. The cross-cutting knowledge is carried by the MCP `instructions` field, MCP prompts, MCP resources and the `ae_guide` tool — all four are generated from the same source, and the Claude Code skills are one more generated output rather than the original. See "Guidance and how it reaches an agent" below.

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
| `packages/jsx/footage.jsx` | `import_footage` / `create_footage_layer`. The SVG viewBox check lives here because import is the only place that has the file path and the resulting item together. |
| `packages/jsx/mogrt.jsx` | `export_mogrt`. Saves, suppresses dialogs, exports outside the undo group, and re-fetches everything afterwards. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate. Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, `evalScript` mutex, JSON envelope, job driver, PNG reader. |
| `packages/ae-panel/client/pngcodec.js` | 16-bit→8-bit PNG conversion, empty-frame detection, decoded pixels for the stale check. Node builtins only, requireable by a test. |
| `packages/ae-panel/client/framecache.js` | The window of recently delivered frames that makes a re-served render buffer visible. |
| `packages/ae-panel/client/mogrt.js` | Zip surgery + box-filter resample that replaces `thumb.png` inside an exported `.mogrt`. Node builtins only, requireable by a test. |
| `packages/mcp-server/src/server.ts` | Tool registry, vision/async-envelope branching, error mapping. |
| `packages/mcp-server/src/tools/descriptions.ts` | All tool descriptions in one file — including the verbatim screenshot guidance. |
| `packages/mcp-server/src/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing. |
| `packages/mcp-server/src/jobs/manager.ts` | In-memory job table, `waitFor(jobId)` for the `await_job` tool. |
| `packages/mcp-server/src/issues/journal.ts` | The cross-session issue journal at `<project>/.ae-mcp/issues/`. Backs `log_issue` / `list_known_issues` / `mark_issue_reported`. The project folder is `process.cwd()`; a client that gives no usable one (Claude Desktop starts servers at `/`) falls back to `~/.after-effects-mcp`, reported as `scope: "home"` so the fallback is never silent. `AE_MCP_HOME` overrides the root (used by the CI check). |
| `packages/mcp-server/src/setup/{check,install,paths}.ts` | Backs `check_setup` / `setup_panel`. Never touches the bridge — it exists for the case where the panel isn't installed yet. |
| `packages/mcp-server/src/setup/platform.ts` | **The only place macOS and Windows diverge** (PlayerDebugMode storage, AE process detection). Plus `cepExtensionsDir()` in `paths.ts`. Keep platform branching here — do not scatter `process.platform` through the codebase. |
| `scripts/lib/setup.mjs` | Loads the compiled setup module so the dev scripts (`doctor`, `install-panel`, `enable-debug`) reuse the same platform logic the MCP tools use instead of keeping a second copy. |
| `packages/mcp-server/src/setup/scaffold.ts` | **The one definition of what a project folder is.** Client-aware layout, target resolution, never-overwrite. Used by both `init_project` and the CLI. |
| `packages/mcp-server/src/cli/init.ts` | `npx … init <dir>` — the terminal front end to `scaffold()`. Holds no templates of its own. |
| `packages/mcp-server/src/guides/*.md` | **Source of truth for agent guidance.** Frontmatter + markdown. Generated into resources, `ae_guide`, `instructions` and Claude Code skills. |
| `packages/mcp-server/src/prompts/*.md` | Source of truth for user-invoked flows. Generated into MCP prompts and Claude Code commands. `$ARGUMENTS` is substituted at `prompts/get`. |
| `packages/mcp-server/src/generated/content.ts` | Generated. Never hand-edit — `build-guides.mjs --check` fails the build if you do. |
| `packages/jsx/style.jsx` | `get_house_style` / `set_house_style`. Reads `house-style.md` beside the .aep over the bridge, which is the only channel every client has. |
| `plugin/` | The Claude Code plugin: `.mcp.json` + generated `skills/` and `commands/`. Everything under those two is output, not source. |
| `.claude-plugin/marketplace.json` | Marketplace catalog. Users add this repo, then install `after-effects@engine-room`. |
| `scripts/bundle-jsx.mjs` | Concatenates `packages/jsx/*.jsx` in dependency order into `packages/ae-panel/jsx/bundle.jsx`. Run via `npm run build:jsx`. |
| `scripts/prepare-package.mjs` | `prepack` hook. esbuild-bundles the server to `bin/server.js` (inlining `@engineroom/shared`, which is never published separately) and vendors the panel to `panel/`. |
| `scripts/install-panel.mjs` | Dev equivalent of `setup_panel`. Copies (or symlinks with `--symlink`) the panel into `~/Library/Application Support/Adobe/CEP/extensions/`. |
| `scripts/build-guides.mjs` | Generates every copy of the guidance prose from `src/{guides,prompts}/*.md`. `--check` mode runs in CI. Also asserts `GUIDE_TOPICS` in `schemas.ts` matches the guides on disk. |
| `scripts/build-mcpb.mjs` | The Claude Desktop bundle. Reproduces the runtime layout `setup/paths.ts` expects: `package.json`, `server/index.js`, real `node_modules/ws`, vendored `panel/`. |
| `scripts/build-binaries.mjs` | `bun build --compile` for mac arm64/x64 and win x64. Each target is a *folder* — the binary alone cannot find the panel. |
| `scripts/sign-and-notarize.sh` | codesign (hardened runtime + `scripts/entitlements.plist`) then `notarytool submit --wait`. Local-only; reads credentials from the environment and never from the repo. |

## The op pipeline (in detail)

Adding a new op = touching five places. In order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and an entry in `OpSchemas`.
2. **ExtendScript handler** — add to the matching module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`. Use `noUndo(fn)` for read-only ops (skips the undo group wrapper).
3. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: add an entry keyed by op name. Write it for an LLM agent reading the tool list cold.
4. **Build** — `npm run build` rebuilds TS and concatenates the .jsx bundle.
5. **Reload in AE** (optional, dev only) — `curl -X POST http://127.0.0.1:7777/reload-jsx` re-`$.evalFile`s the bundle without restarting AE.

The `server.ts` tool registration loop reads `OpSchemas`, so no MCP-side wiring is needed unless the op needs special return packaging (vision = image content, run_batch = async envelope, jobs/* = server-resident).

## Special return shapes

- **Vision** (`screenshot_frame`, `screenshot_layer`): JSX returns `{path, width, height, time, compId, layerId?}`. Panel reads the PNG, normalises it to 8-bit, base64-encodes, returns `{base64, bytes, ...}`. Server packages as MCP `image` content block. Two outcomes are deliberately *not* images: a fully transparent frame comes back as `{empty:true, reason}` and goes through `textResult`, and a frame whose pixels match a different earlier request is refused as a `STALE_FRAME` error. See "Known fragile areas".
- **Long batch** (`run_batch` >100 ops): JSX returns `{jobId, async:true, total}`. Panel drives `_continue_job` in chunks of 25 in the background, broadcasting `progress` events on WS. Server forwards WS progress as `notifications/progress` keyed by the request's `progressToken`.
- **Server-resident** (`await_job`, `get_job`, `cancel_job`, `check_setup`, `setup_panel`, `init_project`, `ae_guide`, `log_issue`, `list_known_issues`, `mark_issue_reported`): handled in `server.ts`; never forwarded to the panel (except `cancel_job`, which also sends `_cancel_job` to the bridge to set the JSX-side flag). They're still listed in `OpSchemas` so `tools/list` picks them up — membership in `SERVER_OPS` is what stops the forwarding.
- **Prose** (`ae_guide`): returns the markdown as a bare text content block rather than through `textResult()`. JSON-stringifying it would hand the model a wall of `\n`.
- **Downsampled screenshots**: handled entirely in `vision.jsx`. `saveFrameToPng` *does* respect `CompItem.resolutionFactor` (measured: a 3840×2160 comp yields 1920×1080 at factor 2, 960×540 at factor 4), so `__saveFrameAt` sets the factor, renders, and restores it in a `finally`. That restore is not optional — a throw mid-render would otherwise leave the user's comp at reduced resolution. The panel reads the true dimensions out of the PNG's IHDR chunk rather than computing them, so reported size can never disagree with the image sent. An earlier version shelled out to `sips`; it was replaced because rendering smaller is faster than resampling and needs no external tool, which is what makes downsampling work on Windows. The factor is *derived* from the comp when the caller omits one (`__autoDownsample`, aiming at a ~1280px long edge) — which is why `ScreenshotFrame`/`ScreenshotLayer` must not carry a zod `.default(1)`: a default there would reach the panel as an explicit 1 and the derivation would never run.

## Conventions

- **ExtendScript is ES3-ish.** No `let`/`const`/arrow functions/template literals/`Object.keys`/destructuring in `packages/jsx/*.jsx`. AE 2026 has native JSON but `core.jsx` polyfills defensively.
- **Stable IDs.** `getCompById(id)` uses `app.project.itemByID`; `getLayerById(comp, layerId)` walks `comp.layers` matching `layer.id`. Never use `.index` as a long-lived identifier — it shifts when layers are reordered.
- **One undo step per request.** `dispatch()` wraps the handler in `app.beginUndoGroup`/`endUndoGroup`. Long batches manage their own undo manually (`run_batch.__meta.noUndo = true`).
- **MCP server stdout is sacred.** All logs go to stderr via `util/logger.ts`. Touching `console.log` anywhere in mcp-server will corrupt the JSON-RPC stream.
- **Tool descriptions are written for LLMs.** Tell the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid. Screenshot descriptions especially must say "one-off, do NOT screenshot every frame."
- **Never report success for work that didn't happen.** An agent can only correct a failure it's told about, so a swallowed error is worse than a thrown one. `add_shape_content` is the reference case: it resolves every key first, and if any is unresolvable it removes the node it created and throws with the offending keys named, rather than leaving a half-built shape behind an `{ok:true}`. Schemas that accept free-form objects must be `.strict()` for the same reason — zod's default is to strip unknown keys silently.

## Guidance and how it reaches an agent

Tool descriptions cover one tool each. The knowledge that actually costs people
time is cross-cutting — ids not indexes, read then write then verify, the
spatial-ease array trap — and belongs to no single tool. There are four carriers
for it, in descending order of reach:

| Carrier | Reaches | Cost |
|---|---|---|
| Tool descriptions | every client, always | always resident |
| `instructions` (initialize result) | every client that honours it | always resident — keep it short |
| `ae_guide` tool | every client | on demand |
| MCP resources (`ae://guide/…`) | clients with resource support | on demand |
| Claude Code skills | Claude Code, claude.ai | on demand |

All of them except the tool descriptions come from
`packages/mcp-server/src/guides/*.md` via `scripts/build-guides.mjs`. **Edit the
markdown, never the outputs.** The same script generates
`packages/mcp-server/src/prompts/*.md` into MCP prompts and Claude Code commands.

Two rules that keep this honest:

- **`instructions` is always resident in every session, so it stays short.** It
  is the six things an agent cannot infer from the tool list, and a pointer to
  `ae_guide` for the rest. Adding a paragraph there is a tax on every request
  the user ever makes. Add it to a guide instead.
- **`ae_guide` exists because the better carriers are not universal.** Some
  clients drop `instructions`; fewer support resources. Tools are the floor
  every client reaches, so the guidance has to be available as one.

## Panel version gating

The panel does not update itself, and it ships inside every distribution — so
"tools newer than panel" is the normal state after any upgrade, not an edge
case. Before this existed it surfaced as `Unknown op: get_house_style`, which
tells an agent nothing and usually got retried.

**Two hashes, and they are not interchangeable:**

| | What it is | Where from |
|---|---|---|
| installed | the bundle in the CEP extension folder — what AE loads *next* launch | `sha256` on disk |
| running | the bundle the panel actually `$.evalFile`d — what answers *now* | `bundleHash` on `/health` |

They diverge for the entire window between `setup_panel` and restarting AE,
which is exactly when calls break. **Only the running hash is worth gating on.**
`setup/panelVersion.ts` maps the pair onto five states, and the distinction that
matters most to a user is `restart-needed` — telling someone to run
`setup_panel` again there wastes their time, so the message says so explicitly.

The fifth state, `partial-install`, is checked *before* any of the others,
because all of them reason from `bundle.jsx` alone and a current bundle says
nothing about the client files beside it. Callers pass `installComplete` from
`panelInstallDiff()`; it defaults to `true` so a caller that has not looked
keeps the old behaviour rather than quietly asserting the install is sound.

Three enforcement points, in order of preference:

1. **The gate in `server.ts`** — one `/health` per session, cached; refuses to
   forward and returns the remediation. `panelGate.invalidate()` after
   `setup_panel`, because the disk half of the comparison just changed.
2. **The `Unknown op:` backstop** — for panels too old to report a hash at all.
   This is never a false positive: `server.ts` validates tool names against
   `OpSchemas` before forwarding, so any op the panel rejects is one this server
   defines.
3. **`check_setup`'s `panelRunningCurrent`** — the truthful version of
   `panelUpToDate`, which compares files and therefore goes green the instant
   `setup_panel` runs, while AE carries on running the old code.

`tests/unit/panel-version.mjs` covers the decision table; CI runs it. Old panels
predate `bundleHash` entirely, so `undefined` must always mean "too old to say",
never "matches".

**Install before AE is open.** The panel loads at launch and only at launch, so
installing while AE is closed costs no restart. `check_setup` reports
`afterEffectsRunning`, and the guides, the `init-after-effects` prompt and
`setup_panel`'s description all branch on it. When changing that advice, change
all four.

## The project scaffold

`init_project` and `npx … init` both call `scaffold()` in `setup/scaffold.ts`.
The tool exists because **the server writing the files is the only design that
works everywhere** — Claude Desktop gives its agent no filesystem tools, so
"tell the agent to write these files" fails there entirely.

Three things it has to get right:

- **Where.** Explicit `dir` → the client's `roots` → `process.cwd()`. It refuses
  the filesystem root and the home directory outright, because Claude Desktop
  starts servers at `/` and scaffolding there is never what anyone meant. The
  error tells the agent to ask the user, which is the correct next move.
- **Which layout.** `server.getClientVersion()` carries the client's name
  through the MCP handshake, so `detectClient()` picks `CLAUDE.md` vs
  `AGENTS.md` vs `.cursor/rules/` without asking the user what they are running.
  `AGENTS.md` is always written; the client-specific file is a pointer to it,
  never a second copy.
- **Never clobber.** It checks every path first and writes nothing if any
  exists. An agent calling this does not know what is already there.

The house style is deliberately *not* part of the scaffold — see below.

## The house style

`house-style.md` lives next to the `.aep`, and is read and written over the
bridge by `packages/jsx/style.jsx`, not by the MCP server.

That looks like the wrong layer until you count clients. The bridge is the one
channel every client has, because the whole product already depends on it.
Reading the style over it needs no working directory, no `roots`, and no
filesystem tools on the client — so it works identically in Claude Desktop and
in a git checkout. A server-side file would need a project folder, and the
clients that need help most are exactly the ones that do not have one.

The costs, both reported rather than worked around:

- **The project must have been saved once.** `app.project.file` is null until
  then and there is no folder to write into. `get_house_style` returns
  `projectSaved: false` with an explanation; `set_house_style` throws it.
- **`set_house_style` replaces the whole file** and requires `overwrite: true`
  to replace an existing one. It is not a patch, and quietly half-rewriting
  someone's hand-written style guide is worse than refusing.

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
10. `get_house_style` on an **unsaved** project → `{found:false, projectSaved:false}` with a readable reason, not a throw. Save the project, `set_house_style({content})` → file appears next to the .aep. Call it again without `overwrite` → refuses and names the path. With `overwrite:true` → replaces. Non-ASCII (curly quotes, accented font names) survives the round trip — that is the UTF-8 encoding, and it fails silently if dropped.
11. `init_project` with no `dir` from a client that advertises `roots` → writes into the client's folder, `resolvedFrom: "client-root"`. From Claude Desktop (cwd `/`) → refuses with a message telling the agent to ask.
12. Version gate, with AE running an older panel: any forwarded op → the remediation message, not `Unknown op`. `setup_panel` then the same op → "still running the previous version", naming the restart as the only fix. Restart AE → works. (`tests/unit/panel-version.mjs` covers the decision table; this recipe covers the wiring.)
13. Partial install: with AE **open**, overwrite a client file in the installed panel (`echo x >> …/client/main.js`). `check_setup` → `panelUpToDate` FAIL naming `client/main.js`, and the next steps lead with "quit After Effects" — never "restart and try again". Restore it → green.
14. Missing dependency: `rm -rf …/games.engine-room.ae-mcp/node_modules/ws`, restart AE. The panel shows "cannot start — the ws module is missing" with the fix in its log, rather than "starting…". `check_setup` → `panelDependencies` FAIL naming the path, not just `bridgeReachable` FAIL.
15. Scoped reads, on a comp with a keyframed shape layer: `list_layers({compId})` and `list_layers({compId, include: []})` → the second is id/index/name/sourceType only, same layers, same ids. `get_layer_full` with no `include` → byte-identical to before this change. With `include: ["transform","bounds"]` → those two sections plus the header, and an `included` echo. With `maxKeyframes: 4` on a property with more → four keyframes, `keyframesOmitted` and a `keyframesTruncated` note naming the count. With `shapeDepth: 1` → `childrenOmitted` on the groups the walk stopped at. `screenshot_frame({compId})` on a 3840×2160 comp → 1280×720 back with `downsample: 3`; the same call with `downsample: 1` → full resolution; the comp's own resolution is unchanged in the viewer afterwards.
17. `import_footage` on an SVG with `viewBox="0 0 278050 333334"` and no width/height → refuses, names both aspect ratios, and the item is **gone** from `get_project_summary`. The same file with `force:true` → the item stays and `validation.ok` is false. A `0 0 512 512` SVG imports clean, and `create_footage_layer` + `screenshot_frame` shows it rendering. (The broken one, forced into a comp, produces no PNG at all — that is the bug, not a tooling failure.)
18. `export_mogrt` on a comp with a text layer in a non-Adobe font → returns in a few seconds with no dialog in AE, and `fonts` names the font. With `suppressDialogs:false` → a modal dialog appears and the call blocks until it is clicked; that is the control, and it is worth running once because the whole tool rests on it. Called twice with the same `name` → refuses the second, then replaces with `overwrite:true`. On a project that has never been saved → refuses with a message naming the save, not a dialog.
19. `.mogrt` thumbnail: give the comp an empty first frame (keyframe every layer's opacity 0 → 100 over the first second), export with no `posterTime` → `thumb.png` inside the zip is solid black. Export again with `posterTime` past the fade → `thumbnail.patched: true` and the frame is in there at AE's own thumbnail dimensions. Unzip and check the *other* entries are byte-identical; a corrupt `project.aegraphic` would not show up in the picture.

16. Compiled binary, the one no unit test reaches: run the built binary from an empty directory *and* from `/`, and confirm `setup_panel` installs a populated `node_modules/ws`. Under `bun --compile` the module resolver returns a bare specifier rather than throwing, so this path cannot be exercised under plain Node — see the `require.resolve` note in Known fragile areas.

## The issue journal

`log_issue` is how one session hands a hard-won workaround to the next, in the folder the work happened in. Four properties matter, and all four are things it would be easy to get wrong:

- **The folder ignores itself.** `ensureJournalDir` writes `.ae-mcp/.gitignore` containing `*` on first use. That is what keeps the journal untracked — not a rule in the project's `.gitignore`, which most of these folders do not have, and which the ones that do would have to remember to add.

- **The title is the identity.** It is slugified into the filename, so re-logging under the same title extends the entry rather than adding a near-duplicate. Agents are told to `list_known_issues` first for exactly this reason.
- **Reporting state belongs to the entry, not the sighting.** Re-logging a known problem preserves `reported`, `issueUrl` and `firstSeen`, and a `cause` worked out once survives a later sighting logged without one. Otherwise the user gets asked to report the same thing repeatedly, which is the fastest way to make them stop reading the offer.
- **The files are meant to be hand-edited.** `parse()` is deliberately forgiving: missing keys, reflowed text and deleted headings degrade one entry instead of failing the whole journal. A file with no recognised headings keeps its text as the symptom rather than being read as empty.
- **The listing is an index, not the corpus.** `listIssues` returns one line per entry by default — id, title, tools, counts and a clipped summary — and the body is fetched with `id`. That is worth roughly 5× on a journal of a dozen entries, and a tool result is re-sent on every request for the rest of the session. The failure mode to guard against is an index that leads nowhere: an agent reads this journal *because something already failed*, so the summary has to be enough to pick an entry and the `next` pointer has to name the call that opens it. `tests/unit/issue-journal.mjs` asserts both.

The user-facing half is the offer to report. It now lives in exactly two places: the `log_issue` **tool description** carries the minimum (finish the work first, phrase it for a non-programmer, don't say "GitHub issue"), and `src/prompts/report-ae-issue.md` carries the full flow. That second one is generated into both the MCP prompt (every client) and the Claude Code command, so there is nothing to keep in sync by hand. If you change the behaviour, change those two.

## Known fragile areas

- `saveFrameToPng` is community-known, not officially documented. Alpha edge cases reported on some comps. If it fails, fallback would be the render queue with PNG Sequence template (slow; deferred to v1.1).
- ExtendScript single-threading: `run_jsx` with a long synchronous loop will freeze AE's UI. Document for the agent in the tool description (already done).
- **A busy AE is indistinguishable from a dead bridge at the HTTP layer.** ExtendScript is single-threaded, so while a script runs — or a modal dialog sits unclicked — the panel cannot service its socket at all. The connection is accepted and then nothing comes back. That is why `httpClient` separates `BridgeTimeoutError` from `BridgeUnreachableError` and why `check_setup`'s `bridgeReachable` reports a timeout differently from a refusal: the two have opposite remedies, and "restart After Effects" said to someone whose script is still running throws away work for nothing. Enumerating `app.effects` (~250 entries, tens of seconds in 26.3) is the reproducible case — issue #26 — which is also why `list_available_effects` caches for the session. Never collapse the two errors back into one sentence.
- **The server's op timeout must sit above the panel's own waits, not on them.** `saveFrameToPng` is asynchronous and the panel polls for the PNG for up to 120s; with the server also at 120s it gave up at the exact moment the panel might still have succeeded. `SLOW_OPS` in `bridge/httpClient.ts` gives the screenshot, `run_jsx` and `run_batch` ops 300s. `AE_MCP_OP_TIMEOUT_MS` overrides every op, deliberately including the slow ones — one number a user can reason about beats a matrix they cannot see.
- CEP manifest's `<AutoVisible>false</AutoVisible>` was unreliable in early CEP 12 builds. Current manifest uses `AutoVisible=true` with a small geometry — the panel still auto-loads invisibly enough; the user can dock the small status panel out of the way.
- CEP panels installed without signing require `PlayerDebugMode=1`. The user does this once via `npm run enable:debug` and a reboot.
- **Anthropic API requires JSON Schema draft 2020-12** for tool input schemas. `zod-to-json-schema` 3.x has no 2020-12 target — `openApi3` emits `nullable` (rejected) and `jsonSchema7` emits draft-07 tuple form `items:[...]` (rejected; 2020-12 wants `prefixItems`). `server.ts` uses `jsonSchema7` + `$refStrategy:"none"` + a `toDraft2020()` post-pass that rewrites tuples. Don't switch back to `openApi3`.
- **`setTemporalEaseAtKey` on spatial properties takes a single-element array**, regardless of 2D/3D — for Position/Anchor Point, the ease is along the motion path. Non-spatial multi-dim (Scale, Color) need one entry per dimension. `keyframes.jsx` branches on `prop.isSpatial`. If you ever see "Value array does not have 1 elements", a spatial property is being fed N entries.
- **`saveFrameToPng` is asynchronous.** It returns before the file is on disk, so anything reading the PNG must poll until the size settles. A cold render of a heavy 4K comp was measured taking over 15 seconds; the panel's wait is 120s because the original 5s silently failed screenshots that were merely still rendering.
- **`saveFrameToPng` re-serves stale buffers and reports success.** Past some per-frame render cost, AE hands back a frame it rendered earlier: byte-identical results for unrelated comps at unrelated times, and at *different* `downsample` factors, which cannot even be the same number of pixels. Nothing in the response distinguishes it — fresh temp file, `ok:true`, well-formed PNG — so content identity is the only signal available. `client/framecache.js` keeps the last 24 delivered frames keyed by `(op, compId, layerId, time, downsample)` and refuses any frame whose pixels match a *different* key. It is an error rather than a warning on the image because an agent that can see the picture believes the picture. It lives in the panel, not the server, because the panel sees every render — the documented workaround for this bug POSTs `/op` directly. Two consequences to keep in mind: the *first* stale buffer of a session always gets through, since there is nothing yet to compare it against; and a genuinely static comp screenshotted at two times does trip it, which is why the message says so and points at a different `downsample` to distinguish the two. Reported as issue #29.
- **A 16-bit project renders 16-bit-per-channel PNGs, and many decoders reject those outright.** `client/pngcodec.js` converts to 8 bits per channel before the panel base64-encodes; anything already 8-bit is passed through byte-for-byte and never re-encoded. Taking the high byte of each 16-bit sample is exact rather than lossy-with-drift, because 8→16 promotion multiplies by 257. The same pass reports a frame whose every pixel is transparent as `empty: true` with **no image** — the ~5KB PNG that encodes one is the other thing decoders choke on, and "the frame is empty" is the useful reading anyway. `tests/unit/png-codec.mjs` and `tests/unit/frame-cache.mjs` cover both with synthetic fixtures and a second, independent PNG implementation; CI runs them, because there is no 16-bit AE project on a runner and this is real image code.
- **`panelSourceDir()` must prefer the checkout over the vendored copy.** After any `npm pack`, a stale `packages/mcp-server/panel/` is left on disk (gitignored). If that were checked first, `setup_panel` in a dev checkout would install the stale copy instead of what you're editing. Order matters in `setup/paths.ts`.
- **esbuild preserves the entry point's hashbang.** Adding a `banner` with `#!/usr/bin/env node` produces a second one on line 2 and the published binary dies with a syntax error. `prepare-package.mjs` asserts there is exactly one.
- **Text alignment is justification, never a computed anchor.** `addText()` centre-justifies point text with the anchor at the origin, so the visible left edge sits at `-width/2`. Until 0.2.1 `create_text_layer` implemented `anchorAlign` by measuring `sourceRectAtTime()` and writing that offset into the Anchor Point. It renders identically at creation and is wrong from the first edit onward: the offset is baked for the string that existed then, so retyping, an expression on Source Text, or an Essential Graphics edit in Premiere re-centres the text on a stale anchor and the layout jumps — and any `sourceRectAtTime()` expression sizing a background behind it inherits the error. `anchorAlign` now sets `ParagraphJustification.LEFT/CENTER/RIGHT_JUSTIFY` (the map lives once, in `text.jsx`) and leaves the anchor at `[0,0,0]`, which is live for whatever the layer says later. Reported as issue #24. `"none"` still means "touch nothing".
- **`addText()` inherits the user's Character panel.** Tracking especially: a layer created with no styling arrives at whatever that workspace was last left on — the report that opened #24 measured `-20` — so the same call renders differently on two machines. Nothing in this repo ever set it. `create_text_layer` now writes tracking explicitly (`args.tracking`, or 0), which is the only way to make the tool reproducible; `anchorAlign: "none"` opts out along with everything else.
- **A compiled binary has no module paths.** `import.meta.url` inside a `bun --compile` build points into the executable's virtual filesystem, so `packageRoot()` finds nothing. `setup/paths.ts` falls back to `executableDir()` — the panel, `package.json` and a real `node_modules/ws` ship *beside* the binary, which is why every binary target is a folder and not a single file. Shipping the bare executable would break `setup_panel` with no obvious cause.
- **`require.resolve` does not throw in a compiled binary — it returns the bare specifier.** `require.resolve("ws")` gives back `"ws"`, not a path and not an exception. Anything that treats a failed resolve as a throw is therefore dead code there, and `path.dirname("ws")` is `"."` — the *working directory*. v0.2.0 copied that into the CEP extension folder, which produced an empty `node_modules/ws` for a server started somewhere empty, and would have attempted to copy the entire filesystem for one started at `/`. `wsModuleDir()` now requires `path.isAbsolute` before believing the resolver and confirms every candidate with `isWsModuleDir()`. **Validate resolver output by its contents, never by `existsSync`.**
- **The panel cannot start without `ws`, and cannot say so.** `main.js` requires it at boot; before this was fixed, a failed require threw out of the top-level IIFE before the DOM handles existed, so the panel sat on "starting…" for ever and the only symptom was silence on port 7777. The require now runs *after* the logger is set up and bails out visibly. Keep it in that order.
- **A panel install can be half-written, and it looks fine.** Installing while AE holds the client files open updates `jsx/bundle.jsx` and fails on the rest. `panelUpToDate` used to hash only the bundle, so it went green on a mix of two versions while every call failed — and because the bundle *was* current, `assessPanel` concluded `restart-needed` and sent the user round a loop no restart could end. `panelInstallDiff()` compares every shipped file, and `installComplete: false` outranks the restart verdict. Reported as issue #20.
- **`ws` can never be inlined.** `setup_panel` copies the directory into the CEP extension, because AE's CEF process cannot resolve modules out of this package. Every packaging path (`prepare-package.mjs`, `build-mcpb.mjs`, `build-binaries.mjs`) has to keep it as a real directory on disk.
- **Bare Mach-O binaries cannot be stapled.** `xcrun stapler` only writes tickets into bundle formats (.app/.pkg/.dmg). The release notarizes the *zip* and lets Gatekeeper verify online on first launch. Do not add a `stapler staple` call expecting it to work.
- **The hardened runtime blocks JIT.** Bun embeds JavaScriptCore, so `scripts/entitlements.plist` must grant `allow-jit` and `allow-unsigned-executable-memory`. Without them the binary signs and verifies fine and then refuses to launch — on someone else's machine, not yours.
- **Shape `Contents` renders index 1 in front, and `addProperty` appends to the end.** So the *first* node added is the one on top, which is the opposite of the layer stack, and building back-to-front (body, then title bar, then dots) produces a silent solid slab with no error. The fix an agent reaches for is worse than the bug: `property.moveTo()` looks correct when the comp is rendered standalone and leaves it serving a stale buffer in every **nested** render. `add_shape_content` therefore takes `zOrder` rather than an index — `"back"` is the append AE already does and touches nothing, and `"front"` is the single `moveTo(1)` call site in the codebase, done on the empty node before any property is set so a failure costs an empty node. The guidance everywhere (tool description, guide) is to order the calls front-to-back and never need it. Reported as issue #32; if `moveTo` is ever proven safe, the note in the description comes out, not the option.
- **A shape node reference goes stale when a sibling is added.** Hold a Fill, add a Stroke to the same group, and the Fill reference starts throwing `Object is invalid`. Add every node first, then re-fetch by name before setting values or expressions. `add_shape_content` re-fetches from the parent after its own `moveTo` for exactly this reason. Reported in issue #24.
- **Generated files under `plugin/` will be overwritten.** `plugin/skills/**` and `plugin/commands/**` come from `src/{guides,prompts}/*.md`. Hand-edits survive until the next `npm run build`. CI runs `build-guides.mjs --check` to catch this at review time rather than in a release.
- **A scoped read must say what it left out.** `include`, `maxKeyframes` and `shapeDepth` on the read ops exist because a tool result is re-sent on every later request — a 65k-token `get_layer_full` is paid for once per call and then again on every request until the session ends. Two rules keep them honest: absent means *everything*, so no existing caller changes behaviour; and anything dropped is named and counted in the response (`included`, `keyframesOmitted` + `keyframesTruncated`, `childrenOmitted`), because a short answer that looks complete is the same class of lie as a swallowed error. Note what the call sites depend on: `args.include ? args.include : null` works because an empty array is truthy in JS, which is exactly what makes `include: []` mean "core fields only". Adding a `.length` guard there would quietly turn it back into "everything".
- **ExtendScript parses chained ternaries left-associatively.** `a ? x : b ? y : z` evaluates as `((a ? x : b) ? y : z)`, so the first truthy branch becomes the next condition and everything falls through to the last alternative — no throw, just the wrong answer. `get_project_summary` labelled every project item `"folder"` for two releases on one such line (issues #21/#22). Write if/else chains in `packages/jsx/*.jsx`; parentheses parse correctly too, but a later edit can drop them. `tests/unit/jsx-ternary.mjs` scans the sources and fails the build — there is no offline ExtendScript runtime, so nothing else can.
- **`run_jsx`'s undo group collides with `copyToComp`.** AE refuses to copy a layer that has a parent or a linked expression while an undo group is open, so `dispatch()`'s wrapper broke exactly the rigs worth copying (issue #30). `run_jsx` now takes `undoGroup:false`, resolved per call through the predicate form of `__meta.noUndo`, and `core.jsx` exposes `withoutUndoGroup(fn)` for closing the group around one statement. Keep the opt-out on the handler's `__meta` — dispatch must stay stateless between calls, or one op's opt-out leaks into the next.
- **AE's scripting DOM has no `toComp`/`toWorld`.** Those exist only in the expression language, so anything needing a world transform reimplements the matrix chain — `layers.jsx` does, for `parent_layer`'s `preserveTransform`. Two things follow: 2D only (AE's 3D rotation order is not worth guessing at), and a child's `Position` has two possible readings of its parent's space that differ by the parent's anchor point, so the position correction only fires when AE's own answer matches *neither* — the one case where AE is provably wrong.
- **`exportAsMotionGraphicsTemplate` invalidates every reference held across it.** Not just the `CompItem` — `app.project` too. Measured on 26.3: after a successful export, a `comp` captured beforehand throws `Object is invalid` on `.name`, and so does an `app.project` captured beforehand, while a fresh `app.project.itemByID(id)` returns a working comp. The first version of `export_mogrt` built its result object from the pre-export `comp` and therefore threw *after* writing a perfectly good `.mogrt` — reporting a failure for work that did happen, which is the same class of lie as swallowing an error. `mogrt.jsx` captures `id` and `name` as primitives before the call and re-fetches after it. Nothing about the error says which object went stale, so if a mogrt op ever starts throwing `Object is invalid`, look for a handle held across the export before anything else.
- **`app.beginSuppressDialogs()` is what makes a scripted `.mogrt` export usable, and it was worth measuring.** Issue #23 filed it as untested. It is not: with a comp using a non-Adobe font, the export returns in ~3s suppressed and blocks past 60s unsuppressed, writing nothing until someone clicks OK on "The following 1 fonts were not synced from Adobe". `endSuppressDialogs(false)` must run in a `finally` — leaving dialogs suppressed would silence every warning for the rest of the user's session.
- **The `.mogrt` filename comes from `comp.motionGraphicsTemplateName`, not the comp name**, and it defaults to the literal `"Untitled"` for a template assembled by script. Left alone, every export in a project overwrites the same `Untitled.mogrt`. `export_mogrt` defaults it to the comp name but leaves a name the user actually set alone. Related: `CompItem.posterTime` does not exist (the thumbnail is the comp's first frame, hence the black one on anything that fades up), and there is no `getMotionGraphicsDataName` — only the reverse-indexed `setMotionGraphicsControllerName`.
- **AE fabricates dimensions for an SVG with a very large viewBox, and the numbers depend only on the viewBox.** A synthetic file with the reported `0 0 278050 333334` imports as **15906x5654** — byte for byte the dimensions in issue #33, from an entirely different SVG. It will not even rasterize: `saveFrameToPng` on a comp containing one produces no file at all, where a healthy SVG renders in seconds. That reproducibility is what makes the aspect-ratio check in `footage.jsx` a reliable detector rather than a heuristic.
- **CEP anchors `__dirname` at the extension root, not at the folder holding the file.** So `require("ws")` resolves (node_modules is at the root) while `require("./pngcodec.js")` from `client/main.js` does not — it looks for `<ext>/pngcodec.js`, which is not where the file is. This is why the panel is the only part of the system whose bootstrap has to be tested rather than reasoned about: it shipped on `versions/0.3.0` refusing to start with "cannot start — pngcodec.js … is missing", and nothing caught it, because there is no AE on a runner, the unit tests require those modules by absolute path, and the one machine it had ever run on still had a pre-#36 panel installed. **Resolve panel-internal paths from `cs.getSystemPath(SystemPath.EXTENSION)`, never from `__dirname`** — that is authoritative, and `main.js` now builds `clientDir` from it before requiring anything. `tests/unit/panel-boot.mjs` runs the real `main.js` against a stub CEP host in a copy of the installed layout and asserts it reaches a listening `/health`.
- **CEP returns a file URL, not a path.** `getSystemPath` gives `file:///C:/Users/…` on Windows, so stripping only the scheme leaves `/C:/…`; `path.join` then reads it as root-relative and produces `\C:\…\bundle.jsx`, and the panel reports the bundle missing while it sits at that exact location. `client/csinterface.js` strips the slash before a drive letter — do that there, not at call sites, since it is the one place a URL becomes a native path. `tests/unit/panel-paths.mjs` covers it; there is no AE on a runner, so nothing else does.

## Platform notes

Linux is impossible, not merely unimplemented — Adobe has never shipped AE for it.

All `packages/jsx/*.jsx` is AE's own scripting API and is platform-neutral; never add platform branching there. Host differences are confined to `setup/platform.ts` (PlayerDebugMode via `defaults` vs `reg`, AE process via `pgrep` vs `tasklist`) and `cepExtensionsDir()` in `setup/paths.ts` (`~/Library/Application Support/...` vs `%APPDATA%\...`).

CI (`.github/workflows/ci.yml`) builds and smoke-tests on macos-latest and windows-latest: server starts, ≥70 tools, `instructions`/prompts/resources are served and `$ARGUMENTS` substitutes, `check_setup` resolves paths, and both scaffold entry points write files and refuse to clobber. It cannot exercise the CEP install — no AE on a runner — so the Windows install path is the least-proven part of the project. macOS is the daily-driven platform.

## Releasing

`make release` is local-only and does the whole thing in one pass: bump → build → npm dry-run → `.mcpb` → binaries → codesign → notarize → commit → tag → push → `gh release create`. Pushing the tag is what triggers `release.yml`, which publishes to npm over OIDC; the GitHub release with its assets is created by the script itself.

Everything that can fail happens **before** the tag is pushed. A failed notarization costs a `git checkout -- .` and nothing else — that ordering is deliberate, so do not move the artifact build after the tag.

The Developer ID certificate stays on one machine and is never read by anything in this repo; `sign-and-notarize.sh` takes credentials from the environment only. A leaked certificate is revoked by Apple, and revocation stops *already-distributed* binaries from launching, which is why CI does not sign.

## Out of scope (v1)

- Render queue (queue + render + progress + cancel).
- Footage *replace* / relink. Import landed in 0.3.0 (`import_footage`) because issue #33's SVG check has nowhere else to live — the detection needs the file path and the imported item in the same call. Replace and relink are still out.
- AE preferences / settings changes (excluded by design — animation only).
- Code-signing the Windows binary (needs a separate certificate; SmartScreen warns on first run until then).
- MCP-over-HTTP straight from the CEP panel. It would remove the separate server process entirely, but the panel cannot install itself — `check_setup` and `setup_panel` exist precisely for when the panel is not there yet, so something still has to ship.
