// run_jsx assembled and mapped on the server, held byte-identical to raw.jsx
// (issue #220, stage 6).
//
// A panel listing `server-run-jsx` gets `_run_jsx` with a wrapper the server
// built (tools/runJsxAssembly.ts) and sends a failure back with the raw line
// for the server to map. Every other panel, and every run_batch step, still
// goes through OPS.run_jsx, which assembles and maps in ExtendScript. The two
// must answer alike, to the byte, and this file is what holds them there:
//
//   1. the builder: TS against raw.jsx's __rjBuildSource, on fixtures and on
//      generated sources — wrapper, preamble, segments, rewrite counts,
//      cautions;
//   2. the whole call: each fixture run through OPS.run_jsx (the old path)
//      and through the server's build + OPS._run_jsx + the server's mapping,
//      with the panel's named forward (client/main.js) in between, comparing
//      the result, the error text and every undo call made on `app`;
//   3. through tools/call: the same fixtures from files, a legacy panel
//      against a `server-run-jsx` one, compared as the agent reads them, plus
//      the routing — who is sent what, and the fallback on `Unknown op`.
//
// What it cannot know is how ExtendScript itself parses and numbers lines;
// both paths hand the same strings to the same eval, which is the point. The
// live checks named in the PR cover a real AE.
//
//   node tests/unit/run-jsx-assembly.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsx = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const core = jsx("core.jsx");
const snapshot = jsx("snapshot.jsx");
const raw = jsx("raw.jsx");
const viewer = jsx("viewer.jsx");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { AeError, aeErrorText } = await import(dist("util", "errors.js"));
const asm = await import(dist("tools", "runJsxAssembly.js"));
const { resolveRunJsxSource } = await import(dist("tools", "runJsxSource.js"));
const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));
const { CAP_SERVER_RUN_JSX } = await import(dist("setup", "panelCapabilities.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`run-jsx-assembly FAILED: ${name}`);
    throw e;
  }
}

/** A fresh ExtendScript context, logging every undo call made on `app`. */
function es(opts = {}) {
  const log = [];
  const ctx = {
    app: {
      beginUndoGroup(n) { log.push(`begin ${n}`); },
      endUndoGroup() { log.push("end"); },
    },
  };
  vm.createContext(ctx);
  if (opts.parseLines) {
    // Node's SyntaxError carries no `line`, so a library parse failure would
    // always map from rawLine null. This stands in for ExtendScript's parser:
    // a library parse check (an uncalled `(function(){ … })`) whose text
    // contains `PARSE_FAIL` throws as AE does, with the line of the marker.
    // Replacing `eval` makes every eval indirect (global scope), which the
    // fixtures that use it are written not to need.
    const realEval = vm.runInContext("eval", ctx);
    ctx.eval = (src) => {
      const s = String(src);
      if (s.startsWith("(function(){ ") && s.endsWith("})") && s.includes("PARSE_FAIL")) {
        const line = s.slice(0, s.indexOf("PARSE_FAIL")).split("\n").length;
        throw { message: "Syntax error", line };
      }
      return realEval(s);
    };
  }
  vm.runInContext(core, ctx, { filename: "core.jsx" });
  vm.runInContext(snapshot, ctx, { filename: "snapshot.jsx" });
  vm.runInContext(raw, ctx, { filename: "raw.jsx" });
  vm.runInContext(viewer, ctx, { filename: "viewer.jsx" });
  return {
    log,
    get: (n) => vm.runInContext(n, ctx),
    dispatch: (op, args) => JSON.parse(JSON.stringify(vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args })))),
  };
}
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * client/main.js's runOp and handleOp, then httpClient's AeError: the named
 * forward is the contract, so it is reproduced field for field. The source
 * scan below fails if main.js stops forwarding what this assumes.
 */
