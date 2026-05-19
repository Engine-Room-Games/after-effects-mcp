/**
 * Tool descriptions written for an LLM agent reading the tool list. Keep them
 * tight — every char is in the eager-tool budget. Say what the tool does, when
 * to reach for it, and only the gotchas an agent can't see from the schema.
 */
export const descriptions: Record<string, string> = {
  // ---------- comps ----------
  list_comps: "All comps: id, name, dims, duration, fps, layer count.",
  get_comp: "Single comp summary by id (no layers).",
  get_comp_tree: "Comp + nested layer tree, recursing pre-comps to `depth`.",
  create_comp: "Create a new comp. Returns id.",
  set_comp: "Modify a comp (name, dims, fps, duration, work area, bg). Undefined fields unchanged.",
  delete_comp: "Delete a comp. Reversible only via AE's Undo.",
  set_active_comp: "Focus a comp in the viewer/timeline.",

  // ---------- layers ----------
  list_layers: "Layers in a comp, one-line each. Use get_layer_full for details.",
  get_layer_full: "Full state of one layer: transform + keyframes + expressions, effects, masks, markers, parenting, text/shape/footage extras, and sourceRect (visible bounds). Always prefer over multiple smaller queries.",
  create_text_layer: "Text layer with optional font/size/color/position. anchorAlign defaults to 'left' so position means the visible left edge.",
  create_shape_layer: "Empty shape layer; fill via add_shape_content.",
  create_solid_layer: "Solid-color layer. color is RGB 0..1.",
  create_null_layer: "Null parent layer.",
  create_adjustment_layer: "Adjustment layer — effects on it apply to layers below.",
  create_precomp_layer: "Insert an existing comp into another as a pre-comp layer.",
  create_camera_layer: "Camera. 3D layers below view through it.",
  create_light_layer: "Light (parallel|spot|point|ambient).",
  duplicate_layer: "Duplicate a layer N times; each has a fresh id.",
  delete_layer: "Remove a layer.",
  set_layer: "Update layer metadata (name/enabled/locked/shy/solo/3D/blend/label/in-out/stretch/trackMatte). Undefined fields unchanged.",
  parent_layer: "Set/clear a layer's parent (parentLayerId=null to unparent).",
  reorder_layer: "Move layer to 1-based stack index.",

  // ---------- transforms ----------
  set_transform: "Set any of position/scale/rotation/anchorPoint/opacity (+3D orientation/per-axis on 3D). keyframe:true + time sets keyframes.",

  // ---------- keyframes ----------
  add_keyframe: "Keyframe at `time` on propertyPath (e.g. ['Transform','Position']). Optional in/out interpolation + ease.",
  remove_keyframe: "Remove keyframe at `time`.",
  get_keyframes: "All keyframes on a property: time, value, interpolation, ease, spatial tangents.",
  set_interpolation: "Set in/out interpolation type of a specific keyframe.",
  set_temporal_ease: "Set influence+speed for in/out ease of a keyframe.",
  set_spatial_tangents: "Set in/out spatial tangents for a position-style keyframe.",

  // ---------- expressions ----------
  get_expression: "Expression text + enabled state on a property.",
  set_expression: "Set + enable an expression on a property.",
  toggle_expression: "Enable/disable an expression without clearing.",
  clear_expression: "Remove an expression.",

  // ---------- effects ----------
  list_effects: "All effects on a layer with current param values + keyframes/expressions.",
  add_effect: "Add effect by matchName (use list_available_effects — matchNames are stable across AE versions; display names aren't).",
  remove_effect: "Remove effect by 1-based index.",
  set_effect_param: "Set an effect param by name/matchName. keyframe:true+time for keyframed value.",
  set_effect_enabled: "Toggle an effect on/off without removing.",
  list_available_effects: "All effects installed in this AE: displayName, matchName, category.",

  // ---------- text ----------
  set_text: "Set text content + styling (font, size, fill/stroke, tracking, leading, justification). Undefined fields unchanged.",
  add_text_animator: "Add a text animator group (position/scale/rotation/opacity/tracking/skew/fillColor/strokeColor). Optional range selector.",

  // ---------- shapes ----------
  set_shape_path: "Replace a shape path with new vertices/tangents/closed.",
  add_shape_content: "Add shape content (rect/ellipse/star/path/fill/stroke/trim/repeater/merge/group) under Contents or a sub-group.",
  set_shape_property: "Set a property on a shape content node. Optional keyframe at time.",

  // ---------- masks ----------
  add_mask: "Add a mask with vertices/tangents/closed/mode.",
  set_mask: "Modify mask vertices/tangents/closed/mode/inverted/expansion/feather/opacity.",
  remove_mask: "Remove a mask by 1-based index.",

  // ---------- markers ----------
  add_marker: "Add a marker on a layer (layerId) or on the comp. time + optional duration/comment/label/chapter/url/frameTarget.",
  remove_marker: "Remove a marker by 1-based index.",

  // ---------- vision ----------
  screenshot_frame: "ONE-OFF visual check of a comp at a time. Base64 PNG. Use only at key moments — never per-frame or in a loop. For motion, 2-3 snapshots + get_layer_full property values.",
  screenshot_layer: "ONE-OFF visual check of a single layer (solo'd) at a time. Same one-off rule as screenshot_frame.",

  // ---------- batch ----------
  run_batch: "Many ops in one ExtendScript pass, one undo step. >500 ops returns a jobId + streams progress; use await_job. transactional:true (default) rolls back on first error.",

  // ---------- explore ----------
  get_project_summary: "Project state: path, item count, active item, flat item list with type.",
  find_layers: "Search across one or all comps for layers matching name/type/effect filters.",

  // ---------- raw ----------
  run_jsx: "Escape hatch: arbitrary ExtendScript in an undo group. `comp`/`app`/`OPS`/helpers in scope. Use `return X` to send a value back; complex AE objects are coerced to plain props.",

  // ---------- jobs ----------
  await_job: "Block until job is done. Default 10min timeout. Returns the same payload the tool would have.",
  get_job: "Non-blocking job status: progress/total/state/error.",
  cancel_job: "Set cancel flag; chunked loop stops at next boundary.",
};
