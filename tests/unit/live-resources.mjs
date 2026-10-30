// Live project resources with change notifications (issue #248).
//
// The real MCP server over an in-memory transport, against a stub bridge on an
// ephemeral port whose "project" the test edits. What is pinned:
//
//   - nobody subscribed → not one op reaches the bridge, however long we wait;
//   - subscribe → change the project → notifications/resources/updated, once,
//     for that uri only; no change → no notification;
//   - unsubscribe → the polling stops;
//   - a refresh never runs while a write holds the lease;
//   - an unreachable panel: a read fails with the tool path's sentence, and a
//     subscription on it neither crashes nor notifies.
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
// The stub panel and the project it describes.
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
/** Every /op the stub saw: op, entered, left. */
const seen = [];
const slow = new Map();

const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { op, args } = JSON.parse(body || "{}");
    const entry = { op, enteredAt: Date.now() };
    seen.push(entry);
    await new Promise((r) => setTimeout(r, slow.get(op) ?? 2));
    let result;
    if (op === "get_project_summary") result = { path: project.path, numItems: project.items.length, activeItemId: project.activeItemId, items: project.items };
    else if (op === "get_comp") result = comps[args.compId];
    else result = { ok: true, op };
    entry.leftAt = Date.now();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
});
new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { ResourceUpdatedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");

const POLL = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(opts) {
  const server = createServer({ livePollMs: POLL, ...opts });
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
const ops = () => seen.filter((s) => s.op === "get_project_summary" || s.op === "get_comp").length;

const { server, client, updates } = await connect();

await check("subscribe is declared, and the live resources are listed beside the guides", async () => {
  assert.equal(client.getServerCapabilities().resources?.subscribe, true);
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
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
  const r = await client.readResource({ uri: "ae://project/summary" });
  const body = JSON.parse(r.contents[0].text);
  assert.equal(body.activeItemId, 2);
  assert.equal(body.items.length, 2);
  const a = JSON.parse((await client.readResource({ uri: "ae://project/active-comp" })).contents[0].text);
  assert.equal(a.comp.name, "Main");
  const g = await client.readResource({ uri: "ae://guide/after-effects" });
  assert.ok(g.contents[0].text.startsWith("# Driving After Effects"));
});

await check("subscribe, change the project: one notification for that uri, none without a change", async () => {
  updates.length = 0;
  await client.subscribeResource({ uri: "ae://project/summary" });
  await sleep(POLL * 4);
  assert.deepEqual(updates, [], "no change, so no notification");
  project.items.push({ id: 3, name: "Intro", type: "comp" });
  for (let i = 0; i < 40 && updates.length === 0; i++) await sleep(POLL / 2);
  assert.deepEqual(updates, ["ae://project/summary"]);
  await sleep(POLL * 4);
  assert.deepEqual(updates, ["ae://project/summary"], "one change is one notification");
});

await check("the active comp notifies when the user switches comps", async () => {
  updates.length = 0;
  comps[3] = { id: 3, name: "Intro", width: 1080, height: 1920, numLayers: 1 };
  await client.subscribeResource({ uri: "ae://project/active-comp" });
  await sleep(POLL * 4);
  updates.length = 0;
  project.activeItemId = 3;
  for (let i = 0; i < 40 && !updates.includes("ae://project/active-comp"); i++) await sleep(POLL / 2);
  assert.ok(updates.includes("ae://project/active-comp"), `got ${JSON.stringify(updates)}`);
});

await check("a refresh never runs while a write holds the lease", async () => {
  slow.set("set_transform", POLL * 8);
  seen.length = 0;
  await client.callTool({ name: "set_transform", arguments: { compId: 2, layerId: 1, properties: { opacity: 50 } } });
  slow.delete("set_transform");
  const w = seen.find((s) => s.op === "set_transform");
  const inside = seen.filter((s) => s.op !== "set_transform" && s.enteredAt < w.leftAt && s.leftAt > w.enteredAt);
  assert.deepEqual(inside.map((s) => s.op), [], "a refresh overlapped the write");
});

await check("unsubscribing from both stops the polling", async () => {
  await client.unsubscribeResource({ uri: "ae://project/summary" });
  await client.unsubscribeResource({ uri: "ae://project/active-comp" });
  await sleep(POLL * 2);
  const before = ops();
  await sleep(POLL * 6);
  assert.equal(ops(), before, "still polling after the last unsubscribe");
});

await check("an unknown uri is refused on subscribe", async () => {
  await assert.rejects(client.subscribeResource({ uri: "ae://project/nope" }), /Unknown resource/);
});

await client.close();
await server.close();

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
process.exit(0);