function overTheBridge(out) {
  if (out.ok) return { ok: true, result: out.result };
  let source;
  if (out.sourceLine !== undefined || out.rawLine !== undefined) {
    source = {
      sourceLine: out.sourceLine,
      sourceText: out.sourceText,
      sourceName: out.sourceName,
      rawLine: out.rawLine,
      lineCount: out.lineCount,
      wrapperLine: out.wrapperLine,
      libraryIndex: out.libraryIndex,
    };
  }
  return plain({ ok: false, error: out.error, stack: out.stack, line: out.line, source });
}
function toAeError(body) {
  return new AeError(body.error, body.stack, body.line, body.code, body.source);
}

// ---------- the panel forwards what the server maps ----------

await check("main.js forwards wrapperLine and libraryIndex, and lists server-run-jsx", () => {
  const main = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "main.js"), "utf8");
  assert.match(main, /wrapperLine:\s*parsed\.wrapperLine/);
  assert.match(main, /libraryIndex:\s*parsed\.libraryIndex/);
  assert.match(main, /PANEL_CAPABILITIES\s*=\s*\[[^\]]*"server-run-jsx"/);
  assert.equal(CAP_SERVER_RUN_JSX, "server-run-jsx");
});

// ---------- 1. the builder ----------

const L = (p, text) => ({ path: p, text });
const builderFixtures = [
  ["no libraries", "return 1;", undefined],
  ["empty libraries", "return 1;", []],
  ["CRLF script", "var a = 1;\r\nvar b = 2;\r\nreturn a + b;", undefined],
  ["bare CR script", "var a = 1;\rreturn a;", undefined],
  ["two libraries", "var a = 1;\nreturn a;", [L("/t/a.jsx", "function a1(){}\nfunction a2(){}"), L("/t/b.jsx", "function b1(){}")]],
  ["library ending in a comment", "return rig();", [L("/t/r.jsx", "function rig(){ return 5; } // the rig")]],
  ["library already newline-terminated", "return 1;", [L("/t/r.jsx", "function r(){}\n")]],
  ["library ending in CR", "return 1;", [L("/t/r.jsx", "function r(){}\r")]],
  ["library CRLF", "return 1;", [L("/t/r.jsx", "function r(){\r\n  return 2;\r\n}")]],
  ["undo in script", "app.beginUndoGroup('x');\nvar a = 1;\napp.endUndoGroup();\nreturn a;", undefined],
  ["undo split over lines", "app\n  .\n  beginUndoGroup('x');\napp . endUndoGroup ( );", undefined],
  ["undo as a member of something else", "foo.app.beginUndoGroup('x'); app2.endUndoGroup();", undefined],
  ["undo in a string and a comment", "var s = 'app.beginUndoGroup'; // app.endUndoGroup()\n/* app.endUndoGroup() */ return s;", undefined],
  ["undo in a library only", "return rig();", [L("/t/r.jsx", "function rig(){ app.beginUndoGroup('r'); app.endUndoGroup(); return 1; }")]],
  ["undo in library and script", "app.endUndoGroup();", [L("/t/r.jsx", "app.beginUndoGroup('lib');\n"), L("/t/s.jsx", "var plain = 1;")]],
  ["withoutUndoGroup is not a mention", "withoutUndoGroup(function(){ return 1; });", undefined],
  ["eval", "return eval('1+1');", undefined],
  ["eval with space and newline", "return eval \n ('1');", undefined],
  ["new Function", "var f = new Function('return 1'); return f();", undefined],
  ["$.evalFile", "$ . evalFile('/x.jsx');", undefined],
  ["evalFile not on $", "foo.evalFile('/x.jsx'); myeval(1); retrieval(); myFunction();", undefined],
  ["\\u escape spelling", "app.\\u0062eginUndoGroup('x');", undefined],
  ["\\u escape harmless", "var s = '\\u00e9';", undefined],
  ["\\u short and odd", "var s = '\\u12'; var t = '\\u12zz';", undefined],
  ["cautions in a library merge without repeats", "eval('1');", [L("/t/a.jsx", "eval('2'); new Function('x');"), L("/t/b.jsx", "Function('y');")]],
  ["unterminated string and comment", "var s = 'abc\napp.beginUndoGroup('x');\n/* never closed app.endUndoGroup()", undefined],
  ["escaped quotes", "var s = 'it\\'s app.beginUndoGroup'; app.endUndoGroup();", undefined],
  ["regex literal with a quote", "var r = /'/; app.beginUndoGroup('x');", undefined],
  ["unicode and odd spaces", "var s = \"é\"; app .﻿beginUndoGroup('x'); app.endUndoGroup();", undefined],
];

