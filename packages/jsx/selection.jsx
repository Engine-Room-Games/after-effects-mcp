// selection.jsx — get_selection: what the user has selected in the active comp
// (issue #179). The one read that answers "this layer" / "these keyframes"
// without asking the user to name anything.

// Caps on what one answer carries. A select-all in a big comp is hundreds of
// layers and thousands of properties, and every tool result is re-sent on every
// later request; past the cap the count of what was left out is reported, never
// silently dropped.
var __SEL_MAX_LAYERS = 200;
var __SEL_MAX_PROPS = 100;
var __SEL_MAX_KEYS = 50;

// A path walkProperty(layer, path) resolves back to exactly this property.
// Names are used where they are unambiguous — they are what an agent reads and
// what every other tool takes — and a sibling's propertyIndex where an earlier
// sibling carries the same name (two shape groups both called "Group 1"), since
// property(name) answers the first match.
function __selPropertyPath(prop) {
  var depth = prop.propertyDepth;
  var chain = [prop];
  for (var up = 1; up < depth; up++) chain.push(prop.propertyGroup(up));
  var path = [];
  for (var i = chain.length - 1; i >= 0; i--) {
    var p = chain[i];
    var parent = (i === chain.length - 1) ? prop.propertyGroup(depth) : chain[i + 1];
    var seg = p.name;
    try {
      var hit = parent.property(p.name);
      if (!hit || hit.propertyIndex !== p.propertyIndex) seg = p.propertyIndex;
    } catch (e) {
      seg = p.propertyIndex;
    }
    path.push(seg);
  }
  return path;
}

function __selDisplayStartFrame(c) {
  var f = null;
  try { f = c.displayStartFrame; } catch (e) { f = null; }
  if (typeof f === "number" && isFinite(f)) return f;
  var t = 0;
  try { t = c.displayStartTime || 0; } catch (e2) { t = 0; }
  return Math.round(t * c.frameRate);
}

function __selProperty(prop) {
  var layer = prop.propertyGroup(prop.propertyDepth);
  var isGroup = prop.propertyType !== PropertyType.PROPERTY;
  var out = {
    layerId: layer.id,
    layerName: layer.name,
    propertyPath: __selPropertyPath(prop),
    name: prop.name,
    matchName: prop.matchName,
    kind: isGroup ? "group" : "property",
  };
  if (!isGroup) {
    var keys = null;
    try { keys = prop.selectedKeys; } catch (e) { keys = null; }
    if (keys && keys.length) {
      var times = [];
      var n = keys.length < __SEL_MAX_KEYS ? keys.length : __SEL_MAX_KEYS;
      for (var k = 0; k < n; k++) times.push(prop.keyTime(keys[k]));
      out.selectedKeyTimes = times;
      if (keys.length > n) out.selectedKeysOmitted = keys.length - n;
    }
  }
  return out;
}

// Which comp the user is looking at: app.project.activeItem, used as it is
// when it is a comp (`source: "activeItem"`). When it is not (the Project
// panel has focus on footage, a folder, or nothing), the composition viewer's
// comp could only be read by focusing the viewer with setActive(), which takes
// the user's keyboard focus — so it is not read, and the answer says why it
// does not know. Every way of not knowing is said as such.
function __selProjectSelectionCount() {
  try { return app.project.selection ? app.project.selection.length : 0; } catch (e) { return 0; }
}

function __selResolveComp() {
  var before = null;
  try { before = app.project.activeItem; } catch (e) { before = null; }
  if (before && before instanceof CompItem) return { comp: before, source: "activeItem" };

  var viewer = null;
  try { viewer = app.activeViewer; } catch (e) { viewer = null; }
  var viewerNote;
  if (viewer) {
    var isComp = false;
    try { isComp = viewer.type === ViewerType.VIEWER_COMPOSITION; } catch (e) { isComp = false; }
    if (isComp) {
      // Which comp it shows is not readable without viewer.setActive(), which
      // moves the user's keyboard focus to the viewer. A read must not take the
      // user's focus, so this says it does not know instead.
      viewerNote = "a composition viewer is open, but which comp it shows cannot be read without moving the user's keyboard focus to it, which this tool does not do";
    } else {
      viewerNote = "the active viewer is a layer or footage viewer, not a composition viewer";
    }
  } else {
    viewerNote = "no viewer is open";
  }
  var why = "Could not determine the comp in the viewer (" + viewerNote + ")";
  if (before) {
    why += "; the active item is '" + before.name + "' (id " + before.id + "), which is not a composition";
  } else {
    var n = __selProjectSelectionCount();
    why += n > 0
      ? "; the Project panel has focus with " + n + " item" + (n === 1 ? "" : "s") + " selected and none of them is an active comp"
      : "; there is no active item either";
  }
  why += ". Ask the user which comp they mean (or to click in its timeline), or pass a compId to the tool you meant to call.";
  return { comp: null, reason: why };
}

OPS.get_selection = noUndo(function (args) {
  var found = __selResolveComp();
  if (!found.comp) {
    return { comp: null, time: null, selectedLayers: [], selectedProperties: [], reason: found.reason };
  }
  var active = found.comp;
  var c = active;
  var fr = c.frameRate;
  var out = {
    comp: { id: c.id, name: c.name },
    // Always "activeItem" now that the viewer is never focused to ask it; kept
    // so a caller reading it keeps working.
    source: found.source,
    time: c.time,
    // As the timeline shows it: AE numbers frames from displayStartFrame
    // (Composition Settings > Start Frame), not from 0. `time` stays on the
    // keyframe clock, which always starts at 0.
    frame: __selDisplayStartFrame(c) + Math.round(c.time * fr),
    selectedLayers: [],
    selectedProperties: [],
  };

  var layers = c.selectedLayers || [];
  var nl = layers.length < __SEL_MAX_LAYERS ? layers.length : __SEL_MAX_LAYERS;
  for (var i = 0; i < nl; i++) {
    var l = layers[i];
    out.selectedLayers.push({ id: l.id, index: l.index, name: l.name });
  }

  var props = c.selectedProperties || [];
  var np = props.length < __SEL_MAX_PROPS ? props.length : __SEL_MAX_PROPS;
  for (var j = 0; j < np; j++) out.selectedProperties.push(__selProperty(props[j]));

  if (layers.length > nl || props.length > np) {
    out.omitted = {};
    if (layers.length > nl) out.omitted.selectedLayers = layers.length - nl;
    if (props.length > np) out.omitted.selectedProperties = props.length - np;
    out.note = "The selection is larger than one answer carries; the first " + nl + " layers and " + np +
      " properties are listed and `omitted` counts the rest.";
  }
  if (__cpIsCheckpoint(c)) {
    out.checkpoint = true;
    out.warning = "The active comp is a checkpoint (a restore point made by checkpoint_comp), not the user's scene — do not edit its layers.";
  }
  return out;
});
