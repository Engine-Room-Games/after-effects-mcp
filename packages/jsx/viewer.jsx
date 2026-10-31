// viewer.jsx — parking the viewer before a run_jsx (issue #266).
//
// Measured on AE 26.5 (2026-10-31): ANY change to the project — even to a comp
// the viewer does not show — makes After Effects re-run every pixel-affecting
// expression of the comp in the viewer, at its current frame, on the main
// thread, once per change. A run_jsx making 1 / 3 / 20 changes cost 3.7 s /
// 11.1 s / 74 s with a heavy comp in view; read-only calls cost nothing;
// expressions in comps nested inside the viewed one cost nothing. Quality,
// resolution, zoom, Fast Previews, selection, app.disableRendering and Live
// Update made no difference. Swapping the viewer from inside the same
// evalScript only takes effect once that call has ended, so it cannot help the
// script it runs in. What works is a light comp already in the viewer BEFORE
// the call starts.
//
// So the server sends three calls under one write lease (tools/viewerPark.ts):
// _viewer_park, then the script, then _viewer_unpark. Both are pure VIEW
// changes: the parking comp is one persistent, tagged, empty 16×16 comp at the
// project root, created the first time it is needed and reused after. A comp
// made and removed per call would itself be two project changes — each one a
// full re-evaluation of the heavy comp, the project marked unsaved, and two
// undo steps around the script's, so Cmd-Z after a run would bring the parking
// comp back instead of undoing the script. Creating it once is one undo step,
// in its own group, the first time only, and it is never part of a script's
// step.
//
//  * Parked only when it can pay off: the viewed comp has at least one enabled
//    expression on an enabled layer of its own (not only inside a precomp).
//    Otherwise nothing changes and no unpark is needed.
//  * The comp it replaced is remembered here, in the bundle — not on the comp,
//    because writing a comment is a project change. viewerComp() (helpers.jsx)
//    and __userActiveItem() read it, so neither a script nor a read op ever
//    mistakes the parking comp for the user's.
//  * Unpark reopens that comp only while the viewer still shows the parking
//    comp. If the script opened another comp itself, that is respected and
//    reported.
//  * A park nobody unparked (the server died, or the script timed out) is
//    found by the next park, which takes its comp over, and by check_setup.

var __PARK_TAG = "ae-mcp-viewer-parking:v1";
var __PARK_COMP_NAME = "AE MCP viewer parking (safe to delete)";
var __PARK_UNDO_NAME = "AE MCP: create viewer parking comp";
// The expression scan stops here and answers "unsure", which parks: a scan
// that cannot finish must not be the reason a heavy comp stays in view.
var __PARK_SCAN_BUDGET_MS = 200;
var __PARK_SCAN_MAX_PROPS = 20000;

// The park in force: {fromId, fromName, parkId, at, token}. Set by _viewer_park
// and cleared by _viewer_unpark. It lives in the bundle's closure, so it
// outlives a server that died between the two, but not a reload of the bundle.
var __PARK = null;
// Each park's token, answered to the server and sent back with its unpark, so
// an unpark can tell its own park from another call's (issue #277). Started
// from the clock, so a token from before a reload of the bundle never matches
// a park made after it.
var __PARK_SEQ = new Date().getTime();
// The parks ended by a call other than their own unpark, newest last, at most
// __PARK_TAKEN_MAX: {token, by, reopened, why?}. `by` is who ended it and
// `reopened` whether that call actually reopened the comp the park replaced —
// recorded as it happened, never assumed (issue #277 review):
//   "park"     another call's park took it over (the viewer still on the
//              parking comp): that call's unpark tries to reopen the comp;
//   "dropped"  another call's park found the viewer no longer on the parking
//              comp, or the comp gone, or could not park, and forgot this
//              park — nothing reopened; `why` says which;
//   "dry-run"  a dry-run park (before a script that reads activeItem) undid it;
//   "recover"  check_setup or a session's next write undid it;
//   "unpark"   an unpark sent without a token (its own park's answer was lost)
//              ended it in its place.
// With the front desk serializing every session's writes, none of this can
// happen between a call's park and its unpark; with it off
// (AE_MCP_FRONT_DESK=off) another session's call can land there, and the
// unpark then says what happened instead of guessing.
var __PARK_TAKEN = [];
var __PARK_TAKEN_MAX = 16;

