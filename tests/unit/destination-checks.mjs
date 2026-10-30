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
const project = { path: aep, items: [{ id: 7, type: "comp" }] };

function mogrt(args) {
  return [
    () => { ctx.app.project.file = new EsFile(aep); return ctx.OPS.export_mogrt({ compId: 7, ...args }); },
    () => D.prepareMogrtDestination({ compId: 7, ...args }, project),
  ];
}
const and = (...fns) => () => fns.forEach((f) => f());

parity("mogrt: default destDir is the .aep's folder", saved, ...mogrt({ name: "LT" }), /^PASSED$/);
parity("mogrt: destDir exists", and(saved, () => fs.mkdirSync(at("out"))), ...mogrt({ name: "LT", destDir: at("out") }), /^PASSED$/);
parity("mogrt: destDir is created", saved, ...mogrt({ name: "LT", destDir: at("new", "deeper") }), /^PASSED$/);
parity("mogrt: trailing separator on destDir", saved, ...mogrt({ name: "LT", destDir: at("out") + "/" }), /^PASSED$/);
parity("mogrt: a slash in the name escapes the folder", saved, ...mogrt({ name: "a/b", destDir: at("out") }), /resolves to .* which is not inside/);
parity("mogrt: a dot-dot name escapes the folder", saved, ...mogrt({ name: "../up", destDir: at("out") }), /is not inside/);
parity("mogrt: existing template, no overwrite", and(saved, touch("out", "LT.mogrt")), ...mogrt({ name: "LT", destDir: at("out") }), /^A template already exists at /);
parity("mogrt: existing template, overwrite", and(saved, touch("out", "LT.mogrt")), ...mogrt({ name: "LT", destDir: at("out"), overwrite: true }), /^PASSED$/);
if (canChmod) {
  parity("mogrt: a folder that refuses writes", and(saved, () => { fs.mkdirSync(at("ro")); fs.chmodSync(at("ro"), 0o555); }),
    ...mogrt({ name: "LT", destDir: at("ro") }), /cannot write into .* a test file could not be created/);
  parity("mogrt: a folder that cannot be created", and(saved, () => { fs.mkdirSync(at("ro")); fs.chmodSync(at("ro"), 0o555); }),
    ...mogrt({ name: "LT", destDir: at("ro", "sub") }), /^Could not create the destination folder /);
}
// No name: the port creates and probes the folder, and leaves the name checks to the jsx.
parity("mogrt: no name, new folder", saved, ...mogrt({ destDir: at("auto") }), /^PASSED$/);

// The write probe never outlives the call.
resetDir(dir);
saved();
fs.mkdirSync(at("out"));
D.prepareMogrtDestination({ compId: 7, name: "LT", destDir: at("out") }, project);
assert.deepEqual(fs.readdirSync(at("out")), []);
passed++;

// Declined: every case where an earlier jsx check decides first, or the path
// is one the two might read differently. Nothing is created for any of them.
resetDir(dir);
saved();
const declined = [
  [{ name: "LT", destDir: at("x1") }, { path: null, items: project.items }, "unsaved project"],
  [{ name: "LT", destDir: at("x2") }, { path: aep, items: [{ id: 8, type: "comp" }] }, "comp not in the project"],
  [{ name: "LT", destDir: at("x3") }, { path: aep, items: [{ id: 7, type: "footage" }] }, "id is not a comp"],
  [{ name: "   ", destDir: at("x4") }, project, "blank name"],
  [{ name: "LT", destDir: "relative/x5" }, project, "relative destDir"],
  [{ name: "LT", destDir: at("x%206") }, project, "escape in destDir"],
];
for (const [args, facts, why] of declined) {
  assert.equal(D.prepareMogrtDestination({ compId: 7, ...args }, facts), null, why);
}
assert.deepEqual(fs.readdirSync(dir), ["proj"], "a declined check makes no folder");
passed++;

// rollback() removes the folders it made, deepest first, and nothing with content.
resetDir(dir);
saved();
let made = D.prepareMogrtDestination({ compId: 7, name: "LT", destDir: at("r1", "r2") }, project);
assert.deepEqual(made.created, [at("r1"), at("r1", "r2")]);
made.rollback();
assert.equal(fs.existsSync(at("r1")), false);
made = D.prepareMogrtDestination({ compId: 7, name: "LT", destDir: at("r3") }, project);
fs.writeFileSync(at("r3", "LT.mogrt"), "zip");
made.rollback();
assert.equal(fs.existsSync(at("r3", "LT.mogrt")), true, "a folder with the export in it is never removed");
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
