// Two writes that reported success for work that did not happen.
//
// #151 — `keyframe: true` with no `time` fell through to a static setValue on
// set_transform, set_effect_param and set_shape_property: no keyframe, no
// error, and the property's static value overwritten. The rule is now declared
// with crossField() (kind "whenTrue"), so it is in the schema the model sees
// and refused by the server; the handlers refuse it too, for a caller that
// reaches OPS directly from run_jsx.
//
// #152 — set_transform skipped orientation / xRotation / yRotation on a 2D
// layer and still answered {ok:true}. It now refuses before writing anything,
// naming the fields and the remedy. zRotation on a 2D layer is that layer's
// Rotation (the same property in AE), so it lands there.
//
// The handlers run against a mock layer; what AE itself does with a keyframe is
// the live check in the PR.
//
//   node tests/unit/keyframe-transform.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const { OpSchemas, StrictOpSchemas } = await import(
  pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href
);

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`keyframe-transform FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------- #151 at the schema ----------

const calls = {
  set_transform: { compId: 1, layerId: 2, properties: { opacity: 50 } },
  set_effect_param: { compId: 1, layerId: 2, effectIndex: 1, paramMatchName: "ADBE Slider Control-0001", value: 5 },
  set_shape_property: { compId: 1, layerId: 2, contentPath: ["Contents", "Rect"], property: "Size", value: [10, 10] },
};

for (const [op, base] of Object.entries(calls)) {
  for (const [label, schemas] of [["OpSchemas", OpSchemas], ["StrictOpSchemas", StrictOpSchemas]]) {
    check(`${op} (${label}): keyframe:true without time is refused, naming both fields`, () => {
      const r = schemas[op].safeParse({ ...base, keyframe: true });
      assert.equal(r.success, false, "a keyframe with no time must not reach After Effects");
      const msg = r.error.issues.map((i) => i.message).join(" ");
      assert.ok(msg.includes("keyframe") && msg.includes("time"), msg);
    });
    check(`${op} (${label}): with time, keyframe:false, or no keyframe at all is accepted`, () => {
      assert.ok(schemas[op].safeParse({ ...base, keyframe: true, time: 1 }).success);
      assert.ok(schemas[op].safeParse({ ...base, keyframe: false }).success);
      assert.ok(schemas[op].safeParse({ ...base }).success);
      assert.ok(schemas[op].safeParse({ ...base, time: 1 }).success);
    });
  }
}

check("set_effect_param keeps its paramName/paramMatchName rule alongside the new one", () => {
  const { paramMatchName, ...noParam } = calls.set_effect_param;
  assert.equal(OpSchemas.set_effect_param.safeParse({ ...noParam, keyframe: true, time: 1 }).success, false);
});

// ---------- the handlers, against a mock ----------

const HOST = `
var OPS = {};
function noUndo(fn) { return fn; }
function MockProp(name, v) { this.name = name; this.v = v; this.keys = []; this.writes = []; }
MockProp.prototype.setValue = function (x) { this.writes.push(["static", x]); this.v = x; };
MockProp.prototype.setValueAtTime = function (t, x) { this.writes.push(["key", t, x]); this.keys.push([t, x]); };
MockProp.prototype.valueAtTime = function () { return this.v; };
Object.defineProperty(MockProp.prototype, "numKeys", { get: function () { return this.keys.length; } });
Object.defineProperty(MockProp.prototype, "value", { get: function () { return this.v; } });
function CameraLayer() {}
function LightLayer() {}
// Transform properties are looked up by match name, so the mock answers only those.
var MATCH = {
  "ADBE Position": "Position", "ADBE Scale": "Scale", "ADBE Rotate Z": "Z Rotation",
  "ADBE Rotate X": "X Rotation", "ADBE Rotate Y": "Y Rotation", "ADBE Orientation": "Orientation",
  "ADBE Anchor Point": "Anchor Point", "ADBE Opacity": "Opacity", "ADBE Point of Interest": "Point of Interest"
};
// kind: "2d" | "3d" | "camera" | "light". A 2D layer keeps its hidden 3D
// properties, as AE's does. A camera or light has no Scale/Opacity/Anchor
// Point; this mock's light has no Z Rotation either, to exercise the refusal.
function makeLayer(kind) {
  var names = kind === "camera" ? ["Point of Interest", "Position", "Orientation", "X Rotation", "Y Rotation", "Z Rotation"]
    : kind === "light" ? ["Point of Interest", "Position", "Orientation", "X Rotation", "Y Rotation"]
    : ["Position", "Scale", "Z Rotation", "X Rotation", "Y Rotation", "Orientation", "Anchor Point", "Opacity"];
  var props = {};
  for (var i = 0; i < names.length; i++) props[names[i]] = new MockProp(names[i], 0);
  var tr = { property: function (n) { return props[MATCH[n]] || null; } };
  var l = kind === "camera" ? new CameraLayer() : kind === "light" ? new LightLayer() : {};
  l.name = "Card";
  l.threeDLayer = kind === "3d"; // cameras and lights report false in AE
  l.props = props;
  l.property = function (n) { return n === "Transform" ? tr : null; };
  return l;
}
var LAYER = null;
var PROP = null;
function getCompById() { return {}; }
function getLayerById() { return LAYER; }
function walkProperty() { return { property: function () { return PROP; } }; }
function allWrites() {
  var out = [];
  for (var k in LAYER.props) for (var i = 0; i < LAYER.props[k].writes.length; i++) out.push(k);
  return out;
}
`;

function makeCtx() {
  const ctx = { Math, String, Error, isNaN, JSON };
  vm.createContext(ctx);
  vm.runInContext(HOST, ctx, { filename: "host.js" });
  for (const f of ["values.jsx", "transforms.jsx", "effects.jsx", "shapes.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  // The effect lookup has its own tests; here it only has to hand back PROP.
  vm.runInContext("__effectAt = function () { return {}; }; __findEffectParam = function () { return PROP; };", ctx);
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const plain = (a) => JSON.parse(JSON.stringify(a));

check("set_transform: keyframe:true without time throws and writes nothing", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("2d");');
  assert.throws(
    () => run(ctx, "OPS.set_transform({compId:1, layerId:2, keyframe:true, properties:{opacity:50}})"),
    /keyframe:true needs `time`/
  );
  assert.deepEqual(plain(run(ctx, "allWrites()")), []);
});

check("set_transform: keyframe:true with time writes a keyframe, not a static value", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("2d");');
  run(ctx, "OPS.set_transform({compId:1, layerId:2, keyframe:true, time:1.5, properties:{opacity:50}})");
  assert.deepEqual(plain(run(ctx, "LAYER.props['Opacity'].writes")), [["key", 1.5, 50]]);
});

check("set_effect_param: keyframe:true without time throws and writes nothing", () => {
  const ctx = makeCtx();
  run(ctx, "PROP = new MockProp('Slider', 0);");
  assert.throws(
    () => run(ctx, "OPS.set_effect_param({compId:1, layerId:2, effectIndex:1, paramMatchName:'x', value:5, keyframe:true})"),
    /set_effect_param: keyframe:true needs `time`/
  );
  assert.deepEqual(plain(run(ctx, "PROP.writes")), []);
});

check("set_shape_property: keyframe:true without time throws and writes nothing", () => {
  const ctx = makeCtx();
  run(ctx, "PROP = new MockProp('Size', [0,0]);");
  assert.throws(
    () => run(ctx, "OPS.set_shape_property({compId:1, layerId:2, contentPath:['Contents'], property:'Size', value:[1,1], keyframe:true})"),
    /set_shape_property: keyframe:true needs `time`/
  );
  assert.deepEqual(plain(run(ctx, "PROP.writes")), []);
});

// ---------- #152 ----------

check("set_transform on a 2D layer refuses orientation/xRotation/yRotation, names them, writes nothing", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("2d");');
  let err;
  try {
    run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{position:[1,2], xRotation:10, orientation:[0,0,90]}})");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a 2D layer must not silently drop 3D-only fields");
  assert.match(err.message, /orientation/);
  assert.match(err.message, /xRotation/);
  assert.match(err.message, /threeDLayer:true/);
  assert.doesNotMatch(err.message, /yRotation/, "only the fields actually passed are named");
  assert.deepEqual(plain(run(ctx, "allWrites()")), [], "position must not land when the call is refused");
});

check("set_transform on a 2D layer puts zRotation on its Rotation (ADBE Rotate Z)", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("2d");');
  run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{zRotation:45}})");
  assert.deepEqual(plain(run(ctx, "allWrites()")), ["Z Rotation"]);
  assert.equal(run(ctx, "LAYER.props['Z Rotation'].v"), 45);
});

check("rotation and zRotation together are refused as one property passed twice", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("3d");');
  assert.throws(
    () => run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{position:[1,2,3], rotation:10, zRotation:20}})"),
    /`rotation` and `zRotation` are the same property/
  );
  assert.deepEqual(plain(run(ctx, "allWrites()")), []);
});

check("a camera takes orientation and X/Y/Z rotation although threeDLayer is false", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("camera");');
  run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{orientation:[0,90,0], xRotation:5, yRotation:6, zRotation:7}})");
  assert.deepEqual(plain(run(ctx, "allWrites()")).sort(), ["Orientation", "X Rotation", "Y Rotation", "Z Rotation"]);
});

check("a light takes orientation, and a property it lacks is refused before any write", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("light");');
  run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{orientation:[0,90,0], xRotation:5}})");
  assert.deepEqual(plain(run(ctx, "allWrites()")).sort(), ["Orientation", "X Rotation"]);

  const ctx2 = makeCtx();
  run(ctx2, 'LAYER = makeLayer("light");');
  let err;
  try {
    run(ctx2, "OPS.set_transform({compId:1, layerId:2, properties:{position:[1,2,3], zRotation:7, opacity:50}})");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a missing property must be refused, not skipped");
  assert.match(err.message, /camera or light/);
  assert.match(err.message, /opacity, zRotation/);
  assert.deepEqual(plain(run(ctx2, "allWrites()")), [], "position must not land when the call is refused");
});

check("set_transform on a 3D layer writes orientation and per-axis rotation", () => {
  const ctx = makeCtx();
  run(ctx, 'LAYER = makeLayer("3d");');
  run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{orientation:[0,0,90], xRotation:10, yRotation:20, zRotation:30}})");
  assert.deepEqual(plain(run(ctx, "allWrites()")).sort(), ["Orientation", "X Rotation", "Y Rotation", "Z Rotation"]);
});

console.log(`keyframe-transform: ${passed} checks passed`);
