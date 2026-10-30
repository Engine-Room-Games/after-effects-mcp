// A chunked run_batch driven by the server (issue #220, stage 5).
//
// The panel used to send every `_continue_job` itself and report over a
// WebSocket; on a panel listing `server-drives-jobs` the server sends them, one
// per chunk under the batch's own write lease. What that buys is that progress,
// cancel and the job's state are the server's. What it costs is that a dead
// server stops the batch at a chunk boundary — so most of this file is about
// stopping truthfully: saying how far it got, never running an op twice, never
// resuming a batch silently.
//
// Two halves. The first drives `BatchDriver` in-process against a fake
// ExtendScript job table with faults injected per chunk. The second is real
// server processes, spawned from dist/index.js and sharing one front desk and
// one fake panel that keeps a job table the way batch.jsx does — including a
// desk leader killed with a chunk at After Effects, and the batch's own server
// killed mid-batch.
//
// Nothing here touches port 7777 or the real ~/.engineroom-ae-mcp.
//
//   node tests/unit/batch-driver.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const serverEntry = path.join(root, "packages", "mcp-server", "dist", "index.js");

const { BatchDriver, foreignJobText, readAeJobRecord } = await import(dist("jobs", "batchDriver.js"));
const { JobManager } = await import(dist("jobs", "manager.js"));
const errors = await import(dist("util", "errors.js"));
const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));
const { CAP_SERVER_DRIVES_JOBS } = await import(dist("setup", "panelCapabilities.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const keepAlive = setInterval(() => {}, 1000);
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, cond, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ===========================================================================
// A job table that behaves like batch.jsx's: the cursor is After Effects'.
// ===========================================================================

class AeJobs {
  constructor() {
    this.jobs = new Map();
    this.seq = 0;
    /** jobId -> per-op run counts. */
    this.ran = new Map();
  }
  start(total, opts = {}) {
    const jobId = `j_${Date.now()}_${++this.seq}`;
    this.jobs.set(jobId, {
      cursor: 0, total, results: [], errors: [], undo: 0, cancelled: false, finished: false,
      failAt: opts.failAt, warnAt: opts.warnAt ?? {}, touchedAt: Date.now(),
    });
    this.ran.set(jobId, new Array(total).fill(0));
    return { jobId, async: true, total, chunkSize: 25 };
  }
  chunk(jobId, size) {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`No job: ${jobId}`);
    if (j.finished) throw new Error(`Job ${jobId} has already finished; its result was delivered when it did.`);
    j.touchedAt = Date.now();
    if (j.cancelled) {
      j.finished = true;
      return { done: true, cancelled: true, jobId, results: [...j.results], errors: [...j.errors], undoSteps: j.undo, undoGroupName: "B", note: "stopped" };
    }
    const end = Math.min(j.cursor + size, j.total);
    j.undo++;
    const warns = [];
    for (; j.cursor < end; j.cursor++) {
      if (j.failAt === j.cursor) {
        j.errors.push({ index: j.cursor, op: "touch", error: "boom" });
        j.finished = true;
        j.failed = true;
        const out = { done: true, failed: true, jobId, error: "boom", atIndex: j.cursor, results: [...j.results], errors: [...j.errors], undoSteps: j.undo, note: "Nothing was rolled back." };
        if (warns.length) out.aeWarnings = warns;
        return out;
      }
      this.ran.get(jobId)[j.cursor]++;
      j.results.push({ i: j.cursor });
      if (j.warnAt[j.cursor]) warns.push(j.warnAt[j.cursor]);
    }
    let out;
    if (j.cursor >= j.total) {
      j.finished = true;
      out = { done: true, jobId, results: [...j.results], errors: [...j.errors], total: j.total, undoSteps: j.undo, undoGroupName: "B", note: `${j.undo} undo steps` };
    } else {
      out = { done: false, jobId, progress: j.cursor, total: j.total, undoSteps: j.undo };
    }
    if (warns.length) out.aeWarnings = warns;
    return out;
  }
  record(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    return { cursor: j.cursor, total: j.total, finished: j.finished, cancelled: j.cancelled, abandoned: false, failed: !!j.failed, errorCount: j.errors.length, undoSteps: j.undo, idleMs: Date.now() - j.touchedAt };
  }
  cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return { known: false, error: "No such job" };
    if (!j.finished) j.cancelled = true;
    return { known: true };
  }
  /** Every op ran exactly once, up to `through`, and none after it. */
  assertOnce(jobId, through) {
    const counts = this.ran.get(jobId);
    for (let i = 0; i < counts.length; i++) {
      assert.equal(counts[i], i < through ? 1 : 0, `op ${i} ran ${counts[i]} times (expected ${i < through ? 1 : 0})`);
    }
  }
}

