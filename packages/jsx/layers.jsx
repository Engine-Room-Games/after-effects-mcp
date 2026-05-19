// layers.jsx — all layer-level ops.

function __layerKind(l) {
  if (l instanceof TextLayer) return "text";
  if (l instanceof ShapeLayer) return "shape";
  if (l instanceof CameraLayer) return "camera";
  if (l instanceof LightLayer) return "light";
  if (l.nullLayer) return "null";
  if (l.adjustmentLayer) return "adjustment";
  if (l.source && l.source instanceof CompItem) return "precomp";
  if (l.source && l.source instanceof FootageItem) {
    if (l.source.mainSource && l.source.mainSource.color !== undefined) return "solid";
    return "footage";
  }
  return "unknown";
}

function __layerSummary(l) {
  var parent = l.parent ? l.parent.id : null;
  return {
    id: l.id,
    index: l.index,
    name: l.name,
    enabled: l.enabled,
    solo: l.solo,
    locked: l.locked,
    shy: l.shy,
    threeDLayer: l.threeDLayer,
    label: l.label,
    inPoint: l.inPoint,
    outPoint: l.outPoint,
    startTime: l.startTime,
    stretch: l.stretch,
    sourceType: __layerKind(l),
    parent: parent,
    blendingMode: l.blendingMode,
  };
}

OPS.list_layers = noUndo(function (args) {
  var c = getCompById(args.compId);
  var out = [];
  for (var i = 1; i <= c.numLayers; i++) out.push(__layerSummary(c.layer(i)));
  return out;
});

OPS.create_text_layer = function (args) {
  var c = getCompById(args.compId);
  var l = c.layers.addText(args.text || "");
  if (args.name) l.name = args.name;
  // Apply font/size/color through TextDocument
  if (args.font || args.size || args.color) {
    var srcText = l.property("Source Text");
    var td = srcText.value;
    if (args.font) td.font = args.font;
    if (args.size) td.fontSize = args.size;
    if (args.color) { td.applyFill = true; td.fillColor = [args.color[0], args.color[1], args.color[2]]; }
    srcText.setValue(td);
  }
  if (args.position) {
    var p = args.position;
    l.property("Transform").property("Position").setValue(p.length === 3 ? p : [p[0], p[1]]);
  }
  return __layerSummary(l);
};

OPS.create_solid_layer = function (args) {
  var c = getCompById(args.compId);
  var w = args.width || c.width;
  var h = args.height || c.height;
  var dur = args.duration || c.duration;
  var col = args.color;
  var l = c.layers.addSolid([col[0], col[1], col[2]], args.name || "Solid", w, h, c.pixelAspect, dur);
  return __layerSummary(l);
};

OPS.create_null_layer = function (args) {
  var c = getCompById(args.compId);
  var l = c.layers.addNull();
  if (args.name) l.name = args.name;
  return __layerSummary(l);
};

OPS.create_adjustment_layer = function (args) {
  var c = getCompById(args.compId);
  var l = c.layers.addSolid([1, 1, 1], args.name || "Adjustment", c.width, c.height, c.pixelAspect, c.duration);
  l.adjustmentLayer = true;
  return __layerSummary(l);
};

OPS.create_shape_layer = function (args) {
  var c = getCompById(args.compId);
  var l = c.layers.addShape();
  if (args.name) l.name = args.name;
  // shapes payload kept loose for v1 — the agent can use add_shape_content for detail
  return __layerSummary(l);
};

OPS.create_precomp_layer = function (args) {
  var c = getCompById(args.compId);
  var src = getCompById(args.sourceCompId);
  var l = c.layers.add(src);
  if (args.position) {
    var p = args.position;
    l.property("Transform").property("Position").setValue(p.length === 3 ? p : [p[0], p[1]]);
  }
  return __layerSummary(l);
};

OPS.create_camera_layer = function (args) {
  var c = getCompById(args.compId);
  var center = (args.position && args.position.length >= 2) ? [args.position[0], args.position[1]] : [c.width / 2, c.height / 2];
  var l = c.layers.addCamera(args.name || "Camera", center);
  if (args.oneNode) { try { l.autoOrient = AutoOrientType.NO_AUTO_ORIENT; } catch (e) {} }
  return __layerSummary(l);
};

OPS.create_light_layer = function (args) {
  var c = getCompById(args.compId);
  var center = (args.position && args.position.length >= 2) ? [args.position[0], args.position[1]] : [c.width / 2, c.height / 2];
  var l = c.layers.addLight(args.name || "Light", center);
  var lightTypeMap = { parallel: LightType.PARALLEL, spot: LightType.SPOT, point: LightType.POINT, ambient: LightType.AMBIENT };
  if (args.lightType && lightTypeMap[args.lightType]) l.lightType = lightTypeMap[args.lightType];
  if (args.color) l.lightOption.property("Color").setValue([args.color[0], args.color[1], args.color[2]]);
  if (args.intensity !== undefined) l.lightOption.property("Intensity").setValue(args.intensity);
  return __layerSummary(l);
};

OPS.duplicate_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var n = args.count || 1;
  var out = [];
  for (var i = 0; i < n; i++) {
    var d = l.duplicate();
    out.push(__layerSummary(d));
  }
  return out;
};

OPS.delete_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  l.remove();
  return { ok: true };
};

OPS.set_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (args.name !== undefined) l.name = args.name;
  if (args.enabled !== undefined) l.enabled = args.enabled;
  if (args.locked !== undefined) l.locked = args.locked;
  if (args.shy !== undefined) l.shy = args.shy;
  if (args.solo !== undefined) l.solo = args.solo;
  if (args.threeDLayer !== undefined) l.threeDLayer = args.threeDLayer;
  if (args.blendingMode !== undefined) {
    try { l.blendingMode = BlendingMode[args.blendingMode] || l.blendingMode; }
    catch (e) {}
  }
  if (args.label !== undefined) l.label = args.label;
  if (args.inPoint !== undefined) l.inPoint = args.inPoint;
  if (args.outPoint !== undefined) l.outPoint = args.outPoint;
  if (args.startTime !== undefined) l.startTime = args.startTime;
  if (args.stretch !== undefined) l.stretch = args.stretch;
  if (args.preserveTransparency !== undefined) l.preserveTransparency = args.preserveTransparency;
  if (args.trackMatte) {
    if (args.trackMatte.type) {
      try { l.trackMatteType = TrackMatteType[args.trackMatte.type] || l.trackMatteType; }
      catch (e2) {}
    }
  }
  return __layerSummary(l);
};

OPS.parent_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (args.parentLayerId === null) {
    l.parent = null;
  } else {
    l.parent = getLayerById(c, args.parentLayerId);
  }
  return __layerSummary(l);
};

OPS.reorder_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  l.moveTo(args.toIndex);
  return __layerSummary(l);
};
