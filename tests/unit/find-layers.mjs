// find_layers' `include` contract, out of packages/jsx/explore.jsx (issue #87).
//
// Every match used to come back as the full __layerSummary record — flags,
// timing, parent, the lot — with no way to bound it, where list_layers had
// taken `include` for a release. Nine name matches cost ~2k tokens, re-sent on
// every later request in the session.
//
// What this locks in:
//   - The default is the bounded form. A search is for learning which layers
//     exist and what to address them by, so absent `include` means the core
//     (id/index/name/sourceType) plus compId/compName, and nothing else. That
//     is the opposite of list_layers, where absent means everything, and the
//     difference is deliberate — the issue asked for it and the description
//     says so.
//   - `include: []` is the same answer as omitting it, and every section name
//     list_layers knows is honoured here through the same __layerSummary.
//   - The result echoes `included`, so a bounded answer is never read as a
//     full one.
//   - The filters still work on the bounded output — the section list must
//     not be able to hide a layer, only trim it.
//   - The schema side: list_layers and find_layers accept the same section
//     names, so the two cannot drift; and the description says the default.
//
//   node tests/unit/find-layers.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
// __layerSummary is in layers.jsx and __wantsSection in comps.jsx; explore.jsx
// holds the op. One scope, like the shipped bundle.
const sources = [
  ["comps.jsx", read("comps.jsx")],
  ["layers.jsx", read("layers.jsx")],
  ["explore.jsx", read("explore.jsx")],
];

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`find-layers FAILED: ${name}`);
    throw e;
  }
  passed++;
}
// Results are built inside the VM realm, whose Object.prototype is not this
// one's, and deepStrictEqual compares prototypes. Compare the JSON instead —
// which is also all the panel ever forwards.
const plain = (v) => JSON.parse(JSON.stringify(v));
const same = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);

// ---------------------------------------------------------------------------
// The mock project: classes live in the VM realm so instanceof works there
// ---------------------------------------------------------------------------

