// text.jsx — text layer styling.

// Shared with create_text_layer, which implements `anchorAlign` as live
// paragraph justification rather than a one-time anchor offset. One map so the
// two cannot drift.
var __JUSTIFICATION = {
  left: ParagraphJustification.LEFT_JUSTIFY,
  center: ParagraphJustification.CENTER_JUSTIFY,
  right: ParagraphJustification.RIGHT_JUSTIFY,
  full: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT,
};

OPS.set_text = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (!(l instanceof TextLayer)) throw new Error("Layer is not a TextLayer");
  var src = l.property("Source Text");
  var td = src.value;
  if (args.text !== undefined) td.text = args.text;
  if (args.font !== undefined) td.font = args.font;
  if (args.size !== undefined) td.fontSize = args.size;
  if (args.fillColor) { td.applyFill = true; td.fillColor = [args.fillColor[0], args.fillColor[1], args.fillColor[2]]; }
  if (args.strokeColor) { td.applyStroke = true; td.strokeColor = [args.strokeColor[0], args.strokeColor[1], args.strokeColor[2]]; }
  if (args.strokeWidth !== undefined) td.strokeWidth = args.strokeWidth;
  if (args.tracking !== undefined) td.tracking = args.tracking;
  if (args.leading !== undefined) td.leading = args.leading;
  if (args.justification !== undefined) {
    if (__JUSTIFICATION[args.justification]) td.justification = __JUSTIFICATION[args.justification];
  }
  if (args.applyFill !== undefined) td.applyFill = args.applyFill;
  if (args.applyStroke !== undefined) td.applyStroke = args.applyStroke;
  if (args.fauxBold !== undefined) td.fauxBold = args.fauxBold;
  if (args.fauxItalic !== undefined) td.fauxItalic = args.fauxItalic;
  if (args.allCaps !== undefined) td.allCaps = args.allCaps;
  if (args.smallCaps !== undefined) td.smallCaps = args.smallCaps;
  if (args.baselineShift !== undefined) td.baselineShift = args.baselineShift;
  src.setValue(td);
  return { ok: true };
};

OPS.add_text_animator = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (!(l instanceof TextLayer)) throw new Error("Layer is not a TextLayer");
  var anims = l.property("Text").property("Animators");
  var anim = anims.addProperty("ADBE Text Animator");
  var typeMap = {
    position: "ADBE Text Position 3D",
    scale: "ADBE Text Scale 3D",
    rotation: "ADBE Text Rotation",
    opacity: "ADBE Text Opacity",
    tracking: "ADBE Text Tracking Amount",
    skew: "ADBE Text Skew",
    fillColor: "ADBE Text Fill Color",
    strokeColor: "ADBE Text Stroke Color",
  };
  var propsGroup = anim.property("ADBE Text Animator Properties");
  if (typeMap[args.type]) {
    try { propsGroup.addProperty(typeMap[args.type]); }
    catch (e) {}
  }
  if (args.range) {
    var selectors = anim.property("ADBE Text Selectors");
    if (selectors.numProperties === 0) selectors.addProperty("ADBE Text Selector");
    var sel = selectors.property(1);
    if (args.range.start !== undefined) sel.property("ADBE Text Percent Start").setValue(args.range.start);
    if (args.range.end !== undefined) sel.property("ADBE Text Percent End").setValue(args.range.end);
    if (args.range.offset !== undefined) sel.property("ADBE Text Percent Offset").setValue(args.range.offset);
  }
  return { ok: true, animatorName: anim.name };
};
