// A z with nowhere to go (issue #291).
//
// A 2D layer's Position and Anchor Point read as three numbers, but write
// [x, y, z] to one and After Effects keeps [x, y, 0] and throws nothing, on
// setValue and setValueAtTime alike. Every tool that took that path reported
// success. The fake does what AE measured (tests/unit/lib/fake-ae.mjs), so each
// check below goes through the real handler and looks at what was left behind.
//
// The other half matters as much: a z that really lands is not refused. A z of
// 0, a 3D layer, a camera or light (threeDLayer reads undefined), per-character
// 3D, and a 3D Point effect control, which reads exactly like a Position.
//
//   node tests/unit/lost-z.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFakeAe } from "./lib/fake-ae.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`lost-z FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const FILES = ["ids.jsx", "values.jsx", "comps.jsx", "layers.jsx", "snapshot.jsx", "transforms.jsx", "keyframes.jsx", "retime.jsx", "footage.jsx", "shapes.jsx", "batch.jsx", "helpers.jsx"];

/** Comp 100 with a 2D layer (id 1), a 3D layer (id 2), and layers.add* that build fakes. */
function scene() {
  const ae = loadFakeAe(FILES);
  ae.run(`
    var comp = FAKE.comp(100, "Main");
    var flat = comp.addLayer(1, "Flat", "null");
    var deep = comp.addLayer(2, "Deep", "null"); deep.threeDLayer = true;
    var LightType = { PARALLEL: 1, SPOT: 2, POINT: 3, AMBIENT: 4 };
    var FolderItem = function () {};
    var nextId = 50;
    function spawn(name, kind) { return comp.addLayer(nextId++, name, kind); }
    comp.layers = {
      addShape: function () { return spawn("Shape", "shape"); },
      addText: function () { return spawn("Text", "text"); },
      add: function () { return spawn("Added", "av"); }
    };
    FAKE.comp(101, "Source");
    app.project.items = { addComp: function () {} };
  `);
  return ae;
}

const pos = (ae, id) => ae.json(`getLayerById(comp, ${id}).property("Transform").property("Position").value`);
const anchor = (ae, id) => ae.json(`getLayerById(comp, ${id}).property("Transform").property("Anchor Point").value`);
const layerCount = (ae) => ae.json("comp.numLayers");
const refused = (r, ...words) => {
  assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
  for (const w of words) assert.match(r.error, w);
};

check("sanity: the fake drops the z the way AE does, and says nothing", () => {
  const ae = scene();
  ae.run(`flat.property("Transform").property("Position").setValue([1, 2, 30])`);
  assert.deepEqual(pos(ae, 1), [1, 2, 0]);
});

check("set_transform refuses a z on a 2D layer and writes none of the call", () => {
  const ae = scene();
  const before = pos(ae, 1);
  refused(ae.call("set_transform", { compId: 100, layerId: 1, properties: { opacity: 50, position: [5, 6, 70] } }), /z 70/, /'Flat' is 2D/, /Nothing was changed/);
  assert.deepEqual(pos(ae, 1), before);
  assert.equal(ae.json(`flat.property("Transform").property("Opacity").value`), 100, "no partial transform");
  refused(ae.call("set_transform", { compId: 100, layerId: 1, properties: { anchorPoint: [1, 2, 3] } }), /Anchor Point/);
  refused(ae.call("set_transform", { compId: 100, layerId: 1, time: 1, keyframe: true, properties: { position: [7, 8, 9] } }), /z 9/);
  assert.equal(ae.json(`flat.property("Transform").property("Position").numKeys`), 0);
});

check("set_transform refuses before its earlier fields: Scale is written ahead of Anchor Point", () => {
  const ae = scene();
  refused(ae.call("set_transform", { compId: 100, layerId: 1, properties: { scale: [50, 50], anchorPoint: [1, 2, 3] } }), /z 3/, /Nothing was changed/);
  assert.deepEqual(ae.json(`flat.property("Transform").property("Scale").value`), [100, 100, 100]);
});

