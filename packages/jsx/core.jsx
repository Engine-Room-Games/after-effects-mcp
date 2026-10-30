// core.jsx — JSON polyfill, dispatcher, undo wrapper, async job table.
// ExtendScript is ES3-ish; no let/const/arrow/template-literals.

// ---------- JSON: a private copy (issue #185) ----------
// The bundle runs in After Effects' shared `main` engine, where any other
// script can replace the global JSON — json2.js-style polyfills are common in
// AE scripts. Inside the bundle's closure (scripts/bundle-jsx.mjs) `JSON` is
// this local, captured once at load: the engine's native one when it still
// round-trips correctly, otherwise the polyfill below. Loaded on its own at a
// global scope (the unit tests), the `var` keeps the existing global JSON.
var JSON = __aemcpJSON(typeof JSON !== "undefined" ? JSON :
  ((typeof $ !== "undefined" && $ && $.global) ? $.global.JSON : undefined));

function __aemcpJSON(engineJSON) {
  try {
    var st = engineJSON.stringify;
    var pa = engineJSON.parse;
    if (typeof st === "function" && typeof pa === "function" &&
        st.call(engineJSON, { a: [1, "x"] }) === '{"a":[1,"x"]}' &&
        pa.call(engineJSON, '{"a":[1]}').a[0] === 1) {
      return {
        stringify: function (v, r, sp) {
          return arguments.length > 1 ? st.call(engineJSON, v, r, sp) : st.call(engineJSON, v);
        },
        parse: function (t, r) {
          return arguments.length > 1 ? pa.call(engineJSON, t, r) : pa.call(engineJSON, t);
        }
      };
    }
  } catch (e) {}
  return __aemcpJSONPolyfill();
}

