// snapshot.jsx — a cheap structural fingerprint of a comp, and the diff
// between two of them.
//
// Verifying a write today means reading the comp back and comparing by eye,
// and every one of those reads is re-sent on every later request for the rest
// of the session. A fingerprint is the other end of that trade: it records
// what an agent actually checks after a write — which layers exist, what they
// are called, where they sit in time, what they are parented to, how many
// keyframes/expressions/effects they carry — and nothing else. The diff of two
// of them is a few dozen tokens for "3 layers added: ids 512-514; layer 498
// Opacity keys 0 -> 4" (issue #52).
//
// Cheapness is the whole point, so the walk stops at the layer's own Transform
// group plus four named properties. It never opens an effect's parameters or a
// shape layer's Contents — those are what make get_layer_full expensive, and a
// fingerprint that costs as much as the read it replaces is worth nothing.
//
// That has a cost of its own, and per the "a scoped read must say what it left
// out" rule it is stated rather than left to be discovered: a diff can only
// report a field it records. __DIFF_COVERS travels with every diff for exactly
// that reason — "no differences" must never be read as "identical".

var __DIFF_COVERS = "Compares recorded fields only - not property values, expression text, " +
  "effect parameters, masks or shape contents. \"No differences\" means none of the recorded fields moved, " +
  "not that the two states render identically.";

var __FP_COVERS = "A snapshot records, per layer: id, name, index, type, inPoint, outPoint, startTime, " +
  "parentId, enabled, keyframe counts per Transform property (plus Marker, Time Remap and Source Text), " +
  "expression count and effect count. Per comp: name, size, duration, frame rate, work area and markers. " +
  "It does NOT record property values, expression text, effect parameters, mask shapes or shape contents, " +
  "because reading those costs as much as the read this replaces.";

// Times are floats out of AE and are compared, not displayed, so they are
// rounded once here rather than at every comparison site.
var __FP_PRECISION = 1000000;

function __fpRound(n) {
  if (typeof n !== "number") return n;
  if (!isFinite(n)) return null;
  return Math.round(n * __FP_PRECISION) / __FP_PRECISION;
}

// Properties worth a fingerprint that do not live under Transform. Each is one
// guarded lookup; a layer that has none of them pays four null checks.
var __FP_EXTRA_PROPS = ["Marker", "Time Remap", "Source Text", "Audio Levels"];

function __fpCountProperty(p, out) {
  if (!p) return;
  var keys = 0;
  try { keys = p.numKeys; } catch (e) { return; }
  if (typeof keys !== "number") return;
  if (keys > 0) out.keyCounts[p.name] = keys;
  try {
    if (p.canSetExpression && p.expression) out.expressionCount += 1;
  } catch (e2) {}
}

function __fpLayer(l) {
  var out = {
    id: l.id,
    name: l.name,
    index: l.index,
    type: __layerKind(l),
    inPoint: __fpRound(l.inPoint),
    outPoint: __fpRound(l.outPoint),
    startTime: __fpRound(l.startTime),
    parentId: null,
    enabled: l.enabled,
    keyCounts: {},
    expressionCount: 0,
    effectCount: 0
  };
  try { if (l.parent) out.parentId = l.parent.id; } catch (e0) {}

  var tr = null;
  try { tr = l.property("Transform"); } catch (e1) {}
  if (tr) {
    for (var i = 1; i <= tr.numProperties; i++) __fpCountProperty(tr.property(i), out);
  }
  for (var j = 0; j < __FP_EXTRA_PROPS.length; j++) {
    var extra = null;
    try { extra = l.property(__FP_EXTRA_PROPS[j]); } catch (e2) {}
    __fpCountProperty(extra, out);
  }
  // Effects are counted, never walked. The parameter tree is the expensive
  // part and an agent checking "did my effect land" only needs the count plus
  // list_effects when it did not.
  try {
    var fx = l.property("Effects");
    if (fx) out.effectCount = fx.numProperties;
  } catch (e3) {}
  return out;
}

