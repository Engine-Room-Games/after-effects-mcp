// The panel reports what it supports, and the house style moves to the server
// on a panel that says it can name the .aep cheaply (issue #220, stage 3).
//
// Pinned here, with no After Effects:
//   - `capabilities` on /health is read as a list; absent or malformed is
//     "legacy", never a guess. The gate keeps it with its verdict and drops it
//     whenever it drops the verdict.
//   - `_project_path` (style.jsx) answers the path and the saved state, and is
//     classified, as is every internal op the server sends; an internal
//     write is sent only under the write lease.
//   - The server's house-style I/O agrees with style.jsx on one real folder:
//     the same results, the same sentences, the same bytes on disk.
//   - Through tools/call: a legacy panel gets `get_house_style` exactly as
//     before; a capable one gets `_project_path` and nothing else; a capable
//     panel that turns out not to know the op, or a folder this process cannot
//     read, falls back to the panel's own op.
//
// What a live After Effects must confirm: `app.project.file.fsName` and
// `app.project.dirty` as `_project_path` reports them, and that the server
// reads and writes beside a saved project exactly where the panel did.
//
//   node tests/unit/panel-capabilities.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { EsFile, EsFolder, outcome, resetDir, scratchDir, snapshotTree } from "./lib/es-file.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { panelCapabilities, CAP_PROJECT_PATH } = await import(dist("setup", "panelCapabilities.js"));
const { createPanelGate } = await import(dist("bridge", "panelGate.js"));
const { BridgeUnreachableError } = await import(dist("util", "errors.js"));
const { readHouseStyle, writeHouseStyle } = await import(dist("style", "houseStyleFile.js"));
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const { InternalOpMutation } = await import(sharedDist("schemas.js"));
const { internalSender, UnleasedInternalWriteError } = await import(dist("tools", "internalOps.js"));
const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));
const { markRendered } = await import(dist("render", "markDone.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`panel-capabilities FAILED: ${name}`);
    throw e;
  }
}

// ---------- reading the field ----------

await check("a missing or malformed field is legacy", () => {
  for (const h of [undefined, null, {}, { ok: true }, { capabilities: "project-path" }, { capabilities: { 0: "x" } }]) {
    const c = panelCapabilities(h);
    assert.equal(c.legacy, true, JSON.stringify(h));
    assert.equal(c.has(CAP_PROJECT_PATH), false);
  }
});

await check("a list is read as one, and only strings count", () => {
  const c = panelCapabilities({ capabilities: ["project-path", 7, null] });
  assert.equal(c.legacy, false);
  assert.equal(c.has("project-path"), true);
  assert.deepEqual([...c.list], ["project-path"]);
  const none = panelCapabilities({ capabilities: [] });
  assert.equal(none.legacy, false);
  assert.equal(none.has("project-path"), false);
});

// ---------- the gate keeps it with the verdict ----------

await check("the gate reports what the last /health said, and forgets it with the verdict", async () => {
  const b = {
    caps: ["project-path"],
    mode: "ok",
    listeners: [],
    async health() {
      if (b.mode === "unreachable") throw new BridgeUnreachableError(7777, new Error("ECONNREFUSED"));
      return { ok: true, port: 7777, bundleHash: "h", ...(b.caps ? { capabilities: b.caps } : {}) };
    },
    onPortChange(l) { b.listeners.push(l); },
  };
  let t = 0;
  const gate = createPanelGate(b, { assess: () => ({ state: "current", message: "" }), now: () => t });
  assert.equal(gate.capabilities().legacy, true, "nothing asked yet: legacy");
  await gate.check();
  assert.equal(gate.capabilities().has("project-path"), true);

  gate.withdraw("project-path");
  assert.equal(gate.capabilities().has("project-path"), false, "withdrawn after an Unknown op");
  t += 120_000;
  await gate.check();
  assert.equal(gate.capabilities().has("project-path"), false, "a routine re-probe does not restore it");

  gate.invalidate();
  assert.equal(gate.capabilities().legacy, true, "invalidate forgets it");
  await gate.check();
  assert.equal(gate.capabilities().has("project-path"), true);

  b.listeners.forEach((l) => l());
  assert.equal(gate.capabilities().legacy, true, "a port change forgets it: another panel may answer");

  b.caps = null;
  await gate.check();
  assert.equal(gate.capabilities().legacy, true, "a panel without the field is legacy");

  b.caps = ["project-path"];
  t += 120_000;
  b.mode = "unreachable";
  await gate.check();
  assert.equal(gate.capabilities().legacy, true, "unreachable forgets it");
});

