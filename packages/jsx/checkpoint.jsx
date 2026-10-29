// checkpoint.jsx — checkpoint a comp, and revert it, without the undo stack
// (issue #136).
//
// An agent cannot lean on After Effects' undo across many calls: a group does
// not survive an evalScript boundary, a chunked batch is many steps, and the
// user's own edits interleave with ours (issue #69, docs/fragile-areas-ae.md).
// snapshot_comp / diff_comp tell an agent WHAT changed; this is the way back.
//
// The design, and why (the long form is in docs/subsystems.md, "Comp
// checkpoints"):
//
//   * A checkpoint is CompItem.duplicate() of the comp, filed in one project
//     folder ("AE MCP Checkpoints") and tagged through its `comment` with a
//     small JSON record: which comp it is of, the label, and the comp's layer
//     ids at that moment. The tag, not the name, is what identifies a
//     checkpoint — a user may rename the item; the comment survives.
//
//   * revert_comp restores INTO THE ORIGINAL COMP. It does not swap the
//     checkpoint in. The comp's id is the agent's long-lived handle and every
//     precomp layer elsewhere, every comp("Name") expression and every render
//     queue item points at that item; a swap would change the id and need every
//     one of those re-linked, and the render queue and Essential Graphics
//     links cannot be re-linked from script at all. Restoring contents keeps
//     the id, the name and every usage, at the price of new LAYER ids — which
//     the result maps (`layerIdMap`) from the ids the comp had when the
//     checkpoint was taken.
//
//   * The restore is copy-first: every checkpoint layer is copied in before any
//     current layer is touched, and a failure there removes the copies and
//     leaves the comp exactly as it was. Only once all of them landed, in
//     order, parented and matted, are the old layers removed.
//
//   * copyToComp refuses a parented or expression-linked layer while an undo
//     group is open (issue #30). Each copy is tried inside the group first and,
//     only on that refusal, retried with the group closed, so a revert of an
//     unrigged comp stays one undo step and a rigged one says how many it took.
//
//   * The result is verified, not assumed: both comps are fingerprinted with
//     snapshot.jsx's walk and compared index by index. A mismatch is reported,
//     never smoothed over.

var __CP_FOLDER_NAME = "AE MCP Checkpoints";
var __CP_TAG = "ae-mcp-checkpoint:v1 ";

var __CP_COVERS = "A checkpoint is a shallow copy of one comp: its own layers (with their keyframes, " +
  "expressions, effects, masks, layer markers and switches), its comp settings and its comp markers. It does NOT " +
  "cover the contents of nested precomps, the footage or solid items its layers point at, or anything in other " +
  "comps - an edit made inside a precomp after the checkpoint survives a revert.";

// Comp settings a revert restores, in the order they are written. Size and
// rate before duration, duration before the work area, which must fit inside
// it. resolutionFactor is left alone on purpose: it is a viewer preference,
// and screenshots borrow and restore it themselves.
var __CP_COMP_FIELDS = [
  "width", "height", "pixelAspect", "frameRate", "duration", "displayStartTime",
  "motionBlur", "shutterAngle", "shutterPhase", "motionBlurSamplesPerFrame", "motionBlurAdaptiveSampleLimit",
  "frameBlending", "hideShyLayers", "draft3d", "preserveNestedFrameRate", "preserveNestedResolution",
  "renderer", "dropFrame"
];

// ---------------------------------------------------------------------------
// Identifying checkpoints
// ---------------------------------------------------------------------------

/** The checkpoint record on an item, null when it is not one, {unreadable:true} when the tag is there but the JSON is not. */
function __cpMeta(it) {
  if (!it || !(it instanceof CompItem)) return null;
  var c = null;
  try { c = it.comment; } catch (e) { return null; }
  if (typeof c !== "string" || c.indexOf(__CP_TAG) !== 0) return null;
  try {
    var m = JSON.parse(c.substring(__CP_TAG.length));
    if (!m || typeof m.compId !== "number") return { unreadable: true };
    return m;
  } catch (e2) {
    return { unreadable: true };
  }
}

function __cpIsCheckpoint(it) {
  return __cpMeta(it) !== null;
}

/** Every checkpoint in the project, wherever it has been moved to, as {item, meta}. */
function __cpAll() {
  var out = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    var m = __cpMeta(it);
    if (m) out.push({ item: it, meta: m });
  }
  return out;
}

function __cpFolder(create) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof FolderItem && it.name === __CP_FOLDER_NAME) return it;
  }
  if (!create) return null;
  return app.project.items.addFolder(__CP_FOLDER_NAME);
}

function __cpPad(n) { return n < 10 ? "0" + n : String(n); }

function __cpStamp(ms) {
  var d = new Date(ms);
  return d.getFullYear() + "-" + __cpPad(d.getMonth() + 1) + "-" + __cpPad(d.getDate()) + " " +
    __cpPad(d.getHours()) + ":" + __cpPad(d.getMinutes()) + ":" + __cpPad(d.getSeconds());
}

function __cpSummary(it, m) {
  if (m.unreadable) {
    return { checkpointId: it.id, name: it.name, unreadable: true, numLayers: it.numLayers };
  }
  var origin = __findItem(m.compId);
  var exists = !!(origin && origin instanceof CompItem && !__cpIsCheckpoint(origin));
  var out = {
    checkpointId: it.id,
    compId: m.compId,
    compName: m.compName,
    label: m.label,
    createdAt: m.createdAtText,
    numLayers: it.numLayers
  };
  if (!exists) out.originMissing = true;
  return out;
}