/** A driver bridge over `ae`, with a fault per chunk number (1-based). */
function bridgeOver(ae, fault = () => null) {
  const b = {
    chunks: 0,
    cancels: [],
    reads: 0,
    async continueJob(jobId, size) {
      const n = ++b.chunks;
      const f = fault(n);
      if (f === "lost-before") throw new errors.FrontDeskLostError(1, "_continue_job", "exited");
      if (f === "place-lost") throw new errors.DeskPlaceLostError("_continue_job", "the desk changed hands and the lease could not be re-taken.");
      if (f === "unreachable") throw new errors.BridgeUnreachableError(1, new Error("ECONNREFUSED"));
      const r = structuredClone(ae.chunk(jobId, size));
      if (f === "lost-after") throw new errors.FrontDeskLostError(1, "_continue_job", "stalled");
      if (f === "timeout") throw new errors.BridgeTimeoutError(1, 300_000, { op: "_continue_job" });
      if (f === "bad-json") throw new errors.AeError("Bad JSON from ExtendScript");
      if (f === "abandoned") {
        throw new errors.AeError(
          `Job ${jobId} was abandoned: no continuation reached it for 30 minutes, so its record was freed. ` +
            "25 of 300 ops had been attempted, in 1 undo step(s); they stay applied. Nothing ran now."
        );
      }
      return r;
    },
    async getJob(jobId) {
      b.reads++;
      return ae.record(jobId);
    },
    async cancel(jobId) {
      b.cancels.push(jobId);
      return ae.cancel(jobId);
    },
  };
  return b;
}

function setup(total, fault, opts) {
  const ae = new AeJobs();
  const jobs = new JobManager();
  const bridge = bridgeOver(ae, fault);
  const driver = new BatchDriver(jobs, bridge);
  const env = ae.start(total, opts);
  jobs.register(env.jobId, env.total);
  const progress = [];
  jobs.bindProgressEmitter(env.jobId, (_id, p, t) => progress.push([p, t]));
  return { ae, jobs, bridge, driver, env, progress };
}

// ===========================================================================
// In-process
// ===========================================================================

await check("drives to the end: one chunk per call, progress per chunk, the final progress exact (#222)", async () => {
  const { ae, jobs, bridge, driver, env, progress } = setup(610);
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "completed");
  assert.equal(st.progress, 610, "the terminal state says where the job ended, not the last boundary before it");
  assert.equal(st.total, 610);
  assert.equal(st.result.results.length, 610);
  assert.equal(st.result.undoSteps, 25);
  assert.equal(st.result.cancelled, false);
  assert.equal(bridge.chunks, 25, "ceil(610/25) chunks, each its own call");
  assert.deepEqual(progress.map(([p]) => p), [...Array.from({ length: 24 }, (_, i) => (i + 1) * 25), 610], "the last notification is the full count (#239 live check)");
  ae.assertOnce(env.jobId, 610);
  assert.deepEqual(driver.running, [], "nothing left running");
});

