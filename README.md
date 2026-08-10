# After Effects MCP

**Control Adobe After Effects with AI.** Describe the animation you want — a lower third, a logo reveal, an animated counter — and it gets built in your project: layers, keyframes, easing, effects, expressions and text, all editable afterwards like anything you would make by hand.

Works with Claude and other MCP clients, on macOS and Windows.

Requires After Effects 2026 and [Node.js 20+](https://nodejs.org).

## Getting started

Four steps. Steps 2 and 3 are one-time setup for a machine; step 1 repeats for each new piece of work.

### 1. Create a project folder

Everything happens inside a folder — it holds your style settings and gives the AI somewhere to work. In a terminal:

```bash
npx @engine-room/after-effects-mcp init my-video
cd my-video
```

Then open that folder in Claude Code, or whichever MCP client you use.

*Alternatively:* if you only want to try things out, any folder will do — you can create a project later.

### 2. Install the tools

**Claude Code** — in the session you just opened:

```
/plugin marketplace add Engine-Room-Games/after-effects-mcp
/plugin install after-effects@engine-room
```

Restart Claude Code. This also installs guidance on using the tools well and on fixing setup problems.

**Any other MCP client** — add the server to its config. For Claude Desktop that is `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart the client.

*Alternatively:* run step 1 as `init my-video --with-mcp` and the project folder comes with this config already in it.

### 3. Connect After Effects

The tools reach After Effects through a small panel that runs inside it. Open After Effects, then ask the AI:

> Set up After Effects.

It installs the panel and enables the Adobe setting that allows it to load, then tells you to quit and reopen After Effects. Ask it to check the setup again to confirm.

Until this step is done, every tool will report that it cannot reach After Effects.

*Alternatively:* from a clone of this repository, run `npm run install:panel`.

### 4. Start working

With After Effects open and your project folder open in your client, describe what you want:

> Build a lower third that says Chapter One, sliding in from the left.

The AI reads the current state of your comp, makes the change, and can take a screenshot to check the result.

Before you get far, fill in `.claude/skills/house-style/SKILL.md` in your project folder with your colours, fonts and motion defaults — everything built afterwards follows them.

Day to day you only repeat step 4. Step 1 comes back when you start a new project.

## Projects

```bash
npx @engine-room/after-effects-mcp init my-video
```

Creates:

```
my-video/
├── .claude/skills/house-style/SKILL.md   your palette, type and timing
├── CLAUDE.md                             what this project is
└── renders/
```

`house-style/SKILL.md` holds your defaults. The AI reads it before building anything, so what it makes follows your style. Updating the tools never touches this file.

A quick way to write it: build one piece the way you want it, then ask the AI to read that comp and write it up in the house-style skill.

Keep one folder per client or series. To apply the same style everywhere instead, put the skill in `~/.claude/skills/house-style/`.

## Connecting After Effects

Asking the AI to set up After Effects runs three things:

1. `check_setup` — reports what is missing.
2. `setup_panel` — copies the panel into your Adobe CEP extensions folder and enables the setting that permits unsigned panels: a preference on macOS, a registry value on Windows.
3. A prompt to quit and reopen After Effects. The panel only loads at launch.

On macOS, if the panel still does not connect after restarting, reboot once; some builds cache that preference until a restart.

To see the panel yourself, use **Window → Extensions → AE MCP Bridge** in After Effects. It shows its status and a log.

If something stops working later, ask the AI to check the After Effects setup.

## Updating

Update the tools, then refresh the panel inside After Effects. Both are needed — the panel does not update on its own.

```
/plugin marketplace update engine-room
/plugin update after-effects@engine-room
```

Restart Claude Code. Then, with After Effects open, ask the AI:

> Update the After Effects panel.

It runs `setup_panel` again and tells you to restart After Effects. Ask it to check the setup afterwards; `check_setup` reports whether the installed panel matches the current version.

On other MCP clients, restarting the client picks up the new server version. The panel refresh is the same.

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

A few notes on the ones that behave differently from the rest:

- `get_layer_full` returns a layer's transforms with their keyframes and expressions, every effect with every parameter, masks, markers and visible bounds — in one call.
- `run_batch` runs many operations in a single pass and counts as one undo step. Long batches stream progress.
- `screenshot_frame` and `screenshot_layer` are for occasional checks, not for reviewing motion frame by frame. On large comps, `downsample: 2` renders at half resolution, which is faster and keeps the image small.
- `run_jsx` runs arbitrary ExtendScript for anything the other tools do not cover.

## Troubleshooting

Ask the AI to run `check_setup` first. It reports which part of the chain is broken and what to do about it.

| Symptom | Cause and fix |
|---|---|
| "Cannot reach the After Effects panel" | AE is not running, or the panel is not installed. Run `setup_panel`, then restart AE. |
| Tools worked before, now fail inside AE | The tools were updated but the panel was not. Run `setup_panel`, restart AE. |
| Panel never loads, setup looks correct | On macOS, reboot once. |
| A panel answers but `check_setup` reports none installed | An older install under a previous bundle id is serving. Remove it from the CEP extensions folder, run `setup_panel`, restart AE. |
| Need the panel's own log | In AE: Window → Extensions → AE MCP Bridge. |

## Platforms

macOS and Windows. Two things differ, and are handled for you:

| | macOS | Windows |
|---|---|---|
| Panel location | `~/Library/Application Support/Adobe/CEP/extensions` | `%APPDATA%\Adobe\CEP\extensions` |
| Unsigned-panel setting | `defaults` preference | `HKCU\Software\Adobe\CSXS.*` registry value |

macOS is the more exercised of the two; [issue reports](https://github.com/Engine-Room-Games/after-effects-mcp/issues) are welcome.

## Limitations

- The panel is unsigned, so loading it requires Adobe's `PlayerDebugMode`. `setup_panel` enables it. This is Adobe's documented path for unsigned extensions.
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
