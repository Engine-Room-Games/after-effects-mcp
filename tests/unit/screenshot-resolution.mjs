// What resolution a screenshot is actually rendered at (issue #72), what it
// costs in undo history (issue #116), and that it never touches the user's
// comp to get there (issue #282).
//
// `saveFrameToPng` renders at the resolutionFactor of the comp it is called
// on, and the user's comp's factor is the Resolution dropdown the designer left
// the viewer on. Rendering it as it stood answered `downsample: 1` on a comp
// parked at Quarter with a quarter-size frame (#72). Setting the factor on the
// user's comp and putting it back — and flipping solo switches for a layer —
// fixed that, and flickered the user's own timeline while it rendered (#282).
// So a screenshot now renders through a TEMPORARY comp whenever anything would
// need changing: a wrapper holding the comp as a precomp, or a copy of it with
// the solos set on the copy. These checks hold, together:
//
//   * every requested factor — 1 included — is the factor the render saw;
//   * the user's comp is never assigned: not its Resolution, not one solo;
//   * every temporary comp is removed, including when the render throws;
//   * a comp that needs nothing changed renders directly, with no temp comp
//     and no undo step;
//   * at most one named undo group per call, none nested in one already open;
//   * omitting the factor still runs the derivation, which is what would break
//     if a zod `.default(1)` were ever added to the screenshot schemas.
//
//   node tests/unit/screenshot-resolution.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const visionSrc = fs.readFileSync(path.join(jsxDir, "vision.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`screenshot-resolution FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// The mock DOM. What it models: saveFrameToPng renders at the resolutionFactor
// of the comp it is called on — and a comp nested in a wrapper renders at the
// WRAPPER's factor unless it preserves its own resolution when nested (the AE
// rule the wrapper route relies on; recipe 79 is the live check). Every
// assignment to the user's comp or its layers is recorded, because since issue
// #282 there must be none.
// ---------------------------------------------------------------------------

const QUARTER = [4, 4];

// A [x, y] resolution factor as a plain host array, whichever realm it came from.
const pair = (v) => [v[0], v[1]];

class MockComp {
  constructor(o, world) {
    o = o || {};
    this.world = world;
    this.id = o.id || 900;
    this.name = o.name || "Main";
    this.width = o.width || 1920;
    this.height = o.height || 1080;
    this.pixelAspect = 1;
    this.duration = 10;
    this.frameRate = 25;
    this.time = 0.5;
    this.kind = o.kind || "user";
    this.preserveNestedResolution = !!o.preserveNestedResolution;
    // Every assignment AE would record as an undo step on THIS comp, in order.
    // Shared with the comp's layers so solo switches land in the same list.
    this.assignments = [];
    this.groupOpen = () => false;
    this._rf = (o.resolutionFactor || QUARTER).slice();
    this.failAt = o.failAt;     // a time whose render throws
    this.layers = [];
    this.nested = null;         // the comp a wrapper holds
    this.removed = false;
  }
  get resolutionFactor() { return this._rf; }
  set resolutionFactor(v) {
    this.assignments.push({ what: "resolution", value: pair(v), inGroup: this.groupOpen() });
    this._rf = v;
  }
  get numLayers() { return this.layers.length; }
  layer(i) { return this.layers[i - 1]; }
  saveFrameToPng(time, file) {
    let factor = pair(this.resolutionFactor);
    let source = this;
    if (this.nested) {
      source = this.nested;
      if (this.nested.preserveNestedResolution) factor = pair(this.nested.resolutionFactor);
    }
    this.world.renders.push({
      time, factor, path: file.path, via: this.kind,
      solos: source.layers.map((l) => l._solo),
      inGroup: this.groupOpen(),
    });
    if (source.failAt !== undefined && time === source.failAt) {
      throw new Error("After Effects error: could not render the frame");
    }
  }
  duplicate() {
    const w = this.world;
    const d = new MockComp({
      id: 5000 + w.temps.length, name: this.name + " 2", width: this.width, height: this.height,
      resolutionFactor: this._rf, kind: "copy", failAt: this.failAt,
    }, w);
    d.groupOpen = this.groupOpen;
    d.layers = this.layers.map((l, i) => {
      const c = new MockLayer(7000 + w.temps.length * 100 + i, w.copyRenamesLayer && i === 1 ? "renamed" : l.name, d);
      c._solo = l._solo;
      return c;
    });
    if (w.copyDropsLayer) d.layers.pop();
    w.temps.push(d);
    if (w.dirtyOnCreate) w.dirty = true;
    return d;
  }
  remove() {
    if (this.world.removeThrows) throw new Error("After Effects error: cannot remove");
    this.removed = true;
  }
  // The size AE would write at the factor a render saw. Not used by the code
  // under test — it is how this file states "larger" and "smaller".
  renderedSize(i) {
    const f = this.world.renders[i].factor[0];
    return [Math.floor(this.width / f), Math.floor(this.height / f)];
  }
  get renders() { return this.world.renders; }
}

