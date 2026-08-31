// audio.jsx — place a list of sound effects into a comp in one pass.
//
// Scoring a scene is 40-90 layers: import or reuse the file, add a layer, set
// its start time, set its level in dB, name it, sometimes trim it. Done through
// the general tools that is dozens of round trips; done through run_jsx it is a
// hand-written loop that has to know the one thing nothing tells you —
// `layer.property("ADBE Audio Levels")` returns **null** on an audio layer,
// because Audio Levels lives under the layer's "Audio" group and the only
// reliable handle is the `layer.audioLevels` shortcut (issue #48).
//
// Two properties carry the design:
//
//   - Nothing is created until every cue has been checked. A run that dies on
//     cue 30 of 90 leaves 29 sound effects in someone's timeline and an error
//     that does not say which ones — the same half-built failure
//     add_shape_content refuses to produce. So: plan first with no side
//     effects, throw naming the offending cue indices, and if a creation still
//     fails, remove everything this call made before rethrowing.
//   - A file named by several cues is imported once. Repeated imports of one
//     .wav are the normal shape of a cue list ("whoosh" nine times), and each
//     one would otherwise add another project item. Anything already in the
//     project from that path is reused rather than imported a second time.

var __MAX_AUDIO_CUES = 200;
var __CUE_TIME_EPS = 1e-6;

// AE's layer label colours. Users can rename them in preferences, but the tool
// takes an index and the indices do not move, so the names are accepted as a
// convenience and translated here. 0 is "None".
var __LABEL_NAMES = {
  none: 0, red: 1, yellow: 2, aqua: 3, pink: 4, lavender: 5, peach: 6,
  seafoam: 7, blue: 8, green: 9, purple: 10, orange: 11, brown: 12,
  fuchsia: 13, cyan: 14, sandstone: 15, darkgreen: 16
};

function __labelKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function __labelNameList() {
  var names = [];
  for (var k in __LABEL_NAMES) {
    if (__LABEL_NAMES.hasOwnProperty(k)) names.push(k);
  }
  return names.join(", ");
}

/** 0..16, or a thrown error naming everything it would have taken. */
function __resolveLabel(label) {
  if (typeof label === "number") {
    if (label !== Math.floor(label) || label < 0 || label > 16) {
      throw new Error("label must be a whole number 0-16 or a colour name (" + __labelNameList() + "); got " + label);
    }
    return label;
  }
  var key = __labelKey(label);
  if (__LABEL_NAMES.hasOwnProperty(key)) return __LABEL_NAMES[key];
  throw new Error("unknown label \"" + label + "\" — use 0-16 or one of: " + __labelNameList());
}

function __basename(p) {
  var s = String(p).replace(/\\/g, "/");
  var slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.substring(slash + 1);
  return s;
}

function __stripExtension(name) {
  var s = String(name);
  var dot = s.lastIndexOf(".");
  if (dot > 0) return s.substring(0, dot);
  return s;
}

/**
 * The Audio Levels property of a layer.
 *
 * `layer.audioLevels` is the shortcut that works. `layer.property("ADBE Audio
 * Levels")` returns null on an audio layer — the property sits inside the
 * layer's "Audio" group, not on the layer — and a null there is what silently
 * turns a scripted level into no level at all. The group walk is only a
 * fallback for a layer whose shortcut is somehow absent; if neither answers,
 * the caller is told rather than left with an unset level.
 */
function __audioLevelsProperty(layer) {
  var p = null;
  try { p = layer.audioLevels; } catch (e) {}
  if (p) return p;
  try {
    var g = layer.property("Audio");
    if (g) p = g.property("Audio Levels");
  } catch (e2) {}
  return p;
}

/** null when the item can carry an audio cue, else the reason it cannot. */
function __audioItemProblem(item) {
  if (item instanceof FolderItem) return "\"" + item.name + "\" is a folder, not footage";
  if (item instanceof CompItem) return "\"" + item.name + "\" is a comp — use create_precomp_layer for that";
  if (item.footageMissing) return "\"" + item.name + "\" is offline; the file it points at is missing";
  // Explicitly `=== false`, not `!item.hasAudio`: an item that does not report
  // the flag at all must not be refused on the strength of a missing property.
  if (item.hasAudio === false) return "\"" + item.name + "\" has no audio track";
  return null;
}

