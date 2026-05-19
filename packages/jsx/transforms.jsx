// transforms.jsx — fast-path for setting common transform properties.

function __setOrKeyAtTime(prop, value, time, keyframe) {
  if (keyframe && time !== undefined && time !== null) {
    prop.setValueAtTime(time, value);
  } else if (time !== undefined && time !== null && !keyframe) {
    // Set value at time only meaningful if property has keyframes; else set static.
    if (prop.numKeys > 0) prop.setValueAtTime(time, value);
    else prop.setValue(value);
  } else {
    prop.setValue(value);
  }
}

OPS.set_transform = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var t = args.time;
  var kf = !!args.keyframe;
  var tr = l.property("Transform");
  var p = args.properties || {};
  if (p.position !== undefined) __setOrKeyAtTime(tr.property("Position"), p.position, t, kf);
  if (p.scale !== undefined) __setOrKeyAtTime(tr.property("Scale"), p.scale, t, kf);
  if (p.rotation !== undefined) {
    var rotProp = l.threeDLayer ? tr.property("Z Rotation") : tr.property("Rotation");
    __setOrKeyAtTime(rotProp, p.rotation, t, kf);
  }
  if (p.anchorPoint !== undefined) __setOrKeyAtTime(tr.property("Anchor Point"), p.anchorPoint, t, kf);
  if (p.opacity !== undefined) __setOrKeyAtTime(tr.property("Opacity"), p.opacity, t, kf);
  if (p.orientation !== undefined && l.threeDLayer) __setOrKeyAtTime(tr.property("Orientation"), p.orientation, t, kf);
  if (p.xRotation !== undefined && l.threeDLayer) __setOrKeyAtTime(tr.property("X Rotation"), p.xRotation, t, kf);
  if (p.yRotation !== undefined && l.threeDLayer) __setOrKeyAtTime(tr.property("Y Rotation"), p.yRotation, t, kf);
  if (p.zRotation !== undefined && l.threeDLayer) __setOrKeyAtTime(tr.property("Z Rotation"), p.zRotation, t, kf);
  return { ok: true };
};
