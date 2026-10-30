// A run_jsx script's own app.beginUndoGroup / app.endUndoGroup (issue #221),
// and the dialog guard dispatch() wraps every op in (issue #225).
//
// Measured on AE 26.5: a begin with no end left the next op without an undo
// step of its own, Undo then emptied the history for good, and a stray end
// later raised "Undo group mismatch" and crashed AE on the next Undo. The rule
// locked in here: whatever a script — or a run_batch step running one — does
// with those two calls, every real begin in the evalScript has its end before
// the call returns, a stray end never reaches After Effects, and the result
// says what was changed.
//
// The fake `app` below throws on an end with nothing open, so an unbalanced
// pass reaches the assertion as a failure rather than as a log to eyeball.
//
//   node tests/unit/run-jsx-undo-guard.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

// The methods are left writable on purpose: AE 26.5 silently ignores an
// assignment to them, so a guard that assigned would work here and not there.
// Writable, any assignment shows up as a changed method (balanced() checks).
function load({ dialogs = false } = {}) {
  const log = [];
  const state = { depth: 0, maxDepth: 0, strayEnds: 0, onError: null, suppressed: 0 };
  const app = {
    beginUndoGroup: (n) => {
      log.push(`begin:${n}`);
      state.depth++;
      state.maxDepth = Math.max(state.maxDepth, state.depth);
    },
    endUndoGroup: () => {
      log.push("end");
      if (state.depth === 0) { state.strayEnds++; return; }
      state.depth--;
    },
  };
  state.origBegin = app.beginUndoGroup;
  state.origEnd = app.endUndoGroup;
  if (dialogs) {
    app.beginSuppressDialogs = () => { log.push("suppress"); state.suppressed++; };
    app.endSuppressDialogs = (a) => { log.push(`unsuppress:${a}`); state.suppressed--; };
    Object.defineProperty(app, "onError", {
      get: () => state.onError,
      set: (v) => { state.onError = v; },
      enumerable: true,
    });
    // What After Effects would do with a warning it has been told not to show.
    // Measured on 26.5: onError(message, severity), WARNING for the mismatch and
    // auto-orient warnings, PROBLEM for an error thrown and caught.
    app.__warn = (msg, sev = "WARNING") => { if (state.onError) state.onError(msg, sev); else log.push(`MODAL:${msg}`); };
  }
  const ctx = { app, log };
  vm.createContext(ctx);
  for (const f of ["core.jsx", "snapshot.jsx", "batch.jsx", "raw.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const call = (op, args) => vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }));
  state.ctx = ctx;
  return { ctx, log, state, call };
}

const opens = (log) => log.filter((l) => l.startsWith("begin:")).length;
const closes = (log) => log.filter((l) => l === "end").length;
const plain = (v) => JSON.parse(JSON.stringify(v));

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exit(1); }
}

function balanced(log, state, name) {
  assert.equal(state.depth, 0, `${name}: an undo group was left open after the call`);
  assert.equal(vm.runInContext("app.beginUndoGroup", state.ctx), state.origBegin, `${name}: app.beginUndoGroup not restored`);
  assert.equal(vm.runInContext("app.endUndoGroup", state.ctx), state.origEnd, `${name}: app.endUndoGroup not restored`);
  assert.equal(state.strayEnds, 0, `${name}: an endUndoGroup reached AE with nothing open`);
  assert.equal(opens(log), closes(log), `${name}: begins and ends differ`);
}

// ---------- The three measured repros ----------

check("a nested pair stays one undo step and is reported", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    code: 'app.beginUndoGroup("inner"); var x = 1; app.endUndoGroup(); return x;',
  });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "nested pair");
  assert.deepEqual(log, ["begin:AE MCP: run_jsx", "end"], "the inner pair must not reach After Effects");
  assert.equal(r.result.returned, 1, "the value still comes back, inside an envelope");
  assert.equal(r.result.undoGuard.balanced, true);
  assert.equal(r.result.undoGuard.beginUndoGroupCalls, 1);
  assert.equal(r.result.undoGuard.endUndoGroupCalls, 1);
});

check("a begin with no end is closed inside the same call, and said", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", { code: 'app.beginUndoGroup("unbalanced"); return 1;' });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "begin with no end");
  assert.equal(r.result.undoGuard.balanced, false);
  assert.equal(r.result.undoGuard.closedForScript, 1);
  assert.match(r.result.undoGuard.note, /UNBALANCED/);
  assert.match(r.result.undoGuard.note, /#221/);
  // ...and the next op still gets its own step.
  const before = log.length;
  const next = call("run_jsx", { code: "return 2;" });
  assert.equal(next.result, 2, "an untouched script keeps its bare result");
  assert.deepEqual(log.slice(before), ["begin:AE MCP: run_jsx", "end"]);
});

