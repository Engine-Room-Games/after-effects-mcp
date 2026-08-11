# After Effects MCP

**Control Adobe After Effects with AI.** Describe the animation you want — a lower third, a logo reveal, an animated counter — and it gets built in your project: layers, keyframes, easing, effects, expressions and text, all editable afterwards like anything you would make by hand.

Works with Claude and other MCP clients, on macOS and Windows.

Requires After Effects 2026 and [Node.js 22+](https://nodejs.org).

## Getting started

### 1. Create a project folder

In a terminal:

```bash
npx @engine-room/after-effects-mcp init my-video
cd my-video
```

Open that folder in your AI client. It contains everything the client needs to find the tools.

*If your client uses one global configuration file rather than per-folder settings* — Claude Desktop, for example — add this to it instead. On macOS it is `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"]
    }
  }
}
```

Restart the client afterwards.

### 2. Connect After Effects

Open After Effects, then ask the AI:

> Set up After Effects.

It installs a small panel inside After Effects, then tells you to quit and reopen it. Ask it to check the setup again to confirm.

This is a one-time step per machine. Until it is done, every tool reports that it cannot reach After Effects.

### 3. Start working

With After Effects open and your project folder open in your client, describe what you want:

> Build a lower third that says Chapter One, sliding in from the left.

The AI reads the current state of your comp, makes the change, and can take a screenshot to check the result.

Day to day, this is the only step you repeat. Create a new folder when you start a new project.

## Your house style

Each project folder contains `.claude/skills/house-style/SKILL.md`. Fill it in with your colours, fonts and motion defaults, and everything built afterwards follows them.

A quick way to write it: build one piece the way you want it, then ask the AI to read that comp and write it up in the house-style skill.

Keep one folder per client or series. To apply the same style everywhere instead, put the skill in `~/.claude/skills/house-style/`.

Updating the tools never touches this file.

## Updating

Two things to update: the tools, and the panel inside After Effects. The panel does not update on its own.

Restart your AI client — it picks up the current version of the tools. Then, with After Effects open, ask:

> Update the After Effects panel.

It reinstalls the panel and tells you to restart After Effects. Ask it to check the setup afterwards, which reports whether the panel matches the current version.

## Tools

| Group | Tools |
|---|---|
| Comps (7) | `list_comps`, `get_comp`, `get_comp_tree`, `create_comp`, `set_comp`, `delete_comp`, `set_active_comp` |
| Layers (15) | `list_layers`, `get_layer_full`, `create_{text,shape,solid,null,adjustment,precomp,camera,light}_layer`, `duplicate_layer`, `delete_layer`, `set_layer`, `parent_layer`, `reorder_layer` |
| Transforms (1) | `set_transform` — position, scale, rotation, anchor, opacity; 2D and 3D; optionally keyframed |
| Keyframes (6) | `add_keyframe`, `remove_keyframe`, `get_keyframes`, `set_interpolation`, `set_temporal_ease`, `set_spatial_tangents` |
| Expressions (4) | `get_expression`, `set_expression`, `toggle_expression`, `clear_expression` |
| Effects (6) | `list_effects`, `add_effect`, `remove_effect`, `set_effect_param`, `set_effect_enabled`, `list_available_effects` |
| Text (2) | `set_text`, `add_text_animator` |
| Shapes (3) | `set_shape_path`, `add_shape_content`, `set_shape_property` |
| Masks (3) | `add_mask`, `set_mask`, `remove_mask` |
| Markers (2) | `add_marker`, `remove_marker` |
| Vision (2) | `screenshot_frame`, `screenshot_layer` |
| Batch (1) | `run_batch` |
| Explore (2) | `get_project_summary`, `find_layers` |
| Raw (1) | `run_jsx` |
| Jobs (3) | `await_job`, `get_job`, `cancel_job` |
| Setup (2) | `check_setup`, `setup_panel` |
| Issues (3) | `list_known_issues`, `log_issue`, `mark_issue_reported` |

A few notes on the ones that behave differently from the rest:

- `get_layer_full` returns a layer's transforms with their keyframes and expressions, every effect with every parameter, masks, markers and visible bounds — in one call.
- `run_batch` runs many operations in a single pass and counts as one undo step. Long batches stream progress.
- `screenshot_frame` and `screenshot_layer` are for occasional checks, not for reviewing motion frame by frame. On large comps, `downsample: 2` renders at half resolution, which is faster and keeps the image small.
- `run_jsx` runs arbitrary ExtendScript for anything the other tools do not cover.
- `log_issue` and `list_known_issues` are the notebook described below.

## When something goes wrong

These tools have rough edges. When the AI hits one and works out a way around
it, it writes the problem and the fix into a notebook in your project folder, at
`.ae-mcp/issues/` — plain text files you can read or delete. The next session
reads that notebook before guessing, so the same twenty minutes are never spent
twice on the same project.

The folder ignores itself, so it stays out of version control without you doing
anything.

If the problem looks like ours rather than yours, the AI will say so at the end
of its reply and offer to pass it on. You can also start that yourself:

```
/report-ae-issue
```

It writes the report, shows it to you, and only sends it once you say yes.
Nothing about your own work — comp names, file paths, clients — goes into it.
Sending needs the [GitHub CLI](https://cli.github.com); without it you get a
prefilled link to click instead.

## Troubleshooting

Ask the AI to check the After Effects setup. It reports which part is broken and what to do about it.

| Symptom | Cause and fix |
|---|---|
| "Cannot reach the After Effects panel" | AE is not running, or the panel is not installed. Ask the AI to set up After Effects, then restart AE. |
| Tools worked before, now fail inside AE | The tools were updated but the panel was not. Ask the AI to update the panel, then restart AE. |
| Panel never loads, setup looks correct | On macOS, reboot once. Some builds cache the Adobe setting until a restart. |
| A panel answers but the setup check reports none installed | An older install is still serving. Remove it from the CEP extensions folder, reinstall the panel, restart AE. |
| Need the panel's own log | In AE: Window → Extensions → AE MCP Bridge. |

## Platforms

macOS and Windows. Two things differ, and are handled for you:

| | macOS | Windows |
|---|---|---|
| Panel location | `~/Library/Application Support/Adobe/CEP/extensions` | `%APPDATA%\Adobe\CEP\extensions` |
| Unsigned-panel setting | `defaults` preference | `HKCU\Software\Adobe\CSXS.*` registry value |

macOS is the more exercised of the two; [issue reports](https://github.com/Engine-Room-Games/after-effects-mcp/issues) are welcome.

## Limitations

- The panel is unsigned, so loading it requires Adobe's `PlayerDebugMode`, which the setup step enables. This is Adobe's documented path for unsigned extensions.
- `saveFrameToPng` is community-known rather than officially documented. It works, but alpha edges can be imperfect on some comps.
- A long synchronous loop in `run_jsx` will freeze the After Effects UI. Use `run_batch` for bulk work.
- Not covered: the render queue, footage import and replacement, and application preferences.

## Development

```bash
git clone https://github.com/Engine-Room-Games/after-effects-mcp.git
cd after-effects-mcp
npm install && npm run build
npm run install:panel
npm run doctor
```

| Command | Purpose |
|---|---|
| `make build` | Compile TypeScript and the ExtendScript bundle |
| `make jsx` | Rebuild `bundle.jsx` and hot-reload it into a running After Effects |
| `make watch` | TypeScript watch mode |
| `make doctor` | Diagnose the install |
| `make verify` | Build, check version strings agree, dry-run the package |
| `make release` | Bump the patch version, tag, and publish |
| `make release 1.1.0` | Set an explicit version, tag, and publish |

Adding a tool takes three edits: a zod schema in `packages/shared/src/schemas.ts`, a handler in the matching `packages/jsx/*.jsx` module, and a description in `packages/mcp-server/src/tools/descriptions.ts`. Registration is automatic.

See [CLAUDE.md](CLAUDE.md) for the architecture, the ExtendScript conventions, and the known-fragile areas.

## License

[MIT](LICENSE)
