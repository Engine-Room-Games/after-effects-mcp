// The justification read-back in set_text and create_text_layer, out of
// packages/jsx/text.jsx and layers.jsx (issues #93 and #94).
//
// Two reports against AE 26.3, neither of which can be reproduced offline:
//   - set_text({text}) on a left-aligned layer came back CENTER (7415). The
//     handler mutates the existing TextDocument and writes it back, so the
//     round trip itself is what loses the justification (#93).
//   - A script setting CENTER_JUSTIFY through the TextDocument landed RIGHT
//     (7414), while set_text({justification:"center"}) on its own landed
//     correctly (#94).
// Nothing raises in either case and the mechanism is unknown. What can be
// built blind is the guard this repo asks for anyway: read the property back,
// compare with what should be there, write the justification alone once more
// if it moved, and throw if it still disagrees — never an ok for a layer that
// re-centred itself.
//
// So the mock Source Text property has a pluggable misbehaviour: one that
// resets justification whenever `.text` changed, one that stores RIGHT when
// handed CENTER, one that resets on every write, and one that behaves. What
// this cannot prove is which of them AE 26.3 actually is; the recipe in
// CLAUDE.md is where that gets measured.
//
//   node tests/unit/text-justification.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
// layers.jsx (create_text_layer) leans on text.jsx's map and verifier, and on
// comps.jsx's __wantsSection through __layerSummary. One scope, as shipped.
const sources = [
  ["comps.jsx", read("comps.jsx")],
  ["layers.jsx", read("layers.jsx")],
  ["text.jsx", read("text.jsx")],
];

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`text-justification FAILED: ${name}`);
    throw e;
  }
  passed++;
}
// Results are built inside the VM realm, whose Object.prototype is not this
// one's, and deepStrictEqual compares prototypes. Compare the JSON instead —
// which is also all the panel ever forwards.
const plain = (v) => JSON.parse(JSON.stringify(v));
const same = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);

// AE's enum values, as measured in the two issues.
const LEFT = 7413, RIGHT = 7414, CENTER = 7415, FULL = 7416;

// ---------------------------------------------------------------------------
// The mock: a TextLayer whose Source Text misbehaves on demand
// ---------------------------------------------------------------------------

// `misbehave(previous, incoming)` returns the document AE will actually keep.
const BEHAVIOURS = {
  clean: (prev, td) => ({ ...td }),
  // #93 as reported: change the text and the justification comes back CENTER.
  resetsOnTextChange: (prev, td) => (td.text !== prev.text ? { ...td, justification: CENTER } : { ...td }),
  // #94 as reported: ask for CENTER and RIGHT is what gets stored, every time.
  wrongEnum: (prev, td) => (td.justification === CENTER ? { ...td, justification: RIGHT } : { ...td }),
  // The worst case: every write resets it, so a re-assert cannot land either.
  resetsAlways: (prev, td) => ({ ...td, justification: CENTER }),
};

class TextLayer {}

class MockSourceText {
  constructor(behaviour, initial) {
    this.behaviour = BEHAVIOURS[behaviour];
    assert.ok(this.behaviour, `no behaviour ${behaviour}`);
    this.stored = { text: "", font: "Helvetica", fontSize: 36, tracking: -20, justification: LEFT, applyFill: false, ...initial };
    this.writes = [];
  }
  // A fresh document each read, as AE hands out: mutating it must not touch
  // the layer until setValue.
  get value() { return { ...this.stored }; }
  setValue(td) {
    this.writes.push({ ...td });
    this.stored = this.behaviour(this.stored, td);
  }
}

class MockTextLayer extends TextLayer {
  constructor(comp, id, name, src) {
    super();
    this.comp = comp; this.id = id; this.name = name; this.src = src;
    this.removed = false;
    this.anchor = null; this.position = null;
    this.enabled = true; this.solo = false; this.locked = false; this.shy = false;
    this.threeDLayer = false; this.label = 0; this.blendingMode = 0;
    this.inPoint = 0; this.outPoint = 5; this.startTime = 0; this.stretch = 100;
    this.parent = null;
  }
  get index() { return this.comp.stack.indexOf(this) + 1; }
  property(n) {
    if (n === "Source Text") return this.src;
    if (n === "Transform") {
      const self = this;
      return {
        property(p) {
          if (p === "Anchor Point") return { setValue(v) { self.anchor = v; } };
          if (p === "Position") return { setValue(v) { self.position = v; } };
          throw new Error(`unexpected transform property ${p}`);
        },
      };
    }
    throw new Error(`unexpected property ${n}`);
  }
  remove() {
    this.removed = true;
    this.comp.stack.splice(this.comp.stack.indexOf(this), 1);
  }
}

class MockComp {
  constructor(behaviour) {
    this.id = 100;
    this.behaviour = behaviour;
    this.stack = [];
    this.nextId = 10;
    const self = this;
    this.layers = {
      addText(text) {
        // addText() starts a layer LEFT in the mock, as #94 observed of AE
        // ("LEFT appeared to work only because it is addText's default").
        const l = new MockTextLayer(self, self.nextId++, "Text", new MockSourceText(self.behaviour, { text }));
        self.stack.unshift(l);
        return l;
      },
    };
  }
  get numLayers() { return this.stack.length; }
  layer(i) { return this.stack[i - 1]; }
}

