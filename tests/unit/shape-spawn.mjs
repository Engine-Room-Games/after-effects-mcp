// Where create_shape_layer puts a new shape layer's origin.
//
// After Effects' addShape() leaves Position at the comp centre with the Anchor
// Point at [0,0], so a fresh shape layer's coordinate space is offset from the
// comp's by half a frame. Every path this toolset can write — set_shape_path
// vertices, add_shape_content vertices, a rect or ellipse `position` — is in
// LAYER space, and nothing in the old response said where that space started.
// An agent drawing in comp pixels got the whole thing shifted by (w/2, h/2),
// and the check that would have caught it is a downsampled screenshot, so it
// cost a review round instead (issue #51).
//
// So the default is now [0,0] — layer space and comp space are the same space —
// and what this test holds is that the default really is that, that AE's own
// spawn point is still reachable in one word, and that the response says which
// one you got so nobody has to render a frame to find out.
//
//   node tests/unit/shape-spawn.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
// layers.jsx is not self-contained: __layerSummary calls __wantsSection out of
// comps.jsx. In the shipped bundle every module shares one scope, so this loads
// both rather than stubbing a helper that would be free to drift.
const sources = [["comps.jsx", read("comps.jsx")], ["layers.jsx", read("layers.jsx")]];

// ---------- the mock DOM ----------

class Prop {
  constructor(v) { this.v = v; }
  get value() { return this.v; }
  setValue(x) { this.v = x; }
}

class PositionProp extends Prop {
  constructor(v, isThreeD) { super(v); this.isThreeD = isThreeD; }
  setValue(x) {
    if (x.length === 3 && !this.isThreeD()) {
      throw new Error("Unable to execute script at line 1. Value array does not have 2 elements.");
    }
    this.v = x;
  }
}

class MockShapeLayer {
  constructor(comp, id) {
    this.id = id;
    this.index = 1;
    this.name = "Shape Layer 1";
    this.enabled = true; this.solo = false; this.locked = false; this.shy = false;
    this.threeDLayer = false; this.label = 0; this.blendingMode = 0;
    this.inPoint = 0; this.outPoint = comp.duration; this.startTime = 0; this.stretch = 100;
    this.nullLayer = false; this.adjustmentLayer = false; this.source = null;
    this._parent = null;
    // AE's own defaults for a scripted shape layer: origin at the comp centre,
    // anchor at zero. That pairing is the whole problem.
    this.props = {
      // AE refuses a three-component position on a 2D layer, which is the one
      // bad value the argument check cannot catch on its own.
      Position: new PositionProp([comp.width / 2, comp.height / 2], () => this.threeDLayer),
      "Anchor Point": new Prop([0, 0]),
    };
  }
  get parent() { return this._parent; }
  property(n) {
    assert.equal(n, "Transform");
    const self = this;
    return { property: (k) => self.props[k] };
  }
}

function makeContext({ width = 3840, height = 2160, threeD = false } = {}) {
  const removed = [];
  const comp = {
    id: 12, name: "Main", width, height, duration: 10,
    numLayers: 0,
    layers: {
      addShape() {
        const l = new MockShapeLayer(comp, 99);
        l.threeDLayer = threeD;
        l.remove = () => { removed.push(l); comp.numLayers--; };
        comp.numLayers++;
        return l;
      },
    },
  };
  const ctx = {
    OPS: {},
    Math, String, Error, Array,
    // __layerKind tests these with instanceof; a shape layer must miss them all
    // and be caught by the ShapeLayer branch.
    TextLayer: class {}, ShapeLayer: MockShapeLayer, CameraLayer: class {}, LightLayer: class {},
    CompItem: class {}, FootageItem: class {},
    noUndo: (fn) => fn,
    getCompById: (id) => {
      assert.equal(id, comp.id);
      return comp;
    },
    comp,
    removed,
  };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  return ctx;
}

