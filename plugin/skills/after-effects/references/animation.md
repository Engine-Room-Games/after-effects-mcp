---
name: animation
reference: after-effects
description: Keyframes, easing, rigging and expressions through the AE MCP tools — what each keyframe tool controls, the one ease pair per side that the tools size for you, the four parenting facts that cost review rounds, and why an expression's `time` does not follow a retimed layer. Load when a task animates, parents or drives anything with an expression.
---

# Keyframes, rigging and expressions

## Keyframes and easing

`add_keyframe` sets a value at a time. Interpolation is separate:

- `set_interpolation` — linear / bezier / hold, per keyframe, in and out.
- `set_temporal_ease` — influence and speed, the "easy ease" controls.
- `set_spatial_tangents` — the shape of a motion path through a position keyframe.
- `get_keyframes` reads them all back, with the ease on each key — the exact
  answer to "does it move right", where a screenshot is an impression.

**Pass one `{influence, speed}` pair per side and nothing else.**
`set_temporal_ease` and `add_keyframe` size the ease array for the property
themselves and report the count that worked as `easeDimensions`. That number is
not derivable from the value's dimension — After Effects wants a different count
per property, and the measured table is in the `extendscript-gotchas` topic for
the day you script an ease by hand. Through the tools you never need it; from a
script, use the `ease()` helper, which is the same sizing code and not a second
copy of it.

Expressions are usually a better answer than dense keyframes for anything
procedural — wiggle, loops, counters, follow-through, time remapping. They stay
editable by the user afterwards, where a wall of baked keyframes does not.

## Rigging

Nulls, parents and retimed layers. Parenting carries less than people expect,
and each of the four below has cost a review round more than once.

**Opacity does not propagate through parenting.** Scale, rotation and position
ride the parent; opacity never does. Every text or child layer under a shape
that pops or stamps in needs its own matching opacity keys, or it sits there on
screen before its parent has revealed anything.

**Parent world layers to a camera null *before* you key the null, at a time
where it is still at identity** — anchor and position at the comp centre, scale
100. Parenting compensation is a no-op there, so the children keep plain world
coordinates and the keyframes they already had. To look at a world target `T`
at zoom `s`: key the null's scale to `s` and its position to `C + (C − T)·s/100`,
with `C` the comp centre. Children of a precomp layer get parented while that
parent is at rest, and AE rewrites their position and divides their scale for
you. `parent_layer` with `preserveTransform` does the arithmetic.

**Anything flown out of frame is still there when the camera moves.** A layer
parked at y = −900 comes straight back into shot on a whip-up. Cut its opacity
once it is clear rather than trusting the frame edge to hide it.

**Expressions run on comp time, not layer time.** Retiming a layer with
`startTime` moves its keyframes and leaves its expressions exactly where they
were, so a freeze written against `time` — `Math.min(time, 0.75)` — replays
from zero in the shifted layer. Offset `time` inside the expression
(`time − startTime`, or rewrite `\btime\b` to `(time + offset)` in every
expression on a layer you retime), or key the value instead. A shot built in
its own comp does not have this problem, which is the reason the `assembly`
topic builds shots in local time.

## Expressions

`set_expression` takes a `propertyPath` such as `["Transform", "Position"]` or
`["Effects", "Gaussian Blur", "Blurriness"]`. Expressions are
ExtendScript-flavoured JavaScript evaluated by AE per frame.

**`set_expression` throws when After Effects cannot evaluate what it wrote.**
Assigning an expression succeeds whatever the text says; AE's only report is a
warning banner on the property in the interface, which you cannot see. So the
tool evaluates the property after the write and, if AE reports an error on it,
fails with AE's own message and the property path — a success result means the
expression compiles and runs. The expression is still on the property after
such a failure: fix it and call `set_expression` again, or `clear_expression`
to remove it. Do not add a second one on top. `toggle_expression({enabled:
true})` verifies the same way, because enabling can surface an error that has
sat on the property since it was disabled.

`get_expression` reads one back as `expression`, `enabled` and
`expressionError` — AE's message, or an empty string when it runs clean. A
non-empty `expressionError` means the property is not being driven by that
expression, whatever `enabled` says. `toggle_expression` disables one without
deleting it, and `clear_expression` removes it.
