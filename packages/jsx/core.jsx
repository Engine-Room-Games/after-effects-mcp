// core.jsx — JSON polyfill, dispatcher, undo wrapper, async job table.
// ExtendScript is ES3-ish; no let/const/arrow/template-literals.

// ---------- JSON polyfill (defensive; AE 2026 has JSON natively but we never know) ----------
if (typeof JSON === "undefined") { JSON = {}; }
if (typeof JSON.stringify !== "function") {
  JSON.stringify = (function () {
    function quote(s) {
      var r = '"';
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i), cc = s.charCodeAt(i);
        if (c === '"') r += '\\"';
        else if (c === "\\") r += "\\\\";
        else if (c === "\n") r += "\\n";
        else if (c === "\r") r += "\\r";
        else if (c === "\t") r += "\\t";
        else if (c === "\b") r += "\\b";
        else if (c === "\f") r += "\\f";
        else if (cc < 0x20) {
          var h = cc.toString(16); while (h.length < 4) h = "0" + h;
          r += "\\u" + h;
        } else r += c;
      }
      return r + '"';
    }
    function str(v) {
      if (v === null) return "null";
      if (v === undefined) return "null";
      var t = typeof v;
      if (t === "number") return isFinite(v) ? String(v) : "null";
      if (t === "boolean") return v ? "true" : "false";
      if (t === "string") return quote(v);
      if (t === "object") {
        if (v instanceof Array) {
          var a = [];
          for (var i = 0; i < v.length; i++) a.push(str(v[i]));
          return "[" + a.join(",") + "]";
        }
        var keys = [];
        for (var k in v) { if (v.hasOwnProperty(k)) keys.push(k); }
        var parts = [];
        for (var j = 0; j < keys.length; j++) {
          var val = str(v[keys[j]]);
          if (val !== undefined) parts.push(quote(keys[j]) + ":" + val);
        }
        return "{" + parts.join(",") + "}";
      }
      return "null";
    }
    return function (v) { return str(v); };
  })();
}
if (typeof JSON.parse !== "function") {
  JSON.parse = function (text) { return eval("(" + text + ")"); };
}

// ---------- Global registry ----------
var OPS = OPS || {};
var JOBS = JOBS || {};
var __JOB_SEQ = __JOB_SEQ || 0;

function __newJobId() {
  __JOB_SEQ += 1;
  return "j_" + (new Date().getTime()) + "_" + __JOB_SEQ;
}

// ---------- Undo wrapper ----------
function withUndo(name, fn) {
  app.beginUndoGroup(name || "AE MCP");
  try { return fn(); }
  finally { app.endUndoGroup(); }
}

// ---------- Error helper ----------
function __mkError(e) {
  var msg = e && e.message ? String(e.message) : String(e);
  var stack = e && e.stack ? String(e.stack) : "";
  var line = e && typeof e.line !== "undefined" ? e.line : null;
  return { ok: false, error: msg, stack: stack, line: line };
}

// ---------- Main dispatch ----------
// Called from panel with a JSON string payload {op, args, requestId}.
// Returns a plain object {ok, result|error}. Panel JSON.stringifys.
function dispatch(payloadJson) {
  var payload;
  try { payload = JSON.parse(payloadJson); }
  catch (e) { return { ok: false, error: "Bad payload JSON: " + e.message }; }
  var op = payload.op;
  var args = payload.args || {};
  if (!OPS.hasOwnProperty(op)) return { ok: false, error: "Unknown op: " + op };
  try {
    var handler = OPS[op];
    var meta = handler.__meta || {};
    if (meta.noUndo) {
      return { ok: true, result: handler(args) };
    }
    var result = withUndo(meta.undoName || ("AE MCP: " + op), function () { return handler(args); });
    return { ok: true, result: result };
  } catch (e) {
    return __mkError(e);
  }
}

// Helper for handlers that don't want an undo group (read-only ops, job continuations).
function noUndo(fn) { fn.__meta = { noUndo: true }; return fn; }
function undoNamed(name, fn) { fn.__meta = { undoName: name }; return fn; }
