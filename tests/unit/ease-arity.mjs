// The ease-array sizing in packages/jsx/keyframes.jsx, against a mock property.
//
// setTemporalEaseAtKey wants one KeyframeEase per "dimension" of the property,
// and the count belongs to the property rather than to its value: a 2D Scale
// takes 2, a shape Ellipse Size takes 3 while its value reads [w,h], Opacity
// and sliders take 1, and a spatial Position takes 1 whether the layer is 2D or
// 3D. The wrong count throws a bare "parameter 2" — no property, no expected
// number — which is why an agent easing three properties in a row hit it three
// times and ended up writing a try/catch ladder by hand (issue #50).
//
// What this locks in:
//   - the derivation, per value type, with isSpatial outranking all of it;
//   - that the derivation is TRIED FIRST, so the ordinary property costs one
//     call and not a ladder;
//   - that the retry still rescues the case the table gets wrong;
//   - that one {influence, speed} pair reaches every entry unchanged;
//   - that the count that worked is reported, and that a total failure throws
//     naming what was tried rather than leaving an unset ease behind an ok.
//
// There is no ExtendScript runtime on a runner, so the property is stubbed:
// isSpatial, propertyValueType, value and setTemporalEaseAtKey are all the
// sizing code touches.
//
//   node tests/unit/ease-arity.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "keyframes.jsx"), "utf8");

const VALUE_TYPES = {
  OneD: "OneD",
  TwoD: "TwoD",
  TwoD_SPATIAL: "TwoD_SPATIAL",
  ThreeD: "ThreeD",
  ThreeD_SPATIAL: "ThreeD_SPATIAL",
  COLOR: "COLOR",
  SHAPE: "SHAPE",
};

function makeContext() {
  const ctx = {
    OPS: {},
    Math,
    String,
    Error,
    isFinite,
    KeyframeInterpolationType: { LINEAR: "linear", BEZIER: "bezier", HOLD: "hold" },
    PropertyValueType: VALUE_TYPES,
    KeyframeEase: class {
      constructor(speed, influence) {
        this.speed = speed;
        this.influence = influence;
      }
    },
    noUndo: (fn) => fn,
    // The keyframe ops resolve their property through these; the tests that
    // exercise a whole op install their own.
    getCompById: () => { throw new Error("not stubbed"); },
    getLayerById: () => { throw new Error("not stubbed"); },
    walkProperty: () => { throw new Error("not stubbed"); },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "keyframes.jsx" });
  return ctx;
}

/**
 * A property that accepts exactly the ease-array lengths in `accepts` and
 * throws AE's own unhelpful message for everything else. `attempts` records the
 * lengths tried, in order — which is how the fast path is told from the ladder.
 */
