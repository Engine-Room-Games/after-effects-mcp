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

// A script whose last statement is a bare expression completes and yields
// undefined — with every side effect already applied. Handing back a bare
// `null` for that made "ran fine, returned nothing" identical on the wire to
// "did not run", and the natural response to a suspected failure is to run the
// script again. Nothing here rolls back, so a second run of a non-idempotent
// script duplicates layers, re-applies moveTo, writes keyframes on top of
// keyframes (issue #43) — and the guidance to prefer few large scripts means
// the ones most likely to be re-run are the most destructive to re-run.
//
// So a null result is never returned bare: it comes back as an envelope that
// says the script finished. An explicit `return null` is folded into the same
// envelope, because the ambiguity is in the value, not in how it was produced.
function __rjResult(result, undoGroupName) {
  var serialized = (typeof result === "undefined") ? null : __rjSerialize(result, 0, [], { n: 0 });
  if (serialized !== null) return serialized;
  return {
    ok: true,
    returned: null,
    undoGroup: undoGroupName,
    note: "Completed with no `return` value — this is not a failure. Use `return X` to send a value back. " +
      "Anything the script changed is already applied and nothing rolls back, so read the state back rather than re-running it."
  };
}

// ---------- Mapping a failure back onto the caller's own script ----------
// A failed run_jsx reported After Effects' line number with nothing to measure
// it against, and that number does not count from where the caller thinks it
// does: the same "line 22" pointed at two different statements in consecutive
// calls (issue #46). Nothing rolls back, so an agent that cannot locate the
// throw has to read the whole project back to find out where the script stopped.
//
// Two halves, and the second is the one that actually helps. The wrapper is
// built so the caller's first line IS line 1 of the evaluated source — the
// prefix carries no newline, so the offset is zero — and __RJ_PREAMBLE_LINES
// *counts* the prefix rather than asserting it, so the offset can never drift
// from the string it describes. Then the mapped line is reported with its
// TEXT, which an agent can act on without trusting any numbering at all.
//
// The mapping refuses to guess: a line that falls outside the submitted source
// is reported as unmappable, never clamped. A confident wrong line number is
// worse than none — it sends the reader to a statement that did not fail.
var __RJ_WRAP_PREFIX = "(function(){ ";
// The closer sits on its own line. Appended to the caller's last line, a script
// ending in a `//` comment commented out its own `})()` and failed to parse for
// a reason nothing in the error mentioned.
var __RJ_WRAP_SUFFIX = "\n})()";

// No regex literal: tests/unit/jsx-ternary.mjs strips string and comment
// literals from these sources and there are none anywhere else in packages/jsx.
function __rjLines(s) {
  return String(s).split("\r\n").join("\n").split("\r").join("\n").split("\n");
}

var __RJ_PREAMBLE_LINES = __rjLines(__RJ_WRAP_PREFIX).length - 1;

function __rjTrim(s) {
  var t = String(s);
  var a = 0;
  var b = t.length;
  while (a < b && (t.charAt(a) === " " || t.charAt(a) === "\t")) a++;
  while (b > a && (t.charAt(b - 1) === " " || t.charAt(b - 1) === "\t")) b--;
  return t.substring(a, b);
}

function __rjClip(s, max) {
  var t = String(s);
  if (t.length <= max) return t;
  return t.substring(0, max) + " ...";
}

// What After Effects reported, mapped onto the source the caller submitted.
// Nothing here is fabricated: when the number does not land inside the script,
// sourceLine stays null and the server says the number could not be mapped.
function __rjSourceInfo(e, code, scriptPath) {
  var lines = __rjLines(code);
  var info = {
    lineCount: lines.length,
    rawLine: null,
    sourceLine: null,
    sourceText: null
  };
  if (scriptPath) info.sourceName = String(scriptPath);

  var raw = null;
  try {
    if (e && typeof e.line === "number" && isFinite(e.line)) raw = e.line;
  } catch (e1) {}
  info.rawLine = raw;

  var mapped = null;
  // ExtendScript also records the source text an error was raised in and the
  // character offset into it. When that source is our own wrapper it answers
  // the question directly, with no assumption about what `line` counts from.
  try {
    var src = null;
    if (e && typeof e.source === "string") src = e.source;
    var start = null;
    if (e && typeof e.start === "number") start = e.start;
    if (src !== null && start !== null && start >= 0 &&
        src.substring(0, __RJ_WRAP_PREFIX.length) === __RJ_WRAP_PREFIX) {
      mapped = __rjLines(src.substring(0, start)).length - __RJ_PREAMBLE_LINES;
    }
  } catch (e2) {}
  if (mapped === null && raw !== null) mapped = raw - __RJ_PREAMBLE_LINES;

  if (mapped !== null && mapped >= 1 && mapped <= lines.length) {
    info.sourceLine = mapped;
    info.sourceText = __rjClip(__rjTrim(lines[mapped - 1]), 200);
  }
  return info;
}

