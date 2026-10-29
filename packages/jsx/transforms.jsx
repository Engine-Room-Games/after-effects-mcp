// transforms.jsx — fast-path for setting common transform properties.

function __setOrKeyAtTime(prop, value, time, keyframe) {
  if (keyframe && time !== undefined && time !== null) {
    prop.setValueAtTime(time, value);
  } else if (time !== undefined && time !== null && !keyframe) {
    // Set value at time only meaningful if property has keyframes; else set static.
    if (prop.numKeys > 0) prop.setValueAtTime(time, value);
    else __setValue(prop, value);
  } else {
    __setValue(prop, value);
  }
}

OPS.set_transform = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var t = args.time;
  var kf = !!args.keyframe;
  __requireKeyTime(kf, t, "set_transform");
  var tr = l.property("Transform");
  var p = args.properties || {};
  // Orientation and X/Y Rotation exist only on a 3D layer. They used to be
  // skipped on a 2D one behind an {ok:true} (issue #152), so refuse before
  // writing anything — a partial transform is worse than none. Z Rotation is
  // the 2D layer's Rotation (the same property, ADBE Rotate Z), so it lands there.
  if (!l.threeDLayer) {
    var only3D = ["orientation", "xRotation", "yRotation"];
    var refused = [];
    for (var i = 0; i < only3D.length; i++) {
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
  if (p.position !== undefined) __setOrKeyAtTime(tr.property("Position"), p.position, t, kf);
  if (p.scale !== undefined) __setOrKeyAtTime(tr.property("Scale"), p.scale, t, kf);
  if (p.rotation !== undefined) {
    var rotProp = l.threeDLayer ? tr.property("Z Rotation") : tr.property("Rotation");
    __setOrKeyAtTime(rotProp, p.rotation, t, kf);
  }
  if (p.anchorPoint !== undefined) __setOrKeyAtTime(tr.property("Anchor Point"), p.anchorPoint, t, kf);
  if (p.opacity !== undefined) __setOrKeyAtTime(tr.property("Opacity"), p.opacity, t, kf);
  if (p.orientation !== undefined) __setOrKeyAtTime(tr.property("Orientation"), p.orientation, t, kf);
  if (p.xRotation !== undefined) __setOrKeyAtTime(tr.property("X Rotation"), p.xRotation, t, kf);
  if (p.yRotation !== undefined) __setOrKeyAtTime(tr.property("Y Rotation"), p.yRotation, t, kf);
  if (p.zRotation !== undefined) {
    __setOrKeyAtTime(l.threeDLayer ? tr.property("Z Rotation") : tr.property("Rotation"), p.zRotation, t, kf);
  }
  return { ok: true };
};
