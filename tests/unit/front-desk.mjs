// The front desk (issue #223): one queue for every session on one After Effects.
//
// Two halves. The first exercises the pieces in-process — the cross-session
// lock, the wire format, the two new error messages. The second is the part
// that cannot be reasoned about: real server processes, spawned from
// dist/index.js exactly as an MCP client spawns them, sharing one fake panel.
// It checks the order writes reach the panel in, what a waiting session is
// told, a run_batch holding the lock across sessions, a leader killed in the
// middle of a request, a graceful handover, a stale leader file, a foreign
// process on the desk port, and read-only mode staying per client.
//
// Nothing here touches port 7777 or the real ~/.engineroom-ae-mcp: every server
// runs with HOME pointed at a temp folder and both ports ephemeral.
//
//   node tests/unit/front-desk.mjs

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

const { DeskLock } = await import(dist("frontdesk", "lock.js"));
const { toWire, fromWire, ordinal, describeLockWait, describeAhead } = await import(dist("frontdesk", "protocol.js"));
const errors = await import(dist("util", "errors.js"));
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

// The lock's timers are unref'd, as the write queue's are — a queued write must
// never be what keeps a server alive. Here, nothing else would keep the test alive.
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
    await sleep(25);
  }
}

// ===========================================================================
// In-process: the lock
// ===========================================================================

const req = (op, sessionId, extra = {}) => ({
  op,
  sessionId,
  session: `${sessionId}-client, pid 1`,
  maxWaitMs: 5000,
  maxDepth: 64,
  holdCeilingMs: 60_000,
  ...extra,
});

await check("the lock grants in arrival order, one holder at a time", async () => {
  const lock = new DeskLock();
  const order = [];
  const a = await lock.acquire(req("set_text", "A"));
  assert.equal(a.wait, null, "an uncontended grant reports no wait");
  const pb = lock.acquire(req("set_layer", "B")).then((g) => (order.push("B"), g));
  const pc = lock.acquire(req("add_keyframe", "C")).then((g) => (order.push("C"), g));
  await sleep(20);
  assert.deepEqual(order, []);
  lock.release(a.id);
  const b = await pb;
  await sleep(10);
  assert.deepEqual(order, ["B"]);
  lock.release(b.id);
  const c = await pc;
  assert.deepEqual(order, ["B", "C"]);
  assert.equal(b.wait.queuedBehind, "set_text");
  assert.equal(b.wait.queuedBehindSession, "A-client, pid 1");
  assert.equal(c.wait.queuedBehind, "set_text", "C names what held the lock when it joined");
  lock.release(c.id);
  lock.release(c.id); // idempotent
  assert.equal(lock.held, null);
});

