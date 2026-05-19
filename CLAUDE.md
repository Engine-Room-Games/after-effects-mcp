# Claude development guide — engine-room-ae-mcp

This file is for future Claude Code sessions working in this repo. Humans reading it: see `README.md` for the user-facing intro.

## What this project is

An MCP server that lets an LLM drive Adobe After Effects 2026: comps, layers, transforms, keyframes (with full interpolation/easing/tangent control), expressions, effects, text, shapes, masks, markers, one-off screenshots, bulk batches. ~58 tools. macOS-only for now.

## How the pieces talk

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
ExtendScript inside AE  (bundle.jsx = concat of packages/jsx/*.jsx)
        │ AE scripting API
        ▼
After Effects
```

The MCP server is stateless except for an in-memory `JobManager`. The panel is the *only* thing that talks to AE; it holds a Promise-chain mutex around `evalScript` because ExtendScript is single-threaded and concurrent calls would interleave.

## Source layout

| Path | Purpose |
|---|---|
| `packages/shared/src/schemas.ts` | **Source of truth for op contracts.** Adding an op = adding a zod schema here. |
| `packages/shared/src/ipc.ts` | HTTP envelope + WS event types. |
| `packages/jsx/*.jsx` | ExtendScript handlers. Each module attaches functions to the global `OPS` table. ES3-ish — no `let`/`const`/arrow/templates. |
| `packages/jsx/core.jsx` | JSON polyfill, `dispatch(payloadJson)` router, `withUndo()` wrapper, `JOBS` table for chunked async. |
| `packages/jsx/explore.jsx` | `get_layer_full` — the deep one-shot dump. The whole reason this MCP exists. Spend disproportionate care here. |
| `packages/jsx/batch.jsx` | `run_batch` for ≤100 ops inline; otherwise registers a job and yields chunks via `_continue_job`. |
| `packages/jsx/vision.jsx` | `saveFrameToPng` wrapper. Returns a temp path; the panel base64-encodes. |
| `packages/ae-panel/CSXS/manifest.xml` | CEP manifest. Auto-start on AE activate. Node enabled. |
| `packages/ae-panel/client/main.js` | HTTP+WS server, `evalScript` mutex, JSON envelope, job driver, PNG reader. |
| `packages/mcp-server/src/server.ts` | Tool registry, vision/async-envelope branching, error mapping. |
| `packages/mcp-server/src/tools/descriptions.ts` | All tool descriptions in one file — including the verbatim screenshot guidance. |
| `packages/mcp-server/src/bridge/{httpClient,wsClient,discovery}.ts` | Bridge plumbing. |
| `packages/mcp-server/src/jobs/manager.ts` | In-memory job table, `waitFor(jobId)` for the `await_job` tool. |
| `scripts/bundle-jsx.mjs` | Concatenates `packages/jsx/*.jsx` in dependency order into `packages/ae-panel/jsx/bundle.jsx`. Run via `npm run build:jsx`. |
| `scripts/install-panel.mjs` | Copies (or symlinks with `--symlink`) the panel into `~/Library/Application Support/Adobe/CEP/extensions/`, also copies `ws` into the destination's `node_modules`. |

## The op pipeline (in detail)

Adding a new op = touching five places. In order:

1. **Schema** — `packages/shared/src/schemas.ts`: add zod schema and an entry in `OpSchemas`.
2. **ExtendScript handler** — add to the matching module in `packages/jsx/` as `OPS.your_op = function(args){ ... }`. Use `noUndo(fn)` for read-only ops (skips the undo group wrapper).
3. **Description** — `packages/mcp-server/src/tools/descriptions.ts`: add an entry keyed by op name. Write it for an LLM agent reading the tool list cold.
4. **Build** — `npm run build` rebuilds TS and concatenates the .jsx bundle.
5. **Reload in AE** (optional, dev only) — `curl -X POST http://127.0.0.1:7777/reload-jsx` re-`$.evalFile`s the bundle without restarting AE.

The `server.ts` tool registration loop reads `OpSchemas`, so no MCP-side wiring is needed unless the op needs special return packaging (vision = image content, run_batch = async envelope, jobs/* = server-resident).

## Special return shapes

- **Vision** (`screenshot_frame`, `screenshot_layer`): JSX returns `{path, width, height, time, compId, layerId?}`. Panel reads the PNG, base64-encodes, returns `{base64, bytes, ...}`. Server packages as MCP `image` content block.
- **Long batch** (`run_batch` >100 ops): JSX returns `{jobId, async:true, total}`. Panel drives `_continue_job` in chunks of 25 in the background, broadcasting `progress` events on WS. Server forwards WS progress as `notifications/progress` keyed by the request's `progressToken`.
- **Server-resident** (`await_job`, `get_job`, `cancel_job`): handled in `server.ts`; never forwarded to the panel (except `cancel_job`, which also sends `_cancel_job` to the bridge to set the JSX-side flag).

## Conventions

- **ExtendScript is ES3-ish.** No `let`/`const`/arrow functions/template literals/`Object.keys`/destructuring in `packages/jsx/*.jsx`. AE 2026 has native JSON but `core.jsx` polyfills defensively.
- **Stable IDs.** `getCompById(id)` uses `app.project.itemByID`; `getLayerById(comp, layerId)` walks `comp.layers` matching `layer.id`. Never use `.index` as a long-lived identifier — it shifts when layers are reordered.
- **One undo step per request.** `dispatch()` wraps the handler in `app.beginUndoGroup`/`endUndoGroup`. Long batches manage their own undo manually (`run_batch.__meta.noUndo = true`).
- **MCP server stdout is sacred.** All logs go to stderr via `util/logger.ts`. Touching `console.log` anywhere in mcp-server will corrupt the JSON-RPC stream.
- **Tool descriptions are written for LLMs.** Tell the agent (a) what the tool does, (b) when to reach for it, (c) what to avoid. Screenshot descriptions especially must say "one-off, do NOT screenshot every frame."

## Build + run

```bash
npm install                 # workspaces hoist deps to root node_modules
npm run build               # tsc shared + mcp-server, concatenate jsx bundle
npm run build:jsx           # only rebuild bundle.jsx (fast iteration)
npm run watch:ts            # tsc --watch for mcp-server
npm run doctor              # sanity checks (debug mode, install, port, AE running)
npm run inspect             # MCP Inspector UI against the server
```

## Verification recipes (run by hand against a live AE 2026)

1. `list_comps` → JSON array, empty `[]` on fresh project.
2. `create_comp({name:"t", width:1920, height:1080, frameRate:30, duration:5})` → returns id.
3. `create_text_layer({compId, text:"hi"})`, then `add_keyframe` at t=0 left and t=2 right, then `screenshot_frame` at t=0/1/2 to confirm motion visually.
4. `add_effect({compId, layerId, matchName:"ADBE Gaussian Blur 2"})`, `set_effect_param({...paramName:"Blurriness", value:25})`.
5. `set_expression({propertyPath:["Effects","Gaussian Blur","Blurriness"], expression:"time*10"})`, then `get_layer_full` echoes the expression.
6. `run_batch` with 50 `create_solid_layer` ops, `transactional:true` → single undo step.
7. `run_batch` with 500 ops → returns `{jobId}`. With `progressToken` set, `notifications/progress` fire ~20/sec. Without it, `await_job(jobId)` resolves with the final result.
8. `run_jsx("app.project.activeItem.name")` → comp name. With deliberate error → structured `AeError` with line number.

## Known fragile areas

- `saveFrameToPng` is community-known, not officially documented. Alpha edge cases reported on some comps. If it fails, fallback would be the render queue with PNG Sequence template (slow; deferred to v1.1).
- ExtendScript single-threading: `run_jsx` with a long synchronous loop will freeze AE's UI. Document for the agent in the tool description (already done).
- CEP manifest's `<AutoVisible>false</AutoVisible>` was unreliable in early CEP 12 builds. Current manifest uses `AutoVisible=true` with a small geometry — the panel still auto-loads invisibly enough; the user can dock the small status panel out of the way.
- CEP panels installed without signing require `PlayerDebugMode=1`. The user does this once via `npm run enable:debug` and a reboot.

## Out of scope (v1)

- Render queue (queue + render + progress + cancel).
- Footage / asset import & replace.
- AE preferences / settings changes (excluded by design — animation only).
- Windows support (`install-panel.mjs` is mac-only; CEP layout differs on Windows).
