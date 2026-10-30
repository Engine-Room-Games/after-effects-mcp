// Unknown keys are refused, not stripped (issue #147), and a run_batch step is
// held to the same arguments as the tool it names (issue #157).
//
// Both failures look like success. zod strips a key an object does not
// declare, while the emitted JSON Schema tells the model `additionalProperties:
// false` — so a misspelt `positon` reached no handler and the tool answered
// "done". And batch steps went to ExtendScript raw: no defaults, typos passed,
// and a tool whose second half runs outside After Effects half-worked. Nothing
// here needs After Effects; the server is driven over MCP against a stub bridge.
//
//   node tests/unit/strict-args.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const S = await import(sharedDist("schemas.js"));
const { OpSchemas, StrictOpSchemas, STRICT_UNHANDLED, OpMutation, crossFieldRulesIn } = S;
const { prepareBatchSteps, batchStepRefusal, BATCH_STEP_REFUSALS } = await import(dist("tools", "batchSteps.js"));
const { MAX_BATCH_DEPTH } = await import(dist("tools", "policy.js"));
const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));

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
const defOf = (s) => s._zod.def;

// ---------------------------------------------------------------------------
// The schemas themselves.
// ---------------------------------------------------------------------------

await check("every op has a strict schema, and every node type was understood", () => {
  assert.deepEqual(Object.keys(StrictOpSchemas), ALL);
  // A node strictDeep could not close is one where a typo would still be
  // stripped. Teach it the type rather than allowing it here.
  assert.deepEqual(STRICT_UNHANDLED, []);
});

await check("every op refuses an unknown top-level key", () => {
  for (const op of ALL) {
    const r = StrictOpSchemas[op].safeParse({ zzNotAField: 1 });
    assert.equal(r.success, false, `${op} accepted an unknown key`);
    assert.ok(
      r.error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("zzNotAField")),
      `${op} did not name the unknown key: ${JSON.stringify(r.error.issues)}`
    );
  }
});

await check("the plain schemas strip it — the bug, so this test can tell", () => {
  // set_transform was one of the 55 non-strict schemas when #147 was filed.
  const r = OpSchemas.set_transform.safeParse({ compId: 1, layerId: 2, properties: {}, positon: [1, 2] });
  assert.equal(r.success, true);
  assert.equal("positon" in r.data, false);
});

await check("every object reached, at any depth, is closed", () => {
  const seen = new Set();
  const walk = (node, where) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const d = defOf(node);
    switch (d.type) {
      case "object":
        assert.equal(defOf(d.catchall ?? { _zod: { def: { type: "missing" } } }).type, "never", `${where} is open`);
        for (const [k, v] of Object.entries(d.shape)) walk(v, `${where}.${k}`);
        return;
      case "optional": case "default": case "prefault": case "nullable": case "readonly": case "nonoptional": case "catch":
        return walk(d.innerType, where);
      case "array": return walk(d.element, `${where}[]`);
      case "tuple": d.items.forEach((s, i) => walk(s, `${where}[${i}]`)); return walk(d.rest, where);
      case "union": return d.options.forEach((s, i) => walk(s, `${where}|${i}`));
      case "record": return walk(d.valueType, `${where}{}`);
      case "pipe": walk(d.in, where); return walk(d.out, where);
      default: return;
    }
  };
  for (const op of ALL) walk(StrictOpSchemas[op], op);
});

await check("nested unknown keys are refused too", () => {
  const ease = StrictOpSchemas.add_keyframe.safeParse({
    compId: 1, layerId: 1, propertyPath: ["Transform", "Opacity"], time: 0, value: 50,
    interpolation: { easeIn: { influence: 33, speed: 0, infl: 1 } },
  });
  assert.equal(ease.success, false);
  assert.ok(ease.error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("infl")));
  // Inside a discriminated union branch.
  const shape = StrictOpSchemas.add_shape_content.safeParse({
    compId: 1, layerId: 1, content: { type: "rect", size: [1, 1], roundnes: 4 },
  });
  assert.equal(shape.success, false);
  assert.ok(shape.error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("roundnes")));
});