function __fpCompMarkers(c) {
  var out = [];
  var mp = null;
  try { mp = c.markerProperty; } catch (e) { return out; }
  if (!mp) return out;
  var n = 0;
  try { n = mp.numKeys; } catch (e2) { return out; }
  for (var i = 1; i <= n; i++) {
    var mv = mp.keyValue(i);
    out.push(String(__fpRound(mp.keyTime(i))) + "|" + String(mv.comment) + "|" + String(__fpRound(mv.duration)));
  }
  return out;
}

function __compFingerprint(compId) {
  var c = getCompById(compId);
  var fp = {
    compId: c.id,
    name: c.name,
    width: c.width,
    height: c.height,
    duration: __fpRound(c.duration),
    frameRate: __fpRound(c.frameRate),
    workAreaStart: __fpRound(c.workAreaStart),
    workAreaDuration: __fpRound(c.workAreaDuration),
    numLayers: c.numLayers,
    markers: __fpCompMarkers(c),
    layers: []
  };
  for (var i = 1; i <= c.numLayers; i++) fp.layers.push(__fpLayer(c.layer(i)));
  return fp;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------
// Pure: two fingerprints in, one object out, no AE. That is what lets it be
// tested against synthetic input (tests/unit/comp-snapshot.mjs) — there is no
// ExtendScript runtime on a runner and this is the part that has to be right.

// Below a frame at any sane frame rate, above the float noise a round-trip
// through JSON leaves behind. Without it a comp re-read after a frame-rate
// change reports every layer "retimed" by 1e-15.
var __DIFF_EPS = 0.000001;

function __diffMoved(a, b) {
  if (typeof a !== "number") return a !== b;
  if (typeof b !== "number") return true;
  return Math.abs(a - b) > __DIFF_EPS;
}

// ES3 has no Map. The "L" prefix keeps a numeric id away from anything already
// on Object.prototype.
function __fpById(fp) {
  var m = {};
  for (var i = 0; i < fp.layers.length; i++) m["L" + fp.layers[i].id] = fp.layers[i];
  return m;
}

function __diffKeyCounts(a, b) {
  var out = null;
  var seen = {};
  var k;
  for (k in a) {
    if (!a.hasOwnProperty(k)) continue;
    seen[k] = true;
    var bv = 0;
    if (b.hasOwnProperty(k)) bv = b[k];
    if (a[k] !== bv) {
      if (!out) out = {};
      out[k] = { from: a[k], to: bv };
    }
  }
  for (k in b) {
    if (!b.hasOwnProperty(k)) continue;
    if (seen[k]) continue;
    if (!out) out = {};
    out[k] = { from: 0, to: b[k] };
  }
  return out;
}

var __DIFF_EXACT_FIELDS = ["name", "type", "enabled"];
var __DIFF_TIME_FIELDS = ["inPoint", "outPoint", "startTime"];
var __DIFF_COUNT_FIELDS = ["expressionCount", "effectCount"];

// `index` is deliberately not compared here: inserting one layer shifts every
// index below it, which would report twenty changed layers for one addition.
// Relative order is compared separately, in __diffReordered.
function __diffLayer(a, b) {
  var ch = {};
  var n = 0;
  var i, k;
  for (i = 0; i < __DIFF_EXACT_FIELDS.length; i++) {
    k = __DIFF_EXACT_FIELDS[i];
    if (a[k] !== b[k]) { ch[k] = { from: a[k], to: b[k] }; n += 1; }
  }
  for (i = 0; i < __DIFF_TIME_FIELDS.length; i++) {
    k = __DIFF_TIME_FIELDS[i];
    if (__diffMoved(a[k], b[k])) { ch[k] = { from: a[k], to: b[k] }; n += 1; }
  }
  for (i = 0; i < __DIFF_COUNT_FIELDS.length; i++) {
    k = __DIFF_COUNT_FIELDS[i];
    if (a[k] !== b[k]) { ch[k] = { from: a[k], to: b[k] }; n += 1; }
  }
  if (a.parentId !== b.parentId) { ch.parentId = { from: a.parentId, to: b.parentId }; n += 1; }
  var kc = __diffKeyCounts(a.keyCounts || {}, b.keyCounts || {});
  if (kc) { ch.keyCounts = kc; n += 1; }
  if (n === 0) return null;
  return { id: b.id, name: b.name, changes: ch };
}

// Only layers present on both sides, and only when their order relative to one
// another actually changed. A layer added or removed elsewhere in the stack is
// not a reorder of anything.
function __diffReordered(before, after, aMap, bMap) {
  var seqA = [];
  var seqB = [];
  var i;
  for (i = 0; i < before.layers.length; i++) {
    var idA = before.layers[i].id;
    if (bMap.hasOwnProperty("L" + idA)) seqA.push(idA);
  }
  for (i = 0; i < after.layers.length; i++) {
    var idB = after.layers[i].id;
    if (aMap.hasOwnProperty("L" + idB)) seqB.push(idB);
  }
  if (seqA.length !== seqB.length) return null;
  var same = true;
  for (i = 0; i < seqA.length; i++) {
    if (seqA[i] !== seqB[i]) { same = false; break; }
  }
  if (same) return null;
  var posA = {};
  for (i = 0; i < seqA.length; i++) posA["L" + seqA[i]] = i;
  var moved = [];
  for (i = 0; i < seqB.length; i++) {
    var id = seqB[i];
    if (posA["L" + id] === i) continue;
    moved.push({
      id: id,
      name: bMap["L" + id].name,
      fromIndex: aMap["L" + id].index,
      toIndex: bMap["L" + id].index
    });
  }
  if (moved.length === 0) return null;
  return moved;
}

function __diffMarkers(a, b) {
  if (a.length !== b.length) return { from: a.length, to: b.length };
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { count: a.length, edited: true };
  }
  return null;
}

