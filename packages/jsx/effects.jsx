// effects.jsx — effect graph ops.

// Effect parameters are bounded by default (issue #115). Every built-in
// effect has under 15 parameters and the heaviest common third-party ones
// (Saber, Warp Stabilizer) under 100, but Trapcode Particular exposes 7,401 —
// one list_effects on it was 1 MB, ~265k tokens, re-sent on every later
// request. 200 returns every ordinary effect whole and caps a pathological one
// at a few thousand tokens. This is a deliberate exception to "absent means
// everything", the same way find_layers' bounded default is: what is left out
// is always counted (paramCount, paramsOmitted) and named (paramsTruncated),
// so a capped effect never passes for a complete one.
var __EFFECT_PARAMS_DEFAULT = 200;

// One parse of maxParams/paramFilter per call, shared by every effect in it.
// paramFilter is a case-insensitive regex over each parameter's name and
// matchName, the same convention as find_layers' name filter.
function __effectParamOpts(args) {
  var max = (args && args.maxParams > 0) ? args.maxParams : __EFFECT_PARAMS_DEFAULT;
  var re = null;
  if (args && typeof args.paramFilter === "string" && args.paramFilter.length > 0) {
    try { re = new RegExp(args.paramFilter, "i"); }
    catch (e) { throw new Error("paramFilter is not a valid regular expression: " + args.paramFilter); }
  }
  return { maxParams: max, paramFilter: re, paramFilterSource: re ? args.paramFilter : null };
}

function __paramsTruncationNote(total, returned, matched, popts) {
  if (popts.paramFilter) {
    var head = "paramFilter /" + popts.paramFilterSource + "/ matched " + matched + " of " + total + " parameters";
    if (matched > returned) {
      return head + "; first " + returned + " returned, " + (matched - returned) + " more matches omitted — raise maxParams";
    }
    return head + "; the other " + (total - matched) + " omitted";
  }
  return "first " + returned + " of " + total + " parameters; " + (total - returned) + " omitted — raise maxParams " +
    "(up to " + total + "), or pass paramFilter, a regex over parameter name/matchName, to read only the ones you need";
}

// `popts` comes from __effectParamOpts; absent means the default cap, never
// "everything".
function __serializeEffect(eff, popts) {
  if (!popts) popts = __effectParamOpts(null);
  var max = popts.maxParams;
  var re = popts.paramFilter;
  var total = eff.numProperties;
  var out = { name: eff.name, matchName: eff.matchName, enabled: eff.enabled, index: eff.propertyIndex, paramCount: total, params: [] };
  var matched = 0;
  for (var i = 1; i <= total; i++) {
    var p = eff.property(i);
    if (re && !(re.test(p.name) || re.test(p.matchName))) continue;
    matched++;
    if (out.params.length >= max) {
      // Unfiltered, the rest is only counted, so stop walking; filtered, keep
      // going so the matched count is exact.
      if (!re) break;
      continue;
    }
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
  if (re) out.paramsMatched = matched;
  else matched = total;
  var omitted = total - out.params.length;
  if (omitted > 0) {
    out.paramsOmitted = omitted;
    out.paramsTruncated = __paramsTruncationNote(total, out.params.length, matched, popts);
  }
  return out;
}

OPS.list_effects = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var fx = l.property("Effects");
  if (!fx) return [];
  var popts = __effectParamOpts(args);
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) out.push(__serializeEffect(fx.property(i), popts));
  return out;
});

// The new effect comes back under the default parameter cap: adding Particular
// should not return 265k tokens nobody asked to read.
OPS.add_effect = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var fx = l.property("Effects");
  var eff = fx.addProperty(args.matchName);
  return __serializeEffect(eff, __effectParamOpts(null));
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

// Enumerating app.effects is very slow — around 250 entries in AE 26.3, slow
// enough that a hand-rolled loop over it in run_jsx blocks the panel's socket
// past the server's timeout and presents as a dead bridge (issue #26). The
// table only changes when a plugin is installed, which needs an AE restart,
// which reloads this bundle — so caching it for the life of the session is
// exact, not merely close enough. Refreshing is available for the case where a
// user swears they just installed something.
var __availableEffects = null;

function __enumerateEffects() {
  // app.effects is an array of {displayName, matchName, category, version} on modern AE.
  var fx;
  try {
    fx = app.effects;
  } catch (e) {
    fx = null;
  }
  if (!fx || fx.length === undefined) {
    // No silent curated substitute here. Handing back eight effects that look
    // like the whole list makes "not installed" indistinguishable from "not
    // enumerated", and an agent then rules out an effect that is right there.
    throw new Error(
      "Cannot read app.effects on this After Effects build, so the installed-effect list is unavailable. " +
        "Add effects by matchName directly — add_effect fails immediately and clearly on a wrong one. " +
        "Common matchNames: ADBE Gaussian Blur 2 (Gaussian Blur), ADBE Box Blur2 (Fast Box Blur), " +
        "ADBE Glo2 (Glow), ADBE Drop Shadow, ADBE CurvesCustom (Curves), ADBE Easy Levels2 (Levels), " +
        "ADBE Fill, CC Light Sweep."
    );
  }
  var out = [];
  for (var i = 0; i < fx.length; i++) {
    out.push({ displayName: fx[i].displayName, matchName: fx[i].matchName, category: fx[i].category });
  }
  return out;
}

OPS.list_available_effects = noUndo(function (args) {
  if (!args) args = {};
  // Only a successful enumeration is cached; a throw leaves the cache empty so
  // the next call retries rather than repeating a stale failure.
  if (args.refresh || !__availableEffects) __availableEffects = __enumerateEffects();
  if (!args.filter) return __availableEffects;

  var q = String(args.filter).toLowerCase();
  var hits = [];
  for (var i = 0; i < __availableEffects.length; i++) {
    var entry = __availableEffects[i];
    var hay = String(entry.displayName) + " " + String(entry.matchName) + " " + String(entry.category);
    if (hay.toLowerCase().indexOf(q) !== -1) hits.push(entry);
  }
  return hits;
});
