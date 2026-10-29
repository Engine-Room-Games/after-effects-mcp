// retime.jsx — retime_keyframes and copy_animation (issue #180).
//
// After Effects has no "move this key" call: a key is moved by reading
// everything about it, removing it, and writing it again at the new time. What
// "everything" means is the whole point of these two ops, because a hand-written
// run_jsx that carries only the value loses the animation's feel — so a key
// record carries its value, both interpolation types, both temporal eases entry
// for entry, the temporal continuous / auto-bezier flags, and on a spatial
// property both spatial tangents, the spatial flags and roving, plus its label.
//
// Two orderings are load-bearing:
//   - every key's VALUE is written before any key's attributes, so a key's
//     neighbours exist when its auto-bezier ease or tangents are computed;
//   - per key the ease is written BEFORE the interpolation types, because
//     setTemporalEaseAtKey turns both sides bezier (measured on 26.5, see
//     __applyTemporalEase in keyframes.jsx) — the other way round a hold or
//     linear side would come back bezier.
//
// Everything is planned and checked before the first write: a path that does
// not resolve, keys that would land on the same frame, a target that already
// has animation — each is refused with every offender named and nothing
// changed. After the write, every attribute is read back, and a disagreement
// throws saying the keys are in place and one undo step brings them back.
//
// The ease array is reapplied at the length it was read, which is the length
// After Effects uses for that property (see the ease-arity notes in
// keyframes.jsx and the extendscript-gotchas guide); the 1-2-3-4 ladder there
// is the fallback, and only for an ease that is the same on every entry.

var __RT_MARKER = "ADBE Marker";
var __RT_TIME_REMAP = "ADBE Time Remapping";

function __rtMsg(e) { return (e && e.message) ? String(e.message) : String(e); }

function __rtLayerLabel(layer) {
  return "layer '" + layer.name + "' (id " + layer.id + ")";
}

function __rtSecs(t) {
  return (Math.round(t * 1000) / 1000) + "s";
}

/**
 * How to find `prop` again from its layer, and how to name it. Children of an
 * indexed group (Effects, Masks, shape Contents, text Animators) are routed by
 * index, because two effects can share a match name and `property(matchName)`
 * would return the first; everything else by match name, which survives a
 * rename and a different UI language.
 */
function __rtRoute(prop) {
  var names = [];
  var route = [];
  var cur = prop;
  while (cur && cur.propertyDepth > 0) {
    var parent = cur.parentProperty;
    names.unshift(cur.name);
    if (parent && parent.propertyType === PropertyType.INDEXED_GROUP) route.unshift(cur.propertyIndex);
    else route.unshift(cur.matchName);
    cur = parent;
  }
  return { names: names, route: route };
}

function __rtResolveRoute(layer, route) {
  var cur = layer;
  for (var i = 0; i < route.length; i++) {
    var next = null;
    try { next = cur.property(route[i]); } catch (e) { next = null; }
    if (!next) return null;
    cur = next;
  }
  return cur;
}

function __rtHasExpression(prop) {
  try { return !!prop.canSetExpression && !!prop.expression; } catch (e) { return false; }
}

function __rtNumKeys(prop) {
  try { return prop.numKeys || 0; } catch (e) { return 0; }
}

/** Every leaf property under `group` that carries keys (or, optionally, an expression). Markers are not animation. */
function __rtCollectAnimated(group, withExpressions, out) {
  var n = 0;
  try { n = group.numProperties; } catch (eN) { n = 0; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (eP) { p = null; }
    if (!p) continue;
    if (p.matchName === __RT_MARKER) continue;
    if (p.propertyType === PropertyType.PROPERTY) {
      if (__rtNumKeys(p) > 0 || (withExpressions && __rtHasExpression(p))) out.push(p);
    } else {
      __rtCollectAnimated(p, withExpressions, out);
    }
  }
  return out;
}

/** The properties a call names, or every animated one on the layer. Problems are pushed, not thrown. */
function __rtPropsOf(layer, paths, withExpressions, problems) {
  if (!paths || !paths.length) return __rtCollectAnimated(layer, withExpressions, []);
  var out = [];
  for (var i = 0; i < paths.length; i++) {
    var p;
    try { p = walkProperty(layer, paths[i]); } catch (e) {
      problems.push(__rtLayerLabel(layer) + ": " + __rtMsg(e));
      continue;
    }
    if (p.propertyType !== PropertyType.PROPERTY) {
      problems.push(__rtLayerLabel(layer) + ": " + __propertyPathLabel(paths[i]) +
        " is a group, not a property — name a property inside it, or omit propertyPaths for every animated one.");
      continue;
    }
    var dup = false;
    for (var j = 0; j < out.length; j++) if (out[j] === p) dup = true;
    if (!dup) out.push(p);
  }
  return out;
}