class MockLayer {
  constructor(id, name, comp) {
    this.id = id; this.name = name; this._solo = false; this.comp = comp;
    this.enabled = true; this.guideLayer = false;
  }
  get index() { return this.comp.layers.indexOf(this) + 1; }
  get solo() { return this._solo; }
  set solo(v) {
    this.comp.assignments.push({ what: "solo", id: this.id, value: v, inGroup: this.comp.groupOpen() });
    this._solo = v;
  }
}

function makeWorld(o) {
  const world = {
    renders: [],
    temps: [],               // every temporary comp the op created
    dirty: o.dirty === undefined ? false : o.dirty,
    dirtyOnCreate: o.dirtyOnCreate !== false,
    removeThrows: !!o.removeThrows,
    copyDropsLayer: !!o.copyDropsLayer,
    copyRenamesLayer: !!o.copyRenamesLayer,
    groupOpen: () => false,
  };
  world.app = {
    project: {
      rootFolder: { name: "Root" },
      get dirty() { return world.dirty; },
      items: {
        addComp(name, w, h, pa, dur, fps) {
          const c = new MockComp({ id: 6000 + world.temps.length, name, width: w, height: h, resolutionFactor: [1, 1], kind: "wrapper" }, world);
          c.pixelAspect = pa; c.duration = dur; c.frameRate = fps;
          c.groupOpen = world.groupOpen;
          c.layers = [];
          c.layers.add = (src) => {
            if (o.wrapperAddThrows) throw new Error("After Effects error: cannot add layer");
            c.nested = src;
            const L = new MockLayer(8000, src.name, c);
            c.layers.push(L);
            return L;
          };
          world.temps.push(c);
          if (world.dirtyOnCreate) world.dirty = true;
          return c;
        },
      },
    },
  };
  return world;
}