function __diffCompFields(a, b) {
  var ch = {};
  var n = 0;
  if (a.name !== b.name) { ch.name = { from: a.name, to: b.name }; n += 1; }
  if (a.width !== b.width || a.height !== b.height) {
    ch.size = { from: [a.width, a.height], to: [b.width, b.height] };
    n += 1;
  }
  if (__diffMoved(a.duration, b.duration)) { ch.duration = { from: a.duration, to: b.duration }; n += 1; }
  if (__diffMoved(a.frameRate, b.frameRate)) { ch.frameRate = { from: a.frameRate, to: b.frameRate }; n += 1; }
  if (__diffMoved(a.workAreaStart, b.workAreaStart) || __diffMoved(a.workAreaDuration, b.workAreaDuration)) {
    ch.workArea = {
      from: [a.workAreaStart, a.workAreaDuration],
      to: [b.workAreaStart, b.workAreaDuration]
    };
    n += 1;
  }
  var mk = __diffMarkers(a.markers || [], b.markers || []);
  if (mk) { ch.markers = mk; n += 1; }
  if (n === 0) return null;
  return ch;
}

// ---------- summary prose ----------

function __diffPlural(n) {
  if (n === 1) return "";
  return "s";
}

// "512-514" for a run, "512, 517" otherwise. Ids come out of AE in creation
// order, so a batch of new layers is nearly always consecutive and this is the
// difference between a readable line and a wall of numbers.
function __diffIdList(ids) {
  if (!ids.length) return "";
  var sorted = [];
  for (var i = 0; i < ids.length; i++) sorted.push(ids[i]);
  sorted.sort(function (x, y) { return x - y; });
  var parts = [];
  var start = sorted[0];
  var prev = sorted[0];
  for (var j = 1; j <= sorted.length; j++) {
    var cur = sorted[j];
    var breaks = true;
    if (j < sorted.length && cur === prev + 1) breaks = false;
    if (breaks) {
      if (start === prev) parts.push(String(start));
      else if (prev === start + 1) parts.push(String(start) + ", " + String(prev));
      else parts.push(String(start) + "-" + String(prev));
      start = cur;
    }
    prev = cur;
  }
  return parts.join(", ");
}