await check("a waiter is told its position and who is in front — never itself", async () => {
  const lock = new DeskLock();
  const a = await lock.acquire(req("run_batch", "A"));
  const seenB = [];
  const seenC = [];
  const pb = lock.acquire(req("set_layer", "B", { onUpdate: (l) => seenB.push(l) }));
  const pc = lock.acquire(req("set_text", "C", { onUpdate: (l) => seenC.push(l) }));
  await sleep(10);
  assert.equal(seenB.at(-1).position, 1);
  assert.equal(seenC.at(-1).position, 2);
  assert.equal(seenC.at(-1).holder.op, "run_batch");
  assert.match(describeLockWait("set_text", seenC.at(-1)), /is 2nd in line .*another session's `run_batch` \(A-client, pid 1\)/);
  lock.release(a.id);
  const b = await pb;
  await sleep(10);
  assert.equal(seenC.at(-1).position, 1, "C moved up");
  lock.release(b.id);
  lock.release((await pc).id);

  // Same session in front: the wait is not reported, so a session never reads
  // that it waited behind itself, and single-session results stay unchanged.
  const own = await lock.acquire(req("set_text", "S"));
  const updates = [];
  const p2 = lock.acquire(req("set_layer", "S", { onUpdate: (l) => updates.push(l) }));
  await sleep(10);
  assert.equal(updates.at(-1).holder, null);
  lock.release(own.id);
  assert.equal((await p2).wait, null);
});

await check("a resumed lease jumps the line, and a takeover's grace holds everyone else back", async () => {
  const lock = new DeskLock({ graceMs: 250 });
  const order = [];
  const t0 = Date.now();
  const plain = lock.acquire(req("set_text", "B")).then((g) => (order.push(["B", Date.now() - t0]), g));
  await sleep(20);
  const resumed = await lock.acquire(req("run_batch", "A", { resume: true }));
  order.push(["A", Date.now() - t0]);
  assert.equal(order[0][0], "A", "the resumed lease is granted during the grace period");
  lock.release(resumed.id);
  const b = await plain;
  assert.ok(order[1][1] >= 230, `a plain waiter was granted ${order[1][1]}ms into a 250ms grace`);
  lock.release(b.id);

  // Resumed waiters queue ahead of plain ones even outside the grace period.
  const lock2 = new DeskLock();
  const h = await lock2.acquire(req("set_text", "X"));
  const got = [];
  const p1 = lock2.acquire(req("set_layer", "Y")).then((g) => (got.push("Y"), g));
  const p2 = lock2.acquire(req("run_batch", "Z", { resume: true })).then((g) => (got.push("Z"), g));
  lock2.release(h.id);
  lock2.release((await p2).id);
  lock2.release((await p1).id);
  assert.deepEqual(got, ["Z", "Y"]);
});

await check("a wait that runs out behind another session says so; one cancelled is dropped unrun", async () => {
  const lock = new DeskLock();
  const a = await lock.acquire(req("run_batch", "A"));
  await assert.rejects(lock.acquire(req("set_text", "B", { maxWaitMs: 60 })), (e) => {
    assert.ok(e instanceof errors.WriteQueueWaitError, "still the write-queue-wait kind");
    assert.ok(e instanceof errors.DeskWaitError);
    assert.match(e.message, /behind another session's `run_batch` \(A-client, pid 1\)/);
    assert.match(e.message, /re-sending this call is safe/);
    return true;
  });
  const ac = new AbortController();
  const p = lock.acquire(req("set_text", "B"), ac.signal);
  ac.abort();
  await assert.rejects(p, errors.WriteQueueCancelledError);
  await assert.rejects(lock.acquire(req("set_text", "B", { maxDepth: 0 })), errors.WriteQueueFullError);
  assert.equal(lock.depth, 0);
  lock.release(a.id);
});

await check("a resumed lease keeps its age: its holder is reported as held for as long as it really has been", async () => {
  const lock = new DeskLock();
  const a = await lock.acquire(req("run_batch", "A", { resume: true, heldForMs: 40_000 }));
  const seen = [];
  const p = lock.acquire(req("set_text", "B", { onUpdate: (l) => seen.push(l) }));
  await sleep(10);
  assert.ok(seen.at(-1).holder.forMs >= 40_000, `reported ${seen.at(-1).holder.forMs}ms`);
  assert.match(describeLockWait("set_text", seen.at(-1)), /held it for 40s/);
  lock.release(a.id);
  lock.release((await p).id);
});

await check("a held lease is freed at its ceiling", async () => {
  const lock = new DeskLock();
  await lock.acquire(req("run_batch", "A", { holdCeilingMs: 50 }));
  const b = await lock.acquire(req("set_text", "B"));
  assert.equal(b.wait.queuedBehind, "run_batch");
  lock.release(b.id);
});

// ===========================================================================
// In-process: the wire and the messages
// ===========================================================================

await check("every bridge failure crosses the desk as the same kind with the same words", async () => {
  const cases = [
    new errors.BridgeTimeoutError(7777, 120_000, { op: "run_jsx" }),
    new errors.BridgeUnreachableError(7777, new Error("connect ECONNREFUSED")),
    new errors.BridgeResetError(7777, "set_text", new Error("socket hang up")),
    new errors.BridgeAuthError(7777, true),
    new errors.AeError("boom", "stack", 3, "STALE_FRAME", { sourceLine: 3 }),
    new errors.WriteQueueWaitError("set_text", 1000, "run_batch"),
    new errors.DeskWaitError("set_text", 1000, "run_batch", "claude-code, pid 4"),
    new errors.WriteQueueFullError("set_text", 64, "run_batch"),
    new errors.WriteQueueCancelledError("set_text"),
  ];
  for (const e of cases) {
    const back = fromWire(JSON.parse(JSON.stringify(toWire(e))));
    assert.equal(back.constructor, e.constructor, `${e.name} came back as ${back.name}`);
    assert.equal(back.message, e.message, `${e.name}'s message changed in transit`);
  }
  const ae = fromWire(toWire(cases[4]));
  assert.equal(ae.code, "STALE_FRAME");
  assert.equal(ae.line, 3);
});

await check("the two new messages are the kinds they belong to, and say something the others do not", async () => {
  const lost = new errors.FrontDeskLostError(17777, "set_text");
  assert.ok(lost instanceof errors.BridgeResetError, "a desk lost mid-call is a reset: may have run");
  assert.match(lost.message.replace(/\n/g, " "), /may or may not have taken effect/);
  assert.match(new errors.FrontDeskLostError(17777, "set_text", "stalled").message, /stopped answering in the middle of `set_text`/);
  const place = new errors.DeskPlaceLostError("set_text", "the desk stopped answering.");
  assert.ok(place instanceof errors.WriteQueueWaitError, "nothing ran: the write-queue-wait kind, safe to re-send");
  assert.match(place.message, /^`set_text` was not sent: the desk stopped answering\./);
  assert.match(place.message, /re-sending this call is safe/);
  assert.match(lost.message, /Do not blindly re-send it/);
  assert.match(lost.message, /It may also land LATER/, "a write the desk may still forward must not be called settled by one read-back");
  assert.doesNotMatch(lost.message, /send it again if it did not/);
  assert.doesNotMatch(lost.message, /check_setup/, "the panel never left; check_setup is not the remedy");
  const wait = new errors.DeskWaitError("set_text", 3000, "run_batch", "claude-code, pid 4");
  assert.doesNotMatch(wait.message, /get_job or await_job for a batch/, "the other session's job is not visible here");
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(22), "22nd");
  assert.match(describeAhead("list_comps", [{ op: "run_jsx", session: "x, pid 2", forMs: 4200 }]), /still running another session's `run_jsx` \(x, pid 2\) ahead of it — 4s so far/);
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-desk-"));
const deskDir = path.join(home, ".engineroom-ae-mcp");

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const deskFile = (port) => path.join(deskDir, `desk-${port}.json`);
const readDesk = (port) => {
  try { return JSON.parse(fs.readFileSync(deskFile(port), "utf8")); } catch { return null; }
};

// ===========================================================================
// In-process: session lines against a real desk, with a fake panel client
// ===========================================================================

// The desk file lives under the home directory, read at call time.
process.env.HOME = home;
process.env.USERPROFILE = home;
const { SessionLine } = await import(dist("frontdesk", "line.js"));
const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));
const { deskProof, FrontDesk } = await import(dist("frontdesk", "desk.js"));
const { monoMs, DESK_PROTOCOL } = await import(dist("frontdesk", "config.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { execFileSync } = await import("node:child_process");

/** One NDJSON request to a desk, raw: lines as they arrive, kept open until told. */
function rawDesk(port, token, route, body) {
  const lines = [];
  let ended = false;
  const req = http.request({ host: "127.0.0.1", port, path: route, method: "POST", agent: false, headers: { "x-ae-mcp-desk-token": token } }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (l.t !== "beat") lines.push(l);
      }
    });
    res.on("end", () => (ended = true));
  });
  req.on("error", () => (ended = true));
  req.end(JSON.stringify(body));
  return { lines, ended: () => ended, close: () => req.destroy() };
}


function fakeBridge() {
  const calls = [];
  return {
    calls,
    port: 1,
    async runOp(op) { calls.push(op); return { ok: true, op }; },
    async cancel() { return { known: true }; },
    async switchPort() {},
    onPortChange() {},
  };
}
const lines = [];
function line(port, name, extra = {}) {
  const bridge = fakeBridge();
  const l = new SessionLine(bridge, new WriteQueue(), { desk: { port, ...extra }, sessionLabel: () => `${name}, pid 1` });
  l.bridge_ = bridge;
  lines.push(l);
  return l;
}
function postDesk(port, token, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: "POST", headers: { "x-ae-mcp-desk-token": token } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(t.split("\n").filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.t !== "beat")));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

