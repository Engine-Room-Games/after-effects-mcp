---
name: after-effects
description: How to drive Adobe After Effects well through the AE MCP tools — orienting in a project, bounding every read, verifying a write with a diff, screenshots as a one-off diagnostic with their cost in tokens, write ordering, and the five bridge failures whose remedies contradict each other. Load whenever a task involves After Effects, motion graphics, comps, layers, or keyframes; it points at one reference per subject for everything else.
---

# Driving After Effects

You have direct control of a live After Effects session. The user sees every
change immediately, and every tool call that changes something is a real undo
step in their project.
Work like a motion designer at the keyboard, not like a script that fires blind.

This file holds only what silently produces wrong output on *any* task. Each
subject sits behind it in a reference, loaded when a task reaches that subject
and never otherwise. From any client, `ae_guide({topic: …})`; loaded as a
skill, the file beside this one:

| When the task reaches… | Topic | File |
|---|---|---|
| keyframes, easing, rigging, expressions | `animation` | `references/animation.md` |
| a shape layer and its Contents | `shapes` | `references/shapes.md` |
| a text layer | `text` | `references/text.md` |
| shots placed into a master comp, markers, retiming a shot | `assembly` | `references/assembly.md` |
| any raw ExtendScript for `run_jsx` — read it **before** writing the script | `extendscript-gotchas` | `references/extendscript-gotchas.md` |
| sound effects and beds | `sound` | `references/sound.md` |
| a `.mogrt` export or filling its Essential Graphics panel, importing footage, or the solids a deleted comp leaves behind | `mogrt-and-footage` | `references/mogrt-and-footage.md` |
| rendering a comp to a movie or image sequence, or the render queue | `rendering` | `references/rendering.md` |
| a tool that fought back, and what to do with what you learned | `issue-journal` | `references/issue-journal.md` |
| a call that behaves differently from what you remember | `whats-new` | `references/whats-new.md` |

Two topics are siblings rather than references: `style-guide`, for capturing the
user's look, and `ae-setup`, for a connection that is not working.

The user can start this server **read-only** (only the tools that look) or with
**`run_jsx` switched off**. Either way the missing tools are simply absent from
your tool list, though this guidance still names them. When a task needs one
you do not have, tell the user it is switched off; do not route around it.

## Read the house style first

`get_house_style` returns the project's style guide — palette, type, motion
defaults, layout rules — read from `house-style.md` beside the `.aep`. Call it
once at the start of any build task and follow it; it is the difference between
work that matches everything else the user has made and work that does not.

What comes back is a **digest** of a few hundred tokens, which is what you build
from. Pass `detail: "full"` only when you need the guide's own wording — and
always before `set_house_style`, which replaces the whole file, so you send the
merged document rather than a patch. `structured: false` means the guide could
not be read as a spec and its opening text is returned instead; `found: false`
means there is none — build with sensible defaults and offer once, at the end,
to capture one from what you made. Do not nag about it.

Pass the palette's hexes as they are. Every colour field takes `"#ff8800"` or
`"#f80"` as well as RGB 0..1, and so does a `value` aimed at a colour property;
a hex `value` aimed at anything else is refused, not converted. There is no
alpha form: After Effects ignores a colour's alpha channel when it renders, so
`#ff8800cc` is refused — set transparency with Opacity, the layer's or a shape
fill's or stroke's.

## Orient before you touch anything

Never guess at project state. Cheap reads exist for exactly this, and the
bounded form is the one to reach for:

| Question | Call |
|---|---|
| What is in this project? | `get_project_summary` |
| What comps exist? | `list_comps({include: []})` — ids and names |
| What is in this comp? | `list_layers({compId, include: []})` — id, index, name, type; `get_comp_tree` for the nesting |
| Where is a layer, by name, type or effect? | `find_layers` — `{matches, count, compsSearched, included}`; a match is id, index, name, sourceType, compId and compName, and `include` (`flags`, `timing`, `parent` — the `list_layers` names) widens it. Unlike `list_layers`, omitting `include` here does **not** return everything |
| What does the user mean by "this" or "these"? | `get_selection` — the active comp, its playhead `time`, the selected layers, and the selected properties as `propertyPath`s with their selected keyframe times. Call it before asking the user to name a layer, and say which layer you took it to mean |
| One layer, in depth | `get_layer_full({compId, layerId, include: […]})` ⭐ |
| What did my last change actually do? | `snapshot_comp` → `diff_comp` ⭐ |

