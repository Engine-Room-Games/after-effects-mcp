// vision.jsx — saveFrameToPng wrapper, returns the temp file path which the
// panel then reads and base64-encodes.

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

// saveFrameToPng honours the comp's resolutionFactor, so AE can render the
// reduced frame directly instead of writing full size and resampling
// afterwards. That is faster (a quarter of the pixels at factor 2) and needs no
// external image tool, which is what makes it work off macOS.
function __saveFrameAt(comp, time, file, factor) {
  if (factor <= 1) {
    comp.saveFrameToPng(time, file);
    return;
  }
  var previous = comp.resolutionFactor;
  try {
    comp.resolutionFactor = [factor, factor];
    comp.saveFrameToPng(time, file);
  } finally {
    // Restore unconditionally — a failed render must never leave the user
    // looking at a half-resolution comp.
    comp.resolutionFactor = previous;
  }
}

OPS.screenshot_frame = noUndo(function (args) {
  var c = getCompById(args.compId);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var ds = __clampDownsample(args.downsample);
  var path = __tmpPngPath();
  var f = new File(path);
  // saveFrameToPng is async-ish; the panel polls the file's existence/size.
  __saveFrameAt(c, t, f, ds);
  return {
    path: path,
    width: c.width, height: c.height,
    downsample: ds,
    time: t, compId: c.id
  };
});

OPS.screenshot_layer = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  // Capture all current solo states; solo target; capture; restore.
  var prevSolo = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var ll = c.layer(i);
    prevSolo.push({ idx: i, solo: ll.solo });
    ll.solo = false;
  }
  l.solo = true;
  var ds = __clampDownsample(args.downsample);
  var path = __tmpPngPath();
  var f = new File(path);
  try {
    __saveFrameAt(c, t, f, ds);
  } finally {
    // restore
    l.solo = false;
    for (var j = 0; j < prevSolo.length; j++) {
      try { c.layer(prevSolo[j].idx).solo = prevSolo[j].solo; } catch (e) {}
    }
  }
  return {
    path: path,
    width: c.width, height: c.height,
    downsample: ds,
    time: t, compId: c.id, layerId: l.id
  };
});