// core.jsx's undo machinery, reduced to what vision.jsx calls: withUndo opens a
// named group and sets __UNDO_OPEN for its duration, exactly as the real one
// does. `undo` records every begin/end, so a test can count the steps a call
// would leave in Edit > History.
function loadOps(comp, world, o) {
  const undo = [];
  const ctx = {
    OPS: {},
    Math, Date, isFinite, Error, String,
    app: world.app,
    noUndo: (fn) => fn,
    __UNDO_OPEN: !!o.groupAlreadyOpen,
    withUndo(name, fn) {
      undo.push(`begin:${name}`);
      ctx.__UNDO_OPEN = true;
      try { return fn(); } finally { ctx.__UNDO_OPEN = false; undo.push("end"); }
    },
    Folder: { temp: { fsName: "/tmp/ae-mcp-test" } },
    File: class { constructor(p) { this.path = p; } },
    getCompById: (id) => {
      assert.equal(id, comp.id, "the handler must resolve the comp it was given");
      return comp;
    },
    getLayerById: (c, id) => {
      const hit = c.layers.find((l) => l.id === id);
      assert.ok(hit, `no mock layer ${id}`);
      return hit;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(visionSrc, ctx, { filename: "vision.jsx" });
  const open = () => !!ctx.__UNDO_OPEN;
  world.groupOpen = open;
  comp.groupOpen = open;
  return { ops: ctx.OPS, undo, ctx };
}

function scene(o) {
  o = o || {};
  const world = makeWorld(o);
  const comp = new MockComp(o, world);
  comp.layers = [new MockLayer(1, "bg", comp), new MockLayer(2, "title", comp), new MockLayer(3, "chip", comp)];
  for (const i of o.soloed || []) comp.layers[i]._solo = true;   // the user's own solos
  const { ops, undo, ctx } = loadOps(comp, world, o);
  return { comp, ops, undo, world, ctx };
}

const factors = (comp) => comp.renders.map((r) => r.factor);
// What the viewer is left on once the op has finished.
const viewer = (comp) => pair(comp.resolutionFactor);
const solos = (comp) => comp.layers.map((l) => l._solo);

// The user's comp was never written: not its Resolution, not a solo switch.
function untouched(comp, msg) {
  assert.deepEqual(comp.assignments, [], (msg ? msg + ": " : "") + "the user's comp must never be assigned (issue #282)");
}
// Every temporary comp the op created is gone again.
function cleanedUp(world) {
  assert.ok(world.temps.every((t) => t.removed), "every temporary comp must be removed");
}

// ---------------------------------------------------------------------------
// The reported bug, stated as the comparison that made it visible
// ---------------------------------------------------------------------------

check("downsample 2 is never larger than downsample 1 — the whole of issue #72", () => {
  const { comp, ops } = scene();               // viewer left on Quarter
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  ops.screenshot_frame({ compId: comp.id, downsample: 2 });
  const [full, half] = [comp.renderedSize(0), comp.renderedSize(1)];
  assert.deepEqual(full, [1920, 1080], `downsample 1 rendered ${full.join("x")}, not the comp's true size`);
  assert.deepEqual(half, [960, 540]);
  assert.ok(full[0] > half[0], "downsample 1 must be the larger of the two");
});

check("downsample 1 renders at Full rather than inheriting the comp's own factor", () => {
  const { comp, ops } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, time: 2, downsample: 1 });
  assert.deepEqual(factors(comp), [[1, 1]], "the render must have seen Full, not the viewer's Quarter");
  assert.equal(out.downsample, 1, "the reported factor is the one that was rendered");
});

check("every explicit factor is honoured from every starting viewer resolution, with the comp untouched", () => {
  for (const start of [[1, 1], [2, 2], [3, 3], [4, 4], [8, 8]]) {
    for (const ds of [1, 2, 3, 4, 8]) {
      const { comp, ops, world } = scene({ resolutionFactor: start });
      const out = ops.screenshot_frame({ compId: comp.id, downsample: ds });
      assert.deepEqual(
        comp.renders[0].factor, [ds, ds],
        `viewer at ${start[0]}, downsample ${ds} rendered at ${comp.renders[0].factor[0]}`,
      );
      assert.equal(out.downsample, ds);
      assert.deepEqual(viewer(comp), start, "the viewer's own setting is never changed");
      untouched(comp, `viewer ${start[0]}, downsample ${ds}`);
      cleanedUp(world);
      assert.equal(out.isolation, start[0] === ds ? "direct" : "wrapper");
    }
  }
});

// ---------------------------------------------------------------------------
// Isolation (issue #282): the routes, and the clean-up
// ---------------------------------------------------------------------------

check("a frame that needs a different factor renders through a wrapper holding the comp", () => {
  const { comp, ops, world } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.equal(out.isolation, "wrapper");
  assert.equal(world.temps.length, 1);
  const w = world.temps[0];
  assert.equal(w.kind, "wrapper");
  assert.equal(w.nested, comp, "the wrapper must hold the user's comp itself, not a copy");
  assert.deepEqual([w.width, w.height, w.pixelAspect, w.duration, w.frameRate], [1920, 1080, 1, 10, 25]);
  assert.equal(comp.renders[0].via, "wrapper");
  untouched(comp);
  cleanedUp(world);
});

check("a comp that preserves its resolution when nested renders through a copy instead", () => {
  // A wrapper's factor would not reach it, which would bring #72 back.
  const { comp, ops, world } = scene({ preserveNestedResolution: true });
  const out = ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.equal(out.isolation, "copy");
  assert.deepEqual(factors(comp), [[1, 1]]);
  assert.equal(comp.renders[0].via, "copy");
  untouched(comp);
  cleanedUp(world);
});

check("the temporary comp is removed when the render throws — at factor 1 too", () => {
  for (const ds of [1, 2]) {
    const { comp, ops, world } = scene({ failAt: 2 });
    assert.throws(
      () => ops.screenshot_frame({ compId: comp.id, time: 2, downsample: ds }),
      /could not render the frame/,
    );
    assert.equal(world.temps.length, 1);
    cleanedUp(world);
    untouched(comp);
    assert.deepEqual(viewer(comp), QUARTER);
  }
});

