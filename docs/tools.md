# The tools

Everything your assistant can do in After Effects, grouped by what it works on.
You never call these yourself — you describe what you want, and the assistant
picks the tools. This page is here for the curious, and for checking whether
something is covered at all.

Back to the [README](../README.md).

## All 89 tools

| Group | Tools |
|---|---|
| Comps (14) | `list_comps`, `get_comp`, `get_comp_tree`, `create_comp`, `set_comp`, `delete_comp`, `set_active_comp`, `duplicate_comp`, `snapshot_comp`, `diff_comp`, `checkpoint_comp`, `list_checkpoints`, `revert_comp`, `delete_checkpoints` |
| Layers (15) | `list_layers`, `get_layer_full`, `create_{text,shape,solid,null,adjustment,precomp,camera,light}_layer`, `duplicate_layer`, `delete_layer`, `set_layer`, `parent_layer`, `reorder_layer` |
| Transforms (1) | `set_transform` — position, scale, rotation, anchor, opacity; 2D and 3D; optionally keyframed |
| Keyframes (8) | `add_keyframe`, `remove_keyframe`, `get_keyframes`, `set_interpolation`, `set_temporal_ease`, `set_spatial_tangents`, `retime_keyframes`, `copy_animation` |
| Expressions (4) | `get_expression`, `set_expression`, `toggle_expression`, `clear_expression` |
| Effects (6) | `list_effects`, `add_effect`, `remove_effect`, `set_effect_param`, `set_effect_enabled`, `list_available_effects` |
| Text (2) | `set_text`, `add_text_animator` |
| Shapes (3) | `set_shape_path`, `add_shape_content`, `set_shape_property` |
| Masks (3) | `add_mask`, `set_mask`, `remove_mask` |
| Markers (2) | `add_marker`, `remove_marker` |
| Vision (2) | `screenshot_frame`, `screenshot_layer` |
| Batch (1) | `run_batch` |
| Footage (3) | `import_footage`, `create_footage_layer`, `purge_unused_footage` — remove the solids (or any footage) no comp uses, with a dry run |
| Audio (1) | `place_audio_cues` — a whole cue list placed as one undo step |
| Motion Graphics (2) | `add_essential_property`, `export_mogrt` — fill the Essential Graphics panel, then export a comp as a `.mogrt` template for Premiere |
| Render queue (4) | `add_to_render_queue`, `list_render_queue`, `remove_render_item`, `render_queue` — render in the background, with progress and cancel |
| Explore (3) | `get_project_summary`, `find_layers`, `get_selection` — what you have selected and where the playhead is |
| Raw (1) | `run_jsx` |
| House style (3) | `get_house_style`, `set_house_style`, `analyze_motion` — read the eases, timings and staggers of comps already animated, for the style guide |
| Jobs (3) | `await_job`, `get_job`, `cancel_job` |
| Setup (3) | `check_setup`, `setup_panel`, `init_project` |
| Guidance (1) | `ae_guide` |
| Issues (4) | `list_known_issues`, `log_issue`, `mark_issue_reported`, `archive_issue` |

## The ones worth knowing about

- **`get_layer_full`** returns a layer's transforms with their keyframes and expressions, every effect with every parameter, masks, markers and visible bounds — in one call.
- **`run_batch`** runs many operations in a single pass. Up to 500 of them is one undo step; past that it runs in the background, streams progress, and lands as one undo step per chunk — After Effects will not keep a single undo group across a long job, so the result says exactly how many steps the work took. Ask for a single undo step at any size with `singleUndo`, at the cost of freezing After Effects until it finishes.
- **`screenshot_frame`** and **`screenshot_layer`** are for occasional checks, not for reviewing motion frame by frame. To judge movement, `screenshot_frame` takes several times at once and returns them as one labelled contact sheet. On large comps it renders at reduced resolution unless you ask otherwise.
- **`analyze_motion`** reads how comps you have already animated actually move — eases, durations, overshoot, staggers — so a style guide can describe your motion with numbers rather than adjectives.
- **`import_footage`** checks what After Effects actually produced. An SVG whose `viewBox` asks for one shape and imports at another is a known After Effects bug that renders as nothing, with no error — so the import is refused and explained rather than left to fail silently later.
- **`render_queue`** renders comps to movies or image sequences in the background, in a separate copy of After Effects, so the one you are working in stays usable. Formats come from your output-module templates; the result lists every file it checked on disk, and a cancel really stops the render. The background copy renders the saved file, so with unsaved changes your assistant has to ask to save first.
- **`export_mogrt`** writes a Motion Graphics template for Premiere. It suppresses the dialogs that would otherwise sit waiting for a click, and can take the thumbnail from any frame you choose rather than the first one — which is usually black if the comp fades up.
- **`snapshot_comp`** and **`diff_comp`** answer "what did that change actually do" without reading the whole comp back: a fingerprint before the change, and afterwards a list of what moved.
- **`checkpoint_comp`** and **`revert_comp`** save a copy of a comp and put it back later — into the same comp, rather than as a new one beside it.
- **`run_jsx`** runs any ExtendScript, for whatever the other tools don't cover. Long scripts can run from a file so they never fill up the conversation.
- **`ae_guide`** is how the assistant reads its own working guidance — the same text the server publishes as MCP resources and ships to Claude Code as skills.

## Extras some apps show

These depend on your AI app supporting a newer part of MCP. Where it doesn't,
everything still works; you just don't get the extra.

- **Asking before destructive changes.** `delete_comp`, `purge_unused_footage` and `revert_comp` ask you to confirm first (and `revert_comp` offers to save the current state). Say no and nothing changes.
- **A comp timeline you can look at.** In apps that support MCP Apps, `snapshot_comp` and `diff_comp` show the comp as layer bars over time, with the work area and markers — and after a change, which layers were added, changed or removed.
- **Live project info.** The project summary and the active comp are offered as resources the app can subscribe to, so it hears when they change.
