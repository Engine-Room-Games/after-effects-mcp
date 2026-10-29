// The effect-parameter cap, out of packages/jsx/effects.jsx (issue #115).
//
// __serializeEffect used to write every parameter of every effect. Trapcode
// Particular exposes 7,401 of them, and one list_effects on a layer carrying
// it came back at 1 MB — ~265k tokens, re-sent on every later request, and on
// a client with no oversized-result guard the end of the session.
//
// What this locks in:
//   - Bounded by DEFAULT. list_effects, get_layer_full's effects section and
//     add_effect's return all stop at 200 parameters per effect when maxParams
//     is absent — a deliberate exception to "absent means everything", like
//     find_layers. An ordinary effect is untouched by it.
//   - Never silent: every effect carries paramCount, and a capped one carries
//     paramsOmitted plus a paramsTruncated sentence that names the remedy.
//   - maxParams raises the cap; paramFilter (case-insensitive regex over name
//     and matchName) narrows it, with paramsMatched exact even past the cap.
//   - The default is one number: the schema's EFFECT_PARAMS_DEFAULT and the
//     panel's __EFFECT_PARAMS_DEFAULT must agree, and the descriptions say it.
//
//   node tests/unit/effect-params.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`effect-params FAILED: ${name}`);
    throw e;
  }
  passed++;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// A stub layer carrying a small built-in effect and a Particular-sized one.
// ---------------------------------------------------------------------------

const ctx = { OPS: {}, noUndo: (fn) => fn, Math, Error, RegExp, String };
vm.createContext(ctx);
for (const f of ["comps.jsx", "layers.jsx", "effects.jsx", "explore.jsx"]) {
  vm.runInContext(read(f), ctx, { filename: f });
}
vm.runInContext(
  `
  function CompItem() {}
  function FootageItem() {}
  function TextLayer() {}
  function ShapeLayer() {}
  function CameraLayer() {}
  function LightLayer() {}
  function AVLayer() {}

  function mkParam(name, matchName, value, keys) {
    return {
      name: name, matchName: matchName, propertyType: "PropertyType.PROPERTY",
      value: value, canSetExpression: true, expression: "",
      numKeys: keys ? keys.length : 0,
      keyTime: function (k) { return keys[k - 1]; },
      keyValue: function (k) { return k; }
    };
  }
  function mkEffect(name, matchName, params, index) {
    return {
      name: name, matchName: matchName, enabled: true, propertyIndex: index,
      numProperties: params.length,
      property: function (i) { return params[i - 1]; }
    };
  }

  var blurParams = [
    mkParam("Blurriness", "ADBE Gaussian Blur 2-0001", 10, [0, 1, 2]),
    mkParam("Blur Dimensions", "ADBE Gaussian Blur 2-0002", 1),
    mkParam("Repeat Edge Pixels", "ADBE Gaussian Blur 2-0003", 0)
  ];
  var particleParams = [];
  for (var n = 1; n <= 7401; n++) {
    var label = n === 5000 ? "Velocity" : (n === 6000 ? "Emitter Type" : "Param " + n);
    particleParams.push(mkParam(label, "tc Particular-" + n, n));
  }
  var effects = [
    mkEffect("Gaussian Blur", "ADBE Gaussian Blur 2", blurParams, 1),
    mkEffect("Particular", "tc Particular", particleParams, 2)
  ];
  var effectsGroup = {
    numProperties: effects.length,
    property: function (i) { return effects[i - 1]; },
    addProperty: function (mn) { return effects[1]; }
  };
  var theLayer = {
    id: 7, index: 1, name: "Particles", enabled: true, solo: false, locked: false,
    shy: false, threeDLayer: false, label: 0, inPoint: 0, outPoint: 5, startTime: 0,
    stretch: 100, blendingMode: "BlendingMode.NORMAL", preserveTransparency: false,
    parent: null,
    // Every other group is present and empty, so a read with include absent
    // walks them all without tripping.
    property: function (n) {
      return n === "Effects" ? effectsGroup : { numProperties: 0, numKeys: 0, property: function () { return null; } };
    }
  };
  var theComp = { id: 3, time: 0 };
  function getCompById(id) { return theComp; }
  function getLayerById(c, id) { return theLayer; }
  `,
  ctx,
);
const OPS = ctx.OPS;
const call = (op, args) => plain(OPS[op]({ compId: 3, layerId: 7, ...args }));

// ---------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------

check("list_effects caps Particular at the default and says so", () => {
  const [blur, part] = call("list_effects", {});
  assert.equal(part.paramCount, 7401);
  assert.equal(part.params.length, 200);
  assert.equal(part.paramsOmitted, 7201);
  assert.match(part.paramsTruncated, /first 200 of 7401/);
  assert.match(part.paramsTruncated, /maxParams/);
  assert.match(part.paramsTruncated, /paramFilter/);
  assert.equal(part.params[0].name, "Param 1", "the cap keeps the leading parameters, in order");
  // The ordinary effect is untouched.
  assert.equal(blur.paramCount, 3);
  assert.equal(blur.params.length, 3);
  assert.equal(blur.paramsOmitted, undefined, "an uncapped effect carries no omission fields");
  assert.equal(blur.paramsTruncated, undefined);
  assert.equal(blur.params[0].keyframes.length, 3);
});