// The park in force ends here, by `by`, when not by its own unpark. Answers
// the record (so the caller can mark `reopened` once it has), or null when no
// park was in force.
function __parkEndBy(by, why) {
  var rec = null;
  if (__PARK) {
    rec = { token: __PARK.token, by: by, reopened: false };
    if (why) rec.why = why;
    // A "dropped" by a dry-run park (before a script that reads activeItem) is said as one.
    if (by === "dropped" && __parkDryRun) rec.dryRun = true;
    __PARK_TAKEN.push(rec);
    if (__PARK_TAKEN.length > __PARK_TAKEN_MAX) __PARK_TAKEN.shift();
  }
  __PARK = null;
  return rec;
}

// Whether the _viewer_park running now is a dry run (read by __parkEndBy).
var __parkDryRun = false;

// How the park with this token ended, if another call ended it; else null.
function __parkTakenBy(token) {
  for (var i = __PARK_TAKEN.length - 1; i >= 0; i--) {
    if (__PARK_TAKEN[i].token === token) return __PARK_TAKEN[i];
  }
  return null;
}
// The last park unparked, kept so a later park that still finds the parking
// comp in the viewer (an unpark whose reopen did not take) knows the way back.
var __PARK_LAST = null;
// The parking comp's id, remembered to avoid walking the project each call.
// Always re-checked against the tag before it is trusted.
var __PARK_ID = null;

function __parkMsg(e) {
  try { return (e && e.message) ? String(e.message) : String(e); } catch (x) { return "unknown error"; }
}

function __parkItem(id) {
  if (id === null || id === undefined) return null;
  try { return app.project.itemByID(id) || null; } catch (e) { return null; }
}

// Carries the tag: the comp is, or was, AE MCP's parking comp.
function __parkIsTagged(item) {
  if (!item) return false;
  try { if (!(item instanceof CompItem)) return false; } catch (e) { return false; }
  var c;
  try { c = item.comment; } catch (e1) { return false; }
  return typeof c === "string" && c.indexOf(__PARK_TAG) === 0;
}

// How the parking comp is made (__parkCreate), field by field. A tagged comp
// that differs in any of these was changed by someone — a script that wrote to
// app.project.activeItem while parked, or the user — and is no longer the
// parking comp: never reused, never hidden, never treated as parked; whatever
// landed in it is the user's work now.
// The settings a script could change, each read as text. Recorded in the tag
// when the comp is made (`made=`, in the one comment write creation does
// anyway), so a comp is compared with how After Effects actually made it —
// never with a guess at its defaults, which, if wrong, would read every fresh
// parking comp as changed and make a new one on every run.
var __PARK_FIELDS = [
  ["width", function (c) { return c.width; }],
  ["height", function (c) { return c.height; }],
  ["duration", function (c) { return c.duration; }],
  ["frame rate", function (c) { return c.frameRate; }],
  ["pixel aspect", function (c) { return c.pixelAspect; }],
  ["work area", function (c) { return c.workAreaStart + "+" + c.workAreaDuration; }],
  ["start timecode", function (c) { return c.displayStartTime; }],
  ["motion blur", function (c) { return c.motionBlur; }],
  ["frame blending", function (c) { return c.frameBlending; }],
  ["background colour", function (c) { var k = c.bgColor; return Math.round(k[0] * 255) + "." + Math.round(k[1] * 255) + "." + Math.round(k[2] * 255); }]
];
// comp.time is deliberately NOT a field: opening a comp in the viewer, and a
// user scrubbing a viewer that shows it, move its time indicator with no
// script involved, and that is no change to the project.

function __parkFieldValue(c, i) {
  try { return String(__PARK_FIELDS[i][1](c)); } catch (e) { return "?"; }
}

function __parkFingerprint(c) {
  var parts = [];
  for (var i = 0; i < __PARK_FIELDS.length; i++) parts.push(__parkFieldValue(c, i));
  return parts.join("|");
}

