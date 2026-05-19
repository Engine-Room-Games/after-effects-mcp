// ids.jsx — stable ID lookup helpers. (compId, layerId) is the canonical pair.

function getCompById(id) {
  if (id === null || id === undefined) throw new Error("compId required");
  var item = app.project.itemByID(id);
  if (!item) throw new Error("No comp with id " + id);
  if (!(item instanceof CompItem)) throw new Error("Item " + id + " is not a CompItem");
  return item;
}

function getItemById(id) {
  if (id === null || id === undefined) throw new Error("itemId required");
  var item = app.project.itemByID(id);
  if (!item) throw new Error("No item with id " + id);
  return item;
}

function getLayerById(comp, layerId) {
  if (!(comp instanceof CompItem)) throw new Error("Expected CompItem");
  if (layerId === null || layerId === undefined) throw new Error("layerId required");
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    if (l.id === layerId) return l;
  }
  throw new Error("No layer with id " + layerId + " in comp " + comp.id);
}

// Walk a propertyPath into a layer/group, e.g. ["Transform","Position"] or ["Effects","Gaussian Blur","Blurriness"].
// Supports numeric indices (1-based) and string names. Returns the Property/PropertyGroup.
function walkProperty(root, path) {
  if (!path || !path.length) throw new Error("Empty propertyPath");
  var cur = root;
  for (var i = 0; i < path.length; i++) {
    var seg = path[i];
    try { cur = cur.property(seg); }
    catch (e) { throw new Error("Property path segment failed at [" + i + "]=" + String(seg) + ": " + e.message); }
    if (!cur) throw new Error("Property path segment returned null at [" + i + "]=" + String(seg));
  }
  return cur;
}

function colorOrDefault(c, fallback) {
  if (!c) return fallback;
  return [Number(c[0]), Number(c[1]), Number(c[2])];
}