/** A checkpoint by id, or a thrown error naming what the id actually is. */
function __cpResolve(id) {
  var it = __findItem(id);
  if (!it) throw new Error("No project item with id " + id + ". list_checkpoints shows the checkpoints that exist.");
  var m = __cpMeta(it);
  if (!m) {
    throw new Error("Item " + id + " (\"" + it.name + "\") is not a checkpoint. Pass a checkpointId from " +
      "checkpoint_comp or list_checkpoints - not the id of the comp it was taken of.");
  }
  if (m.unreadable) {
    throw new Error("Checkpoint " + id + " (\"" + it.name + "\") has a damaged record in its comment, so the comp it " +
      "belongs to is unknown. duplicate_comp it to recover its contents as an ordinary comp.");
  }
  return { item: it, meta: m };
}

// ---------------------------------------------------------------------------
// Taking one
// ---------------------------------------------------------------------------

function __cpTake(c, label) {
  if (__cpIsCheckpoint(c)) {
    throw new Error("Comp " + c.id + " (\"" + c.name + "\") is itself a checkpoint. Checkpoint the comp it was taken " +
      "of, or duplicate_comp this one to turn it back into an ordinary comp.");
  }
  // Captured as primitives before the duplicate — no handle is trusted across it.
  var compId = c.id;
  var compName = c.name;
  var layerIds = [];
  for (var i = 1; i <= c.numLayers; i++) layerIds.push(c.layer(i).id);

  var seq = 0;
  var all = __cpAll();
  for (var k = 0; k < all.length; k++) {
    var am = all[k].meta;
    if (!am.unreadable && am.compId === compId && typeof am.seq === "number" && am.seq > seq) seq = am.seq;
  }
  seq += 1;
  if (!label) label = "#" + seq;

  var now = new Date().getTime();
  var meta = {
    compId: compId,
    compName: compName,
    label: label,
    seq: seq,
    createdAt: now,
    createdAtText: __cpStamp(now),
    layerIds: layerIds
  };

  var folder = __cpFolder(true);
  var dup = c.duplicate();
  var cpId = dup.id;
  var made = __findItem(cpId);
  if (!made) throw new Error("checkpoint_comp duplicated comp " + compId + " but the copy (id " + cpId + ") could not be read back");
  if (made.numLayers !== layerIds.length) {
    var got = made.numLayers;
    try { made.remove(); } catch (e) {}
    throw new Error("checkpoint_comp: the copy of comp " + compId + " has " + got + " layers where the comp has " +
      layerIds.length + ", so it was discarded rather than kept as a checkpoint that would restore the wrong thing.");
  }
  // The name says what it is in the Project panel and keeps it from ever
  // answering comp("<original name>") in an expression.
  made.name = __dupUniqueName(compName + " [checkpoint " + label + "]");
  made.comment = __CP_TAG + JSON.stringify(meta);
  made.parentFolder = folder;
  return { item: made, meta: meta, folder: folder };
}

OPS.checkpoint_comp = function (args) {
  var c = getCompById(args.compId);
  var t = __cpTake(c, args.label || null);
  var count = 0;
  var all = __cpAll();
  for (var i = 0; i < all.length; i++) {
    if (!all[i].meta.unreadable && all[i].meta.compId === t.meta.compId) count += 1;
  }
  var out = __cpSummary(t.item, t.meta);
  out.name = t.item.name;
  out.folderId = t.folder.id;
  out.folderName = t.folder.name;
  out.checkpointsForThisComp = count;
  out.covers = __CP_COVERS;
  if (count > 10) {
    out.note = count + " checkpoints of this comp are now in the project. Each is a full copy of the comp; " +
      "delete_checkpoints the ones you no longer need.";
  }
  return out;
};

OPS.list_checkpoints = noUndo(function (args) {
  var want = (args && args.compId !== undefined && args.compId !== null) ? args.compId : null;
  var all = __cpAll();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var m = all[i].meta;
    if (want !== null && (m.unreadable || m.compId !== want)) continue;
    out.push(__cpSummary(all[i].item, m));
  }
  out.sort(function (a, b) { return a.checkpointId - b.checkpointId; });
  var folder = __cpFolder(false);
  return { checkpoints: out, count: out.length, folderId: folder ? folder.id : null };
});

// ---------------------------------------------------------------------------
// Deleting them
// ---------------------------------------------------------------------------

