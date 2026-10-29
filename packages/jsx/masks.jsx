// masks.jsx — layer mask ops.

OPS.add_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var masksGroup = l.property("Masks");
  var m = masksGroup.addProperty("ADBE Mask Atom");
  var maskPath = m.property("ADBE Mask Shape");
  var shape = new Shape();
  shape.vertices = args.vertices;
  if (args.inTangents) shape.inTangents = args.inTangents;
  if (args.outTangents) shape.outTangents = args.outTangents;
  shape.closed = args.closed !== false;
  __setValue(maskPath, shape);
  if (args.mode) {
    try { m.maskMode = MaskMode[args.mode] || m.maskMode; } catch (e) {}
  }
  return { ok: true, maskIndex: m.propertyIndex };
};

OPS.set_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var m = l.property("Masks").property(args.maskIndex);
  if (args.vertices) {
    var pathProp = m.property("ADBE Mask Shape");
    var sh = pathProp.value;
    if (args.vertices) sh.vertices = args.vertices;
    if (args.inTangents) sh.inTangents = args.inTangents;
    if (args.outTangents) sh.outTangents = args.outTangents;
    if (args.closed !== undefined) sh.closed = args.closed;
    __setValue(pathProp, sh);
  }
  if (args.mode) { try { m.maskMode = MaskMode[args.mode] || m.maskMode; } catch (e) {} }
  if (args.inverted !== undefined) m.inverted = args.inverted;
  if (args.expansion !== undefined) __setValue(m.property("ADBE Mask Offset"), args.expansion);
  if (args.feather !== undefined) __setValue(m.property("ADBE Mask Feather"), args.feather);
  if (args.opacity !== undefined) __setValue(m.property("ADBE Mask Opacity"), args.opacity);
  return { ok: true };
};

OPS.remove_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  l.property("Masks").property(args.maskIndex).remove();
  return { ok: true };
};
