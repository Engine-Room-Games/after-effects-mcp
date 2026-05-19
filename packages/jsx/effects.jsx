// effects.jsx — effect graph ops.

function __serializeEffect(eff) {
  var out = { name: eff.name, matchName: eff.matchName, enabled: eff.enabled, index: eff.propertyIndex, params: [] };
  for (var i = 1; i <= eff.numProperties; i++) {
    var p = eff.property(i);
    var entry = { name: p.name, matchName: p.matchName, propertyType: String(p.propertyType) };
    try { entry.value = p.value; } catch (e) {}
    if (p.canSetExpression && p.expression) entry.expression = p.expression;
    if (p.numKeys > 0) {
      entry.keyframes = [];
      for (var k = 1; k <= p.numKeys; k++) {
        entry.keyframes.push({ time: p.keyTime(k), value: p.keyValue(k) });
      }
    }
    out.params.push(entry);
  }
  return out;
}

OPS.list_effects = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var fx = l.property("Effects");
  if (!fx) return [];
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) out.push(__serializeEffect(fx.property(i)));
  return out;
});

OPS.add_effect = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var fx = l.property("Effects");
  var eff = fx.addProperty(args.matchName);
  return __serializeEffect(eff);
};

OPS.remove_effect = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var fx = l.property("Effects");
  fx.property(args.effectIndex).remove();
  return { ok: true };
};

OPS.set_effect_param = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var eff = l.property("Effects").property(args.effectIndex);
  var p = null;
  if (args.paramMatchName) {
    for (var i = 1; i <= eff.numProperties; i++) {
      if (eff.property(i).matchName === args.paramMatchName) { p = eff.property(i); break; }
    }
  }
  if (!p && args.paramName) p = eff.property(args.paramName);
  if (!p) throw new Error("Effect param not found");
  if (args.keyframe && args.time !== undefined) p.setValueAtTime(args.time, args.value);
  else if (args.time !== undefined && p.numKeys > 0) p.setValueAtTime(args.time, args.value);
  else p.setValue(args.value);
  return { ok: true };
};

OPS.set_effect_enabled = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  l.property("Effects").property(args.effectIndex).enabled = !!args.enabled;
  return { ok: true };
};

OPS.list_available_effects = noUndo(function (args) {
  // app.effects is an array of {displayName, matchName, category, version} on modern AE.
  var out = [];
  try {
    var fx = app.effects;
    for (var i = 0; i < fx.length; i++) {
      out.push({ displayName: fx[i].displayName, matchName: fx[i].matchName, category: fx[i].category });
    }
  } catch (e) {
    // Fallback: return a curated subset of common match names.
    out = [
      { displayName: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", category: "Blur & Sharpen" },
      { displayName: "Fast Box Blur", matchName: "ADBE Box Blur2", category: "Blur & Sharpen" },
      { displayName: "Glow", matchName: "ADBE Glo2", category: "Stylize" },
      { displayName: "Drop Shadow", matchName: "ADBE Drop Shadow", category: "Perspective" },
      { displayName: "Curves", matchName: "ADBE CurvesCustom", category: "Color Correction" },
      { displayName: "Levels", matchName: "ADBE Easy Levels2", category: "Color Correction" },
      { displayName: "Fill", matchName: "ADBE Fill", category: "Generate" },
      { displayName: "CC Light Sweep", matchName: "CC Light Sweep", category: "Generate" },
    ];
  }
  return out;
});
