// helpers.jsx — the scope a run_jsx script runs in.
//
// Everything in this file is a global function, which is what makes it visible
// to `eval`d script bodies and to anything loaded through run_jsx's
// `libraries`. It exists because the run_jsx description promised "helpers in
// scope" and never said which, so every session re-derived the same four or
// five functions — find-a-layer-by-id, ease-with-the-right-array-size, a shape
// builder that zeros the position (issue #53). Each of these was written from
// scratch in the transcript, at token cost, with a fresh chance of getting the
// AE quirk wrong.
//
// The rule for adding one: it has to be something an agent would otherwise
// write badly, not merely something it would write often. All four below wrap
// a documented AE trap.
//
// These are listed by signature in the run_jsx tool description. If you change
// one, change that too — it is the only place a caller ever sees them.

// getCompById by a shorter name, because that is the name agents guess.
function compById(id) {
  return getCompById(id);
}

// getLayerById, but the comp may be given as an id. An agent holding
// (compId, layerId) — the pair every tool returns — can use it directly.
function layerById(comp, layerId) {
  var c = comp;
  if (typeof c === "number") c = getCompById(c);
  return getLayerById(c, layerId);
}

// {influence, speed}, or a bare number read as influence. AE's own default
// ease is 33% influence at zero speed, so that is what an omitted field gets.
function __hEaseSpec(spec) {
  if (spec === null || spec === undefined) return { influence: 33, speed: 0 };
  if (typeof spec === "number") return { influence: spec, speed: 0 };
  var inf = 33;
  var spd = 0;
  if (typeof spec.influence === "number") inf = spec.influence;
  if (typeof spec.speed === "number") spd = spec.speed;
  return { influence: inf, speed: spd };
}

// The array sizes to try, best guess first.
//
// setTemporalEaseAtKey wants one KeyframeEase per dimension and the count is
// NOT derivable from the value: a spatial property takes exactly one whatever
// its dimension (the ease runs along the motion path), a 2D layer's Scale takes
// two, a shape's Ellipse Size takes three, Opacity and sliders take one. The
// wrong count throws "parameter 2" and says nothing else (issue #50). So guess
// from what we can read, then fall back to trying the rest — the call validates
// its arguments before it mutates anything, which is what makes retrying safe.
function __hEaseSizes(prop) {
  var guess = 1;
  try {
    if (prop.isSpatial) {
      guess = 1;
    } else {
      var v = prop.value;
      if (v && typeof v.length === "number" && v.length > 0) guess = v.length;
    }
  } catch (e) {}
  var order = [guess];
  var rest = [1, 2, 3];
  for (var i = 0; i < rest.length; i++) {
    if (rest[i] !== guess) order.push(rest[i]);
  }
  return order;
}

// ease(prop, keyIndex, easeIn, easeOut) — sizes its own ease array.
// easeOut omitted means the same ease on both sides. Returns the number of
// entries that worked, so a caller can see what the property actually wanted.
function ease(prop, keyIndex, easeIn, easeOut) {
  var inSpec = __hEaseSpec(easeIn);
  var outSpec = __hEaseSpec(easeOut === undefined ? easeIn : easeOut);
  var sizes = __hEaseSizes(prop);
  var last = "";
  for (var s = 0; s < sizes.length; s++) {
    var n = sizes[s];
    var ins = [];
    var outs = [];
    for (var d = 0; d < n; d++) {
      ins.push(new KeyframeEase(inSpec.speed, inSpec.influence));
      outs.push(new KeyframeEase(outSpec.speed, outSpec.influence));
    }
    try {
      prop.setTemporalEaseAtKey(keyIndex, ins, outs);
      return n;
    } catch (e) {
      try { last = (e && e.message) ? String(e.message) : String(e); } catch (e2) { last = "unknown error"; }
    }
  }
  var nm = "property";
  try { nm = String(prop.name); } catch (e3) {}
  throw new Error(
    "ease(): could not set a temporal ease on \"" + nm + "\" at key " + keyIndex +
    " with 1, 2 or 3 entries — last error: " + last
  );
}

// addKeys(prop, [[time, value], ...]) — or [{time, value}, ...].
// Returns the key index of each, in the order given, so the next call can ease
// them without searching for them again.
function addKeys(prop, pairs) {
  if (!pairs || !pairs.length) return [];
  var out = [];
  for (var i = 0; i < pairs.length; i++) {
    var p = pairs[i];
    var t;
    var v;
    if (p instanceof Array) {
      t = p[0];
      v = p[1];
    } else {
      t = p.time;
      v = p.value;
    }
    prop.setValueAtTime(t, v);
    out.push(prop.nearestKeyIndex(t));
  }
  return out;
}

// shape(comp, {name, position}) — a shape layer that lands at [0,0].
//
// AE spawns a scripted shape layer at the comp centre with its anchor at
// (0,0), so paths authored in comp pixels come out offset by half a frame —
// easy to miss on a downsampled screenshot (issue #51). Position [0,0] makes
// the layer's coordinate space the comp's, which is what path vertices assume.
function shape(comp, opts) {
  var c = comp;
  if (typeof c === "number") c = getCompById(c);
  var o = opts || {};
  var l = c.layers.addShape();
  if (o.name) l.name = o.name;
  var pos = o.position ? o.position : [0, 0];
  var value = (pos.length === 3) ? pos : [pos[0], pos[1]];
  l.property("Transform").property("Position").setValue(value);
  return l;
}
