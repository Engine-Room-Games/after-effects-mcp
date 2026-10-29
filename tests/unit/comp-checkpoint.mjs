// checkpoint_comp / list_checkpoints / revert_comp / delete_checkpoints, out of
// packages/jsx/checkpoint.jsx (issue #136).
//
// The way back from a change that does not lean on After Effects' undo stack.
// What this locks in, because every one of them fails as a plausible success:
//
//   - The comp keeps its id across a revert. Ids are the agent's long-lived
//     handles and every precomp usage points at the item, so the restore goes
//     INTO the original comp; nothing is swapped in.
//   - Layer ids do change, and the result maps them from the ids the comp had
//     when the checkpoint was taken.
//   - Copy-first: a layer that will not copy leaves the comp exactly as it was.
//   - Order, parenting (without compensation), track mattes and locks are put
//     back explicitly — copyToComp drops the parent and lands copies in an
//     order of its own.
//   - copyToComp's refusal inside an undo group (issue #30) is retried with
//     the group closed, counted, and no group is ever left open.
//   - The result is verified against the checkpoint, and a mismatch is
//     reported rather than smoothed over.
//   - Checkpoints are found by their comment tag, and duplicate_comp of one
//     does not produce a second.
//   - Effect layer picks (Layer Control and friends) are re-pointed. The stub's
//     pick holds a layer and reads back as its index, and a copy keeps holding
//     the checkpoint's layer, so in the restored comp it reads as nothing.
//   - A record naming a comp by id alone is not trusted when the name differs.
//   - Comp settings land before the layers are copied in, and are put back
//     when a copy fails.
//
// Three behaviours of AE 26.5 measured on the live pass of this PR are in the
// stub, because each broke the first version of the op:
//   - itemByID of a deleted id THROWS ("internal verification failure {Item
//     Not Found}") instead of returning null.
//   - copyToComp appends " 2" to an explicitly named layer when the
//     destination already holds that name.
//   - copyToComp of a PARENTED layer bakes its keys into comp space and parents
//     the copy to the destination's namesake of the parent. Stubbed as a
//     `baked` flag: a restored layer carrying it renders in the wrong place.
//
// There is no ExtendScript runtime on a runner, so After Effects is stubbed
// down to what the ops use. The stub's copyToComp follows the measured rules in
// the extendscript-gotchas guide: copies land on top and then below the
// previous copy, the parent is dropped, and a parented or expression-linked
// layer is refused while an undo group is open.
//
//   node tests/unit/comp-checkpoint.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const SOURCES = ["core.jsx", "ids.jsx", "values.jsx", "comps.jsx", "layers.jsx", "snapshot.jsx", "footage.jsx", "checkpoint.jsx", "explore.jsx"];

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(plain(a), plain(b), msg); passed++; };
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const STUB = `
function CompItem() {}
function FolderItem() {}
function FootageItem() {}
function AVLayer() {}
function TextLayer() {}
function ShapeLayer() {}
function CameraLayer() {}
function LightLayer() {}

var NEXT_ID = 1000;
var ITEMS = [];
var UNDO = { open: 0, begun: 0 };
var FAIL_COPY = null;       // name of a layer whose copyToComp throws
var COPY_FORCES_ENABLED = false;
var COPY_DROPS_SHY = false;
var PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
var PropertyValueType = { OneD: 6417, LAYER_INDEX: 6421, MASK_INDEX: 6422 };

// A Layer Control effect: one LAYER_INDEX parameter that holds a layer.
function mkLayerPick(owner, ref) {
  var pick = { name: "Layer", propertyType: PropertyType.PROPERTY, propertyValueType: PropertyValueType.LAYER_INDEX,
    ref: ref, numKeys: 0 };
  pick.__defineGetter__("value", function () {
    if (!pick.ref) return 0;
    return pick.ref.comp === owner.comp && pick.ref.index > 0 ? pick.ref.index : 0;
  });
  pick.setValue = function (i) { pick.ref = i ? owner.comp.layer(i) : null; };
  pick.removeKey = function () {};
  var fx = { name: "Layer Control", propertyType: PropertyType.NAMED_GROUP, numProperties: 1,
    property: function () { return pick; } };
  return { name: "Effects", propertyType: PropertyType.INDEXED_GROUP, numProperties: 1,
    property: function () { return fx; }, pick: pick };
}

function nextId() { NEXT_ID += 1; return NEXT_ID; }
function removeItem(it) {
  for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i] === it) { ITEMS.splice(i, 1); return; }
}

function mkMarkers() {
  var m = { keys: [] };
  m.__defineGetter__("numKeys", function () { return m.keys.length; });
  m.keyTime = function (i) { return m.keys[i - 1].t; };
  m.keyValue = function (i) { return m.keys[i - 1].v; };
  m.removeKey = function (i) { m.keys.splice(i - 1, 1); };
  m.setValueAtTime = function (t, v) { m.keys.push({ t: t, v: v }); m.keys.sort(function (a, b) { return a.t - b.t; }); };
  return m;
}

function mkLayer(comp, name, opts) {
  var l = new AVLayer();
  l.id = nextId();
  l.name = name;
  l.comp = comp;
  l.enabled = true; l.locked = false; l.shy = false;
  l.inPoint = 0; l.outPoint = 5; l.startTime = 0;
  l.parent = null; l.expr = false; l.posKeys = 0;
  l.trackMatteLayer = null; l.trackMatteType = 0;
  l.source = null;
  if (opts) for (var k in opts) l[k] = opts[k];
  l.__defineGetter__("index", function () {
    for (var i = 0; i < l.comp._layers.length; i++) if (l.comp._layers[i] === l) return i + 1;
    return 0;
  });
  l.property = function (n) {
    if (n === "ADBE Effect Parade" || n === "Effects") return l.fx || null;
    if (n !== "Transform") return null;
    return { numProperties: 1, property: function () {
      return { name: "Position", numKeys: l.posKeys, canSetExpression: true, expression: l.expr ? "wiggle(1,1)" : "" };
    } };
  };
  l.copyToComp = function (target) {
    if (UNDO.open > 0 && (l.parent || l.expr)) {
      throw new Error("After Effects error: Can't copy a layer with a parent or with a linked expression, while an Undo Group is open.");
    }
    if (FAIL_COPY === l.name) throw new Error("After Effects refused to copy " + l.name);
    var cname = l.name;
    if (!l.sourceNamed) {
      for (var t = 0; t < target._layers.length; t++) {
        if (target._layers[t].name === cname) { cname = l.name + " 2"; break; }
      }
    }
    var c = mkLayer(target, cname, {
      enabled: COPY_FORCES_ENABLED ? true : l.enabled, locked: l.locked,
      inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime,
      expr: l.expr, posKeys: l.posKeys, trackMatteType: 0, source: l.source,
      shy: COPY_DROPS_SHY ? false : l.shy, copiedAtDuration: target.duration
    });
    // The pick still holds the SOURCE comp's layer, so in the destination it
    // resolves to nothing. Whether AE does this or resolves it to an old layer
    // by index is a live-AE measurement; either way the restored value is wrong.
    if (l.fx) c.fx = mkLayerPick(c, l.fx.pick.ref);
    if (l.parent) {
      c.baked = true;
      for (var pn = 0; pn < target._layers.length; pn++) {
        if (target._layers[pn].name === l.parent.name) { c.parent = target._layers[pn]; break; }
      }
    }
    // The first copy lands on top, each later one below the previous copy.
    var at = 0;
    if (target._lastCopy) {
      var prev = target._lastCopy.index;
      if (prev > 0) at = prev;
    }
    target._layers.splice(at, 0, c);
    target._lastCopy = c;
  };
  l.moveToBeginning = function () {
    if (l.locked) throw new Error("layer is locked");
    var arr = l.comp._layers;
    arr.splice(l.index - 1, 1);
    arr.unshift(l);
  };
  l.remove = function () {
    if (l.locked) throw new Error("layer is locked");
    var arr = l.comp._layers;
    arr.splice(l.index - 1, 1);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].parent === l) arr[i].parent = null;
      if (arr[i].trackMatteLayer === l) arr[i].trackMatteLayer = null;
    }
  };
  l.setParentWithJump = function (p) {
    // Measured on 26.5: the argument is required; unparenting is (null).
    if (arguments.length === 0) throw new Error("After Effects error: Function setParentWithJump requires 1 parameter.");
    if (l.locked) throw new Error("layer is locked");
    l.parent = p || null;
    l.jumped = true;
  };
  l.setTrackMatte = function (m, t) { l.trackMatteLayer = m; l.trackMatteType = t; };
  return l;
}

function mkFolder(name) {
  var f = new FolderItem();
  f.id = nextId(); f.name = name; f.parentFolder = null;
  f.__defineGetter__("numItems", function () {
    var n = 0;
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].parentFolder === f) n++;
    return n;
  });
  f.remove = function () { removeItem(f); };
  ITEMS.push(f);
  return f;
}

function mkComp(name) {
  var c = new CompItem();
  c.id = nextId(); c.name = name; c.comment = ""; c.parentFolder = null;
  c.width = 1920; c.height = 1080; c.pixelAspect = 1; c.frameRate = 30; c.duration = 10;
  c.displayStartTime = 0; c.workAreaStart = 0; c.workAreaDuration = 10; c.bgColor = [0, 0, 0];
  c.markerProperty = mkMarkers();
  c._layers = [];
  c.__defineGetter__("numLayers", function () { return c._layers.length; });
  c.layer = function (i) { return c._layers[i - 1]; };
  c.add = function (name, opts) { var l = mkLayer(c, name, opts); c._layers.push(l); return l; };
  c.remove = function () { removeItem(c); };
  // AE's Duplicate: new ids, parenting and mattes kept within the copy. The
  // item comment is carried across here; whether AE does is for the live pass.
  c.duplicate = function () {
    var d = mkComp(c.name + " 2");
    d.comment = c.comment;
    var fields = ["width", "height", "pixelAspect", "frameRate", "duration", "displayStartTime", "workAreaStart", "workAreaDuration"];
    for (var f = 0; f < fields.length; f++) d[fields[f]] = c[fields[f]];
    d.bgColor = c.bgColor.slice(0);
    for (var k = 0; k < c.markerProperty.keys.length; k++) d.markerProperty.keys.push(c.markerProperty.keys[k]);
    for (var i = 0; i < c._layers.length; i++) {
      var s = c._layers[i];
      d.add(s.name, { enabled: s.enabled, locked: s.locked, inPoint: s.inPoint, outPoint: s.outPoint, shy: s.shy,
        startTime: s.startTime, expr: s.expr, posKeys: s.posKeys, trackMatteType: s.trackMatteType, source: s.source });
    }
    for (var q = 0; q < c._layers.length; q++) {
      var sf = c._layers[q].fx;
      if (sf) d._layers[q].fx = mkLayerPick(d._layers[q], sf.pick.ref ? d._layers[sf.pick.ref.index - 1] : null);
    }
    for (var j = 0; j < c._layers.length; j++) {
      if (c._layers[j].parent) d._layers[j].parent = d._layers[c._layers[j].parent.index - 1];
      if (c._layers[j].trackMatteLayer) d._layers[j].trackMatteLayer = d._layers[c._layers[j].trackMatteLayer.index - 1];
    }
    return d;
  };
  ITEMS.push(c);
  return c;
}

var app = {
  beginUndoGroup: function () { UNDO.open += 1; UNDO.begun += 1; },
  endUndoGroup: function () { UNDO.open -= 1; },
  project: {
    item: function (i) { return ITEMS[i - 1]; },
    itemByID: function (id) {
      for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].id === id) return ITEMS[i];
      throw new Error("After Effects error: internal verification failure, sorry! {Item Not Found}");
    },
    rootFolder: { id: 0, name: "Root" },
    items: { addFolder: function (name) { return mkFolder(name); } }
  }
};
app.project.__defineGetter__("numItems", function () { return ITEMS.length; });

function find(id) { for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].id === id) return ITEMS[i]; return null; }
function names(c) { var o = []; for (var i = 1; i <= c.numLayers; i++) o.push(c.layer(i).name); return o; }
function ids(c) { var o = []; for (var i = 1; i <= c.numLayers; i++) o.push(c.layer(i).id); return o; }
function byName(c, n) { for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === n) return c.layer(i); return null; }
function cpLayer(n) { var cs = checkpoints(); return byName(cs[cs.length - 1], n); }
function cpTitle() { return cpLayer("Title"); }
function checkpoints() { var o = []; for (var i = 0; i < ITEMS.length; i++) if (__cpIsCheckpoint(ITEMS[i])) o.push(ITEMS[i]); return o; }
`;