// AE 2026 has JSON natively; this is for an engine where it is missing or broken.
function __aemcpJSONPolyfill() {
  var out = {};
  out.stringify = (function () {
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
  out.parse = function (text) { return eval("(" + text + ")"); };
  return out;
}

// ---------- Registry ----------
// Inside the bundle these are locals of its closure, fresh on every load, and
// no other script can reach them (issue #185). `X || {}` only matters when a
// file is loaded on its own at a global scope, as the unit tests do.
var OPS = OPS || {};
var JOBS = JOBS || {};
var __JOB_SEQ = __JOB_SEQ || 0;

function __newJobId() {
  __JOB_SEQ += 1;
  return "j_" + (new Date().getTime()) + "_" + __JOB_SEQ;
}

// A finished job's entry held every op's args and every op's result for the
// life of the After Effects session (issue #163) — a long batch is thousands of
// both, and JOBS was never emptied. On finishing, the entry is cut down to a
// tombstone of counters, and only the newest __JOBS_FINISHED_MAX tombstones
// are kept. The tombstone is not decoration: a cancel can arrive after the last
// chunk ran but before the server has heard the job ended, and "no such job"
// there would read as After Effects having restarted and the result being lost.
var __JOBS_FINISHED = __JOBS_FINISHED || [];
var __JOBS_FINISHED_MAX = 64;

function __finishJob(jobId, result) {
  var j = JOBS[jobId];
  if (j && !j.finished) {
    JOBS[jobId] = {
      finished: true,
      cancelled: !!j.cancelled,
      cursor: j.cursor,
      total: j.total,
      errorCount: j.errors ? j.errors.length : 0,
      undoSteps: j.undoSteps,
    };
    __JOBS_FINISHED.push(jobId);
    while (__JOBS_FINISHED.length > __JOBS_FINISHED_MAX) {
      delete JOBS[__JOBS_FINISHED.shift()];
    }
  }
  return result;
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

// ---------- Dialog guard (issue #225) ----------
// After Effects answers some API misuse with a blocking modal instead of a
// throw — "Undo group mismatch, will attempt to fix.", the auto-orient warning
// on a 2D layer, the unsynced-fonts prompt export_mogrt measured. ExtendScript
// is single-threaded, so while one is up the panel's evalScript never returns,
// the bridge stalls, and the user is left facing a dialog nobody asked for.
//
// So dispatch() runs every op between app.beginSuppressDialogs() and
// app.endSuppressDialogs(false), inside the same evalScript and outside the
// undo group — the group's own close is where a mismatch would be raised — and
// points app.onError at a collector for the duration, restoring whatever was
// there before. Measured on AE 26.5 (#226 live pass): no modal appeared in any
// test; `typeof app.beginSuppressDialogs` is "function"; app.onError is called
// as (message, severity), and the auto-orient-on-2D warning and the undo-group
// mismatch both arrive with severity WARNING; suppression and onError are
// restored after a throwing op; a 520-op chunked batch carried its warnings to
// the job result; the whole guard costs about 9 µs per call. What it collects
// comes back as `aeWarnings` on the result, or on the error text. An op that
// manages its own suppression (export_mogrt, whose suppressDialogs:false must
// still be honoured) opts out with __meta.ownDialogs.
//
// Severity PROBLEM is dropped. Also measured: an error a script throws and
// catches itself fires onError too, with severity PROBLEM — a handled error,
// not something After Effects would have shown. Kept, it would put a warning on
// every result whose code used a try/catch. WARNING and anything else is kept.
//
// __DIALOG_GUARD is the switch: false restores the old behaviour exactly.
var __DIALOG_GUARD = true;
var __DIALOGS_SUPPRESSED = false;

function __isHandledProblem(severity) {
  try { return String(severity).toUpperCase().indexOf("PROBLEM") >= 0; } catch (e) { return false; }
}

function __dialogGuardStart() {
  if (!__DIALOG_GUARD || __DIALOGS_SUPPRESSED) return null;
  try {
    if (typeof app === "undefined" || !app || typeof app.beginSuppressDialogs !== "function" ||
        typeof app.endSuppressDialogs !== "function") return null;
  } catch (e0) { return null; }
  // `installed`: the assignment did not throw, so it is put back afterwards
  // even if reading it back does not compare equal — a host that wraps the
  // function must not be left holding ours.
  var g = { messages: [], installed: false, previousOnError: null };
  try { app.beginSuppressDialogs(); } catch (e1) { return null; }
  __DIALOGS_SUPPRESSED = true;
  try {
    g.previousOnError = app.onError;
    app.onError = function (message, severity) {
      try {
        if (__isHandledProblem(severity)) return;
        var m = String(message);
        if (typeof severity !== "undefined" && severity !== null) m += " (severity " + String(severity) + ")";
        g.messages.push(m);
      } catch (eh) {}
    };
    g.installed = true;
  } catch (e2) {}
  return g;
}

function __dialogGuardEnd(g) {
  if (!g) return;
  // The engine is shared with every other script in After Effects: whatever
  // handler was there before goes back, null included.
  if (g.installed) { try { app.onError = g.previousOnError; } catch (e1) {} }
  // false: never replay the suppressed messages as a dialog. They are on the
  // result instead.
  try { app.endSuppressDialogs(false); } catch (e2) {}
  __DIALOGS_SUPPRESSED = false;
}

// Puts what app.onError was handed where the agent will read it.
//
// The labelling stays neutral — "After Effects reported", never "a dialog was
// suppressed". Caught errors arrive as PROBLEM and are dropped above, and on
// 26.5 get_layer_full and the other reads produced no false warnings. But
// nobody has catalogued every WARNING After Effects can raise.
//
// The panel forwards `result` on success and `error` on failure, nothing else.
// An object result gets a top-level `aeWarnings`. Anything else (array, scalar,
// null) travels in a marked envelope that the server unwraps, so the value the
// agent reads keeps its shape and the warnings arrive as a separate block.
var __AE_WARNED_MARK = "__aemcpWarned";

function __dialogGuardReport(out, g) {
  if (!g || g.messages.length === 0) return out;
  var msgs = g.messages;
  if (!out.ok) {
    out.error = String(out.error) + " || After Effects also reported, through app.onError while dialogs were " +
      "suppressed: " + msgs.join(" | ");
    return out;
  }
  var r = out.result;
  if (r && typeof r === "object" && !(r instanceof Array)) {
    r.aeWarnings = msgs;
  } else {
    var env = { value: r, aeWarnings: msgs };
    env[__AE_WARNED_MARK] = true;
    out.result = env;
  }
  return out;
}

// True while dispatch() holds dialogs suppressed. An op that suppresses for
// itself checks this first, so suppression is never begun twice — whether
// After Effects counts nested begin/end pairs is not measured.
function __dialogsSuppressed() { return __DIALOGS_SUPPRESSED; }

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
  var handler = OPS[op];
  var meta = handler.__meta || {};
  var dialogs = meta.ownDialogs ? null : __dialogGuardStart();
  var out;
  try {
    out = __dispatchRun(op, handler, meta, args);
  } finally {
    __dialogGuardEnd(dialogs);
  }
  return __dialogGuardReport(out, dialogs);
}

function __dispatchRun(op, handler, meta, args) {
  try {
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