// What differs from how the comp was made, by name. A tagged comp that differs
// in anything was changed by someone — a script that wrote to
// app.project.activeItem while parked, or the user — and is no longer the
// parking comp: never reused, never hidden, never treated as parked; whatever
// landed in it is the user's work now.
function __parkChanges(item) {
  var out = [];
  function differs(label, read, want) {
    var v;
    try { v = read(); } catch (e) { return; }
    if (v !== want) out.push(label);
  }
  differs("layers", function () { return item.numLayers; }, 0);
  differs("name", function () { return item.name; }, __PARK_COMP_NAME);
  differs("markers", function () { return item.markerProperty.numKeys; }, 0);
  differs("folder", function () { return item.parentFolder.id === app.project.rootFolder.id; }, true);
  var made = null;
  try {
    var m = /\bmade=(\S+)/.exec(item.comment);
    if (m) made = m[1].split("|");
  } catch (e) { made = null; }
  if (made && made.length === __PARK_FIELDS.length) {
    for (var i = 0; i < __PARK_FIELDS.length; i++) {
      var now = __parkFieldValue(item, i);
      if (now !== "?" && made[i] !== "?" && now !== made[i]) out.push(__PARK_FIELDS[i][0]);
    }
  } else {
    // A tag without the record: the size it was always made at.
    differs("width", function () { return item.width; }, 16);
    differs("height", function () { return item.height; }, 16);
  }
  return out;
}

function __parkIsParkingComp(item) {
  if (!__parkIsTagged(item)) return false;
  return __parkChanges(item).length === 0;
}

// What list_comps, get_project_summary and find_layers leave out, and count.
function __parkIsInternalItem(item) {
  return __parkIsParkingComp(item);
}

// What a script left in a parking comp, or null when it is as made.
function __parkDirt(item) {
  if (!__parkIsTagged(item) || __parkIsParkingComp(item)) return null;
  var names = [];
  var n = 0;
  try { n = item.numLayers; } catch (e) { n = 0; }
  for (var i = 1; i <= n && names.length < 5; i++) {
    try { names.push("\"" + item.layer(i).name + "\""); } catch (e1) {}
  }
  var changed = __parkChanges(item);
  var settings = [];
  for (var k = 0; k < changed.length; k++) if (changed[k] !== "layers") settings.push(changed[k]);
  var what = n > 0 ? n + " layer(s) (" + names.join(", ") + (n > names.length ? ", …" : "") + ")" : "";
  if (settings.length) what += (what ? " and " : "") + "a change to its " + settings.join(", ");
  return "CAUTION: " + what + " landed in AE MCP's parking comp " + item.id + " (\"" + item.name + "\"), not in the " +
    "user's comp — the script wrote to app.project.activeItem, which is the parking comp while it runs; use viewerComp(). " +
    "Tell the user; move the layers into the right comp or undo the script. That comp is no longer used for parking";
}

function __parkFind() {
  var it = __parkItem(__PARK_ID);
  if (it && __parkIsParkingComp(it)) return it;
  __PARK_ID = null;
  for (var i = 1; i <= app.project.numItems; i++) {
    var c = app.project.item(i);
    if (__parkIsParkingComp(c)) { __PARK_ID = c.id; return c; }
  }
  return null;
}

// Two project changes, the first time only: the comp and its tag. No folder —
// one would be two more, and an empty one left visible when the comp is gone.
function __parkCreate() {
  var c = app.project.items.addComp(__PARK_COMP_NAME, 16, 16, 1, 1, 1);
  c.comment = __PARK_TAG + " made=" + __parkFingerprint(c) + " — AE MCP shows this empty comp in the viewer while a script runs, so After Effects " +
    "does not re-evaluate your comp's expressions after every change the script makes. Safe to delete; it is made " +
    "again when needed.";
  __PARK_ID = c.id;
  return c;
}

// The comp in the active composition viewer, or null. app.project.activeItem
// answers for the viewer only while that viewer has focus (`active`); while
// the Project panel has it, activeItem is the panel's SELECTION, which may be a
// comp nobody has in view — parking would then scan the wrong comp and the
// unpark reopen a comp the user never had open. So activeItem is used as it
// is only when the composition viewer is active; otherwise the viewer is
// focused with setActive() first. Opening a comp in the viewer, which a park
// and an unpark do, focuses it anyway (#273). Live check: recipe 77.
function __parkViewerComp() {
  var v = null;
  try { v = app.activeViewer; } catch (e) { v = null; }
  if (!v) return null;
  try { if (v.type !== ViewerType.VIEWER_COMPOSITION) return null; } catch (e1) { return null; }
  var a = null;
  var focused = false;
  try { focused = v.active === true; } catch (e4) { focused = false; }
  if (focused) {
    try { a = app.project.activeItem; } catch (e2) { a = null; }
    if (a && a instanceof CompItem) return a;
  }
  a = null;
  try {
    if (v.setActive() !== false) a = app.project.activeItem;
  } catch (e3) { a = null; }
  return (a && a instanceof CompItem) ? a : null;
}