function esBuild(e, code, libs) {
  const b = e.get("__rjBuildSource")(code, libs === undefined ? null : libs);
  return plain({
    wrapper: b.wrapper,
    preambleLines: b.preambleLines,
    segments: b.segments,
    undoRewrites: b.undoRewrites,
    undoMentions: b.undoMentions,
    opaqueRoutes: b.opaqueRoutes,
  });
}
function tsBuild(code, libs) {
  const b = asm.buildRunJsxSource(code, libs);
  assert.ok(b, "buildable");
  return {
    built: b,
    shape: plain({
      wrapper: b.wrapper,
      preambleLines: b.preambleLines,
      segments: b.segments,
      undoRewrites: b.undoRewrites,
      undoMentions: b.undoMentions,
      opaqueRoutes: b.opaqueRoutes,
    }),
  };
}

const e0 = es();
for (const [name, code, libs] of builderFixtures) {
  await check(`builder parity: ${name}`, () => {
    const { built, shape } = tsBuild(code, libs);
    assert.deepEqual(shape, esBuild(e0, code, libs));
    // Each library's parse check sees exactly what raw.jsx's would: the
    // library as written, newline-terminated.
    for (let k = 0; k < built.libraryChecks.length; k++) {
      const c = built.libraryChecks[k];
      const asWritten = built.segments[k].lines.join("\n");
      const checked = c.text ?? built.wrapper.substring(c.start, c.end);
      assert.equal(
        checked.split("\r\n").join("\n").split("\r").join("\n"),
        asWritten,
        "the check parses the library as written"
      );
      if (c.text === undefined) assert.equal(built.wrapper.substring(c.start, c.end), checked);
      else assert.notEqual(built.wrapper.substring(c.start, c.end), c.text, "text travels only when rewritten");
    }
  });
}

await check("builder parity: generated sources (rewrite, fast path, cautions)", () => {
  // Fragments chosen to land on every branch of the scanner: quotes, escapes,
  // comment openers, member chains, the undo names, the opaque routes.
  const parts = [
    "app", ".", " ", "\n", "\r\n", "\t", "beginUndoGroup", "endUndoGroup", "(", ")", "'", "\"", "\\", "/", "*",
    "//", "/*", "*/", "eval", "Function", "new ", "$", "evalFile", "\\u0062", "\\u0065", "x", "foo", ";", " ",
    "withoutUndoGroup", "UndoGroup", "0", "_", "é",
  ];
  let seed = 0x2206;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    let code = "";
    const len = 1 + rnd(40);
    for (let j = 0; j < len; j++) code += parts[rnd(parts.length)];
    assert.deepEqual(asm.rewriteUndoText(code), plain(e0.get("__rjRewriteUndoText")(code)), `rewrite diverged on ${JSON.stringify(code)}`);
    assert.deepEqual(asm.opaqueRoutes(code), plain(e0.get("__rjOpaqueRoutes")(code)), `cautions diverged on ${JSON.stringify(code)}`);
    assert.equal(asm.mentionsUndo(code), e0.get("__rjMentionsUndo")(code));
    const { shape } = tsBuild(code, undefined);
    assert.deepEqual(shape, esBuild(e0, code, undefined), `diverged on ${JSON.stringify(code)}`);
  }
});

