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

const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));

// Watch the write queue from outside. This is the module instance the server
// imports (same URL), so every write the server queues passes through here: the
// moment a write *joins* the queue is something a check can wait on instead of
// guessing at with a sleep.
const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));
/** Every op that asked the write queue for the lock, in order. */
const queued = [];
const queueWaiters = new Map();
const realAcquire = WriteQueue.prototype.acquire;
WriteQueue.prototype.acquire = function (op, ...rest) {
  const p = realAcquire.call(this, op, ...rest);
  queued.push(op);
  const ws = queueWaiters.get(op);
  if (ws) { queueWaiters.delete(op); for (const w of ws) w(); }
  return p;
};
/** Settles once `op` has asked the write queue for the lock (since `queued` was cleared). */
function whenQueued(op) {
  if (queued.includes(op)) return Promise.resolve();
  return new Promise((r) => queueWaiters.set(op, [...(queueWaiters.get(op) ?? []), r]));
}
/** `p`, or a failure naming what never happened — a regression fails the check instead of hanging the suite. */
function within(p, ms, what) {
  let t;
  return Promise.race([
    p,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(what)), ms); }),
  ]).finally(() => clearTimeout(t));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stub bridge. Never port 7777 — a real panel may hold that on this machine.
// ---------------------------------------------------------------------------

/**
 * op -> how long the stub takes, and what it answers.
 *
 * `hold` is a promise the test controls: the stub answers only once it settles.
 * A check that asserts an *ordering* — this ran while that was in flight, this
 * waited behind that — holds the slow op on one and releases it only after it
 * has observed what it asserts about. A fixed `ms` alone only makes the
 * ordering likely: on a loaded CI runner the second call can take longer than
 * `ms` to get through the server, and the check fails with nothing wrong
 * (issue #253).
 */
const behaviour = new Map();
/** Every op the stub saw, with the moment it entered and left. */
const seen = [];
/** "enter:<op>" / "leave:<op>" -> callbacks waiting for it. */
const stubWaiters = new Map();
function emit(key) {
  const ws = stubWaiters.get(key);
  if (!ws) return;
  stubWaiters.delete(key);
  for (const w of ws) w();
}
/** Settles when the stub sees `op` enter (or leave) — at once if it already has since `seen` was cleared. */
function stubEvent(phase, op) {
  if (seen.some((s) => s.op === op && (phase === "enter" || s.leftAt !== undefined))) return Promise.resolve();
  const key = `${phase}:${op}`;
  return new Promise((r) => stubWaiters.set(key, [...(stubWaiters.get(key) ?? []), r]));
}
/** A promise the test opens by hand. */
function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
}

/** How long the stub's /health takes to answer — a busy After Effects blocks it too. */
let healthDelayMs = 0;

