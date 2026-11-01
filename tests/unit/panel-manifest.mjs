// The CEP manifest's shape, and the status panel that comes with it (issue #283).
//
// The bridge used to be a visible Panel with AutoVisible=true, so a window
// opened at every After Effects launch. It is now an invisible extension
// (Type Custom, AutoVisible false, no Menu) started by the activate event, and
// the window under Window > Extensions is a second extension that shows the
// bridge's status and runs nothing. Whether After Effects starts the hidden
// one is a live question (docs/verification-recipes.md); what this file holds
// is everything that can go wrong without After Effects:
//
//   - the bridge stays hidden, auto-started and Node-enabled;
//   - the status panel cannot start a second bridge — no Node, a page that
//     never loads main.js, and a script that binds nothing;
//   - the ids and event names agree between the manifest, main.js, status.js;
//   - status.js renders what the bridge reports, and asks CEP to open the
//     bridge exactly once when nothing answers.
//
//   node tests/unit/panel-manifest.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const panel = path.join(root, "packages", "ae-panel");
const read = (...p) => fs.readFileSync(path.join(panel, ...p), "utf8");

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`panel-manifest: ${name}`); throw err; }
}

const BRIDGE_ID = "games.engine-room.ae-mcp.panel";
const STATUS_ID = "games.engine-room.ae-mcp.status";

const manifest = read("CSXS", "manifest.xml").replace(/<!--[\s\S]*?-->/g, "");
const listed = [...manifest.matchAll(/<ExtensionList>([\s\S]*?)<\/ExtensionList>/g)][0][1];
const listedIds = [...listed.matchAll(/<Extension\s+Id="([^"]+)"\s+Version="([^"]+)"/g)].map((m) => ({ id: m[1], version: m[2] }));
const dispatch = {};
for (const m of manifest.matchAll(/<DispatchInfoList>([\s\S]*?)<\/DispatchInfoList>/g)) {
  for (const e of m[1].matchAll(/<Extension\s+Id="([^"]+)">([\s\S]*?)<\/Extension>/g)) dispatch[e[1]] = e[2];
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : null; };

check("the bundle lists exactly the bridge and the status panel, each with a DispatchInfo", () => {
  assert.deepEqual(listedIds.map((e) => e.id).sort(), [BRIDGE_ID, STATUS_ID]);
  assert.deepEqual(Object.keys(dispatch).sort(), [BRIDGE_ID, STATUS_ID]);
  const bundleVersion = manifest.match(/ExtensionBundleVersion="([^"]+)"/)[1];
  for (const e of listedIds) assert.equal(e.version, bundleVersion, `${e.id} must carry the bundle version (scripts/sync-version.mjs)`);
});

check("the bridge is an invisible extension: Custom, AutoVisible false, no Menu", () => {
  const b = dispatch[BRIDGE_ID];
  assert.equal(tag(b, "Type"), "Custom");
  assert.equal(tag(b, "AutoVisible"), "false");
  assert.equal(tag(b, "Menu"), null, "a Menu would list the hidden bridge under Window > Extensions, where opening it shows a 1px window");
  assert.match(tag(b, "Size"), /<Height>\d+<\/Height>/, "CEP requires a Size even for an invisible extension");
});

check("the bridge starts on After Effects' activate event, with Node", () => {
  const b = dispatch[BRIDGE_ID];
  const events = [...(tag(b, "StartOn") ?? "").matchAll(/<Event>([^<]+)<\/Event>/g)].map((m) => m[1]);
  assert.ok(events.includes("com.adobe.csxs.events.ApplicationActivate"), `StartOn: ${events.join(", ")}`);
  const params = [...(tag(b, "CEFCommandLine") ?? "").matchAll(/<Parameter>([^<]+)<\/Parameter>/g)].map((m) => m[1]);
  assert.ok(params.includes("--enable-nodejs"), "the bridge needs Node for http and fs");
  assert.ok(params.includes("--mixed-context"), "main.js reaches CSInterface and require from one context");
  assert.equal(tag(b, "MainPath"), "./client/index.html");
});

check("the status panel is the visible window, and cannot run Node or start on its own", () => {
  const s = dispatch[STATUS_ID];
  assert.equal(tag(s, "Type"), "Panel");
  assert.equal(tag(s, "Menu"), "AE MCP Bridge", "Window > Extensions > AE MCP Bridge is what every guide names");
  assert.equal(tag(s, "StartOn"), null, "the status panel opens only when the user asks for it");
  assert.doesNotMatch(s, /--enable-nodejs/, "without Node the status page cannot bind a port even by mistake");
  assert.equal(tag(s, "MainPath"), "./client/status.html");
});

