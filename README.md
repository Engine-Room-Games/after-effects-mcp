# after-effects-mcp

An MCP server for Adobe After Effects. It gives an AI agent 60 tools covering comps, layers, transforms, keyframes, expressions, effects, text, shapes, masks and markers, plus screenshots for visual checks.

Requires macOS or Windows, After Effects 2026, and [Node.js 20+](https://nodejs.org).

## Install

For Claude Code:

```
/plugin marketplace add Engine-Room-Games/after-effects-mcp
/plugin install after-effects@engine-room
```

This installs the tools along with two skills: one on using the tools well, one on fixing setup problems.

For any other MCP client, add the server to its config. For Claude Desktop that is `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Connect After Effects

The tools reach After Effects through a small panel that runs inside it. To install the panel, ask the agent to set up After Effects. It will run `check_setup`, report what is missing, and run `setup_panel` to install the panel and enable the Adobe setting that permits unsigned panels — a preference on macOS, a registry value on Windows.

Then quit and reopen After Effects; the panel only loads at launch. On macOS, if it still does not connect, reboot once — some builds cache that preference until a restart.

If something stops working later, ask the agent to check the After Effects setup.

## Start a project

```bash
npx @engine-room/after-effects-mcp init my-video
```

This creates:

```
my-video/
├── .claude/skills/house-style/SKILL.md   your palette, type and timing
├── CLAUDE.md                             what this project is
└── renders/
```

`house-style/SKILL.md` holds your defaults — colours, fonts, motion. The agent reads it before building anything, so what it makes follows your style. Updating the plugin never touches this file.

A quick way to write it: build one piece the way you want it, then ask the agent to read that comp and write it up in the house-style skill.

Keep one folder per client or series, or put the skill in `~/.claude/skills/house-style/` to apply it everywhere.

If you did not install the plugin, run `init` with `--with-mcp` to add a project-level server config as well.

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

`get_layer_full` returns a layer's transforms with their keyframes and expressions, every effect with every parameter, masks, markers and visible bounds — in one call. It is the tool to reach for before changing anything.

Three behaviours worth knowing:

- **Screenshots are diagnostics, not a feedback loop.** The tool descriptions instruct the agent to take two or three, never to scrub frame by frame. On large comps, `downsample` makes After Effects render at reduced resolution rather than shrinking the image afterwards, so it is also faster — `downsample: 2` renders a quarter of the pixels.
- **Bulk work is one undo step.** `run_batch` runs many operations in a single ExtendScript pass, so undo behaves the way you expect. Long batches stream progress.
- **Failures are loud.** A tool that cannot do what was asked returns an error naming the problem instead of reporting success, because an agent can only correct a mistake it is told about.

## How it works

```
Claude / MCP client
        │  stdio (JSON-RPC)
        ▼
  MCP server (Node)
        │  HTTP + WebSocket on 127.0.0.1
        ▼
  CEP panel inside After Effects
        │  evalScript
        ▼
  ExtendScript → After Effects
```

The panel is the only component that talks to After Effects, and it serialises calls because ExtendScript is single-threaded. The server holds no state beyond a job table. The bridge listens on localhost and refuses outside connections.

## Troubleshooting

Ask the agent to run `check_setup` first. It reports which link in the chain is broken and what to do about it.

| Symptom | Cause and fix |
|---|---|
| "Cannot reach the After Effects panel" | AE is not running, or the panel is not installed. Run `setup_panel`, then restart AE. |
| Tools worked before, now fail inside AE | The server was updated but the panel was not. Run `setup_panel`, restart AE. |
| Panel never loads, setup looks correct | On macOS, reboot once. |
| A panel answers but `check_setup` reports none installed | An older install under a previous bundle id is serving. Remove it from the CEP extensions folder, run `setup_panel`, restart AE. |
| Need the panel's own log | In AE: Window → Extensions → AE MCP Bridge. |

## Platforms

macOS and Windows, the two platforms After Effects runs on. Linux is not possible — Adobe has never shipped After Effects for it.

The ExtendScript layer behind all 60 tools is After Effects' own scripting API and is identical on both. Three things differ, and are handled for you:

| | macOS | Windows |
|---|---|---|
| Panel location | `~/Library/Application Support/Adobe/CEP/extensions` | `%APPDATA%\Adobe\CEP\extensions` |
| Unsigned-panel setting | `defaults` preference | `HKCU\Software\Adobe\CSXS.*` registry value |
| Reboot sometimes needed | yes | no |

macOS is the more exercised of the two. Windows path handling and startup are covered by CI, but the panel install itself has had less real-world use; [issue reports](https://github.com/Engine-Room-Games/after-effects-mcp/issues) are welcome.

## Limitations

- The panel is unsigned, so loading it requires Adobe's `PlayerDebugMode`. `setup_panel` enables it. This is Adobe's documented path for unsigned extensions.
- `saveFrameToPng` is community-known rather than officially documented. It works, but alpha edges can be imperfect on some comps.
- A long synchronous loop in `run_jsx` will freeze the After Effects UI, since ExtendScript is single-threaded. Use `run_batch` for bulk work.
- Not covered: the render queue, footage import and replacement, and application preferences. Preferences are excluded deliberately — this tool animates, it does not reconfigure your app.

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
| `npm run build` | Compile TypeScript and concatenate the ExtendScript bundle |
| `npm run build:jsx` | Rebuild `bundle.jsx` only |
| `npm run watch:ts` | TypeScript watch mode |
| `npm run doctor` | Diagnose the install |
| `npm run inspect` | MCP Inspector against the server |
| `npm run pack:check` | Preview the publishable tarball |

Reload ExtendScript changes without restarting After Effects:

```bash
curl -X POST http://127.0.0.1:7777/reload-jsx
```

Adding a tool takes three edits: a zod schema in `packages/shared/src/schemas.ts`, a handler in the matching `packages/jsx/*.jsx` module, and a description in `packages/mcp-server/src/tools/descriptions.ts`. Registration is automatic.

See [CLAUDE.md](CLAUDE.md) for the architecture, the ExtendScript conventions, and the known-fragile areas.

## License

[MIT](LICENSE)