check("the capped response is a few percent of the uncapped one", () => {
  const capped = JSON.stringify(call("list_effects", {})).length;
  const full = JSON.stringify(call("list_effects", { maxParams: 10000 })).length;
  assert.ok(capped * 20 < full, `capped ${capped} chars vs full ${full}`);
});

check("get_layer_full's effects section applies the same default", () => {
  const out = call("get_layer_full", { include: ["effects"] });
  assert.equal(out.effects[1].params.length, 200);
  assert.equal(out.effects[1].paramsOmitted, 7201);
});

check("get_layer_full with include absent caps effects too", () => {
  const out = call("get_layer_full", {});
  assert.equal(out.effects[1].paramsOmitted, 7201);
});

check("add_effect returns the new effect under the default cap", () => {
  const eff = plain(OPS.add_effect({ compId: 3, layerId: 7, matchName: "tc Particular" }));
  assert.equal(eff.params.length, 200);
  assert.equal(eff.paramsOmitted, 7201);
});

// ---------------------------------------------------------------------------
// The knobs
// ---------------------------------------------------------------------------

check("maxParams raises the cap, and a cap at or above the count omits nothing", () => {
  const part = call("list_effects", { maxParams: 7401 })[1];
  assert.equal(part.params.length, 7401);
  assert.equal(part.paramsOmitted, undefined);
  const small = call("list_effects", { maxParams: 2 })[0];
  assert.equal(small.params.length, 2);
  assert.equal(small.paramsOmitted, 1);
});

check("maxParams and paramFilter reach get_layer_full", () => {
  const out = call("get_layer_full", { include: ["effects"], maxParams: 5, paramFilter: "velocity" });
  assert.equal(out.effects[0].params.length, 0);
  assert.deepEqual(out.effects[1].params.map((p) => p.name), ["Velocity"]);
});

check("paramFilter matches name or matchName, case-insensitively, and counts matches", () => {
  const [blur, part] = call("list_effects", { paramFilter: "VELOCITY|emitter" });
  assert.deepEqual(part.params.map((p) => p.name), ["Velocity", "Emitter Type"]);
  assert.equal(part.paramsMatched, 2);
  assert.equal(part.paramsOmitted, 7399);
  assert.match(part.paramsTruncated, /matched 2 of 7401/);
  assert.equal(blur.params.length, 0);
  assert.equal(blur.paramsMatched, 0);
  const byMatch = call("list_effects", { paramFilter: "Blur 2-0002$" })[0];
  assert.deepEqual(byMatch.params.map((p) => p.name), ["Blur Dimensions"]);
});

check("paramFilter past the cap still counts every match", () => {
  const part = call("list_effects", { paramFilter: "^Param 1", maxParams: 10 })[1];
  assert.equal(part.params.length, 10);
  assert.equal(part.paramsMatched, 1111); // Param 1, 10-19, 100-199, 1000-1999
  assert.match(part.paramsTruncated, /1101 more matches omitted/);
});

check("an invalid paramFilter is an error, not an empty answer", () => {
  assert.throws(() => call("list_effects", { paramFilter: "(" }), /paramFilter is not a valid regular expression/);
});

// ---------------------------------------------------------------------------
// One default, stated where the agent reads it
// ---------------------------------------------------------------------------

const sharedDist = pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href;
const serverDist = pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "descriptions.js")).href;
const { EFFECT_PARAMS_DEFAULT, OpSchemas } = await import(sharedDist);
const { descriptions } = await import(serverDist);

check("schema default and panel default agree", () => {
  assert.equal(ctx.__EFFECT_PARAMS_DEFAULT, EFFECT_PARAMS_DEFAULT);
});

check("list_effects and get_layer_full accept maxParams and paramFilter", () => {
  for (const op of ["list_effects", "get_layer_full"]) {
    const ok = OpSchemas[op].safeParse({ compId: 1, layerId: 2, maxParams: 50, paramFilter: "x" });
    assert.ok(ok.success, op);
    assert.equal(OpSchemas[op].safeParse({ compId: 1, layerId: 2, maxParams: 0 }).success, false, op);
  }
});

check("the descriptions state the default cap", () => {
  for (const op of ["list_effects", "get_layer_full", "add_effect"]) {
    assert.ok(descriptions[op].includes(String(EFFECT_PARAMS_DEFAULT)), op);
    assert.ok(descriptions[op].includes("paramsOmitted"), op);
  }
});

console.log(`effect-params: ${passed} checks passed`);
