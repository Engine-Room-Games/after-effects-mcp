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

