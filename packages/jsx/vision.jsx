// vision.jsx — saveFrameToPng wrapper, returns the temp file path which the
// MCP server then reads and base64-encodes (frames/pipeline.ts).

function __tmpPngPath() {
  var folder = Folder.temp;
  var name = "ae-mcp-" + (new Date().getTime()) + "-" + Math.floor(Math.random() * 1e6) + ".png";
  return folder.fsName + "/" + name;
}

function __clampDownsample(v) {
  if (v === undefined || v === null) return 1;
  var n = Math.round(v);
  if (!(n > 1)) return 1;
  return n > 8 ? 8 : n;
}

// The long edge we aim a screenshot at. ~1280px is still legible for checking
// type and layout, and costs roughly 1.2k image tokens instead of the 11k a
// full-resolution 4K frame costs.
var __SCREENSHOT_TARGET_PX = 1280;

// The correct downsample was always derivable from the comp, and an agent that
// forgot it got a full-resolution 4K frame — the most expensive accident
// available through these tools. So derive it, and let an explicit value win.
function __autoDownsampleFor(comp, targetPx) {
  var longEdge = comp.width > comp.height ? comp.width : comp.height;
  var n = Math.ceil(longEdge / targetPx);
  if (!(n > 1)) return 1;
  return n > 8 ? 8 : n;
}

// 1080p -> 2 (960px), 4K -> 3 (1280px), and anything already small -> 1.
function __autoDownsample(comp) {
  return __autoDownsampleFor(comp, __SCREENSHOT_TARGET_PX);
}

// A contact sheet of N frames has to cost about what one frame costs, so each
// tile gets 1/sqrt(N) of the single-frame long edge — N tiles of 1/N the area
// each. Expressed as a multiple of what this comp's *single* frame would have
// used rather than as its own target, for two reasons: it cannot drift from
// __autoDownsample, and the factor is an integer, so deriving from the target
// instead would let the rounding leave a 1080p sheet at nearly twice the budget.
function __tileDownsample(comp, count) {
  var n = Math.ceil(__autoDownsample(comp) * Math.sqrt(count));
  if (!(n > 1)) return 1;
  return n > 8 ? 8 : n;
}

function __resolveDownsample(comp, requested) {
  if (requested === undefined || requested === null) return __autoDownsample(comp);
  return __clampDownsample(requested);
}

// saveFrameToPng honours the comp's resolutionFactor, so AE can render the
// reduced frame directly instead of writing full size and resampling
// afterwards. That is faster (a quarter of the pixels at factor 2) and needs no
// external image tool, which is what makes it work off macOS.
//
// The factor always *names* the resolution the render happens at. Leaving it to
// the viewer rendered at whatever the user had left the Resolution dropdown on,
// so a comp parked at Quarter answered `downsample: 1` with a quarter-size frame
// and `downsample: 2` came back **larger** than `downsample: 1` (issue #72).
// Designers leave heavy comps at Quarter or Third as a matter of course, so that
// was the common case rather than a corner. The panel reads the real dimensions
// out of the PNG's IHDR, which means the response stayed honest while the
// *picture* was not the one asked for — the worse of the two failures, because
// an agent that can see a frame believes it.
//
// What the factor is never set on any more is the USER'S comp (issue #282).
// Setting it there and putting it back — and, for screenshot_layer, flipping
// every solo switch and putting them back — was visible: the Resolution
// dropdown and the solo column flickered in the user's own timeline while the
// frame rendered, and a crash mid-render would have left them flipped. So a
// screenshot that needs anything changed renders a TEMPORARY comp instead and
// removes it afterwards, in a finally:
//
//   * "wrapper" (screenshot_frame, contact sheets, the mogrt poster): a new
//     comp of the same size, aspect, rate and duration holding the user's comp
//     as one precomp layer, at the factor asked for. After Effects renders a
//     nested comp at the CONTAINING comp's resolution — that is what the
//     "Preserve resolution when nested" comp setting exists to switch off — so
//     a comp with that setting on takes the copy route below instead. Cheap: one
//     comp and one layer, whatever the user's comp holds.
//   * "copy" (screenshot_layer, and a comp that preserves its resolution when
//     nested): CompItem.duplicate() of the user's comp, the factor and the solo
//     switches set on the COPY. A copy renders exactly what the old in-place
//     solo rendered — parenting, track mattes, adjustment layers and
//     expressions that reach other layers all come along, which copying the one
//     layer into a fresh comp would have broken — and the user's comp is never
//     written. Dearer on a comp with hundreds of layers.
//   * "direct": the comp is already at the factor asked for (and, for a layer,
//     the target is already the only soloed layer). Nothing needs changing, so
//     the user's comp renders as it is, with nothing created and no undo step —
//     the zero-cost case issue #116 measured.
//
// What a temporary comp still costs, and cannot avoid: creating and removing an
// item are project changes. They share one named undo step,
// "AE MCP: screenshot" (#116's grouping, below) — undoing it is a no-op — and
// After Effects may mark the project as having unsaved changes. Project.dirty
// is read-only, so that cannot be put back; the result says so in `note` when a
// screenshot is what turned a saved project unsaved. Measured on 26.5 (recipe
// 78 in docs/verification-recipes.md): wrapper and copy frames are
// pixel-identical to the comp rendered at Full. The `isolation` field on every
// result says which route a frame took.
function __factorIs(rf, f) {
  return !!rf && rf[0] === f && rf[1] === f;
}

