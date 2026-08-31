// footage.jsx — import a file into the project, and refuse to hand back an
// asset that After Effects imported wrongly.
//
// Import exists here for one reason: it is the only place a viewBox check has
// to live. AE's SVG importer fabricates pixel dimensions for an SVG whose
// viewBox uses a very large coordinate space, and then rasterizes nothing — no
// error at any stage, a footage item that looks healthy in the project panel,
// and an empty frame wherever it is placed (issue #33). The agent doing the
// import is the only thing in the loop that knows an import happened, so a
// guide can tell it what to compare; a tool can compare it.
//
// The check is the one from that report: the aspect ratio the SVG asks for
// against the aspect ratio AE produced. It needs the file path and the
// resulting item together, which is exactly and only what an import op has.

var __SVG_ASPECT_TOLERANCE = 0.02; // 2% — comfortably past rounding, far short of the 3x that a broken import produces.
var __SVG_SNIFF_BYTES = 16384;

function __lowerExt(path) {
  var dot = String(path).lastIndexOf(".");
  if (dot < 0) return "";
  return String(path).substring(dot + 1).toLowerCase();
}

/** First `max` bytes of a file as text, or null if it cannot be read. */
function __readHead(file, max) {
  var text = null;
  try {
    file.encoding = "UTF-8";
    if (!file.open("r")) return null;
    try { text = file.read(max); } finally { file.close(); }
  } catch (e) { return null; }
  return text;
}

/**
 * viewBox / width / height off the root <svg> element. Deliberately a regex
 * rather than a parser: we need four numbers out of the first tag, not a DOM,
 * and ExtendScript has no XML reader that is worth the failure modes.
 */
function __parseSvgViewBox(text) {
  if (!text) return null;
  var m = text.match(/\bviewBox\s*=\s*["']([^"']+)["']/);
  if (!m) return null;
  var parts = m[1].replace(/,/g, " ").replace(/^\s+|\s+$/g, "").split(/\s+/);
  if (parts.length < 4) return null;
  var w = parseFloat(parts[2]);
  var h = parseFloat(parts[3]);
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
  return { minX: parseFloat(parts[0]), minY: parseFloat(parts[1]), width: w, height: h, raw: m[1] };
}

/**
 * Compare what the SVG asked for against what AE produced.
 *
 * Aspect ratio rather than absolute size on purpose: AE is entitled to pick the
 * pixel dimensions for a vector file with no width/height, and does so
 * sensibly for ordinary SVGs. What it is not entitled to do is change the
 * shape, and in the broken case it does — the report's example asks for
 * 278050x333334 (0.83) and gets 15906x5654 (2.81).
 */
function __validateSvgImport(item, file) {
  var vb = __parseSvgViewBox(__readHead(file, __SVG_SNIFF_BYTES));
  if (!vb) return { ok: true, checked: false, reason: "no viewBox on the root <svg> element; nothing to compare against" };

  var w = item.width, h = item.height;
  if (!(w > 0) || !(h > 0)) {
    return {
      ok: false, checked: true, viewBox: vb.raw, itemWidth: w, itemHeight: h,
      reason: "After Effects imported this SVG with dimensions " + w + "x" + h + "."
    };
  }

  var expected = vb.width / vb.height;
  var actual = w / h;
  var drift = Math.abs(actual - expected) / expected;
  var out = {
    checked: true,
    viewBox: vb.raw,
    expectedAspect: Math.round(expected * 10000) / 10000,
    actualAspect: Math.round(actual * 10000) / 10000,
    itemWidth: w,
    itemHeight: h
  };
  if (drift <= __SVG_ASPECT_TOLERANCE) { out.ok = true; return out; }
  out.ok = false;
  out.reason =
    "After Effects imported this SVG as " + w + "x" + h + " (aspect " + out.actualAspect + "), but its " +
    "viewBox \"" + vb.raw + "\" asks for aspect " + out.expectedAspect + ". AE fabricates dimensions for an SVG " +
    "with a very large viewBox coordinate space and then rasterizes nothing, so this item renders empty " +
    "wherever it is placed, with no error.";
  return out;
}