// The scene every case starts from: a rig (null CTRL, Title parented to it with
// an expression, a locked BG, a matte pair), and a second comp that uses Main
// as a precomp — the usage a swap-style revert would have to re-link.
const SCENE = `
var main = mkComp("Main");
var ctrl = main.add("CTRL");
var title = main.add("Title", { expr: true, posKeys: 3 });
title.parent = ctrl;
var matte = main.add("Matte");
var fill = main.add("Fill");
fill.trackMatteLayer = matte; fill.trackMatteType = 2;
var bg = main.add("BG", { locked: true, enabled: false, shy: true });
var picker = main.add("Picker");
var solidNamed = main.add("Red Solid 1", { sourceNamed: true });
picker.fx = mkLayerPick(picker, matte);
main.markerProperty.setValueAtTime(1, { comment: "beat", duration: 0 });
var scene = mkComp("Scene");
var usage = scene.add("Main", { source: main });
`;

function load() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx, { filename: "stub.jsx" });
  for (const f of SOURCES) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext(SCENE, ctx, { filename: "scene.jsx" });
  const get = (expr) => vm.runInContext(expr, ctx);
  const dispatch = get("dispatch");
  const call = (op, args) => {
    const out = plain(dispatch(JSON.stringify({ op, args })));
    assert.equal(get("UNDO.open"), 0, `${op} left an undo group open across the call boundary`);
    return out;
  };
  return { ctx, get, run: (code) => vm.runInContext(code, ctx), call };
}

