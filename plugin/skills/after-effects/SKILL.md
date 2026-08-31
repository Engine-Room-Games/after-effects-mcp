---
name: after-effects
description: How to drive Adobe After Effects well through the AE MCP tools — orienting in a project, building and animating layers, keyframes and easing, expressions, effects, text and shapes, and the gotchas that silently produce wrong output. Load whenever a task involves After Effects, motion graphics, comps, layers, or keyframes.
---

# Driving After Effects

You have direct control of a live After Effects session. The user sees every change immediately, and every tool call is a real undo step in their project. Work like a motion designer at the keyboard, not like a script that fires blind.

Two things sit *behind* this guide rather than in it, so they are not resident in
every session. Both are reachable either way — `ae_guide({topic: …})` from any
client, or the file beside this one if you loaded this as a skill:

- **`extendscript-gotchas`** (`references/extendscript-gotchas.md`) — read it
  before writing any raw ExtendScript for `run_jsx`. Property lookups that return
  null, what `copyToComp` really does, comp time versus layer time, the reserved
  words that stop a script before its first line.
- **`whats-new`** (`references/whats-new.md`) — what changed recently. Read it
  when a call behaves differently from what you expected, or the user says a tool
  used to work another way.

## Read the house style first

`get_house_style` returns the style guide for the project that is currently open
— palette, type, motion defaults, layout rules — read from `house-style.md`
sitting next to the `.aep` file. Call it once at the start of any build task and
follow what it says. It costs one cheap call and it is the difference between
work that matches everything else the user has made and work that does not.

What comes back is a **digest**, not the document: the palette as named hexes,
the type, the motion defaults, the layout rules, and a note naming anything it
could not summarise. That is a few hundred tokens and it is what you build from.
Pass `detail: "full"` when you need the guide's own wording — and always before
`set_house_style`, which replaces the whole file, so you have to send the merged
document rather than a patch. A guide written as unstructured prose comes back
`structured: false` with its opening text, which is an honest "I could not read
this as a spec", not an empty answer.

If it reports `found: false`, build with sensible defaults and offer once, at the
end, to capture a style guide from what you just made. Don't nag about it.

## Orient before you touch anything

Never guess at project state. Cheap reads exist for exactly this:

| Question | Tool |
|---|---|
| What's in this project? | `get_project_summary` |
| What comps exist? | `list_comps` |
| What's in this comp? | `get_comp_tree` |
| Everything about one layer | `get_layer_full` ⭐ |
| Where is a layer, by name/type/effect? | `find_layers` |
| What did my last change actually do? | `snapshot_comp` → `diff_comp` ⭐ |

**Making a variant of something** is `duplicate_comp`, which returns the new id
so you never go looking for it by name. Its default is a **shallow** copy, the
same as AE's own Duplicate: the copy's precomp layers point at the *same* nested
comps, so editing one edits both. That is right for "another version of this
shot" and wrong for "a variant of this rig" — for that pass `deep: true`, which
duplicates the nested comps too and re-points the copy at them.

