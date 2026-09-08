---
name: whats-new
reference: after-effects
description: What changed in the After Effects tools, one section per release, newest first — each entry leads with the rule as it now stands and quotes the old rule it replaces, so a project's own notes can be found and corrected. Read it when a call behaves differently from what you expected, when the user says a tool used to do something else, or with `since` to see only the releases after the one this project last absorbed.
---

<!--
Format contract. `ae_guide({topic: "whats-new", since: "<version>"})` filters
this file by machine and the absorb-release prompt greps project docs with it:

- One `## <semver>` section per release, newest first. No other `##` heading
  below the first release heading; group inside a release with `###`.
- Everything above the first `## <semver>` is the preamble. It is returned with
  every filtered read, so it stays short.
- An entry is one bullet. It opens with a **bold phrase stating the rule as it
  now stands**, present tense, then the reason and what changed.
- A bullet whose rule replaces something a project's own docs may say carries
  one or more indented `supersedes:` lines directly under it, each quoting the
  OLD rule in the words a project doc would have used. They are grep targets:
  short, literal, no markdown.
-->

# What changed

Read this when something behaves differently from what you expected, or when the
user tells you a tool used to work another way. It is the release notes an agent
needs rather than the ones a human reads: one section per release, newest first.
Every entry leads with the rule as it now stands; a `supersedes:` line under it
quotes the old rule in the words a project's own notes would have used, so those
notes can be searched for and corrected. Pass `since` — as in
`ae_guide({topic: "whats-new", since: "0.4.0"})` — to get only the releases
after that version; the absorb-release prompt is the flow that applies them to
a project once and records the version so the history is not read again.

**When this topic and a tool's own schema disagree, believe the schema.** It is
refreshed at each release and a build in between can be ahead of it.

**The panel is versioned separately from the tools, and it does not update
itself.** It loads at After Effects launch and only at launch, so after any
upgrade the tools can be newer than the code answering them. When that happens a
call returns a remediation message rather than a confusing `Unknown op` — relay
it. The distinction worth reading carefully: if it says the panel is *installed*
but the running one is older, running `setup_panel` again changes nothing and
only quitting and reopening After Effects will.

## 0.5.0

The release where the guidance split into a core and references, the journal
started coming to you instead of you going to it, and three more things After
Effects does silently — a batch's progress no client ever saw, a broken
expression reported as ok, a justification that did not land — became
visible. Two results changed shape; those are first, because a caller reading
the old shape gets nothing rather than an error.

### Two results changed shape

- **`find_layers` returns `{matches, count, compsSearched, included}`, and a
  match is id, index, name, sourceType, compId and compName unless `include`
  asks for more.** It used to answer a bare array of full layer summaries —
  flags, timing, parent, on every match — with no way to bound it, so nine name
  matches cost about two thousand tokens, re-sent on every later request.
  `include` takes the `list_layers` section names (`flags`, `timing`,
  `parent`); unlike `list_layers`, omitting it means the bounded record, not
  everything, and the result echoes `included`. A caller that read the old
  array reads `matches` now.
  supersedes: find_layers cannot be bounded
  supersedes: find_layers returns an array of layer summaries
- **`place_audio_cues` results carry one small entry per cue — `layerId`,
  `name`, `time`, plus what an option changed — and `dryRun` answers counts,
  `wouldImport`, `wouldReuse` and the failing cues only.** The per-cue
  `levelDb`, `label`, `index` and `itemId` were echoes of the request, and a
  seven-cue dry run that found nothing wrong cost about 1,500 tokens of them.
  Read a level off the layer, not out of the result.
  supersedes: place_audio_cues echoes the levelDb written for every cue
  supersedes: dryRun on place_audio_cues returns the resolved cue list

### Three silences, now reported

