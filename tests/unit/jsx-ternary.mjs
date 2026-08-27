// Bans unparenthesised chained conditionals in packages/jsx/*.jsx.
//
// After Effects' ExtendScript build parses `a ? x : b ? y : z`
// LEFT-associatively, not right-associatively like every other JavaScript
// engine. The first branch's result becomes the next condition, so a truthy
// value falls straight through to the last alternative. That is not a style
// preference — it silently returns the wrong answer, and it shipped:
// get_project_summary labelled every item in the project "folder" for two
// releases (issues #21/#22) off one line of otherwise ordinary JavaScript.
//
// There is no offline ExtendScript runtime, so nothing else in this repo can
// catch it. This scans the sources instead: at most one `?` per expression per
// parenthesis depth. Nesting inside brackets is fine — `a ? x : (b ? y : z)`
// parses identically everywhere — so parenthesising is a legal fix, and
// if/else is the preferred one.
//
//   node tests/unit/jsx-ternary.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");

// Blanks out string literals and comments so their contents cannot be mistaken
// for code, keeping newlines so reported line numbers stay true. ExtendScript
// here is ES3-ish and the sources carry no regex literals, so `/` is only ever
// division or the start of a comment.
function stripLiterals(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  "; i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += " "; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " "; i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Returns the 1-based line numbers carrying a chained conditional.
export function findChainedTernaries(src) {
  const code = stripLiterals(src);
  const hits = [];
  const seen = [0];           // count of `?` at each open bracket depth
  let depth = 0;
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") { line++; continue; }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      seen[depth] = 0;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
      continue;
    }
    // A comma or semicolon at this depth ends the expression the `?` belonged
    // to, so two ternaries in one argument list or object literal are fine.
    if (c === "," || c === ";") { seen[depth] = 0; continue; }
    if (c === "?") {
      seen[depth]++;
      if (seen[depth] > 1) hits.push(line);
    }
  }
  return hits;
}

// --- self-test: a guard nobody trusts gets deleted -------------------------
const mustFlag = [
  'var t = a ? "comp" : b ? "footage" : "folder";',        // the shipped bug
  "x = p ? 1 : q ? 2 : r ? 3 : 4;",
  "return cond ?\n  one :\n  other ? two : three;",         // spread over lines
  "f(a ? b ? 1 : 2 : 3);",                                  // nested in the then-branch
];
const mustPass = [
  'var t = a ? "comp" : (b ? "footage" : "folder");',       // the legal fix
  "var x = a ? 1 : 2;",
  "f(a ? 1 : 2, b ? 3 : 4);",                               // separate arguments
  "var x = a ? 1 : 2; var y = b ? 3 : 4;",                  // separate statements
  "var o = { a: x ? 1 : 2, b: y ? 3 : 4 };",                // separate object values
  'var s = "a ? b : c ? d : e";',                           // inside a string
  "// a ? b : c ? d : e",                                   // inside a comment
  "/* a ? b : c ? d : e */",
  "var f = a ? function () { return b ? 1 : 2; } : null;",  // nested in a function body
];

let passed = 0;
for (const s of mustFlag) {
  assert.ok(findChainedTernaries(s).length > 0, `should have been flagged: ${s}`);
  passed++;
}
for (const s of mustPass) {
  assert.deepEqual(findChainedTernaries(s), [], `false positive on: ${s}`);
  passed++;
}

// --- the sources -----------------------------------------------------------
const files = fs.readdirSync(jsxDir).filter((f) => f.endsWith(".jsx")).sort();
assert.ok(files.length > 0, `no .jsx sources found in ${jsxDir}`);

const offences = [];
for (const f of files) {
  const full = path.join(jsxDir, f);
  const lines = fs.readFileSync(full, "utf8").split("\n");
  for (const n of findChainedTernaries(lines.join("\n"))) {
    offences.push(`  packages/jsx/${f}:${n}\n    ${(lines[n - 1] || "").trim()}`);
  }
  passed++;
}

if (offences.length > 0) {
  console.error(
    "Chained conditional in ExtendScript:\n\n" +
      offences.join("\n") +
      "\n\nAfter Effects' ExtendScript parses `a ? x : b ? y : z` left-associatively,\n" +
      "so the first branch's value becomes the next condition and everything falls\n" +
      "through to the last alternative. It does not throw — it returns the wrong\n" +
      "answer. get_project_summary reported every project item as \"folder\" for two\n" +
      "releases because of exactly this (issues #21/#22).\n\n" +
      "Rewrite as an if/else chain. Parentheses also parse correctly, but if/else\n" +
      "cannot be un-parenthesised by a later edit.\n",
  );
  process.exit(1);
}

console.log(`jsx-ternary: ${passed} assertions passed across ${files.length} sources`);
