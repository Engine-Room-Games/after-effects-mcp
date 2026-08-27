// run_jsx's result serialization, run out of packages/jsx/raw.jsx.
//
// The old coercion kept only scalar top-level properties, so a script returning
// {done: [...], skipped: [...]} came back as {} — which reads as "the script did
// nothing" while its mutations had already landed, and invites re-running a
// mutating script (issue #31). The rule this locks in: nothing is ever dropped.
// A value that cannot be represented is replaced in place by a short marker, so
// an empty result means the script really returned nothing.
//
// The walk is opt-in, and that matters: a live AE Layer or Property has a huge,
// partly throwing property graph, and walking one would hang or explode. Only
// arrays and plain objects are recursed into.
//
//   node tests/unit/run-jsx-result.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "raw.jsx"), "utf8");

// raw.jsx assumes core.jsx has already run: OPS and noUndoWhen exist. Give it
// those and nothing else, then reach in for the serializer.
// Nothing else goes in: the VM gets its own Object/Array intrinsics, and
// injecting this realm's would break the plain-object check the way a second
// realm would. ExtendScript only ever has one.
const ctx = { OPS: {}, noUndoWhen: (_pred, fn) => fn };
vm.createContext(ctx);
vm.runInContext(source, ctx, { filename: "raw.jsx" });

// Everything under test has to build its values inside the VM realm, or
// `instanceof Array` and `constructor === Object` compare across realms.
const make = (expr) => vm.runInContext(`(${expr})`, ctx);
const ser = (v) => vm.runInContext("__rjResult", ctx)(v);
const wrap = vm.runInContext("(function (k, v) { var o = {}; o[k] = v; return o; })", ctx);

let passed = 0;
// Compared through JSON, which is both what the panel does with the result and
// the only way to compare values built in the other realm.
function check(name, value, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(ser(value))), expected, name);
  passed++;
}

// The reported case, verbatim.
check(
  "arrays and nested objects survive",
  make('({arr: [1,2,3], nested: {a: 1}, s: "x"})'),
  { arr: [1, 2, 3], nested: { a: 1 }, s: "x" },
);
check(
  "the report shape that came back empty",
  make('({done: ["a","b"], skipped: [], errors: [{op: "set", why: "locked"}]})'),
  { done: ["a", "b"], skipped: [], errors: [{ op: "set", why: "locked" }] },
);

// Scalars and the top level.
check("a bare number", 42, 42);
check("a bare string", "hi", "hi");
check("a bare array", make("[1, [2, [3]]]"), [1, [2, [3]]]);
check("no return at all", undefined, null);
check("an explicit null", null, null);

// Values JSON cannot hold become markers rather than disappearing.
check("undefined inside an object", make("({a: 1, b: undefined})"), { a: 1, b: "[undefined]" });
check("undefined inside an array", make("[1, undefined, 3]"), [1, "[undefined]", 3]);
check("a function", make("({f: function () {}})"), { f: "[function]" });
check("a top-level function", make("(function () {})"), "[function]");
check("NaN and infinities", make("[NaN, Infinity, -Infinity]"), ["[NaN]", "[Infinity]", "[-Infinity]"]);

// Cycles must terminate, and a repeated reference that is not a cycle must not
// be mistaken for one.
check(
  "a cycle",
  make("(function () { var o = {name: 'root'}; o.self = o; return o; })()"),
  { name: "root", self: "[circular]" },
);
check(
  "a shared reference is not a cycle",
  make("(function () { var leaf = {v: 1}; return {a: leaf, b: leaf}; })()"),
  { a: { v: 1 }, b: { v: 1 } },
);
check(
  "a cycle through an array",
  make("(function () { var a = [1]; a.push(a); return a; })()"),
  [1, "[circular]"],
);

// Depth is capped, and the cap is visible.
{
  const deep = make("(function () { var o = {}; var c = o; for (var i = 0; i < 40; i++) { c.next = {}; c = c.next; } return o; })()");
  const out = ser(deep);
  let node = out, hops = 0;
  while (node && typeof node === "object") { node = node.next; hops++; }
  assert.equal(node, "[max depth]", "a very deep object must bottom out in a marker, not vanish");
  assert.ok(hops > 5 && hops < 40, `depth cap should bite partway down, stopped after ${hops}`);
  passed += 2;
}

// A live AE object stands in for anything with a hostile property graph: it is
// identified, not walked.
{
  const layer = vm.runInContext(
    `(function () {
       function AVLayer() {}
       var l = new AVLayer();
       l.name = "Hero";
       return l;
     })()`,
    ctx,
  );
  // reflect.name is what ExtendScript exposes for host classes; emulate it.
  Object.defineProperty(layer, "reflect", { value: { name: "AVLayer" }, enumerable: false });
  check("a live AE object", wrap("layer", layer), { layer: '[AVLayer "Hero"]' });

  const throwing = vm.runInContext(
    `(function () {
       function Property() {}
       var p = new Property();
       return p;
     })()`,
    ctx,
  );
  Object.defineProperty(throwing, "reflect", {
    get() { throw new Error("nope"); },
    enumerable: false,
  });
  const out = ser(wrap("p", throwing));
  assert.match(out.p, /^\[/, `an object whose metadata throws must still yield a marker, got ${out.p}`);
  passed++;
}

// A property that throws when read is reported where it sits.
{
  const hostile = make("({ok: 1})");
  Object.defineProperty(hostile, "boom", {
    get() { throw new Error("cannot read that here"); },
    enumerable: true,
  });
  const out = ser(hostile);
  assert.equal(out.ok, 1);
  assert.match(out.boom, /cannot read that here/, "a throwing getter must be reported, not swallowed");
  passed += 2;
}

// The whole point: the result must survive the panel's JSON.stringify.
{
  const messy = make("(function () { var o = {a: [1, {b: undefined}], f: function () {} }; o.cycle = o; return o; })()");
  const json = JSON.stringify(ser(messy));
  assert.deepEqual(
    JSON.parse(json),
    { a: [1, { b: "[undefined]" }], f: "[function]", cycle: "[circular]" },
    `did not survive the panel's JSON.stringify: ${json}`,
  );
  passed++;
}

console.log(`run-jsx-result: ${passed} assertions passed`);
