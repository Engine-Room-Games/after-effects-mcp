// reorder_layer, against a mock AE DOM (issue #70).
//
// The bug this holds down is not subtle and was never caught: the op called
// `Layer.moveTo(index)`, which does not exist on a Layer. `moveTo` is a
// PropertyBase method for re-ranking a property inside an indexed group, so
// every call threw "parent is not an INDEXED_GROUP" — the op has never once
// worked. Nothing offline could have noticed, because nothing offline ran it.
//
// So the mock layer here has a `moveTo` that throws exactly what AE throws.
// Any future rewrite that reaches for it fails this file rather than the user's
// project. What the mock implements instead is the four real primitives,
// written from AE's own definitions (moveBefore = immediately above, moveAfter
// = immediately below) as a lift-and-reinsert on a plain array — deliberately
// not the arithmetic the handler uses, so the off-by-one that separates the two
// directions of a move is actually being checked rather than restated.
//
// What it cannot prove: that AE's moveBefore really means "above". That is the
// live recipe in the PR. What it does prove is that the handler picks the right
// primitive for each direction and lands the layer where the caller asked.
//
//   node tests/unit/reorder-layer.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
// layers.jsx is not self-contained: __layerSummary calls __wantsSection, which
// comps.jsx declares. The shipped bundle shares one scope, so load both rather
// than stubbing the helper — a stub is free to drift from the real scoping.
const sources = [["comps.jsx", read("comps.jsx")], ["layers.jsx", read("layers.jsx")]];

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`reorder-layer FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// The mock DOM
// ---------------------------------------------------------------------------

class MockLayer {
  constructor(comp, id, name) {
    this.comp = comp;
    this.id = id;
    this.name = name;
    // Enough of a layer for __layerSummary to run every section.
    this.nullLayer = true;
    this.adjustmentLayer = false;
    this.enabled = true; this.solo = false; this.locked = false; this.shy = false;
    this.threeDLayer = false; this.label = 0; this.blendingMode = 0;
    this.inPoint = 0; this.outPoint = 5; this.startTime = 0; this.stretch = 100;
    this.parent = null;
    this.moves = [];
  }
  get index() {
    const i = this.comp.stack.indexOf(this);
    assert.notEqual(i, -1, `${this.name} is not in the comp`);
    return i + 1;
  }
  // What AE actually throws when moveTo is called on a Layer. Issue #70 in one
  // line — if the handler ever reaches for it again, this file says so.
  moveTo() {
    throw new Error("After Effects error: parent is not an INDEXED_GROUP");
  }
  _lift() {
    const i = this.comp.stack.indexOf(this);
    this.comp.stack.splice(i, 1);
  }
  moveBefore(other) {
    assert.notEqual(other, this, "AE refuses to move a layer relative to itself");
    this.moves.push(["moveBefore", other.name]);
    this._lift();
    this.comp.stack.splice(this.comp.stack.indexOf(other), 0, this);
  }
  moveAfter(other) {
    assert.notEqual(other, this, "AE refuses to move a layer relative to itself");
    this.moves.push(["moveAfter", other.name]);
    this._lift();
    this.comp.stack.splice(this.comp.stack.indexOf(other) + 1, 0, this);
  }
  moveToBeginning() {
    this.moves.push(["moveToBeginning"]);
    this._lift();
    this.comp.stack.unshift(this);
  }
  moveToEnd() {
    this.moves.push(["moveToEnd"]);
    this._lift();
    this.comp.stack.push(this);
  }
}

class MockComp {
  constructor(names) {
    this.id = 100;
    this.stack = names.map((n, i) => new MockLayer(this, 10 + i, n));
  }
  get numLayers() { return this.stack.length; }
  layer(i) {
    assert.ok(i >= 1 && i <= this.stack.length, `comp.layer(${i}) is out of range`);
    return this.stack[i - 1];
  }
  byName(n) {
    const hit = this.stack.find((l) => l.name === n);
    assert.ok(hit, `no layer named ${n}`);
    return hit;
  }
  get names() { return this.stack.map((l) => l.name); }
}

function loadOps(comp) {
  const ctx = {
    OPS: {},
    TextLayer: class {}, ShapeLayer: class {}, CameraLayer: class {}, LightLayer: class {},
    CompItem: class {}, FootageItem: class {},
    Math, isFinite, Error,
    noUndo: (fn) => fn,
    getCompById: (id) => {
      assert.equal(id, comp.id, "the handler must resolve the comp it was given");
      return comp;
    },
    getLayerById: (c, id) => {
      const hit = c.stack.find((l) => l.id === id);
      if (!hit) throw new Error(`no layer ${id}`);
      return hit;
    },
  };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  return ctx.OPS;
}

function scene(names = ["A", "B", "C", "D"]) {
  const comp = new MockComp(names);
  return { comp, ops: loadOps(comp) };
}

// ---------------------------------------------------------------------------
// The move that never worked
// ---------------------------------------------------------------------------

check("the op never calls Layer.moveTo — the whole of issue #70", () => {
  const { comp, ops } = scene();
  // Every destination form, so no branch can be the one still holding a moveTo.
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("D").id, toIndex: 1 });
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("A").id, toIndex: 4 });
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("B").id, toIndex: 3 });
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("C").id, beforeLayerId: comp.byName("B").id });
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("C").id, afterLayerId: comp.byName("B").id });
  // A mock moveTo throws, so reaching this line at all is the assertion. State
  // it anyway: only the four layer-level primitives may have been used.
  for (const l of comp.stack) {
    for (const m of l.moves) {
      assert.ok(
        ["moveBefore", "moveAfter", "moveToBeginning", "moveToEnd"].includes(m[0]),
        `${l.name} was moved with ${m[0]}, which is not a Layer method`,
      );
    }
  }
});

check("the source no longer mentions moveTo at all in layers.jsx", () => {
  // shapes.jsx keeps the one legitimate moveTo — a PropertyBase, documented in
  // CLAUDE.md. layers.jsx has no business with it.
  const src = read("layers.jsx");
  const hits = src.split("\n").filter((l) => /\bmoveTo\s*\(/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(hits, [], `layers.jsx still calls moveTo: ${hits.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// toIndex is the index the layer LANDS ON, both directions
// ---------------------------------------------------------------------------

check("moving up the stack lands on the requested index", () => {
  const { comp, ops } = scene();               // A B C D
  const d = comp.byName("D");
  const out = ops.reorder_layer({ compId: comp.id, layerId: d.id, toIndex: 2 });
  assert.deepEqual(comp.names, ["A", "D", "B", "C"]);
  assert.equal(d.index, 2, "D must end up at index 2, not next to it");
  assert.equal(out.index, 2);
  assert.equal(out.movedFrom, 4);
  assert.equal(out.id, d.id);
  assert.deepEqual(d.moves, [["moveBefore", "B"]], "moving up displaces downward, so moveBefore is the primitive");
});

check("moving down the stack lands on the requested index", () => {
  const { comp, ops } = scene();               // A B C D
  const a = comp.byName("A");
  const out = ops.reorder_layer({ compId: comp.id, layerId: a.id, toIndex: 3 });
  assert.deepEqual(comp.names, ["B", "C", "A", "D"]);
  assert.equal(a.index, 3, "the target shifts up as A leaves — moveBefore here would land on 2");
  assert.equal(out.index, 3);
  assert.equal(out.movedFrom, 1);
  assert.deepEqual(a.moves, [["moveAfter", "C"]]);
});

check("every index in a five-layer stack is reachable from every start", () => {
  // The exhaustive version of the two cases above: whatever the caller asks
  // for, the layer is at that index and the rest keep their relative order.
  const names = ["A", "B", "C", "D", "E"];
  for (const start of names) {
    for (let to = 1; to <= names.length; to++) {
      const { comp, ops } = scene(names);
      const l = comp.byName(start);
      const others = names.filter((n) => n !== start);
      const out = ops.reorder_layer({ compId: comp.id, layerId: l.id, toIndex: to });
      assert.equal(l.index, to, `${start} -> ${to} landed at ${l.index}`);
      assert.equal(out.index, to);
      assert.deepEqual(
        comp.names.filter((n) => n !== start), others,
        `${start} -> ${to} disturbed the order of the other layers`,
      );
    }
  }
});

check("front and back are the ends of the stack", () => {
  const { comp, ops } = scene();
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("C").id, toIndex: 1 });
  assert.deepEqual(comp.names, ["C", "A", "B", "D"]);
  assert.deepEqual(comp.byName("C").moves, [["moveToBeginning"]]);
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("C").id, toIndex: 4 });
  assert.deepEqual(comp.names, ["A", "B", "D", "C"]);
  assert.deepEqual(comp.byName("C").moves.at(-1), ["moveToEnd"]);
});

