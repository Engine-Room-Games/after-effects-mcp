// masks.jsx — layer mask ops.

OPS.add_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  // Resolved before the mask exists, so a bad name leaves no mask behind.
  var mode = args.mode ? __maskMode("add_mask", args.mode) : undefined;
  var masksGroup = l.property("Masks");
  var m = masksGroup.addProperty("ADBE Mask Atom");
  var maskPath = m.property("ADBE Mask Shape");
  var shape = new Shape();
  shape.vertices = args.vertices;
  if (args.inTangents) shape.inTangents = args.inTangents;
  if (args.outTangents) shape.outTangents = args.outTangents;
  shape.closed = args.closed !== false;
  __setValue(maskPath, shape);
  if (mode !== undefined) m.maskMode = mode;
  return { ok: true, maskIndex: m.propertyIndex };
};

/** A MaskMode by name, or a refusal naming it (issue #150) — never the old mode behind an {ok}. */
function __maskMode(op, name) {
  var v = MaskMode[name];
  if (v === undefined) {
    throw new Error(op + ": mode '" + name + "' is not one of After Effects' MaskMode names " +
      "(ADD, NONE, SUBTRACT, INTERSECT, LIGHTEN, DARKEN, DIFFERENCE). Nothing was changed.");
  }
  return v;
}

OPS.set_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var masks = l.property("Masks");
  var m = masks ? masks.property(args.maskIndex) : null;
  if (!m) {
    throw new Error("set_mask: layer " + args.layerId + " has no mask " + args.maskIndex +
      " (it has " + (masks ? masks.numProperties : 0) + "). Nothing was changed.");
  }
  var mode = args.mode ? __maskMode("set_mask", args.mode) : undefined;
  // Issue #207: closed and the tangents used to be read only inside
  // `if (args.vertices)`, so opening a mask or re-curving it answered {ok} and
  // changed nothing. Any one of the four now reads the current path, applies
  // what was given, and writes it back once — every check before that write.
  var touchesPath = args.vertices !== undefined || args.inTangents !== undefined ||
    args.outTangents !== undefined || args.closed !== undefined;
  if (touchesPath) {
    var pathProp = m.property("ADBE Mask Shape");
    __setValue(pathProp, __reshape("set_mask", pathProp.value, args));
  }
  if (mode !== undefined) m.maskMode = mode;
  if (args.inverted !== undefined) m.inverted = args.inverted;
  if (args.expansion !== undefined) __setValue(m.property("ADBE Mask Offset"), args.expansion);
  if (args.feather !== undefined) __setValue(m.property("ADBE Mask Feather"), args.feather);
  if (args.opacity !== undefined) __setValue(m.property("ADBE Mask Opacity"), args.opacity);
  return { ok: true };
};

/**
 * A new Shape from `current` with whatever of vertices / inTangents /
 * outTangents / closed `args` carries applied (issue #207). Tangents not given
 * are kept when the vertex count is unchanged, and reset to straight corners
 * when new vertices change the count — the old ones no longer line up with
 * anything. A tangent array whose length differs from the vertex count it
 * would sit on is refused, naming both counts; AE would otherwise reject or
 * mangle it.
 */
function __zeroTangents(n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push([0, 0]);
  return out;
}

function __reshape(op, current, args) {
  var oldV = (current && current.vertices) || [];
  var verts = args.vertices !== undefined ? args.vertices : oldV;
  var sameCount = verts.length === oldV.length;
  var keep = function (arr) { return sameCount && arr && arr.length === verts.length ? arr : null; };
  var inT = args.inTangents !== undefined ? args.inTangents : keep(current && current.inTangents);
  var outT = args.outTangents !== undefined ? args.outTangents : keep(current && current.outTangents);
  var names = ["inTangents", "outTangents"], given = [inT, outT];
  for (var i = 0; i < 2; i++) {
    if (given[i] && given[i].length !== verts.length) {
      throw new Error(op + ": " + names[i] + " has " + given[i].length + " entries but the path has " +
        verts.length + " vertices" + (args.vertices !== undefined ? "" : " (its current vertices — pass `vertices` to change the count)") +
        ". One tangent per vertex. Nothing was changed.");
    }
  }
  var s = new Shape();
  s.vertices = verts;
  s.inTangents = inT || __zeroTangents(verts.length);
  s.outTangents = outT || __zeroTangents(verts.length);
  s.closed = args.closed !== undefined ? args.closed : (current ? current.closed !== false : true);
  return s;
}

OPS.remove_mask = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  l.property("Masks").property(args.maskIndex).remove();
  return { ok: true };
};