/** The advice is the same whichever way the item failed, so it is written once. */
function __brokenSvgAdvice() {
  return (
    " Workarounds: for a simple flat SVG, read its path data and rebuild it as a shape layer with " +
    "set_shape_path, scaling the coordinates down to a sane space (divide by 333.334 for a 1000px " +
    "version) and setting ADBE Vector Fill Rule to 2 if the SVG says fill-rule=\"evenodd\" — that is " +
    "pixel-accurate. For a complex one, normalise the viewBox to a small range or rasterize to PNG " +
    "outside AE, then import that. Pass force:true to keep the item anyway."
  );
}

/**
 * The bare import — ImportOptions, importFile, and the two ways AE can decline.
 * Kept as its own function because it is the only import in the codebase and
 * anything else that needs a file in the project (audio.jsx) must go through
 * exactly this, not a second copy that drifts.
 */
function __importFile(file, path, sequence) {
  var opts = new ImportOptions(file);
  if (sequence === true) {
    if (!opts.canImportAs(ImportAsType.FOOTAGE)) throw new Error("Cannot import " + path + " as footage, so it cannot be a sequence either");
    opts.importAs = ImportAsType.FOOTAGE;
    opts.sequence = true;
  }
  var item = app.project.importFile(opts);
  if (!item) throw new Error("After Effects returned no item for " + path);
  return item;
}

/**
 * fsName -> project item, for every item in the project that came from a file.
 * One pass: the caller with N paths to resolve would otherwise walk the project
 * N times, and a project with a few hundred items makes that visible.
 */
function __itemPathMap() {
  var map = {};
  var proj = app.project;
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    var key = null;
    try {
      if (it.mainSource && it.mainSource.file) key = String(it.mainSource.file.fsName);
    } catch (e) {}
    // First one wins: two items on the same file are a duplicate import, and
    // reusing the earlier is what the user would have done by hand.
    if (key && !map.hasOwnProperty(key)) map[key] = it;
  }
  return map;
}

OPS.import_footage = function (args) {
  var path = args && args.path;
  if (typeof path !== "string" || path.length === 0) throw new Error("path is required");

  var file = new File(path);
  if (!file.exists) throw new Error("No file at " + path);

  var item = __importFile(file, path, args.sequence);

  if (typeof args.name === "string" && args.name.length > 0) item.name = args.name;

  var result = {
    itemId: item.id,
    name: item.name,
    path: path,
    width: item.width,
    height: item.height,
    duration: item.duration,
    frameRate: (item.frameRate !== undefined) ? item.frameRate : null,
    isStill: !!item.footageMissing ? null : (item.duration === 0),
    footageMissing: !!item.footageMissing
  };

  if (__lowerExt(path) !== "svg") return result;

  var v = __validateSvgImport(item, file);
  result.validation = v;
  if (v.ok) return result;

  // A silently empty asset is the failure this whole op exists to prevent, so
  // it is not something to return with a warning attached and hope is read.
  // Remove what we created and say why — the same all-or-nothing stance
  // add_shape_content takes when a key will not resolve.
  if (args.force === true) {
    result.warning = v.reason + __brokenSvgAdvice();
    return result;
  }
  var name = item.name;
  try { item.remove(); result.removed = true; }
  catch (e) { result.removed = false; }
  throw new Error(
    v.reason + " The item (\"" + name + "\") has been removed from the project so nothing places it by mistake." +
    __brokenSvgAdvice()
  );
};

OPS.create_footage_layer = function (args) {
  var comp = getCompById(args.compId);
  var item = app.project.itemByID(args.itemId);
  if (!item) throw new Error("No project item with id " + args.itemId);
  if (item instanceof FolderItem) throw new Error("Item " + args.itemId + " (\"" + item.name + "\") is a folder, not footage");

  var layer = comp.layers.add(item);
  if (typeof args.name === "string" && args.name.length > 0) layer.name = args.name;
  if (args.position !== undefined && args.position !== null) {
    layer.property("Transform").property("Position").setValue(args.position);
  }
  if (args.startTime !== undefined && args.startTime !== null) layer.startTime = args.startTime;

  return {
    layerId: layer.id,
    index: layer.index,
    name: layer.name,
    compId: comp.id,
    itemId: item.id,
    inPoint: layer.inPoint,
    outPoint: layer.outPoint
  };
};
