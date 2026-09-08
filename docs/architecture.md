# Architecture — the source tree and the op path

Where everything lives, and what happens to an op between the MCP client and
ExtendScript. The six steps for adding an op are in [CLAUDE.md](../CLAUDE.md);
this file is what those steps do not cover.

Numbered recipes referenced below are in [verification-recipes.md](verification-recipes.md).

## Source layout

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** Adding an op = adding a zod schema here. Also holds `OpMutation` (write/read/server) and the `crossField()` vocabulary for rules `zod-to-json-schema` cannot express — see "Cross-field rules". |
| `packages/shared/src/ipc.ts` | HTTP envelope + WS event types. |
| `packages/jsx/*.jsx` | ExtendScript handlers. Each module attaches functions to the global `OPS` table. ES3-ish — no `let`/`const`/arrow/templates. |
| `packages/jsx/core.jsx` | JSON polyfill, `dispatch(payloadJson)` router, `withUndo()` wrapper, `JOBS` table for chunked async. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists. Spend disproportionate care here. |
| `packages/jsx/snapshot.jsx` | The comp fingerprint and the diff of two of them. Backs `snapshot_comp` / `diff_comp` and the `diff:true` flag on `run_jsx` / `run_batch`. The diff is pure — two objects in, one out — which is what lets it be tested with no AE. |
| `packages/jsx/batch.jsx` | `run_batch` for ≤500 ops inline in one undo group; otherwise registers a job and yields chunks via `_continue_job`, one undo group per chunk. `singleUndo:true` forces the inline path at any size up to 2000. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper. Returns a temp path; the panel base64-encodes. |
| `packages/jsx/footage.jsx` | `import_footage` / `create_footage_layer` / `purge_unused_footage`. The SVG viewBox check lives here because import is the only place that has the file path and the resulting item together. Also holds `__importFile()` and `__itemPathMap()` — the one import in the codebase and the one project-by-path scan, both shared with `audio.jsx` — and the solid/`usedIn`/remove helpers that `delete_comp`'s `purgeUnusedSolids` (in `comps.jsx`) shares with the sweep. |
| `packages/jsx/audio.jsx` | `place_audio_cues`. Plans the whole cue list with no side effects, then imports each distinct file once and builds a layer per cue, rolling back everything it made if any of it fails. The per-cue `loop`, `fadeIn`/`fadeOut` and `stretch` options (#85) live in `__placeAudioCue`, whose statement order is load-bearing — stretch before `startTime`, remap before the extent, fade keys last — because each one moves something AE then resets; see [fragile-areas-ae.md](fragile-areas-ae.md). `loop` keeps the two Time Remap keys AE creates (removing them hides the property, #86). `__fadeFitProblem` is pure and runs twice: at plan time on what is known, and again after the imports on the durations it could not know, still before any layer exists. The dryRun report is counts plus `wouldImport`/`wouldReuse` plus the failing cues, never the resolved list (#88). |
| `packages/jsx/mogrt.jsx` | `export_mogrt`. Checks every precondition it can before touching anything, saves, suppresses dialogs, exports outside the undo group, and re-fetches everything afterwards. `__exportFailureMessage` is where a failure AE will not explain is reported as unknown rather than as a dialog. |
| `packages/jsx/raw.jsx` | `run_jsx` — the result serializer, and the wrapper that inlines any `libraries` ahead of the caller's script and maps a failure back onto whichever of those files it landed in. |
| `packages/jsx/helpers.jsx` | The helper scope a `run_jsx` script runs in: `compById`, `layerById`, `ease`, `addKeys`, `shape`. Global functions on purpose. Every one is listed by signature in the `run_jsx` description — change both together, since that is the only place a caller sees them. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate. Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, `evalScript` mutex, JSON envelope, job driver, PNG reader. Also `startServers`: on `EADDRINUSE` it asks `/health` who holds the port and **waits** for one of our own panels rather than walking past it (issue #92) — see [fragile-areas-bridge.md](fragile-areas-bridge.md). Reads `~/.engineroom-ae-mcp/config.json` (`port`, `allowPortWalk`) because a CEP panel has no environment variables of the user's; writes the port file only for a port actually bound, and removes its own entry on unload. |
| `packages/ae-panel/client/pngcodec.js` | 16-bit→8-bit PNG conversion, empty-frame detection, decoded pixels for the stale check, and `inspectPngStructure` — the chunk walk that says whether a file is a whole PNG yet. Node builtins only, requireable by a test. |
| `packages/ae-panel/client/framereader.js` | The poll loop that decides when After Effects has *finished* writing a frame, and the two error messages that come out of it. Issue #45 lives here. |
| `packages/ae-panel/client/contactsheet.js` | Tiles several frames into one labelled sheet, bitmap font included. Everything `times[]` needs that ExtendScript cannot do. |
| `packages/ae-panel/client/framecache.js` | The window of recently delivered frames that makes a re-served render buffer visible. |
| `packages/ae-panel/client/mogrt.js` | Zip surgery + box-filter resample that replaces `thumb.png` inside an exported `.mogrt`. Node builtins and `pngcodec.js` only — no third-party dependencies, so a test can require it. |
| `packages/mcp-server/src/server.ts` | Tool registry, vision/async-envelope branching, error mapping. `toolInputSchema()` is the whole of what a client sees as a tool's contract: zod → draft-07 → `toDraft2020()` → the cross-field constraints put back. Exported so a test can validate the exact document that ships. |
| `packages/mcp-server/src/tools/descriptions.ts` | All tool descriptions in one file — including the verbatim screenshot guidance. |
| `packages/mcp-server/src/tools/runJsxSource.ts` | `run_jsx`'s `scriptPath` and `libraries`. The **server** reads those files, never the panel — same reasoning as `init_project`. `OPS.run_jsx` throws if a `scriptPath` still reaches it, and likewise for a library with a path and no `text`: that means the call came through `run_batch` (whose steps are never validated) or a direct `/op`, and running the empty script — or skipping the library — would report success for a file nobody read. `MAX_TOTAL_BYTES` caps the script and its libraries together, because since they are inlined every byte travels on every call. It resolves those two fields and **spreads everything else through untouched** — see "The only op whose input is rewritten" below. |
| `packages/mcp-server/src/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing. `discovery.ts` holds the candidate ports (`AE_MCP_PORT` alone if pinned; otherwise 7777 *then* the port file) and `isPanelHealth`, the test that decides whether something on a port is the panel — mirrored by `isOurHealth` in the panel's `main.js`; keep the two in step. `httpClient.ts` re-runs discovery when a call is **refused** (never on a timeout) and re-sends once if a different port answers as the panel; `wsClient.ts` follows the client's port through `onPortChange` instead of keeping a copy. |
| `packages/mcp-server/src/bridge/writeQueue.ts` | The one-writer-at-a-time mutex, and `extendUntil` — the lease that outlives its own call so a long `run_batch` keeps the lock while the panel drives it. Classification comes from `OpMutation` in `schemas.ts`. |
| `packages/mcp-server/src/jobs/manager.ts` | In-memory job table, `waitFor(jobId)` for the `await_job` tool, and the progress emitters `await_job` binds for exactly the span of its own call — `bindProgressEmitter` hands back the unbind, and the caller must use it. See "Long batch" under "Special return shapes" and the #82 entry in [fragile-areas-server.md](fragile-areas-server.md). |
| `packages/mcp-server/src/snapshots/store.ts` | In-memory comp fingerprints for `snapshot_comp` / `diff_comp`. Bounded ring; `missingMessage()` is the whole reason it is a class rather than a `Map`. |
| `packages/mcp-server/src/issues/journal.ts` | The cross-session issue journal — two of them: `<project>/.ae-mcp/issues/` and the user-level `~/.ae-mcp/issues/`. Backs `log_issue` / `list_known_issues` / `mark_issue_reported` / `archive_issue`. The project folder is `process.cwd()`; a client that gives no usable one (Claude Desktop starts servers at `/`) falls back to `~/.after-effects-mcp`, reported as `scope: "home"` so the fallback is never silent. `AE_MCP_HOME` overrides both roots (used by the CI check). Also holds the error-text normaliser and matcher (`normalizeErrorText`, `errorTextsMatch`, `entryMatchesFailure`), the version stamps, and `archiveReason` — the one place that decides whether an entry is hidden. See "The issue journal" in [subsystems.md](subsystems.md). |
| `packages/mcp-server/src/issues/failures.ts` | The push half of the journal: `annotateFailure` appends `Known from earlier sessions: <scope:id> — <title>` lines to a failed tool call's error text, from a per-file mtime+size cache (`JournalCache`). Never throws, never masks the error, never clears an `archive_issue` retirement — it only moves `lastSeen`/`lastVersion` on a match. Every failure-path `errorResult` in `server.ts` goes through it via `fail()`. |
| `packages/mcp-server/src/setup/{check,install,paths}.ts` | Backs `check_setup` / `setup_panel`. Never touches the bridge client — it exists for the case where the panel isn't installed yet — but `check.ts` probes every candidate port itself and reports the one that *answers* (`bridgeReachable`), whether that is the port ops go to (`portAgreement`; the server passes `opPort`), and what CEP's own log says about the panel's signature (`panelSignature`, issue #91; `findSignatureFailure` reads the last 256KB only). `install.ts` warns when it overwrites a self-signed install and turns CEP's LogLevel on where it was never set. `panelInstallDiff` in `paths.ts` walks the *source* tree only, which is what lets a signed install's `META-INF/` and `mimetype` pass as current. |
| `packages/mcp-server/src/setup/platform.ts` | **The only place macOS and Windows diverge** (PlayerDebugMode storage and CEP's `LogLevel` beside it, AE process detection, and where CEP writes its own log — `cepLogDir()` is `%TEMP%` vs `~/Library/Logs/CSXS/`, `cepLogPaths()` matches both the documented `csxs<n>-AEFT.log` and the measured `CEP<n>-AEFT.log`). Plus `cepExtensionsDir()` in `paths.ts`. Keep platform branching here — do not scatter `process.platform` through the codebase. |
| `scripts/lib/setup.mjs` | Loads the compiled setup module so the dev scripts (`doctor`, `install-panel`, `enable-debug`) reuse the same platform logic the MCP tools use instead of keeping a second copy. |
| `packages/mcp-server/src/setup/scaffold.ts` | **The one definition of what a project folder is.** Client-aware layout, target resolution, never-overwrite. Used by both `init_project` and the CLI. |
| `packages/mcp-server/src/cli/init.ts` | `npx … init <dir>` — the terminal front end to `scaffold()`. Holds no templates of its own. |
| `packages/mcp-server/src/guides/*.md` | **Source of truth for agent guidance.** Frontmatter + markdown. Generated into resources, `ae_guide` topics and Claude Code skills. `after-effects.md` is the **core** — it loads on every AE task, so it holds only what silently produces wrong output on *any* task — and every subject sits behind it as a `reference: after-effects` guide, opened when a task reaches that subject; that `reference: <parent>` line is also what makes a guide a reference file under the parent skill rather than a skill of its own. The table at the top of the core is the pointer the generator requires. `whats-new.md` is the one guide with a shape a machine reads — the only home of release history, one `## <semver>` section per release with `supersedes:` lines; its contract is in a comment at the top of the file and asserted by `tests/unit/whats-new.mjs`. See "Guidance and how it reaches an agent" in [guidance-system.md](guidance-system.md). |
| `packages/mcp-server/src/prompts/*.md` | Source of truth for user-invoked flows. Generated into MCP prompts and Claude Code commands. `$ARGUMENTS` is substituted at `prompts/get`. `absorb-release.md` is the upgrade flow — see "Release history, and reading it once" in [guidance-system.md](guidance-system.md). |
| `packages/mcp-server/src/tools/whatsNew.ts` | The `since` filter on `ae_guide({topic: "whats-new"})`: semver compare (numeric — 0.10.0 is newer than 0.9.0), the release splitter, the `supersedes:` extractor and the answer's version header. Pure text functions, so the real guide is tested against its own contract with no server. |
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

The six-step checklist for adding an op is in [CLAUDE.md](../CLAUDE.md). Two
things it deliberately leaves to this file: the one op whose input is rewritten
between validation and the forward, and how a rule that spans two fields is
declared once rather than three times.

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
  `string[]` reaching the panel in place of the resolved `{path, text, bytes}[]`
  is a type error and not a convention.
- **`tests/unit/run-jsx-args.mjs` enumerates `RunJsx.shape` and fails if any
  declared field is unreachable after resolution.** Same shape of guard as the
  `OpMutation` classification test, and for the same reason: the omission is
  invisible in the diff, invisible at runtime, and shows up as a plausible
  success. It generates a sample value per field from the zod type and **throws
  rather than skipping** on a type it cannot generate — a guard that quietly
  passes over the field it does not understand is the failure it exists to catch.

[Verification recipe 29](verification-recipes.md) is the live half.

### Cross-field rules ("pass exactly one of these")

**A `.refine()` is invisible to the model.** `zod-to-json-schema` drops
refinements without a word, so a rule written that way is enforced on the
server and absent from the schema the agent is shown — and the only way it
learns the rule is by making the call and having it rejected. That is a wasted
turn in every session that hits it, and three 0.4.0 features landed on the same
edge independently: `reorder_layer`'s three destinations, `screenshot_frame`'s
`time`/`times`, `run_jsx`'s `code`/`scriptPath`. Two more rules were being
enforced further down still — `set_temporal_ease` from inside After Effects
(a round trip and a write lease spent on a call that was never going to change
anything) and `set_effect_param` as a bare `Effect param not found`, which
reads as though the *name* was wrong rather than absent.

So a rule is **declared once**, with `crossField()` in `schemas.ts`, and three
things are generated from that one declaration:

| Generated | By | Reaches |
|---|---|---|
| the zod check | `crossField` | the server, on every call |
| `oneOf` / `anyOf` / `not` in the emitted schema | `crossFieldJsonSchema`, applied by `toolInputSchema()` | every client, before the call |
| the sentence in the rejection | `crossFieldMessage` | the agent, when it breaks anyway |

Three kinds cover everything so far: `exactlyOne`, `atMostOne`, `atLeastOne`.
Five ops use them — `reorder_layer`, `screenshot_frame`, `run_jsx`,
`set_temporal_ease`, `set_effect_param`.

Four things hold it together, and each is a way it could rot quietly:

- **The declaration is the only copy.** A rule enforced in zod and described in
  prose somewhere else is two statements that drift, and the drift is invisible
  because the schema keeps working while only the *advice* goes stale.
- **An unclassified refinement fails the build.** `tests/unit/schema-constraints.mjs`
  enumerates every `ZodEffects` in every op schema and refuses any that is not a
  declared rule — same shape of guard as the `OpMutation` classification test
  and `run-jsx-args.mjs`, and for the same reason: what it cannot classify, it
  must not pass over. At *runtime* `toolInputSchema()` logs and carries on
  instead of throwing, for the reason `isWriteOp()` falls back to `"write"`:
  `tools/list` is the call every session begins with, so raising there would
  turn one under-specified tool into no tools at all. Fail the build loudly;
  fail the session towards what shipped before.
- **The two enforcers are proved to agree.** For a rule over N fields there are
  2^N ways to pass them, and the test probes every one against both the compiled
  JSON Schema and `safeParse`. A schema *stricter* than the server would
  advertise working calls as illegal; one *looser* is the invisible constraint
  this exists to end.
- **The description says it too.** Belt and braces on purpose — the keyword is
  machine-readable, the sentence is what a model actually reads, and a converter
  or a client can drop the first but never the second. The test requires both
  the field names and a phrase matching the rule kind.

`crossField` returns a `ZodEffects`, which has no `.shape`. Use `objectShapeOf()`
rather than reaching into `_def` — a schema loses `.shape` the day a rule is
added to it, and the caller that breaks is never the one that added the rule.

The runtime half is `invalidArgsText()` in `util/errors.ts`. `ZodError.message`
is `JSON.stringify(issues)`, so every carefully written message used to arrive
buried in an array of `code`/`expected`/`received` objects; it is now one line
per problem, naming the field. Passing *none* of a rule's fields and passing
*two* must read differently — an agent that cannot tell which mistake it made
re-sends the same call.

**Two constraints deliberately left as prose.** `place_audio_cues` requires
exactly one of `footageId`/`path` *per cue*, and `audio.jsx` reports every
offending cue index at once so `dryRun` can answer for the whole list; a zod
rule would reject the call through a different, less structured channel and
change what `dryRun` is for. And `blendingMode`, `trackMatte.type` and a mask's
`mode` are keys into After Effects' own enumerations, looked up by name — an
unrecognised one is **ignored** and the call still reports success. That is a
swallowed error rather than a hidden constraint, and fixing it means changing
what the .jsx does with no AE to test against; for now the accepted names are
in the field descriptions, along with the fact that a wrong one changes nothing.

## Special return shapes

- **Vision** (`screenshot_frame`, `screenshot_layer`): JSX returns `{path, width, height, time, compId, layerId?}`. Panel waits for the file to be a *complete* PNG (`framereader.js`), normalises it to 8-bit, base64-encodes, returns `{base64, bytes, ...}`. Server packages as MCP `image` content block. Four outcomes are deliberately *not* images: a fully transparent frame comes back as `{empty:true, reason}` and goes through `textResult`; a frame whose pixels match a different earlier request is refused as `STALE_FRAME`; a file After Effects wrote and abandoned is refused as `FRAME_INCOMPLETE`; and a render that never finished is refused as `RENDER_TIMEOUT`. Those last two must never share a sentence — see [fragile-areas-bridge.md](fragile-areas-bridge.md).
- **Contact sheet** (`screenshot_frame` with `times`): 2-6 times in one call, exclusive with `time` — a declared `atMostOne` cross-field rule, so two readings of "which frame" can never reach ExtendScript *and* the exclusion is in the emitted JSON Schema rather than only in the rejection. JSX renders one temp PNG per time at a shared per-tile factor and returns `{contactSheet:true, tiles:[{path,time}|{error}], downsample, ...}`; the panel reads each, composites them into one labelled image (`contactsheet.js`) and returns the same `base64` shape plus `tiles`, `cols`, `rows`, `cellWidth`/`cellHeight`. Three properties hold it together: **every requested time keeps its cell**, so a failed tile is a marked block rather than a gap that renumbers the rest; **the time is burned into the picture**, because metadata beside an image is not what a model compares; and **a bad tile never invalidates the sheet** — it is named and counted in `warning`, and only a sheet where *nothing* rendered is refused outright. Inside one sheet, two tiles with identical pixels are a static comp, not the #29 stale buffer, so they are flagged in `note` rather than refused; a match against a frame from *outside* the sheet is still a stale tile and is drawn as a block.
- **Long batch** (`run_batch` >500 ops): JSX returns `{jobId, async:true, total, chunkSize, undoStepsEstimate, undoGroupName, note}`. Panel drives `_continue_job` in chunks of `chunkSize` in the background, broadcasting `progress` events on WS. **Those reach the client as `notifications/progress` on `await_job`, and never on `run_batch`** — `run_batch` has answered before the first chunk runs, and a notification sent on a request's token after that request's response is one every spec-compliant client has already stopped correlating (issue #82; the entry in [fragile-areas-server.md](fragile-areas-server.md)). So `server.ts` appends a sentence to the envelope's `note` saying where progress goes, and `await_job` binds an emitter to *its own* request's `progressToken` for exactly the span of that call, sending through the SDK's request-scoped `extra.sendNotification` and draining every send before it returns (`forwardJobProgress`). `get_job` reads the same state and never notifies. The undo fields ride the envelope because it is the only message the agent sees before it starts describing the work — the *measured* `undoSteps` arrives much later, on the completion event. `singleUndo:true` takes the inline path instead, so no envelope and no progress at all.
- **Server-resident** (`await_job`, `get_job`, `cancel_job`, `check_setup`, `setup_panel`, `init_project`, `ae_guide`, `log_issue`, `list_known_issues`, `mark_issue_reported`, `archive_issue`): handled in `server.ts`; never forwarded to the panel (except `cancel_job`, which also sends `_cancel_job` to the bridge to set the JSX-side flag). They're still listed in `OpSchemas` so `tools/list` picks them up — membership in `SERVER_OPS` is what stops the forwarding.
- **Half server-resident** (`snapshot_comp`, `diff_comp`): the panel gathers, the server remembers. `SNAPSHOT_OPS` in `server.ts` routes them to `runSnapshotOp`, which forwards an internal read op (`_comp_fingerprint` / `_comp_diff`) and keeps the answer in `SnapshotStore`. Deliberately *not* in `SERVER_OPS` — unlike those, these do touch the bridge, and they are dispatched from inside the same `try` as `bridge.runOp` so the timeout, `AeError` and Unknown-op mappings all apply unchanged.
- **Prose** (`ae_guide`): returns the markdown as a bare text content block rather than through `textResult()`. JSON-stringifying it would hand the model a wall of `\n`. The `whats-new` topic is the one exception to "the body, verbatim": its answer opens with a line naming the server's own version (`packageVersion()`, read from package.json — the guide cannot know it, since a build between releases is ahead of its newest section), and with `since` it is the preamble plus only the sections newer than that version, or one explicit line saying nothing is newer. `since` on any other topic is refused, not ignored. The `ae://guide/whats-new` resource is untouched — still the raw body. See "Release history, and reading it once" in [guidance-system.md](guidance-system.md).
- **Summarised** (`get_house_style`): the panel returns the whole document; `server.ts` runs it through `applyHouseStyleDetail` before packaging, and `detail: "summary"` — the default — replaces `content` with a digest. The one post-bridge transform in the codebase that changes what a *read* answers, so it is the one to remember when a house-style result looks unfamiliar. See "The house style" in [subsystems.md](subsystems.md).
- **Downsampled screenshots**: handled entirely in `vision.jsx`. `saveFrameToPng` *does* respect `CompItem.resolutionFactor` (measured: a 3840×2160 comp yields 1920×1080 at factor 2, 960×540 at factor 4), so `__saveFrameAt` sets the factor, renders, and restores it in a `finally`. That restore is not optional — a throw mid-render would otherwise leave the user's comp at reduced resolution. **Every factor is set, factor 1 included**, and that is the fix for issue #72 rather than an implementation detail: `resolutionFactor` is also the Resolution dropdown in the viewer, so treating 1 as "nothing to do" rendered at whatever the designer had left the comp on. A comp parked at Quarter — routine on anything heavy — answered `downsample: 1` with a quarter-size frame and `downsample: 2` with one four times **larger**. The panel reads the true dimensions out of the PNG's IHDR chunk rather than computing them, so reported size can never disagree with the image sent; that is what kept this invisible, because the response stayed honest while the *picture* was not the one asked for, and an agent that can see a frame believes the frame. An earlier version shelled out to `sips`; it was replaced because rendering smaller is faster than resampling and needs no external tool, which is what makes downsampling work on Windows. The factor is *derived* from the comp when the caller omits one (`__autoDownsample`, aiming at a ~1280px long edge) — which is why `ScreenshotFrame`/`ScreenshotLayer` must not carry a zod `.default(1)`: a default there would reach the panel as an explicit 1 and the derivation would never run. `tests/unit/screenshot-resolution.mjs` holds all three — the explicit factor, the restore (on a throw as well, at 1 as well) and the derivation — against a mock comp whose viewer starts at Quarter.

## Serializing writes

**The panel's `evalScript` mutex is necessary and not sufficient, and the gap it
leaves is exactly where the damage was.** That chain serializes every individual
`evalScript`, so two ordinary writes cannot interleave *within* one op — the
undo group `dispatch()` opens is closed before the next call gets a turn. What
it does not cover is the gap around a long `run_batch`. Over 500 ops, the
handler returns `{jobId, async:true}` immediately and the panel then drives
`_continue_job` in chunks of 25. Every chunk is its own turn on the chain, so
any op issued meanwhile slots in *between* two chunks. That is issue #55, and it
is why the fix could not be "the panel already handles it".

Issue #55 described the damage as an interloper's own `endUndoGroup()` closing
the batch's group, since AE's groups do not nest. That reading was wrong in one
detail, found while verifying 0.4.0: the batch's group was **already gone**,
because After Effects discards a group opened in one `evalScript` and closed in
another (issue #69, and the undo-groups entry in [fragile-areas-ae.md](fragile-areas-ae.md)). Each chunk now
opens and closes its own group, so nothing an interloper does can break one. The
lock is still held for the whole job, for the reason that survives the
correction: a batch is one thing the caller asked for, and a write dropped into
the middle of it runs out of the order the agent issued it in.

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
  `await_job` is also the call that carries the batch's progress (#82), which
  is a second reason it can never sit in this queue: a waiter that is itself
  waiting reports nothing about the batch it exists to watch.
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