OPS.delete_checkpoints = function (args) {
  var targets = [];
  var i;
  if (args.checkpointIds) {
    // Every id is resolved before anything is removed, so a bad id in the list
    // removes nothing rather than half the list.
    for (i = 0; i < args.checkpointIds.length; i++) targets.push(__cpResolveAny(args.checkpointIds[i]));
  } else {
    var all = __cpAll();
    for (i = 0; i < all.length; i++) {
      if (!all[i].meta.unreadable && all[i].meta.compId === args.compId) targets.push(all[i]);
    }
  }
  var removed = [];
  for (i = 0; i < targets.length; i++) {
    var it = targets[i].item;
    var id = it.id;
    var name = it.name;
    try {
      it.remove();
    } catch (e) {
      var msg = "delete_checkpoints failed removing checkpoint " + id + " (\"" + name + "\"): " + e.message + ".";
      if (removed.length > 0) msg += " Already removed: " + __nameList(removed, 20) + ".";
      else msg += " Nothing had been removed yet.";
      throw new Error(msg);
    }
    removed.push({ id: id, name: name });
  }
  var out = { removed: removed, count: removed.length, folderRemoved: false };
  var folder = __cpFolder(false);
  if (folder) {
    var empty = false;
    try { empty = folder.numItems === 0; } catch (e2) { empty = false; }
    if (empty) {
      folder.remove();
      out.folderRemoved = true;
    }
  }
  if (removed.length === 0) out.note = "There were no checkpoints to delete.";
  else {
    out.note = "The solids and footage these checkpoints pointed at were not touched; purge_unused_footage " +
      "removes whatever nothing uses any more.";
  }
  return out;
};

/** Like __cpResolve, but a checkpoint with a damaged record may still be deleted. */
function __cpResolveAny(id) {
  var it = __findItem(id);
  if (!it) throw new Error("No project item with id " + id + ". list_checkpoints shows the checkpoints that exist. Nothing was deleted.");
  var m = __cpMeta(it);
  if (!m) {
    throw new Error("Item " + id + " (\"" + it.name + "\") is not a checkpoint, so delete_checkpoints refuses it. " +
      "Nothing was deleted. Use delete_comp for an ordinary comp.");
  }
  return { item: it, meta: m };
}

// ---------------------------------------------------------------------------
// Reverting
// ---------------------------------------------------------------------------

// What `verified` compared — returned with every revert, because a verdict
// that does not say what it looked at reads as "identical", which it is not.
var __CP_CHECKED = "verified compares, layer by layer at the same index: name, type, in/out/start, enabled, " +
  "parent, keyframe and expression counts on the Transform properties and on Marker, Time Remap, Source Text and Audio Levels only (expressions elsewhere are not counted), the number of effects," +
  "locked, shy, solo, 3D, blend mode, adjustment, motion blur, quality, label, stretch, track matte and type, and " +
  "the layer/mask a Layer Control, Displacement Map, Set Matte or text-path parameter points at; and per comp: size, " +
  "pixel aspect, frame rate, duration, work area, background colour, the other restored settings and markers. It does " +
  "NOT compare keyframe values, other effect parameter values, expression text, mask shapes, shape contents or text.";

// ---------- a mirror of a comp's layer order ----------
// A comp.layer(n) reference is index-bound, not a handle (extendscript-gotchas
// guide), so every layer is re-resolved by id after anything that moves one.
// Scanning the comp for each lookup made a revert O(n^2) DOM reads; the mirror
// keeps the id order in plain JS, updated on every move/insert/remove we make,
// and one comp.layer(i) read confirms each lookup. A mismatch — the comp moved
// under us — falls back to one rescan, so the mirror can be stale but never wrong.

function __cpMirror(comp) {
  var m = { comp: comp, ids: [] };
  __cpRescan(m);
  return m;
}

function __cpRescan(m) {
  m.ids = [];
  for (var i = 1; i <= m.comp.numLayers; i++) m.ids.push(m.comp.layer(i).id);
}

function __cpPos(ids, id) {
  for (var i = 0; i < ids.length; i++) if (ids[i] === id) return i;
  return -1;
}

function __cpGet(m, id) {
  var p = __cpPos(m.ids, id);
  if (p >= 0 && p < m.comp.numLayers) {
    var l = m.comp.layer(p + 1);
    if (l.id === id) return l;
  }
  __cpRescan(m);
  p = __cpPos(m.ids, id);
  return p >= 0 ? m.comp.layer(p + 1) : null;
}

/**
 * After one copyToComp: find the new layer and record it in the mirror. The
 * measured landing rule (first copy on top, each later one directly below the
 * previous copy) is tried first — one read — and a full rescan is the fallback.
 */
function __cpLanded(m, known, prevId) {
  var n = m.comp.numLayers;
  var guesses = [1];
  if (prevId !== null) {
    var pp = __cpPos(m.ids, prevId);
    if (pp >= 0) guesses.push(pp + 2);
  }
  for (var g = 0; g < guesses.length; g++) {
    var at = guesses[g];
    if (at < 1 || at > n || n !== m.ids.length + 1) continue;
    var l = m.comp.layer(at);
    if (!known.hasOwnProperty("L" + l.id)) {
      m.ids.splice(at - 1, 0, l.id);
      return l;
    }
  }
  __cpRescan(m);
  var found = null;
  for (var i = 0; i < m.ids.length; i++) {
    if (known.hasOwnProperty("L" + m.ids[i])) continue;
    if (found) return null; // more than one new layer: we cannot tell which is ours
    found = m.comp.layer(i + 1);
  }
  return found;
}

/**
 * Copy one layer into `target`. Inside the open undo group when AE allows it;
 * when it refuses (a parented or expression-linked layer — issue #30) the copy
 * is retried with the group closed. Returns true when it had to split.
 */
function __cpCopyLayer(src, target) {
  try {
    src.copyToComp(target);
    return false;
  } catch (e) {
    var msg = String((e && e.message) ? e.message : e);
    if (!/undo group/i.test(msg)) throw e;
    withoutUndoGroup(function () { src.copyToComp(target); });
    return true;
  }
}

