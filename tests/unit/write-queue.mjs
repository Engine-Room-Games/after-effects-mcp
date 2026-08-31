// The server-side write mutex (issue #55).
//
// Worth testing offline and in full, because every property here is invisible
// when it breaks. A queue that lets two writes overlap looks exactly like one
// that does not until an undo group is corrupted in someone's real project; a
// queue that starts the op timeout at enqueue produces a bridge-failure message
// for a bridge that was working; a queue that executes a cancelled call leaks
// work into a session that asked for none of it. None of that needs After
// Effects to prove — it is all server-side TypeScript.
//
//   node tests/unit/write-queue.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { WriteQueue, mergeWait } = await import(dist("bridge", "writeQueue.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { JobManager } = await import(dist("jobs", "manager.js"));
const { WriteQueueCancelledError, WriteQueueFullError, WriteQueueWaitError, BridgeTimeoutError, BridgeUnreachableError } =
  await import(dist("util", "errors.js"));
const { SERVER_OPS, isWriteOp } = await import(dist("server.js"));
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Classification. The deliverable that keeps the rest honest: a table nobody
// updates is worse than no table, because an op omitted from it would be
// classified by silence.
// ---------------------------------------------------------------------------

const opNames = Object.keys(OpSchemas);
const classified = Object.keys(OpMutation);

await check("every op in OpSchemas is classified", () => {
  const missing = opNames.filter((n) => !(n in OpMutation));
  assert.deepEqual(
    missing,
    [],
    `unclassified op(s): ${missing.join(", ")}\n` +
      "Add them to OpMutation in packages/shared/src/schemas.ts — \"write\" if the op\n" +
      "changes the project or the app, \"read\" if it only looks, \"server\" if it never\n" +
      "reaches the bridge."
  );
});

await check("nothing is classified that is not an op", () => {
  const extra = classified.filter((n) => !(n in OpSchemas));
  assert.deepEqual(extra, [], `OpMutation names an op that no longer exists: ${extra.join(", ")}`);
});

await check("every classification is one of the three buckets", () => {
  for (const [op, effect] of Object.entries(OpMutation)) {
    assert.ok(["write", "read", "server"].includes(effect), `${op} is classified ${JSON.stringify(effect)}`);
  }
});

await check("the two tables agree on what never reaches the bridge", () => {
  for (const op of SERVER_OPS) {
    assert.equal(OpMutation[op], "server", `${op} is in SERVER_OPS but classified ${OpMutation[op]}`);
  }
  for (const [op, effect] of Object.entries(OpMutation)) {
    if (effect === "server") assert.ok(SERVER_OPS.has(op), `${op} is classified "server" but is not in SERVER_OPS`);
  }
});

// The specific exemptions issue #55 and the brief call out by name. If one of
// these ever flips to "write", every write in the session starts waiting on a
// render or, worse, deadlocks against the job it is waiting for.
await check("reads that must never queue", () => {
  for (const op of [
    "list_comps", "list_layers", "list_effects", "get_comp", "get_layer_full",
    "get_keyframes", "get_project_summary", "find_layers", "screenshot_frame",
    "screenshot_layer", "get_house_style", "get_expression",
  ]) {
    assert.equal(OpMutation[op], "read", op);
    assert.equal(isWriteOp(op), false, op);
  }
});

await check("await_job and cancel_job must never take the lock", () => {
  // await_job blocks for as long as the batch it is waiting on; cancel_job is
  // how a stuck batch is released. Queueing either behind that batch's own
  // lease is a deadlock, not a slowdown.
  for (const op of ["await_job", "get_job", "cancel_job", "check_setup", "ae_guide", "list_known_issues"]) {
    assert.equal(isWriteOp(op), false, op);
  }
});

await check("the writers the issue names are writers", () => {
  for (const op of [
    "create_comp", "create_text_layer", "set_transform", "delete_layer",
    "add_keyframe", "remove_keyframe", "run_jsx", "run_batch", "import_footage",
    "set_expression", "export_mogrt", "set_house_style",
  ]) {
    assert.equal(OpMutation[op], "write", op);
    assert.equal(isWriteOp(op), true, op);
  }
});

await check("an op nobody classified is treated as a write, not as a read", () => {
  // Belt to the test's braces. The build fails above, but if it somehow ships,
  // the runtime must fail towards serializing rather than towards interleaving.
  assert.equal(isWriteOp("some_op_added_after_this_test_was_written"), true);
});

