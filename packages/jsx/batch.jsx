// batch.jsx — execute many ops in one ExtendScript pass.
// For huge batches, registers a job and processes in chunks via _continue_job.
//
// UNDO GROUPING, which is the whole design constraint here (issue #69):
// After Effects **discards** an undo group opened in one `evalScript` call and
// closed in another. Measured, not inferred — a 600-op batch that opened its
// group in `run_batch` and closed it from a later `_continue_job` produced ~600
// undo steps, and AE's Edit menu read `Undo New Solid` rather than the group's
// name. So a group only survives if it opens and closes inside one call, and
// that gives the two paths below genuinely different answers:
//
//   inline (<= 500 ops, or any size with singleUndo) — the whole batch runs in
//     one call, so one group round it is real. One undo step.
//   chunked (> 500 ops) — the batch spans N calls, so the most AE will keep is
//     one group per chunk. N undo steps, counted and reported, never claimed
//     to be one.

// The inline cutoff. Inline stays sub-second for typical create/keyframe ops up
// to a few hundred; the async-job overhead (jobId envelope, polling, progress
// notifications) is only worth it for genuinely long jobs.
var __BATCH_INLINE_MAX = 500;
// Chunk size for the async path. The panel reads this back off the envelope
// rather than holding its own copy, so the two cannot drift.
var __BATCH_CHUNK = 25;
// The ceiling on singleUndo. Past this, one blocking ExtendScript call freezes
// After Effects for long enough that the user will think it has hung, with no
// progress events to say otherwise — so it is refused rather than attempted.
var __BATCH_SINGLE_UNDO_MAX = 2000;

OPS.run_batch = function (args) {
  var ops = args.ops || [];
  var transactional = args.transactional !== false;
  var name = args.undoGroupName || "AE MCP Batch";
  var singleUndo = args.singleUndo === true;

  // Refused before anything else happens, including the diff fingerprint: a
  // call that is not going to run should cost nothing.
  if (singleUndo && ops.length > __BATCH_SINGLE_UNDO_MAX) {
    throw new Error(
      "singleUndo refuses " + ops.length + " ops (the limit is " + __BATCH_SINGLE_UNDO_MAX + "). " +
      "One undo step means the whole batch runs inside a single ExtendScript call, which " +
      "freezes After Effects' interface for the whole of it and reports no progress; at this " +
      "size the user would reasonably think it had hung. Either split the work into batches of " +
      __BATCH_SINGLE_UNDO_MAX + " or fewer, or drop singleUndo and accept one undo step per " +
      "chunk of " + __BATCH_CHUNK + " (the result says exactly how many)."
    );
  }

  // diff:true fingerprints the comps this batch names, before and after, inside
  // this one call — see snapshot.jsx. Null unless asked for.
  var diffState = __diffStart(args, ops);

  if (ops.length <= __BATCH_INLINE_MAX || singleUndo) {
    return __batchInline(ops, transactional, name, diffState);
  }

  // Long batches: register job, return jobId; panel polls _continue_job.
  // No undo group is opened here on purpose. One opened now would be closed
  // from a different call and AE would throw it away, which is exactly how this
  // op spent three releases reporting one undo step and delivering hundreds.
  var jobId = __newJobId();
  var estimate = Math.ceil(ops.length / __BATCH_CHUNK);
  JOBS[jobId] = {
    cursor: 0,
    total: ops.length,
    ops: ops,
    results: [],
    errors: [],
    cancelled: false,
    transactional: transactional,
    name: name,
    chunkSize: __BATCH_CHUNK,
    // Counted as groups are actually opened, never predicted. See __UNDO_GROUPS.
    undoSteps: 0,
    // Carried across the chunked continuations: the before-fingerprint has to
    // outlive the call that took it, or a long batch could never be diffed.
    diffState: diffState,
  };
  return {
    jobId: jobId,
    async: true,
    total: ops.length,
    chunkSize: __BATCH_CHUNK,
    // Labelled an estimate because it is one: a transactional failure ends the
    // batch early, and the exact count comes back with the final result.
    undoStepsEstimate: estimate,
    undoGroupName: name,
    note: "This batch runs in " + estimate + " chunks of " + __BATCH_CHUNK + " and will land as " +
      "about " + estimate + " undo steps, NOT one — After Effects discards an undo group that " +
      "spans two script calls, so a chunked batch can only group per chunk. The final result " +
      "reports the exact number. If the user needs a single Cmd-Z, re-send with singleUndo:true " +
      "(up to " + __BATCH_SINGLE_UNDO_MAX + " ops), which runs the whole batch in one blocking " +
      "call with no progress events.",
  };
};
// run_batch is allowed to manage its own undo: the inline path opens exactly one
// group of its own, and the chunked path opens one per continuation.
OPS.run_batch.__meta = { noUndo: true };

