// render.jsx — the render queue: add, list, remove, and the prepare half of a
// render (issue #137).
//
// The render itself does NOT happen in here, and that is the design rather than
// an omission. `app.project.renderQueue.render()` is synchronous: it holds the
// ExtendScript thread, and After Effects' interface with it, for the whole
// render. Every other call on the panel's evalScript chain waits behind it, the
// server's op timeout fires on a render that is still going, and nothing can
// cancel it from a script — the Stop button is the user's, not ours. So the
// queue is built here, the project is saved, and the server renders the saved
// project with `aerender` in a separate process it can watch and kill. See
// "The render queue" in docs/fragile-areas-ae.md.
//
// Output modules are configured by TEMPLATE NAME and never by setSettings:
// After Effects rejects Format, Channels, Depth and Color as read-only from a
// script although getSettings(SPEC) lists them (issue #95). Whatever a template
// actually produced is read back with getSettings(STRING), because a template
// name is a promise and the read-back is the fact.

/** The names of RQItemStatus, so a status is reported as a word and not a number. */
var __RQ_STATUS_NAMES = [
  "QUEUED", "UNQUEUED", "NEEDS_OUTPUT", "RENDERING", "WILL_CONTINUE",
  "USER_STOPPED", "ERR_STOPPED", "DONE",
];

function __rqStatusName(status) {
  for (var i = 0; i < __RQ_STATUS_NAMES.length; i++) {
    var n = __RQ_STATUS_NAMES[i];
    try { if (RQItemStatus[n] === status) return n; } catch (e) {}
  }
  return String(status);
}

/** Frames this item will render, from its time span and the comp's frame rate. */
function __rqFrames(item) {
  var fps = 0;
  try { fps = item.comp.frameRate; } catch (e) { fps = 0; }
  var dur = 0;
  try { dur = item.timeSpanDuration; } catch (e2) { dur = 0; }
  if (!(fps > 0) || !(dur > 0)) return 0;
  return Math.max(1, Math.round(dur * fps));
}

