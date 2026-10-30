// cancel_job and await_job against jobs that do not behave (issues #158, #159).
//
// #158: cancel_job answered `{ok:true}` whatever the panel said — even when the
// /cancel request never reached it — and settled the job as cancelled with no
// result, so the panel's later `complete` event (the batch stopping, with the
// ops it ran) either overwrote `cancelled` with `completed` or was lost.
// #159: await_job on an id this process never registered parked for the full
// ten-minute default and then timed out with a message that did not say the
// job might still be running.
//
// The manager is checked on its own, then the real MCP server is driven over
// an in-memory transport against a stub bridge whose /cancel answer each check
// chooses.
//
//   node tests/unit/job-cancel.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));
const { JobManager } = await import(dist("jobs", "manager.js"));

let passed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The manager.
// ---------------------------------------------------------------------------

// A terminal state is sticky: a late complete() must not turn `cancelled`
// back into `completed`, nor drop the result the cancel recorded.
{
  const jobs = new JobManager();
  jobs.register("j_sticky", 10);
  jobs.cancel("j_sticky", { partialFiles: ["a.mov"] });
  assert.equal(jobs.complete("j_sticky", { rendered: [] }), false, "complete() on a cancelled job must report it did nothing");
  jobs.fail("j_sticky", "late failure");
  const st = jobs.get("j_sticky");
  assert.equal(st.status, "cancelled", "a late complete()/fail() overwrote a cancelled job");
  assert.deepEqual(st.result, { partialFiles: ["a.mov"] }, "the cancel's partial result was replaced");
  assert.equal(st.error, undefined);
  passed++;
}

// A batch that stops on a cancel reports itself complete with cancelled:true.
// That settles it as cancelled, result kept — and a cancelling job that ran
// to the end anyway settles as completed and says so.
{
  const jobs = new JobManager();
  jobs.register("j_stop", 600);
  assert.equal(jobs.markCancelling("j_stop"), true);
  assert.equal(jobs.get("j_stop").status, "cancelling");
  const waiting = jobs.waitFor("j_stop", 5000);
  jobs.complete("j_stop", { results: [1, 2, 3], errors: [], cancelled: true, undoSteps: 1 });
  const st = await waiting;
  assert.equal(st.status, "cancelled");
  assert.deepEqual(st.result.results, [1, 2, 3], "the partial result must survive the cancel");

  jobs.register("j_late", 600);
  jobs.markCancelling("j_late");
  jobs.complete("j_late", { results: [1], errors: [] });
  assert.equal(jobs.get("j_late").status, "completed");
  assert.match(jobs.get("j_late").message, /too late/);
  assert.equal(jobs.markCancelling("j_late"), false, "a finished job cannot be marked cancelling");
  passed++;
}

// An unknown id fails at once; a timeout and an abort release only the wait,
// say the job is still running, and leave no waiter behind.
{
  const jobs = new JobManager();
  const t0 = Date.now();
  await assert.rejects(jobs.waitFor("j_nope"), /No job "j_nope" in this server process/);
  assert.ok(Date.now() - t0 < 500, "an unknown id must not wait");

  jobs.register("j_wait", 10);
  await assert.rejects(jobs.waitFor("j_wait", 30), /STILL RUNNING[\s\S]*Do not re-send/);
  assert.equal(jobs.waiterCount("j_wait"), 0, "a timed-out waiter was left registered");

  const ac = new AbortController();
  const w = jobs.waitFor("j_wait", 60_000, ac.signal);
  assert.equal(jobs.waiterCount("j_wait"), 1);
  ac.abort();
  await assert.rejects(w, /cancelled by the client[\s\S]*still running/);
  assert.equal(jobs.waiterCount("j_wait"), 0, "an aborted waiter was left registered");
  assert.equal(jobs.get("j_wait").status, "running", "aborting a wait must not touch the job");

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(jobs.waitFor("j_wait", 60_000, pre.signal), /cancelled by the client/);
  passed++;
}

// ---------------------------------------------------------------------------
// The server, against a stub bridge never on 7777.
// ---------------------------------------------------------------------------

/** What the stub answers on /cancel: [httpStatus, body]. */
let cancelReply = [200, { ok: true, result: { ok: true } }];
let cancelsSeen = 0;
/** The jobId the stub's run_batch answers with. */
let nextJobId = null;