check("add_keyframe refuses it, on Position and on Anchor Point", () => {
  const ae = scene();
  refused(ae.call("add_keyframe", { compId: 100, layerId: 1, propertyPath: ["Transform", "Position"], time: 1, value: [1, 2, 3] }), /add_keyframe/);
  refused(ae.call("add_keyframe", { compId: 100, layerId: 1, propertyPath: ["Transform", "Anchor Point"], time: 1, value: [1, 2, 3] }), /add_keyframe/);
  assert.equal(ae.json(`flat.property("Transform").property("Position").numKeys`), 0);
});

check("set_shape_property aimed at Transform takes the same refusal", () => {
  const ae = scene();
  refused(ae.call("set_shape_property", { compId: 100, layerId: 1, contentPath: ["Transform"], property: "Anchor Point", value: [4, 4, 44] }), /set_shape_property/);
});

check("the layer-creating tools refuse before any layer exists", () => {
  for (const [op, extra] of [
    ["create_shape_layer", {}],
    ["create_text_layer", { text: "x" }],
    ["create_precomp_layer", { sourceCompId: 101 }],
    ["create_footage_layer", { itemId: 101 }],
  ]) {
    const ae = scene();
    const n = layerCount(ae);
    refused(ae.call(op, { compId: 100, position: [1, 2, 30], ...extra }), new RegExp(op), /Nothing was created/);
    assert.equal(layerCount(ae), n, `${op} left a layer behind`);
  }
});

check("the run_jsx helpers refuse it, and addKeys leaves no key behind", () => {
  const ae = scene();
  const code = (s) => { try { ae.run(s); return null; } catch (e) { return String(e.message); } };
  assert.match(code(`setValueChecked(flat.property("Transform").property("Position"), [1, 2, 3])`), /z 3/);
  assert.match(code(`addKeys(flat.property("Transform").property("Position"), [[0, [1, 2, 0]], [1, [1, 2, 3]]])`), /addKeys/);
  assert.equal(ae.json(`flat.property("Transform").property("Position").numKeys`), 0);
  const n = layerCount(ae);
  assert.match(code(`shape(comp, {position: [1, 2, 3]})`), /Nothing was created/);
  assert.equal(layerCount(ae), n);
});