await check("cross-field rules and defaults survive the closing", () => {
  for (const op of ALL) {
    assert.equal(
      crossFieldRulesIn(StrictOpSchemas[op]).length,
      crossFieldRulesIn(OpSchemas[op]).length,
      `${op} lost a cross-field rule`
    );
  }
  const r = StrictOpSchemas.reorder_layer.safeParse({ compId: 1, layerId: 2 });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /Pass exactly one of/);
  assert.equal(StrictOpSchemas.create_comp.parse({}).name, "Untitled");
  // #148: create_shape_layer declared shapes/fill/stroke/strokeWidth and never
  // applied them. They are gone, so each is now refused by name, not dropped.
  for (const key of ["shapes", "fill", "stroke", "strokeWidth"]) {
    const value = key === "shapes" ? [{ type: "rect" }] : key === "strokeWidth" ? 4 : [1, 0, 0];
    const res = StrictOpSchemas.create_shape_layer.safeParse({ compId: 1, [key]: value });
    assert.equal(res.success, false, `create_shape_layer accepted ${key} it would never apply`);
    assert.deepEqual(res.error.issues[0].keys, [key]);
  }
  assert.equal(StrictOpSchemas.create_shape_layer.safeParse({ compId: 1, position: "center" }).success, true);
});

// ---------------------------------------------------------------------------
// Batch steps, without the server.
// ---------------------------------------------------------------------------

const NULL_STEP = { op: "create_null_layer", args: { compId: 1 } };

await check("a valid step is forwarded parsed, with defaults applied", () => {
  const { ops, problems } = prepareBatchSteps([{ op: "create_comp", args: {} }, NULL_STEP]);
  assert.deepEqual(problems, []);
  assert.equal(ops[0].args.name, "Untitled");
  assert.equal(ops[0].args.width, 1920);
});

await check("a step with a typo, a missing field or a broken rule is refused with its path", () => {
  const { problems } = prepareBatchSteps([
    NULL_STEP,
    { op: "set_layer", args: { compId: 1, layerId: 1, nmae: "x" } },
    { op: "set_layer", args: { layerId: 1 } },
    { op: "reorder_layer", args: { compId: 1, layerId: 1 } },
  ]);
  assert.deepEqual(problems.map((p) => p.path), ["ops[1]", "ops[2]", "ops[3]"]);
  assert.match(problems[0].problem, /unknown field `nmae`/);
  assert.match(problems[1].problem, /compId: required/);
  assert.match(problems[2].problem, /Pass exactly one of/);
});

await check("internal, server-resident and half-outside-AE ops are refused by name, with a reason", () => {
  for (const op of ["_render_prepare", "_continue_job", "no_such_tool"]) assert.ok(batchStepRefusal(op), op);
  // Inherited names are not tools: `"constructor" in {}` is true.
  for (const op of ["constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
    assert.match(batchStepRefusal(op), /^(there is no tool by that name|it is an internal step)/, op);
    const { problems } = prepareBatchSteps([{ op, args: {} }]);
    assert.equal(problems.length, 1, op);
    assert.doesNotMatch(problems[0].problem, /native code/, op);
  }
  for (const op of ALL.filter((n) => OpMutation[n] === "server")) assert.ok(batchStepRefusal(op), op);
  for (const op of ["snapshot_comp", "diff_comp", "screenshot_frame", "screenshot_layer", "export_mogrt", "render_queue", "get_house_style"]) {
    assert.ok(BATCH_STEP_REFUSALS[op], op);
    const { problems } = prepareBatchSteps([{ op, args: {} }]);
    assert.equal(problems.length, 1, op);
    assert.equal(problems[0].problem, BATCH_STEP_REFUSALS[op]);
  }
  // And the ordinary ExtendScript-only tools are not refused.
  for (const op of ["set_layer", "run_jsx", "run_batch", "add_to_render_queue", "checkpoint_comp"]) {
    assert.equal(batchStepRefusal(op), undefined, op);
  }
});

await check("nested batches are validated at every depth", () => {
  const inner = { op: "run_batch", args: { ops: [NULL_STEP, { op: "run_batch", args: { ops: [{ op: "create_comp", args: { nme: "x" } }] } }] } };
  const { problems } = prepareBatchSteps([inner]);
  assert.deepEqual(problems.map((p) => p.path), ["ops[0].args.ops[1].args.ops[0]"]);
  const ok = prepareBatchSteps([{ op: "run_batch", args: { ops: [{ op: "create_comp", args: {} }] } }]);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.ops[0].args.ops[0].args.name, "Untitled");
  // An inner step list that is not a list of steps fails the inner run_batch schema.
  const bad = prepareBatchSteps([{ op: "run_batch", args: { ops: { 0: NULL_STEP, length: 1 } } }]);
  assert.equal(bad.problems.length, 1);
});

await check("nesting past the bound is refused", () => {
  let step = NULL_STEP;
  for (let i = 0; i < MAX_BATCH_DEPTH + 1; i++) step = { op: "run_batch", args: { ops: [step] } };
  const { problems } = prepareBatchSteps([step]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /nested more than/);
});