**If your client supports resource subscriptions**, `ae://project/summary` is
`get_project_summary`'s answer without `activeItemId`, and
`ae://project/active-comp` is `{compId, comp}` with `comp` as `get_comp` answers
it, for the comp last active in a viewer (clicking into the Project panel does
not clear it). A subscription tells you when the user adds, renames or switches
comps, so you need not re-read them to find out (a rename made by hand can take
up to a minute to arrive). They track
the project and the comp's settings, not edits inside a layer; for those it is
still `snapshot_comp` → `diff_comp`.

**Bound every read.** A tool result is re-sent to you on every later request
for the rest of the session, so an unbounded read is paid for once when you
make it and again on every request until the session ends. `include: []` on the
list calls; on `get_layer_full`, `include` names the sections you want
(`transform`, `effects`, `masks`, `markers`, `bounds`, `text`, `shape`,
`source`), `maxKeyframes` caps the keyframes per property, `shapeDepth` limits
the Contents walk, and `shapeDetail: "compact"` reads a shape layer as one line
per group. Omit them all and you get everything. Whatever a bound leaves out is
named and counted in the response, so a bounded read never passes for a
complete one.

**One bounded `get_layer_full` beats several narrow calls.** It returns
transforms with their keyframes and expressions, effects with every parameter,
masks, markers and `sourceRect` (the layer's visible bounds) in one answer, so
when you need three of those, name the three in `include` rather than making
three calls. The bound is the `include` list, not the number of calls.

**Making a variant of something** is `duplicate_comp`, which returns the new id
so you never look for the copy by name. Its default is a **shallow** copy, the
same as AE's own Duplicate: the copy's precomp layers point at the *same* nested
comps, so editing one edits both. That is right for "another version of this
shot" and wrong for "a variant of this rig" — for that pass `deep: true`, which
duplicates the nested comps and re-points the copy at them.

**Effects are added by matchName**, not display name:
`add_effect({matchName: "ADBE Gaussian Blur 2"})`, then `set_effect_param` by
`paramMatchName` — display names are translated, so a `paramName` that works in
English misses on a German or Japanese install. If you do not know a matchName,
`list_available_effects({filter: "blur"})` — always with a `filter`, since the
unfiltered list is several hundred entries and takes seconds every time.
`list_effects` shows what is already on a layer, up to 200 parameters per effect
(`maxParams` and `paramFilter` reach the rest).
A newly added Gaussian Blur has **Repeat Edge Pixels on** by default, so a
blurred solid keeps hard edges until you set `ADBE Gaussian Blur 2-0003` to 0.

## Identify things by id, never by index

Every comp and layer has a stable numeric `id`. Layer `index` is a 1-based
position that **shifts whenever layers are added, deleted or reordered**. Store
`(compId, layerId)` and pass those; an index captured before a `create_*` call
may point at a different layer by the time you use it.

`reorder_layer` is the op that shifts every index below it, so it takes
**exactly one** destination and the id forms are the ones to use:
`beforeLayerId` puts the layer directly in front of (above) that layer,
`afterLayerId` directly behind it. `toIndex` is absolute — 1 is the front,
`numLayers` the back — and means the index the layer **ends up at**, not the
slot it displaces. Reach for it only when you genuinely mean "on top" or "at the
back". The result carries `movedFrom` beside the landed `index`.

## Read, then write, then verify

1. Read the current state (a bounded `get_layer_full`).
2. Make the change.
3. Verify by reading back — property values are the ground truth. A screenshot
   tells you something *looks* wrong; the property tells you *why*.

**Verify with a diff, not a second full read.** Re-reading a comp to see what
changed makes you compare two large answers by eye, and you pay for both for the
rest of the session. `snapshot_comp({compId})` before the write returns a
`snapshotId` and almost nothing else; `diff_comp({since})` afterwards returns
only what moved — layers added, removed, renamed, retimed, re-parented, keyframe
counts, expressions and effects gained or lost — and a count of the layers that
did not. `run_jsx` and `run_batch` take `diff: true`, which does the same
*inside* the call, so there is no window between the write and the fingerprint.

A fingerprint records no property values, expression text, effect parameters,
masks or shape contents, so `changeCount: 0` means none of the recorded fields
moved — not that the comp is unchanged. For "is this value right", read the
property.

**A failed write is a partial write.** Nothing rolls back, on any tool: a
`run_jsx` that throws on its fourth line has done the first three, and a
`run_batch` that stops at op 30 has done 29. So find out what landed — on a
failure the `diff: true` result rides on the error, which is the cheapest way —
and never re-send the same call to see whether it fails again: the half that
worked is applied a second time.

**Before a risky or many-call change, take a checkpoint.** Undo is not a way
back you can count on across calls. `checkpoint_comp({compId, label})` saves a
copy of the comp; `revert_comp({checkpointId})` puts it back **into the same
comp** — the comp id does not change, but every layer id does, so switch to
the ids in `layerIdMap` and drop any layer id you read since. Read `verified`:
`false` means it is not a clean revert, and the `mismatches` say where; `true`
covers structure, timing, switches, parenting, mattes and layer picks, not
keyframe or effect values (`checked` lists it). A
checkpoint is shallow — edits inside a nested precomp are not undone. Each one
is a full comp in the user's project: `delete_checkpoints` when you are done.

**Three calls may ask the user first.** On a client that can show a
confirmation prompt, `delete_comp`, `purge_unused_footage` and `revert_comp`
put the question to the person before anything changes — `revert_comp` also
offers to save the current state first. A `run_batch` containing any of them
asks once for the whole batch before any of it runs. A declined, dismissed or unanswered
prompt comes back as an error saying the tool **was not run** and nothing was
changed: that is the user's answer, not a failure to work around. Tell them it
was not done and do not call it again unless they ask. Writes you issue while
the prompt is open wait behind it, so they still land in the order you issued
them. On other clients nothing is asked and the calls run as before.

## Screenshots are a diagnostic, not a feedback loop

`screenshot_frame` and `screenshot_layer` are **one-off checks**. Do not
screenshot every frame, do not scrub through time, do not screenshot after every
edit.

**An image is the most expensive result this server returns, and it stays in
your context for the rest of the session.** Measured at 4K on 26.3: a frame at
`downsample: 3` — the factor picked for a 4K comp when you pass none, a
1280×720 image — costs about 1,230 tokens; `downsample: 2` about 2,765; a full
4K frame at `downsample: 1` can blow out your context in one call. Budget a
build in a handful of sheets, not in frames.

**To judge motion, ask for a contact sheet — one call, not three.**
`screenshot_frame({compId, times: [0, 1, 2]})` takes two to six times and
returns a *single* tiled image with the time burned into each tile, held to
roughly the pixel budget of one frame. `time` and `times` are mutually
exclusive; there is no `times` on `screenshot_layer`.

The `downsample` is picked from the comp size unless you pass one — 2 at 1080p,
3 at 4K, aiming at a long edge near 1280px, per tile on a sheet. `downsample: 1`
is genuinely full resolution: the render sets the comp's resolution explicitly
and restores it afterwards, whatever the viewer's Resolution dropdown says. The
result reports the dimensions and the factor actually applied — trust those.
Space single frames out; rapid back-to-back requests are the pattern most likely
to come back stale, and a sheet does the spacing for you.

Four results are not a picture, and their remedies point in different
directions, so read which one you got before you retry anything:

- **`Stale frame`** — After Effects re-served pixels it rendered for a
  *different* request, which the error names. Wait a few seconds and retry at a
  higher `downsample`; if two frames of a genuinely static comp really are
  identical, a different factor renders a different number of pixels and proves
  it.
- **`Corrupt frame`** — the render stopped writing and the file is not a whole
  PNG, so nothing was sent. **Not a timeout.** It tracks how heavy the comp is:
  retry at `downsample` 6–8, or screenshot the shot precomps one at a time
  instead of the assembly.
- **`Render timed out`** — After Effects was still working when the panel gave
  up, and probably still is. Wait a few seconds before doing anything else; a
  retry issued now queues behind it.
- **`empty: true`** — every pixel at that time is fully transparent. That is a
  fact about the composition: the wrong time, a layer outside its in/out points,
  disabled, or at zero opacity.

On a sheet a single bad tile is drawn as a marked block and named in `warning`;
the rest of the sheet is still good, so read it rather than re-requesting.

**Never disable layers to make a screenshot render.** A frame that will not
render is a limit of the render path, not project content that needs fixing —
and it is very easy to leave someone's comp switched off afterwards.

## Bulk work, and the order writes land in

`run_batch` runs many ops in one ExtendScript pass — far faster than the same
ops as separate calls, and far fewer undo steps. **Up to 500 ops it is one undo
step.** Over 500 it returns a `jobId` at once, before the first chunk runs, and
lands as **one undo step per chunk of 25** — about 24 for 600 ops — because
After Effects discards an undo group that spans two script calls.
`await_job(jobId)` finishes it, and is the call that carries progress: send it
with a progress token and `notifications/progress` arrive while it waits. None
can ride on `run_batch` itself, whose response is already back; `get_job` polls
the same state without a token. `singleUndo: true` forces one step at any size
up to 2000 by running the whole batch in one blocking call, with AE's interface
frozen for the duration. Every result carries the *measured* `undoSteps`: read
it before you tell anyone how many Cmd-Z the work takes. `transactional: true`
(the default) stops at the first failing op; `false` runs the rest and collects
the errors.
Neither rolls anything back — `diff: true` shows what landed.

**You do not have to issue writes one at a time.** The server runs one write at
a time for the whole session, in the order you issued them, and a long
`run_batch` holds that lock until its last chunk lands — so nothing drops into
the middle of work the user asked for as one thing. A call that had to wait says
so with `queuedBehind` and `waitedMs`. Reads are never queued: `list_*`,
`get_*`, the screenshots and `await_job` answer while a batch runs. Other AI
sessions on the same After Effects take turns with yours the same way; a call
that waited behind one also carries `queuedBehindSession`, naming it.

That queue is this session's only. **A second AI client connected to the same
After Effects has its own**, and neither sees the other's. After Effects still
runs one call at a time, so two calls never mix — but while the other client's
script runs, After Effects answers nothing to anyone, and your call simply
takes longer, with nothing in its result to say why. The other client's writes
can also land between the chunks of a long `run_batch` of yours (measured).
If the user says another session is working in the same project, re-read what
you are about to build on rather than trusting what you last saw.

## Five failures that read alike, with remedies that contradict

- **Did not answer in time.** The call reached After Effects, which is
  single-threaded, so a long script or a modal dialog nobody has clicked blocks
  every reply — and so does another AI client's call on the same After
  Effects, which this one waits behind. It may still be running, or not yet
  started, and either way can still land after the error (measured): do **not**
  re-send it, do not restart
  After Effects, do not run `setup_panel`. Poll `check_setup` for about a
  minute, and ask the user whether a dialog is hiding behind another window.
  While After Effects has answered nothing since, `check_setup` names the call
  under `busyWith` — keep waiting while it does; a long `run_jsx` can hold After
  Effects for minutes. A
  call that legitimately needs longer gets it from `AE_MCP_OP_TIMEOUT_MS` in the
  server's environment. **The one exception is `render_queue`:** its timeout
  says no render was started — the error comes from its prepare or save step,
  before the render — so call `render_queue` again once `check_setup` shows
  the panel answering. At most the project save lands twice, which changes
  nothing.
- **Cannot reach After Effects.** The connection was refused, so nothing
  reached After Effects and nothing changed. The server looks again on its own
  first — 7777, then the port file — and follows a panel that has moved, so a
  refusal that reaches you is one that search did not resolve. Call
  `check_setup` and relay its `nextSteps` to the user in plain language; the
  repair path is the `ae-setup` topic. If it reports the panel answering on a
  port other than the one the call named, retry the call or reconnect the MCP
  server and never restart After Effects for it: something *is* listening, and
  a restart costs the user their work in progress. Do not diagnose CEP by hand.
- **Waited behind another op for the write queue and was dropped.** Nothing
  reached After Effects and nothing changed. Something in front is slow — usually
  a long `run_batch`; find it with `get_job` or `await_job` — then re-send once
  it has finished: nothing ran, so a second copy is impossible. When
  the message says it waited behind *another session*, `get_job` cannot see that
  work: tell the user another session is writing to the same After Effects.
- **Refused: the bridge token did not match.** The panel is running and
  answered at once, by refusing; nothing reached After Effects. Do not re-send
  it — it will be refused identically — and do not restart After Effects or run
  `setup_panel`. Call `check_setup`: its `bridgeToken` check and `nextSteps`
  name the cause, and the `ae-setup` topic has the rest.
- **Dropped the connection mid-call.** Rarer than the others, and unlike any of them: the call
  was delivered and the connection broke before any answer came back — After
  Effects or its panel went away under it. It may or may not have landed. Do
  not re-send it blind: confirm the panel with `check_setup`, then read the comp
  or layer back (`diff_comp` against a snapshot, `get_layer_full`) and re-send
  only if the change is not there.
- **The shared front desk went away mid-call.** The message names the *front
  desk* — another AI session's server that was passing your calls on — not the
  panel. The panel never left, so `check_setup` has nothing to tell you. The
  call may already have reached After Effects, and it **may land later**, even
  after a read-back that did not find it. Read the comp or layer back before
  re-sending; if you re-send, read back again afterwards, or first let one more
  call go through so the old desk is out of the way.
