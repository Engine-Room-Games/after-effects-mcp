// The helper scope every run_jsx script runs in.
//
// The run_jsx description promised "helpers in scope" and never said which, so
// every session wrote its own find-a-layer, its own ease-with-the-right-array-
// size, its own shape builder — the same four or five functions, re-derived at
// token cost with a fresh chance of getting the AE quirk wrong (issue #53).
//
// Each helper here wraps a documented trap, and the traps are what this file
// pins down: the ease array size that is not derivable from the value (#50) and
// the shape layer that spawns at the comp centre (#51). Both are assertable
// against a stub, and neither is assertable any other way — there is no
// ExtendScript to run offline and no After Effects on a runner.
//
//   node tests/unit/run-jsx-helpers.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

// The stub host. Everything is built inside the realm so `instanceof` holds the
// way it does in ExtendScript, which has exactly one.
const HOST = `
function CompItem() { this.layers = { added: [] }; }
function KeyframeEase(speed, influence) { this.speed = speed; this.influence = influence; }
var __project = {};
var app = { project: { itemByID: function (id) { return __project[id] || null; } } };

// A comp whose addShape() records what it made and hands back a layer with a
// settable Transform > Position.
function makeComp(id, layerIds) {
  var c = new CompItem();
  c.id = id;
  c.numLayers = layerIds.length;
  var layers = [];
  for (var i = 0; i < layerIds.length; i++) layers.push({ id: layerIds[i], name: "L" + layerIds[i] });
  c.layer = function (n) { return layers[n - 1]; };
  c.layers.addShape = function () {
    var props = { Position: null };
    var l = {
      name: "Shape Layer 1",
      property: function (n) {
        if (n !== "Transform") throw new Error("unexpected group " + n);
        return { property: function (p) { return { setValue: function (v) { props[p] = v; } }; } };
      },
      props: props
    };
    c.layers.added.push(l);
    return l;
  };
  __project[id] = c;
  return c;
}

// A property that accepts an ease array of exactly \`wants\` entries and records
// every size it was offered, in order.
function makeProp(opts) {
  var p = {
    name: opts.name || "Scale",
    isSpatial: !!opts.isSpatial,
    value: opts.value,
    attempts: [],
    eases: null,
    keys: [],
    numKeys: 0
  };
  p.setTemporalEaseAtKey = function (idx, ins, outs) {
    p.attempts.push(ins.length);
    if (ins.length !== opts.wants) throw new Error("parameter 2");
    p.eases = { keyIndex: idx, ins: ins, outs: outs };
  };
  p.setValueAtTime = function (t, v) { p.keys.push({ time: t, value: v }); p.numKeys = p.keys.length; };
  p.nearestKeyIndex = function (t) {
    for (var i = 0; i < p.keys.length; i++) { if (p.keys[i].time === t) return i + 1; }
    return 1;
  };
  return p;
}
`;

const ctx = {};
vm.createContext(ctx);
vm.runInContext(HOST, ctx, { filename: "host.js" });
vm.runInContext(src("ids.jsx"), ctx, { filename: "ids.jsx" });
vm.runInContext(src("helpers.jsx"), ctx, { filename: "helpers.jsx" });

const run = (expr) => vm.runInContext(expr, ctx);
const fn = (name) => vm.runInContext(name, ctx);

let passed = 0;
const check = (name, f) => { f(); passed++; };
// Values built in the VM realm have to be compared through JSON, exactly as the
// panel compares them: an array from there is not deepEqual to one from here.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------- identity ----------

const comp = run("makeComp(11, [101, 102])");

check("compById is getCompById under the name agents guess", () => {
  assert.equal(fn("compById")(11), comp);
  assert.throws(() => fn("compById")(999), /No comp with id 999/);
});

check("layerById takes the comp id, which is the half of the pair agents hold", () => {
  assert.equal(fn("layerById")(11, 102).id, 102);
  assert.equal(fn("layerById")(comp, 101).id, 101);
  assert.throws(() => fn("layerById")(11, 999), /No layer with id 999/);
});

// ---------- ease ----------

check("a spatial property is tried at one entry first and only once", () => {
  // Position takes a single ease along the motion path whatever its dimension.
  const prop = run("makeProp({name: 'Position', isSpatial: true, value: [0, 0, 0], wants: 1})");
  assert.equal(fn("ease")(prop, 1, { influence: 60, speed: 0 }), 1);
  assert.deepEqual([...prop.attempts], [1], "a spatial property must not be probed at all");
});

check("a 2D Scale is derived from its value, first try", () => {
  const prop = run("makeProp({name: 'Scale', value: [100, 100], wants: 2})");
  assert.equal(fn("ease")(prop, 2, 33), 2);
  assert.deepEqual([...prop.attempts], [2]);
});

