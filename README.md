# engine-room-ae-mcp

A high-fidelity Model Context Protocol (MCP) server for **Adobe After Effects 2026**. Built to let an LLM agent do *anything* animation-related in AE: comps, layers, transforms, keyframes (with interpolation/easing/tangents), expressions, effects, text, shapes, masks, markers, one-off screenshots, and bulk batched ops with live progress notifications. **58 tools**.

## Highlights

- **CEP panel + HTTP/WebSocket bridge.** A panel inside AE runs a local server on `127.0.0.1:7777`; the MCP server connects out. No file polling.
- **Deep one-shot reads.** `get_layer_full` / `get_comp_tree` / `list_effects` return the entire object in one call — transform values + keyframes + expressions + effects with full param introspection + masks + markers + content-specific extras.
- **Vision.** `screenshot_frame` / `screenshot_layer` use `CompItem.saveFrameToPng` and return base64 PNG as MCP image content. Tool descriptions explicitly tell the agent these are **one-off diagnostic snapshots — never per-frame, never in a loop.**
- **Bulk.** `run_batch` runs many ops in a single ExtendScript pass under one undo step. Batches over 100 ops auto-chunk and stream progress.
- **Progress + completion signal.** Long jobs return a `jobId` immediately and stream `notifications/progress` over the WebSocket. A blocking `await_job(jobId)` tool exists for clients that don't render notifications.

## Architecture

```
Claude / MCP client
        │ stdio (JSON-RPC)
        ▼
packages/mcp-server (Node/TS)
        │ HTTP POST /op  +  WS /events
        ▼  (127.0.0.1:7777)
packages/ae-panel (CEP extension, installed into AE)
        │ CSInterface.evalScript
        ▼
ExtendScript inside AE
        │ AE scripting API
        ▼
After Effects 2026
```

A monorepo with npm workspaces:

- **`packages/shared/`** — zod schemas + IPC types, single source of truth for all 58 ops.
- **`packages/jsx/`** — 16 ExtendScript modules concatenated at build time into one `bundle.jsx`.
- **`packages/ae-panel/`** — CEP extension. Auto-starts on AE launch; runs an HTTP+WS server; serializes `evalScript` calls (ExtendScript is single-threaded).
- **`packages/mcp-server/`** — TypeScript stdio MCP server. Registers ~58 tools, maps bridge errors to friendly install instructions, forwards WS progress events to MCP progress notifications.

## One-time setup (macOS)

```bash
git clone <this-repo> && cd engine-room-ae-mcp
npm install
npm run build
```

Then enable CEP's debug mode (lets AE load unsigned panels like this one):

```bash
npm run enable:debug
# reboot the Mac so AE picks up the change
```

Install the panel into AE:

```bash
npm run install:panel
```

This copies `packages/ae-panel/` into `~/Library/Application Support/Adobe/CEP/extensions/games.engine-room.ae-mcp/` and also copies the `ws` Node module the panel needs at runtime. (Use `npm run install:panel -- --symlink` if you want live edits to flow through without re-running install.)

Launch After Effects 2026. The "AE MCP Bridge" panel auto-loads. Verify everything's green:

```bash
npm run doctor
```

## Configure your MCP client

**Claude Desktop / Claude Code** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (or the equivalent for your client):

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/engine-room-ae-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Restart your MCP client. Try: *"List all comps in After Effects."*

If AE isn't running or the panel isn't installed, every tool call returns a structured error containing the exact remediation steps — so the agent can relay them to you verbatim.

## Tool inventory (58)

| Group | Tools |
|---|---|
| **Comps** (7) | `list_comps`, `get_comp`, `get_comp_tree`, `create_comp`, `set_comp`, `delete_comp`, `set_active_comp` |
| **Layers** (14) | `list_layers`, `get_layer_full` ⭐, `create_{text,shape,solid,null,adjustment,precomp,camera,light}_layer`, `duplicate_layer`, `delete_layer`, `set_layer`, `parent_layer`, `reorder_layer` |
| **Transforms** (1) | `set_transform` (position/scale/rotation/anchor/opacity + 3D variants, with optional keyframe) |
| **Keyframes** (6) | `add_keyframe`, `remove_keyframe`, `get_keyframes`, `set_interpolation`, `set_temporal_ease`, `set_spatial_tangents` |
| **Expressions** (4) | `get_expression`, `set_expression`, `toggle_expression`, `clear_expression` |
| **Effects** (6) | `list_effects`, `add_effect`, `remove_effect`, `set_effect_param`, `set_effect_enabled`, `list_available_effects` |
| **Text** (2) | `set_text` (font/size/colors/tracking/leading/etc.), `add_text_animator` |
| **Shapes** (3) | `set_shape_path`, `add_shape_content`, `set_shape_property` |
| **Masks** (3) | `add_mask`, `set_mask`, `remove_mask` |
| **Markers** (2) | `add_marker`, `remove_marker` |
| **Vision** (2) | `screenshot_frame` ⚠️ one-off, `screenshot_layer` ⚠️ one-off |
| **Batch** (1) | `run_batch` — many ops, one undo, progress for >100 ops |
| **Explore** (2) | `get_project_summary`, `find_layers` |
| **Raw** (1) | `run_jsx` — escape hatch |
| **Jobs** (3) | `await_job`, `get_job`, `cancel_job` |

