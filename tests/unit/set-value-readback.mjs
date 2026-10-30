// setValue that throws for a write that landed (issue #129).
//
// In a comp no viewer is showing, After Effects 26.3 threw "invalid numeric
// result (divide by zero?)" from setValue on a shape rect's Size — and applied
// the value anyway. add_shape_content took the throw at its word, removed the
// node it had just built and reported that nothing changed, which is the mirror
// image of reporting success for work that did not happen: the agent retries
// into the same throw on the same comp.
//
// __setValue (values.jsx) reads the property back on that one message and
// drops the throw only when the read-back is what was written. What this file
// holds is both halves of that: the false failure is gone, and nothing else —
// another error, a value that did not land, a value it cannot compare — is
// ever turned into a success. There is no ExtendScript offline, so the throw is
// AE's message on a mock.
//
//   node tests/unit/set-value-readback.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

const AE_MSG = "invalid numeric result (divide by zero?)";

// Built inside the realm so `instanceof Array` holds the way it does in
// ExtendScript, which has exactly one.
const HOST = `
var OPS = {};
var AE_MSG = ${JSON.stringify(AE_MSG)};
function copy(v) {
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(copy(v[i])); return a; }
  if (v && typeof v === "object") { var o = {}; for (var k in v) o[k] = copy(v[k]); return o; }
  return v;
}
// mode: "clean" writes; "spurious" writes then throws AE's message (the #129
// behaviour); "lost" throws AE's message without writing; "other" writes then
// throws a different message. store(v) is what AE keeps — a 2D Position pads
// a third zero, for instance.
function MockProp(initial, mode, store) {
  this.v = initial;
  this.mode = mode || "clean";
  this.store = store || function (x) { return copy(x); };
  this.numKeys = 0;
  this.expression = "";
  this.expressionEnabled = false;
  this.writes = 0;
}
MockProp.prototype.setValue = function (x) {
  this.writes++;
  if (this.mode !== "lost") this.v = this.store(x);
  if (this.mode === "spurious" || this.mode === "lost") throw new Error(AE_MSG);
  if (this.mode === "other") throw new Error("Value array does not have 2 elements.");
};
MockProp.prototype.valueAtTime = function (t, pre) { this.preReads = (this.preReads || 0) + 1; return pre ? this.v : this.post; };
function Shape() { this.vertices = []; this.inTangents = []; this.outTangents = []; this.closed = true; }
`;

function makeCtx(extraSources = []) {
  const ctx = { Math, String, Error, isNaN };
  vm.createContext(ctx);
  vm.runInContext(HOST, ctx, { filename: "host.js" });
  vm.runInContext(read("values.jsx"), ctx, { filename: "values.jsx" });
  for (const f of extraSources) vm.runInContext(read(f), ctx, { filename: f });
  // `value` is a getter, as on a real Property.
  vm.runInContext(
    'Object.defineProperty(MockProp.prototype, "value", { get: function () { return this.post !== undefined ? this.post : this.v; } });',
    ctx
  );
  return ctx;
}