// ---------- internal ops are classified, and defined ----------

const jsxDir = path.join(root, "packages", "jsx");
const jsxSources = fs.readdirSync(jsxDir).filter((f) => f.endsWith(".jsx")).sort()
  .map((f) => fs.readFileSync(path.join(jsxDir, f), "utf8")).join("\n");

await check("every classified internal op has a handler in the bundle; reads are noUndo", () => {
  for (const [op, effect] of Object.entries(InternalOpMutation)) {
    assert.match(jsxSources, new RegExp(`OPS\\.${op}\\s*=`), `${op} has no handler in packages/jsx`);
    if (effect === "read") {
      // An alias of a public op (`OPS._screenshot_frame = OPS.screenshot_frame`,
      // stage 4) is the same function object, so the public op must be noUndo.
      const alias = jsxSources.match(new RegExp(`OPS\\.${op}\\s*=\\s*OPS\\.(\\w+)\\s*;`));
      const handler = alias ? alias[1] : op;
      assert.match(jsxSources, new RegExp(`OPS\\.${handler}\\s*=\\s*noUndo\\(`), `${op} is a read and must be noUndo`);
    }
  }
  assert.equal(InternalOpMutation._project_path, "read");
});

// The one send path (tools/internalOps.ts). Names are typed over
// InternalOpMutation at compile time; at run time a "write" goes out only
// while the write lock is held, and an unclassified name never goes out.
await check("internalSender: every internal write is refused without the lease, and sent with it", async () => {
  const writes = new WriteQueue();
  const sent = [];
  const send = internalSender(async (op) => { sent.push(op); return { results: [] }; }, writes);
  const writeOps = Object.entries(InternalOpMutation).filter(([, e]) => e === "write").map(([op]) => op);
  assert.ok(writeOps.includes("_render_save") && writeOps.includes("_render_mark_done"));
  for (const op of writeOps) {
    await assert.rejects(send(op, {}), UnleasedInternalWriteError, `${op} without a lease`);
  }
  assert.deepEqual(sent, [], "nothing reached the panel");
  const lease = await writes.acquire("render_queue");
  for (const op of writeOps) await send(op, {});
  lease.release();
  assert.deepEqual(sent, writeOps);
  sent.length = 0;
  for (const [op, e] of Object.entries(InternalOpMutation)) if (e === "read") await send(op, {});
  assert.equal(sent.length, Object.values(InternalOpMutation).filter((e) => e === "read").length, "reads need no lease");
  await assert.rejects(send("_not_an_op", {}), /not a classified internal op/);
});

await check("markRendered sends _render_mark_done under its own lease", async () => {
  const writes = new WriteQueue();
  let heldAtSend;
  const send = internalSender(async (op) => { heldAtSend = writes.held; return { results: [] }; }, writes);
  await markRendered(writes, send, [{ index: 1, compId: 1, outputs: [{ path: "/x.mp4" }] }]);
  assert.equal(heldAtSend, "render_queue", "the lease is held when the op is sent");
  assert.equal(writes.held, null, "and released after");
});

// ---------- style.jsx in a vm, for the jsx side ----------

const ctx = {
  OPS: {},
  noUndo: (fn) => fn,
  File: EsFile,
  Folder: EsFolder,
  app: { project: { file: null } },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(jsxDir, "style.jsx"), "utf8"), ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));