/**
 * Position with separated dimensions keeps its keys on X/Y(/Z) Position; the
 * combined property has none and refuses a key. Named here, because AE's own
 * refusal says nothing about why.
 */
function __rtSeparationProblem(prop, layer, names, wantKeys) {
  try {
    if (wantKeys && prop.dimensionsSeparated) {
      return __rtLayerLabel(layer) + ": " + names.join(" > ") + " has its dimensions separated, so its keys live on " +
        "X Position / Y Position — name those instead.";
    }
    if (wantKeys && prop.isSeparationFollower && prop.separationLeader && !prop.separationLeader.dimensionsSeparated) {
      return __rtLayerLabel(layer) + ": " + names.join(" > ") + " is not in use — this layer's Position is not " +
        "separated into dimensions, so it cannot take keys there.";
    }
  } catch (e) {}
  return null;
}

// ---------- reading and writing one key ----------

function __rtTry(fn) {
  try { return fn(); } catch (e) { return null; }
}

/** A property whose keys carry no temporal ease: Source Text's TextDocument. */
function __rtEaseless(prop) {
  try {
    if (prop.matchName === "ADBE Text Document") return true;
    if (typeof PropertyValueType !== "undefined" && PropertyValueType.TEXT_DOCUMENT !== undefined &&
        prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT) return true;
  } catch (e) {}
  return false;
}

/** AE refuses an influence outside 0.1..100; a side reading one is not ease we can carry, so it is not written. */
function __rtEaseWritable(list) {
  for (var i = 0; i < list.length; i++) {
    if (!(list[i].influence >= 0.1 && list[i].influence <= 100)) return false;
  }
  return true;
}

function __rtReadKey(prop, i) {
  var k = {
    time: prop.keyTime(i),
    value: prop.keyValue(i),
    inType: prop.keyInInterpolationType(i),
    outType: prop.keyOutInterpolationType(i),
    inEase: null,
    outEase: null,
    tCont: __rtTry(function () { return prop.keyTemporalContinuous(i); }),
    tAuto: __rtTry(function () { return prop.keyTemporalAutoBezier(i); }),
    spatial: false,
    label: __rtTry(function () { return prop.keyLabel(i); }),
  };
  // Source Text is hold-only and has no temporal ease or flags to carry: AE
  // reads it an influence of 0, which it then refuses to write back ("Value 0
  // out of range 0.1 to 100", measured on 26.5). Only the types (and label)
  // travel with such a key, and nothing is invented for it.
  k.easeless = __rtEaseless(prop);
  if (k.easeless) { k.tCont = null; k.tAuto = null; return k; }
  var ri = __readTemporalEase(prop, i, "in");
  var ro = __readTemporalEase(prop, i, "out");
  if (ri.ease && ro.ease && __rtEaseWritable(ri.ease) && __rtEaseWritable(ro.ease)) { k.inEase = ri.ease; k.outEase = ro.ease; }
  if (prop.isSpatial) {
    k.spatial = true;
    k.inTan = __rtTry(function () { return prop.keyInSpatialTangent(i); });
    k.outTan = __rtTry(function () { return prop.keyOutSpatialTangent(i); });
    k.sCont = __rtTry(function () { return prop.keySpatialContinuous(i); });
    k.sAuto = __rtTry(function () { return prop.keySpatialAutoBezier(i); });
    k.roving = __rtTry(function () { return prop.keyRoving(i); });
  }
  return k;
}

function __rtCopyEase(list, factor) {
  if (!list) return null;
  var out = [];
  for (var i = 0; i < list.length; i++) out.push({ influence: list[i].influence, speed: list[i].speed * factor });
  return out;
}

/**
 * The same key at `time`, reshaped for the retime. Influence is a share of the
 * interval, so it survives a stretch unchanged; speed is value per second, so
 * a stretch by `scale` divides it. Reversed, each key's in side becomes its out
 * side — types, eases and spatial tangents swap — and a non-spatial speed
 * changes sign because the value now runs the other way. A spatial speed is
 * the speed along the motion path, which has no direction to flip.
 */
