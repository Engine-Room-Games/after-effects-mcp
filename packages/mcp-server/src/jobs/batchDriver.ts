import { isTerminal, type JobManager } from "./manager.js";
import { BridgeResetError, BridgeTimeoutError, BridgeUnreachableError, WriteQueueCancelledError, WriteQueueWaitError } from "../util/errors.js";
import { logger } from "../util/logger.js";

/**
 * Drives a chunked `run_batch` from the server (issue #220, stage 5).
 *
 * The batch itself lives in ExtendScript (`JOBS` in core.jsx): its ops, its
 * cursor, its results. What moved here is the loop that used to run inside the
 * panel — send `_continue_job`, read how far it got, send the next — so the
 * server owns progress, cancel and the job's state directly instead of hearing
 * about them over a WebSocket. Each `_continue_job` is still one `evalScript`
 * with one undo group opened and closed inside it (issue #69); nothing about a
 * chunk changed, only who asks for the next one.
 *
 * The one thing this costs, and why most of this file exists: the panel
 * finished a batch even when the server died. Now a dead server stops it at a
 * chunk boundary. So every way the loop can stop says how far the batch got,
 * and nothing here ever runs an op twice:
 *
 * - **The cursor is After Effects'.** `_continue_job` runs from wherever the
 *   job's own cursor is, so sending it again can only ever run the *next* ops.
 *   That is what makes it safe to carry on after a chunk whose answer was lost
 *   on the way back — the front desk dying mid-call: `_get_job` (a read, safe
 *   to send again) says where the cursor is now, the loop continues from
 *   there, and the job carries a warning saying so. Never silently.
 * - **A chunk that timed out is not followed.** It may still be running in
 *   After Effects; the job fails saying which ops may have run.
 * - **A server that dies leaves the job in ExtendScript, not running.** Nobody
 *   resumes it: a restarted server does not know the id, and says so with
 *   what `_get_job` reports (server.ts). core.jsx retires the orphan after
 *   `__JOB_ORPHAN_MS` without a continuation.
 */

export interface BatchEnvelope {
  jobId: string;
  total?: number;
  chunkSize?: number;
  aeWarnings?: unknown;
}

export interface BatchDriverBridge {
  /** `_continue_job` for one chunk, sent as a write under the batch's lease. */
  continueJob(jobId: string, chunkSize: number): Promise<unknown>;
  /** `_get_job`: After Effects' own record of the job. A read. */
  getJob(jobId: string): Promise<unknown>;
  /** `/cancel` → `_cancel_job`. Best effort when the driver stops on its own. */
  cancel(jobId: string): Promise<{ known: boolean; error?: string }>;
}

/** What `_get_job` answers, as far as the driver reads it. */
export interface AeJobRecord {
  cursor: number;
  total?: number;
  finished: boolean;
  cancelled?: boolean;
  abandoned?: boolean;
  errorCount?: number;
  undoSteps?: number;
  idleMs?: number | null;
}

/** How many lost answers one batch recovers from before it gives up. */
const MAX_RECOVERIES = 4;
const DEFAULT_CHUNK = 25;

export function readAeJobRecord(raw: unknown): AeJobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cursor !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    cursor: r.cursor,
    total: num(r.total),
    finished: r.finished === true,
    cancelled: r.cancelled === true,
    abandoned: r.abandoned === true,
    errorCount: num(r.errorCount),
    undoSteps: num(r.undoSteps),
    idleMs: num(r.idleMs) ?? null,
  };
}

function warningsSuffix(w: string[]): string {
  return w.length
    ? " || After Effects also reported, through app.onError while dialogs were suppressed: " + w.join(" | ")
    : "";
}

interface Driving {
  stopFor: string | null;
}

export class BatchDriver {
  private driving = new Map<string, Driving>();

  constructor(private jobs: JobManager, private bridge: BatchDriverBridge) {}

  /** Ids this driver is running now. For tests and diagnostics. */
  get running(): string[] {
    return [...this.driving.keys()];
  }

  /**
   * Stop every batch at its next chunk boundary — the session is closing, and
   * a chunk sent after that would go out without the write lock. The chunk in
   * flight finishes; the job fails saying how far it got.
   */
  stopAll(why: string): void {
    for (const d of this.driving.values()) d.stopFor ??= why;
  }

  /**
   * Run the batch to its end. Never rejects: every outcome settles the job in
   * `JobManager`, and the promise resolves once the batch is over in After
   * Effects as far as this server can make it — which is what the write lease
   * is held until.
   */
  async drive(env: BatchEnvelope): Promise<void> {
    const { jobId } = env;
    const d: Driving = { stopFor: null };
    this.driving.set(jobId, d);
    try {
      await this.loop(env, d);
    } catch (e) {
      // A bug here must still settle the job, or await_job waits for ever.
      this.jobs.fail(jobId, `Batch ${jobId}: the server's batch driver failed (${(e as Error).message}). Read the comp back before re-running anything.`);
    } finally {
      this.driving.delete(jobId);
    }
  }