const dir = scratchDir("style");
const aep = path.join(dir, "show.aep");

await check("_project_path: never saved", () => {
  ctx.app.project = { file: null };
  assert.deepEqual(plain(ctx.OPS._project_path()), { projectSaved: false, path: null, unsavedChanges: null });
});

await check("_project_path: saved, with and without Project.dirty", () => {
  fs.writeFileSync(aep, "");
  ctx.app.project = { file: new EsFile(aep), dirty: true };
  assert.deepEqual(plain(ctx.OPS._project_path()), { projectSaved: true, path: aep, unsavedChanges: true });
  ctx.app.project = { file: new EsFile(aep) };
  assert.deepEqual(plain(ctx.OPS._project_path()), { projectSaved: true, path: aep, unsavedChanges: null });
});

// ---------- parity: the server's I/O against style.jsx's ----------

const saved = () => ({ projectSaved: true, path: aep, unsavedChanges: false });
const unsaved = { projectSaved: false, path: null, unsavedChanges: null };

function parity(name, setup, runJsx, runTs) {
  return check(`parity: ${name}`, () => {
    resetDir(dir);
    fs.writeFileSync(aep, "");
    setup();
    const j = outcome(() => plain(runJsx()));
    const jTree = snapshotTree(dir);
    resetDir(dir);
    fs.writeFileSync(aep, "");
    setup();
    const t = outcome(() => plain(runTs()));
    const tTree = snapshotTree(dir);
    assert.deepEqual(t, j, "the server answers as style.jsx does");
    assert.deepEqual(tTree, jTree, "and leaves the same bytes on disk");
  });
}
const withFile = (fn) => () => { ctx.app.project = { file: new EsFile(aep) }; return fn(); };
const withoutFile = (fn) => () => { ctx.app.project = { file: null }; return fn(); };
const guide = path.join(dir, "house-style.md");

await parity("no guide yet", () => {}, withFile(() => ctx.OPS.get_house_style()), () => readHouseStyle(saved()));
await parity("never saved (read)", () => {}, withoutFile(() => ctx.OPS.get_house_style()), () => readHouseStyle(unsaved));
await parity(
  "a guide with a BOM, CRLF, a bare CR and non-ASCII",
  () => fs.writeFileSync(guide, "﻿# Style\r\nInter — “quoted”\rCafé « x »\n"),
  withFile(() => ctx.OPS.get_house_style()),
  () => readHouseStyle(saved())
);
await parity(
  "set: creates",
  () => {},
  withFile(() => ctx.OPS.set_house_style({ content: "# Style\nÉ — ok\n" })),
  () => writeHouseStyle(saved(), { content: "# Style\nÉ — ok\n" })
);
await parity(
  "set: CRLF and a bare CR land as LF (measured on AE 26.5)",
  () => {},
  withFile(() => ctx.OPS.set_house_style({ content: "# Style\r\nA\rB\n" })),
  () => writeHouseStyle(saved(), { content: "# Style\r\nA\rB\n" })
);
await check("set: the server writes LF for CRLF and a bare CR", () => {
  resetDir(dir);
  fs.writeFileSync(aep, "");
  writeHouseStyle(saved(), { content: "# Style\r\nA\rB\n" });
  assert.equal(fs.readFileSync(guide, "utf8"), "# Style\nA\nB\n");
});
await parity(
  "set: refuses to replace without overwrite",
  () => fs.writeFileSync(guide, "# Theirs\n"),
  withFile(() => ctx.OPS.set_house_style({ content: "# Mine\n" })),
  () => writeHouseStyle(saved(), { content: "# Mine\n" })
);
await parity(
  "set: replaces with overwrite",
  () => fs.writeFileSync(guide, "# Theirs\n"),
  withFile(() => ctx.OPS.set_house_style({ content: "# Mine\n", overwrite: true })),
  () => writeHouseStyle(saved(), { content: "# Mine\n", overwrite: true })
);
await parity(
  "set: never saved",
  () => {},
  withoutFile(() => ctx.OPS.set_house_style({ content: "# Mine\n" })),
  () => writeHouseStyle(unsaved, { content: "# Mine\n" })
);
await parity(
  "set: empty content",
  () => {},
  withFile(() => ctx.OPS.set_house_style({ content: "" })),
  () => writeHouseStyle(saved(), { content: "" })
);

