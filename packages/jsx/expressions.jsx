// expressions.jsx — get/set/toggle/clear expressions on any property.

OPS.get_expression = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  return { expression: prop.expression || "", enabled: !!prop.expressionEnabled };
});

OPS.set_expression = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.expression = args.expression || "";
  prop.expressionEnabled = true;
  return { ok: true };
};

OPS.toggle_expression = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.expressionEnabled = !!args.enabled;
  return { ok: true };
};

OPS.clear_expression = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  var prop = walkProperty(l, args.propertyPath);
  prop.expression = "";
  return { ok: true };
};
