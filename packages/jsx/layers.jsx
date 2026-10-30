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

// `sections` is the caller's `include` array (see __wantsSection in comps.jsx).
// Null means every section, so every existing caller is unaffected; the core —
// the id/index/name/type map an agent orients with — is always present.
function __layerSummary(l, sections) {
  var out = {
    id: l.id,
    index: l.index,
    name: l.name,
    sourceType: __layerKind(l),
  };
  if (__wantsSection(sections, "flags")) {
    out.enabled = l.enabled;
    out.solo = l.solo;
    out.locked = l.locked;
    out.shy = l.shy;
    out.threeDLayer = l.threeDLayer;
    out.label = l.label;
    out.blendingMode = l.blendingMode;
  }
  if (__wantsSection(sections, "timing")) {
    out.inPoint = l.inPoint;
    out.outPoint = l.outPoint;
    out.startTime = l.startTime;
    out.stretch = l.stretch;
  }
  if (__wantsSection(sections, "parent")) out.parent = l.parent ? l.parent.id : null;
  return out;
}

OPS.list_layers = noUndo(function (args) {
  var c = getCompById(args.compId);
  var sections = (args && args.include) ? args.include : null;
  var out = [];
  for (var i = 1; i <= c.numLayers; i++) out.push(__layerSummary(c.layer(i), sections));
  return out;
});