await check("builder parity: generated libraries that parse", () => {
  // raw.jsx parse-checks a library inside __rjBuildSource, so only libraries
  // that parse can be compared through it; the scanner itself is compared
  // on everything above.
  const bodies = [
    "function a(){ app.beginUndoGroup('x'); }", "var s = 'app.endUndoGroup()';", "// app.endUndoGroup()",
    "/* eval( */ var q = 1;", "function b(){ return eval('1'); }", "var t = \"\\u0062eginUndoGroup\";",
    "app\n.\nendUndoGroup();", "var r = /'/;", "function c(){}\r\nfunction d(){}", "x.app.beginUndoGroup;",
  ];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 400; i++) {
    const libs = [];
    const count = 1 + rnd(3);
    for (let k = 0; k < count; k++) {
      let text = "";
      const lines = 1 + rnd(4);
      for (let j = 0; j < lines; j++) text += bodies[rnd(bodies.length)] + (rnd(2) ? "\n" : " ");
      libs.push(L(`/t/g${k}.jsx`, text));
    }
    const code = bodies[rnd(bodies.length)] + "\nreturn 1;";
    const { shape } = tsBuild(code, libs);
    assert.deepEqual(shape, esBuild(e0, code, libs), `diverged on ${JSON.stringify(libs)}`);
  }
});

await check("an unbuildable library goes down the old path, never an invented error", () => {
  assert.equal(asm.buildRunJsxSource("return 1;", [L("/t/blank.jsx", "  \n\t")]), null);
  assert.equal(asm.buildRunJsxSource("return 1;", [{ path: "/t/x.jsx" }]), null);
  assert.equal(asm.buildRunJsxSource("return 1;", [L("", "function a(){}")]), null);
});

// ---------- 2. the whole call, old path against new ----------

/** OPS.run_jsx as every panel before stage 6 runs it. */
function runOld(args, opts) {
  const e = es(opts);
  const body = overTheBridge(e.dispatch("run_jsx", args));
  return { body, log: e.log };
}

/** The server's build, OPS._run_jsx, the server's map — through runJsxViaServer itself. */
async function runNew(args, opts) {
  const e = es(opts);
  const sent = [];
  const send = async (op, a) => {
    sent.push(op);
    const body = overTheBridge(e.dispatch(op, a));
    if (!body.ok) throw toAeError(body);
    return body.result;
  };
  const fallback = async () => { throw new Error("fell back to run_jsx"); };
  try {
    const result = await asm.runJsxViaServer(args, send, fallback);
    return { body: { ok: true, result: plain(result) }, err: null, log: e.log, sent };
  } catch (err) {
    if (!(err instanceof AeError)) throw err;
    return { body: null, err, log: e.log, sent };
  }
}

/** What the agent reads, for an old-path answer. */
function oldOutcome(body) {
  if (body.ok) return { ok: true, result: body.result };
  const err = toAeError(body);
  return { ok: false, text: aeErrorText(err), line: err.line ?? null, source: plain(err.source ?? null) };
}
function newOutcome(r) {
  if (r.body) return { ok: true, result: r.body.result };
  return { ok: false, text: aeErrorText(r.err), line: r.err.line ?? null, source: plain(r.err.source ?? null) };
}