const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/cancel") {
      cancelsSeen++;
      const [status, payload] = cancelReply;
      res.statusCode = status;
      res.end(JSON.stringify(payload));
      return;
    }
    const { op, args } = JSON.parse(body || "{}");
    if (op === "run_batch") {
      // The id each check chose, so it can name the job it is cancelling. A
      // current panel hands the batch to the server to drive (#243).
      res.end(JSON.stringify({ ok: true, result: { jobId: nextJobId, async: true, total: 600, chunkSize: 25, driver: "server" } }));
      return;
    }
    if (op === "_continue_job") {
      res.end(JSON.stringify({ ok: true, result: await nextChunk(args.jobId) }));
      return;
    }
    res.end(JSON.stringify({ ok: true, result: { ok: true, op } }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

// The server drives every batch (issue #243): it sends `_continue_job` and the
// stub holds each one until a check says what that chunk answers. `emit`
// keeps the shape of the events the panel used to broadcast.
const scripted = new Map();
const waiting = new Map();
function nextChunk(jobId) {
  const q = scripted.get(jobId);
  if (q && q.length) return Promise.resolve(q.shift());
  return new Promise((resolve) => {
    if (!waiting.has(jobId)) waiting.set(jobId, []);
    waiting.get(jobId).push(resolve);
  });
}
function emit(evt) {
  const step =
    evt.type === "progress"
      ? { done: false, jobId: evt.jobId, progress: evt.progress, total: evt.total }
      : { done: true, jobId: evt.jobId, ...evt.result };
  const w = waiting.get(evt.jobId);
  if (w && w.length) w.shift()(step);
  else {
    if (!scripted.has(evt.jobId)) scripted.set(evt.jobId, []);
    scripted.get(evt.jobId).push(step);
  }
}

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer({ cancelSettleMs: 300 });
const client = new Client({ name: "job-cancel-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
for (let i = 0; i < 100 && wss.clients.size === 0; i++) await sleep(10);
assert.equal(wss.clients.size, 1, "the server never connected to the stub's /events");

const call = (name, args) => client.callTool({ name, arguments: args });
const text = (res) => res.content.map((c) => c.text).join("\n");
const payload = (res) => JSON.parse(res.content[0].text);

async function batch(jobId) {
  nextJobId = jobId;
  const res = await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });
  assert.ok(!res.isError, text(res));
  assert.equal(payload(res).jobId, jobId);
}
/** Settle a job so the write lease it holds is released for the next check. */
async function finish(jobId) {
  emit({ type: "complete", jobId, result: { results: [], errors: [] } });
  for (let i = 0; i < 100; i++) {
    const st = payload(await call("get_job", { jobId }));
    if (st && st.status !== "running" && st.status !== "cancelling") return st;
    await sleep(10);
  }
  throw new Error(`${jobId} never settled`);
}

// await_job / cancel_job on an id this process never made: fail at once.
{
  const t0 = Date.now();
  const res = await call("await_job", { jobId: "j_from_last_week" });
  assert.ok(Date.now() - t0 < 2000, "await_job on an unknown id waited");
  assert.equal(res.isError, true);
  assert.match(text(res), /No job "j_from_last_week" in this server process/);

  const before = cancelsSeen;
  const c = await call("cancel_job", { jobId: "j_from_last_week" });
  assert.equal(c.isError, true);
  assert.match(text(c), /Nothing was cancelled/);
  assert.equal(cancelsSeen, before, "an unknown job must not be cancelled on the panel");

  // get_job used to answer a bare `null` here (#163) — the same id, the same story.
  const g = await call("get_job", { jobId: "j_from_last_week" });
  assert.equal(g.isError, true, `get_job on an unknown id answered: ${text(g)}`);
  assert.match(text(g), /No job "j_from_last_week" in this server process/);
  assert.doesNotMatch(text(g), /^null$/);
  passed++;
}

// The panel answers the cancel with an error: not ok, and the job is left
// running — it was never told to stop.
{
  await batch("j_refused");
  cancelReply = [500, { ok: false, error: "evalScript blew up" }];
  const res = await call("cancel_job", { jobId: "j_refused" });
  assert.equal(res.isError, true, `a refused cancel was reported as success: ${text(res)}`);
  assert.match(text(res), /NOT confirmed[\s\S]*evalScript blew up/);
  assert.equal(payload(await call("get_job", { jobId: "j_refused" })).status, "running");
  await finish("j_refused");
  passed++;
}

// The panel accepts; the batch stops at the next chunk and reports what ran.
// ok:true, with how far it got, and await_job returns the partial result —
// and a late `complete` without the flag cannot overwrite it.
{
  await batch("j_stops");
  cancelReply = [200, { ok: true, result: { ok: true } }];
  const pending = call("cancel_job", { jobId: "j_stops" });
  await sleep(30);
  // A chunk's progress landing after the cancel was accepted must not hide
  // the cancel's message.
  emit({ type: "progress", jobId: "j_stops", progress: 50, total: 600, message: "running" });
  await sleep(30);
  const mid = payload(await call("get_job", { jobId: "j_stops" }));
  assert.equal(mid.status, "cancelling");
  assert.match(mid.message, /cancel accepted/, "late progress overwrote the cancelling message");
  // A non-transactional batch keeps a failed op in `errors`, not `results`.
  emit({
    type: "complete",
    jobId: "j_stops",
    result: { results: [1, 2, 3], errors: [{ index: 3, op: "x", error: "boom" }], total: 600, cancelled: true, undoSteps: 1 },
  });
  const res = await pending;
  assert.ok(!res.isError, text(res));
  const p = payload(res);
  assert.equal(p.ok, true);
  assert.equal(p.status, "cancelled");
  assert.equal(p.opsRun, 4, "opsRun must count failed ops too");
  assert.equal(p.opsSucceeded, 3);
  assert.equal(p.opsFailed, 1);

  // A second cancel: an error that says the job is over, not that it may be running.
  const again = await call("cancel_job", { jobId: "j_stops" });
  assert.equal(again.isError, true);
  assert.match(text(again), /already over — it had been cancelled[\s\S]*nothing is running/);
  assert.doesNotMatch(text(again), /may still be running|NOT confirmed/);

  const awaited = payload(await call("await_job", { jobId: "j_stops" }));
  assert.equal(awaited.status, "cancelled");
  assert.deepEqual(awaited.result.results, [1, 2, 3], "await_job lost the cancelled batch's partial result");

  emit({ type: "complete", jobId: "j_stops", result: { results: [], errors: [] } });
  await sleep(50);
  assert.equal(payload(await call("get_job", { jobId: "j_stops" })).status, "cancelled", "a late complete overwrote cancelled");
  passed++;
}

// The panel accepts but the stop is not seen in time: not ok, status
// cancelling. Then the batch turns out to have run to the end.
{
  await batch("j_slow");
  const res = await call("cancel_job", { jobId: "j_slow" });
  assert.ok(!res.isError, text(res));
  const p = payload(res);
  assert.equal(p.ok, false, "a cancel whose stop was never seen was reported ok");
  assert.equal(p.status, "cancelling");
  const st = await finish("j_slow");
  assert.equal(st.status, "completed");
  assert.match(st.message, /too late/);
  passed++;
}

// The panel answers but holds no such job (AE restarted): an error, and the
// job is settled as failed so await_job does not wait out its timeout.
{
  await batch("j_lost");
  cancelReply = [200, { ok: true, result: { ok: false, error: "No such job" } }];
  const res = await call("cancel_job", { jobId: "j_lost" });
  assert.equal(res.isError, true);
  assert.match(text(res), /no record of batch j_lost/);
  const aw = await call("await_job", { jobId: "j_lost" });
  assert.equal(aw.isError, true);
  assert.match(text(aw), /no record of batch j_lost/);
  // Answer the chunk the driver is still waiting on, so it lets go of the
  // write lease for the next check.
  emit({ type: "complete", jobId: "j_lost", result: { results: [], errors: [] } });
  passed++;
}

// A job that already finished is not "cancelled" after the fact.
{
  cancelReply = [200, { ok: true, result: { ok: true } }];
  await batch("j_done");
  await finish("j_done");
  const before = cancelsSeen;
  const res = await call("cancel_job", { jobId: "j_done" });
  assert.equal(res.isError, true);
  assert.match(text(res), /already over — it had completed[\s\S]*nothing is running/);
  assert.doesNotMatch(text(res), /may still be running|NOT confirmed/);
  assert.equal(cancelsSeen, before);
  passed++;
}

await client.close();
for (const ws of wss.clients) ws.terminate();
wss.close();
bridge.close();
console.log(`job-cancel: ${passed} checks passed`);
process.exit(0);
