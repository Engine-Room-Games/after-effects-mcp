// get_selection, out of packages/jsx/selection.jsx (issue #179).
//
// The AI could not see what the user had selected, so "animate this layer"
// needed the user to name it. What this locks in:
//   - The op exists, is classified as a read, and its schema takes no args.
//   - It reads the ACTIVE comp: selected layers by id, the playhead time and
//     frame, and selected properties as a propertyPath that walkProperty
//     resolves back to the same property — names where they are unambiguous,
//     a sibling index where an earlier sibling has the same name.
//   - Selected keyframes ride along as times.
//   - The comp is the VIEWER's (app.activeViewer), not activeItem, which
//     follows the Project panel when it has focus; activeItem is the
//     fallback and says so. No comp answers comp:null with a reason that
//     says what is known, never a guessed comp and never an error.
//   - Past a cap, what was left out is counted.
//
//   node tests/unit/get-selection.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`get-selection FAILED: ${name}`);
    throw e;
  }
  passed++;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// A mock AE property tree, in the VM realm so instanceof works there.
// ---------------------------------------------------------------------------

function load(setup) {
  const ctx = { OPS: {}, noUndo: (fn) => fn, Math, Error, String };
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FootageItem() {}
    var PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6214, NAMED_GROUP: 6213 };
    function __cpIsCheckpoint(c) { return !!c.__checkpoint; }

    // node(name, matchName, kids, opts): kids are attached with parent links
    // so propertyGroup(n) and propertyDepth behave as AE's do.
    function node(name, matchName, kids, opts) {
      opts = opts || {};
      var n = {
        name: name, matchName: matchName,
        propertyType: kids ? PropertyType.NAMED_GROUP : PropertyType.PROPERTY,
        kids: kids || [], parent: null, propertyIndex: 0,
        selectedKeys: opts.selectedKeys || [],
        keyTime: function (i) { return opts.keyTimes[i - 1]; },
        property: function (k) {
          if (typeof k === "number") return this.kids[k - 1] || null;
          for (var i = 0; i < this.kids.length; i++)
            if (this.kids[i].name === k || this.kids[i].matchName === k) return this.kids[i];
          return null;
        },
        propertyGroup: function (up) {
          var cur = this;
          for (var i = 0; i < up; i++) cur = cur.parent;
          return cur;
        }
      };
      for (var i = 0; i < n.kids.length; i++) { n.kids[i].parent = n; n.kids[i].propertyIndex = i + 1; }
      return n;
    }
    function finishLayer(layer) {
      // propertyDepth: distance to the layer.
      function walk(n, d) { n.propertyDepth = d; for (var i = 0; i < n.kids.length; i++) walk(n.kids[i], d + 1); }
      for (var i = 0; i < layer.kids.length; i++) walk(layer.kids[i], 1);
      return layer;
    }
    var ViewerType = { VIEWER_COMPOSITION: 1, VIEWER_LAYER: 2, VIEWER_FOOTAGE: 3 };
    // A viewer showing a comp. setActive() focuses it, which is when
    // activeItem starts answering for it — as AE's does.
    function mkViewer(type, item, refuses) {
      return {
        type: type,
        setActive: function () { if (refuses) return false; app.project.activeItem = item; return true; }
      };
    }
    var app = { project: { activeItem: null, selection: [] }, activeViewer: null };
    `,
    ctx,
  );
  // The real resolver, so the round-trip below tests what every tool uses.
  vm.runInContext(read("ids.jsx"), ctx, { filename: "ids.jsx" });
  vm.runInContext(read("selection.jsx"), ctx, { filename: "selection.jsx" });
  vm.runInContext(setup, ctx);
  return ctx;
}

const SCENE = `
  var position = node("Position", "ADBE Position", null, { selectedKeys: [1, 3], keyTimes: [0, 0.5, 1.25] });
  var xform = node("Transform", "ADBE Transform Group", [node("Anchor Point", "ADBE Anchor Point"), position]);
  var fill2 = node("Opacity", "ADBE Vector Fill Opacity");
  var g1 = node("Group 1", "ADBE Vector Group", [node("Opacity", "ADBE Vector Fill Opacity")]);
  var g1b = node("Group 1", "ADBE Vector Group", [fill2]);
  var contents = node("Contents", "ADBE Root Vectors Group", [g1, g1b]);
  var shape = finishLayer(node("Card", "ADBE Vector Layer", [contents, xform]));
  shape.id = 42; shape.index = 1;
  var other = finishLayer(node("Title", "ADBE Text Layer", []));
  other.id = 7; other.index = 2;
  var comp = new CompItem();
  comp.id = 100; comp.name = "Main"; comp.frameRate = 24; comp.time = 1.5;
  comp.selectedLayers = [shape, other];
  comp.selectedProperties = [xform, position, fill2];
  app.project.activeItem = comp;
  app.activeViewer = mkViewer(ViewerType.VIEWER_COMPOSITION, comp);
