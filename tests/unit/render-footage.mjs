// Which footage a render reads, and whether the copy it renders from can find
// it (issues #144 and #145). Everything here is decided before aerender runs,
// and none of it reads aerender's output, so it holds in any language.
//
// #144 — `_render_prepare` refuses missing footage only when the render reads
// it. Footage on a switched-off layer or one outside the rendered span is
// skipped and reported; a track matte, a layer another layer points at through
// a layer-valued property, and audio still count as read; a sampleImage()
// expression demotes a skip to a warning, never to silence.
//
// #145 — the render reads a copy of the .aep in the temp folder, which can only
// find footage by the absolute path the saved file records. The server reads
// those paths from the file and refuses (or, with saveProject:true, saves and
// re-checks) when footage is found only through the relative path, and refuses
// footage whose file is gone although After Effects still shows it.
//
//   node tests/unit/render-footage.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { storedFootagePaths, checkPlanFootage, footageRefusal, canonicalFootagePath } = await import(dist("render", "aerender.js"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`render-footage FAILED: ${name}`);
    throw e;
  }
  passed++;
}
const throwsMsg = (fn) => {
  try { fn(); } catch (e) { return String(e.message); }
  throw new assert.AssertionError({ message: "expected a throw" });
};

// ---------------------------------------------------------------------------
// A mock After Effects DOM, built per test from a small description.
// ---------------------------------------------------------------------------

const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PropertyValueType = { LAYER_INDEX: 6420, OneD: 6417 };
const TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013 };

class CompItem {}
class FootageItem {}

function group(props) {
  return { propertyType: PropertyType.NAMED_GROUP, numProperties: props.length, property: (j) => props[j - 1] };
}
function layerParam(value, extra = {}) {
  return { propertyType: PropertyType.PROPERTY, propertyValueType: PropertyValueType.LAYER_INDEX, value, ...extra };
}
function expressionProp(expression) {
  return { propertyType: PropertyType.PROPERTY, propertyValueType: PropertyValueType.OneD, canSetExpression: true, expressionEnabled: true, expression };
}

let nextId = 100;
function footage(name, { missing = false, file } = {}) {
  return Object.assign(new FootageItem(), {
    id: nextId++,
    name,
    footageMissing: missing,
    file: file === null ? null : { fsName: file ?? `/foot/${name}` },
  });
}
/**
 * A layer: { source, enabled, inPoint, outPoint, startTime, stretch, effects: [props], ... }.
 * Defaults: switched on, spanning 0–10s, no effects.
 */
function layer(spec) {
  const effects = spec.effects ? group(spec.effects.map((p) => group([p]))) : null;
  const L = {
    name: spec.name ?? "Layer",
    source: spec.source,
    enabled: spec.enabled ?? true,
    audioEnabled: spec.audioEnabled ?? false,
    hasAudio: spec.hasAudio ?? false,
    inPoint: spec.inPoint ?? 0,
    outPoint: spec.outPoint ?? 10,
    startTime: spec.startTime ?? 0,
    stretch: spec.stretch ?? 100,
    timeRemapEnabled: spec.timeRemapEnabled ?? false,
    isTrackMatte: spec.isTrackMatte ?? false,
    trackMatteType: spec.trackMatteType ?? TrackMatteType.NO_TRACK_MATTE,
    parent: spec.parent ?? null,
  };
  // A layer is a property group: by number its own top-level groups (where an
  // expression scan looks), by match name the effects.
  const own = spec.props ?? [];
  L.numProperties = own.length;
  L.property = (k) => (typeof k === "number" ? own[k - 1] : k === "ADBE Effect Parade" ? effects ?? group([]) : null);
  return L;
}
function comp(name, layers, { frameRate = 30 } = {}) {
  const c = Object.assign(new CompItem(), { id: nextId++, name, frameRate, numLayers: layers.length });
  layers.forEach((L, i) => { L.index = i + 1; });
  c.layer = (i) => layers[i - 1];
  return c;
}

