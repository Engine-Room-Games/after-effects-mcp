// A minimal fake After Effects object model, for running the real
// packages/jsx handlers offline (issue #167).
//
// Every other mock-DOM suite in tests/unit builds the few objects its one op
// touches. That was right for them and is why 30 of the 71 in-AE ops were never
// executed by anything: each new op needed its own mock. This is the shared
// one — comps, layers, properties with keyframes, masks, markers, effects —
// small enough to read in one sitting, and deliberately not a simulator:
//
//   - It implements the documented scripting API surface the handlers call,
//     with After Effects' own enum values and its 1-based indices.
//   - Where AE refuses something, it refuses too (a keyframe index out of
//     range, setValue on a keyed property, an ease array of the wrong length,
//     an interpolation type that is not one), so a handler that only works
//     because the fake is lenient fails here.
//   - It does not interpolate between keyframes, render, or know about
//     expressions beyond storing the text.
//
// The model is defined *inside* the VM realm (`installFakeAe` is stringified
// and evaluated there), because the handlers test `instanceof Array` and
// `instanceof CompItem`, and an object built in this realm fails both.
//
// Usage:
//   const ae = loadFakeAe(["comps.jsx", "layers.jsx", ...]);
//   const comp = ae.run(`FAKE.comp(100, "Main")`);         // build state in-realm
//   const res = ae.call("set_layer", { compId: 100, ... }); // through dispatch()
//   res.ok / res.result / res.error, as plain JSON — what the panel forwards.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jsxDir = path.join(root, "packages", "jsx");

// The bundle's order (scripts/bundle-jsx.mjs). Whatever subset a test asks
// for is loaded in this order, so a helper is defined before a later file
// reads it at top level exactly as in the shipped bundle.
const BUNDLE_ORDER = [
  "core.jsx", "ids.jsx", "values.jsx", "comps.jsx", "layers.jsx", "snapshot.jsx", "checkpoint.jsx",
  "transforms.jsx", "keyframes.jsx", "expressions.jsx", "retime.jsx", "motion.jsx", "effects.jsx", "text.jsx", "shapes.jsx", "masks.jsx",
  "markers.jsx", "vision.jsx", "footage.jsx", "audio.jsx", "mogrt.jsx", "render.jsx", "style.jsx",
  "batch.jsx", "explore.jsx", "helpers.jsx", "raw.jsx",
];

