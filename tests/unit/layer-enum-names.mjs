// set_layer's track matte and every AE-enumeration name, against a mock DOM
// (issues #149 and #150).
//
// #149: `trackMatte.layerId` was never read. The handler set only
// `trackMatteType`, which in the 2023+ model leaves the matte layer as it was —
// so "use layer X as the matte" answered ok and assigned nothing. The mock
// layer here holds the 2023+ API (`setTrackMatte`, `removeTrackMatte`,
// `trackMatteLayer`) and the tests assert on what the layer ends up holding.
//
// #150: a blend mode, matte type or mask mode name After Effects does not
// define was looked up as `Enum[name] || current` inside an empty catch, so a
// typo left the layer unchanged behind an {ok}. Both halves are held here: the
// schema closes the names (case-insensitively), and the .jsx refuses a miss
// before anything in the call is written — the AE build may lack a name the
// schema offers, and that must be an error too.
//
// What this cannot prove: that AE 2026's setTrackMatte / removeTrackMatte /
// trackMatteType behave as the mock does. That is the live recipe in the PR.
//
//   node tests/unit/layer-enum-names.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
const sources = ["comps.jsx", "layers.jsx", "masks.jsx", "shapes.jsx"].map((f) => [f, read(f)]);
const S = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.error(`layer-enum-names FAILED: ${name}`); throw e; }
  passed++;
}

// After Effects' enumerations, as the running AE would define them. Deliberately
// missing one name the schema offers, to stand in for an AE build that lacks it.
const BlendingMode = { NORMAL: 5212, MULTIPLY: 5216, SCREEN: 5220, ADD: 5213 };
const TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 };

class MockLayer {
  constructor(comp, id, name) {
    Object.assign(this, {
      comp, id, name, nullLayer: true, adjustmentLayer: false,
      enabled: true, solo: false, locked: false, shy: false, threeDLayer: false, label: 0,
      blendingMode: BlendingMode.NORMAL, inPoint: 0, outPoint: 5, startTime: 0, stretch: 100, parent: null,
      trackMatteType: TrackMatteType.NO_TRACK_MATTE, _matte: null, calls: [],
    });
    this.masks = [];
  }
  get index() { return this.comp.stack.indexOf(this) + 1; }
  get trackMatteLayer() { return this._matte; }
  // The 2023+ model: any layer, switched off as a matte, as AE does.
  setTrackMatte(layer, type) {
    this.calls.push(["setTrackMatte", layer && layer.id, type]);
    assert.ok(layer && layer !== this, "setTrackMatte needs another layer");
    this._matte = layer; this.trackMatteType = type; layer.enabled = false;
  }
  // Measured on AE 26.5: clears the matte layer and leaves the type as it was.
  removeTrackMatte() {
    this.calls.push(["removeTrackMatte"]);
    this._matte = null;
  }
  property(name) {
    if (name === "Contents") return this.contents || (this.contents = new MockShapeGroup());
    assert.equal(name, "Masks");
    const self = this;
    return {
      addProperty() {
        const m = { propertyIndex: self.masks.length + 1, maskMode: MaskMode.ADD, inverted: false, property: () => ({}) };
        self.masks.push(m);
        return m;
      },
      get numProperties() { return self.masks.length; },
      property(i) { return self.masks[i - 1]; },
    };
  }
}

class MockCamera extends MockLayer {}

// Just enough of a shape layer's Contents for add_shape_content: a group that
// appends nodes, and nodes whose named properties hold a value.
class MockShapeGroup {
  constructor() { this.nodes = []; }
  addProperty(matchName) {
    const props = {};
    const node = {
      matchName, name: matchName, propertyIndex: this.nodes.length + 1, props,
      property: (n) => props[n] || (props[n] = { name: n, value: undefined }),
      remove: () => { this.nodes.splice(this.nodes.indexOf(node), 1); },
    };
    this.nodes.push(node);
    return node;
  }
  property(i) { return this.nodes[i - 1]; }
}

class MockComp {
  constructor(names) {
    this.id = 100;
    this.stack = names.map((n, i) => new MockLayer(this, 10 + i, n));
    const cam = new MockCamera(this, 90, "Cam");
    cam.nullLayer = false;
    this.stack.push(cam);
  }
  get numLayers() { return this.stack.length; }
  layer(i) { return this.stack[i - 1]; }
  by(n) { return this.stack.find((l) => l.name === n); }
}

function scene() {
  const comp = new MockComp(["Art", "Text", "Matte"]);
  const ctx = {
    OPS: {}, Math, isFinite, Error, BlendingMode, TrackMatteType, MaskMode,
    TextLayer: class {}, ShapeLayer: class {}, CameraLayer: MockCamera, LightLayer: class {},
    CompItem: class {}, FootageItem: class {}, Shape: class {},
    noUndo: (fn) => fn,
    __setValue: (p, v) => { p.value = v; },
    getCompById: () => comp,
    getLayerById: (c, id) => {
      const hit = c.stack.find((l) => l.id === id);
      if (!hit) throw new Error(`No layer with id ${id} in comp ${c.id}`);
      return hit;
    },
  };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  return { comp, ops: ctx.OPS };
}

