// batch.jsx — execute many ops in one ExtendScript pass.
// For huge batches, registers a job and processes in chunks via _continue_job.

OPS.run_batch = function (args) {
  var ops = args.ops || [];
  var transactional = args.transactional !== false;
  var name = args.undoGroupName || "AE MCP Batch";
  // diff:true fingerprints the comps this batch names, before and after, inside
  // this one call — see snapshot.jsx. Null unless asked for.
  var diffState = __diffStart(args, ops);
  // Short batches: run inline synchronously. Inline stays sub-second for
  // typical create/keyframe ops up to a few hundred; the async-job overhead
  // (jobId envelope, polling, progress notifications) is only worth it for
  // genuinely long jobs.
  if (ops.length <= 500) {
    var results = []; var errors = [];
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
    var out = { results: results, errors: errors, total: ops.length };
    if (diffState) out.diff = __diffFinish(diffState);
    return out;
  }
  // Long batches: register job, return jobId; panel polls _continue_job.
  var jobId = __newJobId();
  JOBS[jobId] = {
    cursor: 0,
    total: ops.length,
    ops: ops,
    results: [],
    errors: [],
    cancelled: false,
    transactional: transactional,
    name: name,
    // Carried across the chunked continuations: the before-fingerprint has to
    // outlive the call that took it, or a long batch could never be diffed.
    diffState: diffState,
  };
  // Wrap async run already inside an undoGroup chain. We open it now, the
  // continuations stay inside it until finalization.
  app.beginUndoGroup(name);
  JOBS[jobId].undoOpen = true;
  return { jobId: jobId, async: true, total: ops.length };
};
// run_batch is allowed to manage its own undo (we open/close it manually for long jobs).
OPS.run_batch.__meta = { noUndo: true };

// Continuation step. Returns one chunk's worth of progress.
OPS._continue_job = noUndo(function (args) {
  var jobId = args.jobId;
  var j = JOBS[jobId];
  if (!j) throw new Error("No job: " + jobId);
  if (j.cancelled) {
    if (j.undoOpen) { app.endUndoGroup(); j.undoOpen = false; }
    return { done: true, cancelled: true, jobId: jobId, results: j.results, errors: j.errors };
  }
  var chunkSize = args.chunkSize || 25;
  var endAt = Math.min(j.cursor + chunkSize, j.total);
  for (; j.cursor < endAt; j.cursor++) {
    var step = j.ops[j.cursor];
    try {
      var handler = OPS[step.op];
      if (!handler) throw new Error("Unknown op: " + step.op);
      j.results.push(handler(step.args || {}));
    } catch (e) {
      j.errors.push({ index: j.cursor, op: step.op, error: e.message });
      if (j.transactional) {
        if (j.undoOpen) { app.endUndoGroup(); j.undoOpen = false; }
        // Attempt rollback via undo
        try { app.executeCommand(app.findMenuCommandId("Undo")); } catch (e2) {}
        var failed = { done: true, failed: true, jobId: jobId, error: e.message, atIndex: j.cursor, results: j.results, errors: j.errors };
        // Taken after the undo attempt, so it reports the state that actually
        // survived rather than the one before AE was asked to back it out.
        if (j.diffState) failed.diff = __diffFinish(j.diffState);
        return failed;
      }
    }
  }
  if (j.cursor >= j.total) {
    if (j.undoOpen) { app.endUndoGroup(); j.undoOpen = false; }
    var done = { done: true, jobId: jobId, results: j.results, errors: j.errors, total: j.total };
    if (j.diffState) done.diff = __diffFinish(j.diffState);
    return done;
  }
  return { done: false, jobId: jobId, progress: j.cursor, total: j.total };
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
  return { cursor: j.cursor, total: j.total, cancelled: j.cancelled, errorCount: j.errors.length };
});