- **`run_batch` over 500 ops returns its `jobId` before the first chunk runs,
  and progress is delivered on `await_job` — send that call with a progress
  token and `notifications/progress` arrive while it waits.** Nothing can ride
  on the `run_batch` call itself: its response is already back, and a
  notification sent on a request's token after its response is one every
  spec-compliant client has already stopped listening for — which is where
  every progress message for a long batch went before 0.5.0, seen by no real
  client. `get_job` polls the same state without a token.
  supersedes: run_batch progress arrives on the run_batch call
  supersedes: pass a progressToken on run_batch to see its progress
- **`set_expression` throws when After Effects cannot evaluate the expression,
  and `get_expression` returns `expressionError`.** Assigning an expression
  succeeds whatever the text says, and AE's only report is a warning banner in
  its interface; the tool now evaluates the property after the write and fails
  with AE's message and the property path. The expression stays written — fix
  it and call again, or `clear_expression`. `toggle_expression({enabled:
  true})` verifies the same way. A non-empty `expressionError` means the
  property is not being driven by that expression, whatever `enabled` says.
  supersedes: set_expression reports success for a broken expression
  supersedes: ask the user to check the property for an expression warning banner
- **`set_text` and `create_text_layer` read the justification back after every
  write, re-assert it once if it moved, and throw naming expected and actual
  if it still disagrees.** On 26.3 a `set_text` that changed only `text` has
  re-centred a left-aligned layer. Both results carry `justification` as a
  name and `justificationReasserted`; a failing `create_text_layer` removes
  the layer it made, so nothing is left without an id. An unknown
  justification name is refused rather than ignored.
  supersedes: set_text leaves justification alone when you do not pass it
  supersedes: verify alignment by sourceRect after every set_text

### Deleting a comp, and what it leaves behind

- **`delete_comp` reports `unusedSolidsLeft`, and `purgeUnusedSolids: true`
  removes the comp's own now-unused solids in the same undo step.** A solid's
  source is a footage item in the Solids folder, and deleting the comp only
  ever removed the layer, so a session that built and discarded comps left
  hundreds behind. Only the deleted comp's own solids are considered; one
  another comp still uses is kept and reported in `keptSolids` with that comp.
  supersedes: delete_comp removes a comp and its solids
  supersedes: sweep the Solids folder by hand after deleting comps
- **`purge_unused_footage` sweeps the project: solids only by default,
  `solidsOnly: false` for every unused footage item, `folderId` to scope it,
  `dryRun: true` to list `wouldRemove` without an undo step.** Never a comp or
  a folder — a nested comp nothing uses is not footage.
  supersedes: remove unused footage with run_jsx

### Sound

- **`place_audio_cues` takes `loop`, `fadeIn`/`fadeOut` and `stretch` per cue,
  and `fadeFloorDb` per call.** `loop: true` time-remaps with a wrap-around
  expression, keeps AE's two default keys and re-asserts the out point; fades
  keyframe Audio Levels at the layer's real in and out between the floor
  (default `-48`) and the cue's level, and a fade that does not fit is refused
  by cue index; `stretch` is a percentage with the start time and trims
  re-asserted after it. A stretched loop bakes the factor into its expression,
  so a later hand change to stretch leaves the loop at the old rate. All of it
  is validated before anything is created and rolled back with the rest.
  supersedes: loop a bed with run_jsx and timeRemap after place_audio_cues
  supersedes: fade audio in run_jsx after placing the cues

### The journal comes to you

- **A failed call ends with `Known from earlier sessions: <scope:id> — <title>`
  for up to three entries matching its tool and error text, and the
  `list_known_issues({id})` call that opens the first.** Nobody reads the
  journal ahead of time any more; the pointer arrives with the failure, and a
  match moves the entry's `lastSeen`.
  supersedes: read list_known_issues before nontrivial work
  supersedes: check list_known_issues before guessing
- **`log_issue` takes `errorText` and `kind`, and the same tool with the same
  error text extends the existing entry even under a new title** — the result
  says `mergedBy: "errorText"` and keeps the existing title. `kind:
  "ae-quirk"` marks a permanent After Effects behaviour; the default
  `tool-bug` is presumed fixed once last seen on an older server. Entries
  record `firstVersion` and `lastVersion`.
  supersedes: call list_known_issues first so you reuse the title when logging
