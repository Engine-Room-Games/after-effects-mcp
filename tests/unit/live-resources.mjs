// Live project resources with change notifications (issue #248).
//
// The real MCP server over an in-memory transport, against a stub panel on an
// ephemeral port. The stub runs ops ONE AT A TIME, as the panel's evalScript
// chain does, and records when each arrived, started and finished — so a write
// held up behind a poll read is visible as a gap between arrival and start.
//
// What is pinned:
//   - nobody subscribed → not one op reaches the panel;
//   - subscribe → change → one notification; no change → none;
//   - a tick is one constant-time probe; the project walk runs only when the
//     probe moved, after this session wrote, or on the sweep;
//   - a steadily writing agent: no poll op runs, and no write waits, until the
//     writes go quiet — then one walk;
//   - a client read during an in-flight tick is never overwritten by the
//     tick's older answer (no spurious notifications);
//   - the front desk refuses a poll read, unsent, while ANY session holds the
//     write lock;
//   - live reads go through the panel version gate;
//   - unreachable: a read fails with the tool path's sentence, a subscription
//     stays quiet.
//
//   node tests/unit/live-resources.mjs

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

process.env.AE_MCP_FRONT_DESK = "off";
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));

// ---------------------------------------------------------------------------
// The stub panel: a serial queue, like the evalScript chain.
// ---------------------------------------------------------------------------

const project = {
  path: "/tmp/live.aep",
  activeItemId: 2,
  items: [
    { id: 1, name: "Footage", type: "folder" },
    { id: 2, name: "Main", type: "comp" },
  ],
};
const comps = { 2: { id: 2, name: "Main", width: 1920, height: 1080, numLayers: 3 } };
/** Every op: arrivedAt (reached the panel), enteredAt (started running), leftAt. */
const seen = [];
/** op -> how long it runs. */
const slow = new Map();
/** Delay the next answer to this op after it ran — a response slow on the wire. */
let holdNextAnswer = null;
let reportedHash = sourceBundleHash();
let chain = Promise.resolve();

function answer(op, args) {
  if (op === "get_project_summary") {
    return { path: project.path, numItems: project.items.length, activeItemId: project.activeItemId, items: project.items.map((i) => ({ ...i })) };
  }
  if (op === "_live_probe") {
    const a = project.items.find((i) => i.id === project.activeItemId);
    return {
      path: project.path,
      numItems: project.items.length,
      activeItemId: project.activeItemId,
      activeType: a ? a.type : null,
      activeComp: a && a.type === "comp" ? { ...comps[a.id] } : null,
      comp: args && args.compId && comps[args.compId] ? { ...comps[args.compId] } : null,
    };
  }
  if (op === "get_comp") return { ...comps[args.compId] };
  return { ok: true, op };
}

const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: reportedHash }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op, args } = JSON.parse(body || "{}");
    const entry = { op, arrivedAt: Date.now() };
    seen.push(entry);
    chain = chain.then(async () => {
      entry.enteredAt = Date.now();
      const result = answer(op, args);
      await new Promise((r) => setTimeout(r, slow.get(op) ?? 2));
      entry.leftAt = Date.now();
      const hold = holdNextAnswer && holdNextAnswer.op === op ? holdNextAnswer : null;
      if (hold) holdNextAnswer = null;
      const send = () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (hold) setTimeout(send, hold.ms);
      else send();
    });
  });
});
new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { FrontDesk } = await import(dist("frontdesk", "desk.js"));
const { toWire, fromWire } = await import(dist("frontdesk", "protocol.js"));
const { BridgeBusyError } = await import(dist("util", "errors.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { ResourceUpdatedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");

const POLL = 60;
const QUIET = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_OPS = new Set(["_live_probe", "get_project_summary", "get_comp"]);
const count = (op, since = 0) => seen.slice(since).filter((s) => s.op === op).length;
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
};

async function connect(opts) {
  const server = createServer({ livePollMs: POLL, liveQuietMs: QUIET, liveSweepMs: 60_000, ...opts });
  const client = new Client({ name: "live-resources-test", version: "0" }, { capabilities: {} });
  const updates = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updates.push(n.params.uri));
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { server, client, updates };
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

const { server, client, updates } = await connect();