check("a stray end never reaches After Effects", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", { code: "app.endUndoGroup(); app.endUndoGroup(); return 3;" });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "stray end");
  assert.deepEqual(log, ["begin:AE MCP: run_jsx", "end"],
    "a stray end would close run_jsx's own group early — the mismatch modal");
  assert.equal(r.result.undoGuard.ignoredEnds, 2);
  assert.equal(r.result.undoGuard.balanced, false);
});

check("a script that throws with a group open is still closed, and the error says so", () => {
  const { log, state, call } = load();
  // ExtendScript errors carry `line`; Node's do not, so the script throws one.
  const r = call("run_jsx", { code: 'app.beginUndoGroup("x");\nthrow { message: "boom", line: 2 };' });
  assert.equal(r.ok, false);
  balanced(log, state, "throw with a group open");
  assert.match(r.error, /boom \|\| undo: .*UNBALANCED/);
  assert.equal(r.sourceLine, 2);
  assert.match(r.sourceText, /^throw/);
});

// ---------- undoGroup:false: one real group, through __beginUndoGroup ----------

check("with undoGroup:false the script's pair opens one counted group", () => {
  const { ctx, log, state, call } = load();
  const r = call("run_jsx", {
    undoGroup: false,
    code: 'app.beginUndoGroup("mine"); app.beginUndoGroup("nested"); app.endUndoGroup(); app.endUndoGroup(); return 1;',
  });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "undoGroup:false pair");
  assert.deepEqual(log, ["begin:mine", "end"], "one real group, never a nested one");
  assert.equal(vm.runInContext("__undoGroupsOpened()", ctx), 1, "opened through __beginUndoGroup");
  assert.match(r.result.undoGuard.note, /opened 1 real undo group\(s\) \(the first named "mine"\)/);
});

check("with undoGroup:false a begin with no end is closed before returning", () => {
  const { ctx, log, state, call } = load();
  const r = call("run_jsx", { undoGroup: false, code: 'app.beginUndoGroup("left open"); return 1;' });
  balanced(log, state, "undoGroup:false left open");
  assert.equal(r.result.undoGuard.closedForScript, 1);
  assert.equal(vm.runInContext("__UNDO_OPEN", ctx), false);
});

check("withoutUndoGroup inside a script-opened group still closes and reopens it", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    undoGroup: false,
    code: 'app.beginUndoGroup("g"); var v = withoutUndoGroup(function () { return 5; }); app.endUndoGroup(); return v;',
  });
  assert.equal(r.result.returned, 5);
  balanced(log, state, "withoutUndoGroup in a script group");
  assert.deepEqual(log, ["begin:g", "end", "begin:AE MCP: continue", "end"]);
});

// ---------- Inside run_batch ----------

check("an unbalanced run_jsx step inside an inline batch leaves the batch one step", () => {
  const { log, state, call } = load();
  const r = call("run_batch", {
    ops: [
      { op: "run_jsx", args: { code: 'app.beginUndoGroup("a"); return 1;' } },
      { op: "run_jsx", args: { code: "app.endUndoGroup(); app.endUndoGroup(); return 2;" } },
    ],
  });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "inline batch");
  assert.equal(opens(log), 1, "only the batch's own group");
  assert.equal(r.result.undoSteps, 1);
  assert.equal(r.result.results[0].undoGuard.closedForScript, 1);
  assert.equal(r.result.results[1].undoGuard.ignoredEnds, 2);
});

check("a run_jsx step in a chunked batch stays inside its chunk's group", () => {
  const { ctx, log, state, call } = load();
  vm.runInContext("__BATCH_INLINE_MAX = 1;", ctx);
  const start = call("run_batch", {
    chunkSize: 1,
    ops: [
      { op: "run_jsx", args: { code: 'app.beginUndoGroup("a"); return 1;' } },
      { op: "run_jsx", args: { code: "app.endUndoGroup(); return 2;" } },
      { op: "run_jsx", args: { code: "return 3;" } },
    ],
  });
  assert.equal(start.ok, true, start.error);
  assert.ok(start.result.jobId, "three ops with chunkSize 1 should run as a job");
  let res;
  for (let i = 0; i < 10; i++) {
    res = call("_continue_job", { jobId: start.result.jobId, chunkSize: 1 });
    assert.equal(res.ok, true, res.error);
    balanced(log, state, `chunk ${i}`);
    if (res.result.done) break;
  }
  assert.equal(res.result.done, true);
  assert.equal(res.result.undoSteps, 3, "one group per chunk, none extra");
});