const lib = (p, text) => ({ path: p, text, bytes: Buffer.byteLength(text) });
const W = asm.WRAP_PREFIX;
const callFixtures = [
  ["a value", { code: "return 41 + 1; // done" }],
  ["an object with arrays", { code: "return {done: [1, 2], skipped: []};" }],
  ["no return value", { code: "var a = 1;" }],
  ["explicit null", { code: "return null;" }],
  ["undefined, NaN and Infinity inside a result", { code: "return [undefined, NaN, Infinity, -Infinity, function(){}];" }],
  ["undoGroup:false", { code: "return 1;", undoGroup: false }],
  ["a library in scope", { code: "return rig(3);", libraries: [lib("/t/rig.jsx", "function rig(n){ return n * 7; }")] }],
  ["libraries in order", { code: "return two();", libraries: [lib("/t/one.jsx", "function one(){ return 1; }"), lib("/t/two.jsx", "function two(){ return one() + 1; }")] }],
  ["a throw at a known line", { code: "var a = 1;\nthrow {message: 'exploded', line: 2};\n" }],
  ["a throw named by scriptPath", { code: "var a = 1;\nvar b = 2;\nthrow {message: 'x', line: 3};", scriptPath: "/Users/x/rig.jsx" }],
  ["a throw past the end of the script", { code: "throw {message: 'far', line: 22};" }],
  ["line 0 and a negative line", { code: "throw {message: 'zero', line: 0};" }],
  ["a thrown Error with no line", { code: "nope();" }],
  ["a thrown string", { code: "throw 'just a string';" }],
  ["a thrown object with no message", { code: "throw {line: 1};" }],
  ["a syntax error in the script", { code: "var a = ;\nreturn a;" }],
  ["a long line is clipped", { code: "throw {message: 'long', line: 1, pad: '" + "y".repeat(400) + "'};" }],
  ["CRLF script", { code: "var a = 1;\r\nvar b = 2;\r\nthrow {message: 'crlf', line: 3};" }],
  ["source/start offsets that count", { code: "var a = 1;\nvar b = 2;\nthrow {message: 'off', line: 99, source: " + JSON.stringify(W + "var a = 1;\nvar b = 2;\nboom") + ", start: " + (W.length + 22) + "};" }],
  ["start 0 end 0 is AE saying nothing", { code: "var a = 1;\nthrow {message: 'zz', line: 2, source: " + JSON.stringify(W + "x") + ", start: 0, end: 0};" }],
  ["start 0 with an end", { code: "throw {message: 'head', line: 99, source: " + JSON.stringify(W + "x") + ", start: 0, end: 12};" }],
  ["a source that is not our wrapper", { code: "var a;\nthrow {message: 'foreign', line: 2, source: 'other\\nfile', start: 7};" }],
  ["a throw in the script below libraries", { code: "var a = 1;\nthrow {message: 'exploded', line: 4};\n", libraries: [lib("/t/rig.jsx", "function rig(){}\nfunction rag(){}")] }],
  ["a throw inside a library", { code: "return 1;", libraries: [lib("/t/rig.jsx", "function rig(){}\nthrow {message: 'lib blew up', line: 2};")] }],
  ["a throw inside the second library", { code: "return 1;", libraries: [lib("/t/a.jsx", "function a(){}"), lib("/t/b.jsx", "var q = 1;\nthrow {message: 'b', line: 3};")] }],
  ["a library that does not parse", { code: "return 1;", libraries: [lib("/t/broken.jsx", "function rig(){ return 1;")] }],
  ["the second library does not parse", { code: "return 1;", libraries: [lib("/t/ok.jsx", "function ok(){}"), lib("/t/broken.jsx", "var a = ;")] }],
  ["a library with undo calls that does not parse", { code: "return 1;", libraries: [lib("/t/u.jsx", "app.beginUndoGroup('x');\nfunction (")] }],
  ["balanced undo calls", { code: "app.beginUndoGroup('mine');\nvar a = 1;\napp.endUndoGroup();\nreturn a;" }],
  ["a begin left open", { code: "app.beginUndoGroup('mine');\nreturn 2;" }],
  ["a stray end", { code: "app.endUndoGroup();\nreturn 3;" }],
  ["undo calls with undoGroup:false", { code: "app.beginUndoGroup('own');\napp.endUndoGroup();\nreturn 4;", undoGroup: false }],
  ["a begin left open with undoGroup:false", { code: "app.beginUndoGroup('own');\nreturn 5;", undoGroup: false }],
  ["undo named only in a comment", { code: "// app.beginUndoGroup is not called\nreturn 6;" }],
  ["undo in a library", { code: "return rig();", libraries: [lib("/t/r.jsx", "function rig(){ app.beginUndoGroup('r'); app.endUndoGroup(); return 7; }")] }],
  ["undo calls, then a throw", { code: "app.beginUndoGroup('mine');\nthrow {message: 'mid', line: 2};" }],
  ["eval caution", { code: "return eval('1 + 1');" }],
  ["Function caution", { code: "return new Function('return 8')();" }],
  ["$.evalFile caution", { code: "if (false) $.evalFile('/x.jsx');\nreturn 9;" }],
  ["\\u escape caution", { code: "if (false) app.\\u0065ndUndoGroup();\nreturn 10;" }],
  ["caution from a library", { code: "return 11;", libraries: [lib("/t/e.jsx", "function e(){ return eval('1'); }")] }],
  ["caution and a stray end", { code: "app.endUndoGroup();\nreturn eval('12');" }],
  ["caution, then a throw", { code: "eval('1');\nthrow {message: 'after eval', line: 2};" }],
  ["alert and confirm", { code: "alert('hi'); var c = confirm('sure?'); return c;" }],
  ["a dialog, then a throw", { code: "prompt('name?');\nthrow {message: 'after prompt', line: 2};" }],
  ["diff with no comp", { code: "return 13;", diff: true }],
  ["diff on a failure", { code: "throw {message: 'diffed', line: 1};", diff: true }],
  ["a nested run_jsx that throws", { code: "var r = OPS.run_jsx({code: 'var x;\\nthrow {message: \"inner\", line: 2};'});\nreturn r;" }],
  ["a script reading an undeclared name", { code: "return typeof notDeclaredAnywhere;" }],
];

