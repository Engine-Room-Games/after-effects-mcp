// The riskiest in-AE ops that no test executed, run against a fake After
// Effects (issue #167).
//
// set_layer, set_interpolation, get_keyframes, the mask ops and the marker ops
// are some of the most-called tools there are, and until this file nothing ran
// them: a regression in any of them reached the user's project first. Each is
// driven here through the real `dispatch()` from core.jsx — undo group, error
// envelope and all — against tests/unit/lib/fake-ae.mjs, which refuses what
// After Effects refuses (a key index out of range, setValue on a keyed
// property, an interpolation type that is not one).
//
// get_layer_full — "the whole reason this MCP exists" — gets a golden test:
// one representative layer, every section, compared byte-for-byte with
// tests/unit/golden/get-layer-full.json. A change to its output shape has to
// change that file too, in the same diff, where a reviewer can see it.
// Regenerate deliberately with:
//
//   UPDATE_GOLDEN=1 node tests/unit/fake-ae-ops.mjs
//
// What this cannot prove: that After Effects behaves like the fake. The fake
// is written from the scripting reference and the measured traps in
// docs/fragile-areas-ae.md; the live recipes remain the word on AE itself.
//
//   node tests/unit/fake-ae-ops.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFakeAe } from "./lib/fake-ae.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenFile = path.join(here, "golden", "get-layer-full.json");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`fake-ae-ops FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const FILES = ["ids.jsx", "values.jsx", "comps.jsx", "layers.jsx", "keyframes.jsx", "effects.jsx", "masks.jsx", "markers.jsx", "explore.jsx"];

/** A fresh fake with comp 100 holding layers CTRL (null, id 1) and Card (id 2). */
function scene() {
  const ae = loadFakeAe(FILES);
  ae.run(`
    var C = FAKE.comp(100, "Main");
    var CTRL = C.addLayer(1, "CTRL", "null");
    var CARD = C.addLayer(2, "Card", "av");
  `);
  return ae;
}