OPS.create_text_layer = function (args) {
  var c = getCompById(args.compId);
  // A box size makes paragraph text (issue #181): it wraps inside the box.
  var l = args.boxSize ? c.layers.addBoxText([args.boxSize[0], args.boxSize[1]], args.text || "") : c.layers.addText(args.text || "");
  if (args.name) l.name = args.name;
  // `anchorAlign` is paragraph justification, not geometry. Offsetting the
  // anchor to the measured bbox edge (what this did before) looks right at
  // creation and is wrong the moment the Source Text changes — retyped, driven
  // by an expression, or edited through Essential Graphics in Premiere — because
  // the anchor stays baked for the old string and the layout jumps. Justifying
  // instead keeps the alignment live and leaves the anchor at the origin, which
  // is also what sourceRectAtTime()-driven backgrounds expect.
  //
  // Tracking is normalised for a different reason: addText() inherits the
  // workspace's Character panel, so an untouched layer arrives with whatever
  // that was last left on (-20 is common) and the same call renders differently
  // on two machines. `tracking` sets it explicitly; omitting it means 0.
  //
  // 'none' opts out of all of it and leaves AE's raw defaults alone.
  var align = args.anchorAlign === undefined ? "left" : args.anchorAlign;
  var wantJustify = align !== "none" && __JUSTIFICATION[align] !== undefined;
  var wantTracking = args.tracking !== undefined || align !== "none";
  var verified = null;
  if (args.font || args.size || args.color || wantJustify || wantTracking) {
    var srcText = l.property("Source Text");
    var td = srcText.value;
    // The same TextDocument round trip set_text does, so the same read-back
    // (issue #93 / #94, see __verifyJustification in text.jsx): the requested
    // justification if there is one, otherwise whatever addText() gave the
    // layer — 'none' promised to leave it alone, and that is checked too.
    var justificationWanted = wantJustify ? __JUSTIFICATION[align] : td.justification;
    if (args.font) td.font = args.font;
    if (args.size) td.fontSize = args.size;
    if (args.color) { td.applyFill = true; td.fillColor = [args.color[0], args.color[1], args.color[2]]; }
    if (wantTracking) td.tracking = (args.tracking !== undefined ? args.tracking : 0);
    if (wantJustify) td.justification = justificationWanted;
    srcText.setValue(td);
    try {
      verified = __verifyJustification(srcText, justificationWanted);
    } catch (e) {
      // A throw here would leave a layer the caller has no id for, and the
      // natural next move — call again — makes two. Same rule as
      // add_shape_content: take the node back, then say so. The message is
      // amended on the same Error object so nothing about it is lost.
      try { l.remove(); } catch (e2) {}
      e.message = String(e.message) + " The new layer was removed, so nothing was created; " +
        "create it with anchorAlign:\"none\" and set the alignment afterwards with set_text.";
      throw e;
    }
  }
  if (align !== "none") {
    __setValue(l.property("Transform").property("Anchor Point"), [0, 0, 0]);
  }
  if (args.position) {
    var p = args.position;
    __setValue(l.property("Transform").property("Position"), p.length === 3 ? p : [p[0], p[1]]);
  }
  var out = __layerSummary(l);
  if (verified) {
    out.justification = __justificationName(verified.justification);
    out.justificationReasserted = verified.reasserted;
  }
  if (args.boxSize) {
    var boxSrc = l.property("Source Text");
    try {
      out.boxSize = __verifyBoxSize(boxSrc, args.boxSize, "create_text_layer", "");
    } catch (eBox) {
      try { l.remove(); } catch (eRm) {}
      eBox.message = String(eBox.message) + "The new layer was removed, so nothing was created.";
      throw eBox;
    }
  }
  return out;
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

// Where a new shape layer's origin goes (issue #51).
//
// AE's addShape() leaves Position at the comp centre with the Anchor Point at
// [0,0], so layer space is offset from comp space by half a frame. Every path
// this toolset can write — set_shape_path vertices, add_shape_content vertices,
// a rect/ellipse `position` — is expressed in *layer* space, and nothing in the
// response says where that space starts. An agent authoring in comp pixels gets
// the whole drawing shifted by (width/2, height/2), and the check that would
// catch it is a downsampled screenshot.
//
// Default [0,0] makes layer space and comp space the same space for a fresh
// shape layer, which is the only arrangement in which a vertex list means what
// it says. "center" is AE's own spawn point, kept as one word so the old
// behaviour is still one argument away.
function __shapeSpawnPosition(comp, position) {
  if (position === undefined || position === null) return [0, 0];
  if (position === "center") return [comp.width / 2, comp.height / 2];
  if (position instanceof Array && position.length >= 2) {
    if (position.length === 3) return [position[0], position[1], position[2]];
    return [position[0], position[1]];
  }
  throw new Error(
    "create_shape_layer: position must be [x,y], [x,y,z] or the string \"center\" (After Effects' own " +
    "spawn point, the comp centre). Got: " + String(position)
  );
}

OPS.create_shape_layer = function (args) {
  // Issue #148: these were once advertised and silently dropped, so a caller
  // asking for a red rect got an empty layer and a success. The schema no longer
  // declares them; this refuses them on the way in too, before anything is
  // created, for any caller that reaches the handler without that parse.
  var dropped = [];
  var unsupported = ["shapes", "fill", "stroke", "strokeWidth"];
  for (var u = 0; u < unsupported.length; u++) {
    if (args[unsupported[u]] !== undefined) dropped.push(unsupported[u]);
  }
  if (dropped.length) {
    throw new Error(
      "create_shape_layer does not take " + dropped.join(", ") + ": it only creates the empty layer. " +
      "Add contents with add_shape_content afterwards — a group, then a rect/ellipse/path, then a " +
      "{type:\"fill\", color} or {type:\"stroke\", color, width} inside it. Nothing was created."
    );
  }
  var c = getCompById(args.compId);
  var pos = __shapeSpawnPosition(c, args.position);
  var l = c.layers.addShape();
  if (args.name) l.name = args.name;
  try {
    __setValue(l.property("Transform").property("Position"), pos);
  } catch (ePos) {
    // The shape that can still get here is three components on a 2D layer, which
    // AE refuses. Leaving an empty shape layer in the timeline behind a thrown
    // error is the half-built failure add_shape_content refuses to produce.
    try { l.remove(); } catch (eRm) {}
    throw new Error(
      "create_shape_layer could not set position to [" + pos.join(", ") + "]: " + ePos.message +
      ". (A three-component position needs a 3D layer; create it 2D and set threeDLayer with set_layer first.) " +
      "The empty layer was removed, so nothing changed."
    );
  }
  var out = __layerSummary(l);
  // Read both back rather than echoing what we asked for: together they are the
  // coordinate space every subsequent path on this layer is measured in, and a
  // caller should never have to render a frame to find out what it is.
  out.position = l.property("Transform").property("Position").value;
  out.anchorPoint = l.property("Transform").property("Anchor Point").value;
  return out;
};

OPS.create_precomp_layer = function (args) {
  var c = getCompById(args.compId);
  var src = getCompById(args.sourceCompId);
  var l = c.layers.add(src);
  if (args.position) {
    var p = args.position;
    __setValue(l.property("Transform").property("Position"), p.length === 3 ? p : [p[0], p[1]]);
  }
  return __layerSummary(l);
};

OPS.create_camera_layer = function (args) {
  var c = getCompById(args.compId);
  var center = (args.position && args.position.length >= 2) ? [args.position[0], args.position[1]] : [c.width / 2, c.height / 2];
  var l = c.layers.addCamera(args.name || "Camera", center);
  if (args.oneNode) {
    // Issue #150: this used to swallow its failure and hand back a two-node
    // camera as if it were the one asked for.
    try { l.autoOrient = AutoOrientType.NO_AUTO_ORIENT; }
    catch (e) {
      try { l.remove(); } catch (eRm) {}
      throw new Error("create_camera_layer could not make the camera one-node (autoOrient = NO_AUTO_ORIENT): " + e.message +
        ". The camera was removed, so nothing changed.");
    }
  }
  return __layerSummary(l);
};

OPS.create_light_layer = function (args) {
  var c = getCompById(args.compId);
  var center = (args.position && args.position.length >= 2) ? [args.position[0], args.position[1]] : [c.width / 2, c.height / 2];
  var l = c.layers.addLight(args.name || "Light", center);
  var lightTypeMap = { parallel: LightType.PARALLEL, spot: LightType.SPOT, point: LightType.POINT, ambient: LightType.AMBIENT };
  if (args.lightType && lightTypeMap[args.lightType]) l.lightType = lightTypeMap[args.lightType];
  if (args.color) __setValue(l.lightOption.property("Color"), [args.color[0], args.color[1], args.color[2]]);
  if (args.intensity !== undefined) __setValue(l.lightOption.property("Intensity"), args.intensity);
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

// Removing a layer has fallout After Effects does not announce (issue #160):
// its children lose their parent, layers using it as a track matte lose the
// matte, and a solid's footage item is left in the project. All of it is read
// before the removal — afterwards there is nothing left to ask — and reported,
// each key present only when non-empty.
OPS.delete_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var layerId = l.id;
  var layerName = l.name;
  var children = [];
  var matteUsers = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var o = c.layer(i);
    if (o.id === layerId) continue;
    var par = null;
    try { par = o.parent; } catch (e) { par = null; }
    if (par && par.id === layerId) children.push({ id: o.id, name: o.name });
    var mt = null;
    try { mt = o.trackMatteLayer; } catch (e2) { mt = null; }
    if (mt && mt.id === layerId) matteUsers.push({ id: o.id, name: o.name });
  }
  var srcId = null;
  try { if (l.source && __isSolidItem(l.source)) srcId = l.source.id; } catch (e3) { srcId = null; }

  l.remove();

  var out = { ok: true, layerId: layerId, name: layerName };
  if (children.length > 0) out.unparentedChildren = children;
  if (matteUsers.length > 0) out.lostTrackMatte = matteUsers;
  if (srcId !== null) {
    var item = __findItem(srcId);
    var solidUses = item ? __usedInList(item) : null;
    if (solidUses && solidUses.unreadable) {
      out.solidUseUnknown = { id: item.id, name: item.name, reason: solidUses.unreadable };
    } else if (solidUses && solidUses.length === 0) {
      out.unusedSolidLeft = { id: item.id, name: item.name };
      out.note = "The solid item \"" + item.name + "\" is now used by nothing and remains in the project; purge_unused_footage removes it.";
    }
  }
  return out;
};

