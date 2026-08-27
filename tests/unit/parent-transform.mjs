// parent_layer's preserveTransform arithmetic, against a mock AE DOM.
//
// What this proves and what it does not: it runs the real OPS.parent_layer out
// of packages/jsx/layers.jsx against a fake layer graph whose parenting is
// deliberately broken the way issue #28 describes — the compensation reads the
// parent from a stale snapshot, so a grandchild lands at W - parentWorld twice
// over. It checks that the correction puts the layer back, that it writes
// nothing when the mock compensates correctly, and that it survives both
// readings of what a child's Position means in its parent's space.
//
// It cannot prove which of those two readings After Effects actually uses, or
// that AE's own compensation looks like this mock's. Those are the AE-side
// checks in the PR. What it does prove is that the algebra is right: the
// matrix chain, the R·S decomposition, and the rule that Position is only
// rewritten when AE's answer matches neither reading.
//
//   node tests/unit/parent-transform.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "layers.jsx"), "utf8");

// ---------- the mock DOM ----------

class Prop {
  constructor(v) { this.v = v; this.keys = null; this.expressionEnabled = false; }
  get numKeys() { return this.keys ? this.keys.length : 0; }
  get value() { return this.keys ? this.keys[0] : this.v; }
  valueAtTime() { return this.value; }
  setValue(x) {
    assert.equal(this.keys, null, "setValue on a keyframed property would throw in AE");
    this.v = x;
  }
  keyValue(i) { return this.keys[i - 1]; }
  setValueAtKey(i, x) { this.keys[i - 1] = x; }
}

// Layer-space model: a child's Position is a point in the parent's layer space,
// so it goes through the parent's own matrix. Anchor-relative: Position is an
// offset from where the parent's anchor lands. The two differ by the parent's
// anchor, and coincide when every anchor above is [0,0].
let MODEL = "layer-space";

class MockLayer {
  constructor(name, tr) {
    this.name = name;
    this.threeDLayer = false;
    this.enabled = true; this.solo = false; this.locked = false; this.shy = false;
    this.label = 0; this.inPoint = 0; this.outPoint = 5; this.startTime = 0; this.stretch = 100;
    this.blendingMode = 0;
    this.index = 1;
    this.id = tr.id;
    this.nullLayer = true;          // keeps __layerKind off the source branches
    this.adjustmentLayer = false;
    this._parent = null;
    this.props = {
      Position: new Prop(tr.position.slice()),
      "Anchor Point": new Prop((tr.anchor || [0, 0]).slice()),
      Scale: new Prop((tr.scale || [100, 100]).slice()),
      Rotation: new Prop(tr.rotation || 0),
    };
    // What a broken compensation reads instead of the live parent.
    this.staleParentMatrix = null;
  }
  property(n) {
    assert.equal(n, "Transform");
    const self = this;
    return { property: (k) => self.props[k] };
  }
  get parent() { return this._parent; }
  set parent(p) {
    const worldBefore = worldMatrix(this);
    this._parent = p;
    // The compensation the mock performs: solve for the local transform that
    // reproduces worldBefore under `basis` — which is the live parent matrix
    // when the mock is honest, and a stale one when it is not.
    const basis = this.staleParentMatrix || parentMatrix(this);
    const wanted = mul(invert(basis), worldBefore);
    writeLocal(this, wanted, basis, worldBefore);
  }
}

// ---------- matrix helpers, written independently of the ones under test ----------
// [a, b, c, d, tx, ty]: x' = a*x + c*y + tx, y' = b*x + d*y + ty
const I = () => [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
const point = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const vec = (m, p) => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];

