// The comp fingerprint and the diff of two of them, out of packages/jsx/snapshot.jsx.
//
// Verifying a write by reading the comp back costs thousands of tokens, and a
// tool result is re-sent on every later request for the rest of the session
// (issue #52). A fingerprint plus a diff is a few dozen tokens for the same
// answer — but only if three things hold, and all three are easy to get wrong:
//
//   - It stays CHEAP. The walk must never open an effect's parameters or a
//     shape layer's Contents; those are what make get_layer_full expensive, and
//     a fingerprint costing as much as the read it replaces is worth nothing.
//     Probes on the stub count every such access and the test fails on one.
//   - It reports ONLY what changed. Unchanged layers are counted, never listed,
//     and inserting a layer must not report every layer below it as moved just
//     because its index shifted.
//   - It says what it does NOT cover. A diff can only report a field it
//     records, so "no differences" has to be readable as "none of these moved"
//     and never as "identical".
//
// There is no ExtendScript runtime on a runner, so After Effects is stubbed:
// the fingerprint walk needs numProperties/property()/numKeys and nothing else,
// and the diff is pure — two objects in, one out.
//
//   node tests/unit/comp-snapshot.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");

const ctx = { OPS: {}, noUndo: (fn) => fn, noUndoWhen: (p, fn) => fn, undoNamed: (n, fn) => fn };
vm.createContext(ctx);