// ---------- Literal direct calls are guarded; what it cannot see is said ----------
// Measured on AE 26.5: assigning to app.beginUndoGroup does not throw and the
// native method stays, so the guard rewrites the script's text and covers
// literal direct calls only. The fake `app` here refuses assignment the same
// way (see load()).

for (const [name, code] of [
  ["plain", "app.endUndoGroup();"],
  ["spaced and split", "app\n  . endUndoGroup();"],
  ["after ++, where a / is division", "var i = 4; i++ / 2; app.endUndoGroup(); var z = i / 2;"],
]) {
  check(`guarded: ${name}`, () => {
    const { log, state, call } = load();
    const r = call("run_jsx", { code: `${code} return 1;` });
    assert.equal(r.ok, true, r.error);
    balanced(log, state, name);
    assert.deepEqual(log, ["begin:AE MCP: run_jsx", "end"], `${name}: the stray end reached After Effects`);
    assert.equal(r.result.undoGuard.ignoredEnds, 1);
    assert.match(r.result.undoGuard.note, /UNBALANCED/);
  });
}

for (const [name, code, route] of [
  ["eval", 'var x = eval("1 + 1");', "eval"],
  ["Function", 'var f = Function("return 1"); f();', "Function"],
  ["$.evalFile", 'if (false) $.evalFile("/tmp/rig.jsx");', "$.evalFile"],
]) {
  check(`CAUTION for code the guard cannot see into: ${name}`, () => {
    const { call } = load();
    const r = call("run_jsx", { code: `${code} return 1;` });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.returned, 1);
    assert.deepEqual(plain(r.result.undoGuard.uncountedRoutes), [route]);
    assert.match(r.result.undoGuard.note, /^CAUTION: this script uses /);
    assert.match(r.result.undoGuard.note, /NOT seen by the guard/);
  });
}

check("a $.evalFile in a library is cautioned too", () => {
  const { call } = load();
  const r = call("run_jsx", {
    libraries: [{ path: "/lib/load.jsx", text: 'function load() { $.evalFile("/x.jsx"); }\n' }],
    code: "return 1;",
  });
  assert.deepEqual(plain(r.result.undoGuard.uncountedRoutes), ["$.evalFile"]);
});

check("eval and Function inside longer names are not routes", () => {
  const { call } = load();
  const r = call("run_jsx", { code: "function myFunction(a) { return a; } var retrieval = myFunction; return retrieval(3);" });
  assert.equal(r.result, 3, "no caution, no envelope");
});

check("an alias is not claimed as guarded", () => {
  const { call } = load();
  const r = call("run_jsx", { code: 'var a = app; var n = a.beginUndoGroup; return typeof n;' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.undoGuard.beginUndoGroupCalls, 0);
  assert.match(r.result.undoGuard.note, /Only calls written out as app\.beginUndoGroup/);
  assert.match(r.result.undoGuard.note, /\(0 found\)/);
});

check("names used as data are not refused", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    code: 'var o = {}; o.s = "endUndoGroup"; o.beginUndoGroup = function () { return 7; }; return o.beginUndoGroup();',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.returned, 7);
  assert.equal(r.result.undoGuard.beginUndoGroupCalls, 0);
  balanced(log, state, "data");
});

check("a run_jsx inside a run_jsx counts its own calls", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    code: 'var inner = OPS.run_jsx({ code: "app.endUndoGroup(); return 1;" }); app.beginUndoGroup("o"); app.endUndoGroup(); return inner;',
  });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "nested run_jsx");
  assert.equal(r.result.returned.undoGuard.ignoredEnds, 1);
  assert.equal(r.result.undoGuard.balanced, true);
});

check("withoutUndoGroup is the bundle's, not the script's: no report, no rewrite", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", { code: "withoutUndoGroup(function () {}); return 2;" });
  assert.equal(r.result, 2);
  balanced(log, state, "withoutUndoGroup");
});

check("names in strings and comments are left alone", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    code: [
      "// app.endUndoGroup() would be bad here",
      "/* app.beginUndoGroup(\"x\") */",
      "var s = \"never call app.endUndoGroup() twice\";",
      "return s.length > 0;",
    ].join("\n"),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.returned, true);
  assert.equal(r.result.undoGuard.beginUndoGroupCalls + r.result.undoGuard.endUndoGroupCalls, 0);
  balanced(log, state, "strings and comments");
});

