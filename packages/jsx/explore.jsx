// explore.jsx — rich one-shot inspection. The whole reason this MCP exists.

function __serializeProperty(p, deep) {
  var out = {
    name: p.name,
    matchName: p.matchName,
    propertyType: String(p.propertyType),
    isTimeVarying: p.isTimeVarying,
    canSetExpression: p.canSetExpression,
  };
  try { out.value = p.value; } catch (e) {}
  if (p.canSetExpression && p.expression) out.expression = p.expression;
  if (p.numKeys > 0) {
    out.keyframes = [];
    for (var k = 1; k <= p.numKeys; k++) {
      var entry = { index: k, time: p.keyTime(k), value: p.keyValue(k) };
      try {
        entry["in"] = String(p.keyInInterpolationType(k));
        entry["out"] = String(p.keyOutInterpolationType(k));
      } catch (e1) {}
      try {
        var inE = p.keyInTemporalEase(k);
        var outE = p.keyOutTemporalEase(k);
        entry.easeIn = { influence: inE[0].influence, speed: inE[0].speed };
        entry.easeOut = { influence: outE[0].influence, speed: outE[0].speed };
      } catch (e2) {}
      if (p.isSpatial) {
        try {
          entry.inTangent = p.keyInSpatialTangent(k);
          entry.outTangent = p.keyOutSpatialTangent(k);
        } catch (e3) {}
      }
      out.keyframes.push(entry);
    }
  }
  return out;
}

function __serializeTransformGroup(tg) {
  var out = {};
  for (var i = 1; i <= tg.numProperties; i++) {
    var p = tg.property(i);
    out[p.name] = __serializeProperty(p);
  }
  return out;
}

function __serializeEffects(layer) {
  var fx = layer.property("Effects");
  if (!fx || fx.numProperties === 0) return [];
  var arr = [];
  for (var i = 1; i <= fx.numProperties; i++) arr.push(__serializeEffect(fx.property(i)));
  return arr;
}

function __serializeMasks(layer) {
  var masks = layer.property("Masks");
  if (!masks || masks.numProperties === 0) return [];
  var out = [];
  for (var i = 1; i <= masks.numProperties; i++) {
    var m = masks.property(i);
    var entry = {
      index: i,
      name: m.name,
      mode: String(m.maskMode),
      inverted: m.inverted,
    };
    try { entry.shape = __serializeProperty(m.property("ADBE Mask Shape")); } catch (e1) {}
    try { entry.opacity = __serializeProperty(m.property("ADBE Mask Opacity")); } catch (e2) {}
    try { entry.expansion = __serializeProperty(m.property("ADBE Mask Offset")); } catch (e3) {}
    try { entry.feather = __serializeProperty(m.property("ADBE Mask Feather")); } catch (e4) {}
    out.push(entry);
  }
  return out;
}

function __serializeMarkers(layer) {
  var mp = layer.property("Marker");
  if (!mp || mp.numKeys === 0) return [];
  var out = [];
  for (var i = 1; i <= mp.numKeys; i++) {
    var mv = mp.keyValue(i);
    out.push({
      index: i,
      time: mp.keyTime(i),
      comment: mv.comment,
      duration: mv.duration,
      label: mv.label,
      chapter: mv.chapter,
      url: mv.url,
      frameTarget: mv.frameTarget,
    });
  }
  return out;
}

function __serializeText(layer) {
  try {
    var td = layer.property("Source Text").value;
    return {
      text: td.text,
      font: td.font,
      fontSize: td.fontSize,
      fillColor: td.applyFill ? [td.fillColor[0], td.fillColor[1], td.fillColor[2]] : null,
      strokeColor: td.applyStroke ? [td.strokeColor[0], td.strokeColor[1], td.strokeColor[2]] : null,
      strokeWidth: td.strokeWidth,
      tracking: td.tracking,
      leading: td.leading,
      justification: String(td.justification),
      fauxBold: td.fauxBold,
      fauxItalic: td.fauxItalic,
      allCaps: td.allCaps,
      smallCaps: td.smallCaps,
    };
  } catch (e) { return null; }
}