// The comp a parked viewer replaced, or null. Trusted only while the active
// item really is the parking comp: a __PARK an interrupted call left behind,
// with the user back in a comp of their own, is no answer for this call.
function __parkedFrom() {
  var st = __PARK;
  if (!st) return null;
  var a = null;
  try { a = app.project.activeItem; } catch (e) { a = null; }
  if (!a || !__parkIsParkingComp(a) || a.id !== st.parkId) return null;
  return __parkItem(st.fromId);
}

// app.project.activeItem, except that the parking comp answers as the comp it
// replaced (or null when that is not known). Every op that reports or defaults
// to the active item reads it through here.
function __userActiveItem() {
  var a = null;
  try { a = app.project.activeItem; } catch (e) { a = null; }
  if (!a || !__parkIsParkingComp(a)) return a;
  var st = __PARK || __PARK_LAST;
  return st ? __parkItem(st.fromId) : null;
}

// Is there an enabled expression on an enabled layer of this comp? Only the
// comp's own layers: expressions inside a nested precomp were measured to cost
// nothing. {found, unsure, where}.
function __parkExpressionScan(comp) {
  var started = new Date().getTime();
  var seen = 0;
  var res = { found: false, unsure: false, where: null };
  function over() {
    if (seen > __PARK_SCAN_MAX_PROPS || (new Date().getTime() - started) > __PARK_SCAN_BUDGET_MS) {
      res.unsure = true;
      return true;
    }
    return false;
  }
  function walk(group, layerName) {
    var n = 0;
    try { n = group.numProperties; } catch (e) { return false; }
    for (var i = 1; i <= n; i++) {
      seen += 1;
      if (over()) return true;
      var p = null;
      try { p = group.property(i); } catch (e1) { p = null; }
      if (!p) continue;
      var kind = null;
      try { kind = p.propertyType; } catch (e2) { kind = null; }
      if (kind === PropertyType.PROPERTY) {
        var on = false;
        try { on = p.canSetExpression && p.expressionEnabled && String(p.expression) !== ""; } catch (e3) { on = false; }
        if (on) {
          res.found = true;
          res.where = layerName;
          return true;
        }
      } else {
        // A switched-off effect does not render; the 3D materials group is
        // inert on a 2D layer and is 48 properties per shape group.
        var skip = false;
        try { skip = p.enabled === false || p.matchName === "ADBE Vector Materials Group"; } catch (e4) { skip = false; }
        if (!skip && walk(p, layerName)) return true;
      }
    }
    return false;
  }
  var count = 0;
  try { count = comp.numLayers; } catch (e5) { count = 0; }
  for (var li = 1; li <= count; li++) {
    var l = null;
    try { l = comp.layer(li); } catch (e6) { l = null; }
    if (!l) continue;
    var enabled = true;
    try { enabled = l.enabled !== false; } catch (e7) { enabled = true; }
    if (!enabled) continue;
    var name = "";
    try { name = l.name; } catch (e8) { name = ""; }
    if (walk(l, name)) break;
  }
  return res;
}

// Server-only (tools/viewerPark.ts), sent under the run_jsx call's write lease
// before the script. Answers {parked, compId?, compName?, created?, recovered?,
// skipped?, note?}. noUndo: opening a comp in the viewer is no undo step; the
// one-time creation opens a group of its own.
// Why a park in force was forgotten rather than taken over: the viewer had
// moved off the parking comp (the script, or the user, opened `now`).
function __parkMovedWhy(now) {
  return "the viewer was showing comp " + now.id + " (\"" + now.name + "\") by then, not the parking comp";
}

