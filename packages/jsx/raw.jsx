// raw.jsx — escape hatch. Eval arbitrary ExtendScript and return the value.

// ---------- Result serialization ----------
// The returned value has to survive JSON.stringify in the panel. Anything that
// cannot be represented is replaced *in place* by a short marker string, never
// dropped: the old coercion kept scalars only, so {done:[...], skipped:[...]}
// came back as {} — indistinguishable from "the script did nothing" while its
// mutations had already landed, which invites re-running a mutating script
// (issue #31). An empty result must mean the script returned nothing.
//
// The walk is deliberately opt-in: only arrays and plain objects are recursed
// into. Live AE objects (Layer, Property, CompItem …) have huge and partly
// throwing property graphs, so they degrade to "[AVLayer \"name\"]" rather than
// being walked.

var __RJ_MAX_DEPTH = 12;
var __RJ_MAX_NODES = 50000;

function __rjIsPlainObject(v) {
  try { if (v.constructor === Object) return true; } catch (e) {}
  try { if (v.reflect && v.reflect.name === "Object") return true; } catch (e2) {}
  return false;
}

function __rjTypeName(v) {
  var n = null;
  try { if (v.reflect && v.reflect.name) n = String(v.reflect.name); } catch (e) {}
  if (!n) {
    try {
      n = String(v);
      if (n.substring(0, 8) === "[object ") n = n.substring(8, n.length - 1);
    } catch (e2) { n = "object"; }
  }
  if (n.length > 48) n = n.substring(0, 48);
  return n;
}

// Short, identifiable stand-in for a value we refuse to walk. The name and id
// are worth the two guarded reads: they are what turns "something was here"
// into a handle the caller can pass to get_comp or get_layer_full.
function __rjMarker(v) {
  var extra = "";
  try {
    if (typeof v.name === "string" && v.name.length > 0 && v.name.length < 64) extra = ' "' + v.name + '"';
  } catch (e) {}
  try {
    if (typeof v.id === "number") extra += " #" + v.id;
  } catch (e2) {}
  return "[" + __rjTypeName(v) + extra + "]";
}

// `stack` holds the ancestors currently being walked, so a repeated reference
// that is not a cycle still serializes. ES3 has no Set — a linear scan over a
// depth-limited stack is cheap enough.
function __rjSerialize(v, depth, stack, budget) {
  if (v === null) return null;
  var t = typeof v;
  if (t === "undefined") return "[undefined]";
  if (t === "boolean" || t === "string") return v;
  if (t === "number") {
    if (isNaN(v)) return "[NaN]";
    if (!isFinite(v)) return v > 0 ? "[Infinity]" : "[-Infinity]";
    return v;
  }
  if (t === "function") return "[function]";
  if (t !== "object") return "[" + t + "]";
  if (v instanceof Date) return String(v);

  budget.n += 1;
  if (budget.n > __RJ_MAX_NODES) return "[truncated: node limit]";

  var isArray = (v instanceof Array);
  if (!isArray && !__rjIsPlainObject(v)) return __rjMarker(v);

  for (var s = 0; s < stack.length; s++) { if (stack[s] === v) return "[circular]"; }
  if (depth >= __RJ_MAX_DEPTH) return "[max depth]";

  stack.push(v);
  var out;
  try {
    if (isArray) {
      out = [];
      for (var i = 0; i < v.length; i++) out.push(__rjSerialize(v[i], depth + 1, stack, budget));
    } else {
      out = {};
      for (var k in v) {
        if (!v.hasOwnProperty(k)) continue;
        var val;
        try { val = v[k]; }
        catch (eg) { out[k] = "[threw: " + (eg && eg.message ? eg.message : String(eg)) + "]"; continue; }
        out[k] = __rjSerialize(val, depth + 1, stack, budget);
      }
    }
  } finally {
    stack.pop();
  }
  return out;
}

function __rjResult(result) {
  // A script with no `return` returns undefined at the top level; that is
  // genuinely "nothing", not an unserializable value.
  if (typeof result === "undefined") return null;
  return __rjSerialize(result, 0, [], { n: 0 });
}

// undoGroup:false is a per-call opt-out, read by dispatch() through the
// predicate form of __meta.noUndo. It exists because AE refuses copyToComp for
// a layer with a parent or a linked expression while an undo group is open,
// which is exactly the layer worth copying (issue #30).
OPS.run_jsx = noUndoWhen(function (args) { return args.undoGroup === false; }, function (args) {
  var code = args.code || "";
  // We wrap in a function so `return` works.
  var wrapper = "(function(){ " + code + " })()";
  return __rjResult(eval(wrapper));
});
