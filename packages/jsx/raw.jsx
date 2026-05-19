// raw.jsx — escape hatch. Eval arbitrary ExtendScript and return the value.

OPS.run_jsx = function (args) {
  var code = args.code || "";
  // We wrap in a function so `return` works.
  var wrapper = "(function(){ " + code + " })()";
  var result;
  try { result = eval(wrapper); }
  catch (e) { throw e; }
  // ExtendScript objects can be unserializable; coerce sparingly.
  if (typeof result === "undefined") return null;
  if (result === null) return null;
  var t = typeof result;
  if (t === "number" || t === "string" || t === "boolean") return result;
  if (result instanceof Array) return result;
  // Object: pull plain own props
  try {
    var out = {};
    for (var k in result) {
      if (result.hasOwnProperty(k)) {
        var v = result[k];
        var vt = typeof v;
        if (v === null || vt === "number" || vt === "string" || vt === "boolean") out[k] = v;
      }
    }
    return out;
  } catch (e2) { return String(result); }
};
