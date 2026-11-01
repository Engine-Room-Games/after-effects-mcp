// dispatch()'s undo grouping, including the per-call opt-out run_jsx needs.
//
// After Effects refuses copyToComp for a layer with a parent or a linked
// expression while an undo group is open, so the wrapper dispatch() puts round
// every op broke exactly the rigs worth copying (issue #30). Two escapes now
// exist and both have to be exact about undo state: undoGroup:false skips the
// group entirely, and withoutUndoGroup() closes and reopens it around one
// statement. An unbalanced begin/end leaves the user's project in a state no
// undo can get out of, and nothing else in this repo would notice.
//
//   node tests/unit/jsx-undo-group.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = fs.readFileSync(path.join(root, "packages", "jsx", "core.jsx"), "utf8");
// raw.jsx calls into snapshot.jsx for run_jsx's opt-in diff. In After Effects
// both are halves of one concatenated bundle; here they have to be loaded
// explicitly, or every run_jsx call fails on an undefined helper.
const snapshot = fs.readFileSync(path.join(root, "packages", "jsx", "snapshot.jsx"), "utf8");
const raw = fs.readFileSync(path.join(root, "packages", "jsx", "raw.jsx"), "utf8");

function load() {
  const log = [];
  const ctx = {
    app: {
      beginUndoGroup: (n) => log.push(`begin:${n}`),
      endUndoGroup: () => log.push("end"),
    },
    log,
  };
  vm.createContext(ctx);
  vm.runInContext(core, ctx, { filename: "core.jsx" });
  vm.runInContext(snapshot, ctx, { filename: "snapshot.jsx" });
  vm.runInContext(raw, ctx, { filename: "raw.jsx" });
  const call = (op, args) =>
    vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }));
  return { ctx, log, call };
}

const opens = (log) => log.filter((l) => l.startsWith("begin:")).length;
const closes = (log) => log.filter((l) => l === "end").length;

let passed = 0;

// A normal op gets exactly one balanced group.
{
  const { ctx, log, call } = load();
  ctx.OPS.demo = () => ({ ok: true });
  const r = call("demo", {});
  assert.deepEqual(r.result, { ok: true });
  assert.deepEqual(log, ["begin:AE MCP: demo", "end"]);
  passed += 2;
}

// A throwing op still closes its group — otherwise the next op nests inside it.
{
  const { ctx, log, call } = load();
  ctx.OPS.boom = () => { throw new Error("nope"); };
  const r = call("boom", {});
  assert.equal(r.ok, false);
  assert.equal(closes(log), 1, "a failed op must still close its undo group");
  passed += 2;
}

// run_jsx, the default: wrapped in one group.
{
  const { log, call } = load();
  const r = call("run_jsx", { code: "return 1 + 1;" });
  assert.equal(r.result, 2);
  assert.deepEqual(log, ["begin:AE MCP: run_jsx", "end"]);
  passed += 2;
}

// run_jsx with undoGroup:false: no group at all, and nothing left open.
{
  const { log, call } = load();
  const r = call("run_jsx", { code: "return 3;", undoGroup: false });
  assert.equal(r.result, 3);
  assert.deepEqual(log, [], "undoGroup:false must not touch undo state");
  passed += 2;
}

// The opt-out is per call and must not leak into the next op.
{
  const { ctx, log, call } = load();
  ctx.OPS.demo = () => ({ ok: true });
  call("run_jsx", { code: "return 1;", undoGroup: false });
  call("demo", {});
  call("run_jsx", { code: "return 1;" });
  assert.deepEqual(log, [
    "begin:AE MCP: demo", "end",
    "begin:AE MCP: run_jsx", "end",
  ], "one call's opt-out must not carry into the next");
  passed++;
}

// withoutUndoGroup inside a wrapped script: close, run, reopen, and the
// dispatcher's own finally closes the reopened one. Balanced either way.
{
  const { log, call } = load();
  const r = call("run_jsx", {
    code: "var seen = 0; withoutUndoGroup(function () { seen = 1; }); return seen;",
  });
  assert.equal(r.result, 1, "the body must actually run");
  assert.equal(opens(log), 2);
  assert.equal(closes(log), 2, "every begin needs its end");
  assert.equal(log[0], "begin:AE MCP: run_jsx");
  assert.equal(log[1], "end", "the group must be closed before the body runs");
  assert.equal(log[log.length - 1], "end");
  passed += 5;
}

// withoutUndoGroup when no group of ours is open is a no-op, not an unbalanced
// endUndoGroup that would close something AE opened.
{
  const { log, call } = load();
  const r = call("run_jsx", {
    code: "return withoutUndoGroup(function () { return 7; });",
    undoGroup: false,
  });
  assert.equal(r.result, 7);
  assert.deepEqual(log, [], "with no group of ours open, undo state must be left alone");
  passed += 2;
}