// ---------------------------------------------------------------------------
// #149 — the matte layer is actually set
// ---------------------------------------------------------------------------

check("trackMatte.layerId assigns that layer as the matte, wherever it sits", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), matte = comp.by("Matte");    // matte is BELOW the art
  const out = ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "LUMA", layerId: matte.id } });
  assert.equal(art.trackMatteLayer, matte, "the matte layer must be the one named by layerId");
  assert.equal(art.trackMatteType, TrackMatteType.LUMA);
  assert.deepEqual(JSON.parse(JSON.stringify(art.calls)), [["setTrackMatte", matte.id, TrackMatteType.LUMA]]);
  assert.deepEqual({ ...out.trackMatte }, { type: "LUMA", layerId: matte.id, matteEnabled: false });
});

check("a type without layerId keeps the current matte layer", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), matte = comp.by("Matte");
  ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "ALPHA", layerId: matte.id } });
  ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "ALPHA_INVERTED" } });
  assert.equal(art.trackMatteLayer, matte);
  assert.equal(art.trackMatteType, TrackMatteType.ALPHA_INVERTED);
});

check("NO_TRACK_MATTE removes the matte through removeTrackMatte", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), matte = comp.by("Matte");
  ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "ALPHA", layerId: matte.id } });
  const out = ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "NO_TRACK_MATTE" } });
  assert.equal(art.trackMatteLayer, null);
  assert.equal(art.trackMatteType, TrackMatteType.NO_TRACK_MATTE);
  assert.equal(out.trackMatte.layerId, null);
});

check("a type alone on a layer with no matte is refused, not reported as done", () => {
  // Measured on 26.5: trackMatteType on a matte-less layer 1 answered ok and set nothing.
  const { comp, ops } = scene();
  const art = comp.by("Art");
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, name: "X", trackMatte: { type: "LUMA" } }),
    /has no track matte layer, so trackMatte\.type LUMA alone has nothing to apply to\. Pass trackMatte\.layerId.*Nothing was changed/,
  );
  assert.equal(art.name, "Art");
  assert.equal(art.trackMatteType, TrackMatteType.NO_TRACK_MATTE);
});

check("a matte layer that does not resolve is refused, and nothing in the call is written", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, name: "Renamed", trackMatte: { type: "ALPHA", layerId: 999 } }),
    /trackMatte\.layerId 999 is not a layer.*Nothing was changed/,
  );
  assert.equal(art.name, "Art", "the rename in the same call must not have landed");
  assert.equal(art.trackMatteLayer, null);
});

check("self as matte, and a layerId with NO_TRACK_MATTE, are refused", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  assert.throws(() => ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "ALPHA", layerId: art.id } }), /its own track matte/);
  assert.throws(() => ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "NO_TRACK_MATTE", layerId: comp.by("Matte").id } }), /takes no layerId/);
});

check("a matte AE did not take is an error, not an ok", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), matte = comp.by("Matte");
  art.setTrackMatte = function (layer, type) { this.trackMatteType = type; };   // AE ignores the layer
  assert.throws(
    () => ops.set_layer({
      compId: 100, layerId: art.id, name: "Renamed", shy: true, blendingMode: "SCREEN",
      trackMatte: { type: "ALPHA", layerId: matte.id },
    }),
    /reports no matte layer afterwards\..*Nothing else in this call was written\. Not written: name, shy, blendingMode\./,
  );
  // The matte is written first, so its failed read-back leaves the rest alone.
  assert.equal(art.name, "Art");
  assert.equal(art.shy, false);
  assert.equal(art.blendingMode, BlendingMode.NORMAL);
});

check("a write AE refuses after the matte names what was already applied", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), matte = comp.by("Matte");
  Object.defineProperty(art, "inPoint", {
    get() { return 0; },
    set() { throw new Error("After Effects error: value out of range"); },
  });
  assert.throws(
    () => ops.set_layer({
      compId: 100, layerId: art.id, name: "Renamed", inPoint: 99, stretch: 50,
      trackMatte: { type: "ALPHA", layerId: matte.id },
    }),
    (e) => {
      assert.match(e.message, /could not set inPoint: After Effects error: value out of range/);
      assert.match(e.message, /Already applied by this call: trackMatte \(matte layer 12's video is now off\), name\./);
      assert.match(e.message, /Not written: stretch\./);
      return true;
    },
  );
  assert.equal(art.trackMatteLayer, matte, "the matte did land, and the error said so");
  assert.equal(art.stretch, 100);
});