// ---------- through tools/call ----------

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import(dist("server.js"));

const servers = [];
/** A stub panel with its own /health, and an MCP server pointed at it. */
async function session(health) {
  const s = { answers: {}, seen: [] };
  const bridge = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), ...health }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { op, args } = JSON.parse(body || "{}");
      s.seen.push(op);
      const a = s.answers[op];
      res.end(JSON.stringify(a ? (typeof a === "function" ? a(args) : a) : { ok: false, error: `Unknown op: ${op}` }));
    });
  });
  const wss = new WebSocketServer({ server: bridge, path: "/events" });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
  const port = bridge.address().port;
  assert.notEqual(port, 7777, "must not bind the panel's port");
  process.env.AE_MCP_PORT = String(port);
  const server = createServer();
  const client = new Client({ name: "panel-capabilities-test", version: "0" }, { capabilities: {} });
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]);
  servers.push({ bridge, wss, port });
  s.call = async (name, args) => {
    s.seen.length = 0;
    const res = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: res.content[0]?.text ?? "" };
  };
  return s;
}

const panelStyle = { ok: true, result: { found: true, projectSaved: true, path: "/elsewhere/house-style.md", content: "# From the panel\n", bytes: 17 } };
const where = (p) => ({ ok: true, result: p === null ? { projectSaved: false, path: null, unsavedChanges: null } : { projectSaved: true, path: p, unsavedChanges: false } });

const legacy = await session({});
const capable = await session({ capabilities: ["project-path"] });

