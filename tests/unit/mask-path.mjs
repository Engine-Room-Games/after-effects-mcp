// set_mask's path fields, and set_shape_path's target, against a mock DOM.
//
// #207: set_mask read `closed`, `inTangents` and `outTangents` only inside
// `if (args.vertices)`, so opening a mask, closing one, or re-curving it
// without restating every vertex answered {ok} and left the path as it was.
// Each field now applies on its own, on top of the path the mask already has,
// and a tangent array that does not match the vertex count is refused before
// anything is written.
//
// #163 (one item): set_shape_path dug from a group to its path by the English
// display name "Path", which a localized After Effects does not have. It now
// resolves by match name (ADBE Vector Shape), and a node that is not a path is
// refused by name rather than handed to setValue.
//
// What this cannot prove: that AE 2026 accepts a Shape read from a mask's
// `.value`, modified and written back, as the mock does. That is the live recipe.
//
//   node tests/unit/mask-path.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const sources = ["ids.jsx", "masks.jsx", "shapes.jsx"].map((f) => [f, fs.readFileSync(path.join(jsxDir, f), "utf8")]);

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.error(`mask-path FAILED: ${name}`); throw e; }
  passed++;
}

const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814 };
const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };

// AE's Shape: a plain value object. Reading `.value` hands back a copy, so a
// handler that mutates what it read and never writes it back changes nothing.
// A mask's variable-width feather points ride on the same Shape, indexed by
// segment; a fresh `new Shape()` has none.
const FEATHER = ["featherSegLocs", "featherRelSegLocs", "featherRadii", "featherInterps",
  "featherTensions", "featherTypes", "featherRelCornerAngles"];
class Shape {
  constructor() {
    this.vertices = []; this.inTangents = []; this.outTangents = []; this.closed = true;
    for (const k of FEATHER) this[k] = [];
  }
}
const copyShape = (s) => Object.assign(new Shape(), JSON.parse(JSON.stringify(s)));

class ShapeProp {
  constructor(matchName, name, shape) {
    Object.assign(this, { matchName, name, propertyType: PropertyType.PROPERTY, _v: shape, writes: 0, numKeys: 0 });
  }
  get value() { return copyShape(this._v); }
  write(v) {
    assert.ok(v instanceof Shape, "a path is written as a Shape");
    for (const k of ["inTangents", "outTangents"]) {
      assert.equal(v[k].length, v.vertices.length, `AE needs one ${k} entry per vertex`);
    }
    this._v = copyShape(v); this.writes++;
  }
}

function mask(shape) {
  const props = {
    "ADBE Mask Shape": new ShapeProp("ADBE Mask Shape", "Mask Path", shape),
    "ADBE Mask Offset": { value: 0 }, "ADBE Mask Feather": { value: [0, 0] }, "ADBE Mask Opacity": { value: 100 },
  };
  return {
    matchName: "ADBE Mask Atom", name: "Mask 1", propertyType: PropertyType.INDEXED_GROUP,
    maskMode: MaskMode.ADD, inverted: false, props, property: (n) => props[n],
  };
}

function group(matchName, name, children) {
  return {
    matchName, name, propertyType: PropertyType.NAMED_GROUP,
    property: (n) => children.find((c) => c.matchName === n || c.name === n) || null,
  };
}

const square = () => Object.assign(new Shape(), {
  vertices: [[0, 0], [100, 0], [100, 100], [0, 100]],
  inTangents: [[0, 0], [-10, 0], [0, 0], [0, 0]],
  outTangents: [[0, 0], [10, 0], [0, 0], [0, 0]],
  closed: true,
});

