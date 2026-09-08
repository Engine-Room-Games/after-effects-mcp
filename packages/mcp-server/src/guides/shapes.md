---
name: shapes
reference: after-effects
description: Shape layers through the AE MCP tools — the origin a new shape layer spawns at and why it is the comp's coordinate space, add_shape_content and its all-or-nothing contract, one fill per group, the render order inside Contents that runs opposite to the layer stack (which builds back-to-front), node references that go stale, a group's pivot, seams between shapes, centring a repeated run, and reading a shape layer cheaply. Load when a task builds or edits a shape layer.
---

# Shape layers

## Where a new shape layer's origin is

`create_shape_layer` puts the new layer's origin at `[0,0]` with its anchor at
`[0,0]`, so **the layer's coordinate space is the comp's**: every vertex, rect
position and path you add afterwards is in comp pixels, the same space as the
comp size, another layer's position, `sourceRect` and a screenshot. After
Effects' own spawn point is the comp centre, which silently offsets a drawing
authored in comp coordinates by half a frame; pass `position: "center"` if you
want that back, or any `[x, y]` to place the origin yourself. The result echoes
the position and anchor it ended up with, so nobody has to render a frame to
learn the coordinate system.

## Adding contents

`add_shape_content` builds one node at a time under `Contents` — `rect`,
`ellipse`, `star`, `path`, `fill`, `stroke`, `trim`, `repeater`, `merge`,
`group`. Properties are set with friendly names in the same call (`size`,
`position`, `roundness`, `color`, `width`, `lineCap`, …). For a custom path,
`{type: "path", vertices: [[x, y], …], closed: true}` — the key is `vertices`,
not `points`. `set_shape_path` replaces a path's vertices and tangents later;
`set_shape_property` sets one property on a node, optionally as a keyframe.

The tool is **all-or-nothing**: if a key cannot be applied, the whole node is
removed and the error names the bad keys, so a success result means everything
landed. Do not add defensive re-reads for it — but do read the error, since it
usually means the property is named differently on that node type, and a
`get_layer_full({…, include: ["shape"]})` shows the real name.

**A fill or stroke applies to every path above it in its group.** One Fill
under two paths fills both, so an open stroked path beside a filled shape in
the same group renders as a filled polygon. One group per path-and-paint
pairing: `{type: "group"}` first, then the path and its fill or stroke inside
it through `parentGroupPath`.

**Render order is the opposite of the layer stack.** Inside `Contents`, index 1
renders in *front*, and each `add_shape_content` call appends behind the
previous one. So build **front-to-back**: details, text plates and
traffic-light dots first, the big background rectangle last. Getting it
backwards is silent — no error, just a solid slab where the artwork should be.
`zOrder: "front"` places a node at index 1 for you, but it needs an internal
`moveTo`, which disturbs *nested* renders of the comp on AE 26.3; prefer
ordering the calls. If existing content is in the wrong order, rebuild it rather
than reordering, and verify with a screenshot of a comp that **nests** it, not
only the comp that owns it. None of this applies to the layer stack: moving
whole layers is `reorder_layer`, a different mechanism with none of these
caveats. The stack runs the other way: every new layer — `create_*`,
`duplicate_layer`, a `layers.add*()` in a script — lands at index 1, on top,
so a stack is built **back-to-front**, the plate first and the label after,
and a script re-run from the middle re-stacks whatever it recreates over what
was already there.

**Node references go stale.** Adding a sibling to a group invalidates a
reference you already hold to another node in it — add a Stroke and an earlier
Fill reference starts throwing `Object is invalid`. Add every node first, then
set values and expressions by addressing nodes by name. The tool re-fetches
after every insert for the same reason.

## Animating a group

A group drawn in comp coordinates pivots at the comp origin: its Transform's
anchor point is `[0,0]`, which with the layer's origin at `[0,0]` is the comp's
top-left corner, so a scale or rotation keyed on the group swings the artwork
around that corner. Before keying a group, set its anchor point to the pivot
you mean *and* its position to the same value — `set_shape_property` with
`contentPath: ["Contents", "<group>", "Transform"]` and `property: "Anchor
Point"`, then `"Position"` — which leaves the artwork where it is and turns it
about the pivot.

## Seams and runs

**Two shapes that meet on a shared edge show the seam when they move.**
Anti-aliasing leaves both edges partly transparent, so a hairline of whatever
is behind flickers along the join under a camera move, worst over a dark
ground. Overlap the back shape 10–20 px under the front one rather than
butting them.

**Centring a repeated run** — a Repeater tape, a dashed band — of copies `s`
wide at pitch `p` across a width `W` starting at `left`:
`copies = floor((W − s) / p) + 1`, and the first copy's centre is
`left + (W − s − (copies − 1)·p) / 2 + s/2`. With that `copies` on the
Repeater and that centre as the first element's position the run is
symmetrical whatever `W` is; dashes with equal gaps are `p = 2s`.

## Reading a shape layer

Use `shapeDetail: "compact"` on `get_layer_full`. It returns one indented line
per group — the group's name, its matchName, then its own properties as
`name=value`, with `[3 keys]` or `[expr]` on the animated ones and
`(at defaults)` for a group Transform nobody has touched. Every name the write
tools address a node by is still on the line, at a fraction of the cost of the
JSON form. Reach for `"full"` when you need exact values, keyframe detail or
indices, and `shapeDepth` to stop the walk at a depth on a heavy layer.

One thing is left out of both forms: **Material Options**, the 48-property 3D
extrusion block AE hangs off every vector group. It only means anything for an
extruded shape under the Cinema 4D renderer, and on a 2D shape layer it is most
of the weight of the read — a single 68px circle costs 4,400 tokens with it, of
which the geometry is about 40. `materialsOmitted` counts what was skipped;
`shapeMaterials: true` brings it back.

## Scripting shapes by hand

The raw-scripting traps — the spawn point of `addShape()`, polystar types that
hide their own properties, stroke dashes that refuse to take — are in the
`extendscript-gotchas` topic, along with the `shape()` helper that lands a
scripted layer at `[0,0]`.