OPS.set_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);

  // Resolve every enumeration name and the matte layer before anything is
  // written (issues #149, #150). A name After Effects does not define used to
  // leave the layer as it was behind an {ok}; now it refuses, and refuses
  // before the name or switches in the same call have changed.
  var blend;
  if (args.blendingMode !== undefined) {
    blend = BlendingMode[args.blendingMode];
    // Adobe documents SILHOUETE_ALPHA with one T; should a build ever define
    // the English spelling instead, take that rather than refuse.
    if (blend === undefined && args.blendingMode === "SILHOUETE_ALPHA") blend = BlendingMode.SILHOUETTE_ALPHA;
    if (blend === undefined) {
      throw new Error("set_layer: blendingMode '" + args.blendingMode + "' is not one of After Effects' BlendingMode names. Nothing was changed.");
    }
  }
  var tm = args.trackMatte, tmType, tmLayer = null;
  if (tm) {
    tmType = TrackMatteType[tm.type];
    if (tmType === undefined) {
      throw new Error("set_layer: trackMatte.type '" + tm.type + "' is not one of After Effects' TrackMatteType names. Nothing was changed.");
    }
    if (__isCamOrLight(l)) {
      throw new Error("set_layer: layer " + l.id + " (\"" + l.name + "\") is a " + __layerKind(l) + "; track mattes apply only to layers with pixels, not cameras or lights. Nothing was changed.");
    }
    if (tm.layerId !== undefined && tm.layerId !== null) {
      if (tm.type === "NO_TRACK_MATTE") {
        throw new Error("set_layer: trackMatte.type NO_TRACK_MATTE removes the matte, so it takes no layerId. Nothing was changed.");
      }
      if (tm.layerId === l.id) {
        throw new Error("set_layer: a layer cannot be its own track matte (trackMatte.layerId " + tm.layerId + "). Nothing was changed.");
      }
      try { tmLayer = getLayerById(c, tm.layerId); }
      catch (eM) {
        throw new Error("set_layer: trackMatte.layerId " + tm.layerId + " is not a layer in comp " + c.id + ". Nothing was changed.");
      }
      if (__isCamOrLight(tmLayer)) {
        throw new Error("set_layer: trackMatte.layerId " + tm.layerId + " is a " + __layerKind(tmLayer) + "; a camera or light has no pixels to use as a matte. Nothing was changed.");
      }
      if (typeof l.setTrackMatte !== "function") {
        throw new Error("set_layer: trackMatte.layerId needs After Effects 2023 or later (Layer.setTrackMatte). Nothing was changed.");
      }
    } else if (tm.type !== "NO_TRACK_MATTE") {
      // A type alone re-reads the current matte. With none there is nothing to
      // re-read: measured on 26.5, assigning trackMatteType to a layer with no
      // matte layer reports success and sets no matte (PR #205 live pass).
      var curM = null;
      try { curM = l.trackMatteLayer || null; } catch (eCurM) { curM = null; }
      if (!curM) {
        throw new Error("set_layer: layer " + l.id + " (\"" + l.name + "\") has no track matte layer, so trackMatte.type " + tm.type +
          " alone has nothing to apply to. Pass trackMatte.layerId to choose the matte layer. Nothing was changed.");
      }
    }
  }

  // The switch enumerations (issue #181), resolved by name like blendingMode.
  var switchEnums = {};
  for (var ei = 0; ei < __LAYER_SWITCH_ENUMS.length; ei++) {
    var ef = __LAYER_SWITCH_ENUMS[ei][0];
    if (args[ef] === undefined) continue;
    var en = __LAYER_SWITCH_ENUMS[ei][1];
    var table = __layerSwitchEnum(en);
    var ev = table ? table[args[ef]] : undefined;
    if (ev === undefined) {
      throw new Error("set_layer: " + ef + " '" + args[ef] + "' is not one of After Effects' " + en + " names. Nothing was changed.");
    }
    switchEnums[ef] = ev;
  }

  // What can be known to fail without writing anything is refused here too.
  var camOrLight = __isCamOrLight(l);
  var pixelOnly = ["blendingMode", "threeDLayer", "preserveTransparency", "motionBlur", "collapseTransformation",
    "adjustmentLayer", "guideLayer", "effectsActive", "audioEnabled", "quality", "samplingQuality", "frameBlendingType"];
  for (var pi = 0; pi < pixelOnly.length; pi++) {
    if (camOrLight && args[pixelOnly[pi]] !== undefined) {
      throw new Error("set_layer: layer " + l.id + " (\"" + l.name + "\") is a " + __layerKind(l) + ", which has no " + pixelOnly[pi] + ". Nothing was changed.");
    }
  }
  if (args.collapseTransformation !== undefined && l.canSetCollapseTransformation === false) {
    throw new Error("set_layer: layer " + l.id + " (\"" + l.name + "\") has no collapse-transformations / continuous-rasterize switch " +
      "(After Effects offers it on precomp, shape, text and vector-footage layers). Nothing was changed.");
  }
  if (args.audioEnabled !== undefined && l.hasAudio === false) {
    throw new Error("set_layer: layer " + l.id + " (\"" + l.name + "\") has no audio, so it has no audio switch. Nothing was changed.");
  }
  if (args.autoOrient === "CHARACTERS_TOWARD_CAMERA" && !(l instanceof TextLayer)) {
    throw new Error("set_layer: autoOrient CHARACTERS_TOWARD_CAMERA applies only to a 3D text layer with per-character 3D; layer " + l.id +
      " (\"" + l.name + "\") is a " + __layerKind(l) + ". Nothing was changed.");
  }
  // Orienting toward the camera is 3D-only, and After Effects answers it on a
  // 2D layer with a modal warning rather than a throw: the call blocks until
  // someone clicks OK (measured on AE 2026, PR #216 live pass). So it is
  // refused here, judged by the 3D switch as it will be once this call's own
  // threeDLayer — written before autoOrient when it turns 3D on — has landed. Cameras and lights
  // are always 3D.
  if ((args.autoOrient === "CAMERA_OR_POINT_OF_INTEREST" || args.autoOrient === "CHARACTERS_TOWARD_CAMERA") && !camOrLight) {
    var threeDAfter = args.threeDLayer !== undefined ? !!args.threeDLayer : !!l.threeDLayer;
    if (!threeDAfter) {
      throw new Error("set_layer: autoOrient " + args.autoOrient + " needs a 3D layer, and layer " + l.id + " (\"" + l.name + "\") " +
        (args.threeDLayer === false ? "is made 2D by this call" : "is 2D") +
        " — set threeDLayer:true first (the same call will do). Nothing was changed.");
    }
    if (args.autoOrient === "CHARACTERS_TOWARD_CAMERA" && l.threeDPerChar !== true) {
      throw new Error("set_layer: autoOrient CHARACTERS_TOWARD_CAMERA needs per-character 3D, which text layer " + l.id + " (\"" + l.name +
        "\") does not have enabled (Animate > Enable Per-character 3D). Nothing was changed.");
    }
  }
  // The same modal from the other side: turning 3D off under a toward-camera
  // orient leaves a 2D layer oriented at the camera. With no autoOrient in the
  // call that would be the end state, so it is refused; with one (which, by
  // the check above, is not toward-camera) autoOrient is written before
  // threeDLayer below, so the 2D-and-oriented state never exists, even briefly.
  var orientFirst = args.threeDLayer === false && args.autoOrient !== undefined;
  if (args.threeDLayer === false && args.autoOrient === undefined && !camOrLight) {
    var AO = __layerSwitchEnum("AutoOrientType");
    var curOrient = null;
    try { curOrient = l.autoOrient; } catch (eAO) { curOrient = null; }
    var curName = null;
    if (AO && curOrient === AO.CAMERA_OR_POINT_OF_INTEREST) curName = "CAMERA_OR_POINT_OF_INTEREST";
    else if (AO && curOrient === AO.CHARACTERS_TOWARD_CAMERA) curName = "CHARACTERS_TOWARD_CAMERA";
    if (curName !== null) {
      throw new Error("set_layer: layer " + l.id + " (\"" + l.name + "\") is auto-oriented " + curName + ", which needs a 3D layer, so " +
        "threeDLayer:false alone would leave it oriented at the camera in 2D. Pass autoOrient:\"NO_AUTO_ORIENT\" (or ALONG_PATH) " +
        "in the same call. Nothing was changed.");
    }
  }
  if (args.stretch !== undefined && args.stretch === 0) {
    throw new Error("set_layer: stretch 0 is not a speed After Effects accepts. Nothing was changed.");
  }
  if (args.inPoint !== undefined && args.outPoint !== undefined && args.outPoint <= args.inPoint) {
    throw new Error("set_layer: outPoint " + args.outPoint + " must be after inPoint " + args.inPoint + ". Nothing was changed.");
  }

  // Writes from here on. AE can still refuse one that nothing above could
  // predict (an in-point it will not take), so every write that landed is
  // recorded and a refusal part-way names what this call already changed and
  // what it never reached, rather than implying it changed nothing.
  //
  // Order: an unlock first and a lock last, so the call's own locked switch
  // never stands between it and its other fields. The matte next: it is the
  // write whose result is read back, so its failure comes as early as it can.
  var applied = [];
  var steps = [];
  if (args.locked === false) steps.push(["locked", false]);
  if (tm) steps.push(["trackMatte", tm]);
  steps.push(
    ["name", args.name], ["enabled", args.enabled], ["shy", args.shy],
    ["solo", args.solo], ["autoOrient", orientFirst ? switchEnums.autoOrient : undefined],
    ["threeDLayer", args.threeDLayer], ["blendingMode", blend], ["label", args.label],
    ["inPoint", args.inPoint], ["outPoint", args.outPoint], ["startTime", args.startTime],
    ["stretch", args.stretch], ["preserveTransparency", args.preserveTransparency],
    ["motionBlur", args.motionBlur], ["collapseTransformation", args.collapseTransformation],
    ["adjustmentLayer", args.adjustmentLayer], ["guideLayer", args.guideLayer],
    ["effectsActive", args.effectsActive], ["audioEnabled", args.audioEnabled],
    ["quality", switchEnums.quality], ["samplingQuality", switchEnums.samplingQuality],
    ["frameBlendingType", switchEnums.frameBlendingType], ["autoOrient", orientFirst ? undefined : switchEnums.autoOrient]
  );
  if (args.locked === true) steps.push(["locked", true]);

  var out;
  for (var si = 0; si < steps.length; si++) {
    var field = steps[si][0];
    if (steps[si][1] === undefined) continue;
    try {
      if (field === "trackMatte") out = __setTrackMatte(l, tm, tmType, tmLayer);
      else l[field] = steps[si][1];
      // The switches are read back (issue #181): After Effects can take an
      // assignment it does not apply (frame blending on a still) and say nothing.
      if (__LAYER_READBACK[field] && l[field] !== steps[si][1]) {
        throw new Error("set_layer: After Effects took " + field + " but reads " + String(l[field]) + " afterwards, not " +
          String(steps[si][1]) + "; this layer does not hold that setting.");
      }
    } catch (eW) {
      var notReached = [];
      for (var sj = si + 1; sj < steps.length; sj++) if (steps[sj][1] !== undefined) notReached.push(steps[sj][0]);
      throw new Error("set_layer could not set " + field + ": " + String(eW.message || eW).replace(/^set_layer: /, "") + " " +
        (applied.length ? "Already applied by this call: " + applied.join(", ") + "." : "Nothing else in this call was written.") +
        (notReached.length ? " Not written: " + notReached.join(", ") + "." : ""));
    }
    if (field === "trackMatte") {
      applied.push("trackMatte" + (out.layerId !== null && out.matteEnabled === false ? " (matte layer " + out.layerId + "'s video is now off)" : ""));
    } else {
      applied.push(field);
    }
  }
  var summary = __layerSummary(l);
  if (out) summary.trackMatte = out;
  // The switches this call set, as After Effects now holds them.
  var switches = null;
  for (var ri = 0; ri < __LAYER_SWITCHES.length; ri++) {
    var rf = __LAYER_SWITCHES[ri];
    if (args[rf] === undefined) continue;
    if (!switches) switches = {};
    switches[rf] = switchEnums[rf] !== undefined ? args[rf] : l[rf];
  }
  if (switches) summary.switches = switches;
  return summary;
};

