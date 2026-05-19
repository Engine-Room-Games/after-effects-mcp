// keyframes.jsx — generic keyframe ops.

var __INTERP_MAP = {
  linear: KeyframeInterpolationType.LINEAR,
  bezier: KeyframeInterpolationType.BEZIER,
  hold: KeyframeInterpolationType.HOLD,
};

function __findKeyIndexAtTime(prop, time, eps) {
  eps = eps || 0.001;
  for (var i = 1; i <= prop.numKeys; i++) {
    if (Math.abs(prop.keyTime(i) - time) < eps) return i;
  }
  return -1;
}

function __applyInterpolationToKey(prop, keyIndex, interp) {
  if (!interp) return;
  var inT = interp["in"] && __INTERP_MAP[interp["in"]] ? __INTERP_MAP[interp["in"]] : prop.keyInInterpolationType(keyIndex);
  var outT = interp["out"] && __INTERP_MAP[interp["out"]] ? __INTERP_MAP[interp["out"]] : prop.keyOutInterpolationType(keyIndex);
  prop.setInterpolationTypeAtKey(keyIndex, inT, outT);
  if (interp.easeIn || interp.easeOut) {
    // AE's setTemporalEaseAtKey expects an array of KeyframeEase per dimension —
    // BUT spatial properties (Position, Anchor Point) use a single ease entry that
    // applies along the motion path, regardless of 2D/3D. Non-spatial multi-dim
    // properties (Scale, Color) need one entry per dimension.
    var dim;
    if (prop.isSpatial) {
      dim = 1;
    } else {
      dim = (prop.value && prop.value.length) ? prop.value.length : 1;
    }
    var inEase = interp.easeIn || { influence: 33, speed: 0 };
    var outEase = interp.easeOut || { influence: 33, speed: 0 };
    var inArr = []; var outArr = [];
    for (var d = 0; d < dim; d++) {
      inArr.push(new KeyframeEase(inEase.speed, inEase.influence));
      outArr.push(new KeyframeEase(outEase.speed, outEase.influence));
    }
    prop.setTemporalEaseAtKey(keyIndex, inArr, outArr);
  }
}

OPS.add_keyframe = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.setValueAtTime(args.time, args.value);
  if (args.interpolation) {
    var idx = __findKeyIndexAtTime(prop, args.time);
    if (idx > 0) __applyInterpolationToKey(prop, idx, args.interpolation);
  }
  return { ok: true, keyIndex: __findKeyIndexAtTime(prop, args.time) };
};

OPS.remove_keyframe = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  var idx = __findKeyIndexAtTime(prop, args.time);
  if (idx < 1) throw new Error("No keyframe at time " + args.time);
  prop.removeKey(idx);
  return { ok: true };
};

OPS.get_keyframes = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  var keys = [];
  for (var i = 1; i <= prop.numKeys; i++) {
    var ease = null;
    try {
      var inE = prop.keyInTemporalEase(i);
      var outE = prop.keyOutTemporalEase(i);
      ease = {
        easeIn: { influence: inE[0].influence, speed: inE[0].speed },
        easeOut: { influence: outE[0].influence, speed: outE[0].speed },
      };
    } catch (e) {}
    var tangents = null;
    if (prop.isSpatial) {
      try { tangents = { inTangent: prop.keyInSpatialTangent(i), outTangent: prop.keyOutSpatialTangent(i) }; }
      catch (e2) {}
    }
    keys.push({
      index: i,
      time: prop.keyTime(i),
      value: prop.keyValue(i),
      interpolation: {
        "in": __invInterp(prop.keyInInterpolationType(i)),
        "out": __invInterp(prop.keyOutInterpolationType(i)),
      },
      ease: ease,
      tangents: tangents,
    });
  }
  return keys;
});

function __invInterp(t) {
  if (t === KeyframeInterpolationType.LINEAR) return "linear";
  if (t === KeyframeInterpolationType.BEZIER) return "bezier";
  if (t === KeyframeInterpolationType.HOLD) return "hold";
  return "unknown";
}

OPS.set_interpolation = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  __applyInterpolationToKey(prop, args.keyIndex, { "in": args["in"], "out": args["out"] });
  return { ok: true };
};

OPS.set_temporal_ease = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  __applyInterpolationToKey(prop, args.keyIndex, { easeIn: args.easeIn, easeOut: args.easeOut });
  return { ok: true };
};

OPS.set_spatial_tangents = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  if (!prop.isSpatial) throw new Error("Property is not spatial");
  prop.setSpatialTangentsAtKey(args.keyIndex, args.inTangent, args.outTangent);
  return { ok: true };
};
