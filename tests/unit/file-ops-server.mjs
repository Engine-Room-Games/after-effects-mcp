// The filesystem checks that moved to the server (issue #220, stage 2), as the
// agent meets them through tools/call.
//
// This drives the real MCP server over an in-memory transport against a stub
// bridge, and pins what the parity suite (destination-checks.mjs) cannot see:
//   - A refused call never reaches After Effects, and a passing call costs no
//     extra round trip: the server asks nothing else first, `get_project_summary`
//     (which walks every project item on AE's main thread) least of all.
//   - The server's checks have no side effects: a refused export leaves no
//     folder, and a new destination is left for the panel to create.
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
const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-fileops-")));

/** What the stub answers, per op. */
const answers = {};
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
    const a = answers[op];
    res.end(JSON.stringify(a ? (typeof a === "function" ? a(args) : a) : { ok: false, error: `Unknown op: ${op}` }));
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

// ---------- the house style: one cheap path question, the file read here ----------

fs.writeFileSync(path.join(dir, "p.aep"), "aep");
fs.writeFileSync(path.join(dir, "house-style.md"), "# Style\n");
answers._project_path = { ok: true, result: { projectSaved: true, path: path.join(dir, "p.aep"), unsavedChanges: false } };
let r = await call("get_house_style", { detail: "full" });
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["_project_path"], "no project walk to find the .aep, and no file I/O on the panel");
assert.equal(JSON.parse(r.text).detail, "full");
passed++;

// ---------- add_to_render_queue ----------

answers.add_to_render_queue = { ok: true, result: { index: 1, status: "QUEUED" } };
r = await call("add_to_render_queue", { compId: 7, outputPath: path.join(dir, "missing", "x.mov") });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: The folder for outputPath does not exist: /);
assert.deepEqual(ops(), [], "refused without asking After Effects anything");
assert.equal(fs.existsSync(path.join(dir, "missing")), false);
passed++;

r = await call("add_to_render_queue", { compId: 7, outputPath: path.join(dir, "x.mov") });
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["add_to_render_queue"], "a passing call costs no extra round trip");
passed++;

// ---------- import_footage ----------

r = await call("import_footage", { path: path.join(dir, "nope.png") });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: No file at /);
assert.deepEqual(ops(), []);
passed++;

// ---------- export_mogrt ----------

answers._export_mogrt = (args) => ({
  ok: true,
  result: { ok: true, path: args.destDir + "/" + args.name + ".mogrt", bytes: 3, createdDir: true },
});

// A new destination is the panel's to create: the server checks the name and
// forwards, and makes nothing on the way.
const fresh = path.join(dir, "templates", "new");
r = await call("export_mogrt", { compId: 7, name: "LT", destDir: fresh });
assert.equal(r.isError, false, r.text);
assert.deepEqual(ops(), ["_export_mogrt"]);
assert.equal(fs.existsSync(path.join(dir, "templates")), false, "the server created no folder");
assert.equal(JSON.parse(r.text).createdDir, true, "createdDir is the panel's answer, untouched");
passed++;

// Refused by the server: nothing reaches AE, and nothing is left on disk.
r = await call("export_mogrt", { compId: 7, name: "a/b", destDir: fresh });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: The template name "a\/b" is used as the \.mogrt filename/);
assert.deepEqual(ops(), []);
assert.equal(fs.existsSync(path.join(dir, "templates")), false, "a refused export leaves no folder");
passed++;

const out = path.join(dir, "out");
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, "LT.mogrt"), "zip");
r = await call("export_mogrt", { compId: 7, name: "LT", destDir: out });
assert.equal(r.isError, true);
assert.match(r.text, /^AE: A template already exists at /);
assert.deepEqual(ops(), [], "refused before After Effects is asked to export");
assert.deepEqual(fs.readdirSync(out), ["LT.mogrt"], "nothing written into the folder");
passed++;

r = await call("export_mogrt", { compId: 7, name: "LT" });
assert.deepEqual(ops(), ["_export_mogrt"], "no destDir: no project walk to find the .aep; the jsx checks it");
passed++;

assert.ok(!seen.some((s) => s.op === "get_project_summary"));
console.log(`file-ops-server: ${passed} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
wss.close();
bridge.close();
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