function localMatrix(l) {
  const pos = l.props.Position.v, anc = l.props["Anchor Point"].v, sc = l.props.Scale.v;
  const rad = (l.props.Rotation.v * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rs = [cos * sc[0] / 100, sin * sc[0] / 100, -sin * sc[1] / 100, cos * sc[1] / 100, 0, 0];
  return mul(mul([1, 0, 0, 1, pos[0], pos[1]], rs), [1, 0, 0, 1, -anc[0], -anc[1]]);
}
function parentMatrix(l) { return l._parent ? worldMatrix(l._parent) : I(); }
// What issue #28 describes AE doing: reading the parent as though it were
// still a root layer, so its freshly-rewritten local values are mistaken for
// world ones and the child is compensated against the wrong frame.
function staleBasis(l) { return localMatrix(l); }

// Under the layer-space reading the world matrix is the plain chain product.
// Under the anchor-relative reading each level also re-adds the parent's anchor.
function worldMatrix(l) {
  const up = parentMatrix(l);
  if (MODEL === "layer-space") return mul(up, localMatrix(l));
  const anc = l._parent ? l._parent.props["Anchor Point"].v : [0, 0];
  return mul(mul(up, [1, 0, 0, 1, anc[0], anc[1]]), localMatrix(l));
}

// Split a desired local matrix back into the four AE properties, keeping the
// anchor where it is. Mirrors what AE's compensation has to do.
function writeLocal(l, wanted, basis, worldBefore) {
  const sx = Math.hypot(wanted[0], wanted[1]);
  const theta = Math.atan2(wanted[1], wanted[0]);
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const sy = -sn * wanted[2] + cs * wanted[3];
  l.props.Scale.v = [sx * 100, sy * 100];
  l.props.Rotation.v = (theta * 180) / Math.PI;
  // Position is whatever puts the anchor back where it was, read the way the
  // active model reads it.
  const anchorWorld = point(worldBefore, l.props["Anchor Point"].v);
  if (MODEL === "layer-space") {
    l.props.Position.v = point(invert(basis), anchorWorld);
  } else {
    const pAnc = l._parent ? l._parent.props["Anchor Point"].v : [0, 0];
    const shifted = point(invert(basis), anchorWorld);
    l.props.Position.v = [shifted[0] - pAnc[0], shifted[1] - pAnc[1]];
  }
}

// ---------- load the real handler ----------

function loadOps(layers) {
  const ctx = {
    OPS: {},
    AVLayer: MockLayer,
    TextLayer: class {}, ShapeLayer: class {}, CameraLayer: class {}, LightLayer: class {},
    CompItem: class {}, FootageItem: class {},
    Math,
    isFinite,
    noUndo: (fn) => fn,
    getCompById: () => ({ time: 0 }),
    getLayerById: (_c, id) => {
      const hit = layers.find((l) => l.id === id);
      assert.ok(hit, `no mock layer with id ${id}`);
      return hit;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "layers.jsx" });
  return ctx.OPS;
}

// ---------- scenarios ----------

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
function assertSameWorld(name, got, want) {
  for (let i = 0; i < 6; i++) {
    assert.ok(
      near(got[i], want[i], 1e-6),
      `${name}: world matrix component ${i} is ${got[i]}, expected ${want[i]}`,
    );
  }
}

let passed = 0;

// The reported case: fig -> pb -> bubA, where pb was re-parented earlier in the
// same evaluation so the compensation for bubA reads pb's pre-move matrix.
function twoLevelScene(anchors) {
  const fig = new MockLayer("fig", { id: 1, position: [400, 300], anchor: anchors.fig });
  const pb = new MockLayer("pb", { id: 2, position: [700, 500], anchor: anchors.pb });
  const bubA = new MockLayer("bubA", { id: 3, position: [900, 640], anchor: anchors.bub });
  // A second child, parented honestly, that exists only to let the handler see
  // AE agree with one reading of Position before the broken case arrives.
  const kit = new MockLayer("kit", { id: 4, position: [760, 610], anchor: anchors.bub });
  return { fig, pb, bubA, kit, all: [fig, pb, bubA, kit] };
}

// One honest parenting through the handler, so __PARENT_POS_MODEL is learned.
// A real session gets this for free: most parentings are not stale.
function teachModel(ops, s) {
  const r = ops.parent_layer({ compId: 1, layerId: 4, parentLayerId: 2 });
  assert.equal(r.correction.applied, false, "the teaching call must itself need no correction");
  return r.correction.positionModel;
}

for (const model of ["layer-space", "anchor-relative"]) {
  for (const anchors of [
    { fig: [0, 0], pb: [0, 0], bub: [0, 0] },        // nulls and shapes: unambiguous
    { fig: [50, 50], pb: [80, 20], bub: [10, 10] },  // non-zero anchors: the two readings differ
  ]) {
    MODEL = model;
    const ambiguousAnchors = anchors.pb[0] !== 0 || anchors.pb[1] !== 0;
    const label = `${model} anchors=${JSON.stringify(anchors.pb)}`;

    // 1. Honest compensation: nothing to fix, and nothing may be written. The
    //    control is the same scene parented by bare assignment.
    {
      const control = twoLevelScene(anchors);
      control.pb.parent = control.fig;
      control.bubA.parent = control.pb;
      const wantValues = JSON.stringify([
        control.bubA.props.Position.v, control.bubA.props.Scale.v, control.bubA.props.Rotation.v,
      ]);

      const s = twoLevelScene(anchors);
      const ops = loadOps(s.all);
      s.pb.parent = s.fig;
      const want = worldMatrix(s.bubA);
      const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
      assertSameWorld(`${label} honest`, worldMatrix(s.bubA), want);
      assert.equal(r.correction.applied, false, `${label}: nothing should be corrected when the host is honest`);
      assert.equal(
        JSON.stringify([s.bubA.props.Position.v, s.bubA.props.Scale.v, s.bubA.props.Rotation.v]),
        wantValues,
        `${label}: an honest compensation must be left exactly as the host wrote it`,
      );
      passed += 3;
    }

    // 2. Stale-parent compensation — the bug. The correction must undo it.
    {
      const s = twoLevelScene(anchors);
      const ops = loadOps(s.all);
      s.pb.parent = s.fig;
      const learned = teachModel(ops, s);
      assert.equal(learned, ambiguousAnchors ? model : null, `${label}: model learning`);
      s.bubA.staleParentMatrix = staleBasis(s.pb);
      const want = worldMatrix(s.bubA);
      const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
      assert.equal(r.correction.applied, true, `${label}: a stale compensation must be corrected`);
      assertSameWorld(`${label} stale`, worldMatrix(s.bubA), want);
      passed += 3;
    }

    // 3. The scale junk: a parent at 30% left children at 333%.
    {
      const s = twoLevelScene(anchors);
      s.pb.props.Scale.v = [30, 30];
      const ops = loadOps(s.all);
      s.pb.parent = s.fig;
      teachModel(ops, s);
      s.bubA.staleParentMatrix = staleBasis(s.pb);
      const want = worldMatrix(s.bubA);
      ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
      assertSameWorld(`${label} scaled parent`, worldMatrix(s.bubA), want);
      assert.ok(
        near(s.bubA.props.Scale.v[0], 100 / 0.3, 1e-6),
        `${label}: child of a 30% parent should read ${100 / 0.3}%, got ${s.bubA.props.Scale.v[0]}`,
      );
      passed += 2;
    }

    // 4. A rotated, non-uniformly scaled parent — the general case.
    {
      const s = twoLevelScene(anchors);
      s.pb.props.Rotation.v = 37;
      s.pb.props.Scale.v = [140, 140];
      s.bubA.props.Rotation.v = -12;
      s.bubA.props.Scale.v = [80, 80];
      const ops = loadOps(s.all);
      s.pb.parent = s.fig;
      teachModel(ops, s);
      s.bubA.staleParentMatrix = staleBasis(s.pb);
      const want = worldMatrix(s.bubA);
      ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
      assertSameWorld(`${label} rotated parent`, worldMatrix(s.bubA), want);
      passed++;
    }

    // 5. Unparenting has to preserve the world transform too.
    {
      const s = twoLevelScene(anchors);
      const ops = loadOps(s.all);
      s.pb.parent = s.fig;
      s.bubA.parent = s.pb;
      const want = worldMatrix(s.bubA);
      s.bubA.staleParentMatrix = I();      // a wrong basis on the way back out
      ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: null });
      assertSameWorld(`${label} unparent`, worldMatrix(s.bubA), want);
      passed++;
    }

    // 6. preserveTransform:false keeps the old behaviour: no correction at all.
    {
      const s = twoLevelScene(anchors);
      const ops = loadOps(s.all);
      s.pb.parent = s.fig;
      s.bubA.staleParentMatrix = I();
      const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2, preserveTransform: false });
      assert.equal(r.preserveTransform, false);
      assert.equal(r.correction, undefined, "preserveTransform:false must not report a correction");
      passed += 2;
    }
  }
}