const bridge = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    if (healthDelayMs) await new Promise((r) => setTimeout(r, healthDelayMs));
    res.setHeader("content-type", "application/json");
    // Report the hash this server ships so the panel-version gate is a no-op
    // rather than a variable of whatever is installed on the test machine.
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    // run_jsx reaches the panel as `_run_jsx`, built by the server (#220, #243).
    const op = parsed.op === "_run_jsx" ? "run_jsx" : parsed.op;
    if (op === "_continue_job") {
      // The server drives every batch (#243); a chunk answers when the check
      // finishes the job.
      const result = await chunkAnswer(parsed.args.jobId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    const b = behaviour.get(op) ?? { ms: 5, result: { ok: true, op } };
    const entry = { op, enteredAt: Date.now() };
    seen.push(entry);
    emit(`enter:${op}`);
    await new Promise((r) => setTimeout(r, b.ms ?? 0));
    if (b.hold) await b.hold;
    entry.leftAt = Date.now();
    emit(`leave:${op}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: b.result }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });

/** jobId -> resolve for the chunk the server is waiting on, or the answer given before it asked. */
const chunkWaiters = new Map();
const chunkEarly = new Map();
function chunkAnswer(jobId) {
  if (chunkEarly.has(jobId)) {
    const r = chunkEarly.get(jobId);
    chunkEarly.delete(jobId);
    return Promise.resolve(r);
  }
  return new Promise((resolve) => chunkWaiters.set(jobId, resolve));
}
/** Finish a batch the server is driving: its next chunk reports done. */
function finishJob(jobId, result) {
  const answer = { done: true, jobId, ...result };
  const w = chunkWaiters.get(jobId);
  if (w) { chunkWaiters.delete(jobId); w(answer); }
  else chunkEarly.set(jobId, answer);
}
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
  queued.length = 0;
  const held = gate();
  behaviour.set("set_transform", { hold: held.p, result: { ok: true, which: "set_transform" } });
  behaviour.set("add_keyframe", { ms: 5, result: { ok: true, which: "add_keyframe" } });

  const both = Promise.all([
    call("set_transform", { compId: 1, layerId: 1, properties: { opacity: 50 } }),
    call("add_keyframe", { compId: 1, layerId: 1, propertyPath: ["Position"], time: 0, value: [0, 0] }),
  ]);
  // The first write is at the bridge and the second has joined the queue behind
  // it. Keep the first in flight a known time past that point, so waitedMs has a
  // floor this check can state rather than hope for.
  await within(Promise.all([stubEvent("enter", "set_transform"), whenQueued("add_keyframe")]), 10_000,
    "set_transform never reached the bridge, or add_keyframe never reached the write queue");
  await sleep(100);
  assert.equal(seen.some((s) => s.op === "add_keyframe"), false, "a write reached the bridge while another was in flight");
  held.open();
  const [first, second] = await both;

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
  // The write is held at the bridge until the read has been answered. Were reads
  // queued behind writes, the read could never reach the bridge while the write
  // is held, and this fails instead of hanging. No sleep decides the outcome.
  seen.length = 0;
  queued.length = 0;
  const held = gate();
  behaviour.set("run_jsx", { hold: held.p, result: { ok: true } });
  behaviour.set("list_comps", { ms: 5, result: [] });

  const write = call("run_jsx", { code: "return 1" });
  let read;
  try {
    await within(stubEvent("enter", "run_jsx"), 10_000, "run_jsx never reached the bridge");
    read = await within(call("list_comps", {}), 10_000,
      "the read did not answer while a write was in flight: it was made to wait for the write");
  } finally {
    held.open();
    await write;
  }

  assert.equal(overlapped("run_jsx", "list_comps"), true, "the read should have run during the write");
  assert.equal(queued.includes("list_comps"), false, "a read asked the write queue for the lock");
  // A read never queues, so it never carries a queue note.
  assert.equal(read.content.length, 1);
  assert.deepEqual(payload(read), []);
});

await check("a run_jsx result that is not an object keeps its shape", async () => {
  // #43's lesson: what a run_jsx answer looks like is load-bearing. An array
  // cannot absorb the queue note, so it arrives as a second content block and
  // the first block is byte-for-byte what it would have been.
  seen.length = 0;
  queued.length = 0;
  const held = gate();
  behaviour.set("set_text", { hold: held.p, result: { ok: true } });
  behaviour.set("run_jsx", { ms: 5, result: ["a", "b"] });

  const both = Promise.all([
    call("set_text", { compId: 1, layerId: 1, text: "x" }),
    call("run_jsx", { code: "return ['a','b']" }),
  ]);
  // There is a queue note only if run_jsx really queued behind set_text.
  await within(Promise.all([stubEvent("enter", "set_text"), whenQueued("run_jsx")]), 10_000,
    "set_text never reached the bridge, or run_jsx never reached the write queue");
  held.open();
  const [, jsx] = await both;

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

await check("a timeout says what the whole call cost, not only the op's limit", async () => {
  // Issue #175, measured on 26.5: AE_MCP_OP_TIMEOUT_MS=3000 and the agent was
  // told "did not answer within 3s" after 5.0 s. A fresh server's first call
  // asks /health for the panel-version gate first — a 2 s probe that a busy
  // After Effects blocks too — and only then starts the op's own clock.
  const fresh = createServer();
  const c2 = new Client({ name: "timeout-test", version: "0" }, { capabilities: {} });
  const [cs2, ss2] = InMemoryTransport.createLinkedPair();
  await Promise.all([fresh.connect(ss2), c2.connect(cs2)]);
  healthDelayMs = 2300;
  process.env.AE_MCP_OP_TIMEOUT_MS = "400";
  behaviour.set("set_layer", { ms: 1500, result: { ok: true } });
  try {
    const t0 = Date.now();
    const res = await c2.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, name: "n" } });
    const took = Date.now() - t0;
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    const m = /gave up (\d+\.\d)s after it was made/.exec(text);
    assert.ok(m, text.split("\n")[0]);
    const reported = Number(m[1]) * 1000;
    assert.ok(Math.abs(reported - took) <= 200, `reported ${reported} ms, took ${took} ms`);
    assert.match(text, /limit is 0\.4s/);
    assert.match(text, /earlier steps of this call\. Of that, \d\.\ds checking the panel's version/);
    assert.doesNotMatch(text, /did not answer within/, "the bare limit is not what the call cost");
    assert.match(text, /may still run and land after this message/);
  } finally {
    healthDelayMs = 0;
    delete process.env.AE_MCP_OP_TIMEOUT_MS;
    behaviour.delete("set_layer");
    await c2.close();
  }
});

await check("a render_queue step that times out is reported as render_queue, with no render started", async () => {
  // The prepare and the save cross the bridge before any render starts; a
  // timeout in either must not say "may still land, do not re-send" under an
  // internal op name.
  process.env.AE_MCP_OP_TIMEOUT_MS = "300";
  behaviour.set("_render_prepare", { ms: 900, result: { items: [] } });
  try {
    const res = await client.callTool({ name: "render_queue", arguments: { all: true } });
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /`render_queue`/);
    assert.doesNotMatch(text, /_render_prepare|may still run and land|Do not re-send/);
    assert.match(text, /Nothing was saved and no render was started/);
    assert.match(text, /call render_queue again/);
  } finally {
    delete process.env.AE_MCP_OP_TIMEOUT_MS;
    behaviour.delete("_render_prepare");
    await new Promise((r) => setTimeout(r, 700)); // let the stub answer the abandoned request
  }
});

await check("a long batch holds the queue until the job finishes", async () => {
  // The gap the panel's own evalScript mutex leaves, and the whole reason for
  // this queue: run_batch answers with a jobId and the server goes on driving
  // _continue_job in the background. A write let through here would land in the
  // middle of the batch, out of the order the agent issued it in.
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 5,
    result: {
      jobId: "j_test_1", async: true, total: 600,
      chunkSize: 25, undoStepsEstimate: 24, undoGroupName: "AE MCP Batch",
      note: "about 24 undo steps, NOT one", driver: "server",
    },
  });
  behaviour.set("set_layer", { ms: 5, result: { ok: true } });

  const batch = await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });
  // The undo fields have to survive the envelope: this is the only message the
  // agent sees before it starts telling the user how to undo the work.
  const { note, ...env } = payload(batch);
  assert.deepEqual(env, {
    jobId: "j_test_1", async: true, total: 600,
    chunkSize: 25, undoStepsEstimate: 24, undoGroupName: "AE MCP Batch",
  });
  // The panel's note survives too, with the server's own sentence about where
  // progress goes appended — tests/unit/job-progress.mjs covers that sentence.
  assert.ok(note.startsWith("about 24 undo steps, NOT one "), note);

  let landed = false;
  queued.length = 0;
  const pending = call("set_layer", { compId: 1, layerId: 1, name: "n" }).then((r) => { landed = true; return r; });

  // Once set_layer has joined the queue, give it every chance to slip through
  // before the batch finishes. This sleep only bounds how hard the check looks:
  // a slow runner can make it less searching, never make it fail — and it is
  // also the floor under waitedMs below.
  await within(whenQueued("set_layer"), 10_000, "set_layer never reached the write queue");
  await sleep(120);
  assert.equal(landed, false, "a write reached the bridge while the batch was still running");
  assert.equal(seen.some((s) => s.op === "set_layer"), false);

  // The batch's last chunk reports done.
  finishJob("j_test_1", { results: [] });

  const res = await pending;
  assert.equal(payload(res).queuedBehind, "run_batch");
  assert.ok(payload(res).waitedMs >= 100);
});

await check("await_job does not deadlock against the batch holding the lock", async () => {
  seen.length = 0;
  behaviour.set("run_batch", { ms: 5, result: { jobId: "j_test_2", async: true, total: 600, driver: "server" } });
  await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });

  // await_job is server-resident: it takes no lease, so it can still be
  // answered while the batch's lease is held. If it queued, this would hang.
  const awaited = call("await_job", { jobId: "j_test_2", timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  finishJob("j_test_2", { results: [1] });

  const state = payload(await awaited);
  assert.equal(state.status, "completed");
});

await check("a singleUndo batch releases the queue when its call returns", async () => {
  // singleUndo runs the whole batch inside one evalScript, so it answers with a
  // result and never with a jobId. The lease has to be released by the call's
  // own `finally`; extending it here would park the queue on a job that will
  // never complete, and every write for the rest of the session would wait out
  // the hold ceiling. There is no async envelope to detect, so the guard is
  // that the *next* write answers at all.
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 20,
    result: { results: [], errors: [], total: 600, undoSteps: 1, undoGroupName: "All at once" },
  });
  behaviour.set("set_layer", { ms: 5, result: { ok: true } });

  const batch = await call("run_batch", {
    ops: [{ op: "create_null_layer", args: { compId: 1 } }],
    singleUndo: true,
  });
  assert.equal(payload(batch).undoSteps, 1);

  const after = await Promise.race([
    call("set_layer", { compId: 1, layerId: 1, name: "n" }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("the write after a singleUndo batch never ran — the lease was not released")), 3000)
    ),
  ]);
  assert.equal(payload(after).ok, true);
  assert.equal(seen.map((s) => s.op).join(","), "run_batch,set_layer");
});

console.log(`write-queue-server: ${passed} checks passed`);
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645; the note in
// issue-journal.mjs). The server's WS client reconnects on a timer it owns, so
// the process cannot simply be left to drain.
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