/* eslint-disable no-var */
// Runs in the VM realm. No references to anything outside its own body.
function installFakeAe(g) {
  // After Effects' own enum values (ExtendScript reference, AE 2026).
  g.KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
  g.PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };
  g.PropertyValueType = {
    NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417,
    COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424,
  };
  g.MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 };
  g.BlendingMode = { NORMAL: 5212, MULTIPLY: 5216, SCREEN: 5220, ADD: 5213, OVERLAY: 5223, DIFFERENCE: 5232 };
  g.TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
  g.ParagraphJustification = { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415, FULL_JUSTIFY_LASTLINE_LEFT: 7416 };
  var INTERP = [6612, 6613, 6614];

  function fail(msg) { throw new Error("After Effects error: " + msg); }
  function copy(v) { return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; }

  g.KeyframeEase = function (speed, influence) { this.speed = speed; this.influence = influence; };
  g.Shape = function () { this.vertices = []; this.inTangents = []; this.outTangents = []; this.closed = true; };
  g.MarkerValue = function (comment) {
    this.comment = comment; this.duration = 0; this.label = 0; this.chapter = ""; this.url = ""; this.frameTarget = "";
  };
  g.CompItem = function () {};
  g.FootageItem = function () {};
  g.AVLayer = function () {};
  g.TextLayer = function () {};
  g.ShapeLayer = function () {};
  g.CameraLayer = function () {};
  g.LightLayer = function () {};

  // ---------------------------------------------------------------- Property
  function Property(name, matchName, value, valueType, opts) {
    opts = opts || {};
    this.name = name; this.matchName = matchName; this._value = copy(value);
    this.propertyType = g.PropertyType.PROPERTY;
    this.propertyValueType = valueType;
    this.isSpatial = valueType === g.PropertyValueType.TwoD_SPATIAL || valueType === g.PropertyValueType.ThreeD_SPATIAL;
    this.canSetExpression = opts.canSetExpression !== false;
    this.expression = ""; this.expressionEnabled = false;
    this._keys = [];
    this.parentProperty = null;
  }
  Object.defineProperty(Property.prototype, "numKeys", { get: function () { return this._keys.length; } });
  Object.defineProperty(Property.prototype, "isTimeVarying", { get: function () { return this._keys.length > 0 || !!this.expression; } });
  Object.defineProperty(Property.prototype, "value", { get: function () { return copy(this._keys.length ? this._keys[0].value : this._value); } });
  Object.defineProperty(Property.prototype, "propertyIndex", { get: function () { return this.parentProperty ? this.parentProperty._children.indexOf(this) + 1 : 1; } });
  // How many KeyframeEase entries AE wants: one along a motion path, else one per dimension.
  Property.prototype._easeArity = function () {
    var t = g.PropertyValueType;
    if (this.isSpatial) return 1;
    if (this.propertyValueType === t.TwoD) return 2;
    if (this.propertyValueType === t.ThreeD) return 3;
    if (this.propertyValueType === t.COLOR) return 4;
    return 1;
  };
  Property.prototype._key = function (i) {
    if (!(i >= 1 && i <= this._keys.length) || Math.floor(i) !== i) fail("keyIndex " + i + " out of range (1.." + this._keys.length + ")");
    return this._keys[i - 1];
  };
  Property.prototype.setValue = function (v) {
    if (this._keys.length) fail("can not use setValue on a property with keyframes; use setValueAtTime");
    this._value = copy(v);
  };
  Property.prototype.setValueAtTime = function (t, v) {
    for (var i = 0; i < this._keys.length; i++) {
      if (Math.abs(this._keys[i].time - t) < 1e-6) { this._keys[i].value = copy(v); return; }
    }
    var n = this._easeArity(), inE = [], outE = [];
    for (var d = 0; d < n; d++) { inE.push(new g.KeyframeEase(0, 16.666667)); outE.push(new g.KeyframeEase(0, 16.666667)); }
    var key = {
      time: t, value: copy(v), inType: g.KeyframeInterpolationType.LINEAR, outType: g.KeyframeInterpolationType.LINEAR,
      inEase: inE, outEase: outE, inTangent: this.isSpatial ? [0, 0] : null, outTangent: this.isSpatial ? [0, 0] : null,
    };
    this._keys.push(key);
    this._keys.sort(function (a, b) { return a.time - b.time; });
  };
  Property.prototype.keyTime = function (i) { return this._key(i).time; };
  Property.prototype.keyValue = function (i) { return copy(this._key(i).value); };
  Property.prototype.removeKey = function (i) { this._key(i); this._keys.splice(i - 1, 1); };
  Property.prototype.keyInInterpolationType = function (i) { return this._key(i).inType; };
  Property.prototype.keyOutInterpolationType = function (i) { return this._key(i).outType; };
  Property.prototype.setInterpolationTypeAtKey = function (i, inType, outType) {
    var k = this._key(i);
    if (outType === undefined) outType = inType;
    if (INTERP.indexOf(inType) < 0 || INTERP.indexOf(outType) < 0) fail("invalid KeyframeInterpolationType");
    k.inType = inType; k.outType = outType;
  };
  Property.prototype.keyInTemporalEase = function (i) { return this._key(i).inEase; };
  Property.prototype.keyOutTemporalEase = function (i) { return this._key(i).outEase; };
  Property.prototype.setTemporalEaseAtKey = function (i, inE, outE) {
    var k = this._key(i), n = this._easeArity();
    if (!inE || inE.length !== n || (outE && outE.length !== n)) fail("Unable to call \"setTemporalEaseAtKey\" because of parameter 2.");
    k.inEase = inE; k.outEase = outE || inE;
  };
  Property.prototype.keyInSpatialTangent = function (i) { if (!this.isSpatial) fail("not spatial"); return copy(this._key(i).inTangent); };
  Property.prototype.keyOutSpatialTangent = function (i) { if (!this.isSpatial) fail("not spatial"); return copy(this._key(i).outTangent); };
  Property.prototype.setSpatialTangentsAtKey = function (i, a, b) {
    if (!this.isSpatial) fail("not spatial");
    var k = this._key(i); k.inTangent = copy(a); k.outTangent = copy(b === undefined ? a : b);
  };
  Property.prototype.valueAtTime = function () { return this.value; };
  Property.prototype.remove = function () { this.parentProperty._remove(this); };
  g.FakeProperty = Property;

  // ------------------------------------------------------------------- Group
  function Group(name, matchName, indexed, factory) {
    this.name = name; this.matchName = matchName;
    this.propertyType = indexed ? g.PropertyType.INDEXED_GROUP : g.PropertyType.NAMED_GROUP;
    this._children = []; this._factory = factory || null; this.parentProperty = null;
    this.enabled = true;
  }
  Object.defineProperty(Group.prototype, "numProperties", { get: function () { return this._children.length; } });
  Object.defineProperty(Group.prototype, "propertyIndex", { get: function () { return this.parentProperty ? this.parentProperty._children.indexOf(this) + 1 : 1; } });
  Group.prototype._add = function (p) { p.parentProperty = this; this._children.push(p); return p; };
  Group.prototype._remove = function (p) { this._children.splice(this._children.indexOf(p), 1); p.parentProperty = null; };
  // AE answers null for a name or index that is not there; it does not throw.
  Group.prototype.property = function (key) {
    if (typeof key === "number") return this._children[key - 1] || null;
    for (var i = 0; i < this._children.length; i++) {
      var c = this._children[i];
      if (c.name === key || c.matchName === key) return c;
    }
    return null;
  };
  Group.prototype.addProperty = function (matchName) {
    if (!this._factory) fail("can not add a property to this group");
    return this._add(this._factory(matchName, this));
  };
  Group.prototype.remove = function () { this.parentProperty._remove(this); };
  g.FakeGroup = Group;

  var T = g.PropertyValueType;
  function maskAtom(matchName, parent) {
    if (matchName !== "ADBE Mask Atom") fail("Masks takes ADBE Mask Atom, not " + matchName);
    var m = new Group("Mask " + (parent._children.length + 1), "ADBE Mask Atom", false);
    m.maskMode = g.MaskMode.ADD; m.inverted = false;
    m._add(new Property("Mask Path", "ADBE Mask Shape", new g.Shape(), T.SHAPE));
    m._add(new Property("Mask Feather", "ADBE Mask Feather", [0, 0], T.TwoD));
    m._add(new Property("Mask Opacity", "ADBE Mask Opacity", 100, T.OneD));
    m._add(new Property("Mask Expansion", "ADBE Mask Offset", 0, T.OneD));
    return m;
  }
  // Effects the fake knows, by matchName: [display name, [param name, matchName, value, type]...]
  var EFFECTS = {
    "ADBE Gaussian Blur 2": ["Gaussian Blur", [["Blurriness", "ADBE Gaussian Blur 2-0001", 0, T.OneD], ["Blur Dimensions", "ADBE Gaussian Blur 2-0002", 1, T.OneD]]],
    "ADBE Fill": ["Fill", [["Color", "ADBE Fill-0002", [1, 0, 0, 1], T.COLOR], ["Opacity", "ADBE Fill-0005", 1, T.OneD]]],
  };
  function effect(matchName) {
    var def = EFFECTS[matchName];
    if (!def) fail("unknown effect " + matchName);
    var e = new Group(def[0], matchName, false);
    for (var i = 0; i < def[1].length; i++) e._add(new Property(def[1][i][0], def[1][i][1], def[1][i][2], def[1][i][3]));
    return e;
  }

  // ------------------------------------------------------------------- Layer
  function Layer(comp, id, name, kind) {
    var self = kind === "text" ? new g.TextLayer() : kind === "shape" ? new g.ShapeLayer() : new g.AVLayer();
    self.containingComp = comp; self.id = id; self.name = name;
    self.nullLayer = kind === "null"; self.adjustmentLayer = false;
    self.enabled = true; self.solo = false; self.locked = false; self.shy = false; self.threeDLayer = false;
    self.label = 1; self.blendingMode = g.BlendingMode.NORMAL; self.preserveTransparency = false;
    self.trackMatteType = g.TrackMatteType.NO_TRACK_MATTE;
    self.trackMatteLayer = null;
    // The 2023+ matte API. AE switches the matte layer's video off.
    self.setTrackMatte = function (layer, type) {
      if (!layer || layer === self) fail("setTrackMatte needs another layer");
      self.trackMatteLayer = layer; self.trackMatteType = type; layer.enabled = false;
    };
    self.removeTrackMatte = function () { self.trackMatteLayer = null; };
    self.inPoint = 0; self.outPoint = comp.duration; self.startTime = 0; self.stretch = 100;
    self.parent = null; self.source = null;
    var root = new Group(name, "ADBE AV Layer", false);
    var tr = root._add(new Group("Transform", "ADBE Transform Group", false));
    tr._add(new Property("Anchor Point", "ADBE Anchor Point", [0, 0], T.TwoD_SPATIAL));
    tr._add(new Property("Position", "ADBE Position", [comp.width / 2, comp.height / 2], T.TwoD_SPATIAL));
    tr._add(new Property("Scale", "ADBE Scale", [100, 100, 100], T.ThreeD));
    tr._add(new Property("Rotation", "ADBE Rotate Z", 0, T.OneD));
    tr._add(new Property("Opacity", "ADBE Opacity", 100, T.OneD));
    root._add(new Group("Masks", "ADBE Mask Parade", true, maskAtom));
    root._add(new Group("Effects", "ADBE Effect Parade", true, effect));
    root._add(new Property("Marker", "ADBE Marker", null, T.MARKER, { canSetExpression: false }));
    self._root = root;
    // A Layer is a PropertyGroup in AE: it has a matchName and counts its children.
    self.matchName = kind === "text" ? "ADBE Text Layer" : kind === "shape" ? "ADBE Vector Layer" : "ADBE AV Layer";
    self.propertyType = g.PropertyType.NAMED_GROUP;
    Object.defineProperty(self, "numProperties", { get: function () { return root.numProperties; } });
    self.property = function (key) { return root.property(key); };
    self.sourceRectAtTime = function () { return { left: -50, top: -25, width: 100, height: 50 }; };
    self.remove = function () { comp._layers.splice(comp._layers.indexOf(self), 1); };
    Object.defineProperty(self, "index", { get: function () { return comp._layers.indexOf(self) + 1; } });
    return self;
  }

  // -------------------------------------------------------------------- Comp
  var ITEMS = [];
  function Comp(id, name, opts) {
    opts = opts || {};
    var c = new g.CompItem();
    c.id = id; c.name = name; c.width = opts.width || 1920; c.height = opts.height || 1080;
    c.duration = opts.duration || 10; c.frameRate = 30; c.time = 0; c._layers = [];
    c.markerProperty = new Property("Marker", "ADBE Marker", null, T.MARKER, { canSetExpression: false });
    Object.defineProperty(c, "numLayers", { get: function () { return c._layers.length; } });
    c.layer = function (i) {
      if (!(i >= 1 && i <= c._layers.length)) fail("layer index " + i + " out of range");
      return c._layers[i - 1];
    };
    c.addLayer = function (layerId, layerName, kind) { var l = Layer(c, layerId, layerName, kind); c._layers.push(l); return l; };
    ITEMS.push(c);
    return c;
  }

  g.app = {
    undoGroups: [],
    _open: 0,
    beginUndoGroup: function (n) { this._open++; this.undoGroups.push(n); },
    endUndoGroup: function () { if (this._open > 0) this._open--; },
    project: {
      get numItems() { return ITEMS.length; },
      item: function (i) { return ITEMS[i - 1]; },
      // Measured on AE 26.5: an id that is not there throws (ids.jsx __findItem).
      itemByID: function (id) {
        for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].id === id) return ITEMS[i];
        fail("internal verification failure, sorry! {Item Not Found}");
      },
    },
  };
  g.FAKE = { comp: Comp, items: ITEMS };
}