// The honest failure mode: a broken compensation, a parent chain with non-zero
// anchors, and no chance yet to learn which reading of Position AE uses. The
// correction still fires — leaving the layer wrong by a whole parent-world
// offset would be worse — but the residual is bounded by the anchors, and the
// result says so rather than claiming an exact fix.
{
  MODEL = "anchor-relative";
  const anchors = { fig: [50, 50], pb: [80, 20], bub: [10, 10] };
  const s = twoLevelScene(anchors);
  const ops = loadOps(s.all);
  s.pb.parent = s.fig;
  s.bubA.staleParentMatrix = staleBasis(s.pb);
  const want = worldMatrix(s.bubA);
  const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
  assert.equal(r.correction.applied, true);
  assert.equal(r.correction.positionModel, "layer-space", "the unlearned default");
  assert.match(r.correction.notes.join(" "), /has not yet seen AE agree/, "the assumption must be stated");
  const got = worldMatrix(s.bubA);
  const off = [got[4] - want[4], got[5] - want[5]];
  // Exactly the anchors it could not account for — not a parent-world offset.
  assert.ok(
    near(off[0], anchors.fig[0] + anchors.pb[0]) && near(off[1], anchors.fig[1] + anchors.pb[1]),
    `residual should be the anchor sum, got ${JSON.stringify(off)}`,
  );
  passed += 4;
}