// ---------------------------------------------------------------------------
// Mutual exclusion
// ---------------------------------------------------------------------------

/** Records the exact enter/exit interleaving of everything run through it. */
function tracer() {
  const log = [];
  return {
    log,
    async run(queue, op, ms, opts = {}) {
      const lease = queue ? await queue.acquire(op, opts.signal) : null;
      log.push(`+${op}`);
      try {
        await sleep(ms);
        return lease?.wait ?? null;
      } finally {
        log.push(`-${op}`);
        lease?.release();
      }
    },
  };
}

await check("two concurrent writes run strictly in sequence", async () => {
  const q = new WriteQueue();
  const t = tracer();
  await Promise.all([t.run(q, "set_transform", 40), t.run(q, "add_keyframe", 10)]);
  assert.deepEqual(t.log, ["+set_transform", "-set_transform", "+add_keyframe", "-add_keyframe"]);
});

await check("writes stay in the order they were issued", async () => {
  const q = new WriteQueue();
  const t = tracer();
  await Promise.all(["a", "b", "c", "d"].map((n) => t.run(q, n, 5)));
  assert.deepEqual(t.log, ["+a", "-a", "+b", "-b", "+c", "-c", "+d", "-d"]);
});

await check("reads overlap writes freely", async () => {
  const q = new WriteQueue();
  const t = tracer();
  // Reads pass `null` for the queue, exactly as the server does: it only calls
  // acquire() when isWriteOp() says so.
  await Promise.all([
    t.run(q, "run_jsx", 40),
    t.run(null, "screenshot_frame", 10),
    t.run(null, "get_layer_full", 5),
  ]);
  // Both reads finished while the write was still running.
  assert.equal(t.log.indexOf("-get_layer_full") < t.log.indexOf("-run_jsx"), true);
  assert.equal(t.log.indexOf("-screenshot_frame") < t.log.indexOf("-run_jsx"), true);
});

await check("a failing write still releases the lock", async () => {
  const q = new WriteQueue();
  const first = q.acquire("set_text").then((l) => {
    try { throw new Error("AE said no"); } finally { l.release(); }
  });
  await assert.rejects(first, /AE said no/);
  const second = await q.acquire("set_layer");
  assert.equal(second.wait, null, "the lock must be free again, not merely reported free");
  second.release();
});

// ---------------------------------------------------------------------------
// Reporting the wait — only when there was one.
// ---------------------------------------------------------------------------

await check("an uncontended write reports no wait at all", async () => {
  const q = new WriteQueue();
  const lease = await q.acquire("create_comp");
  assert.equal(lease.wait, null);
  lease.release();
});

await check("a write that waited names what it waited behind, and for how long", async () => {
  const q = new WriteQueue();
  const t = tracer();
  const [, waited] = await Promise.all([t.run(q, "run_batch", 60), t.run(q, "set_transform", 1)]);
  assert.equal(waited.queuedBehind, "run_batch");
  assert.ok(waited.waitedMs >= 40, `waitedMs was ${waited.waitedMs}`);
});

await check("the wait note merges into an object result", () => {
  assert.deepEqual(mergeWait({ id: 7, ok: true }, { queuedBehind: "run_batch", waitedMs: 120 }), {
    id: 7,
    ok: true,
    queuedBehind: "run_batch",
    waitedMs: 120,
  });
});

await check("the wait note never rewrites a shape it cannot own", () => {
  // run_jsx returns whatever the caller's script returned. Folding fields into
  // an array, a number or a string would change what every existing caller
  // reads — those get a second content block instead (server.ts textResult).
  const w = { queuedBehind: "run_batch", waitedMs: 1 };
  assert.equal(mergeWait([1, 2, 3], w), null);
  assert.equal(mergeWait(42, w), null);
  assert.equal(mergeWait("done", w), null);
  assert.equal(mergeWait(null, w), null);
  assert.equal(mergeWait(false, w), null);
  // …nor silently overwrite a key the op already uses.
  assert.equal(mergeWait({ waitedMs: 9 }, w), null);
});

// ---------------------------------------------------------------------------
// The long-batch hold — the actual gap the panel's own mutex leaves.
// ---------------------------------------------------------------------------