function __sourceReport(item, path) {
  return { itemId: item.id, name: item.name, path: path };
}

/**
 * Turn the cue list into a plan, touching nothing. Every problem found is
 * collected with the index of the cue that caused it rather than thrown on the
 * spot, so one call reports all of them instead of one per round trip.
 */
function __planAudioCues(comp, args) {
  var cues = args.cues;
  if (!(cues instanceof Array) || cues.length === 0) {
    throw new Error("place_audio_cues needs a non-empty `cues` array.");
  }
  if (cues.length > __MAX_AUDIO_CUES) {
    throw new Error(
      "place_audio_cues was given " + cues.length + " cues and the limit is " + __MAX_AUDIO_CUES + " per call. " +
      "ExtendScript is single-threaded, so one long run freezes After Effects' interface for its whole duration. " +
      "Split the list into calls of " + __MAX_AUDIO_CUES + " or fewer."
    );
  }

  var prefix = "SFX_";
  if (typeof args.namePrefix === "string") prefix = args.namePrefix;

  var byPath = __itemPathMap();
  var problems = [];
  var planned = [];
  var toImport = [];
  var toImportSeen = {};

  for (var i = 0; i < cues.length; i++) {
    var cue = cues[i];
    if (!cue) { problems.push({ cue: i, reason: "is empty" }); continue; }

    var hasId = (cue.footageId !== undefined && cue.footageId !== null);
    var hasPath = (typeof cue.path === "string" && cue.path.length > 0);
    if (hasId && hasPath) { problems.push({ cue: i, reason: "has both footageId and path — give exactly one" }); continue; }
    if (!hasId && !hasPath) { problems.push({ cue: i, reason: "has neither footageId nor path — give exactly one" }); continue; }

    var time = cue.time;
    if (typeof time !== "number" || !isFinite(time)) {
      problems.push({ cue: i, reason: "time must be a number of seconds; got " + String(time) });
      continue;
    }
    if (time < -__CUE_TIME_EPS || time > comp.duration + __CUE_TIME_EPS) {
      problems.push({ cue: i, reason: "time " + time + "s is outside the comp, which runs 0 to " + comp.duration + "s" });
      continue;
    }

    var levelDb = 0;
    if (cue.levelDb !== undefined && cue.levelDb !== null) {
      if (typeof cue.levelDb !== "number" || !isFinite(cue.levelDb)) {
        problems.push({ cue: i, reason: "levelDb must be a number of decibels (0 is unedited); got " + String(cue.levelDb) });
        continue;
      }
      levelDb = cue.levelDb;
    }

    var inPoint = null;
    var outPoint = null;
    var trimBad = false;
    if (cue.inPoint !== undefined && cue.inPoint !== null) {
      if (typeof cue.inPoint !== "number" || !isFinite(cue.inPoint)) {
        problems.push({ cue: i, reason: "inPoint must be a comp time in seconds; got " + String(cue.inPoint) });
        trimBad = true;
      } else {
        inPoint = cue.inPoint;
      }
    }
    if (!trimBad && cue.outPoint !== undefined && cue.outPoint !== null) {
      if (typeof cue.outPoint !== "number" || !isFinite(cue.outPoint)) {
        problems.push({ cue: i, reason: "outPoint must be a comp time in seconds; got " + String(cue.outPoint) });
        trimBad = true;
      } else {
        outPoint = cue.outPoint;
      }
    }
    if (trimBad) continue;
    // in/out are absolute comp times, like everywhere else in these tools, so
    // they are measured against `time` rather than against the file.
    if (inPoint !== null && inPoint < time - __CUE_TIME_EPS) {
      problems.push({ cue: i, reason: "inPoint " + inPoint + "s is before the cue's own time " + time + "s; both are comp times" });
      continue;
    }
    var trimStart = time;
    if (inPoint !== null) trimStart = inPoint;
    if (outPoint !== null && outPoint <= trimStart + __CUE_TIME_EPS) {
      problems.push({ cue: i, reason: "outPoint " + outPoint + "s is not after the cue starts at " + trimStart + "s" });
      continue;
    }

    var label = null;
    if (cue.label !== undefined && cue.label !== null) {
      try {
        label = __resolveLabel(cue.label);
      } catch (eLabel) {
        problems.push({ cue: i, reason: eLabel.message });
        continue;
      }
    }

    // Resolve the source. A footageId names an item that must already be
    // usable; a path is either something the project already holds or an
    // import this call will do exactly once.
    var source = null;
    var defaultName = null;
    if (hasId) {
      var item = app.project.itemByID(cue.footageId);
      if (!item) { problems.push({ cue: i, reason: "no project item with id " + cue.footageId }); continue; }
      var why = __audioItemProblem(item);
      if (why) { problems.push({ cue: i, reason: why }); continue; }
      source = { kind: "item", item: item, fsName: null, path: null };
      defaultName = item.name;
    } else {
      var file = new File(cue.path);
      if (!file.exists) { problems.push({ cue: i, reason: "no file at " + cue.path }); continue; }
      var fsName = String(file.fsName);
      var existing = null;
      if (byPath.hasOwnProperty(fsName)) existing = byPath[fsName];
      if (existing) {
        var whyExisting = __audioItemProblem(existing);
        if (whyExisting) { problems.push({ cue: i, reason: whyExisting + " (already in the project from " + cue.path + ")" }); continue; }
        source = { kind: "reused", item: existing, fsName: fsName, path: cue.path };
      } else {
        if (!toImportSeen.hasOwnProperty(fsName)) {
          toImportSeen[fsName] = true;
          toImport.push({ fsName: fsName, path: cue.path, file: file });
        }
        source = { kind: "import", item: null, fsName: fsName, path: cue.path };
      }
      // The caller named a path, so the path's basename is the honest default
      // even when the project item it resolves to was renamed by hand.
      defaultName = __basename(cue.path);
    }

    var name = prefix + __stripExtension(defaultName);
    if (typeof cue.name === "string" && cue.name.length > 0) name = cue.name;

    planned.push({
      index: i, name: name, time: time, levelDb: levelDb,
      inPoint: inPoint, outPoint: outPoint, label: label, source: source
    });
  }

  return { prefix: prefix, planned: planned, problems: problems, toImport: toImport };
}

