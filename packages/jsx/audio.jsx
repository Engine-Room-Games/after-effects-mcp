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
//
// Three per-cue options (issue #85) — `loop`, `fadeIn`/`fadeOut`, `stretch` —
// are the patterns every scoring pass used to re-implement in a run_jsx
// follow-up. Each one moves something After Effects then quietly resets, so
// the order inside __placeAudioCue is load-bearing; see the comment there.

var __MAX_AUDIO_CUES = 200;
var __CUE_TIME_EPS = 1e-6;

// The level a fade starts from and ends at when the caller gives none. -48 dB
// is the bottom of the range After Effects' own Audio Levels slider offers, and
// 1/256 of the recorded amplitude — near-silence for a fade to begin from while
// staying inside the range a user can drag the property through by hand.
var __DEFAULT_FADE_FLOOR_DB = -48;

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

function __isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v);
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

/**
 * The Time Remap property of a layer that has remapping enabled. Same shape of
 * trap as Audio Levels: `layer.property("ADBE Time Remap")` is null on an
 * audio layer even after `timeRemapEnabled = true`, and the shortcut
 * `layer.timeRemap` is the handle that answers. The match-name lookup is kept
 * only as a fallback; a null from both is reported, never worked around.
 */
function __timeRemapProperty(layer) {
  var p = null;
  try { p = layer.timeRemap; } catch (e) {}
  if (p) return p;
  try { p = layer.property("ADBE Time Remapping"); } catch (e2) {}
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

/** The duration of a project item, or null when it does not say. */
function __itemDuration(item) {
  if (!item) return null;
  var d = null;
  try { d = item.duration; } catch (e) {}
  if (__isFiniteNumber(d)) return d;
  return null;
}

/**
 * Where a planned cue's layer will start and end, in comp time, given what is
 * known about its source. `end` is null when it cannot be known yet — an
 * unlooped cue on a file that has not been imported, with no outPoint to cap
 * it — and the caller decides what to do with that.
 */
function __cueExtent(p, itemDuration) {
  var start = p.time;
  if (p.inPoint !== null) start = p.inPoint;
  var end = null;
  if (p.loop) {
    // A loop has no natural end, so its end is the one the caller gave or the
    // comp's, whichever the planner settled on.
    end = p.loopEnd;
  } else {
    var natural = null;
    if (__isFiniteNumber(itemDuration)) natural = p.time + itemDuration * p.stretchFactor;
    end = p.outPoint;
    // AE clamps an out point to what the source can supply, so a requested
    // outPoint past the file's end is not where the layer will end.
    if (end === null || (natural !== null && natural < end)) end = natural;
  }
  return { start: start, end: end };
}

function __fmtSeconds(n) {
  // Rounded for prose only; nothing downstream reads these numbers back.
  return String(Math.round(n * 1000) / 1000) + "s";
}

/**
 * null when the cue's fades fit inside its extent; a reason string when they
 * do not; and the string "unknown" when the extent cannot be computed yet.
 * Pure — used at plan time and again after the imports, on the same plan.
 */
function __fadeFitProblem(p, extent) {
  var total = p.fadeIn + p.fadeOut;
  if (total <= 0 && !p.loop) return null;
  if (extent.end === null) {
    if (total <= 0) return null;
    return "unknown";
  }
  var dur = extent.end - extent.start;
  var span = " (from " + __fmtSeconds(extent.start) + " to " + __fmtSeconds(extent.end) + ")";
  if (dur <= __CUE_TIME_EPS) {
    if (p.loop) {
      var why = "the comp's end, since no outPoint was given";
      if (p.outPoint !== null) why = "its outPoint";
      return "inPoint " + __fmtSeconds(extent.start) + " is not before the end of the loop at " + __fmtSeconds(extent.end) + " (" + why + ")";
    }
    return "inPoint " + __fmtSeconds(extent.start) + " is past where the cue ends" + span;
  }
  if (total <= 0) return null;
  if (total > dur + __CUE_TIME_EPS) {
    var what;
    if (p.fadeIn > 0 && p.fadeOut > 0) {
      what = "fadeIn " + __fmtSeconds(p.fadeIn) + " + fadeOut " + __fmtSeconds(p.fadeOut) + " = " + __fmtSeconds(total);
    } else if (p.fadeIn > 0) {
      what = "fadeIn " + __fmtSeconds(p.fadeIn);
    } else {
      what = "fadeOut " + __fmtSeconds(p.fadeOut);
    }
    var tail = "";
    if (!p.loop && p.outPoint === null) tail = " — the file's own length, with no outPoint to extend it and no loop";
    return what + " is longer than the cue, which runs " + __fmtSeconds(dur) + span + tail;
  }
  return null;
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

  // One floor for the whole list: it is a property of the mix, not of a cue.
  var floorDb = __DEFAULT_FADE_FLOOR_DB;
  if (args.fadeFloorDb !== undefined && args.fadeFloorDb !== null) {
    if (!__isFiniteNumber(args.fadeFloorDb)) {
      throw new Error("fadeFloorDb must be a number of decibels (the default is " + __DEFAULT_FADE_FLOOR_DB + "); got " + String(args.fadeFloorDb));
    }
    floorDb = args.fadeFloorDb;
  }

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
    if (!__isFiniteNumber(time)) {
      problems.push({ cue: i, reason: "time must be a number of seconds; got " + String(time) });
      continue;
    }
    if (time < -__CUE_TIME_EPS || time > comp.duration + __CUE_TIME_EPS) {
      problems.push({ cue: i, reason: "time " + time + "s is outside the comp, which runs 0 to " + comp.duration + "s" });
      continue;
    }

    var levelDb = 0;
    if (cue.levelDb !== undefined && cue.levelDb !== null) {
      if (!__isFiniteNumber(cue.levelDb)) {
        problems.push({ cue: i, reason: "levelDb must be a number of decibels (0 is unedited); got " + String(cue.levelDb) });
        continue;
      }
      levelDb = cue.levelDb;
    }

    var inPoint = null;
    var outPoint = null;
    var trimBad = false;
    if (cue.inPoint !== undefined && cue.inPoint !== null) {
      if (!__isFiniteNumber(cue.inPoint)) {
        problems.push({ cue: i, reason: "inPoint must be a comp time in seconds; got " + String(cue.inPoint) });
        trimBad = true;
      } else {
        inPoint = cue.inPoint;
      }
    }
    if (!trimBad && cue.outPoint !== undefined && cue.outPoint !== null) {
      if (!__isFiniteNumber(cue.outPoint)) {
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

    // The #85 options. Type-checked here, before the source is resolved, so a
    // cue with a bad stretch AND a missing file reports the first of the two
    // it hits — every cue still gets a line, which is what matters.
    var loop = false;
    if (cue.loop !== undefined && cue.loop !== null) {
      if (cue.loop !== true && cue.loop !== false) {
        problems.push({ cue: i, reason: "loop must be true or false; got " + String(cue.loop) });
        continue;
      }
      loop = cue.loop;
    }
    var stretch = null;
    if (cue.stretch !== undefined && cue.stretch !== null) {
      if (!__isFiniteNumber(cue.stretch) || cue.stretch <= 0) {
        problems.push({ cue: i, reason: "stretch must be a percentage greater than 0 (100 is unchanged, 200 is half speed); got " + String(cue.stretch) });
        continue;
      }
      stretch = cue.stretch;
    }
    var fadeIn = 0;
    var fadeOut = 0;
    var fadeBad = false;
    if (cue.fadeIn !== undefined && cue.fadeIn !== null) {
      if (!__isFiniteNumber(cue.fadeIn) || cue.fadeIn < 0) {
        problems.push({ cue: i, reason: "fadeIn must be a number of seconds, 0 or more; got " + String(cue.fadeIn) });
        fadeBad = true;
      } else {
        fadeIn = cue.fadeIn;
      }
    }
    if (!fadeBad && cue.fadeOut !== undefined && cue.fadeOut !== null) {
      if (!__isFiniteNumber(cue.fadeOut) || cue.fadeOut < 0) {
        problems.push({ cue: i, reason: "fadeOut must be a number of seconds, 0 or more; got " + String(cue.fadeOut) });
        fadeBad = true;
      } else {
        fadeOut = cue.fadeOut;
      }
    }
    if (fadeBad) continue;
    if ((fadeIn > 0 || fadeOut > 0) && floorDb >= levelDb) {
      problems.push({
        cue: i,
        reason: "fadeFloorDb " + floorDb + " is not below the cue's level " + levelDb + " dB, so its fade would go nowhere — lower the floor or raise the level"
      });
      continue;
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

    var stretchFactor = 1;
    if (stretch !== null) stretchFactor = stretch / 100;
    // A looped cue needs an end, because a loop has none of its own.
    var loopEnd = null;
    if (loop) {
      loopEnd = comp.duration;
      if (outPoint !== null) loopEnd = outPoint;
    }

    var p = {
      index: i, name: name, time: time, levelDb: levelDb,
      inPoint: inPoint, outPoint: outPoint, label: label, source: source,
      loop: loop, loopEnd: loopEnd, stretch: stretch, stretchFactor: stretchFactor,
      fadeIn: fadeIn, fadeOut: fadeOut,
      // true when the fade could not be measured against the file yet
      fadeUnchecked: false
    };

    // Does the cue fit? Known now for a loop (its end is chosen here), for a
    // footageId or reused item (After Effects reports its duration) and for a
    // capped outPoint; not yet for an unlooped cue on a file still to import.
    var fit = __fadeFitProblem(p, __cueExtent(p, __itemDuration(source.item)));
    if (fit === "unknown") {
      p.fadeUnchecked = true;
    } else if (fit !== null) {
      problems.push({ cue: i, reason: fit });
      continue;
    }

    planned.push(p);
  }

  return { prefix: prefix, planned: planned, problems: problems, toImport: toImport, floorDb: floorDb };
}

function __audioProblemLines(problems) {
  var lines = [];
  for (var i = 0; i < problems.length; i++) {
    lines.push("cue " + problems[i].cue + ": " + problems[i].reason);
  }
  return lines.join("; ");
}

function __audioProblemMessage(problems, total) {
  return (
    "place_audio_cues placed nothing — " + problems.length + " of " + total + " cues cannot be placed. " +
    __audioProblemLines(problems) + ". Every cue is checked before anything is created, so the comp and project are " +
    "untouched. Fix these and call again; dryRun:true checks a list without placing it."
  );
}

/**
 * Counts and the two lists a caller cannot work out alone — what would be
 * imported and what is already there — plus the failing cues. Never the
 * resolved list: a 7-cue "all fine" used to cost ~1.5k tokens of echo (#88).
 */
function __audioDryRunReport(comp, plan, total) {
  var wouldImport = [];
  for (var j = 0; j < plan.toImport.length; j++) wouldImport.push(plan.toImport[j].path);

  var wouldReuse = [];
  var reuseSeen = {};
  var looped = 0;
  var faded = 0;
  var stretched = 0;
  var fadesUnchecked = 0;
  for (var i = 0; i < plan.planned.length; i++) {
    var p = plan.planned[i];
    if (p.source.item && !reuseSeen.hasOwnProperty(String(p.source.item.id))) {
      reuseSeen[String(p.source.item.id)] = true;
      var r = { itemId: p.source.item.id, name: p.source.item.name };
      if (p.source.path) r.path = p.source.path;
      wouldReuse.push(r);
    }
    if (p.loop) looped++;
    if (p.fadeIn > 0 || p.fadeOut > 0) faded++;
    if (p.stretch !== null) stretched++;
    if (p.fadeUnchecked) fadesUnchecked++;
  }

  var out = {
    dryRun: true,
    ok: plan.problems.length === 0,
    compId: comp.id,
    compName: comp.name,
    cueCount: total,
    wouldPlace: plan.planned.length,
    wouldImport: wouldImport,
    wouldReuse: wouldReuse,
    problems: plan.problems,
    note: "Nothing was imported, created or changed, and this call is not an undo step."
  };
  if (looped > 0) out.looped = looped;
  if (faded > 0) out.faded = faded;
  if (stretched > 0) out.stretched = stretched;
  if (wouldImport.length > 0) {
    var fadeNote = "";
    if (fadesUnchecked > 0) {
      fadeNote = " — and, for " + fadesUnchecked + " cue(s) with a fade, whether the fade fits the file's length —";
    }
    out.unverified =
      wouldImport.length + " of these files are not in the project yet. They exist on disk, but whether each " +
      "carries an audio track" + fadeNote + " is only knowable once After Effects has imported it; a real run checks " +
      "that and refuses the whole call if one does not.";
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
 * The Time Remap expression that loops a cue. It is the pattern measured in
 * issue #85 — comp time since the layer began, wrapped at the file's length —
 * with two substitutions: `startTime` rather than `inPoint`, so trimming the
 * in point hides the front of the file the way it does on every other layer
 * instead of delaying it; and the source's duration read live off the layer,
 * so a relinked file keeps looping. An expression cannot read a layer's
 * stretch, so a stretched cue has its factor baked in, and that constant goes
 * stale if the stretch is changed by hand afterwards.
 */
function __loopExpression(p) {
  var elapsed = "(time - startTime)";
  if (p.stretch !== null && p.stretch !== 100) elapsed = "((time - startTime) * 100 / " + p.stretch + ")";
  return elapsed + " % thisLayer.source.duration";
}

/**
 * `created` is the rollback list, and the layer joins it the instant it exists
 * rather than once it is fully configured. A cue that dies between add() and
 * the last setValue is exactly the case rollback is for, and a layer that had
 * not been registered yet would be the one thing left behind.
 *
 * The order after that is not free to change. Each of the #85 options moves
 * something After Effects then resets: `stretch` moves startTime, so startTime
 * is set after it; enabling time remap resets the out point, so the extent is
 * set after that; and the fade keys sit at the in/out the layer actually has,
 * so they go last. Out point before in point throughout — extending first is
 * what lets an in point past the file's natural end land on a looped layer.
 */
function __placeAudioCue(comp, p, item, created, floorDb) {
  var layer = comp.layers.add(item);
  created.push(layer);
  layer.name = p.name;
  if (p.stretch !== null) layer.stretch = p.stretch;
  // startTime first: it slides the whole layer and would drag any trim with it.
  layer.startTime = p.time;
  var levels = __audioLevelsProperty(layer);
  if (!levels) {
    throw new Error(
      "the layer created for \"" + item.name + "\" has no Audio Levels property, so its level could not be set"
    );
  }
  if (p.label !== null) layer.label = p.label;

  if (p.loop) {
    // `=== false`, as with hasAudio: a layer that does not answer the question
    // is not refused on the strength of a missing property.
    if (layer.canSetTimeRemapEnabled === false) {
      throw new Error(
        "After Effects reports that time remapping cannot be enabled on the layer created for \"" + item.name + "\", so it cannot loop"
      );
    }
    layer.timeRemapEnabled = true;
    var remap = __timeRemapProperty(layer);
    if (!remap) {
      throw new Error(
        "time remapping was enabled on the layer created for \"" + item.name + "\" but its Time Remap property could not be found, so the loop expression could not be set"
      );
    }
    // The two keyframes AE created when remapping was enabled stay exactly
    // where they are. Removing them hides the property, and the next write to
    // it throws (issue #86); the expression overrides them anyway.
    remap.expression = __loopExpression(p);
    layer.outPoint = p.loopEnd;
    if (p.inPoint !== null) layer.inPoint = p.inPoint;
  } else {
    if (p.outPoint !== null) layer.outPoint = p.outPoint;
    if (p.inPoint !== null) layer.inPoint = p.inPoint;
  }

  // AE's Audio Levels is itself in decibels, one entry per channel.
  var level = [p.levelDb, p.levelDb];
  if (p.fadeIn > 0 || p.fadeOut > 0) {
    var inP = layer.inPoint;
    var outP = layer.outPoint;
    var dur = outP - inP;
    // The planner measured the fade against what it could know; this is the
    // extent After Effects actually gave the layer, and the last line.
    if (p.fadeIn + p.fadeOut > dur + __CUE_TIME_EPS) {
      throw new Error(
        "its fades (" + __fmtSeconds(p.fadeIn) + " in, " + __fmtSeconds(p.fadeOut) + " out) are longer than the " +
        __fmtSeconds(dur) + " After Effects gave the layer (" + __fmtSeconds(inP) + " to " + __fmtSeconds(outP) + ")"
      );
    }
    var floor = [floorDb, floorDb];
    if (p.fadeIn > 0) {
      levels.setValueAtTime(inP, floor);
      levels.setValueAtTime(inP + p.fadeIn, level);
    }
    if (p.fadeOut > 0) {
      levels.setValueAtTime(outP - p.fadeOut, level);
      levels.setValueAtTime(outP, floor);
    }
  } else {
    levels.setValue(level);
  }
  return layer;
}

/**
 * What the caller gets back per cue: the id it has to carry forward, the name,
 * the time, and — only where an option could have changed it — what After
 * Effects actually did. Never an echo of the request.
 */
function __placedEntry(layer, p) {
  var entry = { layerId: layer.id, name: layer.name, time: p.time };
  // Read the trim back: AE clamps an in/out point to what the source can
  // actually supply, and the caller should see what it got.
  if (p.inPoint !== null) entry.inPoint = layer.inPoint;
  if (p.outPoint !== null || p.loop || p.stretch !== null) entry.outPoint = layer.outPoint;
  if (p.loop) entry.looped = true;
  if (p.stretch !== null) entry.stretch = layer.stretch;
  if (p.fadeIn > 0) entry.fadeIn = p.fadeIn;
  if (p.fadeOut > 0) entry.fadeOut = p.fadeOut;
  return entry;
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
    var anyFade = false;

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

      // The fades the planner could not measure — on files it had not seen —
      // are measured now, with every duration known and no layer yet made, so
      // a misfit still names every offending cue at once and costs only the
      // imports, which the rollback takes back.
      var lateProblems = [];
      for (var f = 0; f < plan.planned.length; f++) {
        var pf = plan.planned[f];
        if (!pf.fadeUnchecked) continue;
        var fit = __fadeFitProblem(pf, __cueExtent(pf, __itemDuration(imported[pf.source.fsName])));
        if (fit === "unknown") {
          fit = "After Effects did not report a duration for the imported " + pf.source.path + ", so its fade cannot be checked";
        }
        if (fit !== null) lateProblems.push({ cue: pf.index, reason: fit });
      }
      if (lateProblems.length > 0) {
        throw new Error(
          "the fades on " + lateProblems.length + " cue(s) do not fit the files once imported — " + __audioProblemLines(lateProblems)
        );
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
          layer = __placeAudioCue(comp, p, item, createdLayers, plan.floorDb);
        } catch (eCue) {
          throw new Error("cue " + p.index + " (\"" + p.name + "\" at " + p.time + "s): " + eCue.message);
        }
        if (p.fadeIn > 0 || p.fadeOut > 0) anyFade = true;
        placed.push(__placedEntry(layer, p));
      }
    } catch (e) {
      __rollbackAudioCues(createdLayers, importedItems);
      throw new Error(
        "place_audio_cues failed on " + ((e && e.message) ? e.message : String(e)) +
        ". The " + createdLayers.length + " layer(s) and " + importedItems.length +
        " import(s) it had already made were removed, so the comp and project are as they were."
      );
    }

    var out = {
      compId: comp.id,
      placed: placed,
      count: placed.length,
      sources: { imported: importedReport, reused: reusedReport },
      levelUnit: "dB"
    };
    if (anyFade) out.fadeFloorDb = plan.floorDb;
    return out;
  }
);