// A fake After Effects, built inside the VM realm because the sources lean on
// `instanceof` and that compares against this realm's constructors.
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

  // Every read the fingerprint is forbidden to make lands here.
  var PROBE = { effectParams: 0, shapeContents: 0 };

  function leaf(name, opts) {
    var p = { name: name, numKeys: 0, canSetExpression: true, expression: "" };
    if (opts) { for (var k in opts) p[k] = opts[k]; }
    return p;
  }

  function group(kids, onRead) {
    return {
      numProperties: kids.length,
      property: function (i) { if (onRead) onRead(); return kids[i - 1]; }
    };
  }

  // The five 2D transform properties AE gives every layer.
  function transformGroup(overrides) {
    var names = ["Anchor Point", "Position", "Scale", "Rotation", "Opacity"];
    var kids = [];
    for (var i = 0; i < names.length; i++) {
      var o = null;
      if (overrides && overrides[names[i]]) o = overrides[names[i]];
      kids.push(leaf(names[i], o));
    }
    return group(kids, null);
  }

  // Effects, whose parameters must never be walked: reading one trips PROBE.
  function effectsGroup(count) {
    var kids = [];
    for (var i = 0; i < count; i++) kids.push(leaf("Effect " + (i + 1)));
    return group(kids, function () { PROBE.effectParams += 1; });
  }

  function shapeContents() {
    return group([leaf("Group 1")], function () { PROBE.shapeContents += 1; });
  }

  // spec: {id, name, index, in, out, start, parent, enabled, transform,
  //        effects, keys:{Marker:n,...}, exprs:{...}}
  function mkLayer(kind, spec) {
    var ctors = { text: TextLayer, shape: ShapeLayer, camera: CameraLayer, light: LightLayer, av: AVLayer };
    var Ctor = ctors[kind] || AVLayer;
    var l = new Ctor();
    l.id = spec.id;
    l.name = spec.name;
    l.index = spec.index;
    l.inPoint = spec["in"] === undefined ? 0 : spec["in"];
    l.outPoint = spec.out === undefined ? 5 : spec.out;
    l.startTime = spec.start === undefined ? 0 : spec.start;
    l.enabled = spec.enabled === undefined ? true : spec.enabled;
    l.parent = spec.parent || null;
    l.nullLayer = false;
    l.adjustmentLayer = false;
    l.source = spec.source || null;

    var tr = transformGroup(spec.transform || null);
    var extras = spec.extras || {};
    var fx = effectsGroup(spec.effects === undefined ? 0 : spec.effects);
    var contents = shapeContents();
    l.property = function (n) {
      if (n === "Transform") return tr;
      if (n === "Effects") return fx;
      if (n === "Contents") return contents;
      if (extras.hasOwnProperty(n)) return extras[n];
      return null;
    };
    return l;
  }

  function mkComp(spec) {
    var c = new CompItem();
    c.id = spec.id;
    c.name = spec.name;
    c.width = spec.width === undefined ? 1920 : spec.width;
    c.height = spec.height === undefined ? 1080 : spec.height;
    c.duration = spec.duration === undefined ? 10 : spec.duration;
    c.frameRate = spec.frameRate === undefined ? 30 : spec.frameRate;
    c.workAreaStart = spec.workAreaStart === undefined ? 0 : spec.workAreaStart;
    c.workAreaDuration = spec.workAreaDuration === undefined ? 10 : spec.workAreaDuration;
    var layers = spec.layers || [];
    c.numLayers = layers.length;
    c.layer = function (i) { return layers[i - 1]; };
    c.markerProperty = spec.markers || { numKeys: 0, keyTime: function () { return 0; }, keyValue: function () { return {}; } };
    return c;
  }

  var PROJECT = { items: [] };
  var app = {
    project: {
      activeItem: null,
      itemByID: function (id) {
        for (var i = 0; i < PROJECT.items.length; i++) {
          if (PROJECT.items[i].id === id) return PROJECT.items[i];
        }
        return null;
      }
    }
  };
  function setProject(items, active) {
    PROJECT.items = items;
    app.project.activeItem = active || null;
  }
  `,
  ctx,
);

vm.runInContext(read("ids.jsx"), ctx, { filename: "ids.jsx" });
vm.runInContext(read("layers.jsx"), ctx, { filename: "layers.jsx" });
vm.runInContext(read("snapshot.jsx"), ctx, { filename: "snapshot.jsx" });

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

const call = (name) => vm.runInContext(name, ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));
// Rebuilds a host-realm object inside the VM, so the code under test only ever
// sees objects from its own realm.
const intoVm = (v) => vm.runInContext("JSON.parse", ctx)(JSON.stringify(v));
const diff = (a, b) => plain(call("__diffFingerprints")(intoVm(a), intoVm(b)));

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------
{
  vm.runInContext(
    `
    var parentLayer = mkLayer("av", { id: 10, name: "Null", index: 3 });
    var comp = mkComp({
      id: 1, name: "Main", duration: 12, layers: [
        mkLayer("text", {
          id: 11, name: "Title", index: 1, in: 1, out: 4, start: 0.5,
          parent: parentLayer, effects: 2,
          transform: {
            Position: { numKeys: 4 },
            Opacity: { expression: "wiggle(1,10)" }
          },
          extras: {
            Marker: { name: "Marker", numKeys: 2 },
            "Source Text": { name: "Source Text", numKeys: 3, canSetExpression: true, expression: "" }
          }
        }),
        mkLayer("shape", { id: 12, name: "Box", index: 2 }),
        parentLayer
      ]
    });
    setProject([comp], comp);
    `,
    ctx,
  );

  const fp = plain(call("__compFingerprint")(1));

  eq(fp.compId, 1, "the comp id travels with the fingerprint");
  eq(fp.name, "Main");
  eq(fp.duration, 12);
  eq(fp.layers.length, 3, "one entry per layer");

  const title = fp.layers[0];
  eq(title.id, 11);
  eq(title.name, "Title");
  eq(title.index, 1);
  eq(title.type, "text", "the real __layerKind decides the type, not the fingerprint");
  eq([title.inPoint, title.outPoint, title.startTime], [1, 4, 0.5], "timing is recorded");
  eq(title.parentId, 10, "parenting is recorded by id, never by index");
  eq(title.enabled, true);
  eq(title.effectCount, 2, "effects are counted");
  eq(title.expressionCount, 1, "an expression on a Transform property is counted");
  eq(
    title.keyCounts,
    { Position: 4, Marker: 2, "Source Text": 3 },
    "only properties that actually carry keyframes are listed",
  );
  eq(fp.layers[1].keyCounts, {}, "a layer with no animation carries no key counts at all");
  eq(fp.layers[2].parentId, null, "an unparented layer records null, not a missing key");

  // The reason this is a fingerprint and not a read.
  eq(call("PROBE").effectParams, 0, "an effect's parameters must never be walked");
  eq(call("PROBE").shapeContents, 0, "a shape layer's Contents must never be walked");
  ok(JSON.stringify(fp).length < 1200, `a three-layer fingerprint should be small: ${JSON.stringify(fp).length} bytes`);
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

// A minimal synthetic fingerprint, so each case below changes exactly one thing.
const layer = (over = {}) => ({
  id: 100, name: "L", index: 1, type: "shape",
  inPoint: 0, outPoint: 5, startTime: 0, parentId: null, enabled: true,
  keyCounts: {}, expressionCount: 0, effectCount: 0,
  ...over,
});
const comp = (layers, over = {}) => ({
  compId: 7, name: "Main", width: 1920, height: 1080,
  duration: 10, frameRate: 30, workAreaStart: 0, workAreaDuration: 10,
  numLayers: layers.length, markers: [], layers,
  ...over,
});

// ---------- nothing changed ----------
{
  const base = comp([layer({ id: 100 }), layer({ id: 101, index: 2 })]);
  const d = diff(base, base);
  eq(d.changeCount, 0, "an unchanged comp has no changes");
  eq(d.added, undefined, "empty buckets are omitted, not sent as []");
  eq(d.removed, undefined);
  eq(d.changed, undefined);
  eq(d.reordered, undefined);
  eq(d.unchangedLayers, 2, "unchanged layers are counted, never listed");
  ok(/No differences in the recorded fields/.test(d.summary), "the summary has to say so in words");
  ok(/not compared/.test(d.summary), '"no differences" must never read as "identical"');
  ok(/not property values/.test(d.covers), "every diff carries what it does not cover");
}

// ---------- layers added ----------
{
  const before = comp([layer({ id: 498 })]);
  const after = comp([
    layer({ id: 498 }),
    layer({ id: 512, name: "a", index: 2 }),
    layer({ id: 513, name: "b", index: 3 }),
    layer({ id: 514, name: "c", index: 4 }),
  ]);
  const d = diff(before, after);
  eq(d.added.map((a) => a.id), [512, 513, 514], "the new ids are named");
  eq(d.added[0].name, "a", "…with their names, so a copyToComp result is identifiable");
  eq(d.changed, undefined, "adding a layer changes nothing about the others");
  ok(/3 layers added: ids 512-514/.test(d.summary), `consecutive ids collapse to a range: ${d.summary}`);
}

// ---------- layers removed ----------
{
  const before = comp([layer({ id: 1 }), layer({ id: 2, index: 2 }), layer({ id: 3, index: 3 })]);
  const after = comp([layer({ id: 1 }), layer({ id: 3, index: 2 })]);
  const d = diff(before, after);
  eq(d.removed.map((r) => r.id), [2], "the removed layer is named");
  eq(d.added, undefined);
  eq(d.reordered, undefined, "removing a layer is not a reorder of the survivors");
  ok(/1 layer removed: ids 2/.test(d.summary), d.summary);
}

// ---------- the per-layer fields ----------
{
  const cases = [
    ["renamed", { name: "after" }, (c) => eq(c.name, { from: "L", to: "after" }), /renamed "L" -> "after"/],
    ["retimed in", { inPoint: 1.5 }, (c) => eq(c.inPoint, { from: 0, to: 1.5 }), /retimed \(in 0 -> 1\.5\)/],
    ["retimed out", { outPoint: 9 }, (c) => eq(c.outPoint, { from: 5, to: 9 }), /retimed \(out 5 -> 9\)/],
    ["slipped", { startTime: 2 }, (c) => eq(c.startTime, { from: 0, to: 2 }), /retimed \(start 0 -> 2\)/],
    ["re-parented", { parentId: 12 }, (c) => eq(c.parentId, { from: null, to: 12 }), /re-parented none -> 12/],
    ["disabled", { enabled: false }, (c) => eq(c.enabled, { from: true, to: false }), /layer 100 disabled/],
    ["effects added", { effectCount: 2 }, (c) => eq(c.effectCount, { from: 0, to: 2 }), /effects 0 -> 2/],
    ["expression added", { expressionCount: 1 }, (c) => eq(c.expressionCount, { from: 0, to: 1 }), /expressions 0 -> 1/],
  ];
  for (const [label, over, check, phrase] of cases) {
    const d = diff(comp([layer()]), comp([layer(over)]));
    eq(d.changeCount, 1, `${label}: exactly one change`);
    eq(d.changed.length, 1, `${label}: one layer changed`);
    eq(d.changed[0].id, 100, `${label}: identified by id`);
    check(d.changed[0].changes);
    ok(phrase.test(d.summary), `${label}: the summary should read "${phrase}", got "${d.summary}"`);
  }
}

// ---------- keyframe counts ----------
{
  const d = diff(
    comp([layer({ id: 498, keyCounts: { Position: 2 } })]),
    comp([layer({ id: 498, keyCounts: { Position: 2, Opacity: 4 } })]),
  );
  eq(d.changed[0].changes.keyCounts, { Opacity: { from: 0, to: 4 } }, "a property that gained keys reads 0 -> n");
  ok(/layer 498 Opacity keys 0 -> 4/.test(d.summary), `the issue's own example line: ${d.summary}`);

  // And the other direction: a property whose keys were all deleted drops out
  // of keyCounts entirely, which must still read as a change to zero.
  const gone = diff(
    comp([layer({ keyCounts: { Position: 3 } })]),
    comp([layer({ keyCounts: {} })]),
  );
  eq(gone.changed[0].changes.keyCounts, { Position: { from: 3, to: 0 } }, "deleted keyframes are a change to 0");
}