const run = (ctx, code) => vm.runInContext(code, ctx);
const plain = (a) => JSON.parse(JSON.stringify(a));

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`set-value-readback FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------- the helper ----------

check("a clean write answers false and writes once", () => {
  const ctx = makeCtx();
  const r = run(ctx, `var p = new MockProp([0,0]); [__setValue(p, [500,190]), p.writes, p.v]`);
  assert.deepEqual(plain(r), [false, 1, [500, 190]]);
});

check("the #129 throw with the value in place is absorbed, and says so", () => {
  const ctx = makeCtx();
  const r = run(ctx, `var p = new MockProp([0,0], "spurious"); [__setValue(p, [500,190]), p.writes, p.v]`);
  assert.deepEqual(plain(r), [true, 1, [500, 190]], "one write, no retry, value reported as landed");
});

check("the #129 message with the value NOT in place rethrows the original error", () => {
  const ctx = makeCtx();
  assert.throws(() => run(ctx, `__setValue(new MockProp([0,0], "lost"), [500,190])`), (e) => e.message === AE_MSG);
});

check("any other error is rethrown even when the value matches", () => {
  const ctx = makeCtx();
  assert.throws(
    () => run(ctx, `__setValue(new MockProp([0,0], "other"), [500,190])`),
    /does not have 2 elements/,
    "only the measured message is ever second-guessed"
  );
});

check("numbers and colours compare within a relative tolerance, not exactly", () => {
  const ctx = makeCtx();
  const r = run(ctx, `
    var a = new MockProp(0, "spurious", function (x) { return x + 1e-9; });
    var b = new MockProp([0,0,0,0], "spurious", function (x) { return [x[0] + 1e-7, x[1], x[2], x[3]]; });
    var c3 = new MockProp([0,0,0,1], "spurious", function (x) { return [x[0], x[1], x[2], 1]; });
    [__setValue(a, 12.5), __setValue(b, [0.075, 0.08, 0.11, 1]), __setValue(c3, [1, 0, 0])]`);
  assert.deepEqual(plain(r), [true, true, true], "an RGB write reads back with alpha 1");
  assert.throws(
    () => run(ctx, `__setValue(new MockProp([0,0,0,1], "spurious", function (x) { return [x[0], x[1], x[2], 0.5]; }), [1, 0, 0])`),
    (e) => e.message === AE_MSG,
    "only an alpha of exactly 1 is the one AE fills in"
  );
  assert.throws(
    () => run(ctx, `__setValue(new MockProp(0, "spurious", function (x) { return x + 0.5; }), 12)`),
    (e) => e.message === AE_MSG,
    "a value that is merely near is not the value"
  );
});

check("a 2D Position padded with a zero third component counts; a non-zero one does not", () => {
  const ctx = makeCtx();
  const ok = run(ctx, `__setValue(new MockProp([0,0,0], "spurious", function (x) { return [x[0], x[1], 0]; }), [100, 100])`);
  assert.equal(ok, true);
  assert.throws(
    () => run(ctx, `__setValue(new MockProp([0,0,0], "spurious", function (x) { return [x[0], x[1], 7]; }), [100, 100])`),
    (e) => e.message === AE_MSG
  );
  assert.throws(
    () => run(ctx, `__setValue(new MockProp([0], "spurious", function (x) { return [x[0]]; }), [100, 100])`),
    (e) => e.message === AE_MSG,
    "a shorter read-back is never a match"
  );
});

check("Shapes compare vertex by vertex, with omitted tangents read as zero", () => {
  const ctx = makeCtx();
  const ok = run(ctx, `
    // A real new Shape() holds [] for tangents it was not given, not undefined.
    var want = new Shape(); want.vertices = [[0,0],[10,0],[10,10]]; want.closed = true;
    var p = new MockProp(new Shape(), "spurious", function (x) {
      var s = new Shape(); s.vertices = copy(x.vertices); s.inTangents = [[0,0],[0,0],[0,0]]; s.outTangents = [[0,0],[0,0],[0,0]]; s.closed = x.closed; return s;
    });
    __setValue(p, want)`);
  assert.equal(ok, true);
  assert.throws(
    () => run(ctx, `
      var want2 = new Shape(); want2.vertices = [[0,0],[10,0],[10,10]];
      __setValue(new MockProp(new Shape(), "spurious", function (x) { var s = new Shape(); s.vertices = [[0,0],[10,0],[10,11]]; return s; }), want2)`),
    (e) => e.message === AE_MSG
  );
});

check("a property with an expression is compared on its pre-expression value", () => {
  const ctx = makeCtx();
  const r = run(ctx, `
    var p = new MockProp(0, "spurious");
    p.expression = "value * 2"; p.expressionEnabled = true; p.post = 999;
    [__setValue(p, 40), p.preReads]`);
  assert.deepEqual(plain(r), [true, 1], "post-expression .value would never equal what was written");
});

check("a value it cannot compare (a TextDocument, say) is never read as success", () => {
  const ctx = makeCtx();
  assert.throws(
    () => run(ctx, `__setValue(new MockProp({ text: "hi" }, "spurious"), { text: "hi" })`),
    (e) => e.message === AE_MSG
  );
});

check("a read-back that itself throws rethrows the original error", () => {
  const ctx = makeCtx();
  assert.throws(
    () => run(ctx, `
      var p = new MockProp(0, "spurious");
      Object.defineProperty(p, "value", { get: function () { throw new Error("Object is invalid"); } });
      __setValue(p, 5)`),
    (e) => e.message === AE_MSG
  );
});

// ---------- the ops that write through it ----------

// The reporter's case through the tool: a rect whose Size throws AE's message
// after applying it. Before #129 this removed the node and threw.
const SHAPE_HOST = `
var __layer = null;
function makeShapeLayer(sizeMode) {
  var nodes = [];
  var contents = {
    numProperties: 0,
    addProperty: function (match) {
      var props = {};
      if (match === "ADBE Vector Shape - Rect") {
        props["ADBE Vector Rect Size"] = new MockProp([100, 100], sizeMode);
        props["ADBE Vector Rect Position"] = new MockProp([0, 0], sizeMode);
        props["ADBE Vector Rect Roundness"] = new MockProp(0, sizeMode);
      }
      var node = {
        matchName: match, name: "Rectangle Path " + (nodes.length + 1), removed: false, props: props,
        property: function (n) { return props[n] || null; },
        remove: function () { node.removed = true; }
      };
      nodes.push(node);
      node.propertyIndex = nodes.length;
      contents.numProperties = nodes.length;
      return node;
    },
    property: function (i) { return nodes[i - 1]; }
  };
  var transform = { Position: new MockProp([0, 0, 0], sizeMode, function (x) { return [x[0], x[1], 0]; }), Scale: new MockProp([100, 100, 100]) };
  __layer = {
    nodes: nodes, threeDLayer: false,
    property: function (n) {
      if (n === "Contents") return contents;
      // set_transform resolves by match name; AE answers either form.
      if (n === "Transform") return { property: function (k) { return transform[k] || transform[{ "ADBE Position": "Position", "ADBE Scale": "Scale" }[k]] || null; } };
      return null;
    },
    transform: transform
  };
  return __layer;
}
function getCompById(id) { return { id: id }; }
function getLayerById(c, id) { return __layer; }
function walkProperty(l, path) {
  var cur = l.property("Contents");
  for (var i = 1; i < path.length; i++) cur = cur.property(path[i]);
  return cur;
}
`;

function shapeCtx() {
  const ctx = makeCtx();
  vm.runInContext(SHAPE_HOST, ctx, { filename: "shape-host.js" });
  vm.runInContext(read("shapes.jsx"), ctx, { filename: "shapes.jsx" });
  vm.runInContext(read("transforms.jsx"), ctx, { filename: "transforms.jsx" });
  return ctx;
}

check("add_shape_content keeps the node and reports success when the write landed (the #129 report)", () => {
  const ctx = shapeCtx();
  const r = run(ctx, `
    var l = makeShapeLayer("spurious");
    var out = OPS.add_shape_content({ compId: 1, layerId: 2, content: { type: "rect", size: [500, 190], roundness: 90 } });
    JSON.stringify({ ok: out.ok, applied: out.applied, removed: l.nodes[0].removed, size: l.nodes[0].props["ADBE Vector Rect Size"].v })`);
  assert.deepEqual(JSON.parse(r), { ok: true, applied: ["size", "roundness"], removed: false, size: [500, 190] });
});

check("add_shape_content still removes the node and throws when a write really failed", () => {
  const ctx = shapeCtx();
  run(ctx, `var l = makeShapeLayer("lost");`);
  assert.throws(
    () => run(ctx, `OPS.add_shape_content({ compId: 1, layerId: 2, content: { type: "rect", size: [500, 190] } })`),
    /could not apply these keys on 'rect': size \(invalid numeric result/
  );
  assert.equal(run(ctx, `l.nodes[0].removed`), true, "the all-or-nothing rule still holds for a real failure");
});

check("set_shape_property and set_transform absorb the false failure", () => {
  const ctx = shapeCtx();
  const r = run(ctx, `
    var l = makeShapeLayer("spurious");
    OPS.add_shape_content({ compId: 1, layerId: 2, content: { type: "rect" } });
    var a = OPS.set_shape_property({ compId: 1, layerId: 2, contentPath: ["Contents", 1], property: "ADBE Vector Rect Size", value: [320, 80] });
    var b = OPS.set_transform({ compId: 1, layerId: 2, properties: { position: [960, 540] } });
    JSON.stringify({ a: a.ok, b: b.ok, size: l.nodes[0].props["ADBE Vector Rect Size"].v, pos: l.transform.Position.v })`);
  assert.deepEqual(JSON.parse(r), { a: true, b: true, size: [320, 80], pos: [960, 540, 0] });
});

check("set_shape_property still throws when the write did not land", () => {
  const ctx = shapeCtx();
  run(ctx, `var l = makeShapeLayer("lost"); OPS.add_shape_content.call(null, { compId: 1, layerId: 2, content: { type: "rect" } });`);
  assert.throws(
    () => run(ctx, `OPS.set_shape_property({ compId: 1, layerId: 2, contentPath: ["Contents", 1], property: "ADBE Vector Rect Size", value: [320, 80] })`),
    (e) => e.message === AE_MSG
  );
});

// ---------- nothing writes around it ----------

// A plain `.setValue(` in these modules is a write that can still report a
// false failure. The scan is on code, not comments.
check("the shape, transform, mask and effect writers have no bare setValue left", () => {
  for (const f of ["shapes.jsx", "transforms.jsx", "masks.jsx", "effects.jsx"]) {
    const code = read(f)
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    assert.ok(!/\.setValue\(/.test(code), `${f} calls .setValue( directly; write through __setValue (issue #129)`);
  }
});

check("run_jsx scripts get the same function, by a name the description lists", () => {
  const helpers = read("helpers.jsx");
  assert.match(helpers, /function setValueChecked\(prop, value\) \{\s*return __setValue\(prop, value\);/);
  const desc = fs.readFileSync(path.join(root, "packages", "mcp-server", "src", "tools", "descriptions.ts"), "utf8");
  assert.match(desc, /setValueChecked\(prop, value\)/, "the helper scope is listed by signature in the run_jsx description");
});

console.log(`set-value-readback: ${passed} checks passed`);
