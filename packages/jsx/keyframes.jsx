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
 * The key's current ease on one side, entry for entry: {ease: [...]} or
 * {error: "<why, with AE's own words>"}. `which` is "in" or "out".
 */
function __readTemporalEase(prop, keyIndex, which) {
  var arr = null;
  try {
    arr = which === "in" ? prop.keyInTemporalEase(keyIndex) : prop.keyOutTemporalEase(keyIndex);
  } catch (e) {
    return { error: "After Effects refused to read it: " + ((e && e.message) ? String(e.message) : String(e)) };
  }
  if (!arr || !arr.length) return { error: "After Effects returned no ease entries for it" };
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (!arr[i] || typeof arr[i].influence !== "number" || typeof arr[i].speed !== "number") {
      return { error: "After Effects returned an ease entry with no numeric influence/speed (entry " + (i + 1) + ")" };
    }
    out.push({ influence: arr[i].influence, speed: arr[i].speed });
  }
  return { ease: out };
}

/** True when every entry of a read-back side carries the same ease. */
function __easeUniform(list) {
  for (var i = 1; i < list.length; i++) {
    if (list[i].influence !== list[0].influence || list[i].speed !== list[0].speed) return false;
  }
  return true;
}

/**
 * `n` KeyframeEase entries for one side, or null when that side cannot be
 * written at `n` without changing it. `spec` is either one {influence, speed}
 * pair, copied to every entry, or the per-dimension list read off the key,
 * which is reapplied entry for entry — a kept side must come back exactly as it
 * was. A kept list of another length maps only when all its entries are the
 * same ease (then any count carries it unchanged); a per-dimension list does
 * not shrink or stretch to fit, because that would rewrite the side the caller
 * asked to keep.
 */
function __easeSide(spec, n) {
  if (spec && spec.length) {
    if (spec.length !== n) return __easeUniform(spec) ? __easeArray(spec[0], n) : null;
    var arr = [];
    for (var i = 0; i < n; i++) arr.push(new KeyframeEase(spec[i].speed, spec[i].influence));
    return arr;
  }
  return __easeArray(spec, n);
}

function __easeLabel(prop) {
  var label = "the property";
  try { label = "'" + prop.name + "'"; } catch (eName) {}
  return label;
}

/**
 * Fill in the side(s) the caller did not pass with what the key has now, read
 * BEFORE anything is written. Returns {"in", "out", known} where `known` is the
 * entry count read back (or null). Throws — having touched nothing — on a key
 * index that does not exist, on a property that cannot hold keyframes, or on a
 * side After Effects will not let us read, each with its own message.
 */
function __resolveEaseSides(prop, keyIndex, easeIn, easeOut) {
  var sides = { "in": easeIn, "out": easeOut, known: null };
  if (easeIn && easeOut) return sides;
  var label = __easeLabel(prop);
  var canVary = true;
  try { if (prop.canVaryOverTime === false) canVary = false; } catch (eVary) {}
  if (!canVary) {
    throw new Error(label + " cannot be keyframed, so it has no ease to keep or set.");
  }
  var numKeys = null;
  try { numKeys = prop.numKeys; } catch (eNum) {}
  if (typeof numKeys === "number" && (keyIndex < 1 || keyIndex > numKeys)) {
    throw new Error(
      "No key " + keyIndex + " on " + label + ": it has " + numKeys + " keyframe" + (numKeys === 1 ? "" : "s") +
      " (key indices start at 1)."
    );
  }
  var which = ["in", "out"];
  for (var w = 0; w < which.length; w++) {
    if (sides[which[w]]) continue;
    var read = __readTemporalEase(prop, keyIndex, which[w]);
    if (!read.ease) {
      throw new Error(
        "Could not read the current " + which[w] + " ease of " + label + " at key " + keyIndex +
        ", so it cannot be kept as it is. " + read.error + ". Pass both easeIn and easeOut to set both sides."
      );
    }
    sides[which[w]] = read.ease;
    sides.known = read.ease.length;
  }
  return sides;
}

/**
 * Apply one {influence, speed} pair to every dimension of `prop` at `keyIndex`,
 * and return the number of KeyframeEase entries After Effects accepted.
 *
 * AE only sets both sides in one call, so a side the caller did not pass is
 * read off the key and reapplied unchanged (issue #153). It used to be reset to
 * 33/0, which silently threw away the easing on the side nobody asked about.
 * The array read back also has the length AE uses for this property, so that
 * count is tried first. A side that cannot be read is refused, not guessed:
 * overwriting it with a default is exactly the bug this replaces.
 *
 * `resolved` is the result of __resolveEaseSides when the caller already read
 * the kept side before its own writes (add_keyframe); otherwise it is read here.
 *
 * Throws only when no count works, naming every one it tried. An ease that
 * quietly failed to land is invisible until someone watches the render, which
 * is the same class of lie as a swallowed error.
 */