// set_layer's timeline switches (issue #181). Booleans and enum-valued ones;
// the enum names are keys into the After Effects enumeration named beside them.
var __LAYER_SWITCHES = ["motionBlur", "collapseTransformation", "adjustmentLayer", "guideLayer", "effectsActive",
  "audioEnabled", "quality", "samplingQuality", "frameBlendingType", "autoOrient"];
var __LAYER_SWITCH_ENUMS = [
  ["quality", "LayerQuality"], ["samplingQuality", "LayerSamplingQuality"],
  ["frameBlendingType", "FrameBlendingType"], ["autoOrient", "AutoOrientType"]
];
// Named one by one: an enumeration a build lacks reads undefined, not a throw.
function __layerSwitchEnum(name) {
  if (name === "LayerQuality") return typeof LayerQuality !== "undefined" ? LayerQuality : undefined;
  if (name === "LayerSamplingQuality") return typeof LayerSamplingQuality !== "undefined" ? LayerSamplingQuality : undefined;
  if (name === "FrameBlendingType") return typeof FrameBlendingType !== "undefined" ? FrameBlendingType : undefined;
  if (name === "AutoOrientType") return typeof AutoOrientType !== "undefined" ? AutoOrientType : undefined;
  return undefined;
}
var __LAYER_READBACK = {};
(function () { for (var i = 0; i < __LAYER_SWITCHES.length; i++) __LAYER_READBACK[__LAYER_SWITCHES[i]] = true; })();