await check("subscribe is declared, and the live resources are listed beside the guides", async () => {
  assert.equal(client.getServerCapabilities().resources?.subscribe, true);
  const uris = (await client.listResources()).resources.map((r) => r.uri);
  assert.ok(uris.includes("ae://project/summary"));
  assert.ok(uris.includes("ae://project/active-comp"));
  assert.ok(uris.some((u) => u.startsWith("ae://guide/")), "the guides must still be listed");
});

await check("with nobody subscribed, nothing reaches After Effects", async () => {
  seen.length = 0;
  await client.listResources();
  await sleep(POLL * 6);
  assert.equal(seen.length, 0, `ops sent with no subscriber: ${seen.map((s) => s.op).join(", ")}`);
});

await check("a read answers with the project, and the guides still read", async () => {
  const body = JSON.parse((await client.readResource({ uri: "ae://project/summary" })).contents[0].text);
  assert.equal("activeItemId" in body, false, "focus is the active-comp resource's business, not the summary's");
  assert.equal(body.items.length, 2);
  const a = JSON.parse((await client.readResource({ uri: "ae://project/active-comp" })).contents[0].text);
  assert.equal(a.compId, 2);
  assert.deepEqual(a.comp, comps[2], "comp is get_comp's answer");
  const g = await client.readResource({ uri: "ae://guide/after-effects" });
  assert.ok(g.contents[0].text.startsWith("# Driving After Effects"));
});

await check("subscribed: a tick is one cheap probe, and the walk runs only when the probe moves", async () => {
  updates.length = 0;
  await client.subscribeResource({ uri: "ae://project/summary" });
  const from = seen.length;
  await sleep(POLL * 8);
  assert.deepEqual(updates, [], "no change, so no notification");
  assert.ok(count("_live_probe", from) >= 3, "the poll should be probing");
  assert.equal(count("get_project_summary", from), 0, "no project walk while nothing moved");
  project.items.push({ id: 3, name: "Intro", type: "comp" });
  await until(() => updates.length > 0);
  assert.deepEqual(updates, ["ae://project/summary"]);
  assert.equal(count("get_project_summary", from), 1, "one walk, prompted by the probe");
  await sleep(POLL * 4);
  assert.deepEqual(updates, ["ae://project/summary"], "one change is one notification");
});

await check("the active comp notifies on a switch and on a settings change, from the probe alone", async () => {
  comps[3] = { id: 3, name: "Intro", width: 1080, height: 1920, numLayers: 1 };
  await client.subscribeResource({ uri: "ae://project/active-comp" });
  await sleep(POLL * 4);
  updates.length = 0;
  const from = seen.length;
  comps[2].numLayers = 4;
  await until(() => updates.includes("ae://project/active-comp"));
  assert.deepEqual(updates, ["ae://project/active-comp"]);
  assert.equal(count("get_comp", from), 0, "the active comp came from the probe");
  updates.length = 0;
  project.activeItemId = 3;
  await until(() => updates.includes("ae://project/active-comp"));
  assert.ok(updates.includes("ae://project/active-comp"), `got ${JSON.stringify(updates)}`);
  await sleep(POLL * 3);
});

await check("focus moving to the Project panel is not a change: no notification, no walk", async () => {
  await sleep(POLL * 3);
  updates.length = 0;
  const from = seen.length;
  const was = project.activeItemId;
  project.activeItemId = null; // the Project panel took focus
  await sleep(POLL * 4);
  project.activeItemId = 1; // a folder selected there
  await sleep(POLL * 4);
  assert.deepEqual(updates, [], "a click in the Project panel notified");
  assert.equal(count("get_project_summary", from), 0, "a click in the Project panel cost a walk");
  // The sticky comp still tracks its own settings while focus is elsewhere.
  comps[was].numLayers += 1;
  await until(() => updates.includes("ae://project/active-comp"));
  assert.deepEqual(updates, ["ae://project/active-comp"]);
  const a = JSON.parse((await client.readResource({ uri: "ae://project/active-comp" })).contents[0].text);
  assert.equal(a.compId, was);
  project.activeItemId = was;
  await sleep(POLL * 3);
});