// Rethrow with the mapping attached. dispatch()'s catch copies whatever sits on
// `aeDetail` onto the error result; the panel forwards the fields it names and
// the server prints the line's text. A plain object rather than an Error
// because ExtendScript will not reliably let us write `line` on one, and
// __mkError only ever reads message/stack/line.
function __rjThrowWithSource(e, code, scriptPath) {
  var info = __rjSourceInfo(e, code, scriptPath);
  var msg = "";
  try { if (e && e.message) msg = String(e.message); } catch (e1) {}
  if (!msg) {
    try { msg = String(e); } catch (e2) { msg = "ExtendScript error"; }
  }
  var stack = "";
  try { if (e && e.stack) stack = String(e.stack); } catch (e3) {}
  throw { message: msg, stack: stack, line: info.rawLine, aeDetail: info };
}

// ---------- Helper libraries ----------
// Libraries go through $.evalFile, never eval: eval runs in the *calling*
// function's scope, so a library's `function helper(){}` would be visible only
// inside this loader and gone by the time the script runs. $.evalFile evaluates
// at global scope, which is the whole point — load once, call for the rest of
// the After Effects session (issue #53).
//
// The cache is keyed path -> content hash, and the hash is computed by the
// server when it read the file. Re-passing an unchanged library is free;
// editing it changes the hash and it is re-evaluated. Nothing expires:
// ExtendScript globals live as long as AE does, and so does this table. An
// entry is written only after a successful eval, so a library that failed
// halfway is never recorded as loaded.
var __RJ_LIBS = __RJ_LIBS || {};

function __rjLoadLibraries(libs) {
  if (!libs || !libs.length) return;
  for (var i = 0; i < libs.length; i++) {
    var lib = libs[i];
    var p = null;
    var h = null;
    // The server sends {path, hash}. A bare string is what a caller POSTing
    // /op by hand would send; honour it, but with no hash there is nothing to
    // key a cache on, so it is re-evaluated every time.
    if (typeof lib === "string") {
      p = lib;
    } else if (lib) {
      p = lib.path;
      h = lib.hash;
    }
    if (!p) throw new Error("run_jsx: a libraries entry has no path.");
    if (h && __RJ_LIBS[p] === h) continue;
    var f = new File(p);
    if (!f.exists) throw new Error("run_jsx library not found by After Effects: " + p);
    try {
      $.evalFile(f);
    } catch (e) {
      // Loud, and the cache is left alone. A half-evaluated library reported as
      // loaded would hand the script a scope missing exactly the function it
      // was about to call.
      var m = "";
      try { m = (e && e.message) ? String(e.message) : String(e); } catch (e2) { m = "unknown error"; }
      var at = "";
      try { if (e && typeof e.line === "number") at = " (line " + e.line + ")"; } catch (e3) {}
      throw new Error("run_jsx library failed to evaluate: " + p + at + " — " + m);
    }
    if (h) {
      __RJ_LIBS[p] = h;
    } else if (__RJ_LIBS[p]) {
      delete __RJ_LIBS[p];
    }
  }
}

// undoGroup:false is a per-call opt-out, read by dispatch() through the
// predicate form of __meta.noUndo. It exists because AE refuses copyToComp for
// a layer with a parent or a linked expression while an undo group is open,
// which is exactly the layer worth copying (issue #30).
OPS.run_jsx = noUndoWhen(function (args) { return args.undoGroup === false; }, function (args) {
  var code = args.code || "";
  // scriptPath is resolved to code by the *server* before the payload is built.
  // Arriving here with a path and no code means it came in some other way — a
  // run_batch step, whose args are never validated, or a hand-rolled POST /op.
  // Running an empty script would return the "completed with no return value"
  // envelope, which is a success result for a file nobody read.
  if (!code && args.scriptPath) {
    throw new Error(
      "run_jsx received scriptPath \"" + args.scriptPath + "\" with no code. The server reads that " +
      "file and substitutes it, so this path did not go through the run_jsx tool — run_batch steps " +
      "and direct /op posts must pass `code` themselves."
    );
  }
  if (!code) throw new Error("run_jsx needs `code` — an empty script would report success for nothing.");
  // Libraries first, and outside the try below: a library that fails to parse
  // is not a line in the caller's script and must not be reported as one.
  __rjLoadLibraries(args.libraries);
  // We wrap in a function so `return` works.
  var wrapper = __RJ_WRAP_PREFIX + code + __RJ_WRAP_SUFFIX;
  // Which undo step to look for in AE if the script has to be backed out. The
  // name mirrors dispatch()'s default ("AE MCP: " + op); false means the caller
  // asked for no group and the changes landed as whatever steps AE recorded.
  var undoGroupName = (args.undoGroup === false) ? false : "AE MCP: run_jsx";
  // diff:true fingerprints the comp before and after, inside this one call —
  // see snapshot.jsx. Null unless asked for, so the ordinary path is untouched.
  var __d = __diffStart(args, null);
  var __value;
  try {
    __value = eval(wrapper);
  } catch (e) {
    // Annotate before mapping the line: __rjThrowWithSource reads e.message,
    // so the diff note has to be on it by then, and the source mapping is what
    // makes the reported line the caller's own (#46).
    __diffAnnotateError(e, __d);
    __rjThrowWithSource(e, code, args.scriptPath);
  }
  var __out = __rjResult(__value, undoGroupName);
  if (__d) return __rjWithDiff(__out, __diffFinish(__d), undoGroupName);
  return __out;
});