function __rtReshape(k, time, scale, reverse) {
  var factor = 1 / scale;
  if (reverse && !k.spatial) factor = -factor;
  var o = {};
  for (var f in k) if (k.hasOwnProperty(f)) o[f] = k[f];
  o.time = time;
  o.inEase = __rtCopyEase(k.inEase, factor);
  o.outEase = __rtCopyEase(k.outEase, factor);
  if (reverse) {
    o.inType = k.outType; o.outType = k.inType;
    var e = o.inEase; o.inEase = o.outEase; o.outEase = e;
    if (k.spatial) { o.inTan = k.outTan; o.outTan = k.inTan; }
  }
  return o;
}

/** Write a read-back ease at its own length first, then the ladder for a uniform one. */
function __rtSetEase(prop, i, inList, outList) {
  var counts = [inList.length];
  var ladder = __easeArityCandidates(prop);
  for (var c = 0; c < ladder.length; c++) if (ladder[c] !== inList.length) counts.push(ladder[c]);
  var last = "";
  for (var n = 0; n < counts.length; n++) {
    var inArr = __easeSide(inList, counts[n]);
    var outArr = __easeSide(outList, counts[n]);
    if (!inArr || !outArr) continue;
    try { prop.setTemporalEaseAtKey(i, inArr, outArr); return; } catch (e) { last = __rtMsg(e); }
  }
  throw new Error("After Effects refused the key's temporal ease" + (last ? ": " + last : ""));
}

function __rtApplyAttrs(prop, i, k) {
  // A key held on both sides has no curve for an ease to shape.
  var bothHold = k.inType === KeyframeInterpolationType.HOLD && k.outType === KeyframeInterpolationType.HOLD;
  if (k.inEase && k.outEase && !bothHold) __rtSetEase(prop, i, k.inEase, k.outEase);
  prop.setInterpolationTypeAtKey(i, k.inType, k.outType);
  if (k.tCont !== null) prop.setTemporalContinuousAtKey(i, k.tCont);
  if (k.tAuto !== null) prop.setTemporalAutoBezierAtKey(i, k.tAuto);
  if (k.spatial) {
    if (k.sCont !== null) prop.setSpatialContinuousAtKey(i, k.sCont);
    if (k.sAuto !== null) prop.setSpatialAutoBezierAtKey(i, k.sAuto);
    // An auto-bezier key's tangents are AE's to compute; writing them would
    // turn the flag off.
    if (!k.sAuto && k.inTan && k.outTan) prop.setSpatialTangentsAtKey(i, k.inTan, k.outTan);
  }
  if (k.label !== null && k.label !== undefined) prop.setLabelAtKey(i, k.label);
}

function __rtClose(a, b, tol) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

function __rtSameVec(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (!__rtClose(a[i], b[i], 1e-3)) return false;
  return true;
}

/** What did not come back as written, as phrases; [] when everything did. */
function __rtVerifyKey(prop, i, k) {
  var bad = [];
  if (prop.keyInInterpolationType(i) !== k.inType || prop.keyOutInterpolationType(i) !== k.outType) bad.push("interpolation");
  if (k.tCont !== null && __rtTry(function () { return prop.keyTemporalContinuous(i); }) !== k.tCont) bad.push("temporal continuous");
  if (k.tAuto !== null && __rtTry(function () { return prop.keyTemporalAutoBezier(i); }) !== k.tAuto) bad.push("temporal auto-bezier");
  // Ease is compared only where it shapes the curve: a bezier side that AE is
  // not computing itself. A linear or hold side reads back whatever AE derives,
  // and so does a roving key, whose timing AE works out from its neighbours.
  if (k.inEase && !k.tAuto && !k.roving &&
      !(k.inType === KeyframeInterpolationType.HOLD && k.outType === KeyframeInterpolationType.HOLD)) {
    var sides = [["in", k.inType, k.inEase], ["out", k.outType, k.outEase]];
    for (var s = 0; s < sides.length; s++) {
      if (sides[s][1] !== KeyframeInterpolationType.BEZIER) continue;
      var got = __readTemporalEase(prop, i, sides[s][0]);
      var want = sides[s][2];
      var same = !!got.ease;
      if (same && got.ease.length === want.length) {
        for (var e = 0; e < want.length; e++) {
          if (!__rtClose(got.ease[e].influence, want[e].influence, 1e-3) || !__rtClose(got.ease[e].speed, want[e].speed, 1e-3)) same = false;
        }
      } else if (same) {
        // Written at another count through the ladder: only a uniform ease gets there.
        for (var u = 0; u < got.ease.length; u++) {
          if (!__rtClose(got.ease[u].influence, want[0].influence, 1e-3) || !__rtClose(got.ease[u].speed, want[0].speed, 1e-3)) same = false;
        }
      }
      if (!same) bad.push(sides[s][0] + " ease");
    }
  }
  if (k.spatial) {
    if (k.sCont !== null && __rtTry(function () { return prop.keySpatialContinuous(i); }) !== k.sCont) bad.push("spatial continuous");
    if (k.sAuto !== null && __rtTry(function () { return prop.keySpatialAutoBezier(i); }) !== k.sAuto) bad.push("spatial auto-bezier");
    if (!k.sAuto && k.inTan && k.outTan) {
      if (!__rtSameVec(__rtTry(function () { return prop.keyInSpatialTangent(i); }), k.inTan) ||
          !__rtSameVec(__rtTry(function () { return prop.keyOutSpatialTangent(i); }), k.outTan)) bad.push("spatial tangents");
    }
    if (k.roving !== null && __rtTry(function () { return prop.keyRoving(i); }) !== k.roving) bad.push("roving");
  }
  if (k.label !== null && k.label !== undefined && __rtTry(function () { return prop.keyLabel(i); }) !== k.label) bad.push("label");
  return bad;
}