`;

const shared = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);
check("get_selection is in OpSchemas, takes no args, and is a read", () => {
  assert.ok(shared.OpSchemas.get_selection, "get_selection missing from OpSchemas");
  assert.equal(shared.OpMutation.get_selection, "read");
  assert.equal(shared.OpSchemas.get_selection.safeParse({}).success, true);
  assert.equal(shared.OpSchemas.get_selection.safeParse({ compId: 1 }).success, false, "unknown keys must be refused");
});
const { descriptions } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "descriptions.js")).href
);
check("the description says what it reads and what it does with no comp", () => {
  assert.match(descriptions.get_selection, /selected/);
  assert.match(descriptions.get_selection, /comp:null/);
});

check("reads the active comp's layers, time and properties", () => {
  const ctx = load(SCENE);
  const r = plain(ctx.OPS.get_selection({}));
  assert.deepEqual(r.comp, { id: 100, name: "Main" });
  assert.equal(r.time, 1.5);
  assert.equal(r.frame, 36);
  assert.deepEqual(r.selectedLayers, [
    { id: 42, index: 1, name: "Card" },
    { id: 7, index: 2, name: "Title" },
  ]);
  assert.equal(r.selectedProperties.length, 3);
  const [grp, pos] = r.selectedProperties;
  assert.deepEqual(grp, {
    layerId: 42, layerName: "Card", propertyPath: ["Transform"],
    name: "Transform", matchName: "ADBE Transform Group", kind: "group",
  });
  assert.deepEqual(pos.propertyPath, ["Transform", "Position"]);
  assert.equal(pos.kind, "property");
  assert.deepEqual(pos.selectedKeyTimes, [0, 1.25], "selected keys come back as times");
  assert.equal(r.omitted, undefined);
});

check("every propertyPath resolves back to the selected property, even past a duplicate name", () => {
  const ctx = load(SCENE);
  const r = ctx.OPS.get_selection({});
  const third = r.selectedProperties[2];
  assert.deepEqual(plain(third.propertyPath), ["Contents", 2, "Opacity"],
    "the second 'Group 1' must be addressed by index, or the path lands on the first");
  const props = ctx.comp.selectedProperties;
  for (let i = 0; i < props.length; i++) {
    const hit = ctx.walkProperty(ctx.shape, r.selectedProperties[i].propertyPath);
    assert.ok(hit === props[i], `path ${JSON.stringify(r.selectedProperties[i].propertyPath)} resolved elsewhere`);
  }
});

check("no active comp answers comp:null with a reason", () => {
  const ctx = load("app.project.activeItem = null;");
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp, null);
  assert.deepEqual(r.selectedLayers, []);
  assert.match(r.reason, /Could not determine the comp in the viewer \(no viewer is open\)/);
});

// A spy on setActive: focus is the user's, so it is touched only when
// activeItem cannot answer.
const SPY = `
  var setActiveCalls = 0;
  function spyViewer(item, refuses) {
    var v = mkViewer(ViewerType.VIEWER_COMPOSITION, item, refuses);
    var inner = v.setActive;
    v.setActive = function () { setActiveCalls++; return inner(); };
    return v;
  }