OPS._viewer_park = noUndo(function (args) {
  __parkDryRun = !!(args && args.dryRun);
  var out = { parked: false };
  var stale = __PARK;
  var from = __parkViewerComp();
  var alreadyParked = false;
  // A tagged comp a script wrote into, with no park on record, is the user's
  // to work in now: parked like any other.
  if (from && __parkIsParkingComp(from)) {
    // An earlier park nobody unparked (a server that died, a script that timed
    // out), or an unpark whose reopen did not take: take its comp over.
    var prior = stale || __PARK_LAST;
    var back = prior ? __parkItem(prior.fromId) : null;
    if (!back) {
      __parkEndBy("dropped", "the comp it replaced no longer exists");
      out.skipped = "already-parked";
      out.note = "the viewer was already showing the AE MCP parking comp and the comp it replaced is not known " +
        "(or no longer exists), so the script ran with the parking comp in view and nothing will be reopened";
      return out;
    }
    from = back;
    alreadyParked = true;
    out.recovered = { compId: back.id, compName: back.name };
  }
  if (!from) {
    __parkEndBy("dropped", "the viewer was no longer showing a composition");
    out.skipped = "no-comp-in-viewer";
    return out;
  }
  out.compId = from.id;
  out.compName = from.name;
  if (!alreadyParked) {
    var scan = __parkExpressionScan(from);
    if (!scan.found && !scan.unsure) {
      __parkEndBy("dropped", __parkMovedWhy(from));
      out.skipped = "no-expressions";
      return out;
    }
    if (scan.unsure) out.scan = "unsure";
  }
  // Would it park? Asked for a script that reads app.project.activeItem, which
  // is not parked (tools/viewerPark.ts) — only told that it could have been.
  if (args && args.dryRun) {
    out.wouldPark = true;
    // A park an interrupted call left is undone here, before that script —
    // which reads activeItem — can write into the parking comp.
    if (alreadyParked) {
      var undone = __parkEndBy("dry-run");
      try {
        from.openInViewer();
        if (undone) undone.reopened = true;
      } catch (e0) {}
    }
    return out;
  }
  var park = null;
  try {
    park = __parkFind();
    if (!park) {
      park = withUndo(__PARK_UNDO_NAME, __parkCreate);
      out.created = true;
    }
    if (!alreadyParked) park.openInViewer();
  } catch (e) {
    __parkEndBy("dropped", "another call's park failed (" + __parkMsg(e) + ")" +
      (alreadyParked ? ", with the viewer still on the parking comp" : ""));
    out.skipped = "failed";
    out.note = "the viewer could not be parked (" + __parkMsg(e) + "), so the script ran with comp " + from.id +
      " in view, re-evaluated after every change";
    return out;
  }
  // Taken over (the viewer still on the parking comp: this park reopens that
  // comp later), or forgotten (the viewer had moved on: nothing reopened).
  if (alreadyParked) __parkEndBy("park");
  else __parkEndBy("dropped", __parkMovedWhy(from));
  __PARK_SEQ++;
  __PARK = { fromId: from.id, fromName: from.name, parkId: park.id, at: new Date().getTime(), token: __PARK_SEQ };
  out.parked = true;
  out.token = __PARK_SEQ;
  return out;
});

// What an unpark that ended another call's park did, recorded on that park's
// record as it happened: reopened, or why not (#277 review).
function __parkEnded(rec, res) {
  if (!rec) return res;
  rec.reopened = res.reopened === true;
  // The comp the park replaced is what the viewer shows, read back (a script
  // that reopened it itself, say): said as such, never as "not reopened".
  if (res.restored === true) rec.restored = true;
  if (!rec.reopened && !rec.restored) {
    if (res.note) rec.why = res.note;
    else if (res.viewerComp) rec.why = "the viewer was showing comp " + res.viewerComp.id + " (\"" + res.viewerComp.name + "\") by then, which was left there";
    else rec.why = "the comp was not reopened";
  }
  return res;
}