/**
 * Copy a checkpoint layer with its parent detached for the duration.
 *
 * Measured on 26.5 (issue #136 live pass): copying a PARENTED layer into a comp
 * that holds a layer of its parent's name leaves the copy parented there with
 * its Position keys converted to comp space — the transform applied twice, a
 * visible jump that no fingerprint sees. Detaching the parent first with
 * setParentWithJump() leaves the layer's own values untouched (they are only
 * read in a different space), so the copy carries exactly the checkpoint's
 * local values, and the restored layer is re-parented the same way, also
 * without compensation. The checkpoint's parent is put back in every case;
 * failing to do that would damage the restore point, so it is an error.
 */
function __cpCopyDetached(src, target) {
  var parent = src.parent || null;
  if (!parent) return __cpCopyLayer(src, target);
  var wasLocked = !!src.locked;
  if (wasLocked) src.locked = false;
  src.setParentWithJump();
  var split = false;
  var failure = null;
  try {
    split = __cpCopyLayer(src, target);
  } catch (e) {
    failure = e;
  }
  try {
    src.setParentWithJump(parent);
    if (wasLocked) src.locked = true;
  } catch (e2) {
    throw new Error("could not re-parent checkpoint layer \"" + src.name + "\" to \"" + parent.name + "\" after copying it (" +
      (e2.message || e2) + "); the checkpoint comp now has that layer unparented - re-parent it with parent_layer " +
      "and preserveTransform:false before reverting to it again");
  }
  if (failure) throw failure;
  return split;
}

/** Remove the layers we added. Returns the ids that would not go. */
function __cpRemoveLayers(m, ids) {
  var stuck = [];
  for (var i = ids.length - 1; i >= 0; i--) {
    var l = __cpGet(m, ids[i]);
    if (!l) continue;
    try {
      if (l.locked) l.locked = false;
      l.remove();
      var p = __cpPos(m.ids, ids[i]);
      if (p >= 0) m.ids.splice(p, 1);
    } catch (e) {
      stuck.push(ids[i]);
    }
  }
  return stuck;
}

