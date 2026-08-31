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
// Two halves, and the second is the one that actually helps. The caller's line
// 1 sits a *counted* distance down the evaluated source: with no libraries the
// prefix carries no newline and the distance is zero, and with libraries it is
// however many lines of library text were inlined ahead of the script.
// __rjBuildSource measures the preamble it actually built rather than asserting
// a constant, so the number can never drift from the string it describes —
// a hand-written constant beside a string is exactly how the two came apart the
// first time. Then the mapped line is reported with its TEXT, which an agent
// can act on without trusting any numbering at all.
//
// The mapping refuses to guess: a line that falls outside the submitted source
// is reported as unmappable, never clamped — unless it lands in a library that
// was inlined ahead of it, which is a real file with real lines and is named.
// A confident wrong line number is worse than none — it sends the reader to a
// statement that did not fail.
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

// The preamble of a call with no libraries: the bare wrapper opener, which
// carries no newline, so zero. __rjBuildSource recomputes this per call once
// libraries are in it; this is the default __rjSourceInfo falls back on when a
// caller hands it no layout.
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
//
// `layout` is what __rjBuildSource returned for this call — how many lines of
// preamble sit ahead of the caller's line 1, and where each inlined library
// landed in the evaluated source. Omitted, it means the bare wrapper: no
// libraries and a zero-line preamble, which is every call without `libraries`.
function __rjSourceInfo(e, code, scriptPath, layout) {
  var lay = layout ? layout : { preambleLines: __RJ_PREAMBLE_LINES, segments: [] };
  var preamble = lay.preambleLines;
  var segs = lay.segments ? lay.segments : [];
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

  // Which line of the *evaluated source* — the wrapper, the inlined libraries
  // and the caller's script together — the failure sits on. After Effects' own
  // `line` already counts from there, which is what makes it usable at all.
  var wrapperLine = null;

  // ExtendScript's Error also carries `source` (the text the error was raised
  // in) with `start`/`end` character offsets into it, and the documentation
  // presents those as the better answer, because they need no assumption about
  // what `line` counts from. On After Effects 2026 they are not offsets at all.
  //
  // Probed inside AE, catching from a four-line script that throws on line 4:
  //
  //   eval("(function(){ var a=1;\nvar b=2;\nvar c=3;\nnope.boom();\n})()")
  //   caught -> { "line": 4, "start": 0, "end": 0, "srcLen": 57 }
  //
  // `line` is already correct. `start` and `end` came back 0 on every error
  // measured, however far into the source it was raised. Read as an offset, a
  // zero start puts *every* failure on line 1 and prints line 1's text — which
  // is exactly what issue #46 still did after it was reported fixed, with the
  // true number demoted to the parenthetical afterwards.
  //
  // So the branch survives only for offsets that could actually be real: 0/0 is
  // After Effects declining to say, not After Effects pointing at the first
  // character. Do not restore this from the documentation.
  try {
    var src = null;
    if (e && typeof e.source === "string") src = e.source;
    var start = null;
    if (e && typeof e.start === "number" && isFinite(e.start)) start = e.start;
    var end = null;
    if (e && typeof e.end === "number" && isFinite(e.end)) end = e.end;
    var offsetsUsable = false;
    if (start !== null && start > 0) offsetsUsable = true;
    if (start === 0 && end !== null && end > 0) offsetsUsable = true;
    if (offsetsUsable && src !== null &&
        src.substring(0, __RJ_WRAP_PREFIX.length) === __RJ_WRAP_PREFIX) {
      wrapperLine = __rjLines(src.substring(0, start)).length;
    }
  } catch (e2) {}
  if (wrapperLine === null) wrapperLine = raw;
  if (wrapperLine === null) return info;

  var mapped = wrapperLine - preamble;
  if (mapped >= 1 && mapped <= lines.length) {
    info.sourceLine = mapped;
    info.sourceText = __rjClip(__rjTrim(lines[mapped - 1]), 200);
    return info;
  }

  // Not the caller's script. A library inlined ahead of it is a real file with
  // real lines, so name it and point into it rather than reporting the number
  // as unmappable: that file is where the reader has to look, and naming the
  // script instead would send them to a line that did not fail.
  for (var s = 0; s < segs.length; s++) {
    var seg = segs[s];
    var count = seg.lines.length - 1;
    var within = wrapperLine - seg.firstLine + 1;
    if (within >= 1 && within <= count) {
      info.sourceName = seg.path;
      info.lineCount = count;
      info.sourceLine = within;
      info.sourceText = __rjClip(__rjTrim(seg.lines[within - 1]), 200);
      return info;
    }
  }
  return info;
}

