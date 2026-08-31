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

// ---------- ease array sizing (issue #50) ----------
//
// setTemporalEaseAtKey wants an array of KeyframeEase whose length belongs to
// the *property*, and it is not derivable from the value: a 2D layer Scale
// wants 3, a shape Ellipse Size wants 2 while its value reads [w,h], Opacity
// and a slider want 1, and a spatial Position wants 1 whether the layer is 2D
// or 3D because the ease runs along the motion path. Get it wrong and AE throws
// "parameter 2" and says nothing else — no property name, no expected count.
//
// So: derive the likely count from the property, then try the others. The
// derivation is the fast path; the retry is the safety net, because the Ellipse
// Size case is precisely the one no table gets right from the outside. Whatever
// AE accepted is reported back, so the answer for a given property stops being
// folklore and becomes something a caller can read off a result.
var __EASE_ARITIES = [1, 2, 3, 4];

/** The count to try first, from the property rather than from the value passed in. */
function __easePropertyArity(prop) {
  // Spatial first and unconditionally: a 3D Position is ThreeD_SPATIAL and
  // still takes one entry, so the value type must not get a say here.
  if (prop.isSpatial) return 1;
  var vt = null;
  try { vt = prop.propertyValueType; } catch (eType) {}
  if (vt !== null && vt !== undefined && typeof PropertyValueType !== "undefined") {
    if (vt === PropertyValueType.OneD) return 1;
    if (vt === PropertyValueType.TwoD) return 2;
    if (vt === PropertyValueType.TwoD_SPATIAL) return 1;
    if (vt === PropertyValueType.ThreeD) return 3;
    if (vt === PropertyValueType.ThreeD_SPATIAL) return 1;
    if (vt === PropertyValueType.COLOR) return 4;
  }
  var v = null;
  try { v = prop.value; } catch (eVal) {}
  if (v && v.length) return v.length;
  return 1;
}

/** Derived count first, then every other plausible one, no repeats. */
function __easeArityCandidates(prop) {
  var first = __easePropertyArity(prop);
  var out = [first];
  for (var i = 0; i < __EASE_ARITIES.length; i++) {
    if (__EASE_ARITIES[i] !== first) out.push(__EASE_ARITIES[i]);
  }
  return out;
}

function __easeArray(ease, n) {
  var arr = [];
  for (var i = 0; i < n; i++) arr.push(new KeyframeEase(ease.speed, ease.influence));
  return arr;
}

/**
 * Apply one {influence, speed} pair to every dimension of `prop` at `keyIndex`,
 * and return the number of KeyframeEase entries After Effects accepted.
 *
 * Throws only when no count works, naming every one it tried. An ease that
 * quietly failed to land is invisible until someone watches the render, which
 * is the same class of lie as a swallowed error.
 */
function __applyTemporalEase(prop, keyIndex, easeIn, easeOut) {
  var inEase = easeIn || { influence: 33, speed: 0 };
  var outEase = easeOut || { influence: 33, speed: 0 };
  var candidates = __easeArityCandidates(prop);
  var lastMessage = "";
  for (var i = 0; i < candidates.length; i++) {
    var n = candidates[i];
    try {
      prop.setTemporalEaseAtKey(keyIndex, __easeArray(inEase, n), __easeArray(outEase, n));
      return n;
    } catch (e) {
      lastMessage = (e && e.message) ? String(e.message) : String(e);
    }
  }
  var label = "the property";
  try { label = "'" + prop.name + "'"; } catch (eName) {}
  throw new Error(
    "Could not set the temporal ease on " + label + " at key " + keyIndex + ": After Effects rejected ease " +
    "arrays of " + candidates.join(", ") + " entries. Last error from AE: " + lastMessage
  );
}

/** Returns the ease arity that was used, or null when no ease was requested. */
function __applyInterpolationToKey(prop, keyIndex, interp) {
  if (!interp) return null;
  var inT = interp["in"] && __INTERP_MAP[interp["in"]] ? __INTERP_MAP[interp["in"]] : prop.keyInInterpolationType(keyIndex);
  var outT = interp["out"] && __INTERP_MAP[interp["out"]] ? __INTERP_MAP[interp["out"]] : prop.keyOutInterpolationType(keyIndex);
  prop.setInterpolationTypeAtKey(keyIndex, inT, outT);
  if (interp.easeIn || interp.easeOut) {
    return __applyTemporalEase(prop, keyIndex, interp.easeIn, interp.easeOut);
  }
  return null;
}

OPS.add_keyframe = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.setValueAtTime(args.time, args.value);
  var easeDimensions = null;
  if (args.interpolation) {
    var idx = __findKeyIndexAtTime(prop, args.time);
    if (idx > 0) easeDimensions = __applyInterpolationToKey(prop, idx, args.interpolation);
  }
  var out = { ok: true, keyIndex: __findKeyIndexAtTime(prop, args.time) };
  if (easeDimensions !== null) out.easeDimensions = easeDimensions;
  return out;
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
  // A call with neither ease would previously return {ok:true} having done
  // nothing at all, which reads as "the ease is set" to whoever asked for it.
  if (!args.easeIn && !args.easeOut) {
    throw new Error("set_temporal_ease needs easeIn, easeOut or both — nothing was changed.");
  }
  var n = __applyTemporalEase(prop, args.keyIndex, args.easeIn, args.easeOut);
  return { ok: true, easeDimensions: n };
};

OPS.set_spatial_tangents = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  if (!prop.isSpatial) throw new Error("Property is not spatial");
  prop.setSpatialTangentsAtKey(args.keyIndex, args.inTangent, args.outTangent);
  return { ok: true };
};