`get_layer_full` is the one to reach for. It returns transforms **with their keyframes and expressions**, effects with every parameter, masks, markers, and `sourceRect` (the layer's visible bounds) in a single call. Prefer one `get_layer_full` over four narrow queries — it is faster and it shows you context you did not know to ask for.

### Ask for what you need

A tool result stays in your context for the rest of the session, so a read you cannot bound is paid for on every later call. All of these reads take an `include` list:

- `list_comps` / `list_layers` with `include: []` return the id-to-name map alone, which is what orientation actually needs.
- `get_layer_full` takes `include` (`transform`, `effects`, `masks`, `markers`, `bounds`, `text`, `shape`, `source`), plus `maxKeyframes` to cap the keyframes per property and `shapeDepth` to limit the Contents walk on a heavy shape layer.

Omit them all and you get everything, as before. Whatever they leave out is named and counted in the response — a bounded read never looks like a complete one.

**Reading a shape layer, use `shapeDetail: "compact"`.** It returns one indented line per group — the group's name, its matchName, then its own properties as `name=value`, with `[3 keys]` or `[expr]` on the animated ones and `(at defaults)` for a group Transform nobody has touched. Every name the write tools address a node by is still on the line, and it costs a fraction of the full JSON form. Reach for `"full"` when you need exact values, keyframe detail or indices.

One thing is left out of both forms: **Material Options**, the 48-property 3D extrusion block AE hangs off every vector group. It only means anything for an extruded shape under the Cinema 4D renderer, and on the 2D shape layers that are nearly all of them it was most of the weight of the read — a single 68px circle cost 4,400 tokens, of which the geometry was about 40. `materialsOmitted` counts what was skipped; `shapeMaterials: true` brings it back.

## Identify things by ID, never by index

Every comp and layer has a stable numeric `id`. Layer `index` is a 1-based position that **shifts whenever layers are added, deleted, or reordered**. Store `(compId, layerId)` and pass those. An index captured before a `create_*` call may point at a different layer by the time you use it.

The same trap bites inside `run_jsx`: a `comp.layer(1)` wrapper is index-bound, not a handle. Once a `copyToComp` or a `duplicate()` has shifted the destination's indices, a reference you took earlier silently resolves to a *different* layer — which is how a script ends up parenting a layer to itself. Re-resolve by id or name after anything that inserts a layer.

## Read, then write, then verify

1. Read the current state (`get_layer_full`).
2. Make the change.
3. Verify by reading back the properties — not by screenshotting.

Property values are the ground truth. A screenshot tells you something *looks* wrong; `get_layer_full` tells you *why*.

### Verify with a diff, not a second full read

Re-reading a comp to see what changed makes you compare two large answers by eye,
and you pay for both for the rest of the session. Fingerprint it instead:

- `snapshot_comp({compId})` **before** the write returns a `snapshotId` and
  almost nothing else. `diff_comp({since})` afterwards returns only what moved —
  layers added, removed, renamed, retimed, re-parented, keyframe counts that
  changed, expressions and effects gained or lost — and a count of the layers
  that did not. Tens of tokens where the two reads were thousands.
- `run_jsx` and `run_batch` take `diff: true`, which does the same thing *inside*
  the call, so there is no window between the write and the fingerprint. On a
  failure the diff rides on the error, which is the cheapest way to find where a
  half-applied script stopped — nothing rolls back, so that is the question you
  will actually have.

Know what a fingerprint does **not** record: property values, expression text,
effect parameters, masks and shape contents. So `changeCount: 0` means none of
the recorded fields moved — not that the comp is unchanged. Retype a text layer
or change a colour and the diff is empty and correct. For "is this value right",
read the property.

## Screenshots are a diagnostic, not a feedback loop

`screenshot_frame` and `screenshot_layer` are **one-off checks**. Do not screenshot every frame, do not scrub through time, do not screenshot after every edit.

**To judge motion, ask for a contact sheet — one call, not three.**
`screenshot_frame({compId, times: [0, 1, 2]})` takes two to six times and returns
a *single* tiled image with the time burned into each tile, held to roughly the
pixel budget of one frame. It is cheaper than separate calls, it is one image
resident in your context instead of three, and it gives After Effects one render
request instead of three back-to-back ones — which is the pattern most likely to
come back stale. `time` and `times` are mutually exclusive. There is no `times`
on `screenshot_layer`.

- **An image is the most expensive result this server returns**, and like every result it stays in your context for the rest of the session. One sheet is a budget for a whole build.
- **The `downsample` is picked from the comp size** unless you pass one — 2 at 1080p, 3 at 4K, aiming at a long edge around 1280px, and per tile on a sheet. Pass `downsample: 1` only when you genuinely need full resolution: a full 4K frame is large enough to blow out your context in one call.
- The result reports the dimensions actually returned and the factor actually applied — trust those numbers rather than assuming.
- **Space single frames out.** Rapid back-to-back requests are far more likely to come back stale than requests a few seconds apart. A sheet does this for you.

### The four results that are not a picture

They have different causes and opposite remedies, so read which one you got
before you retry anything.

- **`Stale frame`** — After Effects returned pixels it had already rendered for a *different* request, which the error names. Wait a few seconds and retry at a higher `downsample`; `6` has worked where `3`–`4` stayed stale. If two frames of a genuinely static comp really are identical, a different `downsample` renders a different number of pixels and proves it.
- **`Corrupt frame`** — the render stopped writing and the file is not a whole PNG, so nothing was sent. **This is not a timeout.** It tracks how heavy the comp is: retry at `downsample` 6–8, or screenshot the shot precomps one at a time instead of the assembly.
- **`Render timed out`** — After Effects was still working when the panel gave up. The render is probably still going, so wait a few seconds before doing anything else; a retry issued now queues behind it.
- **`empty: true`** — every pixel at that time is fully transparent, so no image was sent. That is a fact about the composition: usually the wrong time, a layer outside its in/out points, disabled, or at zero opacity.

On a contact sheet a single bad tile is drawn as a marked block and named in `warning` — the rest of the sheet is still good, so read it rather than re-requesting the whole thing.

**Never disable layers to make a screenshot render.** A frame that will not render is a limit of the panel's render path, not project content that needs fixing — and it is very easy to leave someone's comp switched off afterwards.

To check motion exactly, read the keyframe values. A picture tells you it looks wrong; `get_keyframes` tells you why.

## Bulk work goes through run_batch

Building 40 layers with 40 separate calls is slow and produces 40 undo steps. `run_batch` runs many ops in one ExtendScript pass as a **single undo step**, which is also what the user expects when they ask to undo "that thing you just built".

- `transactional: true` (the default) rolls back the whole batch on the first error.
- Over 500 ops it returns a `jobId` and streams progress; call `await_job(jobId)` for the final result.
- `diff: true` appends a structural diff of the comps it touched, so the batch reports what it did rather than you reading the comp back.

**You do not have to issue writes one at a time.** The server holds a single
write lock for the whole session, so independent writing calls sent together are
run in the order you issued them, one after another, and a long `run_batch` keeps
the lock until its last chunk lands — which is what stops another call splitting
its undo step in half. A call that had to wait says so with `queuedBehind` and
`waitedMs`; a call that did not is unchanged. Reads are never queued, so
`list_layers`, `get_layer_full` and `await_job` still answer while a batch runs.

Prefer `run_batch` anyway when the work is one user action: it is one
ExtendScript pass rather than many, and one undo step rather than many.

## Keyframes and easing

`add_keyframe` sets a value at a time. Interpolation is separate:

- `set_interpolation` — linear / bezier / hold, per keyframe, in and out.
- `set_temporal_ease` — influence and speed, the "easy ease" controls.
- `set_spatial_tangents` — the shape of a motion path through a position keyframe.

**Pass one `{influence, speed}` pair per side and nothing else.** `set_temporal_ease` and `add_keyframe` size the ease array themselves and report what the property wanted as `easeDimensions`. That number is worth glancing at, because it is not derivable from the value: a 2D layer's Scale takes 2, a shape's Ellipse Size takes 3, Opacity and sliders take 1, and a spatial property — Position, Anchor Point — takes exactly 1 whether the layer is 2D or 3D, since the ease runs along the motion path rather than per axis. Getting it wrong by hand throws a bare `parameter 2`, which is why you no longer do it by hand. If you are easing a property from `run_jsx` instead, use the `ease()` helper — it is the same sizing code, not a second copy of it.

## Rigging

Nulls, parents and retimed layers. Parenting carries less than people expect, and
each of the four below has cost a review round more than once.

**Opacity does not propagate through parenting.** Scale, rotation and position
ride the parent; opacity never does. Every text or child layer under a shape that
pops or stamps in needs its own matching opacity keys, or it sits there on screen
before its parent has revealed anything.

**Parent world layers to a camera null *before* you key the null, at a time where
it is still at identity** — anchor and position at the comp centre, scale 100.
Parenting compensation is a no-op there, so the children keep plain world
coordinates and the keyframes they already had. To look at a world target `T` at
zoom `s`: key the null's scale to `s` and its position to `C + (C − T)·s/100`,
with `C` the comp centre. Children of a precomp layer get parented while that
parent is at rest, and AE rewrites their position and divides their scale for you.

**Anything flown out of frame is still there when the camera moves.** A layer
parked at y = −900 comes straight back into shot on a whip-up. Cut its opacity
once it is clear rather than trusting the frame edge to hide it.

**Expressions run on comp time, not layer time.** Retiming a layer with
`startTime` moves its keyframes and leaves its expressions exactly where they
were, so a freeze written against `time` replays from zero. Offset `time` inside
the expression, or key the value instead.

## Expressions

`set_expression` takes a `propertyPath` such as `["Transform","Position"]` or `["Effects","Gaussian Blur","Blurriness"]`. Expressions are ExtendScript-flavoured JavaScript evaluated by AE per frame.

Expressions are usually a better answer than dense keyframes for anything procedural — wiggle, loops, counters, follow-through, time remapping. They stay editable by the user afterwards, where a wall of baked keyframes does not.

Use `get_expression` to read one back and `toggle_expression` to disable without deleting.

## Effects

Effects are added by **matchName**, not display name: `add_effect({matchName: "ADBE Gaussian Blur 2"})`. If you do not know a matchName, call `list_available_effects({filter: "blur"})` — do not guess. `list_effects` shows what is already on a layer, with every parameter.

Set parameters with `set_effect_param` by parameter name (e.g. `"Blurriness"`).

**Never enumerate `app.effects` yourself in `run_jsx`.** There are around 250 of them and reading the table is slow enough to block the bridge past its timeout, which looks exactly like a crash and costs a minute of everyone's time. `list_available_effects` does the same enumeration once and caches it for the session, so `filter` searches are free after the first call. A wrong matchName also fails instantly and clearly, so trying `ADBE Slider Control` is cheaper than searching for it.

## Text

`create_text_layer` defaults to `anchorAlign: "left"`, which sets **paragraph justification** and leaves the anchor point at `[0,0]`, so `position` is the start of the first baseline. Pass `"center"` or `"right"` for those, `"none"` for AE's raw behaviour. Because the alignment is justification rather than a measured offset, it stays correct when the text changes later — retyped, driven by an expression, or edited through Essential Graphics in Premiere. Never "fix" alignment by writing an anchor point computed from `sourceRectAtTime()`: it is right once and wrong from the next edit onward.

Tracking is set to `0` unless you pass one, because AE's `addText()` otherwise inherits whatever the user's Character panel was last left on.

`set_text` controls font, size, colour, tracking, leading and justification. To auto-fit a background to text, read `sourceRect` from `get_layer_full` and size the shape from its width and height plus padding.

## Shapes

`create_shape_layer` puts the new layer's origin at `[0,0]` with its anchor at `[0,0]`, so **the layer's coordinate space is the comp's** and every vertex, rect position and path you add afterwards is in comp pixels. After Effects' own spawn point is the comp centre, which silently offsets a drawing authored in comp coordinates by half a frame; pass `position: "center"` if you want that back, or any `[x,y]` to place the origin yourself. The result echoes the position and anchor it ended up with.

`add_shape_content` builds one node at a time under `Contents` — `rect`, `ellipse`, `star`, `path`, `fill`, `stroke`, `trim`, `repeater`, `merge`, `group`. Properties are set with friendly names in the same call (`size`, `position`, `roundness`, `color`, `width`, `lineCap`, …).

This tool is **all-or-nothing**: if a key cannot be applied, the whole node is removed and you get an error naming the bad key. A success result therefore means everything landed. Don't add defensive re-reads for it, but do read the error carefully — it usually means the property is named differently on that node type, and `get_layer_full` will show you the real name.

For a custom path, use `{type: "path", vertices: [[x,y], …], closed: true}`. The key is `vertices`, not `points`.

**Render order is the opposite of the layer stack.** Inside `Contents`, index 1 renders in *front*, and each `add_shape_content` call appends behind the previous one. So build **front-to-back**: details, text plates and traffic-light dots first, the big background rectangle last. Getting it backwards is silent — no error, just a solid slab where your artwork should be. `zOrder: "front"` will place a node at index 1 for you, but it needs an internal `moveTo`, which has been seen to disturb *nested* renders of the comp in AE 26.3; prefer ordering your calls. If an existing layer is already in the wrong order, rebuild it rather than reordering, and verify with a screenshot of a comp that **nests** it, not just the comp that owns it.

**Node references go stale.** Adding a sibling to a group invalidates a reference you already hold to another node in it — add a Stroke and an earlier Fill reference starts throwing `Object is invalid`. Add every node first, then set values and expressions by addressing nodes by name.

## Sound

`place_audio_cues` scores a scene in one call: a list of cues — each a file (or an
already-imported `footageId`), a comp `time` and a `levelDb` — becomes one
audio layer each, imported once however many cues name the same file, named,
trimmed, labelled, in a single undo step. Reach for it the moment you are placing
more than two or three sounds.

It is all-or-nothing: every cue is checked (the file exists, the item has an
audio track, the time is inside the comp) before a single layer is made, and if a
later one still fails, everything the call created is removed and the error names
the cue by index. `dryRun: true` checks a list against the project without
importing, creating, or even adding an undo step. `levelDb` is decibels, AE's own
unit — `0` is the file as recorded, negative is quieter — and `inPoint`/`outPoint`
trim in **comp** time, not file time.

## The escape hatch

`run_jsx` executes arbitrary ExtendScript. Reach for it when a needed operation has no tool — driving the render queue, batch-renaming, a bulk edit no single op expresses. Check the tool list first: duplicating a comp, easing a keyframe and placing a shape layer at a sane origin all have tools now, and each of them wraps a trap you would otherwise hit.

**Read the gotchas before you write one** — `ae_guide({topic: "extendscript-gotchas"})`, or `references/extendscript-gotchas.md` beside this file. It is the list of things that fail while naming something else: a property lookup that returns null and surfaces twenty lines later, a `copyToComp` that does not insert where you think, a reserved word that stops the whole script before its first line. Every item on it has already cost somebody an aborted run.

The reference also carries the two things that make a script cheap to write: `scriptPath` and `libraries`, which keep a long script and its shared helpers out of the conversation entirely, and the helpers already in scope — including the whole `OPS` table, so every tool on this server is callable from inside a script.

ExtendScript is **single-threaded**, so a long synchronous loop freezes the user's AE UI. Keep the script short.

`return X` sends the whole value back — arrays and nested objects included. Values that cannot be represented (functions, live AE objects, cycles) come back as a marker string in place, never dropped — a live object as `"[AVLayer \"Hero\" #616]"`, which is a handle to pass to `get_layer_full`, not a copy of the layer. So an empty result genuinely means the script returned nothing; never read one as "nothing happened".

**A bare expression is not a return.** `"ping";` as the last line yields nothing, and so does any script that just does its work. That case comes back as `{ok: true, returned: null, undoGroup, note}` — an envelope that says *the script ran to completion*. Do not re-run it. Nothing rolls back, so a second run of a script that duplicated a layer, reordered content or wrote keyframes applies all of it twice; read the state back instead, and add an explicit `return` if you want a value.

**On a failure, read the error before you touch anything.** It names the line of *your* script and prints that line's text; when the number cannot be mapped honestly it says so rather than guessing at one. Everything above that line already ran and nothing rolls back — so find out what landed, never re-run the script to see whether it fails again. `diff: true` is the fast way to find out: it fingerprints the comp around the script and appends only what changed, and on a throw that diff rides on the error message.

### Exporting a Motion Graphics template

Use **`export_mogrt`**. Do not drive `comp.exportAsMotionGraphicsTemplate` from `run_jsx` — the tool exists because that call raises modal dialogs, and a modal dialog freezes this whole connection until someone clicks it in After Effects.

`export_mogrt` handles all of it: it saves the project first (which is what removes AE's "the project needs to be saved" prompt, and it has to happen per export because exporting dirties the project again), it suppresses the font warning, and it runs outside the undo group so there is no "undo group mismatch" afterwards. Measured on 26.3: suppressed, an export of a comp using a non-Adobe font returns in about three seconds; unsuppressed, the same export sat past sixty and wrote nothing until the dialog was clicked.

Three things worth knowing before you call it:

- **The project must have been saved once, by hand.** There is no folder to save into otherwise, and the tool refuses rather than raising a dialog the user was not expecting.
- **`name` is the filename.** It defaults to the comp name, because AE's own default is the literal `Untitled` — leave it to AE and every template in the project overwrites the same file.
- **`fonts` in the result lists what the template will require.** Tell the user about any non-Adobe ones: Premiere flags the template as needing fonts it cannot supply, and that is worth hearing from you rather than discovering later.

**The thumbnail.** AE writes the comp's *first frame* into the template, so anything that fades up from nothing gets a black one. Pass `posterTime` with a moment that actually shows the design and it is rendered and swapped in. If only the thumbnail fails the export still succeeds — check `thumbnail.patched` in the result.

Also note that `comp.setMotionGraphicsControllerName(index, …)` numbers controllers in **reverse order of addition**: index 1 is the one you added last.

**If any long call seems to have hung, assume a dialog before you assume a crash** — it may be behind another window. `comp.saveFrameToPng(...)` from `run_jsx` raises the save prompt the same way; use `screenshot_frame`, which does not.

### Importing footage, and the SVG trap

Use **`import_footage`**, then **`create_footage_layer`** to place the item in a comp. (For a comp as a layer, `create_precomp_layer`.)

`import_footage` checks what AE actually produced, because one case fails silently: an SVG with a very large `viewBox` (say `0 0 278050 333334`) imports with **fabricated dimensions and renders as nothing**, no error at any stage. Verified on 26.3 — that viewBox yields a 15906x5654 item that will not even rasterize. The tool compares the aspect ratio the file asks for against the one AE produced, and on a mismatch it deletes the item and throws, rather than handing you an asset that looks healthy in the project panel and renders empty.

If you hit that, the workarounds are:

- **Simple flat SVGs** — rebuild the path as a shape layer with the real vertices, scaled down to a sane coordinate space (divide by `333.334` for a 1000px version), set the fill from the SVG, and set `ADBE Vector Fill Rule` to `2` when the SVG says `fill-rule="evenodd"`. Done this way the result is pixel-accurate.
- **Complex SVGs** — rasterise to PNG outside AE, or normalise the `viewBox` to a small coordinate space before importing.

`force: true` keeps the item and reports the problem in `validation` instead of throwing. It is for when you know the dimensions are wrong and want it anyway — not a way past the error.

## When something costs you real time

These tools have rough edges, and the same ones catch every session. Two tools
exist so that each one is only paid for once.

**`list_known_issues`** — what earlier sessions hit and how they got past it.
Read it when a tool fails in a way you do not immediately understand, before you
start guessing. The answer is often already there. It comes back as a one-line
index, so open the entry that looks like your failure with
`list_known_issues({id})` — the cause and the workaround are in the entry, not in
the index. `tool` and `query` narrow it further.

There are two journals and every entry says which it came from. `project` is
this project's own notes; `user` travels with the person across every project.
Ids are only unique within a journal, so open an entry with the qualified form
the listing's `next` pointer shows you — `list_known_issues({id: "user:…"})`.

**`log_issue`** — write down what you worked out, the moment you work it out.

Log something when all three are true: it cost real effort, it was the tool's
fault rather than yours, and the next session would hit it too. A schema that
accepts an argument AE then rejects, an error message that names the wrong
thing, a property whose real name is nothing like its display name. Not your own
typos. Not "I forgot the layer was 3D".

Write the entry for someone who has not seen the failure: the exact error text,
the call that produced it, and a workaround concrete enough to apply directly.
Reuse the existing title when you are extending an entry — that keeps one good
record instead of five thin ones.

**Pick the scope by what the entry is about, not by where you are.** Leave it at
the default `project` for this project's footage, comps or files. Pass
`scope: "user"` when it is about how these tools or After Effects behave — that
is nearly everything worth logging, and it is the difference between the next
project starting out knowing it and re-learning it.

### Then offer to pass it on

If `log_issue` comes back with `reported: false`, mention it to the user — but
finish the actual work first, and put it at the very end, after you have told
them what you built. It is a footnote, not the headline.

Say it the way you would to a colleague who does not write code. What you were
trying to do, that it fought back, that you got there anyway, and that you can
send it to the people who maintain the tool so the next person does not lose the
same time. Something like:

> Done — the lower third is in. One thing worth mentioning: getting the ease
> onto that position keyframe took a lot longer than it should have, because the
> tool kept rejecting a value it had just asked for. I found a way around it and
> made a note. Want me to send it to the people who maintain this so they can
> fix it properly?

Do not say "GitHub issue", "file a bug" or "open a ticket" unless they say it
first. If they say yes, use the **report-ae-issue** prompt this server provides
(`/report-ae-issue` where your client exposes prompts as commands) — it handles
the rest. If they say no, drop it; the note stays and can be offered again
another time.

Never claim you have reported something you have not.

## When something is not connected

If a tool reports it cannot reach After Effects, call `check_setup` and relay its `nextSteps` to the user in plain language. Do not try to diagnose CEP by hand.

**A timeout is not proof the bridge is dead.** The error that says the panel did not answer in time is a different thing from the one that says the panel cannot be reached. Because ExtendScript is single-threaded, a busy After Effects cannot answer anything — so a long script, or a modal dialog nobody has clicked, is indistinguishable from a crash at this layer. It normally recovers on its own within a minute.

So when a call times out: do not re-send it (you would queue the same work twice), do not restart After Effects, and do not run `setup_panel`. Poll `check_setup` for about a minute first. Two causes worth asking about directly:

- **A dialog is waiting.** Ask the user to check After Effects for a prompt hiding behind another window.
- **They changed desktop.** On macOS, calls have been reported to stall while the user is on a different Space and to complete as soon as they return. If they have wandered off, ask them to switch back to the desktop After Effects is on before you diagnose anything else.

If a specific operation of yours legitimately needs longer than the limit, the user can raise it by setting `AE_MCP_OP_TIMEOUT_MS` in the server's environment.

**A dropped write is the opposite case, and it is safe to re-send.** If a call
comes back saying it *waited behind* another op for the write queue and was
dropped without running, the bridge is fine and nothing reached After Effects.
Something in front is slow — usually a long `run_batch`, occasionally a modal
dialog. Find out what with `get_job` or `await_job`; reads are never queued, so
`list_*` and `get_*` still answer and will tell you the current state. Then
re-send once the work in front has finished. That is exactly what you must *not*
do after a bridge timeout, so read which of the two you got.
