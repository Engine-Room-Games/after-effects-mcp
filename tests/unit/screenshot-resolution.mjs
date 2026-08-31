// What resolution a screenshot is actually rendered at (issue #72).
//
// `saveFrameToPng` renders at the comp's own `resolutionFactor`, and the comp's
// resolutionFactor is the Resolution dropdown the designer left the viewer on.
// `__saveFrameAt` set it for any factor above 1 and skipped it at 1 — so on a
// comp parked at Quarter, `downsample: 1` returned a quarter-size frame and
// `downsample: 2` returned one four times *larger*. The response never lied
// about it (the panel reads the dimensions out of the PNG's IHDR), which is
// precisely why it was invisible: the picture disagreed with the request while
// the numbers agreed with the picture.
//
// So this runs the real vision.jsx ops against a comp whose factor starts at
// Quarter and records what `saveFrameToPng` saw each time it was called. Three
// properties, all of which have to hold together:
//
//   * every requested factor — 1 included — is set explicitly before the render;
//   * the user's own factor is put back afterwards, including when the render
//     throws, because leaving someone's comp at Quarter is a worse bug than the
//     one being fixed;
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
// The mock DOM. The only thing it really models is that saveFrameToPng renders
// at whatever resolutionFactor happens to be set when it is called.
// ---------------------------------------------------------------------------

const QUARTER = [4, 4];

// A [x, y] resolution factor as a plain host array, whichever realm it came from.
const pair = (v) => [v[0], v[1]];

class MockComp {
  constructor(o) {
    o = o || {};
    this.id = 900;
    this.width = o.width || 1920;
    this.height = o.height || 1080;
    this.time = 0.5;
    // The designer's viewer setting. Quarter unless a test says otherwise.
    this.resolutionFactor = (o.resolutionFactor || QUARTER).slice();
    this.renders = [];          // { time, factor } as seen from inside the render
    this.failAt = o.failAt;     // a time whose render throws
    this.layers = [];
  }
  get numLayers() { return this.layers.length; }
  layer(i) { return this.layers[i - 1]; }
  saveFrameToPng(time, file) {
    // Copied element by element rather than with .slice(): the factor the JSX
    // sets is an Array from the vm realm, and deepStrictEqual compares
    // prototypes. This is the host's array holding the same two numbers.
    this.renders.push({ time, factor: pair(this.resolutionFactor), path: file.path });
    if (this.failAt !== undefined && time === this.failAt) {
      throw new Error("After Effects error: could not render the frame");
    }
  }
  // The size AE would write at the factor a render saw. Not used by the code
  // under test — it is how this file states "larger" and "smaller".
  renderedSize(i) {
    const f = this.renders[i].factor[0];
    return [Math.floor(this.width / f), Math.floor(this.height / f)];
  }
}

class MockLayer {
  constructor(id, name) { this.id = id; this.name = name; this.solo = false; }
}

function loadOps(comp) {
  const ctx = {
    OPS: {},
    Math, Date, isFinite, Error, String,
    noUndo: (fn) => fn,
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
  return ctx.OPS;
}

function scene(o) {
  const comp = new MockComp(o);
  comp.layers = [new MockLayer(1, "bg"), new MockLayer(2, "title"), new MockLayer(3, "chip")];
  return { comp, ops: loadOps(comp) };
}

const factors = (comp) => comp.renders.map((r) => r.factor);
// What the viewer is left on once the op has finished.
const viewer = (comp) => pair(comp.resolutionFactor);

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

check("downsample 1 sets the factor rather than inheriting the comp's own", () => {
  const { comp, ops } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, time: 2, downsample: 1 });
  assert.deepEqual(factors(comp), [[1, 1]], "the render must have seen Full, not the viewer's Quarter");
  assert.equal(out.downsample, 1, "the reported factor is the one that was rendered");
});

check("every explicit factor is honoured from every starting viewer resolution", () => {
  for (const start of [[1, 1], [2, 2], [3, 3], [4, 4], [8, 8]]) {
    for (const ds of [1, 2, 3, 4, 8]) {
      const { comp, ops } = scene({ resolutionFactor: start });
      const out = ops.screenshot_frame({ compId: comp.id, downsample: ds });
      assert.deepEqual(
        comp.renders[0].factor, [ds, ds],
        `viewer at ${start[0]}, downsample ${ds} rendered at ${comp.renders[0].factor[0]}`,
      );
      assert.equal(out.downsample, ds);
      assert.deepEqual(viewer(comp), start, "the viewer's own setting must come back");
    }
  }
});

// ---------------------------------------------------------------------------
// The restore, which the fix must not have cost
// ---------------------------------------------------------------------------

