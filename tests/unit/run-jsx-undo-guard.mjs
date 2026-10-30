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
  if (dialogs) {
    app.beginSuppressDialogs = () => { log.push("suppress"); state.suppressed++; };
    app.endSuppressDialogs = (a) => { log.push(`unsuppress:${a}`); state.suppressed--; };
    Object.defineProperty(app, "onError", {
      get: () => state.onError,
      set: (v) => { state.onError = v; },
      enumerable: true,
    });
    // What After Effects would do with a warning it has been told not to show.
    app.__warn = (msg) => { if (state.onError) state.onError(msg, 2); else log.push(`MODAL:${msg}`); };
  }
  const ctx = { app, log };
  vm.createContext(ctx);
  for (const f of ["core.jsx", "snapshot.jsx", "batch.jsx", "raw.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const call = (op, args) => vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }));
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
  assert.match(r.result.undoGuard.note, /opened one real group, "mine"/);
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

// ---------- Spellings the rewrite cannot follow are refused, before running ----------

for (const [name, code] of [
  ["computed member", 'app["endUndoGroup"](); return 1;'],
  ["alias", "var a = app; a.beginUndoGroup('x'); return 1;"],
  ["method reference off another object", "var f = $.global.app.endUndoGroup; return 1;"],
]) {
  check(`refused: ${name}`, () => {
    const { log, call } = load();
    const r = call("run_jsx", { code: `$.ran = 1; ${code}` });
    assert.equal(r.ok, false, `${name} must be refused`);
    assert.match(r.error, /refused this script before running any of it/);
    assert.match(r.error, /line 1/);
    assert.deepEqual(log, ["begin:AE MCP: run_jsx", "end"]);
  });
}

check("names in strings and comments are left alone", () => {
  const { log, state, call } = load();
  const r = call("run_jsx", {
    code: [
      "// app.endUndoGroup() would be bad here",
      "/* app.beginUndoGroup(\"x\") */",
      "var s = \"never call app.endUndoGroup() twice\";",
      "var re = /app.endUndoGroup/;",
      "return s.length > 0 && re.source.length > 0;",
    ].join("\n"),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result, true, "no envelope: the script never called either");
  balanced(log, state, "strings and comments");
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

check("a suppressed warning is returned on the result, and onError is restored", () => {
  const { ctx, state, call } = load({ dialogs: true });
  const theirs = () => {};
  state.onError = theirs;
  vm.runInContext('OPS.warns = function () { app.__warn("Auto-orient needs a 3D layer"); return { done: 1 }; }', ctx);
  const r = call("warns", {});
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.result.aeSuppressedDialogs), ["Auto-orient needs a 3D layer (severity 2)"]);
  assert.match(r.result.aeSuppressedDialogsNote, /suppressed/);
  assert.equal(state.onError, theirs, "another script's onError must be put back");
  assert.equal(state.suppressed, 0);
});

check("a scalar result is wrapped rather than losing the message", () => {
  const { ctx, call } = load({ dialogs: true });
  vm.runInContext('OPS.warns2 = function () { app.__warn("w"); return 4; }', ctx);
  const r = call("warns2", {});
  assert.equal(r.result.returned, 4);
  assert.equal(r.result.aeSuppressedDialogs.length, 1);
});

check("a failing op still ends suppression and carries the message", () => {
  const { ctx, state, log, call } = load({ dialogs: true });
  vm.runInContext('OPS.fails = function () { app.__warn("mismatch"); throw new Error("boom"); }', ctx);
  const r = call("fails", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom \|\| After Effects also said \(dialog suppressed\): mismatch/);
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

console.log(`run-jsx-undo-guard: ${passed} checks passed`);
