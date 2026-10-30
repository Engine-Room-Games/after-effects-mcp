// The MCP Apps comp-timeline view (issue #246), as two clients meet it.
//
// The promise is "strictly additive": a client that did not declare the
// `io.modelcontextprotocol/ui` extension gets exactly the tool list, resource
// list and tool results it always had, and one that did gets the same text
// plus a linked `ui://` view and the view's data on the result's `_meta`.
// Both clients drive the real MCP server over an in-memory transport against
// a stub bridge that answers only `_comp_fingerprint`, so the view can never
// have quietly started asking After Effects for more.
//
//   node tests/unit/mcp-apps.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));
const apps = await import(dist("apps", "compTimeline.js"));
const { UI_EXTENSION, UI_MIME, COMP_TIMELINE_URI, VIEW_DATA_KEY, MAX_VIEW_LAYERS, MAX_VIEW_MARKERS, MAX_VIEW_REMOVED, COMP_TIMELINE_HTML } = apps;

const layer = (id, index, over = {}) => ({
  id, name: "L" + id, index, type: "shape",
  inPoint: 0, outPoint: 5, startTime: 0, parentId: null, enabled: true,
  keyCounts: {}, expressionCount: 0, effectCount: 0, ...over,
});
const fingerprint = (layers) => ({
  compId: 7, name: "Main", width: 1920, height: 1080, duration: 10, frameRate: 30,
  workAreaStart: 0, workAreaDuration: 10, numLayers: layers.length, markers: ["2|beat|0"], layers,
});
// Successive fingerprints: 498 gains keys, 499 is removed, 512 is added.
const states = [
  fingerprint([layer(498, 1), layer(499, 2, { inPoint: 1, outPoint: 3 })]),
  fingerprint([layer(498, 1, { keyCounts: { Opacity: 4 } }), layer(512, 2, { parentId: 498 })]),
];
let calls = 0;
const ops = [];

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
    const { op } = JSON.parse(body || "{}");
    ops.push(op);
    if (op === "_comp_fingerprint") {
      // Each client sees state 0 on its snapshot and state 1 on its diff.
      res.end(JSON.stringify({ ok: true, result: states[calls++ % 2] }));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: { message: `Unknown op: ${op}` } }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
assert.notEqual(bridge.address().port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(bridge.address().port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function connect(capabilities) {
  const server = createServer();
  const client = new Client({ name: "mcp-apps-test", version: "0" }, { capabilities });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
  passed++;
}

async function session(client) {
  const tools = (await client.listTools()).tools;
  const resources = (await client.listResources()).resources;
  const snap = await client.callTool({ name: "snapshot_comp", arguments: { compId: 7 } });
  const snapBody = JSON.parse(snap.content[0].text);
  const diff = await client.callTool({ name: "diff_comp", arguments: { since: snapBody.snapshotId } });
  return { tools, resources, snap, snapBody, diff };
}

const plain = await session(await connect({}));
const ui = await session(await connect({ extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } } }));
// A client declaring the extension for some other MIME type cannot render this view.
const otherMime = await connect({ extensions: { [UI_EXTENSION]: { mimeTypes: ["text/x-other"] } } });

// ---- 1. Without the extension: nothing changes -------------------------------

check("no tool carries _meta for a client without MCP Apps", () => {
  for (const t of plain.tools) assert.equal(t._meta, undefined, `${t.name} must not carry _meta`);
});
check("no ui:// resource is listed for a client without MCP Apps", () => {
  assert.ok(plain.resources.length > 0, "the guide resources are still listed");
  assert.ok(plain.resources.every((r) => !r.uri.startsWith("ui://")));
});
check("a plain client's snapshot and diff results carry no _meta", () => {
  assert.equal(plain.snap._meta, undefined);
  assert.equal(plain.diff._meta, undefined);
  assert.equal(plain.snap.content.length, 1);
});
{
  const t = (await otherMime.listTools()).tools;
  check("other MIME type: no tool _meta", () => assert.ok(t.every((x) => x._meta === undefined)));
}

// ---- 2. With the extension: linked, listed, readable --------------------------