check("Ellipse Size wants three eases for a two-number value — the #50 case", () => {
  // This is the one that cannot be derived: the guess is wrong and the retry is
  // what saves the call. AE validates the argument before it mutates anything,
  // which is what makes retrying safe rather than destructive.
  const prop = run("makeProp({name: 'Size', value: [200, 120], wants: 3})");
  assert.equal(fn("ease")(prop, 1, 40), 3);
  assert.deepEqual([...prop.attempts], [2, 1, 3], "guess first, then work through the rest");
});

check("Opacity — a scalar with no length — lands on one", () => {
  const prop = run("makeProp({name: 'Opacity', value: 100, wants: 1})");
  assert.equal(fn("ease")(prop, 1, 75), 1);
  assert.deepEqual([...prop.attempts], [1]);
});

check("the ease spec reaches every entry, and a bare number means influence", () => {
  const prop = run("makeProp({name: 'Scale', value: [100, 100], wants: 2})");
  fn("ease")(prop, 1, 80, { influence: 20, speed: 5 });
  assert.equal(prop.eases.keyIndex, 1);
  assert.deepEqual(plain(prop.eases.ins.map((e) => [e.influence, e.speed])), [[80, 0], [80, 0]]);
  assert.deepEqual(plain(prop.eases.outs.map((e) => [e.influence, e.speed])), [[20, 5], [20, 5]]);
});

check("an omitted easeOut mirrors easeIn rather than silently defaulting", () => {
  const prop = run("makeProp({name: 'Opacity', value: 100, wants: 1})");
  fn("ease")(prop, 1, { influence: 66, speed: 1 });
  assert.deepEqual(plain(prop.eases.outs.map((e) => [e.influence, e.speed])), [[66, 1]]);
});

check("AE's own default is what an unspecified ease gets", () => {
  const prop = run("makeProp({name: 'Opacity', value: 100, wants: 1})");
  fn("ease")(prop, 1);
  assert.deepEqual(plain(prop.eases.ins.map((e) => [e.influence, e.speed])), [[33, 0]]);
});

check("a property that accepts nothing throws, naming itself and what was tried", () => {
  const prop = run("makeProp({name: 'Weird', value: [1, 2], wants: 9})");
  assert.throws(
    () => fn("ease")(prop, 1, 33),
    (e) => /Weird/.test(e.message) && /1, 2 or 3/.test(e.message) && /parameter 2/.test(e.message),
    "the last AE error is the only clue to what went wrong, so it has to be carried out",
  );
  assert.deepEqual([...prop.attempts], [2, 1, 3], "every size is tried before giving up");
});

// ---------- addKeys ----------

check("addKeys sets each pair and hands back the key indices", () => {
  const prop = run("makeProp({name: 'Opacity', value: 100, wants: 1})");
  const idx = fn("addKeys")(prop, run("[[0, 0], [0.5, 100], [2, 100]]"));
  assert.deepEqual([...idx], [1, 2, 3], "the indices are what the next ease() call needs");
  assert.deepEqual(
    plain(prop.keys.map((k) => [k.time, k.value])),
    [[0, 0], [0.5, 100], [2, 100]],
  );
});

check("addKeys also takes {time, value} objects", () => {
  const prop = run("makeProp({name: 'Opacity', value: 100, wants: 1})");
  fn("addKeys")(prop, run("[{time: 1, value: 50}]"));
  assert.deepEqual(plain(prop.keys.map((k) => [k.time, k.value])), [[1, 50]]);
});

check("addKeys on nothing does nothing", () => {
  const prop = run("makeProp({name: 'Opacity', value: 100, wants: 1})");
  assert.deepEqual([...fn("addKeys")(prop, run("[]"))], []);
  assert.deepEqual(plain(prop.keys), []);
});

// ---------- shape ----------

check("a shape layer lands at [0,0], not the comp centre — the #51 case", () => {
  const c = run("makeComp(21, [])");
  const l = fn("shape")(c, run("({name: 'Card'})"));
  assert.equal(l.name, "Card");
  assert.deepEqual([...l.props.Position], [0, 0], "paths are authored in comp pixels; the layer has to be too");
});

check("shape takes a comp id as well as a comp", () => {
  const c = run("makeComp(22, [])");
  fn("shape")(22, run("({})"));
  assert.equal(c.layers.added.length, 1);
});

check("an explicit position is honoured, in 2D or 3D", () => {
  const c = run("makeComp(23, [])");
  assert.deepEqual([...fn("shape")(c, run("({position: [960, 540]})")).props.Position], [960, 540]);
  assert.deepEqual([...fn("shape")(c, run("({position: [1, 2, 3]})")).props.Position], [1, 2, 3]);
});

check("no options at all is still a layer at the origin", () => {
  const c = run("makeComp(24, [])");
  assert.deepEqual([...fn("shape")(c).props.Position], [0, 0]);
});

console.log(`run-jsx-helpers: ${passed} checks passed`);
