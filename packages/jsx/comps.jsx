// comps.jsx — composition ops.

// The section filter every read op shares. `sections` is the caller's `include`
// array: null/undefined means "all of them", which is what every caller written
// before `include` existed passes. An empty array means the identifying core
// only. Defined here because comps.jsx is the first module in the bundle that
// needs it; layers.jsx and explore.jsx use the same one.
function __wantsSection(sections, name) {
  if (!sections) return true;
  for (var i = 0; i < sections.length; i++) if (sections[i] === name) return true;
  return false;
}

function __compSummary(c, sections) {
  // id and name are the map an agent orients with, so they are never optional.
  var out = { id: c.id, name: c.name };
  if (__wantsSection(sections, "size")) {
    out.width = c.width;
    out.height = c.height;
    out.pixelAspect = c.pixelAspect;
  }
  if (__wantsSection(sections, "timing")) {
    out.duration = c.duration;
    out.frameRate = c.frameRate;
    out.workAreaStart = c.workAreaStart;
    out.workAreaDuration = c.workAreaDuration;
  }
  if (__wantsSection(sections, "bg")) out.bgColor = [c.bgColor[0], c.bgColor[1], c.bgColor[2]];
  if (__wantsSection(sections, "counts")) out.numLayers = c.numLayers;
  return out;
}

OPS.list_comps = noUndo(function (args) {
  var sections = (args && args.include) ? args.include : null;
  var out = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (!(it instanceof CompItem)) continue;
    var s = __compSummary(it, sections);
    // A checkpoint (checkpoint.jsx) is a full copy of a real comp; flagged so
    // nobody builds in one by mistake. Not filtered: hiding comps from the map
    // an agent orients with is a bigger lie than listing them.
    if (__cpIsCheckpoint(it)) s.checkpoint = true;
    out.push(s);
  }
  return out;
});

OPS.get_comp = noUndo(function (args) {
  return __compSummary(getCompById(args.compId));
});

OPS.create_comp = function (args) {
  var bg = args.bgColor || [0, 0, 0];
  var c = app.project.items.addComp(
    args.name || "Untitled",
    args.width || 1920,
    args.height || 1080,
    args.pixelAspect || 1,
    args.duration || 5,
    args.frameRate || 30
  );
  c.bgColor = [bg[0], bg[1], bg[2]];
  return __compSummary(c);
};

OPS.set_comp = function (args) {
  var c = getCompById(args.compId);
  if (args.name !== undefined) c.name = args.name;
  if (args.width !== undefined) c.width = args.width;
  if (args.height !== undefined) c.height = args.height;
  if (args.frameRate !== undefined) c.frameRate = args.frameRate;
  if (args.duration !== undefined) c.duration = args.duration;
  if (args.workAreaStart !== undefined) c.workAreaStart = args.workAreaStart;
  if (args.workAreaDuration !== undefined) c.workAreaDuration = args.workAreaDuration;
  if (args.bgColor) c.bgColor = [args.bgColor[0], args.bgColor[1], args.bgColor[2]];
  // The comp switches layer motion blur and frame blending need (issue #181),
  // read back: a switch that did not land is an error, not a summary.
  var sw = [["motionBlur", args.motionBlur], ["frameBlending", args.frameBlending]];
  for (var i = 0; i < sw.length; i++) {
    if (sw[i][1] === undefined) continue;
    c[sw[i][0]] = sw[i][1];
    if (c[sw[i][0]] !== sw[i][1]) {
      throw new Error("set_comp: asked for " + sw[i][0] + " " + sw[i][1] + " but After Effects reads " + c[sw[i][0]] +
        " afterwards. The fields before it in this call were written.");
    }
  }
  var out = __compSummary(c);
  if (args.motionBlur !== undefined) out.motionBlur = c.motionBlur;
  if (args.frameBlending !== undefined) out.frameBlending = c.frameBlending;
  return out;
};