const mustOk = (r) => { assert.equal(r.ok, true, `expected ok, got: ${r.error}`); return r.result; };

// ---------- taking a checkpoint ----------
{
  const { get, call } = load();
  const mainId = get("main.id");
  const before = get("ids(main)");
  const r = mustOk(call("checkpoint_comp", { compId: mainId, label: "before easing" }));

  eq(r.compId, mainId, "the checkpoint names the comp it is of");
  eq(r.label, "before easing");
  eq(r.numLayers, 7);
  eq(r.folderName, "AE MCP Checkpoints", "filed in the one checkpoints folder");
  ok(/\[checkpoint before easing\]$/.test(r.name), "named so it reads as a checkpoint and never answers comp('Main')");
  ok(/NOT/.test(r.covers) && /nested precomps/.test(r.covers), "the result says what a checkpoint does not cover");
  eq(get("ids(main)"), before, "the comp itself is untouched");
  eq(get(`find(${r.checkpointId}).parentFolder.name`), "AE MCP Checkpoints");
  ok(get(`find(${r.checkpointId}).comment`).indexOf("ae-mcp-checkpoint:v1 ") === 0, "tagged through the comment");

  const r2 = mustOk(call("checkpoint_comp", { compId: mainId }));
  eq(r2.label, "#2", "an unlabelled checkpoint is numbered per comp");
  eq(r2.checkpointsForThisComp, 2);
  eq(get(`(function(){var n=0;for(var i=0;i<ITEMS.length;i++) if (ITEMS[i] instanceof FolderItem) n++; return n;})()`), 1,
    "a second checkpoint reuses the folder");

  const self = call("checkpoint_comp", { compId: r.checkpointId });
  eq(self.ok, false, "a checkpoint of a checkpoint is refused");
  ok(/is itself a checkpoint/.test(self.error));

  const list = mustOk(call("list_checkpoints", { compId: mainId }));
  eq(list.count, 2);
  eq(list.checkpoints.map((c) => c.label), ["before easing", "#2"]);
  eq(mustOk(call("list_checkpoints", { compId: get("scene.id") })).count, 0, "filtered by comp");
}

