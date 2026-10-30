// The last progress notification of a request reaches a real SDK client's
// `onprogress` (issue #261).
//
// The SDK client (@modelcontextprotocol/sdk, measured on 1.32.2) handles a
// notification one microtask after it is read, but a response at once — and
// handling the response deletes that request's progress handler. So when the
// final `notifications/progress` and the response arrive in the same read from
// the server's stdout, the notification finds no handler: `onprogress` never
// sees the 100%, and the client reports "Received a progress notification for
// an unknown token" to `onerror`. The server's order on the wire is right; the
// two messages simply arrived together.
//
// The server's answer (util/requestProgress.ts): after the last notification it
// sent for a request, it pings the client and waits for the answer before the
// response goes out. The client can only answer the ping after it has handled
// the notification read ahead of it.
//
// This drives the real server, spawned from dist/index.js over stdio, with the
// real SDK client, against a stub panel. Each run is a chunked `run_batch`
// whose final chunk is held at the panel until `await_job` is waiting on it, so
// the final progress is reported immediately before await_job answers.
//
// Whether two messages share a read depends on how busy the client is, so the
// client's transport here makes it certain: every progress notification is
// held and handed to the client in the same synchronous pass as the next
// message — what StdioClientTransport does with two messages in one chunk.
// Without the ping that next message is the response, and every run loses its
// final progress; with it, the next message is the ping. Checked as well:
// exactly one ping per call that sent progress and none on a call that did
// not; a client that never answers the ping still gets its result, about
// SETTLE_PING_TIMEOUT_MS late; one that refuses it gets its result at once;
// and a call cancelled while the ping is out stops waiting at once.
//
//   node tests/unit/progress-delivery.mjs
//   PROGRESS_RUNS=200 PROGRESS_COALESCE=0 PROGRESS_LOAD=10 node tests/unit/progress-delivery.mjs
//
// PROGRESS_COALESCE=0 leaves reads to the pipe (the natural race), and
// PROGRESS_LOAD spawns that many busy-loop processes, which is what makes the
// race show on an unfixed server.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));
const { CAP_SERVER_DRIVES_JOBS } = await import(dist("setup", "panelCapabilities.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const RUNS = Number(process.env.PROGRESS_RUNS ?? 40);
const LOAD = Number(process.env.PROGRESS_LOAD ?? 0);
const TOTAL = 50; // two chunks of 25
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stub panel: a server-driven run_batch whose last chunk waits for `release`.
// ---------------------------------------------------------------------------
const jobs = new Map();
let seq = 0;
/** jobId -> resolve, for the last chunk being held. */
const held = new Map();
const heldReady = new Map();
function holdLast(jobId) {
  let release;
  const p = new Promise((r) => (release = r));
  held.set(jobId, { p, release });
}

const panel = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: panelPort, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash(), capabilities: ["project-path", CAP_SERVER_DRIVES_JOBS] }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { op, args } = JSON.parse(body || "{}");
    const answer = (o) => {
      try {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(o));
      } catch {}
    };
    if (req.url === "/cancel") return answer({ ok: true, result: { ok: true } });
    if (op === "run_batch") {
      const jobId = `j_${Date.now()}_${++seq}`;
      jobs.set(jobId, { cursor: 0, total: args.ops.length, results: [], undo: 0, finished: false });
      holdLast(jobId);
      return answer({ ok: true, result: { jobId, async: true, total: args.ops.length, chunkSize: 25, undoStepsEstimate: 2, undoGroupName: "B", note: "chunks", driver: "server" } });
    }
    if (op === "_continue_job") {
      const j = jobs.get(args.jobId);
      const end = Math.min(j.cursor + args.chunkSize, j.total);
      if (end >= j.total) {
        heldReady.get(args.jobId)?.();
        await held.get(args.jobId).p;
      }
      j.undo++;
      for (; j.cursor < end; j.cursor++) j.results.push({ i: j.cursor });
      if (j.cursor >= j.total) {
        j.finished = true;
        return answer({ ok: true, result: { done: true, jobId: args.jobId, results: [...j.results], errors: [], total: j.total, undoSteps: j.undo, undoGroupName: "B", note: "done" } });
      }
      return answer({ ok: true, result: { done: false, jobId: args.jobId, progress: j.cursor, total: j.total, undoSteps: j.undo } });
    }
    if (op === "_get_job") {
      const j = jobs.get(args.jobId);
      return answer({ ok: true, result: j ? { cursor: j.cursor, total: j.total, finished: j.finished, cancelled: false, abandoned: false, failed: false, errorCount: 0, undoSteps: j.undo, idleMs: 0 } : null });
    }
    answer({ ok: true, result: [] });
  });
});
const wss = new WebSocketServer({ server: panel, path: "/events" });
await new Promise((r) => panel.listen(0, "127.0.0.1", r));
const panelPort = panel.address().port;
assert.notEqual(panelPort, 7777);

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}


const { PingRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
const { SETTLE_PING_TIMEOUT_MS } = await import(dist("util", "requestProgress.js"));
const COALESCE = process.env.PROGRESS_COALESCE !== "0";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-progress-delivery-"));
const deskPort = await freePort();

const burners = [];
for (let i = 0; i < LOAD; i++) {
  burners.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
}

const sessions = [];
/**
 * One server process and one SDK client. `ping`: "answer" (the SDK default),
 * "never" (a handler that does not return), "refuse" (a handler that throws),
 * or a function run on each ping that returns what the handler should.
 */
async function startSession(name, { ping = "answer", coalesce = COALESCE, debug = false } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AE_MCP_PORT: String(panelPort),
    AE_MCP_FRONT_DESK_PORT: String(deskPort),
  };
  delete env.AE_MCP_FRONT_DESK;
  delete env.AE_MCP_OP_TIMEOUT_MS;
  if (debug) env.AE_MCP_DEBUG = "1";
  else delete env.AE_MCP_DEBUG;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe" });
  const s = { name, transport, log: "", wire: [], sent: new Map(), errors: [] };
  transport.stderr.on("data", (c) => (s.log += c.toString()));
  const client = new Client({ name, version: "0" }, { capabilities: {} });
  client.onerror = (e) => s.errors.push(String(e?.message ?? e));
  if (ping === "never") client.setRequestHandler(PingRequestSchema, () => new Promise(() => {}));
  else if (ping === "refuse") client.setRequestHandler(PingRequestSchema, () => { throw new Error("no pings here"); });
  else if (typeof ping === "function") client.setRequestHandler(PingRequestSchema, ping);
  await client.connect(transport);
  s.client = client;
  s.pid = transport.pid;

  // The wire as read, before the client handles it: what the server sent, in
  // order, with the time it arrived.
  const deliver = transport.onmessage;
  let held = [];
  transport.onmessage = (m, extra) => {
    const at = Date.now();
    if (m.method === "ping") s.wire.push({ kind: "ping", at });
    else if (m.method === "notifications/progress") s.wire.push({ kind: "progress", token: m.params.progressToken, progress: m.params.progress, at });
    else if (m.id !== undefined && m.method === undefined) s.wire.push({ kind: "response", id: m.id, at });
    if (coalesce && m.method === "notifications/progress") {
      held.push(m);
      return;
    }
    // Everything held, then this, in one synchronous pass: one read.
    const batch = held;
    held = [];
    for (const h of batch) deliver?.(h);
    deliver?.(m, extra);
  };
  const sendRaw = transport.send.bind(transport);
  transport.send = (m, o) => {
    if (m.method === "tools/call") s.sent.set(m.id, m.params);
    return sendRaw(m, o);
  };
  sessions.push(s);
  return s;
}

/**
 * One run: a batch whose last chunk waits at the panel until await_job is
 * waiting for it. Returns what the wire and `onprogress` saw.
 */
