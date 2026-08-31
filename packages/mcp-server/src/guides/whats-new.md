---
name: whats-new
reference: after-effects
description: What changed in the After Effects tools recently, newest first — the behaviour differences worth knowing if you last used an older build, and the version gate you will meet after an upgrade. Read it when a call behaves differently from what you expected, or when the user says a tool used to do something else.
---

# What changed

Read this when something behaves differently from what you expected, or when the
user tells you a tool used to work another way. It is the release notes an agent
needs rather than the ones a human reads.

**When this topic and a tool's own schema disagree, believe the schema.** It is
refreshed at each release and a build in between can be ahead of it.

## 0.4.0

- **The guidance moved.** What the server sends every session is now a short
  pointer rather than a summary, because it was resident in every request the
  user ever made. The narrative lives in `ae_guide({topic: "after-effects"})`,
  and two topics sit behind it for when you need them: `extendscript-gotchas`
  before writing raw `run_jsx`, and this one. In Claude Code and claude.ai the
  same text is the `after-effects` skill and the files in its `references/`
  folder — load one carrier, not both.
- **Rigging is written down.** Opacity not propagating through parenting, and
  parenting to a camera null while it is still at identity, are in the main
  guide now. They were the two that cost the most review rounds.

More is landing in this release than the two entries above; the topic is brought
up to date at release. Where it is silent and a tool's schema is not, the schema
is right.

## 0.3.1

- **Shape reads got much cheaper.** `get_layer_full` no longer returns
  `ADBE Vector Materials Group` — the 48-property 3D extrusion model AE hangs
  off every vector group, which means nothing on a 2D shape layer. It
  was around three quarters of the bytes of a shape read: one 68px circle cost
  4,400 tokens, of which the geometry was about 40. `materialsOmitted` counts
  what was dropped; `shapeMaterials: true` brings it back for a genuinely
  extruded shape. A group Transform still at its creation values collapses to
  `atDefaults: true` the same way.
- **`shapeDetail: "compact"`** returns one indented line per group instead of
  the JSON tree — every name the write tools address a node by, with `[3 keys]`
  or `[expr]` marking the animated properties. Measured end to end on one real
  layer: 13,369 characters before this release, 3,052 once the materials block
  went, 643 compact. Reach for `"full"` only when you need exact values or
  keyframe indices.
- **`run_jsx` never answers a bare `null`.** A script whose last statement is a
  bare expression completes and returns nothing — `"ping";` does not return
  `"ping"` — and that used to be indistinguishable on the wire from a script
  that never ran. It now comes back as
  `{ok: true, returned: null, undoGroup, note}`, which means *it ran to
  completion*. Do not re-run it: nothing rolls back, so a second run of a script
  that duplicated a layer or wrote keyframes does all of it twice. A returned
  value still comes back bare, falsy ones included.

## 0.3.0

- **Bounded reads.** `list_comps`, `list_layers` and `get_layer_full` take
  `include` to name the sections you want, plus `maxKeyframes` and `shapeDepth`
  on the deep read. Omit them all and you get everything, exactly as before.
  Anything left out is named and counted in the response (`included`,
  `keyframesOmitted`, `childrenOmitted`), so a short answer never passes for a
  complete one. This matters more than it sounds: a tool result is re-sent to
  you on every later request for the rest of the session, so one unbounded read
  is paid for many times.
- **Screenshots downsample themselves.** Omit `downsample` and it is derived
  from the comp — 2 at 1080p, 3 at 4K, aiming at a long edge near 1280px. The
  result reports the size actually returned. Pass `downsample: 1` only when you
  genuinely need full resolution.
- **A stale frame is now an error, not a picture.** AE sometimes re-serves a
  frame it rendered for an unrelated request, at a different time and even at a
  different downsample factor, with nothing in the response to say so. Those are
  refused with `Stale frame` naming the request whose pixels came back. Wait a
  few seconds and retry at a higher `downsample`.
- **A fully transparent frame comes back as `{empty: true, reason}`** with no
  image. That is a fact about the composition — wrong time, layer outside its
  in/out points, disabled, zero opacity — not something to retry.
- **Footage import**, with `import_footage` and `create_footage_layer`. The
  import refuses an SVG whose `viewBox` asks for one aspect ratio and imports at
  another: that is a real AE bug which renders as nothing at all, with no error
  at any stage.
- **`export_mogrt`**, which suppresses the modal dialogs that otherwise freeze
  this whole connection until someone clicks them in After Effects. Never drive
  `exportAsMotionGraphicsTemplate` from `run_jsx`.
- **Text alignment is justification**, not a measured anchor offset, so it stays
  correct when the text changes later. Tracking is set explicitly rather than
  inherited from the user's Character panel.

## Older, but you will meet it first

**The panel is versioned separately from the tools, and it does not update
itself.** It loads at After Effects launch and only at launch, so after any
upgrade the tools can be newer than the code answering them. When that happens a
call returns a remediation message rather than a confusing `Unknown op` — relay
it. The distinction worth reading carefully: if it says the panel is *installed*
but the running one is older, running `setup_panel` again changes nothing and
only quitting and reopening After Effects will.