check("the 'video is now off' note appears only when the matte's video is off", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), matte = comp.by("Matte");
  // An AE path that attaches the matte but leaves its video on.
  art.setTrackMatte = function (layer, type) { this._matte = layer; this.trackMatteType = type; };
  Object.defineProperty(art, "inPoint", { get() { return 0; }, set() { throw new Error("refused"); } });
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, inPoint: 1, trackMatte: { type: "ALPHA", layerId: matte.id } }),
    (e) => {
      assert.match(e.message, /Already applied by this call: trackMatte\./);
      assert.doesNotMatch(e.message, /video is now off/);
      return true;
    },
  );
  assert.equal(matte.enabled, true);
});

check("an unlock is written first and a lock last", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  // AE refuses changes to a locked layer; the mock does too, for name.
  let name = art.name;
  Object.defineProperty(art, "name", {
    get() { return name; },
    set(v) { if (this.locked) throw new Error("layer is locked"); name = v; },
  });
  art.locked = true;
  ops.set_layer({ compId: 100, layerId: art.id, locked: false, name: "Unlocked" });
  assert.equal(art.name, "Unlocked");
  ops.set_layer({ compId: 100, layerId: art.id, locked: true, name: "Locked" });
  assert.equal(art.name, "Locked");
  assert.equal(art.locked, true);
});

check("what can be known up front is refused before any write", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art"), cam = comp.by("Cam"), matte = comp.by("Matte");
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, inPoint: 3, outPoint: 2, trackMatte: { type: "ALPHA", layerId: matte.id } }),
    /outPoint 2 must be after inPoint 3\. Nothing was changed/,
  );
  assert.equal(art.trackMatteLayer, null);
  assert.equal(matte.enabled, true);
  assert.throws(() => ops.set_layer({ compId: 100, layerId: cam.id, name: "X", blendingMode: "ADD" }), /is a camera, which has no blendingMode/);
  assert.equal(cam.name, "Cam");
  assert.throws(() => ops.set_layer({ compId: 100, layerId: art.id, stretch: 0 }), /stretch 0/);
});

check("a camera cannot take a matte, and cannot be one", () => {
  const { comp, ops } = scene();
  const cam = comp.by("Cam"), art = comp.by("Art");
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: cam.id, trackMatte: { type: "ALPHA", layerId: art.id } }),
    /is a camera; track mattes apply only to layers with pixels/,
  );
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "ALPHA", layerId: cam.id } }),
    /is a camera; a camera or light has no pixels/,
  );
  assert.equal(art.trackMatteLayer, null);
});

check("an AE without setTrackMatte refuses layerId instead of ignoring it", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  art.setTrackMatte = undefined;
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, trackMatte: { type: "ALPHA", layerId: comp.by("Matte").id } }),
    /After Effects 2023 or later/,
  );
});

// ---------------------------------------------------------------------------
// #150 — unknown names refused, at both layers
// ---------------------------------------------------------------------------

check("a blend mode the running AE does not define is refused before any write", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  // HARD_MIX is in the schema's list but not in this mock AE's BlendingMode.
  assert.throws(
    () => ops.set_layer({ compId: 100, layerId: art.id, shy: true, blendingMode: "HARD_MIX" }),
    /blendingMode 'HARD_MIX' is not one of After Effects' BlendingMode names/,
  );
  assert.equal(art.shy, false);
  assert.equal(art.blendingMode, BlendingMode.NORMAL);
  ops.set_layer({ compId: 100, layerId: art.id, blendingMode: "MULTIPLY" });
  assert.equal(art.blendingMode, BlendingMode.MULTIPLY);
});

check("an unknown matte type is refused", () => {
  const { comp, ops } = scene();
  assert.throws(() => ops.set_layer({ compId: 100, layerId: comp.by("Art").id, trackMatte: { type: "ALPHA_INVERT" } }), /TrackMatteType/);
});

check("an unknown mask mode is refused, and add_mask leaves no mask behind", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  assert.throws(() => ops.add_mask({ compId: 100, layerId: art.id, vertices: [[0, 0], [1, 0], [1, 1]], mode: "MULTIPLY" }), /MaskMode/);
  assert.equal(art.masks.length, 0, "the mask must not have been created");
  ops.add_mask({ compId: 100, layerId: art.id, vertices: [[0, 0], [1, 0], [1, 1]], mode: "SUBTRACT" });
  assert.equal(art.masks[0].maskMode, MaskMode.SUBTRACT);
  assert.throws(() => ops.set_mask({ compId: 100, layerId: art.id, maskIndex: 1, mode: "XOR", inverted: true }), /MaskMode/);
  assert.equal(art.masks[0].inverted, false, "set_mask must refuse before writing anything");
  assert.equal(art.masks[0].maskMode, MaskMode.SUBTRACT);
});