// ---------- float noise is not a change ----------
{
  const d = diff(comp([layer()]), comp([layer({ inPoint: 1e-9, outPoint: 5 + 1e-9 })]));
  eq(d.changeCount, 0, "a difference below a millionth of a second is float noise, not a retime");
}

// ---------- reorder ----------
{
  // Two layers swapped: a genuine reorder.
  const before = comp([layer({ id: 1 }), layer({ id: 2, index: 2 }), layer({ id: 3, index: 3 })]);
  const after = comp([layer({ id: 2, index: 1 }), layer({ id: 1, index: 2 }), layer({ id: 3, index: 3 })]);
  const d = diff(before, after);
  ok(d.reordered, "swapping two layers is a reorder");
  eq(d.reordered.map((r) => r.id).sort(), [1, 2], "…of exactly those two");
  eq(d.reordered[0].fromIndex !== d.reordered[0].toIndex, true, "with both indices reported");
  ok(/moved in the stack/.test(d.summary), d.summary);

  // Inserting at the top shifts every index below it. That is not a reorder,
  // and reporting it as twenty changed layers would destroy the whole point.
  const grown = comp([
    layer({ id: 9, name: "new", index: 1 }),
    layer({ id: 1, index: 2 }),
    layer({ id: 2, index: 3 }),
    layer({ id: 3, index: 4 }),
  ]);
  const ins = diff(before, grown);
  eq(ins.reordered, undefined, "an index shifted by an insertion is not a move");
  eq(ins.changed, undefined, "and nothing about the existing layers changed");
  eq(ins.unchangedLayers, 3, "they are counted as unchanged");
  eq(ins.added.length, 1);
}

