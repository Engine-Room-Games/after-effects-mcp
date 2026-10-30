// shapes.jsx — shape layer paths/fills/strokes/repeaters.

function __makeShape(vertices, inT, outT, closed) {
  var s = new Shape();
  s.vertices = vertices;
  if (inT) s.inTangents = inT;
  if (outT) s.outTangents = outT;
  s.closed = closed !== false;
  return s;
}

OPS.set_shape_path = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var pathProp = __shapePathProp(walkProperty(l, args.shapePath), args.shapePath);
  // Built (and its tangent counts checked) before anything is written.
  var shape = __reshape("set_shape_path", null, args);
  __setValue(pathProp, shape);
  return { ok: true };
};

/**
 * The Path property (matchName "ADBE Vector Shape") that `node` names: the node
 * itself (or a mask's path, or a mask whose path it is), or — for a "Path N" group (ADBE Vector Shape - Group) — its Path
 * child. Resolved by match name, never by the display name "Path", which is
 * localized and missed on a non-English After Effects (issue #163). Anything
 * else is refused with its match name, rather than handing setValue a group.
 */
function __shapePathProp(node, path) {
  // A mask's path (ADBE Mask Shape) holds a Shape too, and has always been writable here.
  if (node.matchName === "ADBE Vector Shape" || node.matchName === "ADBE Mask Shape") return node;
  var child = null;
  if (node.matchName === "ADBE Mask Atom") {
    try { child = node.property("ADBE Mask Shape"); } catch (e0) { child = null; }
  } else if (node.propertyType === PropertyType.NAMED_GROUP || node.propertyType === PropertyType.INDEXED_GROUP) {
    try { child = node.property("ADBE Vector Shape"); } catch (e) { child = null; }
  }
  if (child) return child;
  throw new Error("set_shape_path: " + JSON.stringify(path) + " resolves to '" + node.name + "' (" + node.matchName +
    "), which is not a shape path. Point shapePath at a path node (ADBE Vector Shape - Group, e.g. " +
    "[\"Contents\", \"Group 1\", \"Contents\", \"Path 1\"]) or at its Path property. Nothing was changed.");
}

var __SHAPE_MATCH = {
  rect: "ADBE Vector Shape - Rect",
  ellipse: "ADBE Vector Shape - Ellipse",
  star: "ADBE Vector Shape - Star",
  path: "ADBE Vector Shape - Group",
  fill: "ADBE Vector Graphic - Fill",
  stroke: "ADBE Vector Graphic - Stroke",
  trim: "ADBE Vector Filter - Trim",
  repeater: "ADBE Vector Filter - Repeater",
  merge: "ADBE Vector Filter - Merge",
  group: "ADBE Vector Group"
};

// Friendly key -> candidate property identifiers, tried in order. AE's own
// matchNames are inconsistent (and some are misspelled upstream, e.g. the star
// "Roundess" keys), so each entry is a list and the raw key is always tried
// last. A key that resolves to nothing is reported, never silently dropped.
var __SHAPE_ALIASES = {
  rect: {
    size: ["ADBE Vector Rect Size", "Size"],
    position: ["ADBE Vector Rect Position", "Position"],
    roundness: ["ADBE Vector Rect Roundness", "Roundness"]
  },
  ellipse: {
    size: ["ADBE Vector Ellipse Size", "Size"],
    position: ["ADBE Vector Ellipse Position", "Position"]
  },
  star: {
    starType: ["ADBE Vector Star Type", "Type"],
    points: ["ADBE Vector Star Points", "Points"],
    position: ["ADBE Vector Star Position", "Position"],
    rotation: ["ADBE Vector Star Rotation", "Rotation"],
    innerRadius: ["ADBE Vector Star Inner Radius", "Inner Radius"],
    outerRadius: ["ADBE Vector Star Outer Radius", "Outer Radius"],
    innerRoundness: ["ADBE Vector Star Inner Roundess", "ADBE Vector Star Inner Roundness", "Inner Roundness"],
    outerRoundness: ["ADBE Vector Star Outer Roundess", "ADBE Vector Star Outer Roundness", "Outer Roundness"]
  },
  fill: {
    color: ["ADBE Vector Fill Color", "Color"],
    opacity: ["ADBE Vector Fill Opacity", "Opacity"],
    fillRule: ["ADBE Vector Fill Rule", "Fill Rule"]
  },
  stroke: {
    color: ["ADBE Vector Stroke Color", "Color"],
    opacity: ["ADBE Vector Stroke Opacity", "Opacity"],
    width: ["ADBE Vector Stroke Width", "Stroke Width"],
    lineCap: ["ADBE Vector Stroke Line Cap", "Line Cap"],
    lineJoin: ["ADBE Vector Stroke Line Join", "Line Join"],
    miterLimit: ["ADBE Vector Stroke Miter Limit", "Miter Limit"]
  },
  trim: {
    start: ["ADBE Vector Trim Start", "Start"],
    end: ["ADBE Vector Trim End", "End"],
    offset: ["ADBE Vector Trim Offset", "Offset"]
  },
  repeater: {
    copies: ["ADBE Vector Repeater Copies", "Copies"],
    offset: ["ADBE Vector Repeater Offset", "Offset"],
    composite: ["ADBE Vector Repeater Order", "Composite"]
  },
  merge: {
    mode: ["ADBE Vector Merge Type", "Mode"]
  }
};