await check("After Effects' warnings from every chunk reach the result (#225)", async () => {
  const { jobs, driver, env } = setup(100, undefined, { warnAt: { 30: "Missing font: Inter", 80: "Expression disabled" } });
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.deepEqual(st.result.aeWarnings, ["Missing font: Inter", "Expression disabled"]);
});

await check("a transactional failure: the job fails where it stopped, with the note and the warnings", async () => {
  const { jobs, driver, env, bridge } = setup(200, undefined, { failAt: 60, warnAt: { 10: "Missing font: Inter" } });
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.equal(st.progress, 61, "60 ops succeeded and the 61st failed: 61 attempted");
  assert.match(st.error, /^boom \|\| Nothing was rolled back\. \|\| After Effects also reported.*Missing font: Inter/);
  assert.equal(bridge.chunks, 3, "no chunk after the failing one");
});

await check("cancel between chunks: the next chunk collects the partial result, nothing after it runs", async () => {
  const { ae, jobs, driver, env } = setup(600);
  const orig = ae.chunk.bind(ae);
  let n = 0;
  ae.chunk = (id, size) => {
    const r = orig(id, size);
    // cancel_job lands while chunk 3 runs, as it does on the panel's chain.
    if (++n === 3) {
      jobs.markCancelling(id);
      ae.cancel(id);
    }
    return r;
  };
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "cancelled");
  assert.equal(st.progress, 75);
  assert.equal(st.result.results.length, 75);
  ae.assertOnce(env.jobId, 75);
});