function makeAe(top, { span = [0, 2] } = {}) {
  const om = { file: { fsName: "/renders/out.mov" }, name: "High Quality", templates: [] };
  const item = {
    comp: top,
    render: true,
    timeSpanStart: span[0],
    timeSpanDuration: span[1] - span[0],
    numOutputModules: 1,
    outputModule: () => om,
    status: 3013,
  };
  const log = [];
  const project = {
    file: { fsName: "/proj/show.aep", readonly: false },
    dirty: false,
    save() { log.push("save"); this.dirty = false; },
    renderQueue: { numItems: 1, item: () => item },
  };
  const ctx = {
    OPS: {},
    JSON,
    File: function (p) { this.fsName = p; },
    Folder: { appPackage: { fsName: "/Applications/AE.app" } },
    RQItemStatus: { QUEUED: 3013 },
    CompItem,
    FootageItem,
    PropertyType,
    PropertyValueType,
    TrackMatteType,
    GetSettingsFormat: { STRING: 1 },
    app: {
      project,
      version: "26.5",
      beginSuppressDialogs() { log.push("suppress"); },
      endSuppressDialogs() { log.push("unsuppress"); },
      beginUndoGroup() {},
      endUndoGroup() {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "packages", "jsx", "core.jsx"), "utf8"), ctx, { filename: "core.jsx" });
  vm.runInContext(fs.readFileSync(path.join(root, "packages", "jsx", "render.jsx"), "utf8"), ctx, { filename: "render.jsx" });
  return { ctx, log, project };
}
const prepare = (top, opts) => makeAe(top, opts).ctx.OPS._render_prepare({ indices: [1] });
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// #144: what counts as read
// ---------------------------------------------------------------------------

check("missing footage on a drawn layer is still refused", () => {
  const top = comp("Main", [layer({ source: footage("pic.png", { missing: true }) })]);
  assert.match(throwsMsg(() => prepare(top)), /cannot find: "pic\.png"/);
});

check("missing footage on a switched-off layer is skipped, and said so", () => {
  const top = comp("Main", [
    layer({ name: "Ref", source: footage("ref.mov", { missing: true }), enabled: false }),
    layer({ source: footage("bg.png") }),
  ]);
  const plan = prepare(top);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].footageSkipped.length, 1);
  assert.match(plan.items[0].footageSkipped[0], /"ref\.mov": its layer "Ref" in "Main" is switched off/);
  assert.deepEqual(plain(plan.items[0].footage), [{ name: "bg.png", path: "/foot/bg.png" }]);
  assert.equal(plan.items[0].footageWarnings, undefined);
});

check("missing footage on a layer outside the rendered span is skipped", () => {
  const top = comp("Main", [layer({ name: "Late", source: footage("late.mov", { missing: true }), inPoint: 5, outPoint: 8 })]);
  const plan = prepare(top, { span: [0, 2] });
  assert.match(plan.items[0].footageSkipped[0], /outside the rendered time span/);
});

check("a layer ending one frame before the span still counts (motion blur, frame blending)", () => {
  const top = comp("Main", [layer({ source: footage("edge.mov", { missing: true }), inPoint: 0, outPoint: 1.99 })]);
  assert.match(throwsMsg(() => prepare(top, { span: [2, 4] })), /edge\.mov/);
});

check("a switched-off track matte is read", () => {
  const top = comp("Main", [
    layer({ name: "Matte", source: footage("matte.mov", { missing: true }), enabled: false, isTrackMatte: true }),
    layer({ source: footage("fill.mov"), trackMatteType: TrackMatteType.ALPHA }),
  ]);
  assert.match(throwsMsg(() => prepare(top)), /matte\.mov/);
});

check("the layer above a legacy track-matte user is read even when isTrackMatte is not set", () => {
  const top = comp("Main", [
    layer({ name: "Matte", source: footage("matte.mov", { missing: true }), enabled: false }),
    layer({ source: footage("fill.mov"), trackMatteType: TrackMatteType.ALPHA }),
  ]);
  assert.match(throwsMsg(() => prepare(top)), /matte\.mov/);
});

check("a switched-off layer another layer points at through an effect is read (Displacement Map)", () => {
  const top = comp("Main", [
    layer({ name: "Map", source: footage("map.png", { missing: true }), enabled: false }),
    layer({ source: footage("plate.mov"), effects: [layerParam(1)] }),
  ]);
  assert.match(throwsMsg(() => prepare(top)), /map\.png/);
});