function loadOps() {
  const ctx = { OPS: {}, noUndo: (fn) => fn, Math, isFinite, Error, RegExp, String };
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FootageItem() {}
    function TextLayer() {}
    function ShapeLayer() {}
    function CameraLayer() {}
    function LightLayer() {}

    function mkLayer(kind, id, name, effects, parent) {
      var l;
      if (kind === "text") l = new TextLayer();
      else if (kind === "shape") l = new ShapeLayer();
      else l = {};
      if (kind === "null") l.nullLayer = true;
      l.id = id; l.name = name;
      l.enabled = true; l.solo = false; l.locked = false; l.shy = false;
      l.threeDLayer = false; l.label = 3; l.blendingMode = 5212;
      l.inPoint = 0.5; l.outPoint = 4; l.startTime = 0.5; l.stretch = 100;
      l.parent = parent || null;
      var fx = effects || [];
      l.property = function (n) {
        if (n !== "Effects") return null;
        return {
          numProperties: fx.length,
          property: function (i) { return { matchName: fx[i - 1] }; }
        };
      };
      return l;
    }

    function mkComp(id, name, layers) {
      var c = new CompItem();
      c.id = id; c.name = name;
      c.numLayers = layers.length;
      for (var i = 0; i < layers.length; i++) layers[i].index = i + 1;
      c.layer = function (i) { return layers[i - 1]; };
      return c;
    }

    var HERO = mkLayer("text", 11, "Hero Title", ["ADBE Gaussian Blur 2"]);
    var CARD = mkLayer("shape", 12, "Card", []);
    var NULLA = mkLayer("null", 13, "CTRL", [], null);
    CARD.parent = NULLA;
    var INTRO = mkComp(100, "Intro", [HERO, CARD, NULLA]);

    var TITLE2 = mkLayer("text", 21, "Hero Subtitle", []);
    var BG = mkLayer("shape", 22, "Background", ["ADBE Gaussian Blur 2"]);
    var OUTRO = mkComp(200, "Outro", [TITLE2, BG]);

    var FOLDER = { id: 300, name: "Assets" };

    var app = { project: {
      numItems: 3,
      item: function (i) { return [INTRO, FOLDER, OUTRO][i - 1]; },
      itemByID: function (id) { return id === 100 ? INTRO : (id === 200 ? OUTRO : null); }
    } };
    function getCompById(id) {
      var it = app.project.itemByID(id);
      if (!it) throw new Error("No comp with id " + id);
      return it;
    }
    `,
    ctx,
    { filename: "mock-project.jsx" },
  );
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  return ctx.OPS;
}

const CORE = ["id", "index", "name", "sourceType", "compId", "compName"];
const keysOf = (o) => Object.keys(o).sort();
const byName = (res, n) => {
  const hit = res.matches.find((m) => m.name === n);
  assert.ok(hit, `no match named ${n} in ${JSON.stringify(res.matches.map((m) => m.name))}`);
  return hit;
};

// ---------------------------------------------------------------------------
// The default is the bounded form
// ---------------------------------------------------------------------------

check("omitting include returns the core plus comp, and nothing else", () => {
  const ops = loadOps();
  const res = ops.find_layers({});
  assert.equal(res.count, 5);
  assert.equal(res.compsSearched, 2, "the folder item is not a comp and must not be counted");
  assert.equal(res.matches.length, 5);
  for (const m of res.matches) {
    same(keysOf(m), [...CORE].sort(), `${m.name} carries more than the core: ${keysOf(m)}`);
  }
  const hero = byName(res, "Hero Title");
  assert.equal(hero.id, 11);
  assert.equal(hero.index, 1);
  assert.equal(hero.sourceType, "text");
  assert.equal(hero.compId, 100);
  assert.equal(hero.compName, "Intro");
});

check("the bounded answer says so: included is echoed as []", () => {
  const ops = loadOps();
  same(ops.find_layers({}).included, []);
  same(ops.find_layers({ include: [] }).included, []);
});

check("include: [] is the same answer as omitting it", () => {
  const ops = loadOps();
  same(ops.find_layers({ include: [] }), ops.find_layers({}));
});

// ---------------------------------------------------------------------------
// The sections are list_layers' own, through the same function
// ---------------------------------------------------------------------------

check("include: ['timing'] adds exactly the timing fields to every match", () => {
  const ops = loadOps();
  const res = ops.find_layers({ include: ["timing"] });
  same(res.included, ["timing"]);
  for (const m of res.matches) {
    same(keysOf(m), [...CORE, "inPoint", "outPoint", "startTime", "stretch"].sort());
    assert.equal(m.inPoint, 0.5);
  }
});

check("include: ['flags', 'parent'] adds both, and parent is the id", () => {
  const ops = loadOps();
  const res = ops.find_layers({ compId: 100, include: ["flags", "parent"] });
  const card = byName(res, "Card");
  assert.equal(card.parent, 13, "parent is reported as the parent layer's id");
  assert.equal(card.label, 3);
  assert.equal(card.blendingMode, 5212);
  assert.equal(byName(res, "CTRL").parent, null);
  same(
    keysOf(card),
    [...CORE, "enabled", "solo", "locked", "shy", "threeDLayer", "label", "blendingMode", "parent"].sort(),
  );
});

check("every section list_layers honours, find_layers honours identically", () => {
  // Same layer, both ops, every section: the records must agree field for
  // field, because they are meant to be one function. compId/compName are the
  // only additions find_layers makes.
  const ops = loadOps();
  for (const include of [["flags"], ["timing"], ["parent"], ["flags", "timing", "parent"]]) {
    const listed = ops.list_layers({ compId: 100, include });
    const found = ops.find_layers({ compId: 100, include });
    assert.equal(found.matches.length, listed.length);
    for (let i = 0; i < listed.length; i++) {
      const { compId, compName, ...rest } = found.matches[i];
      same(rest, listed[i], `include ${include} disagrees on layer ${listed[i].name}`);
      assert.equal(compId, 100);
      assert.equal(compName, "Intro");
    }
  }
});

check("an unknown section name is ignored by the walk, never an extra field", () => {
  // The schema refuses it on the direct path; run_batch forwards unvalidated,
  // so the JSX has to stay harmless — a section nobody wrote cannot appear.
  const ops = loadOps();
  const res = ops.find_layers({ include: ["bogus"] });
  for (const m of res.matches) same(keysOf(m), [...CORE].sort());
  same(res.included, ["bogus"], "echoed as given, so the caller sees it was not a real section");
});

// ---------------------------------------------------------------------------
// The filters still work on the bounded output
// ---------------------------------------------------------------------------

check("namePattern is a case-insensitive regex across all comps", () => {
  const ops = loadOps();
  const res = ops.find_layers({ namePattern: "^hero" });
  same(res.matches.map((m) => [m.name, m.compName]), [["Hero Title", "Intro"], ["Hero Subtitle", "Outro"]]);
  assert.equal(res.count, 2);
  assert.equal(res.compsSearched, 2);
});

check("compId narrows the search to one comp", () => {
  const ops = loadOps();
  const res = ops.find_layers({ compId: 200, namePattern: "hero" });
  same(res.matches.map((m) => m.id), [21]);
  assert.equal(res.compsSearched, 1);
});

check("type filters on sourceType, which the bounded record still carries", () => {
  const ops = loadOps();
  const res = ops.find_layers({ type: "shape" });
  same(res.matches.map((m) => m.name), ["Card", "Background"]);
  for (const m of res.matches) assert.equal(m.sourceType, "shape");
});

check("hasEffectMatchName walks the Effects group whatever include says", () => {
  const ops = loadOps();
  const res = ops.find_layers({ hasEffectMatchName: "ADBE Gaussian Blur 2", include: ["timing"] });
  same(res.matches.map((m) => m.name), ["Hero Title", "Background"]);
  same(res.included, ["timing"]);
});

check("all three filters combine, and no match is an honest empty", () => {
  const ops = loadOps();
  const res = ops.find_layers({ namePattern: "hero", type: "text", hasEffectMatchName: "ADBE Gaussian Blur 2" });
  same(res.matches.map((m) => m.id), [11]);
  const none = ops.find_layers({ namePattern: "nothing-here" });
  same(none, { matches: [], count: 0, compsSearched: 2, included: [] });
});

// ---------------------------------------------------------------------------
// The schema half: the two ops share one section vocabulary
// ---------------------------------------------------------------------------

const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, LAYER_SUMMARY_SECTIONS } = await import(sharedDist("schemas.js"));

const enumOptions = (schema, field) => {
  // include is z.array(z.enum(...)).optional() on both ops.
  const inner = schema.shape[field]._def.innerType;
  return inner._def.type._def.values;
};

check("find_layers and list_layers accept exactly the same section names", () => {
  const find = enumOptions(OpSchemas.find_layers, "include");
  const list = enumOptions(OpSchemas.list_layers, "include");
  same(find, list);
  same(find, LAYER_SUMMARY_SECTIONS);
});

check("the section names the schema advertises are the ones __layerSummary implements", () => {
  // The drift the shared constant exists to stop: a name in the schema that
  // the walk has never heard of would be accepted and silently add nothing.
  const src = read("layers.jsx");
  for (const name of LAYER_SUMMARY_SECTIONS) {
    assert.ok(
      src.includes(`__wantsSection(sections, "${name}")`),
      `layers.jsx has no __wantsSection branch for "${name}"`,
    );
  }
});

check("the schema accepts the sections and refuses an unknown one", () => {
  const ok = OpSchemas.find_layers.safeParse({ namePattern: "x", include: ["flags", "parent"] });
  assert.ok(ok.success, ok.error?.message);
  const bad = OpSchemas.find_layers.safeParse({ include: ["transform"] });
  assert.equal(bad.success, false, "transform is a get_layer_full section, not a summary one");
  assert.ok(OpSchemas.find_layers.safeParse({}).success, "include stays optional");
});

check("the schema description and the tool description both say the default is bounded", () => {
  const desc = OpSchemas.find_layers.shape.include.description;
  assert.match(desc, /same names as list_layers/);
  assert.match(desc, /does NOT return every section/);
  for (const name of LAYER_SUMMARY_SECTIONS) assert.ok(desc.includes(name), `schema description omits ${name}`);
});

const serverDist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { descriptions } = await import(serverDist("tools", "descriptions.js"));

check("the tool description names include, the sections and the bounded default", () => {
  const d = descriptions.find_layers;
  assert.match(d, /`include`/);
  assert.match(d, /unlike list_layers/);
  assert.match(d, /included/);
  for (const name of LAYER_SUMMARY_SECTIONS) assert.ok(d.includes(name), `tool description omits ${name}`);
});

console.log(`find-layers: ${passed} checks passed`);
process.exit(0);