// ---------- comp-level fields ----------
{
  const d = diff(comp([]), comp([], { duration: 20, name: "Renamed" }));
  eq(d.comp.duration, { from: 10, to: 20 });
  eq(d.comp.name, { from: "Main", to: "Renamed" });
  ok(/comp duration 10 -> 20/.test(d.summary), d.summary);

  const sized = diff(comp([]), comp([], { width: 1080, height: 1920 }));
  eq(sized.comp.size, { from: [1920, 1080], to: [1080, 1920] });

  const markers = diff(comp([], { markers: ["0|a|0"] }), comp([], { markers: ["0|a|0", "1|b|0"] }));
  eq(markers.comp.markers, { from: 1, to: 2 }, "a marker count change is reported");
  const edited = diff(comp([], { markers: ["0|a|0"] }), comp([], { markers: ["0|b|0"] }));
  eq(edited.comp.markers, { count: 1, edited: true }, "the same count with different content still counts");
}

// ---------- the summary stays one readable line ----------
{
  const many = [];
  const changed = [];
  for (let i = 0; i < 20; i++) {
    many.push(layer({ id: 200 + i, index: i + 1 }));
    changed.push(layer({ id: 200 + i, index: i + 1, name: "renamed " + i }));
  }
  const d = diff(comp(many), comp(changed));
  eq(d.changed.length, 20, "every change is still in the structured fields");
  ok(/and 12 more changes \(see the fields below\)/.test(d.summary), `the prose is capped: ${d.summary}`);
  ok(d.summary.length < 700, `and stays short: ${d.summary.length} chars`);
}