/**
 * Apply a resolved track matte and read it back (issue #149). The 2023+ API is
 * `setTrackMatte(layer, type)` / `removeTrackMatte()`. A type without a
 * layerId re-applies the current matte layer with the new type; set_layer
 * refuses it up front when there is no current matte, because assigning
 * `trackMatteType` alone then reports success and sets nothing (26.5).
 * Whatever AE ends up holding is checked against the request: a matte that
 * did not land is an error, not an {ok}.
 */
function __isCamOrLight(l) {
  return (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) ||
    (typeof LightLayer !== "undefined" && l instanceof LightLayer);
}

function __setTrackMatte(l, tm, tmType, tmLayer) {
  var cur = null;
  try { cur = l.trackMatteLayer || null; } catch (eCur) { cur = null; }
  if (tm.type === "NO_TRACK_MATTE") {
    // Measured on 26.5: removeTrackMatte() clears the matte layer but leaves
    // trackMatteType as it was (ALPHA, say); assigning NO_TRACK_MATTE after it
    // clears the type. Both, in that order.
    if (typeof l.removeTrackMatte === "function") l.removeTrackMatte();
    if (l.trackMatteType !== tmType) l.trackMatteType = tmType;
  } else if (tmLayer) {
    l.setTrackMatte(tmLayer, tmType);
  } else {
    // Validated above: a type alone only reaches here with a matte layer set.
    l.setTrackMatte(cur, tmType);
  }

  var gotType = l.trackMatteType;
  var gotLayer = null;
  try { gotLayer = l.trackMatteLayer || null; } catch (eGot) { gotLayer = null; }
  if (gotType !== tmType) {
    throw new Error("set_layer: asked for trackMatte.type " + tm.type + " but After Effects reports a different matte type afterwards. " +
      "Read the layer back with get_layer_full.");
  }
  var wantLayer = tm.type === "NO_TRACK_MATTE" ? null : (tmLayer || cur);
  if (wantLayer ? (!gotLayer || gotLayer.id !== wantLayer.id) : gotLayer) {
    throw new Error("set_layer: asked for " + (wantLayer ? "layer " + wantLayer.id + " (\"" + wantLayer.name + "\")" : "no matte layer") +
      " as the track matte, but After Effects reports " +
      (gotLayer ? "layer " + gotLayer.id + " (\"" + gotLayer.name + "\")" : "no matte layer") + " afterwards. Read the layer back with get_layer_full.");
  }
  return {
    type: tm.type,
    layerId: gotLayer ? gotLayer.id : null,
    // After Effects switches a layer's video off when it becomes a matte.
    matteEnabled: gotLayer ? gotLayer.enabled : null
  };
}

