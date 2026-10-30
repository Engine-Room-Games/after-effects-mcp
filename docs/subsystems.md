# Subsystems

Five things this server does that are not simply "forward an op": gating on the
panel's version, scaffolding a project folder, reading a house style, keeping
comp fingerprints, and carrying a journal of known problems between sessions.
Each one exists for a reason that is easy to undo by accident, so the reasoning
is here rather than in the code.

Back to [CLAUDE.md](../CLAUDE.md).

Numbered recipes referenced below are in [verification-recipes.md](verification-recipes.md).

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

1. **The gate (`bridge/panelGate.ts`, called from `server.ts`)** — `/health`
   cached; refuses to forward and returns the remediation. A healthy verdict is
   re-checked every minute, a stale one every few seconds. `panelGate.invalidate()`
   after `setup_panel`, because the disk half of the comparison just changed, and
   on `WsClient.onReopen`. **A stale verdict must never be cached for good**
   (issue #156): restarting After Effects rebinds the *same* port, so no port
   change fires, and a verdict kept until one did told the user to restart After
   Effects for the rest of the session after they had. An unreachable `/health`
   drops the verdict (that is `runOp`'s error to report); a timeout keeps it (a
   busy AE is still the old panel). `tests/unit/panel-gate.mjs` pins all of it.
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

**The hash names the ExtendScript; `capabilities` names the panel code.**
`bundleHash` says nothing about `client/main.js`, and a bundle can be current
while the panel code beside it is not. Since issue #220 (stage 3) `/health`
also lists `capabilities`, the only word on which panel code is answering.
`setup/panelCapabilities.ts` reads it, and the gate keeps it with its verdict
and drops it whenever it drops the verdict (invalidate, port change,
unreachable), so a panel nobody has asked yet counts as legacy. **A missing or
malformed field means "legacy", never "broken".** It gates nothing: a
capability only switches the server onto a path that needs it, and every
panel without one keeps the path it always had. The server still falls back
on `Unknown op:` for the op behind a capability, since the list is static in
`main.js` and stands for an op in the bundle installed beside it — and then
withdraws the capability (`panelGate.withdraw`) until the verdict is next
dropped, so the extra round trip is paid once, not on every call.

Internal ops (`_project_path`, `_render_save`, …) are sent only through
`internalSender` in `tools/internalOps.ts`. Its op name is typed over
`InternalOpMutation`, and a `"write"` is refused unless the write lease is
held — internal ops never pass the tool path that takes one.

| Capability | What the server does with it |
|---|---|
| `project-path` | Asks `_project_path` for the .aep's path and reads/writes `house-style.md` itself. |
| `server-images` | Sends `_screenshot_frame`, `_screenshot_layer` and `_export_mogrt`, which answer with ExtendScript's temp paths, and waits for, normalises, tiles and patches the files itself (`frames/pipeline.ts`). The panel's own processing stays for older servers; see "Screenshots and frame integrity" in [fragile-areas-bridge.md](fragile-areas-bridge.md). |
| `server-run-jsx` | Builds `run_jsx`'s wrapper itself (libraries inlined, the #221 undo rewrite, the eval/Function/`$.evalFile` scan) and sends `_run_jsx`; a failure comes back with `rawLine`/`wrapperLine`/`libraryIndex` and the server maps it onto the caller's file (`tools/runJsxAssembly.ts`). ExtendScript keeps each library's parse check and the `Error.source`/`start`/`end` reading. `OPS.run_jsx` stays for older servers and for `run_batch` steps; see "`run_jsx` assembled on the server" in [architecture.md](architecture.md). |
| `server-drives-jobs` | Forwards a long `run_batch` with `__driver: "server"` and, only when the envelope answers `driver: "server"`, sends each `_continue_job` itself (`jobs/batchDriver.ts`). Any other envelope is driven by the panel as before; see "The batch driver" in [architecture.md](architecture.md). |

**Install before AE is open.** The panel loads at launch and only at launch, so
installing while AE is closed costs no restart. `check_setup` reports
`afterEffectsRunning`, and the guides, the `init-after-effects` prompt and
`setup_panel`'s description all branch on it. When changing that advice, change
all four.

**The verdict is about the panel on one port.** Since 0.5.0 the bridge client
can move (issue #92 — see "The port file is not the authority" in
[fragile-areas-bridge.md](fragile-areas-bridge.md)), and a verdict cached about the panel on 7780 says nothing about
the one now answering on 7777. `createPanelGate` subscribes to
`bridge.onPortChange` and drops both the verdict and the recheck clock when the
port changes; `WsClient` follows the same event and reconnects. Anything else
that ever caches the port, or anything derived from `/health`, must subscribe
too — the port is the one input to this gate that used to be a constant.

**A self-signed install is a current install.** The #91 workaround leaves
`META-INF/signatures.xml` and `mimetype` in the extension folder.
`panelInstallDiff` walks the source tree only, so those are invisible to it and
`installComplete` stays true; a diff that counted extras would report every
signed install as `partial-install` and send the user to reinstall, which
strips the signature that made the panel load. `tests/unit/panel-install.mjs`
pins it.

## The project scaffold

`init_project` and `npx … init` both call `scaffold()` in `setup/scaffold.ts`.
The tool exists because **the server writing the files is the only design that
works everywhere** — Claude Desktop gives its agent no filesystem tools, so
"tell the agent to write these files" fails there entirely.

Three things it has to get right:

- **Where.** Explicit `dir` → the client's `roots` → `process.cwd()`. It refuses
  the filesystem root and the home directory outright — **however they were
  arrived at**, an explicit `dir` included — because Claude Desktop starts
  servers at `/` and scaffolding there is never what anyone meant. The error
  tells the agent to ask the user, which is the correct next move. Until
  2026-09-08 only the cwd fallback was guarded, and the live pass found
  `init_project({dir: "/Users/x"})` writing `AGENTS.md` and `renders/` into a
  home directory; `refuseUnscoped()` in `scaffold.ts` now sits behind all three
  sources, and `tests/unit/scaffold-marker.mjs` pins it.
- **Which layout.** `server.getClientVersion()` carries the client's name
  through the MCP handshake, so `detectClient()` picks `CLAUDE.md` vs
  `AGENTS.md` vs `.cursor/rules/` without asking the user what they are running.
  `AGENTS.md` is always written; the client-specific file is a pointer to it,
  never a second copy.
- **Never clobber.** It checks every path first and writes nothing if any
  exists. An agent calling this does not know what is already there.

And one line it has to stamp: `AGENTS.md` carries
`Tools version last absorbed: <version>` under a `## Tool updates` heading —
the marker the absorb-release prompt reads after an upgrade to fetch only what
changed since, and rewrites when it is done (see "Release history, and reading it once" in
[guidance-system.md](guidance-system.md)). The version comes from `packageVersion()` **at call time**, never a
literal: the marker has to say what the user actually installed, or the first
absorb pass re-reads releases the project was scaffolded on. It is a plain,
human-readable line on purpose — designers open AGENTS.md in a text editor, and
a line they can read is one they will leave alone. The pointer files do not get
a second copy, for the same reason they are pointers. `ABSORBED_MARKER_PREFIX`,
`absorbedMarkerLine()` and `absorbedVersionIn()` in `scaffold.ts` are the one
definition of the line; `tests/unit/scaffold-marker.mjs` asserts it through
both entry points, and that never-clobber still holds — a re-run silently
resetting the recorded version to the current one would skip a release.

The house style is deliberately *not* part of the scaffold — see below.

## The house style

`house-style.md` lives next to the `.aep`. Where it is *found* has always
been the bridge's job: the bridge is the one channel every client has, so
asking After Effects for the project's path needs no working directory, no
`roots` and no filesystem tools on the client, and works identically in Claude
Desktop and in a source checkout. A file found any other way would need a
project folder, and the clients that need help most are exactly the ones
without one.

Where it is *opened* depends on the panel (issue #220, stage 3):

- **A panel reporting `project-path`** answers `_project_path` — the .aep's
  path and saved state, nothing else — and the server reads and writes the
  file itself (`style/houseStyleFile.ts`). No file I/O on AE's main thread.
- **Every other panel** (legacy, or one that answers `Unknown op:` after all)
  gets `get_house_style` / `set_house_style` exactly as before, and
  `packages/jsx/style.jsx` opens the file.
- **A folder the server cannot see** goes to the panel's op too. On macOS,
  privacy access to Desktop, Documents and removable or network volumes is
  per app, so After Effects can be allowed where the server is not. A guide is
  "not there" only when the .aep beside it is visible to the server; any other
  failure to read, or an `EACCES`/`EPERM` at open on a write, is the panel's
  to try, and nothing was written by then.

The server's copy is a port of `style.jsx` with the same sentences and result
shapes, and `tests/unit/panel-capabilities.mjs` holds them to each other on a
real folder, BOM, CRLF and non-ASCII included. Both write every line ending
as LF: measured on AE 26.5, `style.jsx` (`lineFeed = "Unix"`) turns a
caller's `\r\n` and bare `\r` into `\n`, so the server normalises the same
way before writing. The jsx copy stays: older
servers use it, and `set_house_style` as a `run_batch` step goes straight to
ExtendScript. Change both together.

The costs, both reported rather than worked around:

- **The project must have been saved once.** `app.project.file` is null until
  then and there is no folder to write into. `get_house_style` returns
  `projectSaved: false` with an explanation; `set_house_style` throws it.
- **`set_house_style` replaces the whole file** and requires `overwrite: true`
  to replace an existing one. It is not a patch, and quietly half-rewriting
  someone's hand-written style guide is worse than refusing.

**Why `_project_path` and not `get_project_summary`.** Stage 2 of #220 left
the I/O on the panel because no cheap op reported the path:
`get_project_summary` does, but walks every project item on AE's main thread
and checks each one for being a checkpoint. Paying that on every style read,
on a large project, to save one small file read would have made the call
slower. `_project_path` reads `app.project.file` and `app.project.dirty` and
nothing else.

### The summary, and why it is not on the panel

`get_house_style` answers with a digest by default (`detail: "summary"`), and
returns the document only when asked (`detail: "full"`). The reason is what
people did without it: an established guide got heavy enough that projects put a
rule in their own build notes telling sessions *not* to call the tool and to read
a hand-maintained 40-line digest instead — so the digest and the source drifted,
and "one cheap call" was neither (issue #59).

**Summarising is a separate question from where the file is opened**, and
`style/summary.ts` answers it on the server whichever side read the document,
for two reasons:

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

### Reading a motion style off existing comps

`analyze_motion` (issue #244) turns keys a designer already made into numbers
for the Motion section: how long a move takes, which ease influence they reach
for, how far things overshoot and how fast they settle, the stagger between
layers. It never writes the guide — the style-guide topic has the agent show
the user what it found and call `set_house_style` only once they agree, the
same "adjectives from you, numbers in the file" flow as reading colours off a
layer.

It is split the way `diff_comp` is. `_motion_keys` (`packages/jsx/motion.jsx`)
does plain reads — one compact array per key, the first ease entry of each
side, the value only when it is numbers — and `style/motion.ts` computes every
statistic. Two reasons, both the summary's: the statistics will be tuned, and a
tuning in the bundle would be dark until a panel reinstall and an AE restart;
and they are arithmetic over arrays, testable with no AE
(`tests/unit/motion-style.mjs`, which also drives the gathering op against the
fake AE). The raw keys never reach the agent: a tool result is re-sent on every
later request, so the answer is a digest with fixed caps (8 properties, 4 ease
pairs, 5 staggers), and a `run_batch` step — which would return the raw keys —
is refused.

The vocabulary is the designer's, not After Effects': a **move** is a run of
changing keys with no hold between them, so `0 → 108 → 100` is one move with an
8% overshoot, not two segments. Overshoot is measured against the move's last
key along the travel from its first, so a bounce (`0 → 110 → 97 → 100`) is one
overshoot with a bounce rather than two overshoots. A reversal counts as
overshoot only when it goes at most half the travel past the target and settles
no slower than it got there (and a wind-up only at a move's first key, by the
same bound); anything else splits the run into two moves, so `0 → 100 → 50`
never reads as a 100% overshoot. Keys outside a layer's in/out are ignored and
counted, markers are passed over, and a separated master Position is not read
beside its X/Y/Z. Everything heuristic says
what it cannot see: expressions are skipped and counted, motion-path shape and
per-dimension eases are not read, nested precomps are not followed, and fewer
than eight moves come back marked as a hint rather than a pattern.

Unmeasured live: that `keyTime` answers comp time for a layer whose
`startTime` is not zero (a stagger built by sliding layers depends on it), and
how long the read takes on a large comp — `maxKeys` (default 2000) is the
bound, and hitting it is reported.

## Filesystem checks on the server

Three ops check the filesystem before they touch the project, and since issue
#220 (stage 2) the server makes those checks before it forwards the call
(`files/destinations.ts`):

| Op | Checks | Ported from |
|---|---|---|
| `add_to_render_queue` | `outputPath` is absolute, its folder exists, an existing file needs `overwrite` | `render.jsx` |
| `import_footage` | the file exists | `footage.jsx` |
| `export_mogrt`, with an explicit `destDir` and `name` | the name resolves into the folder, an existing template needs `overwrite` | `mogrt.jsx` |

Two `export_mogrt` checks stay with the jsx alone: creating a folder that does
not exist yet, and testing that the folder accepts writes. Both write into the
user's folder. A server killed mid-probe would leave its test file behind, and
a file already at the probe's name would be emptied and deleted.

**The aim is for these checks to end up on the server only.** For now the jsx
checks stay and still run, because the panel does not update itself and the
bundle hash is half the version gate: editing a jsx file would tell every user
to reinstall the panel and restart AE. So the server makes the same checks
first, with the same sentences, and the jsx repeats them for the cost of a stat
or two. A refusal now comes from the server and its wording can be fixed
without a restart. `tests/unit/destination-checks.mjs` holds each port to its
jsx on real folders, and its header lists the `File` behaviour only a live AE
can confirm. The jsx copies also still guard these ops as `run_batch` steps,
which go straight to ExtendScript. A server refusal reads
`AE: <the same sentence>` without the old `(line N)`, which was a line in the
concatenated bundle.

**No side effects.** A server check only reads: a `stat`, and nothing else. It
never creates, writes or removes anything, so a refused call leaves nothing on
disk that the jsx alone would not have left.

**"Not allowed to look" is not "missing".** Only a definite `ENOENT` or
`ENOTDIR` refuses (`pathState()` in `destinations.ts`). It counts as definite
only when the path's root (the drive, the UNC share, or `/`) is itself visible.
Windows reports a mapped drive that the server's logon session cannot see as
`ENOENT`, not `EACCES`, so a missing or erroring root means the server cannot
tell. `EACCES`, `EPERM` and
every other failure to look forward the call, and the jsx decides. The server
and After Effects are different processes with different access. On macOS,
privacy access (TCC) to Desktop, Documents, removable and network volumes is
granted per app, so AE can see a folder the server is not allowed to look into.
On Windows a mapped drive can be invisible to the server's process while AE
sees it. `tests/unit/destination-checks.mjs` checks this with a real `EACCES`,
with simulated `EPERM`, `EIO` and others, and with a simulated root that is
itself missing.

**A check runs only where Node and ExtendScript's `File` read the path the same
way.** `File` decodes `%XX` escapes, reads `~` as the home folder, and on
Windows reads a leading `/c/` as a drive. A path that could mean two things is
not judged by the server at all: it is forwarded untouched, and the jsx decides
as it always did. A skipped check is never a refusal.

**No extra round trip.** Every check is a stat on the server, and nothing is
asked of After Effects first. The one AE question that would help,
"where is the .aep?", has no cheap answer in an installed bundle (see the house
style above), so `export_mogrt` without `destDir`, which defaults to the .aep's
folder, is left entirely to the jsx.

**Refusal order: what changed.** Every sentence is unchanged. What can change is
which refusal comes *first* when a call has more than one fault, because the
server's checks now run before checks only After Effects can make. In full:

- **`add_to_render_queue`:** the jsx looked the comp up first. A `compId` that
  is not a comp *and* a bad `outputPath` now reports the path, then the comp
  once the path is fixed.
- **`export_mogrt` with `destDir`:** the jsx refused three things before any
  destination check: a comp that does not exist, a project never saved, and an
  empty Essential Graphics panel (#71). Any of those *and* a bad destination
  now reports the destination first.
- **`export_mogrt` with `destDir` and no `name`:** no change. The template
  name is read off the comp, so the server checks nothing and the jsx makes
  every check in its own order.
- **`export_mogrt` into a folder that does not exist yet:** the jsx created the
  folder first and reported "Could not create the destination folder" before
  checking the name. The server checks the name without creating anything, so
  a name that escapes the folder *and* a folder that cannot be created now
  reports the name first.
- **`import_footage`:** no change. The file-existence check was already first.

**The SVG viewBox check (#33) did not move.** It compares the viewBox against
the *imported item's* size and removes the item when they disagree, and both of
those need After Effects. Only the 16 KB read and the regex could leave, and
the jsx has no way to receive a parsed viewBox without a bundle change.

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
wants to keep. `SnapshotStore` is the other half: besides `JobManager` and the
write queue's in-flight leases, it is the only thing this server remembers.

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
- **`diff_comp` diffs on the server; `diff:true` still diffs in AE** (issue
  #220, stage 1). Only the gathering needs After Effects, and the comparison
  ran on AE's main thread and could only be fixed with a panel reinstall. So
  `diff_comp` asks for a fresh `_comp_fingerprint` — in every bundle ever
  shipped, so no panel update is needed — and diffs it in
  `snapshots/diff.ts`. That leaves two copies of the diff until `diff:true`
  returns its before/after fingerprints too; `tests/unit/comp-snapshot.mjs`
  runs every case against both and a seeded parity sweep compares their
  serialized output byte for byte. `_comp_diff` stays in the bundle, unused,
  so a newer panel never breaks an older server that still calls it.
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

## Comp checkpoints, and why a revert is not a swap

`snapshot_comp` / `diff_comp` say what changed; nothing said how to get back.
After Effects' undo is not a way back an agent can rely on across many calls —
a group does not survive an `evalScript` boundary, a chunked batch is many
steps, and the user's own edits interleave with ours (issue #69, and the undo
notes in [fragile-areas-ae.md](fragile-areas-ae.md)). Issue #136 weighed three
designs:

- **A project-level checkpoint** — save a copy of the .aep, reopen to revert.
  Complete, but it reloads the project under the user, and every id in the
  session is meaningless afterwards. Rejected.
- **A snapshot-driven rebuild** — extend the fingerprint until it can recreate
  the comp. That means serializing every property value, effect, mask, shape
  and expression: `get_layer_full` for every layer, then a writer for all of
  it. The most work and the most fragile. Rejected.
- **A comp-level checkpoint**: `CompItem.duplicate()` into a folder. Chosen,
  and the question that decided its shape was what a *revert* does to ids.

**The obvious revert is a swap, and a swap breaks the agent.** Swapping the
checkpoint in for the original (rename it, `replaceSource` every usage,
remove the original) gives the comp a new id. The comp id is the agent's
long-lived handle — it is in the conversation, in the project's own notes, in
the next call — so a revert that silently changes it breaks every call after
it, and one that returns the new id loudly still leaves stale ids in context.
It also has to re-link everything that points at the item: precomp layers in
other comps (`usedIn` + `replaceSource`, doable), and the render queue and
Essential Graphics, which cannot be re-pointed from script at all.

**So `revert_comp` restores *into* the original comp.** The item never moves:
its id, its name, every precomp usage, every `comp("Name")` expression and
every render-queue entry are untouched by construction, and there is nothing
to re-link. What does change is every **layer** id — the restored layers are
copies — and the result says so and maps them: `layerIdMap` takes the ids the
comp had when the checkpoint was taken (recorded in the checkpoint's tag,
position by position, because `duplicate()` preserves order) to the restored
ones. A layer id read *after* the checkpoint has no counterpart and is not in
the map, which is correct: that layer no longer exists.

How the restore is ordered, and why:

- **Copy first, then remove.** Every checkpoint layer is copied in with
  `copyToComp` before any current layer is touched. A copy that fails removes
  the copies already made and throws saying the comp is as it was. Only when
  all of them have landed, been put in order (`moveToBeginning`, last to
  first, since copies land in an order of their own — see the gotchas guide)
  and been re-parented are the old layers removed. A failure there names the
  layers still present and says a second revert is safe, because a revert
  never modifies the checkpoint.
- **Copied with the parent detached, re-parented with the jump.** Measured on
  26.5: copying a parented layer into a comp that holds a layer of its parent's
  name parents the copy to that namesake and converts its Position keys to comp
  space — the transform applied twice, a visible jump that no fingerprint
  sees, because it does not compare keyframe values. So each parented
  checkpoint layer is unparented with `setParentWithJump(null)` (its own values
  untouched), copied, and re-parented the same way, always — a checkpoint left
  unparented would be a damaged restore point, so that failure is an error.
  The restored layer is then parented with `setParentWithJump` too: plain
  `parent =` would compensate the values. The jump form is exactly "attach
  without touching the values".
- **Names are put back.** `copyToComp` appends " 2" to an explicitly named
  layer when the destination already holds that name (measured, 26.5), and the
  old layers are all still there during the copy, so every unchanged rig layer
  came back renamed. Once the old layers are gone each restored layer whose
  name differs from the checkpoint's is renamed; a layer named after its source
  already matches and is left unnamed.
- **A missing item is `null`, never an exception.** On 26.5 `itemByID` of a
  deleted id throws "internal verification failure {Item Not Found}", so a
  checkpoint whose comp was deleted made `list_checkpoints` fail for the whole
  project. Every lookup goes through `__findItem` (`ids.jsx`), which
  `getCompById` and `delete_comp`/`duplicate_comp` now use too.
- **An explicit `compId` can re-bind an imported checkpoint.** Importing a
  project renumbers every item, so its checkpoints name ids that are gone or
  belong to something else. `revert_comp` accepts a `compId` that differs from
  the record when that comp has the recorded name — the same comp under a new
  id — and rewrites the record to it (`checkpointRebound`); a differently named
  comp is still refused. The name is evidence only while the recorded comp
  cannot be the answer: AE allows two comps called "Main", so a namesake is
  refused while the recorded comp still exists under its recorded name. And
  the record is rewritten only after a revert that verified clean; one that
  did not is no evidence it was the right comp. Track mattes (2023+ `setTrackMatte`) and locks are re-applied the
  same way, explicitly, and a matte that cannot be re-pointed lands in
  `notRestored` rather than failing the call.
- **The undo group is tried, then given up per layer.** `copyToComp` refuses a
  parented or expression-linked layer while a group is open (issue #30). Each
  copy is attempted inside the dispatcher's group and only on that refusal
  retried through `withoutUndoGroup`. An unrigged comp reverts as one step; a
  rigged one reports `undoSplits` and tells the agent not to Cmd-Z it.
- **Verified, and the verdict names its scope.** Both comps are fingerprinted
  with `snapshot.jsx`'s walk, parent ids are rewritten as parent indices, and
  the layers are compared position by position with the diff's own
  `__diffLayer` — plus what the fingerprint does not record but a revert must
  get right: locks, shy/solo/3D/adjustment/motion-blur switches, blend mode,
  quality, label, stretch, track matte and type, every layer/mask pick, and
  every restored comp setting including background colour and pixel aspect.
  It does **not** compare keyframe values or other effect parameter values;
  the result carries `checked`, the exact list, beside `verified`, and the
  note says so on a clean result too. Any difference is `verified: false`
  with `mismatches`, said first. `keepCheckpoint:false` is not honoured on a
  revert that did not verify.
- **The comp name is not reverted.** Other comps' expressions find this one by
  name; restoring an old name would break them. A changed name is reported as
  `nameAtCheckpoint`.
- **But a changed name stops a revert that was not confirmed.** The record
  holds an item id, and ids are unique only within one project: a checkpoint
  that came in with an imported .aep can name an id that here belongs to an
  unrelated comp. So when the target's name differs from the recorded one,
  `revert_comp` refuses unless the caller passes `compId` to confirm.
- **Comp settings go first.** Size, rate, duration and the rest are written
  before any layer is copied in, so nothing is copied against the wrong
  timeline; a failed copy puts the previous settings back with the copies.
- **Effect layer picks are re-pointed after the removal.** Layer Control,
  Displacement Map, Set Matte and the like pick a layer by index, and a text
  path picks a mask the same way. While the copies land the old layers still
  exist, so a copied pick points at an old layer, or at nothing once those
  go. After the removal the restored layers sit at exactly the checkpoint's
  indices, so every `LAYER_INDEX` / `MASK_INDEX` property under Effects and
  Text is set from the checkpoint's value, keyframes included
  (`layerReferencesRepointed` counts them).
- **Lookups go through a mirror of the layer order.** A layer reference is
  index-bound, so every layer is re-resolved by id after anything that moves
  one; scanning the comp per lookup made a revert O(n²) DOM reads. The mirror
  keeps the id order in plain JS, updated on every move, insert and removal
  the op makes, and confirms each lookup with one read — rescanning only on a
  mismatch, so it can be stale but never wrong.

What a checkpoint is, in the project:

- A comp named `<name> [checkpoint <label>]`, in one folder,
  `AE MCP Checkpoints`. The suffix keeps it from ever answering
  `comp("<name>")`; the folder keeps it out of the user's own bins and is
  removed by `delete_checkpoints` once empty.
- **Identified by its comment, not its name.** The item comment carries
  `ae-mcp-checkpoint:v1 ` and a JSON record (comp id and name, label,
  sequence, time, layer ids). A user may rename the item; the tag survives.
  `duplicate_comp` clears the tag on a copy of a checkpoint, because that copy
  is the documented way to recover a checkpoint whose comp was deleted and it
  must not show up as a second checkpoint.
- **Shallow, and it says so.** It is a copy of one comp: nested precomps are
  shared, not copied, so an edit inside one survives a revert. `covers`
  travels with every checkpoint and revert result for the same reason it does
  with a diff. A deep checkpoint is possible (`duplicate_comp`'s `deep` walk)
  but a deep *revert* would have to restore every nested comp in place too;
  that is a follow-up if anyone needs it.
- **Kept out of searches, flagged in the map.** `find_layers` across the
  project skips checkpoint comps and counts them in `checkpointsSkipped` —
  otherwise every match comes back twice, and an agent editing the copy has
  edited the restore point, not the scene. `list_comps` and
  `get_project_summary` list them with `checkpoint: true`: hiding comps from
  the map an agent orients with would be the bigger lie.
- **Layer picks are not keyframed or expression-driven on 26.5.** A Layer
  Control's pick has `canVaryOverTime` false and refuses an expression
  (measured), so the re-point sets a static value and names a keyframed pick
  in `notRestored` rather than carrying code for a case that cannot occur.
- **The write ops do not refuse a checkpoint comp.** It was considered. The
  only central place for that guard is `getCompById`, which every read and
  `duplicate_comp` (the recovery path) also use, so it would need an
  allow-list across some sixty ops for a mistake the flag, the name and the
  `find_layers` skip already make hard to make. And an edited checkpoint is
  still a valid restore point — it restores what it now holds, and the
  revert's verification compares against that.
- **They keep their footage alive.** A checkpoint's layers use the same solid
  and footage items as the original, so `purge_unused_footage` and
  `delete_comp({purgeUnusedSolids})` correctly treat those items as in use.
  Deleting checkpoints is what frees them.

`tests/unit/comp-checkpoint.mjs` holds all of the above against a stub whose
`copyToComp` follows the measured rules; what only AE can answer is in
recipes 47–50.

## The issue journal

`log_issue` is how one session hands a hard-won workaround to the next. Until 0.5.0 the hand-over was *pull*: every session was told to read the journal before nontrivial work, so its cost landed on every session and scaled with the size of a journal that only ever grew — one week of one project produced twelve user-scope entries, two of them the same bug under different slugs, with permanent After Effects quirks sitting beside tool bugs a release had already fixed (issue #102). It is now *push*: a failed call names the entries that match it, an entry has exits, and a re-log of the same error lands in the same entry. Eleven properties matter, and all eleven are things it would be easy to get wrong:

- **The folder ignores itself.** `ensureJournalDir` writes `.ae-mcp/.gitignore` containing `*` on first use, in *both* journals. That is what keeps them untracked — not a rule in the project's `.gitignore`, which most of these folders do not have, and which the ones that do would have to remember to add. The user journal gets one for the same money: `~/.ae-mcp` is usually outside any repository, but a home directory that *is* one (dotfiles) is exactly where committing a private journal of half-diagnosed failures would be an unpleasant surprise.

- **There are two journals, and the folder is the only thing that decides which is which.** `<project>/.ae-mcp/` holds what is true about *this* project — its footage, its comps, its files. `~/.ae-mcp/` holds what is true about the tools and about After Effects, and is read alongside the project one so a new project folder does not start ignorant of everything the last one worked out (issue #57). `log_issue` defaults to `project` and takes `scope: "user"`; `list_known_issues` merges both and tags every entry. The scope is **not** written into the file's frontmatter: these files are meant to be hand-edited and moved, and a `scope:` key could be edited into disagreeing with where the entry actually lives.

- **The home fallback is not the user journal, and keeping them apart is the whole design.** `home` — `~/.after-effects-mcp/`, used when there is no usable working directory — is the *project* journal with nowhere to sit. Merging it into `~/.ae-mcp/` would be one line and would mean every Claude Desktop session's notes about one project's footage arriving in every other project dressed as curated cross-project knowledge. They stay separate directories, `scope: "home"` keeps saying what it always said, and `scope: "project"` on a read — like a `project:<id>` handle — covers the fallback because that is what the fallback is. `AE_MCP_HOME` has to sandbox *both* or a test writes into whoever ran it, so it puts the user journal in a child of the override.

- **The title is the identity, and it is only unique within a journal.** It is slugified into the filename, so re-logging under the same title extends the entry rather than adding a near-duplicate. Two journals can hold the same slug, and both are listed — hiding one would lose whichever the reader needed. A bare id still resolves, project first, and names the other in `next`; `"user:<id>"` addresses one exactly, and falls back to the whole string as a bare id so a title that happens to begin "user:" stays reachable.
- **Reporting state belongs to the entry, not the sighting — and to the entry *in its own journal*.** Re-logging a known problem preserves `reported`, `issueUrl` and `firstSeen`, and a `cause` worked out once survives a later sighting logged without one. Otherwise the user gets asked to report the same thing repeatedly, which is the fastest way to make them stop reading the offer. The same lesson written down in both journals is two records of two claims: sending one to the maintainers says nothing about the other, so `mark_issue_reported` moves exactly the one its id names. Archive state is a third, separate fact: `mark_issue_reported` on a retired entry leaves it retired.
- **The files are meant to be hand-edited.** `parse()` is deliberately forgiving: missing keys, reflowed text and deleted headings degrade one entry instead of failing the whole journal. A file with no recognised headings keeps its text as the symptom rather than being read as empty. A file with none of the 0.5.0 keys loads as a live `tool-bug` with no version and no `errorText`; `archived: true` is the one line a hand-edit needs to retire an entry, and deleting it un-retires. `render` writes the archive keys only on a retired entry, so an ordinary file keeps its shape.
- **The listing is an index, not the corpus.** `listIssues` returns one line per entry by default — id, scope, title, tools, kind, `lastSeen`, `lastVersion`, counts — and the body is fetched with `id`. The clipped summary sentence it used to carry is gone: the title is the summary, and the sentence roughly doubled every line for something the title already said. Entries naming `tool` sort ahead of ones that only mention it in the title, then most recent first, then most recurring. The failure mode to guard against is an index that leads nowhere, so the `next` pointer names the call that opens the first entry, spelled in the qualified `scope:id` form. Merging two journals doubles the listing, so `limit` defaults to 50 (500 is the ceiling the schema allows) and anything held back is counted in `omitted` and repeated in `next`. `tests/unit/issue-journal.mjs` asserts all of it.
- **The same tool with the same error text is the same bug, whatever it was called.** Agents used to be told to `list_known_issues` before logging so they would reuse the title; they did not, reliably, and the journal forked. `logIssue` now looks for a twin when the title is new: an entry *in the same journal* whose `tools` overlap the call's and whose `errorText` matches (see the matcher below). It extends that entry — the existing id and title stay, since the title is the id and the one the index has been showing — and the result says `mergedBy: "errorText"` with a `note` that the title passed was not used. No `tools` or no `errorText` means no twin search; the merge never crosses journals, for the same reason reporting state does not. `tools` are unioned on any merge, and `errorText` is recorded on the entry, so an entry that predates the field acquires one the first time it is re-logged. The matcher is shared with the failure path on purpose: both must agree on what "the same error" means, or an agent would be told a failure is known and then fork it on logging.
- **Every entry says what it is and when it was last seen on what.** `kind` is `tool-bug` (default — something these tools get wrong, which a release may fix) or `ae-quirk` (After Effects behaving unlike its documentation, which no release of this server changes). `firstVersion`/`lastVersion` are the server version at the first and latest sighting, written by `log_issue` and moved by a failure match. That stamp is what makes "stale" visible at all; without it there is no way to tell an entry a release fixed from one that is still biting.
- **An entry has three exits, and only one of them is written down.** `archiveReason()` decides, on every read, whether an entry is hidden: (1) `archive_issue` retired it — `archived: true`, `archivedReason`, `archivedAt` in the frontmatter, the file kept; (2) `lastSeen` is `ARCHIVE_AFTER_DAYS` (30) or more days ago; (3) it is a `tool-bug` whose `lastVersion` is semver-older than the running server, so it is presumed fixed until seen again — an `ae-quirk` is exempt, and so is an entry with **no** `lastVersion`, because unknown is not older (see [fragile-areas-server.md](fragile-areas-server.md)). (2) and (3) are computed, never written into the file, which is what lets a fresh sighting bring an entry back without anyone un-archiving it: a failure match or a re-log moves `lastSeen`/`lastVersion` and the verdict flips by itself. `list_known_issues` hides archived entries, always reports `archivedCount`, says in `next` how to see them, and lists them flagged with the reason under `includeArchived: true`; a read by `id` always returns the entry, archived or not, because the failure pointer names archived entries and has to lead somewhere. A deliberate `log_issue` that lands on a retired entry (same title, or same tool and error text) clears the flag and answers `reopened: true` with `previousArchiveReason` — the entry was archived as gone, and here it is. A failure *match* never clears it: a match is not a person deciding the problem is live again, so the pointer says `(archived: <reason>)` and leaves the decision to the agent.
- **A failed call is answered with the entries that match it.** `issues/failures.ts` is the push half. `server.ts` routes every failure-path `errorResult` in the tool-call handler — schema rejections, `run_jsx` source resolution, write-queue refusals, bridge timeouts and unreachables, `AeError`s — through `fail(name, message)`, which appends one `Known from earlier sessions: <scope:id> — <title>` line per match (`MAX_MATCHES` = 3, most recently seen first, the overflow counted) and a `list_known_issues({ id: "<scope:id>" })` pointer. A match is a sighting: `lastSeen` and `lastVersion` move, best-effort and silently. Three rules hold it: it **never throws and never masks the error** (a journal it cannot read logs to stderr and the message goes back untouched; the test points `AE_MCP_HOME` at a file where the directory should be); it is **cheap** — `JournalCache` re-parses only a file whose size or mtime changed, keyed per *file* because a directory's mtime does not move on an in-place rewrite, which is what every `mark_issue_reported` is; and it is **wired**, which `tests/unit/issue-journal.mjs` proves by running the real server against a stub bridge that fails `set_temporal_ease` with a known error and reading the pointer out of the client's result. The panel-version gate's message and `Unknown tool` are deliberately not annotated.
- **Matching is on the letters of the message.** `normalizeErrorText` cuts the server's own decorations first — the `AE:` prefix, `(line N)`, the mapped-line and "nothing rolls back" lines `aeErrorText` adds, a `diff:true` annotation, and a `Known from earlier sessions:` block, since the natural thing to paste into `errorText` is the whole tool error, pointer included — then drops paths, quoted spans, digits, punctuation, case and whitespace. Two texts match when equal, when one is a prefix of the other and the shorter is at least 20 letters (so `ae` matches nothing), or when both are at least 60 letters and agree that far (so every `Invalid arguments for <tool>` rejection does not fold into one — asserted). An entry with no `errorText` — every file from before 0.5.0 — is matched on its symptom instead, by containment of the failure's opening, with the symptom's quotes *kept* as well as stripped because the error is usually sitting inside a pair of them. The tool must match too, case-insensitively, in both directions.

The user-facing half is the offer to report. It lives in exactly two places: the `log_issue` **tool description** carries the minimum (finish the work first, phrase it for a non-programmer, don't say "GitHub issue"), and `src/prompts/report-ae-issue.md` carries the full flow — which since #100 checks the tracker with `gh issue list`/`gh issue view` before drafting, calls `archive_issue` on an entry a *closed* report already covers and `mark_issue_reported` on one an *open* report covers, sends bodies with `--body-file` rather than quoting markdown on a command line, and takes one approval for "all of them". That prompt is generated into both the MCP prompt (every client) and the Claude Code command (whose `allowed-tools` frontmatter travels verbatim), so there is nothing to keep in sync by hand. If you change the behaviour, change those two.