check("a wrapper that fails part-way through being built is still removed", () => {
  const { comp, ops, world } = scene({ wrapperAddThrows: true });
  assert.throws(() => ops.screenshot_frame({ compId: comp.id, downsample: 1 }), /cannot add layer/);
  assert.equal(world.temps.length, 1);
  cleanedUp(world);
  assert.equal(comp.renders.length, 0);
});

check("a temporary comp that will not go away is reported, not hidden", () => {
  const { comp, ops, world } = scene({ removeThrows: true });
  const out = ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.equal(world.temps.length, 1);
  assert.match(out.note, /could not be removed/);
  assert.match(out.note, /AE MCP screenshot \(temporary\)/, "the note names the item to delete");
  untouched(comp);
});

check("a saved project that the temporary comp leaves unsaved is said, once", () => {
  const clean = scene({ dirty: false });
  const out = clean.ops.screenshot_frame({ compId: clean.comp.id, downsample: 1 });
  assert.match(out.note, /unsaved changes/);
  // Already unsaved before the call: nothing the screenshot did, nothing to say.
  const dirty = scene({ dirty: true });
  assert.equal(dirty.ops.screenshot_frame({ compId: dirty.comp.id, downsample: 1 }).note, undefined);
  // No temp comp at all: nothing to say either.
  const direct = scene({ dirty: false, resolutionFactor: [1, 1] });
  const d = direct.ops.screenshot_frame({ compId: direct.comp.id, downsample: 1 });
  assert.equal(d.isolation, "direct");
  assert.equal(d.note, undefined);
  // AE leaving the project clean: nothing to say.
  const kept = scene({ dirty: false, dirtyOnCreate: false });
  assert.equal(kept.ops.screenshot_frame({ compId: kept.comp.id, downsample: 1 }).note, undefined);
});

check("screenshot_layer solos the target in a copy and never in the user's comp", () => {
  const { comp, ops, world } = scene({ soloed: [0] });   // a solo the user set
  const out = ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.equal(out.isolation, "copy");
  assert.equal(out.layerId, 2);
  assert.equal(out.downsample, 1);
  assert.deepEqual(factors(comp), [[1, 1]]);
  assert.deepEqual(comp.renders[0].solos, [false, true, false], "only the target is soloed in what rendered");
  assert.equal(comp.renders[0].via, "copy");
  assert.deepEqual(solos(comp), [true, false, false], "the user's solo is exactly as they left it");
  untouched(comp);
  cleanedUp(world);
});

check("screenshot_layer assigns only the solo switches that are wrong, on the copy", () => {
  const { comp, ops, world } = scene({ resolutionFactor: [1, 1] });
  ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  const copy = world.temps[0];
  assert.deepEqual(copy.assignments.filter((a) => a.what === "solo").map((a) => a.value), [true]);
  untouched(comp);
});

check("screenshot_layer removes the copy when the render throws", () => {
  const { comp, ops, world } = scene({ failAt: 0.5, soloed: [2] });
  assert.throws(() => ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 }), /could not render/);
  cleanedUp(world);
  untouched(comp);
  assert.deepEqual(solos(comp), [false, false, true]);
  assert.deepEqual(viewer(comp), QUARTER);
});

check("a copy that does not match the comp is refused and removed, never rendered", () => {
  for (const o of [{ copyDropsLayer: true }, { copyRenamesLayer: true }]) {
    const { comp, ops, world } = scene(o);
    assert.throws(() => ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 }), /could not isolate/);
    assert.equal(comp.renders.length, 0, "a copy that is not the comp would render the wrong thing");
    cleanedUp(world);
    untouched(comp);
  }
});

check("screenshot_layer with the target already soloed alone and the factor matching renders directly", () => {
  const { comp, ops, undo, world } = scene({ resolutionFactor: [1, 1], soloed: [1] });
  const out = ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.equal(out.isolation, "direct");
  assert.equal(world.temps.length, 0);
  assert.deepEqual(undo, []);
  assert.equal(comp.renders[0].via, "user");
  untouched(comp);
});

