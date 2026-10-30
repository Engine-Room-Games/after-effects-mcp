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
  app: { project: { file: null, save: reached, renderQueue: { items: { add: reached } } } },
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
if (canChmod) {
  parity("mogrt: a folder that refuses writes", and(saved, () => { fs.mkdirSync(at("ro")); fs.chmodSync(at("ro"), 0o555); }),
    ...mogrt({ name: "LT", destDir: at("ro") }), /cannot write into .* a test file could not be created/);
}

// A destination that does not exist yet: the port makes nothing.
parityNoFolder("mogrt: new destDir passes, and is left to the jsx to create", saved, ...mogrt({ name: "LT", destDir: at("new", "deeper") }), /^PASSED$/);
parityNoFolder("mogrt: new destDir, a slash in the name", saved, ...mogrt({ name: "a/b", destDir: at("new") }), /is not inside/);
parityNoFolder("mogrt: new destDir, no name", saved, ...mogrt({ destDir: at("auto") }), /^PASSED$/);

// The one disagreement a missing folder allows, and the reason it is allowed:
// the jsx fails to create the folder; the port, which creates nothing, passes
// and leaves that refusal to the jsx, word for word, after it.
if (canChmod) {
  const ro = and(saved, () => { fs.mkdirSync(at("ro")); fs.chmodSync(at("ro"), 0o555); });
  resetDir(dir);
  ro();
  assert.match(jsxResult(mogrt({ name: "LT", destDir: at("ro", "sub") })[0]), /^Could not create the destination folder /);
  resetDir(dir);
  ro();
  assert.equal(result(mogrt({ name: "LT", destDir: at("ro", "sub") })[1]), PASSED);
  assert.equal(fs.existsSync(at("ro", "sub")), false);
  resetDir(dir);
  passed++;
}

// No side effects on any refusal, nor on a pass: the write probe never
// outlives the call, and a refused call leaves the folder as it was.
resetDir(dir);
saved();
fs.mkdirSync(at("out"));
fs.writeFileSync(at("out", "LT.mogrt"), "zip");
const beforeRefusal = snapshotTree(dir);
assert.match(result(() => D.checkMogrtDestination({ compId: 7, name: "LT", destDir: at("out") })), /already exists/);
assert.match(result(() => D.checkMogrtDestination({ compId: 7, name: "a/b", destDir: at("nowhere", "deep") })), /is not inside/);
assert.deepEqual(snapshotTree(dir), beforeRefusal, "a refusal leaves no folder and no probe");
assert.equal(result(() => D.checkMogrtDestination({ compId: 7, name: "LT", destDir: at("out"), overwrite: true })), PASSED);
assert.deepEqual(fs.readdirSync(at("out")), ["LT.mogrt"], "the probe is gone after a pass");
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