// ---------------------------------------------------------------------------
// Parenting that does not move the layer
// ---------------------------------------------------------------------------
// AE compensates a child's transform when you assign layer.parent, but within
// one script evaluation it reads the parent from stale data if that parent was
// itself re-parented earlier in the same evaluation: the compensation runs
// against the pre-move parent and the child lands at W - parentWorld twice
// over, and a parent whose scale is not 100 leaves children at 333% (issue
// #28). run_batch and run_jsx are one evaluation, so this is their normal case.
//
// So we do not trust it. We compute the child's world transform ourselves from
// property values before the assignment, compute it again after, and correct
// the local transform when the two disagree. When AE gets it right the two
// agree and nothing is written at all — that no-op is what makes
// preserveTransform safe to default to true.
//
// The matrices are ours because AE's scripting DOM has no toComp/toWorld —
// those exist only in the expression language. Limits, all reported in the
// result rather than worked around:
//   * 2D only. AE's 3D chain (orientation plus three rotations, composed in
//     AE's own order) is not reimplementable here with any confidence, so a 3D
//     layer, camera or light anywhere in either chain skips the correction.
//   * One time. Everything is measured at the comp's current time. A keyframed
//     or expression-driven ancestor makes the world transform time-varying, and
//     no static correction is right at every frame.
//   * Position only when AE is provably wrong. See __PARENT_POS_MODEL below.

// Well below anything visible, well above double-precision noise through a
// chain of matrix products. Nothing is written inside these — the point is that
// a correct compensation is left exactly as AE wrote it.
var __PT_TOL_POS = 1e-3;     // comp pixels
var __PT_TOL_SCALE = 1e-3;   // percentage points
var __PT_TOL_ROT = 1e-3;     // degrees

// A child's Position is measured in its parent's space, and there are two
// readings of where that space starts: at the parent's layer-space origin (so
// Position is a point pushed through the parent's own matrix) or at the
// parent's anchor point. They differ by exactly the parent's anchor, mapped up
// the chain, and coincide whenever every anchor above is [0,0] — which covers
// nulls, shapes and point text, i.e. most rigs. Rather than bet on one, we
// compute both, and only rewrite Position when AE's own answer matches
// *neither* — that is the only case where AE is provably wrong, and it is the
// bug. When AE matches one of them we learn which for the rest of the session.
var __PARENT_POS_MODEL = null;

// Duck-typed rather than `instanceof Array` so it holds for anything indexable
// AE hands back, and a bare number promotes to a vector.
function __ptV2(v) {
  if (v === null || v === undefined) return [0, 0];
  if (typeof v === "number") return [v, 0];
  return [v[0] || 0, v[1] || 0];
}

// 2D affine as [a, b, c, d, tx, ty]:  x' = a*x + c*y + tx,  y' = b*x + d*y + ty
function __ptMId() { return [1, 0, 0, 1, 0, 0]; }
function __ptMMul(m, n) {                 // apply n first, then m
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}
function __ptMPoint(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
function __ptMVec(m, p) { return [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]]; }
function __ptMLinear(m) { return [m[0], m[1], m[2], m[3], 0, 0]; }
function __ptMInvert(m) {
  var det = m[0] * m[3] - m[1] * m[2];
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;   // a scale of 0 somewhere
  var a = m[3] / det, b = -m[1] / det, cc = -m[2] / det, d = m[0] / det;
  return [a, b, cc, d, -(a * m[4] + cc * m[5]), -(b * m[4] + d * m[5])];
}
function __ptNear(a, b, tol) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
}
function __ptWrapDeg(d) { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }
function __ptR4(n) { return Math.round(n * 10000) / 10000; }   // for prose only; reported deltas keep full precision

function __ptProps(l) {
  var tr = l.property("Transform");
  return {
    position: tr.property("Position"),
    anchor: tr.property("Anchor Point"),
    scale: tr.property("Scale"),
    rotation: tr.property("Rotation")
  };
}

function __ptAnimated(p) {
  var list = [p.position, p.anchor, p.scale, p.rotation];
  for (var i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    if (list[i].numKeys > 0) return true;
    try { if (list[i].expressionEnabled) return true; } catch (e) {}
  }
  return false;
}

// T(position) · R(rotation) · S(scale/100) · T(-anchor). This is the same
// matrix the layer uses for its own points, which is what lets a child's
// Position be fed straight through its parent's copy of it.
function __ptLocalMatrix(l, t) {
  var p = __ptProps(l);
  var pos = __ptV2(p.position.valueAtTime(t, false));
  var anc = __ptV2(p.anchor.valueAtTime(t, false));
  var sc = __ptV2(p.scale.valueAtTime(t, false));
  var rad = p.rotation.valueAtTime(t, false) * Math.PI / 180;
  var cos = Math.cos(rad), sin = Math.sin(rad);
  var rs = [cos * sc[0] / 100, sin * sc[0] / 100, -sin * sc[1] / 100, cos * sc[1] / 100, 0, 0];
  return __ptMMul(__ptMMul([1, 0, 0, 1, pos[0], pos[1]], rs), [1, 0, 0, 1, -anc[0], -anc[1]]);
}

// Walks up the parent chain. `m` is the layer's full world matrix; `wb` is its
// world anchor position under the anchor-relative reading of Position.
function __ptChain(l, t, depth) {
  if (!l) return { ok: true, m: __ptMId(), wb: [0, 0], animated: false };
  if (depth > 32) return { ok: false, reason: "parent chain deeper than 32 layers" };
  // Name the exclusions rather than testing for AVLayer: in ExtendScript a
  // ShapeLayer or TextLayer is not `instanceof AVLayer`, despite Adobe's class
  // docs, so that test refused every shape and text layer as a "camera" (#120).
  if (l instanceof CameraLayer || l instanceof LightLayer) return { ok: false, reason: 'a camera or light in the chain ("' + l.name + '") has no 2D transform' };
  if (l.threeDLayer) return { ok: false, reason: 'a 3D layer in the chain ("' + l.name + '")' };
  var up = __ptChain(l.parent, t, depth + 1);
  if (!up.ok) return up;
  var p = __ptProps(l);
  var off = __ptMVec(up.m, __ptV2(p.position.valueAtTime(t, false)));
  return {
    ok: true,
    m: __ptMMul(up.m, __ptLocalMatrix(l, t)),
    wb: [up.wb[0] + off[0], up.wb[1] + off[1]],
    animated: up.animated || __ptAnimated(p)
  };
}

