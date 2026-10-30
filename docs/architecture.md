# Architecture — the source tree and the op path

Where everything lives, and what happens to an op between the MCP client and
ExtendScript. The six steps for adding an op are in [CLAUDE.md](../CLAUDE.md);
this file is what those steps do not cover.

Numbered recipes referenced below are in [verification-recipes.md](verification-recipes.md).

## Source layout

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** Adding an op = adding a zod schema here. Also holds `OpMutation` (write/read/server) and the `crossField()` vocabulary for rules `zod-to-json-schema` cannot express — see "Cross-field rules". |
| `packages/jsx/*.jsx` | ExtendScript handlers. Each module attaches functions to the `OPS` table — top-level code in the source, a closure local in the bundle (issue #185). ES3-ish — no `let`/`const`/arrow/templates. |
| `packages/jsx/core.jsx` | JSON polyfill, `dispatch(payloadJson)` router, `withUndo()` wrapper, `JOBS` table for chunked async. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists. Spend disproportionate care here. |
| `packages/jsx/snapshot.jsx` | The comp fingerprint and the diff of two of them. The fingerprint backs `snapshot_comp` / `diff_comp`; the diff here backs only the `diff:true` flag on `run_jsx` / `run_batch` now — `diff_comp` diffs on the server (issue #220). `_comp_diff` stays in the bundle, unused, so a newer panel never breaks an older server. The diff is pure — two objects in, one out — which is what lets it be tested with no AE. |
| `packages/jsx/checkpoint.jsx` | `checkpoint_comp`, `list_checkpoints`, `revert_comp`, `delete_checkpoints` (issue #136). A checkpoint is a tagged `CompItem.duplicate()`; a revert copies its layers back *into the original comp* so the comp id never changes, then verifies the result with `snapshot.jsx`'s fingerprint. Why it is not a swap is in [subsystems.md](subsystems.md), "Comp checkpoints". |
| `packages/jsx/batch.jsx` | `run_batch` for ≤500 ops inline in one undo group; otherwise registers a job and yields chunks via `_continue_job`, one undo group per chunk. `singleUndo:true` forces the inline path at any size up to 2000. A job no `_continue_job` has reached for 30 minutes (`__JOB_ORPHAN_MS`) is retired to an `abandoned` tombstone — what a batch whose server died leaves behind (issue #220, stage 5). `_get_job` is After Effects' own record of how far a job got. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper. Returns a temp path; the panel base64-encodes. |
| `packages/jsx/footage.jsx` | `import_footage` / `create_footage_layer` / `purge_unused_footage`. The SVG viewBox check lives here because import is the only place that has the file path and the resulting item together. Also holds `__importFile()` and `__itemPathMap()` — the one import in the codebase and the one project-by-path scan, both shared with `audio.jsx` — and the solid/`usedIn`/remove helpers that `delete_comp`'s `purgeUnusedSolids` (in `comps.jsx`) shares with the sweep. |
| `packages/jsx/audio.jsx` | `place_audio_cues`. Plans the whole cue list with no side effects, then imports each distinct file once and builds a layer per cue, rolling back everything it made if any of it fails. The per-cue `loop`, `fadeIn`/`fadeOut` and `stretch` options (#85) live in `__placeAudioCue`, whose statement order is load-bearing — stretch before `startTime`, remap before the extent, fade keys last — because each one moves something AE then resets; see [fragile-areas-ae.md](fragile-areas-ae.md). `loop` keeps the two Time Remap keys AE creates (removing them hides the property, #86). `__fadeFitProblem` is pure and runs twice: at plan time on what is known, and again after the imports on the durations it could not know, still before any layer exists. The dryRun report is counts plus `wouldImport`/`wouldReuse` plus the failing cues, never the resolved list (#88). |
| `packages/jsx/mogrt.jsx` | `export_mogrt`. Checks every precondition it can before touching anything, saves, suppresses dialogs, exports outside the undo group, and re-fetches everything afterwards. `__exportFailureMessage` is where a failure AE will not explain is reported as unknown rather than as a dialog. `add_essential_property` lives here too: it reads the Essential Graphics panel back rather than trusting the add's boolean. |
| `packages/jsx/render.jsx` | `add_to_render_queue` / `list_render_queue` / `remove_render_item`, and the two halves of `render_queue` that need After Effects: `_render_prepare` (read-only — which items, which files, how many frames, which footage each reads (`__rqFootageUse`, issue #144), where AE is installed) and `_render_save`. The render itself is deliberately not here; see the render-queue entries in [fragile-areas-ae.md](fragile-areas-ae.md). |
| `packages/mcp-server/src/render/aerender.ts` | `render_queue`'s job. `RenderRunner` spawns one `aerender` per item, counts `PROGRESS:` frame lines into `JobManager`, verifies every output on disk before calling an item rendered, and on cancel stops the process tree and reports `stopped` only once it has exited. Pure helpers (`parseAerenderLine`, `LineSplitter`, `aerenderArgs`, `verifyOutputs`, `resolveAerender`) are what the unit test exercises; aerender's location and the tree kill are in `setup/platform.ts`. |
| `packages/jsx/raw.jsx` | `run_jsx` — the result serializer, and the wrapper that inlines any `libraries` ahead of the caller's script and maps a failure back onto whichever of those files it landed in. `_run_jsx` runs a wrapper the server built and leaves the mapping to it (stage 6, below); `OPS.run_jsx` keeps both for older servers and `run_batch` steps. |
| `packages/mcp-server/src/tools/runJsxAssembly.ts` | The server's port of raw.jsx's assembly and line mapping, used on a `server-run-jsx` panel. Byte-identical by test (`run-jsx-assembly.mjs`); see "`run_jsx` assembled on the server" below. |
| `packages/jsx/values.jsx` | `__setValue`, which every first-class `setValue` goes through: on AE's spurious `invalid numeric result` throw (issue #129) it reads the property back and drops the throw only if the value landed. See [fragile-areas-ae](fragile-areas-ae.md#shapes). |
| `packages/jsx/helpers.jsx` | The helper scope a `run_jsx` script runs in: `compById`, `layerById`, `ease`, `addKeys`, `shape`, `setValueChecked`. Top-level functions on purpose: in the bundle they are locals of its closure, which `run_jsx`'s direct `eval` sees — never globals, since the ExtendScript engine is shared with other scripts (issue #185). Every one is listed by signature in the `run_jsx` description — change both together, since that is the only place a caller sees them. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate. Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, `evalScript` mutex, JSON envelope, job driver (only for a server that does not ask to drive — see "The batch driver" below), PNG reader. Also `startServers`: on `EADDRINUSE` it asks `/health` who holds the port and **waits** for one of our own panels rather than walking past it (issue #92) — see [fragile-areas-bridge.md](fragile-areas-bridge.md). Reads `~/.engineroom-ae-mcp/config.json` (`port`, `allowPortWalk`) because a CEP panel has no environment variables of the user's; writes the port file only for a port actually bound, and removes its own entry on unload. Mints the bridge token and writes `token-<port>` beside the port file from inside `bindWith`, before the bind promise resolves — the socket is already accepting by then (issue #106). |
| `packages/ae-panel/client/pngcodec.js` | 16-bit→8-bit PNG conversion, empty-frame detection, decoded pixels for the stale check, and `inspectPngStructure` — the chunk walk that says whether a file is a whole PNG yet. Node builtins only, requireable by a test. |
| `packages/ae-panel/client/framereader.js` | The poll loop that decides when After Effects has *finished* writing a frame, and the two error messages that come out of it. Issue #45 lives here. |
| `packages/ae-panel/client/contactsheet.js` | Tiles several frames into one labelled sheet, bitmap font included. Everything `times[]` needs that ExtendScript cannot do. |
| `packages/ae-panel/client/framecache.js` | The window of recently delivered frames that makes a re-served render buffer visible. |
| `packages/ae-panel/client/mogrt.js` | Zip surgery + box-filter resample that replaces `thumb.png` inside an exported `.mogrt`. Node builtins and `pngcodec.js` only — no third-party dependencies, so a test can require it. |
| `packages/mcp-server/src/frames/` | The server's copies of those five (`pngCodec`, `frameReader`, `frameCache`, `contactSheet`, `mogrtThumbnail`) plus `pipeline.ts`, the part of `main.js` that drove them: the retry, the stale check, the sheet, the `.mogrt` patch (issue #220, stage 4). Used on a panel that reports `server-images`; the panel's copies stay for older servers. `tests/unit/image-parity.mjs` runs both on the same renders and requires identical bytes — change one, change both. |
| `packages/mcp-server/src/server.ts` | Tool registry, vision/async-envelope branching, error mapping. `toolInputSchema()` is the whole of what a client sees as a tool's contract: zod → draft-07 → `toDraft2020()` → the cross-field constraints put back. Exported so a test can validate the exact document that ships. |
| `packages/mcp-server/src/tools/descriptions.ts` | All tool descriptions in one file — including the verbatim screenshot guidance. |
| `packages/mcp-server/src/tools/runJsxSource.ts` | `run_jsx`'s `scriptPath` and `libraries`. The **server** reads those files, never the panel — same reasoning as `init_project`. `OPS.run_jsx` throws if a `scriptPath` still reaches it, and likewise for a library with a path and no `text`: that means the call came through a direct `/op` (a `run_batch` step has been resolved by the server since #157), and running the empty script — or skipping the library — would report success for a file nobody read. `MAX_TOTAL_BYTES` caps the script and its libraries together, because since they are inlined every byte travels on every call. It resolves those two fields and **spreads everything else through untouched** — see "The only op whose input is rewritten" below. |
| `packages/mcp-server/src/tools/annotations.ts` | `toolAnnotations()` — the MCP read-only/destructive/idempotent hints, derived from `OpMutation` and `READ_ONLY_SERVER_OPS`. See "Tool annotations" below. |
| `packages/mcp-server/src/tools/policy.ts` | Read-only mode and the `run_jsx` switch (`AE_MCP_READ_ONLY`, `AE_MCP_DISABLE_RUN_JSX`). Which ops are offered, the refusal for one that is not, the batch-step check, and the runtime notice prepended to the guidance. See "Tool switches" below. |
| `packages/mcp-server/src/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing. `discovery.ts` holds the candidate ports (`AE_MCP_PORT` alone if pinned; otherwise 7777 *then* the port file) and `isPanelHealth`, the test that decides whether something on a port is the panel — mirrored by `isOurHealth` in the panel's `main.js`; keep the two in step. `httpClient.ts` re-runs discovery when a call is **refused** (never on a timeout) and re-sends once if a different port answers as the panel; `wsClient.ts` follows the client's port through `onPortChange` instead of keeping a copy. `discovery.ts` also owns `panelToken`/`authHeaders`, read from disk on **every** call rather than cached — a panel that rebinds mints a new token, and a cached one would outlive it (issue #106). |
| `packages/mcp-server/src/bridge/panelGate.ts` | The panel-version gate: caches the verdict from the *running* bundle hash on `/health`. Healthy is re-checked every minute, stale every 5s — never cached for good, because restarting AE rebinds the same port and no port change fires (issue #156). Invalidated on port change, `setup_panel` and `WsClient.onReopen`; concurrent callers share one in-flight probe, and a generation counter stops a probe that started before an invalidate from restoring the old verdict. Unreachable drops the verdict; a timeout keeps it and waits 5s before probing again. |
| `packages/mcp-server/src/bridge/writeQueue.ts` | The one-writer-at-a-time mutex, and `extendUntil` — the lease that outlives its own call so a long `run_batch` keeps the lock while an older panel drives it (a batch the server drives owns its lease outright — see "The batch driver"). Classification comes from `OpMutation` in `schemas.ts`. |
| `packages/mcp-server/src/frontdesk/line.ts` | `SessionLine` — every server's one way to After Effects when several sessions share it (issue #223): the session's own `WriteQueue`, then the desk's cross-session lock; `runOp`/`cancel` through the desk; the election, and the handover rule. With no desk configured every method is a plain pass-through. See "The front desk" below. |
| `packages/mcp-server/src/frontdesk/desk.ts` | `FrontDesk` — the loopback HTTP server the leading session runs: token-gated, NDJSON answers, the in-flight record, the `start` line flushed before a call is posted to the panel. |
| `packages/mcp-server/src/frontdesk/lock.ts` | `DeskLock` — the cross-session write lock: positions, who is in front and for how long, resumed leases first, the takeover grace period, a hold ceiling. |
| `packages/mcp-server/src/frontdesk/{config,protocol}.ts` | The desk port and its file (`desk-<port>.json`, 0600); the wire format, and the error round-trip that keeps the five bridge failures five. |
| `packages/mcp-server/src/jobs/batchDriver.ts` | `BatchDriver` — the chunked `run_batch` loop, on the server since issue #220 stage 5: one `_continue_job` per chunk under the batch's lease, progress and the final state into `JobManager`, a lost answer recovered from `_get_job`'s cursor, every stop worded with how far the batch got. `foreignJobText` answers for a batch id another server process started. See "The batch driver" below. |
| `packages/mcp-server/src/jobs/manager.ts` | In-memory job table, `waitFor(jobId)` for the `await_job` tool, and the progress emitters `await_job` binds for exactly the span of its own call — `bindProgressEmitter` hands back the unbind, and the caller must use it. See "Long batch" under "Special return shapes" and the #82 entry in [fragile-areas-server.md](fragile-areas-server.md). |
| `packages/mcp-server/src/snapshots/diff.ts` | `diff_comp`'s diff — a line-for-line port of `snapshot.jsx`'s, kept byte-for-byte identical to it by a parity sweep in `tests/unit/comp-snapshot.mjs` until `diff:true` moves too (#220). Change one, change both. |
| `packages/mcp-server/src/snapshots/store.ts` | In-memory comp fingerprints for `snapshot_comp` / `diff_comp`. Bounded ring; `missingMessage()` is the whole reason it is a class rather than a `Map`. |
| `packages/mcp-server/src/apps/compTimeline.ts` | The one MCP Apps view (issue #246): a `ui://` comp timeline for `snapshot_comp` / `diff_comp`, its HTML inline, and the capability check that keeps it invisible to every client that did not declare the extension. See "MCP Apps view" below. |
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
| `packages/jsx/style.jsx` | `get_house_style` / `set_house_style`, and `_project_path`. A panel reporting `project-path` (#220, stage 3) answers only the path and the server opens the file; every other panel reads `house-style.md` beside the .aep itself. |
| `packages/mcp-server/src/style/houseStyleFile.ts` | The house style's file I/O on the server: ports of `style.jsx` with its sentences, falling back to the panel's op for a folder this process cannot see. |
| `packages/mcp-server/src/setup/panelCapabilities.ts` | Reads `capabilities` off `/health`. Absent or malformed is legacy; a capability is used only when listed. |
| `packages/mcp-server/src/style/summary.ts` | The digest `get_house_style` returns by default. Parses a markdown document nobody controls; falls back to the document's own opening when it recognises nothing. Applies wherever the document was read. |
| `packages/mcp-server/src/files/destinations.ts` | The filesystem checks `add_to_render_queue`, `import_footage` and `export_mogrt` (with `destDir`) make before the call is forwarded. Ports of the jsx checks, which still run afterwards; a path Node and ExtendScript might read differently is forwarded unjudged. Held to the jsx by `tests/unit/destination-checks.mjs`. Change one, change both. |
| `plugin/` | The Claude Code plugin: `.mcp.json` + generated `skills/` and `commands/`. Everything under those two is output, not source. |
| `.claude-plugin/marketplace.json` | Marketplace catalog. Users add this repo, then install `after-effects@engine-room`. |
| `scripts/bundle-jsx.mjs` | Concatenates `packages/jsx/*.jsx` in dependency order into `packages/ae-panel/jsx/bundle.jsx`, inside one function whose only global is `$.global.__AEMCP` — the engine is shared with every other script in AE ([fragile-areas-ae.md](fragile-areas-ae.md), issue #185). Before writing it parses the result with `scripts/lib/extendscript-syntax.mjs` and refuses, naming the source file and line, anything ExtendScript cannot run — not ES5, an ES3 reserved word as an identifier (`native` broke AE 26.5's load once), or an ES5 built-in such as `Object.keys` or `.forEach` (issue #164; `tests/unit/extendscript-syntax.mjs`). Run via `npm run build:jsx`. |
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

### `run_jsx` assembled on the server (issue #220, stage 6)

On a panel listing `server-run-jsx`, the resolved args take one more step:
`tools/runJsxAssembly.ts` builds the evaluated source (wrapper, inlined
libraries, the #221 undo rewrite and its fast path, the eval/Function/
`$.evalFile` caution scan) and sends `_run_jsx` with `built` in place of
`code`/`scriptPath`/`libraries`. Everything else in the args rides through by
spread, as above. A failure comes back carrying `rawLine` and `wrapperLine` (or
`libraryIndex` for a library that did not parse), forwarded by name in
`client/main.js`, and the server maps it onto the caller's script or library.

It is a **port**, and has to stay byte-identical to raw.jsx's functions: each
TS function names the jsx one it copies, and `tests/unit/run-jsx-assembly.mjs`
runs both on fixtures and on generated sources, then runs whole calls through
`OPS.run_jsx` and through build + `_run_jsx` + mapping and compares the result,
the error text and every undo call. Three things stay in ExtendScript because
they need it: each library's **parse check** (the parser decides what a syntax
error is and its line; a library is parsed as written, its text sent again only
when the rewrite changed it), the **`Error.source`/`start`/`end` reading** (the
error object never leaves AE, and `source` can be text the server never saw),
and the execution with its undo-guard counting, dialog shadows, `diff` and
result serializer.

`OPS.run_jsx` keeps its own assembly and mapping, for three callers: an older
server, a direct `/op`, and every `run_batch` step — `batch.jsx` dispatches
steps to `OPS[step.op]` and reports their failures itself, so moving them would
mean changing the batch code. `_run_jsx` answering `Unknown op` (refused before
any handler, so it carries no source mapping) withdraws the capability and
re-sends as `run_jsx`; a script's own error always carries one, which is what
stops a failure inside the script being read as that and run twice. A call the
server cannot build (a blank library; the tool path never produces one) goes
down the old path rather than inventing an error raw.jsx would have worded
with its own line number.

**One difference, accepted:** the script is `eval`'d in the handler's own
scope, so a name it uses without declaring resolves to the handler's locals
first. Those locals differ between the two handlers. In `_run_jsx`,
`args.code`, `args.scriptPath` and `args.libraries` are gone and `args.built`
is there instead. `code` is declared but `undefined` (raw.jsx, `OPS._run_jsx`),
where in `OPS.run_jsx` it held the script's own text. `built` holds the wire
form (`wrapper`, `undoRewrites`, `undoMentions`, `opaqueRoutes`, `libraries`)
rather than raw.jsx's layout (`preambleLines`, `segments`, …). `code` is still
declared so that an undeclared `code = …` in a script stays local rather than
writing a global into the shared engine (#185). No documented contract
exposes any of these, and the parity fixtures do not read them.

### Cross-field rules ("pass exactly one of these")

**A `.refine()` is invisible to the model.** The JSON Schema converter drops
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

**One constraint deliberately left as prose.** `place_audio_cues` requires
exactly one of `footageId`/`path` *per cue*, and `audio.jsx` reports every
offending cue index at once so `dryRun` can answer for the whole list; a zod
rule would reject the call through a different, less structured channel and
change what `dryRun` is for.

**Names of After Effects enumerations are closed twice (issue #150).**
`blendingMode`, `trackMatte.type` and a mask's `mode` are keys into AE's own
`BlendingMode` / `TrackMatteType` / `MaskMode`, looked up by name. They used to
be free strings, and a miss was **ignored** behind an `{ok}`. Now each is a
`namedEnum()` in `schemas.ts` — a plain `enum` in the emitted schema, matched
case-insensitively and forwarded in AE's spelling — and the .jsx refuses a name
the running AE does not define, before anything in the call is written. The
second check is not redundant: the lists are typed from Adobe's documentation,
and a name a given build lacks must still be an error rather than a no-op.

### Arguments are closed, and batch steps are held to them

**An unknown key is refused, at every depth, for every op (issue #147).** The
emitted schema closes every object (`additionalProperties: false`), but zod's
default for an object is to *strip* a key it does not declare — so a misspelt
`positon` reached no handler and the tool answered `{ok: true}` for a change
that never happened. Hand-writing `.strict()` on 79 objects is a rule that
holds until the next schema, so `strictDeep()` in `schemas.ts` closes every
object once, at module load, into `StrictOpSchemas`. **Parse with
`StrictOpSchemas`; emit from `OpSchemas`.** The closed copies are zod clones:
they keep `checks` (so `crossField()` rules travel) and lose `.describe()`/
`.meta()`, which is why emission stays on the originals. A `z.record()` or
`z.unknown()` is free-form by declaration and stays so. A node type
`strictDeep` does not know is left as it was and listed in `STRICT_UNHANDLED`;
`tests/unit/strict-args.mjs` fails the build on any, and walks every object in
every op to prove it is closed. It does not throw at runtime, for the reason
`toolInputSchema()` does not.

**A `run_batch` step gets the same validation as a direct call (issue #157).**
`tools/batchSteps.ts` parses each step against `StrictOpSchemas[op]`, at every
depth of nesting, and forwards the *parsed* args — defaults applied, `run_jsx`
sources resolved by `resolveRunJsxSource` as the tool would. Any problem
refuses the whole batch with every bad step named by path, and nothing reaches
the bridge. Some tools cannot be a step at all, because part of what they do
happens outside After Effects after the ExtendScript half returns; as a step
only that half ran. Those are refused by name, each with its reason
(`BATCH_STEP_REFUSALS`): `snapshot_comp`/`diff_comp` (the server keeps the
fingerprint), both screenshots (the server or panel builds the image; a step left a temp
PNG), `export_mogrt` (the server or panel writes the thumbnail), `render_queue`
(aerender), `get_house_style` (the server summarises). So are every
`"server"` op and any name not in `OpSchemas`, which covers the `_`-prefixed
internals. A new tool with a server- or panel-side half belongs in that table.
The ExtendScript-side guards (`OPS.run_jsx` refusing a `scriptPath`, enum
checks in handlers) stay: a hand-rolled `POST /op` still reaches them.

## Special return shapes

- **Vision** (`screenshot_frame`, `screenshot_layer`): JSX returns `{path, width, height, time, compId, layerId?}`. Whoever finishes the frame waits for the file to be a *complete* PNG (`frameReader`), normalises it to 8-bit and base64-encodes it, returning `{base64, bytes, ...}`. On a panel reporting `server-images` that is the server (`frames/pipeline.ts`): it sends `_screenshot_frame` / `_screenshot_layer`, which the panel does not intercept, and reads the path itself — the image never crosses the bridge. On any other panel the panel does it, as before, and the result has the same shape either way. Server packages as MCP `image` content block. Four outcomes are deliberately *not* images: a fully transparent frame comes back as `{empty:true, reason}` and goes through `textResult`; a frame whose pixels match a different earlier request is refused as `STALE_FRAME`; a file After Effects wrote and abandoned is refused as `FRAME_INCOMPLETE`; and a render that never finished is refused as `RENDER_TIMEOUT`. Those last two must never share a sentence — see [fragile-areas-bridge.md](fragile-areas-bridge.md).
- **Contact sheet** (`screenshot_frame` with `times`): 2-6 times in one call, exclusive with `time` — a declared `atMostOne` cross-field rule, so two readings of "which frame" can never reach ExtendScript *and* the exclusion is in the emitted JSON Schema rather than only in the rejection. JSX renders one temp PNG per time at a shared per-tile factor and returns `{contactSheet:true, tiles:[{path,time}|{error}], downsample, ...}`; the server (or a legacy panel) reads each, composites them into one labelled image (`contactSheet`) and returns the same `base64` shape plus `tiles`, `cols`, `rows`, `cellWidth`/`cellHeight`. Three properties hold it together: **every requested time keeps its cell**, so a failed tile is a marked block rather than a gap that renumbers the rest; **the time is burned into the picture**, because metadata beside an image is not what a model compares; and **a bad tile never invalidates the sheet** — it is named and counted in `warning`, and only a sheet where *nothing* rendered is refused outright. Inside one sheet, two tiles with identical pixels are a static comp, not the #29 stale buffer, so they are flagged in `note` rather than refused; a match against a frame from *outside* the sheet is still a stale tile and is drawn as a block.
- **Long batch** (`run_batch` >500 ops): JSX returns `{jobId, async:true, total, chunkSize, undoStepsEstimate, undoGroupName, note}`. On a panel reporting `server-drives-jobs` the server sends `_continue_job` itself, one chunk per call, and writes progress straight into `JobManager` (see "The batch driver" below); an older panel drives it in the background and broadcasts `progress` events on WS. **Progress reaches the client as `notifications/progress` on `await_job`, and never on `run_batch`** — `run_batch` has answered before the first chunk runs, and a notification sent on a request's token after that request's response is one every spec-compliant client has already stopped correlating (issue #82; the entry in [fragile-areas-server.md](fragile-areas-server.md)). So `server.ts` appends a sentence to the envelope's `note` saying where progress goes, and `await_job` binds an emitter to *its own* request's `progressToken` for exactly the span of that call, sending through the SDK's request-scoped `extra.sendNotification` and draining every send before it returns (`forwardJobProgress`). `get_job` reads the same state and never notifies. The undo fields ride the envelope because it is the only message the agent sees before it starts describing the work — the *measured* `undoSteps` arrives much later, on the completion event. `singleUndo:true` takes the inline path instead, so no envelope and no progress at all.
- **Render** (`render_queue`): a write op handled in `server.ts` by `runRender`. It forwards `_render_prepare` (refuses a never-saved project, an item not QUEUED, and a call naming neither `indices` nor `all:true` — the schema's `exactlyOne`), refuses existing outputs without `overwrite`, footage whose file is gone or that the saved .aep does not record at a path leading to it (`checkPlanFootage`, issue #145 — the latter is fixed by a save, so it needs `saveProject:true` and the saved file is re-read afterwards), and unsaved changes without `saveProject:true` (a clean project is otherwise never saved), resolves aerender from the `appPackage` that answered, forwards `_render_save` only when there is something to save (dialogs suppressed; a save that silently did not happen — read-only, locked, converted — is detected and refused), then hands the plan to `RenderRunner`, which copies the .aep into the OS temp folder (`snapshotProject`) while the lease is still held and renders every item from that copy. When the job ends it takes the lease once more to send `_render_mark_done` for every verified item, which unticks each Render box that still matches by comp and output path, all in one named undo step ("AE MCP: mark rendered") and answers `{jobId, async:true, total, items, note}`. Everything that can refuse does so **before** the save. The job lives entirely in the server — no WS events, no `_continue_job` — and `await_job`/`get_job` read it from the same `JobManager`. `cancel_job` asks `RenderRunner` first and only falls back to the batch path for a jobId it has never seen; a render that would not exit is reported as a failure, never as cancelled, and if it exits later `run()` settles the job then, so `await_job` cannot hang. While a render runs, `exit`, SIGTERM/SIGINT/SIGHUP and stdin closing kill its process group; the handlers are installed only for the length of the render, and a signal is re-raised after the kill when nothing else listens, so the server's own shutdown is unchanged. **The write lease is released when `runRender` returns**, unlike `run_batch`'s `extendUntil`: a batch's chunks run in the live session, so a write between two of them lands inside the batch, whereas a render reads a file finished before it began, and holding every write for the length of a render would protect nothing.
- **Server-resident** (`await_job`, `get_job`, `cancel_job`, `check_setup`, `setup_panel`, `init_project`, `ae_guide`, `log_issue`, `list_known_issues`, `mark_issue_reported`, `archive_issue`): handled in `server.ts`; never forwarded to the panel (except `cancel_job`, which also sends `_cancel_job` to the bridge to set the JSX-side flag). A batch cancel is reported `ok:true` only once the panel has confirmed it **and** the batch's `complete` event with `cancelled:true` has arrived; until then the job is `cancelling`, which is not terminal. Terminal states are sticky — a late `complete`/`fail` is dropped — and a `complete` carrying `cancelled:true` settles the job as `cancelled` with its partial result (issue #158). `await_job` on an id this process never registered fails at once, its timeout says the job is still running, and the request's abort signal releases the wait (issue #159). They're still listed in `OpSchemas` so `tools/list` picks them up — membership in `SERVER_OPS` is what stops the forwarding.
- **Half server-resident** (`snapshot_comp`, `diff_comp`): the panel gathers, the server remembers. `SNAPSHOT_OPS` in `server.ts` routes them to `runSnapshotOp`, which forwards the internal read op `_comp_fingerprint`, keeps the answer in `SnapshotStore`, and for `diff_comp` diffs it against the stored one in `snapshots/diff.ts`. It never calls `_comp_diff`: the fingerprint op is in every bundle ever shipped, so the server-side diff needs no panel update (issue #220). Deliberately *not* in `SERVER_OPS` — unlike those, these do touch the bridge, and they are dispatched from inside the same `try` as `bridge.runOp` so the timeout, `AeError` and Unknown-op mappings all apply unchanged.
- **MCP Apps view** (`snapshot_comp`, `diff_comp`; issue #246): for a client that declared the `io.modelcontextprotocol/ui` extension with `text/html;profile=mcp-app` in `initialize`, and only for one, three things are added — the tool's `_meta.ui.resourceUri` in `tools/list` (the nested form only; the stable spec deprecates the draft's flat `ui/resourceUri`), the `ui://after-effects/comp-timeline.html` resource in `resources/list`, and the view's data on the result's `_meta["engineroom.games/compTimeline"]`. That data is bounded and says what it left out: at most `MAX_VIEW_LAYERS` layers and `MAX_VIEW_MARKERS` comp markers (`layersOmitted`, `markersOmitted`); for a diff, only the changes to layers that are drawn, plus up to `MAX_VIEW_REMOVED` removed layers with their old timing, the rest counted in `changesOmitted`. Markers and the work area are drawn once, in one overlay across all rows, not per row. The text content is byte-identical for every client: `_meta` is what MCP Apps hosts hand the view and keep out of the model's context, which is why the data is not in `structuredContent`, and why the view falls back to a text `fingerprint` only when `includeFingerprint` put one there. The view costs After Effects nothing — both tools fetch the fingerprint anyway — which is the reason it is these two tools: a timeline with keyframe *ticks* would need a per-layer keyframe read on every snapshot. The HTML is one inline page with no network loads and no declared CSP domains, so the host's restrictive default applies, and every project string goes in through `textContent`. `resources/read` serves it to anyone who asks by URI; only the listing is gated. `tests/unit/mcp-apps.mjs` holds both clients side by side.
- **Prose** (`ae_guide`): returns the markdown as a bare text content block rather than through `textResult()`. JSON-stringifying it would hand the model a wall of `\n`. The `whats-new` topic is the one exception to "the body, verbatim": its answer opens with a line naming the server's own version (`packageVersion()`, read from package.json — the guide cannot know it, since a build between releases is ahead of its newest section), and with `since` it is the preamble plus only the sections newer than that version, or one explicit line saying nothing is newer. Without `since` it is the preamble plus the `RECENT_RELEASES` (two) newest sections, and the header names every older release left out and `since: "0.0.0"` as the call that returns the whole history (issue #169 — the full history is ~9k tokens). `since` on any other topic is refused, not ignored. The `ae://guide/whats-new` resource is untouched — still the raw body. See "Release history, and reading it once" in [guidance-system.md](guidance-system.md).
- **Summarised** (`get_house_style`): the panel returns the whole document; `server.ts` runs it through `applyHouseStyleDetail` before packaging, and `detail: "summary"` — the default — replaces `content` with a digest. The one post-bridge transform in the codebase that changes what a *read* answers, so it is the one to remember when a house-style result looks unfamiliar. See "The house style" in [subsystems.md](subsystems.md).
- **Checked first** (`add_to_render_queue`, `import_footage`, `export_mogrt`): `files/destinations.ts` runs the jsx's filesystem checks before the forward, so a refusal never reaches After Effects. The checks have no side effects (a new destination folder is left to the jsx to create), and a call that passes costs no extra round trip. A refusal can now come before one only AE can make; the exact order changes are listed in "Filesystem checks on the server" in [subsystems.md](subsystems.md).
- **Downsampled screenshots**: handled entirely in `vision.jsx`. `saveFrameToPng` *does* respect `CompItem.resolutionFactor` (measured: a 3840×2160 comp yields 1920×1080 at factor 2, 960×540 at factor 4), so `__saveFrameAt` sets the factor, renders, and restores it in a `finally`. That restore is not optional — a throw mid-render would otherwise leave the user's comp at reduced resolution. **Every factor is set, factor 1 included**, and that is the fix for issue #72 rather than an implementation detail: `resolutionFactor` is also the Resolution dropdown in the viewer, so treating 1 as "nothing to do" rendered at whatever the designer had left the comp on. A comp parked at Quarter — routine on anything heavy — answered `downsample: 1` with a quarter-size frame and `downsample: 2` with one four times **larger**. The panel reads the true dimensions out of the PNG's IHDR chunk rather than computing them, so reported size can never disagree with the image sent; that is what kept this invisible, because the response stayed honest while the *picture* was not the one asked for, and an agent that can see a frame believes the frame. An earlier version shelled out to `sips`; it was replaced because rendering smaller is faster than resampling and needs no external tool, which is what makes downsampling work on Windows. The factor is *derived* from the comp when the caller omits one (`__autoDownsample`, aiming at a ~1280px long edge) — which is why `ScreenshotFrame`/`ScreenshotLayer` must not carry a zod `.default(1)`: a default there would reach the panel as an explicit 1 and the derivation would never run. `tests/unit/screenshot-resolution.mjs` holds all three — the explicit factor, the restore (on a throw as well, at 1 as well) and the derivation — against a mock comp whose viewer starts at Quarter.

- **Every JSON result is compact** (`textResult`, issue #166). `JSON.stringify(v)`, never `(v, null, 2)`: the model does not need the indentation, and every result is re-sent on every later turn, so pretty-printing cost 20–56% of each one many times over. Prose (`ae_guide`) and image blocks are unaffected; the files `init_project` writes are for people and stay indented. `tests/unit/tool-annotations.mjs` fails on a result with indentation in it.

## Tool annotations (issue #165)

Every tool in `tools/list` carries `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, from `toolAnnotations()` in `tools/annotations.ts` — derived, never kept per tool, because a write mislabelled read-only is a client approving it without asking.

- **readOnlyHint** is `OpMutation === "read"`, or a `"server"` op that `ServerOpEffect` (next to `OpMutation` in `schemas.ts`, typed over every server op) classifies `"read"`. Not `READ_ONLY_SERVER_OPS`: read-only mode drops `get_job`/`await_job` because nothing can start a job, not because they write.
- **destructiveHint** is true for a non-read-only op that can lose something: a name starting with a removing verb (`delete`, `remove`, `purge`, `revert`, `clear`); `run_jsx` and `run_batch`, which can do anything those can; and any op that can replace a file on disk, outside After Effects' undo — read off the schema (an `overwrite` argument) or from `OpDiskWrite` beside `OpMutation` (`"overwrites"`: `export_mogrt`, `render_queue`, `set_house_style`, `setup_panel`; `"adds"`: `init_project` and the journal writers, which never lose content). `create_*`, `add_*`, `set_*` on the project are reported non-destructive: the spec's letter would flag every `set_*`, but each call is one undo step, and warning on every keyframe edit trains a user to click through the warning that matters on `delete_comp`.
- **idempotentHint** is true for read-only tools and for writes whose verb is `set`, `toggle`, `clear`, `parent` or `reorder` — every one assigns absolute state (each schema checked: values, flags, indices, never deltas). `add_*`, `create_*`, `duplicate_*`, `import_*` are not idempotent; `delete_*`/`remove_*` are left false because a repeat by index can name a different thing.
- **openWorldHint** is false everywhere: nothing here talks to an external service.

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
  the job finished (when the server drives the batch, the driver owns the lease
  and releases it when the batch is over in After Effects — no ceiling, because
  a chunk sent after one had freed the lock would land between other writes) — releasing it when the HTTP call returned would leave
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
client pointed at the same panel gets a queue of its own and neither sees the
other's. Measured on 26.5 (issue #175): After Effects still runs the two
clients' calls one at a time, with no interleaving inside a call — but a call
waiting behind the other client's work says nothing about it, the other
client's writes do land between the chunks of a long `run_batch`, and a timed-out
call still lands afterwards. The front desk, below, is the shared broker that
fixes all three (issue #223). The details are under "Two MCP clients, one panel" in
[fragile-areas-bridge.md](fragile-areas-bridge.md). And the queue is bounded
(`AE_MCP_WRITE_QUEUE_DEPTH`, default 64; `AE_MCP_WRITE_QUEUE_WAIT_MS`, default
600s) rather than unbounded, because an agent looping writes at a stuck bridge
would otherwise grow it without limit.

## The front desk: one queue for every session (issue #223)

Measured on AE 26.5: while ExtendScript runs, the panel answers nothing, not
even `/health`; two sessions' writes interleaved between the chunks of a
`run_batch`, because each server had its own queue; and a wait measured inside
the panel read 0–2 ms while the real one was seconds, because the panel's clock
does not run while it is blocked. So the one place that can serialize sessions
*and* tell a waiting one the truth is outside After Effects — in a server.

**The first server to start becomes the desk.** It binds `127.0.0.1:17777`
(`P+10000` under `AE_MCP_PORT=P`, so two pinned After Effects never share one;
`AE_MCP_FRONT_DESK_PORT` overrides; `AE_MCP_FRONT_DESK=off` opts out) and writes
`~/.engineroom-ae-mcp/desk-<port>.json` — pid, protocol, a fresh token — 0600,
atomically. The bind *is* the election, and that choice is the whole stale-lock
story: a port is exclusive on macOS and Windows and the OS releases it when the
holder dies, so there is never a lock to clean up; the file only carries the
token, and nobody believes it without the port answering with it. A port held
by something that is not a desk, or a desk speaking another protocol (a
different server version), sends the server direct — today's behaviour — with a
warning that says the sessions are not serialized. The file goes on every exit the process can run code on — a normal close, `exit`, SIGINT/SIGTERM/SIGHUP (re-raised afterwards) — and a server's first election sweeps away any desk file whose pid is no longer running, so a SIGKILLed or crashed desk leaves nothing behind for long. Tests that spawn servers point `HOME` at a temp folder or set `AE_MCP_FRONT_DESK=off`; a pinned ephemeral port otherwise becomes a desk on port+10000 in the real home folder.

**What goes through it.** `server.ts` talks to a `SessionLine` instead of the
`WriteQueue` and `HttpClient` directly. A write takes the session's own queue
first — unchanged, so the session's own calls keep the order the agent issued
them — then the desk's lock, and holds both for a `run_batch`'s whole job.
Every `runOp` and `cancel` is forwarded by the desk, reads included, but reads
take no lock: a screenshot must never stall another session's write, for the
reason in "Serializing writes" above. The desk records what it has handed the
panel, in order — the panel's evalScript chain is a FIFO, so that is the order
it runs in — and that record is what "AE is still running session X's
`run_jsx` ahead of you, 12 s so far" is read from.

**What a waiting session is told.** Its position, what is in front, whose, and
for how long — as `notifications/progress` while it waits, when the client asked
for progress (the request is still open, so #82 does not apply), and in the
result as `queuedBehind`/`waitedMs` plus `queuedBehindSession`. A read is
told too: the lease a batch's session still holds is what names it (an older
panel runs the chunks itself, out of the desk's sight; a server-driven batch
sends each one through the desk). A queue timeout
behind another session is a `DeskWaitError`: still a `WriteQueueWaitError`, same
remedy, but it says `get_job` cannot see the other session's work. None of this
appears unless the call waited behind **another** session, so a single session's
results are byte-identical to before; `DeskLock` never reports a session waiting
behind itself, and the composite lease lets go of the desk before the session's
own queue so that cannot happen at the seam either.

**Handover.** A follower that loses the desk — refused, reset, `moved` — tries
the bind itself; one wins and the rest join it. A write in transit is re-sent
only on *proof* it was never forwarded: the connection refused, a refusal
status, or the desk saying `lost`. Everything else — the connection dropped, the
desk stalled — fails the write with `FrontDeskLostError`, a `BridgeResetError`
subclass, so the may-have-run remedy and `server.ts`'s handling are the reset's;
a read is re-sent. The first version re-sent a write that had not yet seen the
desk's `start` line; review found the hole: a desk can post to the panel and be
killed before that line's bytes arrive (on Windows a hard kill drops unsent
socket data), so a missing `start` proves nothing. Queued writes still move
across a handover safely, because a write waits on its *lock* stream, and the op
is sent only once the lock is granted. A lock is an open connection: it frees
itself when its holder's process dies. A session whose lease dies with the desk
while its batch is still running re-takes it at the new desk with `resume`,
granted ahead of everything; if the old desk's file says a long lease
(`run_batch`, `render_queue`) held the lock — `batchHeld`, written only when
that changes, and left in place by a graceful close for exactly this — the new
desk grants nothing else for 1.5 s and says so to whoever waits. A leftover file
from a desk that held nothing makes nobody wait. A lease that cannot be re-taken
is not dropped quietly: the batch's job gets a `warning` that other sessions'
writes may have landed between its steps, and every later write under that lease
is refused unsent (`DeskPlaceLostError`, the write-queue-wait kind). The desk
enforces it too: a write must name the lease holding the lock, or nothing is
sent and the answer is `lost`.

**A desk that stalls without dying** — a suspended terminal, a debugger, a
blocked event loop — keeps the port bound, so nobody can take over. The desk
beats on every open stream (every 2 s; `AE_MCP_FRONT_DESK_BEAT_MS`), and a
follower that hears nothing for five beats gives up on it: a lock wait fails as
`DeskPlaceLostError` (nothing was sent), a write in flight as
`FrontDeskLostError` (may have run), a read is re-sent, and the session goes to
After Effects directly for 10 s before asking again. Never an indefinite wait.
Giving up is only safe if the desk can never forward the call afterwards, and
measured on SIGSTOP/SIGCONT it could: a woken desk reads the queued request
before it notices the requester's closed connection or released lease, so the
lease check passes and the write lands a second time, possibly after the agent's
read-back. So every forwarded call carries a deadline — half the stall threshold
after it was sent, so it always passes before the requester can give up — and
the desk, after yielding once so pending closes land, refuses unsent (`expired`)
anything past its deadline, whose requester has gone, or whose lease no longer
holds the lock — and again before any re-post the panel client makes after a refusal, since its port search takes seconds. Deadlines are on `monoMs()`, the system-wide monotonic clock (checked across processes in the test), so a wall-clock step cannot stretch one; both the deadline and the follower's first stall threshold grow with the request body, since the desk beats only after reading it. A freeze between the last check and the bytes reaching the panel cannot be closed from the desk, so `FrontDeskLostError` says the write may still land later, after a read-back. Four `expired` answers in a row fail as their own message, not as a handover. The leader's own session's calls carry the same deadline. A
follower that was itself blocked reads the beats waiting in its socket before
it calls the desk stalled (a `setImmediate` re-check), so a long synchronous
stretch or a sleeping laptop is not a stall. A 413 is its own error — the
request is too large — not a refusal to re-elect over. On Windows, a new desk
may be unable to bind for minutes after the old one exits, while its closed
connections sit in TIME_WAIT under `SO_EXCLUSIVEADDRUSE`; that is reported as
such and retried every 5 s (recipe 75 checks it).
A follower also joins a desk only after the desk proves it knows the token — an
HMAC of a fresh nonce — so a process that merely answers 200 with the desk's id
is treated as foreign.

**Decided, not inherited.** Jobs stay with the session that started them —
`await_job`, `get_job`, `cancel_job` and the event socket are per server as
before. A batch an older panel drives reports to every server directly, so a
handover loses nothing; one the server drives is driven by its own server
through whichever desk there is, and a chunk lost in the handover is recovered
from After Effects' cursor (see "The batch driver"). The panel version gate stays per session and reads
`/health` directly: every server judges the same running panel against the same
disk, and `/health` is not work the desk could queue. Read-only mode stays per
client: each server refuses before anything reaches the desk, and a read-only
leader still forwards another session's writes. The op timeout is the issuing
session's, sent with the call and applied by the desk, and its clock still starts
at `start` — never in the queue. `createServer` leaves the desk off unless
`frontDesk` is passed; only `index.ts` passes it, so no in-process test ever
joins a real session's desk. `tests/unit/front-desk.mjs` runs real server
processes against a fake panel for all of it.


## The batch driver: a long `run_batch` is driven by the server (issue #220, stage 5)

A chunked batch used to be driven by the panel: `driveJob` sent `_continue_job`
until the job was done and reported over the `/events` WebSocket. It now runs in
`jobs/batchDriver.ts`, so the server owns progress, cancel and the job's state.
Nothing about a chunk changed — each is one `evalScript` with one undo group
opened and closed inside it (issue #69); only who asks for the next one did.

**Negotiated per call, never assumed.** A panel lists `server-drives-jobs` on
`/health`; the server then forwards `run_batch` with `__driver: "server"` on its
args, and the panel strips it (ExtendScript never sees it), sends no chunk of
its own, and answers the envelope with `driver: "server"`. The server drives
only an envelope that says so. Anything else — a stale capability, an older
panel behind the same port, an older desk — gets the old path: the panel drives
and the server follows the event socket. Two drivers on one job cannot happen.
A newer panel talking to an older server is unchanged too: no flag, so the
panel drives. That is why the WebSocket, `ws` and `wsClient.ts` all stay until
older panels have aged out.

**The lease.** The driver owns the batch's lease outright and releases it once
the batch is over in After Effects, cancel included. Every chunk is an internal
write (`InternalOpMutation._continue_job`), so it goes through the desk under
that lease like any other write: a lease lost for good refuses the next chunk
unsent, and the batch stops there.

**What it costs: a dead server stops the batch.** The panel finished a batch
even when the server died; now it stops at a chunk boundary. Every way the loop
can stop is worded with how far it got, and nothing runs an op twice:

- **The cursor is After Effects'.** `_continue_job` runs from the job's own
  cursor, so re-sending it can only ever run the *next* ops. A chunk whose answer
  was lost — the desk died or stalled with it in flight (`FrontDeskLostError`,
  any `BridgeResetError`) — is followed by `_get_job`, a read; the loop carries
  on from the cursor it reports and the job carries a `warning` saying so. If the
  lost chunk was the last one, the job is over in After Effects, its per-op
  results are lost, and the job fails with the tombstone's counts.
- **A chunk that timed out is not followed.** It may still be running; the job
  fails with `unsureThrough` and the job is cancelled so no later continuation
  can run more of it. `_continue_job` uses the slow-op limit (300 s).
- **A session that closes** stops its batch at the next boundary and cancels it:
  after `close` the line no longer holds the desk, and a chunk sent then would
  bypass every other session.
- **A server that is killed** leaves the job in ExtendScript, not running.
  Nothing resumes it. `await_job`/`get_job` in any other server process, or in
  the restarted one, answer an id they never registered from `_get_job`
  (`foreignJobText`): how far it got, how long since its last chunk, and that
  nothing in this process will continue it. The orphan is retired after 30
  minutes without a continuation (`__sweepOrphanJobs`), and the panel stops
  counting it against `/reload-jsx` after 10.

A batch longer than the desk's hold ceiling (~21 minutes by default) still has
the lock freed under it once; its next chunk re-takes the lease with priority.
That limit predates this change.

## Tool switches: read-only mode and `run_jsx` (issue #135)

Two environment variables decide, once at startup, which tools a server
offers. `AE_MCP_READ_ONLY` offers only the tools that look;
`AE_MCP_DISABLE_RUN_JSX` offers everything but `run_jsx`. Both default off, and
with both off every carrier — `tools/list`, `instructions`, guides, prompts — is
byte-identical to a server without the feature. The `.mcpb` exposes them as two
checkboxes (`user_config` in `scripts/build-mcpb.mjs`). All of it is in
`tools/policy.ts`; `server.ts` only asks it.

**A switched-off tool is not registered.** A tool that is listed and refuses
is one the model plans around, calls, and then explains away; a tool that is
absent is one it never reaches for. The call handler refuses one anyway —
a client may hold a list from before a restart, and a model may try a name it
read in a guide — with a sentence that says nothing ran and that this is the
user's configuration, not a failure. That refusal is deliberately not
annotated from the issue journal, for the same reason `Unknown tool` is not.

**What read-only takes away is decided per op, not inherited.** The
`OpMutation` table answers "does this op queue behind a write", which is close
to the read-only question and not the same one. Every `"write"` goes, because
every one changes the project. `"server"` covers a guide lookup and a panel
installer alike, so each server op has its own entry in
`READ_ONLY_SERVER_OPS`, typed so the compiler refuses a new server op until
someone decides it — the same no-default rule as `OpMutation`, for the same
reason. As decided:

- **Kept:** `ae_guide`, `check_setup` (it only probes), `list_known_issues`.
- **Gone because they write files:** `setup_panel` (installs the panel, can
  flip Adobe's debug preference), `init_project`, and the three journal writers
  `log_issue`, `mark_issue_reported`, `archive_issue`.
- **Gone because nothing can start a job:** `await_job`, `get_job`,
  `cancel_job`. Only `run_batch` creates a job, and it is a write; offering
  three tools that can only answer "no such job" is noise in every
  `tools/list`.

The promise read-only mode makes, then, is *nothing you call here changes the
After Effects project or writes a file a person would look for*. Two things sit
just inside that line and are deliberate. A screenshot borrows the comp's
resolution factor and restores it, which can leave one net-nil undo step
(#116), and writes its PNG to the temp directory. And a failed call still
stamps `lastSeen`/`lastVersion` on a matching journal entry
(`annotateFailure`) — bookkeeping the model does not control and cannot aim.

**A `run_batch` step is a tool call by another route.** `batch.jsx` looks
each `op` up in the ExtendScript `OPS` table and calls it, so
`{op: "run_jsx", args: {code}}` inside a batch runs the script exactly as
`run_jsx` would. Since issue #157 every step is also *validated* as that tool
would be — see "Arguments are closed, and batch steps are held to them"
below — but the policy check runs first and on its own. With any switch on, `server.ts`
checks every step against the disabled set before forwarding and refuses the
whole batch, naming each offending step by path — refusing whole, because a
batch that ran its first half and then stopped is the half-built result this
repo refuses elsewhere. In read-only mode `run_batch` itself is gone, so this
only ever fires for the `run_jsx` switch, but it checks the full disabled set
so a third switch would not need to remember it.

**No tool argument may carry a `__proto__`, `constructor` or `prototype`
key, at any depth, for any op** (`util/argsSafety.ts`, checked on the raw args
before anything else reads them). In JSON, and to every check on this side of
the bridge, `__proto__` is an ordinary own key. ExtendScript parses the
payload again, with its native `JSON.parse` or `core.jsx`'s
`eval("(" + text + ")")` polyfill, and in an object literal that key sets the
prototype. So `run_batch{ops:[{op:"run_batch",args:{"__proto__":{ops:[{op:"run_jsx"}]}}}]}`
showed the batch walk an inner batch with no `ops`, and may have shown
`batch.jsx` one that inherited a `run_jsx` step. Which parser AE 2026 uses, and
what it does with the key, is unmeasured, so the key never reaches either. The
scope is every op rather than `run_batch` alone. zod strips unknown keys from a
declared object, but `z.unknown()` and `z.record()` fields (batch steps,
and `create_shape_layer.shapes` until #148 removed it) pass anything through, and a changed prototype
misleads any handler that reads a field. No schema uses these names. The walk
is one pass over a payload already in memory, bounded at 64 levels.

How the panel embeds the args was checked too, and needs no change.
`runOp` in `main.js` passes `JSON.stringify(JSON.stringify({op, args}))`: the
payload is a JS *string* literal handed to `dispatch()`, which parses it. A
value cannot close that literal, because quotes, backslashes and control
characters are all escaped. The one character that slips through is U+2028/9,
which ES3 treats as a line break inside a string literal. That fails the
`evalScript` with a syntax error rather than running anything.

**The walk descends into nested batches, because `batch.jsx` runs them.** A
`run_batch` step is an op like any other, so
`{op:"run_batch", args:{ops:[{op:"run_jsx", …}]}}` put the script one level
down, past a check that only read the outer list — the first version of the
check had exactly that hole, found by a stdio run in review. `refusedBatchSteps`
now recurses into every `run_batch` step's `args.ops` and reports each hit by
path (`ops[0].args.ops[1]`). It runs before the steps are validated, so the
walk refuses what it cannot read with certainty instead of assuming it
harmless: an inner `ops` that is present but not an array (ExtendScript
iterates an array-like object happily), nesting deeper than `MAX_BATCH_DEPTH`
(8), and an array reached twice. The batch loops in `batch.jsx` are the only
places in the bundle that dispatch `OPS[...]` by a caller-chosen name;
`core.jsx`'s `dispatch()` is the panel's own entry, reached only through the
tool list.

**The guidance names every tool and cannot know which were registered.** The
guides are generated once, at build time. So when a switch is on,
`policyNotice()` is prepended at runtime to `instructions`, every `ae_guide`
answer, every guide resource and every prompt: a short paragraph saying which
tools are absent and that the model should tell the user rather than route
around it. The Claude Code skill is the one carrier the server cannot touch at
runtime, so the core guide (`after-effects.md`) and `extendscript-gotchas.md`
also carry one static sentence each saying the same. The notice takes
`instructions` past the 1,500-character ceiling in
[guidance-system.md](guidance-system.md) — accepted, because it is paid only by
a user who switched something off, and it is the one thing that session most
needs to know.

**Parsing fails closed, with one exception.** `parseSwitch` reads the usual
on/off spellings; anything unrecognised is *on*, with a stderr warning,
because these are safety switches and `AE_MCP_READ_ONLY=enabled` meant it. The
exception is an unexpanded `${user_config.<key>}` placeholder, which is *off*:
the `.mcpb` maps each switch to exactly that, and a client that ever passed it
through literally would otherwise put every Claude Desktop install into
read-only mode with nobody having asked. Only that form is excused, because
only that form is one this project writes. Any other `${…}` — `${READ_ONLY}`
from a shell config that did not expand, another tool's template syntax — was
put there by a person who may well have meant "on", so it falls through to the
fail-closed rule with the same stderr warning as any unrecognised value. The
cost of being wrong that way is a session with fewer tools and a log line
saying why; the cost the other way is a switch silently not applied.

**The `.mcpb` manifest's tool list cannot follow the switches.** Its `tools`
array is static metadata, written at build time and shown by Claude Desktop
before the server ever runs; `user_config` values are substituted into the
server's environment, not into the manifest. So it lists all 88 whatever is
ticked. What the model actually gets is `tools/list` from the running server,
which does follow them.

**What the switches are not.** They restrict what *the model* can do through
this server. They do not restrict the panel: its HTTP bridge still accepts
every op from anything holding the per-port token (#106), and a second MCP
server started without the switch has every tool. They are a scope on an
agent, not a sandbox around After Effects. `tests/unit/tool-policy.mjs` holds
the lists, the refusals, the batch check and the notice through the real
server against a stub bridge.