function __diffParentLabel(v) {
  if (v === null || v === undefined) return "none";
  return String(v);
}

function __diffLayerPhrases(entry) {
  var label = "layer " + entry.id;
  var c = entry.changes;
  var out = [];
  if (c.name) out.push(label + ' renamed "' + c.name.from + '" -> "' + c.name.to + '"');
  if (c.enabled) {
    if (c.enabled.to) out.push(label + " enabled");
    else out.push(label + " disabled");
  }
  var times = [];
  if (c.inPoint) times.push("in " + c.inPoint.from + " -> " + c.inPoint.to);
  if (c.outPoint) times.push("out " + c.outPoint.from + " -> " + c.outPoint.to);
  if (c.startTime) times.push("start " + c.startTime.from + " -> " + c.startTime.to);
  if (times.length) out.push(label + " retimed (" + times.join(", ") + ")");
  if (c.parentId) {
    out.push(label + " re-parented " + __diffParentLabel(c.parentId.from) + " -> " + __diffParentLabel(c.parentId.to));
  }
  if (c.keyCounts) {
    for (var k in c.keyCounts) {
      if (!c.keyCounts.hasOwnProperty(k)) continue;
      out.push(label + " " + k + " keys " + c.keyCounts[k].from + " -> " + c.keyCounts[k].to);
    }
  }
  if (c.effectCount) out.push(label + " effects " + c.effectCount.from + " -> " + c.effectCount.to);
  if (c.expressionCount) {
    out.push(label + " expressions " + c.expressionCount.from + " -> " + c.expressionCount.to);
  }
  if (c.type) out.push(label + " type " + c.type.from + " -> " + c.type.to);
  return out;
}

function __diffCompPhrases(ch) {
  var out = [];
  if (ch.name) out.push('comp renamed "' + ch.name.from + '" -> "' + ch.name.to + '"');
  if (ch.size) {
    out.push("comp resized " + ch.size.from[0] + "x" + ch.size.from[1] + " -> " + ch.size.to[0] + "x" + ch.size.to[1]);
  }
  if (ch.duration) out.push("comp duration " + ch.duration.from + " -> " + ch.duration.to);
  if (ch.frameRate) out.push("comp frame rate " + ch.frameRate.from + " -> " + ch.frameRate.to);
  if (ch.workArea) out.push("comp work area moved");
  if (ch.markers) {
    if (ch.markers.edited) out.push("comp markers edited");
    else out.push("comp markers " + ch.markers.from + " -> " + ch.markers.to);
  }
  return out;
}

// One line. Past this many clauses the rest is counted rather than spelled out
// — the structured fields carry everything, and a summary nobody reads to the
// end is worse than a short one that names where to look.
var __DIFF_SUMMARY_CLAUSES = 8;