check("the schema closes the names, case-insensitively, and forwards AE's spelling", () => {
  const set = S.StrictOpSchemas.set_layer;
  assert.equal(set.parse({ compId: 1, layerId: 2, blendingMode: "multiply" }).blendingMode, "MULTIPLY");
  assert.equal(set.parse({ compId: 1, layerId: 2, trackMatte: { type: "Luma_Inverted", layerId: 3 } }).trackMatte.type, "LUMA_INVERTED");
  assert.equal(set.safeParse({ compId: 1, layerId: 2, blendingMode: "MULTIPLYY" }).success, false);
  assert.equal(set.safeParse({ compId: 1, layerId: 2, trackMatte: { type: "ALPHA_INVERT" } }).success, false);
  assert.equal(S.StrictOpSchemas.add_mask.parse({ compId: 1, layerId: 2, vertices: [[0, 0]], mode: "subtract" }).mode, "SUBTRACT");
  assert.equal(S.StrictOpSchemas.set_mask.safeParse({ compId: 1, layerId: 2, maskIndex: 1, mode: "XOR" }).success, false);
});

check("lineCap, lineJoin and fillRule take names (or AE's 1-based numbers) and nothing else", () => {
  const add = S.StrictOpSchemas.add_shape_content;
  const stroke = (extra) => add.safeParse({ compId: 1, layerId: 2, content: { type: "stroke", ...extra } });
  assert.equal(stroke({ lineCap: "round", lineJoin: "bevel" }).success, true);
  assert.equal(stroke({ lineCap: 3 }).success, true);
  assert.equal(stroke({ lineCap: 7 }).success, false);
  assert.equal(stroke({ lineJoin: "square" }).success, false);
  assert.equal(stroke({ lineCap: "Round" }).data.content.lineCap, "round", "names are case-insensitive");
  assert.equal(add.parse({ compId: 1, layerId: 2, content: { type: "fill", fillRule: "EvenOdd" } }).content.fillRule, "evenodd");
  assert.equal(add.safeParse({ compId: 1, layerId: 2, content: { type: "fill", fillRule: "evenodd" } }).success, true);
  assert.equal(add.safeParse({ compId: 1, layerId: 2, content: { type: "fill", fillRule: 0 } }).success, false);
});

check("the English spelling of SILHOUETE_ALPHA is accepted and forwarded as Adobe's", () => {
  const set = S.StrictOpSchemas.set_layer;
  assert.equal(set.parse({ compId: 1, layerId: 2, blendingMode: "silhouette_alpha" }).blendingMode, "SILHOUETE_ALPHA");
  assert.equal(set.parse({ compId: 1, layerId: 2, blendingMode: "SILHOUETE_ALPHA" }).blendingMode, "SILHOUETE_ALPHA");
});

check("add_shape_content maps line cap, line join and fill rule names to AE's numbers", () => {
  const { comp, ops } = scene();
  const art = comp.by("Art");
  ops.add_shape_content({ compId: 100, layerId: art.id, content: { type: "stroke", lineCap: "projecting", lineJoin: "Round" } });
  const stroke = art.contents.nodes[0];
  assert.equal(stroke.props["ADBE Vector Stroke Line Cap"].value, 3);
  assert.equal(stroke.props["ADBE Vector Stroke Line Join"].value, 2);
  ops.add_shape_content({ compId: 100, layerId: art.id, content: { type: "stroke", lineCap: 2 } });
  assert.equal(art.contents.nodes[1].props["ADBE Vector Stroke Line Cap"].value, 2, "a bare number still passes through");
  ops.add_shape_content({ compId: 100, layerId: art.id, content: { type: "fill", fillRule: "evenodd" } });
  assert.equal(art.contents.nodes[2].props["ADBE Vector Fill Rule"].value, 2);
  // A name the table lacks (only reachable past the schema, e.g. run_jsx) is
  // refused and the half-built node removed, never written as a string.
  assert.throws(
    () => ops.add_shape_content({ compId: 100, layerId: art.id, content: { type: "stroke", lineCap: "square" } }),
    /lineCap \('square' is not a known name\)/,
  );
  assert.equal(art.contents.nodes.length, 3);
});

const { toolInputSchema } = await import(pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "server.js")).href);
check("the emitted schemas show the model every accepted name", () => {
  const js = toolInputSchema("set_layer");
  assert.ok(js.properties.blendingMode.enum.includes("MULTIPLY"));
  assert.deepEqual(js.properties.trackMatte.properties.type.enum, [...S.TRACK_MATTE_TYPES]);
  assert.deepEqual(toolInputSchema("add_mask").properties.mode.enum, [...S.MASK_MODES]);
});

console.log(`layer-enum-names: ${passed} checks passed`);
