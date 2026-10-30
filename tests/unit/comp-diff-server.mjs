// diff_comp as the agent meets it, through tools/call (issue #220, stage 1).
//
// The diff moved out of ExtendScript into the server. What makes that safe on
// every panel ever installed is that the server now asks the bridge for
// nothing but `_comp_fingerprint` — an op every bundle has carried since
// snapshots landed. This drives the real MCP server over an in-memory
// transport against a stub bridge that answers only that op and refuses
// `_comp_diff` outright, so a regression back to the panel-side diff fails
// here rather than in a user's session. The diff's own content is covered by
// tests/unit/comp-snapshot.mjs, against both copies.
//
//   node tests/unit/comp-diff-server.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));
const { diffFingerprints } = await import(dist("snapshots", "diff.js"));

const layer = (id, index, over = {}) => ({
  id, name: "L" + id, index, type: "shape",
  inPoint: 0, outPoint: 5, startTime: 0, parentId: null, enabled: true,
  keyCounts: {}, expressionCount: 0, effectCount: 0, ...over,
});
const fingerprint = (layers) => ({
  compId: 7, name: "Main", width: 1920, height: 1080, duration: 10, frameRate: 30,
  workAreaStart: 0, workAreaDuration: 10, numLayers: layers.length, markers: [], layers,
});

// What the comp looks like on each successive _comp_fingerprint call.
const states = [
  fingerprint([layer(498, 1)]),
  fingerprint([layer(498, 1, { keyCounts: { Opacity: 4 } }), layer(512, 2), layer(513, 3)]),
];
const seen = [];

// Never port 7777 — a real panel may hold that on this machine.
const bridge = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op, args } = JSON.parse(body || "{}");
    seen.push({ op, args });
    if (op === "_comp_fingerprint") {
      res.end(JSON.stringify({ ok: true, result: states[Math.min(seen.length - 1, states.length - 1)] }));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: { message: `Unknown op: ${op}` } }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "comp-diff-server-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

let passed = 0;

const snap = await call("snapshot_comp", { compId: 7 });
const d = await call("diff_comp", { since: snap.snapshotId });

assert.deepEqual(seen.map((s) => s.op), ["_comp_fingerprint", "_comp_fingerprint"],
  "diff_comp must ask the bridge only for a fingerprint — never _comp_diff");
passed++;
assert.deepEqual(seen[1].args, { compId: 7 }, "the fresh fingerprint is of the snapshot's comp");
passed++;

// The tool's answer is the diff, then the three fields the server adds — in
// that order, with nothing of the diff's own altered.
const expected = diffFingerprints(states[0], states[1]);
const { since, snapshotId, ...rest } = d;
assert.equal(JSON.stringify(rest), JSON.stringify(expected), "the diff reaches the agent unaltered");
passed++;
assert.deepEqual(Object.keys(d).slice(-2), ["since", "snapshotId"], "the server's fields follow the diff");
passed++;
assert.equal(since, snap.snapshotId);
assert.ok(/^snap_/.test(snapshotId) && snapshotId !== snap.snapshotId, "the fresh fingerprint is stored as a new snapshot");
passed++;
assert.match(d.summary, /2 layers added: ids 512, 513; layer 498 Opacity keys 0 -> 4/);
passed++;

// Diffing forward from the new snapshot works without another snapshot_comp.
const again = await call("diff_comp", { since: snapshotId, includeFingerprint: true });
assert.equal(again.changeCount, 0, "nothing moved between the second and third fingerprint");
assert.equal(again.fingerprint.layers.length, 3, "includeFingerprint returns the fresh fingerprint");
passed++;

console.log(`comp-diff-server: ${passed} checks passed`);
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
