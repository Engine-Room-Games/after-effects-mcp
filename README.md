# Engine Room — After Effects for AI agents

Drive Adobe After Effects by describing what you want. Comps, layers, keyframes with real easing, expressions, effects, text, shapes, masks — **60 tools**, driven by an agent that can read the project back before it changes anything.

Built for motion designers, not just developers. Setup happens through conversation; you never have to open a terminal if you don't want to.

```
"Build a lower third that says Chapter One, sliding in from the left with an easy ease,
 in my house style."
```

**Requirements:** macOS or Windows · After Effects 2026 · [Node.js 20+](https://nodejs.org)

---

## Install

### Claude Code (recommended)

```
/plugin marketplace add Engine-Room-Games/after-effects-mcp
/plugin install after-effects@engine-room
```

That installs the tools *and* the knowledge of how to use them well — two skills covering AE craft and setup troubleshooting.

### Any other MCP client

Add this to your client's MCP config (for Claude Desktop, `~/Library/Application Support/Claude/claude_desktop_config.json`):

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

## Connect After Effects

The tools talk to a small panel that runs **inside** After Effects. Installing it is a conversation, not a chore:

> **You:** Set up After Effects.

Claude runs `check_setup`, tells you what's missing, asks before it changes anything, then runs `setup_panel` — which installs the panel and switches on the Adobe setting that allows it to load (a preference on macOS, a registry value on Windows). Then:

1. **Quit and reopen After Effects.** The panel only loads at launch.
2. On macOS only: if it still doesn't connect, **reboot once**. Some macOS builds cache that Adobe preference until a restart. One time only.

Ask Claude to "check the After Effects setup" any time something stops working.

## Start a project

```bash
npx @engine-room/after-effects-mcp init my-video
```

This creates a folder built around one idea — **the plugin knows the tool, you own the taste**:

```
my-video/
├── .claude/skills/house-style/SKILL.md   ← your palette, type, timing. Edit this.
├── CLAUDE.md                             ← what this project is
└── renders/
```

Fill in `house-style/SKILL.md` with your colours, fonts and motion defaults and everything Claude builds follows them. Upgrading the plugin never touches it; your style survives tool updates, and the tool's knowledge updates without touching your style.

The fastest way to write it: build one piece the way you like it, then ask *"read this comp and write it up in my house-style skill."*

Keep a folder per client or series. Or put the file in `~/.claude/skills/house-style/` to make it your default everywhere.

> Didn't install the plugin? Run `init` with `--with-mcp` to add a project-level connection instead.

---

## What it can do

| Group | Tools |
|---|---|
| **Comps** (7) | `list_comps`, `get_comp`, `get_comp_tree`, `create_comp`, `set_comp`, `delete_comp`, `set_active_comp` |
| **Layers** (15) | `list_layers`, `get_layer_full` ⭐, `create_{text,shape,solid,null,adjustment,precomp,camera,light}_layer`, `duplicate_layer`, `delete_layer`, `set_layer`, `parent_layer`, `reorder_layer` |
| **Transforms** (1) | `set_transform` — position/scale/rotation/anchor/opacity, 2D and 3D, optionally keyframed |
| **Keyframes** (6) | `add_keyframe`, `remove_keyframe`, `get_keyframes`, `set_interpolation`, `set_temporal_ease`, `set_spatial_tangents` |
| **Expressions** (4) | `get_expression`, `set_expression`, `toggle_expression`, `clear_expression` |
| **Effects** (6) | `list_effects`, `add_effect`, `remove_effect`, `set_effect_param`, `set_effect_enabled`, `list_available_effects` |
| **Text** (2) | `set_text`, `add_text_animator` |
| **Shapes** (3) | `set_shape_path`, `add_shape_content`, `set_shape_property` |
| **Masks** (3) | `add_mask`, `set_mask`, `remove_mask` |
| **Markers** (2) | `add_marker`, `remove_marker` |
| **Vision** (2) | `screenshot_frame`, `screenshot_layer` |
| **Batch** (1) | `run_batch` — many ops, one undo step, progress streaming |
| **Explore** (2) | `get_project_summary`, `find_layers` |
| **Raw** (1) | `run_jsx` — arbitrary ExtendScript escape hatch |
| **Jobs** (3) | `await_job`, `get_job`, `cancel_job` |
| **Setup** (2) | `check_setup`, `setup_panel` |

⭐ **`get_layer_full` is the centrepiece.** One call returns a layer's transforms *with* keyframes and expressions, every effect with every parameter, masks, markers and visible bounds. Reading before writing is what separates an agent that builds what you asked for from one that guesses.

Three design decisions worth knowing about:

- **Screenshots are diagnostics, not a feedback loop.** The tool descriptions tell the agent to take two or three, never to scrub frame by frame. Pass `downsample` on large comps — a full 4K frame is big enough to exhaust an agent's context in one call. Downsampling asks AE to render at reduced resolution rather than shrinking the image afterwards, so it is also faster: `downsample: 2` renders a quarter of the pixels.
- **Bulk work is one undo step.** `run_batch` runs hundreds of operations in a single ExtendScript pass, so "undo that" does what you mean. Long batches stream progress.
- **Failures are loud.** Tools that can't do what was asked return an error naming the problem rather than reporting success — an agent can only correct a mistake it's told about.

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

The panel is the only thing that talks to AE, and it serialises calls because ExtendScript is single-threaded. The server is stateless apart from a job table. The bridge listens on localhost only and refuses outside connections.

## Troubleshooting

Ask Claude to run `check_setup` first — it reports exactly which link in the chain is broken and what to do about it.

| Symptom | Cause |
|---|---|
| "Cannot reach the After Effects panel" | AE isn't running, or the panel isn't installed. Run `setup_panel`, then restart AE. |
| Tools worked before, now error inside AE | The server was upgraded but the panel wasn't. Run `setup_panel`, restart AE. |
| Panel never loads, setup looks correct | On macOS, reboot once — the Adobe preference sometimes needs it. |
| A panel answers but `check_setup` says none is installed | An older install under a previous bundle id is serving. Remove it from the CEP extensions folder, run `setup_panel`, restart AE. |
| Want to see the panel's own log | In AE: **Window > Extensions > AE MCP Bridge**. |

## Platform support

**macOS and Windows** — the two platforms After Effects itself runs on. Linux is not possible: Adobe has never shipped After Effects for it, so there is no host to drive.

The ExtendScript layer behind all 60 tools is AE's own scripting API and is identical on both. Only three things differ, and they are handled for you:

| | macOS | Windows |
|---|---|---|
| Panel location | `~/Library/Application Support/Adobe/CEP/extensions` | `%APPDATA%\Adobe\CEP\extensions` |
| Unsigned-panel setting | `defaults` preference | `HKCU\Software\Adobe\CSXS.*` registry value |
| Reboot sometimes needed | yes | no |

macOS is the more heavily exercised of the two; Windows path handling and startup are covered by CI, but the CEP install has had less real-world use. [Issue reports](https://github.com/Engine-Room-Games/after-effects-mcp/issues) welcome.

## Limitations

- **Unsigned panel.** Loading it requires Adobe's `PlayerDebugMode`, which `setup_panel` enables. This is Adobe's documented path for unsigned extensions.
- **`saveFrameToPng` is community-known**, not officially documented by Adobe. It works, but alpha edges can be imperfect on some comps.
- **Long `run_jsx` loops freeze AE's UI**, because ExtendScript is single-threaded. Use `run_batch` for bulk work.
- **Not covered:** render queue, footage import and replacement, AE preferences. Preferences are excluded by design — this tool animates, it doesn't reconfigure your app.

## Development

```bash
git clone https://github.com/Engine-Room-Games/after-effects-mcp.git
cd after-effects-mcp
npm install && npm run build
npm run install:panel      # or: ask Claude to run setup_panel
npm run doctor             # verify the whole chain
```

| Command | Does |
|---|---|
| `npm run build` | Compile TypeScript, concatenate the ExtendScript bundle |
| `npm run build:jsx` | Rebuild only `bundle.jsx` (fast loop) |
| `npm run watch:ts` | TypeScript watch mode |
| `npm run doctor` | Diagnose the install |
| `npm run inspect` | MCP Inspector against the server |
| `npm run pack:check` | Preview the publishable tarball |

Reload ExtendScript changes without restarting AE:

```bash
curl -X POST http://127.0.0.1:7777/reload-jsx
```

**Adding a tool** takes three edits: a zod schema in `packages/shared/src/schemas.ts`, a handler in the matching `packages/jsx/*.jsx` module, and a description in `packages/mcp-server/src/tools/descriptions.ts`. Registration is automatic. See [CLAUDE.md](CLAUDE.md) for the architecture in depth, the ExtendScript conventions, and the known-fragile areas.

## License

[MIT](LICENSE)