for (const [name, args] of callFixtures) {
  await check(`call parity: ${name}`, async () => {
    const before = runOld(structuredClone(args));
    const after = await runNew(structuredClone(args));
    assert.deepEqual(after.sent, ["_run_jsx"], "the built op, once");
    assert.deepEqual(newOutcome(after), oldOutcome(before.body));
    assert.deepEqual(after.log, before.log, "the same undo calls reach After Effects, in the same order");
  });
}

// A library parse failure AT A KNOWN LINE. The harness's own syntax errors
// carry no line, so without the stub the mapping branch for a library that
// does not parse (rawLine within the library) never runs.
const parseFixtures = [
  ["line 1 of a one-line library", [lib("/t/p.jsx", "var PARSE_FAIL = 1;")], 0, 1, "var PARSE_FAIL = 1;"],
  ["line 3 of a library", [lib("/t/p.jsx", "function a(){}\nfunction b(){}\n  var x = PARSE_FAIL;  \nfunction c(){}")], 0, 3, "var x = PARSE_FAIL;"],
  ["the last line of the second library", [lib("/t/ok.jsx", "function ok(){}\nfunction ok2(){}"), lib("/t/p.jsx", "var a = 1;\r\nvar PARSE_FAIL;")], 1, 2, "var PARSE_FAIL;"],
  ["a rewritten library", [lib("/t/u.jsx", "app.beginUndoGroup('x');\nvar q;\napp.endUndoGroup(); PARSE_FAIL")], 0, 3, "app.endUndoGroup(); PARSE_FAIL"],
];
for (const [name, libraries, which, line, text] of parseFixtures) {
  await check(`call parity, library parse failure at a known line: ${name}`, async () => {
    const args = { code: "return 1;", libraries };
    const before = runOld(structuredClone(args), { parseLines: true });
    const after = await runNew(structuredClone(args), { parseLines: true });
    const o = oldOutcome(before.body);
    assert.deepEqual(newOutcome(after), o);
    // Pinned, not only compared: an off-by-one on either side must fail.
    assert.equal(o.ok, false);
    assert.equal(o.source.sourceName, libraries[which].path);
    assert.equal(o.source.rawLine, line);
    assert.equal(o.source.sourceLine, line);
    assert.equal(o.source.sourceText, text);
    assert.equal(after.err.source.sourceLine, line);
    assert.equal(after.err.source.sourceText, text);
    assert.match(o.text, new RegExp(`at line ${line} of ${libraries[which].path.replace(/\./g, "\\.")}`));
  });
}

await check("library parse failure: a line past the library's end is unmapped, not clamped", async () => {
  const built = asm.buildRunJsxSource("return 1;", [lib("/t/p.jsx", "var a;\nvar b;")]);
  const m = asm.mapRunJsxFailure({ rawLine: 3, libraryIndex: 0 }, "return 1;", undefined, built);
  assert.deepEqual(plain(m), { lineCount: 2, rawLine: 3, sourceLine: null, sourceText: null, sourceName: "/t/p.jsx" });
  const first = asm.mapRunJsxFailure({ rawLine: 1, libraryIndex: 0 }, "return 1;", undefined, built);
  assert.equal(first.sourceText, "var a;");
});

