// Port drift: the server follows the panel when its cached port is refused.
//
// Issue #92. `HttpClient` discovered the port once, in its constructor, and
// posted every op there; `check_setup` re-read the port file on every call. So
// when the panel moved — or the port file was simply wrong — setup passed and
// every op failed, for a week, four times. Two things are pinned here:
//
//   - a *refused* op re-runs discovery, and if a different port answers as the
//     panel the op is re-sent there, once. Never on a timeout: refused means
//     the request never reached a panel, so re-sending cannot run it twice; a
//     timeout means it may still be running (issue #43).
//   - check_setup asks the same ports the client would, reports the one that
//     answers, and says when that is not the one ops are going to — and its
//     advice there is "retry / reconnect the server", never "restart AE".
//
// Everything runs against stub bridges on ephemeral ports. Nothing here ever
// asks 7777, because on the machine this is developed on a real panel holds it.
//
//   node tests/unit/port-drift.mjs

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { BridgeTimeoutError, BridgeUnreachableError } = await import(dist("util", "errors.js"));
const { isPanelHealth, probePanel, locatePanel, portCandidates, DEFAULT_PORT } = await import(dist("bridge", "discovery.js"));
const { probeBridge, buildNextSteps } = await import(dist("setup", "check.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`port-drift FAILED: ${name}`);
    throw e;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** A stub panel: answers /health in the panel's own shape and /op with a canned result. */
async function stubPanel({ healthShape = "panel", opBehaviour = null } = {}) {
  const seen = [];
  let healthHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      healthHits++;
      res.setHeader("content-type", "application/json");
      if (healthShape === "panel") {
        res.end(JSON.stringify({ ok: true, port: server.address().port, bundleLoaded: true, bundleHash: sourceBundleHash() }));
      } else if (healthShape === "other") {
        res.end(JSON.stringify({ hello: true }));
      } else if (healthShape === "hang") {
        // Accept and say nothing — what a busy After Effects looks like.
      }
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { op } = JSON.parse(body || "{}");
      seen.push(op);
      if (opBehaviour === "hang") return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { echoed: op, from: server.address().port } }));
    });
  });
  const wss = new WebSocketServer({ server, path: "/events" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  assert.notEqual(port, DEFAULT_PORT, "must not bind the panel's port");
  return {
    server, wss, port, seen,
    get healthHits() { return healthHits; },
    // Not awaited by the caller: an upgraded WebSocket is not one of the
    // connections `closeAllConnections` drops, so `server.close` would wait
    // on the server's own /events socket for ever. Terminate those first.
    close: () => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections?.(); server.close(); },
  };
}

/** A port nothing listens on: bind, note, release. */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

delete process.env.AE_MCP_PORT;
delete process.env.AE_MCP_OP_TIMEOUT_MS;

const live = await stubPanel();
const other = await stubPanel({ healthShape: "other" });
const silent = await stubPanel({ healthShape: "hang", opBehaviour: "hang" });
const stale = await closedPort();

// ---------------------------------------------------------------------------
// Recognising the panel
// ---------------------------------------------------------------------------

await check("isPanelHealth accepts the panel's shape and nothing else", () => {
  assert.equal(isPanelHealth({ ok: true, port: 1, bundleLoaded: true, bundleHash: "abc" }), true);
  // A panel from before bundleHash existed still identifies itself.
  assert.equal(isPanelHealth({ ok: true, port: 1, bundleLoaded: true }), true);
  assert.equal(isPanelHealth({ ok: true, port: 1, bundleHash: null }), true, "a null hash is still the key being present");
  assert.equal(isPanelHealth({ ok: true }), false, "ok alone is what any service might say");
  assert.equal(isPanelHealth({ hello: true }), false);
  assert.equal(isPanelHealth(null), false);
  assert.equal(isPanelHealth("ok"), false);
});

await check("probePanel classifies all four outcomes", async () => {
  assert.equal((await probePanel(live.port)).status, "panel");
  assert.equal((await probePanel(stale)).status, "none");
  assert.equal((await probePanel(other.port)).status, "other");
  const busy = await probePanel(silent.port, 200);
  assert.equal(busy.status, "busy");
  assert.match(busy.detail, /accepted the connection/);
});

await check("locatePanel stops at the first port that answers as the panel", async () => {
  const r = await locatePanel([stale, other.port, live.port]);
  assert.equal(r.found?.port, live.port);
  assert.deepEqual(r.probed.map((p) => p.status), ["none", "other", "panel"]);
});

await check("AE_MCP_PORT pins the candidate list to that port alone", () => {
  process.env.AE_MCP_PORT = "7999";
  try {
    assert.deepEqual(portCandidates(), [7999]);
  } finally {
    delete process.env.AE_MCP_PORT;
  }
  // Unpinned, the default comes before whatever the port file says: the
  // default is where the panel binds unless something went wrong, and the
  // port file is the thing that went wrong.
  assert.equal(portCandidates()[0], DEFAULT_PORT);
});

// ---------------------------------------------------------------------------
// HttpClient: refused -> rediscover -> switch -> retry once
// ---------------------------------------------------------------------------

