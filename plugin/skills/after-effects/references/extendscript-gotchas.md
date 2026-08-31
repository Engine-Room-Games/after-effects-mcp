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

Three rules that make all of it cheaper:

- **Nothing rolls back.** A script that fails halfway leaves everything before
  the failure applied. A failure names the line of your script and prints its
  text, so start there — then read the state back, or pass `diff: true` and let
  the call tell you what landed. Never re-run a mutating script to see whether
  it fails again.
- **Prefer the tool.** Most of what follows is a trap that only exists because
  you dropped to raw scripting. `add_shape_content`, `set_temporal_ease`,
  `create_shape_layer`, `place_audio_cues`, `duplicate_comp` and `parent_layer`
  resolve names, sizes and orders for you and fail loudly when they cannot. Each
  item below names the tool that already handles it, where there is one.
- **Do not paste what is already in scope.** See "What you already have" at the
  end before you write a helper of your own.

## Property names that return null

`layer.property(matchName)` returns **null** for a name that does not exist on
that layer. It does not throw, so the failure lands later, somewhere else.

- **2D rotation is `ADBE Rotate Z`.** `layer.property("ADBE Rotation")` is null.
  `layer.transform.rotation` is the safe form.
- **Audio levels are `layer.audioLevels`.**
  `layer.property("ADBE Audio Levels")` is null on an audio layer, which is the
  trap a hand-written sound-placement loop hits on its first cue. *The tool
  already does:* `place_audio_cues` places a whole cue list in one undo step,
  all-or-nothing, with a `dryRun`.
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
  position immediately, before you add anything to `Contents`. *The tool already
  does:* `create_shape_layer` defaults to `[0,0]` (`position: "center"` restores
  AE's spawn point), and the `shape(comp, {name, position})` helper does it
  inside a script.
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
- **`app.executeCommand(id)` can silently no-op** through this bridge. Menu
  commands depend on host focus and the active selection, and this bridge has
  neither. Use the API equivalents — `CompItem.duplicate()`, `layer.duplicate()`.
  *The tool already does:* `duplicate_comp` returns the new comp id, and
  `deep: true` duplicates the nested comps and re-points the copy at them, which
  `CompItem.duplicate()` alone does not.

## Keyframes and expressions

- **`setTemporalEaseAtKey` sizes its ease array per property, not per value
  dimension.** A 2D layer's Scale wants 2, a shape Ellipse Size wants 3, a slider
  or Opacity wants 1, and a *spatial* property — Position, Anchor Point — wants
  exactly 1 whether the layer is 2D or 3D, because the ease runs along the motion
  path rather than per axis. The wrong count throws about `parameter 2` or
  `Value array does not have 1 elements`. If you are scripting this by hand, try
  1 then 2 then 3 in a try/catch — or, better, do not: the `ease(prop, keyIndex,
  easeIn, easeOut)` helper is in scope and *is* the sizing code
  `set_temporal_ease` uses, not a second copy of it, so a script and a tool call
  can never disagree about what a property wanted. A bare number means
  influence; omitting `easeOut` uses the same ease both sides; the return value
  is the number of entries that worked. *The tool already does:*
  `set_temporal_ease` and `add_keyframe` take one `{influence, speed}` pair per
  side and report `easeDimensions`.
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

**The error names the line of your script and prints its text.** Believe it —
and when it says the number could not be mapped, believe that too: it is refusing
to guess rather than pointing you at a plausible wrong line.

Everything above that line already ran. To find out exactly what landed, pass
`diff: true` and the call appends what changed to the error itself; otherwise
read it back with `diff_comp`, `get_comp_tree` or `find_layers`. **Never re-run
the script to see whether it fails again** — nothing rolled back, so the lines
above the failure apply a second time.

And remember what a *successful* script with no `return` looks like:
`{ok: true, returned: null, undoGroup, note}`. That is completion, not failure.
Re-running it applies every mutation a second time.

## What you already have

Before you write a helper, check it is not in scope. Every one of these wraps a
trap on this page, and a version you write yourself re-derives the bug.

- **`OPS`** — the whole tool table, callable from inside a script:
  `OPS.set_transform({compId, layerId, position: [0, 0]})`. Anything a tool
  already does well, do it this way rather than reaching into the DOM.
- **`compById(id)` / `layerById(compOrId, layerId)`** — the pair every tool
  returns, resolved. No index arithmetic.
- **`walkProperty(layer, ["Transform", "Position"])`** — a property path,
  resolved the same way the tools resolve it.
- **`addKeys(prop, [[t, v], …])`** — returns the key index of each, in order, so
  the next call can ease them without searching.
- **`ease(prop, keyIndex, easeIn, easeOut)`** — sizes the KeyframeEase array.
- **`shape(comp, {name, position})`** — a shape layer at `[0,0]`.
- **`withoutUndoGroup(fn)`** — closes the undo group around one statement, which
  is what `copyToComp` needs.

And two arguments rather than more code: **`scriptPath`** runs an absolute `.jsx`
path so a long script never enters the conversation at all, and **`libraries`**
takes absolute `.jsx` paths and inlines them ahead of the script, in the same
scope, so their functions are callable from it. The server reads both, so
neither file's text enters the conversation. A library is re-evaluated on every
call — keep libraries to declarations rather than to work — and a failure inside
one is reported against that file, by name and line. Keep shared helpers in a
library instead of pasting them into every script.