/**
 * Write `keys` (already at their new times) onto `prop`, then read every one
 * back. Returns the list of problems found on read-back; throws only if a write
 * itself is refused, with the property and key named.
 */
function __rtWriteKeys(prop, keys, where, staleTimes) {
  var i;
  // New keys first, old ones after: removing the last key of a property can
  // change the property itself — the last Time Remap key switches time
  // remapping off (measured on 26.5), and every write after that is refused as
  // hidden. So the property never drops to zero keys. An old key sitting where
  // a new one lands is simply overwritten, and its attributes rewritten below.
  for (i = 0; i < keys.length; i++) prop.setValueAtTime(keys[i].time, keys[i].value);
  var stale = (staleTimes || []).slice(0).sort(function (a, b) { return b - a; });
  for (i = 0; i < stale.length; i++) {
    var reused = false;
    for (var r = 0; r < keys.length; r++) if (Math.abs(keys[r].time - stale[i]) < 0.001) reused = true;
    if (reused) continue;
    var old = __findKeyIndexAtTime(prop, stale[i]);
    if (old > 0) prop.removeKey(old);
  }
  var idx = [];
  for (i = 0; i < keys.length; i++) {
    var at = __findKeyIndexAtTime(prop, keys[i].time);
    if (at < 1) throw new Error(where + ": the key written at " + __rtSecs(keys[i].time) + " is not there on read-back.");
    idx.push(at);
  }
  for (i = 0; i < keys.length; i++) {
    try { __rtApplyAttrs(prop, idx[i], keys[i]); } catch (e) {
      throw new Error(where + ", key at " + __rtSecs(keys[i].time) + ": " + __rtMsg(e));
    }
  }
  // Roving last: a roving key's time is AE's to compute from its neighbours, so
  // it moves once the flag is set — and every neighbour must be in place first.
  // An overwritten old key may have been roving; a new one that is not must say so.
  for (i = 0; i < keys.length; i++) {
    if (!keys[i].spatial || keys[i].roving === null) continue;
    var now = __rtTry(function () { return prop.keyRoving(idx[i]); });
    if (now === keys[i].roving) continue;
    try { prop.setRovingAtKey(idx[i], keys[i].roving); } catch (eR) {
      throw new Error(where + ", key at " + __rtSecs(keys[i].time) + ": After Effects refused roving: " + __rtMsg(eR));
    }
  }
  var problems = [];
  for (i = 0; i < keys.length; i++) {
    var bad = __rtVerifyKey(prop, idx[i], keys[i]);
    if (bad.length) problems.push(where + ", key at " + __rtSecs(keys[i].time) + ": " + bad.join(", "));
  }
  return problems;
}

/** Time remapping must still be on after its keys were rewritten; a problem phrase is pushed if not. */
function __rtTimeRemapStillOn(prop, layer, where, problems) {
  if (prop.matchName !== __RT_TIME_REMAP) return;
  var on = true;
  try { on = layer.timeRemapEnabled !== false; } catch (e) {}
  if (!on) problems.push(where + ": After Effects switched time remapping off on this layer");
}