await check("a refused op is re-sent to the port that answers as the panel", async () => {
  const client = new HttpClient(stale, { candidates: () => [stale, live.port] });
  const changes = [];
  client.onPortChange((next, prev) => changes.push([prev, next]));
  live.seen.length = 0;

  const result = await client.runOp("list_comps", {});
  assert.deepEqual(result, { echoed: "list_comps", from: live.port });
  assert.equal(client.port, live.port, "the client should now be on the live port");
  assert.equal(client.base, `http://127.0.0.1:${live.port}`);
  assert.deepEqual(changes, [[stale, live.port]]);
  assert.deepEqual(live.seen, ["list_comps"], "the op must reach the panel exactly once");

  // And stays there: the next op goes straight through with no rediscovery.
  await client.runOp("get_comp", { compId: 1 });
  assert.deepEqual(live.seen, ["list_comps", "get_comp"]);
});

await check("a refusal with nothing better found stays a refusal, and says what was looked at", async () => {
  const client = new HttpClient(stale, { candidates: () => [stale] });
  await assert.rejects(client.runOp("list_comps", {}), (e) => {
    assert.ok(e instanceof BridgeUnreachableError, `expected BridgeUnreachableError, got ${e?.constructor?.name}: ${e?.message}`);
    assert.match(e.message, new RegExp(`Cannot reach the After Effects panel at http://127\\.0\\.0\\.1:${stale}`));
    assert.match(e.message, /Also looked for the panel on port/);
    // The three bridge diagnoses share no sentence (tests/unit/write-queue.mjs
    // holds the other direction). The probe summary must not smuggle one in.
    assert.doesNotMatch(e.message, /did not answer within/i);
    assert.doesNotMatch(e.message, /write queue/i);
    return true;
  });
  assert.equal(client.port, stale, "no switch without a panel to switch to");
});

await check("a candidate that answers as something else is not switched to", async () => {
  const client = new HttpClient(stale, { candidates: () => [other.port] });
  await assert.rejects(client.runOp("list_comps", {}), (e) => {
    assert.ok(e instanceof BridgeUnreachableError);
    assert.match(e.message, /not as the After Effects panel/);
    return true;
  });
  assert.equal(client.port, stale);
});

await check("a candidate that accepts and says nothing is named as possibly busy, not switched to", async () => {
  // This one spends the real 2s probe timeout: it is the case where the panel
  // *is* there and After Effects is busy, and switching to a port that cannot
  // be confirmed would turn a precise refusal into a 300s bridge timeout.
  const client = new HttpClient(stale, { candidates: () => [silent.port] });
  await assert.rejects(client.runOp("list_comps", {}), (e) => {
    assert.ok(e instanceof BridgeUnreachableError);
    assert.match(e.message, /may be the panel with After Effects busy/);
    assert.match(e.message, /the next call looks again/);
    assert.doesNotMatch(e.message, /did not answer within/i);
    return true;
  });
  assert.equal(client.port, stale);
});

await check("a timeout never triggers rediscovery or a retry", async () => {
  // The whole safety argument: a timed-out op reached After Effects and may
  // still be running. Re-sending it duplicates side effects (#43), and even
  // probing here would spend seconds on top of a budget already exhausted.
  process.env.AE_MCP_OP_TIMEOUT_MS = "150";
  let probes = 0;
  try {
    const client = new HttpClient(silent.port, { candidates: () => { probes++; return [live.port]; } });
    live.seen.length = 0;
    await assert.rejects(client.runOp("set_transform", {}), (e) => e instanceof BridgeTimeoutError);
    assert.equal(probes, 0, "candidates were consulted after a timeout");
    assert.equal(client.port, silent.port);
    assert.deepEqual(live.seen, [], "the op must not have been re-sent anywhere");
  } finally {
    delete process.env.AE_MCP_OP_TIMEOUT_MS;
  }
});

await check("the retry gets a full timeout budget of its own", async () => {
  // The discovery probes and the retry each have their own clock. A refused
  // call that then succeeds must not be reported as slow because the clock
  // started before the refusal.
  process.env.AE_MCP_OP_TIMEOUT_MS = "400";
  try {
    const client = new HttpClient(stale, { candidates: () => [stale, live.port] });
    const started = Date.now();
    const r = await client.runOp("list_comps", {});
    assert.equal(r.from, live.port);
    assert.ok(Date.now() - started < 2000, "a refused-then-found call should be quick");
  } finally {
    delete process.env.AE_MCP_OP_TIMEOUT_MS;
  }
});

// ---------------------------------------------------------------------------
// check_setup's view of it
// ---------------------------------------------------------------------------

await check("probeBridge asks the op port first and reports the disagreement", async () => {
  const r = await probeBridge([live.port], stale);
  assert.deepEqual(r.probed.map((p) => p.port), [stale, live.port], "op port first, then the candidates");
  assert.equal(r.answering?.port, live.port);
  assert.equal(r.atOpPort?.status, "none");
  assert.equal(r.busy, null);
});

await check("probeBridge with the op port answering asks nothing else", async () => {
  const r = await probeBridge([stale, other.port], live.port);
  assert.equal(r.answering?.port, live.port);
  assert.equal(r.probed.length, 1);
});