// A solid layer's source is a FootageItem in the project's Solids folder, and
// removing the comp removes the layer, not the item (issue #83). The solids
// this comp used are collected from ITS OWN layers before the removal and
// nothing else — deleting comp A must never reach a solid that only some other
// comp uses — and after it, `usedIn` decides: an item some other comp still
// places is kept and reported with the comps using it. The helpers live in
// footage.jsx beside purge_unused_footage, the project-wide sweep.
//
// Removing a comp also removes every precomp layer that nests it, in every
// other comp, and After Effects says nothing (issue #160). So the nesting is
// read first, from AE's own `usedIn`: by default a comp something nests is
// refused with those comps named, and `force:true` deletes it anyway and
// reports, per comp, the layers that went with it.
OPS.delete_comp = function (args) {
  var c = getCompById(args.compId);
  var compId = c.id;
  var compName = c.name;
  var purge = (args.purgeUnusedSolids === true);
  var force = (args.force === true);

  var nestedIn = __delCompNestingLayers(c);
  if (nestedIn.unreadable && !force) {
    throw new Error("delete_comp refused: could not read which comps nest comp \"" + compName + "\" (id " + compId +
      "): " + nestedIn.unreadable + ". Nothing was deleted. Deleting a comp removes every precomp layer that uses it, " +
      "so it is not deleted blind; pass force:true to delete it anyway.");
  }
  if (nestedIn.length > 0 && !force) {
    var cps = 0;
    for (var k = 0; k < nestedIn.length; k++) if (nestedIn[k].checkpoint) cps++;
    var advice = "Re-point or delete those layers first, or pass force:true to delete the comp and those layers together.";
    if (cps > 0) {
      advice = cps + " of them " + (cps === 1 ? "is a checkpoint copy" : "are checkpoint copies") +
        " (marked [checkpoint]): revert_comp or delete_checkpoints to discard the checkpoint, rather than editing it. " +
        (cps < nestedIn.length ? "For the others, re-point or delete those layers first. " : "") +
        "Or pass force:true to delete the comp and those layers together.";
    }
    throw new Error("delete_comp refused: comp \"" + compName + "\" (id " + compId + ") is nested in " +
      nestedIn.length + " other comp(s): " + __delCompNestingText(nestedIn) +
      ". Deleting it would remove those precomp layers too. Nothing was deleted. " + advice);
  }
  var rqCount = __delCompRenderQueueCount(compId);

  var solids = __solidItemsOf(c);

  c.remove();

  var out = { ok: true, compId: compId, name: compName };
  if (nestedIn.length > 0) out.removedFromComps = nestedIn;
  if (nestedIn.unreadable) out.nestingUnknown = "Which comps nested it could not be read (" + nestedIn.unreadable +
    "); any precomp layers using it were removed unreported.";
  if (rqCount > 0) out.renderQueueItemsRemoved = rqCount;
  var kept = [];
  var toRemove = [];
  var gone = [];
  for (var i = 0; i < solids.length; i++) {
    // Re-fetched by id after the removal rather than held across it — the
    // handle staleness this repo has measured elsewhere is not worth risking
    // for one lookup per solid.
    var item = __findItem(solids[i].id);
    if (!item) { gone.push(solids[i]); continue; }
    var uses = __usedInList(item);
    if (uses.length > 0 || uses.unreadable) {
      kept.push({ id: item.id, name: item.name, usedIn: uses });
      continue;
    }
    toRemove.push({ item: item, id: item.id, name: item.name, kind: "solid" });
  }
  if (gone.length > 0) out.solidsAlreadyGone = gone;

  if (!purge) {
    out.unusedSolidsLeft = toRemove.length;
    if (toRemove.length > 0) {
      out.note = toRemove.length + " solid item(s) this comp used are now used by nothing and remain in the project's Solids folder. " +
        "Pass purgeUnusedSolids:true to remove them with the comp, or purge_unused_footage to sweep the whole project.";
    }
    return out;
  }

  var r = __removeItems(toRemove);
  out.removedSolids = r.removed;
  out.keptSolids = kept;
  if (r.failed) {
    var msg = "delete_comp removed comp \"" + compName + "\" (id " + compId + "), then failed purging its solids at \"" +
      r.failed.name + "\" (id " + r.failed.id + "): " + r.error + ".";
    if (r.removed.length > 0) msg += " Removed before it: " + __nameList(r.removed, 20) + ".";
    else msg += " No solid had been removed yet.";
    if (r.notAttempted.length > 0) msg += " Not attempted: " + __nameList(r.notAttempted, 20) + ".";
    msg += " The comp is gone, so do not call delete_comp for it again. One Undo in After Effects restores the comp and " +
      "these solids together; purge_unused_footage removes whatever is still left.";
    throw new Error(msg);
  }
  if (kept.length > 0) {
    out.note = kept.length + " solid item(s) were kept because another comp still uses them; see keptSolids.usedIn.";
  }
  return out;
};

/**
 * The comps that nest `c`, each with the precomp layers pointing at it, as
 * {id, name, layers:[{id, name}]}. Read before the removal: afterwards those
 * layers no longer exist to be named.
 */