function __factorFor(factor) {
  return (factor > 1) ? Math.round(factor) : 1;
}

// The temporary comp's name and comment. The comment is what a later sweep or
// a person can recognise one by if a crash ever leaves one behind.
var __SCREENSHOT_TEMP_NAME = "AE MCP screenshot (temporary)";
var __SCREENSHOT_TEMP_TAG = "ae-mcp-screenshot-temp:v1";

function __projectDirty() {
  try {
    var d = app.project.dirty;
    return d === true ? true : (d === false ? false : null);
  } catch (e) { return null; }
}

function __preservesNestedResolution(comp) {
  try { return comp.preserveNestedResolution === true; } catch (e) { return false; }
}

// Comp-level render switches the wrapper mirrors from the user's comp. They
// decide nothing for the wrapper's one still layer, but if After Effects ever
// gates a nested comp's motion blur or frame blending on the containing comp's
// switch, the wrapper does not switch them off. The precomp LAYER's own
// switches are left at their defaults on purpose: motion blur on a precomp
// layer can blur the motion inside it, which would be a render the user's comp
// does not make.
var __WRAPPER_MIRRORED = [
  "displayStartTime", "motionBlur", "shutterAngle", "shutterPhase",
  "motionBlurSamplesPerFrame", "motionBlurAdaptiveSampleLimit", "frameBlending", "draft3d"
];

// Builds the temporary comp for a route and hands it to `use`; removes it
// afterwards whatever `use` did. `state.leftover` is set when the removal
// itself fails, so the caller can say so instead of reporting a clean success.
//
// `prepare(temp)` runs inside the same try as `use`, so a temp comp that was
// created and then could not be configured is still removed.
function __withTempComp(comp, route, f, state, prepare, use) {
  var temp = null;
  // The name a leftover is reported under. Known before anything can fail, so
  // a temp comp whose removal fails is named even when reading it back fails too.
  var tempName = __SCREENSHOT_TEMP_NAME;
  try {
    if (route === "copy") {
      temp = comp.duplicate();
      if (!temp) throw new Error("could not isolate the screenshot: After Effects did not create the temporary comp");
      // A duplicate lands beside the original as "<name> 2". Renamed and moved
      // to the project root at once, so it is recognisable as ours — the same
      // name and place as a wrapper — and never sits in the user's folder.
      try { temp.name = __SCREENSHOT_TEMP_NAME; } catch (eRn) { try { tempName = temp.name; } catch (eRn2) {} }
      try { temp.parentFolder = app.project.rootFolder; } catch (eF) {}
      if (temp.numLayers !== comp.numLayers) {
        throw new Error("could not isolate the screenshot: the temporary copy of comp " + comp.id + " has " +
          temp.numLayers + " layers where the comp has " + comp.numLayers);
      }
    } else {
      temp = app.project.items.addComp(__SCREENSHOT_TEMP_NAME, comp.width, comp.height,
        comp.pixelAspect, comp.duration, comp.frameRate);
    }
    if (!temp) throw new Error("could not isolate the screenshot: After Effects did not create the temporary comp");
    try { temp.comment = __SCREENSHOT_TEMP_TAG; } catch (eC) {}
    if (route !== "copy") {
      for (var m = 0; m < __WRAPPER_MIRRORED.length; m++) {
        var k = __WRAPPER_MIRRORED[m];
        try { temp[k] = comp[k]; } catch (eM) {}
      }
      temp.layers.add(comp);
    }
    temp.resolutionFactor = [f, f];
    if (prepare) prepare(temp);
    return use(temp);
  } finally {
    if (temp) {
      try {
        temp.remove();
      } catch (eR) {
        state.leftover = tempName;
      }
    }
  }
}

