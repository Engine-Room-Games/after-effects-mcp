// Read-only mode and the run_jsx switch (issue #135).
//
// Every property here fails silently when it breaks. A write op that slips
// into the read-only list is a tool the user turned off and the model can
// still call; a switch that is listed-off but callable is a refusal that never
// happens; a `run_jsx` step inside `run_batch` is `run_jsx` by another door.
// None of it needs After Effects — it is all server-side TypeScript, driven
// through the real MCP server against a stub bridge.
//
//   node tests/unit/tool-policy.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const policyMod = await import(dist("tools", "policy.js"));
const {
  DEFAULT_POLICY, READ_ONLY_SERVER_OPS, parseSwitch, policyFromEnv, disabledOps, enabledOps,
  refusedBatchSteps, policyNotice, MAX_BATCH_DEPTH,
} = policyMod;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));
const { findUnsafeArgKeys } = await import(dist("util", "argsSafety.js"));
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const { SERVER_INSTRUCTIONS } = await import(dist("generated", "content.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    e.message = `${name}: ${e.message}`;
    throw e;
  }
  passed++;
}

const ALL = Object.keys(OpSchemas);
const READ_ONLY = { readOnly: true, runJsx: true };
const NO_JSX = { readOnly: false, runJsx: false };
const BOTH = { readOnly: true, runJsx: false };

// ---------------------------------------------------------------------------
// The switches as the environment spells them.
// ---------------------------------------------------------------------------

await check("off spellings are off, on spellings are on", () => {
  for (const v of [undefined, "", "0", "false", "FALSE", "no", "off", " 0 "]) {
    assert.equal(parseSwitch("X", v), false, JSON.stringify(v));
  }
  for (const v of ["1", "true", "True", "yes", "on"]) {
    assert.equal(parseSwitch("X", v), true, JSON.stringify(v));
  }
});

await check("an unrecognised value fails closed — it is a safety switch", () => {
  assert.equal(parseSwitch("X", "enabled"), true);
});

await check("an unexpanded ${user_config…} placeholder is off, not on", () => {
  // Failing closed here would put every Claude Desktop install into read-only
  // mode the day a client stopped substituting.
  assert.equal(parseSwitch("X", "${user_config.read_only}"), false);
  assert.equal(parseSwitch("X", "${user_config.disable_run_jsx}"), false);
});

await check("any other ${…} is a value somebody wrote, and fails closed", () => {
  // Only the form the .mcpb writes is excused. `${READ_ONLY}` from a shell
  // config that did not expand is a person's setting, and may well mean on.
  for (const v of ["${READ_ONLY}", "${env:AE_MCP_READ_ONLY}", "${user_config}", "${}"]) {
    assert.equal(parseSwitch("X", v), true, v);
  }
});

await check("policyFromEnv reads both variables", () => {
  assert.deepEqual(policyFromEnv({}), DEFAULT_POLICY);
  assert.deepEqual(policyFromEnv({ AE_MCP_READ_ONLY: "1" }), READ_ONLY);
  assert.deepEqual(policyFromEnv({ AE_MCP_DISABLE_RUN_JSX: "true" }), NO_JSX);
  assert.deepEqual(policyFromEnv({ AE_MCP_READ_ONLY: "true", AE_MCP_DISABLE_RUN_JSX: "true" }), BOTH);
  assert.deepEqual(
    policyFromEnv({ AE_MCP_READ_ONLY: "false", AE_MCP_DISABLE_RUN_JSX: "false" }),
    DEFAULT_POLICY,
    "what the .mcpb passes when both boxes are unticked"
  );
});

// ---------------------------------------------------------------------------
// The filtered lists, computed.
// ---------------------------------------------------------------------------

await check("the default policy offers every op and switches nothing off", () => {
  assert.deepEqual(enabledOps(DEFAULT_POLICY), ALL);
  assert.equal(disabledOps(DEFAULT_POLICY).size, 0);
  assert.equal(policyNotice(DEFAULT_POLICY), null);
});

await check("read-only offers no op classified write", () => {
  const on = enabledOps(READ_ONLY);
  const writes = on.filter((n) => OpMutation[n] === "write");
  assert.deepEqual(writes, [], `write ops offered in read-only mode: ${writes.join(", ")}`);
  // …and every read is still there: read-only must not cost a single look.
  const reads = ALL.filter((n) => OpMutation[n] === "read");
  for (const r of reads) assert.ok(on.includes(r), `${r} is a read and was switched off`);
});

await check("read-only keeps exactly the server ops decided `keep`", () => {
  const on = new Set(enabledOps(READ_ONLY));
  const serverOps = ALL.filter((n) => OpMutation[n] === "server");
  const kept = serverOps.filter((n) => on.has(n)).sort();
  assert.deepEqual(kept, ["ae_guide", "check_setup", "list_known_issues"]);
  for (const gone of ["setup_panel", "init_project", "log_issue", "mark_issue_reported", "archive_issue", "await_job", "get_job", "cancel_job"]) {
    assert.ok(!on.has(gone), `${gone} writes or starts something and is still offered`);
  }
});