await check("the fixtures reach the branches they are named for", async () => {
  const pick = (n) => callFixtures.find(([k]) => k === n)[1];
  const o = (n) => oldOutcome(runOld(structuredClone(pick(n))).body);
  assert.match(o("a throw inside a library").text, /line 2 of \/t\/rig\.jsx/);
  assert.match(o("a library that does not parse").text, /failed to parse: \/t\/broken\.jsx/);
  assert.match(o("source/start offsets that count").text, /at line 3 of the script you submitted/);
  assert.match(o("a throw past the end of the script").text, /does not fall inside/);
  assert.match(o("a stray end").result ? JSON.stringify(o("a stray end").result) : "", /UNBALANCED/);
  assert.match(JSON.stringify(o("eval caution").result), /CAUTION: this script uses eval/);
  assert.match(JSON.stringify(o("caution from a library").result), /CAUTION/);
  assert.match(o("a throw in the script below libraries").text, /After Effects reported line 4/);
});

await check("unchanged libraries are not sent twice; a rewritten one is", async () => {
  const e = es();
  let payload;
  await asm.runJsxViaServer(
    { code: "return 1;", libraries: [lib("/t/a.jsx", "function a(){}"), lib("/t/u.jsx", "function u(){ app.endUndoGroup(); }")] },
    async (op, a) => { payload = a; return e.dispatch(op, a).result; },
    async () => assert.fail("no fallback"),
    () => {}
  );
  assert.equal(payload.code, undefined, "the script travels once, inside the wrapper");
  assert.equal(payload.libraries, undefined);
  assert.equal(payload.built.libraries[0].text, undefined);
  assert.equal(payload.built.libraries[1].text, "function u(){ app.endUndoGroup(); }\n");
});

await check("Unknown op: _run_jsx is thrown as it came, never retried as run_jsx (#243); a script's own error is mapped", async () => {
  // A panel that does not know `_run_jsx` predates this server; the caller's
  // backstop tells the user to update it. Nothing is re-sent under another name.
  const legacy = [];
  await assert.rejects(
    asm.runJsxViaServer(
      { code: "return 1;", undoGroup: false },
      async () => { throw new AeError("Unknown op: _run_jsx"); },
      async (op, a) => { legacy.push([op, a]); return 1; }
    ),
    (err) => err instanceof AeError && /^Unknown op: _run_jsx/.test(err.message)
  );
  assert.deepEqual(legacy, [], "fell back to run_jsx");

  // The same words thrown by the script itself come back mapped, so they are
  // the script's failure and are never re-run.
  const e = es();
  await assert.rejects(
    asm.runJsxViaServer(
      { code: "throw {message: 'Unknown op: _run_jsx', line: 1};" },
      async (op, a) => { const b = overTheBridge(e.dispatch(op, a)); throw toAeError(b); },
      async () => assert.fail("a script that ran must not run again")
    ),
    (err) => err instanceof AeError && err.source?.sourceLine === 1
  );
});

// ---------- 3. through tools/call, against OPS.run_jsx as the reference ----------
//
// Since #243 every server sends `_run_jsx`. The reference session's panel
// answers that by running OPS.run_jsx on the args the server resolved — what
// a server before #220 forwarded — so the agent-visible text of the two paths
// is still compared end to end.

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import(dist("server.js"));