function __rtRefuse(op, problems) {
  throw new Error(
    op + " refused — nothing was changed:\n- " + problems.join("\n- ")
  );
}

function __rtAfterWrite(op, problems) {
  if (!problems.length) return;
  throw new Error(
    op + " wrote the keys, but these did not read back as written:\n- " + problems.join("\n- ") +
    "\nThe whole call is one undo step; undo it in After Effects to put the animation back as it was."
  );
}

/**
 * A write that throws part-way leaves keys already removed or rewritten. The
 * raw AE message alone would read as "nothing happened", so the failure names
 * what had landed, what was in progress, and the one undo that restores it.
 */
function __rtWriteFailure(op, e, done, current) {
  return new Error(
    op + " failed part-way: " + __rtMsg(e) +
    "\nAlready changed: " + (done.length ? done.join("; ") : "nothing before this property") + "." +
    (current ? "\nIn progress: " + current + " — it may be only partly written, and any keys it was replacing were removed first." : "") +
    "\nEverything this call did is one undo step: Edit > Undo in After Effects restores it all."
  );
}

/**
 * Why a property's keys cannot be moved or copied by value, or null. A custom-
 * value property (Curves, Levels' histogram and the like) keeps its keys in a
 * form keyValue cannot read or setValueAtTime write; a no-value one has none.
 */
function __rtUnmovable(prop, where) {
  var vt = null;
  try { vt = prop.propertyValueType; } catch (e) { vt = null; }
  if (typeof PropertyValueType === "undefined" || vt === null || vt === undefined) return null;
  if (vt === PropertyValueType.CUSTOM_VALUE) {
    return where + " holds a custom value (as Curves and Levels do), whose keys cannot be read or written by script; " +
      "leave it out of propertyPaths and move or copy it by hand in After Effects.";
  }
  if (vt === PropertyValueType.NO_VALUE) return where + " has no value to key.";
  return null;
}

/** Orientation and X/Y Rotation exist on a 2D layer but only take effect, and values, in 3D. */
var __RT_ONLY_3D = { "ADBE Orientation": true, "ADBE Rotate X": true, "ADBE Rotate Y": true };

function __rtIsCamOrLight(l) {
  return (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) ||
    (typeof LightLayer !== "undefined" && l instanceof LightLayer);
}

/**
 * Two keys closer than `tol` would merge into one in After Effects — the later
 * write silently replaces the earlier. `entries` are {time, from} with `from`
 * describing where the key came from; returns problem phrases.
 */
function __rtCollisions(entries, tol, where) {
  var sorted = entries.slice(0).sort(function (a, b) { return a.time - b.time; });
  var out = [];
  for (var i = 1; i < sorted.length; i++) {
    if (sorted[i].time - sorted[i - 1].time < tol) {
      out.push(where + ": " + sorted[i - 1].from + " and " + sorted[i].from + " would both land at " +
        __rtSecs(sorted[i].time) + " and merge into one key.");
    }
  }
  return out;
}

function __rtExpressionLive(prop) {
  try { return __rtHasExpression(prop) && !!prop.expressionEnabled; } catch (e) { return false; }
}

// ---------- retime_keyframes ----------

