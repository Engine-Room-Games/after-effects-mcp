// __setOrKeyAtTime (packages/jsx/values.jsx): the one write path behind
// set_transform, set_effect_param and set_shape_property (issue #184).
//
// The three ops each carried their own copy of "set the value, or add a
// keyframe". They are one helper now, and this file pins what that helper has
// to keep doing for all three:
//
//   - keyframe + time            -> setValueAtTime, always
//   - time, no keyframe          -> setValueAtTime if the property already has
//                                   keys, otherwise the static value
//   - no time (or a null time)   -> the static value
//   - keyframe:true without time -> refused before anything is written (#151)
//   - static writes go through __setValue, so #129's false "invalid numeric
//     result" throw is dropped when the read-back agrees, and rethrown when it
//     does not; keyframe writes are not second-guessed
//   - set_transform's refusals (hidden property) and partial-write report
//     still wrap it
//
//   node tests/unit/set-or-key.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`set-or-key FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const HOST = `
var OPS = {};
function noUndo(fn) { return fn; }
// throwOn: "static" makes setValue throw #129's false error (the value still
// lands unless lost is set); "key" does the same to setValueAtTime;
// "hidden" makes setValue throw the way a hidden property does.
function MockProp(name, v, keyCount) {
  this.name = name; this.v = v; this.writes = []; this.keys = [];
  for (var i = 0; i < (keyCount || 0); i++) this.keys.push([i, v]);
}
MockProp.prototype.setValue = function (x) {
  this.writes.push(["static", x]);
  if (!this.lost) this.v = x;
  if (this.throwOn === "static") throw new Error("After Effects error: invalid numeric result (divide by zero?)");
  if (this.throwOn === "hidden") throw new Error("Can not set value of a hidden property");
};
MockProp.prototype.setValueAtTime = function (t, x) {
  this.writes.push(["key", t, x]);
  this.keys.push([t, x]);
  if (this.throwOn === "key") throw new Error("After Effects error: invalid numeric result (divide by zero?)");
};
MockProp.prototype.valueAtTime = function () { return this.v; };
Object.defineProperty(MockProp.prototype, "numKeys", { get: function () { return this.keys.length; } });
Object.defineProperty(MockProp.prototype, "value", { get: function () { return this.v; } });
var MATCH = { "ADBE Position": "Position", "ADBE Opacity": "Opacity", "ADBE Scale": "Scale" };
var PROPS = {};
var PROP = null;
var LAYER = {
  name: "Card", threeDLayer: false,
  property: function (n) {
    return n === "Transform" ? { property: function (m) { return PROPS[MATCH[m]] || null; } } : null;
  }
};
function getCompById() { return {}; }
function getLayerById() { return LAYER; }
function walkProperty() { return { property: function () { return PROP; } }; }
`;

function makeCtx(files) {
  const ctx = { Math, String, Error, isNaN, JSON };
  vm.createContext(ctx);
  vm.runInContext(HOST, ctx, { filename: "host.js" });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const plain = (a) => JSON.parse(JSON.stringify(a));

// ---------- the helper on its own: values.jsx is all it needs ----------

// [label, keyframe, time, existing keys, expected writes]
const MATRIX = [
  ["keyframe + time", true, 2, 0, [["key", 2, 7]]],
  ["keyframe + time on an animated property", true, 2, 3, [["key", 2, 7]]],
  ["keyframe + time 0", true, 0, 0, [["key", 0, 7]]],
  ["time, no keyframe, not animated", false, 2, 0, [["static", 7]]],
  ["time, no keyframe, animated", false, 2, 3, [["key", 2, 7]]],
  ["time 0, no keyframe, animated", false, 0, 3, [["key", 0, 7]]],
  ["no time", false, undefined, 0, [["static", 7]]],
  ["no time on an animated property", false, undefined, 3, [["static", 7]]],
  ["null time, animated", false, null, 3, [["static", 7]]],
];

for (const [label, kf, t, keys, want] of MATRIX) {
  check(`helper: ${label}`, () => {
    const ctx = makeCtx(["values.jsx"]);
    ctx.T = t;
    run(ctx, `PROP = new MockProp("P", 0, ${keys}); __setOrKeyAtTime(PROP, 7, T, ${kf}, "op");`);
    assert.deepEqual(plain(run(ctx, "PROP.writes")), want);
  });
}

for (const t of [undefined, null]) {
  check(`helper: keyframe:true with time ${t} is refused and writes nothing`, () => {
    const ctx = makeCtx(["values.jsx"]);
    ctx.T = t;
    assert.throws(
      () => run(ctx, `PROP = new MockProp("P", 0, 2); __setOrKeyAtTime(PROP, 7, T, true, "set_thing");`),
      /set_thing: keyframe:true needs `time`/
    );
    assert.deepEqual(plain(run(ctx, "PROP.writes")), []);
  });
}

check("helper: a static write that landed behind #129's false throw is not a failure", () => {
  const ctx = makeCtx(["values.jsx"]);
  run(ctx, 'PROP = new MockProp("P", 0); PROP.throwOn = "static"; __setOrKeyAtTime(PROP, 7, undefined, false, "op");');
  assert.equal(run(ctx, "PROP.v"), 7);
});

check("helper: a static write that did not land still throws the original error", () => {
  const ctx = makeCtx(["values.jsx"]);
  assert.throws(
    () => run(ctx, 'PROP = new MockProp("P", 0); PROP.throwOn = "static"; PROP.lost = true; __setOrKeyAtTime(PROP, 7, undefined, false, "op");'),
    /invalid numeric result/
  );
});

check("helper: a keyframe write is not second-guessed — its throw propagates", () => {
  const ctx = makeCtx(["values.jsx"]);
  assert.throws(
    () => run(ctx, 'PROP = new MockProp("P", 0); PROP.throwOn = "key"; __setOrKeyAtTime(PROP, 7, 1, true, "op");'),
    /invalid numeric result/
  );
});

// ---------- the three ops route through it identically ----------

const OPS_UNDER_TEST = {
  set_effect_param: (kf, t) =>
    `OPS.set_effect_param({compId:1, layerId:2, effectIndex:1, paramMatchName:'x', value:7${kf ? ", keyframe:true" : ""}${t !== undefined ? ", time:T" : ""}})`,
  set_shape_property: (kf, t) =>
    `OPS.set_shape_property({compId:1, layerId:2, contentPath:['Contents'], property:'P', value:7${kf ? ", keyframe:true" : ""}${t !== undefined ? ", time:T" : ""}})`,
  set_transform: (kf, t) =>
    `OPS.set_transform({compId:1, layerId:2, properties:{opacity:7}${kf ? ", keyframe:true" : ""}${t !== undefined ? ", time:T" : ""}})`,
};

function opCtx() {
  const ctx = makeCtx(["values.jsx", "transforms.jsx", "effects.jsx", "shapes.jsx"]);
  run(ctx, "__effectAt = function () { return {}; }; __findEffectParam = function () { return PROP; };");
  return ctx;
}

for (const [op, call] of Object.entries(OPS_UNDER_TEST)) {
  for (const [label, kf, t, keys, want] of MATRIX) {
    check(`${op}: ${label}`, () => {
      const ctx = opCtx();
      ctx.T = t;
      run(ctx, `PROP = new MockProp("P", 0, ${keys}); PROPS = { Opacity: PROP };`);
      const r = run(ctx, call(kf, t));
      assert.equal(r.ok, true);
      assert.deepEqual(plain(run(ctx, "PROP.writes")), want);
    });
  }
  check(`${op}: keyframe:true without time is refused by name, nothing written`, () => {
    const ctx = opCtx();
    run(ctx, 'PROP = new MockProp("P", 0, 1); PROPS = { Opacity: PROP };');
    assert.throws(() => run(ctx, call(true, undefined)), new RegExp(`${op}: keyframe:true needs \`time\``));
    assert.deepEqual(plain(run(ctx, "PROP.writes")), []);
  });
  check(`${op}: #129's false throw on a static write is absorbed`, () => {
    const ctx = opCtx();
    run(ctx, 'PROP = new MockProp("P", 0); PROP.throwOn = "static"; PROPS = { Opacity: PROP };');
    assert.equal(run(ctx, call(false, undefined)).ok, true);
    assert.equal(run(ctx, "PROP.v"), 7);
  });
}