await check("the deadline clock is one clock for every process on the machine", async () => {
  // Deadlines cross from one server to another; the monotonic clock they are
  // read on must agree between processes (mach_absolute_time, QueryPerformanceCounter).
  const code = "process.stdout.write(JSON.stringify([Number(process.hrtime.bigint() / 1000000n), Date.now()]))";
  const before = [monoMs(), Date.now()];
  const child = JSON.parse(execFileSync(process.execPath, ["-e", code]));
  const after = [monoMs(), Date.now()];
  assert.ok(child[0] >= before[0] && child[0] <= after[0], `child ${child[0]} not within [${before[0]}, ${after[0]}]`);
});

await check("a re-post after a refusal asks first, and stops if the caller has given up", async () => {
  const refused = await freePort();
  let posts = 0;
  const good = http.createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    if (q.url === "/health") return r.end(JSON.stringify({ ok: true, port: 0, bundleHash: "x" }));
    posts++;
    q.resume();
    r.end(JSON.stringify({ ok: true, result: {} }));
  });
  await new Promise((r) => good.listen(0, "127.0.0.1", r));
  const goodPort = good.address().port;
  const client = new HttpClient(refused, { candidates: () => [refused, goodPort] });
  await assert.rejects(client.runOp("set_text", {}, undefined, { beforeRetry: () => { throw new Error("given up"); } }), /given up/);
  assert.equal(posts, 0, "nothing was re-posted");
  await client.runOp("set_text", {}, undefined, { beforeRetry: () => {} });
  assert.equal(posts, 1, "a caller that still wants it gets the re-post");
  await new Promise((r) => good.close(r));
});

await check("a desk that cannot forward within the window, four times running, says so — not 'changed hands'", async () => {
  const port = await freePort();
  const token = "fake-desk-expired";
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(deskFile(port), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: process.pid, port, token, startedAt: 1 }));
  let ops = 0;
  const fake = http.createServer((q, r) => {
    if (q.url === "/desk/hello") {
      r.setHeader("content-type", "application/json");
      return r.end(JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 4245, beatMs: 2000, proof: deskProof(token, q.headers["x-ae-mcp-desk-nonce"]) }));
    }
    q.resume();
    q.on("end", () => {
      r.writeHead(200, { "content-type": "application/x-ndjson" });
      if (q.url === "/desk/lock") return r.write(JSON.stringify({ t: "granted", id: "lease-x", wait: null }) + "\n");
      ops++;
      r.end(JSON.stringify({ t: "expired" }) + "\n");
    });
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  const L = line(port, "L");
  assert.equal(await L.ready(), "follower");
  const lease = await L.acquire("set_text");
  await assert.rejects(L.runOp("set_text", {}, { write: true }), (e) => {
    assert.ok(e instanceof errors.DeskPlaceLostError, e.message);
    assert.match(e.message, /did not get to it within its forwarding window, 4 times running/);
    assert.doesNotMatch(e.message, /changed hands/);
    return true;
  });
  lease.release();
  assert.equal(ops, 4);
  assert.deepEqual(L.bridge_.calls, []);
  await L.close();
  fake.closeAllConnections?.();
  await new Promise((r) => fake.close(r));
});

await check("a stall is never declared before the call's deadline, however large the body's allowance", async () => {
  // A desk that answers `start` and then goes silent — frozen between `start`
  // and its last check. The follower must not give up while the desk could
  // still wake inside the deadline and forward.
  const port = await freePort();
  const token = "fake-desk-silent";
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(deskFile(port), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: process.pid, port, token, startedAt: 1 }));
  let deadline = null;
  const fake = http.createServer((q, r) => {
    if (q.url === "/desk/hello") {
      r.setHeader("content-type", "application/json");
      return r.end(JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 4246, beatMs: 200, proof: deskProof(token, q.headers["x-ae-mcp-desk-nonce"]) }));
    }
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      r.writeHead(200, { "content-type": "application/x-ndjson" });
      if (q.url === "/desk/lock") {
        r.write(JSON.stringify({ t: "granted", id: "lease-s", wait: null }) + "\n");
        const beat = setInterval(() => r.write(JSON.stringify({ t: "beat" }) + "\n"), 200);
        r.on("close", () => clearInterval(beat));
        return;
      }
      deadline = JSON.parse(body).deadline;
      r.write(JSON.stringify({ t: "start", ahead: [] }) + "\n"); // then nothing
    });
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  process.env.AE_MCP_FRONT_DESK_BODY_ALLOWANCE_MS = "2000";
  try {
    const L = line(port, "L");
    assert.equal(await L.ready(), "follower");
    const lease = await L.acquire("set_text");
    await assert.rejects(L.runOp("set_text", {}, { write: true }), (e) => {
      assert.ok(e instanceof errors.FrontDeskLostError, e.message);
      return true;
    });
    const declaredAt = monoMs();
    assert.ok(deadline !== null);
    assert.ok(declaredAt > deadline, `stall declared ${deadline - declaredAt}ms before the deadline`);
    lease.release();
    await L.close();
  } finally {
    delete process.env.AE_MCP_FRONT_DESK_BODY_ALLOWANCE_MS;
    fake.closeAllConnections?.();
    await new Promise((r) => fake.close(r));
  }
});

await check("a server sweeps away desk files left by servers that are gone, and only those", async () => {
  const deadPort = await freePort();
  const livePort = await freePort();
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(deskFile(deadPort), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 999_999, port: deadPort, token: "dead", startedAt: 1 }));
  fs.writeFileSync(deskFile(livePort), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: process.pid, port: livePort, token: "live", startedAt: 1 }));
  const L = line(await freePort(), "L");
  assert.equal(await L.ready(), "leader");
  assert.equal(readDesk(deadPort), null, "a SIGKILLed server's file is removed");
  assert.equal(readDesk(livePort)?.token, "live", "a running server's file is left alone");
  await L.close();
  fs.rmSync(deskFile(livePort), { force: true });
});

await check("the desk refuses a write without the lease holding the lock, and sends nothing", async () => {
  const port = await freePort();
  const L = line(port, "L");
  assert.equal(await L.ready(), "leader");
  const token = readDesk(port).token;
  for (const body of [
    { op: "set_text", write: true, sessionId: "x" },
    { op: "set_text", write: true, leaseId: "not-a-lease", sessionId: "x" },
  ]) {
    const out = await postDesk(port, token, "/desk/op", body);
    assert.deepEqual(out, [{ t: "lost" }]);
  }
  assert.deepEqual(L.bridge_.calls, [], "nothing reached the panel");
  const read = await postDesk(port, token, "/desk/op", { op: "list_comps", sessionId: "x" });
  assert.equal(read.at(-1).t, "ok", "a read needs no lease");
  await L.close();
});