function __audioProblemMessage(problems, total) {
  var lines = [];
  for (var i = 0; i < problems.length; i++) {
    lines.push("cue " + problems[i].cue + ": " + problems[i].reason);
  }
  return (
    "place_audio_cues placed nothing — " + problems.length + " of " + total + " cues cannot be placed. " +
    lines.join("; ") + ". Every cue is checked before anything is created, so the comp and project are " +
    "untouched. Fix these and call again; dryRun:true checks a list without placing it."
  );
}

function __audioDryRunReport(comp, plan, total) {
  var cues = [];
  for (var i = 0; i < plan.planned.length; i++) {
    var p = plan.planned[i];
    var src = { kind: p.source.kind };
    if (p.source.item) {
      src.itemId = p.source.item.id;
      src.name = p.source.item.name;
    }
    if (p.source.path) src.path = p.source.path;
    cues.push({
      cue: p.index, name: p.name, time: p.time, levelDb: p.levelDb,
      inPoint: p.inPoint, outPoint: p.outPoint, label: p.label, source: src
    });
  }
  var wouldImport = [];
  for (var j = 0; j < plan.toImport.length; j++) wouldImport.push(plan.toImport[j].path);

  var out = {
    dryRun: true,
    ok: plan.problems.length === 0,
    compId: comp.id,
    compName: comp.name,
    cueCount: total,
    wouldPlace: cues.length,
    wouldImport: wouldImport,
    problems: plan.problems,
    cues: cues,
    note: "Nothing was imported, created or changed, and this call is not an undo step."
  };
  if (wouldImport.length > 0) {
    out.unverified =
      wouldImport.length + " of these files are not in the project yet. They exist on disk, but whether each " +
      "carries an audio track is only knowable once After Effects has imported it — a real run checks that and " +
      "refuses the whole call if one does not.";
  }
  return out;
}

