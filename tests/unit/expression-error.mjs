// Property.expressionError, out of packages/jsx/expressions.jsx (issue #97).
//
// Assigning `.expression` succeeds whatever the text says. After Effects
// reports a broken expression on `Property.expressionError` — the text of the
// warning banner in its UI — and nowhere else a script can see, so until this
// existed set_expression returned ok for an expression that did nothing, and
// the agent moved on. The skill recommends expressions over dense keyframes,
// which made this the gap between the advice and what could be verified.
//
// What this locks in:
//   - set_expression throws when AE reports an error, naming the property
//     path and AE's message, and saying the expression was written.
//   - The check forces an evaluation first. AE may only fill the field in
//     once the property is evaluated, so the mock has a mode that hides the
//     error until `.value` is read — a guard that only read the field would
//     pass that mock and ship the bug it exists to catch.
//   - get_expression carries expressionError; toggle_expression checks when
//     enabling and not when disabling; clear_expression is untouched.
//   - Nothing about the check can itself fail: a property with no value (a
//     group) and an AE with no such field both read as "no error".
//
// What it cannot prove is whether AE 26.3 populates the field without the
// nudge; the recipe in CLAUDE.md measures that.
//
//   node tests/unit/expression-error.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
// ids.jsx for the real walkProperty; the two lookups it declares are replaced
// below because the mock project is not AE's.
const sources = [["ids.jsx", read("ids.jsx")], ["expressions.jsx", read("expressions.jsx")]];

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`expression-error FAILED: ${name}`);
    throw e;
  }
  passed++;
}
// Results are built inside the VM realm, whose Object.prototype is not this
// one's, and deepStrictEqual compares prototypes. Compare the JSON instead —
// which is also all the panel ever forwards.
const plain = (v) => JSON.parse(JSON.stringify(v));
const same = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);

const AE_MESSAGE = "Error at line 1 in property 'Position' of layer 1 ('Hero') in comp 'Intro'. undefined value used in expression (could be an out of range array subscript?)";

// ---------------------------------------------------------------------------
// The mock property
// ---------------------------------------------------------------------------

// `mode`:
//   clean  — never reports an error
//   eager  — reports it the moment the expression is assigned
//   lazy   — reports it only once `.value` has been read after the assignment
//   absent — an AE with no expressionError field at all
class MockProp {
  constructor(mode, opts = {}) {
    this.mode = mode;
    this.brokenText = opts.brokenText ?? "wiggle(";
    this.disablesOnError = !!opts.disablesOnError;
    this.groupOnly = !!opts.groupOnly;
    this._expression = opts.expression ?? "";
    this._enabled = opts.enabled ?? false;
    this._evaluated = false;
    this.valueReads = 0;
  }
  get expression() { return this._expression; }
  set expression(text) { this._expression = text; this._evaluated = false; }
  get expressionEnabled() {
    if (this.disablesOnError && this._enabled && this.broken && this._evaluatedOrEager) return false;
    return this._enabled;
  }
  set expressionEnabled(v) { this._enabled = v; this._evaluated = false; }
  get broken() { return this._enabled && this._expression === this.brokenText; }
  get _evaluatedOrEager() { return this.mode === "eager" || this._evaluated; }
  get value() {
    this.valueReads++;
    if (this.groupOnly) throw new Error("Unable to get value: property is a group");
    this._evaluated = true;
    return [960, 540];
  }
  get expressionError() {
    if (this.mode === "absent") return undefined;
    if (this.mode === "clean") return "";
    if (!this.broken) return "";
    if (this.mode === "eager") return AE_MESSAGE;
    if (this.mode === "lazy") return this._evaluated ? AE_MESSAGE : "";
    throw new Error(`mode ${this.mode}`);
  }
}

function scene(prop) {
  const layer = {
    id: 7,
    property(n) {
      if (n === "Transform") return { property(p) { if (p === "Position") return prop; return null; } };
      return null;
    },
  };
  const comp = { id: 100, numLayers: 1, layer: () => layer };
  const ctx = { OPS: {}, noUndo: (fn) => fn, Error, String, Math };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  ctx.getCompById = (id) => { assert.equal(id, 100); return comp; };
  ctx.getLayerById = (c, id) => { assert.equal(id, 7); return layer; };
  const args = (extra) => ({ compId: 100, layerId: 7, propertyPath: ["Transform", "Position"], ...extra });
  return { prop, ops: ctx.OPS, args };
}

// ---------------------------------------------------------------------------
// set_expression
// ---------------------------------------------------------------------------

check("a clean expression is written, enabled and reported ok as before", () => {
  const { prop, ops, args } = scene(new MockProp("clean"));
  const out = ops.set_expression(args({ expression: "wiggle(2, 30)" }));
  same(out, { ok: true });
  assert.equal(prop.expression, "wiggle(2, 30)");
  assert.equal(prop.expressionEnabled, true);
});

check("an error AE reports immediately is thrown with path, message and both ways forward", () => {
  const { prop, ops, args } = scene(new MockProp("eager"));
  assert.throws(
    () => ops.set_expression(args({ expression: "wiggle(" })),
    (e) => {
      assert.match(e.message, /^Expression on Transform > Position was written but After Effects cannot evaluate it: /);
      assert.ok(e.message.includes(AE_MESSAGE), "AE's own text is carried verbatim");
      assert.match(e.message, /call set_expression again/);
      assert.match(e.message, /clear_expression to remove it/);
      return true;
    },
  );
  assert.equal(prop.expression, "wiggle(", "the expression stays written — the message says so");
  assert.equal(prop.expressionEnabled, true);
});