check("a layer-valued property driven by an expression makes every layer in the comp count as read", () => {
  const top = comp("Main", [
    layer({ name: "Map", source: footage("map.png", { missing: true }), enabled: false }),
    layer({ source: footage("plate.mov"), effects: [layerParam(0, { expressionEnabled: true })] }),
  ]);
  assert.match(throwsMsg(() => prepare(top)), /map\.png/);
});

check("a switched-off parent is not a read: parenting takes the transform, not the pixels", () => {
  const parent = layer({ name: "Rig", source: footage("rig.png", { missing: true }), enabled: false });
  const top = comp("Main", [parent, layer({ source: footage("plate.mov"), parent })]);
  const plan = prepare(top);
  assert.match(plan.items[0].footageSkipped[0], /rig\.png/);
});

check("video off with audio on is read", () => {
  const top = comp("Main", [layer({ source: footage("vo.wav", { missing: true }), enabled: false, audioEnabled: true, hasAudio: true })]);
  assert.match(throwsMsg(() => prepare(top)), /vo\.wav/);
});

check("a sampleImage() expression turns a skip into a warning, never into silence", () => {
  const top = comp("Main", [
    layer({ name: "Ref", source: footage("ref.mov", { missing: true }), enabled: false }),
    layer({ source: footage("bg.png"), props: [group([expressionProp('thisComp.layer("Ref").sampleImage([0,0])')])] }),
  ]);
  const plan = prepare(top);
  assert.equal(plan.items[0].footageSkipped, undefined);
  assert.equal(plan.items[0].footageWarnings.length, 1);
  assert.match(plan.items[0].footageWarnings[0], /"ref\.mov".*sampleImage/);
});

check("footage read in one place and skipped in another is read", () => {
  const shared = footage("shared.mov", { missing: true });
  const top = comp("Main", [
    layer({ source: shared, enabled: false }),
    layer({ source: shared }),
  ]);
  const msg = throwsMsg(() => prepare(top));
  assert.equal((msg.match(/shared\.mov/g) || []).length, 1);
});

check("the span is mapped into a nested comp: footage outside its mapped time is skipped", () => {
  // The precomp layer starts at 10s in Main; Main renders 10–12s, which is
  // Inner's 0–2s. Inner's missing layer lives at 5–8s.
  const inner = comp("Inner", [
    layer({ name: "Early", source: footage("early.mov") , inPoint: 0, outPoint: 2 }),
    layer({ name: "Later", source: footage("later.mov", { missing: true }), inPoint: 5, outPoint: 8 }),
  ]);
  const top = comp("Main", [layer({ source: inner, startTime: 10, inPoint: 10, outPoint: 20 })]);
  const plan = prepare(top, { span: [10, 12] });
  assert.match(plan.items[0].footageSkipped[0], /"later\.mov": its layer "Later" in "Inner" is outside the rendered time span/);
  assert.deepEqual(plain(plan.items[0].footage).map((f) => f.name), ["early.mov"]);
});

check("a nested comp with time remapping, an effect, or a stretch is read over all of its time", () => {
  for (const extra of [{ timeRemapEnabled: true }, { effects: [expressionProp("0")] }]) {
    const inner = comp("Inner", [layer({ source: footage("later.mov", { missing: true }), inPoint: 5, outPoint: 8 })]);
    const top = comp("Main", [layer({ source: inner, startTime: 10, inPoint: 10, outPoint: 20, ...extra })]);
    assert.match(throwsMsg(() => prepare(top, { span: [10, 12] })), /later\.mov/, JSON.stringify(Object.keys(extra)));
  }
  // 50% stretch: Main's 10–12s is Inner's 0–4s, so a layer at 3–4s is read.
  const inner = comp("Inner", [layer({ source: footage("later.mov", { missing: true }), inPoint: 3, outPoint: 4 })]);
  const top = comp("Main", [layer({ source: inner, startTime: 10, inPoint: 10, outPoint: 20, stretch: 50 })]);
  assert.match(throwsMsg(() => prepare(top, { span: [10, 12] })), /later\.mov/);
});