// The inline path: every op inside one undo group inside one evalScript, which
// is the only shape After Effects keeps.
//
// withUndo() rather than a bare beginUndoGroup/endUndoGroup pair, for two
// reasons: its `finally` closes the group when a transactional op throws, and it
// is the only thing that keeps __UNDO_OPEN honest, so a batched op that calls
// withoutUndoGroup() still works instead of silently doing nothing.
function __batchInline(ops, transactional, name, diffState) {
  var results = [];
  var errors = [];
  var before = __undoGroupsOpened();
  // A run_batch listed as an op inside another run_batch would otherwise open a
  // second group inside the first, and AE's groups do not nest: the inner
  // endUndoGroup closes the outer one and the rest of the outer batch writes
  // ungrouped. Run inside the group that is already open instead, and say so —
  // an inner batch reporting "one undo step" of its own would be a second lie
  // in the same shape as the one this fixes.
  var nested = __UNDO_OPEN;
  // An empty batch opens nothing. AE records no undo step for a group that
  // changed nothing, so opening one would make `undoSteps: 1` an over-report on
  // the one call where the truth is unambiguous.
  var empty = ops.length === 0;
  var run = function () {
    for (var i = 0; i < ops.length; i++) {
      var step = ops[i];
      try {
        var handler = OPS[step.op];
        if (!handler) throw new Error("Unknown op: " + step.op);
        results.push(handler(step.args || {}));
      } catch (e) {
        errors.push({ index: i, op: step.op, error: e.message });
        if (transactional) {
          // Nothing rolls back, so the half-applied state is what the caller
          // has to reason about. The diff says where it stopped.
          var failure = new Error("Batch failed at op[" + i + "] " + step.op + ": " + e.message);
          __diffAnnotateError(failure, diffState);
          throw failure;
        }
      }
    }
  };
  try {
    if (nested || empty) run();
    else withUndo(name, run);
  } catch (e) {
    // The group is already closed by withUndo's finally. Say what it cost, so a
    // failed batch is as clear about its undo history as a successful one.
    try {
      e.message = String(e.message) + " || " +
        __batchUndoNote(__undoGroupsOpened() - before, name, nested, false);
    } catch (e2) {}
    throw e;
  }
  var out = {
    results: results,
    errors: errors,
    total: ops.length,
    undoSteps: __undoGroupsOpened() - before,
    undoGroupName: name,
  };
  if (nested) out.nested = true;
  out.note = __batchUndoNote(out.undoSteps, name, nested, false);
  if (diffState) out.diff = __diffFinish(diffState);
  return out;
}

// The one sentence every batch result carries about its own undo history.
// Written for an agent that is about to tell a person how to undo the work.
// `steps` is always the measured count, so this describes what happened rather
// than what the path intended.
function __batchUndoNote(steps, name, nested, chunked) {
  if (nested) {
    return "This batch ran inside an undo group that was already open (a run_batch nested in " +
      "another one), so it adds no undo step of its own — its work is part of the outer step.";
  }
  if (steps <= 0) {
    return "This batch opened no undo group, so it added no undo steps.";
  }
  if (steps === 1) {
    // A chunked batch reaches one step only by stopping after its first chunk —
    // cancelled, or failed in it — and that group is named "(1)", not the bare
    // name. Quoting the wrong one would send the user looking for a menu entry
    // that is not there.
    return 'This batch is one undo step ("' + name + (chunked ? " (1)" : "") +
      '"): a single Cmd-Z (Ctrl-Z on Windows) undoes all of it.';
  }
  if (chunked) {
    return "This batch landed as " + steps + " undo steps, NOT one — named \"" + name + " (1)\" " +
      'through "' + name + " (" + steps + ')". After Effects discards an undo group that spans ' +
      "two script calls, so a chunked batch can only group per chunk. Undoing all of it takes up " +
      "to " + steps + " presses of Cmd-Z (Ctrl-Z on Windows) — tell the user that number rather " +
      "than saying one. (A chunk whose ops changed nothing records no step, so that is the " +
      "ceiling.) singleUndo:true buys a single step back, at the cost of freezing AE's interface " +
      "for the whole batch and emitting no progress.";
  }
  return "This batch landed as " + steps + " undo steps rather than one: an op inside it closed " +
    "the batch's undo group and opened a new one (withoutUndoGroup — After Effects refuses " +
    "copyToComp on a parented or expression-linked layer while a group is open). Undoing all of " +
    "it takes up to " + steps + " presses of Cmd-Z (Ctrl-Z on Windows).";
}

