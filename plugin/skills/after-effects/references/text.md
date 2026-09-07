---
name: text
reference: after-effects
description: Text layers through the AE MCP tools — alignment as live paragraph justification rather than a measured anchor, tracking set explicitly so the Character panel cannot leak in, what set_text controls, and sizing a background to the text. Load when a task creates, restyles or lays out a text layer.
---

# Text layers

`create_text_layer` defaults to `anchorAlign: "left"`, which sets **paragraph
justification** and leaves the anchor point at `[0,0]`, so `position` is the
start of the first baseline. Pass `"center"` or `"right"` for those, `"none"`
for AE's raw behaviour. Because the alignment is justification rather than a
measured offset, it stays correct when the text changes later — retyped, driven
by an expression, or edited through Essential Graphics in Premiere. Never "fix"
alignment by writing an anchor point computed from `sourceRectAtTime()`: it is
right once and wrong from the next edit onward.

Tracking is set to `0` unless you pass one, because AE's `addText()` otherwise
inherits whatever the user's Character panel was last left on, and the same
call then renders differently on two machines.

`set_text` controls the text and its styling — font, size, fill and stroke,
tracking, leading, justification, faux bold and italic, caps, baseline shift.
`add_text_animator` adds an animator group (position, scale, rotation, opacity,
tracking, skew, fill and stroke colour) with an optional range selector, which
is how per-character animation is built.

**Verify alignment by the bounds, not by eye.** `get_layer_full({…, include:
["bounds"]})` returns `sourceRect`: a centred layer's `left` is about
`-width / 2`, a left-justified layer's about `0`, a right-justified layer's
about `-width`. That is the check to make after a script has touched a
`TextDocument`; the tools check their own writes, below.

**To fit a background to text**, read `sourceRect` from the same call and size
the shape from its width and height plus padding, positioned from its `left`
and `top`. A `sourceRectAtTime()` expression on the background does the same
thing live, and stays right when the text is retyped.

**The justification you got is the one in the result, not the one you asked
for.** On 26.3 the Source Text round trip can hand back a different alignment
from the one written — a left-aligned layer re-centred by a `set_text` that
changed only `text`. So `set_text` and `create_text_layer` read the
justification back after every write, write it once more on its own if it
moved, and throw naming expected and actual if it still disagrees;
`create_text_layer` removes the layer first, so a failure never leaves a layer
you have no id for. Both results carry `justification` as a name and
`justificationReasserted`, and an unknown justification name is refused rather
than ignored. Trust `justification` in the result over your own argument.

**From `run_jsx`, set justification through the tool** —
`OPS.set_text({compId, layerId, justification: "center"})` inside the script —
rather than by assigning `TextDocument.justification`, which on 26.3 stores the
wrong value and gets no read-back. The `extendscript-gotchas` topic has the
measurement under Text.
