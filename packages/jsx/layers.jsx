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
  var l = c.layers.addText(args.text || "");
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
  if (args.font || args.size || args.color || wantJustify || wantTracking) {
    var srcText = l.property("Source Text");
    var td = srcText.value;
    if (args.font) td.font = args.font;
    if (args.size) td.fontSize = args.size;
    if (args.color) { td.applyFill = true; td.fillColor = [args.color[0], args.color[1], args.color[2]]; }
    if (wantTracking) td.tracking = (args.tracking !== undefined ? args.tracking : 0);
    if (wantJustify) td.justification = __JUSTIFICATION[align];
    srcText.setValue(td);
  }
  if (align !== "none") {
    l.property("Transform").property("Anchor Point").setValue([0, 0, 0]);
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
  if (!(l instanceof AVLayer)) return { ok: false, reason: 'a camera or light in the chain ("' + l.name + '") has no 2D transform' };
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
  prop.setValue(fn(prop.value));
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

OPS.reorder_layer = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  l.moveTo(args.toIndex);
  return __layerSummary(l);
};
