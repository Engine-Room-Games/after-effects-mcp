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

<!-- Coordinator: the 0.5.0 entries go here, in the format described at the top
     of this file — bold rule first, then the reason, then `supersedes:` lines
     quoting what a project's notes would have said before this release. -->

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
- **Rigging is written down**, in the main guide: opacity does not propagate
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