await check("legacy panel: get_house_style goes to the panel, as before", async () => {
  legacy.answers.get_house_style = panelStyle;
  const r = await legacy.call("get_house_style", { detail: "full" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(legacy.seen, ["get_house_style"], "no _project_path to a panel that did not offer it");
  assert.equal(JSON.parse(r.text).content, "# From the panel\n");
});

await check("legacy panel: set_house_style goes to the panel, as before", async () => {
  legacy.answers.set_house_style = { ok: true, result: { ok: true, path: "/x/house-style.md", bytes: 3, created: true, replaced: false } };
  const r = await legacy.call("set_house_style", { content: "# x" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(legacy.seen, ["set_house_style"]);
});

await check("capable panel: the server reads the guide itself", async () => {
  resetDir(dir);
  fs.writeFileSync(aep, "");
  fs.writeFileSync(guide, "# Style\r\n\r\n## Palette\r\n- Ink #101820\r\n");
  capable.answers._project_path = where(aep);
  const full = await capable.call("get_house_style", { detail: "full" });
  assert.equal(full.isError, false, full.text);
  assert.deepEqual(capable.seen, ["_project_path"], "one cheap op, no get_house_style, no project walk");
  const body = JSON.parse(full.text);
  assert.equal(body.found, true);
  assert.equal(body.path, guide);
  assert.equal(body.content, "# Style\n\n## Palette\n- Ink #101820\n");

  const sum = JSON.parse((await capable.call("get_house_style", {})).text);
  assert.equal(sum.detail, "summary", "the summariser still applies");
  assert.ok(!("content" in sum));
});

await check("capable panel: no guide, and a project never saved", async () => {
  resetDir(dir);
  fs.writeFileSync(aep, "");
  capable.answers._project_path = where(aep);
  let body = JSON.parse((await capable.call("get_house_style", {})).text);
  assert.equal(body.found, false);
  assert.equal(body.projectSaved, true);
  assert.equal(body.path, guide);

  capable.answers._project_path = where(null);
  body = JSON.parse((await capable.call("get_house_style", {})).text);
  assert.deepEqual([body.found, body.projectSaved, body.path], [false, false, null]);
  assert.match(body.reason, /never been saved/);
  const w = await capable.call("set_house_style", { content: "# x" });
  assert.equal(w.isError, true);
  assert.match(w.text, /never been saved/);
  assert.deepEqual(capable.seen, ["_project_path"]);
});

await check("capable panel: the server writes, refuses to clobber, and replaces with overwrite", async () => {
  resetDir(dir);
  fs.writeFileSync(aep, "");
  capable.answers._project_path = where(aep);
  let r = await capable.call("set_house_style", { content: "# Mine\nCafé\n" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(capable.seen, ["_project_path"]);
  assert.equal(JSON.parse(r.text).created, true);
  assert.equal(fs.readFileSync(guide, "utf8"), "# Mine\nCafé\n");

  r = await capable.call("set_house_style", { content: "# Other\n" });
  assert.equal(r.isError, true);
  assert.match(r.text, /A style guide already exists at .*overwrite: true/);
  assert.equal(fs.readFileSync(guide, "utf8"), "# Mine\nCafé\n", "a refusal leaves the guide alone");

  r = await capable.call("set_house_style", { content: "# Other\n", overwrite: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).replaced, true);
  assert.equal(fs.readFileSync(guide, "utf8"), "# Other\n");
});

await check("capable panel that does not know _project_path: falls back to the panel's op", async () => {
  // Its own session: the withdrawal lasts for the rest of the session.
  const forgetful = await session({ capabilities: ["project-path"] });
  forgetful.answers.get_house_style = panelStyle;
  const r = await forgetful.call("get_house_style", { detail: "full" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(forgetful.seen, ["_project_path", "get_house_style"]);
  assert.equal(JSON.parse(r.text).content, "# From the panel\n");
  await forgetful.call("get_house_style", { detail: "full" });
  assert.deepEqual(forgetful.seen, ["get_house_style"], "the capability is withdrawn: no second _project_path");
});

await check("capable panel, odd answer: falls back to the panel's op", async () => {
  capable.answers._project_path = { ok: true, result: { path: 7 } };
  capable.answers.get_house_style = panelStyle;
  const r = await capable.call("get_house_style", { detail: "full" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(capable.seen, ["_project_path", "get_house_style"]);
});

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
if (canChmod) {
  await check("a folder this process cannot read goes to the panel, which may be allowed", async () => {
    resetDir(dir);
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    const lockedAep = path.join(locked, "show.aep");
    fs.writeFileSync(lockedAep, "");
    fs.writeFileSync(path.join(locked, "house-style.md"), "# Theirs\n");
    fs.chmodSync(path.join(locked, "house-style.md"), 0o000);
    capable.answers._project_path = where(lockedAep);
    capable.answers.get_house_style = panelStyle;
    capable.answers.set_house_style = { ok: true, result: { ok: true, path: "p", bytes: 1, created: false, replaced: true } };
    let r = await capable.call("get_house_style", { detail: "full" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(capable.seen, ["_project_path", "get_house_style"]);

    fs.chmodSync(path.join(locked, "house-style.md"), 0o444);
    r = await capable.call("set_house_style", { content: "# Mine\n", overwrite: true });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(capable.seen, ["_project_path", "set_house_style"], "an EACCES write is the panel's to try");
    fs.chmodSync(path.join(locked, "house-style.md"), 0o644);
    assert.equal(fs.readFileSync(path.join(locked, "house-style.md"), "utf8"), "# Theirs\n", "nothing written by the server");
  });
}

// ---------- server-images (issue #220, stage 4) ----------
// Which side finishes a screenshot or a .mogrt thumbnail. The bytes are held
// equal by tests/unit/image-parity.mjs; this is only who is asked for what.
const { encodePng8 } = await import(dist("frames", "pngCodec.js"));
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-caps-shot-"));
let shotSeq = 0;
function rawFrame(args) {
  const px = Buffer.alloc(4 * 3 * 4, 0);
  for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 1] = shotSeq * 9; px[i + 2] = 9; px[i + 3] = 255; }
  const file = path.join(shotDir, `f-${shotSeq++}.png`);
  fs.writeFileSync(file, encodePng8(4, 3, 6, px));
  return { ok: true, result: { path: file, width: 16, height: 12, downsample: 4, time: args.time ?? 0, compId: 3 } };
}
const panelShot = { ok: true, result: { width: 4, height: 3, downsample: 4, time: 0, compId: 3, mimeType: "image/png", base64: "aGk=", bytes: 2 } };

await check("legacy panel: a screenshot goes to the panel's own op, as before", async () => {
  legacy.answers.screenshot_frame = panelShot;
  const r = await legacy.call("screenshot_frame", { compId: 3, time: 0 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(legacy.seen, ["screenshot_frame"], "no raw op to a panel that did not offer it");
  assert.equal(JSON.parse(r.text).bytes, 2);
});

await check("server-images panel: the raw op is sent and the server reads the file", async () => {
  const shots = await session({ capabilities: ["project-path", "server-images"] });
  shots.answers._screenshot_frame = (a) => rawFrame(a);
  const r = await shots.call("screenshot_frame", { compId: 3, time: 1 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(shots.seen, ["_screenshot_frame"]);
  const meta = JSON.parse(r.text);
  assert.equal(meta.width, 4);
  assert.equal(meta.height, 3);
  assert.deepEqual(fs.readdirSync(shotDir), [], "the server removes the temp frame it read");

  // A corrupt file is re-rendered once, through a second raw op.
  let first = true;
  shots.answers._screenshot_frame = (a) => {
    const out = rawFrame(a);
    if (first) { first = false; fs.writeFileSync(out.result.path, "not a png"); }
    return out;
  };
  const again = await shots.call("screenshot_frame", { compId: 3, time: 2 });
  assert.equal(again.isError, false, again.text);
  assert.deepEqual(shots.seen, ["_screenshot_frame", "_screenshot_frame"]);
});

await check("server-images panel that does not know the raw op: falls back once, then stays on the panel's op", async () => {
  const forgetful = await session({ capabilities: ["server-images"] });
  forgetful.answers.screenshot_frame = panelShot;
  const r = await forgetful.call("screenshot_frame", { compId: 3, time: 0 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(forgetful.seen, ["_screenshot_frame", "screenshot_frame"]);
  await forgetful.call("screenshot_frame", { compId: 3, time: 0 });
  assert.deepEqual(forgetful.seen, ["screenshot_frame"], "the capability is withdrawn");
});

await check("server-images panel: export_mogrt is sent raw and never carries posterPngPath back", async () => {
  const shots = await session({ capabilities: ["server-images"] });
  shots.answers._export_mogrt = { ok: true, result: { ok: true, path: path.join(shotDir, "none.mogrt"), bytes: 5, compId: 3 } };
  const r = await shots.call("export_mogrt", { compId: 3 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(shots.seen, ["_export_mogrt"]);
  assert.equal(JSON.parse(r.text).bytes, 5);
});
fs.rmSync(shotDir, { recursive: true, force: true });

console.log(`panel-capabilities: ${passed} checks passed`);
resetDir(dir);
fs.rmSync(dir, { recursive: true, force: true });
for (const { bridge, wss, port } of servers) {
  wss.close();
  bridge.close();
  // The shared stale-frame window these sessions wrote (frames/sharedFrameCache.ts).
  fs.rmSync(path.join(os.homedir(), ".engineroom-ae-mcp", `frames-${port}.jsonl`), { force: true });
}
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
