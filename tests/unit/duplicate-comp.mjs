// duplicate_comp, out of packages/jsx/comps.jsx.
//
// AE's own CompItem.duplicate() is SHALLOW: the copy's precomp layers point at
// the same nested comps as the original, so "make a variant of this rig" and
// then editing the variant silently edits the original too. `deep:true` is
// where all the risk lives, and three of its failure modes are invisible in a
// screenshot:
//
//   - Fan-out. The same nested comp usually appears on several layers. A naive
//     walk duplicates it once per reference and the variant ends up with three
//     unrelated copies of one beat comp.
//   - Cycles. The `seen` map is the guard, and the copy has to be registered
//     BEFORE recursing into it or a cycle recurses for ever.
//   - Half-success. If a nested duplication fails part-way, the comps already
//     created are real and nothing rolled them back. Reporting {ok:true} over
//     that, or an error that does not name what exists, is the same class of
//     lie as swallowing the error.
//
// There is no ExtendScript runtime on a runner, so After Effects is stubbed
// down to what the walk actually uses: duplicate(), layer(i), source,
// replaceSource() and the project's item list.
//
//   node tests/unit/duplicate-comp.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

// A fresh fake project per case: these tests mutate it.
function load() {
  const ctx = { OPS: {}, noUndo: (fn) => fn, noUndoWhen: (p, fn) => fn, undoNamed: (n, fn) => fn };
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FolderItem() {}
    function FootageItem() {}
    function AVLayer() {}
    function TextLayer() {}
    function ShapeLayer() {}
    function CameraLayer() {}
    function LightLayer() {}

    var NEXT_ID = 1000;
    var ITEMS = [];
    var FAIL_ON = null;          // name of a comp whose duplicate() should throw

    function addItem(it) { ITEMS.push(it); return it; }

    function mkLayer(name, source) {
      var l = new AVLayer();
      l.name = name;
      l.source = source || null;
      l.replaceSource = function (next, fixExpressions) {
        l.source = next;
        l.fixExpressions = fixExpressions;
      };
      return l;
    }

    function mkFolder(name) {
      var f = new FolderItem();
      NEXT_ID += 1;
      f.id = NEXT_ID;
      f.name = name;
      return addItem(f);
    }

    function mkFootage(name) {
      var f = new FootageItem();
      NEXT_ID += 1;
      f.id = NEXT_ID;
      f.name = name;
      return addItem(f);
    }

    function mkComp(name, layers) {
      var c = new CompItem();
      NEXT_ID += 1;
      c.id = NEXT_ID;
      c.name = name;
      c.width = 1920; c.height = 1080; c.pixelAspect = 1;
      c.duration = 10; c.frameRate = 30;
      c.workAreaStart = 0; c.workAreaDuration = 10;
      c.bgColor = [0, 0, 0];
      c.parentFolder = null;
      c._layers = layers || [];
      c.numLayers = c._layers.length;
      c.layer = function (i) { return c._layers[i - 1]; };
      // AE's duplicate: a new comp with new layers pointing at the SAME sources.
      c.duplicate = function () {
        if (FAIL_ON === c.name) throw new Error("After Effects refused to duplicate " + c.name);
        var copies = [];
        for (var i = 0; i < c._layers.length; i++) copies.push(mkLayer(c._layers[i].name, c._layers[i].source));
        return mkComp(c.name + " 2", copies);
      };
      return addItem(c);
    }

    var app = {
      project: {
        get numItems() { return ITEMS.length; },
        item: function (i) { return ITEMS[i - 1]; },
        itemByID: function (id) {
          for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) return ITEMS[i]; }
          return null;
        }
      }
    };

    function comps() {
      var out = [];
      for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i] instanceof CompItem) out.push(ITEMS[i]); }
      return out;
    }
    function byName(name) {
      var hits = [];
      for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].name === name) hits.push(ITEMS[i]); }
      return hits;
    }
    `,
    ctx,
  );
  vm.runInContext(read("ids.jsx"), ctx, { filename: "ids.jsx" });
  vm.runInContext(read("comps.jsx"), ctx, { filename: "comps.jsx" });
  vm.runInContext(read("explore.jsx"), ctx, { filename: "explore.jsx" });
  const run = (args) => JSON.parse(JSON.stringify(vm.runInContext("OPS.duplicate_comp", ctx)(args)));
  return { ctx, run, get: (expr) => vm.runInContext(expr, ctx) };
}

// ---------- shallow, the default ----------
{
  const { ctx, run, get } = load();
  vm.runInContext(
    `
    var beat = mkComp("Beat", []);
    var main = mkComp("Main", [mkLayer("beat A", beat), mkLayer("beat B", beat)]);
    `,
    ctx,
  );
  const before = get("comps().length");
  const res = run({ compId: get("main.id") });

  eq(get("comps().length"), before + 1, "exactly one comp is created");
  eq(res.name, "Main 2", "AE's own naming stands when none is given");
  eq(res.fromCompId, get("main.id"), "the source is named in the result");
  ok(typeof res.id === "number", "the new comp id comes back, so nobody has to find it by name");
  eq(res.deep, false);
  eq(res.nestedDuplicated, undefined, "a shallow copy duplicated nothing nested");
  ok(/still point at the SAME nested comps/.test(res.note), "and the sharing is stated, not left to be discovered");

  // The copy's layers still point at the original nested comp — that IS the
  // shallow contract, and the reason deep exists.
  const shared = get(`(function () {
    var dup = app.project.itemByID(${res.id});
    return dup.layer(1).source === beat && dup.layer(2).source === beat;
  })()`);
  eq(shared, true, "shallow means shared, exactly like AE's Duplicate");
}

// ---------- name and folder ----------
{
  const { ctx, run, get } = load();
  vm.runInContext(`var folder = mkFolder("Rigs"); var main = mkComp("Main", []);`, ctx);
  const res = run({ compId: get("main.id"), name: "Scene 4", folderId: get("folder.id") });
  eq(res.name, "Scene 4", "an explicit name is used");
  eq(res.folderName, "Rigs", "and the folder it was filed in is reported");
  eq(get(`app.project.itemByID(${res.id}).parentFolder.name`), "Rigs", "…because it really was moved");
}

// ---------- folderId has to be a folder ----------
{
  const { ctx, get } = load();
  vm.runInContext(`var other = mkComp("Other", []); var main = mkComp("Main", []);`, ctx);
  const call = (args) => vm.runInContext("OPS.duplicate_comp", ctx)(args);

  assert.throws(
    () => call({ compId: get("main.id"), folderId: get("other.id") }),
    (e) => /not a project folder/.test(e.message) && /Other/.test(e.message) && /comp/.test(e.message),
    "a comp id passed as folderId must fail loudly, naming the id and what it actually is",
  );
  passed++;
  assert.throws(
    () => call({ compId: get("main.id"), folderId: 999999 }),
    /No project item with id 999999/,
    "an id that is nothing at all is named too",
  );
  passed++;
  eq(vm.runInContext("comps().length", ctx), 2, "and nothing was created on the way to the error");
}

// ---------- deep: nested comps are duplicated and re-pointed ----------
{
  const { ctx, run, get } = load();
  vm.runInContext(
    `
    var logo = mkFootage("logo.png");
    var inner = mkComp("Inner", [mkLayer("art", logo)]);
    var beat = mkComp("Beat", [mkLayer("inner", inner)]);
    var main = mkComp("Main", [mkLayer("beat", beat), mkLayer("still", logo)]);
    `,
    ctx,
  );
  const res = run({ compId: get("main.id"), name: "Main variant", deep: true });

  eq(res.deep, true);
  eq(res.nestedCount, 2, "Beat and Inner are both duplicated — the walk recurses");
  eq(res.layersRepointed, 2, "one precomp layer in the copy, one in the copy of Beat");

  const wired = get(`(function () {
    var dup = app.project.itemByID(${res.id});
    var newBeat = dup.layer(1).source;
    return {
      beatIsFresh: newBeat !== beat,
      innerIsFresh: newBeat.layer(1).source !== inner,
      footageShared: dup.layer(2).source === logo,
      fixExpressions: dup.layer(1).fixExpressions
    };
  })()`);
  eq(wired.beatIsFresh, true, "the copy points at its own Beat, not the original");
  eq(wired.innerIsFresh, true, "and that copy points at its own Inner — the recursion reaches the bottom");
  eq(wired.footageShared, true, "footage is never duplicated; only comps are");
  eq(wired.fixExpressions, false, "replaceSource must not be allowed to rewrite the rig's expressions");

  const names = res.nestedDuplicated.map((n) => n.fromName).sort();
  eq(names, ["Beat", "Inner"], "every nested duplication is reported, with where it came from");
}

// ---------- deep: the same nested comp on several layers is duplicated once ----------
{
  const { ctx, run, get } = load();
  vm.runInContext(
    `
    var beat = mkComp("Beat", []);
    var main = mkComp("Main", [mkLayer("a", beat), mkLayer("b", beat), mkLayer("c", beat)]);
    `,
    ctx,
  );
  const res = run({ compId: get("main.id"), deep: true });

  eq(res.nestedCount, 1, "one nested comp used three times is duplicated once, not three times");
  eq(res.layersRepointed, 3, "…and all three layers are re-pointed at it");
  const oneSource = get(`(function () {
    var dup = app.project.itemByID(${res.id});
    return dup.layer(1).source === dup.layer(2).source && dup.layer(2).source === dup.layer(3).source;
  })()`);
  eq(oneSource, true, "so the variant shares one beat comp, exactly as the original did");
}

// ---------- deep: a cycle terminates ----------
{
  const { ctx, run, get } = load();
  // AE refuses to nest a comp inside itself, but the guard must not depend on
  // that: the copy is registered before the walk descends into it.
  vm.runInContext(
    `
    var loop = mkComp("Loop", []);
    loop._layers = [mkLayer("self", loop)];
    loop.numLayers = 1;
    var main = mkComp("Main", [mkLayer("loop", loop)]);
    `,
    ctx,
  );
  const res = run({ compId: get("main.id"), deep: true });
  eq(res.nestedCount, 1, "a self-referencing comp is duplicated once and reused, not recursed into for ever");
  passed++;
}

// ---------- deep: nameSuffix, and never two items with the same name ----------
{
  const { ctx, run, get } = load();
  vm.runInContext(
    `
    var beat = mkComp("Beat", []);
    var main = mkComp("Main", [mkLayer("beat", beat)]);
    var collide = mkComp("Beat [v2]", []);
    `,
    ctx,
  );
  const res = run({ compId: get("main.id"), name: "Main [v2]", deep: true, nameSuffix: " [v2]" });
  eq(res.name, "Main [v2]");
  eq(
    res.nestedDuplicated[0].name,
    "Beat [v2] 2",
    "the suffixed name was already taken, so a counter is appended rather than shipping two identical names",
  );
  eq(get(`byName("Beat [v2]").length`), 1, "and the existing item keeps its name");
}

// ---------- deep: a half-built rig is never reported as a success ----------
{
  const { ctx, get } = load();
  vm.runInContext(
    `
    var good = mkComp("Good", []);
    var bad = mkComp("Bad", []);
    var main = mkComp("Main", [mkLayer("good", good), mkLayer("bad", bad)]);
    FAIL_ON = "Bad";
    `,
    ctx,
  );
  const before = get("comps().length");
  assert.throws(
    () => vm.runInContext("OPS.duplicate_comp", ctx)({ compId: get("main.id"), deep: true }),
    (e) =>
      /failed part-way/.test(e.message) &&
      /still exist: ids /.test(e.message) &&
      /Undo once in After Effects/.test(e.message) &&
      /refused to duplicate Bad/.test(e.message),
    "a deep duplication that fails must name what was created, why, and how to back it out",
  );
  passed++;
  eq(get("comps().length"), before + 2, "the copies made before the failure really do still exist");
}

console.log(`duplicate-comp: ${passed} assertions passed`);
