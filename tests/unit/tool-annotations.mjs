// Tool annotations (issue #165) and compact tool results (issue #166).
//
// Both fail silently. An annotation that drifts from OpMutation is a write a
// client auto-approves as a read; a missing one is a client that cannot tell.
// A result that goes back to pretty-printing is 20–40% more tokens on every
// later turn of the session, and nothing errors. Driven through the real MCP
// server against a stub bridge; no After Effects.
//
//   node tests/unit/tool-annotations.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { OpSchemas, OpMutation, ServerOpEffect, OpDiskWrite } = await import(sharedDist("schemas.js"));
const { toolAnnotations, DESTRUCTIVE_VERBS, IDEMPOTENT_VERBS, overwritesDisk } = await import(dist("tools", "annotations.js"));
const { z } = await import("zod");
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));

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

// A nested read, shaped like a real get_layer_full answer.
const SAMPLE = {
  id: 12, name: "Title", type: "text", inPoint: 0, outPoint: 10,
  transform: {
    position: { value: [960, 540, 0], keyframes: [{ time: 0, value: [960, 600, 0], inEase: [{ speed: 0, influence: 33.3 }], outEase: [{ speed: 0, influence: 75 }] }, { time: 1, value: [960, 540, 0], inEase: [{ speed: 0, influence: 75 }], outEase: [{ speed: 0, influence: 33.3 }] }] },
    scale: { value: [100, 100, 100] },
    opacity: { value: 100, expression: { text: "wiggle(2, 5)", enabled: true } },
  },
  effects: [{ name: "Drop Shadow", matchName: "ADBE Drop Shadow", enabled: true, params: [{ name: "Opacity", value: 50 }, { name: "Distance", value: 5 }] }],
  text: { content: "Hello\nworld", font: "Inter-Bold", fontSize: 72, justification: "center" },
};

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
    res.setHeader("content-type", "application/json");
    const result =
      op === "run_batch"
        ? { jobId: "job-1", async: true, total: 900, chunkSize: 200, undoStepsEstimate: 5, undoGroupName: "AE MCP: batch" }
        : SAMPLE;
    res.end(JSON.stringify({ ok: true, result }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
assert.notEqual(bridge.address().port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(bridge.address().port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function connect(policy) {
  const server = createServer({ policy });
  const client = new Client({ name: "tool-annotations-test", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const client = await connect({ readOnly: false, runJsx: true });
const readOnlyClient = await connect({ readOnly: true, runJsx: true });

// ---------------------------------------------------------------------------
// #165 — annotations
// ---------------------------------------------------------------------------

const tools = (await client.listTools()).tools;

await check("every listed tool carries all four annotations as booleans", () => {
  assert.equal(tools.length, Object.keys(OpSchemas).length);
  for (const t of tools) {
    assert.ok(t.annotations, `${t.name} has no annotations`);
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof t.annotations[k], "boolean", `${t.name}.${k}`);
    }
  }
});

await check("readOnlyHint follows OpMutation, and ServerOpEffect for server ops", () => {
  for (const t of tools) {
    const effect = OpMutation[t.name];
    const expected = effect === "read" || (effect === "server" && ServerOpEffect[t.name] === "read");
    assert.equal(t.annotations.readOnlyHint, expected, `${t.name} (${effect})`);
  }
  // Pure reads that read-only mode drops for another reason are still reads.
  for (const name of ["get_job", "await_job", "ae_guide", "check_setup", "list_known_issues"]) {
    assert.equal(toolAnnotations(name).readOnlyHint, true, name);
  }
  for (const name of ["cancel_job", "setup_panel", "init_project", "log_issue", "archive_issue"]) {
    assert.equal(toolAnnotations(name).readOnlyHint, false, name);
  }
});

await check("no read-only tool is destructive; openWorld is false", () => {
  for (const t of tools) {
    if (t.annotations.readOnlyHint) {
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.equal(t.annotations.idempotentHint, true, t.name);
    }
    assert.equal(t.annotations.openWorldHint, false, t.name);
  }
});

await check("every op with an `overwrite` argument, or that overwrites disk, is destructive", () => {
  const withField = Object.keys(OpSchemas).filter((n) => {
    const j = z.toJSONSchema(OpSchemas[n], { io: "input", unrepresentable: "any" });
    return j.properties && Object.hasOwn(j.properties, "overwrite");
  });
  assert.ok(withField.length >= 4, `only ${withField} have an overwrite field`);
  for (const n of withField) assert.equal(toolAnnotations(n).destructiveHint, true, `${n} has overwrite`);
  for (const [n, kind] of Object.entries(OpDiskWrite)) {
    assert.ok(Object.hasOwn(OpSchemas, n), `OpDiskWrite names unknown op ${n}`);
    if (kind === "overwrites") assert.equal(toolAnnotations(n).destructiveHint, true, `${n} overwrites disk`);
  }
  for (const n of ["set_house_style", "export_mogrt", "render_queue", "add_to_render_queue", "setup_panel"]) {
    assert.equal(overwritesDisk(n), true, n);
    assert.equal(toolAnnotations(n).destructiveHint, true, n);
  }
  // Additive disk writes do not cry wolf.
  for (const n of ["init_project", "log_issue", "mark_issue_reported", "archive_issue"]) {
    assert.equal(toolAnnotations(n).destructiveHint, false, n);
  }
});

await check("destructive = a removing verb, arbitrary steps, or overwriting disk", () => {
  const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  for (const name of destructive) {
    const verb = name.split("_")[0];
    assert.ok(
      DESTRUCTIVE_VERBS.includes(verb) || name === "run_jsx" || name === "run_batch" || overwritesDisk(name),
      `${name} flagged destructive`
    );
  }
  for (const name of [
    "delete_comp", "delete_layer", "delete_checkpoints", "revert_comp", "purge_unused_footage",
    "remove_effect", "remove_keyframe", "remove_mask", "remove_marker", "remove_render_item",
    "clear_expression", "run_jsx", "run_batch",
  ]) {
    assert.ok(destructive.includes(name), `${name} should be destructive`);
  }
  for (const name of ["create_comp", "add_keyframe", "set_transform", "duplicate_layer", "import_footage", "checkpoint_comp"]) {
    assert.equal(toolAnnotations(name).destructiveHint, false, name);
  }
});

await check("idempotent writes are exactly the absolute-state verbs", () => {
  for (const t of tools) {
    if (t.annotations.readOnlyHint) continue;
    const expected = IDEMPOTENT_VERBS.includes(t.name.split("_")[0]);
    assert.equal(t.annotations.idempotentHint, expected, t.name);
  }
  for (const n of ["set_transform", "set_layer", "toggle_expression", "parent_layer", "reorder_layer", "set_house_style"]) {
    assert.equal(toolAnnotations(n).idempotentHint, true, n);
  }
  for (const n of ["add_keyframe", "create_comp", "duplicate_layer", "import_footage", "delete_layer", "run_jsx", "run_batch", "log_issue"]) {
    assert.equal(toolAnnotations(n).idempotentHint, false, n);
  }
});

await check("read-only mode lists only tools annotated read-only", async () => {
  const listed = (await readOnlyClient.listTools()).tools;
  assert.ok(listed.length > 0);
  for (const t of listed) assert.equal(t.annotations.readOnlyHint, true, `${t.name} listed in read-only mode`);
});

// ---------------------------------------------------------------------------
// #166 — compact results
// ---------------------------------------------------------------------------

await check("a JSON result is compact, with content unchanged", async () => {
  const res = await client.callTool({ name: "get_layer_full", arguments: { compId: 1, layerId: 12 } });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  const text = res.content[0].text;
  assert.deepEqual(JSON.parse(text), SAMPLE);
  assert.equal(text, JSON.stringify(SAMPLE), "result is not compact JSON");
  assert.ok(!/\n\s/.test(text), "result contains pretty-print indentation");
  const pretty = JSON.stringify(SAMPLE, null, 2).length;
  console.log(`  sample get_layer_full: ${pretty} -> ${text.length} chars (${Math.round((1 - text.length / pretty) * 100)}% smaller)`);
});

await check("run_batch's async envelope is compact and keeps its fields", async () => {
  const res = await client.callTool({ name: "run_batch", arguments: { ops: [{ op: "list_comps" }] } });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  const text = res.content[0].text;
  assert.ok(!/\n\s/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')), "envelope contains pretty-print indentation");
  const env = JSON.parse(text);
  assert.equal(env.jobId, "job-1");
  assert.equal(env.async, true);
  assert.equal(env.total, 900);
});

await check("a server-resident result (get_job) is compact", async () => {
  const res = await client.callTool({ name: "get_job", arguments: { jobId: "job-1" } });
  const text = res.content[0].text;
  assert.equal(text, JSON.stringify(JSON.parse(text)));
});

console.log(`tool-annotations: ${passed} checks passed`);
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows (nodejs/node#56645; the note in issue-journal.mjs).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