await check("a lease held for an async job blocks the next write until the job ends", async () => {
  const q = new WriteQueue();
  const jobs = new JobManager();
  const order = [];

  const batch = await q.acquire("run_batch");
  jobs.register("j1", 600);
  // Exactly what server.ts does when the panel answers with {jobId, async}.
  batch.extendUntil(jobs.waitFor("j1", q.holdCeilingMs));
  batch.release(); // the HTTP call is over; the batch is not.
  order.push("envelope-returned");

  const next = q.acquire("set_transform").then((l) => { order.push("next-ran"); l.release(); });

  await sleep(30);
  assert.deepEqual(order, ["envelope-returned"], "the next write must not run while the batch is still going");

  jobs.complete("j1", { results: [] });
  await next;
  assert.deepEqual(order, ["envelope-returned", "next-ran"]);
});

await check("a job that fails still ends the hold", async () => {
  const q = new WriteQueue();
  const jobs = new JobManager();
  const batch = await q.acquire("run_batch");
  jobs.register("j2", 600);
  batch.extendUntil(jobs.waitFor("j2", q.holdCeilingMs));
  batch.release();
  jobs.fail("j2", "op[3] blew up");
  const next = await q.acquire("set_layer");
  assert.equal(next.wait.queuedBehind, "run_batch");
  next.release();
});

await check("a cancelled job ends the hold", async () => {
  const q = new WriteQueue();
  const jobs = new JobManager();
  const batch = await q.acquire("run_batch");
  jobs.register("j3", 600);
  batch.extendUntil(jobs.waitFor("j3", q.holdCeilingMs));
  batch.release();
  // cancel_job is server-resident and takes no lock, which is the only reason
  // this can happen at all.
  assert.equal(isWriteOp("cancel_job"), false);
  jobs.cancel("j3");
  const next = await q.acquire("delete_layer");
  next.release();
});

await check("await_job never blocks the queue", async () => {
  // await_job is not a write, so it takes no lease. Modelled here as what the
  // server actually does: wait on the JobManager while the batch's lease holds
  // the lock, and prove the wait resolves rather than deadlocking.
  const q = new WriteQueue();
  const jobs = new JobManager();
  const batch = await q.acquire("run_batch");
  jobs.register("j4", 600);
  batch.extendUntil(jobs.waitFor("j4", q.holdCeilingMs));
  batch.release();

  const awaited = jobs.waitFor("j4", 5000);
  const queuedWrite = q.acquire("set_transform");
  jobs.complete("j4", { results: [1] });

  const state = await awaited;
  assert.equal(state.status, "completed");
  (await queuedWrite).release();
});

await check("the hold ceiling sits above the wait ceiling", () => {
  // Otherwise a batch's hold could expire a beat before the writer queued
  // behind it hits its own deadline, and the lock would be handed over
  // mid-batch — the exact interleaving this is here to stop.
  const q = new WriteQueue({ maxWaitMs: 1000 });
  assert.ok(q.holdCeilingMs > 1000);
});

// ---------------------------------------------------------------------------
// Cancellation and backpressure
// ---------------------------------------------------------------------------

await check("a cancelled queued call never executes", async () => {
  const q = new WriteQueue();
  const ran = [];
  const holder = await q.acquire("run_batch");

  const ac = new AbortController();
  const queued = q
    .acquire("set_transform", ac.signal)
    .then((l) => { ran.push("set_transform"); l.release(); });

  ac.abort();
  await assert.rejects(queued, (e) => e instanceof WriteQueueCancelledError);
  holder.release();
  await sleep(20);
  assert.deepEqual(ran, [], "an aborted call must be dropped, not executed later");
});

await check("cancelling one queued call does not strand the ones behind it", async () => {
  const q = new WriteQueue();
  const ran = [];
  const holder = await q.acquire("run_batch");
  const ac = new AbortController();
  const cancelled = q.acquire("a", ac.signal).then(() => ran.push("a"), () => {});
  const survivor = q.acquire("b").then((l) => { ran.push("b"); l.release(); });
  ac.abort();
  holder.release();
  await Promise.all([cancelled, survivor]);
  assert.deepEqual(ran, ["b"]);
});

await check("a call cancelled before it ever queues is refused", async () => {
  const q = new WriteQueue();
  await assert.rejects(q.acquire("set_text", AbortSignal.abort()), (e) => e instanceof WriteQueueCancelledError);
  // …and the queue is untouched by it.
  const lease = await q.acquire("set_text");
  assert.equal(lease.wait, null);
  lease.release();
});