- **Entries archive themselves — unseen for 30 days, or a `tool-bug` last seen
  on an older server — and `archive_issue({id, reason})` retires one by
  hand.** Archived entries are hidden from the index and counted in
  `archivedCount`; `includeArchived: true` lists them, a read by `id` always
  works, and a fresh `log_issue` reopens one with `reopened: true`. Index
  lines carry `kind`, `lastSeen` and `lastVersion` and no summary sentence,
  sorted by tool match and then most recently seen.
  supersedes: the journal only grows, entries are never removed
- **The report flow checks the tracker before drafting.** An entry a closed
  report already covers is archived with that URL; one an open report covers
  is marked reported. Bodies go through a file, and "all of them" is one
  approval.

### Reading the history once

- **`ae_guide({topic: "whats-new", since: "<version>"})` returns only the
  releases after that version, opening with the server's own version**, and
  this file has a shape a machine can filter: one section per release, every
  entry leading with the rule as it now stands, `supersedes:` lines under it
  quoting the old rule. The absorb-release prompt (`/absorb-release` where
  prompts are commands) applies the delta to a project's notes once and
  records the version in the `Tools version last absorbed:` line
  `init_project` writes into AGENTS.md.
  supersedes: read the whole whats-new guide after every update

### The guidance

- **The `after-effects` topic is a core of what silently produces wrong output
  on any task, and each subject is its own topic** — `animation`, `shapes`,
  `text`, `assembly`, `extendscript-gotchas`, `sound`, `mogrt-and-footage`,
  `issue-journal`, `whats-new` — twelve `ae_guide` topics in all with
  `style-guide` and `ae-setup`. In Claude Code and claude.ai the references
  are the files in the `after-effects` skill's `references/` folder, opened
  only when the core points at them. Keyframes, easing and rigging are in
  `animation`; raw scripting, with the ease-arity table, in
  `extendscript-gotchas` and nowhere else.
  supersedes: the after-effects skill covers keyframes text and shapes in one file
  supersedes: the ease arity table is in the main guide
- **Four more After Effects facts, measured on 26.3, in `extendscript-gotchas`:**
  removing the last Time Remap key hides the property, so edit AE's two
  default keys in place or put an expression over them, and re-assert
  `outPoint` after enabling remapping; `TextDocument.justification` written
  from a script lands as RIGHT when handed CENTER, so set it through
  `set_text`; `OutputModule.setSettings` rejects Format, Channels, Depth and
  Color as read-only, so build an output template in the UI and apply it by
  name; and the ease arity is not derivable from a value's dimension, so
  never size a `KeyframeEase` array by hand.
  supersedes: clear the Time Remap keys before adding your own
  supersedes: set justification on the TextDocument from run_jsx
  supersedes: set the output module codec with setSettings from run_jsx

### Connecting, and staying connected

