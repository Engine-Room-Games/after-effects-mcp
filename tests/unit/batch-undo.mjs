// run_batch's undo grouping (issue #69).
//
// The measurement this whole file exists to protect: **After Effects discards
// an undo group opened in one `evalScript` call and closed in another.** The old
// code opened the group in `run_batch`, returned `{jobId, async:true}` — ending
// that call — and closed it from a later `_continue_job`. AE had already thrown
// it away, so a 600-op batch that reported "one undo step" cost the user ~600,
// and the Edit menu read `Undo New Solid` rather than the batch's name.
//
// Nothing offline can see AE's undo stack, so what is asserted here is the
// property that decides it: **every group opens and closes inside the same
// dispatch call.** A begin left open when a call returns is the bug, whatever
// the result object claims. The reported `undoSteps` is checked against the
// number of `beginUndoGroup` calls the stub actually saw, so the number an agent
// repeats to a user as "press Cmd-Z N times" can never be a guess.
//
//   node tests/unit/batch-undo.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const core = read("core.jsx");
// batch.jsx reaches into snapshot.jsx for diff:true. In After Effects both are
// halves of one concatenated bundle; here they have to be loaded explicitly.
const snapshot = read("snapshot.jsx");
const batch = read("batch.jsx");

function load() {
  const log = [];
  const ctx = {
    app: {
      beginUndoGroup: (n) => log.push(`begin:${n}`),
      endUndoGroup: () => log.push("end"),
      // The old async path fired a menu `Undo` on a transactional failure and
      // reported it as a rollback. Menu commands do not work over this bridge
      // at all, so they are here only to prove nothing calls them.
      findMenuCommandId: (n) => { log.push(`findMenu:${n}`); return 16; },
      executeCommand: (id) => { log.push(`exec:${id}`); },
    },
    log,
  };
  vm.createContext(ctx);
  vm.runInContext(core, ctx, { filename: "core.jsx" });
  vm.runInContext(snapshot, ctx, { filename: "snapshot.jsx" });
  vm.runInContext(batch, ctx, { filename: "batch.jsx" });
  const dispatch = vm.runInContext("dispatch", ctx);

  // Every call through here asserts the invariant the bug violated: whatever
  // else it did, the call left no undo group open behind it.
  const call = (op, args) => {
    const before = log.length;
    const out = dispatch(JSON.stringify({ op, args }));
    const slice = log.slice(before);
    const opened = slice.filter((l) => l.startsWith("begin:")).length;
    const closed = slice.filter((l) => l === "end").length;
    assert.equal(
      opened,
      closed,
      `${op} left ${opened - closed} undo group(s) open across the call boundary — ` +
        `After Effects discards those, so the work lands ungrouped`
    );
    return out;
  };

  // Runs a job the way the panel's driveJob does, one continuation per call.
  const drive = (jobId, chunkSize, onChunk) => {
    const chunks = [];
    for (let guard = 0; guard < 500; guard++) {
      const r = call("_continue_job", { jobId, chunkSize });
      assert.equal(r.ok, true, `_continue_job failed: ${r.error}`);
      chunks.push(r.result);
      if (onChunk) onChunk(r.result, chunks.length);
      if (r.result.done) return { chunks, final: r.result };
    }
    throw new Error("job never finished");
  };

  return { ctx, log, call, drive };
}

const opens = (log) => log.filter((l) => l.startsWith("begin:")).length;
const closes = (log) => log.filter((l) => l === "end").length;
const names = (log) => log.filter((l) => l.startsWith("begin:")).map((l) => l.slice(6));

/** `n` ops that each record that they ran. */
function makeOps(ctx, n, op = "touch") {
  ctx.ran = [];
  ctx.OPS[op] = (a) => { ctx.ran.push(a && a.i); return { ok: true }; };
  const ops = [];
  for (let i = 0; i < n; i++) ops.push({ op, args: { i } });
  return ops;
}

let passed = 0;

// ---------------------------------------------------------------------------
// 1. Inline path: exactly one group, opened before the first op and closed
//    after the last, all inside this one dispatch.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  const ops = makeOps(ctx, 50);
  const r = call("run_batch", { ops, transactional: true, undoGroupName: "Fifty solids" });
  assert.equal(r.ok, true);
  assert.equal(ctx.ran.length, 50, "every op must run");
  assert.equal(opens(log), 1, "an inline batch is one undo group");
  assert.equal(closes(log), 1);
  assert.deepEqual(log, ["begin:Fifty solids", "end"]);
  assert.equal(r.result.undoSteps, 1);
  assert.equal(r.result.undoGroupName, "Fifty solids");
  assert.match(r.result.note, /one undo step/);
  passed += 8;
}