await check("a batch whose lock cannot be re-taken after a handover says so, and its writes are refused", async () => {
  const port = await freePort();
  const L1 = line(port, "L1");
  const L2 = line(port, "L2");
  assert.equal(await L1.ready(), "leader");
  assert.equal(await L2.ready(), "follower");
  const lease = await L2.acquire("run_batch");
  let finish;
  lease.extendUntil(new Promise((r) => (finish = r)));
  const warnings = [];
  lease.onLost((w) => warnings.push(w));
  lease.release();
  assert.equal(readDesk(port).batchHeld, true, "the file says a long lease holds the lock");

  // L1's desk goes away, and something else takes its port before L2 can.
  const desk = L1["mode"].desk;
  desk["server"].close();
  const foreign = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  await new Promise((r) => foreign.listen(port, "127.0.0.1", r));
  await L1.close();
  assert.equal(readDesk(port)?.batchHeld, true, "a graceful close leaves the file while a long lease holds the lock");

  await until("the batch to be told", () => warnings.length > 0);
  assert.match(warnings[0], /lost the shared After Effects write lock when the front desk changed hands/);
  assert.match(warnings[0], /another AI session's writes may have landed between its steps/);
  await assert.rejects(L2.runOp("set_text", {}, { write: true }), (e) => {
    assert.ok(e instanceof errors.DeskPlaceLostError, e.message);
    assert.match(e.message, /lost its turn in the shared write queue/);
    return true;
  });
  assert.deepEqual(L2.bridge_.calls, [], "the write never left the server");
  finish();
  await new Promise((r) => foreign.close(r));
  fs.rmSync(deskFile(port), { force: true });
});

await check("a leftover desk file costs a lone session nothing; one left by a running batch is a reported grace", async () => {
  const quiet = await freePort();
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(deskFile(quiet), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 999_999, port: quiet, token: "old", startedAt: 1 }));
  const L = line(quiet, "L", { graceMs: 600 });
  assert.equal(await L.ready(), "leader");
  const t0 = Date.now();
  (await L.acquire("set_text")).release();
  assert.ok(Date.now() - t0 < 300, `a leftover file with nothing held made a lone session wait ${Date.now() - t0}ms`);
  await L.close();

  const busy = await freePort();
  fs.writeFileSync(deskFile(busy), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 999_999, port: busy, token: "old", startedAt: 1, batchHeld: true }));
  const M = line(busy, "M", { graceMs: 600 });
  assert.equal(await M.ready(), "leader");
  const said = [];
  const t1 = Date.now();
  (await M.acquire("set_text", undefined, (m) => said.push(m))).release();
  assert.ok(Date.now() - t1 >= 400, "a batch was holding the lock: its session gets its grace");
  assert.ok(said.some((m) => /is waiting up to 0\.6s for the write queue: the previous front desk went away while another session's long write held it/.test(m)), said.join("\n"));
  await M.close();
});

await check("a request too large for the desk is its own error, not four handovers", async () => {
  const port = await freePort();
  const token = "fake-desk-413";
  fs.writeFileSync(deskFile(port), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: process.pid, port, token, startedAt: 1 }));
  let posts = 0;
  const fake = http.createServer((q, r) => {
    if (q.url === "/desk/hello") {
      r.setHeader("content-type", "application/json");
      return r.end(JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 4244, beatMs: 2000, proof: deskProof(token, q.headers["x-ae-mcp-desk-nonce"]) }));
    }
    posts++;
    q.resume();
    r.statusCode = 413;
    r.end(JSON.stringify({ error: "body too large" }));
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  const L = line(port, "L");
  assert.equal(await L.ready(), "follower");
  await assert.rejects(L.runOp("list_comps", {}), /`list_comps` was not sent: its request is larger than the front desk accepts/);
  assert.equal(posts, 1, "refused once, never re-elected and re-sent");
  assert.deepEqual(L.bridge_.calls, []);
  await L.close();
  await new Promise((r) => fake.close(r));
});

await check("a port that will not bind with nothing listening is reported as such, and retried soon", async () => {
  const port = await freePort();
  const real = FrontDesk.prototype.listen;
  const logged = [];
  const realError = console.error;
  FrontDesk.prototype.listen = () => Promise.reject(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const L = line(port, "L", { electionDeadlineMs: 400 });
    assert.equal(await L.ready(), "direct");
    assert.ok(logged.some((m) => /cannot be bound although nothing is listening on it .*Trying again every 5s/.test(m)), logged.join("\n"));
    await L.close();
  } finally {
    FrontDesk.prototype.listen = real;
    console.error = realError;
  }
});

await check("a desk that cannot prove it knows the token is never joined, and never crashes the server", async () => {
  for (const withFile of [false, true]) {
    const port = await freePort();
    const fake = http.createServer((_q, r) => {
      r.setHeader("content-type", "application/json");
      r.end(JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 4242, beatMs: 2000 }));
    });
    await new Promise((r) => fake.listen(port, "127.0.0.1", r));
    if (withFile) {
      fs.writeFileSync(deskFile(port), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: process.pid, port, token: "t", startedAt: 1 }));
    }
    const L = line(port, "L", { electionDeadlineMs: 600 });
    assert.equal(await L.ready(), "direct", `withFile=${withFile}`);
    assert.deepEqual(await L.runOp("list_comps", {}), { ok: true, op: "list_comps" });
    await L.close();
    await new Promise((r) => fake.close(r));
  }
});

await check("a write the desk may have forwarded is never re-sent: no answer is not proof it never ran", async () => {
  // A desk that proves itself, grants the lock, and on every op reads the
  // request and drops the connection — what a hard kill after forwarding,
  // with the `start` line lost on the way, looks like from here.
  const port = await freePort();
  const token = "fake-desk-token";
  fs.writeFileSync(deskFile(port), JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: process.pid, port, token, startedAt: 1 }));
  const ops = [];
  const fake = http.createServer((q, r) => {
    if (q.url === "/desk/hello") {
      r.setHeader("content-type", "application/json");
      return r.end(JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 4243, beatMs: 2000, proof: deskProof(token, q.headers["x-ae-mcp-desk-nonce"]) }));
    }
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      if (q.url === "/desk/lock") {
        r.writeHead(200, { "content-type": "application/x-ndjson" });
        r.write(JSON.stringify({ t: "granted", id: "lease-1", wait: null }) + "\n");
        return;
      }
      ops.push(JSON.parse(body).op);
      q.socket.destroy();
    });
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  const L = line(port, "L");
  assert.equal(await L.ready(), "follower");
  const lease = await L.acquire("set_text");
  await assert.rejects(L.runOp("set_text", {}, { write: true }), (e) => {
    assert.ok(e instanceof errors.FrontDeskLostError, e.message);
    return true;
  });
  lease.release();
  assert.deepEqual(ops, ["set_text"], "sent to the desk exactly once");
  assert.deepEqual(L.bridge_.calls, [], "and never sent anywhere else");
  // A read is safe to send again, and is.
  assert.deepEqual(await L.runOp("list_comps", {}), { ok: true, op: "list_comps" });
  assert.ok(ops.filter((o) => o === "list_comps").length >= 2, `the read was re-sent: ${ops}`);
  await L.close();
  fake.closeAllConnections?.();
  await new Promise((r) => fake.close(r));
});

