// The panel-version gate re-checks a stale verdict (issue #156).
//
// The gate cached a stale verdict forever, on the theory that restarting After
// Effects drops the bridge and a port change clears the cache. AE rebinds the
// same port, so nothing cleared it, and every call kept saying "restart After
// Effects" after the user had. Pinned here:
//
//   - a stale verdict is re-probed after STALE_RECHECK_MS and clears once the
//     running panel is current; within the window it is answered from cache.
//   - an unreachable bridge drops the verdict (runOp reports unreachable);
//     a timeout keeps it (a busy AE is still running the old code).
//   - WsClient fires onReopen when the socket reopens, not on the first open.
//
//   node tests/unit/panel-gate.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { createPanelGate, STALE_RECHECK_MS, HEALTHY_RECHECK_MS } = await import(dist("bridge", "panelGate.js"));
const { BridgeTimeoutError, BridgeUnreachableError } = await import(dist("util", "errors.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { WsClient } = await import(dist("bridge", "wsClient.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`panel-gate FAILED: ${name}`);
    throw e;
  }
}

const STALE = "After Effects is still running the old panel. Restart After Effects.";

/** A fake bridge whose /health answer and outcome the test controls. */
function fakeBridge() {
  const b = {
    hash: "old",
    mode: "ok", // ok | unreachable | timeout
    hits: 0,
    portListeners: [],
    async health() {
      b.hits++;
      if (b.mode === "unreachable") throw new BridgeUnreachableError(7777, new Error("ECONNREFUSED"));
      if (b.mode === "timeout") throw new BridgeTimeoutError(7777, 2000, { op: "health", adjustable: false });
      return { ok: true, port: 7777, bundleLoaded: true, bundleHash: b.hash };
    },
    onPortChange(l) { b.portListeners.push(l); },
  };
  return b;
}
const assess = (h) => (h.bundleHash === "new" ? { state: "current", message: "" } : { state: "restart-needed", message: STALE });

function clock() {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
}

await check("a stale verdict clears once the restarted panel is current", async () => {
  const b = fakeBridge();
  const c = clock();
  const gate = createPanelGate(b, { assess, now: c.now });
  assert.equal(await gate.check(), STALE);
  // User restarts AE on the same port: no port change event.
  b.hash = "new";
  c.t += 100;
  assert.equal(await gate.check(), STALE, "within the window the cache answers");
  assert.equal(b.hits, 1);
  c.t += STALE_RECHECK_MS;
  assert.equal(await gate.check(), null, "re-probed and cleared — the bug was a stale verdict forever");
  assert.equal(b.hits, 2);
});

await check("a healthy verdict is not re-probed on every call", async () => {
  const b = fakeBridge();
  b.hash = "new";
  const c = clock();
  const gate = createPanelGate(b, { assess, now: c.now });
  assert.equal(await gate.check(), null);
  c.t += STALE_RECHECK_MS * 2;
  assert.equal(await gate.check(), null);
  assert.equal(b.hits, 1);
  c.t += HEALTHY_RECHECK_MS;
  await gate.check();
  assert.equal(b.hits, 2);
});

await check("unreachable during the restart drops the verdict; a timeout keeps it", async () => {
  const b = fakeBridge();
  const c = clock();
  const gate = createPanelGate(b, { assess, now: c.now });
  assert.equal(await gate.check(), STALE);
  b.mode = "timeout";
  c.t += STALE_RECHECK_MS;
  assert.equal(await gate.check(), STALE, "a busy AE is still the old panel");
  const hits = b.hits;
  c.t += 100;
  assert.equal(await gate.check(), STALE);
  assert.equal(b.hits, hits, "a timeout resets the clock: the next call does not pay the probe again");
  c.t += STALE_RECHECK_MS;
  b.mode = "unreachable";
  assert.equal(await gate.check(), null, "unreachable is runOp's error to report, not the gate's");
  b.mode = "ok";
  b.hash = "new";
  assert.equal(await gate.check(), null);
});

await check("invalidate and a port change force the next call to ask", async () => {
  const b = fakeBridge();
  const c = clock();
  const gate = createPanelGate(b, { assess, now: c.now });
  await gate.check();
  b.hash = "new";
  gate.invalidate();
  assert.equal(await gate.check(), null);
  b.hash = "old";
  b.portListeners.forEach((l) => l(7778, 7777));
  assert.equal(await gate.check(), STALE);
});

await check("concurrent callers share one in-flight probe", async () => {
  const b = fakeBridge();
  let release;
  const gate = createPanelGate(
    { ...b, health: () => { b.hits++; return new Promise((r) => (release = r)); }, onPortChange() {} },
    { assess, now: clock().now }
  );
  const calls = [gate.check(), gate.check(), gate.check()];
  release({ ok: true, port: 7777, bundleHash: "old" });
  assert.deepEqual(await Promise.all(calls), [STALE, STALE, STALE]);
  assert.equal(b.hits, 1);
});

await check("a probe begun before invalidate() cannot restore the pre-restart verdict", async () => {
  const pending = [];
  const c = clock();
  const gate = createPanelGate(
    { health: () => new Promise((r) => pending.push(r)), onPortChange() {} },
    { assess, now: c.now }
  );
  const before = gate.check(); // asks the old panel
  gate.invalidate(); // the socket reopened: AE restarted
  const after = gate.check(); // asks the new panel
  assert.equal(pending.length, 2, "the invalidate started a fresh probe rather than joining the old one");
  pending[1]({ ok: true, port: 7777, bundleHash: "new" });
  assert.equal(await after, null);
  pending[0]({ ok: true, port: 7777, bundleHash: "old" }); // the old answer lands late
  await before;
  c.t += 100;
  assert.equal(await gate.check(), null, "the late pre-restart answer did not overwrite the fresh verdict");
});

await check("WsClient fires onReopen when the socket reopens, not on the first open", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/events" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const bridge = new HttpClient(port, { candidates: () => [port] });
  const ws = new WsClient(bridge, { reportProgress() {}, complete() {}, fail() {} });
  let reopens = 0;
  ws.onReopen(() => reopens++);
  const connected = new Promise((r) => wss.once("connection", r));
  ws.start();
  const sock = await connected;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reopens, 0, "first open is not a reopen");
  // The panel goes away and comes back on the same port.
  const again = new Promise((r) => wss.once("connection", r));
  sock.terminate();
  await again;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(reopens, 1);
  ws.stop();
  wss.close();
  server.close();
});

console.log(`panel-gate: ${passed} checks passed`);