// ---------- id ranges ----------
{
  const idList = call("__diffIdList");
  eq(idList([512, 513, 514]), "512-514", "a run collapses");
  eq(idList([514, 512, 513]), "512-514", "…whatever order they arrive in");
  eq(idList([1, 2]), "1, 2", "two consecutive ids are clearer spelled out");
  eq(idList([1, 5, 6, 7, 20]), "1, 5-7, 20", "runs and singletons mix");
  eq(idList([42]), "42");
}

// ---------------------------------------------------------------------------
// diff:true on the write ops
// ---------------------------------------------------------------------------
{
  const start = call("__diffStart");
  const finish = call("__diffFinish");

  eq(start({}, null), null, "no diff asked for, no work done");
  eq(start({ diff: false }, null), null, "…and false means false");

  // Nothing to fingerprint: refused with a reason, never silently skipped. A
  // missing diff that looks like "nothing changed" is the failure this exists
  // to prevent.
  vm.runInContext("setProject([], null);", ctx);
  const none = plain(finish(start({ diff: true }, null)));
  eq(none.unavailable, true, "with no comp to look at, the diff says so");
  ok(/diffCompId/.test(none.reason), "and names the way to fix it");
  ok(/No diff was taken/.test(none.summary), none.summary);

  // A batch names its own comps in its ops.
  vm.runInContext(
    `
    var c1 = mkComp({ id: 21, name: "One", layers: [mkLayer("shape", { id: 1, name: "a", index: 1 })] });
    var c2 = mkComp({ id: 22, name: "Two", layers: [] });
    setProject([c1, c2], c2);
    var OPS_ARGS = [{ op: "x", args: { compId: 21 } }, { op: "y", args: { compId: 21 } }, { op: "z", args: { compId: 22 } }];
    `,
    ctx,
  );
  const fromOps = start({ diff: true }, call("OPS_ARGS"));
  eq(plain(fromOps.ids), [21, 22], "each comp the batch names, once");

  // An explicit diffCompId outranks both.
  eq(plain(start({ diff: true, diffCompId: 22 }, call("OPS_ARGS")).ids), [22], "diffCompId wins");

  // …and with neither, the comp open in the viewer.
  eq(plain(start({ diff: true }, null).ids), [22], "otherwise the active comp");

  // One comp in, one diff out — not a list of one.
  const single = plain(finish(start({ diff: true, diffCompId: 21 }, null)));
  eq(single.compId, 21, "a single-comp diff is returned bare");
  eq(single.changeCount, 0);

  // Several comps in, one wrapper out with a combined line.
  const multi = plain(finish(fromOps));
  eq(multi.comps.length, 2, "a multi-comp diff lists them");
  ok(/comp 21: /.test(multi.summary) && /comp 22: /.test(multi.summary), multi.summary);

  // A comp deleted between the two fingerprints is reported, not thrown.
  const across = start({ diff: true, diffCompId: 21 }, null);
  vm.runInContext("setProject([c2], c2);", ctx);
  const deleted = plain(finish(across));
  eq(deleted.gone, true, "a comp that vanished mid-call is reported as gone");
  ok(/no longer be read/.test(deleted.summary), deleted.summary);
}