check("a library's undo calls are guarded too", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    libraries: [{ path: "/lib/rig.jsx", text: 'function rig() { app.beginUndoGroup("lib"); return 9; }\n' }],
    code: "return rig();",
  });
  assert.equal(r.ok, true, r.error);
  balanced(log, state, "library");
  assert.equal(r.result.undoGuard.closedForScript, 1);
});

check("the report counts what it rewrote", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", { code: 'app.beginUndoGroup("x"); app.endUndoGroup(); app.endUndoGroup(); return 1;' });
  balanced(log, state, "count");
  assert.match(r.result.undoGuard.note, /\(3 found\)/);
  assert.equal("mode" in r.result.undoGuard, false, "there is only one mode now");
});

check("the guard never assigns to app's methods", () => {
  const { ctx, call } = load();
  vm.runInContext("app.__assigned = 0;", ctx);
  const plainApp = vm.runInContext("app", ctx);
  // A setter on a fresh property would not catch it; check the methods are
  // still the very functions load() installed after a guarded call.
  const before = [plainApp.beginUndoGroup, plainApp.endUndoGroup];
  call("run_jsx", { code: 'app.beginUndoGroup("x"); eval("1"); return 1;' });
  assert.equal(plainApp.beginUndoGroup, before[0]);
  assert.equal(plainApp.endUndoGroup, before[1]);
});

check("app . beginUndoGroup across lines keeps every later line number", () => {
  const { ctx, log, state, call } = load();
  const code = 'app\n  .beginUndoGroup("x"); // why\napp /* c */ . endUndoGroup();\nreturn 4;';
  const built = vm.runInContext("__rjBuildSource", ctx)(code, null);
  const lines = built.wrapper.split("\n");
  assert.equal(lines.length, code.split("\n").length + 1, "one extra line: the wrapper's closer");
  // The name lands where `app` was; the newline that followed it stays put.
  assert.match(lines[0], /__rjUndoBegin$/);
  assert.equal(lines[1], '("x"); // why');
  assert.match(lines[2], /^__rjUndoEnd\(\);$/);
  assert.equal(built.undoRewrites, 2);
  const r = call("run_jsx", { code });
  assert.equal(r.result.returned, 4);
  balanced(log, state, "multi-line member");
});

// ---------- Fast path: no rewrite unless the source names the methods ----------
// Measured on AE 26.5 the rewrite costs ~10 ms per KB of source, paid by every
// run_jsx before this check.