// Applies fn to a property's static value, or to every keyframe. AE's own
// compensation rewrites every key, so ours does too: the correction is a
// constant change of frame, not a change of animation.
function __ptAdjust(prop, fn) {
  if (prop.numKeys > 0) {
    for (var i = 1; i <= prop.numKeys; i++) prop.setValueAtKey(i, fn(prop.keyValue(i)));
    return prop.numKeys;
  }
  __setValue(prop, fn(prop.value));
  return 0;
}

function __ptExprDriven(prop) {
  try { return !!prop.expressionEnabled; } catch (e) { return false; }
}

OPS.parent_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var newParent = null;
  if (args.parentLayerId !== null && args.parentLayerId !== undefined) {
    newParent = getLayerById(c, args.parentLayerId);
  }
  var preserve = args.preserveTransform !== false;

  if (!preserve) {
    l.parent = newParent;
    var plain = __layerSummary(l);
    plain.preserveTransform = false;
    return plain;
  }

  var t = c.time;
  var notes = [];
  var before = __ptChain(l, t, 0);
  var oldParent = __ptChain(l.parent, t, 0);
  var posChildBefore = __ptV2(__ptProps(l).position.valueAtTime(t, false));

  // The parenting itself always happens, whether or not we can check it.
  l.parent = newParent;

  var out = __layerSummary(l);
  out.preserveTransform = true;
  var corr = {
    applied: false,
    atTime: t,
    positionDelta: null,
    scaleDelta: null,
    rotationDelta: null,
    keysAdjusted: 0,
    positionModel: null,
    timeVarying: false,
    notes: notes
  };
  out.correction = corr;

  if (!before.ok || !oldParent.ok) {
    notes.push("not corrected: " + (before.reason || oldParent.reason));
    return out;
  }
  var after = __ptChain(newParent, t, 0);
  if (!after.ok) {
    notes.push("not corrected: " + after.reason);
    return out;
  }
  var invAfter = __ptMInvert(after.m);
  if (!invAfter) {
    notes.push("not corrected: the new parent chain has a scale of 0 and cannot be inverted");
    return out;
  }
  corr.timeVarying = !!(before.animated || after.animated);
  if (corr.timeVarying) {
    notes.push("a transform in the chain is keyframed or expression-driven, so the world transform varies over time; corrected at comp time " + t);
  }

  var props = __ptProps(l);
  // The child's world anchor position before the assignment, under each of the
  // two readings of what a child's Position means in its parent's space.
  var waAnchorRel = __ptV2(before.wb);
  var waLayerSpace = __ptMPoint(oldParent.m, posChildBefore);

  // --- rotation and scale -------------------------------------------------
  // The linear part of a world matrix is the product of R·S up the chain, which
  // is the same under both readings of Position. This half is model-free.
  //
  // desired = inv(Lin(new parent chain)) · Lin(child's world before), i.e. the
  // child's own R·S that reproduces the world it had. Split it back into a
  // rotation and an axis-aligned scale: column 0 is R·(sx,0) and column 1 is
  // R·(0,sy), so |column 0| is |sx| and its angle is the rotation. A mirrored
  // layer can be written either as a negative sx or as a negative sy plus 180
  // degrees, so we keep whichever sign the layer already carries rather than
  // rewriting an equivalent transform for no reason.
  var desired = __ptMMul(__ptMLinear(invAfter), __ptMLinear(before.m));
  var scNow = __ptV2(props.scale.valueAtTime(t, false));
  var col0x = desired[0], col0y = desired[1];
  var negX = (scNow[0] < 0);
  if (negX) { col0x = -col0x; col0y = -col0y; }
  var sxNew = Math.sqrt(col0x * col0x + col0y * col0y);
  if (negX) sxNew = -sxNew;
  var theta = Math.atan2(col0y, col0x);
  var cs = Math.cos(theta), sn = Math.sin(theta);
  var skew = cs * desired[2] + sn * desired[3];
  var syNew = -sn * desired[2] + cs * desired[3];
  if (Math.abs(skew) > 1e-6) {
    notes.push("the new parent shears the layer (non-uniform scale under rotation); position/scale/rotation cannot express it exactly, residual skew " + __ptR4(skew));
  }

  var rotNow = props.rotation.valueAtTime(t, false);
  var rotDelta = __ptWrapDeg(theta * 180 / Math.PI - rotNow);
  if (Math.abs(rotDelta) > __PT_TOL_ROT) {
    if (__ptExprDriven(props.rotation)) {
      notes.push("rotation is expression-driven; the " + __ptR4(rotDelta) + "deg correction was not written");
    } else {
      corr.keysAdjusted += __ptAdjust(props.rotation, function (v) { return v + rotDelta; });
      corr.rotationDelta = rotDelta;
      corr.applied = true;
    }
  }

  var scTarget = [sxNew * 100, syNew * 100];
  var dsx = scTarget[0] - scNow[0], dsy = scTarget[1] - scNow[1];
  if (Math.abs(dsx) > __PT_TOL_SCALE || Math.abs(dsy) > __PT_TOL_SCALE) {
    if (__ptExprDriven(props.scale)) {
      notes.push("scale is expression-driven; the correction to [" + __ptR4(scTarget[0]) + ", " + __ptR4(scTarget[1]) + "] was not written");
    } else if (Math.abs(scNow[0]) < 1e-9 || Math.abs(scNow[1]) < 1e-9) {
      notes.push("scale is 0 on an axis, so it cannot be scaled back to [" + __ptR4(scTarget[0]) + ", " + __ptR4(scTarget[1]) + "]");
    } else {
      // Multiplicative, so a keyframed scale keeps the shape of its animation.
      var fx = scTarget[0] / scNow[0], fy = scTarget[1] / scNow[1];
      corr.keysAdjusted += __ptAdjust(props.scale, function (v) {
        var o = [];
        for (var i = 0; i < v.length; i++) {
          var f = fy;
          if (i === 0) f = fx;
          o.push(v[i] * f);
        }
        return o;
      });
      corr.scaleDelta = [dsx, dsy];
      corr.applied = true;
    }
  }

  // --- position -----------------------------------------------------------
  // Recomputed after the linear correction, since the child's own R·S does not
  // affect where its anchor lands but AE may have rewritten Position too.
  var pAfter = __ptV2(props.position.valueAtTime(t, false));
  var candLayerSpace = __ptMPoint(invAfter, waLayerSpace);
  var candAnchorRel = __ptMVec(invAfter, [waAnchorRel[0] - after.wb[0], waAnchorRel[1] - after.wb[1]]);
  var hitLayerSpace = __ptNear(pAfter, candLayerSpace, __PT_TOL_POS);
  var hitAnchorRel = __ptNear(pAfter, candAnchorRel, __PT_TOL_POS);
  var ambiguous = !__ptNear(candLayerSpace, candAnchorRel, __PT_TOL_POS);

  if (hitLayerSpace || hitAnchorRel) {
    // AE placed it where one of the two readings says it belongs — nothing to
    // fix. Learn the reading when the two candidates actually disagree.
    if (ambiguous && hitLayerSpace !== hitAnchorRel) {
      __PARENT_POS_MODEL = hitLayerSpace ? "layer-space" : "anchor-relative";
    }
    corr.positionModel = __PARENT_POS_MODEL;
  } else {
    var model = __PARENT_POS_MODEL || "layer-space";
    var target = candLayerSpace;
    if (model === "anchor-relative") target = candAnchorRel;
    corr.positionModel = model;
    if (ambiguous && !__PARENT_POS_MODEL) {
      notes.push("the parent chain has a non-zero anchor point and this session has not yet seen AE agree with either reading of a child's Position, so the layer-space reading was assumed; the two differ by [" + __ptR4(candLayerSpace[0] - candAnchorRel[0]) + ", " + __ptR4(candLayerSpace[1] - candAnchorRel[1]) + "]");
    }
    var dx = target[0] - pAfter[0], dy = target[1] - pAfter[1];
    if (__ptExprDriven(props.position)) {
      notes.push("position is expression-driven; the [" + __ptR4(dx) + ", " + __ptR4(dy) + "] correction was not written");
    } else {
      corr.keysAdjusted += __ptAdjust(props.position, function (v) {
        var o = [];
        for (var i = 0; i < v.length; i++) {
          var d = 0;
          if (i === 0) d = dx;
          else if (i === 1) d = dy;
          o.push(v[i] + d);
        }
        return o;
      });
      corr.positionDelta = [dx, dy];
      corr.applied = true;
    }
  }

  return out;
};

