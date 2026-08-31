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
// __UNDO_OPEN tracks whether a group *this bundle* opened is currently open.
// withUndo() is the only thing that may set it — dispatch and run_batch both
// group through there — because it is what lets withoutUndoGroup() reopen
// exactly what it closed, and leave undo state alone entirely when we never
// opened a group in the first place.
var __UNDO_OPEN = false;

// Every undo group this bundle opens is counted here, and __beginUndoGroup is
// the only place allowed to call app.beginUndoGroup. run_batch reports the
// number of undo steps it cost as the *delta* of this counter, so the number an
// agent repeats to the user as "press Cmd-Z N times" is measured rather than
// predicted — a chunk that threw still opened its group, and a batched op that
// called withoutUndoGroup() really did split itself into two steps.
var __UNDO_GROUPS = 0;

function __beginUndoGroup(name) {
  __UNDO_GROUPS += 1;
  app.beginUndoGroup(name || "AE MCP");
}

function __undoGroupsOpened() { return __UNDO_GROUPS; }

// An undo group must open and close inside ONE evalScript call. After Effects
// discards one that spans two — see the note in CLAUDE.md; measured, not
// inferred. Everything that groups goes through here for that reason.
function withUndo(name, fn) {
  __beginUndoGroup(name || "AE MCP");
  __UNDO_OPEN = true;
  try { return fn(); }
  finally { __UNDO_OPEN = false; app.endUndoGroup(); }
}

// Run fn with the dispatcher's undo group closed, then reopen it.
// After Effects refuses a handful of operations while an undo group is open —
// copyToComp on a layer with a parent or a linked expression is the one that
// bites (issue #30). No-op when no group of ours is open, so it is always safe
// to call. The work inside becomes its own undo step, separate from the rest.
function withoutUndoGroup(fn) {
  if (!__UNDO_OPEN) return fn();
  app.endUndoGroup();
  __UNDO_OPEN = false;
  try { return fn(); }
  finally { __beginUndoGroup("AE MCP: continue"); __UNDO_OPEN = true; }
}

// ---------- Error helper ----------
// A handler that can say more about *where* it failed than "an error happened"
// attaches that on `aeDetail` and it is copied onto the result verbatim —
// run_jsx maps After Effects' line number back onto the script the caller
// actually submitted (issue #46). The bag is free-form here on purpose; the
// panel forwards a named list of fields, which is where the contract is kept.
function __mkError(e) {
  var msg = e && e.message ? String(e.message) : String(e);
  var stack = e && e.stack ? String(e.stack) : "";
  var line = e && typeof e.line !== "undefined" ? e.line : null;
  var out = { ok: false, error: msg, stack: stack, line: line };
  var detail = null;
  try { if (e && e.aeDetail) detail = e.aeDetail; } catch (ed) {}
  if (detail) {
    for (var k in detail) {
      if (detail.hasOwnProperty(k)) out[k] = detail[k];
    }
  }
  return out;
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
    // __meta.noUndo is a boolean for handlers that never want a group, or a
    // predicate over args for ops where the caller decides per call (run_jsx).
    // Keeping the predicate on the handler is what stops one op's opt-out from
    // leaking into the next: dispatch never remembers anything between calls.
    var skipUndo = meta.noUndo;
    if (typeof skipUndo === "function") skipUndo = skipUndo(args);
    if (skipUndo) {
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
// Same, but the handler decides per call from its own args.
function noUndoWhen(pred, fn) { fn.__meta = { noUndo: pred }; return fn; }
function undoNamed(name, fn) { fn.__meta = { undoName: name }; return fn; }