// ===========================================================================
// Processes: a fake panel and real servers
// ===========================================================================

/** Every op the fake panel ran: op, tag, when it entered and left. */
const seen = [];
let chain = Promise.resolve();
const batches = new Map(); // jobId -> completedAt
let batchMs = 700;
const panel = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: panelPort, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op, args } = JSON.parse(body || "{}");
    // One at a time, like the real panel's evalScript chain.
    chain = chain.then(async () => {
      const tag = op === "run_jsx" ? /tag:(\w+)/.exec(args.code)?.[1] : op;
      const ms = op === "run_jsx" ? Number(/ms:(\d+)/.exec(args.code)?.[1] ?? 5) : 5;
      const entry = { op, tag, enteredAt: Date.now() };
      seen.push(entry);
      await sleep(ms);
      entry.leftAt = Date.now();
      let result = { tag };
      if (op === "run_batch") {
        const jobId = `job-${seen.length}`;
        result = { jobId, async: true, total: 600 };
        const runFor = batchMs;
        setTimeout(() => {
          batches.set(jobId, Date.now());
          const msg = JSON.stringify({ type: "complete", jobId, result: { results: [], total: 600 } });
          for (const c of wss.clients) c.send(msg);
        }, runFor);
      }
      if (op === "list_comps") result = [];
      // A non-object result After Effects warned about, as core.jsx wraps it (#225).
      if (tag === "WARN") result = { __aemcpWarned: true, value: [1, 2], aeWarnings: ["Missing font: Inter"] };
      try {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      } catch {}
    });
  });
});
const wss = new WebSocketServer({ server: panel, path: "/events" });
await new Promise((r) => panel.listen(0, "127.0.0.1", r));
const panelPort = panel.address().port;
assert.notEqual(panelPort, 7777);