// The default name still reaches AE's Edit menu.
{
  const { ctx, log, call } = load();
  const r = call("run_batch", { ops: makeOps(ctx, 3) });
  assert.deepEqual(names(log), ["AE MCP Batch"]);
  assert.equal(r.result.undoSteps, 1);
  passed += 2;
}

// An empty batch opens nothing — AE records no step for a group that changed
// nothing, so `undoSteps: 1` would be an over-report on the one call where the
// truth is not in doubt.
{
  const { log, call } = load();
  const r = call("run_batch", { ops: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(log, []);
  assert.equal(r.result.undoSteps, 0);
  assert.match(r.result.note, /no undo steps/);
  passed += 4;
}

// ---------------------------------------------------------------------------
// 2. The reported count is measured, not asserted. An op that calls
//    withoutUndoGroup() really does split the batch, and the result says 2.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  ctx.OPS.splits = () => vm.runInContext("withoutUndoGroup", ctx)(() => ({ ok: true }));
  const r = call("run_batch", { ops: [{ op: "splits", args: {} }] });
  assert.equal(r.ok, true);
  assert.equal(opens(log), 2, "withoutUndoGroup closes one group and opens another");
  assert.equal(closes(log), 2);
  assert.equal(r.result.undoSteps, 2, "the count must follow the groups, not the intent");
  assert.doesNotMatch(r.result.note, /\(1\)/, "an inline split is not the chunked naming");
  passed += 5;
}

// A batched op reaching for withoutUndoGroup must find a group open — that only
// works because the inline path goes through withUndo, which owns __UNDO_OPEN.
{
  const { ctx, call } = load();
  ctx.seen = null;
  ctx.OPS.probe = () => { ctx.seen = vm.runInContext("__UNDO_OPEN", ctx); return { ok: true }; };
  call("run_batch", { ops: [{ op: "probe", args: {} }] });
  assert.equal(ctx.seen, true, "an inline batch must present itself as an open group");
  passed++;
}

// ---------------------------------------------------------------------------
// 3. A transactional failure still closes the group, and says what it cost.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  makeOps(ctx, 0);
  ctx.OPS.boom = () => { throw new Error("nope"); };
  const r = call("run_batch", {
    ops: [{ op: "touch", args: { i: 0 } }, { op: "boom", args: {} }, { op: "touch", args: { i: 2 } }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Batch failed at op\[1\] boom/);
  assert.match(r.error, /one undo step/, "a failed batch reports its undo cost too");
  assert.equal(opens(log), 1);
  assert.equal(closes(log), 1, "a throw must not leave the batch's group open");
  assert.deepEqual(ctx.ran, [0], "transactional stops at the first failure");
  passed += 6;
}

// Non-transactional: the failure is collected, the rest runs, still one group.
{
  const { ctx, log, call } = load();
  makeOps(ctx, 0);
  ctx.OPS.boom = () => { throw new Error("nope"); };
  const r = call("run_batch", {
    ops: [{ op: "touch", args: { i: 0 } }, { op: "boom", args: {} }, { op: "touch", args: { i: 2 } }],
    transactional: false,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.ran, [0, 2]);
  assert.equal(r.result.errors.length, 1);
  assert.equal(r.result.undoSteps, 1);
  assert.equal(opens(log), 1);
  passed += 5;
}

// ---------------------------------------------------------------------------
// 4. The async path opens NOTHING in the call that registers the job. This is
//    the regression that produced ~600 undo steps: a begin here is closed from
//    a different call, and AE drops the group.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  const r = call("run_batch", { ops: makeOps(ctx, 600), undoGroupName: "Six hundred" });
  assert.equal(r.ok, true);
  assert.equal(r.result.async, true);
  assert.ok(r.result.jobId, "an over-cutoff batch registers a job");
  assert.deepEqual(log, [], "registering a job must not open an undo group");
  assert.equal(r.result.chunkSize, 25);
  assert.equal(r.result.undoStepsEstimate, 24);
  assert.equal(r.result.undoGroupName, "Six hundred");
  assert.match(r.result.note, /NOT one/, "the envelope must not promise one step");
  assert.match(r.result.note, /singleUndo/);
  assert.equal(ctx.ran.length, 0, "nothing runs until the first continuation");
  passed += 10;
}

// ---------------------------------------------------------------------------
// 5. Driving it: one group per chunk, opened and closed inside that chunk's own
//    call, and the final count equals the groups the stub actually saw.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call, drive } = load();
  const env = call("run_batch", { ops: makeOps(ctx, 600), undoGroupName: "Six hundred" }).result;
  const { chunks, final } = drive(env.jobId, env.chunkSize, (res, n) => {
    // Balance is asserted per call inside `call`; this checks the shape too.
    assert.equal(opens(log), n, "each continuation opens exactly one group");
    assert.equal(closes(log), n);
  });
  assert.equal(chunks.length, 24, "600 ops in chunks of 25");
  assert.equal(ctx.ran.length, 600, "every op runs");
  assert.equal(final.done, true);
  assert.equal(final.total, 600);
  assert.equal(opens(log), 24, "24 groups, one per chunk");
  assert.equal(closes(log), 24);
  assert.equal(final.undoSteps, opens(log), "the reported count is the measured count");
  assert.deepEqual(names(log).slice(0, 3), ["Six hundred (1)", "Six hundred (2)", "Six hundred (3)"]);
  assert.equal(names(log)[23], "Six hundred (24)");
  assert.match(final.note, /24 undo steps, NOT one/);
  assert.match(final.note, /Cmd-Z/);
  passed += 11;
}

// Progress continuations carry the running count, so a caller watching the
// stream is never told a number that later grows without warning.
{
  const { ctx, call, drive } = load();
  // 525 ops is the smallest thing past the 500 inline cutoff that divides
  // evenly by the chunk size: 21 continuations, so the running count is 1..21.
  const env = call("run_batch", { ops: makeOps(ctx, 525) }).result;
  const { chunks } = drive(env.jobId, env.chunkSize);
  const counted = [];
  for (let i = 1; i <= 21; i++) counted.push(i);
  assert.deepEqual(chunks.map((c) => c.undoSteps), counted);
  assert.equal(chunks.filter((c) => c.done).length, 1, "only the last continuation is done");
  assert.equal(chunks[chunks.length - 1].done, true);
  passed += 3;
}

// ---------------------------------------------------------------------------
// 6. Cancellation. A cancel can only be observed between chunks — every group
//    is already closed by then — so it must never leave one open.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call, drive } = load();
  const env = call("run_batch", { ops: makeOps(ctx, 600), undoGroupName: "Cancelled" }).result;
  // Two chunks, then cancel, exactly as /cancel does: its own evalScript.
  call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize });
  call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize });
  const c = call("_cancel_job", { jobId: env.jobId });
  assert.equal(c.result.ok, true);
  const stop = call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize }).result;
  assert.equal(stop.done, true);
  assert.equal(stop.cancelled, true);
  assert.equal(opens(log), 2, "the cancelling continuation opens no group of its own");
  assert.equal(closes(log), 2, "a cancelled batch leaves nothing open");
  assert.equal(stop.undoSteps, 2, "it reports the two chunks that did land");
  assert.equal(ctx.ran.length, 50, "and only those 50 ops ran");
  passed += 7;
}