function __applyTemporalEase(prop, keyIndex, easeIn, easeOut, resolved) {
  var label = __easeLabel(prop);
  var sides = resolved || __resolveEaseSides(prop, keyIndex, easeIn, easeOut);
  var known = sides.known;
  var candidates = __easeArityCandidates(prop);
  // Spatial keeps its derived 1 first: a 3D Position may also accept 3, which
  // means something else (one per axis), so a read-back must not outrank it.
  if (known !== null && candidates[0] !== known && !prop.isSpatial) {
    var reordered = [known];
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c] !== known) reordered.push(candidates[c]);
    }
    candidates = reordered;
  }
  var lastMessage = "";
  var skipped = [];
  for (var i = 0; i < candidates.length; i++) {
    var n = candidates[i];
    var inArr = __easeSide(sides["in"], n);
    var outArr = __easeSide(sides["out"], n);
    if (!inArr || !outArr) { skipped.push(n); continue; }
    try {
      prop.setTemporalEaseAtKey(keyIndex, inArr, outArr);
      return n;
    } catch (e) {
      lastMessage = (e && e.message) ? String(e.message) : String(e);
    }
  }
  var detail = "";
  if (skipped.length) {
    detail = " Not tried at " + skipped.join(", ") + ": the kept side reads back as " + known +
      " different per-dimension eases, which cannot be written at another count without changing them.";
  }
  throw new Error(
    "Could not set the temporal ease on " + label + " at key " + keyIndex + ": After Effects rejected ease " +
    "arrays of " + candidates.join(", ") + " entries; the ease was not changed." + detail +
    (lastMessage ? " Last error from AE: " + lastMessage : "")
  );
}

/** Returns the ease arity that was used, or null when no ease was requested. */
function __applyInterpolationToKey(prop, keyIndex, interp, resolved, written) {
  if (!interp) return null;
  // Read the side to keep before the interpolation is touched, so a refusal
  // leaves the interpolation as it was and the kept ease is the key's own.
  if (!resolved && (interp.easeIn || interp.easeOut)) {
    resolved = __resolveEaseSides(prop, keyIndex, interp.easeIn, interp.easeOut);
  }
  var inT = interp["in"] && __INTERP_MAP[interp["in"]] ? __INTERP_MAP[interp["in"]] : prop.keyInInterpolationType(keyIndex);
  var outT = interp["out"] && __INTERP_MAP[interp["out"]] ? __INTERP_MAP[interp["out"]] : prop.keyOutInterpolationType(keyIndex);
  prop.setInterpolationTypeAtKey(keyIndex, inT, outT);
  // Only a type the caller asked for counts as written: the others are the
  // key's own, set back unchanged.
  if (written && (interp["in"] || interp["out"])) written.interpolation = true;
  if (resolved) {
    return __applyTemporalEase(prop, keyIndex, interp.easeIn, interp.easeOut, resolved);
  }
  return null;
}

OPS.add_keyframe = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  var interp = args.interpolation;
  // A key already at this time: read the ease side to keep before anything is
  // written, so a refusal there really does leave the property untouched.
  var resolved = null;
  if (interp && (interp.easeIn || interp.easeOut)) {
    var before = __findKeyIndexAtTime(prop, args.time);
    if (before > 0) resolved = __resolveEaseSides(prop, before, interp.easeIn, interp.easeOut);
  }
  prop.setValueAtTime(args.time, args.value);
  var easeDimensions = null;
  if (interp) {
    var idx = __findKeyIndexAtTime(prop, args.time);
    if (idx > 0) {
      var written = { interpolation: false };
      try {
        easeDimensions = __applyInterpolationToKey(prop, idx, interp, resolved, written);
      } catch (eInterp) {
        // The value is already on the key by now; say so rather than let a
        // message about the ease read as though the whole call did nothing.
        throw new Error(
          "The keyframe value at time " + args.time + " was set (key " + idx + ")" +
          (written.interpolation
            ? ", and so was its interpolation, but its ease was not: "
            : ", but its interpolation and ease were not: ") + ((eInterp && eInterp.message) ? eInterp.message : String(eInterp))
        );
      }
    }
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