check("a script that never names the methods is never rewritten", () => {
  const { ctx, call } = load();
  vm.runInContext('__rjRewriteUndoText = function () { throw new Error("rewrite ran"); };', ctx);
  const r = call("run_jsx", {
    libraries: [{ path: "/lib/a.jsx", text: "function a() { return 1; }\n" }],
    code: "return a() + 1;",
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result, 2);
  const named = call("run_jsx", { code: "app.endUndoGroup(); return 1;" });
  assert.equal(named.ok, false, "a script that names them does go through the rewrite");
  assert.match(named.error, /rewrite ran/);
});

// ---------- Dialogs the script tries to show ----------

check("alert/confirm/prompt in a script come back instead of blocking", () => {
  const { call } = load();
  const r = call("run_jsx", { code: 'alert("hi"); var c = confirm("sure?"); var p = prompt("name"); return [c, p];' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(plain(r.result.returned), [false, null]);
  assert.deepEqual(plain(r.result.suppressedDialogs),
    ["alert: hi", "confirm (answered No): sure?", "prompt (answered Cancel): name"]);
});

// ---------- dispatch()'s dialog guard (issue #225) ----------

check("every op runs with dialogs suppressed, the undo group inside it", () => {
  const { ctx, log, call } = load({ dialogs: true });
  vm.runInContext("OPS.demo = function () { return { ok: true }; }", ctx);
  const r = call("demo", {});
  assert.equal(r.ok, true);
  assert.deepEqual(log, ["suppress", "begin:AE MCP: demo", "end", "unsuppress:false"]);
});

check("a reported message is a top-level aeWarnings on the result, and onError is restored", () => {
  const { ctx, state, call } = load({ dialogs: true });
  const theirs = () => {};
  state.onError = theirs;
  vm.runInContext('OPS.warns = function () { app.__warn("Auto-orient needs a 3D layer"); return { done: 1 }; }', ctx);
  const r = call("warns", {});
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.result.aeWarnings), ["Auto-orient needs a 3D layer (severity WARNING)"]);
  assert.equal(r.result.done, 1);
  assert.equal(state.onError, theirs, "another script's onError must be put back");
  assert.equal(state.suppressed, 0);
});

check("an array or scalar result travels in the marked envelope, its value untouched", () => {
  const { ctx, call } = load({ dialogs: true });
  vm.runInContext('OPS.warnsA = function () { app.__warn("w"); return [1, 2]; }', ctx);
  vm.runInContext('OPS.warnsN = function () { app.__warn("w"); return 4; }', ctx);
  const a = plain(call("warnsA", {}).result);
  assert.deepEqual(a, { value: [1, 2], aeWarnings: ["w (severity WARNING)"], __aemcpWarned: true });
  const n = plain(call("warnsN", {}).result);
  assert.equal(n.value, 4);
  assert.equal(n.__aemcpWarned, true);
});

check("severity PROBLEM (an error thrown and caught) is not a warning; WARNING and others are", () => {
  const { ctx, call } = load({ dialogs: true });
  vm.runInContext(
    'OPS.mixed = function () { app.__warn("caught", "PROBLEM"); app.__warn("mismatch", "WARNING");' +
    ' app.__warn("other", "NAKED"); return { done: 1 }; }', ctx);
  vm.runInContext('OPS.onlyCaught = function () { app.__warn("caught", "PROBLEM"); return { done: 1 }; }', ctx);
  assert.deepEqual(plain(call("mixed", {}).result.aeWarnings),
    ["mismatch (severity WARNING)", "other (severity NAKED)"]);
  assert.equal("aeWarnings" in call("onlyCaught", {}).result, false, "a handled error must not read as a warning");
});

check("no message, no change: an array result keeps its shape", () => {
  const { ctx, call } = load({ dialogs: true });
  vm.runInContext("OPS.arr = function () { return [1, 2]; }", ctx);
  assert.deepEqual(plain(call("arr", {}).result), [1, 2]);
});

check("a failing op still ends suppression and carries the message", () => {
  const { ctx, state, log, call } = load({ dialogs: true });
  vm.runInContext('OPS.fails = function () { app.__warn("mismatch"); throw new Error("boom"); }', ctx);
  const r = call("fails", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom \|\| After Effects also reported, through app\.onError while dialogs were suppressed: mismatch/);
  assert.equal(state.suppressed, 0);
  assert.equal(log[log.length - 1], "unsuppress:false");
});

check("an op that owns its dialogs is left alone; nothing is suppressed twice", () => {
  const { ctx, log, call } = load({ dialogs: true });
  vm.runInContext("OPS.mine = noUndo(function () { return 1; }); OPS.mine.__meta.ownDialogs = true;", ctx);
  call("mine", {});
  assert.deepEqual(log, []);
  // Nested: a run_jsx dispatched from inside an op does not begin again.
  vm.runInContext("OPS.outer = function () { return dispatch(JSON.stringify({ op: 'run_jsx', args: { code: 'return 1;' } })); }", ctx);
  log.length = 0;
  call("outer", {});
  assert.equal(log.filter((l) => l === "suppress").length, 1);
});

check("an AE without the suppression API runs ops exactly as before", () => {
  const { ctx, log, call } = load();
  vm.runInContext("OPS.demo = function () { return { ok: true }; }", ctx);
  call("demo", {});
  assert.deepEqual(log, ["begin:AE MCP: demo", "end"]);
});

// ---------- A chunked batch carries every chunk's warnings to its result ----------
// The panel's job driver builds the job result from named fields, so a field it
// does not name is dropped. Its real source is run against scripted chunks.
// Async checks, run in order; a failure is reported by name like any other.
async function checkAsync(name, fn) {
  try { await fn(); passed++; }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exit(1); }
}

function loadDriver() {
  const mainJs = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "main.js"), "utf8");
  const start = mainJs.indexOf("  function driveJobSteps(");
  const end = mainJs.indexOf("\n  }\n", start) + 4;
  assert.ok(start > 0 && end > start, "driveJobSteps moved; update this test");
  return async (chunks) => {
    const events = [];
    let i = 0;
    const sandbox = {
      Promise, setTimeout, String, Error,
      runOp: () => {
        const c = chunks[i++];
        return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
      },
      broadcast: (e) => events.push(e),
      log: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(mainJs.slice(start, end), sandbox);
    try {
      const out = await vm.runInContext("driveJobSteps", sandbox)("j1", null, 1, 3, {});
      return { out, events, error: null };
    } catch (error) {
      return { out: null, events, error };
    }
  };
}