// ---------- the revert itself ----------
{
  const { get, run, call } = load();
  const mainId = get("main.id");
  const atCheckpoint = get("ids(main)");
  const cp = mustOk(call("checkpoint_comp", { compId: mainId }));

  // The changes an agent makes after a checkpoint.
  run(`
    title.name = "Title v2";
    bg.locked = false; bg.remove();
    main.add("Junk");
    main.duration = 4; main.workAreaDuration = 4; main.bgColor = [1, 0, 0];
    main.markerProperty.setValueAtTime(2, { comment: "extra", duration: 0 });
  `);
  const objBefore = get("main");
  const groupsBefore = get("UNDO.begun");

  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId }));

  eq(r.compId, mainId, "the comp keeps its id");
  ok(get(`find(${mainId})`) === objBefore, "…because it is the same item, restored in place");
  ok(get("usage.source === main"), "a precomp usage elsewhere still points at the comp, with nothing re-linked");
  eq(get("names(main)"), ["CTRL", "Title", "Matte", "Fill", "BG", "Picker", "Red Solid 1"], "layers back, in the checkpoint's order");
  eq(r.layersRestored, 7);
  eq(r.layersRemoved, 7, "the seven layers it held are gone, the stray one included");
  eq(get("byName(main, 'Junk')"), null);

  eq(get("byName(main, 'Title').parent === byName(main, 'CTRL')"), true, "parenting re-applied to the restored layers");
  eq(get("byName(main, 'Title').jumped"), true, "with setParentWithJump, so the parent-relative values are not compensated");
  eq(get("byName(main, 'Title').baked"), undefined,
    "the checkpoint layer was copied with its parent detached, so AE had nothing to bake into comp space");
  eq(get("cpTitle().parent === cpLayer('CTRL')"), true, "and the checkpoint's own parenting was put back");
  eq(get("byName(main, 'CTRL 2')"), null, "copyToComp's ' 2' collision rename is undone");
  eq(get("byName(main, 'Fill').trackMatteLayer === byName(main, 'Matte')"), true, "track matte re-pointed at the restored matte");
  eq(get("byName(main, 'Fill').trackMatteType"), 2);
  eq(get("byName(main, 'BG').locked"), true, "the lock comes back");
  eq(get("byName(main, 'BG').enabled"), false);
  eq(get("main.duration"), 10, "comp settings restored");
  eq(get("main.workAreaDuration"), 10);
  eq(get("main.bgColor"), [0, 0, 0]);
  eq(get("main.markerProperty.numKeys"), 1, "comp markers restored");
  eq(get("byName(main, 'Picker').fx.pick.ref === byName(main, 'Matte')"), true,
    "the Layer Control pick points at the restored Matte, not the removed old one");
  eq(r.layerReferencesRepointed, 1, "and the re-point is counted");
  eq(get("byName(main, 'BG').shy"), true);
  eq(get("byName(main, 'CTRL').copiedAtDuration"), 10, "comp settings were restored before the layers were copied in");
  ok(/keyframe values/.test(r.checked), "the result says what verified did not compare");

  eq(Object.keys(r.layerIdMap).map(Number), atCheckpoint, "the id map is keyed by the ids the comp had at the checkpoint");
  eq(Object.values(r.layerIdMap), get("ids(main)"), "…and maps them to the layers now in the comp");
  ok(atCheckpoint.every((id) => !get("ids(main)").includes(id)), "every old layer id really is gone");
  ok(/keeps its id/.test(r.note) && /layerIdMap/.test(r.note), "the note says the comp id holds and the layer ids do not");

  eq(r.verified, true, "the restore checks out against the checkpoint");
  eq(r.mismatches, undefined);
  eq(r.undoSplits, 1, "Title (parented, with an expression) had to be copied with the group closed");
  ok(get("UNDO.begun") - groupsBefore >= 2, "and that split really did reopen a group");
  ok(/Do not try to Cmd-Z/.test(r.note));
  eq(get(`find(${cp.checkpointId}) !== null`), true, "the checkpoint is kept by default");

  // Reverting twice is safe — the checkpoint is unchanged by a revert.
  const again = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, compId: mainId }));
  eq(again.verified, true, "a second revert to the same checkpoint is clean too");
  eq(get("names(main)"), ["CTRL", "Title", "Matte", "Fill", "BG", "Picker", "Red Solid 1"]);
}