await check("a steadily writing agent: no poll op runs and no write waits, until the writes go quiet", async () => {
  slow.set("get_project_summary", 150);
  await sleep(POLL * 2);
  const from = seen.length;
  const startedAt = Date.now();
  while (Date.now() - startedAt < QUIET * 3) {
    await client.callTool({ name: "set_transform", arguments: { compId: 2, layerId: 1, properties: { opacity: 50 } } });
    await sleep(20);
  }
  const lastWrite = Date.now();
  const during = seen.slice(from);
  const writes = during.filter((s) => s.op === "set_transform");
  assert.ok(writes.length >= 10, `only ${writes.length} writes`);
  // The first write may land behind a tick already in flight when it began.
  const polled = during.filter((s) => POLL_OPS.has(s.op) && s.arrivedAt > writes[0].leftAt && s.arrivedAt < lastWrite);
  assert.deepEqual(polled.map((s) => s.op), [], "the poll ran between writes");
  const waited = writes.slice(1).map((w) => w.enteredAt - w.arrivedAt);
  assert.ok(Math.max(...waited) < 40, `a write waited ${Math.max(...waited)}ms behind something`);
  slow.delete("get_project_summary");
});

await check("an agent writing at its own pace never pays for a project walk, nor waits behind one", async () => {
  // Spaced wider than the quiet period, as an agent's writes are: ticks run
  // between them, and each must be the probe alone.
  slow.set("get_project_summary", 150);
  await sleep(QUIET + POLL * 2);
  const from = seen.length;
  for (let i = 0; i < 5; i++) {
    await client.callTool({ name: "add_keyframe", arguments: { compId: 2, layerId: 1, propertyPath: ["Position"], time: i, value: [0, 0] } });
    await sleep(QUIET + POLL * 2);
  }
  assert.ok(count("_live_probe", from) >= 5, "the poll should have probed between the writes");
  assert.equal(count("get_project_summary", from), 0, "a keyframe write caused a project walk");
  const waited = seen.slice(from).filter((s) => s.op === "add_keyframe").map((w) => w.enteredAt - w.arrivedAt);
  assert.ok(Math.max(...waited) < 40, `a write waited ${Math.max(...waited)}ms behind a poll read`);
  // A rename is the one write the probe cannot see: one walk, after the quiet.
  const before = seen.length;
  await client.callTool({ name: "set_comp", arguments: { compId: 2, name: "Main v2" } });
  await until(() => count("get_project_summary", before) >= 1, QUIET * 4);
  assert.equal(count("get_project_summary", before), 1, "one walk after a renaming write");
  slow.delete("get_project_summary");
});

await check("a client read during an in-flight tick is not overwritten by the tick's older answer", async () => {
  await sleep(QUIET + POLL * 3);
  updates.length = 0;
  holdNextAnswer = { op: "_live_probe", ms: POLL * 4 };
  const from = seen.length;
  await until(() => seen.slice(from).some((s) => s.op === "_live_probe" && s.leftAt));
  comps[3].numLayers = 9; // after the tick's probe ran, before its answer arrives
  const fresh = JSON.parse((await client.readResource({ uri: "ae://project/active-comp" })).contents[0].text);
  assert.equal(fresh.comp.numLayers, 9);
  await sleep(POLL * 8);
  assert.deepEqual(updates, [], "the client read the new value; nothing to notify, twice or once");
});

await check("unsubscribing from both stops the polling", async () => {
  await client.unsubscribeResource({ uri: "ae://project/summary" });
  await client.unsubscribeResource({ uri: "ae://project/active-comp" });
  await sleep(POLL * 2);
  const before = seen.length;
  await sleep(POLL * 6);
  assert.equal(seen.length, before, "still polling after the last unsubscribe");
});

await check("an unknown uri is refused on subscribe", async () => {
  await assert.rejects(client.subscribeResource({ uri: "ae://project/nope" }), /Unknown resource/);
});

await client.close();
await server.close();

await check("a live read goes through the panel version gate", async () => {
  reportedHash = "0".repeat(64);
  const g = await connect();
  const from = seen.length;
  await assert.rejects(g.client.readResource({ uri: "ae://project/summary" }), /panel|After Effects/i);
  assert.equal(seen.length, from, "a stale panel was sent a read");
  await g.client.close();
  await g.server.close();
  reportedHash = sourceBundleHash();
});

// ---------------------------------------------------------------------------
// The front desk: a poll read yields to ANY session's write lock.
// ---------------------------------------------------------------------------

