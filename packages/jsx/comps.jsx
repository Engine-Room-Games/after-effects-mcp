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
    if (it instanceof CompItem) out.push(__compSummary(it, sections));
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
  return __compSummary(c);
};

OPS.delete_comp = function (args) {
  var c = getCompById(args.compId);
  c.remove();
  return { ok: true };
};

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

OPS.duplicate_comp = function (args) {
  var src = getCompById(args.compId);
  var folder = null;
  if (args.folderId !== undefined && args.folderId !== null) {
    var f = app.project.itemByID(args.folderId);
    if (!f) throw new Error("No project item with id " + args.folderId + " to use as folderId");
    if (!(f instanceof FolderItem)) {
      throw new Error(
        "folderId " + args.folderId + ' ("' + f.name + '") is a ' + __itemKind(f) +
        ", not a project folder. Pass the id of a folder from get_project_summary, or omit folderId."
      );
    }
    folder = f;
  }

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
  var made = app.project.itemByID(newId);
  if (!made) throw new Error("duplicate_comp created comp " + newId + " but it could not be read back");
  if (folder) made.parentFolder = folder;

  var out = __compSummary(made);
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