// Continuation step. Returns one chunk's worth of progress.
//
// Cancellation, which used to need bookkeeping across calls and no longer does:
// _cancel_job is its own evalScript and the panel serializes those, so a cancel
// can only ever be observed *between* chunks. A chunk's group opens and closes
// inside this one call, so there is never an open group for a cancel — or a
// throw, or a dropped WebSocket — to leave behind. That is what the old
// `j.undoOpen` flag was for, and it was tracking a group AE had already dropped.
OPS._continue_job = noUndo(function (args) {
  var jobId = args.jobId;
  var j = JOBS[jobId];
  if (!j) throw new Error("No job: " + jobId);
  if (j.cancelled) {
    var stopped = {
      done: true, cancelled: true, jobId: jobId,
      results: j.results, errors: j.errors,
      undoSteps: j.undoSteps, undoGroupName: j.name,
      note: __batchUndoNote(j.undoSteps, j.name, false, true),
    };
    if (j.diffState) stopped.diff = __diffFinish(j.diffState);
    return stopped;
  }
  var chunkSize = args.chunkSize || j.chunkSize || __BATCH_CHUNK;
  var endAt = Math.min(j.cursor + chunkSize, j.total);
  var before = __undoGroupsOpened();
  var failure = null;
  // One group per chunk, opened and closed inside this call. The chunk number
  // is in the name so the Edit menu says which part of the batch a step is.
  withUndo(j.name + " (" + (j.undoSteps + 1) + ")", function () {
    for (; j.cursor < endAt; j.cursor++) {
      var step = j.ops[j.cursor];
      try {
        var handler = OPS[step.op];
        if (!handler) throw new Error("Unknown op: " + step.op);
        j.results.push(handler(step.args || {}));
      } catch (e) {
        j.errors.push({ index: j.cursor, op: step.op, error: e.message });
        if (j.transactional) {
          failure = { error: e.message, atIndex: j.cursor };
          return;
        }
      }
    }
  });
  j.undoSteps += __undoGroupsOpened() - before;

  if (failure) {
    // No rollback is attempted. The old code fired one `Undo` menu command
    // here, which undoes at most the last step even when it works at all —
    // menu commands depend on host focus and the active selection, neither of
    // which this bridge has. Reporting a rollback that did not happen is the
    // same class of lie as swallowing an error, so it says plainly what is on
    // disk and how many steps it took.
    var failed = {
      done: true, failed: true, jobId: jobId,
      error: failure.error, atIndex: failure.atIndex,
      results: j.results, errors: j.errors,
      rolledBack: false,
      undoSteps: j.undoSteps, undoGroupName: j.name,
      note: __batchUndoNote(j.undoSteps, j.name, false, true) +
        " Nothing was rolled back: the ops before op[" + failure.atIndex + "] are applied and " +
        "stay applied. Read the state back rather than re-running the batch.",
    };
    if (j.diffState) failed.diff = __diffFinish(j.diffState);
    return failed;
  }
  if (j.cursor >= j.total) {
    var done = {
      done: true, jobId: jobId,
      results: j.results, errors: j.errors, total: j.total,
      undoSteps: j.undoSteps, undoGroupName: j.name,
      note: __batchUndoNote(j.undoSteps, j.name, false, true),
    };
    if (j.diffState) done.diff = __diffFinish(j.diffState);
    return done;
  }
  return { done: false, jobId: jobId, progress: j.cursor, total: j.total, undoSteps: j.undoSteps };
});

OPS._cancel_job = noUndo(function (args) {
  var j = JOBS[args.jobId];
  if (!j) return { ok: false, error: "No such job" };
  j.cancelled = true;
  return { ok: true };
});

OPS._get_job = noUndo(function (args) {
  var j = JOBS[args.jobId];
  if (!j) return null;
  return {
    cursor: j.cursor, total: j.total, cancelled: j.cancelled,
    errorCount: j.errors.length, undoSteps: j.undoSteps,
  };
});