function __delCompNestingLayers(c) {
  var users = __usedInList(c);
  var out = [];
  if (users.unreadable) out.unreadable = users.unreadable;
  for (var i = 0; i < users.length; i++) {
    var host = __findItem(users[i].id);
    var layers = [];
    if (host) {
      for (var j = 1; j <= host.numLayers; j++) {
        var l = host.layer(j);
        var src = null;
        try { src = l.source; } catch (e) { src = null; }
        if (src && src.id === c.id) layers.push({ id: l.id, name: l.name });
      }
    }
    var entry = { id: users[i].id, name: users[i].name, layers: layers };
    try { if (host && typeof __cpIsCheckpoint === "function" && __cpIsCheckpoint(host)) entry.checkpoint = true; } catch (eCp) {}
    out.push(entry);
  }
  return out;
}

function __delCompNestingText(nestedIn) {
  var parts = [];
  for (var i = 0; i < nestedIn.length && i < 20; i++) {
    var n = nestedIn[i];
    parts.push("\"" + n.name + "\" (id " + n.id + ", " + n.layers.length + " layer(s)" + (n.checkpoint ? ", checkpoint" : "") + ")");
  }
  if (nestedIn.length > 20) parts.push("and " + (nestedIn.length - 20) + " more");
  return parts.join(", ");
}

/** Render-queue items that render this comp; AE removes them with it. 0 when the queue cannot be read. */
function __delCompRenderQueueCount(compId) {
  var n = 0;
  try {
    var rq = app.project.renderQueue;
    if (!rq) return 0;
    for (var i = 1; i <= rq.numItems; i++) {
      var it = rq.item(i);
      var comp = null;
      try { comp = it.comp; } catch (e) { comp = null; }
      if (comp && comp.id === compId) n++;
    }
  } catch (e2) { return n; }
  return n;
}

// ---------------------------------------------------------------------------
// duplicate_comp
// ---------------------------------------------------------------------------
// There was duplicate_layer, create_comp and delete_comp but no way to copy a
// comp, so every rig workflow detoured through run_jsx and CompItem.duplicate()
// (issue #54). Two things that detour never got right:
//
//   * AE's own Duplicate is SHALLOW. The copy's precomp layers point at the
//     same source comps as the original, so "make a variant of this rig" and
//     then editing the variant edits the original too. `deep:true` duplicates
//     the nested comps as well and re-points the copy's layers at them, which
//     is the entire value of the flag.
//   * The same nested comp usually appears on several layers. Duplicating per
//     layer fans out one copy per reference; __dupNested keeps a map from
//     original id to its copy and reuses it, and registers the copy *before*
//     recursing so a cycle terminates instead of recursing for ever.

// AE happily allows two project items with the same name, which makes a
// deep-duplicated rig unreadable in the project panel. Appending a counter is
// the smaller evil, and the chosen name is reported either way.
function __dupNameTaken(name) {
  for (var i = 1; i <= app.project.numItems; i++) {
    if (app.project.item(i).name === name) return true;
  }
  return false;
}

function __dupUniqueName(base) {
  if (!__dupNameTaken(base)) return base;
  for (var n = 2; n < 1000; n++) {
    var candidate = base + " " + n;
    if (!__dupNameTaken(candidate)) return candidate;
  }
  return base;
}

// Depth is a backstop, not the cycle guard — `seen` is. AE refuses to nest a
// comp inside itself, but nothing here should recurse for ever if a future
// build ever allows it.
var __DUP_MAX_DEPTH = 32;

function __dupNested(src, opts, depth) {
  var key = "C" + src.id;
  if (opts.seen.hasOwnProperty(key)) return opts.seen[key];
  if (depth > __DUP_MAX_DEPTH) {
    throw new Error("nested comps are more than " + __DUP_MAX_DEPTH + " deep below the comp being duplicated");
  }
  var srcId = src.id;
  var srcName = src.name;
  var dup = src.duplicate();
  opts.seen[key] = dup;
  if (opts.nameSuffix) dup.name = __dupUniqueName(srcName + opts.nameSuffix);
  opts.created.push({ fromCompId: srcId, fromName: srcName, compId: dup.id, name: dup.name });
  __dupRepoint(dup, opts, depth);
  return dup;
}

// Re-point every precomp layer of a freshly duplicated comp at the duplicate of
// its source rather than the original. Layers whose source is footage, and
// layers with no source at all, are left alone.
function __dupRepoint(comp, opts, depth) {
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    if (!(l instanceof AVLayer)) continue;
    var srcItem = null;
    try { srcItem = l.source; } catch (e) { continue; }
    if (!srcItem || !(srcItem instanceof CompItem)) continue;
    var replacement = __dupNested(srcItem, opts, depth + 1);
    // fixExpressions:false — the layer keeps its name and its own properties,
    // so there is nothing for AE to rewrite, and letting it rewrite expressions
    // on a rig is a change nobody asked for.
    l.replaceSource(replacement, false);
    opts.repointed += 1;
  }
}

