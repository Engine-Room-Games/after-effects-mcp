// ids.jsx — stable ID lookup helpers. (compId, layerId) is the canonical pair.

// The project item with this id, or null. Measured on AE 26.5: itemByID of an
// id that no longer exists THROWS "internal verification failure, sorry!
// {Item Not Found}" rather than returning null, so every "is it still there"
// check has to go through here or it surfaces as that internal error.
function __findItem(id) {
  try { return app.project.itemByID(id) || null; } catch (e) { return null; }
}

function getCompById(id) {
  if (id === null || id === undefined) throw new Error("compId required");
  var item = __findItem(id);
  if (!item) throw new Error("No comp with id " + id);
  if (!(item instanceof CompItem)) throw new Error("Item " + id + " is not a CompItem");
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
//
// A miss names the segment, where it was looked for, and what IS there (issue
// #170): the children of the group the segment was looked up in, name and
// matchName, capped at __PATH_CHILD_CAP with the remainder counted — so the
// agent can correct the path from the error instead of guessing again. A
// segment asked of a leaf property says the path went one step too far.
var __PATH_CHILD_CAP = 30;

function __pathLabel(path, upTo) {
  var parts = [];
  for (var i = 0; i < upTo && i < path.length; i++) parts.push(JSON.stringify(path[i]));
  return "[" + parts.join(", ") + "]";
}

// "'Anchor Point' = ADBE Anchor Point; ...", at most `cap` of them, and how
// many were left out. "" for a group with no children; null when the count
// cannot be read at all, so a caller says nothing rather than "no children".
function __childListing(group, cap) {
  var n;
  try { n = group.numProperties; } catch (e) { return null; }
  if (typeof n !== "number") return null;
  if (n === 0) return "";
  var shown = [];
  for (var i = 1; i <= n && shown.length < cap; i++) {
    try {
      var c = group.property(i);
      shown.push("'" + c.name + "' = " + c.matchName);
    } catch (e2) {
      shown.push("#" + i + " (unreadable)");
    }
  }
  var out = shown.join("; ");
  if (n > shown.length) out += "; ... and " + (n - shown.length) + " more not listed";
  return out;
}

function __pathMissMessage(parent, path, i, cause) {
  var seg = path[i];
  var where = i === 0 ? "the layer" : __pathLabel(path, i);
  var parentName = "";
  try { parentName = " ('" + parent.name + "', " + parent.matchName + ")"; } catch (e) { parentName = ""; }
  var isLeaf = false;
  try { isLeaf = parent.propertyType === PropertyType.PROPERTY; } catch (e2) { isLeaf = false; }
  var msg = "Property path " + __pathLabel(path, path.length) + ": no " + JSON.stringify(seg) + " (segment " + i + ") under " + where + parentName + ".";
  if (isLeaf) {
    return msg + " That is a property with no children; the path ends there, so drop the segments after it.";
  }
  var kids = __childListing(parent, __PATH_CHILD_CAP);
  if (kids) {
    msg += " Its children (name = matchName): " + kids + ".";
    if (typeof seg === "number") msg += " A number is a 1-based index into that list.";
  } else if (kids === "") {
    msg += " It has no children.";
  }
  if (cause) msg += " (After Effects: " + cause + ")";
  return msg;
}

function walkProperty(root, path) {
  if (!path || !path.length) throw new Error("Empty propertyPath");
  var cur = root;
  for (var i = 0; i < path.length; i++) {
    var seg = path[i];
    var next = null;
    var cause = "";
    try { next = cur.property(seg); }
    catch (e) { next = null; cause = (e && e.message) ? e.message : String(e); }
    if (!next) throw new Error(__pathMissMessage(cur, path, i, cause));
    cur = next;
  }
  return cur;
}
