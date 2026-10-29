// retime_keyframes and copy_animation (issue #180), against a mock AE DOM.
//
// After Effects cannot move a key: it is read, removed and written again. The
// bug class these ops exist to end is the hand-rolled version of that, which
// keeps the value and quietly drops the feel — the eases, the hold, the
// tangents, the roving and auto-bezier flags. So the mock keyframes below carry
// every one of those, and every check reads them back after the op.
//
// The mock copies two measured After Effects behaviours that decide the code's
// shape, so a rewrite that forgets them fails here rather than in a project:
//   - setTemporalEaseAtKey turns BOTH sides bezier (measured on 26.5) — a hold
//     side survives only if the types are written after the ease;
//   - setTemporalEaseAtKey wants an array whose length belongs to the property
//     and throws a bare "parameter 2" otherwise (issue #50).
//
// What it cannot prove: that AE's spatial ease speed is unsigned (so a reversed
// Position keeps its sign), that setSpatialTangentsAtKey leaves auto-bezier as
// written in the order used, and how AE settles a roving key. Those are the
// live checks named in the PR.
//
//   node tests/unit/retime-animation.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const sources = ["ids.jsx", "keyframes.jsx", "expressions.jsx", "retime.jsx"].map((f) => [
  f,
  fs.readFileSync(path.join(jsxDir, f), "utf8"),
]);

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`retime-animation FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// The mock DOM
// ---------------------------------------------------------------------------

const PT = { PROPERTY: "PROPERTY", NAMED_GROUP: "NAMED_GROUP", INDEXED_GROUP: "INDEXED_GROUP" };
const KIT = { LINEAR: "linear", BEZIER: "bezier", HOLD: "hold" };

class KeyframeEase {
  constructor(speed, influence) {
    this.speed = speed;
    this.influence = influence;
  }
}

const ease = (influence, speed, n = 1) => Array.from({ length: n }, () => ({ influence, speed }));

class MockProp {
  constructor(name, matchName, { arity = 1, isSpatial = false, value = 0 } = {}) {
    this.name = name;
    this.matchName = matchName;
    this.propertyType = PT.PROPERTY;
    this.arity = arity;
    this.isSpatial = isSpatial;
    this.canVaryOverTime = true;
    this.canSetExpression = true;
    this.expression = "";
    this.expressionEnabled = false;
    this.expressionError = "";
    this._value = value;
    this.keys = [];
    this.writes = 0;
  }
  get value() { return this._value; }
  get numKeys() { return this.keys.length; }
  _k(i) {
    const k = this.keys[i - 1];
    if (!k) throw new Error(`After Effects error: no key ${i} on ${this.name}`);
    return k;
  }
  /** A key as a test writes it: everything defaulted that it does not name. */
  addKey(time, value, o = {}) {
    this.keys.push({
      time, value,
      inType: KIT.BEZIER, outType: KIT.BEZIER,
      inEase: ease(16.666, 0, this.arity), outEase: ease(16.666, 0, this.arity),
      tCont: false, tAuto: false,
      inTan: [0, 0], outTan: [0, 0], sCont: false, sAuto: false, roving: false,
      label: 0,
      ...o,
    });
    this.keys.sort((a, b) => a.time - b.time);
    return this;
  }
  keyTime(i) { return this._k(i).time; }
  keyValue(i) { return this._k(i).value; }
  keyInInterpolationType(i) { return this._k(i).inType; }
  keyOutInterpolationType(i) { return this._k(i).outType; }
  keyInTemporalEase(i) { return this._k(i).inEase.map((e) => new KeyframeEase(e.speed, e.influence)); }
  keyOutTemporalEase(i) { return this._k(i).outEase.map((e) => new KeyframeEase(e.speed, e.influence)); }
  keyTemporalContinuous(i) { return this._k(i).tCont; }
  keyTemporalAutoBezier(i) { return this._k(i).tAuto; }
  keyInSpatialTangent(i) { if (!this.isSpatial) throw new Error("not spatial"); return this._k(i).inTan.slice(); }
  keyOutSpatialTangent(i) { if (!this.isSpatial) throw new Error("not spatial"); return this._k(i).outTan.slice(); }
  keySpatialContinuous(i) { if (!this.isSpatial) throw new Error("not spatial"); return this._k(i).sCont; }
  keySpatialAutoBezier(i) { if (!this.isSpatial) throw new Error("not spatial"); return this._k(i).sAuto; }
  keyRoving(i) { if (!this.isSpatial) throw new Error("not spatial"); return this._k(i).roving; }
  keyLabel(i) { return this._k(i).label; }

  setValueAtTime(t, v) {
    this.writes++;
    const at = this.keys.find((k) => Math.abs(k.time - t) < 0.001);
    if (at) { at.value = v; return; }
    // A fresh key gets AE's defaults, not anything the op meant.
    this.keys.push({
      time: t, value: v, inType: KIT.LINEAR, outType: KIT.LINEAR,
      inEase: ease(16.666, 0, this.arity), outEase: ease(16.666, 0, this.arity),
      tCont: false, tAuto: false, inTan: [0, 0], outTan: [0, 0], sCont: false, sAuto: true, roving: false, label: 0,
    });
    this.keys.sort((a, b) => a.time - b.time);
  }
  removeKey(i) { this.writes++; this._k(i); this.keys.splice(i - 1, 1); }
  setTemporalEaseAtKey(i, inArr, outArr) {
    this.writes++;
    if (inArr.length !== this.arity || outArr.length !== this.arity) throw new Error("After Effects error: parameter 2");
    const k = this._k(i);
    // Array.from, not .map: the arrays come from the vm realm, and a host-realm
    // copy keeps deepEqual honest.
    k.inEase = Array.from(inArr, (e) => ({ influence: e.influence, speed: e.speed }));
    k.outEase = Array.from(outArr, (e) => ({ influence: e.influence, speed: e.speed }));
    // Measured on 26.5: both sides become bezier.
    k.inType = KIT.BEZIER;
    k.outType = KIT.BEZIER;
  }
  setInterpolationTypeAtKey(i, a, b) { this.writes++; const k = this._k(i); k.inType = a; k.outType = b ?? a; }
  setTemporalContinuousAtKey(i, v) { this.writes++; this._k(i).tCont = v; }
  setTemporalAutoBezierAtKey(i, v) { this.writes++; this._k(i).tAuto = v; }
  setSpatialContinuousAtKey(i, v) { this.writes++; this._k(i).sCont = v; }
  setSpatialAutoBezierAtKey(i, v) { this.writes++; this._k(i).sAuto = v; }
  setSpatialTangentsAtKey(i, a, b) {
    this.writes++;
    const k = this._k(i);
    k.inTan = Array.from(a); k.outTan = Array.from(b); k.sAuto = false;
  }
  setRovingAtKey(i, v) {
    this.writes++;
    if (v && (i === 1 || i === this.keys.length)) throw new Error("After Effects error: first and last keys cannot rove");
    this._k(i).roving = v;
  }
  setLabelAtKey(i, v) { this.writes++; this._k(i).label = v; }
}

class MockGroup {
  constructor(name, matchName, children, type = PT.NAMED_GROUP) {
    this.name = name;
    this.matchName = matchName;
    this.propertyType = type;
    this.children = [];
    for (const c of children) this.adopt(c);
  }
  adopt(c) {
    this.children.push(c);
    c.parentProperty = this;
    c.propertyIndex = this.children.length;
  }
  get numProperties() { return this.children.length; }
  property(k) {
    if (typeof k === "number") return this.children[k - 1] ?? null;
    return this.children.find((c) => c.name === k || c.matchName === k) ?? null;
  }
}

/** Depth is derived after the tree is built, as AE reports it. */
function setDepths(node, depth) {
  node.propertyDepth = depth;
  for (const c of node.children ?? []) setDepths(c, depth + 1);
}

class MockLayer extends MockGroup {
  constructor(id, name, { startTime = 0, effects = [] } = {}) {
    const transform = new MockGroup("Transform", "ADBE Transform Group", [
      new MockProp("Position", "ADBE Position", { isSpatial: true, arity: 1, value: [0, 0] }),
      new MockProp("Scale", "ADBE Scale", { arity: 3, value: [100, 100] }),
      new MockProp("Rotation", "ADBE Rotate Z", { value: 0 }),
      new MockProp("Opacity", "ADBE Opacity", { value: 100 }),
    ]);
    const marker = new MockProp("Marker", "ADBE Marker");
    const fx = new MockGroup("Effects", "ADBE Effect Parade", effects, PT.INDEXED_GROUP);
    super(name, "ADBE AV Layer", [marker, transform, fx]);
    this.id = id;
    this.startTime = startTime;
    this.timeRemapEnabled = false;
    this.parentProperty = null;
    setDepths(this, 0);
  }
  p(...path) {
    let cur = this;
    for (const s of path) cur = cur.property(s);
    return cur;
  }
}

const blur = (name, value = 0) =>
  new MockGroup(name, "ADBE Gaussian Blur 2", [new MockProp("Blurriness", "ADBE Gaussian Blur 2-0001", { value })]);

class CompItem {
  constructor(id, layers, frameRate = 30) {
    this.id = id;
    this.layers = layers;
    this.frameDuration = 1 / frameRate;
  }
  get numLayers() { return this.layers.length; }
  layer(i) { return this.layers[i - 1]; }
}

function makeWorld(comps) {
  const items = new Map(comps.map((c) => [c.id, c]));
  const ctx = {
    OPS: {},
    Math, String, Error, isFinite,
    app: { project: { itemByID: (id) => items.get(id) ?? null } },
    CompItem,
    KeyframeEase,
    KeyframeInterpolationType: KIT,
    PropertyType: PT,
    PropertyValueType: { OneD: "OneD", TwoD: "TwoD", ThreeD: "ThreeD", TwoD_SPATIAL: "TwoD_SPATIAL", ThreeD_SPATIAL: "ThreeD_SPATIAL", COLOR: "COLOR" },
    noUndo: (fn) => fn,
  };
  vm.createContext(ctx);
  for (const [file, src] of sources) vm.runInContext(src, ctx, { filename: file });
  return ctx;
}

// Results come from the vm realm; a host copy keeps deepEqual about values.
const plain = (x) => JSON.parse(JSON.stringify(x));
const snap = (prop) => JSON.parse(JSON.stringify(prop.keys));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

// ---------------------------------------------------------------------------
// retime_keyframes
// ---------------------------------------------------------------------------

check("offset + scale: every attribute survives, speeds rescale, hold stays hold", () => {
  const l = new MockLayer(1, "Card");
  const op = l.p("Transform", "Opacity");
  op.addKey(1, 0, { outEase: [{ influence: 80, speed: 0 }], inEase: [{ influence: 10, speed: 5 }], label: 3 })
    .addKey(2, 100, { inEase: [{ influence: 60, speed: 40 }], outType: KIT.HOLD, tCont: false })
    .addKey(3, 50, { inType: KIT.LINEAR, outType: KIT.LINEAR });
  const sc = l.p("Transform", "Scale");
  // Per-dimension eases at the property's own arity (3 for a 2D Scale).
  sc.addKey(1, [0, 0], { outEase: [{ influence: 70, speed: 10 }, { influence: 50, speed: 20 }, { influence: 33, speed: 0 }], inEase: ease(16.666, 0, 3) })
    .addKey(2, [100, 100], { inEase: [{ influence: 90, speed: 0 }, { influence: 80, speed: 0 }, { influence: 33, speed: 0 }], outEase: ease(16.666, 0, 3) });
  const ctx = makeWorld([new CompItem(10, [l])]);

  const res = plain(ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], offset: 0.5, scale: 2 }));
  assert.equal(res.ok, true);
  // Pivot defaults to the first key (1s): 1 -> 1.5, 2 -> 3.5, 3 -> 5.5.
  assert.deepEqual(op.keys.map((k) => +k.time.toFixed(6)), [1.5, 3.5, 5.5]);
  assert.deepEqual(op.keys.map((k) => k.value), [0, 100, 50]);
  assert.equal(op.keys[1].outType, KIT.HOLD, "the hold must survive the ease write");
  assert.equal(op.keys[1].inType, KIT.BEZIER);
  assert.deepEqual([op.keys[2].inType, op.keys[2].outType], [KIT.LINEAR, KIT.LINEAR]);
  assert.equal(op.keys[0].outEase[0].influence, 80, "influence is a share of the interval — unchanged");
  near(op.keys[0].inEase[0].speed, 2.5, "speed halves when the time doubles");
  near(op.keys[1].inEase[0].speed, 20, "speed halves when the time doubles");
  assert.equal(op.keys[0].label, 3);
  assert.deepEqual(sc.keys.map((k) => +k.time.toFixed(6)), [1.5, 3.5]);
  assert.deepEqual(sc.keys[0].outEase.map((e) => e.influence), [70, 50, 33], "per-dimension eases kept entry for entry");
  assert.deepEqual(sc.keys[0].outEase.map((e) => e.speed), [5, 10, 0]);
  assert.deepEqual(res.layers[0].properties.map((p) => p.path.join(" > ")).sort(), ["Transform > Opacity", "Transform > Scale"]);
});

check("reverse mirrors the span, swaps sides, and negates only a non-spatial speed", () => {
  const l = new MockLayer(1, "Dot");
  const op = l.p("Transform", "Opacity");
  op.addKey(0, 0, { outEase: [{ influence: 75, speed: 12 }], inType: KIT.HOLD, outType: KIT.BEZIER })
    .addKey(1, 100, { inEase: [{ influence: 20, speed: 3 }], inType: KIT.BEZIER, outType: KIT.LINEAR });
  const pos = l.p("Transform", "Position");
  pos.addKey(0, [0, 0], { inTan: [1, 1], outTan: [10, 0], outEase: [{ influence: 50, speed: 300 }] })
    .addKey(0.5, [50, 50], { roving: true, sCont: true, sAuto: true, tCont: true })
    .addKey(1, [100, 0], { inTan: [-10, 0], outTan: [2, 2], inEase: [{ influence: 40, speed: 100 }] });
  const ctx = makeWorld([new CompItem(10, [l])]);

  ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], reverse: true });
  assert.deepEqual(op.keys.map((k) => k.value), [100, 0], "values play backwards");
  assert.deepEqual([op.keys[0].inType, op.keys[0].outType], [KIT.LINEAR, KIT.BEZIER], "in/out types swap");
  assert.deepEqual([op.keys[1].inType, op.keys[1].outType], [KIT.BEZIER, KIT.HOLD]);
  assert.equal(op.keys[0].outEase[0].influence, 20);
  near(op.keys[0].outEase[0].speed, -3, "a 1D speed changes sign when the value runs the other way");
  near(op.keys[1].inEase[0].speed, -12, "a 1D speed changes sign");
  assert.deepEqual(pos.keys.map((k) => k.value), [[100, 0], [50, 50], [0, 0]]);
  assert.deepEqual([pos.keys[0].inTan, pos.keys[0].outTan], [[2, 2], [-10, 0]], "spatial tangents swap");
  assert.deepEqual([pos.keys[2].inTan, pos.keys[2].outTan], [[10, 0], [1, 1]]);
  assert.equal(pos.keys[0].outEase[0].speed, 100, "a speed along the motion path has no direction to flip");
  assert.equal(pos.keys[1].roving, true, "roving kept");
  assert.equal(pos.keys[1].sAuto, true, "spatial auto-bezier kept");
  assert.equal(pos.keys[1].sCont, true);
  assert.equal(pos.keys[1].tCont, true);
});

check("stagger shifts each layer by its place in the list", () => {
  const a = new MockLayer(1, "A");
  const b = new MockLayer(2, "B");
  const c = new MockLayer(3, "C");
  for (const l of [a, b, c]) l.p("Transform", "Rotation").addKey(1, 0).addKey(2, 90);
  const ctx = makeWorld([new CompItem(10, [a, b, c])]);
  const res = plain(ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 3 }, { layerId: 1 }, { layerId: 2 }], stagger: 0.2 }));
  const first = (l) => +l.p("Transform", "Rotation").keys[0].time.toFixed(6);
  assert.deepEqual([first(c), first(a), first(b)], [1, 1.2, 1.4]);
  assert.deepEqual(res.layers.map((l) => +l.shift.toFixed(6)), [0, 0.2, 0.4]);
});

check("keys squeezed onto one frame are refused, naming them, and nothing is written", () => {
  const l = new MockLayer(1, "Card");
  const op = l.p("Transform", "Opacity");
  op.addKey(1, 0).addKey(1.1, 50).addKey(2, 100);
  const before = snap(op);
  const ctx = makeWorld([new CompItem(10, [l])]);
  assert.throws(
    () => ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], scale: 0.1 }),
    (e) => /refused — nothing was changed/.test(e.message) && /Opacity/.test(e.message) && /merge into one key/.test(e.message)
  );
  assert.deepEqual(snap(op), before);
  assert.equal(op.writes, 0);
});

check("range: keys outside stay put, and landing on one is refused", () => {
  const l = new MockLayer(1, "Card");
  const op = l.p("Transform", "Opacity");
  op.addKey(0, 0).addKey(2, 50).addKey(3, 100);
  const ctx = makeWorld([new CompItem(10, [l])]);
  ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], range: { start: 1.5, end: 5 }, offset: 1 });
  assert.deepEqual(op.keys.map((k) => +k.time.toFixed(6)), [0, 3, 4]);
  const before = snap(op);
  assert.throws(
    () => ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], range: { start: 2.5, end: 5 }, offset: -3 }),
    /outside the range, not moved/
  );
  assert.deepEqual(snap(op), before);
});

check("frame snapping, and keys with no keys to move are refused when named", () => {
  const l = new MockLayer(1, "Card");
  l.p("Transform", "Opacity").addKey(0, 0).addKey(1, 100);
  const ctx = makeWorld([new CompItem(10, [l], 25)]);
  ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], offset: 0.013 });
  near(l.p("Transform", "Opacity").keys[0].time, 0, "0.013s rounds to frame 0 at 25fps");
  assert.throws(
    () => ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1, propertyPaths: [["Transform", "Rotation"]] }], offset: 1 }),
    /Rotation has no keyframes to retime/
  );
  assert.throws(
    () => ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }, { layerId: 1 }], offset: 1 }),
    /listed twice/
  );
});

check("an attribute that does not read back is a failure, not an ok", () => {
  const l = new MockLayer(1, "Card");
  const op = l.p("Transform", "Opacity");
  op.addKey(0, 0, { tCont: true }).addKey(1, 100);
  op.setTemporalContinuousAtKey = function () { this.writes++; }; // AE ignoring it
  const ctx = makeWorld([new CompItem(10, [l])]);
  assert.throws(
    () => ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], offset: 1 }),
    (e) => /did not read back as written/.test(e.message) && /temporal continuous/.test(e.message) && /undo/.test(e.message)
  );
});

check("an expression on a retimed property is reported, since it does not move", () => {
  const l = new MockLayer(1, "Card");
  const op = l.p("Transform", "Opacity");
  op.addKey(0, 0).addKey(1, 100);
  op.expression = "value * Math.min(time, 1)";
  op.expressionEnabled = true;
  const ctx = makeWorld([new CompItem(10, [l])]);
  const res = plain(ctx.OPS.retime_keyframes({ compId: 10, layers: [{ layerId: 1 }], offset: 1 }));
  assert.equal(res.expressionsNotRetimed.length, 1);
  assert.match(res.expressionsNotRetimed[0], /Opacity/);
});

// ---------------------------------------------------------------------------
// copy_animation
// ---------------------------------------------------------------------------

function sourceLayer() {
  const s = new MockLayer(1, "Source", { startTime: 0, effects: [blur("Blur A"), blur("Blur B")] });
  s.p("Transform", "Position")
    .addKey(0, [0, 0], { outTan: [30, 0], outEase: [{ influence: 66, speed: 200 }], label: 2 })
    .addKey(0.5, [50, 0], { roving: true, sAuto: true })
    .addKey(1, [100, 0], { inTan: [-30, 0], inType: KIT.BEZIER, outType: KIT.HOLD });
  s.p("Transform", "Scale").addKey(0, [0, 0], {
    outEase: [{ influence: 90, speed: 1 }, { influence: 45, speed: 2 }, { influence: 33, speed: 0 }],
  }).addKey(1, [100, 100], { tAuto: true, tCont: true });
  s.p("Effects", 2, "Blurriness").addKey(0, 10).addKey(1, 0);
  const rot = s.p("Transform", "Rotation");
  rot.expression = "wiggle(2, 5)";
  rot.expressionEnabled = true;
  return s;
}

check("copy carries every key attribute, routes effects by index, and staggers targets", () => {
  const s = sourceLayer();
  const t1 = new MockLayer(2, "T1", { effects: [blur("x"), blur("y")] });
  const t2 = new MockLayer(3, "T2", { effects: [blur("x"), blur("y")] });
  const ctx = makeWorld([new CompItem(10, [s, t1, t2])]);
  const res = plain(ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ layerId: 2 }, { layerId: 3 }], offset: 1, stagger: 0.5 }));
  assert.equal(res.ok, true);
  for (const [t, shift] of [[t1, 1], [t2, 1.5]]) {
    const pos = t.p("Transform", "Position");
    assert.deepEqual(pos.keys.map((k) => k.time), [shift, shift + 0.5, shift + 1]);
    assert.deepEqual(pos.keys[0].outTan, [30, 0]);
    assert.equal(pos.keys[0].outEase[0].influence, 66);
    assert.equal(pos.keys[0].outEase[0].speed, 200, "copy does not stretch, so speed is untouched");
    assert.equal(pos.keys[0].label, 2);
    assert.equal(pos.keys[0].sAuto, false, "explicit tangents stay explicit");
    assert.equal(pos.keys[1].roving, true);
    assert.equal(pos.keys[1].sAuto, true);
    assert.equal(pos.keys[2].outType, KIT.HOLD);
    const sc = t.p("Transform", "Scale");
    assert.deepEqual(sc.keys[0].outEase.map((e) => e.influence), [90, 45, 33]);
    assert.equal(sc.keys[1].tAuto, true);
    assert.equal(sc.keys[1].tCont, true);
    assert.equal(t.p("Effects", 1, "Blurriness").numKeys, 0, "Blur A's twin is untouched");
    assert.deepEqual(t.p("Effects", 2, "Blurriness").keys.map((k) => k.value), [10, 0], "the second blur, by index");
    assert.equal(t.p("Transform", "Rotation").expression, "wiggle(2, 5)");
    assert.equal(t.p("Transform", "Rotation").expressionEnabled, true);
    assert.equal(t.p("Marker").numKeys, 0);
  }
  assert.deepEqual(res.targets.map((t) => [t.layerId, t.shift, t.properties, t.expressions]), [[2, 1, 4, 1], [3, 1.5, 4, 1]]);
  assert.deepEqual(s.p("Transform", "Position").keys.map((k) => k.time), [0, 0.5, 1], "the source is untouched");
});

check("an animated target is refused without replaceExisting, and replaced with it", () => {
  const s = sourceLayer();
  const t = new MockLayer(2, "T", { effects: [blur("x"), blur("y")] });
  t.p("Transform", "Scale").addKey(3, [50, 50]).addKey(4, [60, 60]);
  const ctx = makeWorld([new CompItem(10, [s, t])]);
  const before = snap(t.p("Transform", "Scale"));
  assert.throws(
    () => ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ layerId: 2 }] }),
    (e) => /nothing was changed/.test(e.message) && /Scale already has 2 keyframes/.test(e.message) && /replaceExisting/.test(e.message)
  );
  assert.deepEqual(snap(t.p("Transform", "Scale")), before);
  assert.equal(t.p("Transform", "Position").numKeys, 0, "no other property was written either");
  ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ layerId: 2 }], replaceExisting: true });
  assert.deepEqual(t.p("Transform", "Scale").keys.map((k) => k.time), [0, 1]);
});

check("a target without the matching property is refused, naming it", () => {
  const s = sourceLayer();
  const t = new MockLayer(2, "T", { effects: [blur("only one")] });
  const ctx = makeWorld([new CompItem(10, [s, t])]);
  assert.throws(
    () => ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ layerId: 2 }] }),
    (e) => /no matching property/.test(e.message) && /Blur B > Blurriness/.test(e.message)
  );
  assert.equal(t.p("Transform", "Position").numKeys, 0);
});

check("copy across comps, by layer start, with propertyPaths and expressions off", () => {
  const s = sourceLayer();
  const t = new MockLayer(7, "Other", { startTime: 2 });
  const ctx = makeWorld([new CompItem(10, [s]), new CompItem(20, [t])]);
  const res = plain(ctx.OPS.copy_animation({
    compId: 10, layerId: 1, targets: [{ compId: 20, layerId: 7 }], align: "layerStart",
    propertyPaths: [["Transform", "Position"]], expressions: false,
  }));
  assert.deepEqual(t.p("Transform", "Position").keys.map((k) => k.time), [2, 2.5, 3]);
  assert.equal(res.targets[0].compId, 20);
  assert.throws(
    () => ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ compId: 20, layerId: 7 }], propertyPaths: [["Transform", "Rotation"]], expressions: false }),
    /Rotation has no keyframes to copy/
  );
  assert.equal(t.p("Transform", "Rotation").expression, "");
});

check("the source layer is not a target", () => {
  const s = sourceLayer();
  const ctx = makeWorld([new CompItem(10, [s])]);
  assert.throws(() => ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ layerId: 1 }] }), /is the source layer/);
});

check("an expression that will not evaluate on the target fails the call after the copy", () => {
  const s = sourceLayer();
  const t = new MockLayer(2, "T", { effects: [blur("x"), blur("y")] });
  const rot = t.p("Transform", "Rotation");
  Object.defineProperty(rot, "expressionError", { get() { return this.expression ? "Error: wiggle is not defined" : ""; } });
  const ctx = makeWorld([new CompItem(10, [s, t])]);
  assert.throws(
    () => ctx.OPS.copy_animation({ compId: 10, layerId: 1, targets: [{ layerId: 2 }] }),
    (e) => /copied everything/.test(e.message) && /wiggle is not defined/.test(e.message) && /Rotation/.test(e.message)
  );
  assert.equal(t.p("Transform", "Position").numKeys, 3, "the copy itself landed, as the message says");
});

console.log(`retime-animation: ${passed} checks passed`);
