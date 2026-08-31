# Claude development guide — after-effects-mcp

This file is for future Claude Code sessions working in this repo. Humans reading it: see `README.md` for the user-facing intro.

## What this project is

An MCP server that lets an LLM drive Adobe After Effects 2026: comps, layers, transforms, keyframes (with full interpolation/easing/tangent control), expressions, effects, text, shapes, masks, markers, footage import, audio cue placement, comp snapshots and diffs, Motion Graphics template export, one-off screenshots and contact sheets, bulk batches. 74 tools. macOS and Windows — the only two platforms AE runs on.

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

The MCP server is stateless except for an in-memory `JobManager` and the write queue. The panel is the *only* thing that talks to AE; it holds a Promise-chain mutex around `evalScript` because ExtendScript is single-threaded and concurrent calls would interleave. That mutex is necessary and not sufficient — see "Serializing writes" below.

## Source layout

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** Adding an op = adding a zod schema here. |
| `packages/shared/src/ipc.ts` | HTTP envelope + WS event types. |
| `packages/jsx/*.jsx` | ExtendScript handlers. Each module attaches functions to the global `OPS` table. ES3-ish — no `let`/`const`/arrow/templates. |
| `packages/jsx/core.jsx` | JSON polyfill, `dispatch(payloadJson)` router, `withUndo()` wrapper, `JOBS` table for chunked async. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists. Spend disproportionate care here. |
| `packages/jsx/snapshot.jsx` | The comp fingerprint and the diff of two of them. Backs `snapshot_comp` / `diff_comp` and the `diff:true` flag on `run_jsx` / `run_batch`. The diff is pure — two objects in, one out — which is what lets it be tested with no AE. |
| `packages/jsx/batch.jsx` | `run_batch` for ≤100 ops inline; otherwise registers a job and yields chunks via `_continue_job`. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper. Returns a temp path; the panel base64-encodes. |
| `packages/jsx/footage.jsx` | `import_footage` / `create_footage_layer`. The SVG viewBox check lives here because import is the only place that has the file path and the resulting item together. Also holds `__importFile()` and `__itemPathMap()` — the one import in the codebase and the one project-by-path scan, both shared with `audio.jsx`. |
| `packages/jsx/audio.jsx` | `place_audio_cues`. Plans the whole cue list with no side effects, then imports each distinct file once and builds a layer per cue, rolling back everything it made if any of it fails. |
| `packages/jsx/mogrt.jsx` | `export_mogrt`. Saves, suppresses dialogs, exports outside the undo group, and re-fetches everything afterwards. |
| `packages/jsx/raw.jsx` | `run_jsx` — the result serializer, the wrapper that maps a failure back onto the caller's source, and the per-session `libraries` cache. |
| `packages/jsx/helpers.jsx` | The helper scope a `run_jsx` script runs in: `compById`, `layerById`, `ease`, `addKeys`, `shape`. Global functions on purpose. Every one is listed by signature in the `run_jsx` description — change both together, since that is the only place a caller sees them. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate. Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, `evalScript` mutex, JSON envelope, job driver, PNG reader. |
| `packages/ae-panel/client/pngcodec.js` | 16-bit→8-bit PNG conversion, empty-frame detection, decoded pixels for the stale check, and `inspectPngStructure` — the chunk walk that says whether a file is a whole PNG yet. Node builtins only, requireable by a test. |
| `packages/ae-panel/client/framereader.js` | The poll loop that decides when After Effects has *finished* writing a frame, and the two error messages that come out of it. Issue #45 lives here. |
| `packages/ae-panel/client/contactsheet.js` | Tiles several frames into one labelled sheet, bitmap font included. Everything `times[]` needs that ExtendScript cannot do. |
| `packages/ae-panel/client/framecache.js` | The window of recently delivered frames that makes a re-served render buffer visible. |
| `packages/ae-panel/client/mogrt.js` | Zip surgery + box-filter resample that replaces `thumb.png` inside an exported `.mogrt`. Node builtins only, requireable by a test. |
| `packages/mcp-server/src/server.ts` | Tool registry, vision/async-envelope branching, error mapping. |
| `packages/mcp-server/src/tools/descriptions.ts` | All tool descriptions in one file — including the verbatim screenshot guidance. |
| `packages/mcp-server/src/tools/runJsxSource.ts` | `run_jsx`'s `scriptPath` and `libraries`. The **server** reads those files, never the panel — same reasoning as `init_project`. `OPS.run_jsx` throws if a `scriptPath` still reaches it: that means the call came through `run_batch` (whose steps are never validated) or a direct `/op`, and running the empty script would report success for a file nobody read. It resolves those two fields and **spreads everything else through untouched** — see "The only op whose input is rewritten" below. |
| `packages/mcp-server/src/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing. |
| `packages/mcp-server/src/bridge/writeQueue.ts` | The one-writer-at-a-time mutex, and `extendUntil` — the lease that outlives its own call so a long `run_batch` keeps the lock while the panel drives it. Classification comes from `OpMutation` in `schemas.ts`. |
| `packages/mcp-server/src/jobs/manager.ts` | In-memory job table, `waitFor(jobId)` for the `await_job` tool. |
| `packages/mcp-server/src/snapshots/store.ts` | In-memory comp fingerprints for `snapshot_comp` / `diff_comp`. Bounded ring; `missingMessage()` is the whole reason it is a class rather than a `Map`. |
| `packages/mcp-server/src/issues/journal.ts` | The cross-session issue journal — two of them: `<project>/.ae-mcp/issues/` and the user-level `~/.ae-mcp/issues/`. Backs `log_issue` / `list_known_issues` / `mark_issue_reported`. The project folder is `process.cwd()`; a client that gives no usable one (Claude Desktop starts servers at `/`) falls back to `~/.after-effects-mcp`, reported as `scope: "home"` so the fallback is never silent. `AE_MCP_HOME` overrides both roots (used by the CI check). |
| `packages/mcp-server/src/setup/{check,install,paths}.ts` | Backs `check_setup` / `setup_panel`. Never touches the bridge — it exists for the case where the panel isn't installed yet. |
| `packages/mcp-server/src/setup/platform.ts` | **The only place macOS and Windows diverge** (PlayerDebugMode storage, AE process detection). Plus `cepExtensionsDir()` in `paths.ts`. Keep platform branching here — do not scatter `process.platform` through the codebase. |
| `scripts/lib/setup.mjs` | Loads the compiled setup module so the dev scripts (`doctor`, `install-panel`, `enable-debug`) reuse the same platform logic the MCP tools use instead of keeping a second copy. |
| `packages/mcp-server/src/setup/scaffold.ts` | **The one definition of what a project folder is.** Client-aware layout, target resolution, never-overwrite. Used by both `init_project` and the CLI. |
| `packages/mcp-server/src/cli/init.ts` | `npx … init <dir>` — the terminal front end to `scaffold()`. Holds no templates of its own. |
| `packages/mcp-server/src/guides/*.md` | **Source of truth for agent guidance.** Frontmatter + markdown. Generated into resources, `ae_guide` topics and Claude Code skills. A `reference: <parent>` line makes one a reference file under the parent skill rather than a skill of its own — see "Guidance and how it reaches an agent". |
| `packages/mcp-server/src/prompts/*.md` | Source of truth for user-invoked flows. Generated into MCP prompts and Claude Code commands. `$ARGUMENTS` is substituted at `prompts/get`. |
| `packages/mcp-server/src/generated/content.ts` | Generated. Never hand-edit — `build-guides.mjs --check` fails the build if you do. |
| `packages/jsx/style.jsx` | `get_house_style` / `set_house_style`. Reads `house-style.md` beside the .aep over the bridge, which is the only channel every client has. |
| `packages/mcp-server/src/style/summary.ts` | The digest `get_house_style` returns by default. Parses a markdown document nobody controls; falls back to the document's own opening when it recognises nothing. Reading stays on the panel — only the summarising is here. |
| `plugin/` | The Claude Code plugin: `.mcp.json` + generated `skills/` and `commands/`. Everything under those two is output, not source. |
| `.claude-plugin/marketplace.json` | Marketplace catalog. Users add this repo, then install `after-effects@engine-room`. |
| `scripts/bundle-jsx.mjs` | Concatenates `packages/jsx/*.jsx` in dependency order into `packages/ae-panel/jsx/bundle.jsx`. Run via `npm run build:jsx`. |
| `scripts/prepare-package.mjs` | `prepack` hook. esbuild-bundles the server to `bin/server.js` (inlining `@engineroom/shared`, which is never published separately) and vendors the panel to `panel/`. |
| `scripts/install-panel.mjs` | Dev equivalent of `setup_panel`. Copies (or symlinks with `--symlink`) the panel into `~/Library/Application Support/Adobe/CEP/extensions/`. |
| `scripts/build-guides.mjs` | Generates every copy of the guidance prose from `src/{guides,prompts}/*.md`. Holds the hand-written `instructions` text. `--check` mode runs in CI. Also asserts `GUIDE_TOPICS` in `schemas.ts` matches the guides on disk, and that every `reference:` guide has a parent that points at it. |
| `scripts/build-mcpb.mjs` | The Claude Desktop bundle. Reproduces the runtime layout `setup/paths.ts` expects: `package.json`, `server/index.js`, real `node_modules/ws`, vendored `panel/`. |
| `scripts/build-binaries.mjs` | `bun build --compile` for mac arm64/x64 and win x64. Each target is a *folder* — the binary alone cannot find the panel. |
| `scripts/sign-and-notarize.sh` | codesign (hardened runtime + `scripts/entitlements.plist`) then `notarytool submit --wait`. Local-only; reads credentials from the environment and never from the repo. |

## The op pipeline (in detail)

Adding a new op = touching six places. In order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and an entry in `OpSchemas`.
2. **Classification** — the `OpMutation` table at the bottom of the same file: `"write"`, `"read"` or `"server"`. `tests/unit/write-queue.mjs` fails the build if you skip it, on purpose — see "Serializing writes".
3. **ExtendScript handler** — add to the matching module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`. Use `noUndo(fn)` for read-only ops (skips the undo group wrapper).
4. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: add an entry keyed by op name. Write it for an LLM agent reading the tool list cold.
5. **Build** — `npm run build` rebuilds TS and concatenates the .jsx bundle.
6. **Reload in AE** (optional, dev only) — `curl -X POST http://127.0.0.1:7777/reload-jsx` re-`$.evalFile`s the bundle without restarting AE.

The `server.ts` tool registration loop reads `OpSchemas`, so no MCP-side wiring is needed unless the op needs special return packaging (vision = image content, run_batch = async envelope, jobs/* = server-resident) — or, in one case, special *input* packaging: `run_jsx` is rewritten between zod validation and the forward, so `scriptPath` becomes `code` and `libraries` become `{path, hash}` before the panel ever sees them (`tools/runJsxSource.ts`).

### The only op whose input is rewritten

Adding a field to `RunJsx` is therefore the one case where step 1 above is not
enough on its own — so `resolveRunJsxSource` is built to make it enough anyway.

It used to construct a fresh args object and copy across the fields it knew
about, which made it a **second copy of the `RunJsx` schema, maintained by
hand**. The two diverged the first time the schema grew: `diff` and `diffCompId`
were added to `RunJsx` and `RunBatch` together, `run_batch` forwards its args
untouched and worked, and `run_jsx` dropped both on the floor. Nothing failed.
`diff:true` came back as an ordinary success with no diff on it — the swallowed
error this repo refuses everywhere else, in the one tool where an agent that
cannot see what a script changed re-runs the script.

Two rules, and they are the whole of it:

- **Spread the caller's args; override only what this function resolves.** The
  whitelist belongs to the zod schema, which has already run by then and has
  already stripped everything it does not declare. `libraries` is lifted out of
  the spread by destructuring rather than overwritten after it, so the caller's
  `string[]` reaching the panel in place of the resolved `{path, hash, bytes}[]`
  is a type error and not a convention.
- **`tests/unit/run-jsx-args.mjs` enumerates `RunJsx.shape` and fails if any
  declared field is unreachable after resolution.** Same shape of guard as the
  `OpMutation` classification test, and for the same reason: the omission is
  invisible in the diff, invisible at runtime, and shows up as a plausible
  success. It generates a sample value per field from the zod type and **throws
  rather than skipping** on a type it cannot generate — a guard that quietly
  passes over the field it does not understand is the failure it exists to catch.

Verification recipe 29 is the live half.

## Special return shapes

- **Vision** (`screenshot_frame`, `screenshot_layer`): JSX returns `{path, width, height, time, compId, layerId?}`. Panel waits for the file to be a *complete* PNG (`framereader.js`), normalises it to 8-bit, base64-encodes, returns `{base64, bytes, ...}`. Server packages as MCP `image` content block. Four outcomes are deliberately *not* images: a fully transparent frame comes back as `{empty:true, reason}` and goes through `textResult`; a frame whose pixels match a different earlier request is refused as `STALE_FRAME`; a file After Effects wrote and abandoned is refused as `FRAME_INCOMPLETE`; and a render that never finished is refused as `RENDER_TIMEOUT`. Those last two must never share a sentence — see "Known fragile areas".
- **Contact sheet** (`screenshot_frame` with `times`): 2-6 times in one call, exclusive with `time` (enforced by a zod `.refine`, so two readings of "which frame" can never reach ExtendScript). JSX renders one temp PNG per time at a shared per-tile factor and returns `{contactSheet:true, tiles:[{path,time}|{error}], downsample, ...}`; the panel reads each, composites them into one labelled image (`contactsheet.js`) and returns the same `base64` shape plus `tiles`, `cols`, `rows`, `cellWidth`/`cellHeight`. Three properties hold it together: **every requested time keeps its cell**, so a failed tile is a marked block rather than a gap that renumbers the rest; **the time is burned into the picture**, because metadata beside an image is not what a model compares; and **a bad tile never invalidates the sheet** — it is named and counted in `warning`, and only a sheet where *nothing* rendered is refused outright. Inside one sheet, two tiles with identical pixels are a static comp, not the #29 stale buffer, so they are flagged in `note` rather than refused; a match against a frame from *outside* the sheet is still a stale tile and is drawn as a block.
- **Long batch** (`run_batch` >100 ops): JSX returns `{jobId, async:true, total}`. Panel drives `_continue_job` in chunks of 25 in the background, broadcasting `progress` events on WS. Server forwards WS progress as `notifications/progress` keyed by the request's `progressToken`.
- **Server-resident** (`await_job`, `get_job`, `cancel_job`, `check_setup`, `setup_panel`, `init_project`, `ae_guide`, `log_issue`, `list_known_issues`, `mark_issue_reported`): handled in `server.ts`; never forwarded to the panel (except `cancel_job`, which also sends `_cancel_job` to the bridge to set the JSX-side flag). They're still listed in `OpSchemas` so `tools/list` picks them up — membership in `SERVER_OPS` is what stops the forwarding.
- **Half server-resident** (`snapshot_comp`, `diff_comp`): the panel gathers, the server remembers. `SNAPSHOT_OPS` in `server.ts` routes them to `runSnapshotOp`, which forwards an internal read op (`_comp_fingerprint` / `_comp_diff`) and keeps the answer in `SnapshotStore`. Deliberately *not* in `SERVER_OPS` — unlike those, these do touch the bridge, and they are dispatched from inside the same `try` as `bridge.runOp` so the timeout, `AeError` and Unknown-op mappings all apply unchanged.
- **Prose** (`ae_guide`): returns the markdown as a bare text content block rather than through `textResult()`. JSON-stringifying it would hand the model a wall of `\n`.
- **Summarised** (`get_house_style`): the panel returns the whole document; `server.ts` runs it through `applyHouseStyleDetail` before packaging, and `detail: "summary"` — the default — replaces `content` with a digest. The one post-bridge transform in the codebase that changes what a *read* answers, so it is the one to remember when a house-style result looks unfamiliar. See "The house style".
- **Downsampled screenshots**: handled entirely in `vision.jsx`. `saveFrameToPng` *does* respect `CompItem.resolutionFactor` (measured: a 3840×2160 comp yields 1920×1080 at factor 2, 960×540 at factor 4), so `__saveFrameAt` sets the factor, renders, and restores it in a `finally`. That restore is not optional — a throw mid-render would otherwise leave the user's comp at reduced resolution. The panel reads the true dimensions out of the PNG's IHDR chunk rather than computing them, so reported size can never disagree with the image sent. An earlier version shelled out to `sips`; it was replaced because rendering smaller is faster than resampling and needs no external tool, which is what makes downsampling work on Windows. The factor is *derived* from the comp when the caller omits one (`__autoDownsample`, aiming at a ~1280px long edge) — which is why `ScreenshotFrame`/`ScreenshotLayer` must not carry a zod `.default(1)`: a default there would reach the panel as an explicit 1 and the derivation would never run.

## Serializing writes

**The panel's `evalScript` mutex is necessary and not sufficient, and the gap it
leaves is exactly where the damage was.** That chain serializes every individual
`evalScript`, so two ordinary writes cannot interleave *within* one op — the
undo group `dispatch()` opens is closed before the next call gets a turn. What
it does not cover is the gap around a long `run_batch`. Over 500 ops, the
handler calls `app.beginUndoGroup(name)`, returns `{jobId, async:true}`
immediately, and the panel then drives `_continue_job` in chunks of 25 with that
group **still open**. Every chunk is its own turn on the chain, so any op issued
meanwhile slots in *between* two chunks — and AE's undo groups do not nest, so
that op's own `endUndoGroup()` closes the batch's group. The rest of the batch
writes outside any group, and the batch's final `endUndoGroup()` closes whatever
happens to be open by then. One user action, an unknown number of undo steps,
and no error anywhere. That is issue #55, and it is why the fix could not be
"the panel already handles it".

Ordering was the second half. Requests arrive at the server in the order the
agent issued them, but the old code fired every one at `fetch` in parallel and
took whatever order the sockets happened to deliver. Two writes where the second
depends on the first were a coin toss.

So: **one writer at a time, for the whole session.** `bridge/writeQueue.ts` is a
FIFO mutex; `server.ts` takes a lease before forwarding any op classified
`"write"`. Five things about it are load-bearing.

- **The classification is a table, not a list of prefixes.** `OpMutation` lives
  beside `OpSchemas` in `schemas.ts` and covers every op with `"write"`,
  `"read"` or `"server"`. There is deliberately no default: an op nobody
  classified would be classified by silence, and the silent answer — "read" — is
  the one that reintroduces the bug. `tests/unit/write-queue.mjs` fails the
  build when the two tables disagree in either direction, and `isWriteOp()`
  falls back to `"write"` at runtime so even a shipped omission costs
  serialization rather than correctness.
- **Reads never queue, screenshots least of all.** They are unaffected by an
  open undo group, and a screenshot is the slowest thing in the system — putting
  one behind the write mutex would make every write wait on a render for
  nothing. `await_job` and `cancel_job` are `"server"` for a harder reason: they
  can be issued *while* the batch holding the lock is running, and queueing
  either would deadlock against the thing they exist to wait on and release.
- **The lease outlives its own call.** `extendUntil` is the whole fix. When
  `run_batch` answers with a jobId, the lock is held until `JobManager` reports
  the job finished — releasing it when the HTTP call returned would leave
  precisely the gap described above. A leak guard at twice the wait ceiling
  covers a job that never reports (a dropped WS); it is set *above* the wait
  ceiling so that any writer queued behind the batch has hit its own deadline
  and gone before the hold could expire and hand it the lock mid-batch.
- **The op timeout starts at execution, never at enqueue.** `AbortSignal.timeout`
  is created inside `runOp`, and `acquire()` is awaited before it — so a call
  that waited ten minutes still gets its full budget when it runs. Get this
  backwards and a queued call times out having never run, reporting a bridge
  failure for a bridge that was answering fine. That is the one way this feature
  could have made things worse, and the test that pins it runs the real
  `HttpClient` against a stub on an ephemeral port.
- **A cancelled request is dropped, not deferred.** If the MCP request is
  cancelled while queued, `acquire` rejects and the caller never reaches the
  bridge. Work that runs after the thing that asked for it gave up is the leak.

A call that waited says so: `queuedBehind` and `waitedMs`, present only when it
actually waited, so an uncontended result is byte-identical to what it always
was. They fold into the result object where there is one, which is every writing
op but `run_jsx` — that returns whatever the caller's script returned, arrays
and bare numbers included, and rewrapping those would change what every existing
caller reads (#43). Those get a second text content block instead. Vision
results never carry a note at all, since screenshots are reads.

Two limits worth knowing. The queue is per-server-process, so a second MCP
client pointed at the same panel is not serialized against the first — the panel
is a shared resource with no lock of its own. And the queue is bounded
(`AE_MCP_WRITE_QUEUE_DEPTH`, default 64; `AE_MCP_WRITE_QUEUE_WAIT_MS`, default
600s) rather than unbounded, because an agent looping writes at a stuck bridge
would otherwise grow it without limit.

## Conventions

- **ExtendScript is ES3-ish.** No `let`/`const`/arrow functions/template literals/`Object.keys`/destructuring in `packages/jsx/*.jsx`. AE 2026 has native JSON but `core.jsx` polyfills defensively.
- **Stable IDs.** `getCompById(id)` uses `app.project.itemByID`; `getLayerById(comp, layerId)` walks `comp.layers` matching `layer.id`. Never use `.index` as a long-lived identifier — it shifts when layers are reordered.
- **One undo step per request.** `dispatch()` wraps the handler in `app.beginUndoGroup`/`endUndoGroup`. Long batches manage their own undo manually (`run_batch.__meta.noUndo = true`).
- **MCP server stdout is sacred.** All logs go to stderr via `util/logger.ts`. Touching `console.log` anywhere in mcp-server will corrupt the JSON-RPC stream.
- **Tool descriptions are written for LLMs.** Tell the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid. Screenshot descriptions especially must say "one-off, do NOT screenshot every frame."
- **Never report success for work that didn't happen.** An agent can only correct a failure it's told about, so a swallowed error is worse than a thrown one. `add_shape_content` is the reference case: it resolves every key first, and if any is unresolvable it removes the node it created and throws with the offending keys named, rather than leaving a half-built shape behind an `{ok:true}`. Schemas that accept free-form objects must be `.strict()` for the same reason — zod's default is to strip unknown keys silently.

## Guidance and how it reaches an agent

Tool descriptions cover one tool each. The knowledge that actually costs people
time is cross-cutting — ids not indexes, read then write then verify, which of
three bridge failures is safe to re-send — and belongs to no single tool. The carriers for it, in
descending order of reach:

| Carrier | Reaches | Cost |
|---|---|---|
| Tool descriptions | every client, always | always resident |
| `instructions` (initialize result) | every client that honours it | always resident — keep it short |
| `ae_guide` tool | every client | on demand |
| MCP resources (`ae://guide/…`) | clients with resource support | on demand |
| Claude Code skills | Claude Code, claude.ai | on demand, whole skill at once |
| Claude Code skill references | Claude Code, claude.ai | on demand, one file at a time |

All of them except the tool descriptions come from
`packages/mcp-server/src/guides/*.md` via `scripts/build-guides.mjs`. **Edit the
markdown, never the outputs.** The same script generates
`packages/mcp-server/src/prompts/*.md` into MCP prompts and Claude Code commands.

Three rules that keep this honest:

- **`instructions` is always resident in every session, so it stays short.** It
  says three things: that the session is live, where the real guidance is, and
  the two or three habits that decide whether the *first* calls do damage before
  an agent has read any of it. Everything else is a tax on every request the user
  ever makes — put it in a guide. It was six numbered items and 1,395 characters
  until 0.4.0, restating what `after-effects.md` already said in full; issue #60
  is what that cost. `tests/unit/guide-references.mjs` and the CI smoke test both
  fail it past 1,500 characters, which is a ceiling and not a target.
- **`ae_guide` exists because the better carriers are not universal.** Some
  clients drop `instructions`; fewer support resources. Tools are the floor
  every client reaches, so the guidance has to be available as one.
- **Only the skill has a per-session cost, so only the skill splits.** A guide
  with `reference: <parent>` in its frontmatter is still a full `ae_guide` topic
  and a full `ae://guide/…` resource — narrowing that half would be a reach
  regression for every non-Claude client — but on the skill side it generates
  into `plugin/skills/<parent>/references/<name>.md` instead of a skill of its
  own, so Claude Code opens it only when the parent points at it. That pointer is
  load-bearing: the generator refuses to build a reference whose parent does not
  name `references/<name>.md`, because a reference nothing points at is a file
  that is never read and never noticed. Two ship today, both under
  `after-effects`: `extendscript-gotchas` (issue #48 — ten KB of `run_jsx` traps
  and the helpers that already solve them, which only matter to an agent about to
  script) and `whats-new` (issue #60 — the version deltas users were otherwise
  keeping in their own project notes).

Where a fact goes, in one line: an agent cannot infer it from the tool list *and*
getting it wrong on the first call costs real work → `instructions`; it is part
of doing the job well → the relevant guide; it only matters once you have already
decided to do something specific → a reference under that guide.

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

**Both hashes must identify the code, not the build.** `bundle-jsx.mjs` used to
stamp `// Generated <ISO timestamp>` into the header, which put a moving value
inside the thing being compared: two builds of an unchanged tree disagreed, and
an upgrade touching no ExtendScript still told the user to quit AE and relaunch.
Nothing in `packages/jsx/` may reach the bundle unless a source changed, so keep
the concatenation a pure function of the sources — no timestamps, no ids, and no
unsorted directory reads. `tests/unit/bundle-determinism.mjs` builds twice and
compares the bytes, and also checks the hash still moves when a source does.

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

### The summary, and why it is not on the panel

`get_house_style` answers with a digest by default (`detail: "summary"`), and
returns the document only when asked (`detail: "full"`). The reason is what
people did without it: an established guide got heavy enough that projects put a
rule in their own build notes telling sessions *not* to call the tool and to read
a hand-maintained 40-line digest instead — so the digest and the source drifted,
and "one cheap call" was neither (issue #59).

**The reading is still over the bridge; only the summarising moved.** Every
argument in the section above is about *where the file is opened*, and that has
not changed — the panel opens it beside the .aep and hands back the whole text.
Summarising is a separate question, and `style/summary.ts` answers it on the
server for two reasons:

- **The panel does not update itself.** A summariser in the .jsx bundle would be
  dark until the user reinstalled the panel and relaunched AE, and until then an
  old panel would return the whole document to a caller that believes it asked
  for a digest. That is worse than not shipping the feature. Server-side, it is
  live the moment the server updates, against whatever panel is already running.
- **ExtendScript is ES3-ish.** This is regex-heavy parsing of a markdown file
  nobody controls; doing it there would be miserable, and untestable without AE.
  `tests/unit/house-style-summary.mjs` runs against synthetic documents with no
  AE and no panel.

Three rules keep the digest honest, and all three are about the same failure —
a summary that looks complete and is not:

- **Recognising nothing must not return nothing.** A guide written as prose with
  no headings and no hexes comes back `structured: false` with the *document's
  own opening* verbatim and a note saying it could not be interpreted. An empty
  summary would read as "this project has no rules", and the agent would go on
  to build something plausible in the wrong colours.
- **Everything dropped is named.** Unrecognised headings come back in
  `sectionsOmitted`, and the capped buckets are counted in the note. The one
  section the walk deliberately folds in is `Rules`, because it is in the
  template this project's own style-guide guide hands out.
- **UTF-8 has one more place to break.** Recipe 10 exists because the encoding
  fails *silently*; putting a processing step between the file and the caller
  adds a place for it to fail. Curly quotes, guillemets, en dashes in a size
  range and accented font names are asserted through the summariser, not just
  through the round trip.

`set_house_style` is unchanged: still the whole file, still `overwrite: true`.
So `detail: "full"` is not optional before an edit — read the document, merge,
send it back.

## Comp snapshots, and why they live in the server

Verifying a write used to mean reading the comp back — `list_layers`, then
`get_layer_full` — and comparing by eye. That answer is thousands of tokens,
and a tool result is re-sent on every later request for the rest of the session,
so a fourteen-scene build paid for it over and over (issue #52). A fingerprint
plus a diff is a few dozen tokens for the same three questions: which layer is
the new one after a `copyToComp` (copies do not land at index 1), where a
partly-applied `run_jsx` stopped, and whether an assembly landed when
`screenshot_frame` cannot render it.

**The snapshot is kept in the MCP server, not in the After Effects project.**
That split is the whole design. Only the panel can read AE, so the gathering
has to happen there; but writing the fingerprint into the .aep would make a
*read* tool modify the user's project — a project-panel item or a marker they
never asked for, in their file and in their undo stack, for scaffolding nobody
wants to keep. `SnapshotStore` is the other half: the one place in this server
that remembers anything besides `JobManager`.

The cost is a lifetime of one process, which for a stdio client is one session.
That is acceptable — nothing needs yesterday's snapshot — but it must never be
met as a cryptic failure, so `missingMessage()` says why the id is gone, lists
the ids that *are* held, and names both ways forward (take a fresh one; or read
the comp back, since a diff can only compare against a snapshot taken
beforehand). That method is why the store is a class rather than a `Map`.

Three further things hold this honest:

- **`diff:true` on `run_jsx` / `run_batch` fingerprints inside the same call.**
  A before-snapshot taken by a separate `snapshot_comp` is a second round-trip
  during which anything can happen, and the agent has to remember to make it. So
  the before, the write and the after are one bridge call, and the diff logic
  lives in `snapshot.jsx` where `raw.jsx` and `batch.jsx` can both reach it —
  each of them gains about six lines and no new contract.
- **A failed write still gets its diff.** Nothing rolls back, so "where did it
  stop" is the most valuable question after a throw. `__diffAnnotateError`
  *mutates* the error's `message` and rethrows the same object, so `line` and
  `stack` survive for `__mkError` — never build a new Error there.
- **A diff is the extreme case of a scoped read, so it says what it left out.**
  `covers` travels with every diff and `snapshot_comp` returns the long form:
  the fingerprint records ids, names, indices, types, in/out/start, parent,
  enabled, per-property keyframe counts, expression count and effect count, and
  no property *values*, expression text, effect parameters, masks or shape
  contents. Reading "no differences" as "identical" is the failure mode, and it
  is the same class of lie as a swallowed error. The walk stops there on purpose
  — a fingerprint that costs as much as the read it replaces is worth nothing —
  and `tests/unit/comp-snapshot.mjs` puts probes on the effect and shape
  accessors so a later edit cannot quietly start walking them.

`index` is recorded but never diffed directly: inserting one layer shifts every
index below it, which would report twenty changed layers for one addition.
Relative order is compared separately, so a real reorder is reported and an
insertion is not.

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

## Verification recipes (run by hand against a live AE 2026)

1. `list_comps` → JSON array, empty `[]` on fresh project.
2. `create_comp({name:"t", width:1920, height:1080, frameRate:30, duration:5})` → returns id.
3. `create_text_layer({compId, text:"hi"})`, then `add_keyframe` at t=0 left and t=2 right, then `screenshot_frame` at t=0/1/2 to confirm motion visually.
4. `add_effect({compId, layerId, matchName:"ADBE Gaussian Blur 2"})`, `set_effect_param({...paramName:"Blurriness", value:25})`.
5. `set_expression({propertyPath:["Effects","Gaussian Blur","Blurriness"], expression:"time*10"})`, then `get_layer_full` echoes the expression.
6. `run_batch` with 50 `create_solid_layer` ops, `transactional:true` → single undo step.
7. `run_batch` with 600 ops → returns `{jobId}` (inline cutoff is 500). With `progressToken` set, `notifications/progress` fire ~20/sec. Without it, `await_job(jobId)` resolves with the final result.
8. `run_jsx("return app.project.activeItem.name")` → comp name. Without the `return` → `{ok:true, returned:null, undoGroup:"AE MCP: run_jsx", note}`, never a bare `null`; same for an explicit `return null`, and `undoGroup:false` in the args flips the `undoGroup` field to `false`. `return 0` / `return false` still come back as `0` / `false` — the envelope is for nothing, not for falsy. With a deliberate error → structured `AeError` with line number.
9. `log_issue` twice with the same title → one file, `occurrences: 2`, `previouslyLogged: true`. `mark_issue_reported` then `log_issue` again → still `reported: true` (a new sighting must not un-report an entry). The same title once more with `scope:"user"` → a *second* file under `~/.ae-mcp/issues`, `occurrences: 1`, `previouslyLogged: false`, and `alsoIn: ["project"]`. `list_known_issues` → both listed, each tagged, `journals` naming two directories, and `next` quoting a `scope:id`. `list_known_issues({id: "user:<id>"})` → the new one, `reported: false`, while the project one stays reported. From Claude Desktop (cwd `/`) the same calls → the project entry reports `scope: "home"` and the user entry still reports `scope: "user"`; they are different folders and neither is `~/.ae-mcp` for both.
10. `get_house_style` on an **unsaved** project → `{found:false, projectSaved:false}` with a readable reason, not a throw. Save the project, `set_house_style({content})` → file appears next to the .aep. Call it again without `overwrite` → refuses and names the path. With `overwrite:true` → replaces. Non-ASCII (curly quotes, accented font names) survives the round trip — that is the UTF-8 encoding, and it fails silently if dropped. Then the summary: `get_house_style` with no args → **no `content`**, a `summary` with the palette as named hexes, `characters`/`lines` sizing the source, and a `note` naming `detail:"full"`; the same call with `detail:"full"` → the document, byte-identical to what `set_house_style` wrote, non-ASCII included. Replace the guide with a page of prose containing no headings and no hexes → `structured:false`, `head` holding the document's own opening, and a note saying it could not be interpreted — never an empty summary.
11. `init_project` with no `dir` from a client that advertises `roots` → writes into the client's folder, `resolvedFrom: "client-root"`. From Claude Desktop (cwd `/`) → refuses with a message telling the agent to ask.
12. Version gate, with AE running an older panel: any forwarded op → the remediation message, not `Unknown op`. `setup_panel` then the same op → "still running the previous version", naming the restart as the only fix. Restart AE → works. (`tests/unit/panel-version.mjs` covers the decision table; this recipe covers the wiring.)
13. Partial install: with AE **open**, overwrite a client file in the installed panel (`echo x >> …/client/main.js`). `check_setup` → `panelUpToDate` FAIL naming `client/main.js`, and the next steps lead with "quit After Effects" — never "restart and try again". Restore it → green.
14. Missing dependency: `rm -rf …/games.engine-room.ae-mcp/node_modules/ws`, restart AE. The panel shows "cannot start — the ws module is missing" with the fix in its log, rather than "starting…". `check_setup` → `panelDependencies` FAIL naming the path, not just `bridgeReachable` FAIL.
15. Scoped reads, on a comp with a keyframed shape layer: `list_layers({compId})` and `list_layers({compId, include: []})` → the second is id/index/name/sourceType only, same layers, same ids. `get_layer_full` with no `include` → byte-identical to before the scoping params existed, save for the shape-layer material groups that recipe 20 covers. With `include: ["transform","bounds"]` → those two sections plus the header, and an `included` echo. With `maxKeyframes: 4` on a property with more → four keyframes, `keyframesOmitted` and a `keyframesTruncated` note naming the count. With `shapeDepth: 1` → `childrenOmitted` on the groups the walk stopped at. `screenshot_frame({compId})` on a 3840×2160 comp → 1280×720 back with `downsample: 3`; the same call with `downsample: 1` → full resolution; the comp's own resolution is unchanged in the viewer afterwards.
16. Compiled binary, the one no unit test reaches: run the built binary from an empty directory *and* from `/`, and confirm `setup_panel` installs a populated `node_modules/ws`. Under `bun --compile` the module resolver returns a bare specifier rather than throwing, so this path cannot be exercised under plain Node — see the `require.resolve` note in Known fragile areas.
17. `import_footage` on an SVG with `viewBox="0 0 278050 333334"` and no width/height → refuses, names both aspect ratios, and the item is **gone** from `get_project_summary`. The same file with `force:true` → the item stays and `validation.ok` is false. A `0 0 512 512` SVG imports clean, and `create_footage_layer` + `screenshot_frame` shows it rendering. (The broken one, forced into a comp, produces no PNG at all — that is the bug, not a tooling failure.)
18. `export_mogrt` on a comp with a text layer in a non-Adobe font → returns in a few seconds with no dialog in AE, and `fonts` names the font. With `suppressDialogs:false` → a modal dialog appears and the call blocks until it is clicked; that is the control, and it is worth running once because the whole tool rests on it. Called twice with the same `name` → refuses the second, then replaces with `overwrite:true`. On a project that has never been saved → refuses with a message naming the save, not a dialog.
19. `.mogrt` thumbnail: give the comp an empty first frame (keyframe every layer's opacity 0 → 100 over the first second), export with no `posterTime` → `thumb.png` inside the zip is solid black. Export again with `posterTime` past the fade → `thumbnail.patched: true` and the frame is in there at AE's own thumbnail dimensions. Unzip and check the *other* entries are byte-identical; a corrupt `project.aegraphic` would not show up in the picture.
20. Shape reads, on a shape layer with several groups: `get_layer_full({compId, layerId, include:["shape"]})` → no `ADBE Vector Materials Group` anywhere, `materialsOmitted` counting the groups it was dropped from, and every group whose Transform nobody has touched carrying `atDefaults: true` instead of its seven properties. With `shapeMaterials:true` → the 48 properties are back and `materialsOmitted` is gone. A group that is scaled, keyframed or expression-driven must *never* say `atDefaults`. With `shapeDetail:"compact"` → one indented line per group, `[n keys]`/`[expr]` on the animated properties, and a path as `path(7 verts, closed)`. Measured on the layer in issue #42: 13,369 → 3,052 → 643 characters of shape JSON.

21. `run_jsx` error lines, which is the whole of issue #46 and cannot be seen offline. Submit a script whose *fourth* line throws (`comp.property("Nope").setValue(1)`), with three lines of real work above it → the error names line 4 and prints that line's text, and `list_layers` confirms the three lines above it landed. Run it again with the same throw moved to a different line → the reported line moves with it. Then submit a one-line script that throws → the line is 1, never 22. If a case ever comes back with "does not fall inside", that is the honest outcome, not a regression: read what `rawLine` said and work out what AE was counting from.
22. `scriptPath` and `libraries`: write `/tmp/rig.jsx` containing `function rig(c){ return c.name; }` and `/tmp/scene.jsx` containing `return rig(app.project.activeItem);`. `run_jsx({scriptPath:"/tmp/scene.jsx", libraries:["/tmp/rig.jsx"]})` → the comp name, with neither file's text in the conversation. Call it again → same answer (the library is cached, not re-evaluated). Edit `rig.jsx` to return `c.name + "!"` and call again → the new answer, which is the content hash working. `run_jsx({scriptPath:"scene.jsx"})` → refused for being relative; a missing path → refused naming it; `code` and `scriptPath` together → refused. Break `rig.jsx` with a syntax error → the failure names the library file, not a line of the script.
23. Helpers, against a real comp: `run_jsx({code:"var l = shape(app.project.activeItem, {name:'Card'}); return l.property('Transform').property('Position').value;"})` → `[0,0]`, not the comp centre. Then `addKeys` two keys on Opacity and `ease(prop, 2, 60)` → returns 1; the same on a shape's Ellipse **Size** → returns 3, having tried 2 first (issue #50's case, and the retry is the point). `get_layer_full` shows the ease on the keys.
24. Write serialization, which needs a live AE because the failure it prevents is in AE's undo stack and nowhere else. Issue two writes in one turn — `create_solid_layer` and `create_text_layer` on the same comp — and check the second result carries `queuedBehind: "create_solid_layer"` and a `waitedMs`, while the first carries neither. Then the real one: `run_batch` with 600 ops (past the 500 inline cutoff) and, in the *same* turn, a `set_transform`. The batch returns its `{jobId}` immediately; the `set_transform` must not return until the job does, and AE's Edit menu afterwards must show the batch as **one** undo step with the transform as a separate one after it. Before this landed the transform went in mid-batch and the batch broke into an arbitrary number of steps. Reads are the control: `list_layers` issued alongside the running batch returns straight away, and `await_job` on the batch resolves rather than hanging (it would hang if it queued).
25. Ease sizing, the three properties that used to fail in a row: `add_keyframe` twice on **Opacity**, then `set_temporal_ease` on it → `easeDimensions: 1`. Same on a 2D layer's **Scale** → `2`. Same on a shape group's **Ellipse Size** → `3` (this is the one whose value reads `[w,h]`, so `2` would be the sensible wrong answer). Same on **Position**, 2D and then with the layer set 3D → `1` both times. `get_keyframes` echoes the influence and speed on each, and the easing is visibly non-linear in the graph editor. `set_temporal_ease` with neither `easeIn` nor `easeOut` → refuses rather than returning `ok`.
26. Shape spawn point: `create_shape_layer({compId})` on a 3840×2160 comp → `position: [0,0]`, `anchorPoint: [0,0]` in the result. `add_shape_content` a rect of `size:[400,200]` with `position:[400,200]`, then `screenshot_frame` → the rect is near the top-left, centred on (400,200) in comp pixels, not half a frame away. The same sequence with `create_shape_layer({compId, position:"center"})` → `position: [1920,1080]` and the rect renders at comp centre + (400,200), which is AE's old behaviour. `position:"middle"` → refused, no layer created.
27. `place_audio_cues`, on a comp with a few seconds of room: nine cues naming the same .wav at different times → nine layers, **one** new project item, one undo step (Cmd-Z removes all nine). Levels: pass `levelDb:-6` on one and read the Audio Levels property back — `-6, -6`, and the layer is audibly quieter on a RAM preview. Call it again on a project that already holds that .wav → `sources.reused` names it and nothing new is imported. `dryRun:true` on a list with one typo'd path → `ok:false`, the bad cue named by index, no layers, no imports, and **no new step in AE's undo history**. Point one cue at a still image already in the project → refused before anything is placed, naming "has no audio track". Then the rollback, which is the one worth doing deliberately: take a 90-cue list, make cue 60 impossible (an `outPoint` far past the end of a short file, say), run it → the call fails naming cue 60 and the timeline has **zero** new audio layers, not 59.
28. `snapshot_comp({compId})` on a comp with a few layers → a `snapshotId` and a handful of fields, **no fingerprint** (add `includeFingerprint:true` to see it). Add a layer and keyframe its Opacity, then `diff_comp({since})` → the new layer's id and name, `layer N Opacity keys 0 → 4`, `unchangedLayers` counting the rest, and nothing at all about them. `diff_comp` again immediately → `changeCount: 0` and a summary that says the recorded fields did not move rather than "identical". Reorder two layers → `reordered` names those two; add a layer at the top instead → **no** `reordered` and no `changed`, even though every index below it shifted. `diff_comp({since:"snap_999"})` → the store's message, naming the ids it does hold. Restart the MCP server and reuse an old id → the same message, not a crash.
29. `diff:true` on the write ops: `run_jsx({code:"…create three layers…", diff:true})` → `{ok, returned, diff}` with the three ids, in one call. The same script with a deliberate throw half-way → the error message carries `|| Changed before it stopped: 1 layer added…` **and** still reports its line number. `run_batch({ops:[…], diff:true})` across two comps → a `comps` array with one diff each. With no `compId` anywhere in the call and no comp open in the viewer → `diff.unavailable` naming `diffCompId`, and the call itself unaffected.
30. `duplicate_comp({compId})` on a comp with a precomp layer → new id, name `<name> 2`, and the copy's precomp layer resolves to the **same** nested comp as the original (that is the shallow contract; the result says so). The same call with `deep:true` → the copy points at its own nested comp, editing that one leaves the original alone, and a nested comp used by three layers is duplicated **once** with all three re-pointed at it. `folderId` pointing at a comp instead of a folder → refused, naming the id and what it actually is, with nothing created. `nameSuffix:" [v2]"` where `<name> [v2]` already exists → the copy gets `… [v2] 2`, and the existing item keeps its name.
31. Frame integrity, on the comp that produced issue #45 — a heavy assembly, ~88 layers: a nested full-frame background precomp plus several shot precomps, at 4K. Build one if there isn't one: a 3840×2160 comp, a 1080p precomp scaled to fill with a blur and a glow on it, then six shot precomps each holding a dozen keyframed shape and text layers, all nested in. `screenshot_frame({compId})` → an image, or a message that says which of the two failures it was — never `truncated PNG` reaching the client, and never a picture that is a picture of something else. Repeat it four or five times at downsample 4, 6 and 8; if any call fails it must fail as **Corrupt frame** or **Render timed out**, with different advice under each, and a second failure at a different time must still say the same thing rather than turning into `Stale frame`. Watch the panel log: a corrupt read logs "re-rendering once", exactly once per call.
32. Contact sheet: on a comp with something moving across the frame, `screenshot_frame({compId, times:[0, 1, 2]})` → **one** image, three cells left to right, `0s`/`1s`/`2s` burned into the top-left of each, `cols:3 rows:1`, and `tiles` naming each time and status. The sheet should be about the size a single `screenshot_frame` of that comp returns — compare `bytes` against one. `times` plus `time` in the same call → refused by the schema before it reaches AE. `times:[0,1,2], downsample:1` → full-resolution tiles, so an explicit factor still wins. On a comp with a **static** first second, `times:[0, 0.3, 0.6]` → three tiles, all `ok`, with `pixel-identical to the 0s tile` in the notes and no `Stale frame` error. On the heavy comp from recipe 31, expect a `FAILED` block sooner or later: the other tiles must still be there and `warning` must name the one that is not.

## The issue journal

`log_issue` is how one session hands a hard-won workaround to the next. Six properties matter, and all six are things it would be easy to get wrong:

- **The folder ignores itself.** `ensureJournalDir` writes `.ae-mcp/.gitignore` containing `*` on first use, in *both* journals. That is what keeps them untracked — not a rule in the project's `.gitignore`, which most of these folders do not have, and which the ones that do would have to remember to add. The user journal gets one for the same money: `~/.ae-mcp` is usually outside any repository, but a home directory that *is* one (dotfiles) is exactly where committing a private journal of half-diagnosed failures would be an unpleasant surprise.

- **There are two journals, and the folder is the only thing that decides which is which.** `<project>/.ae-mcp/` holds what is true about *this* project — its footage, its comps, its files. `~/.ae-mcp/` holds what is true about the tools and about After Effects, and is read alongside the project one so a new project folder does not start ignorant of everything the last one worked out (issue #57). `log_issue` defaults to `project` and takes `scope: "user"`; `list_known_issues` merges both and tags every entry. The scope is **not** written into the file's frontmatter: these files are meant to be hand-edited and moved, and a `scope:` key could be edited into disagreeing with where the entry actually lives.

- **The home fallback is not the user journal, and keeping them apart is the whole design.** `home` — `~/.after-effects-mcp/`, used when there is no usable working directory — is the *project* journal with nowhere to sit. Merging it into `~/.ae-mcp/` would be one line and would mean every Claude Desktop session's notes about one project's footage arriving in every other project dressed as curated cross-project knowledge. They stay separate directories, `scope: "home"` keeps saying what it always said, and `scope: "project"` on a read covers the fallback because that is what the fallback is. `AE_MCP_HOME` has to sandbox *both* or a test writes into whoever ran it, so it puts the user journal in a child of the override.

- **The title is the identity, and it is only unique within a journal.** It is slugified into the filename, so re-logging under the same title extends the entry rather than adding a near-duplicate. Agents are told to `list_known_issues` first for exactly this reason. Two journals can now hold the same slug, and both are listed — hiding one would lose whichever the reader needed. A bare id still resolves, project first, and names the other in `next`; `"user:<id>"` addresses one exactly, and falls back to the whole string as a bare id so a title that happens to begin "user:" stays reachable.
- **Reporting state belongs to the entry, not the sighting — and to the entry *in its own journal*.** Re-logging a known problem preserves `reported`, `issueUrl` and `firstSeen`, and a `cause` worked out once survives a later sighting logged without one. Otherwise the user gets asked to report the same thing repeatedly, which is the fastest way to make them stop reading the offer. The same lesson written down in both journals is two records of two claims: sending one to the maintainers says nothing about the other, so `mark_issue_reported` moves exactly the one its id names.
- **The files are meant to be hand-edited.** `parse()` is deliberately forgiving: missing keys, reflowed text and deleted headings degrade one entry instead of failing the whole journal. A file with no recognised headings keeps its text as the symptom rather than being read as empty.
- **The listing is an index, not the corpus.** `listIssues` returns one line per entry by default — id, scope, title, tools, counts and a clipped summary — and the body is fetched with `id`. That is worth roughly 5× on a journal of a dozen entries, and a tool result is re-sent on every request for the rest of the session. The failure mode to guard against is an index that leads nowhere: an agent reads this journal *because something already failed*, so the summary has to be enough to pick an entry and the `next` pointer has to name the call that opens it — which is why the pointer spells the qualified `scope:id` form out on a real entry rather than leaving the caller to infer the syntax. Merging two journals doubles the listing, so `limit` caps it at 50 and anything held back is counted in `omitted` and repeated in `next`. `tests/unit/issue-journal.mjs` asserts all of it.

The user-facing half is the offer to report. It now lives in exactly two places: the `log_issue` **tool description** carries the minimum (finish the work first, phrase it for a non-programmer, don't say "GitHub issue"), and `src/prompts/report-ae-issue.md` carries the full flow. That second one is generated into both the MCP prompt (every client) and the Claude Code command, so there is nothing to keep in sync by hand. If you change the behaviour, change those two.

## Known fragile areas

- `saveFrameToPng` is community-known, not officially documented. Alpha edge cases reported on some comps. If it fails, fallback would be the render queue with PNG Sequence template (slow; deferred to v1.1).
- ExtendScript single-threading: `run_jsx` with a long synchronous loop will freeze AE's UI. Document for the agent in the tool description (already done).
- **A busy AE is indistinguishable from a dead bridge at the HTTP layer.** ExtendScript is single-threaded, so while a script runs — or a modal dialog sits unclicked — the panel cannot service its socket at all. The connection is accepted and then nothing comes back. That is why `httpClient` separates `BridgeTimeoutError` from `BridgeUnreachableError` and why `check_setup`'s `bridgeReachable` reports a timeout differently from a refusal: the two have opposite remedies, and "restart After Effects" said to someone whose script is still running throws away work for nothing. Enumerating `app.effects` (~250 entries, tens of seconds in 26.3) is the reproducible case — issue #26 — which is also why `list_available_effects` caches for the session. Never collapse the two errors back into one sentence.
- **There are now three of those, not two, and the third one's advice is the opposite of the second's.** `WriteQueueWaitError` means the call sat behind another write for the full `AE_MCP_WRITE_QUEUE_WAIT_MS` and was dropped **without ever leaving the server**. `BridgeTimeoutError` forbids re-sending, because that call did reach After Effects and may still be running; the queue error has to say the opposite, because nothing was written and re-sending once the queue drains is the correct move. `BridgeUnreachableError` sends the reader to `check_setup`, which the queue error must not, since the bridge is answering perfectly well. Three diagnoses, three remedies, no shared sentences — `tests/unit/write-queue.mjs` asserts they stay distinct, including that neither bridge error ever mentions the queue.
- **The server's op timeout must sit above the panel's own waits, not on them.** `saveFrameToPng` is asynchronous and the panel polls for the PNG for up to 120s; with the server also at 120s it gave up at the exact moment the panel might still have succeeded. `SLOW_OPS` in `bridge/httpClient.ts` gives the screenshot, `run_jsx` and `run_batch` ops 300s. `AE_MCP_OP_TIMEOUT_MS` overrides every op, deliberately including the slow ones — one number a user can reason about beats a matrix they cannot see.
- CEP manifest's `<AutoVisible>false</AutoVisible>` was unreliable in early CEP 12 builds. Current manifest uses `AutoVisible=true` with a small geometry — the panel still auto-loads invisibly enough; the user can dock the small status panel out of the way.
- CEP panels installed without signing require `PlayerDebugMode=1`. The user does this once via `npm run enable:debug` and a reboot.
- **Anthropic API requires JSON Schema draft 2020-12** for tool input schemas. `zod-to-json-schema` 3.x has no 2020-12 target — `openApi3` emits `nullable` (rejected) and `jsonSchema7` emits draft-07 tuple form `items:[...]` (rejected; 2020-12 wants `prefixItems`). `server.ts` uses `jsonSchema7` + `$refStrategy:"none"` + a `toDraft2020()` post-pass that rewrites tuples. Don't switch back to `openApi3`.
- **`setTemporalEaseAtKey`'s array length belongs to the property, and cannot be read off the value.** Spatial properties (Position, Anchor Point) take a single entry regardless of 2D/3D, because the ease runs along the motion path. Non-spatial multi-dimensional properties take one per dimension — Scale 2 or 3, Color 4. And then a shape **Ellipse Size** takes 3 while its value reads `[w, h]`, which is the case that proves no table derived from the outside is going to be right everywhere (issue #50). AE's own diagnosis for a wrong count is the string `parameter 2` — no property name, no expected length — so an agent easing three properties in a row hits it three times and ends up writing a try/catch ladder by hand. `__applyTemporalEase` in `keyframes.jsx` is the one implementation: it derives a count from `isSpatial` first and `propertyValueType` second (falling back to the value's length), tries that, and then tries 1 → 2 → 3 → 4. **The derivation is the fast path and the retry is the safety net, not the other way round** — an ordinary property must cost one call, or a long batch pays a ladder per keyframe. Callers pass one `{influence, speed}` pair and it is expanded to every entry; the count AE accepted comes back as `easeDimensions`, which is the only way the real answer for a property ever becomes knowable. Everything that sets ease (`add_keyframe`, `set_temporal_ease`, and anything in run_jsx that wants it) must go through that function rather than sizing an array itself. `tests/unit/ease-arity.mjs` covers the table, the ordering and the retry.
- **`saveFrameToPng` is asynchronous, and "the file stopped growing" is not the same statement as "the file is finished".** It returns before the bytes are on disk, so anything reading the PNG has to decide for itself when the write is done. Until 0.4.0 that decision was *settling*: two `stat` calls 30ms apart reporting the same size. What that let through is every writer pause longer than 30ms — which on a heavy comp (the report was ~88 layers, a full-frame background precomp plus several shot precomps) is routine. The panel read the file mid-flight, shipped it, and the agent got `truncated PNG: chunk IDAT runs past the end of the file` for a render that was still happening. Completion is now *structural*: the file is finished when it ends in a zero-length IEND chunk and every chunk length from the signature adds up to exactly that (`pngCodec.inspectPngStructure`), so a partial write cannot be delivered at all — only waited on. `framereader.js` polls for that, with a cheap tail probe in front of the full read because IEND is the last chunk in the format and a file that does not end in one does not need reading. Three numbers: 120s of render budget (a cold 4K render was measured over 15 seconds; the original 5s silently failed screenshots that were merely still rendering), a 6s stall window after which a file that has stopped changing and still is not a PNG is declared abandoned, and one automatic re-render. The retry is safe because both screenshot ops are read-only and leave nothing in the project — unlike `run_jsx`, where re-running duplicates side effects (#43) — and it fires **only** on a corrupt read, never on a timeout: a timeout has already spent the 120s budget and a second one would push the op past the server's 300s ceiling, turning a precise diagnosis into a bridge timeout with the opposite remedy. `growable` in `inspectPngStructure` is what keeps the fast cases fast: a wrong signature or a missing IHDR can never be fixed by more bytes, so it fails immediately instead of waiting out the stall. Reported as issue #45.
- **A failed frame read must never be cached, and the two failures must never share a message.** The other half of #45 was the diagnosis, not the read: the old passthrough path hashed the *truncated* bytes into `framecache.js`, so the next truncation at the same byte count came back as `Stale frame` — the reported symptom was "the same 73,877 bytes for different times and downsamples". Only a frame that decoded and was delivered reaches `frameCache.remember` now. And `FRAME_INCOMPLETE` ("the file After Effects wrote is not a whole PNG"; retry at a higher downsample) and `RENDER_TIMEOUT` ("it did not finish in time"; wait, do not retry immediately) get completely separate messages, for the same reason `BridgeTimeoutError` and `BridgeUnreachableError` do: the remedies point in opposite directions. Neither message may ever suggest restarting After Effects or re-running `setup_panel`, and `tests/unit/frame-integrity.mjs` asserts that.
- **`saveFrameToPng` re-serves stale buffers and reports success.** Past some per-frame render cost, AE hands back a frame it rendered earlier: byte-identical results for unrelated comps at unrelated times, and at *different* `downsample` factors, which cannot even be the same number of pixels. Nothing in the response distinguishes it — fresh temp file, `ok:true`, well-formed PNG — so content identity is the only signal available. `client/framecache.js` keeps the last 24 delivered frames keyed by `(op, compId, layerId, time, downsample)` and refuses any frame whose pixels match a *different* key. It is an error rather than a warning on the image because an agent that can see the picture believes the picture. It lives in the panel, not the server, because the panel sees every render — the documented workaround for this bug POSTs `/op` directly. Two consequences to keep in mind: the *first* stale buffer of a session always gets through, since there is nothing yet to compare it against; and a genuinely static comp screenshotted at two times does trip it, which is why the message says so and points at a different `downsample` to distinguish the two. Reported as issue #29. The contact-sheet path is the one place that second consequence is *resolved* rather than merely explained: inside one sheet the caller asked for several times deliberately, so a tile matching a sibling is flagged in its `note` and the picture is still sent. The relaxation is scoped to a sheet's own tiles and nothing else — a single-frame call, and a sheet tile matching anything from outside the sheet, are both still refused, and `tests/unit/screenshot-pipeline.mjs` asserts the detector still fires.
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
- **A new shape layer's origin is now `[0,0]`, not AE's comp centre — and that is a deliberate behaviour change.** `addShape()` leaves Position at the comp centre with the Anchor Point at `[0,0]`, so layer space is offset from comp space by half a frame. Every path this toolset can write — `set_shape_path` vertices, `add_shape_content` vertices, a rect or ellipse `position` — is in *layer* space, while every other coordinate an agent handles (comp size, `sourceRect`, other layers' positions, a screenshot) is comp space, and nothing in the old response said which one it had been given. So a drawing authored in comp pixels came out shifted by `(width/2, height/2)`, and the check that would catch it is a downsampled screenshot: issue #51 cost a review round. `create_shape_layer` therefore takes `position`, defaulting to `[0,0]`, which makes the two spaces the same space; `"center"` is AE's own spawn point kept to one word, and the result echoes the position and anchor point it ended up with so nobody has to render a frame to learn the coordinate system. **What this breaks:** a caller that relied on the old spawn point to centre a motif — `create_shape_layer` then `add_shape_content({type:"rect", size:[200,100]})` with no explicit position — now gets that rect at the top-left corner instead of the middle. The fix is one argument (`position:"center"`), the failure is visible in the first frame rendered rather than three edits later, and the precedent is the `anchorAlign` change in 0.2.1: this repo changes a creation-time default when the old one was wrong in a way that only shows up downstream. `tests/unit/shape-spawn.mjs` holds the default, the escape hatch and the echo.
- **Generated files under `plugin/` will be overwritten.** `plugin/skills/**` — SKILL.md and `references/*.md` alike — and `plugin/commands/**` come from `src/{guides,prompts}/*.md`. Hand-edits survive until the next `npm run build`. Every generated directory is owned *wholesale*, down to each skill folder, so a renamed or re-parented source cannot leave a second copy behind for an agent to read. CI runs `build-guides.mjs --check` to catch this at review time rather than in a release.
- **AE hangs a 48-property `ADBE Vector Materials Group` off every vector group, and it is inert on a 2D shape layer.** It is the 3D extrusion model — Front/Bevel/Side/Back × twelve attributes — and it only means anything for an extruded shape under the Cinema 4D renderer. It was around 75% of the bytes of a shape read: one 68×68 circle in one group cost 4,400 tokens, of which the geometry was about 40 (issue #42). `explore.jsx` skips it unless `shapeMaterials` asks, which is the one place `include`-absent-means-everything does not hold — hence `materialsOmitted` and a note in the response, and hence a separate flag rather than a member of `include`, whose contract would otherwise have to bend. The group Transform beside it is elided by the same walk when every property is still at its creation value, tested against `__VECTOR_TRANSFORM_DEFAULTS` rather than through `PropertyBase.isModified`: the values can be asserted with no AE to run in, and a property that table has never heard of has to fail the test rather than be folded away unread.

- **A scoped read must say what it left out.** `include`, `maxKeyframes` and `shapeDepth` on the read ops exist because a tool result is re-sent on every later request — a 65k-token `get_layer_full` is paid for once per call and then again on every request until the session ends. Two rules keep them honest: absent means *everything*, so no existing caller changes behaviour; and anything dropped is named and counted in the response (`included`, `keyframesOmitted` + `keyframesTruncated`, `childrenOmitted`), because a short answer that looks complete is the same class of lie as a swallowed error. Note what the call sites depend on: `args.include ? args.include : null` works because an empty array is truthy in JS, which is exactly what makes `include: []` mean "core fields only". Adding a `.length` guard there would quietly turn it back into "everything".
- **ExtendScript parses chained ternaries left-associatively.** `a ? x : b ? y : z` evaluates as `((a ? x : b) ? y : z)`, so the first truthy branch becomes the next condition and everything falls through to the last alternative — no throw, just the wrong answer. `get_project_summary` labelled every project item `"folder"` for two releases on one such line (issues #21/#22). Write if/else chains in `packages/jsx/*.jsx`; parentheses parse correctly too, but a later edit can drop them. `tests/unit/jsx-ternary.mjs` scans the sources and fails the build — there is no offline ExtendScript runtime, so nothing else can.
- **`run_jsx` must never answer `null`.** A script whose last statement is a bare expression completes and yields `undefined` — `"ping";` does not return `"ping"` — with every side effect already applied. Answering that with a bare `null` made "ran fine, returned nothing" identical on the wire to "did not run", and the natural response to a suspected failure is to run the script again: nothing rolls back, so a second run of a non-idempotent script duplicates layers, re-applies `moveTo` and writes keyframes on top of keyframes (issue #43). The guidance to prefer few large scripts makes the ones most likely to be re-run the most destructive to re-run. `__rjResult` therefore wraps *any* null — `undefined` and an explicit `return null` alike — in `{ok:true, returned:null, undoGroup, note}`. A returned value still comes back bare, falsy ones included; the envelope is for nothing, not for falsy.

- **`run_jsx`'s error line counts from something the caller cannot see.** The reported number did not map onto the submitted script and the shift was not even constant between calls — the same "line 22" pointed at two different statements in consecutive calls (issue #46). It costs more here than anywhere else: nothing rolls back, so an agent that cannot locate the throw either reads the whole project back or, worse, runs the script again and applies the completed half twice. Two things fix it, and the second is the one that survives being wrong. First, the wrapper is built so the caller's line 1 *is* line 1 of the evaluated source — `__RJ_WRAP_PREFIX` carries no newline and `__RJ_PREAMBLE_LINES` **counts** it rather than asserting it, because a hand-written constant beside a string is exactly how the two came apart. Second, the failure is reported with the line's **text**, which needs no trust in any numbering, and `__rjSourceInfo` refuses to map a line that falls outside the script rather than clamping it — a confident wrong number sends the reader to a statement that did not fail. `aeErrorText()` in `util/errors.ts` is the one place this becomes prose. `tests/unit/run-jsx-lines.mjs` holds the preamble invariant; nothing else can, since there is no ExtendScript to run offline.
- **`app.executeCommand()` silently no-ops through the bridge.** `app.executeCommand(2080)` (Edit → Duplicate) runs, throws nothing, and does nothing: menu commands need host/panel focus and an active selection, and CEP's `evalScript` guarantees neither. It fails in the worst available shape — a success result for work that did not happen — and only surfaces later as a missing item. There is nothing to fix in code, so the `run_jsx` description names the failure and points at the API equivalents (`CompItem.duplicate()`, `layer.duplicate()`). Reported as issue #47.
- **A `run_jsx` library has to go through `$.evalFile`, never `eval`.** `eval` runs in the *calling* function's scope, so a library's `function helper(){}` would live inside the loader and be gone the moment it returned — which would make "load once, call for the rest of the session" a lie that only shows up as an undefined function three scripts later. `$.evalFile` evaluates at global scope, and that single fact decides the shape of the whole feature: the server sends `{path, hash}` and the panel evaluates the file from disk, rather than the server inlining the source. The hash is a content hash taken when the server read the file, so re-passing an unchanged library is free and editing one re-evaluates it. `__RJ_LIBS` is written only after a successful eval — a half-loaded library recorded as loaded is the same lie in a different place.

- **`run_jsx`'s undo group collides with `copyToComp`.** AE refuses to copy a layer that has a parent or a linked expression while an undo group is open, so `dispatch()`'s wrapper broke exactly the rigs worth copying (issue #30). `run_jsx` now takes `undoGroup:false`, resolved per call through the predicate form of `__meta.noUndo`, and `core.jsx` exposes `withoutUndoGroup(fn)` for closing the group around one statement. Keep the opt-out on the handler's `__meta` — dispatch must stay stateless between calls, or one op's opt-out leaks into the next.
- **AE's scripting DOM has no `toComp`/`toWorld`.** Those exist only in the expression language, so anything needing a world transform reimplements the matrix chain — `layers.jsx` does, for `parent_layer`'s `preserveTransform`. Two things follow: 2D only (AE's 3D rotation order is not worth guessing at), and a child's `Position` has two possible readings of its parent's space that differ by the parent's anchor point, so the position correction only fires when AE's own answer matches *neither* — the one case where AE is provably wrong.
- **`exportAsMotionGraphicsTemplate` invalidates every reference held across it.** Not just the `CompItem` — `app.project` too. Measured on 26.3: after a successful export, a `comp` captured beforehand throws `Object is invalid` on `.name`, and so does an `app.project` captured beforehand, while a fresh `app.project.itemByID(id)` returns a working comp. The first version of `export_mogrt` built its result object from the pre-export `comp` and therefore threw *after* writing a perfectly good `.mogrt` — reporting a failure for work that did happen, which is the same class of lie as swallowing an error. `mogrt.jsx` captures `id` and `name` as primitives before the call and re-fetches after it. Nothing about the error says which object went stale, so if a mogrt op ever starts throwing `Object is invalid`, look for a handle held across the export before anything else.
- **`app.beginSuppressDialogs()` is what makes a scripted `.mogrt` export usable, and it was worth measuring.** Issue #23 filed it as untested. It is not: with a comp using a non-Adobe font, the export returns in ~3s suppressed and blocks past 60s unsuppressed, writing nothing until someone clicks OK on "The following 1 fonts were not synced from Adobe". `endSuppressDialogs(false)` must run in a `finally` — leaving dialogs suppressed would silence every warning for the rest of the user's session.
- **The `.mogrt` filename comes from `comp.motionGraphicsTemplateName`, not the comp name**, and it defaults to the literal `"Untitled"` for a template assembled by script. Left alone, every export in a project overwrites the same `Untitled.mogrt`. `export_mogrt` defaults it to the comp name but leaves a name the user actually set alone. Related: `CompItem.posterTime` does not exist (the thumbnail is the comp's first frame, hence the black one on anything that fades up), and there is no `getMotionGraphicsDataName` — only the reverse-indexed `setMotionGraphicsControllerName`.
- **`layer.property("ADBE Audio Levels")` returns null on an audio layer.** Audio Levels sits inside the layer's `Audio` group, not on the layer, and the only reliable handle is the `layer.audioLevels` shortcut (issue #48). A null there does not throw — it just means the level is never set, on every layer, silently — which is most of the reason `place_audio_cues` exists rather than being left to a `run_jsx` loop. `audio.jsx` uses the shortcut and falls back to the group walk; if neither answers it says so instead of leaving a layer at whatever level the file happened to have. AE's Audio Levels is itself in decibels, two channels, and the tool writes `0` explicitly when the caller gives no level for the same reason `create_text_layer` writes tracking explicitly.
- **A batch op has to be all-or-nothing, because a partial one cannot be described.** `place_audio_cues` can be handed 90 cues; a run that dies on cue 30 leaves 29 sound effects in the timeline and an error naming none of them, and the natural next move — call it again — doubles the first 29. So it plans the whole list with no side effects (resolving every `footageId`, checking every path exists, checking each resolved item has audio, checking every time is inside the comp), reports *all* the offending cue indices at once, and creates nothing if any of them failed. What planning cannot foresee — an import that turns out to be silent, an AE refusal on some particular layer — is caught by a rollback that removes every layer and every import the call made, newest first, layers before items. **The layer joins the rollback list the instant `layers.add()` returns, not once it is configured**; registering it after the last `setValue` leaves exactly the failing layer behind, which the offline test caught before this ever ran in AE. `dryRun:true` is the same planner with the creation phase skipped, and it is not an undo step either — a plan appearing in the user's undo history would make "this changed nothing" false in the one place they can see it.
- **AE fabricates dimensions for an SVG with a very large viewBox, and the numbers depend only on the viewBox.** A synthetic file with the reported `0 0 278050 333334` imports as **15906x5654** — byte for byte the dimensions in issue #33, from an entirely different SVG. It will not even rasterize: `saveFrameToPng` on a comp containing one produces no file at all, where a healthy SVG renders in seconds. That reproducibility is what makes the aspect-ratio check in `footage.jsx` a reliable detector rather than a heuristic.
- **CEP anchors `__dirname` at the extension root, not at the folder holding the file.** So `require("ws")` resolves (node_modules is at the root) while `require("./pngcodec.js")` from `client/main.js` does not — it looks for `<ext>/pngcodec.js`, which is not where the file is. This is why the panel is the only part of the system whose bootstrap has to be tested rather than reasoned about: it shipped on `versions/0.3.0` refusing to start with "cannot start — pngcodec.js … is missing", and nothing caught it, because there is no AE on a runner, the unit tests require those modules by absolute path, and the one machine it had ever run on still had a pre-#36 panel installed. **Resolve panel-internal paths from `cs.getSystemPath(SystemPath.EXTENSION)`, never from `__dirname`** — that is authoritative, and `main.js` now builds `clientDir` from it before requiring anything. `tests/unit/panel-boot.mjs` runs the real `main.js` against a stub CEP host in a copy of the installed layout and asserts it reaches a listening `/health`.
- **`CompItem.duplicate()` is shallow, and the copy looks finished.** The
  duplicate's precomp layers point at the *same* nested comps as the original,
  so "make a variant of this rig" and then editing the variant edits the
  original too — silently, and usually noticed several scenes later.
  `duplicate_comp` keeps that as the default because it is AE's own Duplicate
  and changing it would surprise anyone who knows the app, but it says so in the
  result rather than leaving it to be discovered, and `deep:true` duplicates the
  nested comps and re-points the copy at them. Two things `deep` has to get
  right and a hand-rolled `run_jsx` version usually does not: the same nested
  comp appears on several layers, so it is duplicated once and reused (keyed by
  the *original* id) rather than fanned out per reference; and the copy is
  registered in that map *before* the walk descends into it, which is what makes
  a cycle terminate. A nested duplication that fails part-way names every comp
  it created in the error — the objects are real and nothing rolled them back.
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
