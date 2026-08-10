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
  var prop = walkProperty(l, args.shapePath);
  // The shape path is usually a "Path" property whose value is a Shape.
  var pathProp = prop;
  // If user passed a group, dig down to "Path"
  if (pathProp.propertyType === PropertyType.NAMED_GROUP || pathProp.propertyType === PropertyType.INDEXED_GROUP) {
    try { pathProp = pathProp.property("Path"); } catch (e) {}
  }
  var shape = __makeShape(args.vertices, args.inTangents, args.outTangents, args.closed);
  pathProp.setValue(shape);
  return { ok: true };
};

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
    offset: ["ADBE Vector Repeater Offset", "Offset"]
  },
  merge: {
    mode: ["ADBE Vector Merge Type", "Mode"]
  }
};

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
  if (!match) {
    throw new Error("Unknown shape content type: " + String(type) + ". Expected one of: " + __shapeTypeList() + ".");
  }

  var node = parent.addProperty(match);
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
        pathProp.setValue(__makeShape(verts, content.inTangents, content.outTangents, content.closed));
        applied.push("vertices");
      }
    }

    for (var k in content) {
      if (!content.hasOwnProperty(k)) continue;
      if (k === "type") continue;
      if (type === "path" && __PATH_KEYS[k]) continue;
      // `name` is a node attribute, not a child property.
      if (k === "name") {
        node.name = String(content[k]);
        applied.push("name");
        continue;
      }
      var target = __resolveShapeProp(node, type, k);
      if (!target) { failed.push(k); continue; }
      try {
        target.setValue(content[k]);
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
  if (args.keyframe && args.time !== undefined) pp.setValueAtTime(args.time, args.value);
  else if (args.time !== undefined && pp.numKeys > 0) pp.setValueAtTime(args.time, args.value);
  else pp.setValue(args.value);
  return { ok: true };
};
