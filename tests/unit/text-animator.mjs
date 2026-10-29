// add_text_animator is all-or-nothing (issue #154), out of packages/jsx/text.jsx.
//
// The handler used to add the animator's property inside `catch (e) {}`, so a
// type After Effects refused left an empty animator on the layer and the call
// still answered `{ok:true}`. The contract now is add_shape_content's: resolve
// every requested piece, and if any fails remove the animator this call made
// and throw naming what failed. The mock below is a text layer whose animator
// groups can be told to refuse a property or a range value.
//
//   node tests/unit/text-animator.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`text-animator FAILED: ${name}`);
    throw e;
  }
  passed++;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------

class TextLayer {}

class Prop {
  constructor(matchName, owner) {
    this.matchName = matchName;
    this.owner = owner;
    this.value = undefined;
    this.refuseSet = false;
  }
  setValue(v) {
    if (this.refuseSet) throw new Error(`refused ${this.matchName}`);
    this.value = v;
  }
  get propertyValueType() { return 0; }
}

// A property group: addProperty appends, property(n) by 1-based index or name.
class Group {
  constructor(matchName, name, parent, opts = {}) {
    this.matchName = matchName;
    this.name = name;
    this.parentGroup = parent;
    this.children = [];
    this.opts = opts;
    this.removed = false;
  }
  get numProperties() { return this.children.length; }
  get propertyIndex() { return this.parentGroup.children.indexOf(this) + 1; }
  property(n) {
    if (typeof n === "number") return this.children[n - 1] || null;
    return this.children.find((c) => c.matchName === n || c.name === n) || null;
  }
  addProperty(matchName) {
    const h = this.opts.onAdd;
    if (h) {
      const r = h(matchName, this);
      if (r !== undefined) return r;
    }
    const child = this.opts.make ? this.opts.make(matchName, this) : new Group(matchName, matchName, this);
    this.children.push(child);
    return child;
  }
  remove() {
    const i = this.parentGroup.children.indexOf(this);
    assert.ok(i >= 0, "removed twice");
    this.parentGroup.children.splice(i, 1);
    this.removed = true;
  }
}

function makeAnimator(parent, faults) {
  const anim = new Group("ADBE Text Animator", `Animator ${parent.children.length + 1}`, parent);
  const props = new Group("ADBE Text Animator Properties", "Properties", anim, {
    onAdd: (matchName) => {
      if (faults.refuseProperty === "throw") throw new Error(`cannot add ${matchName}`);
      if (faults.refuseProperty === "null") return null;
      return undefined;
    },
    make: (matchName, g) => new Prop(matchName, g),
  });
  const selectors = new Group("ADBE Text Selectors", "Selectors", anim, {
    make: (matchName, g) => {
      const sel = new Group(matchName, "Range Selector 1", g);
      for (const m of ["ADBE Text Percent Start", "ADBE Text Percent End", "ADBE Text Percent Offset"]) {
        const p = new Prop(m, sel);
        if (faults.refuseRange === m) p.refuseSet = true;
        sel.children.push(p);
      }
      return sel;
    },
  });
  anim.children.push(props, selectors);
  return anim;
}

function makeLayer(faults = {}) {
  const layer = new TextLayer();
  layer.id = 7;
  const animators = new Group("ADBE Text Animators", "Animators", null, {
    make: (matchName, g) => makeAnimator(g, faults),
  });
  const text = { property: (n) => (n === "Animators" ? animators : null) };
  layer.property = (n) => (n === "Text" ? text : null);
  layer.animators = animators;
  return layer;
}

function run(layer, args) {
  const comp = { id: 1 };
  const ctx = {
    OPS: {},
    TextLayer,
    ParagraphJustification: { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415, FULL_JUSTIFY_LASTLINE_LEFT: 7416 },
    getCompById: () => comp,
    getLayerById: () => layer,
    PropertyValueType: {},
  };
  vm.createContext(ctx);
  for (const f of ["values.jsx", "text.jsx"]) vm.runInContext(read(f), ctx, { filename: f });
  return ctx.OPS.add_text_animator({ compId: 1, layerId: 7, ...args });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

check("a clean add returns ok and leaves one animator with the property", () => {
  const layer = makeLayer();
  const r = plain(run(layer, { type: "opacity", range: { start: 10, end: 60, offset: 0 } }));
  assert.equal(r.ok, true);
  assert.equal(r.property, "ADBE Text Opacity");
  assert.equal(layer.animators.numProperties, 1);
  const anim = layer.animators.property(1);
  assert.equal(anim.property("ADBE Text Animator Properties").property(1).matchName, "ADBE Text Opacity");
  const sel = anim.property("ADBE Text Selectors").property(1);
  assert.equal(sel.property("ADBE Text Percent Start").value, 10);
  assert.equal(sel.property("ADBE Text Percent End").value, 60);
});

check("a property AE throws on: animator removed, error names the type and AE's message", () => {
  const layer = makeLayer({ refuseProperty: "throw" });
  assert.throws(
    () => run(layer, { type: "skew" }),
    (e) => /skew/.test(e.message) && /ADBE Text Skew/.test(e.message) && /cannot add/.test(e.message) && /removed, so nothing changed/.test(e.message),
  );
  assert.equal(layer.animators.numProperties, 0, "the empty animator must not be left behind");
});

check("a property AE silently does not add: still a failure", () => {
  const layer = makeLayer({ refuseProperty: "null" });
  assert.throws(() => run(layer, { type: "fillColor" }), /fillColor.*did not add it/);
  assert.equal(layer.animators.numProperties, 0);
});

check("a range value that will not set: animator removed, error names range.<key>", () => {
  const layer = makeLayer({ refuseRange: "ADBE Text Percent End" });
  assert.throws(
    () => run(layer, { type: "position", range: { start: 0, end: 50, offset: 0 } }),
    (e) => /range\.end/.test(e.message) && !/range\.start/.test(e.message),
  );
  assert.equal(layer.animators.numProperties, 0);
});

check("an unknown type is refused before anything is created", () => {
  const layer = makeLayer();
  assert.throws(() => run(layer, { type: "blur" }), /Unknown text animator type 'blur'.*Nothing was changed/);
  assert.equal(layer.animators.numProperties, 0);
});

check("an inherited name is not a type", () => {
  const layer = makeLayer();
  assert.throws(() => run(layer, { type: "toString" }), /Unknown text animator type/);
  assert.equal(layer.animators.numProperties, 0);
});

check("the rollback removes only this call's animator, not an earlier one", () => {
  const layer = makeLayer();
  run(layer, { type: "opacity" });
  layer.animators.opts.make = (m, g) => makeAnimator(g, { refuseProperty: "throw" });
  assert.throws(() => run(layer, { type: "scale" }), /scale/);
  assert.equal(layer.animators.numProperties, 1);
  assert.equal(layer.animators.property(1).property("ADBE Text Animator Properties").property(1).matchName, "ADBE Text Opacity");
});

console.log(`text-animator: ${passed} checks passed`);