  private async loop(env: BatchEnvelope, d: Driving): Promise<void> {
    const { jobId } = env;
    const size = env.chunkSize && env.chunkSize > 0 ? env.chunkSize : DEFAULT_CHUNK;
    let total: number | null = typeof env.total === "number" ? env.total : null;
    // The cursor: ops attempted, not ops that succeeded — a continue-on-error
    // batch moves past a failed op too.
    let attempted = 0;
    let steps = 0;
    let recoveries = 0;
    // What After Effects reported through app.onError in ANY chunk (#225).
    // Each chunk is its own dispatch, so a warning raised in chunk 3 of 40
    // would otherwise be on a result nobody reads.
    let aeWarnings: string[] = Array.isArray(env.aeWarnings) ? env.aeWarnings.map(String) : [];

    for (;;) {
      const st = this.jobs.get(jobId);
      // Settled elsewhere: cancel_job found After Effects had lost the job.
      if (!st || isTerminal(st.status)) return;
      if (d.stopFor !== null) {
        this.stopped(jobId, d.stopFor, attempted, total, steps, aeWarnings, null);
        await this.cancelQuietly(jobId);
        return;
      }

      let res: Record<string, unknown>;
      try {
        res = ((await this.bridge.continueJob(jobId, size)) ?? {}) as Record<string, unknown>;
      } catch (e) {
        if (e instanceof BridgeResetError && recoveries < MAX_RECOVERIES && d.stopFor === null) {
          // The chunk reached the desk or the panel and its answer did not come
          // back. After Effects knows where the cursor is; ask it.
          const rec = await this.record(jobId);
          if (rec && !rec.finished && rec.cursor >= attempted) {
            recoveries++;
            const lostAt = attempted;
            attempted = rec.cursor;
            if (typeof rec.undoSteps === "number") steps = rec.undoSteps;
            if (typeof rec.total === "number") total = rec.total;
            this.jobs.warn(
              jobId,
              `One chunk's answer was lost on the way back (${(e as Error).message.split("\n")[0]}). The batch carried on ` +
                `from op ${rec.cursor + 1}, where After Effects' own record of it said it had reached ` +
                `(${rec.cursor - lostAt} op(s) of that chunk had run); no op was sent twice. ` +
                "Any After Effects warnings and per-op results from that chunk are in the final result only if the chunk ran."
            );
            this.jobs.reportProgress(jobId, attempted, total ?? undefined, "running");
            continue;
          }
          if (rec && rec.finished) {
            this.jobs.fail(jobId, finishedUnseenMessage(jobId, rec, e as Error) + warningsSuffix(aeWarnings), rec.cursor);
            return;
          }
        }
        this.stopped(jobId, null, attempted, total, steps, aeWarnings, e as Error, size);
        // A timed-out chunk may still be running; a cancel makes sure nothing
        // after it does, if anything ever sends the job another continuation.
        await this.cancelQuietly(jobId);
        return;
      }

      if (Array.isArray(res.aeWarnings) && res.aeWarnings.length) aeWarnings = aeWarnings.concat(res.aeWarnings.map(String));
      if (typeof res.total === "number") total = res.total;
      if (!res.done) {
        if (typeof res.progress === "number") attempted = res.progress;
        if (typeof res.undoSteps === "number") steps = res.undoSteps;
        this.jobs.reportProgress(jobId, attempted, total ?? undefined, "running");
        continue;
      }
      if (res.failed) {
        // The ops before the failure are applied and stay applied; what the
        // batch cost has to travel inside the error or it is lost.
        const msg =
          String(res.error ?? "batch failed") + (res.note ? " || " + String(res.note) : "") + warningsSuffix(aeWarnings);
        // Where it stopped (issue #222): every op attempted, the failing one included.
        const failedAt =
          (Array.isArray(res.results) ? res.results.length : 0) + (Array.isArray(res.errors) ? res.errors.length : 0);
        this.jobs.fail(jobId, msg, failedAt);
        return;
      }
      // `undoSteps` is the measured number of undo groups the batch opened,
      // and `diff` is the batch's own before/after — the agent sees both only
      // on this result. A cancelled stop is a completion with `cancelled:true`.
      const completed: Record<string, unknown> = {
        results: res.results,
        errors: res.errors,
        total: res.total ?? total ?? undefined,
        cancelled: !!res.cancelled,
        undoSteps: res.undoSteps,
        undoGroupName: res.undoGroupName,
        note: res.note,
        diff: res.diff,
      };
      if (aeWarnings.length) completed.aeWarnings = aeWarnings;
      this.jobs.complete(jobId, completed);
      return;
    }
  }

  private async record(jobId: string): Promise<AeJobRecord | null> {
    try {
      return readAeJobRecord(await this.bridge.getJob(jobId));
    } catch (e) {
      logger.warn(`batch ${jobId}: could not read After Effects' record of the job: ${(e as Error).message}`);
      return null;
    }
  }

  private async cancelQuietly(jobId: string): Promise<void> {
    try {
      await this.bridge.cancel(jobId);
    } catch (e) {
      logger.debug(`batch ${jobId}: cancel after stopping was not confirmed: ${(e as Error).message}`);
    }
  }