check("a switched-off precomp's missing footage is skipped, and a drawn use of the same precomp is not", () => {
  const inner = comp("Inner", [layer({ source: footage("deep.mov", { missing: true }) })]);
  const off = comp("Main", [layer({ name: "Pre", source: inner, enabled: false })]);
  assert.match(prepare(off).items[0].footageSkipped[0], /"deep\.mov": its layer "Pre" in "Main" is switched off/);
  const both = comp("Main", [layer({ name: "Pre", source: inner, enabled: false }), layer({ source: inner })]);
  assert.match(throwsMsg(() => prepare(both)), /deep\.mov/);
});

check("a solid or other footage with no file is not listed for the on-disk check", () => {
  const top = comp("Main", [layer({ source: footage("Black Solid 1", { file: null }) })]);
  assert.deepEqual(plain(prepare(top).items[0].footage), []);
});

check("_render_save with force saves a clean project", () => {
  const { ctx, log } = makeAe(comp("Main", []));
  assert.equal(ctx.OPS._render_save({}).saved, false);
  assert.deepEqual(log, []);
  assert.equal(ctx.OPS._render_save({ force: true }).saved, true);
  assert.deepEqual(log, ["suppress", "save", "unsuppress"]);
});

// ---------------------------------------------------------------------------
// #145: what the saved project records
// ---------------------------------------------------------------------------