check("snapshot_comp and diff_comp link the timeline view, and nothing else does", () => {
  const linked = ui.tools.filter((t) => t._meta).map((t) => t.name).sort();
  assert.deepEqual(linked, ["diff_comp", "snapshot_comp"]);
  for (const name of linked) {
    const m = ui.tools.find((t) => t.name === name)._meta;
    assert.equal(m.ui.resourceUri, COMP_TIMELINE_URI);
    assert.deepEqual(m, { ui: { resourceUri: COMP_TIMELINE_URI } }, "the spec's nested form only; the flat ui/resourceUri is deprecated");
  }
});
check("tool schemas, descriptions and annotations are identical for both clients", () => {
  assert.equal(ui.tools.length, plain.tools.length);
  for (const t of ui.tools) {
    const p = plain.tools.find((x) => x.name === t.name);
    const { _meta, ...rest } = t;
    assert.deepEqual(rest, p, `${t.name} differs beyond _meta`);
  }
});
check("the view is listed as a ui:// resource with the MCP Apps MIME type", () => {
  const r = ui.resources.find((x) => x.uri === COMP_TIMELINE_URI);
  assert.ok(r, "listed");
  assert.equal(r.mimeType, UI_MIME);
  assert.equal(ui.resources.length, plain.resources.length + 1, "the guides are all still there");
});