function scene(behaviour, initial) {
  const comp = new MockComp(behaviour);
  const layer = new MockTextLayer(comp, 1, "Existing", new MockSourceText(behaviour, initial));
  comp.stack.push(layer);
  const ctx = {
    OPS: {},
    TextLayer, ShapeLayer: class {}, CameraLayer: class {}, LightLayer: class {},
    CompItem: class {}, FootageItem: class {},
    ParagraphJustification: {
      LEFT_JUSTIFY: LEFT, CENTER_JUSTIFY: CENTER, RIGHT_JUSTIFY: RIGHT, FULL_JUSTIFY_LASTLINE_LEFT: FULL,
    },
    Math, isFinite, Error, String,
    noUndo: (fn) => fn,
    getCompById: (id) => { assert.equal(id, comp.id); return comp; },
    getLayerById: (c, id) => {
      const hit = c.stack.find((l) => l.id === id);
      if (!hit) throw new Error(`no layer ${id}`);
      return hit;
    },
  };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  return { comp, layer, ops: ctx.OPS };
}

// ---------------------------------------------------------------------------
// set_text: the behaving case is byte-for-byte what it always did, plus the echo
// ---------------------------------------------------------------------------

check("a behaving AE: text lands, justification untouched, one write, echoed by name", () => {
  const { comp, layer, ops } = scene("clean");
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, text: "Hello" });
  same(out, { ok: true, justification: "left", justificationReasserted: false });
  assert.equal(layer.src.stored.text, "Hello");
  assert.equal(layer.src.stored.justification, LEFT);
  assert.equal(layer.src.writes.length, 1, "no second write when the first landed");
});

check("a requested justification is written and read back by name", () => {
  const { comp, layer, ops } = scene("clean");
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, justification: "right" });
  assert.equal(out.justification, "right");
  assert.equal(out.justificationReasserted, false);
  assert.equal(layer.src.stored.justification, RIGHT);
  assert.equal(layer.src.stored.text, "", "undefined fields unchanged: text was not touched");
});

check("a justification the map does not know is reported as its number, not the nearest name", () => {
  const FULL_CENTER = 7418;
  const { comp, layer, ops } = scene("clean", { justification: FULL_CENTER });
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, text: "x" });
  assert.equal(out.justification, String(FULL_CENTER));
  assert.equal(layer.src.stored.justification, FULL_CENTER, "an unknown alignment set by hand survives a text change");
});

// ---------------------------------------------------------------------------
// #93: the round trip resets it, and the re-assert brings it back
// ---------------------------------------------------------------------------

check("#93: text-only write that resets to CENTER is caught and re-asserted", () => {
  const { comp, layer, ops } = scene("resetsOnTextChange");
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, text: "Retyped" });
  same(out, { ok: true, justification: "left", justificationReasserted: true });
  assert.equal(layer.src.stored.justification, LEFT, "the layer ends up where it started");
  assert.equal(layer.src.stored.text, "Retyped", "the text change is kept");
  assert.equal(layer.src.writes.length, 2);
  // The second write is the justification alone, on a fresh read of the
  // document, so nothing else moves with it.
  assert.equal(layer.src.writes[1].text, "Retyped");
  assert.equal(layer.src.writes[1].justification, LEFT);
});

check("#93 with a justification requested in the same call: re-asserted to the requested one", () => {
  const { comp, layer, ops } = scene("resetsOnTextChange");
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, text: "Retyped", justification: "right" });
  same(out, { ok: true, justification: "right", justificationReasserted: true });
  assert.equal(layer.src.stored.justification, RIGHT);
});

check("the re-assert is never taken when nothing moved", () => {
  const { comp, layer, ops } = scene("resetsOnTextChange");
  // No text change, so this mock does not reset — and the guard must not
  // write a second time just in case.
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, size: 48 });
  assert.equal(out.justificationReasserted, false);
  assert.equal(layer.src.writes.length, 1);
  assert.equal(layer.src.stored.fontSize, 48);
});

// ---------------------------------------------------------------------------
// #94: the setter stores the wrong value, and a second try does not help
// ---------------------------------------------------------------------------

check("#94: CENTER stored as RIGHT twice is a throw naming expected and actual", () => {
  const { comp, layer, ops } = scene("wrongEnum");
  assert.throws(
    () => ops.set_text({ compId: comp.id, layerId: layer.id, text: "Centred", justification: "center" }),
    (e) => {
      assert.match(e.message, /Source Text justification did not land/);
      assert.match(e.message, /expected center \(7415\)/);
      assert.match(e.message, /reads right \(7414\)/);
      assert.match(e.message, /second write/);
      assert.match(e.message, /get_layer_full/);
      return true;
    },
  );
  assert.equal(layer.src.writes.length, 2, "the re-assert was tried before giving up");
  assert.equal(layer.src.stored.text, "Centred", "the throw is honest about the other fields having landed");
});