// Layers do not reorder with moveTo. `moveTo` is a PropertyBase method for
// re-ranking a property inside an indexed group, and calling it on a Layer
// throws "parent is not an INDEXED_GROUP" — which is every call this op has
// ever served (issue #70). AE's layer-level primitives are moveBefore,
// moveAfter, moveToBeginning and moveToEnd, and all four take a *layer*, never
// an index. (The one legitimate moveTo in this codebase is the shape-property
// one in shapes.jsx; it is on a PropertyBase and stays.)
//
// Two ways in, because reorder is the op that invalidates indexes:
//
//   * `beforeLayerId` / `afterLayerId` — place this layer relative to another
//     one by id. Nothing about the answer depends on the stack not having moved
//     since the caller last read it, which is why these are the preferred form.
//   * `toIndex` — the index the layer ends up at, counting from the front.
//     Stated as the *landing* index because "the index it displaces" and "the
//     index it lands on" differ by one when moving down the stack and the
//     caller cannot tell which one a tool meant.
//
// The two directions need different primitives, and swapping them is off by one
// with no error. Moving up (toIndex < from), the layer currently at the target
// is pushed down, so moveBefore lands exactly on it. Moving down, that layer
// shifts up by one as this one leaves, so moveAfter is what lands on the target.
OPS.reorder_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var from = l.index;
  var n = c.numLayers;
  var to;

  if (args.beforeLayerId !== undefined && args.beforeLayerId !== null) {
    var b = getLayerById(c, args.beforeLayerId);
    if (b.id === l.id) throw new Error("reorder_layer: beforeLayerId is the layer being moved (" + l.id + ").");
    l.moveBefore(b);
  } else if (args.afterLayerId !== undefined && args.afterLayerId !== null) {
    var a = getLayerById(c, args.afterLayerId);
    if (a.id === l.id) throw new Error("reorder_layer: afterLayerId is the layer being moved (" + l.id + ").");
    l.moveAfter(a);
  } else if (args.toIndex !== undefined && args.toIndex !== null) {
    to = Math.round(args.toIndex);
    if (to < 1) to = 1;
    if (to > n) to = n;
    if (to === from) {
      // Nothing to do. Saying so beats an AE call that is a no-op anyway.
    } else if (to === 1) {
      l.moveToBeginning();
    } else if (to === n) {
      l.moveToEnd();
    } else if (to < from) {
      l.moveBefore(c.layer(to));
    } else {
      l.moveAfter(c.layer(to));
    }
  } else {
    throw new Error("reorder_layer: pass one of toIndex, beforeLayerId or afterLayerId.");
  }

  // Report both ends of the move. The landing index is read back off the layer
  // rather than assumed, so a result can never claim a position AE did not
  // give it — and `movedFrom === index` is how a caller sees a no-op.
  var out = __layerSummary(l);
  out.movedFrom = from;
  return out;
};
