// motion.jsx — the keyframes analyze_motion summarises (issue #244).
//
// analyze_motion reads how a designer's existing comps move — durations,
// eases, overshoot, staggers — so a house style can say it in numbers. Only
// the gathering needs After Effects; the statistics are the server's
// (style/motion.ts), which keeps AE's main thread to plain reads and lets the
// summary change without a panel reinstall.
//
// So this answers raw, compact records and nothing else: per keyed property,
// one array per key — [time, inInterp, outInterp, inInfluence, inSpeed,
// outInfluence, outSpeed, value, identity]. Interpolation is "l" / "b" / "h".
// The ease is the FIRST entry of each side's array: a per-dimension ease is
// rare in hand-made work and the summary says it reads the first. `value` is
// the key's numeric value as an array (a scalar becomes [v]), or null for a
// value that is not numbers (a shape path, a text document) — those still
// count for timing and ease, never for overshoot, and carry `identity`, a
// short hash that tells two equal paths or texts apart from two different
// ones (null for numeric values, or when nothing could be read).
//
// Bounded: `maxKeys` caps the keys read across every comp. A property that no
// longer fits is skipped and counted (`truncated`, `keysNotRead`,
// `propsNotRead`) rather than returned as a partial read that looks whole.
//
// Skipped, and counted so the summary can name them: Time Remap and audio
// levels (retiming and mixing, not a motion style), and any keyed property
// whose expression is on (its keys are not what plays). Passed over uncounted:
// markers, and the master Position of a layer whose dimensions are separated
// (X/Y/Z carry its keys). Each property carries its layer's in/out, ordered
// low to high (null when unreadable), so the server can drop the moves that
// are never on screen. A time-reversed layer's keys are put in comp-time order
// with `reversed: true` rather than dropped.

// Markers are not keyframed motion and are passed over without a count.
var __MO_MARKER = "ADBE Marker";

var __MO_SKIP = {
  "ADBE Time Remapping": true,
  "ADBE Audio Group": true,
  "ADBE Audio Levels": true
};

function __moInterp(t) {
  if (t === KeyframeInterpolationType.LINEAR) return "l";
  if (t === KeyframeInterpolationType.HOLD) return "h";
  return "b";
}

function __moRound(n, places) {
  var f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

/** The key's value as an array of numbers, or null when it is not numeric. */
function __moValue(v) {
  if (typeof v === "number") return isFinite(v) ? [__moRound(v, 4)] : null;
  if (!v || typeof v !== "object" || typeof v.length !== "number" || v.length < 1 || v.length > 4) return null;
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (typeof v[i] !== "number" || !isFinite(v[i])) return null;
    out.push(__moRound(v[i], 4));
  }
  return out;
}

// Identity hashing is bounded twice, because maxKeys caps keys and not what
// is in them: a path over __MO_PATH_MAX_VERTICES vertices is not hashed at
// all, and once __MO_HASH_BUDGET characters have been hashed in one call no
// further value is. Either way the key carries no identity, the server takes
// it as changed (the old, safe reading), and the count comes back in
// `skipped.uncompared` so the summary can say so.
var __MO_PATH_MAX_VERTICES = 1000;
var __MO_HASH_BUDGET = 250000;

function __moHex(h) {
  var hex = (h >>> 0).toString(16);
  while (hex.length < 8) hex = "0" + hex;
  return hex;
}

/**
 * The string's length and two independent 32-bit hashes (djb2 and sdbm), so a
 * swap that collides in one ("Ez" / "FY" under djb2) does not in both. Bit
 * operators keep every step a 32-bit integer, which ES3 does exactly.
 */
function __moHash(str) {
  var h1 = 5381, h2 = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = (c + (h2 << 6) + (h2 << 16) - h2) | 0;
  }
  return str.length.toString(36) + ":" + __moHex(h1) + __moHex(h2);
}