// ---------- the name is not reverted, and says so ----------
{
  const { get, run, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id") }));
  run(`main.name = "Main renamed";`);
  const before = get("ids(main)");
  const refused = call("revert_comp", { checkpointId: cp.checkpointId });
  eq(refused.ok, false, "a comp whose name no longer matches the record is not reverted on the id alone");
  ok(/pass compId: \d+ to confirm/.test(refused.error) && /another project/.test(refused.error));
  eq(get("ids(main)"), before, "…and nothing changed");
  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, compId: get("main.id") }));
  eq(r.name, "Main renamed", "comp('Name') lookups elsewhere would break if a revert renamed the comp");
  eq(r.nameAtCheckpoint, "Main");
  ok(/set_comp renames it/.test(r.note));
}

// ---------- copy-first: a layer that will not copy leaves the comp as it was ----------
{
  const { get, run, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id") }));
  run(`main.add("Junk"); main.duration = 4; main.workAreaDuration = 4;`);
  const before = get("ids(main)");
  run(`FAIL_COPY = "Fill";`);
  const r = call("revert_comp", { checkpointId: cp.checkpointId });
  eq(r.ok, false, "a failed copy is an error, not a partial success");
  ok(/layer 4 \("Fill"\)/.test(r.error), "naming the layer that failed");
  ok(/as it was before the call/.test(r.error), "and saying the comp is untouched");
  eq(get("ids(main)"), before, "…which it is: the copies made before the failure were removed");
  eq(get("main.duration"), 4, "and the comp settings written before the copies were put back");
  eq(get(`find(${cp.checkpointId}) !== null`), true, "the checkpoint survives");
}

// ---------- verification: a restore that does not match is reported ----------
{
  const { get, run, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id") }));
  run(`COPY_FORCES_ENABLED = true;`);
  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, keepCheckpoint: false }));
  eq(r.verified, false, "BG came back enabled, so the revert is not clean");
  ok(r.mismatches.some((m) => m.name === "BG" && m.changes.enabled), "and the mismatch names the layer and the field");
  ok(/^NOT a clean revert/.test(r.note), "said first, not buried");
  eq(r.checkpointDeleted, false, "keepCheckpoint:false is not honoured on a revert that did not verify");
  eq(get(`find(${cp.checkpointId}) !== null`), true);
}

