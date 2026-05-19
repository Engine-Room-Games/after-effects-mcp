// comps.jsx — composition ops.

function __compSummary(c) {
  return {
    id: c.id,
    name: c.name,
    width: c.width,
    height: c.height,
    duration: c.duration,
    frameRate: c.frameRate,
    pixelAspect: c.pixelAspect,
    bgColor: [c.bgColor[0], c.bgColor[1], c.bgColor[2]],
    numLayers: c.numLayers,
    workAreaStart: c.workAreaStart,
    workAreaDuration: c.workAreaDuration,
  };
}

OPS.list_comps = noUndo(function (args) {
  var out = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof CompItem) out.push(__compSummary(it));
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