function __moPoints(list) {
  var out = [];
  if (!list) return "";
  for (var i = 0; i < list.length; i++) {
    var pt = list[i];
    out.push(pt && pt.length ? __moRound(pt[0], 3) + "," + __moRound(pt[1], 3) : String(pt));
  }
  return out.join(";");
}

/** One text-style attribute as a string, or "" when it cannot be read; each read on its own. */
function __moAttr(v, name) {
  try {
    var x = v[name];
    if (x === undefined || x === null) return "";
    if (typeof x === "object" && typeof x.length === "number") return x.join(",");
    return String(x);
  } catch (e) { return ""; }
}

var __MO_TEXT_ATTRS = ["font", "fontSize", "applyFill", "fillColor", "applyStroke", "strokeColor", "strokeWidth", "tracking"];

/**
 * A cheap identity for a value that is not numbers, so two keys holding the
 * same shape or the same text are recognised as a hold rather than a move:
 * the hash of a path's vertices, tangents and closed flag, or of a text
 * document's text and style. Null when the value is neither, or when the
 * bounds above say not to hash it (`st.skipped.uncompared` counts those).
 */
function __moIdentity(v, st) {
  if (!v || typeof v !== "object") return null;
  var str = null, tag = "";
  try {
    if (v.vertices) {
      // Refused before the string is built: a vertex prints as about 36
      // characters across vertices and both tangents.
      if (v.vertices.length > __MO_PATH_MAX_VERTICES || st.hashed + v.vertices.length * 36 > __MO_HASH_BUDGET) {
        st.skipped.uncompared += 1;
        return null;
      }
      tag = "s";
      str = __moPoints(v.vertices) + "|" + __moPoints(v.inTangents) + "|" +
        __moPoints(v.outTangents) + "|" + (v.closed ? "1" : "0");
    } else if (typeof v.text === "string") {
      tag = "t";
      var parts = [v.text];
      for (var i = 0; i < __MO_TEXT_ATTRS.length; i++) parts.push(__moAttr(v, __MO_TEXT_ATTRS[i]));
      str = parts.join("|");
    }
  } catch (e) { return null; }
  if (str === null) return null;
  if (st.hashed + str.length > __MO_HASH_BUDGET) { st.skipped.uncompared += 1; return null; }
  st.hashed += str.length;
  return tag + __moHash(str);
}

/** [influence, speed] of the first entry of one side, or [null, null]. */
function __moEase(prop, i, which) {
  try {
    var arr = which === "in" ? prop.keyInTemporalEase(i) : prop.keyOutTemporalEase(i);
    if (arr && arr.length && typeof arr[0].influence === "number" && typeof arr[0].speed === "number") {
      return [__moRound(arr[0].influence, 2), __moRound(arr[0].speed, 4)];
    }
  } catch (e) {}
  return [null, null];
}

function __moExpressionOn(prop) {
  try { return !!prop.canSetExpression && !!prop.expressionEnabled && !!prop.expression; } catch (e) { return false; }
}

function __moNumKeys(prop) {
  try { return prop.numKeys || 0; } catch (e) { return 0; }
}

/**
 * Walk `group` for keyed leaf properties, pushing a record per property onto
 * `st.props` until `st.budget` keys have been read.
 */
