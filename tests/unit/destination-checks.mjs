// The filesystem checks that moved from the jsx to the server (issue #220,
// stage 2): add_to_render_queue's output path, import_footage's file, and
// export_mogrt's destination folder.
//
// The jsx copies stay in the bundle and still run after the server's pass, so
// the server's check is only ever *earlier*, never different. That holds only
// if, on the same folder, each port refuses exactly when its jsx refuses, with
// the same sentence. Each scenario here runs both against one real temporary
// folder, reset between them, with ExtendScript's File modelled on the real
// filesystem (lib/es-file.mjs). The jsx handler is stopped at the first thing
// it does *after* its checks — adding the render item, importing, saving the
// project — which is reported as "PASSED"; the port passing is "PASSED" too.
//
// A port may also decline to judge (a path Node and ExtendScript might read
// differently, a template name it does not know). That forwards the call
// untouched and the jsx decides, which is never a disagreement — those cases
// are asserted separately.
//
// What only live After Effects can confirm, because the model in
// lib/es-file.mjs assumes it (recipes 18, 57, 64 and 72):
//   - `File.fsName` on a path that does not exist yet: whether it resolves
//     symlinks (/tmp vs /private/tmp) or `..`, and whether a trailing
//     separator is dropped. The refusals quote it.
//   - Whether `fsName` hands back a Unicode path in the form it was given, or
//     NFD on macOS. The port quotes the form it was given.
//   - `~` as the home folder on macOS, and `Folder.create` making every
//     missing parent.
//   - A destination that exists as a *file*: `Folder.exists` may differ from
//     Node's `existsSync`.
//
//   node tests/unit/destination-checks.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EsFile, EsFolder, resetDir, scratchDir, snapshotTree } from "./lib/es-file.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const D = await import(dist("files", "destinations.js"));

const PASSED = "PASSED";
const reached = () => { throw new Error(PASSED); };
const result = (fn) => {
  try { const v = fn(); return v === null ? "FORWARD" : PASSED; }
  catch (e) { return String(e.message); }
};