/**
 * A fresh realm with the fake installed and `files` (packages/jsx names) loaded
 * in bundle order. core.jsx is always loaded first — `call` goes through its
 * real `dispatch`, undo group and all.
 */
export function loadFakeAe(files = []) {
  const ctx = vm.createContext({});
  vm.runInContext(`(${installFakeAe.toString()})(this);`, ctx, { filename: "fake-ae.mjs" });
  const wanted = new Set(["core.jsx", ...files]);
  for (const f of wanted) if (!BUNDLE_ORDER.includes(f)) throw new Error(`fake-ae: ${f} is not in the bundle order`);
  for (const f of BUNDLE_ORDER) {
    if (!wanted.has(f)) continue;
    vm.runInContext(fs.readFileSync(path.join(jsxDir, f), "utf8"), ctx, { filename: f });
  }
  return {
    ctx,
    /** Evaluate in the realm; the value is returned as-is (in-realm objects). */
    run: (code) => vm.runInContext(code, ctx),
    /** An op through the real dispatch(), answered as plain JSON like the panel forwards it. */
    call(op, args) {
      const payload = JSON.stringify({ op, args });
      return JSON.parse(vm.runInContext(`JSON.stringify(dispatch(${JSON.stringify(payload)}))`, ctx));
    },
    /** Read something in-realm as plain JSON. */
    json: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, ctx)),
  };
}