  /**
   * Settle a job the loop is giving up on, saying what had landed. A bare
   * error — "No job: j_…" after a bundle reload, or a reset's "may have run",
   * which is true of one call and not of the batch — would invite a re-run
   * that applies the chunks before it twice.
   */
  private stopped(
    jobId: string,
    stopFor: string | null,
    attempted: number,
    total: number | null,
    steps: number,
    aeWarnings: string[],
    e: Error | null,
    size = 0
  ): void {
    const msg = e ? e.message : "";
    let cause: string;
    if (stopFor !== null) cause = `${stopFor} The next chunk was not sent.`;
    else if (/^No job: /.test(msg))
      cause =
        "the AE MCP bundle was reloaded in After Effects (another script removed it from the shared script engine, " +
        "or /reload-jsx ran), which discards running jobs.";
    else if (e instanceof BridgeTimeoutError)
      cause = `a chunk did not answer in time and may still be running in After Effects, so no further chunk was sent. (${msg.split("\n")[0]})`;
    // The first line only: what follows in a bridge error is the remedy for a
    // single call ("re-sending is safe"), which is false of a batch.
    else cause = msg.split("\n")[0].split("Nothing ran.").join("The next chunk did not run.").replace(/[\s.]*$/, ".");
    // Unless the next chunk provably never reached After Effects, it may have
    // partly or fully run (#222): a timeout, a lost answer, an error raised
    // after the chunk's ops ran ("Bad JSON" on the way back).
    const surelyUnsent =
      e === null ||
      e instanceof BridgeUnreachableError ||
      e instanceof WriteQueueWaitError ||
      e instanceof WriteQueueCancelledError ||
      /^No job: /.test(msg) ||
      /^Internal error: /.test(msg);
    const unsure = surelyUnsent ? 0 : size;
    const landed =
      attempted === 0 && steps === 0
        ? unsure > 0
          ? "No chunk had finished yet; the first may have partly run."
          : "No op of the batch had run yet."
        : `${attempted} of ${total ?? "?"} ops had already been attempted, in ${steps} undo step(s); whatever they ` +
          "changed stays applied (an op that failed under continue-on-error may not have changed anything)." +
          (unsure > 0 ? " The chunk after them may have partly run." : "");
    const advice = " Do NOT re-run the batch as it was: read the comp back and send only the ops that are missing.";
    const text = `Batch ${jobId} stopped mid-run: ${cause} ${landed}${advice}${warningsSuffix(aeWarnings)}`;
    logger.error(text);
    const unsureThrough = unsure > 0 ? (total === null ? attempted + unsure : Math.min(attempted + unsure, total)) : undefined;
    this.jobs.fail(jobId, text, attempted, unsureThrough);
  }
}

/**
 * The last chunk ran and finished the job, and its answer — the per-op results —
 * was lost on the way back. What After Effects kept is the tombstone's counters.
 */
function finishedUnseenMessage(jobId: string, rec: AeJobRecord, e: Error): string {
  const of = rec.total !== undefined ? ` of ${rec.total}` : "";
  const how = rec.cancelled ? "stopped on a cancel" : rec.abandoned ? "was abandoned" : "ran to its end";
  return (
    `Batch ${jobId} ${how} in After Effects, but the answer to its last chunk was lost on the way back ` +
    `(${e.message.split("\n")[0]}), so its per-op results, diff and undo note are lost. After Effects' own record: ` +
    `${rec.cursor}${of} ops attempted, ${rec.errorCount ?? "?"} of them failed, in ${rec.undoSteps ?? "?"} undo step(s). ` +
    "Everything it did stays applied. Do NOT re-run the batch: read the comp back to confirm."
  );
}

/**
 * The answer for a batch id this server process never started — another
 * session's, or one started by this server before it restarted — from what
 * `_get_job` says. Never claims to know who is driving it.
 */
export function foreignJobText(jobId: string, rec: AeJobRecord): string {
  const of = rec.total !== undefined ? ` of ${rec.total}` : "";
  const counts = `${rec.cursor}${of} ops attempted, ${rec.errorCount ?? "?"} failed, in ${rec.undoSteps ?? "?"} undo step(s)`;
  if (rec.finished) {
    const how = rec.abandoned
      ? "was abandoned — no chunk reached it for 30 minutes, which is what a batch whose server stopped looks like"
      : rec.cancelled
        ? "stopped on a cancel"
        : "has finished";
    return (
      `No job "${jobId}" in this server process, but After Effects knows it: it ${how}. ${counts}; what ran stays ` +
      "applied. Its per-op results were returned only to the server that drove it. Read the comp back rather than re-sending it."
    );
  }
  const idle =
    typeof rec.idleMs === "number" ? ` Its last chunk started or ended ${Math.round(rec.idleMs / 1000)}s ago.` : "";
  return (
    `No job "${jobId}" in this server process, but After Effects holds it, unfinished: ${counts}.${idle} ` +
    "It belongs to another server process — another AI session's, or this session's server before it restarted. " +
    "Nothing in this process will continue it, and a batch whose server has stopped does not continue on its own: " +
    "if its last chunk is not recent, it has stopped there for good. Read the comp back and send only the ops that are missing."
  );
}