check("an error AE reports only after evaluation is still thrown — the value read is the nudge", () => {
  const prop = new MockProp("lazy");
  // The control: this mock does hide the error from a bare field read.
  prop.expression = "wiggle(";
  prop.expressionEnabled = true;
  assert.equal(prop.expressionError, "", "the mock must hide the error until evaluated, or this test proves nothing");
  const { ops, args } = scene(new MockProp("lazy"));
  assert.throws(() => ops.set_expression(args({ expression: "wiggle(" })), /cannot evaluate it/);
});

check("the nudge is exactly one value read, taken before the field is read", () => {
  const prop = new MockProp("lazy");
  const { ops, args } = scene(prop);
  assert.throws(() => ops.set_expression(args({ expression: "wiggle(" })));
  assert.equal(prop.valueReads, 1);
});

check("when AE disables the expression on error, the message says so", () => {
  const { ops, args } = scene(new MockProp("eager", { disablesOnError: true }));
  assert.throws(
    () => ops.set_expression(args({ expression: "wiggle(" })),
    /\(After Effects has disabled it\.\)/,
  );
  const { ops: ops2, args: args2 } = scene(new MockProp("eager"));
  assert.throws(
    () => ops2.set_expression(args2({ expression: "wiggle(" })),
    (e) => { assert.doesNotMatch(e.message, /disabled/); return true; },
  );
});

check("a property whose value cannot be read is not an expression error", () => {
  // A group throws on .value; the nudge is in a try and the answer is clean.
  const { ops, args } = scene(new MockProp("clean", { groupOnly: true }));
  same(ops.set_expression(args({ expression: "x" })), { ok: true });
});

check("an AE with no expressionError field reads as no error, not as a crash", () => {
  const { ops, args } = scene(new MockProp("absent"));
  same(ops.set_expression(args({ expression: "wiggle(" })), { ok: true });
});

check("the path label handles numeric segments", () => {
  const prop = new MockProp("eager");
  // Three segments, so three .property() hops before the leaf.
  const layer = { id: 7, property: () => ({ property: () => ({ property: () => prop }) }) };
  const ctx = { OPS: {}, noUndo: (fn) => fn, Error, String, Math };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  ctx.getCompById = () => ({});
  ctx.getLayerById = () => layer;
  assert.throws(
    () => ctx.OPS.set_expression({ compId: 1, layerId: 7, propertyPath: ["Effects", 2, "Slider"], expression: "wiggle(" }),
    /Expression on Effects > 2 > Slider was written/,
  );
});

// ---------------------------------------------------------------------------
// get_expression
// ---------------------------------------------------------------------------

check("get_expression carries expressionError: empty when clean", () => {
  const { ops, args } = scene(new MockProp("clean", { expression: "time*10", enabled: true }));
  same(ops.get_expression(args()), { expression: "time*10", enabled: true, expressionError: "" });
});

check("get_expression carries AE's message, forcing the evaluation the same way", () => {
  const prop = new MockProp("lazy", { expression: "wiggle(", enabled: true });
  const { ops, args } = scene(prop);
  const out = ops.get_expression(args());
  assert.equal(out.expression, "wiggle(");
  assert.equal(out.enabled, true);
  assert.equal(out.expressionError, AE_MESSAGE);
  assert.equal(prop.valueReads, 1);
});

check("get_expression on a property with no expression is what it always was, plus the empty field", () => {
  const { ops, args } = scene(new MockProp("absent"));
  same(ops.get_expression(args()), { expression: "", enabled: false, expressionError: "" });
});

// ---------------------------------------------------------------------------
// toggle_expression
// ---------------------------------------------------------------------------

check("enabling a broken expression throws, worded for the enable", () => {
  const { prop, ops, args } = scene(new MockProp("lazy", { expression: "wiggle(", enabled: false }));
  assert.throws(
    () => ops.toggle_expression(args({ enabled: true })),
    /Expression on Transform > Position was enabled but After Effects cannot evaluate it/,
  );
  assert.equal(prop.expressionEnabled, true, "the enable itself stands; the caller was told");
});

check("disabling never evaluates and never throws, broken or not", () => {
  const prop = new MockProp("eager", { expression: "wiggle(", enabled: true });
  const { ops, args } = scene(prop);
  same(ops.toggle_expression(args({ enabled: false })), { ok: true });
  assert.equal(prop.expressionEnabled, false);
  assert.equal(prop.valueReads, 0);
});

check("enabling a clean expression is ok", () => {
  const { prop, ops, args } = scene(new MockProp("clean", { expression: "time", enabled: false }));
  same(ops.toggle_expression(args({ enabled: true })), { ok: true });
  assert.equal(prop.expressionEnabled, true);
});

// ---------------------------------------------------------------------------
// clear_expression is untouched
// ---------------------------------------------------------------------------

check("clear_expression removes the text and does not evaluate", () => {
  const prop = new MockProp("eager", { expression: "wiggle(", enabled: true });
  const { ops, args } = scene(prop);
  same(ops.clear_expression(args()), { ok: true });
  assert.equal(prop.expression, "");
  assert.equal(prop.valueReads, 0);
});

// ---------------------------------------------------------------------------
// The descriptions say it
// ---------------------------------------------------------------------------

const serverDist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { descriptions } = await import(serverDist("tools", "descriptions.js"));

check("the tool descriptions name expressionError and the throw", () => {
  assert.match(descriptions.get_expression, /expressionError/);
  assert.match(descriptions.set_expression, /THROWS|throws/);
  assert.match(descriptions.set_expression, /clear_expression/);
  assert.match(descriptions.toggle_expression, /throws/);
});

console.log(`expression-error: ${passed} checks passed`);
process.exit(0);
