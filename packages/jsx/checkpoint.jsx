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
  var origin = app.project.itemByID(m.compId);
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
  var it = app.project.itemByID(id);
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
  var made = app.project.itemByID(cpId);
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
  var it = app.project.itemByID(id);
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

function __cpLayerById(comp, id) {
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    if (l.id === id) return l;
  }
  return null;
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

/** The one layer in `comp` whose id is not in `known`. */
function __cpNewLayer(comp, known) {
  var found = null;
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    if (known.hasOwnProperty("L" + l.id)) continue;
    if (found) return null; // more than one: we cannot tell which is ours
    found = l;
  }
  return found;
}

/** Remove the layers we added. Returns the ids that would not go. */
function __cpRemoveLayers(comp, ids) {
  var stuck = [];
  for (var i = ids.length - 1; i >= 0; i--) {
    var l = __cpLayerById(comp, ids[i]);
    if (!l) continue;
    try {
      if (l.locked) l.locked = false;
      l.remove();
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

/** Comp settings, then the work area, then markers. Failures are collected, never thrown. */
function __cpRestoreComp(cp, target, notRestored) {
  var i;
  for (i = 0; i < __CP_COMP_FIELDS.length; i++) {
    var f = __CP_COMP_FIELDS[i];
    var want;
    try { want = cp[f]; } catch (e0) { continue; }
    if (want === undefined) continue;
    try {
      if (!__cpSame(target[f], want)) target[f] = want;
    } catch (e1) {
      notRestored.push({ what: "comp " + f, reason: String(e1.message || e1) });
    }
  }
  try {
    var bg = cp.bgColor;
    if (!__cpSame(target.bgColor, bg)) target.bgColor = [bg[0], bg[1], bg[2]];
  } catch (e2) {
    notRestored.push({ what: "comp bgColor", reason: String(e2.message || e2) });
  }
  // The work area has to fit inside the duration at every intermediate step,
  // so whichever order fails first is retried the other way round.
  var ws = cp.workAreaStart;
  var wd = cp.workAreaDuration;
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
  __cpRestoreMarkers(cp, target, notRestored);
}

function __cpRestoreMarkers(cp, target, notRestored) {
  var src = null;
  var dst = null;
  try { src = cp.markerProperty; dst = target.markerProperty; } catch (e) { return; }
  if (!src || !dst) return;
  var a = __fpCompMarkers(cp);
  var b = __fpCompMarkers(target);
  if (__cpSame(a, b)) return;
  try {
    for (var i = dst.numKeys; i >= 1; i--) dst.removeKey(i);
    for (var j = 1; j <= src.numKeys; j++) dst.setValueAtTime(src.keyTime(j), src.keyValue(j));
  } catch (e2) {
    notRestored.push({ what: "comp markers", reason: String(e2.message || e2) });
  }
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

function __cpVerify(cpId, targetId) {
  var a = __cpComparable(__compFingerprint(cpId));
  var b = __cpComparable(__compFingerprint(targetId));
  var mismatches = [];
  if (a.layers.length !== b.layers.length) {
    mismatches.push({ what: "layer count", checkpoint: a.layers.length, comp: b.layers.length });
  }
  var n = Math.min(a.layers.length, b.layers.length);
  for (var i = 0; i < n; i++) {
    var d = __diffLayer(a.layers[i], b.layers[i]);
    if (d) mismatches.push({ index: i + 1, name: b.layers[i].name, changes: d.changes });
  }
  b.name = a.name;
  var cf = __diffCompFields(a, b);
  if (cf) mismatches.push({ what: "comp", changes: cf });
  return mismatches;
}

OPS.revert_comp = function (args) {
  var cp = __cpResolve(args.checkpointId);
  var meta = cp.meta;
  var cpComp = cp.item;
  var cpId = cpComp.id;
  var targetId = meta.compId;
  if (args.compId !== undefined && args.compId !== null && args.compId !== targetId) {
    throw new Error("Checkpoint " + cpId + " was taken of comp " + targetId + " (\"" + meta.compName + "\"), not comp " +
      args.compId + ". A checkpoint only reverts the comp it was taken of. Nothing was changed.");
  }
  var target = app.project.itemByID(targetId);
  if (!target || !(target instanceof CompItem) || __cpIsCheckpoint(target)) {
    throw new Error("Checkpoint " + cpId + " was taken of comp " + targetId + " (\"" + meta.compName + "\"), which no " +
      "longer exists, so there is nothing to revert into. duplicate_comp the checkpoint to get its contents back as " +
      "an ordinary comp (it gets a new id). Nothing was changed.");
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

  // The layers the comp holds now: the ones to remove once the restore has landed.
  var oldIds = [];
  var known = {};
  var i;
  for (i = 1; i <= target.numLayers; i++) {
    var ol = target.layer(i);
    oldIds.push(ol.id);
    known["L" + ol.id] = true;
  }

  var copies = [];
  var splits = 0;
  var stage = "copying";
  var at = 0;
  try {
    // 1. Copy every checkpoint layer in, before anything existing is touched.
    for (i = 1; i <= n; i++) {
      at = i;
      if (__cpCopyLayer(cpComp.layer(i), target)) splits += 1;
      var fresh = __cpNewLayer(target, known);
      if (!fresh) throw new Error("the copy of layer " + i + " could not be told apart from the comp's other layers");
      known["L" + fresh.id] = true;
      copies.push(fresh.id);
    }

    // 2. Order, parenting and track mattes, from the checkpoint.
    stage = "arranging";
    var wantLocked = [];
    for (i = 0; i < n; i++) {
      var c0 = __cpLayerById(target, copies[i]);
      wantLocked.push(!!c0.locked);
      if (c0.locked) c0.locked = false;
    }
    for (i = n - 1; i >= 0; i--) {
      at = i + 1;
      __cpLayerById(target, copies[i]).moveToBeginning();
    }
    for (i = 1; i <= n; i++) {
      at = i;
      var src = cpComp.layer(i);
      var dst = __cpLayerById(target, copies[i - 1]);
      var wantParent = null;
      if (src.parent) wantParent = __cpLayerById(target, copies[src.parent.index - 1]);
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
    var stuck = __cpRemoveLayers(target, copies);
    var what = "";
    if (at > 0 && at <= n) what = " at layer " + at + " (\"" + cpComp.layer(at).name + "\")";
    var msg = "revert_comp failed while " + stage + what + ": " + (e.message || e) + ".";
    if (stuck.length === 0) {
      msg += " The " + copies.length + " layer(s) it had copied in were removed again, so comp " + targetId +
        " is as it was before the call.";
    } else {
      msg += " It could not remove every layer it had copied in: ids " + stuck.join(", ") + " are still in comp " +
        targetId + " beside the original layers. delete_layer them.";
    }
    if (out.savedCheckpoint) msg += " The saveCurrent checkpoint " + out.savedCheckpoint.checkpointId + " was taken and still exists.";
    throw new Error(msg);
  }

  // 3. Track mattes. Done before the old layers go so a copy that AE linked to
  //    an old matte is re-pointed first. A failure is reported, not thrown: the
  //    layers are in, and the agent is better served by a named gap.
  var notRestored = [];
  for (i = 1; i <= n; i++) {
    var s = cpComp.layer(i);
    var m = null;
    try { m = s.trackMatteLayer; } catch (em) { m = null; }
    if (!m) continue;
    try {
      var d = __cpLayerById(target, copies[i - 1]);
      var wantM = __cpLayerById(target, copies[m.index - 1]);
      var curM = null;
      try { curM = d.trackMatteLayer; } catch (em2) { curM = null; }
      if (!curM || curM.id !== wantM.id) d.setTrackMatte(wantM, s.trackMatteType);
    } catch (em3) {
      notRestored.push({ what: "track matte of layer " + i + " (\"" + s.name + "\")", reason: String(em3.message || em3) });
    }
  }

  // 4. Remove what the comp held before.
  for (i = 0; i < oldIds.length; i++) {
    var gone = __cpLayerById(target, oldIds[i]);
    if (!gone) continue;
    try {
      if (gone.locked) gone.locked = false;
      gone.remove();
    } catch (er) {
      var left = [];
      for (var j = i; j < oldIds.length; j++) if (__cpLayerById(target, oldIds[j])) left.push(oldIds[j]);
      throw new Error("revert_comp copied all " + n + " checkpoint layers into comp " + targetId + " (ids " +
        copies.join(", ") + ", on top) but failed removing the comp's previous layer " + oldIds[i] + ": " +
        (er.message || er) + ". Previous layers still present: ids " + left.join(", ") + ". delete_layer them, " +
        "or call revert_comp again - it is safe to repeat.");
    }
  }

  // 5. Re-lock what the checkpoint had locked.
  for (i = 0; i < n; i++) {
    if (!wantLocked[i]) continue;
    try { __cpLayerById(target, copies[i]).locked = true; }
    catch (el) { notRestored.push({ what: "lock on layer " + (i + 1), reason: String(el.message || el) }); }
  }

  // 6. Comp settings and comp markers.
  __cpRestoreComp(cpComp, target, notRestored);

  // 7. Check it.
  var mismatches = __cpVerify(cpId, targetId);

  var layerIdMap = {};
  var mapped = meta.layerIds && meta.layerIds.length === n;
  if (mapped) {
    for (i = 0; i < n; i++) layerIdMap[String(meta.layerIds[i])] = copies[i];
  }

  var made = app.project.itemByID(targetId);
  out.compId = targetId;
  out.name = made.name;
  out.checkpointId = cpId;
  out.label = meta.label;
  out.layersRestored = n;
  out.layersRemoved = oldIds.length;
  out.layerIds = copies;
  if (mapped) out.layerIdMap = layerIdMap;
  out.verified = mismatches.length === 0 && notRestored.length === 0;
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
    notes.unshift("NOT a clean revert: " + mismatches.length + " recorded field(s) differ from the checkpoint and " +
      notRestored.length + " item(s) could not be restored - see mismatches/notRestored.");
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
      app.project.itemByID(cpId).remove();
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