// ---------- set_transform's guards still wrap the helper ----------

check("set_transform: a property reporting canSetExpression:false is refused before any write", () => {
  const ctx = opCtx();
  run(ctx, 'PROPS = { Position: new MockProp("Position", [0,0]), Opacity: new MockProp("Opacity", 0) }; PROPS.Opacity.canSetExpression = false;');
  assert.throws(
    () => run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{position:[1,2], opacity:7}})"),
    /cannot set opacity \(hidden on this layer\)\. Nothing was changed/
  );
  assert.deepEqual(plain(run(ctx, "PROPS.Position.writes.concat(PROPS.Opacity.writes)")), []);
});

check("set_transform: a write that throws mid-call names what already landed", () => {
  const ctx = opCtx();
  run(ctx, 'PROPS = { Position: new MockProp("Position", [0,0]), Opacity: new MockProp("Opacity", 0) }; PROPS.Opacity.throwOn = "hidden";');
  let err;
  try {
    run(ctx, "OPS.set_transform({compId:1, layerId:2, properties:{position:[1,2], opacity:7}})");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a throwing write must not report ok");
  assert.match(err.message, /could not set opacity/);
  assert.match(err.message, /Already written in this call: position\./);
  assert.match(err.message, /hidden on this layer; drop opacity/);
});

console.log(`set-or-key: ${passed} checks passed`);