await check("the desk refuses a yielding read, unsent, while another session holds the write lock", async () => {
  const sent = [];
  const desk = new FrontDesk(
    { runOp: async (op) => (sent.push(op), { ok: true }), cancel: async () => ({ known: true }), port: 1 },
    { port: 0, token: "t" }
  );
  const grant = await desk.lock.acquire({ op: "run_batch", sessionId: "other", session: "another session", maxWaitMs: 1000, maxDepth: 4 });
  const req = { sessionId: "me", session: "me", kind: "op", op: "_live_probe", args: {}, yieldToWrites: true };
  await assert.rejects(desk.forward(req), (e) => e instanceof BridgeBusyError && /run_batch/.test(e.message));
  assert.deepEqual(sent, [], "a yielding read reached the panel during another session's batch");
  // An agent's own read is never held back.
  await desk.forward({ ...req, yieldToWrites: false });
  assert.deepEqual(sent, ["_live_probe"]);
  desk.lock.release(grant.id);
  await desk.forward(req);
  assert.deepEqual(sent, ["_live_probe", "_live_probe"]);
  // And the refusal crosses the wire as itself.
  assert.ok(fromWire(toWire(new BridgeBusyError("_live_probe", "run_batch"))) instanceof BridgeBusyError);
});

// ---------------------------------------------------------------------------
// Each guard on its own, with a hand-driven clock and timer: nothing fires
// unless the test calls poll(), so no guard can pass by a timer being pushed
// back. Each check fails when its guard is removed.
// ---------------------------------------------------------------------------

const { LiveResources } = await import(dist("resources", "live.js"));
const { SessionLine } = await import(dist("frontdesk", "line.js"));
const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));

function rig() {
  const t = { now: 100_000, delays: [], reads: [], notes: [], writing: false, stale: null, probe: null, numItems: 2 };
  const live = new LiveResources({
    read: async (op) => {
      t.reads.push(op);
      return { path: "/p.aep", numItems: t.numItems, activeItemId: 2, items: [{ id: 2, name: "Main", type: "comp" }] };
    },
    probe: async () => {
      t.reads.push("_live_probe");
      if (t.probe) return t.probe();
      return { path: "/p.aep", numItems: t.numItems, activeItemId: 2, activeType: "comp", activeComp: { id: 2 }, comp: { id: 2 } };
    },
    notify: async (uri) => void t.notes.push(uri),
    writing: () => t.writing,
    gate: async () => t.stale,
    intervalMs: 5_000,
    quietMs: 2_000,
    sweepMs: 60_000,
    now: () => t.now,
    setTimer: (fn, ms) => (t.delays.push(ms), {}),
    clearTimer: () => {},
  });
  live.subscribe("ae://project/summary");
  return { t, live };
}

await check("guard: no tick runs while this session holds or waits on the write lease", async () => {
  const { t, live } = rig();
  t.writing = true;
  await live.poll();
  assert.deepEqual(t.reads, [], "a tick ran during a write");
  t.writing = false;
  await live.poll();
  assert.ok(t.reads.length > 0);
});

await check("guard: no tick runs inside the quiet period after this session's last write", async () => {
  const { t, live } = rig();
  await live.poll();
  live.noteWrite("set_transform");
  t.reads.length = 0;
  t.now += 1_999;
  await live.poll();
  assert.deepEqual(t.reads, [], "a tick ran inside the quiet period");
  t.now += 1;
  await live.poll();
  assert.deepEqual(t.reads, ["_live_probe"], "after the quiet period: the probe, and no walk for a non-renaming write");
});

await check("guard: the poll goes through the panel version gate", async () => {
  const { t, live } = rig();
  t.stale = "The running panel is older than this server.";
  await live.poll();
  assert.deepEqual(t.reads, [], "a stale panel was polled");
});

await check("guard: the summary is walked on the sweep even when the probe never moves", async () => {
  const { t, live } = rig();
  await live.poll();
  assert.deepEqual(t.reads, ["_live_probe", "get_project_summary"], "the first tick takes the baseline");
  t.reads.length = 0;
  t.now += 59_999;
  await live.poll();
  assert.deepEqual(t.reads, ["_live_probe"]);
  t.reads.length = 0;
  t.now += 1;
  await live.poll();
  assert.deepEqual(t.reads, ["_live_probe", "get_project_summary"], "no walk when the sweep fell due");
});