function __moWalk(group, names, layer, st) {
  var n = 0;
  try { n = group.numProperties; } catch (eN) { n = 0; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (eP) { p = null; }
    if (!p) continue;
    if (p.matchName === __MO_MARKER) continue;
    // Separated dimensions: X/Y/Z Position carry the keys, the master is not what plays.
    if (p.matchName === "ADBE Position") {
      var sep = false;
      try { sep = !!p.dimensionsSeparated; } catch (eSep) {}
      if (sep) continue;
    }
    if (__MO_SKIP[p.matchName]) {
      if (p.propertyType === PropertyType.PROPERTY && __moNumKeys(p) > 0) st.skipped.notMotion += 1;
      continue;
    }
    var path = names.concat([p.name]);
    if (p.propertyType !== PropertyType.PROPERTY) {
      __moWalk(p, path, layer, st);
      continue;
    }
    var nk = __moNumKeys(p);
    if (nk < 1) continue;
    if (__moExpressionOn(p)) { st.skipped.expressionDriven += 1; continue; }
    if (st.read + nk > st.budget) {
      st.truncated = true;
      st.keysNotRead += nk;
      st.propsNotRead += 1;
      continue;
    }
    var keys = [];
    var lo = -Infinity, hi = Infinity;
    try { lo = layer.inPoint; hi = layer.outPoint; } catch (eIO) {}
    if (lo > hi) { var sw = lo; lo = hi; hi = sw; }
    for (var k = 1; k <= nk; k++) {
      // Every key is sent, including ones outside the layer's in/out: a move
      // that starts before the in point is still seen in part, and only the
      // server knows where a move begins and ends. It drops the moves that
      // lie wholly outside [inPoint, outPoint], sent below.
      var kt = p.keyTime(k);
      var inE = __moEase(p, k, "in");
      var outE = __moEase(p, k, "out");
      var v = null;
      var id = null;
      try {
        var raw = p.keyValue(k);
        v = __moValue(raw);
        if (v === null) id = __moIdentity(raw, st);
      } catch (eV) { v = null; }
      keys.push([
        __moRound(kt, 5),
        __moInterp(p.keyInInterpolationType(k)),
        __moInterp(p.keyOutInterpolationType(k)),
        inE[0], inE[1], outE[0], outE[1],
        v,
        id
      ]);
    }
    st.read += nk;
    if (!keys.length) continue;
    // A time-reversed layer (negative stretch) answers its keys descending in
    // comp time. Read them in comp-time order, where a key's "out" side is the
    // one that plays first — so the ease sides swap too.
    var reversed = keys.length > 1 && keys[0][0] > keys[keys.length - 1][0];
    if (reversed) {
      keys.reverse();
      for (var r = 0; r < keys.length; r++) {
        var kr = keys[r];
        keys[r] = [kr[0], kr[2], kr[1], kr[5], kr[6], kr[3], kr[4], kr[7], kr[8]];
      }
    }
    var spatial = false;
    try { spatial = !!p.isSpatial; } catch (eS) {}
    st.props.push({
      layerId: layer.id,
      layer: layer.name,
      path: path.join(" > "),
      matchName: p.matchName,
      spatial: spatial,
      reversed: reversed,
      inPoint: lo,
      outPoint: hi,
      keys: keys
    });
  }
}

OPS._motion_keys = noUndo(function (args) {
  var ids = args.compIds;
  if (!ids || !ids.length) throw new Error("_motion_keys needs compIds");
  // Resolve every comp before reading any, so a bad id costs nothing.
  var comps = [];
  for (var c = 0; c < ids.length; c++) comps.push(getCompById(ids[c]));
  var budget = args.maxKeys > 0 ? args.maxKeys : 2000;
  var out = [];
  var st = null;
  var read = 0, truncated = false, keysNotRead = 0, propsNotRead = 0, hashed = 0;
  for (var j = 0; j < comps.length; j++) {
    var comp = comps[j];
    st = {
      props: [], read: read, budget: budget, truncated: truncated, keysNotRead: 0, propsNotRead: 0, hashed: hashed,
      skipped: { notMotion: 0, expressionDriven: 0, uncompared: 0 }
    };
    for (var li = 1; li <= comp.numLayers; li++) {
      var layer = comp.layer(li);
      __moWalk(layer, [], layer, st);
    }
    read = st.read;
    hashed = st.hashed;
    truncated = st.truncated;
    keysNotRead += st.keysNotRead;
    propsNotRead += st.propsNotRead;
    out.push({
      id: comp.id,
      name: comp.name,
      frameRate: comp.frameRate,
      duration: comp.duration,
      numLayers: comp.numLayers,
      props: st.props,
      skipped: st.skipped
    });
  }
  return {
    comps: out,
    keysRead: read,
    maxKeys: budget,
    truncated: truncated,
    keysNotRead: keysNotRead,
    propsNotRead: propsNotRead
  };
});
