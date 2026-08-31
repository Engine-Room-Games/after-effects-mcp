// The write queue as the agent actually meets it: through tools/call.
//
// tests/unit/write-queue.mjs covers the queue itself. This one covers the
// wiring, which is the half that would fail silently — a `wait` not threaded to
// one of the three return sites, or `acquire` called on the wrong side of the
// panel gate, leaves the queue working perfectly and reporting nothing.
//
// It drives the real MCP server over an in-memory transport against a stub
// bridge on an ephemeral port. There is no After Effects here and none is
// needed: everything asserted is server-side.
//
//   node tests/unit/write-queue-server.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));

// ---------------------------------------------------------------------------
// Stub bridge. Never port 7777 — a real panel may hold that on this machine.
// ---------------------------------------------------------------------------

/** op -> how long the stub takes, and what it answers. */
const behaviour = new Map();
/** Every op the stub saw, with the moment it entered and left. */
const seen = [];

const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    // Report the hash this server ships so the panel-version gate is a no-op
    // rather than a variable of whatever is installed on the test machine.
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { op } = JSON.parse(body || "{}");
    const b = behaviour.get(op) ?? { ms: 5, result: { ok: true, op } };
    const entry = { op, enteredAt: Date.now() };
    seen.push(entry);
    await new Promise((r) => setTimeout(r, b.ms));
    entry.leftAt = Date.now();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: b.result }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

// Imported only after AE_MCP_PORT is set: HttpClient resolves the port in its
// constructor, which runs inside createServer().
const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "write-queue-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
}
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content[0]?.text}`);
  return res;
}
const payload = (res, i = 0) => JSON.parse(res.content[i].text);
const overlapped = (a, b) => {
  const x = seen.find((s) => s.op === a);
  const y = seen.find((s) => s.op === b);
  return x.enteredAt < y.leftAt && y.enteredAt < x.leftAt;
};

// ---------------------------------------------------------------------------

await check("two concurrent writes reach the bridge one at a time", async () => {
  seen.length = 0;
  behaviour.set("set_transform", { ms: 120, result: { ok: true, which: "set_transform" } });
  behaviour.set("add_keyframe", { ms: 5, result: { ok: true, which: "add_keyframe" } });

  const [first, second] = await Promise.all([
    call("set_transform", { compId: 1, layerId: 1, properties: { opacity: 50 } }),
    call("add_keyframe", { compId: 1, layerId: 1, propertyPath: ["Position"], time: 0, value: [0, 0] }),
  ]);

  assert.deepEqual(seen.map((s) => s.op), ["set_transform", "add_keyframe"]);
  assert.equal(overlapped("set_transform", "add_keyframe"), false, "the two writes overlapped at the bridge");

  // The one that went straight through says nothing about the queue…
  const a = payload(first);
  assert.equal("queuedBehind" in a, false);
  assert.equal("waitedMs" in a, false);
  // …and the one that waited names what it waited behind.
  const b = payload(second);
  assert.equal(b.queuedBehind, "set_transform");
  assert.ok(b.waitedMs >= 80, `waitedMs was ${b.waitedMs}`);
  assert.equal(b.which, "add_keyframe", "the op's own result must survive the annotation");
});

await check("a read issued behind a slow write is not made to wait for it", async () => {
  seen.length = 0;
  behaviour.set("run_jsx", { ms: 150, result: { ok: true } });
  behaviour.set("list_comps", { ms: 5, result: [] });

  const [, read] = await Promise.all([
    call("run_jsx", { code: "return 1" }),
    call("list_comps", {}),
  ]);

  assert.equal(overlapped("run_jsx", "list_comps"), true, "the read should have run during the write");
  // A read never queues, so it never carries a queue note.
  assert.equal(read.content.length, 1);
  assert.deepEqual(payload(read), []);
});

await check("a run_jsx result that is not an object keeps its shape", async () => {
  // #43's lesson: what a run_jsx answer looks like is load-bearing. An array
  // cannot absorb the queue note, so it arrives as a second content block and
  // the first block is byte-for-byte what it would have been.
  seen.length = 0;
  behaviour.set("set_text", { ms: 120, result: { ok: true } });
  behaviour.set("run_jsx", { ms: 5, result: ["a", "b"] });

  const [, jsx] = await Promise.all([
    call("set_text", { compId: 1, layerId: 1, text: "x" }),
    call("run_jsx", { code: "return ['a','b']" }),
  ]);

  assert.equal(jsx.content.length, 2, "the note must not be folded into an array");
  assert.deepEqual(payload(jsx, 0), ["a", "b"]);
  assert.equal(payload(jsx, 1).queuedBehind, "set_text");
});

await check("an uncontended write is byte-identical to what it always was", async () => {
  seen.length = 0;
  behaviour.set("create_comp", { ms: 5, result: { id: 42, name: "t" } });
  const res = await call("create_comp", { name: "t", width: 1920, height: 1080, frameRate: 30, duration: 5 });
  assert.equal(res.content.length, 1);
  assert.deepEqual(payload(res), { id: 42, name: "t" });
});

await check("a long batch holds the queue until the job finishes", async () => {
  // The gap the panel's own evalScript mutex leaves, and the whole reason for
  // this queue: run_batch answers with a jobId while its undo group is still
  // open, and the panel goes on driving _continue_job in the background. A
  // write let through here would land inside that group.
  seen.length = 0;
  behaviour.set("run_batch", { ms: 5, result: { jobId: "j_test_1", async: true, total: 600 } });
  behaviour.set("set_layer", { ms: 5, result: { ok: true } });

  const batch = await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });
  assert.deepEqual(payload(batch), { jobId: "j_test_1", async: true, total: 600 });

  let landed = false;
  const queued = call("set_layer", { compId: 1, layerId: 1, name: "n" }).then((r) => { landed = true; return r; });

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(landed, false, "a write reached the bridge while the batch was still running");
  assert.equal(seen.some((s) => s.op === "set_layer"), false);

  // What the panel broadcasts over /events when the batch finishes.
  for (const ws of wss.clients) ws.send(JSON.stringify({ type: "complete", jobId: "j_test_1", result: { results: [] } }));

  const res = await queued;
  assert.equal(payload(res).queuedBehind, "run_batch");
  assert.ok(payload(res).waitedMs >= 100);
});

await check("await_job does not deadlock against the batch holding the lock", async () => {
  seen.length = 0;
  behaviour.set("run_batch", { ms: 5, result: { jobId: "j_test_2", async: true, total: 600 } });
  await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });

  // await_job is server-resident: it takes no lease, so it can still be
  // answered while the batch's lease is held. If it queued, this would hang.
  const awaited = call("await_job", { jobId: "j_test_2", timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  for (const ws of wss.clients) ws.send(JSON.stringify({ type: "complete", jobId: "j_test_2", result: { results: [1] } }));

  const state = payload(await awaited);
  assert.equal(state.status, "completed");
});

console.log(`write-queue-server: ${passed} checks passed`);
// The bridge stub's WS client reconnects on a timer the server owns, so there
// is nothing to await here — same reason panel-boot.mjs ends this way.
process.exit(0);