// Rethrow with the mapping attached. dispatch()'s catch copies whatever sits on
// `aeDetail` onto the error result; the panel forwards the fields it names and
// the server prints the line's text. A plain object rather than an Error
// because ExtendScript will not reliably let us write `line` on one, and
// __mkError only ever reads message/stack/line.
function __rjThrowWithSource(e, code, scriptPath, layout) {
  var info = __rjSourceInfo(e, code, scriptPath, layout);
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
// A library's source is inlined into the SAME eval as the caller's script,
// ahead of it. That is not the obvious design, and it is the only one that
// works.
//
// The first version used $.evalFile, on the documented premise that it
// evaluates at global scope — load once, call for the rest of the After Effects
// session (issue #53). Probed inside AE 2026, calling $.evalFile from the body
// of an eval'd script, on a library declaring `function rig2()` and
// `var RIGVAR = 3`:
//
//   {"exists":true, "typeofRig2_local":"function", "typeofRIGVAR_local":"number",
//    "globalRig2":"undefined", "viaGlobal":null}
//   // and on the next run_jsx call, in the same AE session:
//   {"typeofRig2":"undefined", "viaGlobal":"undefined"}
//
// $.evalFile evaluates into the *calling function's* scope, exactly as eval
// does. Everything a library defined therefore lived inside the loader and was
// gone before the wrapper ran, so `libraries` answered "Function rig is
// undefined" every time, for every library, in every session. The per-session
// cache keyed on a content hash has gone with it: nothing was ever left loaded
// to reuse, so the only work it ever skipped was work whose result had already
// been discarded.
//
// One eval means one scope: a library's `function helper(){}` is a declaration
// in the same function body as the script, so the script can call it. Two
// consequences, both handled here rather than left to surprise someone:
//
//  * A library is re-evaluated on every call. That is the price of the scoping
//    After Effects actually has. Keep libraries to declarations, not to work.
//  * The library text shifts the caller's line 1 down, which is precisely the
//    failure issue #46 was about. __rjBuildSource *counts* the preamble it
//    built rather than asserting a constant, and __rjSourceInfo subtracts that
//    count — so a caller's line 1 is line 1 of their own script whether they
//    passed libraries or not.

// No regex literal, for the same reason __rjLines has none.
function __rjIsBlank(s) {
  var t = String(s);
  for (var i = 0; i < t.length; i++) {
    var c = t.charAt(i);
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return false;
  }
  return true;
}

// Every library ends in a newline before the next one — or the caller's script
// — follows it. Appended directly, a library whose last line is a `//` comment
// would comment out whatever came after it: the same trap __RJ_WRAP_SUFFIX
// exists for at the other end of the wrapper.
function __rjEndWithNewline(s) {
  var t = String(s);
  if (t.length === 0) return "\n";
  var last = t.charAt(t.length - 1);
  if (last === "\n" || last === "\r") return t;
  return t + "\n";
}

// The server reads library files and sends {path, text}, exactly as it does for
// scriptPath — one place reads files, and its errors can name the path it was
// given. Arriving with a path and no text means the call did not come through
// the run_jsx tool: a run_batch step, whose args are never validated, or a
// hand-rolled POST /op.
function __rjLibrarySource(lib) {
  var p = null;
  var text = null;
  if (typeof lib === "string") {
    p = lib;
  } else if (lib) {
    p = lib.path;
    if (typeof lib.text === "string") text = lib.text;
  }
  if (!p) throw new Error("run_jsx: a libraries entry has no path.");
  if (text === null) {
    throw new Error(
      "run_jsx library \"" + p + "\" arrived with no source text. The server reads library files " +
      "and substitutes their contents, so this call did not go through the run_jsx tool — " +
      "run_batch steps and direct /op posts must pass {path, text} themselves."
    );
  }
  if (__rjIsBlank(text)) throw new Error("run_jsx library is empty: " + p);
  return { path: String(p), text: __rjEndWithNewline(text) };
}

// Parse each library on its own before any of it reaches the shared eval.
// Inlining means a library that does not parse takes the whole wrapper with it,
// and the line After Effects reports for a syntax error is wherever its parser
// gave up — frequently inside the caller's script, which would blame the wrong
// file for someone else's missing brace. An uncalled function expression forces
// a full parse of exactly this library and nothing else, so the failure names
// it and counts from its own line 1.
function __rjCheckLibraryParses(lib) {
  try {
    eval("(function(){ " + lib.text + "})");
  } catch (e) {
    var m = "";
    try { m = (e && e.message) ? String(e.message) : String(e); } catch (e1) { m = "unknown error"; }
    var ln = null;
    try { if (e && typeof e.line === "number" && isFinite(e.line)) ln = e.line; } catch (e2) {}
    var libLines = __rjLines(lib.text);
    var count = libLines.length - 1;
    var detail = {
      lineCount: count,
      rawLine: ln,
      sourceLine: null,
      sourceText: null,
      sourceName: lib.path
    };
    if (ln !== null && ln >= 1 && ln <= count) {
      detail.sourceLine = ln;
      detail.sourceText = __rjClip(__rjTrim(libLines[ln - 1]), 200);
    }
    throw {
      message: "run_jsx library failed to parse: " + lib.path + " — " + m,
      stack: "",
      line: ln,
      aeDetail: detail
    };
  }
}

// The evaluated source for one call, plus the map that turns any line of it
// back into a line of a file the caller knows about.
//
// `preambleLines` is COUNTED from the text that precedes the script rather than
// assumed. That is the invariant issue #46 turned on, and it now has to hold
// for a preamble whose length changes from call to call: it can never drift
// from the string it describes, however many libraries there are.
function __rjBuildSource(code, libraries) {
  var prefix = __RJ_WRAP_PREFIX;
  var segments = [];
  if (libraries && libraries.length) {
    for (var i = 0; i < libraries.length; i++) {
      var lib = __rjLibrarySource(libraries[i]);
      __rjCheckLibraryParses(lib);
      segments.push({
        path: lib.path,
        // The wrapper opener carries no newline, so the first library's line 1
        // shares line 1 of the evaluated source with it.
        firstLine: __rjLines(prefix).length,
        lines: __rjLines(lib.text)
      });
      prefix = prefix + lib.text;
    }
  }
  return {
    wrapper: prefix + code + __RJ_WRAP_SUFFIX,
    preambleLines: __rjLines(prefix).length - 1,
    segments: segments
  };
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
  // We wrap in a function so `return` works, with any libraries inlined ahead
  // of the script so they share its scope. Assembled and parse-checked before
  // anything runs, and outside the try below: a library that fails to parse is
  // not a line in the caller's script and must not be reported as one.
  var built = __rjBuildSource(code, args.libraries);
  // Which undo step to look for in AE if the script has to be backed out. The
  // name mirrors dispatch()'s default ("AE MCP: " + op); false means the caller
  // asked for no group and the changes landed as whatever steps AE recorded.
  var undoGroupName = (args.undoGroup === false) ? false : "AE MCP: run_jsx";
  // diff:true fingerprints the comp before and after, inside this one call —
  // see snapshot.jsx. Null unless asked for, so the ordinary path is untouched.
  var __d = __diffStart(args, null);
  var __value;
  try {
    __value = eval(built.wrapper);
  } catch (e) {
    // Annotate before mapping the line: __rjThrowWithSource reads e.message,
    // so the diff note has to be on it by then, and the source mapping is what
    // makes the reported line the caller's own (#46).
    __diffAnnotateError(e, __d);
    __rjThrowWithSource(e, code, args.scriptPath, built);
  }
  var __out = __rjResult(__value, undoGroupName);
  if (__d) return __rjWithDiff(__out, __diffFinish(__d), undoGroupName);
  return __out;
});
