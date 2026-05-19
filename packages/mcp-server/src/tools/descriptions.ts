/**
 * Tool descriptions written for an LLM agent reading the tool list. They tell
 * the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid.
 *
 * The vision tools' descriptions explicitly include the "one-off, do not
 * screenshot every frame" guidance the user asked for.
 */
export const descriptions: Record<string, string> = {
  // ---------- comps ----------
  list_comps: "Lists all compositions in the current project with id, name, dimensions, duration, frameRate and layer count. Use for project overview.",
  get_comp: "Returns a single composition's summary (no layers). Use list_comps if you don't know which comp.",
  get_comp_tree: "Returns a comp and its nested layer tree, recursing into pre-comps up to `depth`. The richest 'show me everything' read for a comp.",
  create_comp: "Creates a new composition. Returns the new comp's id and summary. Use for setting up a scene.",
  set_comp: "Modify an existing comp (name, dimensions, frameRate, duration, work area, bg color). Properties left undefined are unchanged.",
  delete_comp: "Removes a composition from the project. Irreversible from outside AE (the user can Undo inside AE).",
  set_active_comp: "Opens a comp in the viewer/timeline (makes it the focused comp).",

  // ---------- layers ----------
  list_layers: "Lists layers in a comp with concise per-layer summary. Use get_layer_full when you need details on a specific layer.",
  get_layer_full: "Returns the COMPLETE state of one layer in a single call: transform values + keyframes + expressions, all effects with their params + keyframes + expressions, masks, markers, parenting, blend mode, in/out, content-specific extras (text/shape/footage/precomp). Always prefer this over multiple smaller queries.",
  create_text_layer: "Creates a text layer. Optional font/size/color/position applied immediately.",
  create_shape_layer: "Creates an empty shape layer. Use add_shape_content to fill it with rects, ellipses, paths, fills, strokes, trims, repeaters.",
  create_solid_layer: "Creates a solid-color layer of given dimensions. color is RGB 0..1.",
  create_null_layer: "Creates a null object (invisible parent layer).",
  create_adjustment_layer: "Creates an adjustment layer — effects on it apply to layers beneath.",
  create_precomp_layer: "Drops an existing composition into another comp as a pre-comp layer.",
  create_camera_layer: "Creates a camera. 3D layers below will be viewed through it.",
  create_light_layer: "Creates a light (parallel, spot, point, or ambient).",
  duplicate_layer: "Duplicates a layer N times. Each duplicate is a fresh, independently-IDed layer.",
  delete_layer: "Removes a layer from its comp.",
  set_layer: "Bulk-update a layer's metadata (name, enabled, locked, shy, solo, 3D, blendingMode, label, in/out points, stretch, track matte). Undefined fields are unchanged.",
  parent_layer: "Sets a layer's parent. Pass parentLayerId=null to unparent.",
  reorder_layer: "Moves a layer to a new 1-based index in the comp's stacking order.",

  // ---------- transforms ----------
  set_transform: "Convenience: set any combination of position/scale/rotation/anchorPoint/opacity (plus 3D orientation and per-axis rotations on 3D layers) in one call. If `keyframe:true` and `time` is given, sets keyframes; otherwise sets the static value.",

  // ---------- keyframes ----------
  add_keyframe: "Adds a keyframe at `time` on a property identified by propertyPath (e.g. ['Transform','Position'] or ['Effects','Gaussian Blur','Blurriness']). Optionally sets interpolation (in/out: linear|bezier|hold) and ease (influence + speed) for that key.",
  remove_keyframe: "Removes the keyframe at `time` on the given property.",
  get_keyframes: "Returns ALL keyframes on a property with time, value, in/out interpolation, ease, and spatial tangents (if spatial).",
  set_interpolation: "Sets the in/out interpolation type of a specific keyframe (linear|bezier|hold).",
  set_temporal_ease: "Sets influence + speed for the in/out ease of a specific keyframe.",
  set_spatial_tangents: "Sets the in/out spatial tangents for a position-style keyframe (2D or 3D).",

  // ---------- expressions ----------
  get_expression: "Returns the expression text on a property (empty string if none) and whether it's enabled.",
  set_expression: "Sets an expression on a property and enables it.",
  toggle_expression: "Enables/disables an expression without clearing it.",
  clear_expression: "Removes the expression from a property.",

  // ---------- effects ----------
  list_effects: "Lists every effect on a layer with all current parameter values and any keyframes/expressions on those parameters.",
  add_effect: "Adds an effect by its matchName (use list_available_effects to find the matchName for an effect — matchNames are stable across AE versions, display names are not).",
  remove_effect: "Removes an effect by its 1-based index on the layer.",
  set_effect_param: "Sets the value of an effect parameter (by paramName or paramMatchName). Optionally at a specific time with keyframe:true.",
  set_effect_enabled: "Enables/disables an effect without removing it.",
  list_available_effects: "Returns every effect installed in this AE, with displayName, matchName, and category. Use this to discover matchNames before calling add_effect.",

  // ---------- text ----------
  set_text: "Sets text content and styling on a text layer (font, size, fill/stroke color, tracking, leading, justification, etc.). Properties left undefined are unchanged.",
  add_text_animator: "Adds a text animator group of the given type (position, scale, rotation, opacity, tracking, skew, fillColor, strokeColor). Optional range selector with start/end/offset percentages.",

  // ---------- shapes ----------
  set_shape_path: "Replaces the path of a shape (the property at `shapePath`) with new vertices/tangents/closed flag.",
  add_shape_content: "Adds shape content (rect, ellipse, star, path, fill, stroke, trim, repeater, merge, group) into the layer's Contents (or into a sub-group identified by parentGroupPath).",
  set_shape_property: "Sets any property on a shape content node (path+property name pair), optionally as a keyframe at `time`.",

  // ---------- masks ----------
  add_mask: "Adds a mask to a layer with vertices/tangents/closed/mode.",
  set_mask: "Modifies an existing mask: vertices/tangents/closed/mode/inverted/expansion/feather/opacity.",
  remove_mask: "Removes a mask by 1-based index.",

  // ---------- markers ----------
  add_marker: "Adds a marker on a layer (if layerId given) or on the comp. Includes time, optional duration, comment, label, chapter, url, frameTarget.",
  remove_marker: "Removes a marker by 1-based index.",

  // ---------- vision ----------
  screenshot_frame:
    "ONE-OFF diagnostic snapshot of a composition at a specific time. Returns a base64 PNG inline (plus dimensions in a metadata text block). " +
    "USE ONLY to verify visual state at key moments (e.g., the value at a specific keyframe). " +
    "Do NOT screenshot every frame. Do NOT scrub through time with this. Do NOT call this in a loop. " +
    "For motion verification, take 2–3 snapshots at chosen times and infer motion from those plus the actual property values returned by get_layer_full.",
  screenshot_layer:
    "ONE-OFF diagnostic snapshot of a single layer (isolated by soloing it) at a specific time. Same rules as screenshot_frame: " +
    "one-off only, never per-frame, never in a loop.",

  // ---------- batch ----------
  run_batch:
    "Run many ops in a single ExtendScript pass, sharing one undo step. Ideal for 'create 30 layers and set their positions' style work — far faster than individual calls. " +
    "For >100 ops, this returns a `jobId` immediately and streams progress notifications; subscribe to those or call await_job(jobId). " +
    "If transactional:true (default), the first error rolls everything back.",

  // ---------- explore ----------
  get_project_summary: "Top-level project state: file path, item count, active item, and a flat list of items with type tags.",
  find_layers: "Search across one or all comps for layers matching name/type/effect filters. Returns layer summaries with comp identifiers.",

  // ---------- raw ----------
  run_jsx:
    "Escape hatch: run arbitrary ExtendScript inside an undo group. Prefer typed tools first. " +
    "`comp`, `app`, `OPS` and all helpers are in scope. The last expression's value is JSON-encoded and returned; complex AE objects are coerced to plain props.",

  // ---------- jobs ----------
  await_job: "Blocks until the given job reaches a terminal state (completed/failed/cancelled). Default timeout 10 minutes. Returns the same payload the long-running tool would have returned.",
  get_job: "Non-blocking status snapshot for a job: progress/total/status/error.",
  cancel_job: "Sets the cancel flag on a running job. The chunked async loop checks between chunks and stops at the next chunk boundary.",
};