// ---------- the error annotation ----------
{
  vm.runInContext(
    `
    var c3 = mkComp({ id: 31, name: "Live", layers: [mkLayer("shape", { id: 1, name: "a", index: 1 })] });
    setProject([c3], c3);
    `,
    ctx,
  );
  const state = call("__diffStart")({ diff: true, diffCompId: 31 }, null);
  // The script adds a layer and then throws — nothing rolls back.
  vm.runInContext(
    `
    var c3b = mkComp({ id: 31, name: "Live", layers: [
      mkLayer("shape", { id: 1, name: "a", index: 1 }),
      mkLayer("shape", { id: 2, name: "b", index: 2 })
    ] });
    setProject([c3b], c3b);
    `,
    ctx,
  );
  const err = new Error("boom");
  err.line = 12;
  call("__diffAnnotateError")(err, state);
  ok(/boom/.test(err.message), "the original message survives");
  ok(/1 layer added: ids 2/.test(err.message), `the stop point is on the error: ${err.message}`);
  ok(/nothing rolls back/.test(err.message), "and says re-running is not the fix");
  eq(err.line, 12, "the error object is mutated, not replaced — line and stack survive for the caller");

  // With no diff requested there is nothing to annotate and nothing to say.
  const clean = new Error("boom");
  call("__diffAnnotateError")(clean, null);
  eq(clean.message, "boom", "no diff asked for, no noise added");
}

// ---------- run_jsx's envelope ----------
{
  const withDiff = call("__rjWithDiff");
  const d = intoVm({ summary: "x", changeCount: 0 });

  const scalar = plain(withDiff(7, d, "AE MCP: run_jsx"));
  eq(scalar.returned, 7, "a scalar return value has nowhere to hang a diff, so it is enveloped");
  eq(scalar.ok, true);
  eq(scalar.undoGroup, "AE MCP: run_jsx");
  ok(scalar.diff, "…with the diff beside it");

  const arr = plain(withDiff(intoVm([1, 2]), d, false));
  eq(arr.returned, [1, 2], "an array is a value, not an envelope to extend");
  eq(arr.undoGroup, false, "undoGroup:false is carried through as false");

  // __rjResult's own null envelope is already the right shape; extending it
  // beats nesting one envelope inside another.
  const nullEnv = intoVm({ ok: true, returned: null, undoGroup: "AE MCP: run_jsx", note: "Completed with no return" });
  const extended = plain(withDiff(nullEnv, d, "AE MCP: run_jsx"));
  eq(extended.returned, null);
  ok(extended.note, "the note that says it did not fail is kept");
  ok(extended.diff, "and the diff joins it at the top level");
  ok(extended.returned === null, "never an envelope nested inside a second envelope");
}

// ---------------------------------------------------------------------------
// Where the snapshots are kept
// ---------------------------------------------------------------------------
// In the MCP server's memory, not in the After Effects project — a tool that
// reads the project must not modify it. The cost of that is a lifetime of one
// session, which is fine, but only if it is never met as a cryptic failure.
{
  // pathToFileURL, not the bare path: on Windows an absolute path starts with a
  // drive letter, which the ESM loader reads as an unsupported URL scheme.
  const { SnapshotStore } = await import(
    pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "snapshots", "store.js")).href
  );

  const store = new SnapshotStore(3);
  const fp = (compId, layers) => ({ compId, name: "Main", numLayers: layers, layers: new Array(layers).fill({}) });

  const first = store.store(fp(7, 2));
  eq(first.compId, 7, "the comp is remembered with the fingerprint");
  eq(first.layerCount, 2);
  ok(store.get(first.id).fingerprint, "…and the fingerprint itself is what comes back");
  eq(store.get("nope"), undefined, "an id that was never issued is simply absent");

  const ids = [first.id];
  for (let i = 0; i < 3; i++) ids.push(store.store(fp(7, 1)).id);
  eq(store.size(), 3, "the table is bounded");
  eq(store.get(ids[0]), undefined, "and it is the oldest that goes");
  ok(store.get(ids[3]), "the newest is kept");

  // The message an agent meets after doing the work it wanted to verify. It has
  // to explain and then point somewhere, or it strands them.
  const msg = store.missingMessage(ids[0]);
  ok(msg.includes(ids[0]), "the message names the id that was asked for");
  ok(/length of the session/.test(msg), "…says why it is gone");
  ok(/oldest is dropped once 3 are held/.test(msg), "…including the other reason");
  ok(/snapshot_comp/.test(msg) && /list_layers/.test(msg), "…and names both ways forward");
  ok(store.ids().every((id) => msg.includes(id)), "the ids that ARE held are listed, so the next call can succeed");

  eq(new SnapshotStore(3).missingMessage("snap_1").includes("No snapshots are held"), true,
    "a fresh session says that rather than listing nothing");
}

console.log(`comp-snapshot: ${passed} assertions passed`);
