// expressions.jsx — get/set/toggle/clear expressions on any property.

// After Effects reports a broken expression on `Property.expressionError` and
// nowhere a script can otherwise see: assigning `.expression` succeeds whatever
// the text says, and the failure is a warning banner in the UI (issue #97).
// The field is filled in when the expression is *evaluated*, which a bare
// assignment does not necessarily do — so the value is read first, inside a
// try, purely to force one evaluation. Whether AE would populate the field
// without that nudge cannot be settled offline; forcing it costs one evaluation
// and makes the answer independent of the question. `.value` throws on a
// property that has none (a group), which is also not an expression error.
function __expressionError(prop) {
  try { var forced = prop.value; } catch (e) {}
  var err = "";
  try { err = prop.expressionError; } catch (e2) { err = ""; }
  return err ? String(err) : "";
}

function __propertyPathLabel(path) {
  var parts = [];
  for (var i = 0; i < path.length; i++) parts.push(String(path[i]));
  return parts.join(" > ");
}

// Throws if the expression on `prop` does not evaluate, naming the property,
// AE's own message and both ways forward. The expression stays written — the
// message says so — because nothing here rolls back and a caller fixing a
// typo wants the property it was aimed at, not a cleared one.
function __assertExpressionEvaluates(prop, path, verb) {
  var err = __expressionError(prop);
  if (!err) return;
  var enabledNow;
  try { enabledNow = !!prop.expressionEnabled; } catch (e) { enabledNow = null; }
  throw new Error(
    "Expression on " + __propertyPathLabel(path) + " was " + verb +
    " but After Effects cannot evaluate it: " + err +
    (enabledNow === false ? " (After Effects has disabled it.)" : "") +
    " Fix the expression and call set_expression again, or clear_expression to remove it."
  );
}

OPS.get_expression = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  return {
    expression: prop.expression || "",
    enabled: !!prop.expressionEnabled,
    expressionError: __expressionError(prop),
  };
});

OPS.set_expression = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.expression = args.expression || "";
  prop.expressionEnabled = true;
  __assertExpressionEvaluates(prop, args.propertyPath, "written");
  return { ok: true };
};

OPS.toggle_expression = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.expressionEnabled = !!args.enabled;
  // Disabling cannot fail this way; enabling can surface an error that has
  // been sitting on the property since it was disabled.
  if (args.enabled) __assertExpressionEvaluates(prop, args.propertyPath, "enabled");
  return { ok: true };
};

OPS.clear_expression = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.expression = "";
  return { ok: true };
};
