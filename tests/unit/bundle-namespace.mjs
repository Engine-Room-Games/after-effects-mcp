// The bundle shares After Effects' ExtendScript engine with everything else.
//
// Every CEP extension's evalScript, File > Scripts, ScriptUI panels and
// osascript's DoScript run in the same `main` engine (measured on 26.5, issue
// #185). With the bundle's ~19 bare globals, a ScriptUI panel's `OPS = {}` or
// an osascript `function dispatch(){}` failed every op, a File > Scripts
// `getCompById` hijacked get_comp, and our `ease`/`shape` replaced theirs.
//
// scripts/bundle-jsx.mjs now wraps the whole concatenation in one closure and
// publishes a single global, `__AEMCP`. This evaluates the real built bundle in
// a sandbox that plays the hostile neighbour in both directions:
//
//  * before the load — their `OPS`, `ease`, `shape`, `getCompById` must survive
//    it untouched, and the bundle must add no global but `__AEMCP`;
//  * after the load — replacing `dispatch`, `OPS`, `getCompById` and even the
//    engine's `JSON` must not change what an op runs, and run_jsx must still
//    see every documented helper.
//
//   node tests/unit/bundle-namespace.mjs [path/to/bundle.jsx]

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundlePath = process.argv[2] ?? path.join(root, "packages", "ae-panel", "jsx", "bundle.jsx");
if (!fs.existsSync(bundlePath)) {
  console.error(`bundle.jsx not built: ${bundlePath} — run \`npm run build:jsx\``);
  process.exit(1);
}
const bundle = fs.readFileSync(bundlePath, "utf8");

const ctx = vm.createContext({});
vm.runInContext(`
var $ = { global: this, os: "Macintosh", engineName: "main" };
function CompItem() {}
// The enums a few modules read at load time.
var KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
var ParagraphJustification = { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415,
  FULL_JUSTIFY_LASTLINE_LEFT: 7416, FULL_JUSTIFY_LASTLINE_RIGHT: 7417,
  FULL_JUSTIFY_LASTLINE_CENTER: 7418, FULL_JUSTIFY_LASTLINE_FULL: 7419 };
var __comp = new CompItem(); __comp.id = 5; __comp.name = "Main"; __comp.numLayers = 0;
var __undo = [];
var app = {
  version: "26.5",
  project: { itemByID: function (id) { return id === 5 ? __comp : null; } },
  beginUndoGroup: function (n) { __undo.push("+" + n); },
  endUndoGroup: function () { __undo.push("-"); }
};
`, ctx);

// The neighbour's globals, defined before our bundle loads.
vm.runInContext(`
var OPS = { list_comps: function () { return "theirs"; } };
function ease() { return "their ease"; }
var shape = "their shape";
function getCompById() { return "their getCompById"; }
`, ctx);
const theirOPS = ctx.OPS;
const before = new Set(Object.getOwnPropertyNames(ctx));

vm.runInContext(bundle, ctx, { filename: "bundle.jsx" });

const added = Object.getOwnPropertyNames(ctx).filter((k) => !before.has(k));
assert.deepEqual(added, ["__AEMCP"],
  `the bundle must publish exactly one global, __AEMCP; it added: ${added.join(", ")}`);
assert.equal(ctx.OPS, theirOPS, "the bundle replaced another script's global OPS");
assert.equal(vm.runInContext("ease()", ctx), "their ease", "the bundle replaced another script's ease()");
assert.equal(ctx.shape, "their shape", "the bundle replaced another script's shape");
assert.equal(vm.runInContext("getCompById()", ctx), "their getCompById",
  "the bundle replaced another script's getCompById()");
assert.equal(ctx.__AEMCP.id, "games.engine-room.ae-mcp");
assert.equal(typeof ctx.__AEMCP.call, "function");
assert.equal(ctx.__AEMCP.OPS, undefined, "the op table must not be reachable from outside the closure");

// Now the neighbour runs after us and replaces everything it can name.
vm.runInContext(`
dispatch = function () { throw new Error("hijacked dispatch"); };
OPS = {};
getCompById = function () { throw new Error("hijacked getCompById"); };
compById = function () { throw new Error("hijacked compById"); };
JSON = { stringify: function () { throw new Error("hijacked JSON"); },
         parse: function () { throw new Error("hijacked JSON"); } };
`, ctx);

// What the panel sends: a payload string in, a JSON string out.
function call(op, args) {
  const raw = ctx.__AEMCP.call(JSON.stringify({ op, args }));
  assert.equal(typeof raw, "string", `${op} did not answer a JSON string`);
  return JSON.parse(raw);
}

const unknown = call("no_such_op", {});
assert.equal(unknown.ok, false);
assert.match(unknown.error, /Unknown op: no_such_op/);

// run_jsx still sees its documented helpers — as closure locals, not globals —
// and they resolve to the bundle's own, not the hijacked globals.
const helpers = call("run_jsx", {
  code: "return { comp: compById(5).name, viaGet: getCompById(5).name, " +
    "types: [typeof layerById, typeof ease, typeof addKeys, typeof shape, typeof setValueChecked, " +
    "typeof walkProperty, typeof withoutUndoGroup, typeof OPS.run_jsx, typeof app] };",
});
assert.equal(helpers.ok, true, `run_jsx failed: ${helpers.error}`);
assert.equal(helpers.result.comp, "Main");
assert.equal(helpers.result.viaGet, "Main");
assert.deepEqual(helpers.result.types,
  ["function", "function", "function", "function", "function", "function", "function", "function", "object"]);

// A first-class op through the bundle's own getCompById.
const ok = call("run_jsx", { code: "return OPS.run_jsx({ code: 'return 1 + 1;' });" });
assert.equal(ok.ok, true, ok.error);
assert.equal(ok.result, 2);

// A script that defines a top-level function in run_jsx keeps it local, as before.
call("run_jsx", { code: "function mine() { return 1; } return mine();" });
assert.equal(ctx.mine, undefined, "a run_jsx declaration leaked into the shared engine");

// The panel's readiness probe answers through __AEMCP and nothing else.
const ready = vm.runInContext(
  "(typeof __AEMCP === 'object' && __AEMCP !== null && __AEMCP.id === 'games.engine-room.ae-mcp' && typeof __AEMCP.call === 'function')",
  ctx);
assert.equal(ready, true);

// Reloading restores a deleted namespace — what the panel's self-heal does.
vm.runInContext("__AEMCP = undefined;", ctx);
vm.runInContext(bundle, ctx, { filename: "bundle.jsx" });
assert.equal(call("run_jsx", { code: "return 'back';" }).result, "back");

console.log("bundle-namespace: ok — one global (__AEMCP), neighbours' globals untouched, hijacked globals ignored");