// The route a frame of `comp` at factor `f` takes. See the long note above.
// A wrapper is only chosen when it renders what the comp itself would. Two
// things send a comp to the copy route instead: preserving its resolution when
// nested (the wrapper's factor would not reach it), and an enabled guide layer
// — After Effects leaves guide layers out of a nested comp's render, while the
// comp rendered directly shows them, so the wrapper would answer with a
// different picture from the "direct" route. A layer AE will not report on
// counts as a guide layer: the copy is never wrong, only dearer.
function __hasEnabledGuideLayer(comp) {
  try {
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (l.guideLayer === true && l.enabled !== false) return true;
    }
  } catch (e) { return true; }
  return false;
}

function __frameRoute(comp, f) {
  if (__factorIs(comp.resolutionFactor, f)) return "direct";
  if (__preservesNestedResolution(comp) || __hasEnabledGuideLayer(comp)) return "copy";
  return "wrapper";
}

// Render several times of `comp` at factor `factor` through one route, one
// temp comp for all of them. `renderAll(source)` does the saveFrameToPng calls
// against whichever comp it is handed.
function __renderIsolated(comp, factor, state, renderAll) {
  var f = __factorFor(factor);
  var route = __frameRoute(comp, f);
  state.isolation = route;
  if (route === "direct") return renderAll(comp);
  return __withTempComp(comp, route, f, state, null, renderAll);
}

// One frame, the one-call form. mogrt.jsx's poster renders through this. It
// returns the state so a caller can surface a leftover temp comp.
function __saveFrameAt(comp, time, file, factor) {
  var state = {};
  __renderIsolated(comp, factor, state, function (src) { src.saveFrameToPng(time, file); });
  return state;
}

// The one undo step a screenshot is allowed to cost (issue #116).
//
// A screenshot changes nothing in the user's comp, but the temporary comp it
// renders through is created, configured and removed, and After Effects
// records each of those as a step. Grouped, they collapse into one step the
// user can recognise by name in Edit > History.
//
// Three rules, all of which the tests hold:
//   * no group at all when nothing is created — the "direct" route — so that
//     case costs zero steps;
//   * no group of our own when one of ours is already open (a screenshot inside
//     run_batch, or the dispatcher's group around another op): AE's groups do
//     not nest, and an inner endUndoGroup would close the outer one and leave
//     the rest of that batch ungrouped. The temp comp joins the step already open;
//   * the group goes through withUndo, so it opens and closes inside this one
//     evalScript call and is counted by __beginUndoGroup like every other.
// The ops stay `noUndo` at the dispatcher for exactly this reason: the decision
// depends on the comp's state, which dispatch() cannot see.
var __SCREENSHOT_UNDO_NAME = "AE MCP: screenshot";

function __screenshotGroup(needed, fn) {
  if (!needed || __UNDO_OPEN) return fn();
  return withUndo(__SCREENSHOT_UNDO_NAME, fn);
}

// What the result says about the temporary comp, when there is anything to say.
// `wasDirty` is Project.dirty before the call; only a project that was saved and
// is unsaved now is worth a sentence.
function __isolationNote(state, wasDirty) {
  var parts = [];
  if (state.leftover) {
    parts.push("The screenshot rendered, but the temporary comp it rendered through (\"" + state.leftover +
      "\") could not be removed. Delete it from the Project panel; nothing else in the project uses it.");
  }
  if (state.isolation && state.isolation !== "direct" && wasDirty === false && __projectDirty() === true) {
    parts.push("After Effects now shows the project as having unsaved changes: the screenshot rendered " +
      "through a temporary comp, which counts as a change even though it was removed again. Nothing in the " +
      "user's comps changed. Mention it only if the user asks why the project looks modified.");
  }
  return parts.length ? parts.join(" ") : null;
}

function __withIsolationFields(result, state, wasDirty) {
  result.isolation = state.isolation;
  var note = __isolationNote(state, wasDirty);
  if (note) result.note = note;
  return result;
}

