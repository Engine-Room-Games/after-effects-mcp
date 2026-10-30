/**
 * Tool descriptions written for an LLM agent reading the tool list. Keep them
 * tight — every char is in the eager-tool budget, and tests/unit/tool-budget.mjs
 * fails the build when a tool outgrows its share. Say what the tool does, when
 * to reach for it, and only the gotchas an agent can't see from the schema.
 * A field's own detail belongs in its `.describe()` in schemas.ts, not here as
 * well; how After Effects behaves belongs in an ae_guide topic. No issue
 * numbers or measurements — they mean nothing to the model.
 */
export const descriptions: Record<string, string> = {
  // ---------- comps ----------
  list_comps: "All comps: id, name, dims, duration, fps, layer count. `include: []` returns just the id+name map — usually all orientation needs.",
  get_comp: "Single comp summary by id (no layers).",
  get_comp_tree: "Comp + nested layer tree, recursing pre-comps to `depth`.",
  create_comp: "Create a new comp. Returns id.",
  set_comp: "Modify a comp (name, dims, fps, duration, work area, bg, motionBlur/frameBlending switches). Undefined fields unchanged.",
  delete_comp:
    "Delete a comp; reversible only via AE's Undo. A comp other comps nest is REFUSED, naming them, unless `force:true` — which also deletes every precomp layer using it (listed in `removedFromComps`). Its render-queue items go too (`renderQueueItemsRemoved`). Its solids stay in the project (`unusedSolidsLeft`) unless `purgeUnusedSolids:true`; one another comp uses is kept (`keptSolids`). For the whole project's orphans use purge_unused_footage.",
  set_active_comp: "Focus a comp in the viewer/timeline.",
  duplicate_comp:
    "Copy a comp; returns the new comp id. Use this, not run_jsx + CompItem.duplicate(). SHALLOW by default, like AE's Duplicate: the copy's precomp layers point at the same nested comps, so editing one edits both. `deep:true` duplicates the nested comps too (each once) and re-points the copy at them — what 'a variant of this rig' means.",
  checkpoint_comp:
    "Save a restore point for a comp BEFORE a risky or many-call change — AE's undo stack cannot be relied on across calls. Stored as a copy in the project folder 'AE MCP Checkpoints'; returns checkpointId. SHALLOW: covers this comp's own layers (keyframes, expressions, effects, masks, markers, switches), settings and markers — NOT edits inside nested precomps, nor footage. Never edit layers inside a checkpoint comp (flagged `checkpoint: true` by list_comps/get_project_summary; find_layers skips them). delete_checkpoints the ones you are done with.",
  list_checkpoints:
    "Checkpoints in the project (or of one comp): checkpointId, compId/compName it was taken of, label, when, layer count. `originMissing: true` means its comp was deleted — duplicate_comp the checkpoint to recover the contents.",
  revert_comp:
    "Restore a comp to a checkpoint, INTO the original comp: its compId, name and precomp uses are unchanged, but every LAYER id changes — use `layerIdMap` (old -> restored id) and discard layer ids read after the checkpoint. If a layer cannot be copied in, the comp is left as it was. Layer pickers (Layer Control, Displacement Map, Set Matte, text-path masks) are re-pointed. The result is verified: `verified: false` with `mismatches`/`notRestored` is NOT a clean revert — tell the user; `verified: true` covers only the fields in `checked`, not keyframe or effect values. A comp renamed since the checkpoint is refused unless `compId` confirms it. `saveCurrent: true` checkpoints the current state first. Do not Cmd-Z a revert of a rigged comp: it can span several undo steps (`undoSplits`). The comp name is not reverted.",
  delete_checkpoints:
    "Delete checkpoints: pass exactly one of `checkpointIds` or `compId` (every checkpoint of that comp). Only checkpoint comps are ever removed — a regular comp id is refused before anything is deleted. Removes the 'AE MCP Checkpoints' folder once empty; their solids stay (purge_unused_footage sweeps them).",
  snapshot_comp:
    "Cheap structural fingerprint of a comp, kept in server memory; returns a snapshotId. Call it BEFORE a write, then diff_comp after to learn what the write did instead of reading the comp back. Records per layer: id, name, index, type, in/out/start, parent, enabled, keyframe/expression/effect counts; per comp: size, duration, fps, work area, markers. NOT property values, expression text, effect params, masks or shape contents. Writes nothing to the project; gone when the session ends.",
  diff_comp:
    "What changed in a comp since a snapshot: layers added, removed, renamed, retimed, re-parented, keyframe counts moved, expressions/effects gained or lost; unchanged layers are only counted. Tens of tokens where re-reading the comp is thousands — use it to find the new layer, where a failed script stopped, or whether an assembly landed. Only recorded fields are compared, so 'no differences' means none of THOSE moved. Returns a fresh snapshotId to keep diffing forward.",

  // ---------- layers ----------
  list_layers: "Layers in a comp, one line each; get_layer_full for details. `include: []` returns just id/index/name/type — the cheapest way to see what is in a comp.",
  get_layer_full:
    "Full state of one layer: transform + keyframes + expressions, effects, masks, markers, parenting, text/shape/footage extras, sourceRect (visible bounds). Prefer it to several smaller reads. Bound a heavy layer with `include`, `maxKeyframes`, `shapeDepth`; anything dropped is named and counted in the response. Effect parameters are capped at 200 per effect even when you pass nothing (`maxParams`, `paramFilter`); a capped effect reports `paramsOmitted`. On a shape layer prefer `shapeDetail:'compact'` — a fraction of the size, still naming every node the write tools address. Material Options are left out (`materialsOmitted`) unless `shapeMaterials:true`.",
  create_text_layer:
    "Text layer with optional font/size/color/position/tracking. `anchorAlign` (default 'left') aligns by paragraph justification with the anchor left at [0,0], so `position` is the start of the baseline and stays right when the text changes later. Tracking is 0 unless passed. Justification is read back: the result's `justification` is what AE holds (`justificationReasserted` when a second write was needed), and if it still disagrees the layer is removed and the call throws. `boxSize` makes wrapping box text.",
  create_shape_layer: "Creates an EMPTY shape layer (no fill, stroke or shapes) — draw into it with add_shape_content: a group, then a rect/ellipse/path, then a fill or stroke inside the group. Position and Anchor Point default to [0,0], so the layer's space IS the comp's and every coordinate you add is in comp pixels; `position:'center'` gives AE's own default, which offsets a comp-space drawing by half a frame. The result echoes the position and anchor point.",
  create_solid_layer: "Solid-color layer. color is RGB 0..1 or hex.",
  create_null_layer: "Null parent layer.",
  create_adjustment_layer: "Adjustment layer — effects on it apply to layers below.",
  create_precomp_layer: "Insert an existing comp into another as a pre-comp layer.",
  create_camera_layer: "Camera. 3D layers below view through it.",
  create_light_layer: "Light (parallel|spot|point|ambient).",
  duplicate_layer: "Duplicate a layer N times; each has a fresh id.",
  delete_layer: "Remove a layer. Reports the fallout AE does not announce, each only when non-empty: `unparentedChildren`, `lostTrackMatte` (layers that used it as their matte), `unusedSolidLeft` (its solid, now used by nothing — purge_unused_footage removes it).",
  set_layer: "Update layer metadata (name/enabled/locked/shy/solo/3D/blend/label/in-out/stretch/trackMatte); undefined fields unchanged. `trackMatte {type, layerId}` makes any layer in the comp this layer's matte (AE 2023+), read back in the result; a type without layerId changes how the current matte is read (refused when there is none). AE switches the matte layer's video off — set enabled:true on it if it must show. Unknown blend/matte names, an unresolvable matte layer, a matte or blend mode on a camera/light, or outPoint not after inPoint are refused before anything changes. Timeline switches (motionBlur, collapseTransformation, quality, autoOrient, …) are read back into `switches`; one the layer lacks is refused first. If AE refuses part-way, the error lists what was applied and what was not reached; one undo step.",
  parent_layer:
    "Set or clear (parentLayerId=null) a layer's parent. The layer stays visually put: the world transform is recomputed and any position/scale/rotation fix is reported in `correction`. Read `correction.notes` — 3D layers, cameras and lights are not corrected, and with a keyframed ancestor the fix is exact only at the current time. preserveTransform:false lets it jump.",
  reorder_layer:
    "Move a layer in the render stack. Pass exactly one destination: `beforeLayerId` (directly in front of / above it), `afterLayerId` (directly behind it) or `toIndex` (the 1-based position it ENDS UP at; 1 is the front). Prefer the id forms: this op shifts indices, so an index read earlier may be stale. Returns `movedFrom` and the landed `index`.",

  // ---------- transforms ----------
  set_transform: "Set any of position/scale/rotation/anchorPoint/opacity (+ orientation/xRotation/yRotation/zRotation). `keyframe:true` requires `time` and writes keyframes there; otherwise it sets static values. orientation/xRotation/yRotation need a 3D layer (set_layer threeDLayer:true first); cameras and lights take them as they are. zRotation on a 2D layer is its Rotation — pass one, not both. On a camera or light, anchorPoint sets the Point of Interest. A property the layer lacks or hides (camera Scale, a one-node camera's Point of Interest, a point light's Orientation) refuses the call. `separateDimensions` (alone, or with `properties` — at least one of the two) flips Position's switch first; then write xPosition/yPosition/zPosition, not position. Nothing is written when a call is refused.",

  // ---------- keyframes ----------
  add_keyframe: "Keyframe at `time` on propertyPath. Optional in/out interpolation + ease: one influence/speed pair per side, sized to the property for you (the count used comes back as `easeDimensions`).",
  remove_keyframe: "Remove keyframe at `time`.",
  get_keyframes: "All keyframes on a property: time, value, interpolation, ease (`perDimension` when they differ), spatial tangents, `flags`.",
  set_interpolation: "Set one keyframe's in/out interpolation and/or flags (temporalContinuous, temporalAutoBezier, spatialContinuous, spatialAutoBezier, roving); pass at least one. Flags are read back into `flags`; ones that cannot apply are refused first.",
  set_temporal_ease:
    "Set the in/out ease of one keyframe. Pass at least one of `easeIn`/`easeOut`; a side you leave out keeps its ease. ONE {influence, speed} pair per side is applied to every dimension: this tool works out the per-property array size AE wants (a wrong one fails as a bare 'parameter 2') and reports it as `easeDimensions`. A list of pairs eases each dimension apart (not on a spatial property such as Position).",
  set_spatial_tangents: "Set in/out spatial tangents for a position-style keyframe.",
  retime_keyframes:
    "Move existing keyframes in time, keeping their feel: `offset` shifts, `scale` stretches about `pivot`, `reverse` plays them backwards, `stagger` adds seconds per layer in `layers` order. Values, interpolation, eases (speeds rescaled), spatial tangents and continuous/auto-bezier/roving flags are kept. Omit a layer's `propertyPaths` for all its keyframed properties; `range` limits it to a time window. Use this instead of run_jsx or remove/re-add, which lose the eases. Keys that would land on one frame (or on a key outside `range`) are REFUSED, each named, nothing changed. Expressions are not retimed: properties carrying one are listed in `expressionsNotRetimed`. One undo step.",
  copy_animation:
    "Copy a layer's animation onto other layers (any comp): keyframes with values, interpolation, eases, spatial tangents and flags, plus expressions unless expressions:false. Omit `propertyPaths` for every animated property. `offset`/`stagger` shift the copies; align:'layerStart' keeps timing relative to each layer's start. A target lacking the property (the same effects, masks or shape groups in the same order) is refused, naming what is missing. A target property already keyframed (or with an expression, when one is copied) is refused unless replaceExisting:true — never merged silently. An expression that fails on its new layer makes the call throw after the copy, naming it; fix it with set_expression. One undo step.",

  // ---------- expressions ----------
  get_expression:
    "Expression text, enabled state and `expressionError` — AE's own compile/evaluation error (the UI's warning banner text), or '' when it runs clean. A non-empty one means the expression is not driving the property, whatever `enabled` says.",
  set_expression:
    "Set + enable an expression, then evaluate it: if AE reports an error the call THROWS with the message and property path (the text stays written) — fix it and call again, or clear_expression to remove it. A success means it compiles and runs.",
  toggle_expression:
    "Enable/disable an expression without clearing it. Enabling verifies like set_expression: an expression AE reports an error on throws rather than returning ok.",
  clear_expression: "Remove an expression.",

  // ---------- effects ----------
  list_effects: "All effects on a layer with param values + keyframes/expressions. Capped at 200 parameters per effect (`maxParams` raises it), because a third-party effect can carry thousands. Every effect reports `paramCount`; a capped one adds `paramsOmitted` and `paramsTruncated` — never read it as the whole effect. For a few parameters of a heavy effect pass `paramFilter` rather than raising the cap.",
  add_effect: "Add an effect by matchName — stable across AE versions and languages, unlike display names. A wrong matchName fails fast, so try the standard one (ADBE Gaussian Blur 2, ADBE Slider Control) before searching list_available_effects. Returns the effect with at most 200 parameters, the rest counted in `paramsOmitted`; list_effects reads more.",
  remove_effect: "Remove effect by 1-based index.",
  set_effect_param:
    "Set one parameter of one effect. Pass at least one of `paramMatchName` (preferred — the same in every UI language) or `paramName` (display name, which only matches in the user's UI language); with both, matchName wins. list_effects reports both. A miss lists the effect's parameters so you can retry. `keyframe:true` requires `time` and writes a keyframe there.",
  set_effect_enabled: "Toggle an effect on/off without removing.",
  list_available_effects: "Effects installed in this AE: displayName, matchName, category. **Always pass `filter`** (substring): the full list is 250-450+ entries and takes seconds; a filtered one a fraction of one. Cached per AE session — `refresh:true` after installing a plugin. Never loop over `app.effects` in run_jsx: it can block the bridge past its timeout.",

  // ---------- text ----------
  set_text:
    "Set text content + styling (font, size, fill/stroke, tracking, leading, justification); undefined fields unchanged. Justification is verified: AE can reset it when only the text changes, so it is read back and re-written if it moved, and if it still disagrees the call throws naming expected and actual. The result carries `justification` (read back) and `justificationReasserted`. `boxSize` resizes box text; refused on point text.",
  add_text_animator: "Add a text animator group (position/scale/rotation/opacity/tracking/skew/fillColor/strokeColor), optionally with a range selector (start/end/offset in %). All-or-nothing: if AE refuses the property or a range value, the animator is removed and the error names what failed. Returns the animator name and the property matchName.",

  // ---------- shapes ----------
  set_shape_path: "Replace a shape path with new vertices/tangents/closed. `shapePath` names a path node (e.g. [\"Contents\", \"Group 1\", \"Contents\", \"Path 1\"]) or its Path property; anything else (a rect, a group) is refused. Tangents not given are straight corners; a tangent array must have one entry per vertex.",
  add_shape_content: "Add shape content under Contents or a sub-group. `content.type` picks the node (rect/ellipse/star/path/fill/stroke/trim/repeater/merge/group); its other keys set the node's properties. No gradient fill/stroke: a script cannot set its colour stops. Unknown or unsettable keys are NOT ignored — the node is rolled back and the error lists them, so trust a success. ORDER MATTERS: index 1 renders in FRONT and each call appends behind the last, so add front-to-back (details first, background rects last) rather than reaching for `zOrder`. A reference to one node goes stale once a sibling is added ('Object is invalid'): add every node first, then address them by name. More in ae_guide topic 'shapes'.",
  set_shape_property: "Set a property on a shape content node. `keyframe:true` requires `time` and writes a keyframe there; otherwise it sets the static value.",

  // ---------- masks ----------
  add_mask: "Add a mask with vertices/tangents/closed/mode.",
  set_mask: "Modify mask vertices/tangents/closed/mode/inverted/expansion/feather/opacity. Each path field applies on top of the current path: `closed:false` alone opens it, `inTangents` alone re-curves it. Tangents not given are kept unless new `vertices` change the count (then straight); a tangent array needs one entry per vertex. Refused with nothing changed: a wrong tangent count, a vertex-count change on a mask with variable-width feather points, or any path field on a keyframed mask path (use add_keyframe there).",
  remove_mask: "Remove a mask by 1-based index.",

  // ---------- markers ----------
  add_marker: "Add a marker on a layer (layerId) or on the comp, at `time` with optional duration/comment/label/chapter/url/frameTarget.",
  remove_marker: "Remove a marker by 1-based index.",

  // ---------- vision ----------
  screenshot_frame: "ONE-OFF visual check of a comp, as a PNG — never per-frame or in a loop. To judge MOTION pass `times` (2-6) for one tiled contact sheet, about the cost of a single frame; `time` and `times` are mutually exclusive. A picture is not exact: confirm numbers with get_layer_full / get_keyframes. Leave `downsample` unset unless you genuinely need full resolution. Non-image answers: 'Stale frame' (AE re-served an earlier render), 'Corrupt frame' (retry at downsample 6-8, or screenshot the precomps separately), 'Render timed out' (still rendering — wait, don't retry at once), `empty:true` (every pixel transparent — check time, in/out points, enabled). A bad sheet tile is marked and named in `warning`; the rest of the sheet is still good. Never disable layers to make a frame render.",
  screenshot_layer: "ONE-OFF visual check of a single layer (solo'd) at a time — do NOT screenshot every frame. Same downsample guidance and the same 'Stale frame', 'Corrupt frame', 'Render timed out' and `empty:true` answers as screenshot_frame. No `times` here — contact sheets are screenshot_frame only.",

  // ---------- batch ----------
  run_batch:
    "Many ops in one ExtendScript pass — far faster, and far fewer undo steps, than separate calls. " +
    "**Up to 500 ops it is exactly one undo step.** Over 500 it is chunked into a background job: this call returns a jobId at once; finish with await_job (a progressToken goes on THAT call; get_job polls) — and it lands as **one undo step per chunk of 25**, since AE discards an undo group that spans two script calls. Read `undoSteps` and its `note` before telling anyone how to undo the work; never say \"one Cmd-Z\" for a chunked batch. This server sends the chunks, so if it stops mid-batch (client quit or restarted) the batch stops at a chunk boundary: read the comp back, never re-send it whole. " +
    "`singleUndo:true` forces one undo step up to 2000 ops, freezing AE with no progress until done; over 2000 is refused. " +
    "Each step's `args` are checked as that tool's own; a batch with any bad step is refused whole before anything runs. Not allowed as steps: screenshot_frame, screenshot_layer, snapshot_comp, diff_comp, analyze_motion, export_mogrt, render_queue, get_house_style and the server-side tools (ae_guide, await_job, log_issue, …). " +
    "transactional:true (default) stops at the first error; nothing rolls back either way — read the state back rather than re-running. " +
    "`diff:true` appends a structural diff of what the batch did, also to an error — the cheapest way to find where a half-applied batch stopped.",

  // ---------- explore ----------
  get_project_summary: "Project state: path, item count, active item, flat item list with type (comp | footage | solid | folder | unknown — same vocabulary as a layer's sourceType).",
  get_selection:
    "What the user has selected right now in the comp they are looking at: `{comp:{id,name}, source, time, frame, selectedLayers:[{id,index,name}], selectedProperties:[{layerId, layerName, propertyPath, name, matchName, kind, selectedKeyTimes?}], note?}`. " +
    "Use it when the user says \"this layer\", \"these keyframes\" or \"here\" (the playhead) instead of asking them to name it. A `kind:\"property\"` propertyPath goes straight into the propertyPath tools; a `kind:\"group\"` cannot be keyframed — read its children with get_layer_full. `time` is comp seconds, the keyframe clock; `frame` is as the timeline shows it. " +
    "The comp is the active item (`source:\"activeItem\"`) — if the user may mean another comp, say which one you read; only when that is not a comp is the viewer asked (`source:\"viewer\"`, with a `note` — it takes keyboard focus, changes nothing). With neither it answers `comp:null` and a `reason` — ask the user then, never guess. " +
    "The selection can change any moment: read it when you need it, and say which layer you took them to mean before changing it. Capped at 200 layers, 100 properties, 50 key times per property (`omitted`/`selectedKeysOmitted`). Read-only.",
  find_layers:
    "Search one comp (`compId`) or every comp for layers by name (regex, case-insensitive), type and/or effect matchName. Returns `{matches, count, compsSearched, included}`; each match is id/index/name/sourceType plus compId/compName — enough to address it. Bounded by default: unlike list_layers, an omitted `include` adds no sections; pass flags, timing and/or parent to add them. A project-wide search skips checkpoint comps (`checkpointsSkipped`); pass a checkpoint's id as `compId` to search one.",

  // ---------- raw ----------
  run_jsx:
    "Escape hatch: arbitrary ExtendScript in one undo group. Pass exactly one of `code` or `scriptPath` (absolute; the server reads it, so prefer it for anything long). `libraries` (absolute .jsx paths) are inlined ahead in the same scope and re-evaluated every call — keep them to declarations. " +
    "In scope: `app`, the full `OPS` table (every tool, e.g. `OPS.set_transform({compId, layerId, position:[0,0]})`), and these helpers — `compById(id)`, `getCompById(id)`, `layerById(compOrId, layerId)`, `getLayerById(comp, layerId)`, `walkProperty(layer, [\"Transform\",\"Position\"])`, `addKeys(prop, [[t, v], …])` → key indices, `ease(prop, keyIndex, easeIn, easeOut)` which sizes the KeyframeEase array itself (a bare number is influence; omit easeOut for the same both sides), `shape(comp, {name, position})` which lands the layer at [0,0] rather than the comp centre, `setValueChecked(prop, value)` — use it instead of `prop.setValue(value)` in a comp not open in a viewer, where AE can throw a false 'invalid numeric result'; it rethrows only if the write really failed — and `withoutUndoGroup(fn)`. " +
    "`app.executeCommand()` menu commands silently no-op here; use the API equivalents (`CompItem.duplicate()`, `layer.duplicate()`). " +
    "`return X` sends a value back whole; anything not JSON becomes a marker string in place, never dropped: `\"[function]\"`, `\"[undefined]\"`, `\"[circular]\"`, `\"[max depth]\"`, `\"[NaN]\"`, and live AE objects as `\"[CompItem \\\"Main\\\" #12]\"` — a handle for a read tool. " +
    "No explicit `return` (a bare final expression does NOT return) answers `{ok:true, returned:null, undoGroup, note}`: it ran to completion and did **not** fail — do not re-run it; nothing rolls back, so a mutating script would apply twice. " +
    "A failure names the line of YOUR script (or says it cannot); everything before it already ran — read the state back, never re-run to see if it fails again. " +
    "AE refuses copyToComp for a layer with a parent or a linked expression inside an undo group: wrap just that part in `withoutUndoGroup(function(){ … })`, or pass undoGroup:false. Keep loops short — ExtendScript freezes the user's UI. " +
    "`diff:true` appends what the script changed (the answer is then `{ok, returned, diff}`), also to an error. Read ae_guide topic 'extendscript-gotchas' before writing anything substantial.",

  // ---------- footage ----------
  import_footage:
    "Import a file (video, image, audio, SVG, PSD/AI); returns the item id for create_footage_layer. Validates what AE produced: an SVG that imports at the wrong aspect ratio renders as nothing, so the item is deleted and the call throws with the workaround; `force:true` keeps it and reports the problem in `validation`.",
  create_footage_layer: "Place an imported project item into a comp as a layer. Takes the itemId from import_footage or get_project_summary. For a comp use create_precomp_layer instead.",
  purge_unused_footage:
    "Remove footage items no comp uses — by default only solids, which delete_comp and delete_layer leave behind. `solidsOnly:false` removes every unused footage item, like AE's Remove Unused Footage. Comps and folders are never touched. " +
    "Use `dryRun:true` first on a project you did not build (lists `wouldRemove`, no undo step). `folderId` limits the sweep to one folder tree. Reports `scanned`, `inUse` and `removed`; one undo step. If a removal fails, the error names what was already removed and what was not attempted — nothing rolls back.",

  // ---------- audio ----------
  place_audio_cues:
    "Score a scene in one call: each cue — a sound at a comp time with a level in dB — becomes one audio layer, imported if needed, named, trimmed and labelled, all in one undo step. Use it for more than two or three sound effects instead of a run_jsx loop. " +
    "Each cue names its sound with **exactly one** of `path` or `footageId`; `inPoint`/`outPoint` trim in COMP time. Per-cue `loop`, `fadeIn`/`fadeOut` and `stretch` are explained on their fields; a stretched loop bakes the factor into its expression, so changing stretch by hand later leaves the loop at the old rate. " +
    "All-or-nothing: every cue is validated (file, audio, time inside the comp, options) before any layer is made; if a later one still fails, everything created is removed and the error names the cue index. The result has one small entry per cue plus `sources` (imported or reused). `dryRun:true` checks the list without touching anything, undo stack included. Max 200 cues. More in ae_guide topic 'sound'.",

  // ---------- motion graphics templates ----------
  export_mogrt:
    "Export a comp as a .mogrt for Premiere. It saves the project first, suppresses AE's modal font warning (which would freeze this connection until someone clicks OK in AE) and runs outside the undo group. " +
    "**The comp needs at least one property in its Essential Graphics panel** — AE silently refuses an empty one, so this refuses first; add one with add_essential_property. " +
    "`posterTime` renders that frame as the thumbnail instead of AE's black one (the export still succeeds if only the thumbnail fails); needs the project saved once by hand. `fonts` in the result lists the fonts the template requires — tell the user, since Premiere flags non-Adobe ones. " +
    "If an export still fails, read the message: it lists what was checked, and under the default suppression no dialog is involved — the user sees AE's own reason by running the export by hand from the Essential Graphics panel.",

  add_essential_property:
    "Add one layer property to its comp's Essential Graphics panel as a controller — what export_mogrt needs. `propertyPath` must name a single property, not a group: ['Source Text'], ['Effects','Fill','Color'], ['Transform','Position']. " +
    "Refused with nothing changed when AE says it cannot go in — paths, masks, markers and layer pickers cannot; drive one of those by expression from an expression-control effect and add the control. The result is read back from the panel: `controllerCount`, `controllerIndex`, `controllerName`. An unchanged count is a refusal (usually already in the panel), so call it once per property.",

  // ---------- render queue ----------
  add_to_render_queue:
    "Queue a comp to render to `outputPath` (absolute; its folder must exist; [####] for an image sequence). Choose the format by TEMPLATE NAME — `outputModuleTemplate`, `renderSettingsTemplate`. Scripts cannot set codec, bit depth or alpha directly, so if no template fits, ask the user to save one in AE (Edit > Templates > Output Module) and pass its name. An unknown name is refused with the list that exists. " +
    "The result reads back what AE will write — `outputs[0].settings` (format/channels/depth/color) and the final path, which AE may change to match the format; check alpha there, not by a template's name. An existing file is refused unless `overwrite:true`; a path any other item in the queue has (an already-rendered, unticked one too — remove it first to render there again) is refused outright, naming that item. A refused call queues nothing. This only queues — render_queue renders.",
  list_render_queue:
    "The render queue: per item its 1-based `index`, comp, status (QUEUED, DONE, NEEDS_OUTPUT, …), frame count, output paths and template names. `includeSettings:true` adds each output's format/channels/depth/color; `includeTemplates:true` every template name (needs one item queued). Items have no stable id — re-read before acting on an index.",
  remove_render_item:
    "Remove one render queue item by its current `index`, checked against `compId` so a shifted index is refused instead of deleting the wrong item.",
  render_queue:
    "Render render-queue items to their output files. Pass exactly one of `indices` (the items you added — the normal call) or `all:true`, which renders EVERY QUEUED item including ones the user queued by hand; use it only when the user asked for the whole queue. Returns a jobId at once; a background `aerender` process renders a private copy of the saved project, so AE stays responsive and later edits do not change the render. " +
    "Unsaved changes are refused unless `saveProject:true` — tell the user it will be saved first. Missing footage the render draws is refused before anything renders; missing footage it does not draw comes back in `missingFootageNotRendered` (or `footageWarnings`) — mention it. Never-saved, read-only or converted-from-older projects are refused with what to do. Existing output files are refused unless `overwrite:true`; an item sharing its output path with any other item (unticked ones too) is refused outright. " +
    "Then await_job (generous `timeoutMs`; a progressToken for per-frame progress). Outputs are checked on disk — a missing or stale file is a failure, never done. Rendered items are then unticked in the queue, which adds ONE undo step, \"AE MCP: mark rendered\", to the user's history — mention it. cancel_job kills the process and names any incomplete file. One render at a time. More in ae_guide topic 'rendering'.",

  // ---------- house style ----------
  get_house_style:
    "The user's palette, type, motion and layout defaults for the open project, from `house-style.md` beside the .aep. Call it once before building anything so your work matches theirs — it is cheap. Default is a few-hundred-token summary; `detail:'full'` returns the whole document, needed before editing it with set_house_style. `found:false`: none exists — use sensible defaults and offer to capture one afterwards.",
  analyze_motion:
    "Read how comps the user already animated move, as numbers for the Motion section of their house style: typical move length, common ease influence, overshoot and settle, anticipation, staggers between layers, holds. Reads every keyed property in the named comps (not precomps inside them) and returns a bounded summary plus `suggestedLines` — never the keys. Read-only. Show the user what it found and write it with set_house_style only after they agree. For one property's exact keys use get_keyframes.",
  set_house_style:
    "Write the project's style guide. Replaces the whole file, so read it first and send the merged document — `overwrite:true` is required to replace an existing one. The project must have been saved once, since the file lives beside the .aep. ae_guide topic 'style-guide' covers capturing a style worth writing down.",

  // ---------- guidance ----------
  ae_guide:
    "The working guidance for these tools, by topic — the traps that silently produce wrong output and that no single tool's schema shows. Read `after-effects` before a first substantial build in a session; the other topics are listed on `topic`. `whats-new` is one section per release, newest first, each entry giving the rule as it now stands and a `supersedes:` line; without `since` it returns the two newest releases and names the older ones, and `since` (e.g. '0.4.0', or '0.0.0' for everything) returns every release after it. `since` is rejected on any other topic.",

  // ---------- jobs ----------
  await_job:
    "Block until a job is done — a chunked run_batch, or a render_queue render — and return the tool's payload, `undoSteps` included. Default 10min timeout; a timeout stops only the wait, never the job — call await_job again rather than re-sending the work. An unknown jobId (mistyped, or from before a server restart) fails at once — for a batch After Effects still knows, saying how far it got. " +
    "**This is the call that carries progress**: send the progressToken here, since run_batch answers before its first chunk runs.",
  get_job:
    "Non-blocking job status: progress/total/state/error. `status` is running, cancelling (cancel_job accepted; not stopped yet), completed, failed or cancelled — the last three are final. Poll this when you cannot keep an await_job open; it sends no progress notifications. An id this server process does not know is an error, never an empty result.",
  cancel_job:
    "Stop a job. A chunked run_batch stops at the next chunk boundary (what already ran stays applied): `ok:true` only once it has stopped, with `opsRun` (= `opsSucceeded` + `opsFailed`) and await_job/get_job returning the partial result; `ok:false` with `status:\"cancelling\"` means accepted but not yet stopped — call await_job; `ok:false` with `status:\"completed\"` means it finished first and every op ran. An error's message says which of four things happened: the cancel was NOT confirmed (the batch may still be running — never report it stopped); the job is already over (await_job returns its result); the jobId is unknown to this server process; or AE or the panel restarted and lost the job (not running, result lost — read the comp back rather than re-sending). Read the message before telling the user anything. A render_queue render is stopped by ending its aerender process: `stopped:true` only once it has exited, with `partialFiles` naming possibly incomplete output — check its duration before using or deleting it.",

  // ---------- setup ----------
  check_setup: "Diagnose the After Effects connection: panel installed and up to date, the version AE is actually running, Adobe debug preference, AE running, bridge answering on whichever port it answers, `portAgreement`, and — when nothing answers — `panelSignature`. Read-only, safe any time. Call it FIRST whenever a tool cannot reach After Effects or says the panel is out of date, then relay `nextSteps` to the user in plain language. `panelRunningCurrent` predicts whether calls will work; it can fail while `panelUpToDate` passes (update installed, AE not restarted). A failing `portAgreement` is a stale server port: retry the call or reconnect the MCP server — never restart After Effects for it. A failing `panelSignature` means no restart or reinstall will help; `nextSteps` carries the self-signing fix. A failing `panelSignatureIntact` (files changed after signing) is fixed by setup_panel with force:true.",
  setup_panel: "Install or refresh the After Effects panel and enable the Adobe preference AE needs to load it — when check_setup reports the panel missing, out of date, or older than what AE is running. It writes to the user's Adobe CEP extensions folder and sets user-level Adobe preferences (PlayerDebugMode; CEP's LogLevel where unset) — tell the user before calling it. Best while AE is CLOSED; if AE is open they must quit and reopen it, and the old panel answers until they do. A released server ships the panel signed (result `signed: true`): it loads without the debug preference, which is set only as a fallback. An unsigned panel (a development checkout) needs the preference, and newly enabling it may need a one-time Mac reboot; it also replaces a self-signed install (check_setup's `panelInstalled` says so) with an unsigned copy that must be re-signed — tell the user first.",
  init_project:
    "Set up a working folder for one video, series or client: a project brief and a pointer to the house style, in this client's layout. For when the user is starting out or asks to set up a project. It writes files — say which folder before calling, and pass `dir` unless the client already told the server where it works. It never overwrites anything and reports every path it wrote. Leave AGENTS.md's `Tools version last absorbed: <version>` line in place: the absorb-release prompt reads and moves it after an upgrade.",

  // ---------- issue journal ----------
  list_known_issues:
    "Problems earlier sessions hit with these tools, with the workarounds that worked. No need to read it ahead of time: a failed call names matching entries in its error, under `Known from earlier sessions:`. Call it when planning something that has bitten before (`tool` or `query`), to open an entry a failure pointed at, or when the user asks. Merges two journals and tags each entry: `project` (or `home`) for this project's notes, `user` for tool and AE behaviour across projects. Default is a one-line index, entries naming `tool` first; read one with `id` in the `scope:id` form the `next` pointer shows. Archived entries are hidden and counted in `archivedCount`. Also returns the repo and server version needed to report one.",
  log_issue:
    "Record a problem you hit and the workaround that got past it, so the next session doesn't rediscover it. Only what cost real effort and will recur — a tool failing for a non-obvious reason, an argument shape the schema didn't imply, AE behaving unlike the docs; not your typos or one-off user mistakes. Pass `tools` and the exact `errorText`: later failures are matched on them, and a re-log merges into the existing entry (`mergedBy`, existing title kept), as does reusing a title. `kind:'ae-quirk'` for permanent AE behaviour. `scope:'user'` when it is about how these tools or AE behave; the default `project` for this project's footage, comps or files. `reopened:true` means a retired problem is back — tell the user it was supposed to be gone. If the result says reported:false, then AFTER finishing the actual work, close your reply by telling the user in plain language that something took much longer than it should have and offering to pass it to the people who maintain this tool — phrased for a motion designer, in terms of what happened; don't say 'GitHub issue' or 'bug report' unless they do.",
  mark_issue_reported:
    "Record that a journal entry has been sent to the maintainers, with the resulting URL. Call it only once the issue really exists, so later sessions don't ask the user to report the same thing twice.",
  archive_issue:
    "Retire a journal entry for good: it leaves the index (failure pointers still name it, marked archived with this reason) but the file stays, with `reason` in its frontmatter. Use it when a report already covers the problem (pass that URL), a release fixed it, or the lesson moved into the project's own notes — entries that merely go quiet archive themselves. Use the scope-qualified id (`user:my-entry`) when both journals hold the slug; only that one moves. A later log_issue with the same title, or the same tool and error text, brings it back and says so.",
};