- **The server follows the panel's port.** A call refused on the port the
  server remembered makes it look again — 7777 first, then the port file —
  switch to whichever answers as the panel, and re-send the call once. Only a
  refused connection triggers this; a timed-out call reached After Effects and
  is never re-sent (issue #92). `AE_MCP_PORT` is a hard pin: with it set, no
  other port is ever tried.
  supersedes: reconnect the MCP server when ops fail on a port check_setup does not report
- **`check_setup` reports the port that actually answers**, flags a stale
  port file, and carries a new `portAgreement` check. When calls go to one
  port and the panel answers on another, its advice is to retry or reconnect
  the MCP server. It never tells you to restart After Effects for that.
  supersedes: cannot reach the panel means nothing is listening so restart After Effects
- **The panel waits instead of moving when an older copy of itself holds
  7777.** It says so in its own window, names the holder, and takes the port
  over the moment that copy exits, with no restart. Two After Effects
  instances on one machine opt back into walking with `"allowPortWalk": true`
  in `~/.engineroom-ae-mcp/config.json`; the same file's `"port"` moves the
  panel. The port file only ever names a port that was really bound and is
  removed when the panel unloads.
  supersedes: the panel walks up to the next free port when 7777 is taken
- **A panel that never loads on Windows gets a diagnosis, not a restart
  loop.** `check_setup` reads CEP's own log and, when CEP refused the panel's
  signature — an Adobe CEP 12 bug that ignores PlayerDebugMode — reports
  `panelSignature` with the steps to self-sign the installed panel with
  Adobe's ZXPSignCmd (issue #91). With no log yet, it gives the one command
  that turns CEP logging on. `setup_panel` now turns that logging on itself
  where it was never set, warns when it is about to replace a self-signed
  panel (`signedInstallOverwritten`, since the fresh copy needs signing
  again), and reports a signed panel as up to date rather than partial.
  supersedes: check_setup all green but the panel never loads means restart After Effects again
- **`check_setup` under an `AE_MCP_PORT` pin still asks 7777 and the port
  file, and a pinned wrong port is reported as the pin, not as a dead panel.**
  The pin decides where ops go and is never walked past; the diagnosis says so,
  names the port the panel is really answering on, and tells you to change or
  unset `AE_MCP_PORT` and reconnect the MCP server — never to restart After
  Effects. A refused op under a pin says the same in its own message.

### Found by the live pass

- **`init_project` refuses the home directory and the filesystem root however
  they were arrived at, an explicit `dir` included.** Before this only the
  working-directory fallback was guarded, so `dir: "~"` resolved by a client,
  or `dir: "/"`, scaffolded `AGENTS.md` and a `renders/` folder into a home
  directory and reported success.
- **`set_house_style` writes `house-style.md` with Unix line endings.**
  ExtendScript's default on macOS turned every line break into a bare carriage
  return: the tools read the file back correctly, so the round trip looked
  fine, but a designer opening the file in an editor saw one long line.

## 0.4.0

The release where verifying a change stopped meaning reading the whole thing
back — and where a live pass against After Effects 2026 found four things this
server had been claiming that were never true. Those are first, because an agent
that learned the old story will otherwise repeat it to a user.

### Four things that were never true, and are now fixed

- **`run_batch` is one undo step up to 500 ops; over 500 it is one step per
  chunk of 25, and `singleUndo: true` makes it one step up to 2000.** The
  one-step guarantee it shipped with before 0.4.0 did not exist on either path:
  After Effects discards an undo group opened in one script call and closed in
  another, so a 600-op batch landed as about six hundred separate steps while
  reporting one. Now up to 500 ops is genuinely one step; over 500 is one step
  per chunk of 25 — around 24 for 600 ops — with the measured count in
  `undoSteps` and a `note` saying it in words. `singleUndo: true` runs the batch
  in a single blocking call, which freezes AE's interface for the duration and
  reports no progress. Read `undoSteps` before you tell anyone how to undo the
  work.
  supersedes: run_batch is one undo step
  supersedes: a long run_batch is one undo step
- **`transactional: true` stops at the first failure, rolls nothing back, and
  says so: `rolledBack: false` with the stop point named.** It never rolled
  anything back — it fired one menu-command Undo, and menu commands silently do
  nothing over this bridge; one Undo is one step, not a batch, in any case. The
  ops before the failure stay applied. Use `diff: true` to see what landed.
  supersedes: transactional: true rolls the batch back on failure
- **`reorder_layer` works, and takes exactly one of `beforeLayerId`,
  `afterLayerId` or `toIndex`.** Every call it served before 0.4.0 threw
  `parent is not an INDEXED_GROUP`, because it used a shape-node method on a
  layer. Prefer the id forms, because this is the op that invalidates indexes;
  `toIndex` means the index the layer **ends up at**.
  supersedes: reorder_layer is broken, use run_jsx
  supersedes: reorder_layer throws parent is not an INDEXED_GROUP
- **`downsample: 1` is full resolution, whatever the viewer's Resolution
  dropdown is set to.** Before 0.4.0 factor 1 skipped setting the comp's
  resolution at all, so it inherited the viewer's setting — on a comp a designer
  had left at Quarter, `downsample: 1` returned a quarter-size frame and
  `downsample: 2` returned one four times larger. The response was honest about
  the dimensions; the picture was not the one asked for. Factor 1 is now set
  explicitly like any other and restored afterwards.
  supersedes: downsample: 1 means the viewer's resolution
  supersedes: set the viewer to Full before a downsample: 1 screenshot

### Two calls changed under you

- **`create_shape_layer` spawns at `[0,0]`**, with the anchor at `[0,0]`, so the
  layer's coordinate space *is* the comp's and every vertex, rect position and
  path you add afterwards is in comp pixels. After Effects' own spawn point is
  the comp centre, which silently offsets a drawing authored in comp coordinates
  by half a frame — easy to miss on a downsampled screenshot. `position:
  "center"` restores AE's behaviour, and any `[x,y]` places the origin yourself.
  The result echoes what it ended up with.
  supersedes: a new shape layer spawns at the comp centre
  supersedes: shape paths are offset by half a frame, subtract the comp centre
- **`get_house_style` returns a digest, not the document; `detail: "full"`
  returns the document.** The digest is a few hundred tokens: palette as named
  hexes, type, motion, layout, and a note naming anything it could not summarise.
  You need the full document before `set_house_style`, which replaces the file
  rather than patching it. An unstructured guide comes back `structured: false`
  with its opening text, which is an honest "I could not read this as a spec"
  rather than an empty answer.
  supersedes: do not call get_house_style, read the digest in these notes instead
  supersedes: get_house_style returns the whole style guide

### Verify with a diff instead of a second read

- **`snapshot_comp` and `diff_comp` fingerprint a comp and report what moved.**
  Fingerprint before a write, then ask: layers added, removed, renamed,
  retimed, re-parented, keyframe counts, expressions and effects gained or lost
  — and a count of the layers that did not move. Tens of tokens where two full
  reads were thousands. It does **not** record property values, expression
  text, effect parameters, masks or shape contents, so `changeCount: 0` means
  none of the recorded fields moved, not that the comp is identical.
  supersedes: verify a write by reading the comp back with list_layers and get_layer_full
- **`diff: true` on `run_jsx` and `run_batch` does the same inside the call**,
  so there is no window between the write and the fingerprint — and on a
  failure the diff rides on the error, which is how you find where a
  half-applied script stopped.

### Screenshots

- **`screenshot_frame` takes `times` (2–6) and returns one tiled contact
  sheet**, each tile labelled with its own time, held to roughly the pixel
  budget of a single frame. Judging motion is one call now, not three: one
  image in your context instead of three, and one render request instead of
  three back-to-back ones, which is the pattern that provoked stale frames.
  `time` and `times` are mutually exclusive; there is no `times` on
  `screenshot_layer`.
  supersedes: screenshot each time separately to judge motion
- **Three screenshot failures, each with its own remedy.** `Stale frame` (AE
  served an earlier render — wait, retry higher), `Corrupt frame` (the file is
  not a whole PNG; not a timeout — retry at downsample 6–8 or shoot the precomps
  separately), `Render timed out` (still rendering — wait before retrying, or a
  retry queues behind it). A frame that is genuinely all-transparent is still
  `empty: true` with no image. On a sheet, one bad tile is drawn as a marked
  block and named in `warning`; the rest of the sheet is good.
  supersedes: truncated PNG from screenshot_frame means retry it

### run_jsx

- **A `run_jsx` failure names the line of *your* script and prints its text**,
  and says so honestly when the number cannot be mapped rather than guessing.
  This was claimed once before it was true: until the 0.4.0 live pass every
  error said line 1 and printed line 1's text, with the real number only in the
  parenthetical after it, because AE reports `Error.start`/`Error.end` as `0`
  on every error rather than as the character offsets its documentation
  describes.
  supersedes: run_jsx line numbers are wrong, count from the wrapper
  supersedes: run_jsx reports line 1 for every error
- **`diff: true` on `run_jsx` reaches After Effects.** The server was building
  a fresh argument object and dropping every field it did not enumerate, so the
  flag was discarded before the call left. The same flag on `run_batch` always
  worked, which is what hid it.
  supersedes: diff: true on run_jsx does nothing
- **`scriptPath` and `libraries` keep a long script and its shared helpers out
  of the conversation entirely.** Libraries are inlined ahead of the script in
  the same scope, so their functions are callable from it; they are
  re-evaluated on every call, so keep them to declarations rather than to work.
- **Helpers are in scope**, each wrapping a trap: `compById`, `layerById`,
  `walkProperty`, `addKeys`, `ease` (which sizes the KeyframeEase array using
  the same code `set_temporal_ease` uses, not a copy), `shape` (which lands at
  `[0,0]`), and `withoutUndoGroup`. The whole `OPS` table is callable too.

### New tools, and one thing you no longer have to get right

- **`duplicate_comp` returns the new comp id**, so you never look for the copy
  by name. Shallow by default like AE's own Duplicate — the copy's precomp
  layers point at the *same* nested comps — with `deep: true` for a real
  variant.
  supersedes: duplicate a comp with run_jsx and find the copy by name
- **`place_audio_cues` scores a scene in one call**: a cue list becomes one
  audio layer each, imported once per file, named, trimmed, levelled in dB, in a
  single undo step, all-or-nothing, with a `dryRun`.
  supersedes: place audio with run_jsx, one layer at a time
- **`set_temporal_ease` and `add_keyframe` size the ease array themselves.**
  Pass one `{influence, speed}` pair per side; the count that worked comes back
  as `easeDimensions`. The bare `parameter 2` failure is no longer yours to
  avoid.
  supersedes: set_temporal_ease fails with parameter 2, pass the right number of KeyframeEase objects by hand
  supersedes: set_temporal_ease fails on Scale, use run_jsx
- **`export_mogrt` refuses an empty Essential Graphics panel up front**, naming
  the controller count. It used to attempt the export and then blame a modal
  dialog, which under the default dialog suppression is the one cause ruled out
  by construction. When an export does fail now, the message says what was
  checked and — if dialogs were suppressed — that the cause is genuinely
  unknown, because AE answers with a bare boolean and has no way to say why.
  supersedes: export_mogrt fails with a modal dialog when the comp has no Essential Graphics controllers

### Underneath

- **Writes are serialized, one at a time, for the whole session**, so two
  writes issued together run in the order you issued them and a long
  `run_batch` holds the lock until its last chunk lands — nothing else drops
  into the middle of work the user asked for as one thing. A call that waited
  says `queuedBehind` and `waitedMs`. Reads are never queued. There is a new
  diagnosis to tell apart from a bridge timeout: a call *dropped while waiting
  for the write queue* never reached After Effects, so re-sending it is safe —
  which is the opposite of what a timeout means.
  supersedes: never issue two writes in the same turn, the order is not guaranteed
- **The issue journal has two scopes.** `project` is this project's notes;
  `user` travels with the person across every project, so log tool and After
  Effects behaviour there. Ids are unique only within a journal, so open an
  entry with the qualified form the listing shows (`user:…`).
- **The guidance lives in `ae_guide` and the skill, not in what the server sends
  every session.** What the server sends is a short pointer rather than a
  summary, because it was resident in every request the user ever made. The
  narrative is `ae_guide({topic: "after-effects"})`, with `extendscript-gotchas`
  behind it for raw `run_jsx` and this topic for changes. In Claude Code and
  claude.ai the same text is the `after-effects` skill and the files in its
  `references/` folder — load one carrier, not both.
- **Rigging is written down**, in the `animation` topic: opacity does not propagate
  through parenting, and a camera null is parented to while it is still at
  identity.

## 0.3.1

- **`get_layer_full` omits `ADBE Vector Materials Group` unless
  `shapeMaterials: true`.** That is the 48-property 3D extrusion model AE hangs
  off every vector group, which means nothing on a 2D shape layer. It was around
  three quarters of the bytes of a shape read: one 68px circle cost 4,400
  tokens, of which the geometry was about 40. `materialsOmitted` counts what was
  dropped; `shapeMaterials: true` brings it back for a genuinely extruded shape.
  A group Transform still at its creation values collapses to `atDefaults:
  true` the same way.
  supersedes: shape reads are huge, avoid get_layer_full on shape layers
- **`shapeDetail: "compact"` returns one indented line per group** instead of
  the JSON tree — every name the write tools address a node by, with `[3 keys]`
  or `[expr]` marking the animated properties. Measured end to end on one real
  layer: 13,369 characters before 0.3.1, 3,052 once the materials block went,
  643 compact. Reach for `"full"` only when you need exact values or keyframe
  indices.
- **`run_jsx` never answers a bare `null`.** A script whose last statement is a
  bare expression completes and returns nothing — `"ping";` does not return
  `"ping"` — and that used to be indistinguishable on the wire from a script
  that never ran. It now comes back as `{ok: true, returned: null, undoGroup,
  note}`, which means *it ran to completion*. Do not re-run it: nothing rolls
  back, so a second run of a script that duplicated a layer or wrote keyframes
  does all of it twice. A returned value still comes back bare, falsy ones
  included.
  supersedes: a null from run_jsx means the script did not run, run it again

## 0.3.0

- **`list_comps`, `list_layers` and `get_layer_full` take `include` to name the
  sections you want**, plus `maxKeyframes` and `shapeDepth` on the deep read.
  Omit them all and you get everything, exactly as before. Anything left out is
  named and counted in the response (`included`, `keyframesOmitted`,
  `childrenOmitted`), so a short answer never passes for a complete one. This
  matters more than it sounds: a tool result is re-sent to you on every later
  request for the rest of the session, so one unbounded read is paid for many
  times.
  supersedes: get_layer_full returns everything, there is no way to bound it
- **Screenshots downsample themselves.** Omit `downsample` and it is derived
  from the comp — 2 at 1080p, 3 at 4K, aiming at a long edge near 1280px. The
  result reports the size actually returned. Pass `downsample: 1` only when you
  genuinely need full resolution.
  supersedes: always pass downsample on screenshot_frame or it returns full resolution
- **A stale frame is an error, not a picture.** AE sometimes re-serves a frame
  it rendered for an unrelated request, at a different time and even at a
  different downsample factor, with nothing in the response to say so. Those
  are refused with `Stale frame` naming the request whose pixels came back.
  Wait a few seconds and retry at a higher `downsample`.
- **A fully transparent frame comes back as `{empty: true, reason}`** with no
  image. That is a fact about the composition — wrong time, layer outside its
  in/out points, disabled, zero opacity — not something to retry.
- **`import_footage` and `create_footage_layer` bring footage in**, and the
  import refuses an SVG whose `viewBox` asks for one aspect ratio and imports at
  another: that is a real AE bug which renders as nothing at all, with no error
  at any stage.
  supersedes: import footage with run_jsx and importFile
- **`export_mogrt` exports a Motion Graphics template and suppresses the modal
  dialogs** that otherwise freeze this whole connection until someone clicks
  them in After Effects. Never drive `exportAsMotionGraphicsTemplate` from
  `run_jsx`.
  supersedes: export a mogrt with run_jsx and exportAsMotionGraphicsTemplate
- **Text alignment is justification**, not a measured anchor offset, so it
  stays correct when the text changes later. Tracking is set explicitly rather
  than inherited from the user's Character panel.
  supersedes: anchorAlign moves the anchor point, re-align text after every edit