⭐ = the centerpiece — returns the entire layer in one call. Use it instead of multiple narrow queries.
⚠️ = explicitly described as one-off; agents are told not to screenshot every frame or scrub through time.

## Development

```bash
npm run build         # tsc shared + mcp-server, concat .jsx bundle
npm run build:jsx     # only rebuild bundle.jsx (fast)
npm run watch:ts      # tsc --watch for mcp-server during dev
npm run inspect       # open MCP Inspector against the server
npm run doctor        # diagnostics
```

While AE is open with the panel running, reload .jsx changes without restarting AE:

```bash
curl -X POST http://127.0.0.1:7777/reload-jsx
```

### Adding a new op

Five touchpoints, in order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and entry in `OpSchemas`.
2. **JSX handler** — relevant module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`.
3. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: tell the LLM what it does, when to reach for it, what to avoid.
4. `npm run build`.
5. `curl -X POST http://127.0.0.1:7777/reload-jsx` (or restart AE).

No MCP-side wiring required for typical ops — `server.ts` registers everything in `OpSchemas` automatically.

## Verification recipes

Run these against a live AE 2026 with the panel installed:

1. `list_comps` → JSON array.
2. `create_comp({name:"t", width:1920, height:1080, frameRate:30, duration:5})` → returns id.
3. `create_text_layer({compId, text:"hi"})` → returns layerId.
4. Two `add_keyframe`s on `["Transform","Position"]` at t=0 left and t=2 right. `screenshot_frame` at t=0/1/2 — confirms motion.
5. `add_effect({compId, layerId, matchName:"ADBE Gaussian Blur 2"})`, `set_effect_param({...paramName:"Blurriness", value:25})`. `screenshot_frame` shows blur.
6. `set_expression({propertyPath:["Effects","Gaussian Blur","Blurriness"], expression:"time*10"})`. `get_layer_full` echoes the expression in the dump.
7. `run_batch` with 50 `create_solid_layer` ops, `transactional:true` → single undo step, completes in seconds.
8. `run_batch` with 500 ops + a `progressToken` → progress notifications stream during the run. Without `progressToken`, `await_job(jobId)` resolves with the final result.
9. `run_jsx("return app.project.activeItem.name")` → comp name. A deliberate error returns a structured AE error with line number.

## Known caveats

- **macOS only.** `install-panel.mjs` and `enable-debug.mjs` are mac-specific. Windows requires manual CEP setup via regedit and a different extension path.
- **`saveFrameToPng` is community-known**, not officially documented by Adobe. It works on AE 2026 but alpha-channel edges can have artifacts on some comps. A render-queue PNG fallback is planned for v1.1.
- **ExtendScript is single-threaded.** Calls are serialized by the panel via a Promise-chain mutex. `run_jsx` with a long synchronous loop *will* freeze AE's UI — `run_batch` chunks better for the same reason.
- **Layer `.id` is stable per-project but not across copy-paste.** Always treat `(compId, layerId)` as the canonical pair. Layer `.index` is 1-based and shifts on reorder — never store it.
- **PlayerDebugMode requires a reboot** to take effect on some macOS builds. If `npm run doctor` says CEP debug is on but AE still won't load the panel, reboot once.
- **Unsigned panel.** This is a local-only developer tool; we don't ship an Adobe-signed package. PlayerDebugMode is the documented Adobe path for that.
- **CEP, not UXP.** Adobe has been promising UXP for AE for years; it isn't production-ready in AE 2026. Will migrate when Adobe ships it.
- **The panel runs an HTTP server bound to 127.0.0.1.** It refuses non-localhost connections. If port 7777 is in use, it scans 7778–7799 and writes the chosen port to `~/.engineroom-ae-mcp/port` for the MCP server to discover.

## Out of scope (v1)

- Render queue (queue + render + progress + cancel) — v1.1.
- Footage / asset import & replace — v1.1.
- AE preferences / settings changes — explicitly excluded by design (animation only).
- Windows support.

## License

MIT.
