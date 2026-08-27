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

console.log(`jsx-undo-group: ${passed} assertions passed`);