async function oneRun(s, { signal, onAwaitSent } = {}) {
  const pingsSince = (mark) => s.wire.slice(mark).filter((w) => w.kind === "ping").length;
  const rbMark = s.wire.length;
  const rb = await s.client.callTool({ name: "run_batch", arguments: { ops: Array.from({ length: TOTAL }, () => ({ op: "list_comps", args: {} })) } });
  assert.equal(rb.isError, undefined, rb.content?.[0]?.text);
  const { jobId } = JSON.parse(rb.content[0].text);
  const runBatchPings = pingsSince(rbMark);
  await new Promise((r) => (jobs.get(jobId).finished ? r() : heldReady.set(jobId, r)));
  const progress = [];
  const awMark = s.wire.length;
  const done = s.client
    .callTool({ name: "await_job", arguments: { jobId } }, undefined, { timeout: 60_000, signal, onprogress: (p) => progress.push(p) })
    .then((res) => ({ res }), (error) => ({ error }));
  let id;
  for (let n = 0; n < 2000 && id === undefined; n++) {
    id = [...s.sent].find(([, p]) => p.name === "await_job" && p.arguments?.jobId === jobId)?.[0];
    if (id === undefined) await sleep(1);
  }
  onAwaitSent?.(id);
  // Let the request reach the server and bind its emitter, then release.
  await sleep(15);
  held.get(jobId).release();
  const out = await done;
  await sleep(0); // let any late notification handler run, so a loss is seen as one
  const respAt = s.wire.findIndex((w, i) => i >= awMark && w.kind === "response" && w.id === id);
  const upTo = respAt >= 0 ? respAt : s.wire.length;
  const onWire = s.wire.slice(awMark, upTo).filter((w) => w.kind === "progress" && w.token === id);
  return {
    ...out,
    id,
    runBatchPings,
    awaitPings: pingsSince(awMark),
    bound: onWire.length > 0 && onWire.at(-1).progress === TOTAL,
    finalDelivered: progress.at(-1)?.progress === TOTAL,
    misordered: respAt >= 0 && s.wire.slice(respAt).some((w) => w.kind === "progress" && w.token === id),
    lastProgressAt: onWire.at(-1)?.at,
    responseAt: respAt >= 0 ? s.wire[respAt].at : undefined,
  };
}

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