function scene({ localized = false } = {}) {
  const m = mask(square());
  // A shape layer as a non-English AE names it: the Path property's display
  // name is "Pfad", only its match name is fixed.
  const shapePath = new ShapeProp("ADBE Vector Shape", localized ? "Pfad" : "Path", square());
  const pathGroup = group("ADBE Vector Shape - Group", localized ? "Pfad 1" : "Path 1", [shapePath]);
  const rect = group("ADBE Vector Shape - Rect", "Rectangle 1", []);
  const contents = group("ADBE Root Vectors Group", "Contents", [pathGroup, rect]);
  const layer = {
    id: 7,
    property: (n) => {
      if (n === "Masks") return { numProperties: 1, property: (i) => (i === 1 ? m : null) };
      if (n === "Contents" || n === "ADBE Root Vectors Group") return contents;
      return null;
    },
  };
  const ctx = {
    OPS: {}, Math, Error, JSON, MaskMode, PropertyType, Shape,
    __setValue: (p, v) => { if (p.write) p.write(v); else p.value = v; },
  };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  // ids.jsx is loaded for the real walkProperty; the two lookups are the mock's.
  ctx.getCompById = () => ({});
  ctx.getLayerById = () => layer;
  return { ops: ctx.OPS, m, maskPath: m.props["ADBE Mask Shape"], shapePath, pathGroup };
}
const base = { compId: 1, layerId: 7, maskIndex: 1 };

// ---------------------------------------------------------------------------
// #207 — set_mask applies each path field on its own
// ---------------------------------------------------------------------------

check("closed:false alone opens the mask and keeps its vertices and curves", () => {
  const { ops, maskPath } = scene();
  ops.set_mask({ ...base, closed: false });
  assert.equal(maskPath._v.closed, false);
  assert.deepEqual(maskPath._v.vertices, square().vertices);
  assert.deepEqual(maskPath._v.outTangents, square().outTangents);
  ops.set_mask({ ...base, closed: true });
  assert.equal(maskPath._v.closed, true);
});

check("tangents alone re-curve the existing vertices", () => {
  const { ops, maskPath } = scene();
  const inT = [[0, -20], [0, 0], [0, 0], [0, 0]];
  ops.set_mask({ ...base, inTangents: inT });
  assert.deepEqual(maskPath._v.inTangents, inT);
  assert.deepEqual(maskPath._v.outTangents, square().outTangents, "outTangents not given are kept");
  assert.deepEqual(maskPath._v.vertices, square().vertices);
  assert.equal(maskPath.writes, 1);
});

