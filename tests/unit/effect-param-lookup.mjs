// set_effect_param's parameter lookup, out of packages/jsx/effects.jsx (issue #121).
//
// `Property.property(name)` matches only the display name in After Effects' UI
// language, so on a zh_CN install an English 'Distance' answers null while
// 'ADBE Drop Shadow-0004' resolves. The op used to throw a bare "Effect param
// not found", which reads as though the parameter does not exist.
//
// What this locks in:
//   - paramMatchName resolves regardless of language, and wins over paramName.
//   - paramName still resolves the localised display name, and forgives case.
//   - A miss names the effect, lists name = matchName for its parameters,
//     caps that list on a huge effect and says how many were left out,
//     mentions app.isoLanguage when it is not en_US, and recommends
//     paramMatchName.
//   - Nothing is written on a miss.
//   - An out-of-range effectIndex is named, for set_effect_param,
//     remove_effect and set_effect_enabled alike, instead of a TypeError.
//
//   node tests/unit/effect-param-lookup.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(root, "packages", "jsx", "effects.jsx"), "utf8");
// set_effect_param writes through __setValue (#129), which lives in values.jsx.
const values = fs.readFileSync(path.join(root, "packages", "jsx", "values.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`effect-param-lookup FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// A mock of AE's display-name lookup: property(string) matches the localised
// name or the matchName, never the English name of a localised parameter.
class Param {
  constructor(name, matchName) {
    this.name = name;
    this.matchName = matchName;
    this.numKeys = 0;
    this.writes = [];
  }
  setValue(v) { this.writes.push(["setValue", v]); }
  setValueAtTime(t, v) { this.writes.push(["setValueAtTime", t, v]); }
}
class Group {
  constructor(name, matchName, children) {
    this.name = name;
    this.matchName = matchName;
    this.children = children;
    this.enabled = true;
    this.removed = false;
  }
  get numProperties() { return this.children.length; }
  property(k) {
    if (typeof k === "number") return this.children[k - 1] ?? null;
    return this.children.find((c) => c.name === k || c.matchName === k) ?? null;
  }
  remove() { this.removed = true; }
}

function makeEnv({ lang = "zh_CN", params } = {}) {
  const shadow = new Group("投影", "ADBE Drop Shadow", params ?? [
    new Param("阴影颜色", "ADBE Drop Shadow-0001"),
    new Param("不透明度", "ADBE Drop Shadow-0002"),
    new Param("方向", "ADBE Drop Shadow-0003"),
    new Param("距离", "ADBE Drop Shadow-0004"),
    new Param("柔和度", "ADBE Drop Shadow-0005"),
  ]);
  const parade = new Group("效果", "ADBE Effect Parade", [shadow]);
  const layer = { name: "Hero", property: (k) => (k === "ADBE Effect Parade" ? parade : null) };
  const ctx = {
    OPS: {},
    noUndo: (fn) => fn,
    getCompById: () => ({}),
    getLayerById: () => layer,
    app: lang === undefined ? {} : { isoLanguage: lang },
  };
  vm.createContext(ctx);
  vm.runInContext(values, ctx, { filename: "values.jsx" });
  vm.runInContext(src, ctx, { filename: "effects.jsx" });
  return { ctx, shadow, parade };
}

const base = { compId: 1, layerId: 1, effectIndex: 1, value: 12 };
const errOf = (fn) => {
  try { fn(); } catch (e) { return String(e.message); }
  assert.fail("expected a throw");
};

check("paramMatchName resolves on a localised AE", () => {
  const { ctx, shadow } = makeEnv();
  ctx.OPS.set_effect_param({ ...base, paramMatchName: "ADBE Drop Shadow-0004" });
  assert.deepEqual(shadow.children[3].writes, [["setValue", 12]]);
});

check("paramMatchName wins over paramName", () => {
  const { ctx, shadow } = makeEnv();
  ctx.OPS.set_effect_param({ ...base, paramMatchName: "ADBE Drop Shadow-0004", paramName: "不透明度" });
  assert.equal(shadow.children[3].writes.length, 1);
  assert.equal(shadow.children[1].writes.length, 0);
});

check("paramName resolves the localised display name", () => {
  const { ctx, shadow } = makeEnv();
  ctx.OPS.set_effect_param({ ...base, paramName: "距离" });
  assert.equal(shadow.children[3].writes.length, 1);
});

check("paramName forgives case", () => {
  const { ctx, shadow } = makeEnv({
    lang: "en_US",
    params: [new Param("Distance", "ADBE Drop Shadow-0004")],
  });
  ctx.OPS.set_effect_param({ ...base, paramName: "distance" });
  assert.equal(shadow.children[0].writes.length, 1);
});

check("an English paramName on zh_CN fails with a useful error", () => {
  const { ctx, shadow } = makeEnv();
  const msg = errOf(() => ctx.OPS.set_effect_param({ ...base, paramName: "Distance" }));
  assert.match(msg, /'投影' \(ADBE Drop Shadow\)/);
  assert.match(msg, /paramName 'Distance'/);
  assert.match(msg, /'距离' = ADBE Drop Shadow-0004/);
  assert.match(msg, /zh_CN/);
  assert.match(msg, /paramMatchName/);
  assert.doesNotMatch(msg, /more not listed/);
  for (const p of shadow.children) assert.equal(p.writes.length, 0, "nothing written on a miss");
});

check("en_US does not blame the language, still recommends paramMatchName", () => {
  const { ctx } = makeEnv({ lang: "en_US", params: [new Param("Distance", "ADBE Drop Shadow-0004")] });
  const msg = errOf(() => ctx.OPS.set_effect_param({ ...base, paramName: "Distnce" }));
  assert.doesNotMatch(msg, /en_US/);
  assert.match(msg, /paramMatchName/);
  assert.match(msg, /'Distance' = ADBE Drop Shadow-0004/);
});

check("a missing app.isoLanguage is not itself a failure", () => {
  const { ctx } = makeEnv({ lang: undefined });
  const msg = errOf(() => ctx.OPS.set_effect_param({ ...base, paramName: "Distance" }));
  assert.match(msg, /paramMatchName/);
});

check("a wrong paramMatchName alone is named, without the language advice", () => {
  const { ctx } = makeEnv();
  const msg = errOf(() => ctx.OPS.set_effect_param({ ...base, paramMatchName: "ADBE Drop Shadow-0099" }));
  assert.match(msg, /paramMatchName 'ADBE Drop Shadow-0099'/);
  assert.match(msg, /ADBE Drop Shadow-0004/);
  assert.doesNotMatch(msg, /UI language/);
});

check("a huge effect's parameter list is capped and the remainder counted", () => {
  const params = [];
  for (let i = 1; i <= 3000; i++) params.push(new Param(`P${i}`, `TC Particular-${i}`));
  const { ctx } = makeEnv({ params });
  const msg = errOf(() => ctx.OPS.set_effect_param({ ...base, paramName: "Emitter" }));
  assert.match(msg, /'P40' = TC Particular-40/);
  assert.doesNotMatch(msg, /'P41'/);
  assert.match(msg, /2960 more not listed/);
  assert.ok(msg.length < 4000, `message is ${msg.length} chars`);
});

check("an out-of-range effectIndex is named on every effect op", () => {
  for (const op of ["set_effect_param", "remove_effect", "set_effect_enabled"]) {
    const { ctx } = makeEnv();
    const msg = errOf(() => ctx.OPS[op]({ ...base, effectIndex: 4, paramName: "距离", enabled: false }));
    assert.match(msg, /No effect at effectIndex 4 on layer 'Hero': it has 1 effect\./, op);
  }
});

check("remove_effect and set_effect_enabled still work in range", () => {
  const { ctx, shadow } = makeEnv();
  ctx.OPS.set_effect_enabled({ ...base, enabled: false });
  assert.equal(shadow.enabled, false);
  ctx.OPS.remove_effect({ ...base });
  assert.equal(shadow.removed, true);
});

console.log(`effect-param-lookup: ${passed} checks passed`);