// Popup properties the schema lets a caller name (issue #150), mapped to the
// 1-based value After Effects stores. Keyed "<content type>.<key>".
var __SHAPE_NAMED = {
  "fill.fillRule": { nonzero: 1, evenodd: 2 },
  "stroke.lineCap": { butt: 1, round: 2, projecting: 3 },
  "stroke.lineJoin": { miter: 1, round: 2, bevel: 3 },
  // Measured on AE 26.5 (issue #181) with sampleImage on two overlapping
  // stroked copies: 1, the default, draws each copy BEHIND the one before it
  // (the original on top); 2 draws each copy above it. 0 and 3 are refused by
  // AE as "out of range 1 to 2".
  "repeater.composite": { below: 1, above: 2 }
};

// Gradient colour stops (issue #181). Measured on AE 26.5: "ADBE Vector Grad
// Colors" on both a Gradient Fill and a Gradient Stroke is
// PropertyValueType.NO_VALUE, so value, setValue, setValueAtTime and
// valueAtTime all throw, and canSetExpression is false. Nothing a script can
// reach sets the stops, so every door that could look like it does refuses
// with this text rather than build a white-to-black gradient nobody asked for.
var __GRADIENT_REFUSAL =
  "Gradient colour stops cannot be set from a script: After Effects exposes 'ADBE Vector Grad Colors' " +
  "with no value (PropertyValueType.NO_VALUE) and refuses an expression on it, so neither setValue nor an " +
  "expression can change them. Nothing was changed. For a scripted gradient use the Gradient Ramp effect " +
  "(add_effect 'ADBE Ramp', whose colours are ordinary parameters) on the layer, or ask the user to set the " +
  "stops in the Gradient Editor.";

// The Repeater's Transform group (issue #181): friendly key -> candidates,
// tried in order like __SHAPE_ALIASES.
var __REPEATER_TRANSFORM = [
  ["anchorPoint", ["ADBE Vector Repeater Anchor", "Anchor Point"]],
  ["position", ["ADBE Vector Repeater Position", "Position"]],
  ["scale", ["ADBE Vector Repeater Scale", "Scale"]],
  ["rotation", ["ADBE Vector Repeater Rotation", "Rotation"]],
  ["startOpacity", ["ADBE Vector Repeater Opacity 1", "Start Opacity"]],
  ["endOpacity", ["ADBE Vector Repeater Opacity 2", "End Opacity"]]
];

/** Set each key of a repeater's `transform`; what fails is pushed to `failed` by name. */
function __applyRepeaterTransform(node, tf, applied, failed) {
  var group = null;
  try { group = node.property("ADBE Vector Repeater Transform") || node.property("Transform"); } catch (e) { group = null; }
  if (!group) { failed.push("transform (no Transform group on the repeater)"); return; }
  var known = {};
  for (var i = 0; i < __REPEATER_TRANSFORM.length; i++) {
    var key = __REPEATER_TRANSFORM[i][0];
    known[key] = true;
    if (tf[key] === undefined) continue;
    var target = null, names = __REPEATER_TRANSFORM[i][1];
    for (var j = 0; j < names.length && !target; j++) {
      try { target = group.property(names[j]) || null; } catch (e2) { target = null; }
    }
    if (!target) { failed.push("transform." + key); continue; }
    try {
      __setValue(target, tf[key]);
      applied.push("transform." + key);
    } catch (e3) {
      failed.push("transform." + key + " (" + e3.message + ")");
    }
  }
  for (var k in tf) {
    if (tf.hasOwnProperty(k) && !known[k]) failed.push("transform." + k + " (not a Repeater transform key)");
  }
}

// Keys consumed by the path builder rather than set as plain properties.
var __PATH_KEYS = { vertices: 1, points: 1, inTangents: 1, outTangents: 1, closed: 1 };

function __resolveShapeProp(node, type, key) {
  var candidates = [];
  var table = __SHAPE_ALIASES[type];
  if (table && table[key]) {
    var aliases = table[key];
    for (var i = 0; i < aliases.length; i++) candidates.push(aliases[i]);
  }
  candidates.push(key);
  for (var j = 0; j < candidates.length; j++) {
    try {
      var pp = node.property(candidates[j]);
      if (pp) return pp;
    } catch (e) {}
  }
  return null;
}

function __shapeTypeList() {
  var names = [];
  for (var k in __SHAPE_MATCH) { if (__SHAPE_MATCH.hasOwnProperty(k)) names.push(k); }
  return names.join(", ");
}