function makeProp({ isSpatial = false, valueType, value, accepts, name = "Some Property" }) {
  const prop = {
    name,
    isSpatial,
    propertyValueType: valueType,
    value,
    numKeys: 1,
    attempts: [],
    applied: null,
    keyTime: () => 0,
    keyInInterpolationType: () => "bezier",
    keyOutInterpolationType: () => "bezier",
    setInterpolationTypeAtKey() {},
    setValueAtTime() {},
    setTemporalEaseAtKey(keyIndex, inArr, outArr) {
      prop.attempts.push(inArr.length);
      if (!accepts.includes(inArr.length)) {
        // Verbatim shape of what AE says, which is the whole problem.
        throw new Error("After Effects error: Unable to execute script at line 1. parameter 2");
      }
      assert.equal(outArr.length, inArr.length, "AE takes the same length on both sides");
      prop.applied = { keyIndex, inArr, outArr };
    },
  };
  return prop;
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`ease-arity FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const EASE_IN = { influence: 75, speed: 0 };
const EASE_OUT = { influence: 25, speed: 10 };

// ---------- the derivation, and that it is tried first ----------

const derivations = [
  ["Opacity", { valueType: VALUE_TYPES.OneD, value: 100, accepts: [1] }, 1],
  ["a slider effect control", { valueType: VALUE_TYPES.OneD, value: 0, accepts: [1] }, 1],
  ["2D Scale", { valueType: VALUE_TYPES.TwoD, value: [100, 100], accepts: [2] }, 2],
  ["3D Scale", { valueType: VALUE_TYPES.ThreeD, value: [100, 100, 100], accepts: [3] }, 3],
  ["a colour", { valueType: VALUE_TYPES.COLOR, value: [1, 0, 0, 1], accepts: [4] }, 4],
  ["2D Position", { isSpatial: true, valueType: VALUE_TYPES.TwoD_SPATIAL, value: [0, 0], accepts: [1] }, 1],
  ["3D Position", { isSpatial: true, valueType: VALUE_TYPES.ThreeD_SPATIAL, value: [0, 0, 0], accepts: [1] }, 1],
];

for (const [label, spec, expected] of derivations) {
  check(`${label} is sized right first time`, () => {
    const ctx = makeContext();
    const prop = makeProp(spec);
    const n = ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT);
    assert.equal(n, expected, `${label} should take ${expected} ease entries`);
    assert.deepEqual(prop.attempts, [expected], `${label} must not cost a retry ladder`);
  });
}

check("isSpatial outranks the value type and the value's own length", () => {
  // The trap in the other direction: a 3D Position whose property would also
  // accept 3 entries. AE means something different by those three (one per
  // axis, rather than one along the motion path), so the derivation must not
  // reach for the value's shape when the property says it is spatial.
  const ctx = makeContext();
  const prop = makeProp({
    isSpatial: true,
    valueType: VALUE_TYPES.ThreeD_SPATIAL,
    value: [0, 0, 0],
    accepts: [1, 3],
  });
  assert.equal(ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT), 1);
  assert.deepEqual(prop.attempts, [1]);
});

check("falls back to the value's length when AE reports no value type", () => {
  const ctx = makeContext();
  const prop = makeProp({ valueType: undefined, value: [1, 2, 3], accepts: [3] });
  assert.equal(ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT), 3);
  assert.deepEqual(prop.attempts, [3]);
});

check("falls back to 1 for a property with neither a value type nor a length", () => {
  const ctx = makeContext();
  const prop = makeProp({ valueType: undefined, value: undefined, accepts: [1] });
  assert.equal(ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT), 1);
});

// ---------- the retry, which is the point of the whole exercise ----------

check("a shape Ellipse Size wanting 3 is found by retry, and reported", () => {
  // The case from the report: the value reads [width, height] and every honest
  // reading of it says 2, but AE wants 3. No table gets this right from the
  // outside, which is why the ladder exists behind the derivation.
  const ctx = makeContext();
  const prop = makeProp({
    name: "Size",
    valueType: VALUE_TYPES.TwoD,
    value: [68, 68],
    accepts: [3],
  });
  const n = ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT);
  assert.equal(n, 3, "the caller has to be told the real answer, not just get one");
  assert.deepEqual(prop.attempts, [2, 1, 3], "derived first, then the rest in order");
});

check("every plausible count is tried before giving up", () => {
  const ctx = makeContext();
  const prop = makeProp({ valueType: VALUE_TYPES.OneD, value: 0, accepts: [4] });
  assert.equal(ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT), 4);
  assert.deepEqual(prop.attempts, [1, 2, 3, 4]);
});

check("a property that accepts nothing throws, naming what was tried", () => {
  const ctx = makeContext();
  const prop = makeProp({ name: "Impossible", valueType: VALUE_TYPES.OneD, value: 0, accepts: [] });
  assert.throws(
    () => ctx.__applyTemporalEase(prop, 4, EASE_IN, EASE_OUT),
    (e) => {
      assert.match(e.message, /Impossible/, "name the property");
      assert.match(e.message, /key 4/, "name the keyframe");
      assert.match(e.message, /1, 2, 3, 4/, "name every count it tried");
      assert.match(e.message, /parameter 2/, "pass AE's own last words through");
      return true;
    },
  );
  assert.deepEqual(prop.attempts, [1, 2, 3, 4]);
});

// ---------- one pair, every dimension ----------

check("the caller's single pair reaches every entry unchanged", () => {
  const ctx = makeContext();
  const prop = makeProp({ valueType: VALUE_TYPES.ThreeD, value: [1, 2, 3], accepts: [3] });
  ctx.__applyTemporalEase(prop, 1, EASE_IN, EASE_OUT);
  assert.equal(prop.applied.inArr.length, 3);
  for (const e of prop.applied.inArr) {
    assert.equal(e.influence, 75);
    assert.equal(e.speed, 0);
  }
  for (const e of prop.applied.outArr) {
    assert.equal(e.influence, 25);
    assert.equal(e.speed, 10);
  }
});

check("one side given, the other defaults rather than being left unset", () => {
  const ctx = makeContext();
  const prop = makeProp({ valueType: VALUE_TYPES.TwoD, value: [0, 0], accepts: [2] });
  ctx.__applyTemporalEase(prop, 1, EASE_IN, undefined);
  assert.equal(prop.applied.outArr.length, 2, "AE requires both arrays whatever the caller sent");
  assert.equal(prop.applied.outArr[0].influence, 33);
});

// ---------- through the ops ----------

function withProp(prop) {
  const ctx = makeContext();
  ctx.getCompById = () => ({ id: 1 });
  ctx.getLayerById = () => ({ id: 2 });
  ctx.walkProperty = () => prop;
  return ctx;
}

check("set_temporal_ease reports the count it resolved", () => {
  const prop = makeProp({ valueType: VALUE_TYPES.TwoD, value: [68, 68], accepts: [3] });
  const ctx = withProp(prop);
  const r = ctx.OPS.set_temporal_ease({ compId: 1, layerId: 2, propertyPath: ["Size"], keyIndex: 1, easeIn: EASE_IN, easeOut: EASE_OUT });
  assert.equal(r.ok, true);
  assert.equal(r.easeDimensions, 3, "the answer for this property has to come back out");
});

check("set_temporal_ease with neither ease refuses instead of reporting ok", () => {
  const prop = makeProp({ valueType: VALUE_TYPES.OneD, value: 0, accepts: [1] });
  const ctx = withProp(prop);
  assert.throws(
    () => ctx.OPS.set_temporal_ease({ compId: 1, layerId: 2, propertyPath: ["Opacity"], keyIndex: 1 }),
    /needs easeIn, easeOut or both/,
  );
  assert.deepEqual(prop.attempts, [], "nothing should have been attempted");
});

check("add_keyframe eases through the same path and reports the count", () => {
  const prop = makeProp({ valueType: VALUE_TYPES.TwoD, value: [100, 100], accepts: [2] });
  const ctx = withProp(prop);
  const r = ctx.OPS.add_keyframe({
    compId: 1, layerId: 2, propertyPath: ["Transform", "Scale"], time: 0, value: [100, 100],
    interpolation: { in: "bezier", out: "bezier", easeIn: EASE_IN, easeOut: EASE_OUT },
  });
  assert.equal(r.ok, true);
  assert.equal(r.easeDimensions, 2);
});

check("add_keyframe without an ease says nothing about ease dimensions", () => {
  const prop = makeProp({ valueType: VALUE_TYPES.TwoD, value: [100, 100], accepts: [2] });
  const ctx = withProp(prop);
  const r = ctx.OPS.add_keyframe({ compId: 1, layerId: 2, propertyPath: ["Transform", "Scale"], time: 0, value: [100, 100] });
  assert.equal(r.ok, true);
  assert.equal("easeDimensions" in r, false, "a field that means nothing here should not be there");
  assert.deepEqual(prop.attempts, []);
});

console.log(`ease-arity: ${passed} checks passed`);
