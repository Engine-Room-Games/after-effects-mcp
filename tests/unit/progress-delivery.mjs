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
// the notification read ahead of it. A request that sent no progress sends no
// ping, and that is checked here too.
//
// This drives the real server, spawned from dist/index.js over stdio, with the
// real SDK client, against a stub panel. Each run is a chunked `run_batch`
// whose final chunk is held at the panel until `await_job` is waiting on it, so
// the final progress is reported immediately before await_job answers — the
// exact shape of the bug. Every run must deliver the final progress to
// `onprogress`, and the client must report no error.
//
//   node tests/unit/progress-delivery.mjs
//   PROGRESS_RUNS=200 PROGRESS_LOAD=8 node tests/unit/progress-delivery.mjs
//
// PROGRESS_LOAD spawns that many busy-loop processes for the duration, which
// is what makes the two writes coalesce on an unfixed server.

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-progress-delivery-"));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  AE_MCP_PORT: String(panelPort),
  AE_MCP_FRONT_DESK_PORT: String(await freePort()),
};
delete env.AE_MCP_FRONT_DESK;
delete env.AE_MCP_OP_TIMEOUT_MS;

const burners = [];
for (let i = 0; i < LOAD; i++) {
  burners.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
}

const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe" });
let log = "";
transport.stderr.on("data", (c) => (log += c.toString()));
const client = new Client({ name: "progress-delivery", version: "0" }, { capabilities: {} });
const clientErrors = [];
client.onerror = (e) => clientErrors.push(String(e?.message ?? e));
await client.connect(transport);

// The wire as read, before the client handles it: what the server sent, in order.
const wire = [];
const sent = new Map();
const deliver = transport.onmessage;
transport.onmessage = (m, extra) => {
  if (m.method === "ping") wire.push({ kind: "ping" });
  else if (m.method === "notifications/progress") wire.push({ kind: "progress", token: m.params.progressToken, progress: m.params.progress });
  else if (m.id !== undefined && m.method === undefined) wire.push({ kind: "response", id: m.id });
  deliver?.(m, extra);
};
const sendRaw = transport.send.bind(transport);
transport.send = (m, o) => {
  if (m.method === "tools/call") sent.set(m.id, m.params);
  return sendRaw(m, o);
};

const counts = { runs: 0, delivered: 0, lostFinal: 0, unbound: 0, wireMisordered: 0, pingsWithoutProgress: 0, pingsPerProgressCall: new Map() };
const pingsSince = (mark) => wire.slice(mark).filter((w) => w.kind === "ping").length;
try {
  for (let i = 0; i < RUNS; i++) {
    const rbMark = wire.length;
    const rb = await client.callTool({ name: "run_batch", arguments: { ops: Array.from({ length: TOTAL }, () => ({ op: "list_comps", args: {} })) } });
    assert.equal(rb.isError, undefined, rb.content?.[0]?.text);
    const { jobId } = JSON.parse(rb.content[0].text);
    counts.pingsWithoutProgress += pingsSince(rbMark); // no progressToken, so no ping
    // The last chunk is at the panel and held there: the job cannot finish
    // until await_job is waiting for it.
    await new Promise((r) => (jobs.get(jobId).finished ? r() : heldReady.set(jobId, r)));
    const progress = [];
    const awMark = wire.length;
    const done = client.callTool({ name: "await_job", arguments: { jobId } }, undefined, { timeout: 60_000, onprogress: (p) => progress.push(p) });
    // Let the request reach the server and bind its emitter, then release.
    let id;
    for (let n = 0; n < 200 && id === undefined; n++) {
      id = [...sent].find(([, p]) => p.name === "await_job" && p.arguments?.jobId === jobId)?.[0];
      if (id === undefined) await sleep(1);
    }
    await sleep(15);
    held.get(jobId).release();
    const r = await done;
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    assert.equal(JSON.parse(r.content[0].text).status, "completed");
    await sleep(0); // let any late notification handler run, so a loss is seen as one
    counts.runs++;
    const pings = pingsSince(awMark);
    counts.pingsPerProgressCall.set(pings, (counts.pingsPerProgressCall.get(pings) ?? 0) + 1);
    const at = wire.findIndex((w) => w.kind === "response" && w.id === id);
    const onWire = wire.slice(0, at).filter((w) => w.kind === "progress" && w.token === id);
    if (wire.slice(at).some((w) => w.kind === "progress" && w.token === id)) counts.wireMisordered++;
    if (onWire.length === 0 || onWire.at(-1).progress !== TOTAL) {
      // The emitter was bound after the final report: nothing to deliver.
      counts.unbound++;
      continue;
    }
    if (progress.at(-1)?.progress === TOTAL) counts.delivered++;
    else counts.lostFinal++;
  }
} finally {
  for (const b of burners) b.kill("SIGKILL");
  await client.close().catch(() => {});
  try { process.kill(transport.pid, "SIGKILL"); } catch {}
  wss.close();
  panel.closeAllConnections?.();
  await new Promise((r) => panel.close(r));
  fs.rmSync(home, { recursive: true, force: true });
}

const unknownToken = clientErrors.filter((e) => /unknown token/.test(e));
console.log(
  `progress-delivery: ${counts.runs} runs (load ${LOAD}): final progress delivered ${counts.delivered}, lost ${counts.lostFinal}, ` +
    `not bound in time ${counts.unbound}, sent after the response ${counts.wireMisordered}; client errors ${clientErrors.length}; ` +
    `pings on calls without progress ${counts.pingsWithoutProgress}, pings per await_job ${JSON.stringify([...counts.pingsPerProgressCall])}`
);
if (unknownToken.length) console.log(`  first client error: ${unknownToken[0]}`);
assert.equal(counts.wireMisordered, 0, "a progress notification left the server after its request's response");
assert.equal(counts.lostFinal, 0, "the final progress notification reached the wire but never reached onprogress");
assert.equal(counts.pingsWithoutProgress, 0, "a call that sent no progress paid for a ping");
for (const [n] of counts.pingsPerProgressCall) assert.ok(n <= 1, `an await_job sent ${n} pings; settle() pings once`);
assert.equal(clientErrors.length, 0, `the client reported errors: ${clientErrors.slice(0, 3).join(" | ")}`);
assert.ok(counts.delivered >= Math.ceil(counts.runs / 2), `only ${counts.delivered} of ${counts.runs} runs bound await_job before the final report`);