function __diffSummary(d) {
  var parts = [];
  var i;
  if (d.added) {
    var addedIds = [];
    for (i = 0; i < d.added.length; i++) addedIds.push(d.added[i].id);
    parts.push(d.added.length + " layer" + __diffPlural(d.added.length) + " added: ids " + __diffIdList(addedIds));
  }
  if (d.removed) {
    var removedIds = [];
    for (i = 0; i < d.removed.length; i++) removedIds.push(d.removed[i].id);
    parts.push(d.removed.length + " layer" + __diffPlural(d.removed.length) + " removed: ids " + __diffIdList(removedIds));
  }
  if (d.reordered) {
    parts.push(d.reordered.length + " layer" + __diffPlural(d.reordered.length) + " moved in the stack");
  }
  if (d.changed) {
    for (i = 0; i < d.changed.length; i++) {
      var phrases = __diffLayerPhrases(d.changed[i]);
      for (var p = 0; p < phrases.length; p++) parts.push(phrases[p]);
    }
  }
  if (d.comp) {
    var compPhrases = __diffCompPhrases(d.comp);
    for (i = 0; i < compPhrases.length; i++) parts.push(compPhrases[i]);
  }
  if (parts.length === 0) {
    return "No differences in the recorded fields. Property values, expression text, effect parameters " +
      "and shape contents are not compared, so this is not a claim that nothing changed at all.";
  }
  if (parts.length > __DIFF_SUMMARY_CLAUSES) {
    var extra = parts.length - __DIFF_SUMMARY_CLAUSES;
    parts = parts.slice(0, __DIFF_SUMMARY_CLAUSES);
    parts.push("and " + extra + " more change" + __diffPlural(extra) + " (see the fields below)");
  }
  return parts.join("; ");
}

// Two fingerprints -> only what moved. Unchanged layers are counted, never
// listed: listing them is the cost this whole thing exists to avoid.
function __diffFingerprints(before, after) {
  var aMap = __fpById(before);
  var bMap = __fpById(after);
  var added = [];
  var removed = [];
  var changed = [];
  var unchanged = 0;
  var i, l;
  for (i = 0; i < after.layers.length; i++) {
    l = after.layers[i];
    var prev = aMap["L" + l.id];
    if (!prev) {
      added.push({ id: l.id, name: l.name, index: l.index, type: l.type });
      continue;
    }
    var d = __diffLayer(prev, l);
    if (d) changed.push(d);
    else unchanged += 1;
  }
  for (i = 0; i < before.layers.length; i++) {
    l = before.layers[i];
    if (bMap.hasOwnProperty("L" + l.id)) continue;
    removed.push({ id: l.id, name: l.name, index: l.index, type: l.type });
  }
  var reordered = __diffReordered(before, after, aMap, bMap);
  var comp = __diffCompFields(before, after);

  var out = { compId: after.compId, compName: after.name };
  if (added.length) out.added = added;
  if (removed.length) out.removed = removed;
  if (changed.length) out.changed = changed;
  if (reordered) out.reordered = reordered;
  if (comp) out.comp = comp;
  out.unchangedLayers = unchanged;
  var count = added.length + removed.length + changed.length;
  if (reordered) count += reordered.length;
  if (comp) count += 1;
  out.changeCount = count;
  out.summary = __diffSummary(out);
  out.covers = __DIFF_COVERS;
  return out;
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------
// Both are internal: the tools an agent sees are snapshot_comp and diff_comp,
// and those are half server-resident. Only the panel can read After Effects,
// and only the server can remember anything between calls — so the server
// keeps the fingerprint and these two gather it. See snapshots/store.ts.

OPS._comp_fingerprint = noUndo(function (args) {
  return __compFingerprint(args.compId);
});

OPS._comp_diff = noUndo(function (args) {
  var before = args.since;
  if (!before || !before.layers) {
    throw new Error("_comp_diff needs a stored fingerprint in `since` (the MCP server supplies it from the snapshot id)");
  }
  var compId = args.compId;
  if (compId === undefined || compId === null) compId = before.compId;
  var after = __compFingerprint(compId);
  return { diff: __diffFingerprints(before, after), fingerprint: after };
});

// ---------------------------------------------------------------------------
// diff:true on the write ops
// ---------------------------------------------------------------------------
// The before-fingerprint has to be taken inside the same bridge call as the
// write, or it is not a before at all: a separate snapshot_comp is a second
// round-trip during which anything can happen, and the agent has to remember to
// make it. run_jsx and run_batch therefore fingerprint, run, fingerprint again,
// and diff — one call, one answer.

function __diffPushUnique(list, v) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] === v) return;
  }
  list.push(v);
}

