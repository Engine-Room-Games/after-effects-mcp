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

OPS.add_shape_content = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var contents = l.property("Contents");
  var parent = contents;
  if (args.parentGroupPath && args.parentGroupPath.length > 0) {
    parent = walkProperty(l, args.parentGroupPath);
  }
  var content = args.content || {};
  var matchMap = {
    rect: "ADBE Vector Shape - Rect",
    ellipse: "ADBE Vector Shape - Ellipse",
    star: "ADBE Vector Shape - Star",
    path: "ADBE Vector Shape - Group",
    fill: "ADBE Vector Graphic - Fill",
    stroke: "ADBE Vector Graphic - Stroke",
    trim: "ADBE Vector Filter - Trim",
    repeater: "ADBE Vector Filter - Repeater",
    merge: "ADBE Vector Filter - Merge",
    group: "ADBE Vector Group",
  };
  var match = matchMap[content.type];
  if (!match) throw new Error("Unknown shape content type: " + content.type);
  var prop = parent.addProperty(match);
  // Apply scalar props on the new node
  for (var k in content) {
    if (k === "type" || !content.hasOwnProperty(k)) continue;
    try {
      var pp = prop.property(k);
      if (pp) pp.setValue(content[k]);
    } catch (e) {}
  }
  return { ok: true, name: prop.name, index: prop.propertyIndex };
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