// Server-only, sent after the script under the same lease (and by check_setup
// with recover:true). Idempotent: with no park in force it does nothing.
// Answers {unparked, reopened?, restored, compId, compName, viewerComp?, caution?, note?},
// or {unparked: false, takenBy?}. `token` (the park's own, from its answer)
// makes it this park's unpark only: another call's park is left alone, and
// one that ended another way is named (`takenBy`, see __PARK_TAKEN).
OPS._viewer_unpark = noUndo(function (args) {
  var st = __PARK;
  var token = (args && typeof args.token === "number") ? args.token : null;
  if (token !== null && !(args && args.recover) && (!st || st.token !== token)) {
    var taken = __parkTakenBy(token);
    if (!taken) return { unparked: false };
    var t = { unparked: false, takenBy: taken.by, reopened: taken.reopened };
    if (taken.why) t.why = taken.why;
    if (taken.dryRun) t.dryRun = true;
    if (taken.restored) t.restored = true;
    return t;
  }
  if (!st) {
    if (!(args && args.recover)) return { unparked: false };
    // A park whose reopen did not take: the viewer still on the parking comp.
    // activeItem only — no focus is moved for a check that is nearly always no.
    var a = null;
    try { a = app.project.activeItem; } catch (e) { a = null; }
    if (!a || !__parkIsParkingComp(a) || !__PARK_LAST) return { unparked: false };
    st = __PARK_LAST;
  } else if (args && args.recover && __parkDirt(__parkItem(st.parkId))) {
    // A park left by an interrupted call whose script built in the parking
    // comp: that comp is the user's work now, and it is what they are looking
    // at. Nothing is reopened over it; the park is forgotten and the CAUTION said.
    __parkEndBy("recover", "the parking comp had been written into, so it was left in the viewer as the user's");
    __PARK_LAST = null;
    return { unparked: false, caution: __parkDirt(__parkItem(st.parkId)) };
  }
  // Ended by its own unpark (the token matched) — or, with no token, by an
  // unpark that cannot know whose park this is: recorded, so the park's own
  // unpark is told what happened instead of finding nothing (#277 review).
  var ended = null;
  if (args && args.recover) ended = __parkEndBy("recover");
  else if (token === null) ended = __parkEndBy("unpark");
  else __PARK = null;
  __PARK_LAST = st;
  var res = { unparked: true, restored: false, compId: st.fromId, compName: st.fromName };
  var dirt = __parkDirt(__parkItem(st.parkId));
  if (dirt) res.caution = dirt;
  var now = __parkViewerComp();
  // Still parked: the viewer shows this park's own comp (written into or not —
  // the CAUTION above says so). Anything else is the script's choice.
  if (now && now.id !== st.parkId && !__parkIsParkingComp(now)) {
    // The script put a comp in the viewer itself (openInViewer,
    // OPS.set_active_comp): its choice stands.
    res.viewerComp = { id: now.id, name: now.name };
    if (now.id === st.fromId) res.restored = true;
    else res.note = "the script opened comp " + now.id + " (\"" + now.name + "\") in the viewer, so it was left there " +
      "rather than reopening comp " + st.fromId + " (\"" + st.fromName + "\")";
    return __parkEnded(ended, res);
  }
  if (!now) {
    var v = null;
    try { v = app.activeViewer; } catch (e1) { v = null; }
    if (v) {
      res.note = "the active viewer is no longer a composition viewer (the script opened a layer or footage " +
        "viewer?), so comp " + st.fromId + " (\"" + st.fromName + "\") was not reopened";
      return __parkEnded(ended, res);
    }
  }
  var from = __parkItem(st.fromId);
  if (!from || !(from instanceof CompItem)) {
    res.note = "comp " + st.fromId + " (\"" + st.fromName + "\") was in the viewer and no longer exists — the script " +
      "removed it — so the viewer still shows the AE MCP parking comp";
    return __parkEnded(ended, res);
  }
  try {
    from.openInViewer();
    res.reopened = true;
    // `restored` is claimed only when the viewer is seen showing the comp.
    // Measured on 26.5, a viewer change lands once the call has ended, so this
    // read usually cannot see it yet; the next park checks instead (a viewer
    // still on the parking comp is taken over). Whether it ever reads true
    // here is recipe 77's to record.
    var after = null;
    try { after = app.project.activeItem; } catch (e3) { after = null; }
    if (after && after.id === from.id) res.restored = true;
  } catch (e2) {
    res.note = "comp " + st.fromId + " (\"" + st.fromName + "\") could not be reopened in the viewer (" + __parkMsg(e2) +
      "), so the viewer still shows the AE MCP parking comp — open the comp from the Project panel";
  }
  return __parkEnded(ended, res);
});

// Server-only, a read: is a park in force (or the viewer still on the parking
// comp)? check_setup asks this before it takes any lock to undo one.
OPS._viewer_parked = noUndo(function (args) {
  // A park whose comp a script wrote into is not one to undo (see the recover above).
  if (__PARK) return { parked: !__parkDirt(__parkItem(__PARK.parkId)), compId: __PARK.fromId };
  var a = null;
  try { a = app.project.activeItem; } catch (e) { a = null; }
  return { parked: !!(a && __parkIsParkingComp(a) && __PARK_LAST) };
});
