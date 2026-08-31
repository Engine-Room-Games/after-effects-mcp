// Mapping a run_jsx failure back onto the script the caller submitted.
//
// The reported line did not correspond to the submitted source, and the shift
// was not even constant between calls — the same "line 22" pointed at two
// different statements in consecutive calls (issue #46). That matters more here
// than it would anywhere else: nothing rolls back, so an agent that mislocates
// the throw has to read the whole project back to find out where the script
// stopped, and the alternative it reaches for — running the script again —
// applies the first half of the work twice.
//
// The invariant that broke is the one this file exists to hold: the wrapper's
// preamble is exactly as many lines as the offset code believes it is. It can
// be asserted with no After Effects, which is the only way it will ever be
// asserted at all.
//
// The second half is the part that survives the numbering being wrong anyway:
// the failing line's TEXT, and an explicit admission when the number could not
// be mapped rather than a plausible wrong one.
//
//   node tests/unit/run-jsx-lines.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = fs.readFileSync(path.join(root, "packages", "jsx", "core.jsx"), "utf8");
const raw = fs.readFileSync(path.join(root, "packages", "jsx", "raw.jsx"), "utf8");
// raw.jsx calls into snapshot.jsx for `diff:true`, and the bundle loads it first.
const snapshot = fs.readFileSync(path.join(root, "packages", "jsx", "snapshot.jsx"), "utf8");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { AeError, aeErrorText } = await import(dist("util", "errors.js"));

function load() {
  const ctx = {
    app: { beginUndoGroup() {}, endUndoGroup() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(core, ctx, { filename: "core.jsx" });
  vm.runInContext(snapshot, ctx, { filename: "snapshot.jsx" });
  vm.runInContext(raw, ctx, { filename: "raw.jsx" });
  return {
    ctx,
    get: (name) => vm.runInContext(name, ctx),
    call: (op, args) => vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args })),
  };
}

const { get, call } = load();
let passed = 0;
const check = (name, fn) => { fn(); passed++; };

// ---------- the invariant ----------

check("the wrapper's prefix carries no newline", () => {
  const prefix = get("__RJ_WRAP_PREFIX");
  assert.equal(
    prefix.indexOf("\n"),
    -1,
    "__RJ_WRAP_PREFIX gained a newline. The caller's line 1 is no longer line 1 of\n" +
      "the evaluated source, so every reported line is off by however many were added.\n",
  );
});

check("the offset counts the prefix rather than asserting it", () => {
  const prefix = get("__RJ_WRAP_PREFIX");
  const counted = prefix.split("\n").length - 1;
  assert.equal(
    get("__RJ_PREAMBLE_LINES"),
    counted,
    "__RJ_PREAMBLE_LINES disagrees with the prefix it describes. This is the exact\n" +
      "drift that produced issue #46: a constant that stopped matching the string.\n",
  );
  assert.equal(counted, 0, "the caller's first line must be line 1 of the evaluated source");
});

check("the closer sits on its own line, so a trailing // comment cannot eat it", () => {
  assert.ok(get("__RJ_WRAP_SUFFIX").charAt(0) === "\n");
  // The functional half: this script is a syntax error if the closer is
  // appended to the caller's last line.
  const r = call("run_jsx", { code: "return 41 + 1; // done" });
  assert.equal(r.ok, true, `a script ending in a comment must still parse: ${r.error}`);
  assert.equal(r.result, 42);
});

// ---------- mapping ----------

const script = [
  "var comp = app.project.activeItem;",
  "var layer = comp.layer(1);",
  "  layer.property('Nope').setValue(1);",
  "return layer.name;",
].join("\n");

const info = (e, code, scriptPath) => get("__rjSourceInfo")(e, code === undefined ? script : code, scriptPath);

check("a line After Effects reports maps onto that line of the source, with its text", () => {
  const out = info({ message: "boom", line: 3 });
  assert.equal(out.sourceLine, 3);
  assert.equal(out.rawLine, 3);
  assert.equal(out.lineCount, 4);
  // Trimmed: the leading indentation is noise in a one-line quote.
  assert.equal(out.sourceText, "layer.property('Nope').setValue(1);");
});

check("a line outside the submitted source is refused, not clamped", () => {
  const out = info({ message: "boom", line: 22 });
  assert.equal(out.sourceLine, null, "a line past the end of the script must not be reported as a line of it");
  assert.equal(out.sourceText, null);
  assert.equal(out.rawLine, 22, "what AE said is still reported, so the reader can see the disagreement");
  assert.equal(out.lineCount, 4);
});

check("line 0 and negative lines are refused too", () => {
  assert.equal(info({ line: 0 }).sourceLine, null);
  assert.equal(info({ line: -4 }).sourceLine, null);
});

check("no line information at all yields no line, never a guess", () => {
  const out = info(new Error("plain"));
  assert.equal(out.sourceLine, null);
  assert.equal(out.rawLine, null);
  assert.equal(out.lineCount, 4);
});

