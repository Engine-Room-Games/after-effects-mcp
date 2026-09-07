// delete_comp's purgeUnusedSolids and purge_unused_footage, out of
// packages/jsx/comps.jsx and packages/jsx/footage.jsx (issue #83).
//
// A solid layer's source is a FootageItem in the project's Solids folder, and
// removing the comp removes the layer but not the item. The two ops here are
// the two ways of cleaning that up, and every property that makes them safe
// is invisible from a screenshot or a layer read:
//
//   - delete_comp only ever considers the solids ITS OWN layers used. A solid
//     some other comp shares is kept, and the comps keeping it are named.
//     Solids nobody uses that belonged to other work are never touched by it.
//   - purge_unused_footage decides by AE's `usedIn`, on footage only. A nested
//     comp nothing uses any more is not footage and must survive; so must a
//     folder. `solidsOnly:false` widens it to files and placeholders — AE's own
//     Remove Unused Footage — and never further.
//   - Items are collected in one pass and removed in a second, highest index
//     first, so no removal shifts an item still to be visited.
//   - A dryRun removes nothing and is not an undo step. A failure part-way
//     names the item, what went before it and what was never attempted,
//     because nothing rolls back.
//
// Both ops run through the real `dispatch` from core.jsx, so the undo grouping
// is under test as well. There is no ExtendScript runtime on a runner, so After
// Effects is stubbed down to what the walks actually use: the project's item
// list, `usedIn` computed from the comps' layers, `mainSource` typed with the
// same constructors the .jsx tests against, and `remove()`.
//
//   node tests/unit/purge-footage.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`purge-footage FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// A fresh fake project per case: these tests mutate it.
function load() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `
    function CompItem() {}
    function FolderItem() {}
    function FootageItem() {}
    function AVLayer() {}
    function CameraLayer() {}
    function SolidSource() {}
    function FileSource() {}
    function PlaceholderSource() {}

    var NEXT_ID = 1000;
    var ITEMS = [];
    var FAIL_ON = {};       // item name -> true: remove() throws AE-style
    var REMOVAL_LOG = [];   // {name, index}: the project index at the moment of removal
    var UNDO = [];

    var ROOT = new FolderItem();
    ROOT.id = 1; ROOT.name = "Root"; ROOT.parentFolder = null;

    function indexOf(it) {
      for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i] === it) return i + 1;
      return -1;
    }
    function addItem(it, folder) {
      it.parentFolder = folder || ROOT;
      ITEMS.push(it);
      return it;
    }
    function removeSelf(it) {
      if (FAIL_ON[it.name]) throw new Error("After Effects refused to remove " + it.name);
      var idx = indexOf(it);
      if (idx < 0) throw new Error("Object is invalid");
      REMOVAL_LOG.push({ name: it.name, index: idx });
      ITEMS.splice(idx - 1, 1);
    }
    // AE's AVItem.usedIn: the comps that place this item, read fresh each time.
    function compsUsing(it) {
      var out = [];
      for (var i = 0; i < ITEMS.length; i++) {
        var c = ITEMS[i];
        if (!(c instanceof CompItem)) continue;
        for (var j = 0; j < c._layers.length; j++) {
          if (c._layers[j].source === it) { out.push(c); break; }
        }
      }
      return out;
    }
    function avItem(it) {
      Object.defineProperty(it, "usedIn", { get: function () { return compsUsing(it); } });
      it.remove = function () { removeSelf(it); };
      return it;
    }

    function mkFolder(name, parent) {
      var f = new FolderItem();
      f.id = ++NEXT_ID; f.name = name;
      f.remove = function () { removeSelf(f); };
      return addItem(f, parent);
    }
    function mkSolid(name, folder) {
      var f = new FootageItem();
      f.id = ++NEXT_ID; f.name = name;
      f.mainSource = new SolidSource();
      f.mainSource.color = [1, 0, 0];
      f.footageMissing = false;
      return addItem(avItem(f), folder);
    }
    function mkFile(name, fsPath, folder, missing) {
      var f = new FootageItem();
      f.id = ++NEXT_ID; f.name = name;
      f.mainSource = new FileSource();
      f.mainSource.file = { fsName: fsPath };
      f.footageMissing = !!missing;
      return addItem(avItem(f), folder);
    }
    function mkPlaceholder(name, folder) {
      var f = new FootageItem();
      f.id = ++NEXT_ID; f.name = name;
      f.mainSource = new PlaceholderSource();
      f.footageMissing = false;
      return addItem(avItem(f), folder);
    }
    function mkLayer(name, source, ctor) {
      var l = new (ctor || AVLayer)();
      l.name = name;
      l.source = source || null;
      return l;
    }
    function mkComp(name, layers, folder) {
      var c = new CompItem();
      c.id = ++NEXT_ID; c.name = name;
      c.width = 1920; c.height = 1080; c.pixelAspect = 1;
      c.duration = 10; c.frameRate = 30;
      c.workAreaStart = 0; c.workAreaDuration = 10;
      c.bgColor = [0, 0, 0];
      c._layers = layers || [];
      c.numLayers = c._layers.length;
      c.layer = function (i) { return c._layers[i - 1]; };
      return addItem(avItem(c), folder);
    }

    var app = {
      beginUndoGroup: function (n) { UNDO.push("begin:" + n); },
      endUndoGroup: function () { UNDO.push("end"); },
      project: {
        get numItems() { return ITEMS.length; },
        item: function (i) { return ITEMS[i - 1]; },
        itemByID: function (id) {
          for (var i = 0; i < ITEMS.length; i++) { if (ITEMS[i].id === id) return ITEMS[i]; }
          return null;
        }
      }
    };

    function has(it) { return indexOf(it) > 0; }
    function names() { var out = []; for (var i = 0; i < ITEMS.length; i++) out.push(ITEMS[i].name); return out; }
    `,
    ctx,
  );
  // core.jsx for dispatch/noUndoWhen, comps.jsx for delete_comp and __folderArg,
  // footage.jsx for the purge and the helpers both share, explore.jsx for
  // __itemKind. In the shipped bundle all of them share one scope.
  for (const f of ["core.jsx", "ids.jsx", "comps.jsx", "footage.jsx", "explore.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, ctx);
  // Arrays and objects come out of the VM with that realm's prototypes, which
  // strict deepEqual refuses; anything compared as data takes a JSON round trip.
  const data = (expr) => JSON.parse(JSON.stringify(get(expr)));
  const call = (op, args) => JSON.parse(JSON.stringify(get("dispatch")(JSON.stringify({ op, args }))));
  const success = (r) => { assert.equal(r.ok, true, `expected success, got: ${r.error}`); return r.result; };
  const failure = (r) => { assert.equal(r.ok, false, `expected a failure, got: ${JSON.stringify(r.result)}`); return r.error; };
  const undo = () => data("UNDO.slice(0)");
  return { ctx, get, data, call, success, failure, undo };
}

// The standard project. Two comps sharing a solid, a solid each of their own,
// two orphaned solids (one in a subfolder), an imported file used by comp A and
// by a nested comp, an unused file, an offline file, a placeholder, and a nested
// comp nothing uses. Item indices follow creation order.
function fixture(ctx) {
  vm.runInContext(
    `
    var solidsFolder = mkFolder("Solids");
    var sub = mkFolder("Old", solidsFolder);
    var S1 = mkSolid("Red Solid 1", solidsFolder);      // A only, on two layers
    var S2 = mkSolid("Shared Solid", solidsFolder);     // A and B
    var S3 = mkSolid("B Only Solid", solidsFolder);     // B only
    var U1 = mkSolid("Orphan Solid 1", solidsFolder);   // nobody
    var U2 = mkSolid("Orphan Solid 2", sub);            // nobody, nested folder
    var F1 = mkFile("logo.png", "/art/logo.png");       // A and Nested
    var F2 = mkFile("unused.mov", "/art/unused.mov");   // nobody
    var F3 = mkFile("missing.wav", "/snd/missing.wav", ROOT, true); // nobody, offline
    var P1 = mkPlaceholder("Placeholder");              // nobody
    var N = mkComp("Nested", [mkLayer("art", F1)]);     // used by A
    var LOOSE = mkComp("Loose", []);                    // a comp nobody uses
    var A = mkComp("A", [
      mkLayer("bg", S1), mkLayer("bg again", S1), mkLayer("shared", S2),
      mkLayer("logo", F1), mkLayer("nested", N), mkLayer("cam", null, CameraLayer)
    ]);
    var B = mkComp("B", [mkLayer("shared", S2), mkLayer("own", S3)]);
    `,
    ctx,
  );
}

// ===========================================================================
// delete_comp
// ===========================================================================

check("delete_comp by default leaves the solids and says so", () => {
  const { ctx, get, data, call, success, undo } = load();
  fixture(ctx);
  const res = success(call("delete_comp", { compId: get("A.id") }));

  eq(get("has(A)"), false, "the comp is gone");
  eq(res.ok, true);
  eq(res.name, "A", "the result names what it deleted");
  eq(res.unusedSolidsLeft, 1, "S1 is now used by nothing; S2 is still B's");
  ok(/purgeUnusedSolids:true/.test(res.note) && /purge_unused_footage/.test(res.note), "and both ways of cleaning up are named");
  eq(res.removedSolids, undefined, "nothing claims to have been removed");
  eq(get("has(S1) && has(S2) && has(U1) && has(U2) && has(F1) && has(N)"), true, "every project item survives");
  eq(undo(), ["begin:AE MCP: delete_comp", "end"], "one undo step");
});

check("delete_comp with no unused solids reports zero and no note", () => {
  const { ctx, get, data, call, success } = load();
  fixture(ctx);
  const res = success(call("delete_comp", { compId: get("B.id") }));
  // S3 was B's alone, so one is left over; run it on Loose instead for the zero case.
  eq(res.unusedSolidsLeft, 1);
  const res2 = success(call("delete_comp", { compId: get("LOOSE.id") }));
  eq(res2.unusedSolidsLeft, 0);
  eq(res2.note, undefined, "nothing to point at, so no note");
});

check("purgeUnusedSolids removes this comp's orphaned solids and only those", () => {
  const { ctx, get, data, call, success, undo } = load();
  fixture(ctx);
  const ids = data("({ S1: S1.id, S2: S2.id, B: B.id })");
  const res = success(call("delete_comp", { compId: get("A.id"), purgeUnusedSolids: true }));

  eq(get("has(A)"), false, "the comp is gone");
  eq(res.removedSolids, [{ id: ids.S1, name: "Red Solid 1", kind: "solid" }], "S1 was A's alone, listed once though two layers used it");
  eq(res.keptSolids, [{ id: ids.S2, name: "Shared Solid", usedIn: [{ id: ids.B, name: "B" }] }], "S2 is kept, and the comp keeping it is named");
  ok(/kept because another comp still uses them/.test(res.note), "the keep is explained");
  eq(res.unusedSolidsLeft, undefined, "nothing is left behind, so the count is not there to mislead");

  eq(get("has(S1)"), false, "S1 really is gone");
  eq(get("has(S2) && has(S3)"), true, "S2 (shared) and S3 (B's) survive");
  eq(get("has(U1) && has(U2)"), true, "orphans that were never A's are not this op's business");
  eq(get("has(F1) && has(F2) && has(P1)"), true, "files and placeholders are not solids");
  eq(get("has(N) && has(LOOSE)"), true, "a nested comp is never footage, used or not");
  eq(get("has(solidsFolder) && has(sub)"), true, "folders survive");
  eq(undo(), ["begin:AE MCP: delete_comp", "end"], "the comp and its solids go in one undo step");
});

check("purgeUnusedSolids on a comp with no solids reports empty lists", () => {
  const { ctx, get, data, call, success } = load();
  fixture(ctx);
  const res = success(call("delete_comp", { compId: get("LOOSE.id"), purgeUnusedSolids: true }));
  eq(res.removedSolids, []);
  eq(res.keptSolids, []);
  eq(res.note, undefined);
});

check("delete_comp on an unknown comp removes nothing", () => {
  const { ctx, get, data, call, failure } = load();
  fixture(ctx);
  const before = data("names()");
  const msg = failure(call("delete_comp", { compId: 424242, purgeUnusedSolids: true }));
  ok(/No comp with id 424242/.test(msg), msg);
  eq(data("names()"), before, "the project is untouched");
});

check("a purge that fails part-way says the comp is gone, what went, and what did not", () => {
  const { ctx, get, data, call, failure } = load();
  fixture(ctx);
  vm.runInContext(
    `
    var S1b = mkSolid("A Second Solid", solidsFolder);
    var S1c = mkSolid("A Third Solid", solidsFolder);
    A._layers.push(mkLayer("second", S1b), mkLayer("third", S1c));
    A.numLayers = A._layers.length;
    FAIL_ON["A Second Solid"] = true;
    `,
    ctx,
  );
  const msg = failure(call("delete_comp", { compId: get("A.id"), purgeUnusedSolids: true }));

  ok(/removed comp "A"/.test(msg), "the comp deletion is reported as done");
  ok(/failed purging its solids at "A Second Solid"/.test(msg), "the failing item is named");
  ok(/refused to remove A Second Solid/.test(msg), "with AE's own reason");
  ok(/Removed before it: "Red Solid 1"/.test(msg), "what went before it is listed");
  ok(/Not attempted: "A Third Solid"/.test(msg), "and what was never attempted");
  ok(/do not call delete_comp for it again/.test(msg), "so the agent does not retry a delete that already happened");
  ok(/One Undo/.test(msg), "and knows one Undo backs the whole step out");
  eq(get("has(A)"), false, "the comp really is gone");
  eq(get("has(S1)"), false, "S1 really was removed");
  eq(get("has(S1b) && has(S1c)"), true, "the failed one and the unattempted one really remain");
});

// ===========================================================================
// purge_unused_footage
// ===========================================================================

check("the default sweep removes unused solids and nothing else", () => {
  const { ctx, get, data, call, success, undo } = load();
  fixture(ctx);
  const ids = data("({ U1: U1.id, U2: U2.id })");
  const res = success(call("purge_unused_footage", {}));

  eq(res.solidsOnly, true);
  eq(res.scanned, 5, "five solids in the project");
  eq(res.inUse, 3, "S1, S2, S3 are placed somewhere");
  eq(res.removedCount, 2);
  eq(res.removed, [
    { id: ids.U2, name: "Orphan Solid 2", kind: "solid" },
    { id: ids.U1, name: "Orphan Solid 1", kind: "solid" },
  ], "the two orphans, highest project index first");
  ok(/Removed 2 unused solids in the project, as one undo step/.test(res.note), res.note);
  eq(res.dryRun, undefined);
  eq(res.wouldRemove, undefined, "a real run does not speak in the conditional");

  eq(get("has(U1) || has(U2)"), false, "both orphans are gone");
  eq(get("has(S1) && has(S2) && has(S3)"), true, "used solids stay");
  eq(get("has(F2) && has(F3) && has(P1)"), true, "unused files and placeholders are not solids");
  eq(get("has(N) && has(LOOSE) && has(A) && has(B)"), true, "no comp is touched, used or not");
  eq(get("has(solidsFolder) && has(sub)"), true, "no folder is touched");
  eq(undo(), ["begin:AE MCP: purge_unused_footage", "end"], "one undo step");
});

check("removal order is highest project index first", () => {
  const { ctx, get, data, call, success } = load();
  fixture(ctx);
  vm.runInContext(`for (var k = 0; k < 6; k++) mkSolid("Late orphan " + k, solidsFolder);`, ctx);
  success(call("purge_unused_footage", {}));
  const log = data("REMOVAL_LOG.slice(0)");
  eq(log.length, 8);
  for (let i = 1; i < log.length; i++) {
    ok(log[i].index < log[i - 1].index, `removal ${i} at index ${log[i].index} after ${log[i - 1].index}`);
  }
});

check("solidsOnly:false is AE's Remove Unused Footage: files and placeholders too, never a comp", () => {
  const { ctx, get, data, call, success } = load();
  fixture(ctx);
  const ids = data("({ U1: U1.id, U2: U2.id, F2: F2.id, F3: F3.id, P1: P1.id })");
  const res = success(call("purge_unused_footage", { solidsOnly: false }));

  eq(res.solidsOnly, false);
  eq(res.scanned, 9, "five solids, three files, one placeholder");
  eq(res.inUse, 4, "S1, S2, S3 and logo.png");
  eq(res.removed, [
    { id: ids.P1, name: "Placeholder", kind: "placeholder" },
    { id: ids.F3, name: "missing.wav", kind: "footage", footageMissing: true },
    { id: ids.F2, name: "unused.mov", kind: "footage" },
    { id: ids.U2, name: "Orphan Solid 2", kind: "solid" },
    { id: ids.U1, name: "Orphan Solid 1", kind: "solid" },
  ], "every unused footage item, each with its kind, the offline one flagged");
  eq(get("has(F1)"), true, "logo.png is kept: comp A and the nested comp both place it");
  eq(get("has(N) && has(LOOSE)"), true, "a nested comp with no uses is not footage and survives");
  eq(get("has(solidsFolder) && has(sub)"), true, "folders survive");
});

check("dryRun lists exactly what a real run then removes, and is not an undo step", () => {
  const { ctx, get, data, call, success, undo } = load();
  fixture(ctx);
  const before = data("names()");
  const dry = success(call("purge_unused_footage", { dryRun: true, solidsOnly: false }));

  eq(dry.dryRun, true);
  eq(dry.scanned, 9);
  eq(dry.inUse, 4);
  eq(dry.wouldRemoveCount, 5);
  eq(dry.removed, undefined, "a dry run never says 'removed'");
  eq(dry.removedCount, undefined);
  ok(/Nothing was removed and this call is not an undo step/.test(dry.note), dry.note);
  ok(/Call again without dryRun to remove these 5 footage items/.test(dry.note), dry.note);
  eq(data("names()"), before, "the project is byte-for-byte what it was");
  eq(undo(), [], "and the undo stack was never touched");

  const real = success(call("purge_unused_footage", { solidsOnly: false }));
  eq(real.removed, dry.wouldRemove, "the plan was the truth");
  eq(undo(), ["begin:AE MCP: purge_unused_footage", "end"]);
});

check("nothing to remove is said plainly, in both modes", () => {
  const { ctx, get, data, call, success } = load();
  fixture(ctx);
  success(call("purge_unused_footage", {}));
  const again = success(call("purge_unused_footage", {}));
  eq(again.removed, []);
  eq(again.removedCount, 0);
  eq(again.scanned, 3);
  eq(again.inUse, 3);
  ok(/Nothing to remove: every solid in the project is still used in a comp/.test(again.note), again.note);

  const dry = success(call("purge_unused_footage", { dryRun: true }));
  eq(dry.wouldRemove, []);
  ok(/Nothing to remove/.test(dry.note) && /not an undo step/.test(dry.note), dry.note);

  // An empty project says why differently: there was nothing to scan.
  const empty = load();
  const res = empty.success(empty.call("purge_unused_footage", {}));
  eq(res.scanned, 0);
  ok(/no solids in the project/.test(res.note), res.note);
  eq(empty.get("ITEMS.length"), 0);
});

check("folderId restricts the sweep to that folder and everything under it", () => {
  const { ctx, get, data, call, success } = load();
  fixture(ctx);
  const ids = data("({ U1: U1.id, U2: U2.id, sub: sub.id, solids: solidsFolder.id })");

  const inner = success(call("purge_unused_footage", { dryRun: true, folderId: ids.sub }));
  eq(inner.folderId, ids.sub);
  eq(inner.folderName, "Old");
  eq(inner.scanned, 1, "only the subfolder's one solid is scanned");
  eq(inner.wouldRemove.map((r) => r.id), [ids.U2]);
  ok(/in folder "Old"/.test(inner.note), inner.note);

  const outer = success(call("purge_unused_footage", { folderId: ids.solids, solidsOnly: false }));
  eq(outer.scanned, 5, "the Solids folder and its subfolder, nothing at the root");
  eq(outer.removed.map((r) => r.id), [ids.U2, ids.U1], "both orphans, the nested one included");
  eq(get("has(F2) && has(F3) && has(P1)"), true, "root-level unused footage is outside the folder and untouched");
});

check("folderId that is not a folder is refused, naming what it is, with nothing removed", () => {
  const { ctx, get, data, call, failure } = load();
  fixture(ctx);
  const before = data("names()");
  const msg = failure(call("purge_unused_footage", { folderId: get("A.id") }));
  ok(/not a project folder/.test(msg) && /"A"/.test(msg) && /is a comp/.test(msg), msg);
  const msg2 = failure(call("purge_unused_footage", { folderId: 999999 }));
  ok(/No project item with id 999999/.test(msg2), msg2);
  eq(data("names()"), before, "nothing was removed on the way to either error");
});

check("a sweep that fails part-way names the item, what went before it and what was not attempted", () => {
  const { ctx, get, data, call, failure } = load();
  fixture(ctx);
  // Highest index first, so U2 goes and U1 — the next — fails.
  vm.runInContext(`FAIL_ON["Orphan Solid 1"] = true;`, ctx);
  const msg = failure(call("purge_unused_footage", {}));
  ok(/stopped at "Orphan Solid 1" \(id \d+, solid\)/.test(msg), msg);
  ok(/refused to remove Orphan Solid 1/.test(msg), "with AE's own reason");
  ok(/1 item\(s\) were removed before it: "Orphan Solid 2"/.test(msg), msg);
  ok(/0 unused item\(s\) were not attempted/.test(msg), msg);
  ok(/one Undo in After Effects restores what this call removed/.test(msg), msg);
  eq(get("has(U2)"), false, "the one before the failure really went");
  eq(get("has(U1)"), true, "the one that failed really stayed");

  // And the other way round: the first attempt fails, nothing went, one pending.
  const w2 = load();
  fixture(w2.ctx);
  vm.runInContext(`FAIL_ON["Orphan Solid 2"] = true;`, w2.ctx);
  const msg2 = w2.failure(w2.call("purge_unused_footage", {}));
  ok(/stopped at "Orphan Solid 2"/.test(msg2), msg2);
  ok(/Nothing had been removed yet/.test(msg2), msg2);
  ok(/1 unused item\(s\) were not attempted/.test(msg2), msg2);
  eq(w2.get("has(U1) && has(U2)"), true, "both orphans remain");
});

check("the source stays ES3-ish", () => {
  for (const f of ["comps.jsx", "footage.jsx"]) {
    // Comments may say anything; the code may not.
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of [/\blet\s/, /\bconst\s/, /=>/, /`/, /Object\.keys\(/]) {
      ok(!bad.test(src), `${f} uses ${bad} which ExtendScript does not have`);
    }
  }
});

// ---------- the schema the client sees ----------
{
  const { DeleteComp, PurgeUnusedFootage, OpSchemas, OpMutation } = await import(
    pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href
  );
  check("DeleteComp is strict and purgeUnusedSolids is optional", () => {
    ok(DeleteComp.safeParse({ compId: 1 }).success);
    ok(DeleteComp.safeParse({ compId: 1, purgeUnusedSolids: true }).success);
    ok(!DeleteComp.safeParse({ compId: 1, purgeSolids: true }).success, "an unknown key is refused, not stripped");
  });
  check("PurgeUnusedFootage is strict and every field is optional", () => {
    ok(PurgeUnusedFootage.safeParse({}).success);
    ok(PurgeUnusedFootage.safeParse({ solidsOnly: false, dryRun: true, folderId: 12 }).success);
    ok(!PurgeUnusedFootage.safeParse({ folder: 12 }).success);
    ok(!PurgeUnusedFootage.safeParse({ solidsOnly: "yes" }).success);
  });
  check("purge_unused_footage is registered and classified as a write", () => {
    ok(OpSchemas.purge_unused_footage === PurgeUnusedFootage);
    eq(OpMutation.purge_unused_footage, "write");
  });
}

console.log(`purge-footage: ${passed} assertions passed`);