OPS.retime_keyframes = function (args) {
  var c = getCompById(args.compId);
  var fd = c.frameDuration;
  var scale = typeof args.scale === "number" ? args.scale : 1;
  var offset = typeof args.offset === "number" ? args.offset : 0;
  var stagger = typeof args.stagger === "number" ? args.stagger : 0;
  var reverse = !!args.reverse;
  var snap = args.snapToFrames !== false;
  var range = args.range || null;
  var tol = snap ? fd / 2 : 0.001;
  var problems = [];
  if (!(scale > 0)) problems.push("scale must be greater than 0 (got " + scale + "); use reverse:true to play keys backwards.");
  if (range && range.end < range.start) problems.push("range.end (" + range.end + ") is before range.start (" + range.start + ").");
  if (problems.length) __rtRefuse("retime_keyframes", problems);

  var inRange = function (t) {
    return !range || (t >= range.start - 0.0005 && t <= range.end + 0.0005);
  };
  var plans = [];
  var seenLayers = {};
  for (var li = 0; li < args.layers.length; li++) {
    var entry = args.layers[li];
    var l = getLayerById(c, entry.layerId);
    if (seenLayers[l.id]) {
      problems.push(__rtLayerLabel(l) + " is listed twice; list each layer once (put every path it needs in one propertyPaths).");
      continue;
    }
    seenLayers[l.id] = true;
    var props = __rtPropsOf(l, entry.propertyPaths, false, problems);
    var layerPlans = [];
    var lo = null;
    var hi = null;
    for (var pi = 0; pi < props.length; pi++) {
      var prop = props[pi];
      var names = __rtRoute(prop).names;
      var where = __rtLayerLabel(l) + ", " + names.join(" > ");
      var n = __rtNumKeys(prop);
      if (n === 0) {
        if (entry.propertyPaths) problems.push(__rtSeparationProblem(prop, l, names, true) || (where + " has no keyframes to retime."));
        continue;
      }
      var unmovable = __rtUnmovable(prop, where);
      if (unmovable) { problems.push(unmovable); continue; }
      var moved = [];
      var kept = [];
      for (var k = 1; k <= n; k++) {
        var t = prop.keyTime(k);
        if (inRange(t)) {
          moved.push({ index: k, key: __rtReadKey(prop, k) });
          if (lo === null || t < lo) lo = t;
          if (hi === null || t > hi) hi = t;
        } else {
          kept.push(t);
        }
      }
      if (!moved.length) {
        if (entry.propertyPaths) problems.push(where + " has no keyframes inside the range.");
        continue;
      }
      layerPlans.push({ prop: prop, names: names, where: where, moved: moved, kept: kept });
    }
    if (!layerPlans.length) {
      if (!entry.propertyPaths) {
        problems.push(__rtLayerLabel(l) + " has no keyframes" + (range ? " inside the range" : "") + " to retime.");
      }
      continue;
    }
    var pivot = typeof args.pivot === "number" ? args.pivot : lo;
    var shift = offset + li * stagger;
    plans.push({ layer: l, lo: lo, hi: hi, pivot: pivot, shift: shift, props: layerPlans });
  }

  // Map every key and look for anything that would land on top of another.
  for (var p = 0; p < plans.length; p++) {
    var plan = plans[p];
    for (var q = 0; q < plan.props.length; q++) {
      var pp = plan.props[q];
      var entries = [];
      pp.newKeys = [];
      for (var m = 0; m < pp.moved.length; m++) {
        var src = pp.moved[m].key;
        var u = reverse ? (plan.lo + plan.hi - src.time) : src.time;
        u = plan.pivot + (u - plan.pivot) * scale + plan.shift;
        if (snap) u = Math.round(u / fd) * fd;
        pp.newKeys.push(__rtReshape(src, u, scale, reverse));
        entries.push({ time: u, from: "the key at " + __rtSecs(src.time) });
      }
      for (var kk = 0; kk < pp.kept.length; kk++) {
        entries.push({ time: pp.kept[kk], from: "the key at " + __rtSecs(pp.kept[kk]) + " (outside the range, not moved)" });
      }
      var hits = __rtCollisions(entries, tol, pp.where);
      for (var h = 0; h < hits.length; h++) problems.push(hits[h]);
    }
  }
  if (problems.length) __rtRefuse("retime_keyframes", problems);

  var verify = [];
  var out = [];
  var expressionNotes = [];
  var done = [];
  for (var w = 0; w < plans.length; w++) {
    var pl = plans[w];
    var layerOut = { layerId: pl.layer.id, name: pl.layer.name, shift: pl.shift, properties: [] };
    for (var x = 0; x < pl.props.length; x++) {
      var pr = pl.props[x];
      var oldTimes = [];
      for (var y = 0; y < pr.moved.length; y++) oldTimes.push(pr.moved[y].key.time);
      var bad;
      try {
        bad = __rtWriteKeys(pr.prop, pr.newKeys, pr.where, oldTimes);
        __rtTimeRemapStillOn(pr.prop, pl.layer, pr.where, bad);
      } catch (eW) {
        throw __rtWriteFailure("retime_keyframes", eW, done, pr.where + " (" + pr.newKeys.length + " keys)");
      }
      done.push(pr.where + " (" + pr.newKeys.length + " keys retimed)");
      for (var b = 0; b < bad.length; b++) verify.push(bad[b]);
      var first = null;
      var last = null;
      for (var z = 0; z < pr.newKeys.length; z++) {
        var nt = pr.newKeys[z].time;
        if (first === null || nt < first) first = nt;
        if (last === null || nt > last) last = nt;
      }
      layerOut.properties.push({ path: pr.names, keys: pr.newKeys.length, firstKey: first, lastKey: last });
      if (__rtExpressionLive(pr.prop)) expressionNotes.push(pr.names.join(" > ") + " on " + __rtLayerLabel(pl.layer));
    }
    out.push(layerOut);
  }
  __rtAfterWrite("retime_keyframes", verify);
  var result = { ok: true, layers: out };
  if (expressionNotes.length) {
    result.expressionsNotRetimed = expressionNotes;
    result.note = "These properties also carry an expression, which runs on comp time and was not changed — if it " +
      "reads `time`, it no longer lines up with the moved keys.";
  }
  return result;
};