// Several times in one call. Every requested time gets an entry, in order,
// whether or not it rendered — the panel draws a marked block for the ones that
// did not, so the sheet it composes still lines up with the times that were
// asked for. Dropping a failed tile would silently renumber the rest, which is
// the same class of lie as swallowing an error.
function __contactSheetFrames(comp, args) {
  var times = args.times;
  var ds;
  if (args.downsample === undefined || args.downsample === null) {
    ds = __tileDownsample(comp, times.length);
  } else {
    ds = __clampDownsample(args.downsample);
  }
  var tiles = [];
  var state = {};
  var wasDirty = __projectDirty();
  // Every tile renders at the same factor through the same temporary comp, so
  // the whole sheet is one undo step at most rather than one per tile.
  __screenshotGroup(__frameRoute(comp, __factorFor(ds)) !== "direct", function () {
    __renderIsolated(comp, ds, state, function (src) {
      for (var i = 0; i < times.length; i++) {
        var entry = { time: times[i], downsample: ds };
        try {
          var p = __tmpPngPath();
          src.saveFrameToPng(times[i], new File(p));
          entry.path = p;
        } catch (e) {
          // One time that will not render must not cost the other five.
          entry.error = String(e && e.message ? e.message : e);
        }
        tiles.push(entry);
      }
    });
  });
  return __withIsolationFields({
    contactSheet: true,
    tiles: tiles,
    downsample: ds,
    width: comp.width, height: comp.height,
    times: times, compId: comp.id
  }, state, wasDirty);
}

OPS.screenshot_frame = noUndo(function (args) {
  var c = getCompById(args.compId);
  if (args.times && args.times.length) return __contactSheetFrames(c, args);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var ds = __resolveDownsample(c, args.downsample);
  var path = __tmpPngPath();
  var f = new File(path);
  var state = {};
  var wasDirty = __projectDirty();
  // saveFrameToPng is async-ish; the server polls the file's existence/size.
  __screenshotGroup(__frameRoute(c, __factorFor(ds)) !== "direct", function () {
    __renderIsolated(c, ds, state, function (src) { src.saveFrameToPng(t, f); });
  });
  return __withIsolationFields({
    path: path,
    width: c.width, height: c.height,
    downsample: ds,
    time: t, compId: c.id
  }, state, wasDirty);
});

// The solo switches a copy of `comp` needs so only layer index `targetIndex`
// renders: every layer whose solo is not already what it should be, by index —
// a duplicate keeps the layer order and gives every layer a new id.
function __soloPlan(comp, targetIndex) {
  var plan = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    var want = (i === targetIndex);
    if (comp.layer(i).solo !== want) plan.push({ index: i, want: want });
  }
  return plan;
}

OPS.screenshot_layer = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  // After Effects will not solo a switched-off layer ("Solo flag can not be
  // set..."), and a switched-off layer renders nothing anyway. Refused before
  // anything is created, in words an agent can act on.
  if (l.enabled === false) {
    throw new Error("screenshot_layer: layer " + l.id + " (\"" + l.name + "\") is switched off (its eye is " +
      "off), so it renders nothing and After Effects will not solo it. Nothing was changed. Switch it on with " +
      "set_layer({enabled: true}) first if the user wants it visible, or use screenshot_frame for the comp.");
  }
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var ds = __resolveDownsample(c, args.downsample);
  var fac = __factorFor(ds);
  var targetIndex = l.index;
  var targetName = l.name;
  // Read only: nothing in the user's comp is assigned. The switches are set on
  // a copy, and only the ones that are actually wrong.
  var plan = __soloPlan(c, targetIndex);
  var route = (plan.length === 0 && __factorIs(c.resolutionFactor, fac)) ? "direct" : "copy";
  var path = __tmpPngPath();
  var f = new File(path);
  var state = { isolation: route };
  var wasDirty = __projectDirty();
  __screenshotGroup(route !== "direct", function () {
    if (route === "direct") {
      c.saveFrameToPng(t, f);
      return;
    }
    __withTempComp(c, "copy", fac, state, function (copy) {
      var target = copy.layer(targetIndex);
      if (!target || target.name !== targetName) {
        throw new Error("could not isolate layer " + l.id + " for the screenshot: the temporary copy of comp " +
          c.id + " has a different layer at index " + targetIndex);
      }
      for (var k = 0; k < plan.length; k++) copy.layer(plan[k].index).solo = plan[k].want;
    }, function (copy) {
      copy.saveFrameToPng(t, f);
    });
  });
  return __withIsolationFields({
    path: path,
    width: c.width, height: c.height,
    downsample: ds,
    time: t, compId: c.id, layerId: l.id
  }, state, wasDirty);
});

// The same two renders under the internal names the server sends (issue #220,
// stage 4); the paths above come back as they are and the server reads the
// files itself. Since #243 the panel no longer post-processes the public names
// either — they stay as the handler each tool is keyed by (and a direct /op),
// and are refused as run_batch steps. One function object each, so the
// dispatcher's flags cannot drift between the two names.
OPS._screenshot_frame = OPS.screenshot_frame;
OPS._screenshot_layer = OPS.screenshot_layer;
