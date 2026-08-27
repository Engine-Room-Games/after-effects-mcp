// import_footage's SVG check, against a mock AE DOM.
//
// The bug it guards (issue #33) is silent by construction: After Effects
// imports an SVG with a very large viewBox, fabricates pixel dimensions, and
// rasterizes nothing — a footage item that looks healthy in the project panel
// and renders as an empty frame wherever it is placed, with no error at any
// stage. The only signal available at import time is that the aspect ratio AE
// produced is not the one the file asked for.
//
// So the thing worth testing offline is the comparison and what it does with
// the result: refuse and remove by default, keep and warn under force, and
// stay out of the way for the ordinary SVGs that import perfectly well.
//
//   node tests/unit/svg-import.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "footage.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`svg-import FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------- the mock DOM ----------

/** What AE will claim the import produced, keyed by the path asked for. */
let IMPORT_RESULT = null;
let FILES = new Map();
let REMOVED = [];

class MockFile {
  constructor(p) {
    this.path = String(p);
    this.encoding = null;
    this._open = false;
  }
  get exists() { return FILES.has(this.path); }
  open(mode) { this._open = mode === "r" && FILES.has(this.path); return this._open; }
  read(max) {
    const text = FILES.get(this.path) ?? "";
    return max === undefined ? text : text.slice(0, max);
  }
  close() { this._open = false; }
}

class MockItem {
  constructor({ id, name, width, height, duration = 0 }) {
    this.id = id; this.name = name;
    this.width = width; this.height = height;
    this.duration = duration;
    this.frameRate = 0;
    this.footageMissing = false;
  }
  remove() { REMOVED.push(this.name); }
}

class FolderItem {}

function makeContext() {
  REMOVED = [];
  const ctx = {
    OPS: {},
    File: MockFile,
    Folder: class {},
    FolderItem,
    ImportOptions: class { constructor(f) { this.file = f; } canImportAs() { return true; } },
    ImportAsType: { FOOTAGE: "footage" },
    Math,
    isFinite,
    parseFloat,
    String,
    Error,
    app: {
      project: {
        importFile: () => (IMPORT_RESULT === null ? null : new MockItem(IMPORT_RESULT)),
        itemByID: () => null,
      },
    },
    getCompById: () => { throw new Error("not used here"); },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "footage.jsx" });
  return ctx;
}

function withSvg(text, imported) {
  FILES = new Map([["/tmp/icon.svg", text]]);
  IMPORT_RESULT = imported === null ? null : { id: 7, name: "icon.svg", ...imported };
  return makeContext();
}

// ---------- fixtures ----------

// The exact case from the report: viewBox 278050x333334 (aspect 0.834),
// imported by AE as 15906x5654 (aspect 2.813).
const BROKEN = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 278050 333334"><path d="M0 0h10v10z"/></svg>';
// The one that worked in the same session.
const HEALTHY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="200"/></svg>';

// ---------- tests ----------

check("refuses the reported case, removes the item, and names both aspects", () => {
  const ctx = withSvg(BROKEN, { width: 15906, height: 5654 });
  assert.throws(
    () => ctx.OPS.import_footage({ path: "/tmp/icon.svg" }),
    (e) => {
      assert.match(e.message, /15906x5654/, "should name the dimensions AE produced");
      assert.match(e.message, /0 0 278050 333334/, "should name the viewBox");
      assert.match(e.message, /2\.813/, "should name the actual aspect");
      assert.match(e.message, /0\.834/, "should name the expected aspect");
      assert.match(e.message, /has been removed from the project/, "should say the item is gone");
      assert.match(e.message, /force:true/, "should name the escape hatch");
      return true;
    },
  );
  assert.deepEqual(REMOVED, ["icon.svg"], "the broken item must not be left in the project");
});

