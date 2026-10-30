// The capability gaps of issue #181, run against the fake After Effects:
//
//   - set_layer's timeline switches (motion blur, collapse, quality, frame
//     blending, auto-orient, …) and set_comp's motion-blur/frame-blending switch
//   - set_transform's separateDimensions with xPosition/yPosition/zPosition
//   - keyframe flags on set_interpolation (continuous, auto-bezier, roving),
//     read back by get_keyframes, and a per-dimension ease on set_temporal_ease
//   - box (paragraph) text on create_text_layer and set_text
//   - the Repeater's Transform group on add_shape_content
//
// Every one of these was reachable only through run_jsx before. Each test
// fails without the feature: the field was stripped or refused by the strict
// schema, or never reached After Effects.
//
// The fake is extended here, in-realm, with the surface these need — it is not
// a claim about how After Effects behaves beyond the scripting reference. The
// live recipe in the PR is the word on AE itself.
//
//   node tests/unit/capability-gaps.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFakeAe } from "./lib/fake-ae.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const S = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.error(`capability-gaps FAILED: ${name}`); throw e; }
  passed++;
}
function ok(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${res.error}`);
  return res.result;
}
function refused(res, pattern, what) {
  assert.equal(res.ok, false, `${what} should have been refused, answered ${JSON.stringify(res.result)}`);
  assert.match(res.error, pattern);
}

const FILES = ["ids.jsx", "values.jsx", "comps.jsx", "layers.jsx", "transforms.jsx", "keyframes.jsx", "text.jsx", "shapes.jsx"];

// In-realm additions: the enumerations, layer switches, separable Position,
// keyframe flags, text documents and a shape Repeater.
const EXTEND = `
  LayerQuality = { BEST: 4612, DRAFT: 4613, WIREFRAME: 4614 };
  LayerSamplingQuality = { BICUBIC: 4813, BILINEAR: 4812 };
  FrameBlendingType = { FRAME_MIX: 4013, NO_FRAME_BLEND: 4012, PIXEL_MOTION: 4014 };
  AutoOrientType = { ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214, CHARACTERS_TOWARD_CAMERA: 4215, NO_AUTO_ORIENT: 4212 };

  function addSwitches(l) {
    l.motionBlur = false; l.collapseTransformation = false; l.canSetCollapseTransformation = true;
    l.guideLayer = false; l.effectsActive = true; l.audioEnabled = true; l.hasAudio = true;
    l.quality = LayerQuality.BEST; l.samplingQuality = LayerSamplingQuality.BILINEAR;
    l.frameBlendingType = FrameBlendingType.NO_FRAME_BLEND; l.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
  }

  // Position's Separate Dimensions: each family is hidden (canSetExpression
  // false, measured on 26.5 for a hidden property) while the other is in use.
  function separable(l) {
    var tr = l.property("Transform");
    var pos = tr.property("ADBE Position");
    pos.dimensionsSeparated = false;
    Object.defineProperty(pos, "canSetExpression", { get: function () { return !pos.dimensionsSeparated; } });
    var names = ["X Position", "Y Position", "Z Position"];
    for (var i = 0; i < 3; i++) {
      var d = tr._add(new FakeProperty(names[i], "ADBE Position_" + i, pos.value[i] || 0, PropertyValueType.OneD));
      Object.defineProperty(d, "canSetExpression", { get: function () { return pos.dimensionsSeparated; } });
    }
  }

  // Keyframe flags, stored on the key. A spatial-only flag on a non-spatial
  // property throws, as AE does.
  var FLAGS = [["TemporalContinuous", false], ["TemporalAutoBezier", false], ["SpatialContinuous", true],
    ["SpatialAutoBezier", true], ["Roving", true]];
  FLAGS.forEach(function (f) {
    FakeProperty.prototype["key" + f[0]] = function (i) {
      if (f[1] && !this.isSpatial) throw new Error("not spatial");
      return !!this._key(i)[f[0]];
    };
    FakeProperty.prototype["set" + f[0] + "AtKey"] = function (i, v) {
      if (f[1] && !this.isSpatial) throw new Error("not spatial");
      this._key(i)[f[0]] = !!v;
    };
  });

  // Text: a TextDocument value; box text only from addBoxText.
  function textDoc(text, box) {
    return { text: text, font: "Arial", fontSize: 50, tracking: 0, justification: 7413, applyFill: true,
      fillColor: [1, 1, 1], boxText: !!box, boxTextSize: box ? [box[0], box[1]] : undefined };
  }
  function textLayer(c, id, text, box) {
    var l = c.addLayer(id, text || "Text", "text");
    var src = new FakeProperty("Source Text", "ADBE Text Document", textDoc(text, box), PropertyValueType.TEXT_DOCUMENT);
    l._root._add(src);
    return l;
  }
  var NEXT_ID = 50;
  function withLayersCollection(c) {
    c.layers = {
      addText: function (t) { return textLayer(c, NEXT_ID++, t, null); },
      addBoxText: function (size, t) { return textLayer(c, NEXT_ID++, t, size); }
    };
  }

  // A shape layer whose Contents can hold a Repeater with its Transform group.
  function shapeLayer(c, id) {
    var l = c.addLayer(id, "Shape", "shape");
    var T = PropertyValueType;
    var contents = l._root._add(new FakeGroup("Contents", "ADBE Root Vectors Group", true, function (mn) {
      if (mn !== "ADBE Vector Filter - Repeater") throw new Error("fake: only repeaters");
      var r = new FakeGroup("Repeater 1", mn, false);
      r._add(new FakeProperty("Copies", "ADBE Vector Repeater Copies", 3, T.OneD));
      r._add(new FakeProperty("Offset", "ADBE Vector Repeater Offset", 0, T.OneD));
      var tf = r._add(new FakeGroup("Transform", "ADBE Vector Repeater Transform", false));
      tf._add(new FakeProperty("Anchor Point", "ADBE Vector Repeater Anchor", [0, 0], T.TwoD_SPATIAL));
      tf._add(new FakeProperty("Position", "ADBE Vector Repeater Position", [100, 0], T.TwoD_SPATIAL));
      tf._add(new FakeProperty("Scale", "ADBE Vector Repeater Scale", [100, 100], T.TwoD));
      tf._add(new FakeProperty("Rotation", "ADBE Vector Repeater Rotation", 0, T.OneD));
      tf._add(new FakeProperty("Start Opacity", "ADBE Vector Repeater Opacity 1", 100, T.OneD));
      tf._add(new FakeProperty("End Opacity", "ADBE Vector Repeater Opacity 2", 100, T.OneD));
      return r;
    }));
    return l;
  }
`;

function scene() {
  const ae = loadFakeAe(FILES);
  ae.run(EXTEND);
  ae.run(`
    var C = FAKE.comp(100, "Main");
    C.motionBlur = false; C.frameBlending = false; C.bgColor = [0, 0, 0]; C.pixelAspect = 1;
    var CARD = C.addLayer(2, "Card", "av"); addSwitches(CARD); separable(CARD);
    var SOLID = C.addLayer(3, "Solid", "av"); addSwitches(SOLID);
    SOLID.canSetCollapseTransformation = false; SOLID.hasAudio = false;
    withLayersCollection(C);
  `);
  return ae;
}

// ---------------------------------------------------------------------------
// Layer and comp switches
// ---------------------------------------------------------------------------

check("set_layer sets the timeline switches, by name for the enum ones, and echoes them", () => {
  const ae = scene();
  const r = ok(ae.call("set_layer", {
    compId: 100, layerId: 2, motionBlur: true, collapseTransformation: true, guideLayer: true, effectsActive: false,
    audioEnabled: false, quality: "DRAFT", samplingQuality: "BICUBIC", frameBlendingType: "PIXEL_MOTION", autoOrient: "ALONG_PATH",
  }), "set_layer switches");
  assert.deepEqual(r.switches, {
    motionBlur: true, collapseTransformation: true, guideLayer: true, effectsActive: false, audioEnabled: false,
    quality: "DRAFT", samplingQuality: "BICUBIC", frameBlendingType: "PIXEL_MOTION", autoOrient: "ALONG_PATH",
  });
  const l = ae.json(`(function(l){return {mb:l.motionBlur,q:l.quality,fb:l.frameBlendingType,ao:l.autoOrient,fx:l.effectsActive};})(CARD)`);
  assert.deepEqual(l, { mb: true, q: 4613, fb: 4014, ao: 4213, fx: false });
});

check("the switch names reach set_layer through the schema, case-insensitively", () => {
  const parsed = S.SetLayer.parse({ compId: 1, layerId: 2, quality: "draft", frameBlendingType: "frame_mix", motionBlur: true });
  assert.equal(parsed.quality, "DRAFT");
  assert.equal(parsed.frameBlendingType, "FRAME_MIX");
  assert.equal(parsed.motionBlur, true);
  assert.throws(() => S.SetLayer.parse({ compId: 1, layerId: 2, quality: "ultra" }));
});

check("a switch the layer does not have is refused before anything is written", () => {
  const ae = scene();
  refused(ae.call("set_layer", { compId: 100, layerId: 3, name: "Renamed", collapseTransformation: true }),
    /no collapse-transformations .*Nothing was changed/, "collapse on a solid");
  refused(ae.call("set_layer", { compId: 100, layerId: 3, name: "Renamed", audioEnabled: true }),
    /has no audio.*Nothing was changed/, "audio on a silent layer");
  refused(ae.call("set_layer", { compId: 100, layerId: 3, name: "Renamed", autoOrient: "CHARACTERS_TOWARD_CAMERA" }),
    /only to a 3D text layer.*Nothing was changed/, "characters toward camera on a solid");
  assert.equal(ae.json("SOLID.name"), "Solid");
});

check("toward-camera auto-orient on a 2D layer is refused before anything is written (AE answers it with a modal)", () => {
  const ae = scene();
  // AE raises a blocking warning dialog here instead of throwing; the fake
  // stands in for that by recording the assignment.
  ae.run(`var ORIENTED = [];
    [CARD, SOLID].forEach(function (l) {
      var v = l.autoOrient;
      Object.defineProperty(l, "autoOrient", { get: function () { return v; }, set: function (x) {
        if (x === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST && !l.threeDLayer) ORIENTED.push(l.name);
        v = x; } });
    });`);
  refused(ae.call("set_layer", { compId: 100, layerId: 3, name: "Renamed", motionBlur: true, autoOrient: "CAMERA_OR_POINT_OF_INTEREST" }),
    /autoOrient CAMERA_OR_POINT_OF_INTEREST needs a 3D layer.*is 2D.*threeDLayer:true.*Nothing was changed/, "camera orient on a 2D solid");
  refused(ae.call("set_layer", { compId: 100, layerId: 3, threeDLayer: false, autoOrient: "CAMERA_OR_POINT_OF_INTEREST" }),
    /needs a 3D layer.*is made 2D by this call.*Nothing was changed/, "camera orient while turning 3D off");
  assert.deepEqual(ae.json("[SOLID.name, SOLID.motionBlur, SOLID.autoOrient, ORIENTED.length]"), ["Solid", false, 4212, 0]);

  // threeDLayer:true in the same call is written first, so it is honoured.
  const r = ok(ae.call("set_layer", { compId: 100, layerId: 3, threeDLayer: true, autoOrient: "CAMERA_OR_POINT_OF_INTEREST" }), "3D + camera orient");
  assert.equal(r.switches.autoOrient, "CAMERA_OR_POINT_OF_INTEREST");
  // An already-3D layer needs nothing else; ALONG_PATH stays fine on 2D.
  ae.run("CARD.threeDLayer = true;");
  ok(ae.call("set_layer", { compId: 100, layerId: 2, autoOrient: "CAMERA_OR_POINT_OF_INTEREST" }), "camera orient on a 3D layer");
  assert.deepEqual(ae.json("[SOLID.threeDLayer, ORIENTED.length]"), [true, 0]);
});

check("turning 3D off under a toward-camera orient never passes through 2D-and-oriented", () => {
  const ae = scene();
  // Record every moment a layer is 2D while oriented at the camera — the state
  // After Effects answers with a modal.
  ae.run(`var MODAL = [];
    function watch(l) {
      var o = l.autoOrient, d = l.threeDLayer;
      function bad() { return !d && (o === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST || o === AutoOrientType.CHARACTERS_TOWARD_CAMERA); }
      Object.defineProperty(l, "autoOrient", { get: function () { return o; }, set: function (x) { o = x; if (bad()) MODAL.push(l.name); } });
      Object.defineProperty(l, "threeDLayer", { get: function () { return d; }, set: function (x) { d = x; if (bad()) MODAL.push(l.name); } });
    }
    watch(CARD);
    CARD.threeDLayer = true; CARD.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    var TXT = textLayer(C, 9, "Hi", null); TXT.threeDPerChar = true; watch(TXT);
    TXT.threeDLayer = true; TXT.autoOrient = AutoOrientType.CHARACTERS_TOWARD_CAMERA;`);
  refused(ae.call("set_layer", { compId: 100, layerId: 2, name: "Flat", threeDLayer: false }),
    /is auto-oriented CAMERA_OR_POINT_OF_INTEREST.*threeDLayer:false alone.*NO_AUTO_ORIENT.*Nothing was changed/, "3D off alone");
  refused(ae.call("set_layer", { compId: 100, layerId: 9, threeDLayer: false }),
    /is auto-oriented CHARACTERS_TOWARD_CAMERA.*Nothing was changed/, "per-character text 3D off alone");
  assert.deepEqual(ae.json("[CARD.name, CARD.threeDLayer, TXT.threeDLayer, MODAL.length]"), ["Card", true, true, 0]);
  // With the orient cleared in the same call, the orient goes first.
  const r = ok(ae.call("set_layer", { compId: 100, layerId: 2, threeDLayer: false, autoOrient: "NO_AUTO_ORIENT" }), "3D off + orient off");
  assert.equal(r.switches.autoOrient, "NO_AUTO_ORIENT");
  ok(ae.call("set_layer", { compId: 100, layerId: 9, threeDLayer: false, autoOrient: "ALONG_PATH" }), "text 3D off + along path");
  assert.deepEqual(ae.json("[CARD.threeDLayer, TXT.threeDLayer, MODAL]"), [false, false, []]);
});

check("a threeDLayer:true AE ignores stops the call before a toward-camera orient is written", () => {
  const ae = scene();
  // A layer that cannot be 3D (an audio-only layer): the assignment is taken
  // and nothing changes. Orienting it at the camera afterwards is the modal.
  ae.run(`var MODAL = 0;
    Object.defineProperty(SOLID, "threeDLayer", { get: function () { return false; }, set: function () {} });
    var ao = SOLID.autoOrient;
    Object.defineProperty(SOLID, "autoOrient", { get: function () { return ao; }, set: function (x) {
      if (x === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST) MODAL++; ao = x; } });`);
  refused(ae.call("set_layer", { compId: 100, layerId: 3, name: "Renamed", motionBlur: true, threeDLayer: true, autoOrient: "CAMERA_OR_POINT_OF_INTEREST" }),
    /could not set threeDLayer: .*reads false afterwards.*Nothing else in this call was written\. Not written: name, motionBlur, autoOrient/,
    "3D that did not take");
  assert.deepEqual(ae.json("[SOLID.name, SOLID.motionBlur, SOLID.autoOrient, MODAL]"), ["Solid", false, 4212, 0]);
});

check("turning 3D off is refused when the orient cannot be told (fail closed)", () => {
  const ae = scene();
  ae.run("CARD.threeDLayer = true; delete AutoOrientType;");
  refused(ae.call("set_layer", { compId: 100, layerId: 2, name: "Flat", threeDLayer: false }),
    /cannot tell whether layer 2 .*no AutoOrientType.*Nothing was changed/, "missing enum");
  assert.deepEqual(ae.json("[CARD.name, CARD.threeDLayer]"), ["Card", true]);
  // A layer already 2D has nothing to fear from threeDLayer:false.
  ok(ae.call("set_layer", { compId: 100, layerId: 3, threeDLayer: false }), "2D stays 2D");
});

check("characters-toward-camera needs a 3D text layer with per-character 3D", () => {
  const ae = scene();
  ae.run(`var TXT = textLayer(C, 9, "Hi", null);
    TXT.autoOrient = AutoOrientType.NO_AUTO_ORIENT; TXT.threeDPerChar = false;`);
  refused(ae.call("set_layer", { compId: 100, layerId: 9, name: "X", autoOrient: "CHARACTERS_TOWARD_CAMERA" }),
    /needs a 3D layer.*Nothing was changed/, "2D text");
  refused(ae.call("set_layer", { compId: 100, layerId: 9, name: "X", threeDLayer: true, autoOrient: "CHARACTERS_TOWARD_CAMERA" }),
    /needs per-character 3D.*Nothing was changed/, "3D text without per-character 3D");
  assert.deepEqual(ae.json("[TXT.name, TXT.threeDLayer, TXT.autoOrient]"), ["Hi", false, 4212]);
  ae.run("TXT.threeDLayer = true; TXT.threeDPerChar = true;");
  ok(ae.call("set_layer", { compId: 100, layerId: 9, autoOrient: "CHARACTERS_TOWARD_CAMERA" }), "per-character 3D text");
});

check("an enumeration the running AE lacks is refused, nothing changed", () => {
  const ae = scene();
  ae.run("delete AutoOrientType;");
  refused(ae.call("set_layer", { compId: 100, layerId: 2, motionBlur: true, autoOrient: "ALONG_PATH" }),
    /autoOrient 'ALONG_PATH' is not one of After Effects' AutoOrientType names\. Nothing was changed/, "missing enum");
  assert.equal(ae.json("CARD.motionBlur"), false);
});

check("a switch After Effects takes but does not apply is an error naming what landed", () => {
  const ae = scene();
  // Frame blending on a layer whose source does not move: the assignment is
  // accepted and the value stays where it was.
  ae.run(`Object.defineProperty(CARD, "frameBlendingType", { get: function () { return FrameBlendingType.NO_FRAME_BLEND; }, set: function () {} });`);
  refused(ae.call("set_layer", { compId: 100, layerId: 2, motionBlur: true, frameBlendingType: "FRAME_MIX", autoOrient: "ALONG_PATH" }),
    /could not set frameBlendingType: .*reads .* afterwards.*Already applied by this call: motionBlur\. Not written: autoOrient/,
    "frame blending that did not land");
});

check("set_comp sets and reads back the comp's motion-blur and frame-blending switches", () => {
  const ae = scene();
  const r = ok(ae.call("set_comp", { compId: 100, motionBlur: true, frameBlending: true }), "set_comp switches");
  assert.equal(r.motionBlur, true);
  assert.equal(r.frameBlending, true);
  assert.deepEqual(ae.json("[C.motionBlur, C.frameBlending]"), [true, true]);
});

// ---------------------------------------------------------------------------
// Separate dimensions
// ---------------------------------------------------------------------------

check("separateDimensions:true and xPosition/yPosition write the separated values", () => {
  const ae = scene();
  const r = ok(ae.call("set_transform", { compId: 100, layerId: 2, separateDimensions: true, properties: { xPosition: 120, yPosition: 340 } }),
    "separate and write");
  assert.equal(r.dimensionsSeparated, true);
  assert.deepEqual(ae.json(`[CARD.property("Transform").property("ADBE Position").dimensionsSeparated,
    CARD.property("Transform").property("ADBE Position_0").value, CARD.property("Transform").property("ADBE Position_1").value]`),
  [true, 120, 340]);
});

check("x/y position on joined dimensions, and position on separated ones, are refused with nothing written", () => {
  const ae = scene();
  refused(ae.call("set_transform", { compId: 100, layerId: 2, properties: { xPosition: 5, opacity: 10 } }),
    /xPosition exist only while Position's dimensions are separated.*Nothing was changed.*separateDimensions:true/, "x on joined");
  refused(ae.call("set_transform", { compId: 100, layerId: 2, separateDimensions: true, properties: { position: [1, 2], opacity: 10 } }),
    /dimensions separated \(by this call\).*Nothing was changed.*xPosition\/yPosition/, "position while separating");
  refused(ae.call("set_transform", { compId: 100, layerId: 2, separateDimensions: true, properties: { zPosition: 5 } }),
    /is 2D, and zPosition exists only on a 3D layer/, "z on a 2D layer");
  assert.deepEqual(ae.json(`[CARD.property("Transform").property("ADBE Position").dimensionsSeparated, CARD.property("Transform").property("ADBE Opacity").value]`),
    [false, 100]);
});

check("separateDimensions:false joins them again and position is writable in the same call", () => {
  const ae = scene();
  ae.run(`CARD.property("Transform").property("ADBE Position").dimensionsSeparated = true;`);
  const r = ok(ae.call("set_transform", { compId: 100, layerId: 2, separateDimensions: false, properties: { position: [10, 20] } }), "join");
  assert.equal(r.dimensionsSeparated, false);
  assert.deepEqual(ae.json(`CARD.property("Transform").property("ADBE Position").value`), [10, 20]);
});

// ---------------------------------------------------------------------------
// Keyframe flags and per-dimension ease
// ---------------------------------------------------------------------------

function keyed() {
  const ae = scene();
  ae.run(`
    var P = CARD.property("Transform").property("ADBE Position");
    P.setValueAtTime(0, [0, 0]); P.setValueAtTime(1, [100, 0]); P.setValueAtTime(2, [200, 50]);
    var SC = CARD.property("Transform").property("ADBE Scale");
    SC.setValueAtTime(0, [100, 100, 100]); SC.setValueAtTime(1, [50, 50, 100]);
  `);
  return ae;
}
const POS = ["Transform", "Position"];
const SCALE = ["Transform", "Scale"];

check("set_interpolation sets keyframe flags, reads them back, and get_keyframes reports them", () => {
  const ae = keyed();
  const r = ok(ae.call("set_interpolation", {
    compId: 100, layerId: 2, propertyPath: POS, keyIndex: 2, roving: true, spatialAutoBezier: true, temporalContinuous: true,
  }), "flags");
  assert.deepEqual(r.flags, { temporalContinuous: true, temporalAutoBezier: false, spatialContinuous: false, spatialAutoBezier: true, roving: true });
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "get_keyframes");
  assert.equal(keys[1].flags.roving, true);
  assert.equal(keys[0].flags.roving, false);
  // A non-spatial property reports only the temporal flags.
  const sk = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: SCALE }), "scale keys");
  assert.deepEqual(Object.keys(sk[0].flags).sort(), ["temporalAutoBezier", "temporalContinuous"]);
});

check("a flag that cannot apply is refused before the interpolation is touched", () => {
  const ae = keyed();
  refused(ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: POS, keyIndex: 1, in: "hold", roving: true }),
    /first and last keys of a property cannot rove.*Nothing was changed/, "roving on the first key");
  refused(ae.call("set_interpolation", { compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1, in: "hold", spatialContinuous: true }),
    /spatialContinuous applies only to a spatial property.*Nothing was changed/, "spatial flag on Scale");
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "keys");
  assert.equal(keys[0].interpolation.in, "linear");
});

check("set_interpolation with nothing to set is refused by the schema", () => {
  assert.throws(() => S.SetInterpolation.parse({ compId: 1, layerId: 2, propertyPath: POS, keyIndex: 1 }));
  assert.doesNotThrow(() => S.SetInterpolation.parse({ compId: 1, layerId: 2, propertyPath: POS, keyIndex: 1, roving: false }));
});

check("set_temporal_ease takes one pair per dimension and get_keyframes reports them", () => {
  const ae = keyed();
  const ease = [{ influence: 80, speed: 0 }, { influence: 20, speed: 0 }, { influence: 50, speed: 0 }];
  const r = ok(ae.call("set_temporal_ease", { compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1, easeOut: ease }), "per-dim ease");
  assert.equal(r.easeDimensions, 3);
  const keys = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: SCALE }), "keys");
  assert.deepEqual(keys[0].ease.perDimension.easeOut, ease);
  // A uniform key carries no perDimension.
  assert.equal(keys[1].ease.perDimension, undefined);
});

check("a per-dimension ease of a length the property does not take is refused, nothing changed", () => {
  const ae = keyed();
  const before = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: SCALE }), "before");
  refused(ae.call("set_temporal_ease", {
    compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1, easeIn: [{ influence: 80, speed: 0 }, { influence: 20, speed: 0 }],
  }), /the ease was not changed.*2 per-dimension eases passed as easeIn cannot be written at another count/, "wrong length");
  // A count is either rejected (sent, refused) or not tried (never sent) —
  // never both, which is what the message used to say.
  const msg = ae.call("set_temporal_ease", {
    compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1, easeIn: [{ influence: 80, speed: 0 }, { influence: 20, speed: 0 }],
  }).error;
  const rejected = (msg.match(/rejected ease arrays of ([\d, ]+) entries/) || [])[1].split(", ").map(Number);
  const notTried = (msg.match(/Not tried at ([\d, ]+):/) || [])[1].split(", ").map(Number);
  assert.deepEqual(rejected, [2], msg);
  assert.ok(notTried.length > 0 && notTried.every((n) => !rejected.includes(n)), msg);
  // Both sides passed: nothing is kept, so the blame is the passed list that
  // differs per dimension — even when the other one is uniform.
  const both = ae.call("set_temporal_ease", {
    compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1,
    easeIn: [{ influence: 50, speed: 0 }, { influence: 50, speed: 0 }],
    easeOut: [{ influence: 80, speed: 0 }, { influence: 20, speed: 0 }],
  }).error;
  assert.doesNotMatch(both, /kept side|null/, both);
  assert.match(both, /the 2 per-dimension eases passed as easeOut cannot be written at another count/, both);
  const after = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: SCALE }), "after");
  assert.deepEqual(after, before);
});

check("a refusal caused by the side the caller did not send names that side", () => {
  const ae = keyed();
  // Key 1's easeOut already differs per dimension (3 values).
  ok(ae.call("set_temporal_ease", { compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1,
    easeOut: [{ influence: 80, speed: 0 }, { influence: 20, speed: 0 }, { influence: 50, speed: 0 }] }), "existing per-dim easeOut");
  const before = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: SCALE }), "before");
  const msg = ae.call("set_temporal_ease", { compId: 100, layerId: 2, propertyPath: SCALE, keyIndex: 1,
    easeIn: [{ influence: 70, speed: 0 }, { influence: 10, speed: 0 }] }).error;
  assert.match(msg, /the existing easeOut on this key differs per dimension \(3 values\).*pass easeOut too/, msg);
  assert.match(msg, /the 2 per-dimension eases passed as easeIn/, msg);
  assert.deepEqual(ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: SCALE }), "after"), before);
});

check("differing per-dimension pairs on a spatial property are refused; identical ones collapse to one", () => {
  const ae = keyed();
  const before = ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "before");
  refused(ae.call("set_temporal_ease", {
    compId: 100, layerId: 2, propertyPath: POS, keyIndex: 2, easeIn: [{ influence: 80, speed: 0 }, { influence: 20, speed: 0 }],
  }), /is spatial and eases along its motion path with one pair.*Nothing was changed/, "per-dim on Position");
  assert.deepEqual(ok(ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: POS }), "after"), before);
  const r = ok(ae.call("set_temporal_ease", {
    compId: 100, layerId: 2, propertyPath: POS, keyIndex: 2, easeIn: [{ influence: 60, speed: 0 }, { influence: 60, speed: 0 }],
  }), "identical pairs");
  assert.equal(r.easeDimensions, 1);
});

check("set_transform takes separateDimensions alone, and refuses a call with neither", () => {
  assert.doesNotThrow(() => S.SetTransform.parse({ compId: 1, layerId: 2, separateDimensions: true }));
  assert.throws(() => S.SetTransform.parse({ compId: 1, layerId: 2 }));
  const ae = scene();
  ok(ae.call("set_transform", { compId: 100, layerId: 2, separateDimensions: true }), "switch only");
  assert.equal(ae.json(`CARD.property("Transform").property("ADBE Position").dimensionsSeparated`), true);
});

// ---------------------------------------------------------------------------
// Box text
// ---------------------------------------------------------------------------

check("create_text_layer boxSize makes box text and echoes its size", () => {
  const ae = scene();
  const r = ok(ae.call("create_text_layer", { compId: 100, text: "Wrapped copy", boxSize: [400, 200] }), "box text");
  assert.deepEqual(r.boxSize, [400, 200]);
  assert.equal(ae.json(`C.layer(C.numLayers).property("Source Text").value.boxText`), true);
});

check("set_text boxSize resizes box text and is refused on point text", () => {
  const ae = scene();
  const box = ok(ae.call("create_text_layer", { compId: 100, text: "Box", boxSize: [400, 200] }), "box");
  const r = ok(ae.call("set_text", { compId: 100, layerId: box.id, boxSize: [600, 120] }), "resize");
  assert.deepEqual(r.boxSize, [600, 120]);
  // A fractional size After Effects truncates is a write that landed.
  ae.run(`(function(){var src=C.layer(C.numLayers).property("Source Text"); var sv=src.setValue;
    src.setValue=function(d){ if (d.boxTextSize) d.boxTextSize=[Math.floor(d.boxTextSize[0]), Math.floor(d.boxTextSize[1])]; sv.call(src,d); };})()`);
  assert.deepEqual(ok(ae.call("set_text", { compId: 100, layerId: box.id, boxSize: [300.9, 99.9] }), "fractional").boxSize, [300, 99]);
  const point = ok(ae.call("create_text_layer", { compId: 100, text: "Point" }), "point");
  refused(ae.call("set_text", { compId: 100, layerId: point.id, text: "Changed", boxSize: [600, 120] }),
    /is point text.*cannot convert.*Nothing was changed/, "box size on point text");
  assert.equal(ae.json(`C.layer(C.numLayers).property("Source Text").value.text`), "Point");
});

// ---------------------------------------------------------------------------
// Repeater transform
// ---------------------------------------------------------------------------

check("add_shape_content sets a Repeater's Transform group", () => {
  const ae = scene();
  ae.run(`var SH = shapeLayer(C, 9);`);
  const r = ok(ae.call("add_shape_content", {
    compId: 100, layerId: 9,
    content: { type: "repeater", copies: 5, transform: { position: [40, 0], scale: [90, 90], rotation: 15, startOpacity: 100, endOpacity: 20 } },
  }), "repeater");
  assert.ok(r.applied.includes("transform.position") && r.applied.includes("copies"));
  const tf = ae.json(`(function(){var t=SH.property("Contents").property(1).property("ADBE Vector Repeater Transform");
    return [t.property("ADBE Vector Repeater Position").value, t.property("ADBE Vector Repeater Scale").value,
      t.property("ADBE Vector Repeater Rotation").value, t.property("ADBE Vector Repeater Opacity 2").value];})()`);
  assert.deepEqual(tf, [[40, 0], [90, 90], 15, 20]);
});

check("an unknown Repeater transform key is refused by the schema", () => {
  assert.throws(() => S.AddShapeContent.parse({ compId: 1, layerId: 2, content: { type: "repeater", transform: { skew: 4 } } }));
});

console.log(`capability-gaps: ${passed} checks passed`);