// ---------- verification covers switches the fingerprint does not ----------
{
  const { get, run, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id") }));
  run(`COPY_DROPS_SHY = true;`);
  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId }));
  eq(r.verified, false, "a dropped shy switch is caught");
  ok(r.mismatches.some((m) => m.name === "BG" && m.changes.shy), "and named");
}

// ---------- checkpoints are flagged in the orienting reads ----------
{
  const { get, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id") }));
  const comps = mustOk(call("list_comps", { include: [] }));
  eq(comps.find((c) => c.id === cp.checkpointId).checkpoint, true, "list_comps flags a checkpoint");
  eq(comps.find((c) => c.id === get("main.id")).checkpoint, undefined, "and nothing else");
  const sum = mustOk(call("get_project_summary", {}));
  eq(sum.items.find((i) => i.id === cp.checkpointId).checkpoint, true, "so does get_project_summary");
}

// ---------- keepCheckpoint:false on a clean revert ----------
{
  const { get, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id") }));
  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, keepCheckpoint: false }));
  eq(r.checkpointDeleted, true);
  eq(get(`find(${cp.checkpointId})`), null);
}

// ---------- saveCurrent: the revert is itself reversible ----------
{
  const { get, run, call } = load();
  const cp = mustOk(call("checkpoint_comp", { compId: get("main.id"), label: "clean" }));
  run(`main.add("Work in progress");`);
  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, saveCurrent: true }));
  ok(r.savedCheckpoint && r.savedCheckpoint.checkpointId, "the current state was checkpointed first");
  eq(r.savedCheckpoint.label, "before revert to clean");
  eq(r.savedCheckpoint.numLayers, 8, "…holding the layer the revert removed");
  const back = mustOk(call("revert_comp", { checkpointId: r.savedCheckpoint.checkpointId }));
  eq(back.verified, true);
  ok(get("names(main)").includes("Work in progress"), "and reverting to it brings the work back");
}