await check("a run_jsx step has its scriptPath resolved, as the tool would", () => {
  const { ops, problems } = prepareBatchSteps([{ op: "run_jsx", args: { code: "return 1" } }]);
  assert.deepEqual(problems, []);
  assert.equal(ops[0].args.code, "return 1");
  const missing = prepareBatchSteps([{ op: "run_jsx", args: { scriptPath: path.join(root, "no-such-script.jsx") } }]);
  assert.equal(missing.problems.length, 1);
});

// ---------------------------------------------------------------------------
// Through the real server.
// ---------------------------------------------------------------------------

const seen = [];
const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    seen.push(msg);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { ok: true, op: msg.op } }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
assert.notEqual(bridge.address().port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(bridge.address().port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const server = createServer({});
const client = new Client({ name: "strict-args-test", version: "0" }, { capabilities: {} });
const [c, s] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(s), client.connect(c)]);

await check("a direct call with a misspelt key is refused before the bridge", async () => {
  seen.length = 0;
  const res = await client.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, nmae: "x" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown field `nmae`/);
  assert.deepEqual(seen, []);
});

await check("an inherited name is an unknown tool, directly and as a step", async () => {
  seen.length = 0;
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    const res = await client.callTool({ name, arguments: {} });
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text, new RegExp(`Unknown tool: ${name}`));
    const batch = await client.callTool({ name: "run_batch", arguments: { ops: [{ op: name, args: {} }] } });
    assert.equal(batch.isError, true, name);
    assert.match(batch.content[0].text, /there is no tool by that name/);
    assert.doesNotMatch(batch.content[0].text, /native code/);
  }
  assert.deepEqual(seen, []);
});

await check("a server-resident tool refuses an unknown key too", async () => {
  const res = await client.callTool({ name: "ae_guide", arguments: { topic: "after-effects", detial: "x" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown field `detial`/);
});

await check("run_batch with one bad step sends nothing, and names it", async () => {
  seen.length = 0;
  const res = await client.callTool({
    name: "run_batch",
    arguments: { ops: [NULL_STEP, { op: "screenshot_frame", args: { compId: 1 } }, { op: "set_layer", args: { compId: 1, layerId: 1, nmae: "x" } }] },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /nothing in the batch was run/);
  assert.match(res.content[0].text, /ops\[1\] \(screenshot_frame\)/);
  assert.match(res.content[0].text, /ops\[2\] \(set_layer\): invalid arguments: .*nmae/);
  assert.deepEqual(seen, []);
});

await check("create_shape_layer's removed fields point at add_shape_content, directly and as a step (#148)", async () => {
  seen.length = 0;
  const direct = await client.callTool({
    name: "create_shape_layer",
    arguments: { compId: 1, fill: [1, 0, 0], stroke: [0, 0, 0], strokeWidth: 4, shapes: [], nmae: "x" },
  });
  assert.equal(direct.isError, true);
  const text = direct.content[0].text;
  assert.match(text, /create_shape_layer does not take `fill`, `stroke`, `strokeWidth`, `shapes`: .*add_shape_content/);
  // The removed fields are spelt right, so they must not be told to check the
  // spelling — but a real typo alongside them still is.
  assert.match(text, /unknown field `nmae`.*Check the spelling/);
  assert.doesNotMatch(text, /`fill`[^\n]*Check the spelling/);
  const batch = await client.callTool({
    name: "run_batch",
    arguments: { ops: [{ op: "create_shape_layer", args: { compId: 1, fill: [1, 0, 0] } }] },
  });
  assert.equal(batch.isError, true);
  assert.match(batch.content[0].text, /ops\[0\] \(create_shape_layer\): invalid arguments: .*does not take `fill`: .*add_shape_content/);
  assert.doesNotMatch(batch.content[0].text, /Check the spelling/);
  assert.deepEqual(seen, []);
});

await check("run_batch forwards the parsed steps, defaults applied", async () => {
  seen.length = 0;
  const res = await client.callTool({ name: "run_batch", arguments: { ops: [{ op: "create_comp", args: {} }, NULL_STEP] } });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].op, "run_batch");
  assert.equal(seen[0].args.ops[0].args.name, "Untitled");
  assert.deepEqual(seen[0].args.ops[1], NULL_STEP);
});

console.log(`strict-args: ${passed} checks passed`);
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows (nodejs/node#56645; the note in issue-journal.mjs).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
