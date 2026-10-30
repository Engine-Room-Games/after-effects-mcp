// transforms.jsx — fast-path for setting common transform properties.
// Each write goes through __setOrKeyAtTime (values.jsx).

// Each field's property, by match name. Display names change with the UI
// language and the layer type: a 2D layer's "Rotation" is a 3D layer's
// "Z Rotation", and both are ADBE Rotate Z.
var __TRANSFORM_FIELDS = [
  ["position", "ADBE Position"],
  ["xPosition", "ADBE Position_0"],
  ["yPosition", "ADBE Position_1"],
  ["zPosition", "ADBE Position_2"],
  ["scale", "ADBE Scale"],
  ["rotation", "ADBE Rotate Z"],
  ["anchorPoint", "ADBE Anchor Point"],
  ["opacity", "ADBE Opacity"],
  ["orientation", "ADBE Orientation"],
  ["xRotation", "ADBE Rotate X"],
  ["yRotation", "ADBE Rotate Y"],
  ["zRotation", "ADBE Rotate Z"]
];

OPS.set_transform = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var t = args.time;
  var kf = !!args.keyframe;
  __requireKeyTime(kf, t, "set_transform");
  var tr = l.property("Transform");
  var p = args.properties || {};
  var i;
  // Every refusal below comes before the first write, so a refused call leaves
  // the layer untouched. A partial transform is worse than none.
  if (p.rotation !== undefined && p.zRotation !== undefined) {
    throw new Error(
      "set_transform: `rotation` and `zRotation` are the same property (ADBE Rotate Z) and both were passed. " +
      "Nothing was changed. Pass only one of them."
    );
  }
  // Orientation and X/Y Rotation exist only in 3D. On a 2D layer they used to be
  // skipped behind an {ok:true} (issue #152). Cameras and lights are always 3D
  // but do not report threeDLayer, so they are named rather than judged by that
  // flag (the same exclusion __ptChain makes in layers.jsx).
  var isCamOrLight = (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) ||
    (typeof LightLayer !== "undefined" && l instanceof LightLayer);
  // Separate Dimensions (issue #181). Position and X/Y/Z Position are each
  // hidden while the other is in use, so which family this call may write is
  // decided by the switch as it will be once this call has set it — and said
  // in those words, rather than as a bare "hidden" from the generic check.
  var posProp = null;
  try { posProp = tr.property("ADBE Position"); } catch (ePos) { posProp = null; }
  var sepNow = false;
  try { sepNow = !!(posProp && posProp.dimensionsSeparated); } catch (eSep) { sepNow = false; }
  var sepToggle = args.separateDimensions !== undefined && !!args.separateDimensions !== sepNow;
  var sepAfter = args.separateDimensions !== undefined ? !!args.separateDimensions : sepNow;
  if (args.separateDimensions !== undefined && !posProp) {
    throw new Error("set_transform: layer '" + l.name + "' has no Position property, so it has no Separate Dimensions switch. Nothing was changed.");
  }
  if (sepAfter && p.position !== undefined) {
    throw new Error(
      "set_transform: layer '" + l.name + "' has Position's dimensions separated" + (sepToggle ? " (by this call)" : "") +
      ", so Position itself is hidden. Nothing was changed. Pass xPosition/yPosition" +
      (l.threeDLayer ? "/zPosition" : "") + " instead, or separateDimensions:false to write position."
    );
  }
  var sepFields = [];
  if (p.xPosition !== undefined) sepFields.push("xPosition");
  if (p.yPosition !== undefined) sepFields.push("yPosition");
  if (p.zPosition !== undefined) sepFields.push("zPosition");
  if (!sepAfter && sepFields.length) {
    throw new Error(
      "set_transform: " + sepFields.join(", ") + " exist only while Position's dimensions are separated, and on layer '" +
      l.name + "' they are not. Nothing was changed. Pass separateDimensions:true in the same call, or write position."
    );
  }
  if (!l.threeDLayer && !isCamOrLight) {
    var only3D = ["orientation", "xRotation", "yRotation", "zPosition"];
    var refused = [];
    for (i = 0; i < only3D.length; i++) {
      if (p[only3D[i]] !== undefined) refused.push(only3D[i]);
    }
    if (refused.length) {
      throw new Error(
        "set_transform: layer '" + l.name + "' is 2D, and " + refused.join(", ") +
        (refused.length === 1 ? " exists" : " exist") + " only on a 3D layer. Nothing was changed. " +
        "Make it 3D first with set_layer threeDLayer:true, or drop " + refused.join(", ") +
        " (use `rotation` for a 2D layer's rotation)."
      );
    }
  }
  // Resolve every property first. A camera or light has no Scale or Opacity,
  // and some of what it does have is there but unsettable (a one-node camera's
  // Point of Interest, a point light's Orientation and rotations), so a field
  // that is absent or cannot take a value is refused by name, not skipped.
  // AE 26.5 has no canSetValue (it reads undefined); a hidden property reports
  // canSetExpression:false, measured — so that is the pre-write test.
  // On a camera or light, anchorPoint (ADBE Anchor Point) IS the Point of Interest.
  var plan = [];
  var missing = [];
  var unsettable = [];
  for (i = 0; i < __TRANSFORM_FIELDS.length; i++) {
    var field = __TRANSFORM_FIELDS[i][0];
    if (p[field] === undefined) continue;
    var prop = null;
    try { prop = tr.property(__TRANSFORM_FIELDS[i][1]); } catch (e) { prop = null; }
    var settable = true;
    // Position and X/Y/Z Position swap visibility when this call flips the
    // switch, so their hidden state now says nothing about after; the checks
    // above have already decided them.
    var swaps = sepToggle && (field === "position" || field === "xPosition" || field === "yPosition" || field === "zPosition");
    if (prop && !swaps) {
      try { settable = prop.canSetExpression !== false; } catch (e2) { settable = false; }
    }
    if (!prop) missing.push(field);
    else if (!settable) unsettable.push(field);
    else plan.push([prop, p[field], field, __TRANSFORM_FIELDS[i][1]]);
  }
  if (missing.length || unsettable.length) {
    var what = [];
    if (missing.length) what.push("has no " + missing.join(", ") + " property");
    if (unsettable.length) what.push("cannot set " + unsettable.join(", ") + " (hidden on this layer)");
    var drop = missing.concat(unsettable);
    throw new Error(
      "set_transform: layer '" + l.name + "'" + (isCamOrLight ? " (a camera or light)" : "") +
      " " + what.join(" and ") + ". Nothing was changed. Drop " + drop.join(", ") +
      "; get_layer_full lists the transform properties this layer has."
    );
  }
  // Fallback for a hidden property the check above did not see: name what
  // already landed, so the failure is never read as "nothing changed".
  var written = [];
  if (sepToggle) {
    try {
      posProp.dimensionsSeparated = sepAfter;
    } catch (eSet) {
      throw new Error("set_transform: could not " + (sepAfter ? "separate" : "join") + " Position's dimensions on layer '" + l.name +
        "': " + ((eSet && eSet.message) ? eSet.message : String(eSet)) + " Nothing was changed.");
    }
    if (!!posProp.dimensionsSeparated !== sepAfter) {
      throw new Error("set_transform: asked to " + (sepAfter ? "separate" : "join") + " Position's dimensions on layer '" + l.name +
        "', but After Effects reads dimensionsSeparated " + posProp.dimensionsSeparated + " afterwards. Nothing else was written.");
    }
    written.push("separateDimensions");
  }
  for (i = 0; i < plan.length; i++) {
    try {
      // Re-fetched after the switch flipped, so no reference outlives it.
      var target = sepToggle ? tr.property(plan[i][3]) : plan[i][0];
      __setOrKeyAtTime(target, plan[i][1], t, kf, "set_transform");
    } catch (e3) {
      var msg = (e3 && e3.message) ? e3.message : String(e3);
      throw new Error(
        "set_transform: could not set " + plan[i][2] + " on layer '" + l.name + "': " + msg +
        (written.length ? " Already written in this call: " + written.join(", ") + "." : " Nothing was changed.") +
        (/hidden/i.test(msg) ? " The property is hidden on this layer; drop " + plan[i][2] + "." : "")
      );
    }
    written.push(plan[i][2]);
  }
  var res = { ok: true };
  if (posProp && (args.separateDimensions !== undefined || sepFields.length)) res.dimensionsSeparated = !!posProp.dimensionsSeparated;
  return res;
};