check("an index past the ends is clamped, not an error", () => {
  // run_batch forwards op args unvalidated, so the JSX side is the only guard.
  const { comp, ops } = scene();
  const out = ops.reorder_layer({ compId: comp.id, layerId: comp.byName("A").id, toIndex: 99 });
  assert.deepEqual(comp.names, ["B", "C", "D", "A"]);
  assert.equal(out.index, 4);
  const back = ops.reorder_layer({ compId: comp.id, layerId: comp.byName("A").id, toIndex: 0 });
  assert.deepEqual(comp.names, ["A", "B", "C", "D"]);
  assert.equal(back.index, 1);
});

check("a layer already at the requested index is a reported no-op", () => {
  const { comp, ops } = scene();
  const b = comp.byName("B");
  const out = ops.reorder_layer({ compId: comp.id, layerId: b.id, toIndex: 2 });
  assert.deepEqual(comp.names, ["A", "B", "C", "D"]);
  assert.deepEqual(b.moves, [], "no AE call at all when there is nothing to move");
  assert.equal(out.movedFrom, out.index, "equal from/to is how a caller sees a no-op");
});

// ---------------------------------------------------------------------------
// The id-relative forms, which is what an agent should actually reach for
// ---------------------------------------------------------------------------

check("beforeLayerId puts the layer directly in front of that layer", () => {
  const { comp, ops } = scene();
  const d = comp.byName("D");
  const out = ops.reorder_layer({ compId: comp.id, layerId: d.id, beforeLayerId: comp.byName("B").id });
  assert.deepEqual(comp.names, ["A", "D", "B", "C"]);
  assert.equal(out.index, 2);
  assert.equal(out.movedFrom, 4);
});

