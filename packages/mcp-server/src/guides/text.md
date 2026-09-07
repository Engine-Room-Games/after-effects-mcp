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
about `-width`. That is the check to make after any call that could have
touched justification.

**To fit a background to text**, read `sourceRect` from the same call and size
the shape from its width and height plus padding, positioned from its `left`
and `top`. A `sourceRectAtTime()` expression on the background does the same
thing live, and stays right when the text is retyped.

**Scripting a `TextDocument` by hand** has one trap worth knowing before you
try: justification written into the document from a script lands as the wrong
value on 26.3, while the tool path lands correctly. It is in the
`extendscript-gotchas` topic under Text, with the verification above.