/** Undo everything this call made, newest first. Layers before items: an item still in use cannot go. */
function __rollbackAudioCues(layers, items) {
  for (var i = layers.length - 1; i >= 0; i--) {
    try { layers[i].remove(); } catch (e) {}
  }
  for (var j = items.length - 1; j >= 0; j--) {
    try { items[j].remove(); } catch (e2) {}
  }
}

/**
 * `created` is the rollback list, and the layer joins it the instant it exists
 * rather than once it is fully configured. A cue that dies between add() and
 * the last setValue is exactly the case rollback is for, and a layer that had
 * not been registered yet would be the one thing left behind.
 */
function __placeAudioCue(comp, p, item, created) {
  var layer = comp.layers.add(item);
  created.push(layer);
  layer.name = p.name;
  // startTime first: it slides the whole layer and would drag any trim with it.
  layer.startTime = p.time;
  var levels = __audioLevelsProperty(layer);
  if (!levels) {
    throw new Error(
      "the layer created for \"" + item.name + "\" has no Audio Levels property, so its level could not be set"
    );
  }
  // AE's Audio Levels is itself in decibels, one entry per channel.
  levels.setValue([p.levelDb, p.levelDb]);
  if (p.label !== null) layer.label = p.label;
  if (p.inPoint !== null) layer.inPoint = p.inPoint;
  if (p.outPoint !== null) layer.outPoint = p.outPoint;
  return layer;
}

OPS.place_audio_cues = noUndoWhen(
  // dryRun is not an undo step either. A plan that quietly appeared in the
  // user's undo history would make "this changed nothing" false in the one
  // place they can see it.
  function (args) { return !!(args && args.dryRun === true); },
  function (args) {
    var comp = getCompById(args.compId);
    var total = 0;
    if (args.cues instanceof Array) total = args.cues.length;
    var plan = __planAudioCues(comp, args);

    if (args.dryRun === true) return __audioDryRunReport(comp, plan, total);
    if (plan.problems.length > 0) throw new Error(__audioProblemMessage(plan.problems, total));

    var createdLayers = [];
    var importedItems = [];
    var importedReport = [];
    var reusedReport = [];
    var reusedSeen = {};
    var placed = [];

    try {
      // One import per distinct file, before any layer exists, so a bad file
      // costs nothing but the import itself.
      var imported = {};
      for (var i = 0; i < plan.toImport.length; i++) {
        var spec = plan.toImport[i];
        var newItem = __importFile(spec.file, spec.path, false);
        importedItems.push(newItem);
        var why = __audioItemProblem(newItem);
        if (why) throw new Error("imported " + spec.path + " and then found that " + why);
        imported[spec.fsName] = newItem;
        importedReport.push(__sourceReport(newItem, spec.path));
      }

      for (var k = 0; k < plan.planned.length; k++) {
        var p = plan.planned[k];
        var item = p.source.item;
        if (!item) item = imported[p.source.fsName];
        if (p.source.kind !== "import" && !reusedSeen.hasOwnProperty(String(item.id))) {
          reusedSeen[String(item.id)] = true;
          reusedReport.push(__sourceReport(item, p.source.path));
        }
        var layer;
        try {
          layer = __placeAudioCue(comp, p, item, createdLayers);
        } catch (eCue) {
          throw new Error("cue " + p.index + " (\"" + p.name + "\" at " + p.time + "s): " + eCue.message);
        }
        placed.push({
          layerId: layer.id,
          index: layer.index,
          name: layer.name,
          time: p.time,
          levelDb: p.levelDb,
          itemId: item.id,
          // Read the trim back: AE clamps an in/out point to what the source
          // can actually supply, and the caller should see what it got.
          inPoint: layer.inPoint,
          outPoint: layer.outPoint,
          label: layer.label
        });
      }
    } catch (e) {
      __rollbackAudioCues(createdLayers, importedItems);
      throw new Error(
        "place_audio_cues failed on " + ((e && e.message) ? e.message : String(e)) +
        ". The " + createdLayers.length + " layer(s) and " + importedItems.length +
        " import(s) it had already made were removed, so the comp and project are as they were."
      );
    }

    return {
      compId: comp.id,
      placed: placed,
      count: placed.length,
      sources: { imported: importedReport, reused: reusedReport },
      levelUnit: "dB"
    };
  }
);
