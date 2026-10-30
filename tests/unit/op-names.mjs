// Messages name the tool, never the internal op behind it (#243 review).
//
// Since #243 a screenshot, a run_jsx, a house-style call and every chunk of a
// long batch reach After Effects under an internal name (`_screenshot_frame`,
// `_run_jsx`, `_project_path`, `_continue_job`, …). A timeout, a dropped
// connection, a write-queue wait or a front-desk message that quoted that name
// told the agent about an op it never called. Pinned here:
//   - every internal op has a display name, and it names real tools;
//   - each message that quotes an op shows the tool for an internal one, and a
//     tool's own name unchanged.
//
//   node tests/unit/op-names.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { displayOp, INTERNAL_OP_TOOLS } = await import(dist("util", "opNames.js"));
const errors = await import(dist("util", "errors.js"));
const protocol = await import(dist("frontdesk", "protocol.js"));
const { schemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "index.js")).href);

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`op-names FAILED: ${name}`);
    throw e;
  }
}

const internal = Object.keys(schemas.InternalOpMutation);
const tools = new Set(Object.keys(schemas.OpSchemas));
const NOT_A_TOOL = new Set(["_live_probe"]);

check("every internal op has a display name made of real tool names", () => {
  for (const op of internal) {
    const shown = INTERNAL_OP_TOOLS[op];
    assert.ok(shown, `${op} has no display name in util/opNames.ts`);
    // One internal op is not behind any tool; it is named for what it does.
    if (NOT_A_TOOL.has(op)) continue;
    for (const t of shown.split("/")) assert.ok(tools.has(t), `${op} is shown as ${t}, which is not a tool`);
  }
  assert.equal(displayOp("get_comp"), "get_comp", "a tool's own name is unchanged");
  assert.equal(displayOp("__proto__"), "__proto__", "no prototype lookups");
});

/** No internal name may appear in a message; the tool must. */
function names(text, tool, op) {
  assert.ok(!text.includes("`" + op + "`") && !text.includes(op + " "), `message still names ${op}: ${text}`);
  assert.ok(text.includes(tool), `message does not name ${tool}: ${text}`);
}

check("bridge timeout and dropped connection", () => {
  names(new errors.BridgeTimeoutError(7777, 300000, { op: "_run_jsx" }).message, "`run_jsx`", "_run_jsx");
  names(new errors.BridgeResetError(7777, "_screenshot_frame").message, "`screenshot_frame`", "_screenshot_frame");
});

check("write-queue and desk waits, both sides of the wait", () => {
  names(new errors.WriteQueueWaitError("_export_mogrt", 5000, "_continue_job").message, "`run_batch`", "_continue_job");
  names(new errors.WriteQueueWaitError("_export_mogrt", 5000, "_continue_job").message, "`export_mogrt`", "_export_mogrt");
  names(new errors.DeskWaitError("_run_jsx", 5000, "_continue_job", "s").message, "`run_jsx`", "_run_jsx");
});

check("front-desk progress lines", () => {
  const wait = protocol.describeLockWait("_project_path", {
    t: "wait", position: 2, waitedMs: 3000, holder: { op: "_run_jsx", session: "other", forMs: 4000 },
  });
  names(wait, "`get_house_style/set_house_style`", "_project_path");
  names(wait, "`run_jsx`", "_run_jsx");
  const ahead = protocol.describeAhead("_screenshot_layer", [{ op: "_continue_job", session: "other", forMs: 1000 }]);
  names(ahead, "`screenshot_layer`", "_screenshot_layer");
  names(ahead, "`run_batch`", "_continue_job");
});

console.log(`op-names: ${passed} checks passed`);