await check("the queue is bounded, and says so clearly", async () => {
  const q = new WriteQueue({ maxDepth: 2 });
  const holder = await q.acquire("run_batch");
  const a = q.acquire("a");
  const b = q.acquire("b");
  await assert.rejects(q.acquire("c"), (e) => {
    assert.ok(e instanceof WriteQueueFullError);
    assert.match(e.message, /Nothing was written/);
    assert.match(e.message, /run_batch/);
    assert.match(e.message, /run_batch instead of as many calls/);
    return true;
  });
  holder.release();
  (await a).release();
  (await b).release();
});

await check("waiting too long is reported as its own diagnosis, not as a bridge failure", async () => {
  const q = new WriteQueue({ maxWaitMs: 30 });
  const holder = await q.acquire("run_batch");
  // The queue's own timers are unref'd — a write waiting on a batch must never
  // be the reason a shutting-down process stays alive — so nothing here would
  // hold the event loop open while we wait for that timer to fire.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(q.acquire("set_transform"), (e) => {
      assert.ok(e instanceof WriteQueueWaitError);
      assert.match(e.message, /waited 0s behind `run_batch`/);
      return true;
    });
  } finally {
    clearTimeout(keepAlive);
  }
  holder.release();
});

await check("the three failure diagnoses share no remedy", () => {
  const queued = new WriteQueueWaitError("set_transform", 600_000, "run_batch");
  const timeout = new BridgeTimeoutError(7777, 300_000, { op: "run_batch" });
  const unreachable = new BridgeUnreachableError(7777, new Error("ECONNREFUSED"));

  // The bridge timeout forbids re-sending, because the call did reach AE and
  // may still be running. The queue wait requires the opposite advice: the call
  // never left the server, so re-sending is the correct move.
  assert.match(timeout.message, /Do not re-send/i);
  assert.match(queued.message, /re-sending this call is safe/i);
  assert.match(queued.message, /nothing in the project was changed/i);
  assert.match(queued.message, /neither a lost connection nor a busy bridge/i);
  assert.match(queued.message, /AE_MCP_WRITE_QUEUE_WAIT_MS/);
  assert.match(queued.message, /run_batch/, "it must name what it waited behind");

  // And it must not be mistakable for either of the other two.
  assert.doesNotMatch(queued.message, /Cannot reach the After Effects panel at/);
  assert.doesNotMatch(queued.message, /did not answer within/);
  assert.doesNotMatch(queued.message, /setup_panel/);
  assert.doesNotMatch(timeout.message, /write queue/i);
  assert.doesNotMatch(unreachable.message, /write queue/i);
});

// ---------------------------------------------------------------------------
// The trap: the op timeout must be measured from execution, not from enqueue.
//
// Run against a real HTTP server on an ephemeral port so it goes through the
// actual HttpClient/AbortSignal path rather than a re-implementation of it.
// Never port 7777 — the live panel holds that.
// ---------------------------------------------------------------------------

const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { op } = JSON.parse(body || "{}");
    await sleep(200);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { echoed: op } }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;
assert.notEqual(stubPort, 7777, "must not bind the panel's port");

await check("a queued call gets its full timeout budget, measured from execution", async () => {
  // 700ms budget; the stub answers in 200ms. The call in front holds the lock
  // for 900ms — well past the budget. If the clock started at enqueue, the
  // queued call would blow its timeout having never run and report a bridge
  // failure for a bridge that was answering fine.
  process.env.AE_MCP_OP_TIMEOUT_MS = "700";
  try {
    const q = new WriteQueue();
    const client = new HttpClient(stubPort);

    const holder = await q.acquire("run_batch");
    const queued = (async () => {
      const lease = await q.acquire("set_transform");
      try { return await client.runOp("set_transform", {}); }
      finally { lease.release(); }
    })();

    await sleep(900);
    holder.release();

    const result = await queued;
    assert.deepEqual(result, { echoed: "set_transform" });
  } finally {
    delete process.env.AE_MCP_OP_TIMEOUT_MS;
  }
});

await check("the timeout still fires for a call that really is too slow", async () => {
  process.env.AE_MCP_OP_TIMEOUT_MS = "50";
  try {
    const client = new HttpClient(stubPort);
    await assert.rejects(client.runOp("set_transform", {}), (e) => e instanceof BridgeTimeoutError);
  } finally {
    delete process.env.AE_MCP_OP_TIMEOUT_MS;
  }
});

await new Promise((r) => stub.close(r));

console.log(`write-queue: ${passed} checks passed`);
