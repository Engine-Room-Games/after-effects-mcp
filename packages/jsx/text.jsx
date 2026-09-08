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

// The name for an enum value, for results and errors. AE has more FULL_JUSTIFY
// variants than the map offers, so a value the map does not know comes back as
// its number rather than as the nearest name.
function __justificationName(v) {
  for (var k in __JUSTIFICATION) {
    if (__JUSTIFICATION.hasOwnProperty(k) && __JUSTIFICATION[k] === v) return k;
  }
  return String(v);
}

// Issue #93: on AE 26.3 the TextDocument round trip — read `.value`, change
// `.text`, `setValue()` — has come back with justification reset to CENTER
// even though the document that went in still said LEFT; issue #94 reports the
// setter storing RIGHT when handed CENTER from a script. Nothing raises in
// either case and the mechanism is unknown, so the only guard that can be built
// blind is the one this repo asks for anyway: read the property back and
// compare with what should be there. A second write of the justification alone
// has been seen to land (`set_text({justification})` on its own always did), so
// one re-assert is tried before giving up. If that also disagrees, the caller
// is told what was expected and what the layer actually shows — a text layer
// that silently re-centres is the failure this codebase refuses everywhere.
//
// `expected` is an enum value: the requested one, or the one read before the
// mutation. Returns {justification, reasserted}; throws when it cannot deliver.
function __verifyJustification(src, expected) {
  var actual = src.value.justification;
  if (actual === expected) return { justification: actual, reasserted: false };
  var again = src.value;
  again.justification = expected;
  src.setValue(again);
  actual = src.value.justification;
  if (actual === expected) return { justification: actual, reasserted: true };
  throw new Error(
    "Source Text justification did not land: expected " + __justificationName(expected) +
    " (" + String(expected) + "), the layer reads " + __justificationName(actual) +
    " (" + String(actual) + ") after a second write. The other fields were written. " +
    "Read the layer back with get_layer_full include:[\"text\"] before relying on its alignment."
  );
}

OPS.set_text = function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  if (!(l instanceof TextLayer)) throw new Error("Layer is not a TextLayer");
  var src = l.property("Source Text");
  var td = src.value;
  // Captured before anything is touched: "undefined fields unchanged" is a
  // claim about this value, and it is what the read-back is checked against
  // when no justification was asked for.
  var justificationBefore = td.justification;
  var justificationWanted = justificationBefore;
  if (args.justification !== undefined) {
    if (__JUSTIFICATION[args.justification] === undefined) {
      throw new Error("Unknown justification '" + String(args.justification) + "'; expected one of left, center, right, full. Nothing was changed.");
    }
    justificationWanted = __JUSTIFICATION[args.justification];
  }
  if (args.text !== undefined) td.text = args.text;
  if (args.font !== undefined) td.font = args.font;
  if (args.size !== undefined) td.fontSize = args.size;
  if (args.fillColor) { td.applyFill = true; td.fillColor = [args.fillColor[0], args.fillColor[1], args.fillColor[2]]; }
  if (args.strokeColor) { td.applyStroke = true; td.strokeColor = [args.strokeColor[0], args.strokeColor[1], args.strokeColor[2]]; }
  if (args.strokeWidth !== undefined) td.strokeWidth = args.strokeWidth;
  if (args.tracking !== undefined) td.tracking = args.tracking;
  if (args.leading !== undefined) td.leading = args.leading;
  if (args.justification !== undefined) td.justification = justificationWanted;
  if (args.applyFill !== undefined) td.applyFill = args.applyFill;
  if (args.applyStroke !== undefined) td.applyStroke = args.applyStroke;
  if (args.fauxBold !== undefined) td.fauxBold = args.fauxBold;
  if (args.fauxItalic !== undefined) td.fauxItalic = args.fauxItalic;
  if (args.allCaps !== undefined) td.allCaps = args.allCaps;
  if (args.smallCaps !== undefined) td.smallCaps = args.smallCaps;
  if (args.baselineShift !== undefined) td.baselineShift = args.baselineShift;
  src.setValue(td);
  var verified = __verifyJustification(src, justificationWanted);
  return {
    ok: true,
    justification: __justificationName(verified.justification),
    justificationReasserted: verified.reasserted,
  };
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