check("Error.source + Error.start answer directly when ExtendScript provides them", () => {
  // ExtendScript records the source an error was raised in and the character
  // offset into it. That is a better answer than `line`, because it needs no
  // assumption about what `line` counts from.
  const wrapper = get("__RJ_WRAP_PREFIX") + script + get("__RJ_WRAP_SUFFIX");
  const start = wrapper.indexOf("setValue");
  // A deliberately wrong `line` alongside it: source/start must win.
  const out = info({ message: "boom", line: 99, source: wrapper, start });
  assert.equal(out.sourceLine, 3);
  assert.equal(out.sourceText, "layer.property('Nope').setValue(1);");
  assert.equal(out.rawLine, 99, "AE's own number is still carried through");
});

check("a source that is not our wrapper is ignored rather than mis-measured", () => {
  const out = info({ message: "boom", line: 2, source: "some other file\nline two\n", start: 20 });
  assert.equal(out.sourceLine, 2, "falls back to the line number rather than measuring a foreign source");
});

check("a script from a file names the file", () => {
  const out = info({ line: 1 }, script, "/Users/x/rig.jsx");
  assert.equal(out.sourceName, "/Users/x/rig.jsx");
});

check("a very long line is clipped rather than returned whole", () => {
  const long = "var x = '" + "y".repeat(500) + "';";
  const out = info({ line: 1 }, long);
  assert.ok(out.sourceText.length < 220, `source line came back ${out.sourceText.length} chars long`);
  assert.ok(out.sourceText.endsWith("..."), "a clipped line has to say it was clipped");
});

check("CRLF sources line up the same as LF ones", () => {
  const crlf = "var a = 1;\r\nvar b = 2;\r\nthrow new Error('x');";
  const out = info({ line: 3 }, crlf);
  assert.equal(out.lineCount, 3);
  assert.equal(out.sourceText, "throw new Error('x');");
});

// ---------- through dispatch ----------

check("a failing script comes back as a failure carrying the mapping", () => {
  const r = call("run_jsx", { code: "var a = 1;\nthrow {message: 'exploded', line: 2};\n" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "exploded");
  assert.equal(r.sourceLine, 2);
  assert.equal(r.sourceText, "throw {message: 'exploded', line: 2};");
  assert.equal(r.lineCount, 3);
});

check("a failure with no line info still reports the script's shape", () => {
  const r = call("run_jsx", { code: "nope();" });
  assert.equal(r.ok, false);
  assert.match(r.error, /nope/);
  assert.equal(r.sourceLine, null, "nothing may be invented from an error that carries no line");
  assert.equal(r.lineCount, 1);
});

check("an unresolved scriptPath is refused rather than run as an empty script", () => {
  // run_batch calls OPS[op](args) directly and never validates them, so a batch
  // step can reach here with the path the server would have substituted. An
  // empty script would come back as "completed with no return value" — a
  // success result for a file nobody read.
  const r = call("run_jsx", { scriptPath: "/tmp/scene.jsx" });
  assert.equal(r.ok, false);
  assert.match(r.error, /\/tmp\/scene\.jsx/);
  assert.match(r.error, /run_batch|POST/);
  assert.equal(call("run_jsx", {}).ok, false, "an empty script is not a run");
});

check("a successful script is untouched by any of this", () => {
  const r = call("run_jsx", { code: "return {a: [1, 2]};" });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result)), { a: [1, 2] });
});

// ---------- how the server prints it ----------

check("a mapped failure prints the line's text", () => {
  const text = aeErrorText(
    new AeError("Object is invalid", "", 3, undefined, {
      sourceLine: 3,
      sourceText: "layer.property('Nope').setValue(1);",
      rawLine: 3,
      lineCount: 4,
    }),
  );
  assert.match(text, /AE: Object is invalid/);
  assert.match(text, /line 3 of the script you submitted, 4 lines/);
  assert.match(text, /layer\.property\('Nope'\)\.setValue\(1\);/);
  assert.match(text, /nothing rolls back/i, "the reader must be told not to re-run it");
});

check("an unmapped failure says the number does not map, rather than printing it plain", () => {
  const text = aeErrorText(
    new AeError("Object is invalid", "", 22, undefined, { sourceLine: null, rawLine: 22, lineCount: 4 }),
  );
  assert.match(text, /reported line 22/);
  assert.match(text, /does not fall inside/);
  assert.match(text, /trust the message, not the number/);
});

check("a script from a file is named in the text", () => {
  const text = aeErrorText(
    new AeError("boom", "", 3, undefined, {
      sourceLine: 3,
      sourceText: "x();",
      sourceName: "/Users/x/rig.jsx",
      rawLine: 3,
      lineCount: 9,
    }),
  );
  assert.match(text, /line 3 of \/Users\/x\/rig\.jsx, 9 lines/);
});

check("an error from any other op is printed exactly as it always was", () => {
  assert.equal(aeErrorText(new AeError("No comp with id 7")), "AE: No comp with id 7");
  assert.equal(aeErrorText(new AeError("boom", "", 12)), "AE: boom (line 12)");
});

console.log(`run-jsx-lines: ${passed} checks passed`);