// ---------- wrong comp, missing comp, not a checkpoint ----------
{
  const { get, run, call } = load();
  const mainId = get("main.id");
  const cp = mustOk(call("checkpoint_comp", { compId: mainId }));
  const before = get("ids(main)");

  const wrong = call("revert_comp", { checkpointId: cp.checkpointId, compId: get("scene.id") });
  eq(wrong.ok, false, "a compId that does not match the checkpoint is refused");
  ok(/only reverts the comp it was taken of/.test(wrong.error) && /Nothing was changed/.test(wrong.error));
  eq(get("ids(main)"), before);

  const notCp = call("revert_comp", { checkpointId: mainId });
  eq(notCp.ok, false, "passing the comp's own id is caught");
  ok(/is not a checkpoint/.test(notCp.error) && /not the id of the comp/.test(notCp.error));

  run(`main.remove();`);
  const gone = call("revert_comp", { checkpointId: cp.checkpointId });
  eq(gone.ok, false, "a checkpoint whose comp was deleted has nothing to revert into");
  ok(/no longer exists/.test(gone.error) && /duplicate_comp the checkpoint/.test(gone.error));
  const list = mustOk(call("list_checkpoints", {}));
  eq(list.checkpoints[0].originMissing, true, "and list_checkpoints flags it");

  const dup = mustOk(call("duplicate_comp", { compId: cp.checkpointId, name: "Main recovered" }));
  eq(dup.fromCheckpoint, true, "duplicate_comp of a checkpoint recovers it as an ordinary comp");
  eq(get(`find(${dup.id}).comment`), "", "…with the tag cleared");
  eq(get(`find(${dup.id}).parentFolder === app.project.rootFolder`), true, "…and out of the checkpoints folder");
  eq(mustOk(call("list_checkpoints", {})).count, 1, "so it does not turn up as a second checkpoint");
}

// ---------- a checkpoint imported with its project ----------
// Importing an .aep renumbers every item, so the record names an id that is
// gone (or belongs to something else). Simulated by rewriting the record.
{
  const { get, run, call } = load();
  const mainId = get("main.id");
  const cp = mustOk(call("checkpoint_comp", { compId: mainId }));
  run(`(function () {
    var c = find(${cp.checkpointId});
    var m = __cpMeta(c); m.compId = 99999;
    c.comment = "ae-mcp-checkpoint:v1 " + JSON.stringify(m);
  })(); main.add("Junk");`);

  const list = mustOk(call("list_checkpoints", {}));
  eq(list.checkpoints[0].originMissing, true, "a recorded id that throws in itemByID is reported, not an internal error");
  const bare = call("revert_comp", { checkpointId: cp.checkpointId });
  eq(bare.ok, false);
  ok(/no longer exists/.test(bare.error) && !/verification failure/.test(bare.error), "the bare revert gives the real reason");

  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, compId: mainId }));
  eq(r.verified, true, "an explicit compId of the same comp under its new id reverts it");
  eq(r.checkpointRebound, true);
  eq(get("byName(main, 'Junk')"), null);
  eq(mustOk(call("list_checkpoints", { compId: mainId })).count, 1, "the checkpoint now belongs to the comp's new id");
  eq(mustOk(call("revert_comp", { checkpointId: cp.checkpointId })).verified, true, "and later reverts need no compId");
}

