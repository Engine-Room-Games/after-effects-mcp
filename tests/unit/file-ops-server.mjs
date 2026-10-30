// The file work that moved to the server (issue #220, stage 2), as the agent
// meets it through tools/call.
//
// What makes the move safe on every installed panel is that the server asks
// the bridge only for things every bundle has: `get_project_summary` for the
// .aep's path, and the export/render/import ops themselves. This drives the
// real MCP server over an in-memory transport against a stub bridge that
// refuses get_house_style and set_house_style outright, so a regression back to
// the panel-side house style fails here. The checks' own wording is covered by
// house-style-files.mjs and destination-checks.mjs, against the jsx copies.
//
//   node tests/unit/file-ops-server.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-fileops-")));
const aep = path.join(dir, "show.aep");
fs.writeFileSync(aep, "aep");

let projectPath = aep;
/** What the stub does for each op other than get_project_summary. */
const answers = {};
const seen = [];

// Never port 7777 — a real panel may hold that on this machine.
const bridge = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op, args } = JSON.parse(body || "{}");
    seen.push({ op, args });
    if (op === "get_project_summary") {
      res.end(JSON.stringify({ ok: true, result: { path: projectPath, numItems: 1, activeItemId: null, items: [{ id: 7, name: "LT", type: "comp" }] } }));
      return;
    }
    const a = answers[op];
    if (a) {
      res.end(JSON.stringify(typeof a === "function" ? a(args) : a));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: `Unknown op: ${op}` }));
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
const client = new Client({ name: "file-ops-server-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

async function call(name, args) {
  seen.length = 0;
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, text: res.content[0]?.text ?? "" };
}
const ops = () => seen.map((s) => s.op);
let passed = 0;
const guide = path.join(dir, "house-style.md");

// ---------- house style ----------

let r = await call("get_house_style", {});
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["get_project_summary"], "the guide is read by the server, never by the panel");
assert.equal(JSON.parse(r.text).found, false);
passed++;

r = await call("set_house_style", { content: "# Style\n\n## Palette\n- Ink #111111\n" });
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["get_project_summary"]);
assert.deepEqual(JSON.parse(r.text), { ok: true, path: guide, bytes: 34, created: true, replaced: false });
assert.equal(fs.readFileSync(guide, "utf8"), "# Style\n\n## Palette\n- Ink #111111\n", "LF on disk");
passed++;

r = await call("set_house_style", { content: "# Other\n" });
assert.equal(r.isError, true);
assert.equal(r.text.split("\n")[0],
  "AE: A style guide already exists at " + guide + ". Read it with get_house_style, merge your changes into the full document, and call again with overwrite: true.",
  "the refusal reads exactly as the panel's did, less the bundle line number");
passed++;

r = await call("get_house_style", { detail: "full" });
const full = JSON.parse(r.text);
assert.equal(full.content, "# Style\n\n## Palette\n- Ink #111111\n");
assert.equal(full.detail, "full");
r = await call("get_house_style", {});
const summary = JSON.parse(r.text);
assert.equal(summary.detail, "summary", "still summarised by default");
assert.equal(summary.content, undefined);
passed++;

projectPath = null;
r = await call("get_house_style", {});
assert.equal(JSON.parse(r.text).projectSaved, false);
r = await call("set_house_style", { content: "# x\n" });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: This After Effects project has never been saved/);
projectPath = aep;
passed++;

// ---------- add_to_render_queue ----------

answers.add_to_render_queue = { ok: true, result: { index: 1, status: "QUEUED" } };
r = await call("add_to_render_queue", { compId: 7, outputPath: path.join(dir, "missing", "x.mov") });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: The folder for outputPath does not exist: /);
assert.deepEqual(ops(), [], "a refused path never reaches After Effects");
passed++;

r = await call("add_to_render_queue", { compId: 7, outputPath: path.join(dir, "x.mov") });
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["add_to_render_queue"]);
passed++;

// ---------- import_footage ----------

r = await call("import_footage", { path: path.join(dir, "nope.png") });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: No file at /);
assert.deepEqual(ops(), []);
passed++;

// ---------- export_mogrt ----------

const out = path.join(dir, "templates", "lt");
answers.export_mogrt = (args) => ({
  ok: true,
  result: { ok: true, path: args.destDir + "/" + args.name + ".mogrt", bytes: 3, createdDir: false },
});
r = await call("export_mogrt", { compId: 7, name: "LT", destDir: out });
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["get_project_summary", "export_mogrt"]);
assert.equal(JSON.parse(r.text).createdDir, true, "the folder the server made is reported as made");
assert.ok(fs.existsSync(out));
passed++;

fs.writeFileSync(path.join(out, "LT.mogrt"), "zip");
r = await call("export_mogrt", { compId: 7, name: "LT", destDir: out });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: A template already exists at /);
assert.deepEqual(ops(), ["get_project_summary"], "refused before After Effects is asked to export");
passed++;

// After Effects refuses (an empty Essential Graphics panel, say): the folder
// the server made for it goes again, as the jsx never made one.
answers.export_mogrt = { ok: false, error: "This comp has 0 Essential Graphics controllers, and …", line: 1 };
const fresh = path.join(dir, "templates", "never");
r = await call("export_mogrt", { compId: 7, name: "LT", destDir: fresh });
assert.equal(r.isError, true);
assert.match(r.text, /0 Essential Graphics controllers/);
assert.equal(fs.existsSync(fresh), false, "an empty folder made for a refused export is removed");
passed++;

console.log(`file-ops-server: ${passed} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