check("afterLayerId puts the layer directly behind that layer", () => {
  const { comp, ops } = scene();
  const a = comp.byName("A");
  const out = ops.reorder_layer({ compId: comp.id, layerId: a.id, afterLayerId: comp.byName("C").id });
  assert.deepEqual(comp.names, ["B", "C", "A", "D"]);
  assert.equal(out.index, 3);
});

check("the id forms survive a stack that moved since the caller read it", () => {
  // The reason they exist. Read the stack, someone reorders it, then place a
  // layer: the index answer is now wrong and the id answer is still right.
  const { comp, ops } = scene();               // A B C D
  const target = comp.byName("C");
  const wasAt = target.index;                  // 3, read before the disturbance
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("D").id, toIndex: 1 });
  assert.deepEqual(comp.names, ["D", "A", "B", "C"]);
  assert.notEqual(target.index, wasAt, "the scene must actually have shifted");
  ops.reorder_layer({ compId: comp.id, layerId: comp.byName("A").id, beforeLayerId: target.id });
  assert.deepEqual(comp.names, ["D", "B", "A", "C"], "A is in front of C wherever C ended up");
});

check("naming the moved layer as its own destination is refused", () => {
  const { comp, ops } = scene();
  const b = comp.byName("B");
  assert.throws(
    () => ops.reorder_layer({ compId: comp.id, layerId: b.id, beforeLayerId: b.id }),
    /beforeLayerId is the layer being moved/,
  );
  assert.throws(
    () => ops.reorder_layer({ compId: comp.id, layerId: b.id, afterLayerId: b.id }),
    /afterLayerId is the layer being moved/,
  );
  assert.deepEqual(comp.names, ["A", "B", "C", "D"], "a refused move must change nothing");
});

check("no destination at all is an error, not a silent no-op", () => {
  const { comp, ops } = scene();
  assert.throws(
    () => ops.reorder_layer({ compId: comp.id, layerId: comp.byName("A").id }),
    /toIndex, beforeLayerId or afterLayerId/,
  );
});

// ---------------------------------------------------------------------------
// The schema half: exactly one destination reaches ExtendScript
// ---------------------------------------------------------------------------

const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas } = await import(sharedDist("schemas.js"));
const ReorderLayer = OpSchemas.reorder_layer;

check("the schema accepts each destination on its own", () => {
  for (const dest of [{ toIndex: 2 }, { beforeLayerId: 7 }, { afterLayerId: 7 }]) {
    const r = ReorderLayer.safeParse({ compId: 1, layerId: 2, ...dest });
    assert.ok(r.success, `${JSON.stringify(dest)} should parse: ${r.error?.message}`);
  }
});

check("the schema refuses two destinations, and refuses none", () => {
  for (const dest of [
    { toIndex: 2, beforeLayerId: 7 },
    { beforeLayerId: 7, afterLayerId: 8 },
    { toIndex: 2, beforeLayerId: 7, afterLayerId: 8 },
    {},
  ]) {
    const r = ReorderLayer.safeParse({ compId: 1, layerId: 2, ...dest });
    assert.equal(r.success, false, `${JSON.stringify(dest)} must not parse`);
    assert.match(r.error.message, /exactly one of/i);
  }
});

console.log(`reorder-layer: ${passed} checks passed`);
process.exit(0);