check("the same misbehaviour on an alignment it does not affect passes clean", () => {
  const { comp, layer, ops } = scene("wrongEnum");
  const out = ops.set_text({ compId: comp.id, layerId: layer.id, justification: "left" });
  same(out, { ok: true, justification: "left", justificationReasserted: false });
});

// ---------------------------------------------------------------------------
// The argument itself
// ---------------------------------------------------------------------------

check("an unknown justification name is refused before anything is written", () => {
  // The schema enum stops this on the direct path; run_batch forwards
  // unvalidated, and the old code ignored the value and reported ok.
  const { comp, layer, ops } = scene("clean");
  assert.throws(
    () => ops.set_text({ compId: comp.id, layerId: layer.id, text: "x", justification: "middle" }),
    /Unknown justification 'middle'.*left, center, right, full.*Nothing was changed/,
  );
  assert.equal(layer.src.writes.length, 0);
  assert.equal(layer.src.stored.text, "");
});

check("every name in the map round-trips through the result", () => {
  for (const [name, value] of [["left", LEFT], ["center", CENTER], ["right", RIGHT], ["full", FULL]]) {
    const { comp, layer, ops } = scene("clean");
    const out = ops.set_text({ compId: comp.id, layerId: layer.id, justification: name });
    assert.equal(out.justification, name);
    assert.equal(layer.src.stored.justification, value);
  }
});

// ---------------------------------------------------------------------------
// create_text_layer: the same round trip, so the same guard
// ---------------------------------------------------------------------------

check("create_text_layer on a behaving AE: left by default, echoed, anchor at origin", () => {
  const { comp, ops } = scene("clean");
  const out = ops.create_text_layer({ compId: comp.id, text: "Title", font: "Inter", size: 64 });
  const made = comp.stack[0];
  assert.equal(out.id, made.id);
  assert.equal(out.justification, "left");
  assert.equal(out.justificationReasserted, false);
  assert.equal(made.src.stored.justification, LEFT);
  assert.equal(made.src.stored.tracking, 0, "tracking normalised as before");
  assert.equal(made.src.stored.font, "Inter");
  same(made.anchor, [0, 0, 0]);
  assert.equal(made.src.writes.length, 1);
});

check("create_text_layer anchorAlign 'center' on the #94 setter: re-asserted, then removed and thrown", () => {
  const { comp, ops } = scene("wrongEnum");
  assert.throws(
    () => ops.create_text_layer({ compId: comp.id, text: "Title", anchorAlign: "center", font: "Inter" }),
    (e) => {
      assert.match(e.message, /expected center \(7415\)/);
      assert.match(e.message, /The new layer was removed, so nothing was created/);
      assert.match(e.message, /anchorAlign:"none"/);
      return true;
    },
  );
  assert.equal(comp.stack.length, 1, "only the pre-existing layer remains");
  assert.equal(comp.stack[0].name, "Existing");
});

check("create_text_layer where a re-assert lands: layer kept, flagged", () => {
  // resetsOnTextChange cannot fire on create (addText sets the text before
  // the round trip), so the reset is modelled by handing the layer a document
  // whose justification the first write loses and the second keeps.
  const { comp, ops } = scene("clean");
  let calls = 0;
  const original = BEHAVIOURS.clean;
  comp.behaviour = "clean";
  // Patch addText's source to lose the justification exactly once.
  const addText = comp.layers.addText;
  comp.layers.addText = (text) => {
    const l = addText(text);
    l.src.behaviour = (prev, td) => (++calls === 1 ? { ...td, justification: CENTER } : original(prev, td));
    return l;
  };
  const out = ops.create_text_layer({ compId: comp.id, text: "Title", anchorAlign: "right" });
  assert.equal(out.justification, "right");
  assert.equal(out.justificationReasserted, true);
  assert.equal(comp.stack.length, 2);
  assert.equal(comp.stack[0].src.stored.justification, RIGHT);
});

check("anchorAlign 'none' promises to leave the justification alone, and that is checked too", () => {
  // 'none' plus a font still round-trips the document. On an AE that resets
  // every write, that would silently re-centre a layer the caller asked to
  // leave alone — so the guard compares against what addText gave it.
  const { comp, ops } = scene("resetsAlways");
  assert.throws(
    () => ops.create_text_layer({ compId: comp.id, text: "x", anchorAlign: "none", font: "Inter" }),
    /expected left \(7413\).*reads center \(7415\).*removed/,
  );
  assert.equal(comp.stack.length, 1);
});

check("anchorAlign 'none' with nothing else touches no document and reports no justification", () => {
  const { comp, ops } = scene("resetsAlways");
  const out = ops.create_text_layer({ compId: comp.id, text: "x", anchorAlign: "none" });
  const made = comp.stack[0];
  assert.equal(made.src.writes.length, 0, "no round trip, so no read-back to fail");
  assert.equal("justification" in out, false);
  assert.equal("justificationReasserted" in out, false);
  assert.equal(made.anchor, null);
});

console.log(`text-justification: ${passed} checks passed`);
process.exit(0);