function __cpSame(a, b) {
  if (a instanceof Array && b instanceof Array) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

// ---------- comp settings ----------

/** The settings a revert restores, read off a comp into a plain object — so the pre-revert state can be put back on failure. */
function __cpReadSettings(c) {
  var s = {};
  for (var i = 0; i < __CP_COMP_FIELDS.length; i++) {
    var f = __CP_COMP_FIELDS[i];
    try { if (c[f] !== undefined) s[f] = c[f]; } catch (e) {}
  }
  try { s.bgColor = [c.bgColor[0], c.bgColor[1], c.bgColor[2]]; } catch (e2) {}
  s.workAreaStart = c.workAreaStart;
  s.workAreaDuration = c.workAreaDuration;
  return s;
}

/** Write a settings object onto a comp. Failures are collected, never thrown. */
function __cpWriteSettings(s, target, notRestored) {
  for (var i = 0; i < __CP_COMP_FIELDS.length; i++) {
    var f = __CP_COMP_FIELDS[i];
    if (!s.hasOwnProperty(f)) continue;
    try {
      if (!__cpSame(target[f], s[f])) target[f] = s[f];
    } catch (e1) {
      notRestored.push({ what: "comp " + f, reason: String(e1.message || e1) });
    }
  }
  if (s.bgColor) {
    try {
      if (!__cpSame(target.bgColor, s.bgColor)) target.bgColor = [s.bgColor[0], s.bgColor[1], s.bgColor[2]];
    } catch (e2) {
      notRestored.push({ what: "comp bgColor", reason: String(e2.message || e2) });
    }
  }
  // The work area has to fit inside the duration at every intermediate step,
  // so whichever order fails first is retried the other way round.
  var ws = s.workAreaStart;
  var wd = s.workAreaDuration;
  if (target.workAreaStart !== ws || target.workAreaDuration !== wd) {
    try {
      target.workAreaStart = ws;
      target.workAreaDuration = wd;
    } catch (e3) {
      try {
        target.workAreaDuration = wd;
        target.workAreaStart = ws;
      } catch (e4) {
        notRestored.push({ what: "comp work area", reason: String(e4.message || e4) });
      }
    }
  }
}

function __cpRestoreMarkers(cp, target, notRestored) {
  var src = null;
  var dst = null;
  try { src = cp.markerProperty; dst = target.markerProperty; } catch (e) { return; }
  if (!src || !dst) return;
  if (__cpSame(__fpCompMarkers(cp), __fpCompMarkers(target))) return;
  try {
    for (var i = dst.numKeys; i >= 1; i--) dst.removeKey(i);
    for (var j = 1; j <= src.numKeys; j++) dst.setValueAtTime(src.keyTime(j), src.keyValue(j));
  } catch (e2) {
    notRestored.push({ what: "comp markers", reason: String(e2.message || e2) });
  }
}

// ---------- layer and mask references ----------
// Layer Control, Displacement Map, Set Matte, Compound Blur and friends pick a
// layer BY INDEX, and a text path picks a mask the same way. The copies land
// while the old layers still exist, so those picks point at the wrong layer —
// and at nothing once the old ones go. After the removal the restored layers
// sit at exactly the checkpoint's indices, so the checkpoint's value is the
// right value, and it is copied across. Measured on 26.5: a bare copyToComp
// leaves both a Layer Control and a Displacement Map pick at 0 ("None").

var __CP_REF_GROUPS = ["ADBE Effect Parade", "ADBE Text Properties"];

function __cpIsRefProp(p) {
  if (typeof PropertyValueType === "undefined") return false;
  var vt = null;
  try { vt = p.propertyValueType; } catch (e) { return false; }
  return vt === PropertyValueType.LAYER_INDEX || vt === PropertyValueType.MASK_INDEX;
}

function __cpIsLeaf(p) {
  try { return p.propertyType === PropertyType.PROPERTY; } catch (e) { return false; }
}

/** Calls fn(srcProp, dstProp, path) for every layer/mask reference under the two layers, walked in parallel. */
function __cpWalkRefs(srcLayer, dstLayer, fn) {
  for (var g = 0; g < __CP_REF_GROUPS.length; g++) {
    var sg = null;
    var dg = null;
    try { sg = srcLayer.property(__CP_REF_GROUPS[g]); } catch (e) { sg = null; }
    if (!sg) continue;
    if (dstLayer) { try { dg = dstLayer.property(__CP_REF_GROUPS[g]); } catch (e2) { dg = null; } }
    __cpWalkGroup(sg, dg, sg.name, fn, 0);
  }
}

function __cpWalkGroup(sg, dg, path, fn, depth) {
  if (depth > 16) return;
  var n = 0;
  try { n = sg.numProperties; } catch (e) { return; }
  for (var i = 1; i <= n; i++) {
    var sp = sg.property(i);
    if (!sp) continue;
    var dp = null;
    if (dg) { try { dp = dg.property(i); } catch (e2) { dp = null; } }
    var here = path + " > " + sp.name;
    if (__cpIsLeaf(sp)) {
      if (__cpIsRefProp(sp)) fn(sp, dp, here);
    } else {
      __cpWalkGroup(sp, dp, here, fn, depth + 1);
    }
  }
}

/** A comparable string for one reference property: its value, or every key. */
function __cpRefValue(p) {
  var n = 0;
  try { n = p.numKeys; } catch (e) { n = 0; }
  if (!n) return String(p.value);
  var parts = [];
  for (var k = 1; k <= n; k++) parts.push(__fpRound(p.keyTime(k)) + "=" + String(p.keyValue(k)));
  return parts.join(",");
}

function __cpRestoreRefs(cpComp, m, copies, notRestored) {
  var fixed = 0;
  for (var i = 1; i <= copies.length; i++) {
    var src = cpComp.layer(i);
    var dst = __cpGet(m, copies[i - 1]);
    __cpWalkRefs(src, dst, function (sp, dp, path) {
      try {
        if (!dp) throw new Error("the restored layer has no matching property");
        if (__cpRefValue(sp) === __cpRefValue(dp)) return;
        // A Layer Control pick cannot vary over time on 26.5 (canVaryOverTime
        // false, measured), so a keyframed pick is not a case worth code; if
        // one ever appears it is named rather than half-restored.
        if (sp.numKeys > 0) throw new Error("a keyframed layer/mask pick is not restored");
        __setValue(dp, sp.value);
        fixed += 1;
      } catch (e) {
        notRestored.push({ what: "layer " + i + " (\"" + src.name + "\") " + path, reason: String(e.message || e) });
      }
    });
  }
  return fixed;
}

// ---------- verification ----------

var __CP_LAYER_FLAGS = ["locked", "shy", "solo", "threeDLayer", "blendingMode", "adjustmentLayer", "motionBlur",
  "quality", "label", "stretch"];

/** What the fingerprint does not record but a revert must get right: switches, mattes and layer references. */
function __cpLayerExtras(l) {
  var out = {};
  for (var i = 0; i < __CP_LAYER_FLAGS.length; i++) {
    var f = __CP_LAYER_FLAGS[i];
    try { out[f] = l[f]; } catch (e) { out[f] = null; }
  }
  var mt = null;
  try { mt = l.trackMatteLayer; } catch (e2) { mt = null; }
  out.matteIndex = mt ? mt.index : null;
  try { out.matteType = l.trackMatteType; } catch (e3) { out.matteType = null; }
  var refs = [];
  __cpWalkRefs(l, null, function (sp, dp, path) { refs.push(path + "=" + __cpRefValue(sp)); });
  out.refs = refs.join(";");
  return out;
}

/** Fingerprints with parent ids rewritten as parent indices, so two comps can be compared position by position. */
function __cpComparable(fp) {
  var idx = {};
  var i;
  for (i = 0; i < fp.layers.length; i++) idx["L" + fp.layers[i].id] = fp.layers[i].index;
  for (i = 0; i < fp.layers.length; i++) {
    var l = fp.layers[i];
    l.parentId = (l.parentId === null || l.parentId === undefined) ? null : (idx["L" + l.parentId] || -1);
    l.id = 0;
  }
  return fp;
}

function __cpVerify(cpComp, target) {
  var a = __cpComparable(__compFingerprint(cpComp.id));
  var b = __cpComparable(__compFingerprint(target.id));
  var mismatches = [];
  if (a.layers.length !== b.layers.length) {
    mismatches.push({ what: "layer count", checkpoint: a.layers.length, comp: b.layers.length });
  }
  var n = Math.min(a.layers.length, b.layers.length);
  for (var i = 0; i < n; i++) {
    var d = __diffLayer(a.layers[i], b.layers[i]);
    var changes = d ? d.changes : {};
    var any = !!d;
    var ea = __cpLayerExtras(cpComp.layer(i + 1));
    var eb = __cpLayerExtras(target.layer(i + 1));
    for (var k in ea) {
      if (!ea.hasOwnProperty(k)) continue;
      if (ea[k] !== eb[k]) { changes[k] = { from: ea[k], to: eb[k] }; any = true; }
    }
    if (any) mismatches.push({ index: i + 1, name: b.layers[i].name, changes: changes });
  }
  b.name = a.name;
  var cf = __diffCompFields(a, b) || {};
  var cany = false;
  for (var ck in cf) if (cf.hasOwnProperty(ck)) cany = true;
  var sa = __cpReadSettings(cpComp);
  var sb = __cpReadSettings(target);
  for (var f in sa) {
    if (!sa.hasOwnProperty(f) || cf.hasOwnProperty(f)) continue;
    if (!__cpSame(sa[f], sb[f]) && __diffMoved(sa[f], sb[f])) { cf[f] = { from: sa[f], to: sb[f] }; cany = true; }
  }
  if (cany) mismatches.push({ what: "comp", changes: cf });
  return mismatches;
}

// ---------- the op ----------

OPS.revert_comp = function (args) {
  var cp = __cpResolve(args.checkpointId);
  var meta = cp.meta;
  var cpComp = cp.item;
  var cpId = cpComp.id;
  var explicit = (args.compId !== undefined && args.compId !== null);
  var targetId = explicit ? args.compId : meta.compId;
  var target = __findItem(targetId);
  // A different compId is the same comp under a new id — which is what an
  // imported project gives every item — or a mistake. The name is the evidence
  // that tells them apart; with it, the checkpoint is re-bound to the new id.
  var rebind = explicit && args.compId !== meta.compId;
  if (rebind) {
    if (!target || !(target instanceof CompItem) || __cpIsCheckpoint(target)) {
      throw new Error("No comp with id " + args.compId + " to revert into (checkpoint " + cpId + " was taken of comp " +
        meta.compId + ", \"" + meta.compName + "\"). Nothing was changed.");
    }
    if (target.name !== meta.compName) {
      throw new Error("Checkpoint " + cpId + " was taken of comp " + meta.compId + " (\"" + meta.compName + "\"), and " +
        "comp " + args.compId + " is \"" + target.name + "\". A checkpoint only reverts the comp it was taken of; a " +
        "different compId is accepted for that same comp under a new id (after importing its project), recognised by " +
        "its name. If comp " + args.compId + " is that comp, set_comp it to \"" + meta.compName + "\" first. Nothing was changed.");
    }
    // A name match is evidence only when the recorded comp cannot be the
    // answer. AE allows two comps called "Main"; while the recorded one still
    // exists under its recorded name, another "Main" is a different comp, and
    // reverting it would overwrite unrelated work.
    var recorded = __findItem(meta.compId);
    if (recorded && recorded instanceof CompItem && !__cpIsCheckpoint(recorded) && recorded.name === meta.compName) {
      throw new Error("Checkpoint " + cpId + " belongs to comp " + meta.compId + " (\"" + meta.compName + "\"), which " +
        "still exists. Comp " + args.compId + " only shares its name. Omit compId (or pass " + meta.compId + ") to " +
        "revert the comp the checkpoint was taken of. Nothing was changed.");
    }
  }
  if (!target || !(target instanceof CompItem) || __cpIsCheckpoint(target)) {
    throw new Error("Checkpoint " + cpId + " was taken of comp " + targetId + " (\"" + meta.compName + "\"), which no " +
      "longer exists, so there is nothing to revert into. duplicate_comp the checkpoint to get its contents back as " +
      "an ordinary comp (it gets a new id). Nothing was changed.");
  }
  // The record holds an item id, and ids are only unique within one project:
  // a checkpoint that arrived by importing another .aep can name an id that
  // here belongs to an unrelated comp. A name that still matches is the
  // cheap evidence it is the same comp; without it the caller has to say so.
  if (!explicit && target.name !== meta.compName) {
    throw new Error("Checkpoint " + cpId + " was taken of a comp named \"" + meta.compName + "\" (id " + targetId +
      "), but comp " + targetId + " is now named \"" + target.name + "\". It may have been renamed, or the checkpoint " +
      "came from another project whose ids collide with this one. If comp " + targetId + " really is the one to " +
      "revert, pass compId: " + targetId + " to confirm. Nothing was changed.");
  }

  var n = cpComp.numLayers;
  if (n > 0 && typeof cpComp.layer(1).setParentWithJump !== "function") {
    throw new Error("revert_comp needs Layer.setParentWithJump, which this After Effects does not have. Nothing was changed.");
  }

  var out = {};
  if (args.saveCurrent) {
    var saved = __cpTake(target, "before revert to " + meta.label);
    out.savedCheckpoint = __cpSummary(saved.item, saved.meta);
  }

  var m = __cpMirror(target);
  var oldIds = m.ids.slice(0);
  var known = {};
  var i;
  for (i = 0; i < oldIds.length; i++) known["L" + oldIds[i]] = true;

  // Comp settings go first: a layer copied into a comp of the wrong length or
  // rate is copied against the wrong timeline. The pre-revert settings are kept
  // so a failed copy can put them back along with removing the copies.
  var notRestored = [];
  var before = __cpReadSettings(target);
  __cpWriteSettings(__cpReadSettings(cpComp), target, notRestored);

  var copies = [];
  var splits = 0;
  var stage = "copying";
  var at = 0;
  var wantLocked = [];
  try {
    // 1. Copy every checkpoint layer in, before anything existing is touched.
    var prev = null;
    for (i = 1; i <= n; i++) {
      at = i;
      if (__cpCopyDetached(cpComp.layer(i), target)) splits += 1;
      var fresh = __cpLanded(m, known, prev);
      if (!fresh) throw new Error("the copy of layer " + i + " could not be told apart from the comp's other layers");
      known["L" + fresh.id] = true;
      copies.push(fresh.id);
      prev = fresh.id;
    }

    // 2. Order and parenting, from the checkpoint.
    stage = "arranging";
    for (i = 0; i < n; i++) {
      var c0 = __cpGet(m, copies[i]);
      wantLocked.push(!!c0.locked);
      if (c0.locked) c0.locked = false;
    }
    for (i = n - 1; i >= 0; i--) {
      at = i + 1;
      __cpGet(m, copies[i]).moveToBeginning();
      var mp = __cpPos(m.ids, copies[i]);
      if (mp >= 0) m.ids.splice(mp, 1);
      m.ids.unshift(copies[i]);
    }
    // From here the copies are layers 1..n in checkpoint order, and nothing
    // below moves a layer until the removal, so index reads are direct.
    for (i = 1; i <= n; i++) {
      at = i;
      var src = cpComp.layer(i);
      var dst = target.layer(i);
      if (dst.id !== copies[i - 1]) throw new Error("layer " + i + " is not the copy it should be after reordering");
      var wantParent = src.parent ? target.layer(src.parent.index) : null;
      var curParentId = dst.parent ? dst.parent.id : null;
      var wantParentId = wantParent ? wantParent.id : null;
      // With the jump: the copy already holds the parent-relative values the
      // checkpoint had, and plain `parent =` would compensate them away.
      if (curParentId !== wantParentId) {
        if (wantParent) dst.setParentWithJump(wantParent);
        else dst.setParentWithJump();
      }
    }
  } catch (e) {
    var stuck = __cpRemoveLayers(m, copies);
    var back = [];
    __cpWriteSettings(before, target, back);
    var what = "";
    if (at > 0 && at <= n) what = " at layer " + at + " (\"" + cpComp.layer(at).name + "\")";
    var msg = "revert_comp failed while " + stage + what + ": " + (e.message || e) + ".";
    if (stuck.length === 0 && back.length === 0) {
      msg += " The " + copies.length + " layer(s) it had copied in were removed again and the comp settings put " +
        "back, so comp " + targetId + " is as it was before the call.";
    } else {
      if (stuck.length > 0) {
        msg += " It could not remove every layer it had copied in: ids " + stuck.join(", ") + " are still in comp " +
          targetId + " beside the original layers. delete_layer them.";
      }
      if (back.length > 0) {
        msg += " It could not put back these comp settings: " + back.length + " (first: " + back[0].what + "); read get_comp.";
      }
    }
    if (out.savedCheckpoint) msg += " The saveCurrent checkpoint " + out.savedCheckpoint.checkpointId + " was taken and still exists.";
    throw new Error(msg);
  }

  // 3. Track mattes, while the copies are still layers 1..n. Done before the
  //    old layers go so a copy AE linked to an old matte is re-pointed first.
  //    A failure is reported, not thrown: the layers are in, and a named gap
  //    serves the agent better than an error over a half-finished revert.
  for (i = 1; i <= n; i++) {
    var s = cpComp.layer(i);
    var mt = null;
    try { mt = s.trackMatteLayer; } catch (em) { mt = null; }
    if (!mt) continue;
    try {
      var d = target.layer(i);
      var wantM = target.layer(mt.index);
      var curM = null;
      try { curM = d.trackMatteLayer; } catch (em2) { curM = null; }
      if (!curM || curM.id !== wantM.id) d.setTrackMatte(wantM, s.trackMatteType);
    } catch (em3) {
      notRestored.push({ what: "track matte of layer " + i + " (\"" + s.name + "\")", reason: String(em3.message || em3) });
    }
  }

  // 4. Remove what the comp held before: the old layers are n+1.. now, so the
  //    bottom of the stack is removed first and no removal shifts one still to go.
  for (i = oldIds.length - 1; i >= 0; i--) {
    var gone = __cpGet(m, oldIds[i]);
    if (!gone) continue;
    try {
      if (gone.locked) gone.locked = false;
      gone.remove();
      var gp = __cpPos(m.ids, oldIds[i]);
      if (gp >= 0) m.ids.splice(gp, 1);
    } catch (er) {
      var left = [];
      for (var j = 0; j <= i; j++) if (__cpGet(m, oldIds[j])) left.push(oldIds[j]);
      throw new Error("revert_comp copied all " + n + " checkpoint layers into comp " + targetId + " (ids " +
        copies.join(", ") + ", on top) but failed removing the comp's previous layer " + oldIds[i] + ": " +
        (er.message || er) + ". Previous layers still present: ids " + left.join(", ") + ". delete_layer them, " +
        "or call revert_comp again - it is safe to repeat. Effect layer references (Layer Control, Displacement " +
        "Map, Set Matte) are not re-pointed until the previous layers are gone.");
    }
  }

  // 5. Names. copyToComp appends " 2" to an explicitly named layer when the
  //    destination already holds that name (measured, 26.5), and the old
  //    layers were all still there during the copy. Layers named after their
  //    source keep their names and are not touched, so they stay unnamed.
  for (i = 1; i <= n; i++) {
    var sn = cpComp.layer(i);
    var dn = target.layer(i);
    if (dn.name === sn.name) continue;
    try { dn.name = sn.name; }
    catch (enm) { notRestored.push({ what: "name of layer " + i + " (\"" + sn.name + "\")", reason: String(enm.message || enm) }); }
  }

  // 6. Layer and mask references, now that the indices are the checkpoint's.
  var refsFixed = __cpRestoreRefs(cpComp, m, copies, notRestored);

  // 7. Re-lock what the checkpoint had locked.
  for (i = 0; i < n; i++) {
    if (!wantLocked[i]) continue;
    try { __cpGet(m, copies[i]).locked = true; }
    catch (el) { notRestored.push({ what: "lock on layer " + (i + 1), reason: String(el.message || el) }); }
  }

  // 8. Comp markers.
  __cpRestoreMarkers(cpComp, target, notRestored);

  // 9. Check it.
  var mismatches = __cpVerify(cpComp, target);

  var layerIdMap = {};
  var mapped = meta.layerIds && meta.layerIds.length === n;
  if (mapped) {
    for (i = 0; i < n; i++) layerIdMap[String(meta.layerIds[i])] = copies[i];
  }

  // Re-tie the checkpoint to the new id only after a clean revert: a revert
  // that did not verify is no evidence the comp is the one it was taken of.
  var clean = mismatches.length === 0 && notRestored.length === 0;
  if (rebind && clean) {
    try {
      var rmeta = __cpMeta(cpComp);
      rmeta.compId = targetId;
      cpComp.comment = __CP_TAG + JSON.stringify(rmeta);
      out.checkpointRebound = true;
    } catch (erb) {
      notRestored.push({ what: "re-binding the checkpoint to comp " + targetId, reason: String(erb.message || erb) });
    }
  } else if (rebind) {
    out.checkpointRebound = false;
  }

  var made = __findItem(targetId);
  out.compId = targetId;
  out.name = made.name;
  out.checkpointId = cpId;
  out.label = meta.label;
  out.layersRestored = n;
  out.layersRemoved = oldIds.length;
  out.layerIds = copies;
  if (mapped) out.layerIdMap = layerIdMap;
  if (refsFixed > 0) out.layerReferencesRepointed = refsFixed;
  out.verified = mismatches.length === 0 && notRestored.length === 0;
  out.checked = __CP_CHECKED;
  if (mismatches.length > 0) out.mismatches = mismatches;
  if (notRestored.length > 0) out.notRestored = notRestored;
  if (made.name !== meta.compName) {
    out.nameAtCheckpoint = meta.compName;
  }

  var notes = [];
  notes.push("Comp " + targetId + " keeps its id; every layer id it held before this call is gone. " +
    (mapped ? "layerIdMap maps the ids the comp had when the checkpoint was taken to the restored ones."
            : "The checkpoint's layer count no longer matches its record, so no id map is given; read the comp back with list_layers."));
  if (!out.verified) {
    notes.unshift("NOT a clean revert: " + mismatches.length + " layer(s)/comp differ from the checkpoint in the " +
      "fields compared and " + notRestored.length + " item(s) could not be restored - see mismatches/notRestored.");
  } else {
    notes.push("verified:true covers the fields listed in `checked`, not keyframe or effect values.");
  }
  if (out.checkpointRebound === false) {
    notes.push("The checkpoint still records comp " + meta.compId + ": it is re-tied to comp " + targetId +
      " only after a clean revert.");
  }
  if (out.checkpointRebound) {
    notes.push("The checkpoint now belongs to comp " + targetId + " (it recorded another id, as a checkpoint " +
      "imported with its project does); later reverts need no compId. layerIdMap keys are the layer ids from " +
      "the project the checkpoint was taken in.");
  }
  if (out.nameAtCheckpoint) {
    notes.push("The comp's name was left as it is now; it was \"" + meta.compName + "\" at the checkpoint. set_comp renames it.");
  }
  if (splits > 0) {
    out.undoSplits = splits;
    notes.push("After Effects refused to copy " + splits + " parented or expression-linked layer(s) inside an undo " +
      "group, so this revert is spread over several undo steps. Do not try to Cmd-Z it; revert to another checkpoint instead.");
  }

  var keep = args.keepCheckpoint !== false;
  if (!keep && out.verified) {
    try {
      __findItem(cpId).remove();
      out.checkpointDeleted = true;
    } catch (ed) {
      out.checkpointDeleted = false;
      notes.push("keepCheckpoint:false, but the checkpoint could not be removed: " + (ed.message || ed) + ".");
    }
  } else if (!keep) {
    out.checkpointDeleted = false;
    notes.push("The checkpoint was kept despite keepCheckpoint:false, because the revert did not verify clean.");
  }
  out.covers = __CP_COVERS;
  out.note = notes.join(" ");
  return out;
};