function __serializeShapeContents(group, depth) {
  if (!group || !group.numProperties) return [];
  var out = [];
  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    var entry = { name: p.name, matchName: p.matchName, index: i };
    if (p.propertyType === PropertyType.NAMED_GROUP || p.propertyType === PropertyType.INDEXED_GROUP) {
      if (depth > 0) entry.children = __serializeShapeContents(p, depth - 1);
    } else {
      try { entry.value = p.value; } catch (e) {}
    }
    out.push(entry);
  }
  return out;
}

OPS.get_layer_full = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var out = {
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
    blendingMode: String(l.blendingMode),
    preserveTransparency: l.preserveTransparency,
    parent: l.parent ? { layerId: l.parent.id, name: l.parent.name } : null,
    sourceType: __layerKind(l),
    transform: __serializeTransformGroup(l.property("Transform")),
    effects: __serializeEffects(l),
    masks: __serializeMasks(l),
    markers: __serializeMarkers(l),
  };
  // Visual bounds at the comp's current time — cheap to fetch and removes a
  // class of "I need to screenshot to know where this renders" round-trips.
  // Coordinates are in the layer's local space (origin at the Anchor Point).
  try {
    var __rect = l.sourceRectAtTime(c.time, false);
    out.sourceRect = { left: __rect.left, top: __rect.top, width: __rect.width, height: __rect.height, time: c.time };
  } catch (__e) {}
  if (l instanceof TextLayer) out.text = __serializeText(l);
  if (l instanceof ShapeLayer) {
    try { out.shape = { contents: __serializeShapeContents(l.property("Contents"), 4) }; }
    catch (e) {}
  }
  if (l.source && l.source instanceof CompItem) {
    out.precomp = { compId: l.source.id, compName: l.source.name };
    if (args.includeChildren) {
      out.children = [];
      for (var i = 1; i <= l.source.numLayers; i++) out.children.push(__layerSummary(l.source.layer(i)));
    }
  } else if (l.source && l.source instanceof FootageItem) {
    var src = l.source;
    out.footage = {
      itemId: src.id,
      name: src.name,
      hasAlpha: src.hasAlpha,
      duration: src.duration,
      width: src.width,
      height: src.height,
    };
    try { if (src.file) out.footage.path = src.file.fsName; } catch (e2) {}
  }
  return out;
});

// Project item kind. An if/else chain, not a chained ternary: this build of
// ExtendScript parses `a ? x : b ? y : z` left-associatively, so the first
// truthy branch became the next condition and every item fell through to
// "folder" (issues #21/#22). tests/unit/jsx-ternary.mjs keeps it that way.
// "solid" mirrors __layerKind in layers.jsx so an item and a layer that share a
// source describe it with the same word.
function __itemKind(it) {
  if (it instanceof CompItem) return "comp";
  if (it instanceof FolderItem) return "folder";
  if (it instanceof FootageItem) {
    try {
      if (it.mainSource && it.mainSource.color !== undefined) return "solid";
    } catch (e) {}
    return "footage";
  }
  return "unknown";
}

OPS.get_project_summary = noUndo(function (args) {
  var p = app.project;
  var items = [];
  for (var i = 1; i <= p.numItems; i++) {
    var it = p.item(i);
    items.push({
      id: it.id,
      name: it.name,
      type: __itemKind(it),
    });
  }
  return {
    path: p.file ? p.file.fsName : null,
    numItems: p.numItems,
    activeItemId: p.activeItem ? p.activeItem.id : null,
    items: items,
  };
});

OPS.find_layers = noUndo(function (args) {
  var out = [];
  var comps = [];
  if (args.compId) comps.push(getCompById(args.compId));
  else {
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem) comps.push(it);
    }
  }
  var pat = args.namePattern ? new RegExp(args.namePattern, "i") : null;
  for (var ci = 0; ci < comps.length; ci++) {
    var c = comps[ci];
    for (var li = 1; li <= c.numLayers; li++) {
      var l = c.layer(li);
      if (pat && !pat.test(l.name)) continue;
      if (args.type && __layerKind(l) !== args.type) continue;
      if (args.hasEffectMatchName) {
        var fx = l.property("Effects");
        var hit = false;
        if (fx) {
          for (var fi = 1; fi <= fx.numProperties; fi++) {
            if (fx.property(fi).matchName === args.hasEffectMatchName) { hit = true; break; }
          }
        }
        if (!hit) continue;
      }
      var s = __layerSummary(l);
      s.compId = c.id;
      s.compName = c.name;
      out.push(s);
    }
  }
  return out;
});