await check("every server op has a read-only decision, and nothing else does", () => {
  const serverOps = ALL.filter((n) => OpMutation[n] === "server").sort();
  assert.deepEqual(Object.keys(READ_ONLY_SERVER_OPS).sort(), serverOps);
});

await check("the specific reads a read-only session is for are all present", () => {
  const on = new Set(enabledOps(READ_ONLY));
  for (const op of ["get_project_summary", "list_comps", "list_layers", "get_layer_full", "find_layers",
    "get_keyframes", "get_expression", "list_effects", "screenshot_frame", "screenshot_layer",
    "snapshot_comp", "diff_comp", "get_house_style"]) {
    assert.ok(on.has(op), op);
  }
});

await check("disabling run_jsx removes run_jsx and nothing else", () => {
  assert.deepEqual(enabledOps(NO_JSX), ALL.filter((n) => n !== "run_jsx"));
  assert.ok(policyNotice(NO_JSX).includes("run_jsx"));
});

await check("both switches together are read-only (run_jsx is already a write)", () => {
  assert.deepEqual(enabledOps(BOTH), enabledOps(READ_ONLY));
});

await check("a batch step naming a switched-off op is caught, with its path", () => {
  const steps = [{ op: "set_layer" }, { op: "run_jsx" }, { op: "add_keyframe" }, { op: "run_jsx" }];
  assert.deepEqual(refusedBatchSteps(steps, DEFAULT_POLICY), []);
  assert.deepEqual(refusedBatchSteps(steps, NO_JSX).map((r) => `${r.op}@${r.path}`), ["run_jsx@ops[1]", "run_jsx@ops[3]"]);
});

// batch.jsx runs a run_batch step like any other op, and the inner batch's
// steps go to OPS[...] by name — so run_jsx two batches down is run_jsx.
const nest = (depth, leaf) => {
  let step = leaf;
  for (let i = 0; i < depth; i++) step = { op: "run_batch", args: { ops: [{ op: "set_layer", args: { compId: 1, layerId: 1, name: "x" } }, step] } };
  return step;
};
const JSX_LEAF = { op: "run_jsx", args: { code: "return 1" } };

await check("a run_jsx step inside a nested run_batch is caught", () => {
  const refused = refusedBatchSteps([nest(1, JSX_LEAF)], NO_JSX);
  assert.deepEqual(refused.map((r) => r.path), ["ops[0].args.ops[1]"]);
  assert.equal(refused[0].op, "run_jsx");
});

await check("a run_jsx step several batches deep is caught, up to the depth bound", () => {
  const refused = refusedBatchSteps([nest(5, JSX_LEAF)], NO_JSX);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].op, "run_jsx");
  assert.equal(refused[0].path.split("args.ops").length - 1, 5);
});

await check("a batch nested past the bound is refused, not trusted", () => {
  const refused = refusedBatchSteps([nest(MAX_BATCH_DEPTH + 3, { op: "set_layer" })], NO_JSX);
  assert.equal(refused.length, 1);
  assert.match(refused[0].reason, /nested more than/);
});

await check("a nested ops that is not an array is refused (ExtendScript iterates array-likes)", () => {
  const sneaky = { op: "run_batch", args: { ops: { 0: JSX_LEAF, length: 1 } } };
  const refused = refusedBatchSteps([sneaky], NO_JSX);
  assert.equal(refused.length, 1);
  assert.match(refused[0].reason, /not an array/);
});

await check("a batch that refers to itself terminates and is refused", () => {
  const ops = [];
  ops.push({ op: "run_batch", args: { ops } });
  const refused = refusedBatchSteps(ops, NO_JSX);
  assert.ok(refused.some((r) => /refers to itself/.test(r.reason)));
});

await check("a clean nested batch passes", () => {
  assert.deepEqual(refusedBatchSteps([nest(3, { op: "add_keyframe" })], NO_JSX), []);
});

// ---------------------------------------------------------------------------
// The same lists through tools/list and tools/call on the real server.
// ---------------------------------------------------------------------------

