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
    var use = __rqFootageUse(rq.item(s.index));
    if (use.missing.length) {
      problems.push("item " + s.index + " (" + s.compName + ") renders footage After Effects cannot find: " +
        use.missing.join(", ") + " — relink it (File > Dependencies > Find Missing Footage), or the render would " +
        "carry the missing-footage placeholder");
      continue;
    }
    // Every file the render reads, so the server can check each is still on
    // disk and recorded in the saved project at that path (issue #145).
    s.footage = use.files;
    if (use.warnings.length) s.footageWarnings = use.warnings;
    if (use.skipped.length) s.footageSkipped = use.skipped;
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
 * What footage a render queue item actually reads, decided before anything
 * renders and asked of the project itself, so it holds in any language —
 * aerender's own wording is only the second layer (the 26.5 live run: aerender
 * exits 0 with footage missing, and its warning once never reached the server).
 *
 * Returns
 *   missing  — names of missing footage the render WILL read. Any one refuses.
 *   warnings — missing footage the render probably does not read, but might:
 *              reported in the result, never refused (issue #144).
 *   skipped  — missing footage it provably does not read, with why.
 *   files    — {name, path} of every file-backed footage item it reads, for
 *              the server's on-disk and saved-path checks (issue #145).
 *
 * The walk follows nested comps with the time span mapped into each one. A
 * layer's footage is READ when the layer is switched on (video, or audio with
 * audio to give) and its in/out overlaps the span, padded by a frame for motion
 * blur and frame blending. It is read regardless of both when the layer is a
 * track matte, or when another layer in its comp points at it through a
 * layer-valued property (Displacement Map, Set Matte, Compound Blur, a Layer
 * Control, a light's source — anything whose value is a layer): those pull
 * pixels from layers that are switched off, which is how they are normally
 * used. A parent is NOT a read: parenting takes the parent's transform, never
 * its pixels, and a missing file keeps its dimensions.
 *
 * What cannot be proved either way is a warning, not a refusal and not a skip:
 * an expression calling sampleImage() can read any layer's pixels by name, and
 * names in code are not something to guess at — so when one exists anywhere in
 * the walked comps, every "provably unread" verdict is demoted to a warning.
 * A layer-valued property whose value AE will not give, or one driven by an
 * expression, makes every layer in that comp count as read. A nested comp is
 * given the whole of its own time (no span limit) when the layer holding it
 * has time remapping, any effect (Echo, Time Displacement, Posterize Time…
 * read other times), or a stretch AE will not report.
 *
 * Any property AE will not describe counts as read: the only cost of reading
 * too much is the refusal #144 is about, while reading too little renders the
 * missing-footage placeholder and calls it done.
 */
function __rqFootageUse(item) {
  var NAMES_CAP = 20;
  var missing = [];
  var warnings = [];
  var skipped = [];
  var files = [];
  var usedIds = {};       // footage id -> true once read
  var skipWhy = {};       // footage id -> reason, for missing footage not (yet) read
  var skipOrder = [];     // footage ids in the order first skipped
  var skipFiles = {};     // footage id -> {name, path}, file-backed and not missing
  var compState = {};
  var refsMemo = {};
  var visited = [];

  function idOf(x) { try { return x.id; } catch (e) { return null; } }
  function nameOf(x) { try { return String(x.name); } catch (e) { return "?"; } }
  function fileOf(src) {
    try { return src.file ? src.file.fsName : null; } catch (e) { return null; }
  }
  function isMissing(src) {
    try { return src.footageMissing === true; } catch (e) { return false; }
  }
  function fps(c) {
    var f = 0;
    try { f = c.frameRate; } catch (e) { f = 0; }
    return f > 0 ? f : 0;
  }

  // Switched on: the video switch, or the audio switch on a layer with audio.
  function layerOn(L) {
    var v = true;
    try { v = L.enabled !== false; } catch (e) { v = true; }
    if (v) return true;
    try { return L.audioEnabled === true && L.hasAudio !== false; } catch (e2) { return true; }
  }
  function layerSpan(L) {
    try {
      var a = L.inPoint, b = L.outPoint;
      if (typeof a !== "number" || typeof b !== "number") return null;
      return { a: Math.min(a, b), b: Math.max(a, b) };
    } catch (e) { return null; }
  }
  function overlaps(L, iv, c) {
    if (!iv) return true;
    var s = layerSpan(L);
    if (!s) return true;
    var f = fps(c);
    var pad = f ? 1 / f : 0;
    return s.a - pad < iv.b && s.b + pad > iv.a;
  }
  function isMatte(L) {
    try { return L.isTrackMatte === true; } catch (e) { return true; }
  }

  // Layers in comp c that some layer reaches through a track matte or a
  // layer-valued property. {idx: {index: true}, all: bool}.
  function scanLayerProps(group, out, depth) {
    if (!group || depth > 6) return;
    var n = 0;
    try { n = group.numProperties || 0; } catch (e) { out.all = true; return; }
    for (var j = 1; j <= n; j++) {
      var p = null;
      try { p = group.property(j); } catch (e1) { out.all = true; continue; }
      if (!p) continue;
      var kind = null;
      try { kind = p.propertyType; } catch (e2) { out.all = true; continue; }
      if (kind === PropertyType.PROPERTY) {
        var vt = null;
        try { vt = p.propertyValueType; } catch (e3) { out.all = true; continue; }
        if (vt !== PropertyValueType.LAYER_INDEX) continue;
        try {
          if (p.expressionEnabled === true) { out.all = true; continue; }
          var v = p.value;
          if (typeof v === "number" && v > 0) out.idx[v] = true;
          else if (v && typeof v === "object" && typeof v.index === "number") out.idx[v.index] = true;
        } catch (e4) { out.all = true; }
      } else {
        scanLayerProps(p, out, depth + 1);
      }
    }
  }
  function refsOf(c) {
    var key = String(idOf(c));
    if (refsMemo[key]) return refsMemo[key];
    var out = { idx: {}, all: false };
    if (typeof PropertyType === "undefined" || typeof PropertyValueType === "undefined") out.all = true;
    var n = 0;
    try { n = c.numLayers || 0; } catch (e) { n = 0; out.all = true; }
    for (var i = 1; i <= n && !out.all; i++) {
      var X = null;
      try { X = c.layer(i); } catch (e1) { out.all = true; break; }
      // The matte a layer names (AE 23+), and the layer above it (the older
      // rule, where the matte is always the layer directly above).
      try { var m = X.trackMatteLayer; if (m) out.idx[m.index] = true; } catch (e2) {}
      try {
        if (typeof TrackMatteType !== "undefined" && X.trackMatteType !== undefined &&
            X.trackMatteType !== TrackMatteType.NO_TRACK_MATTE && X.index > 1) out.idx[X.index - 1] = true;
      } catch (e3) {}
      var groups = ["ADBE Effect Parade", "ADBE Light Options Group"];
      for (var g = 0; g < groups.length && !out.all; g++) {
        var grp = null;
        try { grp = X.property ? X.property(groups[g]) : null; } catch (e4) { grp = null; }
        if (grp) scanLayerProps(grp, out, 0);
      }
    }
    refsMemo[key] = out;
    return out;
  }

  // The span a nested comp is read over, in its own time; null = all of it.
  function childSpan(L, iv, child) {
    if (!iv) return null;
    try {
      if (L.timeRemapEnabled === true) return null;
      var fx = L.property ? L.property("ADBE Effect Parade") : null;
      if (fx && fx.numProperties > 0) return null;
      var st = L.startTime;
      var str = L.stretch;
      if (typeof st !== "number" || typeof str !== "number" || !str) return null;
      var s = layerSpan(L);
      var a = iv.a, b = iv.b;
      if (s) { a = Math.max(a, s.a); b = Math.min(b, s.b); }
      var x1 = (a - st) * 100 / str;
      var x2 = (b - st) * 100 / str;
      var f = fps(child);
      var pad = f ? 1 / f : 0;
      return { a: Math.min(x1, x2) - pad, b: Math.max(x1, x2) + pad };
    } catch (e) { return null; }
  }

  // Effects that read a layer's input at OTHER times — Echo, Posterize Time,
  // Timewarp and their kin. On an adjustment layer they read the composite of
  // every layer below at earlier frames, so a layer that ends before the span
  // still reaches the render. A comp where any switched-on layer carries one
  // is read over all of its time. Matched loosely on match name and display
  // name on purpose: a false match costs only a skip.
  //
  // A name list cannot know third-party effects (Twixtor, RSMB, …), and on an
  // adjustment layer an unknown one is exactly the risk. So on an ADJUSTMENT
  // layer the rule is inverted: every effect counts as reading other times
  // unless its match name is on NON_TIME_EFFECTS, a short list of stock
  // effects that work on the current frame alone. The cost of the inversion
  // is an occasional refusal (out-of-span missing footage in a comp with an
  // unlisted adjustment effect), never a placeholder. On any other layer an
  // effect reads only that layer's own source, whose in/out the walk already
  // judges, so the name list is enough there.
  var NON_TIME_EFFECTS = {
    "ADBE Lumetri": 1, "ADBE CurvesCustom": 1, "ADBE Easy Levels2": 1, "ADBE Pro Levels2": 1,
    "ADBE HUE SATURATION": 1, "ADBE Brightness & Contrast 2": 1, "ADBE Exposure2": 1, "ADBE Tint": 1,
    "ADBE Tritone": 1, "ADBE Color Balance 2": 1, "ADBE Black&White": 1, "ADBE Vibrance": 1,
    "ADBE Gaussian Blur 2": 1, "ADBE Fast Blur": 1, "ADBE Box Blur2": 1, "ADBE Sharpen": 1,
    "ADBE Unsharp Mask2": 1, "ADBE Noise2": 1, "ADBE Glo2": 1, "ADBE Invert": 1, "ADBE Fill": 1,
    "ADBE Ramp": 1, "ADBE Vignette": 1, "ADBE Photo Filter": 1, "ADBE Change Color": 1
  };
  var TIME_EFFECT = /echo|posterize\s*time|time\s*warp|time\s*displacement|time\s*difference|time\s*blend|wide\s*time|motion\s*blur|frame\s*blend|pixel\s*motion|time\s*remap|freeze|optical\s*flow|\btime\b/i;
  var timeFxMemo = {};
  function readsOtherTimes(c) {
    var key = String(idOf(c));
    if (timeFxMemo.hasOwnProperty(key)) return timeFxMemo[key];
    var found = false;
    var n = 0;
    try { n = c.numLayers || 0; } catch (e) { found = true; }
    for (var i = 1; i <= n && !found; i++) {
      try {
        var L = c.layer(i);
        if (L.enabled === false) continue;
        var adjust = L.adjustmentLayer === true;
        var fx = L.property ? L.property("ADBE Effect Parade") : null;
        var m = fx ? (fx.numProperties || 0) : 0;
        for (var j = 1; j <= m && !found; j++) {
          var ef = fx.property(j);
          var mn = String(ef.matchName);
          if (TIME_EFFECT.test(mn) || TIME_EFFECT.test(String(ef.name))) found = true;
          else if (adjust && NON_TIME_EFFECTS[mn] !== 1) found = true;
        }
      } catch (e2) { found = true; }
    }
    timeFxMemo[key] = found;
    return found;
  }

  function walk(c, iv, live, why, depth) {
    if (!c || depth > 32) return;
    if (live && iv && readsOtherTimes(c)) iv = null;
    var key = String(idOf(c));
    var st = compState[key];
    if (!st) { st = compState[key] = { live: false, all: false, hull: null, skip: false }; visited.push(c); }
    if (live) {
      // A comp reached twice is walked again only for time it has not covered.
      if (st.live && (st.all || (iv && st.hull && iv.a >= st.hull.a && iv.b <= st.hull.b))) return;
      if (!iv) st.all = true;
      else st.hull = st.hull ? { a: Math.min(st.hull.a, iv.a), b: Math.max(st.hull.b, iv.b) } : { a: iv.a, b: iv.b };
      st.live = true;
      iv = st.all ? null : st.hull;
    } else {
      if (st.skip) return;
      st.skip = true;
    }
    var n = 0;
    try { n = c.numLayers || 0; } catch (e1) { n = 0; }
    for (var i = 1; i <= n; i++) {
      var L = null, src = null;
      try { L = c.layer(i); src = L.source; } catch (e2) { src = null; }
      if (!src) continue;
      var isComp = src instanceof CompItem;
      var isFootage = !isComp && src instanceof FootageItem;
      if (!isComp && !isFootage) continue;

      var read = false, reason = why;
      var drawn = false;
      if (live) {
        var on = layerOn(L);
        drawn = on && overlaps(L, iv, c);
        read = drawn || isMatte(L);
        if (!read) {
          var refs = refsOf(c);
          read = refs.all || refs.idx[i] === true;
        }
        if (!read) {
          reason = "its layer \"" + nameOf(L) + "\" in \"" + nameOf(c) + "\" is " +
            (on ? "outside the rendered time span" : "switched off");
        }
      }
      if (isComp) {
        if (read) walk(src, drawn ? childSpan(L, iv, src) : null, true, null, depth + 1);
        else walk(src, null, false, reason, depth + 1);
        continue;
      }
      var fid = String(idOf(src));
      var gone = isMissing(src);
      if (read) {
        if (usedIds[fid]) continue;
        usedIds[fid] = true;
        if (gone) {
          if (missing.length < NAMES_CAP) missing.push("\"" + nameOf(src) + "\"");
        } else {
          var p = fileOf(src);
          if (p) files.push({ name: nameOf(src), path: p });
        }
      } else if (gone) {
        if (!skipWhy[fid]) { skipWhy[fid] = { name: nameOf(src), why: reason }; skipOrder.push(fid); }
      } else {
        var sp = fileOf(src);
        if (sp && !skipFiles[fid]) skipFiles[fid] = { name: nameOf(src), path: sp };
      }
    }
  }

  // An expression in the render that samples pixels can read any layer.
  function hasSampleImage(group, depth) {
    if (depth > 12) return true;
    var n = 0;
    try { n = group.numProperties || 0; } catch (e) { return true; }
    for (var j = 1; j <= n; j++) {
      var p = null;
      try { p = group.property(j); } catch (e1) { return true; }
      if (!p) continue;
      try {
        if (p.propertyType === PropertyType.PROPERTY) {
          if (p.canSetExpression === true && p.expressionEnabled === true && /sampleImage/.test(String(p.expression))) return true;
        } else if (hasSampleImage(p, depth + 1)) {
          return true;
        }
      } catch (e2) { return true; }
    }
    return false;
  }
  function anySampleImage() {
    if (typeof PropertyType === "undefined") return true;
    for (var k = 0; k < visited.length; k++) {
      var n = 0;
      try { n = visited[k].numLayers || 0; } catch (e) { return true; }
      for (var i = 1; i <= n; i++) {
        var L = null;
        try { L = visited[k].layer(i); } catch (e1) { return true; }
        if (hasSampleImage(L, 0)) return true;
      }
    }
    return false;
  }

  var span = null;
  try {
    var t0 = item.timeSpanStart, d = item.timeSpanDuration;
    if (typeof t0 === "number" && typeof d === "number" && d > 0) span = { a: t0, b: t0 + d };
  } catch (e) { span = null; }
  var comp = null;
  try { comp = item.comp; } catch (e3) { comp = null; }
  walk(comp, span, true, null, 0);

  // Missing footage read anywhere is read; a skip elsewhere does not undo it.
  var pending = [];
  for (var s = 0; s < skipOrder.length; s++) {
    if (!usedIds[skipOrder[s]]) pending.push(skipWhy[skipOrder[s]]);
  }
  var unreadFiles = [];
  for (var fk in skipFiles) {
    if (skipFiles.hasOwnProperty(fk) && !usedIds[fk]) unreadFiles.push(skipFiles[fk]);
  }
  // Whenever anything was left unread, missing or not: a skipped layer with
  // its footage present must still be checked on disk (#145) when an
  // expression may sample it. When nothing was skipped the scan could change
  // nothing, so that is the one case it is not run.
  var sampled = (pending.length || unreadFiles.length) ? anySampleImage() : false;
  for (var q = 0; q < pending.length && q < NAMES_CAP; q++) {
    var line = "\"" + pending[q].name + "\": " + pending[q].why;
    if (sampled) {
      warnings.push(line + ", so it should not be rendered — but an expression in this render calls sampleImage(), " +
        "which can read a switched-off layer's pixels. If it reads this one, those frames show the missing-footage " +
        "placeholder. Relink it to be sure.");
    } else {
      skipped.push(line);
    }
  }
  // Present footage that is probably unread still has to be findable when an
  // expression may sample it.
  if (sampled) for (var u = 0; u < unreadFiles.length; u++) files.push(unreadFiles[u]);
  return { missing: missing, warnings: warnings, skipped: skipped, files: files };
}

/** True when the .aep on disk cannot be written. Null when the host will not say. */
function __rqProjectReadOnly() {
  try { return app.project.file.readonly === true; } catch (e) { return null; }
}

/**
 * Save the project so the separate render process sees what the user sees.
 *
 * Only ever called when the caller passed saveProject:true, and the project
 * has unsaved changes or (with `force`) records footage paths that went stale. Dialogs are suppressed for the save, as export_mogrt does:
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
  // `force` saves a clean project too: the server asks for that when the saved
  // file records footage at paths that no longer hold it (issue #145) — a save
  // makes After Effects write the paths it resolves now. A clean project's
  // dirty flag cannot show whether that save happened, so the server re-reads
  // the saved file afterwards instead.
  if (app.project.dirty !== true && args.force !== true) {
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
