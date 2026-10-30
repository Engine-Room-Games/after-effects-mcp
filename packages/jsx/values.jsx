// values.jsx — setValue that does not report a failure for a write that landed.
//
// Issue #129. In a comp that is not open in any viewer, Property.setValue() on a
// shape rectangle's Size can throw
//
//     Error: invalid numeric result (divide by zero?)
//
// for every rect after the first one written — and the value is applied
// anyway. Reading the property back shows exactly what was asked for. The
// reporter's comp read a negative `comp.time` (it was nested further down a
// parent's timeline), setting `comp.time` did not help, and the same writes in a
// comp open in the viewer never threw. The best guess is that AE re-evaluates
// the comp after the write, has no viewer time to evaluate it at, and surfaces
// that evaluation's error as the setValue exception.
//
// What that does to the first-class ops is the mirror of "never report success
// for work that didn't happen": add_shape_content catches the throw, counts the
// key as failed, REMOVES THE NODE IT BUILT and tells the agent nothing changed —
// so the agent retries, and hits the same throw on the same comp. Reporting a
// failure for work that happened is as wrong as the other way round.
//
// So: when setValue throws THIS error, read the property back. If it holds the
// value that was asked for, the write happened and the throw is dropped.
// Anything else — a different error, a value that did not land, a value we have
// no way to compare — rethrows the original error untouched. Nothing here can
// turn a real failure into a success: success needs the read-back to agree.
//
// What it deliberately does not do is call comp.openInViewer(), the other known
// workaround. That changes which comp the user is looking at, from a call that
// asked for nothing of the sort.

var __SPURIOUS_SETVALUE = /invalid numeric result/i;

function __isSpuriousSetValueError(e) {
  var msg = "";
  try { msg = String(e && e.message !== undefined ? e.message : e); } catch (x) { msg = ""; }
  return __SPURIOUS_SETVALUE.test(msg);
}

function __numClose(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (a === b) return true;
  if (isNaN(a) || isNaN(b)) return false;
  var scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-4 * scale;
}

function __numArrayClose(want, got, allowExtra) {
  if (!(want instanceof Array) || !(got instanceof Array)) return false;
  if (got.length < want.length) return false;
  // A 2D layer's Position reads back with a third component of 0 when it was
  // written with two. Extra components are tolerated only when they are zero —
  // the value AE fills in — and only where the caller allows it.
  // A colour written as [r, g, b] reads back as [r, g, b, 1] — AE fills in the
  // alpha (measured on a shape Fill Color, AE 26.5). That one extra component
  // is tolerated at 1 as well.
  if (got.length > want.length) {
    if (!allowExtra) return false;
    for (var x = want.length; x < got.length; x++) {
      if (__numClose(0, got[x])) continue;
      if (want.length === 3 && got.length === 4 && x === 3 && __numClose(1, got[x])) continue;
      return false;
    }
  }
  for (var i = 0; i < want.length; i++) { if (!__numClose(want[i], got[i])) return false; }
  return true;
}

function __pointListClose(want, got) {
  // Omitted tangents: a fresh `new Shape()` holds `[]` for them (not
  // undefined), and AE reads them back as one [0, 0] per vertex. Measured, AE 26.5.
  if (!want || want.length === 0) return !got || got.length === 0 || __allZeroPoints(got);
  if (!got || want.length !== got.length) return false;
  for (var i = 0; i < want.length; i++) { if (!__numArrayClose(want[i], got[i], false)) return false; }
  return true;
}

function __allZeroPoints(list) {
  for (var i = 0; i < list.length; i++) {
    for (var j = 0; j < list[i].length; j++) { if (!__numClose(0, list[i][j])) return false; }
  }
  return true;
}

// Does `got` (what the property reads back) hold `want` (what was written)?
// Numbers, numeric arrays and Shapes are comparable. Anything else — a
// TextDocument, a marker — answers false, which means the original error is
// rethrown: unknown is never read as success.
function __valueMatches(want, got) {
  if (typeof want === "number") return __numClose(want, got);
  if (typeof want === "boolean") return typeof got === "boolean" ? want === got : __numClose(want ? 1 : 0, got);
  if (want instanceof Array) return __numArrayClose(want, got, true);
  if (want && typeof want === "object" && want.vertices !== undefined) {
    if (!got || typeof got !== "object" || got.vertices === undefined) return false;
    if (!__pointListClose(want.vertices, got.vertices)) return false;
    if (!__pointListClose(want.inTangents, got.inTangents)) return false;
    if (!__pointListClose(want.outTangents, got.outTangents)) return false;
    if (want.closed !== undefined && !!want.closed !== !!got.closed) return false;
    return true;
  }
  return false;
}