const sessions = [];
/** Start one real server process as an MCP client would, and connect to it. */
async function startSession(name, deskPort, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AE_MCP_PORT: String(panelPort),
    AE_MCP_FRONT_DESK_PORT: String(deskPort),
    // Fast heartbeats, so a stalled desk is noticed in a second rather than ten.
    AE_MCP_FRONT_DESK_BEAT_MS: "200",
    ...extraEnv,
  };
  delete env.AE_MCP_FRONT_DESK;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe" });
  let log = "";
  transport.stderr.on("data", (c) => {
    log += c.toString();
    if (process.env.DESK_TEST_VERBOSE) process.stderr.write(`[${name}] ${c}`);
  });
  const client = new Client({ name, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  const s = { name, client, transport, pid: transport.pid, log: () => log, alive: true };
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
const jsx = (tag, ms) => ({ code: `// tag:${tag} ms:${ms}\nreturn 1;` });
/** Start a call; `progress` fills while it runs, so a test can wait on what the session is told. */
function begin(s, name, args) {
  const progress = [];
  const done = s.client
    .callTool({ name, arguments: args }, undefined, { timeout: 60_000, onprogress: (p) => progress.push(p.message) })
    .then((res) => ({ res, progress, text: res.content?.[0]?.text ?? "", json: () => JSON.parse(res.content[0].text) }));
  return { progress, done };
}
const call = (s, name, args) => begin(s, name, args).done;
const ran = (tag) => seen.filter((e) => e.tag === tag);

try {
  const deskPort = await freePort();
  const A = await startSession("desk-test-A", deskPort);
  await until("A to run the desk", () => readDesk(deskPort)?.pid === A.pid);

  await check("the first server binds the desk; later ones join it", async () => {
    const info = readDesk(deskPort);
    assert.equal(info.port, deskPort);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(deskFile(deskPort)).mode & 0o777, 0o600, "the desk file holds a token: 0600");
    }
    assert.match(A.log(), /this server runs the desk/);
    return true;
  });
  const B = await startSession("desk-test-B", deskPort);
  const C = await startSession("desk-test-C", deskPort);
  await until("B and C to join", () => /joined the desk/.test(B.log()) && /joined the desk/.test(C.log()));

  await check("the desk refuses a caller without its token, and any web page", async () => {
    const get = (headers) =>
      new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: deskPort, path: "/desk/status", headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      });
    assert.equal(await get({}), 401);
    assert.equal(await get({ "x-ae-mcp-desk-token": "nope" }), 401);
    const token = readDesk(deskPort).token;
    assert.equal(await get({ "x-ae-mcp-desk-token": token, origin: "https://example.com" }), 403);
    assert.equal(await get({ "x-ae-mcp-desk-token": token }), 200);
  });

  await check("a write nobody else is waiting on looks exactly as it always did", async () => {
    const r = await call(B, "run_jsx", jsx("solo", 5));
    assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(r.json(), { tag: "solo" });
    assert.equal(r.res.content.length, 1);
  });

  await check("After Effects' warnings survive the trip through the desk to a follower", async () => {
    const r = await call(B, "run_jsx", jsx("WARN", 5));
    assert.equal(r.res.isError, undefined, r.text);
    const texts = r.res.content.map((c) => c.text);
    assert.ok(texts.some((t) => /^WARNING: After Effects reported 1 message\(s\).*Missing font: Inter/.test(t)), texts.join("\n"));
    assert.ok(texts.includes("[1,2]"), `the value keeps its shape: ${texts.join(" | ")}`);
  });

  await check("three sessions' writes reach After Effects one at a time, in the order they queued", async () => {
    seen.length = 0;
    const pa = call(A, "run_jsx", jsx("A1", 600));
    await until("A1 at the panel", () => ran("A1").length === 1);
    const hb = begin(B, "run_jsx", jsx("B1", 50));
    await until("B to be told it is in line", () => hb.progress.length > 0);
    const hc = begin(C, "run_jsx", jsx("C1", 50));
    const [ra, rb, rc] = await Promise.all([pa, hb.done, hc.done]);
    for (const r of [ra, rb, rc]) assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(seen.map((e) => e.tag), ["A1", "B1", "C1"]);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].enteredAt >= seen[i - 1].leftAt, `${seen[i].tag} overlapped ${seen[i - 1].tag}`);
    }

    // The truth, in the result…
    const b = rb.json();
    assert.equal(b.tag, "B1", "the op's own result survives the note");
    assert.equal(b.queuedBehind, "run_jsx");
    assert.match(b.queuedBehindSession, new RegExp(`^desk-test-A, pid ${A.pid}$`));
    assert.ok(b.waitedMs >= 300, `B waited ${b.waitedMs}ms behind a 600ms write`);
    assert.equal(ra.json().queuedBehind, undefined, "the session in front waited for nothing");
    // …and while it waited.
    assert.ok(rb.progress.some((m) => /is 1st in line .*another session's `run_jsx` \(desk-test-A, pid \d+\)/.test(m)), rb.progress.join("\n"));
    assert.ok(rc.progress.some((m) => /is 2nd in line/.test(m)), rc.progress.join("\n"));
  });

  await check("a read is never held behind another session's write", async () => {
    seen.length = 0;
    const pa = call(A, "run_jsx", jsx("A2", 500));
    await until("A2 at the panel", () => ran("A2").length === 1);
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([pa, call(B, "list_comps", {})]);
    assert.equal(rb.res.isError, undefined, rb.text);
    assert.deepEqual(rb.json(), []);
    assert.equal(ra.res.isError, undefined);
    assert.ok(Date.now() - t0 < 2000);
    // It still waits inside After Effects — the panel runs one thing at a time —
    // and is told what it is behind rather than left in silence.
    assert.ok(
      rb.progress.some((m) => /`list_comps` has reached After Effects, which is still running another session's `run_jsx` \(desk-test-A, pid \d+\)/.test(m)),
      rb.progress.join("\n") || "no progress at all"
    );
  });

  await check("a read behind another session's running batch is told it is the batch", async () => {
    batchMs = 1500;
    const rbatch = await call(A, "run_batch", { ops: [{ op: "list_comps", args: {} }] });
    assert.equal(rbatch.res.isError, undefined, rbatch.text);
    const rb = await call(B, "list_comps", {});
    assert.equal(rb.res.isError, undefined, rb.text);
    assert.ok(
      rb.progress.some((m) => /still running another session's `run_batch` \(desk-test-A, pid \d+\)/.test(m)),
      rb.progress.join("\n") || "no progress at all"
    );
    await until("the batch to finish", () => batches.has(rbatch.json().jobId), 5000);
    batchMs = 700;
  });

  await check("a run_batch holds the lock for its whole job, across sessions", async () => {
    seen.length = 0;
    const rb = await call(A, "run_batch", { ops: [{ op: "list_comps", args: {} }] });
    assert.equal(rb.res.isError, undefined, rb.text);
    const { jobId } = rb.json();
    assert.ok(jobId);
    const t0 = Date.now();
    const rw = await call(B, "run_jsx", jsx("B2", 5));
    assert.equal(rw.res.isError, undefined, rw.text);
    const done = batches.get(jobId);
    assert.ok(done, "the batch completed");
    const b2 = ran("B2")[0];
    assert.ok(b2.enteredAt >= done, `B2 reached After Effects ${done - b2.enteredAt}ms before the batch finished`);
    assert.equal(rw.json().queuedBehind, "run_batch");
    assert.ok(Date.now() - t0 >= 400);
  });

  await check("a leader killed mid-request: the started write is not re-sent, the queued one moves", async () => {
    seen.length = 0;
    // C's write is at After Effects through A when A dies; B's is still waiting for the lock.
    const pc = call(C, "run_jsx", jsx("C3", 1200));
    await until("C3 at the panel", () => ran("C3").length === 1);
    const hb = begin(B, "run_jsx", jsx("B3", 20));
    await until("B to be queued behind C3", () => hb.progress.length > 0);
    const hbQueuedAt = Date.now();
    await sleep(400); // let B's wait at A grow, so losing it in the handover would show
    kill(A);
    const [rc, rb] = await Promise.all([pc, hb.done]);

    assert.equal(rc.res.isError, true, "C's write had been handed to After Effects: it must not report success");
    assert.match(rc.text, /went away in the middle of `run_jsx`/);
    assert.match(rc.text, /may or may not have/);
    assert.equal(rb.res.isError, undefined, `B's queued write should have moved to the new desk: ${rb.text}`);
    // The whole wait, across the handover, and who it was behind — not just the new desk's share.
    const b3 = rb.json();
    assert.equal(b3.queuedBehind, "run_jsx", rb.text);
    assert.match(b3.queuedBehindSession, new RegExp(`^desk-test-C, pid ${C.pid}$`));
    assert.ok(b3.waitedMs >= 400, `B reported ${b3.waitedMs}ms, having waited 400ms at the dead desk alone`);
    await sleep(300);
    assert.equal(ran("C3").length, 1, "C3 ran exactly once — never re-sent");
    assert.equal(ran("B3").length, 1, "B3 ran exactly once — not lost, not doubled");
    assert.ok(ran("B3")[0].enteredAt >= ran("C3")[0].leftAt);
    const info = await until("a new desk file", () => {
      const d = readDesk(deskPort);
      return d && d.pid !== A.pid ? d : null;
    });
    assert.ok([B.pid, C.pid].includes(info.pid), `desk now run by ${info.pid}`);
  });

  await check("after the handover every surviving session still writes, in turn", async () => {
    seen.length = 0;
    const [r1, r2] = await Promise.all([call(B, "run_jsx", jsx("B4", 100)), call(C, "run_jsx", jsx("C4", 100))]);
    assert.equal(r1.res.isError, undefined, r1.text);
    assert.equal(r2.res.isError, undefined, r2.text);
    assert.ok(seen[1].enteredAt >= seen[0].leftAt, "the two writes overlapped after the handover");
  });

  await check("a leader that leaves gracefully hands the desk on", async () => {
    const leader = readDesk(deskPort).pid === B.pid ? B : C;
    const other = leader === B ? C : B;
    await stop(leader);
    const r = await call(other, "run_jsx", jsx("after", 5));
    assert.equal(r.res.isError, undefined, r.text);
    await until("the survivor to run the desk", () => readDesk(deskPort)?.pid === other.pid);
    assert.match(other.log(), /taking over/);
  });

  // ---- a fresh desk: a stale leader file, a read-only leader --------------
  const desk2 = await freePort();
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(
    deskFile(desk2),
    JSON.stringify({ desk: "ae-mcp-front-desk", protocol: DESK_PROTOCOL, pid: 999_999, port: desk2, token: "stale-token", startedAt: 1 })
  );

  await check("a stale leader file is overwritten by the server that binds the port", async () => {
    const E = await startSession("desk-test-E", desk2, { AE_MCP_READ_ONLY: "1" });
    const info = await until("E to run the desk", () => (readDesk(desk2)?.pid === E.pid ? readDesk(desk2) : null));
    assert.notEqual(info.token, "stale-token");
    assert.doesNotMatch(E.log(), /grace/, "a stale file from a desk that held nothing gives no grace");
    const F = await startSession("desk-test-F", desk2);
    await until("F to join", () => /joined the desk/.test(F.log()));

    await check("read-only mode stays per client: a read-only leader forwards another session's writes", async () => {
      const tools = (await E.client.listTools()).tools.map((t) => t.name);
      assert.ok(!tools.includes("run_jsx"), "E is read-only");
      const refused = await call(E, "run_jsx", jsx("E1", 5));
      assert.equal(refused.res.isError, true);
      assert.equal(ran("E1").length, 0);
      const r = await call(F, "run_jsx", jsx("F1", 5));
      assert.equal(r.res.isError, undefined, r.text);
      assert.equal(ran("F1").length, 1);
    });
  });

  // ---- a leader killed while another session's batch is still running ------
  await check("a batch's lock survives the desk dying under it: nobody slips between its chunks", async () => {
    const desk3 = await freePort();
    const H = await startSession("desk-test-H", desk3);
    await until("H to run the desk", () => readDesk(desk3)?.pid === H.pid);
    const I = await startSession("desk-test-I", desk3);
    const J = await startSession("desk-test-J", desk3);
    await until("I and J to join", () => /joined the desk/.test(I.log()) && /joined the desk/.test(J.log()));
    seen.length = 0;
    // Longer than the takeover grace, so only the resumed lease can be what holds J back.
    batchMs = 3500;
    const rb = await call(I, "run_batch", { ops: [{ op: "list_comps", args: {} }] });
    assert.equal(rb.res.isError, undefined, rb.text);
    const { jobId } = rb.json();
    const hj = begin(J, "run_jsx", jsx("J1", 5));
    await until("J to be queued behind the batch", () => hj.progress.length > 0);
    const pj = hj.done;
    kill(H);
    const rj = await pj;
    assert.equal(rj.res.isError, undefined, rj.text);
    const done = batches.get(jobId);
    assert.ok(done, "the batch completed");
    assert.ok(ran("J1")[0].enteredAt >= done, `J1 reached After Effects ${done - ran("J1")[0].enteredAt}ms before I's batch finished`);
    assert.equal(ran("J1").length, 1);
    assert.match(I.log(), /re-taking it at the next one/);
    batchMs = 700;
  });

  // ---- a desk that stops answering without dying -------------------------
  if (process.platform !== "win32") {
    await check("a stalled desk is noticed, never waited on for ever: each call fails the right way", async () => {
      const desk4 = await freePort();
      const K = await startSession("desk-test-K", desk4);
      await until("K to run the desk", () => readDesk(desk4)?.pid === K.pid);
      const L = await startSession("desk-test-L", desk4);
      const M = await startSession("desk-test-M", desk4);
      await until("L and M to join", () => /joined the desk/.test(L.log()) && /joined the desk/.test(M.log()));
      seen.length = 0;

      // L's write is at After Effects through K when K freezes: it may have run.
      const pl = call(L, "run_jsx", jsx("L1", 600));
      await until("L1 at the panel", () => ran("L1").length === 1);
      process.kill(K.pid, "SIGSTOP");
      try {
        const t0 = Date.now();
        const rl = await pl;
        assert.equal(rl.res.isError, true, rl.text);
        assert.match(rl.text, /stopped answering in the middle of `run_jsx`/);
        assert.match(rl.text.replace(/\n/g, " "), /may or may not have taken effect/);
        assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms to notice`);

        // M's write waits for the lock on a frozen desk: nothing was sent.
        const t1 = Date.now();
        const rm = await call(M, "run_jsx", jsx("M1", 5));
        assert.equal(rm.res.isError, true, rm.text);
        assert.match(rm.text, /^`run_jsx` was not sent: the front desk \(run by pid \d+\) stopped answering/);
        assert.ok(Date.now() - t1 < 5000, `took ${Date.now() - t1}ms to notice`);
        assert.equal(ran("M1").length, 0);

        // Both carry on, straight to After Effects, rather than hanging.
        const again = await call(M, "run_jsx", jsx("M2", 5));
        assert.equal(again.res.isError, undefined, again.text);
        const read = await call(L, "list_comps", {});
        assert.equal(read.res.isError, undefined, read.text);
        assert.equal(ran("L1").length, 1, "L1 was never re-sent");
      } finally {
        process.kill(K.pid, "SIGCONT");
      }
    });
  }

  if (process.platform !== "win32") {
    await check("the deadline alone stops a woken desk: lease held, requester still connected", async () => {
      // Every other guard passes here — the lock is held, the requester never
      // hangs up — so only the deadline can refuse the write.
      const desk7 = await freePort();
      const K = await startSession("desk-test-K4", desk7);
      await until("K4 to run the desk", () => readDesk(desk7)?.pid === K.pid);
      const token = readDesk(desk7).token;
      seen.length = 0;
      const lock = rawDesk(desk7, token, "/desk/lock", { op: "run_jsx", sessionId: "raw", session: "raw, pid 0", maxWaitMs: 5000, maxDepth: 8, holdCeilingMs: 60000 });
      const granted = await until("the lock", () => lock.lines.find((l) => l.t === "granted"));
      process.kill(K.pid, "SIGSTOP");
      let op;
      try {
        op = rawDesk(desk7, token, "/desk/op", {
          kind: "op", op: "run_jsx", args: jsx("DL1", 5), write: true, leaseId: granted.id,
          sessionId: "raw", session: "raw, pid 0", timeoutMs: 10000, deadline: monoMs() + 300,
        });
        await sleep(800); // frozen past the deadline, with the request waiting in its socket
      } finally {
        process.kill(K.pid, "SIGCONT");
      }
      await until("the desk to answer", () => op.ended());
      assert.deepEqual(op.lines.map((l) => l.t).filter((t) => t !== "start"), ["expired"]);
      assert.equal(ran("DL1").length, 0, "forwarded past its deadline");
      assert.equal(lock.ended(), false, "the requester's lease stayed held throughout");
      lock.close();

      // The same request within its deadline goes through: the deadline is not
      // refusing things it should not.
      const lock2 = rawDesk(desk7, token, "/desk/lock", { op: "run_jsx", sessionId: "raw", session: "raw, pid 0", maxWaitMs: 5000, maxDepth: 8, holdCeilingMs: 60000 });
      const g2 = await until("the lock again", () => lock2.lines.find((l) => l.t === "granted"));
      const ok = rawDesk(desk7, token, "/desk/op", {
        kind: "op", op: "run_jsx", args: jsx("DL2", 5), write: true, leaseId: g2.id,
        sessionId: "raw", session: "raw, pid 0", timeoutMs: 10000, deadline: monoMs() + 2000,
      });
      await until("the desk to answer", () => ok.ended());
      assert.equal(ok.lines.at(-1).t, "ok");
      assert.equal(ran("DL2").length, 1);
      lock2.close();
      await stop(K);
    });

    await check("a request over the desk's size limit is refused once, by a real desk, with its own message", async () => {
      const desk8 = await freePort();
      const K = await startSession("desk-test-K5", desk8, { AE_MCP_FRONT_DESK_MAX_BODY_BYTES: "2000" });
      await until("K5 to run the desk", () => readDesk(desk8)?.pid === K.pid);
      const L = line(desk8, "L");
      assert.equal(await L.ready(), "follower");
      seen.length = 0;
      await assert.rejects(L.runOp("run_jsx", { code: `// tag:BIG ms:5\n${"x".repeat(5000)}` }), /was not sent: its request is larger than the front desk accepts/);
      assert.equal(ran("BIG").length, 0);
      assert.equal(L.role, "follower", "a refusal of one request is not a lost desk");
      await L.close();
      await stop(K);
    });

    await check("a desk that wakes from a stall never forwards a write its requester gave up on", async () => {
      const desk5 = await freePort();
      const K = await startSession("desk-test-K2", desk5);
      await until("K2 to run the desk", () => readDesk(desk5)?.pid === K.pid);
      const L = line(desk5, "L");
      assert.equal(await L.ready(), "follower");
      seen.length = 0;
      const lease = await L.acquire("run_jsx");
      process.kill(K.pid, "SIGSTOP");
      try {
        await assert.rejects(L.runOp("run_jsx", jsx("DW1", 5), { write: true }), (e) => {
          assert.ok(e instanceof errors.FrontDeskLostError, e.message);
          return true;
        });
        lease.release();
      } finally {
        process.kill(K.pid, "SIGCONT");
      }
      // K wakes with L's request still queued in its socket. Make sure it has
      // caught up — it answers status again — and then some, before looking.
      const token = readDesk(desk5).token;
      await until("K2 to answer again", () =>
        new Promise((resolve) => {
          http.get({ host: "127.0.0.1", port: desk5, path: "/desk/status", headers: { "x-ae-mcp-desk-token": token } }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          }).on("error", () => resolve(false));
        })
      );
      await sleep(500); // proving a negative: nothing more should arrive
      assert.equal(ran("DW1").length, 0, "the woken desk forwarded a write its requester had already reported lost");
      await L.close();
      await stop(K);
    });

    await check("a follower that was itself blocked does not mistake buffered heartbeats for a stall", async () => {
      const desk6 = await freePort();
      const K = await startSession("desk-test-K3", desk6);
      await until("K3 to run the desk", () => readDesk(desk6)?.pid === K.pid);
      const L = line(desk6, "L");
      assert.equal(await L.ready(), "follower");
      seen.length = 0;
      const lease = await L.acquire("run_jsx");
      const p = L.runOp("run_jsx", jsx("BL1", 2500), { write: true });
      await until("BL1 at the panel", () => ran("BL1").length === 1);
      // Block this process well past the 1s stall threshold; the desk keeps beating.
      // From the check phase, so the next thing the event loop does is run the
      // expired timers — before the poll phase reads the beats waiting in the socket.
      await new Promise((r) => setImmediate(() => {
        const end = Date.now() + 1800;
        while (Date.now() < end) {}
        r();
      }));
      // The fake panel runs in this process too, so it finishes BL1 only now.
      assert.deepEqual(await p, { tag: "BL1" });
      lease.release();
      await L.close();
      await stop(K);
    });
  }

  if (process.platform !== "win32") {
    await check("a desk stopped by SIGTERM removes its file on the way out", async () => {
      const desk9 = await freePort();
      const X = await startSession("desk-test-X", desk9);
      await until("X to run the desk", () => readDesk(desk9)?.pid === X.pid);
      X.alive = false;
      process.kill(X.pid, "SIGTERM");
      await until("X's desk file to go", () => readDesk(desk9) === null, 5000);
    });
  }

  // ---- a foreign process on the desk port ----------------------------------
  await check("something else on the desk port: the server goes direct and still works", async () => {
    const foreign = http.createServer((_q, r) => { r.statusCode = 404; r.end("not here"); });
    await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
    const fport = foreign.address().port;
    const G = await startSession("desk-test-G", fport);
    const r = await call(G, "run_jsx", jsx("G1", 5));
    assert.equal(r.res.isError, undefined, r.text);
    assert.equal(ran("G1").length, 1);
    assert.match(G.log(), /not a front desk/);
    await new Promise((r) => foreign.close(r));
  });
} finally {
  for (const l of lines) await l.close().catch(() => {});
  for (const s of sessions) if (s.alive) await stop(s);
  for (const s of sessions) try { process.kill(s.pid, "SIGKILL"); } catch {}
  wss.close();
  panel.closeAllConnections?.();
  await new Promise((r) => panel.close(r));
  fs.rmSync(home, { recursive: true, force: true });
  clearInterval(keepAlive);
}

console.log(`front-desk: ${passed} checks passed`);