check("the copy is renamed as ours and moved to the project root, never left as '<name> 2' in the user's folder", () => {
  const { comp, ops, world } = scene({ removeThrows: true });
  const out = ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  const copy = world.temps[0];
  assert.equal(copy.name, "AE MCP screenshot (temporary)");
  assert.equal(copy.parentFolder, world.app.project.rootFolder);
  assert.match(out.note, /\("AE MCP screenshot \(temporary\)"\) could not be removed/, "the leftover is named as it now is");
});

check("a guide layer does not change the route — saveFrameToPng never renders one (measured on 26.5)", () => {
  const { comp, ops, world } = scene();
  comp.layers[0].guideLayer = true;
  const out = ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.equal(out.isolation, "wrapper");
  untouched(comp);
  cleanedUp(world);
});

check("screenshot_layer on a switched-off layer is refused before anything is created", () => {
  const { comp, ops, world, undo } = scene();
  comp.layers[1].enabled = false;
  assert.throws(
    () => ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 }),
    /switched off.*Nothing was changed.*set_layer\(\{enabled: true\}\)/s,
  );
  assert.equal(world.temps.length, 0);
  assert.equal(comp.renders.length, 0);
  assert.deepEqual(undo, []);
  untouched(comp);
});

// ---------------------------------------------------------------------------
// The derivation, which a zod `.default(1)` would silently switch off
// ---------------------------------------------------------------------------

check("an omitted factor is derived from the comp, not taken as 1", () => {
  const hd = scene({ width: 1920, height: 1080 });
  assert.equal(hd.ops.screenshot_frame({ compId: hd.comp.id }).downsample, 2);
  assert.deepEqual(hd.comp.renders[0].factor, [2, 2]);

  const uhd = scene({ width: 3840, height: 2160 });
  assert.equal(uhd.ops.screenshot_frame({ compId: uhd.comp.id }).downsample, 3);
  assert.deepEqual(uhd.comp.renders[0].factor, [3, 3]);

  const small = scene({ width: 800, height: 600 });
  assert.equal(small.ops.screenshot_frame({ compId: small.comp.id }).downsample, 1);
  assert.deepEqual(small.comp.renders[0].factor, [1, 1]);
  assert.deepEqual(viewer(small.comp), QUARTER);
});

check("the screenshot schemas carry no zod default on downsample", () => {
  const src = fs.readFileSync(path.join(root, "packages", "shared", "src", "schemas.ts"), "utf8");
  const decl = src.slice(src.indexOf("const downsampleParam"));
  const chain = decl.slice(0, decl.indexOf(");"));
  assert.ok(!/\.default\(/.test(chain), "downsampleParam must stay optional with no default");
});

// ---------------------------------------------------------------------------
// The contact sheet, which renders every tile through one temporary comp
// ---------------------------------------------------------------------------

check("every tile of a sheet renders at the sheet's factor through one wrapper", () => {
  const { comp, ops, world } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.equal(out.contactSheet, true);
  assert.deepEqual(factors(comp), [[1, 1], [1, 1], [1, 1]], "a Quarter viewer must not shrink the tiles");
  assert.equal(out.downsample, 1);
  assert.deepEqual(Array.from(out.tiles, (t) => t.downsample), [1, 1, 1]);
  assert.equal(world.temps.length, 1, "one temporary comp for the whole sheet");
  assert.equal(out.isolation, "wrapper");
  untouched(comp);
  cleanedUp(world);
});

check("a sheet's derived per-tile factor is used for the render, not just reported", () => {
  const { comp, ops } = scene();               // 1080p, single-frame factor 2
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2] });
  assert.equal(out.downsample, 4, "ceil(2 * sqrt(3)) — a sheet costs about what one frame costs");
  assert.deepEqual(factors(comp), [[4, 4], [4, 4], [4, 4]]);
  // Quarter viewer, sheet factor 4: nothing to change, so it renders directly.
  assert.equal(out.isolation, "direct");
  untouched(comp);
});

check("one tile that will not render costs neither the others nor the clean-up", () => {
  const { comp, ops, world } = scene({ failAt: 1 });
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.equal(out.tiles.length, 3, "every requested time keeps its cell");
  assert.equal(out.tiles[1].path, undefined);
  assert.match(out.tiles[1].error, /could not render the frame/);
  assert.ok(out.tiles[0].path && out.tiles[2].path);
  assert.deepEqual(factors(comp), [[1, 1], [1, 1], [1, 1]]);
  untouched(comp);
  cleanedUp(world);
});