// Keyframed position: AE's own compensation rewrites every key, so ours has to
// shift all of them by the same amount rather than throwing on setValue.
{
  MODEL = "layer-space";
  const s = twoLevelScene({ fig: [0, 0], pb: [0, 0], bub: [0, 0] });
  const keys = [[900, 640], [1100, 700], [1300, 900]];
  s.bubA.props.Position.keys = keys.map((k) => k.slice());
  const ops = loadOps(s.all);
  s.pb.parent = s.fig;
  s.bubA.staleParentMatrix = staleBasis(s.pb);
  const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
  assert.equal(r.correction.keysAdjusted, 3, "every key must be shifted");
  const d = r.correction.positionDelta;
  for (let i = 0; i < keys.length; i++) {
    assert.ok(
      near(s.bubA.props.Position.keys[i][0], keys[i][0] + d[0])
        && near(s.bubA.props.Position.keys[i][1], keys[i][1] + d[1]),
      `key ${i + 1} should have moved by the same delta`,
    );
  }
  passed += 4;
}

// An expression on the property is reported, not silently overwritten.
{
  MODEL = "layer-space";
  const s = twoLevelScene({ fig: [0, 0], pb: [0, 0], bub: [0, 0] });
  s.bubA.props.Position.expressionEnabled = true;
  const ops = loadOps(s.all);
  s.pb.parent = s.fig;
  s.bubA.staleParentMatrix = staleBasis(s.pb);
  const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
  assert.match(r.correction.notes.join(" "), /expression-driven/);
  assert.equal(r.correction.positionDelta, null, "nothing was written, so nothing may be claimed");

  // The control: the same broken assignment, done bare. Our handler must have
  // left the property exactly where the host put it.
  const control = twoLevelScene({ fig: [0, 0], pb: [0, 0], bub: [0, 0] });
  control.pb.parent = control.fig;
  control.bubA.staleParentMatrix = staleBasis(control.pb);
  control.bubA.parent = control.pb;
  assert.deepEqual(
    [...s.bubA.props.Position.v],
    [...control.bubA.props.Position.v],
    "an expression-driven position must not be rewritten",
  );
  passed += 3;
}

// A 3D layer is refused rather than half-corrected.
{
  MODEL = "layer-space";
  const s = twoLevelScene({ fig: [0, 0], pb: [0, 0], bub: [0, 0] });
  s.bubA.threeDLayer = true;
  const ops = loadOps(s.all);
  const r = ops.parent_layer({ compId: 1, layerId: 3, parentLayerId: 2 });
  assert.equal(r.correction.applied, false);
  assert.match(r.correction.notes.join(" "), /3D layer/, "a 3D layer must say why it was not corrected");
  assert.equal(s.bubA.parent, s.pb, "the parenting itself must still happen");
  passed += 3;
}

console.log(`parent-transform: ${passed} assertions passed`);
