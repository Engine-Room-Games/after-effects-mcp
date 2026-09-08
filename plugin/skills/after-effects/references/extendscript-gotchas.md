---
name: extendscript-gotchas
reference: after-effects
description: The run_jsx reference — when to script instead of calling a tool, how much one call can do before the timeout, scriptPath and libraries as the normal way to build, the helpers already in scope, and the ExtendScript facts that abort a script while naming something else (property lookups that return null, a `.value` read at the playhead rather than at a time, effects addressed by a name that is not unique, a track matte that switches its matte's video off, ease arrays sized per property, a TextDocument that stores the wrong justification, output-module settings that are read-only, the reserved words that stop a script before its first line). Read it before writing raw ExtendScript, not after it fails.
---

# Scripting After Effects with run_jsx

`run_jsx` executes arbitrary ExtendScript inside After Effects. Reach for it
when a needed operation has no tool — the render queue, a bulk edit no single op
expresses, a rig that is easier to describe as a loop than as forty calls. Check
the tool list first: duplicating a comp, easing a keyframe, reordering a layer,
placing a shape layer at a sane origin and scoring a scene all have tools, and
each wraps a trap on this page. The whole `OPS` table is in scope, so a script
can call any tool as a function and keep to the DOM for the part no tool covers.

## How much one call can do

- **Timeouts.** A call gets 120 s by default; `run_jsx`, `run_batch`, the two
  screenshot ops, `export_mogrt`, `import_footage` and `place_audio_cues` get
  300 s. `AE_MCP_OP_TIMEOUT_MS` in the server's environment raises every one of
  them. ExtendScript is single-threaded, so After Effects' interface is frozen
  for as long as the script runs, and a script that outlives its limit looks to
  the server exactly like a dead bridge — the "did not answer in time" failure —
  while it carries on running to the end.
- **In practice, about 60 layers' worth of creation and keying per call** is
  where a scene build stays well inside the limit (reported from a
  fourteen-scene, thousand-layer build). Split a big build by scene, not by op;
  the same op repeated hundreds of times is `run_batch`, which chunks itself.
- **Source size** — the script plus every library it names — is capped at 1 MB
  per call, because libraries are inlined into the call, so every byte travels
  every time.

## Build from files, not from the conversation

Inline `code` is for a probe or a one-liner. A build is written as files:

- **`scriptPath`** runs an absolute `.jsx` path. The server reads it, so the
  script is paid for once, on disk, rather than once per call in the
  conversation and again on every later request.
- **`libraries`** takes absolute `.jsx` paths and inlines them ahead of the
  script, in the same scope, so their functions are callable from it. A library
  is re-read and re-evaluated on every call, so keep it to declarations rather
  than to work; it is parse-checked on its own before the script runs, and a
  failure inside one is reported against that file, by name and line.

The rule: a script file is paid for once; a helper shared by two scripts belongs
in a library, never pasted into both. `code` and `scriptPath` are exclusive.

Pass **`diff: true`** on any script that writes. It fingerprints the comp
around the call and appends only what changed — layers added, renamed, retimed,
keyframe counts — so the script reports what it did instead of you reading the
comp back, and on a throw the diff rides on the error, which is how you find
where a half-applied script stopped.

## What you already have

Before you write a helper, check it is not in scope. Each of these wraps a trap
on this page, and a version you write yourself re-derives the bug.

- **`OPS`** — the whole tool table:
  `OPS.set_transform({compId, layerId, position: [0, 0]})`. Anything a tool
  already does well, do this way rather than reaching into the DOM.
- **`compById(id)` / `layerById(compOrId, layerId)`** — the pair every tool
  returns, resolved. No index arithmetic.
- **`walkProperty(layer, ["Transform", "Position"])`** — a property path,
  resolved the way the tools resolve it.
- **`addKeys(prop, [[t, v], …])`** — returns the key index of each, in order, so
  the next call can ease them without searching.
- **`ease(prop, keyIndex, easeIn, easeOut)`** — sizes the KeyframeEase array
  itself; see "Keyframes and easing" below for why that is not optional.
- **`shape(comp, {name, position})`** — a shape layer whose origin is `[0,0]`.
- **`withoutUndoGroup(fn)`** — closes the undo group around one statement, which
  is what `copyToComp` needs.

## Adobe's documentation describes an ExtendScript After Effects 2026 does not implement

Every item here is measured on 26.3, and several contradict Adobe's reference:
`$.evalFile` evaluates into the calling function's scope, not the global one;
`Error.start` and `Error.end` are `0` on every error, however far in the throw
was; an undo group opened in one script call and closed in another is
discarded; `CompItem.posterTime` does not exist; `exportAsMotionGraphicsTemplate`
invalidates `app.project` itself, not only the comp passed to it. None of them
raise — each returns exactly what success returns. When this page and Adobe's
reference disagree, this page was measured; and before you build on a
documented behaviour nothing here mentions, write the three-line probe that
proves it.

## Property names that return null

`layer.property(matchName)` returns **null** for a name that does not exist on
that layer. It does not throw, so the failure lands later, somewhere else, as
`null is not an object`. When a lookup might miss, check for null on the line
that does it.

- **2D rotation is `ADBE Rotate Z`.** `layer.property("ADBE Rotation")` is
  null; `layer.transform.rotation` is the safe form.
- **Audio levels are `layer.audioLevels`.** `layer.property("ADBE Audio
  Levels")` is null on an audio layer — the level is never set, on every layer,
  silently. *The tool already does:* `place_audio_cues`.
- **Time remap is `layer.timeRemap`.** `layer.property("ADBE Time Remap")` is
  null on audio layers and on precomp layers, even after
  `timeRemapEnabled = true`.
- **`instanceof` is unreliable on host objects.** Probe instead: a shape layer
  is one where `property("ADBE Root Vectors Group")` is non-null, and a
  project item's kind is `item.typeName` — `"Composition"`, `"Footage"`,
  `"Folder"` — a string compare that needs no class.

## Reading and writing values

- **`.value` is the value at the comp's current time** — wherever the user
  left the playhead, not time zero — so on a keyed or expression-driven
  property it is one sample from a moment you did not choose. Read at the
  time you mean with `valueAtTime(t, false)`, the post-expression value
  (`true` is pre-expression). To bake a driven property, sample every time
  you need first, then remove the expression, then the keys: each of those
  changes what the next read returns.
- **`setValue` on a comp that is not open in a viewer can throw with the
  value already applied.** Open the comp first — `comp.openInViewer()`, or
  `set_active_comp` from outside — and on such a throw read the property back
  before retrying: the write may already be there.

## Layers and comps

- **A `comp.layer(n)` reference is index-bound, not a handle.** Once a
  `copyToComp` or a `duplicate()` has shifted the destination's indices, a
  reference taken earlier resolves to a *different* layer — which is how a script
  parents a layer to itself. Re-resolve by id or name after anything that
  inserts a layer.
- **`copyToComp` does not put the copy at index 1.** The first copy lands on
  top; each later copy lands *below the previous copy*, so `dest.layer(1)` keeps
  handing back the same layer. Identify a copy by diffing the set of layer ids
  before and after the call, or pass `diff: true`.
- **`copyToComp` needs the undo group closed.** AE refuses to copy a layer that
  has a parent or a linked expression while an undo group is open — exactly the
  rig worth copying. Wrap that one call in `withoutUndoGroup(function () { … })`,
  or pass `undoGroup: false` for the whole script and accept whatever undo steps
  AE records on its own.
- **A copied layer carries parent-relative values.** Parented to a null that
  was not at identity, it renders offset in the destination. Check the first
  frame against the source; fix it with an intermediate null carrying the
  inverse offset, re-parenting while the new parent is at identity.
- **Set the parent first, the transform second.** Raw `layer.parent = x` does
  not reliably preserve where a layer sits two levels deep, so after scripted
  parenting audit scale and rotation as well as position. *The tool already
  does:* `parent_layer` with `preserveTransform`.
- **`app.executeCommand(id)` silently no-ops** through this bridge. Menu
  commands depend on host focus and the active selection, and the bridge has
  neither; the call returns without complaint and nothing happens. Use the API
  equivalents — `CompItem.duplicate()`, `layer.duplicate()`. *The tool already
  does:* `duplicate_comp`, whose `deep: true` also duplicates the nested comps,
  which `CompItem.duplicate()` alone does not.
- **`moveTo` is a shape-node method, not a layer method.** `layer.moveTo(n)`
  throws `parent is not an INDEXED_GROUP`, naming a concept the caller never
  mentioned. Layers move with `moveBefore` / `moveAfter` / `moveToBeginning` /
  `moveToEnd` — the first two take a **layer**, never an index, and the two
  directions need different primitives: moving up, `moveBefore` lands on the
  target; moving down the target shifts up as the layer leaves, so `moveAfter`
  is the one that lands on it. *The tool already does:* `reorder_layer`.
- **Assigning a track matte switches the matte layer's video off.** That is
  After Effects' own default, and `setTrackMatte` and `trackMatteType` both
  do it. A layer that is both a matte and visible art gets `enabled = true`
  again after every call that points a matte at it; read the switch back
  rather than assuming.
- **`replaceSource` keeps the layer's old timing.** `startTime`, `inPoint`
  and `outPoint` stay where the previous source put them, so a longer or
  shorter file arrives trimmed to the old one. After the swap write
  `startTime`, then `inPoint`, then `outPoint`, and read them back; on a
  time-remapped layer turn `timeRemapEnabled` off before the swap and on
  again after it, so the default keys are rebuilt for the new duration.
- **Removing a comp removes every layer that nests it**, in every comp,
  without a word. The `assembly` topic has the replacement flow.
- The layer stack builds back-to-front — every `layers.add*()` lands at
  index 1, on top — which the `shapes` topic states beside the `Contents`
  order it is the opposite of.

## Effects

- **Effects are addressed by display name, and the name is not unique.**
  `effects.property("Slider Control")` returns the *first* effect with that
  name, so a second slider added under the default name is unreachable by
  name and a write meant for it silently drives the first. Name each control
  as you add it (`fx.name = "Zoom"`), or remove a same-named one first; from
  outside, `list_effects` reports every effect's name and index and
  `set_effect_param` takes the index.
- **Adding an effect invalidates every effect reference held on that layer**,
  a second Slider Control included: the group re-indexes and an earlier
  handle throws `Object is invalid`, the way a shape node reference goes
  stale when a sibling is added. Add every effect first, then resolve each by
  name and set its parameters.

## Shapes

Render order inside `Contents`, references that go stale when a sibling is
added, and the coordinate space of a new shape layer bite the tool path as much
as a script, so they are in the `shapes` topic. The raw-scripting traps:

- **`comp.layers.addShape()` spawns at the comp centre** with the anchor at
  `(0,0)`, so contents authored in comp coordinates land offset by half a frame.
  Zero the position before adding anything to `Contents` — the `shape()` helper
  does.
- **Polystar type is `1 = Star`, `2 = Polygon`** on `ADBE Vector Star Type`.
  Type 2 *hides* Inner Radius, so setting it after choosing polygon throws
  `property is hidden`. A gear is type 1.
- **Stroke dashes do not take.** `addProperty("ADBE Vector Stroke Dash 1")`
  followed by `setValue` throws the same hidden-property error. A dashed band
  that does work: a small square plus a Repeater (`ADBE Vector Repeater
  Transform` → `ADBE Vector Repeater Position` set to `[2 * side, 0]`) in a
  group in front, over a plain rect in a group behind.

## Text

- **Do not write `justification` into a `TextDocument` from a script.** On
  26.3, `d.justification = ParagraphJustification.CENTER_JUSTIFY;
  prop.setValue(d)` on a layer made with `addText()` lands as RIGHT (`7414`):
  the enum reads correctly in that scope (`CENTER_JUSTIFY` is `7415`, LEFT
  `7413`), the setter stores the wrong value, and LEFT only appears to work
  because it is `addText()`'s default. Set font, size, colour and tracking
  through the `TextDocument` if you like, then set justification through the
  tool — `OPS.set_text({compId, layerId, justification: "center"})` inside the
  script, or `set_text` / `create_text_layer`'s `anchorAlign` from outside —
  and verify with `get_layer_full({…, include: ["bounds"]})`: a centred layer's
  `sourceRect.left` is about `-width / 2`, a left-justified one's about `0`.
  The tool path gets a check a script does not: `set_text` and
  `create_text_layer` read the justification back after the write, re-assert it
  once if it moved, and throw naming expected and actual if it still disagrees,
  so the `justification` they return is what the layer shows.

## Keyframes and easing

- **`setTemporalEaseAtKey` wants one `KeyframeEase` per ease dimension, and
  that count belongs to the property, not to its value.** Measured on 26.3:
  Opacity and sliders take 1; a 2D layer's **Scale takes 3** while its value
  reads `[x, y]`; a shape's **Ellipse Size takes 2** while its value reads
  `[w, h]`; Position and Anchor Point take 1 whether the layer is 2D or 3D,
  because the ease runs along the motion path. Each of those is the opposite of
  the sensible guess — and one session on 26.3 had a 2D layer's Position
  accept only **3** through raw `setTemporalEaseAtKey`, a single observation
  not yet reproduced. The point is that the count is not derivable, from the
  value's length or from this list. The wrong one throws `Value array does not
  have N elements` about `parameter 2` and aborts the script there. So never
  size it by hand: `ease(prop, keyIndex, easeIn, easeOut)` is in scope and is
  the same code `set_temporal_ease` runs — it walks 1, 2, 3, 4 until one takes
  and returns the count that worked; the tools report the same number as
  `easeDimensions`. A bare number means influence; omitting `easeOut` uses the
  same ease both sides. And **put eases after every geometry and key write in
  the script**, so an ease that still fails loses nothing above it.
- **The key lookup is `nearestKeyIndex(t)`**, not `nearestKeyAtTime`.
- **Removing the last Time Remap key hides the property.** After
  `while (tr.numKeys) tr.removeKey(1)` the next `setValueAtTime` (or
  `addKeys`) throws `Can not "set value at time" with this property, because
  the property or a parent property is hidden`, the script dies there, and the
  layer is left remap-enabled with no keys. Setting `timeRemapEnabled = true`
  already creates the two keys a loop needs — `[inPoint, 0]` and
  `[inPoint + source duration, source duration]` — so there is no reason to
  clear them: edit those keys in place, or put an expression over them —
  `(time - startTime) % thisLayer.source.duration` loops — which overrides
  them without touching them. If your keys must sit at other times, add them
  **before** removing the two defaults: only a property with no keys at all
  hides. And re-assert `outPoint` after `timeRemapEnabled = true`, because
  enabling it resets the layer's end — on a remapped layer set `outPoint`
  before `inPoint` and read both back, since an in point past the source's
  natural end moves the layer instead of trimming it until the out point has
  let it extend. If the keys are already gone, toggle `timeRemapEnabled` off
  and on to get the defaults back. *The tool already does:* `place_audio_cues`
  with `loop: true`.

## Render queue and output modules

- **`OutputModule.setSettings` rejects Format, Channels, Depth and Color as
  read-only** — `Invalid Value for key: <Depth>. Property is read-only`, and
  likewise `<Channels>`, `<Format>`, `<Color>` — although
  `getSettings(GetSettingsFormat.SPEC)` lists full enum tables for all four.
  SPEC reports a setting's domain, not whether it is writable;
  `GetSettingsFormat.STRING_SETTABLE` is the honest list, and it omits all four.
  Measured on 26.3 from four starting states (after `applyTemplate` of a ProRes
  template, after the stock alpha templates, after a TIFF sequence, and on a
  fresh output module setting Format alone), so it is not codec gating. "Video
  Codec" is not in SPEC at all; it lives behind the QuickTime Format Options
  dialog, which has no scripting surface.
- **So codec, bit depth and alpha cannot be set from a script.** A person builds
  the output module once in the UI — Edit > Templates > Output Module > New, or
  Make Template from the Render Queue's Output Module menu — under a known name,
  and scripts (`om.applyTemplate(name)`) and `aerender -OMtemplate "<name>"`
  apply it by name. Templates live in AE's preferences, so one creation covers
  every project on the machine. Before trusting a template, apply it and read
  `getSettings(GetSettingsFormat.STRING)` back: an alpha-incapable codec such as
  ProRes 422 HQ reports Channels `RGB` and will not be talked out of it.
- **A failed `setSettings` throws before any cleanup line runs**, so a temporary
  render-queue item added earlier in the script stays in the user's queue. Add
  temporary items inside `try { … } finally { item.remove(); }`, or sweep the
  queue at the top of the next call.

## Undo groups

- **An undo group does not survive a script boundary.** `beginUndoGroup` in one
  `evalScript` call and `endUndoGroup` in another produces no group at all —
  After Effects discards it, `endUndoGroup()` returns exactly as it does on
  success, and the only place the truth is visible is AE's Edit menu. Anything
  spanning calls opens and closes its own group per call. *The tool already
  does:* `run_batch` reports the measured `undoSteps`.
- **`copyToComp` needs the group closed**, which is the opposite problem — see
  "Layers and comps".

## The language itself

ExtendScript reserves words JavaScript does not: **`short`, `int`, `char`,
`byte`, `long`, `float`, `double`, `boolean`**. `var short = …` fails with
`Illegal use of reserved word` and **nothing in the script runs** — every side
effect you expected is simply absent, which reads exactly like a bridge failure.
`s`, `n`, `count`, `flag` cost nothing.

The rest of the dialect is ES3: no `let`/`const`, no arrow functions, no
template literals, no `Object.keys`, no destructuring, no trailing commas.

## Reading the result, and a failure

`return X` sends the whole value back — arrays and nested objects included.
Values that cannot be represented come back as a marker string in place, never
dropped: a live AE object as `"[AVLayer \"Hero\" #616]"`, which is a handle to
pass to `get_layer_full`, not a copy of the layer. An empty result therefore
means the script returned nothing.

**A bare expression is not a return.** `"ping";` as the last line yields
nothing, and so does any script that just does its work. That case comes back
as `{ok: true, returned: null, undoGroup, note}` — an envelope that says *the
script ran to completion*. Do not re-run it; add an explicit `return` if you
want a value.

**On a failure, read the error before you touch anything.** It names the line
of *your* script and prints that line's text; a line inside a library is
attributed to that file; and when the number cannot be mapped it says so rather
than guessing. Everything above that line already ran and nothing rolls back,
so find out what landed — `diff: true` appends it to the error; otherwise
`diff_comp`, `get_comp_tree` or `find_layers` — and never re-run the script to
see whether it fails again: the lines above the failure apply a second time.
