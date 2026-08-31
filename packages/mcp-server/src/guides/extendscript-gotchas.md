---
name: extendscript-gotchas
reference: after-effects
description: The ExtendScript facts that cost a run_jsx script an aborted run — property names that return null, shape node types that hide their own properties, what copyToComp actually does, comp time versus layer time, and the reserved words that stop a script before its first line. Read this before writing raw ExtendScript, not after it fails.
---

# ExtendScript gotchas

Everything here was paid for once already. One video's build — fourteen scenes,
each assembled by a fresh agent, roughly a thousand layers — lost at least one
aborted script to every item below, and three to some of them. Measured on After
Effects 2026 (26.3) through this server at 0.3.1.

Read it **before** you write the script. Most of these fail in a way that names
the wrong thing: a null returned here surfaces as `null is not an object` twenty
lines later, and a reserved word means **nothing in the script runs at all**
while the error points at one line in the middle.

Two rules that make all of it cheaper:

- **Nothing rolls back.** A script that fails halfway leaves everything before
  the failure applied. Read the state back to find where it stopped; do not
  re-run it and hope.
- **Prefer the tool.** Most of what follows is a trap that only exists because
  you dropped to raw scripting. `add_shape_content`, `set_temporal_ease`,
  `parent_layer` and the rest resolve names, sizes and orders for you and fail
  loudly when they cannot.

## Property names that return null

`layer.property(matchName)` returns **null** for a name that does not exist on
that layer. It does not throw, so the failure lands later, somewhere else.

- **2D rotation is `ADBE Rotate Z`.** `layer.property("ADBE Rotation")` is null.
  `layer.transform.rotation` is the safe form.
- **Time remap is an attribute, not a property lookup.**
  `layer.property("ADBE Time Remap")` is null on audio layers and on precomp
  layers, *even after* setting `timeRemapEnabled = true`. Use `layer.timeRemap`.
  Audio levels are `layer.audioLevels` the same way.
- **`instanceof` is unreliable on host objects.** `x instanceof Layer` cannot be
  trusted to identify a layer kind. Probe instead: a shape layer is one where
  `property("ADBE Root Vectors Group")` is non-null.

When a lookup might miss, check for null on the line that does the lookup. That
turns a misleading error twenty lines away into an accurate one here.

## Shapes

- **`comp.layers.addShape()` spawns the layer at the comp centre** (960,540 at
  1080p, 1920,1080 at 4K) with its anchor at (0,0). If you then build contents in
  comp coordinates the whole drawing lands offset by half a frame. Zero the
  position immediately, before you add anything to `Contents`.
- **Polystar type is `1 = Star`, `2 = Polygon`** on `ADBE Vector Star Type`.
  Type 2 *hides* Inner Radius, so setting inner radius after choosing polygon
  throws `property is hidden`. A gear is type 1.
- **Stroke dashes do not take.** `addProperty("ADBE Vector Stroke Dash 1")`
  followed by `setValue` throws the same hidden-property error on this build. A
  dashed or hazard-tape band that does work: a small square plus a Repeater
  (`ADBE Vector Repeater Transform` → `ADBE Vector Repeater Position` set to
  `[2 * side, 0]`) in a group in front, over a plain rect in a group behind.
- **Render order is the reverse of the layer stack.** Index 1 in `Contents`
  renders in front and `addProperty` appends to the end, so the first node you
  add is the one on top. Build front-to-back.
- **A node reference goes stale when a sibling is added.** Hold a Fill, add a
  Stroke to the same group, and the Fill reference starts throwing
  `Object is invalid`. Add every node first, then re-fetch by name before
  setting values.

## Layers and comps

- **`copyToComp` does not put the copy at index 1.** The first copy lands on
  top; each later copy lands *below the previous copy*, so `dest.layer(1)` keeps
  handing back the same layer while you think you are collecting new ones.
  Identify the copy by diffing the set of layer ids before and after the call.
- **`copyToComp` needs the undo group closed.** AE refuses to copy a layer that
  has a parent or a linked expression while an undo group is open — which is
  exactly the rig worth copying. Wrap that one call in
  `withoutUndoGroup(function () { … })`, or pass `undoGroup: false` for the whole
  script and accept whatever undo steps AE records on its own.
- **A copied layer carries parent-relative values.** If it was parented to a null
  that was not at identity, it renders offset in the destination. Check the first
  frame against the source; fix it with an intermediate null carrying the inverse
  offset, re-parenting while the new parent is at identity.
- **A comp layer renders nothing before its `startTime`.** You cannot hold a
  rigged precomp at its pre-animation state by pushing `startTime` past the shot
  — you get an empty frame. Freeze the start by duplicating the comp and
  stripping the keys; freeze the end past the source duration with time remap and
  `Math.min(time + off, dur - 0.1)`.
- **Set the parent first, the transform second.** Raw `layer.parent = x` inside a
  script does not reliably preserve where the layer sits two levels deep, so
  after scripted parenting audit scale and rotation as well as position.
  `parent_layer` does this correctly and takes `preserveTransform`.
- **`app.executeCommand(id)` can silently no-op** through this bridge. Use API
  methods — `CompItem.duplicate()`, `layer.duplicate()` — not menu command ids.

## Keyframes and expressions

- **`setTemporalEaseAtKey` sizes its ease array per property, not per value
  dimension.** A 2D layer's Scale wants 2, a shape Ellipse Size wants 3, a slider
  or Opacity wants 1, and a *spatial* property — Position, Anchor Point — wants
  exactly 1 whether the layer is 2D or 3D, because the ease runs along the motion
  path rather than per axis. The wrong count throws about `parameter 2` or
  `Value array does not have 1 elements`. If you are scripting this by hand, try
  1 then 2 then 3 in a try/catch. The `set_temporal_ease` tool knows the spatial
  rule — see the array-size trap in the main guide — which is one more reason to
  use it rather than reaching in.
- **The key lookup is `nearestKeyIndex(t)`**, not `nearestKeyAtTime`.
- **Expression `time` is comp time, not layer time.** Shifting a layer's
  `startTime` moves its keyframes and leaves its expressions where they were, so
  a `Math.min(time, 0.75)` freeze replays from zero in the shifted copy. Rewrite
  `\btime\b` to `(time + offset)` in the expressions of any layer you retime.

## The language itself

ExtendScript reserves words JavaScript does not: **`short`, `int`, `char`,
`byte`, `long`, `float`, `double`, `boolean`**. `var short = …` fails with
`Illegal use of reserved word` and **nothing in the script runs** — every
side effect you expected is simply absent, which reads exactly like a bridge
failure. `s`, `n`, `count`, `flag` cost nothing.

The rest of the dialect is ES3: no `let`/`const`, no arrow functions, no
template literals, no `Object.keys`, no destructuring, no trailing commas.

It is also **single-threaded**, so a long synchronous loop freezes the user's AE
window and looks to this server exactly like a crash. Keep a script to work that
finishes in seconds; anything longer belongs in `run_batch`.

## When a script fails halfway

The reported line number does not reliably map to your source, so do not spend
long on it. Find the stop point by reading back what exists — `get_comp_tree`,
`find_layers`, `get_layer_full` — and resume from there.

And remember what a *successful* script with no `return` looks like:
`{ok: true, returned: null, undoGroup, note}`. That is completion, not failure.
Re-running it applies every mutation a second time.