await check("probeBridge reports a busy port when nothing answers as the panel", async () => {
  const r = await probeBridge([silent.port], stale);
  assert.equal(r.answering, null);
  assert.equal(r.busy?.port, silent.port);
});

const ok = (name, detail = "") => ({ name, ok: true, detail });
const bad = (name, detail = "", fix = "…") => ({ name, ok: false, detail, fix });
const healthy = [
  ok("platform"), ok("panelAssetsPresent"), ok("cepDebugMode"), ok("panelInstalled"),
  ok("panelUpToDate"), ok("panelDependencies"), ok("afterEffectsRunning"),
];

await check("a port disagreement is told to retry or reconnect, never to restart After Effects", () => {
  const steps = buildNextSteps(
    [...healthy, ok("bridgeReachable", "responding on port 7777"),
      bad("portAgreement", "tool calls are being sent to port 7780 (nothing is listening on port 7780), but the panel is answering on port 7777")],
    false,
    false
  );
  const text = steps.join("\n");
  assert.match(steps[0], /^Do not restart After Effects/, "the first thing said must forbid the restart");
  assert.match(steps[0], /7780/);
  assert.match(steps[0], /7777/);
  assert.match(text, /Retry the call/i);
  assert.match(text, /reconnect the MCP server/i);
  assert.doesNotMatch(text, /reopen After Effects/i);
  assert.doesNotMatch(text, /Quit After Effects/i);
  assert.doesNotMatch(text, /Run the setup_panel tool/i);
});

await check("a busy port on a different number keeps the wait advice and names the port", () => {
  const steps = buildNextSteps(
    [...healthy, bad("bridgeReachable", "port 7777 accepted the connection but did not answer within 2s"),
      bad("portAgreement", "tool calls are being sent to port 7780 (nothing is listening on port 7780); port 7777 accepted a connection but is busy and could not be confirmed as the panel")],
    false,
    true
  );
  assert.match(steps[0], /^Wait/);
  assert.match(steps.join("\n"), /7780/);
  assert.match(steps.join("\n"), /no reconnect needed/i);
});

await check("an agreeing port changes nothing about the other advice", () => {
  const steps = buildNextSteps(
    [...healthy, bad("bridgeReachable"), ok("portAgreement", "tool calls go to port 7777 and the panel answers there")],
    false,
    false
  );
  assert.match(steps.join("\n"), /reopen/i);
});

// ---------------------------------------------------------------------------
// Through the real server: the WS client and the panel gate follow the switch
// ---------------------------------------------------------------------------

await check("the MCP server switches ports on a refused call, and its job socket follows", async () => {
  const { createServer } = await import(dist("server.js"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  // The server probes /health at startup and, on a refusal, searches once
  // then — so the live port is hidden from the search until after startup,
  // otherwise the first tool call would find the bridge already moved and the
  // refused-call path through server.ts would go unexercised.
  let reveal = false;
  const bridge = new HttpClient(stale, { candidates: () => (reveal ? [stale, live.port] : [stale]) });
  const server = createServer({ bridge });
  const client = new Client({ name: "port-drift-test", version: "0" }, { capabilities: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  // Startup found nothing: still on the stale port, socket pointed at nothing.
  await sleep(150);
  assert.equal(bridge.port, stale, "startup must not have moved the bridge with no panel to move to");
  assert.equal(live.wss.clients.size, 0, "no socket should have reached the live panel yet");

  reveal = true;
  live.seen.length = 0;
  const res = await client.callTool({ name: "list_comps", arguments: {} });
  assert.equal(res.isError, undefined, res.content[0]?.text);
  assert.deepEqual(JSON.parse(res.content[0].text), { echoed: "list_comps", from: live.port });
  assert.equal(bridge.port, live.port);

  // The WS client reconnected to the new port as part of the switch, so a
  // batch's completion event can reach the job table.
  const deadline = Date.now() + 2000;
  while (live.wss.clients.size === 0 && Date.now() < deadline) await sleep(20);
  assert.equal(live.wss.clients.size, 1, "the /events socket did not follow the port switch");

  // check_setup from inside the server reports the port ops now go to, and
  // agreement with it. Only the port checks are asserted: the rest of the
  // report describes whatever machine this runs on.
  const setup = JSON.parse((await client.callTool({ name: "check_setup", arguments: {} })).content[0].text);
  const agreement = setup.checks.find((c) => c.name === "portAgreement");
  assert.ok(agreement, "check_setup from the server must include portAgreement");
  assert.equal(agreement.ok, true);
  assert.match(agreement.detail, new RegExp(String(live.port)));
  const reachable = setup.checks.find((c) => c.name === "bridgeReachable");
  assert.equal(reachable.ok, true);
  assert.match(reachable.detail, new RegExp(`responding on port ${live.port}`));

  await client.close();
  await server.close();
});

console.log(`port-drift: ${passed} checks passed`);
live.close(); other.close(); silent.close();
// The bridge's WS client reconnects on a timer the server owns, so there is
// nothing to await here — same reason write-queue-server.mjs ends this way.
process.exit(0);