check("new vertices of the same count keep the curves; a different count resets them", () => {
  const { ops, maskPath } = scene();
  ops.set_mask({ ...base, vertices: [[1, 1], [2, 1], [2, 2], [1, 2]] });
  assert.deepEqual(maskPath._v.outTangents, square().outTangents);
  ops.set_mask({ ...base, vertices: [[0, 0], [50, 0], [25, 40]] });
  assert.deepEqual(maskPath._v.inTangents, [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(maskPath._v.outTangents, [[0, 0], [0, 0], [0, 0]]);
  assert.equal(maskPath._v.closed, true, "closed not given is kept");
});

check("a tangent count that differs from the vertex count is refused before any write", () => {
  const { ops, m, maskPath } = scene();
  assert.throws(() => ops.set_mask({ ...base, inTangents: [[0, 0]], inverted: true }),
    /inTangents has 1 entries but the path has 4 vertices.*Nothing was changed/);
  assert.throws(() => ops.set_mask({ ...base, vertices: [[0, 0], [1, 0], [1, 1]], outTangents: [[0, 0]] }),
    /outTangents has 1 entries but the path has 3 vertices/);
  assert.equal(maskPath.writes, 0);
  assert.equal(m.inverted, false);
});

const feathered = () => Object.assign(square(), {
  featherSegLocs: [1, 2], featherRelSegLocs: [0.5, 0.25], featherRadii: [12, -6], featherInterps: [0, 1],
  featherTensions: [0, 0.3], featherTypes: [0, 1], featherRelCornerAngles: [0, 0],
});

check("variable-width feather points survive a path edit that keeps the vertex count", () => {
  const { ops, maskPath } = scene();
  maskPath._v = feathered();
  ops.set_mask({ ...base, closed: false, inTangents: [[0, -20], [0, 0], [0, 0], [0, 0]] });
  ops.set_mask({ ...base, vertices: [[1, 1], [2, 1], [2, 2], [1, 2]] });
  assert.equal(maskPath._v.closed, false);
  for (const k of FEATHER) assert.deepEqual(maskPath._v[k], feathered()[k], `${k} must be kept`);
});

check("a vertex-count change on a feathered mask is refused, not a silent drop", () => {
  const { ops, maskPath } = scene();
  maskPath._v = feathered();
  assert.throws(() => ops.set_mask({ ...base, vertices: [[0, 0], [1, 0], [1, 1]] }),
    /2 variable-width feather point\(s\).*Nothing was changed/);
  assert.equal(maskPath.writes, 0);
});

check("an animated mask path is refused by name before any write", () => {
  const { ops, m, maskPath } = scene();
  maskPath.numKeys = 2;
  assert.throws(() => ops.set_mask({ ...base, closed: false, inverted: true }), /path is animated \(2 keyframes\).*Nothing was changed/);
  assert.equal(maskPath.writes, 0);
  assert.equal(m.inverted, false);
  ops.set_mask({ ...base, inverted: true });
  assert.equal(m.inverted, true, "fields off the path still apply to an animated mask");
});

check("fields that do not touch the path leave it unwritten", () => {
  const { ops, m, maskPath } = scene();
  ops.set_mask({ ...base, inverted: true, opacity: 50 });
  assert.equal(maskPath.writes, 0);
  assert.equal(m.inverted, true);
});

check("a mask index the layer does not have is refused by name", () => {
  const { ops } = scene();
  assert.throws(() => ops.set_mask({ ...base, maskIndex: 3, closed: false }), /has no mask 3 \(it has 1\)/);
});

// ---------------------------------------------------------------------------
// #163 — set_shape_path finds the Path by match name
// ---------------------------------------------------------------------------

const verts = [[0, 0], [10, 0], [10, 10]];

check("a Path N group resolves to its path on a localized After Effects", () => {
  const { ops, shapePath } = scene({ localized: true });
  ops.set_shape_path({ compId: 1, layerId: 7, shapePath: ["Contents", "Pfad 1"], vertices: verts, closed: false });
  assert.deepEqual(shapePath._v.vertices, verts);
  assert.equal(shapePath._v.closed, false);
});

check("the Path property itself, a mask's path, or the mask itself is accepted", () => {
  const { ops, shapePath, maskPath } = scene();
  ops.set_shape_path({ compId: 1, layerId: 7, shapePath: ["Contents", "Path 1", "ADBE Vector Shape"], vertices: verts });
  assert.deepEqual(shapePath._v.vertices, verts);
  assert.equal(shapePath._v.closed, true);
  ops.set_shape_path({ compId: 1, layerId: 7, shapePath: ["Masks", 1, "ADBE Mask Shape"], vertices: verts });
  assert.deepEqual(maskPath._v.vertices, verts);
  ops.set_shape_path({ compId: 1, layerId: 7, shapePath: ["Masks", 1], vertices: verts, closed: false });
  assert.equal(maskPath._v.closed, false, "a mask group resolves to its Mask Path");
});

check("a node that is not a path is refused with its match name", () => {
  const { ops } = scene();
  assert.throws(() => ops.set_shape_path({ compId: 1, layerId: 7, shapePath: ["Contents", "Rectangle 1"], vertices: verts }),
    /'Rectangle 1' \(ADBE Vector Shape - Rect\), which is not a shape path/);
});

check("set_shape_path refuses a tangent count that does not match", () => {
  const { ops, shapePath } = scene();
  assert.throws(() => ops.set_shape_path({ compId: 1, layerId: 7, shapePath: ["Contents", "Path 1"], vertices: verts, inTangents: [[0, 0]] }),
    /inTangents has 1 entries but the path has 3 vertices/);
  assert.equal(shapePath.writes, 0);
});

console.log(`mask-path: ${passed} checks passed`);