const indexHtml = read("client", "index.html");
const statusHtml = read("client", "status.html");
const statusJs = read("client", "status.js");
const mainJs = read("client", "main.js");
const scripts = (html) => [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

check("only the bridge's page loads main.js", () => {
  assert.ok(scripts(indexHtml).includes("./main.js"));
  assert.ok(!scripts(statusHtml).some((s) => /main\.js$/.test(s)), `status.html loads ${scripts(statusHtml).join(", ")}`);
  assert.ok(scripts(statusHtml).includes("./status.js"));
});

check("status.js binds nothing and requires nothing", () => {
  const code = statusJs.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\brequire\s*\(/);
  assert.doesNotMatch(code, /createServer|\.listen\s*\(|WebSocket/);
});

const ids = (src) => ({
  status: src.match(/STATUS_EVENT = "([^"]+)"/)?.[1],
  request: src.match(/STATUS_REQUEST = "([^"]+)"/)?.[1],
});

check("main.js and status.js agree on the event names, and status.js names the bridge's id", () => {
  assert.deepEqual(ids(statusJs), ids(mainJs));
  assert.equal(ids(mainJs).status, "games.engine-room.ae-mcp.status");
  assert.equal(statusJs.match(/BRIDGE_ID = "([^"]+)"/)?.[1], BRIDGE_ID);
});

// ---------------------------------------------------------------------------
// status.js against a stub CEP host, with a clock this test turns.
// ---------------------------------------------------------------------------
function runStatus() {
  let now = 1_000_000;
  const ticks = [];
  const host = { dispatched: [], listeners: {}, opened: [] };
  host.dispatchEvent = (ev) => host.dispatched.push({ type: ev.type, data: ev.data });
  host.addEventListener = (type, fn) => { (host.listeners[type] ??= []).push(fn); };
  host.requestOpenExtension = (id) => host.opened.push(id);
  const mk = () => ({
    textContent: "", className: "", childNodes: [],
    appendChild(n) { this.childNodes.push(n); },
    removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); },
    get firstChild() { return this.childNodes[0] ?? null; },
  });
  const nodes = {};
  for (const id of ["status", "port", "ae", "jsx", "reqs", "log"]) nodes[id] = mk();
  class FakeDate { getTime() { return now; } }
  const sandbox = {
    JSON, String, Math,
    Date: FakeDate,
    window: { __adobe_cep__: host },
    document: { getElementById: (id) => nodes[id] ?? null, createElement: () => mk() },
    setInterval: (fn) => { ticks.push(fn); return 1; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("client", "csinterface.js"), sandbox);
  vm.runInContext(statusJs, sandbox);
  const advance = (ms) => { for (let t = 0; t < ms; t += 2000) { now += 2000; for (const fn of ticks) fn(); } };
  const say = (state) => { for (const fn of host.listeners["games.engine-room.ae-mcp.status"] ?? []) fn({ data: JSON.stringify(state) }); };
  return { host, nodes, advance, say };
}

check("status.js asks at once, and renders what the bridge answers", () => {
  const s = runStatus();
  assert.equal(s.host.dispatched[0].type, "games.engine-room.ae-mcp.status.request");
  s.say({ status: "ready", statusClass: "ok", port: "7777", portClass: "ok", ae: "AEFT 26.5", jsx: "loaded", jsxClass: "ok", reqs: 3,
    log: [{ level: "", text: "[10:00:00] Bridge listening on http://127.0.0.1:7777" }] });
  assert.equal(s.nodes.status.textContent, "ready");
  assert.equal(s.nodes.status.className, "ok");
  assert.equal(s.nodes.port.textContent, "7777");
  assert.equal(s.nodes.reqs.textContent, "3");
  assert.equal(s.nodes.log.childNodes.length, 1);
  // An answering bridge is never asked to open.
  for (let i = 0; i < 10; i++) { s.advance(2000); s.say({ status: "ready" }); }
  assert.deepEqual(s.host.opened, []);
});

check("status.js asks CEP to open the bridge once when nothing answers, then says it is not running", () => {
  const s = runStatus();
  s.advance(6000);
  assert.deepEqual(s.host.opened, [BRIDGE_ID]);
  assert.match(s.nodes.status.textContent, /no answer from the bridge/);
  s.advance(20000);
  assert.deepEqual(s.host.opened, [BRIDGE_ID], "opening is asked once, not on every tick");
  assert.equal(s.nodes.status.textContent, "the bridge is not running");
  // A bridge that comes up late still takes the window over.
  s.say({ status: "ready", statusClass: "ok", port: "7777" });
  assert.equal(s.nodes.status.textContent, "ready");
});

console.log(`panel-manifest: ${passed} checks passed`);
