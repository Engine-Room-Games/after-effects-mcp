// The live After Effects driver (tests/live/), minus After Effects.
//
// Everything here runs in CI: the stdio framing, the client against a fake
// server process, the safety guards (opt-in, scratch paths, the prefs backup
// and its refusals), the fixture registry checked against the real op schemas
// and the recipe list, and the runner against a stub client. The one thing it
// cannot do is reach After Effects — and the opt-in check below proves the
// driver refuses to try without being told.
//
//   node tests/unit/live-driver.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const live = (...p) => pathToFileURL(path.join(root, "tests", "live", ...p)).href;

const { LineDecoder, encodeMessage, readToolResult } = await import(live("lib", "framing.mjs"));
const { StdioMcpClient } = await import(live("lib", "client.mjs"));
const safety = await import(live("lib", "safety.mjs"));
const fx = await import(live("lib", "fixtures.mjs"));
const runner = await import(live("lib", "runner.mjs"));
const { OpSchemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "live-driver-test-"));
process.on("exit", () => fs.rmSync(tmpBase, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

await check("decoder reassembles messages cut anywhere, including inside a UTF-8 character", () => {
  const got = [];
  const noise = [];
  const d = new LineDecoder({ onMessage: (m) => got.push(m), onNoise: (l) => noise.push(l) });
  const wire = Buffer.from(
    encodeMessage({ jsonrpc: "2.0", id: 1, result: { s: "café ✓" } }) + encodeMessage({ jsonrpc: "2.0", method: "n" }),
    "utf8"
  );
  for (let i = 0; i < wire.length; i++) d.push(wire.subarray(i, i + 1)); // one byte at a time
  assert.equal(got.length, 2);
  assert.equal(got[0].result.s, "café ✓");
  assert.equal(got[1].method, "n");
  assert.equal(noise.length, 0);
});

await check("decoder: CRLF, blank lines, noise and a final line with no newline", () => {
  const got = [];
  const noise = [];
  const d = new LineDecoder({ onMessage: (m) => got.push(m), onNoise: (l) => noise.push(l) });
  d.push('{"jsonrpc":"2.0","id":1,"result":{}}\r\n\n  \nhello from a console.log\n{"not":"rpc"}\n');
  d.push('{"jsonrpc":"2.0","id":2,"result":{}}');
  assert.equal(got.length, 1);
  d.end();
  assert.equal(got.length, 2);
  assert.deepEqual(noise, ["hello from a console.log", '{"not":"rpc"}']);
});

await check("readToolResult reads JSON, images, extra blocks and errors", () => {
  const ok = readToolResult({
    content: [
      { type: "text", text: '{"width":1280}' },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: '{"queuedBehind":"x"}' },
    ],
  });
  assert.equal(ok.json.width, 1280);
  assert.equal(ok.images.length, 1);
  assert.deepEqual(ok.extra, [{ queuedBehind: "x" }]);
  assert.equal(ok.isError, false);
  const err = readToolResult({ content: [{ type: "text", text: "AE: boom" }], isError: true });
  assert.equal(err.isError, true);
  assert.equal(err.json, undefined);
  assert.equal(err.text, "AE: boom");
});

// ---------------------------------------------------------------------------
// The client, against a fake server process
// ---------------------------------------------------------------------------

const fakeServer = path.join(tmpBase, "fake-server.mjs");
fs.writeFileSync(
  fakeServer,
  `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdout.write("stray line\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "fake", version: "0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "run_jsx" }] } });
    else if (m.method === "tools/call") {
      const token = m.params._meta && m.params._meta.progressToken;
      if (token !== undefined) send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1 } });
      send({ jsonrpc: "2.0", id: "srv-1", method: "ping" });
      if (m.params.name === "boom") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "AE: boom" }], isError: true } });
      else send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ echo: m.params.arguments }) }] } });
    } else if (m.id === "srv-1") { process.stderr.write("pong received\\n"); }
  }
});
`
);

await check("client: handshake, calls, progress ordering, server ping, noise, and close", async () => {
  const c = new StdioMcpClient({ command: process.execPath, args: [fakeServer], env: process.env, timeoutMs: 10_000 }).start();
  try {
    const init = await c.initialize();
    assert.equal(init.serverInfo.name, "fake");
    assert.deepEqual((await c.listTools()).map((t) => t.name), ["run_jsx"]);
    const [a, b] = await Promise.all([c.callTool("x", { n: 1 }, { progressToken: "tok" }), c.callTool("y", { n: 2 })]);
    assert.deepEqual(a.json.echo, { n: 1 });
    assert.deepEqual(b.json.echo, { n: 2 });
    const err = await c.callTool("boom");
    assert.equal(err.isError, true);
    const prog = c.notifications.filter((n) => n.params?.progressToken === "tok");
    assert.equal(prog.length, 1);
    assert.ok(prog[0].openRequests.length >= 1, "the progress arrived while its request was still open");
    assert.deepEqual(c.noise, ["stray line"]);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(c.stderr, /pong received/, "a server-initiated ping is answered");
  } finally {
    await c.close();
  }
  assert.notEqual(c.child.exitCode ?? c.child.signalCode, null, "the child it spawned is gone");
});

await check("client: close escalates to SIGKILL when the server ignores stdin closing and SIGTERM", async () => {
  if (process.platform === "win32") return; // no catchable SIGTERM there: kill() is already final
  const stubborn = path.join(tmpBase, "stubborn.mjs");
  fs.writeFileSync(stubborn, "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);");
  const c = new StdioMcpClient({ command: process.execPath, args: [stubborn] }).start();
  await new Promise((r) => setTimeout(r, 200));
  await c.close();
  assert.equal(c.child.signalCode, "SIGKILL");
});

await check("client: a request to a dead server rejects instead of hanging", async () => {
  const c = new StdioMcpClient({ command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 5000 }).start();
  await c.exited;
  await assert.rejects(c.request("tools/list", {}), /not running|exited/);
});

// ---------------------------------------------------------------------------
// Safety: opt-in
// ---------------------------------------------------------------------------

await check("opt-in: only --live or AE_MCP_LIVE=1, nothing looser", () => {
  assert.equal(safety.liveOptIn(["run"], {}).ok, false);
  for (const v of ["0", "true", "yes", "", " 1"]) assert.equal(safety.liveOptIn(["run"], { AE_MCP_LIVE: v }).ok, false, v);
  assert.equal(safety.liveOptIn(["run"], { AE_MCP_LIVE: "1" }).ok, true);
  assert.equal(safety.liveOptIn(["run", "--live"], {}).ok, true);
  assert.match(safety.liveOptIn([], {}).message, /--live/);
});

await check("run.mjs refuses run and prefs without opting in, before touching anything", () => {
  const env = { ...process.env };
  delete env.AE_MCP_LIVE;
  for (const args of [["run"], ["run", "01"], ["prefs", "backup"], ["prefs", "restore"]]) {
    const r = spawnSync(process.execPath, [path.join(root, "tests", "live", "run.mjs"), ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /Refusing to touch After Effects/);
  }
  const ok = spawnSync(process.execPath, [path.join(root, "tests", "live", "run.mjs"), "validate"], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});

// ---------------------------------------------------------------------------
// Safety: scratch paths
// ---------------------------------------------------------------------------

await check("scratch paths: inside only, no traversal, no sibling-prefix match", () => {
  const r = safety.makeScratchRoot(tmpBase);
  assert.ok(path.basename(r).startsWith(safety.SCRATCH_PREFIX));
  assert.equal(safety.isInside(path.join(r, "a", "b.aep"), r), true);
  assert.equal(safety.isInside(r, r), false, "the root itself is not inside");
  assert.equal(safety.isInside(path.join(r, "..", "x.aep"), r), false);
  assert.equal(safety.isInside(r + "2/x.aep", r), false, "a sibling sharing the prefix");
  assert.equal(safety.isInside(path.join(os.homedir(), "Documents", "real.aep"), r), false);
  assert.throws(() => safety.assertScratchPath("/Users/someone/Work/client.aep", r), /only writes inside/);
  assert.equal(safety.assertScratchPath(path.join(r, "ok.aep"), r), path.join(r, "ok.aep"));
});

await check("removeScratchRoot deletes its own folder and refuses anything else", () => {
  const r = safety.makeScratchRoot(tmpBase);
  fs.writeFileSync(path.join(r, "f"), "x");
  const other = fs.mkdtempSync(path.join(tmpBase, "not-ours-"));
  assert.throws(() => safety.removeScratchRoot(other, tmpBase), /not a live-driver scratch folder/);
  assert.throws(() => safety.removeScratchRoot(path.join(r, "nested"), tmpBase), /not a live-driver scratch folder/);
  assert.throws(() => safety.removeScratchRoot(os.homedir(), tmpBase), /not a live-driver scratch folder/);
  assert.ok(fs.existsSync(other));
  safety.removeScratchRoot(r, tmpBase);
  assert.equal(fs.existsSync(r), false);
  const slashed = safety.makeScratchRoot(tmpBase);
  assert.equal(safety.isInside(path.join(slashed, "a.aep"), slashed + path.sep), true, "a root given with a trailing separator");
  safety.removeScratchRoot(slashed + path.sep, tmpBase);
  assert.equal(fs.existsSync(slashed), false);
});

await check("a symlink inside scratch that points outside does not count as inside", () => {
  const r = safety.makeScratchRoot(tmpBase);
  const outside = fs.mkdtempSync(path.join(tmpBase, "elsewhere-"));
  try {
    fs.symlinkSync(outside, path.join(r, "out"), process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    if (process.platform === "win32") return; // junctions may need rights the runner lacks
    throw e;
  }
  assert.equal(safety.isInside(path.join(r, "out", "x.mov"), r), false, "an existing link");
  assert.equal(safety.isInside(path.join(r, "out", "not", "yet", "x.mov"), r), false, "through a link, to folders not created yet");
  assert.equal(safety.isInside(path.join(r, "real", "x.mov"), r), true, "a not-yet-created folder that really is inside");
  const linkedRoot = path.join(tmpBase, "linked-root");
  fs.symlinkSync(r, linkedRoot, "dir");
  assert.equal(safety.isInside(path.join(linkedRoot, "a.aep"), r), true, "the root reached through a link is still the root");
});

await check("render outputs: every output of every queued item must write inside scratch", () => {
  const scratch = safety.makeScratchRoot(tmpBase);
  const inside = (p) => safety.isInside(p, scratch);
  const q = (paths) => ({ items: [{ index: 1, outputs: paths.map((p, i) => ({ index: i + 1, path: p })) }], count: 1 });
  assert.deepEqual(safety.renderOutputsOutside(q([path.join(scratch, "a.mov")]), inside), []);
  assert.match(safety.renderOutputsOutside(q([path.join(scratch, "a.mov"), "/Users/m/Desktop/b.mov"]), inside).join(), /output 2 writes to "\/Users\/m\/Desktop\/b\.mov"/);
  assert.match(safety.renderOutputsOutside(q([null]), inside).join(), /writes to null/);
  assert.match(safety.renderOutputsOutside({ nope: 1 }, inside).join(), /could not read/);
});

await check("the project guard's prefixes end in a separator, however the root was written", () => {
  const p = runner.scratchPrefixes(["/tmp/ae-mcp-live-abc/", "/tmp/ae-mcp-live-abc", "C:\\T\\ae-mcp-live-x\\"]);
  assert.deepEqual(p.sort(), ["/tmp/ae-mcp-live-abc/", "/tmp/ae-mcp-live-abc\\", "C:\\T\\ae-mcp-live-x/", "C:\\T\\ae-mcp-live-x\\"].sort());
  assert.ok(!p.some((x) => "/tmp/ae-mcp-live-abc2/x.aep".startsWith(x)), "a sibling sharing the prefix is not ours");
  assert.ok(p.some((x) => "/tmp/ae-mcp-live-abc/x.aep".startsWith(x)));
});

await check("isScratchLike recognises live-run paths in either separator", () => {
  assert.equal(safety.isScratchLike("/private/var/folders/x/T/ae-mcp-live-AbC/10-house-style/style.aep"), true);
  assert.equal(safety.isScratchLike("C:\\Users\\m\\AppData\\Local\\Temp\\ae-mcp-live-xyz\\rq\\rq.aep"), true);
  assert.equal(safety.isScratchLike("/Users/migs/Projects/Engine Room.aep"), false);
});

await check("fixtures may not quit AE or open, close or save projects themselves", () => {
  for (const code of ["app.quit();", "app.newProject()", "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", "app.project.save(f)",
    "app.open(new File('/x.aep'))", "app.executeCommand(1)", "system.callSystem('rm -rf ~')", "app.project.saveWithDialog()"]) {
    assert.ok(safety.forbiddenJsx(code).length > 0, code);
  }
  assert.deepEqual(safety.forbiddenJsx("var l = comp.layers.addNull(); return l.name;"), []);
  assert.deepEqual(safety.forbiddenJsx("comp.layer(1).remove(); return comp.numLayers;"), [], "deleting a layer is ordinary work");
  for (const code of ["new File('/x').remove()", "var f = Folder.desktop; f.remove();", "app.project.file.remove()",
    "new Folder('/x').create()", "f.rename('y')", "new File('/x.command').execute()", "$.evalFile('/x.jsx')",
    "app.scheduleTask('x', 1, false)", "app.preferences.savePrefAsLong('a','b',1)", "app.settings.saveSetting('a','b','c')"]) {
    assert.ok(safety.forbiddenJsx(code).length > 0, code);
  }
});

await check("every source a call would run is checked: scriptPath, libraries, and run_jsx inside run_batch", () => {
  const files = { "/s/ok.jsx": "return 1;", "/s/lib.jsx": "function q(){ app.quit(); }" };
  const read = (f) => (f in files ? files[f] : null);
  assert.deepEqual(safety.forbiddenInCall("run_jsx", { scriptPath: "/s/ok.jsx" }, read), []);
  assert.match(safety.forbiddenInCall("run_jsx", { scriptPath: "/s/ok.jsx", libraries: ["/s/lib.jsx"] }, read).join(), /lib\.jsx.*quit/);
  assert.match(safety.forbiddenInCall("run_jsx", { scriptPath: "/s/missing.jsx" }, read).join(), /cannot be read/);
  const batch = { ops: [{ op: "create_comp", args: {} }, { op: "run_jsx", args: { code: "app.project.save()" } }] };
  assert.match(safety.forbiddenInCall("run_batch", batch, read).join(), /ops\[1\] code/);
  assert.deepEqual(safety.forbiddenInCall("create_comp", { name: "app.quit()" }, read), [], "only ExtendScript is code");
});

await check("the ban list also catches file writes and renders (best-effort, not a sandbox)", () => {
  for (const code of ["var f = new File(p); f.open('w');", "f.open( \"a\" )", "f.open('e')", "f.write('x')", "f.writeln('x')",
    "app.project.renderQueue.render();"]) {
    assert.ok(safety.forbiddenJsx(code).length > 0, code);
  }
  assert.deepEqual(safety.forbiddenJsx("var f = Folder.appPackage; return f.fsName;"), []);
});

await check("every server tool is on exactly one fixture list, so a new tool is refused until someone decides", () => {
  const lists = [new Set(Object.keys(safety.REFUSED_TOOLS)), new Set(Object.keys(safety.FILE_WRITING_TOOLS)), safety.ALLOWED_TOOLS];
  for (const tool of Object.keys(OpSchemas)) {
    assert.equal(lists.filter((l) => l.has(tool)).length, 1, `${tool} must be on exactly one list in tests/live/lib/safety.mjs`);
  }
  for (const l of lists) for (const t of l) assert.ok(t in OpSchemas, `${t} is listed but is not a tool`);
  const inside = () => true;
  assert.match(safety.checkToolUse("a_tool_added_later", {}, inside).problems.join(), /on no list/);
});

await check("refused and file-writing tools: refused, or allowed only with every path inside scratch", () => {
  const scratch = safety.makeScratchRoot(tmpBase);
  const inside = (p) => safety.isInside(p, scratch);
  const problems = (tool, args) => safety.checkToolUse(tool, args, inside).problems.join("\n");
  assert.match(problems("setup_panel", {}), /refused/);
  assert.match(problems("init_project", { dir: path.join(scratch, "p") }), /refused/, "refused even inside scratch");
  assert.match(problems("export_mogrt", { compId: 1 }), /destDir must be passed/);
  assert.match(problems("export_mogrt", { compId: 1, destDir: path.join(os.homedir(), "Desktop") }), /destDir .* outside the scratch folder/);
  assert.equal(problems("export_mogrt", { compId: 1, destDir: path.join(scratch, "m") }), "");
  assert.match(problems("add_to_render_queue", { compId: 1, outputPath: "/tmp/elsewhere/x.mov" }), /outputPath .* outside/);
  assert.equal(problems("add_to_render_queue", { compId: 1, outputPath: path.join(scratch, "x.mov") }), "");
  assert.match(problems("add_to_render_queue", { compId: 1, outputPath: path.join(scratch, "x.mov"), extra: { nested: "/Users/m/y" } }), /extra\.nested/,
    "path-like values are found at any depth");
  assert.equal(problems("list_comps", {}), "");
  assert.match(problems("run_batch", { ops: [{ op: "create_comp", args: {} }, { op: "setup_panel", args: {} }] }), /ops\[1\] \(setup_panel\).*refused/);
  const hs = safety.checkToolUse("set_house_style", { content: "x" }, inside);
  assert.deepEqual(hs.problems, []);
  assert.deepEqual(hs.needsOurProject, ["set_house_style"]);
  assert.deepEqual(safety.checkToolUse("run_batch", { ops: [{ op: "render_queue", args: { all: true } }] }, inside).needsOurProject, ["run_batch ops[0] (render_queue)"]);
});

await check("the validator applies the tool rules to fixtures", () => {
  const v = (steps) => fx.validateFixture({ id: "t", recipe: 2, title: "t", steps }, { opSchemas: OpSchemas }).join("\n");
  assert.match(v([{ call: "setup_panel" }]), /refused/);
  assert.match(v([{ call: "add_to_render_queue", args: { compId: 1, outputPath: "/Users/m/Desktop/x.mov" } }]), /outside the scratch folder/);
  assert.equal(v([{ call: "add_to_render_queue", args: { compId: 1, outputPath: "${scratch}/x.mov" } }]), "");
  assert.match(v([{ call: "set_house_style", args: { content: "x" } }]), /saveProject into the scratch folder first/);
  assert.equal(v([{ saveProject: "a.aep" }, { call: "set_house_style", args: { content: "x" } }]), "");
});

await check("AE versions: a folder-name version is validated, and app.version reduces to major.minor", () => {
  assert.equal(safety.assertAeVersion("26.5"), "26.5");
  for (const bad of ["../..", "", "26", "26.5/..", "26.5.1", undefined]) assert.throws(() => safety.assertAeVersion(bad), /not an After Effects version/);
  assert.equal(safety.aeMajorMinor("26.5x87"), "26.5");
  assert.equal(safety.aeMajorMinor("26.10.1x3"), "26.10");
  assert.equal(safety.aeMajorMinor(undefined), null);
});

// ---------------------------------------------------------------------------
// Safety: prefs backup and restore
// ---------------------------------------------------------------------------

const PREFS_HEAD = '["General Section"]\n\t"Some Pref" = "1"\n\n';
const mruSection = (paths) =>
  '["Most Recently Used (MRU) Search v2"]\n' +
  paths.map((p, i) => `\t"MRU Project Path ID # ${i}, File Path" = "${p}"\n`).join("") +
  '\n["Other Section"]\n\t"Path-ish" = "/not/an/mru"\n';

await check("parseMruEntries reads entries, joins continuation lines, and says null when it cannot tell", () => {
  const text = mruSection(["/Users/m/A.aep", "/Users/m/B.aep"]);
  assert.deepEqual(safety.parseMruEntries(text), ["/Users/m/A.aep", "/Users/m/B.aep"]);
  const wrapped = '["Most Recently Used (MRU) Search v2"]\n\t"MRU Project Path ID # 0, File Path" = "/Users/m/a very long "\n\t\t"folder/Long.aep"\n';
  assert.deepEqual(safety.parseMruEntries(wrapped), ["/Users/m/a very long folder/Long.aep"]);
  assert.equal(safety.parseMruEntries(PREFS_HEAD), null);
  assert.deepEqual(safety.parseMruEntries('["Most Recently Used (MRU) Search v2"]\n'), []);
});

await check("detectAeVersion picks the newest major.minor folder", () => {
  const pr = fs.mkdtempSync(path.join(tmpBase, "prefs-"));
  for (const v of ["24.6", "26.3", "26.10", "26.5", "Crash Reports"]) fs.mkdirSync(path.join(pr, v));
  assert.equal(safety.detectAeVersion(pr), "26.10");
  assert.equal(safety.detectAeVersion(path.join(pr, "missing")), null);
  assert.match(safety.aePrefsRoot({ platform: "darwin", home: "/Users/x" }), /Library\/Preferences\/Adobe\/After Effects$/);
  assert.equal(safety.aePrefsRoot({ platform: "win32", home: "C:\\Users\\x", env: { APPDATA: "C:\\AD" } }), "C:\\AD\\Adobe\\After Effects");
  assert.equal(safety.aePrefsRoot({ platform: "linux" }), null);
});

function fakePrefs(mru) {
  const prefsRoot = fs.mkdtempSync(path.join(tmpBase, "prefs-"));
  const t = safety.prefsTargets(prefsRoot, "26.5");
  fs.mkdirSync(path.join(t.workspacesDir, "sub"), { recursive: true });
  fs.writeFileSync(t.prefsFile, PREFS_HEAD + mruSection(mru));
  fs.writeFileSync(path.join(t.workspacesDir, "Mine.xml"), "<w/>");
  fs.writeFileSync(path.join(t.workspacesDir, "sub", "Deep.xml"), "<d/>");
  const backupRoot = fs.mkdtempSync(path.join(tmpBase, "backup-"));
  return { prefsRoot, t, backupRoot };
}
const running = async () => true;
const quit = async () => false;

await check("backup refuses while AE runs, and never overwrites an earlier backup without force", async () => {
  const { prefsRoot, backupRoot } = fakePrefs(["/Users/m/Real.aep"]);
  await assert.rejects(safety.backupPrefs({ prefsRoot, version: "26.5", backupRoot, isAeRunning: running }), /running/);
  assert.equal(safety.readBackup(backupRoot, "26.5"), null);
  const { manifest } = await safety.backupPrefs({ prefsRoot, version: "26.5", backupRoot, isAeRunning: quit });
  assert.deepEqual(manifest.mru, ["/Users/m/Real.aep"]);
  assert.deepEqual(Object.keys(manifest.workspaces).sort(), ["Mine.xml", "sub/Deep.xml"]);
  await assert.rejects(safety.backupPrefs({ prefsRoot, version: "26.5", backupRoot, isAeRunning: quit }), /already exists/);
  await safety.backupPrefs({ prefsRoot, version: "26.5", backupRoot, isAeRunning: quit, force: true });
});

await check("restore is byte-identical — prefs and workspaces, additions and deletions — then retires the backup", async () => {
  const { prefsRoot, t, backupRoot } = fakePrefs(["/Users/m/Real.aep", "/Users/m/Other.aep"]);
  const before = fs.readFileSync(t.prefsFile);
  await safety.backupPrefs({ prefsRoot, version: "26.5", backupRoot, isAeRunning: quit });
  // What a live run does to them: scratch projects at the top of Open Recent, a workspace changed and one added.
  fs.writeFileSync(t.prefsFile, PREFS_HEAD + mruSection(["/private/var/folders/q/T/ae-mcp-live-x1/10-house-style/style.aep", "/Users/m/Real.aep"]));
  fs.writeFileSync(path.join(t.workspacesDir, "Mine.xml"), "<changed/>");
  fs.writeFileSync(path.join(t.workspacesDir, "New.xml"), "<new/>");
  fs.rmSync(path.join(t.workspacesDir, "sub"), { recursive: true });
  await assert.rejects(safety.restorePrefs({ backupRoot, version: "26.5", isAeRunning: running }), /running/);
  const r = await safety.restorePrefs({ backupRoot, version: "26.5", isAeRunning: quit });
  assert.ok(fs.readFileSync(t.prefsFile).equals(before));
  assert.equal(fs.readFileSync(path.join(t.workspacesDir, "Mine.xml"), "utf8"), "<w/>");
  assert.equal(fs.readFileSync(path.join(t.workspacesDir, "sub", "Deep.xml"), "utf8"), "<d/>");
  assert.equal(fs.existsSync(path.join(t.workspacesDir, "New.xml")), false);
  assert.equal(safety.readBackup(backupRoot, "26.5"), null, "retired, so the next run must take a fresh backup");
  assert.ok(fs.existsSync(path.join(r.retired, "manifest.json")));
});

await check("restore refuses when someone used AE for real in between, or when Open Recent is unreadable", async () => {
  const { prefsRoot, t, backupRoot } = fakePrefs(["/Users/m/Real.aep"]);
  await safety.backupPrefs({ prefsRoot, version: "26.5", backupRoot, isAeRunning: quit });
  fs.writeFileSync(t.prefsFile, PREFS_HEAD + mruSection(["/Users/m/Opened Since.aep", "/Users/m/Real.aep"]));
  await assert.rejects(safety.restorePrefs({ backupRoot, version: "26.5", isAeRunning: quit }), /Opened Since\.aep[\s\S]*Not restoring/);
  assert.match(fs.readFileSync(t.prefsFile, "utf8"), /Opened Since/, "nothing was overwritten");
  fs.writeFileSync(t.prefsFile, PREFS_HEAD + "garbled");
  await assert.rejects(safety.restorePrefs({ backupRoot, version: "26.5", isAeRunning: quit }), /Cannot read the Open Recent/);
  await safety.restorePrefs({ backupRoot, version: "26.5", isAeRunning: quit, force: true });
  assert.match(fs.readFileSync(t.prefsFile, "utf8"), /Real\.aep/);
  await assert.rejects(safety.restorePrefs({ backupRoot, version: "26.5", isAeRunning: quit }), /No backup/);
});

// ---------------------------------------------------------------------------
// Fixtures: templates, matchers, validation
// ---------------------------------------------------------------------------

await check("paths and templates", () => {
  assert.deepEqual(fx.parsePath("a.b[0][2].c"), ["a", "b", 0, 2, "c"]);
  assert.deepEqual(fx.parsePath("[0].name"), [0, "name"]);
  assert.equal(fx.getPath({ m: [{ x: 5 }] }, "m[0].x"), 5);
  assert.equal(fx.getPath({ m: [] }, "m[3].x"), undefined);
  const scope = { comp: { id: 42 }, scratch: "/tmp/s" };
  assert.deepEqual(fx.resolve({ compId: "${comp.id}", p: "${scratch}/a.mov", n: "id=${comp.id}" }, scope), { compId: 42, p: "/tmp/s/a.mov", n: "id=42" });
  assert.deepEqual(fx.resolve({ $repeat: 3, item: { name: "s${n}", i: "${i}" } }, scope), [
    { name: "s1", i: 0 }, { name: "s2", i: 1 }, { name: "s3", i: 2 },
  ]);
  assert.throws(() => fx.resolve("${nope.id}", scope), /Unknown template variable "nope"/);
  assert.throws(() => fx.resolve("${comp.missing}", scope), /undefined/);
});

await check("matchers", () => {
  const r = { json: { a: [1, 2], s: "hello", n: 3, o: { k: null } }, text: '{"a":[1,2]}', isError: false, images: [{}], progress: 2 };
  const ok = (e) => assert.equal(fx.checkExpectation(e, r), null, JSON.stringify(e));
  const bad = (e) => assert.notEqual(fx.checkExpectation(e, r), null, JSON.stringify(e));
  ok({ path: "a", equals: [1, 2] }); bad({ path: "a", equals: [2, 1] });
  ok({ path: "a", type: "array" }); ok({ path: "o.k", type: "null" }); bad({ path: "s", type: "number" });
  ok({ path: "o.k", exists: true }); ok({ path: "zz", exists: false }); bad({ path: "s", exists: false });
  ok({ path: "s", matches: "^hel" }); bad({ path: "s", notMatches: "ell" });
  ok({ path: "a", length: 2 }); bad({ path: "a", length: 3 });
  ok({ path: "n", gte: 3 }); bad({ path: "n", lte: 2 }); bad({ path: "s", gte: 0 });
  ok({ path: "a", includes: 2 }); ok({ path: "s", includes: "ll" }); bad({ path: "a", includes: 9 });
  ok({ path: "n", oneOf: [1, 3] });
  ok({ path: "$images", equals: 1 }); ok({ path: "$progress", gte: 1 }); ok({ path: "$text", matches: "\\[1,2\\]" });
  ok({ equals: { a: [1, 2], s: "hello", n: 3, o: { k: null } } });
});

await check("checkCallResult: errors are failures unless expected, and an expected error must happen", () => {
  const err = { isError: true, text: "AE: boom\n  at line 4 of the script", json: undefined };
  const fine = { isError: false, text: "{}", json: {} };
  assert.equal(fx.checkCallResult({ call: "x" }, err).length, 1);
  assert.deepEqual(fx.checkCallResult({ call: "x", expectError: true }, err), []);
  assert.deepEqual(fx.checkCallResult({ call: "x", expectError: "at line 4\\b" }, err), []);
  assert.equal(fx.checkCallResult({ call: "x", expectError: "at line 1\\b" }, err).length, 1);
  assert.equal(fx.checkCallResult({ call: "x", expectError: true }, fine).length, 1);
});

const docs = fs.readFileSync(path.join(root, "docs", "verification-recipes.md"), "utf8");
const recipeNumbers = fx.recipeNumbersInDocs(docs);
const fixtures = fx.loadFixtures(path.join(root, "tests", "live", "recipes"));

await check("every committed fixture validates against the real op schemas and the recipe list", () => {
  assert.ok(recipeNumbers.has(1) && recipeNumbers.has(58), "the recipe numbers parse");
  assert.ok(fixtures.length >= 20, `only ${fixtures.length} fixtures`);
  const problems = fixtures.flatMap((f) => fx.validateFixture(f, { opSchemas: OpSchemas, recipeNumbers }));
  assert.deepEqual(problems, []);
  const ids = new Set(fixtures.map((f) => f.id));
  assert.equal(ids.size, fixtures.length);
  for (const f of fixtures) assert.match(f.id, new RegExp(`^${String(f.recipe).padStart(2, "0")}-[a-z0-9-]+$`), `${f.id} is named for its recipe`);
});

await check("the validator catches what a live run would otherwise discover the slow way", () => {
  const v = (f) => fx.validateFixture({ id: "t", recipe: 2, title: "t", ...f }, { opSchemas: OpSchemas, recipeNumbers });
  const one = (steps) => v({ steps });
  assert.deepEqual(one([{ call: "create_comp", args: { name: "ok" } }]), []);
  assert.match(one([{ call: "create_comp", args: { nmae: "typo" } }]).join(), /no argument "nmae"/);
  assert.match(one([{ call: "create_kompo", args: {} }]).join(), /no tool named/);
  assert.match(one([{ call: "create_comp", args: { width: "wide" } }]).join(), /rejects width/);
  assert.deepEqual(one([{ call: "create_solid_layer", args: { compId: "${comp.id}", color: [1, 0, 0] } }]), [], "a templated id is a placeholder");
  assert.match(one([{ call: "create_solid_layer", args: { compId: "${comp.id}" } }]).join(), /rejects color/);
  assert.match(one([{ call: "run_jsx", args: { code: "app.quit();" } }]).join(), /only the driver may/);
  assert.match(
    one([{ call: "run_batch", args: { ops: { $repeat: 3, item: { op: "create_solid_layer", args: { compId: 1, colour: [1, 0, 0] } } } } }]).join(),
    /ops\[0\].*no argument "colour"/
  );
  assert.match(one([{ call: "list_comps", expect: [{ path: "x", equals: 1, type: "number" }] }]).join(), /exactly one/);
  assert.match(one([{ call: "list_comps", expect: [{ path: "x", matches: "(" }] }]).join(), /Invalid regular expression|Unterminated/);
  assert.match(one([{ writeFile: "../escape.jsx", content: "" }]).join(), /inside the scratch folder/);
  assert.match(one([{ saveProject: "/Users/m/real.aep" }]).join(), /bare file name/);
  assert.match(one([{ call: "list_comps", bogus: 1 }]).join(), /unknown key "bogus"/);
  assert.match(v({ recipe: 999, steps: [{ call: "list_comps" }] }).join(), /not in docs/);
  assert.match(v({ needsSavedProject: true, steps: [{ call: "list_comps" }] }).join(), /never saves/);
  assert.deepEqual(one([{ call: "create_shape_layer", args: { compId: 1, position: "middle" }, expectError: true }]), [],
    "a step expecting refusal may send what the schema refuses");
  assert.deepEqual(one([{ writeFile: "s.jsx", content: "return 1;", save: "s" }, { call: "run_jsx", args: { scriptPath: "${s}" } }]), []);
  assert.match(one([{ call: "run_jsx", args: { scriptPath: "/Users/m/anything.jsx" } }]).join(), /file this fixture writes first/);
  assert.match(
    one([{ writeFile: "lib.jsx", content: "app.quit();", save: "lib" }, { call: "run_jsx", args: { code: "return 1;", libraries: ["${lib}"] } }]).join(),
    /writeFile content does what only the driver may[\s\S]*lib does what only the driver may/
  );
  assert.match(
    one([{ call: "run_batch", args: { ops: [{ op: "run_jsx", args: { code: "new File('/x').remove()" } }] } }]).join(),
    /ops\[0\].*only the driver may/
  );
});

await check("selectFixtures by id, prefix or recipe number", () => {
  assert.equal(fx.selectFixtures(fixtures, []).length, fixtures.length);
  assert.deepEqual(fx.selectFixtures(fixtures, ["7"]).map((f) => f.recipe), [7]);
  assert.deepEqual(fx.selectFixtures(fixtures, ["01-list-comps-empty"]).map((f) => f.id), ["01-list-comps-empty"]);
  assert.ok(fx.selectFixtures(fixtures, ["0"]).length >= 9, "prefix");
});

// ---------------------------------------------------------------------------
// Runner, against a stub client
// ---------------------------------------------------------------------------

class StubClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.notifications = [];
  }
  async callTool(name, args, opts = {}) {
    this.calls.push({ name, args, opts });
    const out = await this.handler(name, args, opts, this);
    return { isError: false, text: JSON.stringify(out), json: out, extra: [], images: [], ...(out?.__raw ?? {}) };
  }
}

await check("runner threads saved values into later steps and stops at the first failure", async () => {
  const client = new StubClient((name, args) => {
    if (name === "create_comp") return { id: 77, name: args.name };
    if (name === "create_solid_layer") return { id: 5, compId: args.compId };
    return { ok: true };
  });
  const scratchDir = fs.mkdtempSync(path.join(tmpBase, "run-"));
  const r = await runner.runFixture(
    {
      id: "t", recipe: 2, title: "t",
      steps: [
        { call: "create_comp", args: { name: "c" }, save: "comp" },
        { call: "create_solid_layer", args: { compId: "${comp.id}", color: [1, 0, 0] }, expect: [{ path: "compId", equals: "${comp.id}" }] },
        { writeFile: "lib/rig.jsx", content: "// comp ${comp.id}", save: "rig" },
        { call: "list_comps", expect: [{ path: "ok", equals: false }] },
        { call: "never_reached" },
      ],
    },
    { client, scratchDir }
  );
  assert.equal(r.status, "fail");
  assert.deepEqual(client.calls.map((c) => c.name), ["create_comp", "create_solid_layer", "list_comps"]);
  assert.equal(client.calls[1].args.compId, 77);
  assert.equal(fs.readFileSync(path.join(scratchDir, "lib", "rig.jsx"), "utf8"), "// comp 77");
  assert.match(r.steps.at(-1).failures[0], /"ok" is true, expected false/);
});

await check("runner flags a progress notification that arrives after its response (#82)", async () => {
  const client = new StubClient((name, args, opts, self) => {
    self.notifications.push({ method: "notifications/progress", params: { progressToken: opts.progressToken } });
    setTimeout(() => self.notifications.push({ method: "notifications/progress", params: { progressToken: opts.progressToken } }), 10);
    return { ok: true };
  });
  const r = await runner.runFixture(
    { id: "p", recipe: 7, title: "p", steps: [{ call: "await_job", args: { jobId: "j" }, progress: true, expect: [{ path: "$progress", gte: 1 }] }] },
    { client, scratchDir: tmpBase, settleMs: 50 }
  );
  assert.equal(r.status, "fail");
  assert.match(r.steps.at(-1).failures[0], /after the response/);
});

await check("runner refuses fixture code the driver alone may run, even if validation was skipped", async () => {
  const client = new StubClient(() => ({ ok: true }));
  const r = await runner.runFixture(
    { id: "q", recipe: 8, title: "q", steps: [{ call: "run_jsx", args: { code: "app.quit()" } }] },
    { client, scratchDir: tmpBase }
  );
  assert.equal(r.status, "error");
  assert.match(r.error, /only the driver may/);
  assert.equal(client.calls.length, 0);
});

await check("runner refuses a file-writing call outside scratch, and one beside a project that is not ours", async () => {
  const scratch = safety.makeScratchRoot(tmpBase);
  const client = new StubClient((name, args) => (name === "run_jsx" ? { file: null, numItems: 0 } : { ok: true }));
  const guard = new runner.ProjectGuard({ client, scratchRoots: [scratch] });
  const r1 = await runner.runFixture(
    { id: "w", recipe: 57, title: "w", steps: [{ call: "add_to_render_queue", args: { compId: 1, outputPath: "/Users/m/Desktop/x.mov" } }] },
    { client, scratchDir: scratch }
  );
  assert.equal(r1.status, "error");
  assert.match(r1.error, /outside the scratch folder/);
  const r2 = await runner.runFixture(
    { id: "h", recipe: 10, title: "h", steps: [{ call: "set_house_style", args: { content: "x" } }] },
    { client, guard, scratchDir: scratch }
  );
  assert.equal(r2.status, "error");
  assert.match(r2.error, /an unsaved project is not a scratch project/);
  assert.ok(!client.calls.some((c) => c.name === "add_to_render_queue" || c.name === "set_house_style"), "neither reached the server");
  assert.equal(guard.isOurs(path.join(scratch, "a.aep")), true);
  assert.equal(guard.isOurs(scratch + "2/a.aep"), false);
  assert.equal(guard.isOurs(null), false);
});

await check("SIGTERM and SIGHUP stop a run like Ctrl-C: server killed, restore reminder printed", async () => {
  if (process.platform === "win32") return; // no POSIX signals to send
  // A stand-in for run.mjs's run loop: the real one needs After Effects, so
  // this drives the same client and the same exit hook through a child that
  // starts a server, then is signalled.
  const harness = path.join(tmpBase, "harness.mjs");
  const pidFile = path.join(tmpBase, "server.pid");
  fs.writeFileSync(
    harness,
    `import { StdioMcpClient } from ${JSON.stringify(live("lib", "client.mjs"))};
     import fs from "node:fs";
     const c = new StdioMcpClient({ command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); setInterval(()=>{},1000)"] }).start();
     // Handlers first: the pid file is the test's cue to signal, and a signal
     // that lands before them takes the default action and prints nothing.
     for (const s of ["SIGTERM", "SIGHUP"]) process.on(s, () => { process.stdout.write("reminder\\n"); process.exit(1); });
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.child.pid));
     setInterval(() => {}, 1000);`
  );
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    fs.rmSync(pidFile, { force: true });
    const { spawn } = await import("node:child_process");
    const h = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    h.stdout.on("data", (d) => (out += d));
    while (!fs.existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
    const serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    h.kill(sig);
    await new Promise((r) => h.on("exit", r));
    await new Promise((r) => setTimeout(r, 200));
    assert.match(out, /reminder/);
    let alive = true;
    try {
      process.kill(serverPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `${sig}: the server child is gone`);
  }
  // And run.mjs itself wires all three.
  const src = fs.readFileSync(path.join(root, "tests", "live", "run.mjs"), "utf8");
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.ok(src.includes(`["${sig}",`), `run.mjs handles ${sig}`);
  // Shutdown order: close the scratch project through the server, then stop the server, then delete the folder.
  const cleanupSrc = src.slice(src.indexOf("const cleanup = async"));
  const order = ["await guard.fresh()", "await client.close()", "removeScratchRoot(scratchRoot)"].map((s) => cleanupSrc.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], `cleanup order ${order}`);
  assert.match(cleanupSrc, /WITHOUT saving/, "a server already gone leaves the maintainer a note");
  assert.match(fs.readFileSync(path.join(root, "tests", "live", "lib", "client.mjs"), "utf8"), /detached: process\.platform !== "win32"/,
    "the server is out of the terminal's process group, so Ctrl-C does not kill it before the reset");
});

await check("runner reads the render queue back before render_queue, and refuses a repointed output", async () => {
  const scratch = safety.makeScratchRoot(tmpBase);
  const queue = { items: [{ index: 1, outputs: [{ index: 1, path: path.join(scratch, "ok.mov") }] }], count: 1 };
  const client = new StubClient((name, args) => {
    if (name === "run_jsx" && args.code.includes("DO_NOT_SAVE")) return { closed: null, numItems: 0, file: null }; // fresh()
    if (name === "run_jsx") return { file: path.join(scratch, "p.aep"), numItems: 1 }; // state(): a saved scratch project
    if (name === "list_render_queue") return queue;
    return { jobId: "j" };
  });
  const guard = new runner.ProjectGuard({ client, scratchRoots: [scratch] });
  const fixture = { id: "r", recipe: 59, title: "r", steps: [{ call: "render_queue", args: { all: true } }] };
  const ok = await runner.runFixture(fixture, { client, guard, scratchDir: scratch });
  assert.equal(ok.status, "pass", ok.error);
  queue.items[0].outputs.push({ index: 2, path: "/Users/m/Desktop/repointed.mov" }); // what a run_jsx could do
  const before = client.calls.filter((c) => c.name === "render_queue").length;
  const refused = await runner.runFixture(fixture, { client, guard, scratchDir: scratch });
  assert.equal(refused.status, "error");
  assert.match(refused.error, /repointed\.mov.*outside the scratch folder/);
  assert.equal(client.calls.filter((c) => c.name === "render_queue").length, before, "render_queue never reached the server");
});

await check("the starting project: only an empty untitled one is acceptable", () => {
  assert.equal(runner.judgeStartingProject({ file: null, numItems: 0 }), null);
  assert.match(runner.judgeStartingProject({ file: "/Users/m/Client.aep", numItems: 3 }), /will not close anyone's work/);
  assert.match(runner.judgeStartingProject({ file: null, numItems: 2 }), /unsaved work/);
  assert.match(runner.judgeStartingProject(undefined), /could not read/);
});

await check("the project guard: refuses to close a non-scratch project, and to save outside scratch", async () => {
  const scratch = safety.makeScratchRoot(tmpBase);
  const jsx = runner.freshProjectJsx([scratch]);
  assert.ok(jsx.includes(JSON.stringify(scratch + "/")), "the roots are embedded as string literals, separator-terminated");
  assert.match(jsx, /refusing to close it/);
  assert.match(jsx, /DO_NOT_SAVE_CHANGES/);
  assert.doesNotMatch(jsx, /app\.quit/);
  const client = new StubClient((name, args) => {
    if (args.code.includes("app.project.save")) return { file: "x" };
    return { closed: null, numItems: 0, file: null };
  });
  const guard = new runner.ProjectGuard({ client, scratchRoots: [scratch] });
  await guard.fresh();
  assert.equal(client.calls[0].args.undoGroup, false);
  await assert.rejects(guard.save(path.join(os.homedir(), "Desktop", "oops.aep")), /outside the scratch folder/);
  await guard.save(path.join(scratch, "fine.aep"));
  assert.equal(client.calls.length, 2, "the refused save never reached the server");
  const dirty = new runner.ProjectGuard({ client: new StubClient(() => ({ numItems: 4, file: null })), scratchRoots: [scratch] });
  await assert.rejects(dirty.fresh(), /not empty/);
});

console.log(`live-driver: ${passed} checks passed`);