// ---------------------------------------------------------------------------
// The undo history a screenshot leaves behind (issue #116)
//
// The temporary comp's creation, settings and removal are each a step in AE.
// The properties: at most one named group per call, none at all when nothing
// is created, no nested group inside one already open, and every change to a
// temporary comp — and every render — inside the group.
// ---------------------------------------------------------------------------

const groups = (undo) => undo.filter((u) => u.startsWith("begin:"));
const balanced = (undo) => groups(undo).length === undo.filter((u) => u === "end").length;

check("a comp already at the requested factor renders directly, with no temp comp and no undo step", () => {
  const { comp, ops, undo, world } = scene({ resolutionFactor: [1, 1] });
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.deepEqual(factors(comp), [[1, 1]], "the render still happens at the requested factor (#72)");
  assert.equal(world.temps.length, 0);
  assert.deepEqual(undo, [], "nothing changed, so no undo group either");
});

check("the same holds for a derived factor that happens to match", () => {
  const { comp, ops, undo, world } = scene({ resolutionFactor: [2, 2] }); // 1080p derives 2
  const out = ops.screenshot_frame({ compId: comp.id });
  assert.equal(out.downsample, 2);
  assert.equal(world.temps.length, 0);
  assert.deepEqual(undo, []);
});

check("a wrapper render is one named undo group holding the whole temp comp's life", () => {
  const { comp, ops, undo, world } = scene();
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.deepEqual(undo, ["begin:AE MCP: screenshot", "end"]);
  assert.ok(world.temps[0].assignments.every((a) => a.inGroup), "the wrapper's settings land inside the group");
  assert.ok(comp.renders.every((r) => r.inGroup));
});

check("a whole contact sheet is one undo step, not one per tile", () => {
  const { comp, ops, undo } = scene();
  ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2, 3], downsample: 1 });
  assert.deepEqual(groups(undo), ["begin:AE MCP: screenshot"]);
  assert.ok(balanced(undo));
});

check("a contact sheet at the comp's own factor costs nothing", () => {
  const { comp, ops, undo, world } = scene({ resolutionFactor: [1, 1] });
  ops.screenshot_frame({ compId: comp.id, times: [0, 1], downsample: 1 });
  assert.equal(world.temps.length, 0);
  assert.deepEqual(undo, []);
});

check("a failed render still closes the group", () => {
  const { comp, ops, undo } = scene({ failAt: 2 });
  assert.throws(() => ops.screenshot_frame({ compId: comp.id, time: 2, downsample: 1 }), /could not render/);
  assert.deepEqual(undo, ["begin:AE MCP: screenshot", "end"]);
});

check("screenshot_layer puts the copy, its solos and its removal inside one group", () => {
  const { comp, ops, undo, world } = scene({ soloed: [0] });
  ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.deepEqual(undo, ["begin:AE MCP: screenshot", "end"]);
  assert.ok(world.temps[0].assignments.length > 0);
  assert.ok(world.temps[0].assignments.every((a) => a.inGroup), "every switch on the copy is inside the group");
});

check("inside a group that is already open (run_batch), no nested group is opened", () => {
  const { comp, ops, undo, world } = scene({ groupAlreadyOpen: true });
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  ops.screenshot_frame({ compId: comp.id, times: [0, 1], downsample: 1 });
  ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.deepEqual(undo, [], "the temp comps join the step that is already open");
  untouched(comp);
  cleanedUp(world);
});

// ---------------------------------------------------------------------------
// The mogrt poster renders through the same function
// ---------------------------------------------------------------------------

check("__saveFrameAt (the mogrt poster) isolates too, and returns what it did", () => {
  const { comp, world, ctx } = scene();
  const st = ctx.__saveFrameAt(comp, 1, new ctx.File("/tmp/poster.png"), 1);
  assert.equal(st.isolation, "wrapper");
  assert.deepEqual(factors(comp), [[1, 1]]);
  untouched(comp);
  cleanedUp(world);
});

console.log(`screenshot-resolution: ${passed} checks passed`);
process.exit(0);