// A `folderId` argument resolved to a FolderItem, or a thrown error naming the
// id and what it actually is. Shared by duplicate_comp and purge_unused_footage.
function __folderArg(id) {
  var f = __findItem(id);
  if (!f) throw new Error("No project item with id " + id + " to use as folderId");
  if (!(f instanceof FolderItem)) {
    throw new Error(
      "folderId " + id + ' ("' + f.name + '") is a ' + __itemKind(f) +
      ", not a project folder. Pass the id of a folder from get_project_summary, or omit folderId."
    );
  }
  return f;
}

OPS.duplicate_comp = function (args) {
  var src = getCompById(args.compId);
  var folder = null;
  if (args.folderId !== undefined && args.folderId !== null) folder = __folderArg(args.folderId);

  var opts = { seen: {}, created: [], repointed: 0, nameSuffix: null };
  if (args.nameSuffix) opts.nameSuffix = args.nameSuffix;

  // Captured as primitives before the duplicate. Some AE calls invalidate every
  // handle held across them (exportAsMotionGraphicsTemplate is the measured
  // one), so nothing below reads `src` again.
  var srcId = src.id;
  var srcName = src.name;
  var dup = src.duplicate();
  var newId = dup.id;
  if (args.name) dup.name = args.name;

  if (args.deep) {
    opts.seen["C" + srcId] = dup;
    try {
      __dupRepoint(dup, opts, 1);
    } catch (e) {
      // The copy and any nested copies made before the failure are real and
      // nothing rolled them back. Reporting {ok:true} over a half-built rig, or
      // an error that does not name what exists, are the same class of lie.
      var madeIds = [];
      madeIds.push(String(newId));
      for (var m = 0; m < opts.created.length; m++) madeIds.push(String(opts.created[m].compId));
      throw new Error(
        "duplicate_comp deep failed part-way: " + e.message +
        ". These comps were created and still exist: ids " + madeIds.join(", ") +
        ". Undo once in After Effects to back the whole thing out, or delete_comp them."
      );
    }
  }

  // Re-fetch by id rather than trusting the handle held across the duplication.
  var made = __findItem(newId);
  if (!made) throw new Error("duplicate_comp created comp " + newId + " but it could not be read back");
  if (folder) made.parentFolder = folder;
  // A copy of a checkpoint (checkpoint.jsx) is how its contents are recovered
  // once the comp it was taken of is gone. Whether or not AE carries the item
  // comment across a duplicate, the copy must not read as a second checkpoint.
  var wasCheckpoint = (typeof __cpIsCheckpoint === "function") && __cpIsCheckpoint(made);
  if (wasCheckpoint) {
    made.comment = "";
    // AE files a duplicate beside its source, which for a checkpoint is the
    // checkpoints folder (measured, 26.5). The recovered comp is ordinary work.
    if (!folder) made.parentFolder = app.project.rootFolder;
  }

  var out = __compSummary(made);
  if (wasCheckpoint) out.fromCheckpoint = true;
  out.fromCompId = srcId;
  out.fromName = srcName;
  out.deep = !!args.deep;
  if (folder) {
    out.folderId = folder.id;
    out.folderName = folder.name;
  }
  if (args.deep) {
    out.nestedDuplicated = opts.created;
    out.nestedCount = opts.created.length;
    out.layersRepointed = opts.repointed;
    if (opts.created.length === 0) {
      out.note = "deep:true had nothing to do - this comp has no precomp layers.";
    }
  } else {
    out.note = "Shallow copy: its precomp layers still point at the SAME nested comps as the original, " +
      "so editing one of those edits both. Pass deep:true to duplicate the nested comps too.";
  }
  return out;
};

OPS.set_active_comp = function (args) {
  var c = getCompById(args.compId);
  c.openInViewer();
  return { ok: true };
};

OPS.get_comp_tree = noUndo(function (args) {
  var c = getCompById(args.compId);
  var depth = args.depth || 2;
  function summarize(comp, d) {
    var s = __compSummary(comp);
    s.layers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      var ls = __layerSummary(l);
      if (d > 0 && l.source && l.source instanceof CompItem) {
        ls.precomp = summarize(l.source, d - 1);
      }
      s.layers.push(ls);
    }
    return s;
  }
  return summarize(c, depth);
});