// ---------- two comps called "Main": a name match is not enough ----------
{
  const { get, run, call } = load();
  const mainId = get("main.id");
  run(`var main2 = mkComp("Main"); main2.add("Other work");`);
  const otherId = get("main2.id");
  const cp = mustOk(call("checkpoint_comp", { compId: mainId }));
  const before = get("ids(main2)");

  const r = call("revert_comp", { checkpointId: cp.checkpointId, compId: otherId });
  eq(r.ok, false, "a namesake is refused while the recorded comp still exists under its name");
  ok(/still exists/.test(r.error) && /only shares its name/.test(r.error) && /Nothing was changed/.test(r.error));
  eq(get("ids(main2)"), before, "the other Main is untouched");
  eq(get(`__cpMeta(find(${cp.checkpointId})).compId`), mainId, "and the checkpoint is not re-tied to it");

  // Once the recorded comp is gone, the namesake is the imported-copy case and is accepted.
  run(`main.remove();`);
  const ok2 = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, compId: otherId }));
  eq(ok2.checkpointRebound, true);
  eq(get("names(main2)"), ["CTRL", "Title", "Matte", "Fill", "BG", "Picker", "Red Solid 1"]);
}

// ---------- a revert that did not verify does not re-tie the checkpoint ----------
{
  const { get, run, call } = load();
  const mainId = get("main.id");
  const cp = mustOk(call("checkpoint_comp", { compId: mainId }));
  run(`(function () {
    var c = find(${cp.checkpointId});
    var m = __cpMeta(c); m.compId = 99999;
    c.comment = "ae-mcp-checkpoint:v1 " + JSON.stringify(m);
  })(); COPY_FORCES_ENABLED = true;`);
  const r = mustOk(call("revert_comp", { checkpointId: cp.checkpointId, compId: mainId }));
  eq(r.verified, false);
  eq(r.checkpointRebound, false, "not re-tied after a revert that did not verify");
  eq(get(`__cpMeta(find(${cp.checkpointId})).compId`), 99999, "the record is unchanged");
  ok(/only after a clean revert/.test(r.note));
}

// ---------- deleting ----------
{
  const { get, call } = load();
  const mainId = get("main.id");
  const a = mustOk(call("checkpoint_comp", { compId: mainId }));
  const b = mustOk(call("checkpoint_comp", { compId: mainId }));

  const bad = call("delete_checkpoints", { checkpointIds: [a.checkpointId, get("scene.id")] });
  eq(bad.ok, false, "a regular comp in the list is refused");
  ok(/is not a checkpoint/.test(bad.error) && /Nothing was deleted/.test(bad.error));
  eq(get("checkpoints().length"), 2, "…before anything was removed");

  const one = mustOk(call("delete_checkpoints", { checkpointIds: [a.checkpointId] }));
  eq(one.count, 1);
  eq(one.folderRemoved, false, "the folder stays while a checkpoint is in it");

  const all = mustOk(call("delete_checkpoints", { compId: mainId }));
  eq(all.removed.map((x) => x.id), [b.checkpointId]);
  eq(all.folderRemoved, true, "the empty checkpoints folder is cleaned up");
  eq(get("checkpoints().length"), 0);
  eq(get(`find(${mainId}) !== null`), true, "the comp itself is never touched");
}

// ---------- the schema half: delete_checkpoints takes exactly one selector ----------
{
  const shared = await import(path.join(root, "packages", "shared", "dist", "schemas.js"));
  const S = shared.OpSchemas.delete_checkpoints;
  eq(S.safeParse({ checkpointIds: [1] }).success, true);
  eq(S.safeParse({ compId: 1 }).success, true);
  eq(S.safeParse({}).success, false, "neither is refused");
  eq(S.safeParse({ checkpointIds: [1], compId: 1 }).success, false, "both is refused");
  eq(S.safeParse({ checkpointIds: [] }).success, false, "an empty list would delete nothing and say so as success");
  for (const op of ["checkpoint_comp", "list_checkpoints", "revert_comp", "delete_checkpoints"]) {
    ok(op in shared.OpMutation, `${op} is classified`);
  }
  eq(shared.OpMutation.list_checkpoints, "read");
  eq(shared.OpMutation.revert_comp, "write");
}

console.log(`comp-checkpoint: ${passed} assertions passed`);
