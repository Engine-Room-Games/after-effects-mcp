// vision.jsx — saveFrameToPng wrapper, returns the temp file path which the
// panel then reads and base64-encodes.

function __tmpPngPath() {
  var folder = Folder.temp;
  var name = "ae-mcp-" + (new Date().getTime()) + "-" + Math.floor(Math.random() * 1e6) + ".png";
  return folder.fsName + "/" + name;
}

OPS.screenshot_frame = noUndo(function (args) {
  var c = getCompById(args.compId);
  var t = (args.time !== undefined && args.time !== null) ? args.time : c.time;
  var path = __tmpPngPath();
  var f = new File(path);
  // saveFrameToPng is async-ish; the panel polls the file's existence/size.
  c.saveFrameToPng(t, f);
  return { path: path, width: c.width, height: c.height, time: t, compId: c.id };
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
  var path = __tmpPngPath();
  var f = new File(path);
  try {
    c.saveFrameToPng(t, f);
  } finally {
    // restore
    l.solo = false;
    for (var j = 0; j < prevSolo.length; j++) {
      try { c.layer(prevSolo[j].idx).solo = prevSolo[j].solo; } catch (e) {}
    }
  }
  return { path: path, width: c.width, height: c.height, time: t, compId: c.id, layerId: l.id };
});