await check("guard: a poll refused as busy is skipped quietly — no warning, no backoff", async () => {
  const { t, live } = rig();
  await live.poll();
  t.probe = () => { throw new BridgeBusyError("_live_probe", "run_batch"); };
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await live.poll();
    await live.poll();
  } finally {
    console.error = orig;
  }
  assert.deepEqual(t.delays.slice(-2), [5_000, 5_000], `a busy tick backed off: ${t.delays.slice(-2)}`);
  assert.deepEqual(logged.filter((l) => /could not refresh/.test(l)), [], "a busy tick was logged as a failure");
});

await check("guard: SessionLine refuses a yielding read, unsent, while this session holds the write lease", async () => {
  const sent = [];
  const fakeBridge = { port: 1, runOp: async (op) => (sent.push(op), {}), cancel: async () => ({ known: true }), onPortChange() {} };
  const writes = new WriteQueue();
  const line = new SessionLine(fakeBridge, writes, { desk: null, sessionLabel: () => "test" });
  const lease = await writes.acquire("set_transform");
  await assert.rejects(line.runOp("_live_probe", {}, { yieldToWrites: true }), (e) => e instanceof BridgeBusyError);
  assert.deepEqual(sent, [], "a yielding read reached the panel during this session's write");
  await line.runOp("get_comp", { compId: 1 });
  assert.deepEqual(sent, ["get_comp"], "an agent's read is never held back");
  lease.release();
  await line.runOp("_live_probe", {}, { yieldToWrites: true });
  assert.deepEqual(sent, ["get_comp", "_live_probe"]);
});

await check("guard: the desk re-checks the lock at the last moment before sending", async () => {
  const sent = [];
  const desk = new FrontDesk(
    { runOp: async (op) => (sent.push(op), { ok: true }), cancel: async () => ({ known: true }), port: 1 },
    { port: 0, token: "t" }
  );
  const req = { sessionId: "me", session: "me", kind: "op", op: "_live_probe", args: {}, yieldToWrites: true };
  // The lock is free when the read arrives, and taken by another session's
  // write between the desk's first look and the post to the panel.
  await assert.rejects(
    desk.forward(req, {
      onStart: async () => {
        await desk.lock.acquire({ op: "run_batch", sessionId: "other", session: "another session", maxWaitMs: 1000, maxDepth: 4 });
      },
    }),
    (e) => e instanceof BridgeBusyError
  );
  assert.deepEqual(sent, [], "the read went out after another session took the lock");
});

// ---------------------------------------------------------------------------
// The remembered comp belongs to one project. Item ids are small numbers per
// .aep, so the same id in the next project is a different comp.
// ---------------------------------------------------------------------------