const seen = [];
const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op } = JSON.parse(body || "{}");
    seen.push(op);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { ok: true, op } }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function connect(policy) {
  const server = createServer(policy ? { policy } : {});
  const client = new Client({ name: "tool-policy-test", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const clients = {
  default: await connect(undefined),
  readOnly: await connect(READ_ONLY),
  noJsx: await connect(NO_JSX),
};
const listed = async (client) => (await client.listTools()).tools.map((t) => t.name);

await check("tools/list: default lists all 84 ops", async () => {
  assert.deepEqual(await listed(clients.default), ALL);
  assert.equal(ALL.length, 84, "the op count moved — update this and the README's tool count together");
});

await check("tools/list: read-only lists exactly enabledOps, and no write", async () => {
  const names = await listed(clients.readOnly);
  assert.deepEqual(names, enabledOps(READ_ONLY));
  assert.ok(names.every((n) => OpMutation[n] !== "write"));
  assert.equal(names.length, ALL.filter((n) => OpMutation[n] === "read").length + 3);
});

// Checkpoints (#136): taking, reverting and deleting one changes the project,
// so read-only mode must drop them; listing them only reads item comments.
await check("read-only keeps list_checkpoints and drops the three checkpoint writes", async () => {
  const names = await listed(clients.readOnly);
  assert.ok(names.includes("list_checkpoints"));
  for (const op of ["checkpoint_comp", "revert_comp", "delete_checkpoints"]) {
    assert.equal(OpMutation[op], "write", op);
    assert.ok(!names.includes(op), `${op} is offered in read-only mode`);
    assert.ok(disabledOps(READ_ONLY).has(op), `${op} is not refused in read-only mode`);
  }
});

await check("tools/list: run_jsx off lists 83, without run_jsx", async () => {
  const names = await listed(clients.noJsx);
  assert.equal(names.length, ALL.length - 1);
  assert.ok(!names.includes("run_jsx"));
});

await check("instructions are untouched by default and carry the notice otherwise", async () => {
  assert.equal(clients.default.getInstructions(), SERVER_INSTRUCTIONS);
  assert.ok(clients.readOnly.getInstructions().startsWith("**This server is in read-only mode.**"));
  assert.ok(clients.readOnly.getInstructions().endsWith(SERVER_INSTRUCTIONS));
  assert.ok(clients.noJsx.getInstructions().startsWith("**`run_jsx` is switched off"));
});

await check("ae_guide carries the notice when a switch is on, and only then", async () => {
  const text = async (c) => (await c.callTool({ name: "ae_guide", arguments: { topic: "extendscript-gotchas" } })).content[0].text;
  assert.ok(!(await text(clients.default)).includes("switched off on this server"));
  assert.ok((await text(clients.noJsx)).startsWith("**`run_jsx` is switched off"));
});

await check("calling a switched-off tool is refused before the bridge", async () => {
  seen.length = 0;
  const res = await clients.readOnly.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, name: "x" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /set_layer is not available: the server is in read-only mode/);
  assert.match(res.content[0].text, /Nothing was run/);
  const jsx = await clients.noJsx.callTool({ name: "run_jsx", arguments: { code: "return 1" } });
  assert.equal(jsx.isError, true);
  assert.match(jsx.content[0].text, /AE_MCP_DISABLE_RUN_JSX/);
  const setup = await clients.readOnly.callTool({ name: "setup_panel", arguments: {} });
  assert.equal(setup.isError, true, "setup_panel installs files; read-only must refuse it");
  assert.deepEqual(seen, [], "a switched-off tool reached the bridge");
});

await check("run_batch refuses a run_jsx step whole, naming it, and sends nothing", async () => {
  seen.length = 0;
  const res = await clients.noJsx.callTool({
    name: "run_batch",
    arguments: { ops: [{ op: "set_layer", args: { compId: 1, layerId: 1, name: "x" } }, { op: "run_jsx", args: { code: "return 1" } }] },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ops\[1\] \(run_jsx\)/);
  assert.match(res.content[0].text, /nothing in the batch was run/i);
  assert.deepEqual(seen, []);
});

await check("run_batch refuses run_jsx hidden in a nested batch, and sends nothing", async () => {
  // The shape of the payload a stdio run got past the first version of this check.
  seen.length = 0;
  for (const depth of [1, 4]) {
    const res = await clients.noJsx.callTool({ name: "run_batch", arguments: { ops: [nest(depth, JSX_LEAF)] } });
    assert.equal(res.isError, true, `depth ${depth} was not refused`);
    assert.match(res.content[0].text, /\(run_jsx\)/);
  }
  assert.deepEqual(seen, [], "a nested run_jsx reached the bridge");
});

// A `__proto__` key is an own key in JSON and on this side of the bridge, but
// may become a prototype once ExtendScript parses the payload — and then an
// `ops` hidden behind it is invisible to a walk that reads own keys. Built with
// JSON.parse on purpose: written as an object literal here, `__proto__` would
// set this test's own prototype and the key would never reach the wire.
const protoPayload = (key) =>
  JSON.parse(
    `{"ops":[{"op":"run_batch","args":{"${key}":{"ops":[{"op":"run_jsx","args":{"code":"return 1"}}]}}}]}`
  );

await check("run_batch with run_jsx behind a __proto__ key is refused before the bridge", async () => {
  seen.length = 0;
  const args = protoPayload("__proto__");
  assert.ok(Object.keys(args.ops[0].args).includes("__proto__"), "the fixture must carry an own __proto__ key");
  const res = await clients.noJsx.callTool({ name: "run_batch", arguments: args });
  assert.equal(res.isError, true, "a __proto__-hidden run_jsx step was accepted");
  assert.match(res.content[0].text, /ops\[0\]\.args\.__proto__ — the key "__proto__" is not allowed/);
  assert.deepEqual(seen, [], "a __proto__ payload reached the bridge");
});

await check("__proto__, constructor and prototype are refused in every op's args, in every mode", async () => {
  seen.length = 0;
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const res = await clients.default.callTool({ name: "run_batch", arguments: protoPayload(key) });
    assert.equal(res.isError, true, `${key} was forwarded`);
    // Not only run_batch: the check runs on the raw args of every op, before
    // the schema sees them, so any free-form field a schema declares later is
    // covered without a test of its own.
    const shape = await clients.default.callTool({
      name: "create_shape_layer",
      arguments: JSON.parse(`{"compId":1,"name":"x","nested":[{"type":"rect","${key}":{"x":1}}]}`),
    });
    assert.equal(shape.isError, true, `${key} in create_shape_layer args was forwarded`);
    assert.match(shape.content[0].text, new RegExp(`the key "${key}" is not allowed`));
  }
  assert.deepEqual(seen, []);
});

await check("ordinary keys and values that merely contain those words still pass", async () => {
  seen.length = 0;
  assert.deepEqual(findUnsafeArgKeys({ shapes: [{ constructorName: "a", prototypes: 1, __proto__x: 2 }] }), []);
  const res = await clients.default.callTool({
    name: "create_shape_layer",
    arguments: { compId: 1, name: "__proto__ in a value is fine" },
  });
  assert.equal(res.isError, undefined);
  assert.deepEqual(seen, ["create_shape_layer"]);
});

await check("what is still offered still works", async () => {
  seen.length = 0;
  const ro = await clients.readOnly.callTool({ name: "list_comps", arguments: {} });
  assert.equal(ro.isError, undefined);
  const batch = await clients.noJsx.callTool({ name: "run_batch", arguments: { ops: [{ op: "set_layer", args: { compId: 1, layerId: 1, name: "x" } }] } });
  assert.equal(batch.isError, undefined);
  assert.deepEqual(seen, ["list_comps", "run_batch"]);
});

// Issue #161: the switch's user-facing description once said the render queue
// stops working without run_jsx. It does not — the render tools are their own
// ops — and a description that names a tool the switch keeps sends the user
// to the wrong switch. Pin both the fact and the two places that state it.
// The sentence must say rendering survives, and must not say it stops. Any
// mention of rendering in it is read as a claim and has to be the positive one.
function assertRenderingKept(text, where) {
  assert.match(text, /rendering included/i, `${where} no longer says rendering keeps working`);
  const negative = /render(ing| queue)?[^.|]*\b(impossible|unavailable|stops?|break|breaks|broken|disabled|lost|no longer|cannot|can't|won't)\b|\b(impossible|unavailable|cannot|can't|no longer|lose|lost)\b[^.|]*render/i;
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    const stripped = sentence.replace(/rendering included/gi, "");
    if (/render/i.test(stripped)) {
      assert.fail(`${where} mentions rendering outside the "rendering included" claim: ${sentence}`);
    }
    assert.doesNotMatch(stripped, negative, `${where} says rendering stops working without run_jsx: ${sentence}`);
  }
}

await check("turning off run_jsx keeps the render queue, and its descriptions say so", async () => {
  const fs = await import("node:fs");
  const renderOps = ["add_to_render_queue", "list_render_queue", "remove_render_item", "render_queue", "await_job", "get_job", "cancel_job"];
  const kept = enabledOps(NO_JSX);
  for (const op of renderOps) assert.ok(kept.includes(op), `${op} is switched off with run_jsx`);

  const mcpb = fs.readFileSync(path.join(root, "scripts", "build-mcpb.mjs"), "utf8");
  const block = mcpb.slice(mcpb.indexOf("disable_run_jsx: {"));
  const desc = block.slice(block.indexOf("description:"), block.indexOf("default:"));
  assert.ok(desc.length > 0, "could not find the disable_run_jsx description in build-mcpb.mjs");
  assertRenderingKept(desc.replace(/"\s*\+\s*"/g, ""), "the .mcpb run_jsx setting");

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const row = readme.split("\n").find((l) => l.startsWith("| **Turn off running scripts**"));
  assert.ok(row, "README has no 'Turn off running scripts' row");
  assertRenderingKept(row, "the README's 'Turn off running scripts' row");
});

console.log(`tool-policy: ${passed} checks passed`);
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows (nodejs/node#56645; the note in issue-journal.mjs).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