check("copy_animation refuses a 3D source's z on a 2D target, and keeps a z of 0", () => {
  const ae = scene();
  const key = (z) => ae.run(`var p = deep.property("Transform").property("Position"); p.setValueAtTime(0, [1, 1, ${z}]); p.setValueAtTime(1, [2, 2, ${z}]);`);
  key(100);
  const paths = [["Transform", "Position"]];
  refused(ae.call("copy_animation", { compId: 100, layerId: 2, propertyPaths: paths, targets: [{ layerId: 1 }] }), /z of 100/, /'Flat' is 2D/);
  assert.equal(ae.json(`flat.property("Transform").property("Position").numKeys`), 0);
  key(0);
  const ok = ae.call("copy_animation", { compId: 100, layerId: 2, propertyPaths: paths, targets: [{ layerId: 1 }] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

check("a z of 0 and a plain [x, y] still work on a 2D layer", () => {
  const ae = scene();
  assert.equal(ae.call("set_transform", { compId: 100, layerId: 1, properties: { position: [5, 6, 0], anchorPoint: [1, 2, 0] } }).ok, true);
  assert.deepEqual(pos(ae, 1), [5, 6, 0]);
  assert.equal(ae.call("set_transform", { compId: 100, layerId: 1, properties: { position: [7, 8] } }).ok, true);
  assert.deepEqual(pos(ae, 1), [7, 8]);
  assert.equal(ae.call("add_keyframe", { compId: 100, layerId: 1, propertyPath: ["Transform", "Position"], time: 1, value: [1, 2, 0] }).ok, true);
  assert.equal(ae.call("create_shape_layer", { compId: 100, position: [1, 2, 0] }).ok, true);
  assert.equal(ae.call("create_text_layer", { compId: 100, text: "x", anchorAlign: "none", position: [1, 2, 0] }).ok, true);
  assert.equal(ae.call("create_precomp_layer", { compId: 100, sourceCompId: 101, position: [1, 2, 0] }).ok, true);
  assert.equal(ae.call("create_shape_layer", { compId: 100, position: "center" }).ok, true);
  assert.equal(ae.call("create_shape_layer", { compId: 100 }).ok, true);
});

check("a float's noise around zero is a z of 0", () => {
  const ae = scene();
  assert.equal(ae.call("set_transform", { compId: 100, layerId: 1, properties: { position: [5, 6, 1e-12] } }).ok, true);
});

check("a 3D layer keeps its z, through every route", () => {
  const ae = scene();
  assert.equal(ae.call("set_transform", { compId: 100, layerId: 2, properties: { position: [5, 6, 70], anchorPoint: [1, 2, 3] } }).ok, true);
  assert.deepEqual(pos(ae, 2), [5, 6, 70]);
  assert.deepEqual(anchor(ae, 2), [1, 2, 3]);
  assert.equal(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: ["Transform", "Position"], time: 1, value: [1, 2, 3] }).ok, true);
});

check("a layer made 3D earlier in a batch is judged as it is by then", () => {
  const ae = scene();
  const r = ae.call("run_batch", { ops: [
    { op: "set_layer", args: { compId: 100, layerId: 1, threeDLayer: true } },
    { op: "set_transform", args: { compId: 100, layerId: 1, properties: { position: [5, 6, 70] } } },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(pos(ae, 1), [5, 6, 70]);
});

check("a batch step takes the same refusal", () => {
  const ae = scene();
  const r = ae.call("run_batch", { ops: [{ op: "set_transform", args: { compId: 100, layerId: 1, properties: { position: [5, 6, 70] } } }] });
  refused(r, /z 70/, /'Flat' is 2D/);
});

// Z Position exists on a separated 2D layer: read as a bare number, not an array.
function separated(ae, layer, name) {
  ae.run(`
    (function () {
      var tr = ${layer}.property("Transform");
      var z = tr._add(new FAKE.Property("Z Position", "ADBE Position_2", 0, PropertyValueType.OneD));
      z.propertyDepth = 2;
      z.propertyGroup = function (n) { return n === 2 ? ${layer} : tr; };
      ${name} = z;
    })();
  `);
}

check("Z Position on a separated 2D layer is refused; a 0 and a 3D layer are not", () => {
  const ae = scene();
  separated(ae, "flat", "this.flatZ");
  separated(ae, "deep", "this.deepZ");
  refused(ae.call("add_keyframe", { compId: 100, layerId: 1, propertyPath: ["Transform", "Z Position"], time: 1, value: 44 }), /add_keyframe: z 44/, /'Flat' is 2D/);
  assert.equal(ae.json("flatZ.numKeys"), 0);
  assert.equal(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: ["Transform", "Z Position"], time: 1, value: 44 }).ok, true);
  assert.equal(ae.run(`__zFor(flatZ, 0)`), null);
  assert.equal(ae.run(`__zFor(flatZ, 44)`), 44);
});

check("copy_animation refuses a Z Position key onto a separated 2D target", () => {
  const ae = scene();
  separated(ae, "flat", "this.flatZ");
  separated(ae, "deep", "this.deepZ");
  ae.run(`deepZ.setValueAtTime(1, 44)`);
  const r = ae.call("copy_animation", { compId: 100, layerId: 2, propertyPaths: [["Transform", "Z Position"]], targets: [{ layerId: 1 }] });
  refused(r, /z of 44/, /'Flat' is 2D/);
  assert.equal(ae.json("flatZ.numKeys"), 0);
});

// The cases a judgement by value type or by `!threeDLayer` gets wrong, on the
// helper itself: the fake has no cameras, text animators or 3D Point controls.
check("a z that lands is not refused: cameras, lights, per-character 3D, 3D Point controls", () => {
  const ae = scene();
  const verdict = (matchName, layer) => ae.run(`__zIsDropped({
    matchName: ${JSON.stringify(matchName)}, propertyDepth: 2,
    propertyGroup: function () { return ${layer}; }
  })`);
  // Measured on 26.5: both read threeDLayer as undefined.
  assert.equal(verdict("ADBE Position", "{}"), false, "a camera or light");
  assert.equal(verdict("ADBE Anchor Point", "{}"), false, "a camera's Point of Interest");
  assert.equal(verdict("ADBE Position", "new CameraLayer()"), false);
  assert.equal(verdict("ADBE Position", "{threeDLayer: true, threeDPerChar: true}"), false);
  assert.equal(verdict("ADBE Position", "{threeDLayer: false}"), true);
  // A text animator's z follows per-character 3D, not the layer's 3D switch.
  assert.equal(verdict("ADBE Text Position 3D", "{threeDLayer: true, threeDPerChar: true}"), false);
  assert.equal(verdict("ADBE Text Position 3D", "{threeDLayer: true, threeDPerChar: false}"), true);
  assert.equal(verdict("ADBE Text Anchor Point 3D", "{threeDLayer: false, threeDPerChar: false}"), true);
  // ThreeD_SPATIAL like a Position, on a 2D layer, and its z lands.
  assert.equal(verdict("ADBE Point3D Control-0001", "{threeDLayer: false}"), false);
  assert.equal(ae.run(`__zIsDropped({ matchName: "ADBE Position" })`), false, "what cannot be read is not refused");
});

check("cameras and lights: a z reaches Position, [x, y] stays where it was", () => {
  const ae = scene();
  ae.run(`
    comp.layers.addCamera = function (name, center) { var l = spawn(name, "null"); l.threeDLayer = undefined; l.center = center; return l; };
    comp.layers.addLight = function (name, center) { var l = spawn(name, "null"); l.threeDLayer = undefined; l.center = center; return l; };
  `);
  for (const op of ["create_camera_layer", "create_light_layer"]) {
    const r = ae.call(op, { compId: 100, position: [100, 200, -300] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(pos(ae, r.result.id), [100, 200, -300]);
    for (const p of [[100, 200], [100, 200, 0]]) {
      const plain = ae.call(op, { compId: 100, position: p });
      assert.equal(plain.ok, true);
      assert.deepEqual(pos(ae, plain.result.id), [960, 540], "Position is left to After Effects");
    }
  }
});

check("an ambient light with a z is refused before any layer is added", () => {
  const ae = scene();
  ae.run(`comp.layers.addLight = function () { throw new Error("addLight was called"); };`);
  refused(ae.call("create_light_layer", { compId: 100, lightType: "ambient", position: [1, 2, 3] }), /ambient/, /Nothing was created/);
  ae.run(`comp.layers.addLight = function (name) { var l = spawn(name, "null"); l.threeDLayer = undefined; return l; };`);
  assert.equal(ae.call("create_light_layer", { compId: 100, lightType: "ambient", position: [1, 2, 0] }).ok, true);
});

check("a camera or light whose Position will not take the write is removed, not left half built", () => {
  const ae = scene();
  ae.run(`
    comp.layers.addLight = function (name) {
      var l = spawn(name, "null"); l.threeDLayer = undefined;
      l.property("Transform").property("Position").setValue = function () { throw new Error("the property is hidden"); };
      return l;
    };
  `);
  const n = layerCount(ae);
  refused(ae.call("create_light_layer", { compId: 100, position: [1, 2, 3] }), /hidden/, /removed/);
  assert.equal(layerCount(ae), n);
});

check("the panel-free docs keep the promise the tool list makes", () => {
  const desc = fs.readFileSync(path.join(root, "packages", "mcp-server", "src", "tools", "descriptions.ts"), "utf8");
  assert.match(desc, /non-zero z for a 2D layer's position or anchorPoint is refused/);
  assert.match(desc, /refuse a z a 2D layer would drop/);
});

console.log(`lost-z: ${passed} checks passed`);