// Cancelled after exactly one chunk: the one group is named "(1)", so the note
// must quote that and not the bare batch name — the user would go looking for a
// menu entry that is not there.
{
  const { ctx, log, call } = load();
  const env = call("run_batch", { ops: makeOps(ctx, 600), undoGroupName: "Stopped" }).result;
  call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize });
  call("_cancel_job", { jobId: env.jobId });
  const stop = call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize }).result;
  assert.equal(stop.undoSteps, 1);
  assert.deepEqual(names(log), ["Stopped (1)"]);
  assert.match(stop.note, /"Stopped \(1\)"/);
  passed += 3;
}

// Cancelled before the first chunk: no groups at all, and it says so.
{
  const { ctx, log, call } = load();
  const env = call("run_batch", { ops: makeOps(ctx, 600) }).result;
  call("_cancel_job", { jobId: env.jobId });
  const stop = call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize }).result;
  assert.equal(stop.cancelled, true);
  assert.equal(stop.undoSteps, 0);
  assert.deepEqual(log, []);
  assert.match(stop.note, /no undo steps/);
  passed += 4;
}

// ---------------------------------------------------------------------------
// 7. A transactional failure mid-chunk: the chunk's group closes, the count is
//    honest, and no rollback is claimed. The old code fired a menu `Undo` here
//    and reported it as one; menu commands do not work over this bridge.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  makeOps(ctx, 0);
  const ops = [];
  for (let i = 0; i < 600; i++) ops.push({ op: i === 60 ? "boom" : "touch", args: { i } });
  ctx.OPS.boom = () => { throw new Error("op 60 is impossible"); };
  const env = call("run_batch", { ops, undoGroupName: "Doomed" }).result;
  let res = null;
  for (let n = 0; n < 10 && (!res || !res.done); n++) {
    res = call("_continue_job", { jobId: env.jobId, chunkSize: env.chunkSize }).result;
  }
  assert.equal(res.done, true);
  assert.equal(res.failed, true);
  assert.equal(res.atIndex, 60);
  assert.equal(res.rolledBack, false, "nothing rolls back and the result must say so");
  assert.equal(opens(log), 3, "chunks 1-3, the third stopping at op 60");
  assert.equal(closes(log), 3, "the failing chunk still closes its group");
  assert.equal(res.undoSteps, opens(log));
  assert.equal(log.filter((l) => l.startsWith("exec:")).length, 0, "no menu Undo is attempted");
  assert.equal(log.filter((l) => l.startsWith("findMenu:")).length, 0);
  assert.match(res.note, /Nothing was rolled back/);
  assert.equal(ctx.ran.length, 60, "ops 0-59 ran and stay applied");
  passed += 11;
}