// The property's own value, before any expression. `value` is post-expression,
// so a property with an expression on it would never compare equal to what was
// written; valueAtTime(t, true) is the pre-expression value, and for a property
// with no keyframes it is the same at every t.
function __readBackForCompare(prop) {
  var hasExpr = false;
  try { hasExpr = !!prop.expressionEnabled && String(prop.expression) !== ""; } catch (e) { hasExpr = false; }
  var keyed = 0;
  try { keyed = prop.numKeys || 0; } catch (e2) { keyed = 0; }
  if (hasExpr && keyed === 0) {
    try { return { ok: true, value: prop.valueAtTime(0, true) }; } catch (e3) {}
  }
  try { return { ok: true, value: prop.value }; } catch (e4) { return { ok: false }; }
}

// setValue, minus the #129 false failure. Returns true when it absorbed that
// throw — the write landed and AE said otherwise — and false for a clean write.
// Throws the original error for anything else.
function __setValue(prop, value) {
  try {
    prop.setValue(value);
    return false;
  } catch (e) {
    if (!__isSpuriousSetValueError(e)) throw e;
    var back = __readBackForCompare(prop);
    if (back.ok && __valueMatches(value, back.value)) return true;
    throw e;
  }
}

// keyframe:true with no time used to fall through to a static write and report
// ok (issue #151). The schema refuses it before the call gets here; this is the
// same refusal for a caller that reaches OPS directly (run_jsx). Used by
// set_transform, set_effect_param and set_shape_property.
function __requireKeyTime(keyframe, time, op) {
  if (keyframe && (time === undefined || time === null)) {
    throw new Error(
      op + ": keyframe:true needs `time` (the keyframe's time in comp seconds). " +
      "Nothing was changed. Pass `time`, or drop `keyframe` to set a static value."
    );
  }
}

// The one write path for an op that takes `value` plus optional `time` and
// `keyframe`: set_transform, set_effect_param, set_shape_property (issue #184).
// It lives here rather than in transforms.jsx because
// tests/unit/effect-param-lookup.mjs loads effects.jsx with values.jsx alone.
//
//   keyframe + time   -> a keyframe at `time`
//   time, no keyframe -> a keyframe at `time` if the property is already
//                        animated, otherwise the static value
//   no time           -> the static value
//
// A null time is no time. Static writes go through __setValue (#129); keyframe
// writes do not, since the false throw was only ever measured on setValue.
// keyframe:true without a time is refused before anything is written. Every
// caller checks that itself first, with its own op name; this is the backstop.
function __setOrKeyAtTime(prop, value, time, keyframe, op) {
  __requireKeyTime(keyframe, time, op || "__setOrKeyAtTime");
  value = __hexValue(prop, value, op || "__setOrKeyAtTime");
  var hasTime = time !== undefined && time !== null;
  if (hasTime && (keyframe || prop.numKeys > 0)) prop.setValueAtTime(time, value);
  else __setValue(prop, value);
}

// Hex colours (issue #170). The schema lets a `value` be a hex string, checked
// for form only: whether it may be a colour depends on the property, and only
// After Effects knows that. A colour property gets [r,g,b] 0..1 (AE fills in
// an alpha of 1) and anything else is refused, rather than a hex aimed at
// Position landing there as three small numbers. No alpha form: AE 26.5 stores
// a colour's alpha and renders it as 1 regardless (see HEX_RGB in schemas.ts).
// The arithmetic is hexToRgb's in schemas.ts; tests/unit/hex-colour.mjs holds
// the two to the same answers.
var __HEX_COLOUR = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function __hexToRgb(hex) {
  var h = String(hex).replace(/^#/, "");
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255];
}

// `value` unchanged unless it is a string; a hex string becomes its channels
// when `prop` is a colour property, and is refused otherwise. Nothing is
// written here, so a refusal leaves the property as it was.
function __hexValue(prop, value, op) {
  if (typeof value !== "string") return value;
  if (!__HEX_COLOUR.test(value)) {
    throw new Error(op + ": value '" + value + "' is a string but not a hex colour ('#ff8800' or '#f80'; a colour's alpha is ignored by After Effects, so no '#ff8800cc'). Nothing was changed.");
  }
  var isColour = false;
  try { isColour = prop.propertyValueType === PropertyValueType.COLOR; } catch (e) { isColour = false; }
  if (!isColour) {
    var label = "this property";
    try { label = "'" + prop.name + "' (" + prop.matchName + ")"; } catch (e2) { label = "this property"; }
    throw new Error(op + ": value '" + value + "' is a hex colour, but " + label +
      " is not a colour property. Nothing was changed. Pass a number or an array of numbers.");
  }
  return __hexToRgb(value);
}