const servers = [];
/** A panel answering from a real ExtendScript context, behind a real MCP server. */
async function session(health, opts = {}) {
  const s = { seen: [], logs: [] };
  const bridge = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash(), ...health }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { op, args } = JSON.parse(body || "{}");
      s.seen.push(op);
      if (opts.unknown?.includes(op)) {
        res.end(JSON.stringify({ ok: false, error: `Unknown op: ${op}` }));
        return;
      }
      const e = es();
      const reference = opts.reference && op === "_run_jsx";
      const out = overTheBridge(reference ? e.dispatch("run_jsx", s.referenceArgs) : e.dispatch(op, args));
      s.logs.push(e.log);
      res.end(JSON.stringify(out));
    });
  });
  const wss = new WebSocketServer({ server: bridge, path: "/events" });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
  const port = bridge.address().port;
  assert.notEqual(port, 7777, "must not bind the panel's port");
  process.env.AE_MCP_PORT = String(port);
  const server = createServer();
  const client = new Client({ name: "run-jsx-assembly-test", version: "0" }, { capabilities: {} });
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]);
  servers.push({ bridge, wss, port });
  s.call = async (name, args) => {
    s.seen.length = 0;
    s.logs.length = 0;
    const res = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: res.content.map((b) => b.text ?? "").join("\n---\n") };
  };
  return s;
}

// What the panel ran, less the viewer park and unpark around a script.
const scriptOps = (s) => s.seen.filter((op) => op !== "_viewer_park" && op !== "_viewer_unpark");

const referencePanel = await session({}, { reference: true });
const capablePanel = await session({});

const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-rjx-asm-"));
const writeFile = (name, text) => {
  const p = path.join(fileDir, name);
  fs.writeFileSync(p, text);
  return p;
};

const toolFixtures = callFixtures
  .filter(([n]) => n !== "a nested run_jsx that throws")
  .map(([name, a]) => {
    const args = {};
    if (a.scriptPath) args.scriptPath = writeFile(`s-${name.replace(/\W+/g, "_")}.jsx`, a.code);
    else args.code = a.code;
    if (a.libraries) args.libraries = a.libraries.map((l, i) => writeFile(`l-${i}-${name.replace(/\W+/g, "_")}.jsx`, l.text));
    if (a.undoGroup !== undefined) args.undoGroup = a.undoGroup;
    if (a.diff !== undefined) args.diff = a.diff;
    return [name, args];
  });

for (const [name, args] of toolFixtures) {
  await check(`tools/call parity: ${name}`, async () => {
    referencePanel.referenceArgs = resolveRunJsxSource(args);
    const before = await referencePanel.call("run_jsx", args);
    const after = await capablePanel.call("run_jsx", args);
    // The viewer park around it (issue #266) is tests/unit/quiet-viewer.mjs's.
    assert.deepEqual(scriptOps(capablePanel), ["_run_jsx"], "the panel gets the built op and nothing else");
    // The library and script paths are the only thing that differ by fixture
    // file, and they are the same files on both sides.
    assert.equal(after.isError, before.isError);
    assert.equal(after.text, before.text);
    assert.deepEqual(capablePanel.logs, referencePanel.logs, "the same undo calls");
  });
}

await check("tools/call: a panel that does not know _run_jsx is told to update, and nothing is re-sent (#243)", async () => {
  const old = await session({}, { unknown: ["_run_jsx"] });
  const r = await old.call("run_jsx", { code: "return 1;" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /older than these tools/);
  assert.match(r.text, /setup_panel/);
  assert.deepEqual(scriptOps(old), ["_run_jsx"], "retried under the public name");
});

await check("tools/call: run_batch steps still go to OPS.run_jsx inside the batch", async () => {
  // Routing only: batch.jsx dispatches its steps to OPS[step.op] itself, so a
  // run_jsx step is assembled and mapped in ExtendScript on every panel.
  await capablePanel.call("run_batch", { ops: [{ op: "run_jsx", args: { code: "return 2;" } }] });
  assert.deepEqual(scriptOps(capablePanel), ["run_batch"]);
});

console.log(`run-jsx-assembly: ${passed} checks passed`);
fs.rmSync(fileDir, { recursive: true, force: true });
for (const { bridge, wss, port } of servers) {
  wss.close();
  bridge.close();
  fs.rmSync(path.join(os.homedir(), ".engineroom-ae-mcp", `frames-${port}.jsonl`), { force: true });
}
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
