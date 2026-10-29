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

OPS.get_selection = noUndo(function (args) {
  var active = null;
  try { active = app.project.activeItem; } catch (e) { active = null; }
  if (!active || !(active instanceof CompItem)) {
    return {
      comp: null,
      time: null,
      selectedLayers: [],
      selectedProperties: [],
      reason: active
        ? "The active item is '" + active.name + "' (id " + active.id + "), which is not a composition — there is no comp selection to read. Ask the user to open the comp in the viewer, or pass a compId to the tool you meant to call."
        : "No composition is active in After Effects — nothing is open in the viewer, so there is no selection to read. Ask the user which comp they mean, or open one with set_active_comp."
    };
  }
  var c = active;
  var fr = c.frameRate;
  var out = {
    comp: { id: c.id, name: c.name },
    time: c.time,
    frame: Math.round(c.time * fr),
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
