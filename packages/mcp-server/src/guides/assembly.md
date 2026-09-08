---
name: assembly
reference: after-effects
description: Assembling shots into a master comp — each shot built in its own comp in local time and placed at its offset, comp markers at the beats, retiming, reversing or trimming a shot without touching its contents, the precomp that renders nothing before its startTime or past its source, what a nesting shares (controls, a resize, collapse transformations, motion blur), replacing a nested comp without losing the layers that nest it, and how an assembly, a small detail, a doubtful tile and a cut are verified. Load when a task has more than one scene, a narration to cut to, or a shot to move in time.
---

# Assembling shots into a master

Every narrated job has this shape: several shots, each a few seconds, cut to
beats in a voice track, in one deliverable. Build it as **one comp per shot,
placed into a master**, and the three questions that otherwise cost a session —
where does this shot start, how do I move it, why is the frame black — stop
arising.

## Build each shot in local time

Make each shot its own comp (`create_comp`, sized and timed like the master)
and animate it **from zero** — its first keyframe at `0`, its expressions
written against the comp's own `time`. A shot comp has its own clock: when it
is placed into the master, every keyframe and every expression inside it keeps
working wherever it lands, because nothing inside it ever knew about the
master's timeline. That is the whole reason to build this way; a shot animated
in the master's absolute time cannot be moved without re-keying it, and its
expressions do not follow — see the `animation` topic on comp time versus layer
time.

## Place it at its offset

`create_precomp_layer({compId: master, sourceCompId: shot})` places the shot as
a layer, then `set_layer({…, startTime: offset})` puts its local zero at the
beat. `inPoint` and `outPoint` trim it in master time; `stretch` changes its
speed. All four leave the shot comp untouched, which is what "retime a shot"
should mean: move the layer, never the contents. To make a shot longer or
shorter, change its content in the shot comp and then re-trim the layer.

**A precomp layer cannot run past its source.** `outPoint` clamps to the shot
comp's duration without a word, and a layer trimmed past it — in a rig as much
as in the master — simply ends there. Extend the shot comp's `duration` with
`set_comp` first, then the layer's `outPoint`, and read the out point back
from the result. To play a shot backwards, time-remap the layer from the
shot's end to its start — `run_jsx`: `timeRemapEnabled = true`, then swap the
values of the two default keys with `setValueAtKey` — and nothing inside the
shot is touched.

**A precomp layer renders nothing before its `startTime`.** So you cannot hold
a rigged shot at its pre-animation state by pushing `startTime` later than the
moment it appears — you get an empty frame until the layer starts. Freeze the
start by duplicating the shot comp and stripping the keys (`duplicate_comp`,
which is a shallow copy by default — pass `deep: true` when the shot nests
comps of its own), or start the layer at the moment it should first be visible
and let the shot's own opening hold. Freeze the *end* past the source duration
with time remap and `Math.min(time + off, dur − 0.1)` on the layer, not by
extending the shot comp.

**Nothing on the master's timeline hides a shot that has run past its cut.**
Trim `outPoint` at the cut, or the next shot renders on top of a tail that is
still animating.

## What a nesting shares, and what it clips

**A control inside a shot comp is shared by every layer that nests it.** Key a
slider in the shot and every instance of the shot changes with it. A shot that
must differ per placement is its own comp — `duplicate_comp`, with `deep:
true` when the shot nests comps of its own — keyed on its own control.

**Changing a shot comp's size moves everything that nests it by half the
change.** A precomp layer's anchor sits at its source's centre, and after
`set_comp` changes the width or height the anchor and the position of each
nesting layer no longer agree, so the nested world jumps by half the
difference. Read every nesting layer's anchor point and position back and
re-place it.

**A precomp is clipped at its own bounds unless collapse transformations is
on.** A blur or a glow at a shot's edge is cut off at the frame, and a camera
below 100 % shows the cut edge; a shot flown through at scale goes soft at 4×.
The layer's collapse switch fixes both — vector contents render at the final
resolution and past the bounds — and every instance of the shot needs it, not
just one. It costs two things: an adjustment layer inside a collapsed shot acts
on the frame *behind* the shot rather than on the shot alone, and the shot
layer's own blending mode is ignored. Where either matters, leave collapse off
and oversize the shot comp instead. No tool sets the switch; from `run_jsx`,
`layerById(compId, layerId).collapseTransformation = true`.

**Motion blur is a per-comp switch and a per-layer switch, and the layer
switch inside the shot is the one a build forgets.** The master's comp switch,
the precomp layer's switch and each moving layer's switch inside the shot all
have to be on before anything in the shot blurs; switch the shot comp's own on
too, so the shot previews the same way opened alone. From `run_jsx`:
`comp.motionBlur = true` on a comp, `layer.motionBlur = true` on a layer.

**`delete_comp` on a shot takes every layer that nests it with it**, in the
master and anywhere else, silently. To replace a shot with a rebuilt one, build
the new comp under a working name, point each nesting layer at it — `run_jsx`:
`layer.replaceSource(newComp, false)`, then `startTime`, `inPoint` and
`outPoint` written again, because the swap keeps the old timing — and delete
the old comp only once nothing nests it (`return compById(oldId).usedIn.length`
reads `0`); then rename.

## Markers at the beats

`add_marker({compId, time, comment})` with no `layerId` puts a **comp marker**
on the master; with a `layerId` it marks the layer. Put one at every beat you
cut to, with the beat's words in `comment`, before you place a single shot — the
offsets then have a name, the user sees the structure in the timeline, and a
later session reads the plan off the comp instead of re-deriving it. `duration`
turns a marker into a span, which suits a shot's whole run.

## Checking an assembly

**Verify the master by reading it back; screenshot the shots.**
`get_comp_tree({compId: master})` shows the nesting, `list_layers({compId,
include: ["timing"]})` shows where each shot starts and ends, and
`snapshot_comp` → `diff_comp` confirms a placement moved only the layer you
meant. A master is the heaviest thing you can render and the first to come back
`Corrupt frame`; a shot comp screenshots cheaply and shows the same picture. A
camera move across the master is a null parented while at identity — the
`animation` topic has the arithmetic.

Four rules for the screenshots you do take:

- **A shot comp with no background renders its empty areas transparent, and
  what a transparent area looks like is the viewer, not the set** — white,
  often, or a sheet's dark gutter. Judge sky, ground and anything that reads
  against the background on the assembled comp over its real background, or
  put a temporary solid behind the shot.
- **Detail under about 40 px is judged at `downsample: 1`, never from a
  downsampled frame** — a stroke, a label, a small icon blur or vanish at the
  default factor. `screenshot_layer` isolates the layer but is still a whole
  frame; for a detail in a heavy comp, a small temporary comp of a few hundred
  pixels that nests the shot scaled up around the detail is what makes full
  resolution affordable.
- **A contact-sheet tile that contradicts a property read-back is re-rendered
  as a single frame before anything is changed.** A tile can be stale — the
  sheet names it when it can tell — and a read-back cannot, so the
  disagreement is a question about the picture, not about the property.
- **A cut is verified with a Difference render.** In a temporary comp, the
  outgoing shot at its last frame under the incoming shot at its first
  (`create_precomp_layer` twice, `set_layer` with `startTime` so those two
  frames fall on the same comp time), the top layer at
  `set_layer({blendingMode: "DIFFERENCE"})`, both over one solid so both sides
  are opaque, collapse off on both — a collapsed layer ignores its blending
  mode. `screenshot_frame` at that time: anything not black is where the two
  frames disagree.