// ---------- copy_animation ----------

OPS.copy_animation = function (args) {
  var sc = getCompById(args.compId);
  var sl = getLayerById(sc, args.layerId);
  var withExpr = args.expressions !== false;
  var replace = !!args.replaceExisting;
  var offset = typeof args.offset === "number" ? args.offset : 0;
  var stagger = typeof args.stagger === "number" ? args.stagger : 0;
  var alignLayer = args.align === "layerStart";
  var problems = [];

  var props = __rtPropsOf(sl, args.propertyPaths, withExpr, problems);
  var sources = [];
  for (var i = 0; i < props.length; i++) {
    var prop = props[i];
    var r = __rtRoute(prop);
    var n = __rtNumKeys(prop);
    var keys = [];
    if (n > 0) {
      var unmovable = __rtUnmovable(prop, __rtLayerLabel(sl) + ", " + r.names.join(" > "));
      if (unmovable) { problems.push(unmovable); continue; }
    }
    for (var k = 1; k <= n; k++) keys.push(__rtReadKey(prop, k));
    var expr = null;
    if (withExpr && __rtHasExpression(prop)) expr = { text: prop.expression, enabled: !!prop.expressionEnabled };
    if (!keys.length && !expr) {
      problems.push(__rtLayerLabel(sl) + ", " + r.names.join(" > ") + " has no keyframes" +
        (withExpr ? " or expression" : "") + " to copy.");
      continue;
    }
    sources.push({ prop: prop, names: r.names, route: r.route, matchName: prop.matchName, keys: keys, expr: expr });
  }
  if (!sources.length && !problems.length) {
    problems.push(__rtLayerLabel(sl) + " has no keyframed" + (withExpr ? " or expression-driven" : "") + " properties to copy.");
  }

  var jobs = [];
  var targetsOut = [];
  var keptExpressions = [];
  var seen = {};
  for (var ti = 0; ti < args.targets.length; ti++) {
    var tdef = args.targets[ti];
    var tc = typeof tdef.compId === "number" ? getCompById(tdef.compId) : sc;
    var tl = getLayerById(tc, tdef.layerId);
    var tkey = tc.id + ":" + tl.id;
    if (seen[tkey]) { problems.push(__rtLayerLabel(tl) + " is listed twice in targets."); continue; }
    seen[tkey] = true;
    if (tc.id === sc.id && tl.id === sl.id) {
      problems.push(__rtLayerLabel(tl) + " is the source layer; it cannot be a target. Use retime_keyframes to move its own keys.");
      continue;
    }
    var shift = offset + ti * stagger + (alignLayer ? tl.startTime - sl.startTime : 0);
    var count = { props: 0, keys: 0, expressions: 0 };
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      var where = __rtLayerLabel(tl) + ", " + src.names.join(" > ");
      var tp = __rtResolveRoute(tl, src.route);
      if (!tp || tp.matchName !== src.matchName) {
        problems.push(where + ": the target has no matching property (it needs the same effects, masks or shape " +
          "groups in the same order as the source).");
        continue;
      }
      // Separation first: a Position split into dimensions on one side and not
      // the other reads as hidden on the target, which is the wrong reason.
      var sep = __rtSeparationProblem(tp, tl, src.names, src.keys.length > 0);
      if (sep) { problems.push(sep); continue; }
      // The same pre-write test set_transform uses (#204): AE 26.5 has no
      // canSetValue, and a hidden property reports canSetExpression:false.
      if (__RT_ONLY_3D[src.matchName] && !tl.threeDLayer && !__rtIsCamOrLight(tl)) {
        problems.push(where + " exists only on a 3D layer, and this one is 2D. Make it 3D first with set_layer " +
          "threeDLayer:true, or leave it out of propertyPaths.");
        continue;
      }
      var settable = true;
      try { settable = tp.canSetExpression !== false; } catch (eS) { settable = false; }
      // X/Y/Z Position of a separated Position are in use whatever that flag
      // says; the separation check above has already refused the other case.
      try {
        if (!settable && tp.isSeparationFollower && tp.separationLeader && tp.separationLeader.dimensionsSeparated) settable = true;
      } catch (eF) {}
      if (!settable) {
        problems.push(where + " is hidden on the target and cannot be set (for example a camera's Point of Interest " +
          "in one-node mode, or a point light's Orientation). Leave it out of propertyPaths.");
        continue;
      }
      if (src.keys.length) {
        if (src.matchName === __RT_TIME_REMAP && !tl.timeRemapEnabled) {
          problems.push(where + ": time remapping is not enabled on the target, so it has no Time Remap to key.");
          continue;
        }
        var canVary = true;
        try { if (tp.canVaryOverTime === false) canVary = false; } catch (eV) {}
        if (!canVary) { problems.push(where + " cannot be keyframed on the target."); continue; }
      }
      if (src.expr) {
        var canExpr = true;
        try { canExpr = !!tp.canSetExpression; } catch (eE) { canExpr = false; }
        if (!canExpr) { problems.push(where + " cannot take an expression on the target."); continue; }
      }
      var taken = [];
      if (src.keys.length && __rtNumKeys(tp) > 0) taken.push(__rtNumKeys(tp) + " keyframe" + (__rtNumKeys(tp) === 1 ? "" : "s"));
      if (src.expr && __rtHasExpression(tp)) taken.push("an expression");
      if (taken.length && !replace) {
        problems.push(where + " already has " + taken.join(" and ") + "; pass replaceExisting:true to replace " +
          (taken.length > 1 ? "them" : "it") + ".");
        continue;
      }
      if (!src.expr && __rtExpressionLive(tp)) keptExpressions.push(where);
      var shifted = [];
      for (var kk = 0; kk < src.keys.length; kk++) shifted.push(__rtReshape(src.keys[kk], src.keys[kk].time + shift, 1, false));
      jobs.push({ prop: tp, layer: tl, where: where, keys: shifted, expr: src.expr });
      count.props++;
      count.keys += shifted.length;
      if (src.expr) count.expressions++;
    }
    targetsOut.push({ compId: tc.id, layerId: tl.id, name: tl.name, shift: shift, properties: count.props, keys: count.keys, expressions: count.expressions });
  }
  if (problems.length) __rtRefuse("copy_animation", problems);

  var verify = [];
  var exprErrors = [];
  var done = [];
  for (var j = 0; j < jobs.length; j++) {
    var job = jobs[j];
    var what = [];
    if (job.keys.length) what.push(job.keys.length + " keys");
    if (job.expr) what.push("expression");
    try {
      if (job.keys.length) {
        var existing = [];
        for (var e = 1; e <= __rtNumKeys(job.prop); e++) existing.push(job.prop.keyTime(e));
        var bad = __rtWriteKeys(job.prop, job.keys, job.where, existing);
        __rtTimeRemapStillOn(job.prop, job.layer, job.where, bad);
        for (var b = 0; b < bad.length; b++) verify.push(bad[b]);
      }
      if (job.expr) {
        job.prop.expression = job.expr.text;
        job.prop.expressionEnabled = job.expr.enabled;
      }
    } catch (eW) {
      throw __rtWriteFailure("copy_animation", eW, done, job.where + " (" + what.join(" + ") + ")");
    }
    done.push(job.where + " (" + what.join(" + ") + " copied)");
    if (job.expr) {
      if (job.expr.enabled) {
        var err = __expressionError(job.prop);
        if (err) exprErrors.push(job.where + ": " + err);
      }
    }
  }
  __rtAfterWrite("copy_animation", verify);
  if (exprErrors.length) {
    throw new Error(
      "copy_animation copied everything, but After Effects cannot evaluate these expressions on the target:\n- " +
      exprErrors.join("\n- ") + "\nThey are on the property as copied. Fix them with set_expression, remove them " +
      "with clear_expression, or undo the whole copy (one undo step). Or copy again with expressions:false."
    );
  }
  var result = { ok: true, targets: targetsOut };
  if (keptExpressions.length) {
    result.targetExpressionsKept = keptExpressions;
    result.note = "These target properties already had an enabled expression, which was left in place and may " +
      "override the copied keys.";
  }
  return result;
};