OPS.add_shape_content = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var parent = l.property("Contents");
  if (args.parentGroupPath && args.parentGroupPath.length > 0) {
    parent = walkProperty(l, args.parentGroupPath);
  }
  var content = args.content || {};
  var type = content.type;
  var match = __SHAPE_MATCH[type];
  if (!match && /grad|^g-?(fill|stroke)$/i.test(String(type))) {
    throw new Error("add_shape_content does not offer gradient fills or strokes. " + __GRADIENT_REFUSAL);
  }
  if (!match) {
    throw new Error("Unknown shape content type: " + String(type) + ". Expected one of: " + __shapeTypeList() + ".");
  }

  var node = parent.addProperty(match);

  // Render order. addProperty always appends to the END of the group, and in a
  // shape layer index 1 renders in FRONT — so an appended node lands at the back
  // and the first thing added is the thing on top. That is the opposite of the
  // layer stack, and building back-to-front silently produces a solid slab.
  //
  // "back" is therefore what already happened and needs no move. "front" is the
  // only case that reorders, and moveTo is the only primitive AE offers for it —
  // see the note in the tool description about nested renders. Do it here, on a
  // node with nothing in it yet, so a failure costs an empty node and nothing
  // else, and re-fetch afterwards: a structural change invalidates references
  // into the group (the same trap that makes a Fill reference go stale when a
  // Stroke is added beside it).
  if (args.zOrder === "front" && node.propertyIndex !== 1) {
    try {
      node.moveTo(1);
    } catch (eMove) {
      try { node.remove(); } catch (eRm) {}
      throw new Error(
        "add_shape_content created the '" + type + "' node but could not move it to the front of the " +
        "render stack: " + eMove.message + ". The node was removed, so nothing changed."
      );
    }
    node = parent.property(1);
    // Cheap identity check on the re-fetch. If moveTo ever lands the node
    // somewhere other than index 1, setting properties on whatever is there
    // would corrupt a node the caller never asked about.
    if (!node || node.matchName !== match) {
      throw new Error(
        "add_shape_content moved the '" + type + "' node towards the front of the render stack but did not " +
        "find it at index 1 afterwards. No properties were set on it. Read the layer back with get_layer_full " +
        "before retrying, and add contents front-to-back instead of using zOrder."
      );
    }
  }

  var applied = [];
  var failed = [];

  try {
    // A "path" node is a Vector Group whose Path property holds a Shape; the
    // vertex keys have to be folded into one setValue rather than set directly.
    if (type === "path" && (content.vertices || content.points)) {
      var verts = content.vertices || content.points;
      var pathProp = __resolveShapeProp(node, "path", "ADBE Vector Shape");
      if (!pathProp) pathProp = __resolveShapeProp(node, "path", "Path");
      if (!pathProp) {
        failed.push("vertices (no Path property on the created group)");
      } else {
        __setValue(pathProp, __makeShape(verts, content.inTangents, content.outTangents, content.closed));
        applied.push("vertices");
      }
    }

    for (var k in content) {
      if (!content.hasOwnProperty(k)) continue;
      if (k === "type") continue;
      if (type === "path" && __PATH_KEYS[k]) continue;
      if (type === "repeater" && k === "transform") {
        __applyRepeaterTransform(node, content.transform || {}, applied, failed);
        continue;
      }
      // `name` is a node attribute, not a child property.
      if (k === "name") {
        node.name = String(content[k]);
        applied.push("name");
        continue;
      }
      var target = __resolveShapeProp(node, type, k);
      if (!target) { failed.push(k); continue; }
      var val = content[k];
      // Named menu values (issue #150). AE's popups take 1-based numbers; the
      // schema offers the names and still passes a bare number through.
      var named = __SHAPE_NAMED[type + "." + k];
      if (named && typeof val === "string") {
        var nk = val.toLowerCase();
        if (!named.hasOwnProperty(nk)) { failed.push(k + " ('" + val + "' is not a known name)"); continue; }
        val = named[nk];
      }
      try {
        __setValue(target, val);
        applied.push(k);
      } catch (e) {
        failed.push(k + " (" + e.message + ")");
      }
    }
  } catch (e) {
    try { node.remove(); } catch (e2) {}
    throw e;
  }

  // All-or-nothing: a partially built node that reports success is worse than a
  // clear failure, because the caller cannot tell what actually landed.
  if (failed.length > 0) {
    try { node.remove(); } catch (e3) {}
    throw new Error(
      "add_shape_content could not apply these keys on '" + type + "': " + failed.join(", ") +
      ". The node was removed, so nothing changed. Check the property names with get_layer_full, " +
      "or set them afterwards with set_shape_property."
    );
  }

  return { ok: true, name: node.name, matchName: match, index: node.propertyIndex, applied: applied };
};

OPS.set_shape_property = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var node = walkProperty(l, args.contentPath);
  var pp = node.property(args.property);
  if (!pp) throw new Error("No property: " + args.property);
  if (pp.matchName === "ADBE Vector Grad Colors") throw new Error("set_shape_property: " + __GRADIENT_REFUSAL);
  __requireKeyTime(!!args.keyframe, args.time, "set_shape_property");
  __setOrKeyAtTime(pp, args.value, args.time, !!args.keyframe, "set_shape_property");
  return { ok: true };
};