check("the viewer's resolution is restored after a successful render", () => {
  const { comp, ops } = scene();
  ops.screenshot_frame({ compId: comp.id, downsample: 1 });
  assert.deepEqual(viewer(comp), QUARTER);
  ops.screenshot_frame({ compId: comp.id, downsample: 3 });
  assert.deepEqual(viewer(comp), QUARTER);
});

check("the viewer's resolution is restored when the render throws — at factor 1 too", () => {
  // The finally used to be reachable only above factor 1. Now that 1 sets the
  // factor as well, 1 is the case that would leave a comp at Full if the
  // restore were ever moved into the success path.
  for (const ds of [1, 4]) {
    const { comp, ops } = scene({ failAt: 2 });
    assert.throws(
      () => ops.screenshot_frame({ compId: comp.id, time: 2, downsample: ds }),
      /could not render the frame/,
    );
    assert.deepEqual(
      viewer(comp), QUARTER,
      `a throw at downsample ${ds} left the comp at ${viewer(comp)[0]}`,
    );
  }
});

check("screenshot_layer sets the factor explicitly and restores solo as well", () => {
  const { comp, ops } = scene();
  comp.layers[0].solo = true;                 // a solo the user set, to be put back
  const out = ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 });
  assert.deepEqual(factors(comp), [[1, 1]]);
  assert.deepEqual(viewer(comp), QUARTER);
  assert.deepEqual(comp.layers.map((l) => l.solo), [true, false, false], "solo state must be restored");
  assert.equal(out.layerId, 2);
  assert.equal(out.downsample, 1);
});

check("screenshot_layer restores both the resolution and the solo state on a throw", () => {
  const { comp, ops } = scene({ failAt: 0.5 });
  comp.layers[2].solo = true;
  assert.throws(() => ops.screenshot_layer({ compId: comp.id, layerId: 2, downsample: 1 }), /could not render/);
  assert.deepEqual(viewer(comp), QUARTER);
  assert.deepEqual(comp.layers.map((l) => l.solo), [false, false, true]);
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

  // Already small: the derivation lands on 1, and 1 is now an explicit Full
  // render rather than "whatever the viewer says".
  const small = scene({ width: 800, height: 600 });
  assert.equal(small.ops.screenshot_frame({ compId: small.comp.id }).downsample, 1);
  assert.deepEqual(small.comp.renders[0].factor, [1, 1]);
  assert.deepEqual(viewer(small.comp), QUARTER);
});

check("the screenshot schemas carry no zod default on downsample", () => {
  // Behavioural cover for the same trap: a `.default(1)` reaches the panel as
  // an explicit 1 and the derivation above never runs again.
  const src = fs.readFileSync(path.join(root, "packages", "shared", "src", "schemas.ts"), "utf8");
  const decl = src.slice(src.indexOf("const downsampleParam"));
  const chain = decl.slice(0, decl.indexOf(");"));
  assert.ok(!/\.default\(/.test(chain), "downsampleParam must stay optional with no default");
});

// ---------------------------------------------------------------------------
// The contact sheet, which renders through the same function
// ---------------------------------------------------------------------------

check("every tile of a sheet renders at the sheet's factor, explicit 1 included", () => {
  const { comp, ops } = scene();
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.equal(out.contactSheet, true);
  assert.deepEqual(factors(comp), [[1, 1], [1, 1], [1, 1]], "a Quarter viewer must not shrink the tiles");
  assert.equal(out.downsample, 1);
  // Array.from, because `tiles` was built inside the vm realm and
  // deepStrictEqual compares prototypes.
  assert.deepEqual(Array.from(out.tiles, (t) => t.downsample), [1, 1, 1]);
  assert.deepEqual(viewer(comp), QUARTER);
});

check("a sheet's derived per-tile factor is used for the render, not just reported", () => {
  const { comp, ops } = scene();               // 1080p, single-frame factor 2
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2] });
  assert.equal(out.downsample, 4, "ceil(2 * sqrt(3)) — a sheet costs about what one frame costs");
  assert.deepEqual(factors(comp), [[4, 4], [4, 4], [4, 4]]);
  assert.deepEqual(viewer(comp), QUARTER);
});

check("one tile that will not render costs neither the others nor the restore", () => {
  const { comp, ops } = scene({ failAt: 1 });
  const out = ops.screenshot_frame({ compId: comp.id, times: [0, 1, 2], downsample: 1 });
  assert.equal(out.tiles.length, 3, "every requested time keeps its cell");
  assert.equal(out.tiles[1].path, undefined);
  assert.match(out.tiles[1].error, /could not render the frame/);
  assert.ok(out.tiles[0].path && out.tiles[2].path);
  assert.deepEqual(factors(comp), [[1, 1], [1, 1], [1, 1]]);
  assert.deepEqual(viewer(comp), QUARTER, "a failed tile must not leave the comp at Full");
});

console.log(`screenshot-resolution: ${passed} checks passed`);
process.exit(0);