/** An image-sequence output names its frame number as [###] in the file name. */
function __rqIsSequencePath(p) {
  return /\[#+\]/.test(String(p));
}

/** ExtendScript has no path module; absolute is all this needs to know. */
function __rqIsAbsolutePath(p) {
  var s = String(p);
  if (s.charAt(0) === "/" || s.charAt(0) === "~") return true;
  if (/^[A-Za-z]:[\\\/]/.test(s)) return true;
  if (s.substring(0, 2) === "\\\\") return true;
  return false;
}

/** Search a getSettings(STRING) tree, which nests by section, for one key. */
function __rqFindSetting(tree, key, depth) {
  if (!tree || typeof tree !== "object" || depth > 4) return null;
  if (tree.hasOwnProperty(key)) {
    var v = tree[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  }
  for (var k in tree) {
    if (!tree.hasOwnProperty(k)) continue;
    var sub = tree[k];
    if (sub && typeof sub === "object") {
      var found = __rqFindSetting(sub, key, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * What an output module will actually write, read back from After Effects.
 * Null where this AE will not say — an unanswered read is not a fact.
 */
function __rqOmSettings(om) {
  var s = null;
  try { s = om.getSettings(GetSettingsFormat.STRING); } catch (e) { return null; }
  if (!s) return null;
  return {
    format: __rqFindSetting(s, "Format", 0),
    channels: __rqFindSetting(s, "Channels", 0),
    depth: __rqFindSetting(s, "Depth", 0),
    color: __rqFindSetting(s, "Color", 0),
  };
}

function __rqOmPath(om) {
  try { return om.file ? om.file.fsName : null; } catch (e) { return null; }
}

function __rqOmTemplateName(om) {
  try { return om.name ? String(om.name) : null; } catch (e) { return null; }
}

function __rqHasName(list, name) {
  if (!list) return false;
  for (var i = 0; i < list.length; i++) { if (String(list[i]) === String(name)) return true; }
  return false;
}

function __rqNames(list) {
  var out = [];
  if (!list) return out;
  for (var i = 0; i < list.length; i++) out.push(String(list[i]));
  return out;
}

function __rqItemSummary(rq, index, withSettings) {
  var item = rq.item(index);
  var outputs = [];
  var n = 0;
  try { n = item.numOutputModules; } catch (e) { n = 0; }
  for (var o = 1; o <= n; o++) {
    var om = item.outputModule(o);
    var out = { index: o, path: __rqOmPath(om), template: __rqOmTemplateName(om) };
    if (withSettings) out.settings = __rqOmSettings(om);
    outputs.push(out);
  }
  var compId = null;
  var compName = null;
  try { compId = item.comp.id; compName = item.comp.name; } catch (e2) {}
  return {
    index: index,
    compId: compId,
    compName: compName,
    status: __rqStatusName(item.status),
    render: item.render === true,
    timeSpanStart: item.timeSpanStart,
    timeSpanDuration: item.timeSpanDuration,
    frames: __rqFrames(item),
    outputs: outputs,
  };
}

OPS.add_to_render_queue = function (args) {
  var comp = getCompById(args.compId);
  var outputPath = String(args.outputPath || "");

  // Every check that can run before the queue is touched runs here, so a
  // refusal leaves nothing behind in the user's Render Queue panel.
  if (!__rqIsAbsolutePath(outputPath)) {
    throw new Error(
      "outputPath must be absolute (got \"" + outputPath + "\"). A relative path would be resolved " +
      "against After Effects' own working folder, not the project's."
    );
  }
  var outFile = new File(outputPath);
  var parent = outFile.parent;
  if (!parent || !parent.exists) {
    throw new Error(
      "The folder for outputPath does not exist: " + (parent ? parent.fsName : outputPath) + ". " +
      "Create it first — a render into a missing folder fails only when it runs."
    );
  }
  if (!__rqIsSequencePath(outputPath) && outFile.exists && args.overwrite !== true) {
    throw new Error(
      "A file already exists at " + outFile.fsName + ". Pass overwrite:true to replace it when the " +
      "render runs, or choose another outputPath."
    );
  }
  if (args.duration !== undefined && !(args.duration > 0)) {
    throw new Error("duration must be greater than 0 seconds.");
  }

  var rq = app.project.renderQueue;
  var item = rq.items.add(comp);
  var index = rq.numItems;
  try {
    if (args.renderSettingsTemplate !== undefined) {
      var rsTemplates = item.templates;
      if (!__rqHasName(rsTemplates, args.renderSettingsTemplate)) {
        throw new Error(
          "No render settings template named \"" + args.renderSettingsTemplate + "\". Available: " +
          __rqNames(rsTemplates).join(", ") + "."
        );
      }
      item.applyTemplate(args.renderSettingsTemplate);
    }
    var om = item.outputModule(1);
    if (args.outputModuleTemplate !== undefined) {
      var omTemplates = om.templates;
      if (!__rqHasName(omTemplates, args.outputModuleTemplate)) {
        throw new Error(
          "No output module template named \"" + args.outputModuleTemplate + "\". Available: " +
          __rqNames(omTemplates).join(", ") + ". A codec, bit depth or alpha setting that none of " +
          "these gives has to be saved as a template by hand once (Edit > Templates > Output Module) — " +
          "a script cannot set Format, Channels, Depth or Color directly (issue #95)."
        );
      }
      om.applyTemplate(args.outputModuleTemplate);
    }
    // The file is set after the template, because applying a template can
    // replace the output path with the template's own default.
    om.file = new File(outputPath);
    if (args.startTime !== undefined) item.timeSpanStart = args.startTime;
    if (args.duration !== undefined) item.timeSpanDuration = args.duration;

    var status = __rqStatusName(item.status);
    if (status !== "QUEUED") {
      throw new Error(
        "After Effects left the new render queue item in status " + status + " rather than QUEUED, " +
        "so it would not render."
      );
    }
  } catch (e) {
    // Never leave a half-configured item in the user's queue (issue #95's
    // workaround notes the same leak for scripts that throw mid-setup).
    try { item.remove(); } catch (eR) {}
    throw e;
  }

  var summary = __rqItemSummary(rq, index, true);
  var actual = summary.outputs.length ? summary.outputs[0].path : null;
  if (actual && actual !== outFile.fsName) {
    summary.note = "After Effects changed the output path to " + actual + " (the template's format " +
      "decides the extension). That is the file the render will write.";
  }
  return summary;
};
OPS.add_to_render_queue.__meta = { undoName: "AE MCP: add to render queue" };

OPS.list_render_queue = noUndo(function (args) {
  var rq = app.project.renderQueue;
  var items = [];
  for (var i = 1; i <= rq.numItems; i++) items.push(__rqItemSummary(rq, i, args.includeSettings === true));
  var out = { items: items, count: items.length };
  if (args.includeTemplates === true) {
    if (rq.numItems > 0) {
      var first = rq.item(1);
      out.renderSettingsTemplates = __rqNames(first.templates);
      out.outputModuleTemplates = __rqNames(first.outputModule(1).templates);
    } else {
      // A template list is only readable from an existing item, and inventing
      // one here would turn a read into a write.
      out.templatesNote = "The render queue is empty, and After Effects only lists templates through " +
        "an existing item. Add one with add_to_render_queue (an unknown template name is refused " +
        "with the full list), then list again.";
    }
  }
  return out;
});

OPS.remove_render_item = function (args) {
  var rq = app.project.renderQueue;
  var index = args.index;
  if (!(index >= 1 && index <= rq.numItems)) {
    throw new Error("No render queue item at index " + index + " (the queue has " + rq.numItems + ").");
  }
  var item = rq.item(index);
  // Render queue items have no stable id, so the index is checked against the
  // comp the caller believes is there — an index shifts every time an earlier
  // item is removed.
  var compId = null;
  try { compId = item.comp.id; } catch (e) {}
  if (compId !== args.compId) {
    throw new Error(
      "Render queue item " + index + " renders comp " + compId + ", not " + args.compId + ". Indices " +
      "shift when earlier items are removed — call list_render_queue and use the index it reports now."
    );
  }
  var status = __rqStatusName(item.status);
  if (status === "RENDERING") {
    throw new Error("Render queue item " + index + " is rendering in After Effects right now and cannot be removed.");
  }
  var removed = __rqItemSummary(rq, index, false);
  item.remove();
  return { removed: removed, remaining: rq.numItems };
};
OPS.remove_render_item.__meta = { undoName: "AE MCP: remove render item" };

/**
 * The read-only half of render_queue: which items will render, to which files,
 * how many frames, and where After Effects is installed. Changes nothing — the
 * server uses this to find aerender and refuse early before anything is saved.
 */
OPS._render_prepare = noUndo(function (args) {
  if (!app.project.file) {
    throw new Error(
      "This project has never been saved. render_queue renders the saved project file in a separate " +
      "process, so it needs one — and saving an untitled project raises a modal dialog that would " +
      "freeze this connection. Ask the user to save the project once, then call render_queue again."
    );
  }
  var rq = app.project.renderQueue;
  var picked = [];
  var problems = [];
  var i;
  if (args.indices && args.indices.length) {
    for (i = 0; i < args.indices.length; i++) {
      var idx = args.indices[i];
      if (!(idx >= 1 && idx <= rq.numItems)) {
        problems.push("index " + idx + " does not exist (the queue has " + rq.numItems + ")");
        continue;
      }
      picked.push(idx);
    }
  } else if (args.all === true) {
    for (i = 1; i <= rq.numItems; i++) {
      if (__rqStatusName(rq.item(i).status) === "QUEUED") picked.push(i);
    }
    if (!picked.length) {
      throw new Error(
        "Nothing in the render queue is QUEUED (" + rq.numItems + " item(s) in total). Add one with " +
        "add_to_render_queue — an item render_queue already rendered is switched off (UNQUEUED) so it " +
        "does not render twice."
      );
    }
  } else {
    // The server's schema makes this unreachable; a direct /op call must not
    // fall back to rendering items nobody named.
    throw new Error("render_queue needs `indices`, or `all:true` to render every QUEUED item.");
  }

  var items = [];
  for (i = 0; i < picked.length; i++) {
    var s = __rqItemSummary(rq, picked[i], false);
    if (s.status !== "QUEUED") {
      problems.push("item " + s.index + " (" + s.compName + ") is " + s.status + ", not QUEUED" +
        (s.status === "DONE" ? " — a finished item cannot be re-queued; add a fresh one" : ""));
      continue;
    }
    var missing = false;
    for (var o = 0; o < s.outputs.length; o++) { if (!s.outputs[o].path) missing = true; }
    if (missing || !s.outputs.length) {
      problems.push("item " + s.index + " (" + s.compName + ") has an output module with no file");
      continue;
    }
    var gone = __rqMissingFootage(rq.item(s.index).comp);
    if (gone.length) {
      problems.push("item " + s.index + " (" + s.compName + ") uses footage After Effects cannot find: " +
        gone.join(", ") + " — relink it (File > Dependencies > Find Missing Footage), or the render would " +
        "carry the missing-footage placeholder");
      continue;
    }
    items.push(s);
  }
  if (problems.length) {
    throw new Error("render_queue refused before saving or rendering anything: " + problems.join("; ") + ".");
  }


  var appPackage = null;
  try { appPackage = Folder.appPackage.fsName; } catch (e) {}
  return {
    projectPath: app.project.file.fsName,
    dirty: app.project.dirty === true,
    readOnly: __rqProjectReadOnly(),
    appPackage: appPackage,
    version: app.version,
    items: items,
  };
});

/**
 * Names of the footage a comp renders that After Effects reports missing,
 * following nested comps (each comp once). Asked of the project itself, so it
 * holds in any language — aerender's own wording is only the second layer
 * (the 26.5 live run: aerender exits 0 with footage missing, and its warning
 * once never reached the server). A layer AE will not describe is skipped,
 * not guessed at; at most 20 names come back.
 */
function __rqMissingFootage(comp) {
  var names = [];
  var seen = {};
  function walk(c, depth) {
    if (!c || depth > 32) return;
    var id = null;
    try { id = c.id; } catch (e0) {}
    if (id !== null) {
      if (seen[id]) return;
      seen[id] = true;
    }
    var n = 0;
    try { n = c.numLayers || 0; } catch (e1) { n = 0; }
    for (var i = 1; i <= n && names.length < 20; i++) {
      var src = null;
      try { src = c.layer(i).source; } catch (e2) { src = null; }
      if (!src) continue;
      if (src instanceof CompItem) {
        walk(src, depth + 1);
      } else if (src instanceof FootageItem) {
        var miss = false;
        try { miss = src.footageMissing === true; } catch (e3) { miss = false; }
        if (miss && !seen["f" + src.id]) {
          seen["f" + src.id] = true;
          names.push("\"" + src.name + "\"");
        }
      }
    }
  }
  walk(comp, 0);
  return names;
}

/** True when the .aep on disk cannot be written. Null when the host will not say. */
function __rqProjectReadOnly() {
  try { return app.project.file.readonly === true; } catch (e) { return null; }
}

/**
 * Save the project so the separate render process sees what the user sees.
 *
 * Only ever called when the project has unsaved changes and the caller passed
 * saveProject:true. Dialogs are suppressed for the save, as export_mogrt does:
 * a read-only file, a project converted from an older version (which AE will
 * only Save As) or a locked one would otherwise raise a modal that freezes this
 * connection while the write lease is held. Under suppression such a save just
 * does not happen, so it is checked afterwards rather than trusted.
 *
 * The check is AE's own dirty flag, NOT the file's modified time. File.modified
 * has one-second resolution, and the live run (AE 26.5) refused a save that
 * had happened, because it landed in the same second as the one before: the
 * mtime read identical while `dirty` had gone false. A save that did not
 * happen leaves the project dirty; that is the signal.
 */
OPS._render_save = noUndo(function (args) {
  if (!app.project.file) {
    throw new Error("This project has never been saved. Ask the user to save it once, then call render_queue again.");
  }
  if (__rqProjectReadOnly() === true) {
    throw new Error(
      "The project file " + app.project.file.fsName + " is read-only, so it cannot be saved for the render. " +
      "Nothing was rendered. Ask the user to make it writable or Save As somewhere else, then call render_queue again."
    );
  }
  if (app.project.dirty !== true) {
    return { projectPath: app.project.file.fsName, saved: false, reason: "no unsaved changes" };
  }
  var file = app.project.file;
  var threw = null;
  app.beginSuppressDialogs();
  try {
    app.project.save();
  } catch (e) {
    threw = e;
  } finally {
    app.endSuppressDialogs(false);
  }
  var stillDirty = app.project.dirty === true;
  if (threw || stillDirty) {
    throw new Error(
      "After Effects did not save the project (" + file.fsName + ")" +
      (threw ? ": " + threw.message : "") + ". Nothing was rendered. The usual causes are a file that is " +
      "locked or read-only, or a project converted from an older version of After Effects, which only " +
      "File > Save As will write. Ask the user to save it by hand, then call render_queue again."
    );
  }
  return { projectPath: file.fsName, saved: true };
});

/**
 * When a render job ends, take its verified items out of the queue's QUEUED
 * set so a later render_queue does not render them again (aerender rendered a
 * copy of the file, so the live queue never learned they were done).
 *
 * It changes the project, so it is ONE named undo step — "AE MCP: mark
 * rendered" — opened and closed by dispatch() in this one call, never an
 * unlabeled entry. All the job's items go in that one step, once, at the end:
 * a step per item would land in the user's undo history every few minutes
 * while they work, between their own edits. Matched by comp AND output path,
 * because indices shift: an item that no longer matches is left alone and
 * reported, never guessed at.
 */
OPS._render_mark_done = undoNamed("AE MCP: mark rendered", function (args) {
  var rq = app.project.renderQueue;
  var list = args.items || [];
  var results = [];
  for (var k = 0; k < list.length; k++) {
    var want = list[k];
    var idx = want.index;
    if (!(idx >= 1 && idx <= rq.numItems)) {
      results.push({ index: idx, marked: false, reason: "item " + idx + " no longer exists" });
      continue;
    }
    var s = __rqItemSummary(rq, idx, false);
    var firstPath = s.outputs.length ? s.outputs[0].path : null;
    if (s.compId !== want.compId || firstPath !== want.outputPath) {
      results.push({ index: idx, marked: false, reason: "item " + idx + " now renders something else (the queue changed during the render)" });
      continue;
    }
    rq.item(idx).render = false;
    results.push({ index: idx, marked: true, status: __rqStatusName(rq.item(idx).status) });
  }
  return { results: results };
});