await checkAsync("a chunked batch's result carries warnings from every chunk", async () => {
  const run = loadDriver();
  const ok = await run([
    { done: false, progress: 1, total: 3, undoSteps: 1, aeWarnings: ["first"] },
    { done: false, progress: 2, total: 3, undoSteps: 2 },
    { done: true, total: 3, results: [1, 2, 3], errors: [], undoSteps: 3, aeWarnings: ["last"] },
  ]);
  assert.equal(ok.error, null);
  assert.deepEqual(plain(ok.out.aeWarnings), ["first", "last"], "a warning from an early chunk was dropped");
  assert.deepEqual(plain(ok.events.find((e) => e.type === "complete").result.aeWarnings), ["first", "last"]);
  assert.equal(ok.out.undoSteps, 3);
});

await checkAsync("a batch that fails in AE keeps earlier chunks' warnings", async () => {
  const run = loadDriver();
  const failed = await run([
    { done: false, progress: 1, total: 2, undoSteps: 1, aeWarnings: ["early"] },
    { done: true, failed: true, error: "boom", atIndex: 1, undoSteps: 2 },
  ]);
  assert.deepEqual(plain(failed.out.aeWarnings), ["early"]);
  assert.match(failed.events.find((e) => e.type === "error").error, /boom.*app\.onError.*early/);
});

await checkAsync("a batch whose next chunk call fails keeps earlier chunks' warnings", async () => {
  const run = loadDriver();
  const r = await run([
    { done: false, progress: 1, total: 3, undoSteps: 1, aeWarnings: ["before the break"] },
    new Error("No job: j1"),
  ]);
  assert.ok(r.error, "the driver must reject");
  assert.match(String(r.error.message), /stopped mid-run.*app\.onError.*before the break/);
});

await checkAsync("no warnings, no field", async () => {
  const run = loadDriver();
  const quiet = await run([{ done: true, total: 1, results: [1], errors: [], undoSteps: 1 }]);
  assert.equal("aeWarnings" in quiet.out, false);
});

// ---------- The server never lets a warning read as a clean success ----------
const serverDist = path.join(root, "packages", "mcp-server", "dist", "server.js");
const server = await import(serverDist).catch(() => ({}));

await checkAsync("an unwrapped array result gets the WARNING block first, its value intact", async () => {
  const { liftAeWarnings, withAeWarnings, textResult } = server;
  assert.equal(typeof liftAeWarnings, "function", "server.ts exports no liftAeWarnings");
  const lifted = liftAeWarnings({ value: [1, 2], aeWarnings: ["w"], __aemcpWarned: true });
  assert.deepEqual(lifted.value, [1, 2], "the agent reads the array, not the envelope");
  const res = withAeWarnings(textResult(lifted.value), lifted.envelopeWarnings);
  assert.equal(res.content.length, 2);
  assert.match(res.content[0].text, /^WARNING: After Effects reported 1 message/);
  assert.match(res.content[0].text, /do not report it as a clean success/);
  assert.match(res.content[0].text, /Read the affected state back/);
  assert.equal(res.content[1].text, "[1,2]");
  assert.deepEqual(liftAeWarnings([1]).value, [1]);
});

await checkAsync("an object result with aeWarnings gets the block; one without does not", async () => {
  const { textResult } = server;
  assert.equal(typeof textResult, "function", "server.ts exports no textResult");
  assert.match(textResult({ ok: true, aeWarnings: ["x"] }).content[0].text, /^WARNING/);
  assert.equal(textResult({ ok: true }).content.length, 1);
});

await checkAsync("await_job/get_job's {status, result:{aeWarnings}} is flagged too", async () => {
  const { textResult } = server;
  assert.equal(typeof textResult, "function", "server.ts exports no textResult");
  const res = textResult({ jobId: "j1", status: "done", result: { undoSteps: 3, aeWarnings: ["chunk 2"] } });
  assert.equal(res.content.length, 2, "a finished chunked batch's warnings went unflagged");
  assert.match(res.content[0].text, /^WARNING.*"chunk 2"/);
  assert.equal(textResult({ status: "done", result: { undoSteps: 3 } }).content.length, 1);
});

console.log(`run-jsx-undo-guard: ${passed} checks passed`);