// ---------------------------------------------------------------------------
// 8. singleUndo: one step at any size up to the ceiling, and a refusal above it
//    rather than a frozen After Effects.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  const r = call("run_batch", { ops: makeOps(ctx, 600), singleUndo: true, undoGroupName: "All at once" });
  assert.equal(r.ok, true);
  assert.equal(r.result.async, undefined, "singleUndo never registers a job");
  assert.equal(r.result.jobId, undefined);
  assert.equal(ctx.ran.length, 600, "the whole batch runs in this one call");
  assert.deepEqual(log, ["begin:All at once", "end"], "one group round all 600 ops");
  assert.equal(r.result.undoSteps, 1);
  assert.match(r.result.note, /one undo step/);
  passed += 7;
}

// At the ceiling exactly: still allowed.
{
  const { ctx, log, call } = load();
  const r = call("run_batch", { ops: makeOps(ctx, 2000), singleUndo: true });
  assert.equal(r.ok, true);
  assert.equal(r.result.undoSteps, 1);
  assert.equal(opens(log), 1);
  passed += 3;
}

// One past it: refused, with the number, the reason and both ways out — and
// without having opened a group or run a single op first.
{
  const { ctx, log, call } = load();
  const r = call("run_batch", { ops: makeOps(ctx, 2001), singleUndo: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /singleUndo refuses 2001 ops/);
  assert.match(r.error, /2000/);
  assert.match(r.error, /freezes/);
  assert.match(r.error, /split the work/);
  assert.deepEqual(log, [], "a refusal must not have opened anything");
  assert.equal(ctx.ran.length, 0, "and must not have run anything");
  passed += 7;
}

// Without singleUndo the same 2001 ops are chunked, not refused.
{
  const { ctx, call } = load();
  const r = call("run_batch", { ops: makeOps(ctx, 2001) });
  assert.equal(r.ok, true);
  assert.equal(r.result.async, true);
  assert.equal(r.result.undoStepsEstimate, 81);
  passed += 3;
}

// ---------------------------------------------------------------------------
// 9. A run_batch nested inside another must not open a second group: AE's undo
//    groups do not nest, so the inner endUndoGroup would close the outer one
//    and the rest of the outer batch would write ungrouped.
// ---------------------------------------------------------------------------
{
  const { ctx, log, call } = load();
  makeOps(ctx, 0);
  const inner = [{ op: "touch", args: { i: 1 } }, { op: "touch", args: { i: 2 } }];
  const r = call("run_batch", {
    ops: [
      { op: "touch", args: { i: 0 } },
      { op: "run_batch", args: { ops: inner, undoGroupName: "Inner" } },
      { op: "touch", args: { i: 3 } },
    ],
    undoGroupName: "Outer",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(log, ["begin:Outer", "end"], "one group for the pair, not two");
  assert.equal(r.result.undoSteps, 1);
  assert.deepEqual(ctx.ran, [0, 1, 2, 3], "the outer batch still finishes after the inner one");
  const innerResult = r.result.results[1];
  assert.equal(innerResult.nested, true);
  assert.equal(innerResult.undoSteps, 0, "the inner batch adds no step of its own");
  assert.match(innerResult.note, /part of the outer step/);
  passed += 7;
}

// ---------------------------------------------------------------------------
// 10. The chunk size the panel drives with comes off the envelope, so the two
//     sides cannot drift into a different number of undo steps.
// ---------------------------------------------------------------------------
{
  const main = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "main.js"), "utf8");
  assert.match(
    main,
    /driveJob\(res\.jobId, progressToken, res\.chunkSize\)/,
    "the panel must take its chunk size from the job envelope"
  );
  assert.match(main, /chunkSize: size/, "and drive _continue_job with it");
  passed += 2;
}

console.log(`batch-undo: ${passed} assertions passed`);