// Explicit diffCompId wins. Otherwise a batch names its own comps in its ops,
// and a script gets the comp the user is looking at. When none of the three
// yields anything the diff is refused with a reason rather than quietly
// skipped — a missing diff that looks like "nothing changed" is the failure
// this whole feature exists to prevent.
function __diffCompIds(args, ops) {
  var ids = [];
  if (args && args.diffCompId !== undefined && args.diffCompId !== null) {
    __diffPushUnique(ids, args.diffCompId);
    return ids;
  }
  if (ops) {
    for (var i = 0; i < ops.length; i++) {
      var a = ops[i].args;
      if (a && typeof a.compId === "number") __diffPushUnique(ids, a.compId);
    }
    if (ids.length > 0) return ids;
  }
  var active = null;
  try { active = app.project.activeItem; } catch (e) {}
  if (active && active instanceof CompItem) __diffPushUnique(ids, active.id);
  return ids;
}

function __diffStart(args, ops) {
  if (!args || !args.diff) return null;
  var ids = __diffCompIds(args, ops);
  if (ids.length === 0) {
    return {
      unavailable: true,
      reason: "no compId appeared in this call and no composition is open in the viewer — pass diffCompId to name the comp to fingerprint"
    };
  }
  var state = { ids: ids, before: [], unavailable: false };
  for (var i = 0; i < ids.length; i++) {
    try {
      state.before.push(__compFingerprint(ids[i]));
    } catch (e) {
      return { unavailable: true, reason: "comp " + ids[i] + " could not be fingerprinted before the call: " + e.message };
    }
  }
  return state;
}

function __diffFinish(state) {
  if (!state) return null;
  if (state.unavailable) {
    return {
      unavailable: true,
      reason: state.reason,
      summary: "No diff was taken: " + state.reason + ". The call itself is unaffected."
    };
  }
  var comps = [];
  var total = 0;
  for (var i = 0; i < state.before.length; i++) {
    var b = state.before[i];
    var after = null;
    try {
      after = __compFingerprint(b.compId);
    } catch (e) {
      comps.push({
        compId: b.compId,
        compName: b.name,
        gone: true,
        changeCount: 1,
        summary: "comp " + b.compId + ' ("' + b.name + '") can no longer be read: ' + e.message
      });
      total += 1;
      continue;
    }
    var d = __diffFingerprints(b, after);
    comps.push(d);
    total += d.changeCount;
  }
  if (comps.length === 1) return comps[0];
  var parts = [];
  for (var j = 0; j < comps.length; j++) parts.push("comp " + comps[j].compId + ": " + comps[j].summary);
  return { comps: comps, changeCount: total, summary: parts.join(" | "), covers: __DIFF_COVERS };
}

// A script or batch that threw still changed whatever it changed before it
// stopped, and nothing rolls back. Finding that stop point by reading the comp
// back is one of the three cases issue #52 was opened for, so the diff is put
// where the agent will actually see it: on the error. The error object itself
// is mutated rather than replaced, so `line` and `stack` survive for the
// caller's own reporting.
function __diffAnnotateError(e, state) {
  if (!state) return;
  var d = null;
  try { d = __diffFinish(state); } catch (e2) { return; }
  if (!d || !d.summary) return;
  try {
    e.message = String(e.message) + " || Changed before it stopped: " + d.summary +
      " (nothing rolls back - read the state back rather than re-running)";
  } catch (e3) {}
}

// run_jsx returns whatever the script returned, which may be a number or a
// string with nowhere to hang a diff on. With diff:true it is enveloped
// instead. The null envelope __rjResult already builds is the right shape
// already, so that one is extended rather than nested inside a second one.
function __rjWithDiff(out, diff, undoGroupName) {
  if (out && typeof out === "object" && !(out instanceof Array) &&
      out.ok === true && out.returned === null && out.note) {
    out.diff = diff;
    return out;
  }
  return { ok: true, returned: out, undoGroup: undoGroupName, diff: diff };
}
