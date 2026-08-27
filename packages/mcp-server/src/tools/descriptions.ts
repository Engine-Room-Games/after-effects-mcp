/**
 * Tool descriptions written for an LLM agent reading the tool list. Keep them
 * tight — every char is in the eager-tool budget. Say what the tool does, when
 * to reach for it, and only the gotchas an agent can't see from the schema.
 */
export const descriptions: Record<string, string> = {
  // ---------- comps ----------
  list_comps: "All comps: id, name, dims, duration, fps, layer count. Pass `include` to trim it — `include: []` returns the id+name map alone, which is all orientation usually needs.",
  get_comp: "Single comp summary by id (no layers).",
  get_comp_tree: "Comp + nested layer tree, recursing pre-comps to `depth`.",
  create_comp: "Create a new comp. Returns id.",
  set_comp: "Modify a comp (name, dims, fps, duration, work area, bg). Undefined fields unchanged.",
  delete_comp: "Delete a comp. Reversible only via AE's Undo.",
  set_active_comp: "Focus a comp in the viewer/timeline.",

  // ---------- layers ----------
  list_layers: "Layers in a comp, one-line each. Use get_layer_full for details. Pass `include` to trim it — `include: []` returns just id/index/name/type, the cheapest way to learn what is in a comp.",
  get_layer_full: "Full state of one layer: transform + keyframes + expressions, effects, masks, markers, parenting, text/shape/footage extras, and sourceRect (visible bounds). Always prefer over multiple smaller queries. Bound the answer on a heavy layer: `include` picks the sections you need, `maxKeyframes` caps the keyframes per property, `shapeDepth` limits the Contents walk. Anything dropped is named and counted in the response, so a bounded read is never mistaken for a complete one.",
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
  add_shape_content: "Add shape content under Contents or a sub-group. `content.type` picks the node (rect/ellipse/star/path/fill/stroke/trim/repeater/merge/group); the other keys set its properties by friendly name (e.g. rect: size/position/roundness; fill: color/opacity; stroke: color/width/lineCap; path: vertices/inTangents/outTangents/closed). Unknown or unsettable keys are NOT ignored — the whole node is rolled back and an error lists them, so trust a success result. Use get_layer_full to see exact property names.",
  set_shape_property: "Set a property on a shape content node. Optional keyframe at time.",

  // ---------- masks ----------
  add_mask: "Add a mask with vertices/tangents/closed/mode.",
  set_mask: "Modify mask vertices/tangents/closed/mode/inverted/expansion/feather/opacity.",
  remove_mask: "Remove a mask by 1-based index.",

  // ---------- markers ----------
  add_marker: "Add a marker on a layer (layerId) or on the comp. time + optional duration/comment/label/chapter/url/frameTarget.",
  remove_marker: "Remove a marker by 1-based index.",

  // ---------- vision ----------
  screenshot_frame: "ONE-OFF visual check of a comp at a time. Base64 PNG. Use only at key moments — never per-frame or in a loop. For motion, 2-3 snapshots + get_layer_full property values. A downsample is chosen from the comp size unless you pass one — omit it, and pass downsample:1 only when you genuinely need full resolution. The result reports the dimensions actually returned, and warns if a requested downsample could not be applied.",
  screenshot_layer: "ONE-OFF visual check of a single layer (solo'd) at a time. Same one-off rule and same downsample guidance as screenshot_frame.",

  // ---------- batch ----------
  run_batch: "Many ops in one ExtendScript pass, one undo step. >500 ops returns a jobId + streams progress; use await_job. transactional:true (default) rolls back on first error.",

  // ---------- explore ----------
  get_project_summary: "Project state: path, item count, active item, flat item list with type.",
  find_layers: "Search across one or all comps for layers matching name/type/effect filters.",

  // ---------- raw ----------
  run_jsx: "Escape hatch: arbitrary ExtendScript in an undo group. `comp`/`app`/`OPS`/helpers in scope. Use `return X` to send a value back; complex AE objects are coerced to plain props.",

  // ---------- house style ----------
  get_house_style:
    "The user's palette, type, motion and layout defaults for the project that is open, read from `house-style.md` beside the .aep. Call it once before building anything so your work matches the rest of theirs. `found:false` means none exists yet — build with sensible defaults and offer to capture one afterwards. Cheap; never a reason to skip.",
  set_house_style:
    "Write the project's style guide. Replaces the whole file, so read it first and send the merged document — `overwrite:true` is required to replace an existing one. The project must have been saved at least once, since the file lives beside the .aep. Use the style-guide topic of ae_guide for how to capture a style worth writing down.",

  // ---------- guidance ----------
  ae_guide:
    "The full working guidance for these tools, by topic. Read `after-effects` before a first substantial build in a session, `style-guide` when capturing or editing the user's look, `ae-setup` when a tool cannot reach After Effects. Covers the traps that silently produce wrong output and are not visible from any single tool's schema.",

  // ---------- jobs ----------
  await_job: "Block until job is done. Default 10min timeout. Returns the same payload the tool would have.",
  get_job: "Non-blocking job status: progress/total/state/error.",
  cancel_job: "Set cancel flag; chunked loop stops at next boundary.",

  // ---------- setup ----------
  check_setup: "Diagnose the After Effects connection: panel installed, up to date, the version AE is actually running, Adobe debug preference on, AE running, bridge answering. Read-only and safe to call any time. Call this FIRST whenever another tool reports it cannot reach After Effects or says the panel is out of date, then relay `nextSteps` to the user in plain language. `panelRunningCurrent` is the one that predicts whether calls will work — it can fail while `panelUpToDate` passes, which means an update is installed but AE has not been restarted.",
  setup_panel: "Install or refresh the After Effects panel and enable the Adobe preference AE needs to load it. Run this when check_setup reports the panel is missing, out of date, or older than what AE is running. It writes to the user's Adobe CEP extensions folder and sets a user-level Adobe preference — tell the user what it will do before calling it. Prefer running it while AE is CLOSED: the panel then loads when they open it, with no restart. If AE is already open they must quit and reopen it, and until they do, the old panel keeps answering. If the preference was newly enabled, a one-time Mac reboot may also be needed.",
  init_project:
    "Set up a working folder for one video, series or client: a project brief and a pointer to the house style, written in whichever layout this client reads. Run it when the user is starting out or asks to set up a project. It writes files to disk — say which folder before calling, and pass `dir` explicitly unless the client already told the server where it is working. It never overwrites anything and reports every path it wrote.",

  // ---------- issue journal ----------
  list_known_issues:
    "Problems earlier sessions hit with these tools, with the workarounds that worked. Read it when a tool fails in a way you don't immediately understand — pass `tool` or `query` to narrow it — and before nontrivial work. It can save you rediscovering a fix that already cost someone an hour. Returns a one-line index by default; the cause and the workaround are in the entry, so follow up with `id` on anything that looks like your problem. `detail:'full'` dumps every matching entry and is rarely worth it. Also returns the repo and server version needed to report one.",
  log_issue:
    "Record a problem you hit and the workaround that got past it, so the next session doesn't rediscover it. Log only what cost real effort and will recur: a tool failing for a non-obvious reason, an argument shape the schema didn't imply, AE behaving unlike the docs. Not your own typos, not one-off user mistakes. Call list_known_issues first and reuse the same title to extend an existing entry rather than duplicating it. If the result comes back with reported:false, then AFTER you have finished the actual work, close your reply by telling the user in plain language that something took much longer than it should have and offering to pass it to the people who maintain this tool — phrase it for a motion designer, in terms of what actually happened, and don't say 'GitHub issue' or 'bug report' unless they say it first.",
  mark_issue_reported:
    "Record that a journal entry has been sent to the maintainers, with the resulting URL. Call it only once the issue really exists, so later sessions don't ask the user to report the same thing twice.",
};