try {
  await check("every run delivers the final progress to onprogress, with exactly one ping and no client error", async () => {
    const s = await startSession("delivery");
    const c = { runs: 0, delivered: 0, lost: 0, unbound: 0, misordered: 0, runBatchPings: 0, pings: new Map() };
    for (let i = 0; i < RUNS; i++) {
      const r = await oneRun(s);
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.res.isError, undefined, r.res.content?.[0]?.text);
      assert.equal(JSON.parse(r.res.content[0].text).status, "completed");
      c.runs++;
      c.runBatchPings += r.runBatchPings;
      if (r.misordered) c.misordered++;
      if (!r.bound) {
        // The emitter was bound after the final report: no progress was sent.
        c.unbound++;
        assert.equal(r.awaitPings, 0, "an await_job that sent no progress pinged the client");
        continue;
      }
      c.pings.set(r.awaitPings, (c.pings.get(r.awaitPings) ?? 0) + 1);
      if (r.finalDelivered) c.delivered++;
      else c.lost++;
    }
    const unknownToken = s.errors.filter((e) => /unknown token/.test(e));
    console.log(
      `progress-delivery: ${c.runs} runs (${COALESCE ? "progress and the next message in one read" : "reads left to the pipe"}, load ${LOAD}): ` +
        `final progress delivered ${c.delivered}, lost ${c.lost}, not bound in time ${c.unbound}, sent after the response ${c.misordered}; ` +
        `client errors ${s.errors.length}; pings on run_batch ${c.runBatchPings}, pings per await_job ${JSON.stringify([...c.pings])}`
    );
    if (unknownToken.length) console.log(`  first client error: ${unknownToken[0]}`);
    assert.equal(c.misordered, 0, "a progress notification left the server after its request's response");
    assert.equal(c.lost, 0, "the final progress notification reached the wire but never reached onprogress");
    assert.equal(s.errors.length, 0, `the client reported errors: ${s.errors.slice(0, 3).join(" | ")}`);
    assert.equal(c.runBatchPings, 0, "run_batch sent no progress, so it must not ping");
    assert.deepEqual([...c.pings.keys()], c.delivered + c.lost > 0 ? [1] : [], "an await_job that sent progress must ping exactly once");
    assert.ok(c.delivered >= Math.ceil(c.runs / 2), `only ${c.delivered} of ${c.runs} runs bound await_job before the final report`);
  });

  await check("a client that never answers the ping still gets its result, about SETTLE_PING_TIMEOUT_MS late", async () => {
    const s = await startSession("ping-never", { ping: "never" });
    for (let i = 0; i < 3; i++) {
      const r = await oneRun(s);
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.res.isError, undefined);
      assert.equal(JSON.parse(r.res.content[0].text).status, "completed");
      if (!r.bound) continue;
      assert.equal(r.awaitPings, 1);
      assert.ok(r.finalDelivered, "the final progress was lost");
      const lag = r.responseAt - r.lastProgressAt;
      assert.ok(lag >= SETTLE_PING_TIMEOUT_MS - 50, `the response came ${lag} ms after the last progress: the server did not wait for the ping`);
      assert.ok(lag < SETTLE_PING_TIMEOUT_MS + 2500, `the response came ${lag} ms after the last progress: the ping's wait is not bounded`);
      return;
    }
    assert.fail("await_job never bound before the final report");
  });

  await check("a client that refuses the ping gets its result at once, final progress included", async () => {
    const s = await startSession("ping-refuse", { ping: "refuse" });
    for (let i = 0; i < 3; i++) {
      const r = await oneRun(s);
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.res.isError, undefined);
      assert.equal(JSON.parse(r.res.content[0].text).status, "completed");
      if (!r.bound) continue;
      assert.equal(r.awaitPings, 1);
      assert.ok(r.finalDelivered, "the final progress was lost");
      const lag = r.responseAt - r.lastProgressAt;
      assert.ok(lag < SETTLE_PING_TIMEOUT_MS - 50, `the response came ${lag} ms after the last progress: a refused ping was waited out`);
      return;
    }
    assert.fail("await_job never bound before the final report");
  });

  await check("a call cancelled while the ping is out stops waiting for it at once", async () => {
    const ac = new AbortController();
    let pinged = false;
    // On the ping, cancel the call, and never answer.
    const s = await startSession("ping-cancel", {
      debug: true,
      ping: () => {
        pinged = true;
        ac.abort("cancelled by the test");
        return new Promise(() => {});
      },
    });
    const r = await oneRun(s, { signal: ac.signal });
    assert.ok(pinged, "the server never pinged");
    assert.ok(r.error, "the cancelled call resolved");
    await until("the server to end its wait", () => /request cancelled during the ping/.test(s.log) || /ping not answered/.test(s.log), 5000);
    assert.match(s.log, /request cancelled during the ping/, "the server waited the ping out instead of stopping on the cancel");
    assert.doesNotMatch(s.log, /ping not answered/);
  });
} finally {
  for (const b of burners) b.kill("SIGKILL");
  for (const s of sessions) {
    await s.client.close().catch(() => {});
    try { process.kill(s.pid, "SIGKILL"); } catch {}
  }
  wss.close();
  panel.closeAllConnections?.();
  await new Promise((r) => panel.close(r));
  fs.rmSync(home, { recursive: true, force: true });
}

async function until(what, cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

console.log(`progress-delivery: ${passed} checks passed`);
