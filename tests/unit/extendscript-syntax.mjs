// The gate that keeps syntax ExtendScript cannot run out of bundle.jsx (#164).
//
// Every other test runs the .jsx sources under Node, which accepts ES2015+, so
// they pass on code After Effects refuses outright. PR #192 shipped exactly
// that to a live check: a parameter named `native` — reserved in ES3 — and AE
// 26.5 loaded nothing, `SyntaxError: Illegal use of reserved word`. This holds
// the checker scripts/bundle-jsx.mjs runs before it writes the bundle.
//
//   node tests/unit/extendscript-syntax.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extendScriptProblems } from "../../scripts/lib/extendscript-syntax.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundlePath = path.join(root, "packages", "ae-panel", "jsx", "bundle.jsx");
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exit(1); }
}

check("the built bundle is clean", () => {
  const bundle = fs.readFileSync(bundlePath, "utf8");
  const problems = extendScriptProblems(bundle);
  assert.deepEqual(problems, [], problems.map((p) => `${p.line}:${p.column} ${p.message}`).join("\n"));
});

check("the bundle that failed live on AE 26.5 is refused, naming `native`", () => {
  const bundle = fs.readFileSync(bundlePath, "utf8");
  assert.ok(bundle.includes("function __aemcpJSON(engineJSON)"), "the fixture's anchor moved; update this test");
  const old = bundle.split("engineJSON").join("native");
  const problems = extendScriptProblems(old);
  assert.ok(problems.length > 0, "the live-failing bundle passed the gate");
  assert.match(problems[0].message, /`native` is reserved/);
  const line = old.split("\n")[problems[0].line - 1];
  assert.match(line, /function __aemcpJSON\(native\)/);
});

const refused = {
  "let": "let a = 1;",
  "const": "const a = 1;",
  "arrow function": "var f = function () { return [1].length; }; var g = (x) => x;",
  "template literal": "var s = `a${1}`;",
  "class": "class A {}",
  "destructuring": "var { a } = {};",
  "default parameter": "function f(a = 1) { return a; }",
  "spread": "f(...args);",
  "for-of": "for (var x of y) {}",
  "shorthand method": "var o = { m() {} };",
  "getter": "var o = { get x() { return 1; } };",
  "reserved variable": "var int = 1;",
  "reserved function": "function goto() {}",
  "reserved parameter": "function f(native) { return native; }",
  "reserved catch parameter": "try {} catch (synchronized) {}",
  "reserved label": "transient: for (;;) { break transient; }",
  "Object.keys": "var k = Object.keys({});",
  "Array.isArray": "Array.isArray([]);",
  "Date.now": "var t = Date.now();",
  "forEach": "[1].forEach(function () {});",
  "map": "[1].map(function (x) { return x; });",
  "trim": "' a '.trim();",
  "bind": "(function () {}).bind(null);",
};
for (const [what, code] of Object.entries(refused)) {
  check(`refuses ${what}`, () => {
    assert.ok(extendScriptProblems(code).length > 0, `${what} passed the gate: ${code}`);
  });
}

const allowed = {
  "trailing comma in an object literal (ExtendScript accepts it; the bundle has them)": "var o = { a: 1, b: 2, };",
  "trailing comma in an array literal": "var a = [1, 2, ];",
  "a reserved word as a property name": "var o = {}; o.native = 1; var p = { class: 1 };",
  "String#indexOf, which ES3 has": "'abc'.indexOf('b');",
  "a chained ternary is jsx-ternary.mjs's job, not this one's": "var x = a ? 1 : (b ? 2 : 3);",
};
for (const [what, code] of Object.entries(allowed)) {
  check(`allows ${what}`, () => {
    assert.deepEqual(extendScriptProblems(code), []);
  });
}

check("deterministic: the same source gives the same answer", () => {
  const code = "var int = 1; [1].map(function(){}); let a;";
  assert.deepEqual(extendScriptProblems(code), extendScriptProblems(code));
});

console.log(`extendscript-syntax: ${passed} checks passed`);