check("lets a healthy SVG through untouched", () => {
  const ctx = withSvg(HEALTHY, { width: 1024, height: 1024 });
  const r = ctx.OPS.import_footage({ path: "/tmp/icon.svg" });
  assert.equal(r.itemId, 7);
  assert.equal(r.width, 1024);
  assert.equal(r.validation.ok, true);
  assert.equal(r.validation.checked, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(REMOVED, []);
});

check("tolerates the rounding AE does on a non-integer aspect", () => {
  // 512x300 is 1.70667; AE rounding to 1024x600 is exact, 1024x601 is not but
  // is well inside tolerance. Neither is the bug.
  const ctx = withSvg('<svg viewBox="0 0 512 300"/>', { width: 1024, height: 601 });
  const r = ctx.OPS.import_footage({ path: "/tmp/icon.svg" });
  assert.equal(r.validation.ok, true);
});

check("catches a mismatch that is large but not enormous", () => {
  // 10% off: not the 3x of the reported case, but not rounding either.
  const ctx = withSvg('<svg viewBox="0 0 1000 1000"/>', { width: 1000, height: 1100 });
  assert.throws(() => ctx.OPS.import_footage({ path: "/tmp/icon.svg" }), /renders empty/);
});

check("force:true keeps the item and reports the problem instead of throwing", () => {
  const ctx = withSvg(BROKEN, { width: 15906, height: 5654 });
  const r = ctx.OPS.import_footage({ path: "/tmp/icon.svg", force: true });
  assert.equal(r.itemId, 7);
  assert.equal(r.validation.ok, false);
  assert.match(r.warning, /renders empty/);
  assert.match(r.warning, /Workarounds/);
  assert.deepEqual(REMOVED, [], "force must not remove the item");
});

check("treats zero dimensions as broken however the viewBox reads", () => {
  const ctx = withSvg(HEALTHY, { width: 0, height: 0 });
  assert.throws(() => ctx.OPS.import_footage({ path: "/tmp/icon.svg" }), /dimensions 0x0/);
  assert.deepEqual(REMOVED, ["icon.svg"]);
});

check("an SVG with no viewBox is passed through, and says why it was not checked", () => {
  const ctx = withSvg('<svg width="100" height="100"><rect/></svg>', { width: 100, height: 100 });
  const r = ctx.OPS.import_footage({ path: "/tmp/icon.svg" });
  assert.equal(r.validation.checked, false);
  assert.match(r.validation.reason, /no viewBox/);
});

check("parses the viewBox forms SVG actually allows", () => {
  // Commas, extra whitespace, negative origin, single quotes, a newline inside
  // the tag — all legal, and all things a stricter regex would miss and then
  // silently skip the check for.
  const forms = [
    "viewBox='-10,-10, 200 , 100'",
    'viewBox="  0   0   200   100  "',
    'viewBox="0,0,200,100"',
    'viewBox="0 0 200\n100"',
  ];
  for (const attr of forms) {
    const ctx = withSvg(`<svg ${attr}><path/></svg>`, { width: 400, height: 200 });
    const r = ctx.OPS.import_footage({ path: "/tmp/icon.svg" });
    assert.equal(r.validation.checked, true, `should have parsed ${attr}`);
    assert.equal(r.validation.ok, true, `${attr} is 2:1 and 400x200 is too`);
    assert.equal(r.validation.expectedAspect, 2);
  }
});

check("only checks .svg — a PNG that AE resized is not this bug", () => {
  FILES = new Map([["/tmp/pic.png", "\x89PNG"]]);
  IMPORT_RESULT = { id: 9, name: "pic.png", width: 100, height: 900 };
  const ctx = makeContext();
  const r = ctx.OPS.import_footage({ path: "/tmp/pic.png" });
  assert.equal(r.validation, undefined, "non-SVG imports must not carry an SVG verdict");
});

check("renames when asked, and reports a still as a still", () => {
  const ctx = withSvg(HEALTHY, { width: 512, height: 512, duration: 0 });
  const r = ctx.OPS.import_footage({ path: "/tmp/icon.svg", name: "Chrome icon" });
  assert.equal(r.name, "Chrome icon");
  assert.equal(r.isStill, true);
});

check("refuses a path that is not there, before importing anything", () => {
  FILES = new Map();
  IMPORT_RESULT = { id: 1, name: "x", width: 1, height: 1 };
  const ctx = makeContext();
  assert.throws(() => ctx.OPS.import_footage({ path: "/tmp/missing.svg" }), /No file at \/tmp\/missing\.svg/);
});

check("refuses when AE returns no item at all", () => {
  const ctx = withSvg(HEALTHY, null);
  assert.throws(() => ctx.OPS.import_footage({ path: "/tmp/icon.svg" }), /returned no item/);
});

console.log(`svg-import: ${passed} checks passed`);