`;

check("activeItem is a comp: it is used as is and focus is never touched", () => {
  const ctx = load(SCENE + SPY + `
    var other = new CompItem(); other.id = 200; other.name = "Lower third";
    app.project.activeItem = other;
    app.activeViewer = spyViewer(comp);
  `);
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp.id, 200);
  assert.equal(r.source, "activeItem");
  assert.equal(ctx.setActiveCalls, 0, "setActive must not be called when activeItem is already a comp");
  assert.equal(r.note, undefined);
});

check("activeItem not a comp: the viewer is asked, and the answer says so", () => {
  const ctx = load(SCENE + SPY + `
    var f = new FootageItem(); f.id = 5; f.name = "clip.mov";
    app.project.activeItem = f;
    app.activeViewer = spyViewer(comp);
  `);
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp.id, 100);
  assert.equal(r.source, "viewer");
  assert.equal(ctx.setActiveCalls, 1);
  assert.match(r.note, /clip\.mov/);
  assert.match(r.note, /composition viewer/);
});

check("activeItem empty: the viewer is asked", () => {
  const ctx = load(SCENE + SPY + "app.project.activeItem = null; app.activeViewer = spyViewer(comp);");
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp.id, 100);
  assert.equal(r.source, "viewer");
  assert.match(r.note, /was empty/);
});

check("a viewer that refuses focus is not read as the viewer's comp", () => {
  const ctx = load(SCENE + SPY + "app.project.activeItem = null; app.activeViewer = spyViewer(comp, true);");
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp, null);
  assert.match(r.reason, /could not be read/);
});


check("Project panel focused with items selected: the reason says so, never 'nothing open'", () => {
  const ctx = load("app.project.activeItem = null; app.project.selection = [{}, {}];");
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp, null);
  assert.match(r.reason, /Project panel has focus with 2 items selected/);
  assert.doesNotMatch(r.reason, /nothing is open/i);
});

check("frame counts from the comp's start frame, time stays on the keyframe clock", () => {
  const ctx = load(SCENE + "comp.displayStartFrame = 1001;");
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.time, 1.5);
  assert.equal(r.frame, 1037);
});

check("footage active is not a comp, and says so by name", () => {
  const ctx = load('var f = new FootageItem(); f.id = 5; f.name = "clip.mov"; app.project.activeItem = f; app.activeViewer = mkViewer(ViewerType.VIEWER_FOOTAGE, f);');
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.comp, null);
  assert.match(r.reason, /clip\.mov/);
  assert.match(r.reason, /layer or footage viewer/);
});

check("an empty selection is an empty answer, not an error", () => {
  const ctx = load(SCENE + "comp.selectedLayers = []; comp.selectedProperties = [];");
  const r = plain(ctx.OPS.get_selection({}));
  assert.deepEqual(r.selectedLayers, []);
  assert.deepEqual(r.selectedProperties, []);
  assert.equal(r.time, 1.5);
});

check("a selection past the cap counts what it left out", () => {
  const ctx = load(SCENE + `
    var many = [];
    for (var i = 0; i < 250; i++) many.push(shape);
    comp.selectedLayers = many;
  `);
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.selectedLayers.length, 200);
  assert.equal(r.omitted.selectedLayers, 50);
  assert.match(r.note, /omitted/);
});

check("a checkpoint comp is flagged", () => {
  const ctx = load(SCENE + "comp.__checkpoint = true;");
  const r = plain(ctx.OPS.get_selection({}));
  assert.equal(r.checkpoint, true);
  assert.match(r.warning, /checkpoint/);
});

console.log(`get-selection: ${passed} checks passed`);