// A throw inside withoutUndoGroup still reopens the group, so the dispatcher's
// close stays balanced and the error still reaches the caller.
{
  const { log, call } = load();
  const r = call("run_jsx", {
    code: "withoutUndoGroup(function () { throw new Error('inner'); });",
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /inner/);
  assert.equal(opens(log), 2);
  assert.equal(closes(log), 2, "a throw inside must not leave undo unbalanced");
  passed += 4;
}

// ---------------------------------------------------------------------------
// Screenshots through the real dispatcher (issue #116)
//
// The screenshot ops are noUndo at the dispatcher and group themselves, because
// whether a group is needed depends on the comp's resolution, which dispatch()
// cannot see. This runs the real core.jsx + vision.jsx (+ batch.jsx) together,
// so it is the actual __UNDO_OPEN and withUndo that decide — the unit file
// tests/unit/screenshot-resolution.mjs stubs both.
// ---------------------------------------------------------------------------
{
  const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
  const loadVision = (startFactor) => {
    const log = [];
    // A temporary comp (issue #282): the wrapper or copy a screenshot renders
    // through. Its own assignments are logged as `tmp:*`; the user's comp's as
    // `rf` / `solo`, which must never appear.
    const temp = (kind) => {
      const t = {
        kind, numLayers: 1, pixelAspect: 1, duration: 10, frameRate: 25,
        set resolutionFactor(v) { log.push(`tmp:${kind}:rf`); },
        layer() { return { name: "lay", set solo(v) { log.push(`tmp:${kind}:solo`); } }; },
        saveFrameToPng() { log.push(`render:${kind}`); },
        remove() { log.push(`tmp:${kind}:remove`); },
      };
      t.layers = { add() { log.push(`tmp:${kind}:add`); } };
      return t;
    };
    const comp = {
      id: 5, width: 1920, height: 1080, time: 0, pixelAspect: 1, duration: 10, frameRate: 25,
      _rf: startFactor,
      get resolutionFactor() { return this._rf; },
      set resolutionFactor(v) { log.push("rf"); this._rf = v; },
      numLayers: 1,
      layer() { return lay; },
      saveFrameToPng() { log.push("render"); },
      duplicate() { log.push("tmp:copy:create"); return temp("copy"); },
    };
    const lay = {
      id: 9, index: 1, name: "lay", _solo: false,
      get solo() { return this._solo; },
      set solo(v) { log.push("solo"); this._solo = v; },
    };
    const ctx = {
      app: {
        beginUndoGroup: (n) => log.push(`begin:${n}`),
        endUndoGroup: () => log.push("end"),
        project: {
          dirty: true,
          items: { addComp() { log.push("tmp:wrapper:create"); return temp("wrapper"); } },
        },
      },
      Folder: { temp: { fsName: "/tmp" } },
      File: function (p) { this.path = p; },
      getCompById: () => comp,
      getLayerById: () => lay,
      log,
    };
    vm.createContext(ctx);
    vm.runInContext(read("core.jsx"), ctx, { filename: "core.jsx" });
    vm.runInContext(read("snapshot.jsx"), ctx, { filename: "snapshot.jsx" });
    vm.runInContext(read("batch.jsx"), ctx, { filename: "batch.jsx" });
    vm.runInContext(read("vision.jsx"), ctx, { filename: "vision.jsx" });
    const call = (op, args) => vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }));
    return { log, call, ctx };
  };

  // Comp at Full, downsample 1: nothing to borrow, so no group and no step.
  {
    const { log, call } = loadVision([1, 1]);
    assert.equal(call("screenshot_frame", { compId: 5, downsample: 1 }).ok, true);
    assert.deepEqual(log, ["render"], "a screenshot that changes nothing must leave no undo step");
    passed++;
  }

  // Comp at Quarter: one named group around the wrapper's whole life.
  {
    const { log, call } = loadVision([4, 4]);
    call("screenshot_frame", { compId: 5, downsample: 1 });
    assert.deepEqual(log, [
      "begin:AE MCP: screenshot",
      "tmp:wrapper:create", "tmp:wrapper:add", "tmp:wrapper:rf", "render:wrapper", "tmp:wrapper:remove",
      "end",
    ], "the user's comp is never assigned; the wrapper lives and dies inside the group");
    passed++;
  }

  // A contact sheet: one group for every tile.
  {
    const { log, call } = loadVision([4, 4]);
    call("screenshot_frame", { compId: 5, times: [0, 1, 2], downsample: 1 });
    assert.equal(opens(log), 1, "a sheet is one undo step, not two per tile");
    assert.equal(closes(log), 1);
    passed += 2;
  }

  // screenshot_layer: a copy with the solo set on it, inside one group.
  {
    const { log, call } = loadVision([4, 4]);
    call("screenshot_layer", { compId: 5, layerId: 9, downsample: 1 });
    assert.deepEqual(log, [
      "begin:AE MCP: screenshot",
      "tmp:copy:create", "tmp:copy:rf", "tmp:copy:solo", "render:copy", "tmp:copy:remove",
      "end",
    ], "the solo is set on the copy, never on the user's layer");
    passed++;
  }

  // Inside run_batch: the batch's group is the only one. A nested begin would
  // be closed by the screenshot's own end, and the rest of the batch would land
  // ungrouped.
  {
    const { log, call } = loadVision([4, 4]);
    const r = call("run_batch", {
      ops: [
        { op: "screenshot_frame", args: { compId: 5, downsample: 1 } },
        { op: "screenshot_layer", args: { compId: 5, layerId: 9, downsample: 1 } },
      ],
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(opens(log), 1, "a screenshot inside a batch must not open a group of its own");
    assert.equal(closes(log), 1);
    assert.equal(r.result.undoSteps, 1);
    passed += 4;
  }
}

console.log(`jsx-undo-group: ${passed} assertions passed`);
