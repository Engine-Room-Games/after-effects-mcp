---
name: after-effects
description: How to drive Adobe After Effects well through the AE MCP tools — orienting in a project, building and animating layers, keyframes and easing, expressions, effects, text and shapes, and the gotchas that silently produce wrong output. Load whenever a task involves After Effects, motion graphics, comps, layers, or keyframes.
---

# Driving After Effects

You have direct control of a live After Effects session. The user sees every change immediately, and every tool call is a real undo step in their project. Work like a motion designer at the keyboard, not like a script that fires blind.

## Read the house style first

`get_house_style` returns the style guide for the project that is currently open
— palette, type, motion defaults, layout rules — read from `house-style.md`
sitting next to the `.aep` file. Call it once at the start of any build task and
follow what it says. It costs one cheap call and it is the difference between
work that matches everything else the user has made and work that does not.

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

`get_layer_full` is the one to reach for. It returns transforms **with their keyframes and expressions**, effects with every parameter, masks, markers, and `sourceRect` (the layer's visible bounds) in a single call. Prefer one `get_layer_full` over four narrow queries — it is faster and it shows you context you did not know to ask for.

## Identify things by ID, never by index

Every comp and layer has a stable numeric `id`. Layer `index` is a 1-based position that **shifts whenever layers are added, deleted, or reordered**. Store `(compId, layerId)` and pass those. An index captured before a `create_*` call may point at a different layer by the time you use it.

## Read, then write, then verify

1. Read the current state (`get_layer_full`).
2. Make the change.
3. Verify by reading back the properties — not by screenshotting.

Property values are the ground truth. A screenshot tells you something *looks* wrong; `get_layer_full` tells you *why*.

## Screenshots are a diagnostic, not a feedback loop

`screenshot_frame` and `screenshot_layer` are **one-off checks**. Do not screenshot every frame, do not scrub through time, do not screenshot after every edit.

- Take at most 2–3 across an animation — typically start, middle, end.
- **Always pass `downsample`** on large comps: `2` for 1080p, `3`–`4` for 4K. A full-resolution 4K frame is large enough to blow out your context in one call.
- The result reports the dimensions actually returned and warns if the downsample could not be applied — trust those numbers rather than assuming.
- **Space them out.** Rapid back-to-back requests are far more likely to come back stale than requests a few seconds apart.

Two results are not images, and both are information rather than something to retry blindly:

- **`Stale frame` (an error)** — After Effects returned the pixels it had already rendered for a *different* request, which the error names. Pause a few seconds and retry with a higher `downsample`; `6` has worked where `3`–`4` stayed stale. If it repeats, read the keyframes instead.
- **`empty: true`** — every pixel at that time is fully transparent, so no image was sent. That is a fact about the composition: usually the wrong time, a layer outside its in/out points, disabled, or at zero opacity.

**Never disable layers to make a screenshot render.** A frame that will not render is a limit of the panel's render path, not project content that needs fixing — and it is very easy to leave someone's comp switched off afterwards.

To check motion, read the keyframe values. That is exact; a picture is not.

## Bulk work goes through run_batch

Building 40 layers with 40 separate calls is slow and produces 40 undo steps. `run_batch` runs many ops in one ExtendScript pass as a **single undo step**, which is also what the user expects when they ask to undo "that thing you just built".

- `transactional: true` (the default) rolls back the whole batch on the first error.
- Over 500 ops it returns a `jobId` and streams progress; call `await_job(jobId)` for the final result.

## Keyframes and easing

`add_keyframe` sets a value at a time. Interpolation is separate:

- `set_interpolation` — linear / bezier / hold, per keyframe, in and out.
- `set_temporal_ease` — influence and speed, the "easy ease" controls.
- `set_spatial_tangents` — the shape of a motion path through a position keyframe.

**The array-size trap.** `set_temporal_ease` wants one ease entry *per dimension* for ordinary multi-dimensional properties (Scale, Color), but exactly **one** entry for spatial properties (Position, Anchor Point) regardless of whether the layer is 2D or 3D — because the ease applies along the motion path, not per axis. If you see `Value array does not have 1 elements`, you fed a spatial property one entry per axis.

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

`add_shape_content` builds one node at a time under `Contents` — `rect`, `ellipse`, `star`, `path`, `fill`, `stroke`, `trim`, `repeater`, `merge`, `group`. Properties are set with friendly names in the same call (`size`, `position`, `roundness`, `color`, `width`, `lineCap`, …).

This tool is **all-or-nothing**: if a key cannot be applied, the whole node is removed and you get an error naming the bad key. A success result therefore means everything landed. Don't add defensive re-reads for it, but do read the error carefully — it usually means the property is named differently on that node type, and `get_layer_full` will show you the real name.

For a custom path, use `{type: "path", vertices: [[x,y], …], closed: true}`. The key is `vertices`, not `points`.

**Render order is the opposite of the layer stack.** Inside `Contents`, index 1 renders in *front*, and each `add_shape_content` call appends behind the previous one. So build **front-to-back**: details, text plates and traffic-light dots first, the big background rectangle last. Getting it backwards is silent — no error, just a solid slab where your artwork should be. `zOrder: "front"` will place a node at index 1 for you, but it needs an internal `moveTo`, which has been seen to disturb *nested* renders of the comp in AE 26.3; prefer ordering your calls. If an existing layer is already in the wrong order, rebuild it rather than reordering, and verify with a screenshot of a comp that **nests** it, not just the comp that owns it.

**Node references go stale.** Adding a sibling to a group invalidates a reference you already hold to another node in it — add a Stroke and an earlier Fill reference starts throwing `Object is invalid`. Add every node first, then set values and expressions by addressing nodes by name.

## The escape hatch

`run_jsx` executes arbitrary ExtendScript with `app`, `comp`, `OPS` and the helper functions in scope. Reach for it when a needed operation has no tool — duplicating a comp, driving the render queue, batch-renaming.

Two warnings: ExtendScript is **single-threaded**, so a long synchronous loop freezes the user's AE UI; and returned objects are flattened, so return a string you have assembled yourself rather than a nested object.

### Exporting, saving frames, and the dialogs they raise

After Effects asks the user interactively where a script would rather have an error, and every dialog freezes the bridge until someone clicks it. Three of them turn up around `comp.exportAsMotionGraphicsTemplate(...)` and `comp.saveFrameToPng(...)`:

- **"The project needs to be saved first."** Call `app.project.save()` immediately before the export, in the same `run_jsx`. That removes this one deterministically. If the project has never been saved there is no path to save to — ask the user to save it once first.
- **"The following fonts were not synced from Adobe … Click OK to continue."** Unavoidable when the comp uses non-Adobe fonts. Warn the user *before* you start the export that they will have to click OK, so a dialog they were not expecting does not read as a hang.
- **"Undo group mismatch, will attempt to fix."** Harmless; the export is not undoable and interrupting it unbalances the group `run_jsx` wraps your code in.

If an export seems to have hung, assume a dialog before you assume a crash — it may be behind another window. And note that `comp.setMotionGraphicsControllerName(index, …)` numbers controllers in **reverse order of addition**: index 1 is the one you added last.

### Importing SVG

There is no import tool; SVG import happens through `run_jsx` and `importFile`, and AE's own SVG importer has a trap. An SVG with a very large `viewBox` (say `0 0 278050 333334`) imports with **fabricated dimensions and renders as nothing**, with no error at any stage.

Check it yourself after importing: read the footage item's `width`/`height` and compare the aspect ratio with the `viewBox`. If they disagree, the item is broken however healthy it looks in the project panel.

- **Simple flat SVGs** — rebuild the path as a shape layer with the real vertices, scaled down to a sane coordinate space (divide by `333.334` for a 1000px version), set the fill from the SVG, and set `ADBE Vector Fill Rule` to `2` when the SVG says `fill-rule="evenodd"`. Done this way the result is pixel-accurate.
- **Complex SVGs** — rasterise to PNG outside AE, or normalise the `viewBox` to a small coordinate space before importing.

Either way, delete the broken footage item so nobody places it later.

## When something costs you real time

These tools have rough edges, and the same ones catch every session. Two tools
exist so that each one is only paid for once.

**`list_known_issues`** — what earlier sessions hit and how they got past it.
Read it when a tool fails in a way you do not immediately understand, before you
start guessing. The answer is often already there.

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