/** A RIFX-ish byte stream with one `alas` chunk per path, as AE 26.x writes it (measured). */
function fakeAep(paths, { folder = [] } = {}) {
  const parts = [Buffer.from("RIFX\0\0\0\0Egg!", "latin1")];
  const rec = (p, isFolder) => {
    const json = JSON.stringify({ ascendcount_base: 1, ascendcount_target: 3, fullpath: p, platform: 2, server_name: "", server_volume_name: "", target_is_folder: isFolder });
    const body = Buffer.from(json, "utf8");
    const pad = body.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    const head = Buffer.alloc(8);
    head.write("alas", 0, "latin1");
    head.writeUInt32BE(body.length, 4);
    parts.push(Buffer.from("Utf8\0\0\0\0LIST\0\0\0\0Als2", "latin1"), head, body, pad, Buffer.from("opti\0\0\0\x3aWAVE", "latin1"));
  };
  for (const p of paths) rec(p, false);
  for (const p of folder) rec(p, true);
  return Buffer.concat(parts);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-footage-")));
const footDir = path.join(tmp, "Prüfung", "foot");
fs.mkdirSync(footDir, { recursive: true });
const pic = path.join(footDir, "pic.png");
const vo = path.join(footDir, "vo.wav");
fs.writeFileSync(pic, "x");
fs.writeFileSync(vo, "x");
const aep = path.join(tmp, "show.aep");
const planWith = (...refs) => ({ projectPath: aep, appPackage: null, items: [{ index: 1, compId: 1, compName: "Main", status: "QUEUED", frames: 1, outputs: [], footage: refs }] });

check("the absolute paths are read out of a saved project, wherever the chunks sit", () => {
  const bytes = fakeAep(["/a/one.wav", "/Volumes/Prüfung/two.mov"], { folder: ["/seq"] });
  const got = storedFootagePaths(bytes);
  assert.equal(got.records, 3);
  assert.deepEqual(got.paths, ["/a/one.wav", "/Volumes/Prüfung/two.mov"]);
  assert.deepEqual(got.folders, ["/seq"]);
  assert.equal(storedFootagePaths(Buffer.from("RIFX no footage here alas\0\0\0\x05hello")).records, 0);
});

check("an .aepx's fileReference attributes are read too", () => {
  const xml = '<x><fileReference fullpath="/a/b &amp; c.png" target_is_folder="0"/><fileReference fullpath="/seq" target_is_folder="1"/></x>';
  const got = storedFootagePaths(Buffer.from(xml), true);
  assert.deepEqual(got.paths, ["/a/b & c.png"]);
  assert.deepEqual(got.folders, ["/seq"]);
});

check("footage recorded at its absolute path passes", () => {
  fs.writeFileSync(aep, fakeAep([pic, vo]));
  const r = checkPlanFootage(planWith({ name: "pic.png", path: pic }, { name: "vo.wav", path: vo }), aep);
  assert.deepEqual(r, { gone: [], stale: [], unreadable: false });
  assert.equal(footageRefusal(r, { saveProject: false, afterSave: false }), null);
});

check("footage found only through the relative path is stale, and refused until saveProject:true", () => {
  // The project folder was moved: the file records where the footage USED to be.
  fs.writeFileSync(aep, fakeAep(["/Volumes/Old Drive/Prüfung/foot/pic.png", vo]));
  const r = checkPlanFootage(planWith({ name: "pic.png", path: pic }, { name: "vo.wav", path: vo }), aep);
  assert.deepEqual(r.stale.map((f) => f.name), ["pic.png"]);
  const refused = footageRefusal(r, { saveProject: false, afterSave: false });
  assert.match(refused, /^Nothing was saved or rendered/);
  assert.match(refused, /relative to the project/);
  assert.match(refused, /saveProject:true/);
  assert.equal(footageRefusal(r, { saveProject: true, afterSave: false }), null, "with saveProject the save goes ahead");
  assert.match(footageRefusal(r, { saveProject: true, afterSave: true }), /^The project WAS saved, but nothing was rendered/);
});

check("footage After Effects still shows but whose file is gone is refused, save or no save", () => {
  fs.writeFileSync(aep, fakeAep([pic, path.join(footDir, "deleted.mov")]));
  const r = checkPlanFootage(planWith({ name: "deleted.mov", path: path.join(footDir, "deleted.mov") }), aep);
  assert.equal(r.gone.length, 1);
  for (const saveProject of [false, true]) {
    assert.match(footageRefusal(r, { saveProject, afterSave: false }), /no longer on disk: "deleted\.mov"/);
  }
});

check("a project from which no footage path can be read proves nothing, and is refused", () => {
  fs.writeFileSync(aep, Buffer.from("RIFX but not a format this knows"));
  const r = checkPlanFootage(planWith({ name: "pic.png", path: pic }), aep);
  assert.equal(r.unreadable, true);
  assert.match(footageRefusal(r, { saveProject: true, afterSave: false }), /no footage path could be read/);
  // …but a render that reads no file-backed footage at all needs no paths.
  assert.deepEqual(checkPlanFootage(planWith(), aep), { gone: [], stale: [], unreadable: false });
});

check("the same file under another name (NFD, symlink, folder record) is not stale", () => {
  // Finder hands out NFD; After Effects may store either.
  fs.writeFileSync(aep, fakeAep([pic.normalize("NFD")]));
  assert.deepEqual(checkPlanFootage(planWith({ name: "pic.png", path: pic }), aep).stale, []);
  // A symlinked folder: the project records the link, AE resolves the target.
  // (Windows needs a privilege to make one, so the CI runner skips this part.)
  const link = path.join(tmp, "linked");
  let linked = true;
  try { fs.symlinkSync(footDir, link, "junction"); } catch { linked = false; }
  if (linked) {
    fs.writeFileSync(aep, fakeAep([path.join(link, "pic.png")]));
    assert.deepEqual(checkPlanFootage(planWith({ name: "pic.png", path: pic }), aep).stale, []);
  } else {
    assert.equal(process.platform, "win32", "symlinks are only expected to fail on Windows");
  }
  // A sequence recorded as its folder.
  fs.writeFileSync(aep, fakeAep([], { folder: [footDir] }));
  assert.deepEqual(checkPlanFootage(planWith({ name: "pic.png", path: pic }), aep).stale, []);
});

check("Windows paths compare without case or slash direction", () => {
  assert.equal(canonicalFootagePath("C:\\Proj\\Foot\\A.PNG", "win32"), canonicalFootagePath("c:/proj/foot/a.png", "win32"));
  assert.equal(canonicalFootagePath("/c/Proj/a.png", "win32"), "c:/proj/a.png");
  assert.notEqual(canonicalFootagePath("/Proj/A.png", "darwin"), canonicalFootagePath("/proj/a.png", "darwin"));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`render-footage: ${passed} checks passed`);