function stickyRig() {
  // `p` is what After Effects reports; comps are per project, keyed by id.
  const t = {
    p: { path: "/a.aep", docId: "xmp.did:A", activeItemId: 2 },
    comps: { "/a.aep|xmp.did:A": { 2: { id: 2, name: "Main (A)" } } },
    notes: [],
    asked: [],
  };
  const key = () => `${t.p.path}|${t.p.docId}`;
  const live = new LiveResources({
    read: async () => ({}),
    probe: async (args) => {
      t.asked.push(args);
      const comps = t.comps[key()] ?? {};
      const active = t.p.activeItemId === null ? null : comps[t.p.activeItemId] ?? null;
      return {
        path: t.p.path,
        numItems: Object.keys(comps).length,
        activeItemId: t.p.activeItemId,
        activeType: t.p.activeItemId === null ? null : active ? "comp" : "folder",
        activeComp: active,
        comp: args.compId ? comps[args.compId] ?? null : null,
        docId: args.identity ? t.p.docId : null,
      };
    },
    notify: async (uri) => void t.notes.push(uri),
    writing: () => false,
    gate: async () => null,
    intervalMs: 5_000,
    quietMs: 2_000,
    now: () => 0,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  live.subscribe("ae://project/active-comp");
  const read = async () => JSON.parse(await live.read("ae://project/active-comp"));
  return { t, live, read };
}

await check("sticky: focus away from the comp keeps it, in the same project", async () => {
  const { t, live, read } = stickyRig();
  await live.poll();
  t.p.activeItemId = null;
  await live.poll();
  const a = await read();
  assert.equal(a.compId, 2);
  assert.equal(a.comp.name, "Main (A)");
  assert.ok(t.asked.every((x) => x.identity === true), "every probe asks for the project's identity");
});

await check("sticky: opening another project drops the remembered comp, even where the same id exists", async () => {
  const { t, live, read } = stickyRig();
  await live.poll();
  t.p = { path: "/b.aep", docId: "xmp.did:B", activeItemId: null };
  t.comps["/b.aep|xmp.did:B"] = { 2: { id: 2, name: "Somebody else's comp (B)" } };
  await live.poll();
  assert.deepEqual(t.notes, ["ae://project/active-comp"]);
  const a = await read();
  assert.equal(a.compId, null, `served ${JSON.stringify(a)} from the other project`);
  assert.match(a.reason, /different project/);
  await live.poll();
  assert.deepEqual(t.notes, ["ae://project/active-comp"], "the reason must not change on the next tick, or that is a notification too");
});

await check("sticky: another saved project with no DocumentID is told apart by its path", async () => {
  const { t, live, read } = stickyRig();
  t.p = { path: "/a.aep", docId: null, activeItemId: 2 };
  t.comps["/a.aep|null"] = { 2: { id: 2, name: "Main (A)" } };
  await live.poll();
  t.p = { path: "/b.aep", docId: null, activeItemId: null };
  t.comps["/b.aep|null"] = { 2: { id: 2, name: "Somebody else's comp (B)" } };
  await live.poll();
  const a = await read();
  assert.equal(a.compId, null, `served ${JSON.stringify(a)} from the other project`);
});

await check("sticky: a new unsaved project drops the remembered comp", async () => {
  const { t, live, read } = stickyRig();
  await live.poll();
  t.p = { path: null, docId: "xmp.did:NEW", activeItemId: null };
  t.comps["null|xmp.did:NEW"] = { 2: { id: 2, name: "Comp 1 (new)" } };
  await live.poll();
  const a = await read();
  assert.equal(a.compId, null, `served ${JSON.stringify(a)} from the new project`);
});

await check("sticky: one unsaved project replaced by another is told apart by its DocumentID", async () => {
  const { t, live, read } = stickyRig();
  t.p = { path: null, docId: "xmp.did:U1", activeItemId: 2 };
  t.comps["null|xmp.did:U1"] = { 2: { id: 2, name: "Comp 1 (U1)" } };
  await live.poll();
  t.p = { path: null, docId: "xmp.did:U2", activeItemId: null };
  t.comps["null|xmp.did:U2"] = { 2: { id: 2, name: "Comp 1 (U2)" } };
  await live.poll();
  const a = await read();
  assert.equal(a.compId, null, `served ${JSON.stringify(a)} from the second unsaved project`);
});

await check("sticky: deleting the remembered comp drops it", async () => {
  const { t, live, read } = stickyRig();
  await live.poll();
  t.p.activeItemId = null;
  delete t.comps["/a.aep|xmp.did:A"][2];
  await live.poll();
  assert.deepEqual(t.notes, ["ae://project/active-comp"]);
  const a = await read();
  assert.equal(a.compId, null);
  assert.match(a.reason, /no longer exists/);
});

await check("another session's write, seen as a busy tick, earns the summary one walk", async () => {
  const { t, live } = rig();
  await live.poll();
  t.reads.length = 0;
  t.probe = () => { throw new BridgeBusyError("_live_probe", "set_comp", undefined, true); };
  await live.poll();
  t.probe = null;
  await live.poll();
  assert.deepEqual(t.reads, ["_live_probe", "_live_probe", "get_project_summary"], "no walk after another session wrote");
  t.reads.length = 0;
  await live.poll();
  assert.deepEqual(t.reads, ["_live_probe"], "one walk, not one per tick");
});

// ---------------------------------------------------------------------------
// Nothing listening: a closed port.
// ---------------------------------------------------------------------------

const dead = await new Promise((r) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});

await check("unreachable: a read fails with the tool path's message; a subscription stays quiet", async () => {
  const off = await connect({ bridge: new HttpClient(dead, { candidates: () => [dead] }) });
  await assert.rejects(off.client.readResource({ uri: "ae://project/summary" }), /Cannot reach the After Effects panel/);
  await off.client.subscribeResource({ uri: "ae://project/summary" });
  await sleep(POLL * 8);
  assert.deepEqual(off.updates, [], "a failing refresh must not notify");
  await off.client.close();
  await off.server.close();
});

bridge.close();
console.log(`live-resources: ${passed} checks passed`);
// A short drain before exit, as write-queue-server.mjs does: an exit straight
// after a fetch trips Node 24 on Windows (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
