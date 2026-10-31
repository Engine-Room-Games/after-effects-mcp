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
// changes: the parking comp is one persistent, tagged 16×16 comp in a folder
// named "AE MCP", created the first time it is needed and reused after. A comp
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
var __PARK_FOLDER_NAME = "AE MCP";
var __PARK_COMP_NAME = "AE MCP viewer parking (safe to delete)";
var __PARK_UNDO_NAME = "AE MCP: create viewer parking comp";
// The expression scan stops here and answers "unsure", which parks: a scan
// that cannot finish must not be the reason a heavy comp stays in view.
var __PARK_SCAN_BUDGET_MS = 200;
var __PARK_SCAN_MAX_PROPS = 20000;

// The park in force: {fromId, fromName, parkId, at}. Set by _viewer_park and
// cleared by _viewer_unpark. It lives in the bundle's closure, so it outlives a
// server that died between the two, but not a reload of the bundle.
var __PARK = null;
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

function __parkIsParkingComp(item) {
  if (!item) return false;
  try { if (!(item instanceof CompItem)) return false; } catch (e) { return false; }
  var c;
  try { c = item.comment; } catch (e1) { return false; }
  return typeof c === "string" && c.indexOf(__PARK_TAG) === 0;
}

// The folder the parking comp is filed in, counted as ours only while it holds
// nothing but parking comps — a user's own "AE MCP" folder is never hidden.
function __parkIsParkingFolder(item) {
  try {
    if (!(item instanceof FolderItem) || item.name !== __PARK_FOLDER_NAME) return false;
    if (item.numItems === 0) return false;
    for (var i = 1; i <= item.numItems; i++) if (!__parkIsParkingComp(item.item(i))) return false;
    return true;
  } catch (e) { return false; }
}

// True for the parking comp and its folder: what list_comps,
// get_project_summary and find_layers leave out, and count.
function __parkIsInternalItem(item) {
  return __parkIsParkingComp(item) || __parkIsParkingFolder(item);
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

function __parkCreate() {
  var folder = null;
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof FolderItem && it.name === __PARK_FOLDER_NAME) { folder = it; break; }
  }
  if (!folder) folder = app.project.items.addFolder(__PARK_FOLDER_NAME);
  var c = app.project.items.addComp(__PARK_COMP_NAME, 16, 16, 1, 1, 1);
  c.comment = __PARK_TAG + " — AE MCP shows this empty comp in the viewer while a script runs, so After Effects " +
    "does not re-evaluate your comp's expressions after every change the script makes. Safe to delete; it is made " +
    "again when needed.";
  c.parentFolder = folder;
  __PARK_ID = c.id;
  return c;
}

// The comp in the active composition viewer, or null. The viewer is asked, not
// app.project.activeItem alone: while the Project panel has focus, activeItem
// is its selection. setActive() moves keyboard focus to the viewer; opening a
// comp in it, which is what a park does next, moves it anyway.
function __parkViewerComp() {
  var v = null;
  try { v = app.activeViewer; } catch (e) { v = null; }
  if (!v) return null;
  try { if (v.type !== ViewerType.VIEWER_COMPOSITION) return null; } catch (e1) { return null; }
  var a = null;
  try {
    if (v.setActive() !== false) a = app.project.activeItem;
  } catch (e2) { a = null; }
  return (a && a instanceof CompItem) ? a : null;
}

// The comp a parked viewer replaced, or null.
function __parkedFrom() {
  var st = __PARK;
  return st ? __parkItem(st.fromId) : null;
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
OPS._viewer_park = noUndo(function (args) {
  var out = { parked: false };
  var stale = __PARK;
  var from = __parkViewerComp();
  var alreadyParked = false;
  if (from && __parkIsParkingComp(from)) {
    // An earlier park nobody unparked (a server that died, a script that timed
    // out), or an unpark whose reopen did not take: take its comp over.
    var prior = stale || __PARK_LAST;
    var back = prior ? __parkItem(prior.fromId) : null;
    if (!back) {
      __PARK = null;
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
    __PARK = null;
    out.skipped = "no-comp-in-viewer";
    return out;
  }
  out.compId = from.id;
  out.compName = from.name;
  if (!alreadyParked) {
    var scan = __parkExpressionScan(from);
    if (!scan.found && !scan.unsure) {
      __PARK = null;
      out.skipped = "no-expressions";
      return out;
    }
    if (scan.unsure) out.scan = "unsure";
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
    __PARK = null;
    out.skipped = "failed";
    out.note = "the viewer could not be parked (" + __parkMsg(e) + "), so the script ran with comp " + from.id +
      " in view, re-evaluated after every change";
    return out;
  }
  __PARK = { fromId: from.id, fromName: from.name, parkId: park.id, at: new Date().getTime() };
  out.parked = true;
  return out;
});

// Server-only, sent after the script under the same lease (and by check_setup
// with recover:true). Idempotent: with no park in force it does nothing.
// Answers {unparked, restored, compId, compName, viewerComp?, note?}.
OPS._viewer_unpark = noUndo(function (args) {
  var st = __PARK;
  if (!st) {
    if (!(args && args.recover)) return { unparked: false };
    // A park whose reopen did not take: the viewer still on the parking comp.
    // activeItem only — no focus is moved for a check that is nearly always no.
    var a = null;
    try { a = app.project.activeItem; } catch (e) { a = null; }
    if (!a || !__parkIsParkingComp(a) || !__PARK_LAST) return { unparked: false };
    st = __PARK_LAST;
  }
  __PARK = null;
  __PARK_LAST = st;
  var res = { unparked: true, restored: false, compId: st.fromId, compName: st.fromName };
  var now = __parkViewerComp();
  if (now && !__parkIsParkingComp(now)) {
    // The script put a comp in the viewer itself (openInViewer,
    // OPS.set_active_comp): its choice stands.
    res.viewerComp = { id: now.id, name: now.name };
    if (now.id === st.fromId) res.restored = true;
    else res.note = "the script opened comp " + now.id + " (\"" + now.name + "\") in the viewer, so it was left there " +
      "rather than reopening comp " + st.fromId + " (\"" + st.fromName + "\")";
    return res;
  }
  if (!now) {
    var v = null;
    try { v = app.activeViewer; } catch (e1) { v = null; }
    if (v) {
      res.note = "the active viewer is no longer a composition viewer (the script opened a layer or footage " +
        "viewer?), so comp " + st.fromId + " (\"" + st.fromName + "\") was not reopened";
      return res;
    }
  }
  var from = __parkItem(st.fromId);
  if (!from || !(from instanceof CompItem)) {
    res.note = "comp " + st.fromId + " (\"" + st.fromName + "\") was in the viewer and no longer exists — the script " +
      "removed it — so the viewer still shows the AE MCP parking comp";
    return res;
  }
  try {
    from.openInViewer();
    res.restored = true;
  } catch (e2) {
    res.note = "comp " + st.fromId + " (\"" + st.fromName + "\") could not be reopened in the viewer (" + __parkMsg(e2) +
      "), so the viewer still shows the AE MCP parking comp — open the comp from the Project panel";
  }
  return res;
});