// Arrays that came back out of the VM carry that realm's Array.prototype, which
// deepStrictEqual counts as a difference. Only their contents are under test.
const plain = (a) => Array.prototype.slice.call(a);

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`shape-spawn FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------- tests ----------

check("the default puts the origin at [0,0], not at the comp centre", () => {
  const ctx = makeContext({ width: 3840, height: 2160 });
  const r = ctx.OPS.create_shape_layer({ compId: 12 });
  assert.deepEqual(plain(r.position), [0, 0], "a path written in comp pixels has to land where it says");
  assert.deepEqual(plain(r.anchorPoint), [0, 0]);
});

check("the response says which coordinate space the caller got", () => {
  // The old response was id/index/name/type, from which the spawn point was not
  // recoverable at all — the thing an agent needed most was the thing it could
  // only learn by rendering.
  const ctx = makeContext();
  const r = ctx.OPS.create_shape_layer({ compId: 12, name: "Badge" });
  assert.equal(r.id, 99);
  assert.equal(r.name, "Badge");
  assert.equal(r.sourceType, "shape");
  assert.ok("position" in r && "anchorPoint" in r, "both halves of the space, or neither is useful");
});

check("'center' is still AE's own spawn point, in one word", () => {
  const ctx = makeContext({ width: 3840, height: 2160 });
  const r = ctx.OPS.create_shape_layer({ compId: 12, position: "center" });
  assert.deepEqual(plain(r.position), [1920, 1080], "the 4K comp centre from the report");
});

check("'center' follows the comp, not a hardcoded frame size", () => {
  const ctx = makeContext({ width: 1080, height: 1920 });
  const r = ctx.OPS.create_shape_layer({ compId: 12, position: "center" });
  assert.deepEqual(plain(r.position), [540, 960]);
});

check("an explicit 2D position is honoured", () => {
  const ctx = makeContext();
  const r = ctx.OPS.create_shape_layer({ compId: 12, position: [300, 250] });
  assert.deepEqual(plain(r.position), [300, 250]);
});

check("an explicit 3D position keeps its third component on a 3D layer", () => {
  const ctx = makeContext({ threeD: true });
  const r = ctx.OPS.create_shape_layer({ compId: 12, position: [300, 250, -40] });
  assert.deepEqual(plain(r.position), [300, 250, -40]);
});

check("a 3D position on a 2D layer is refused, and takes the empty layer with it", () => {
  // The one bad value the argument check cannot see: it is a well-formed
  // vector and AE is the thing that says no. Leaving an empty shape layer
  // behind a thrown error is the half-built failure this repo refuses.
  const ctx = makeContext();
  assert.throws(
    () => ctx.OPS.create_shape_layer({ compId: 12, position: [300, 250, -40] }),
    (e) => {
      assert.match(e.message, /\[300, 250, -40\]/, "name the position it could not set");
      assert.match(e.message, /3D layer/, "say what would make it work");
      assert.match(e.message, /removed/);
      return true;
    },
  );
  assert.equal(ctx.comp.numLayers, 0, "no empty shape layer left behind");
  assert.equal(ctx.removed.length, 1, "and the layer must have been removed again");
});

check("a position that means nothing is refused, and says what it takes", () => {
  const ctx = makeContext();
  for (const bad of ["middle", [5], 42, {}]) {
    assert.throws(
      () => ctx.OPS.create_shape_layer({ compId: 12, position: bad }),
      (e) => {
        assert.match(e.message, /\[x,y\]/);
        assert.match(e.message, /center/);
        return true;
      },
      `position ${JSON.stringify(bad)} should be refused`,
    );
  }
});

check("a refused position creates no layer", () => {
  // The position is resolved before addShape() is called, so a bad argument
  // costs nothing — no empty shape layer left in the user's timeline.
  const ctx = makeContext();
  assert.throws(() => ctx.OPS.create_shape_layer({ compId: 12, position: "middle" }));
  assert.equal(ctx.comp.numLayers, 0, "nothing should have been created");
});

console.log(`shape-spawn: ${passed} checks passed`);