function ok(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${res.error}`);
  return res.result;
}
function refused(res, pattern, what) {
  assert.equal(res.ok, false, `${what} should have been refused, answered ${JSON.stringify(res.result)}`);
  assert.match(res.error, pattern);
}

const POS = ["Transform", "Position"];
const OPACITY = ["Transform", "Opacity"];

// ---------------------------------------------------------------------------
// set_layer
// ---------------------------------------------------------------------------

check("set_layer writes every switch and timing field it is given", () => {
  const ae = scene();
  ae.run(`var MATTE = C.addLayer(3, "Matte", "av");`);
  const res = ok(
    ae.call("set_layer", {
      compId: 100, layerId: 2,
      name: "Card v2", enabled: false, locked: true, shy: true, solo: true, threeDLayer: true,
      label: 9, inPoint: 1, outPoint: 4, startTime: 0.5, stretch: 50, preserveTransparency: true,
      blendingMode: "MULTIPLY", trackMatte: { type: "ALPHA", layerId: 3 },
    }),
    "set_layer"
  );
  const l = ae.json(`(function(l){ return { name: l.name, enabled: l.enabled, locked: l.locked, shy: l.shy, solo: l.solo,
    threeDLayer: l.threeDLayer, label: l.label, inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime,
    stretch: l.stretch, preserveTransparency: l.preserveTransparency, blendingMode: l.blendingMode,
    trackMatteType: l.trackMatteType, trackMatteLayer: l.trackMatteLayer && l.trackMatteLayer.id }; })(CARD)`);
  assert.deepEqual(l, {
    name: "Card v2", enabled: false, locked: true, shy: true, solo: true, threeDLayer: true,
    label: 9, inPoint: 1, outPoint: 4, startTime: 0.5, stretch: 50, preserveTransparency: true,
    blendingMode: 5216, trackMatteType: 5013, trackMatteLayer: 3,
  });
  // It answers with the layer as it now is, by id.
  assert.equal(res.id, 2);
  assert.equal(res.name, "Card v2");
});

check("set_layer refuses a matte type with no matte layer to apply it to, and changes nothing", () => {
  const ae = scene();
  refused(
    ae.call("set_layer", { compId: 100, layerId: 2, name: "renamed", trackMatte: { type: "ALPHA" } }),
    /trackMatte\.layerId/,
    "set_layer"
  );
  assert.deepEqual(ae.json(`[CARD.name, CARD.trackMatteType, CARD.trackMatteLayer]`), ["Card", 5012, null]);
});

check("set_layer leaves every field it was not given alone", () => {
  const ae = scene();
  const before = ae.json(`(function(l){ var o = {}; for (var k in l) if (typeof l[k] !== "function" && typeof l[k] !== "object") o[k] = l[k]; return o; })(CARD)`);
  ok(ae.call("set_layer", { compId: 100, layerId: 2, label: 4 }), "set_layer");
  const after = ae.json(`(function(l){ var o = {}; for (var k in l) if (typeof l[k] !== "function" && typeof l[k] !== "object") o[k] = l[k]; return o; })(CARD)`);
  assert.deepEqual(after, { ...before, label: 4 });
  // And the other layer is not touched at all.
  assert.equal(ae.json(`CTRL.label`), 1);
});

check("set_layer on a layer id that is not in the comp is an error, not a success", () => {
  const ae = scene();
  refused(ae.call("set_layer", { compId: 100, layerId: 99, name: "x" }), /No layer with id 99/, "set_layer");
  refused(ae.call("set_layer", { compId: 7, layerId: 2, name: "x" }), /No comp with id 7/, "set_layer");
});

check("a write op runs inside exactly one undo group of its own name", () => {
  const ae = scene();
  ok(ae.call("set_layer", { compId: 100, layerId: 2, label: 4 }), "set_layer");
  assert.deepEqual(ae.json(`app.undoGroups`), ["AE MCP: set_layer"]);
  assert.equal(ae.json(`app._open`), 0, "the group was closed");
  ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "get_keyframes");
  assert.deepEqual(ae.json(`app.undoGroups`), ["AE MCP: set_layer"], "a read opens no undo group");
});

// ---------------------------------------------------------------------------
// get_keyframes and set_interpolation
// ---------------------------------------------------------------------------

/** Card's Position keyed at 0, 1, 2 (added out of order) and Opacity at 0, 2. */
function keyed() {
  const ae = scene();
  for (const [t, v] of [[2, [300, 300]], [0, [100, 100]], [1, [200, 150]]]) {
    ok(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: POS, time: t, value: v }), "add_keyframe");
  }
  ok(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: OPACITY, time: 0, value: 0 }), "add_keyframe");
  ok(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: OPACITY, time: 2, value: 100 }), "add_keyframe");
  return ae;
}

const interpOf = (keys) => keys.map((k) => `${k.interpolation.in}/${k.interpolation.out}`);

check("get_keyframes reads every key in time order with value, interpolation and ease", () => {
  const ae = keyed();
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "get_keyframes");
  assert.deepEqual(keys.map((k) => k.index), [1, 2, 3]);
  assert.deepEqual(keys.map((k) => k.time), [0, 1, 2]);
  assert.deepEqual(keys.map((k) => k.value), [[100, 100], [200, 150], [300, 300]]);
  assert.deepEqual(interpOf(keys), ["linear/linear", "linear/linear", "linear/linear"]);
  assert.deepEqual(keys[0].ease, { easeIn: { influence: 16.666667, speed: 0 }, easeOut: { influence: 16.666667, speed: 0 } });
  // Position is spatial: tangents are read.
  assert.deepEqual(keys[0].tangents, { inTangent: [0, 0], outTangent: [0, 0] });
});

check("get_keyframes reports no tangents on a property that is not spatial", () => {
  const ae = keyed();
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: OPACITY }), "get_keyframes");
  assert.deepEqual(keys.map((k) => [k.time, k.value, k.tangents]), [[0, 0, null], [2, 100, null]]);
});

check("get_keyframes on a property with no keys is an empty list", () => {
  const ae = scene();
  assert.deepEqual(ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Transform", "Rotation"] }), "get_keyframes"), []);
});

check("get_keyframes on a path that does not exist names the segment", () => {
  const ae = scene();
  refused(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Transform", "Wobble"] }), /\[1\]=Wobble/, "get_keyframes");
});

check("set_interpolation sets in and out on the one key it names, and not the other way round", () => {
  const ae = keyed();
  ok(ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: POS, keyIndex: 2, in: "hold", out: "bezier" }), "set_interpolation");
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "get_keyframes");
  // in and out differ on purpose: a swap anywhere between the schema and
  // setInterpolationTypeAtKey reads back as bezier/hold.
  assert.deepEqual(interpOf(keys), ["linear/linear", "hold/bezier", "linear/linear"]);
  // The value and time of the key are untouched.
  assert.deepEqual([keys[1].time, keys[1].value], [1, [200, 150]]);
});

check("set_interpolation with one side keeps the other side's type", () => {
  const ae = keyed();
  ok(ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: POS, keyIndex: 1, out: "bezier" }), "out only");
  ok(ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: POS, keyIndex: 1, in: "hold" }), "in only");
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "get_keyframes");
  assert.deepEqual(interpOf(keys)[0], "hold/bezier");
});

check("set_interpolation on a key that does not exist is an error", () => {
  const ae = keyed();
  refused(
    ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: OPACITY, keyIndex: 3, in: "hold" }),
    /no key 3 .*it has 2 keyframes.*Nothing was changed/,
    "set_interpolation"
  );
});

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

const SQUARE = [[0, 0], [100, 0], [100, 100], [0, 100]];
const maskState = (ae, i) =>
  ae.json(`(function(m){ return { name: m.name, mode: m.maskMode, inverted: m.inverted,
    path: m.property("ADBE Mask Shape").value, feather: m.property("ADBE Mask Feather").value,
    opacity: m.property("ADBE Mask Opacity").value, expansion: m.property("ADBE Mask Offset").value }; })(CARD.property("Masks").property(${i}))`);

check("add_mask builds the path it was given, closed by default, in the mode asked for", () => {
  const ae = scene();
  const r = ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE, mode: "SUBTRACT" }), "add_mask");
  assert.deepEqual(r, { ok: true, maskIndex: 1 });
  const m = maskState(ae, 1);
  assert.deepEqual(m.path.vertices, SQUARE);
  assert.equal(m.path.closed, true);
  assert.equal(m.mode, 6814);
});

check("add_mask honours closed:false and the tangents", () => {
  const ae = scene();
  const inT = [[0, 0], [-10, 0], [0, 0], [0, 0]];
  const outT = [[10, 0], [0, 0], [0, 0], [0, 0]];
  const r = ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE, inTangents: inT, outTangents: outT, closed: false }), "add_mask");
  assert.equal(r.maskIndex, 1);
  const m = maskState(ae, 1);
  assert.deepEqual([m.path.closed, m.path.inTangents, m.path.outTangents], [false, inT, outT]);
  assert.equal(m.mode, 6813, "no mode given leaves After Effects' default, ADD");
});

check("set_mask changes the mask it names and nothing else", () => {
  const ae = scene();
  ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE }), "add_mask");
  ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE }), "add_mask");
  const tri = [[0, 0], [50, 100], [100, 0]];
  ok(
    ae.call("set_mask", {
      compId: 100, layerId: 2, maskIndex: 2,
      vertices: tri, closed: false, mode: "DARKEN", inverted: true, expansion: 5, feather: [3, 3], opacity: 40,
    }),
    "set_mask"
  );
  const m = maskState(ae, 2);
  assert.deepEqual(
    [m.path.vertices, m.path.closed, m.mode, m.inverted, m.expansion, m.feather, m.opacity],
    [tri, false, 6817, true, 5, [3, 3], 40]
  );
  const untouched = maskState(ae, 1);
  assert.deepEqual([untouched.path.vertices, untouched.mode, untouched.inverted, untouched.opacity], [SQUARE, 6813, false, 100]);
});

check("remove_mask removes the one it names and the next one moves up", () => {
  const ae = scene();
  ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE, mode: "ADD" }), "add_mask");
  ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE, mode: "DIFFERENCE" }), "add_mask");
  ok(ae.call("remove_mask", { compId: 100, layerId: 2, maskIndex: 1 }), "remove_mask");
  assert.equal(ae.json(`CARD.property("Masks").numProperties`), 1);
  assert.equal(maskState(ae, 1).mode, 6818);
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const markersOf = (ae, holder) =>
  ae.json(`(function(p){ var o = []; for (var i = 1; i <= p.numKeys; i++) { var v = p.keyValue(i);
    o.push({ time: p.keyTime(i), comment: v.comment, duration: v.duration, label: v.label, chapter: v.chapter,
      url: v.url, frameTarget: v.frameTarget }); } return o; })(${holder})`);

check("add_marker without a layerId marks the comp, with every field it was given", () => {
  const ae = scene();
  ok(
    ae.call("add_marker", {
      compId: 100, time: 1.5, comment: "beat", duration: 0.5, label: 3, chapter: "Intro", url: "https://example.com", frameTarget: "_blank",
    }),
    "add_marker"
  );
  assert.deepEqual(markersOf(ae, "C.markerProperty"), [
    { time: 1.5, comment: "beat", duration: 0.5, label: 3, chapter: "Intro", url: "https://example.com", frameTarget: "_blank" },
  ]);
  assert.deepEqual(markersOf(ae, `CARD.property("Marker")`), [], "no layer was marked");
});

check("add_marker with a layerId marks that layer; remove_marker removes by index in time order", () => {
  const ae = scene();
  ok(ae.call("add_marker", { compId: 100, layerId: 2, time: 3, comment: "late" }), "add_marker");
  ok(ae.call("add_marker", { compId: 100, layerId: 2, time: 1, comment: "early" }), "add_marker");
  ok(ae.call("add_marker", { compId: 100, time: 2, comment: "comp" }), "add_marker");
  assert.deepEqual(markersOf(ae, `CARD.property("Marker")`).map((m) => m.comment), ["early", "late"]);
  ok(ae.call("remove_marker", { compId: 100, layerId: 2, markerIndex: 1 }), "remove_marker");
  assert.deepEqual(markersOf(ae, `CARD.property("Marker")`).map((m) => m.comment), ["late"]);
  assert.deepEqual(markersOf(ae, "C.markerProperty").map((m) => m.comment), ["comp"], "the comp's markers are untouched");
  ok(ae.call("remove_marker", { compId: 100, markerIndex: 1 }), "remove_marker");
  assert.deepEqual(markersOf(ae, "C.markerProperty"), []);
});

check("remove_marker past the end is an error, not a success", () => {
  const ae = scene();
  refused(ae.call("remove_marker", { compId: 100, layerId: 2, markerIndex: 1 }), /out of range/, "remove_marker");
});

// ---------------------------------------------------------------------------
// get_layer_full, golden
// ---------------------------------------------------------------------------

/** One layer with something in every section get_layer_full reads. */
function representative() {
  const ae = scene();
  ae.run(`
    CARD.parent = CTRL;
    CARD.label = 4;
    var SOLID = new FootageItem();
    SOLID.id = 50; SOLID.name = "Red Solid"; SOLID.hasAlpha = false; SOLID.duration = 0;
    SOLID.width = 1920; SOLID.height = 1080; SOLID.mainSource = { color: [1, 0, 0] };
    CARD.source = SOLID;
    CARD.property("Transform").property("Opacity").expression = "wiggle(2, 10)";
  `);
  for (const [t, v] of [[0, [100, 100]], [1, [200, 150]], [2, [300, 300]]]) {
    ok(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: POS, time: t, value: v }), "add_keyframe");
  }
  ok(ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: POS, keyIndex: 3, in: "hold", out: "hold" }), "set_interpolation");
  ok(ae.call("add_effect", { compId: 100, layerId: 2, matchName: "ADBE Gaussian Blur 2" }), "add_effect");
  ae.run(`CARD.property("Effects").property(1).property("Blurriness").setValue(12);`);
  ok(ae.call("add_mask", { compId: 100, layerId: 2, vertices: SQUARE, mode: "ADD" }), "add_mask");
  ok(ae.call("add_marker", { compId: 100, layerId: 2, time: 0.5, comment: "hit", label: 2 }), "add_marker");
  return ae;
}

check("get_layer_full's whole answer matches the golden file", () => {
  const ae = representative();
  const full = ok(ae.call("get_layer_full", { compId: 100, layerId: 2 }), "get_layer_full");
  const text = JSON.stringify(full, null, 2) + "\n";
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
    fs.writeFileSync(goldenFile, text);
    console.log(`fake-ae-ops: wrote ${path.relative(process.cwd(), goldenFile)}`);
  }
  assert.equal(
    text,
    fs.readFileSync(goldenFile, "utf8").replace(/\r\n/g, "\n"),
    "get_layer_full's output changed. If that is intended, regenerate with UPDATE_GOLDEN=1 and review the diff of tests/unit/golden/get-layer-full.json."
  );
});

check("get_layer_full with include returns those sections and says it was bounded", () => {
  const ae = representative();
  const r = ok(ae.call("get_layer_full", { compId: 100, layerId: 2, include: ["markers", "masks"] }), "get_layer_full");
  for (const absent of ["transform", "effects", "sourceRect", "footage", "precomp"]) assert.ok(!(absent in r), `${absent} came back`);
  assert.deepEqual(r.included, ["markers", "masks"]);
  assert.equal(r.markers.length, 1);
  assert.equal(r.masks.length, 1);
  // The header is never optional.
  assert.deepEqual([r.id, r.name, r.sourceType, r.parent], [2, "Card", "solid", { layerId: 1, name: "CTRL" }]);
});

check("get_layer_full with maxKeyframes keeps the ends and counts what it dropped", () => {
  const ae = representative();
  const r = ok(ae.call("get_layer_full", { compId: 100, layerId: 2, include: ["transform"], maxKeyframes: 2 }), "get_layer_full");
  const p = r.transform.Position;
  assert.deepEqual(p.keyframes.map((k) => k.index), [1, 3]);
  assert.equal(p.keyframeCount, 3);
  assert.equal(p.keyframesOmitted, 1);
  assert.match(p.keyframesTruncated, /1 omitted/);
});

console.log(`fake-ae-ops: ${passed} checks passed`);