const uiClient = await connect({ extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } } });
const read = await uiClient.readResource({ uri: COMP_TIMELINE_URI });
check("the view is readable, self-contained and bounded", () => {
  const c = read.contents[0];
  assert.equal(c.uri, COMP_TIMELINE_URI);
  assert.equal(c.mimeType, UI_MIME);
  assert.equal(c.text, COMP_TIMELINE_HTML);
  assert.ok(c.text.length < 24_000, `the view is ${c.text.length} chars; keep it small`);
  assert.doesNotMatch(c.text, /https?:\/\//, "the view loads nothing from the network");
  assert.doesNotMatch(c.text, /<script[^>]+src=|<link[^>]+href=|@import/i, "no external script, style or import");
  assert.equal(c._meta?.ui?.csp, undefined, "no CSP domains declared: the host's no-network default applies");
  assert.doesNotMatch(c.text, /innerHTML/, "project strings go in through textContent only");
});
check("the view's script compiles and speaks the MCP Apps handshake", () => {
  const script = COMP_TIMELINE_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  new Function(script); // throws on a syntax error, runs nothing
  for (const m of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed"]) {
    assert.ok(script.includes(`"${m}"`), `the view handles ${m}`);
  }
  assert.ok(script.includes(VIEW_DATA_KEY), "the view reads the key the server writes");
});

// ---- 3. Results: same text, plus the view's data on _meta ---------------------

const strip = (body) => { const { snapshotId, takenAt, since, next, ...rest } = body; return rest; };
check("the text content is the same for both clients", () => {
  assert.deepEqual(strip(ui.snapBody), strip(plain.snapBody));
  assert.deepEqual(strip(JSON.parse(ui.diff.content[0].text)), strip(JSON.parse(plain.diff.content[0].text)));
  assert.equal(ui.snapBody.fingerprint, undefined, "the fingerprint stays out of the model's text");
});
check("snapshot_comp carries the fingerprint for the view on _meta", () => {
  const v = ui.snap._meta[VIEW_DATA_KEY];
  assert.equal(v.kind, "snapshot");
  assert.deepEqual(v.fingerprint, states[0]);
  assert.equal(v.layersOmitted, 0);
  assert.equal(v.markersOmitted, 0);
});
check("diff_comp carries the fresh fingerprint and the diff by layer id", () => {
  const v = ui.diff._meta[VIEW_DATA_KEY];
  assert.equal(v.kind, "diff");
  assert.deepEqual(v.fingerprint, states[1]);
  assert.deepEqual(v.diff.added, [512]);
  assert.deepEqual(Object.keys(v.diff.changed), ["498"]);
  assert.deepEqual(v.diff.removed, [{ id: 499, name: "L499", type: "shape", inPoint: 1, outPoint: 3 }],
    "a removed layer keeps its old timing, from the previous snapshot, to draw as a ghost");
  assert.equal(v.diff.changesOmitted, 0);
});
check("the view asked After Effects for nothing new", () => {
  assert.ok(ops.every((o) => o === "_comp_fingerprint"), `ops seen: ${ops.join(", ")}`);
  assert.equal(ops.length, 4, "one fingerprint per snapshot and per diff, for each client");
});

// ---- 4. Bounded -----------------------------------------------------------------

check("a comp past the layer cap is drawn truncated and says how many it left out", () => {
  const many = fingerprint(Array.from({ length: MAX_VIEW_LAYERS + 37 }, (_, i) => layer(1000 + i, i + 1)));
  const v = apps.snapshotViewData(many);
  assert.equal(v.fingerprint.layers.length, MAX_VIEW_LAYERS);
  assert.equal(v.layersOmitted, 37);
  assert.equal(many.layers.length, MAX_VIEW_LAYERS + 37, "the stored fingerprint is not mutated");
});
check("comp markers are capped, drawn once, and the remainder counted", () => {
  const fp = fingerprint([layer(1, 1)]);
  fp.markers = Array.from({ length: MAX_VIEW_MARKERS + 900 }, (_, i) => `${(i % 100) / 10}|m${i}|0`);
  const v = apps.snapshotViewData(fp);
  assert.equal(v.fingerprint.markers.length, MAX_VIEW_MARKERS);
  assert.equal(v.markersOmitted, 900);
  assert.equal(fp.markers.length, MAX_VIEW_MARKERS + 900, "the stored fingerprint is not mutated");
  const script = COMP_TIMELINE_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotMatch(script, /underlay\(/, "markers are not redrawn inside every row");
  assert.match(script, /var over=el\("div","over"\)/, "markers go into one shared overlay");
  assert.match(script, /markersOmitted/, "the view says how many markers it left out");
});
check("a diff's changes are bounded by the same cut as the layers, and the rest counted", () => {
  const n = MAX_VIEW_LAYERS + 50;
  const before = fingerprint(Array.from({ length: n + MAX_VIEW_REMOVED + 7 }, (_, i) => layer(1 + i, i + 1)));
  const after = fingerprint(Array.from({ length: n }, (_, i) => layer(1 + i, i + 1, { keyCounts: { Opacity: 2 } })));
  after.layers.push(layer(99999, n + 1)); // added past the cut
  const diff = {
    summary: "s", changeCount: 0,
    added: [{ id: 99999 }],
    changed: after.layers.slice(0, n).map((l) => ({ id: l.id, name: l.name, changes: { keyCounts: {} } })),
    removed: before.layers.slice(n).map((l) => ({ id: l.id, name: l.name, type: l.type })),
  };
  const v = apps.diffViewData(before, after, diff);
  assert.equal(v.fingerprint.layers.length, MAX_VIEW_LAYERS);
  assert.deepEqual(v.diff.added, [], "an added layer past the cut is not sent");
  assert.equal(Object.keys(v.diff.changed).length, MAX_VIEW_LAYERS, "only changes to drawn layers travel");
  assert.equal(v.diff.removed.length, MAX_VIEW_REMOVED);
  assert.equal(v.diff.changesOmitted, 1 + 50 + 7, "added + changed past the cut + removed past the cap");
  assert.match(COMP_TIMELINE_HTML, /diff\.changesOmitted/, "the view names what it left out");
});
check("the view never asks for includeFingerprint, which the agent is not to pass for it", () => {
  assert.doesNotMatch(COMP_TIMELINE_HTML, /textContent=[^;]*includeFingerprint/);
});
check("size is reported after the handshake and measured so the view can shrink", () => {
  const script = COMP_TIMELINE_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.match(script, /function size\(\)\{\s*if\(!ready\)return;/, "no size report before ui/notifications/initialized");
  assert.ok(script.indexOf('notify("ui/notifications/initialized"') < script.indexOf("ready=true"), "ready only after initialized");
  assert.doesNotMatch(script, /scrollHeight/, "a stretched body's scrollHeight never shrinks");
});
check("a text-fallback diff is not labelled a snapshot", () => {
  assert.ok(COMP_TIMELINE_HTML.includes('kind:j.changeCount!==undefined?"diff-text":"snapshot"'));
});
check("clientSupportsApps reads the declared capability and nothing else", () => {
  assert.equal(apps.clientSupportsApps(undefined), false);
  assert.equal(apps.clientSupportsApps({}), false);
  assert.equal(apps.clientSupportsApps({ extensions: {} }), false);
  assert.equal(apps.clientSupportsApps({ extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } } }), true);
  assert.equal(apps.clientSupportsApps({ extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html"] } } }), false);
  assert.equal(apps.clientSupportsApps({ extensions: { [UI_EXTENSION]: {} } }), false, "mimeTypes is required by the spec");
});

console.log(`mcp-apps: ${passed} checks passed`);
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