await check("an answer lost on the way back: carries on from After Effects' cursor, nothing twice, and says so", async () => {
  const { ae, jobs, bridge, driver, env } = setup(300, (n) => (n === 4 ? "lost-after" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "completed", st.error);
  assert.equal(st.progress, 300);
  ae.assertOnce(env.jobId, 300);
  assert.equal(bridge.reads, 1, "After Effects' record was read once");
  assert.match(st.warning, /One chunk's answer was lost on the way back .*carried on from op 101.*\(25 op\(s\) of that chunk had run\); no op was sent twice/);
});

await check("a chunk lost before it reached After Effects: the cursor has not moved, and the same ops go next", async () => {
  const { ae, jobs, driver, env } = setup(300, (n) => (n === 2 ? "lost-before" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "completed", st.error);
  ae.assertOnce(env.jobId, 300);
  assert.match(st.warning, /carried on from op 26.*\(0 op\(s\) of that chunk had run\)/);
});

await check("the last chunk's answer lost: the job is over in After Effects and says so, with its counts", async () => {
  const { ae, jobs, driver, env } = setup(100, (n) => (n === 4 ? "lost-after" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.equal(st.progress, 100);
  assert.match(st.error, /ran to its end in After Effects, but the answer to its last chunk was lost .* 100 of 100 ops attempted, 0 of them failed, in 4 undo step\(s\).*Do NOT re-run/s);
  ae.assertOnce(env.jobId, 100);
});

await check("a chunk that timed out: no further chunk, the job says which ops may have run, and the job is cancelled", async () => {
  const { ae, jobs, bridge, driver, env } = setup(300, (n) => (n === 3 ? "timeout" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.equal(bridge.chunks, 3);
  assert.equal(st.progress, 50, "a lower bound: two chunks are known to have run");
  assert.match(st.message, /at least 50 of 300 ops ran; the failing chunk \(ops 51–75\) may have partly run/);
  assert.match(st.error, /a chunk did not answer in time and may still be running in After Effects/);
  assert.match(st.error, /50 of 300 ops had already been attempted, in 2 undo step\(s\)/);
  assert.match(st.error, /Do NOT re-run the batch as it was/);
  assert.deepEqual(bridge.cancels, [env.jobId], "cancelled, so no later continuation can run more of it");
  assert.equal(ae.jobs.get(env.jobId).cancelled, true);
});

await check("an error after the chunk ran (Bad JSON) is a may-have-run, never a 'nothing ran'", async () => {
  const { jobs, driver, env } = setup(300, (n) => (n === 2 ? "bad-json" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.match(st.message, /may have partly run/);
});

await check("a job ExtendScript retired as abandoned ran nothing more: no 'may have partly run'", async () => {
  // Thrown in place of chunk 2, before it touches the table: what batch.jsx does.
  const { jobs, driver, env } = setup(300, (n) => (n === 2 ? "abandoned" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.match(st.error, /was abandoned: .*Nothing ran now/);
  assert.equal(st.message, "failed after 25 of 300 ops attempted", st.message);
});

await check("a transactional failure in the last chunk whose answer was lost is not called 'ran to its end'", async () => {
  const { jobs, driver, env } = setup(100, (n) => (n === 4 ? "lost-after" : null), { failAt: 90 });
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.match(st.error, /failed in its last chunk in After Effects/);
  assert.doesNotMatch(st.error, /ran to its end/);
  assert.match(foreignJobText(env.jobId, readAeJobRecord({ cursor: 90, total: 100, finished: true, failed: true })), /stopped on a failed op/);
});

await check("the bundle reloaded under the job: says so, and what had landed", async () => {
  const { ae, jobs, driver, env } = setup(300);
  const orig = ae.chunk.bind(ae);
  let n = 0;
  ae.chunk = (id, size) => {
    if (++n === 3) ae.jobs.delete(id);
    return orig(id, size);
  };
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.match(st.error, /bundle was reloaded in After Effects/);
  assert.match(st.error, /50 of 300 ops had already been attempted, in 2 undo step/);
  assert.equal(st.progress, 50);
  assert.doesNotMatch(st.message, /may have partly run/, "a job that is gone ran nothing more");
});

await check("the lease lost for good: the chunk is refused unsent and the batch stops exactly there", async () => {
  const { ae, jobs, driver, env, bridge } = setup(300, (n) => (n === 3 ? "place-lost" : null));
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.equal(st.message, "failed after 50 of 300 ops attempted");
  assert.doesNotMatch(st.error, /re-sending this call is safe/, "a single call's remedy is not the batch's");
  ae.assertOnce(env.jobId, 50);
  assert.equal(bridge.reads, 0, "nothing to recover: it was never sent");
});

await check("stopAll (the session is closing): the next chunk is never sent", async () => {
  const { ae, jobs, driver, env, bridge } = setup(300);
  const orig = ae.chunk.bind(ae);
  let n = 0;
  ae.chunk = (id, size) => {
    if (++n === 2) driver.stopAll("this server is closing.");
    return orig(id, size);
  };
  await driver.drive(env);
  const st = jobs.get(env.jobId);
  assert.equal(st.status, "failed");
  assert.equal(bridge.chunks, 2);
  assert.match(st.error, /this server is closing\. The next chunk was not sent\. 50 of 300 ops/);
  assert.deepEqual(bridge.cancels, [env.jobId]);
  ae.assertOnce(env.jobId, 50);
});

await check("a job settled elsewhere (cancel_job found it lost) is not driven further", async () => {
  const { ae, jobs, driver, env, bridge } = setup(300);
  const orig = ae.chunk.bind(ae);
  ae.chunk = (id, size) => {
    jobs.fail(id, "lost");
    return orig(id, size);
  };
  await driver.drive(env);
  assert.equal(bridge.chunks, 1);
  assert.equal(jobs.get(env.jobId).error, "lost");
});

await check("a job id this process never started is described from After Effects' record, never claimed as running", () => {
  assert.equal(readAeJobRecord(null), null);
  assert.equal(readAeJobRecord({ tag: "x" }), null);
  const open = foreignJobText("j_1_2", readAeJobRecord({ cursor: 100, total: 600, finished: false, errorCount: 0, undoSteps: 4, idleMs: 90_000 }));
  assert.match(open, /After Effects holds it, unfinished: 100 of 600 ops attempted, 0 failed, in 4 undo step\(s\)\. Its last chunk started or ended 90s ago/);
  assert.match(open, /Nothing in this process will continue it/);
  const gone = foreignJobText("j_1_2", readAeJobRecord({ cursor: 25, total: 600, finished: true, abandoned: true }));
  assert.match(gone, /was abandoned/);
  const done = foreignJobText("j_1_2", readAeJobRecord({ cursor: 600, total: 600, finished: true }));
  assert.match(done, /has finished\. 600 of 600 ops attempted/);
});

// ===========================================================================
// Processes: a fake panel with a job table, real servers, one front desk
// ===========================================================================

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-batch-driver-"));
const deskDir = path.join(home, ".engineroom-ae-mcp");
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const readDesk = (port) => {
  try { return JSON.parse(fs.readFileSync(path.join(deskDir, `desk-${port}.json`), "utf8")); } catch { return null; }
};

const ae = new AeJobs();
/** Every op the fake panel ran, in order. */
const seen = [];
const runBatchArgs = [];
const cancels = [];
let chain = Promise.resolve();
let chunkMs = 30;
let echoDriver = true;
/** `{jobId, n, release}`: hold that job's n-th chunk at the panel until released. */
let hold = null;
const chunkCount = new Map();

const panel = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: panelPort, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash(), capabilities: ["project-path", CAP_SERVER_DRIVES_JOBS] }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const answer = (result) => {
      try {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch {}
    };
    if (req.url === "/cancel") {
      cancels.push(parsed.jobId);
      chain = chain.then(() => {
        const c = ae.cancel(parsed.jobId);
        answer({ ok: true, result: c.known ? { ok: true } : { ok: false, error: c.error } });
      });
      return;
    }
    const { op, args } = parsed;
    // One at a time, like the real panel's evalScript chain.
    chain = chain.then(async () => {
      // run_jsx arrives as `_run_jsx`, with the server-built wrapper (#220, #243).
      const jsxSource = op === "run_jsx" || op === "_run_jsx" ? String(args.code ?? args.built?.wrapper ?? "") : null;
      const tag = jsxSource !== null ? /tag:(\w+)/.exec(jsxSource)?.[1] : op;
      const entry = { op, tag, jobId: args?.jobId, enteredAt: Date.now() };
      seen.push(entry);
      try {
        let result;
        if (op === "run_batch") {
          runBatchArgs.push(args);
          const env = ae.start(args.ops.length);
          if (echoDriver && args.__driver === "server") {
            result = { ...env, undoStepsEstimate: Math.ceil(env.total / 25), undoGroupName: "B", note: "chunks", driver: "server" };
          } else {
            // An older panel: drives its own job and reports over /events.
            result = env;
            setTimeout(async () => {
              for (;;) {
                const r = ae.chunk(env.jobId, 25);
                if (r.done) {
                  for (const c of wss.clients) c.send(JSON.stringify({ type: "complete", jobId: env.jobId, result: r }));
                  return;
                }
                for (const c of wss.clients) c.send(JSON.stringify({ type: "progress", jobId: env.jobId, progress: r.progress, total: r.total }));
                await sleep(5);
              }
            }, 20);
          }
        } else if (op === "_continue_job") {
          const n = (chunkCount.get(args.jobId) ?? 0) + 1;
          chunkCount.set(args.jobId, n);
          entry.n = n;
          if (hold && hold.jobId === args.jobId && hold.n === n) await hold.released;
          await sleep(chunkMs);
          result = ae.chunk(args.jobId, args.chunkSize);
        } else if (op === "_get_job") {
          result = ae.record(args.jobId);
        } else if (jsxSource !== null) {
          await sleep(Number(/ms:(\d+)/.exec(jsxSource)?.[1] ?? 5));
          result = { tag };
        } else {
          result = [];
        }
        entry.leftAt = Date.now();
        answer({ ok: true, result });
      } catch (e) {
        entry.leftAt = Date.now();
        res.statusCode = 500;
        answer({ ok: false, error: e.message });
      }
    });
  });
});
const wss = new WebSocketServer({ server: panel, path: "/events" });
await new Promise((r) => panel.listen(0, "127.0.0.1", r));
const panelPort = panel.address().port;
assert.notEqual(panelPort, 7777);

const sessions = [];
async function startSession(name, deskPort) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AE_MCP_PORT: String(panelPort),
    AE_MCP_FRONT_DESK_PORT: String(deskPort),
    AE_MCP_FRONT_DESK_BEAT_MS: "200",
  };
  delete env.AE_MCP_FRONT_DESK;
  delete env.AE_MCP_OP_TIMEOUT_MS;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe" });
  let log = "";
  transport.stderr.on("data", (c) => {
    log += c.toString();
    if (process.env.BATCH_TEST_VERBOSE) process.stderr.write(`[${name}] ${c}`);
  });
  const client = new Client({ name, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  const s = { name, client, pid: transport.pid, log: () => log, alive: true };
  sessions.push(s);
  return s;
}
function kill(s) {
  s.alive = false;
  try { process.kill(s.pid, "SIGKILL"); } catch {}
}
async function stop(s) {
  s.alive = false;
  await s.client.close().catch(() => {});
}
function begin(s, name, args) {
  const progress = [];
  const done = s.client
    .callTool({ name, arguments: args }, undefined, { timeout: 60_000, onprogress: (p) => progress.push(p) })
    .then((res) => ({ res, progress, text: res.content?.[0]?.text ?? "", json: () => JSON.parse(res.content[0].text) }));
  return { progress, done };
}
const call = (s, name, args) => begin(s, name, args).done;
const batchOps = (n) => Array.from({ length: n }, () => ({ op: "list_comps", args: {} }));
const chunksOf = (jobId) => seen.filter((e) => e.op === "_continue_job" && e.jobId === jobId);
const ran = (tag) => seen.filter((e) => e.tag === tag);

try {
  const deskPort = await freePort();
  const A = await startSession("batch-A", deskPort);
  await until("A to run the desk", () => readDesk(deskPort)?.pid === A.pid);
  const B = await startSession("batch-B", deskPort);
  await until("B to join", () => /joined the desk/.test(B.log()));

  await check("the server drives a long batch: one chunk per call, progress on await_job, exact at the end", async () => {
    const rb = await call(A, "run_batch", { ops: batchOps(300) });
    assert.equal(rb.res.isError, undefined, rb.text);
    const env = rb.json();
    assert.equal(env.async, true);
    assert.equal(env.driver, undefined, "the panel's word to the server is not passed on to the agent");
    assert.equal(runBatchArgs.at(-1).__driver, "server", "the panel was asked to leave the driving to the server");
    const aw = begin(A, "await_job", { jobId: env.jobId });
    const r = await aw.done;
    assert.equal(r.res.isError, undefined, r.text);
    const st = r.json();
    assert.equal(st.status, "completed");
    assert.equal(st.progress, 300);
    assert.equal(st.result.results.length, 300);
    assert.equal(st.warning, undefined);
    assert.equal(chunksOf(env.jobId).length, 12);
    ae.assertOnce(env.jobId, 300);
    assert.ok(aw.progress.length >= 1, "await_job carried the batch's progress");
    assert.equal(aw.progress.at(-1).progress, 300, "the last notification on await_job is the full count, not one chunk short");
    assert.equal(aw.progress.at(-1).total, 300);
  });

  await check("another session's write waits for the whole server-driven batch, never between its chunks", async () => {
    chunkMs = 40;
    const rb = await call(A, "run_batch", { ops: batchOps(250) });
    const { jobId } = rb.json();
    const rw = await call(B, "run_jsx", { code: "// tag:B1 ms:5\nreturn 1;" });
    assert.equal(rw.res.isError, undefined, rw.text);
    const last = chunksOf(jobId).at(-1);
    assert.equal(chunksOf(jobId).length, 10);
    assert.ok(ran("B1")[0].enteredAt >= last.leftAt, "B1 reached After Effects before the batch's last chunk had run");
    assert.equal(rw.json().queuedBehind, "run_batch");
    chunkMs = 30;
  });

  await check("cancel_job stops a server-driven batch between chunks, with the partial result", async () => {
    chunkMs = 60;
    const rb = await call(A, "run_batch", { ops: batchOps(600) });
    const { jobId } = rb.json();
    await until("two chunks", () => chunksOf(jobId).filter((e) => e.leftAt).length >= 2);
    const rc = await call(A, "cancel_job", { jobId });
    assert.equal(rc.res.isError, undefined, rc.text);
    const c = rc.json();
    assert.equal(c.ok, true);
    assert.equal(c.status, "cancelled");
    const through = ae.jobs.get(jobId).cursor;
    assert.equal(c.opsRun, through);
    ae.assertOnce(jobId, through);
    const st = (await call(A, "get_job", { jobId })).json();
    assert.equal(st.status, "cancelled");
    assert.equal(st.progress, through);
    await sleep(200);
    assert.equal(ae.jobs.get(jobId).cursor, through, "nothing ran after the cancel");
    chunkMs = 30;
  });

  // Since #243 nothing follows a panel-driven job: a panel that drives its own
  // batch is an old one, and the agent is told so instead of handed a job id.
  await check("a panel that drives its own job is reported as out of date, and never sent a chunk", async () => {
    echoDriver = false;
    try {
      const rb = await call(A, "run_batch", { ops: batchOps(300) });
      assert.equal(rb.res.isError, true, rb.text);
      assert.match(rb.text, /older than these tools/);
      assert.match(rb.text, /setup_panel/);
      assert.match(rb.text, /must not be sent again/);
      assert.doesNotMatch(rb.text, /does not recognise/, "the panel did recognise run_batch: it started the batch");
      const jobId = [...ae.jobs.keys()].pop();
      await sleep(300);
      assert.equal(chunksOf(jobId).length, 0, "the server sent no chunk of a job the panel drives: never two drivers");
    } finally {
      echoDriver = true;
    }
  });

  await check("a server that closes mid-batch stops it at the next chunk boundary and cancels it", async () => {
    chunkMs = 60;
    const C = await startSession("batch-C", deskPort);
    await until("C to join", () => /joined the desk/.test(C.log()));
    const rb = await call(C, "run_batch", { ops: batchOps(600) });
    const { jobId } = rb.json();
    await until("two chunks", () => chunksOf(jobId).filter((e) => e.leftAt).length >= 2);
    await stop(C);
    await until("the cancel", () => cancels.includes(jobId), 5000);
    const atStop = chunksOf(jobId).length;
    await sleep(400);
    assert.equal(chunksOf(jobId).length, atStop, "no chunk after the close");
    const through = ae.jobs.get(jobId).cursor;
    ae.assertOnce(jobId, through);
    assert.ok(through < 600);
    // Another session asks about it: told how far it got, and that it is not this session's.
    const g = await call(A, "get_job", { jobId });
    assert.equal(g.res.isError, true);
    assert.match(g.text, new RegExp(`After Effects knows it: it stopped on a cancel|After Effects holds it, unfinished: ${through} of 600`));
    chunkMs = 30;
  });

  // ---- the desk leader dies while a follower's chunk is at After Effects ----
  await check("the desk dies with a follower's chunk at After Effects: the batch carries on from AE's cursor, nothing twice, nobody between its chunks", async () => {
    const desk2 = await freePort();
    const H = await startSession("batch-H", desk2);
    await until("H to run the desk", () => readDesk(desk2)?.pid === H.pid);
    const I = await startSession("batch-I", desk2);
    const J = await startSession("batch-J", desk2);
    await until("I and J to join", () => /joined the desk/.test(I.log()) && /joined the desk/.test(J.log()));

    // Hold the job's third chunk at the panel; the job id is the next one the table mints.
    let release;
    const released = new Promise((r) => (release = r));
    const nextId = () => [...ae.jobs.keys()].at(-1);
    const before = nextId();
    const pb = call(I, "run_batch", { ops: batchOps(300) });
    const jobId = await until("the job", () => (nextId() !== before ? nextId() : null));
    hold = { jobId, n: 3, released };
    const rb = await pb;
    assert.equal(rb.res.isError, undefined, rb.text);
    await until("chunk 3 at the panel", () => chunksOf(jobId).some((e) => e.n === 3));
    const hj = begin(J, "run_jsx", { code: "// tag:J1 ms:5\nreturn 1;" });
    await until("J to be queued behind the batch", () => hj.progress.length > 0);
    kill(H);
    // I has seen the desk go — its lease and the chunk in flight with it — and a new desk is up.
    await until("I to lose the desk and a new one to start", () =>
      /re-taking it at the next one/.test(I.log()) && [I.pid, J.pid].includes(readDesk(desk2)?.pid));
    release();
    const rj = await hj.done;
    assert.equal(rj.res.isError, undefined, rj.text);
    const st = (await call(I, "await_job", { jobId })).json();
    hold = null;
    assert.equal(st.status, "completed", JSON.stringify(st));
    assert.equal(st.progress, 300);
    ae.assertOnce(jobId, 300);
    assert.match(st.warning ?? "", /answer was lost on the way back.*no op was sent twice/s, st.warning);
    const last = chunksOf(jobId).at(-1);
    assert.ok(ran("J1")[0].enteredAt >= last.leftAt, "J1 slipped in between the batch's chunks across the handover");
    await stop(I);
    await stop(J);
  });

  // ---- the batch's own server dies ------------------------------------------
  await check("the batch's own server is killed: the batch stops there, nobody resumes it, and another session is told how far it got", async () => {
    chunkMs = 50;
    const desk3 = await freePort();
    const K = await startSession("batch-K", desk3);
    await until("K to run the desk", () => readDesk(desk3)?.pid === K.pid);
    const L = await startSession("batch-L", desk3);
    await until("L to join", () => /joined the desk/.test(L.log()));
    const rb = await call(L, "run_batch", { ops: batchOps(600) });
    const { jobId } = rb.json();
    await until("four chunks", () => chunksOf(jobId).filter((e) => e.leftAt).length >= 4);
    kill(L);
    // A write from another session goes through once the dead lease is gone.
    const rw = await call(K, "run_jsx", { code: "// tag:K1 ms:5\nreturn 1;" });
    assert.equal(rw.res.isError, undefined, rw.text);
    await sleep(300);
    const atStop = chunksOf(jobId).length;
    const through = ae.jobs.get(jobId).cursor;
    await sleep(500);
    assert.equal(chunksOf(jobId).length, atStop, "nothing resumed the batch");
    assert.equal(ae.jobs.get(jobId).cursor, through);
    assert.ok(through > 0 && through < 600);
    ae.assertOnce(jobId, through);
    for (const tool of ["get_job", "await_job"]) {
      const r = await call(K, tool, { jobId });
      assert.equal(r.res.isError, true);
      assert.match(r.text, new RegExp(`No job "${jobId}" in this server process, but After Effects holds it, unfinished: ${through} of 600 ops attempted`));
      assert.match(r.text, /Nothing in this process will continue it/);
    }
    await stop(K);
    chunkMs = 30;
  });
} finally {
  for (const s of sessions) if (s.alive) await stop(s);
  for (const s of sessions) try { process.kill(s.pid, "SIGKILL"); } catch {}
  wss.close();
  panel.closeAllConnections?.();
  await new Promise((r) => panel.close(r));
  fs.rmSync(home, { recursive: true, force: true });
  clearInterval(keepAlive);
}

console.log(`batch-driver: ${passed} checks passed`);
