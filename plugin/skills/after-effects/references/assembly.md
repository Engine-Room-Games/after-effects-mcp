---
name: assembly
reference: after-effects
description: Assembling shots into a master comp — each shot built in its own comp in local time and placed at its offset, comp markers at the beats, retiming or trimming a shot without touching its contents, and the precomp that renders nothing before its startTime. Load when a task has more than one scene, a narration to cut to, or a shot to move in time.
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

## Markers at the beats

`add_marker({compId, time, comment})` with no `layerId` puts a **comp marker**
on the master; with a `layerId` it marks the layer. Put one at every beat you
cut to, with the beat's words in `comment`, before you place a single shot — the
offsets then have a name, the user sees the structure in the timeline, and a
later session reads the plan off the comp instead of re-deriving it. `duration`
turns a marker into a span, which suits a shot's whole run.

## Checking an assembly

`get_comp_tree({compId: master})` shows the nesting, and `snapshot_comp` →
`diff_comp` on the master confirms a placement moved only the layer you meant.
A master is the heaviest thing you can screenshot: when a frame of it comes back
`Corrupt frame`, screenshot the shot comps one at a time instead and trust the
master's layer timing from the read. A camera move across the master is a null
parented while at identity — the `animation` topic has the arithmetic.