// One realm for all three jsx files, with just enough AE for each handler to
// reach the line after its checks.
const ctx = {
  OPS: {},
  noUndo: (fn) => fn,
  undoNamed: (n, fn) => fn,
  noUndoWhen: (p, fn) => fn,
  File: EsFile,
  Folder: EsFolder,
  ImportOptions: function () { reached(); },
  // export_mogrt's first side effect is suppressing dialogs, then the save.
  app: { beginSuppressDialogs: reached, project: { file: null, save: reached, renderQueue: { items: { add: reached } } } },
};
vm.createContext(ctx);
vm.runInContext(`
  function CompItem() {}
  function TextLayer() {}
  function FolderItem() {}
  function FootageItem() {}
  var COMP = new CompItem();
  COMP.id = 7; COMP.name = "Lower Third"; COMP.numLayers = 0; COMP.duration = 5;
  COMP.motionGraphicsTemplateName = "Untitled";
  COMP.motionGraphicsTemplateControllerCount = 1;
  function getCompById(id) { if (id !== 7) throw new Error("No comp with id " + id); return COMP; }
`, ctx);
for (const f of ["render.jsx", "footage.jsx", "mogrt.jsx"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8"), ctx);
}
const jsxResult = (fn) => {
  try { fn(); return "RETURNED"; }
  catch (e) { return String(e.message); }
};

const dir = scratchDir("dest");
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
let passed = 0;

function parity(name, setup, runJsx, runTs, expect) {
  resetDir(dir);
  setup();
  const j = jsxResult(runJsx);
  const jDisk = snapshotTree(dir);
  resetDir(dir);
  setup();
  const t = result(runTs);
  const tDisk = snapshotTree(dir);
  resetDir(dir);
  try {
    assert.equal(t, j, "the port and the jsx reach the same verdict, in the same words");
    assert.deepEqual(tDisk, jDisk, "and leave the same things on disk");
    if (expect) assert.match(t, expect);
  } catch (e) {
    console.error(`destination-checks FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const at = (...p) => path.join(dir, ...p);
const touch = (...p) => () => { fs.mkdirSync(path.dirname(at(...p)), { recursive: true }); fs.writeFileSync(at(...p), "x"); };
const nothing = () => {};
const and = (...fns) => () => fns.forEach((f) => f());

// ---------- add_to_render_queue ----------

const rq = (outputPath, extra = {}) => [
  () => ctx.OPS.add_to_render_queue({ compId: 7, outputPath, ...extra }),
  () => D.checkRenderOutput({ outputPath, ...extra }),
];

parity("render: relative path", nothing, ...rq("renders/x.mov"), /must be absolute/);
parity("render: empty path", nothing, ...rq(""), /must be absolute \(got ""\)/);
parity("render: folder exists", nothing, ...rq(at("x.mov")), /^PASSED$/);
parity("render: folder missing", nothing, ...rq(at("nope", "x.mov")), /folder for outputPath does not exist/);
parity("render: nested missing", nothing, ...rq(at("a", "b", "x.mov")), /does not exist: .*a.b\./);
parity("render: file exists, no overwrite", touch("x.mov"), ...rq(at("x.mov")), /already exists/);
parity("render: file exists, overwrite", touch("x.mov"), ...rq(at("x.mov"), { overwrite: true }), /^PASSED$/);
parity("render: sequence pattern is never 'exists'", touch("f_[####].png"), ...rq(at("f_[####].png")), /^PASSED$/);
parity("render: dot segments normalise", touch("x.mov"), ...rq(dir + "/sub/../x.mov"), /already exists at [^.]*x\.mov\./);
parity("render: trailing separator names the folder itself", nothing, ...rq(at("out") + "/"), /^PASSED$/);

// The home folder: ExtendScript reads ~ as $HOME on macOS. On Windows the port
// leaves ~ to the jsx.
if (process.platform !== "win32") {
  const home = fs.realpathSync(os.homedir());
  const missing = "~/ae-mcp-surely-not-here-" + process.pid + "/x.mov";
  assert.equal(result(() => D.checkRenderOutput({ outputPath: missing })),
    "The folder for outputPath does not exist: " + path.join(home, path.dirname(missing.slice(2))) +
    ". Create it first — a render into a missing folder fails only when it runs.");
  passed++;
}

// Unicode in both normal forms. A folder made with a decomposed name (as
// Finder makes one) and named in the caller's composed form, and the reverse.
// Both copies answer from the same filesystem; on APFS and NTFS lookups are
// normalisation-insensitive or byte-exact alike for Node and the model.
const nfd = "Prüfung ✓";
const nfc = nfd.normalize("NFC");
const unicodeFolder = (name) => () => fs.mkdirSync(at(name));
parity("render: NFD folder, NFD path", unicodeFolder(nfd), ...rq(at(nfd, "clip.mov")), /^PASSED$/);
parity("render: NFC folder, NFC path", unicodeFolder(nfc), ...rq(at(nfc, "clip.mov")), /^PASSED$/);
parity("render: NFD folder named in NFC", unicodeFolder(nfd), ...rq(at(nfc, "clip.mov")));
parity("render: missing Unicode folder names it as given", nothing, ...rq(at(nfd, "日本", "x.mov")), /does not exist/);
parity("render: existing NFD file", and(unicodeFolder(nfd), touch(nfd, "é.mov")), ...rq(at(nfd, "é.mov")), /already exists/);

// Declined, never refused: a path ExtendScript might decode differently.
assert.equal(result(() => D.checkRenderOutput({ outputPath: at("no%20such", "x.mov") })), PASSED);
passed++;

// ---------- import_footage ----------

const imp = (p) => [() => ctx.OPS.import_footage({ path: p }), () => D.checkFootageExists({ path: p })];
parity("footage: present", touch("clip.mov"), ...imp(at("clip.mov")), /^PASSED$/);
parity("footage: missing", nothing, ...imp(at("clip.mov")), /^No file at /);
// A relative path is not judged here; the jsx decides it as it always did.
assert.equal(result(() => D.checkFootageExists({ path: "clip.mov" })), PASSED);
passed++;

// ---------- export_mogrt ----------

const aep = at("proj", "show.aep");
const saved = () => { fs.mkdirSync(at("proj"), { recursive: true }); fs.writeFileSync(aep, "aep"); };

function mogrt(args) {
  return [
    () => { ctx.app.project.file = new EsFile(aep); return ctx.OPS.export_mogrt({ compId: 7, ...args }); },
    () => D.checkMogrtDestination({ compId: 7, ...args }),
  ];
}

/**
 * The port against the jsx where the folder does not exist yet. The jsx makes
 * it; the port must not. So the verdicts must agree, the port must leave the
 * disk exactly as it found it, and the jsx may differ only by the folder.
 */
function parityNoFolder(name, setup, runJsx, runTs, expect) {
  resetDir(dir);
  setup();
  const j = jsxResult(runJsx);
  resetDir(dir);
  setup();
  const before = snapshotTree(dir);
  const t = result(runTs);
  const after = snapshotTree(dir);
  resetDir(dir);
  try {
    assert.equal(t, j, "the port and the jsx reach the same verdict, in the same words");
    assert.deepEqual(after, before, "the port has no side effect: no folder, no probe");
    if (expect) assert.match(t, expect);
  } catch (e) {
    console.error(`destination-checks FAILED: ${name}`);
    throw e;
  }
  passed++;
}

parity("mogrt: destDir exists", and(saved, () => fs.mkdirSync(at("out"))), ...mogrt({ name: "LT", destDir: at("out") }), /^PASSED$/);
parity("mogrt: trailing separator on destDir", and(saved, () => fs.mkdirSync(at("out"))), ...mogrt({ name: "LT", destDir: at("out") + "/" }), /^PASSED$/);
parity("mogrt: a slash in the name escapes the folder", and(saved, () => fs.mkdirSync(at("out"))), ...mogrt({ name: "a/b", destDir: at("out") }), /resolves to .* which is not inside/);
parity("mogrt: a dot-dot name escapes the folder", and(saved, () => fs.mkdirSync(at("out"))), ...mogrt({ name: "../up", destDir: at("out") }), /is not inside/);
parity("mogrt: existing template, no overwrite", and(saved, touch("out", "LT.mogrt")), ...mogrt({ name: "LT", destDir: at("out") }), /^A template already exists at /);
parity("mogrt: existing template, overwrite", and(saved, touch("out", "LT.mogrt")), ...mogrt({ name: "LT", destDir: at("out"), overwrite: true }), /^PASSED$/);
parity("mogrt: no name, folder exists", and(saved, () => fs.mkdirSync(at("auto"))), ...mogrt({ destDir: at("auto") }), /^PASSED$/);

// A destination that does not exist yet: the port makes nothing.
parityNoFolder("mogrt: new destDir passes, and is left to the jsx to create", saved, ...mogrt({ name: "LT", destDir: at("new", "deeper") }), /^PASSED$/);
parityNoFolder("mogrt: new destDir, a slash in the name", saved, ...mogrt({ name: "a/b", destDir: at("new") }), /is not inside/);
parityNoFolder("mogrt: new destDir, no name", saved, ...mogrt({ destDir: at("auto") }), /^PASSED$/);

// Left to the jsx, by design: whether the folder accepts writes (the jsx's
// test is a file written into the folder, which the server will not do) and
// whether a new folder can be created. The port passes, creates and writes
// nothing, and the jsx then refuses in its own words, as it always did.
if (canChmod) {
  const ro = and(saved, () => { fs.mkdirSync(at("ro")); fs.chmodSync(at("ro"), 0o555); });
  for (const [why, destDir, jsxSays] of [
    ["a folder that refuses writes", () => at("ro"), /cannot write into .* a test file could not be created/],
    ["a folder that cannot be created", () => at("ro", "sub"), /^Could not create the destination folder /],
  ]) {
    resetDir(dir);
    ro();
    assert.match(jsxResult(mogrt({ name: "LT", destDir: destDir() })[0]), jsxSays, why);
    resetDir(dir);
    ro();
    const before = snapshotTree(dir);
    assert.equal(result(mogrt({ name: "LT", destDir: destDir() })[1]), PASSED, why);
    assert.deepEqual(snapshotTree(dir), before, why + ": the port wrote nothing");
    resetDir(dir);
    passed++;
  }
}

// No side effects on any refusal, nor on a pass.
resetDir(dir);
saved();
fs.mkdirSync(at("out"));
fs.writeFileSync(at("out", "LT.mogrt"), "zip");
const beforeRefusal = snapshotTree(dir);
assert.match(result(() => D.checkMogrtDestination({ compId: 7, name: "LT", destDir: at("out") })), /already exists/);
assert.match(result(() => D.checkMogrtDestination({ compId: 7, name: "a/b", destDir: at("nowhere", "deep") })), /is not inside/);
assert.equal(result(() => D.checkMogrtDestination({ compId: 7, name: "LT", destDir: at("out"), overwrite: true })), PASSED);
assert.deepEqual(snapshotTree(dir), beforeRefusal, "nothing created, written or removed");
passed++;

// Not judged: no destDir, a blank name the jsx refuses first, or a path the
// two might read differently. Nothing is created for any of them.
resetDir(dir);
saved();
const declined = [
  [{ name: "LT" }, "no destDir"],
  [{ name: "LT", destDir: "" }, "empty destDir"],
  [{ name: "   ", destDir: at("x4") }, "blank name"],
  [{ name: "a/b", destDir: "relative/x5" }, "relative destDir"],
  [{ name: "a/b", destDir: at("x%206") }, "escape in destDir"],
];
for (const [args, why] of declined) {
  assert.equal(result(() => D.checkMogrtDestination({ compId: 7, ...args })), PASSED, why);
}
assert.deepEqual(fs.readdirSync(dir), ["proj"], "a declined check makes no folder");
passed++;

// ---------- not allowed to look is not "missing" ----------
//
// macOS grants privacy access (TCC) to Desktop, Documents, removable and
// network volumes per app, and a Windows mapped drive can be invisible to the
// server's process while After Effects sees it. So only a definite ENOENT or
// ENOTDIR is "missing"; EACCES, EPERM or any other failure to look forwards
// the call and the jsx decides.

// Real EACCES: a folder this process may not search.
if (canChmod) {
  resetDir(dir);
  fs.mkdirSync(at("locked", "inner"), { recursive: true });
  fs.writeFileSync(at("locked", "LT.mogrt"), "zip");
  fs.chmodSync(at("locked"), 0o000);
  let code = null;
  try { fs.statSync(at("locked", "inner")); } catch (e) { code = e.code; }
  assert.equal(code, "EACCES", "the fixture really cannot be looked into");
  assert.equal(D.pathState(at("locked", "inner")), "unknown");
  assert.equal(result(() => D.checkRenderOutput({ outputPath: at("locked", "inner", "x.mov") })), PASSED, "render: forwarded");
  assert.equal(result(() => D.checkFootageExists({ path: at("locked", "clip.mov") })), PASSED, "footage: forwarded");
  assert.equal(result(() => D.checkMogrtDestination({ compId: 7, name: "LT", destDir: at("locked") })), PASSED, "mogrt: forwarded");
  fs.chmodSync(at("locked"), 0o755);
  resetDir(dir);
  passed++;
}

// Simulated, on every platform: each errno a stat can fail with.
{
  const realStat = fs.statSync;
  const isRoot = (p) => path.parse(path.resolve(String(p))).root === path.resolve(String(p));
  // Every stat fails with `code`; the volume root answers unless `rootCode` says otherwise.
  const failWith = (code, rootCode = null) => {
    fs.statSync = (p) => {
      const c = isRoot(p) ? rootCode : code;
      if (c === null) return realStat(p);
      const e = new Error(c); e.code = c; throw e;
    };
  };
  try {
    for (const code of ["EACCES", "EPERM", "EIO", "ELOOP", "ENAMETOOLONG", "EBUSY"]) {
      failWith(code);
      assert.equal(D.pathState(at("x")), "unknown", code);
      assert.equal(result(() => D.checkRenderOutput({ outputPath: at("a", "x.mov") })), PASSED, `render forwarded on ${code}`);
      assert.equal(result(() => D.checkFootageExists({ path: at("clip.mov") })), PASSED, `footage forwarded on ${code}`);
      assert.equal(result(() => D.checkMogrtDestination({ compId: 7, name: "LT", destDir: at("out") })), PASSED, `mogrt forwarded on ${code}`);
    }
    for (const code of ["ENOENT", "ENOTDIR"]) {
      failWith(code);
      assert.equal(D.pathState(at("x")), "missing", code);
      assert.match(result(() => D.checkRenderOutput({ outputPath: at("a", "x.mov") })), /does not exist/, `render refused on ${code}`);
      assert.match(result(() => D.checkFootageExists({ path: at("clip.mov") })), /^No file at /, `footage refused on ${code}`);
    }
    // A mapped drive the server's logon session cannot see: Windows answers
    // ENOENT for the path *and* for the drive root. The volume is not
    // visible, so the server cannot tell, and the call is forwarded.
    for (const rootCode of ["ENOENT", "EACCES", "EIO"]) {
      failWith("ENOENT", rootCode);
      assert.equal(D.pathState(at("x")), "unknown", `root ${rootCode}`);
      assert.equal(result(() => D.checkRenderOutput({ outputPath: at("a", "x.mov") })), PASSED, `render forwarded, root ${rootCode}`);
      assert.equal(result(() => D.checkFootageExists({ path: at("clip.mov") })), PASSED, `footage forwarded, root ${rootCode}`);
    }
    for (const p of ["Z:\\renders\\x.mov", "\\\\server\\share\\renders\\x.mov"]) {
      const root = path.win32.parse(p).root;
      assert.ok(root === "Z:\\" || root === "\\\\server\\share\\", `${p} has a drive or UNC root: ${root}`);
    }
  } finally {
    fs.statSync = realStat;
  }
  passed++;
}

// The ported helpers match the jsx's on the inputs they exist for.
for (const p of ["/a", "~/a", "C:\\a", "c:/a", "\\\\srv\\a", "a/b", "", ".", "C:a"]) {
  assert.equal(D.rqIsAbsolutePath(p), ctx.__rqIsAbsolutePath(p), p);
}
for (const p of ["/x/[####].png", "/x/[#].png", "/x/[].png", "/x/#.png"]) {
  assert.equal(D.isSequencePath(p), ctx.__rqIsSequencePath(p), p);
}
for (const p of ["/a/", "/a//", "/", "C:\\a\\", "a"]) {
  assert.equal(D.trimTrailingSeparator(p), ctx.__trimTrailingSeparator(p), p);
  assert.equal(D.joinPath(p, "x"), ctx.__joinPath(p, "x"), p);
}
for (const s of ["", " ", "\t\n", "a", " a "]) assert.equal(D.isBlank(s), ctx.__isBlank(s), JSON.stringify(s));
passed++;

fs.rmSync(dir, { recursive: true, force: true });
console.log(`destination-checks: ${passed} checks passed`);
