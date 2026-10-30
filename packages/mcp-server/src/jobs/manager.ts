import type { JobState } from "@engineroom/shared";

export function isTerminal(status: JobState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function unknownJobMessage(jobId: string, nothing = "Nothing was waited on."): string {
  return (
    `No job "${jobId}" in this server process. Job ids come from run_batch and render_queue and live in this ` +
    "server's memory only, so an id from before the server restarted, or a mistyped one, is unknown here. " +
    `${nothing} If the work may have run, read the comp back rather than re-sending it.`
  );
}

function waitTimeoutMessage(jobId: string, timeoutMs: number): string {
  return (
    `await_job(${jobId}) stopped waiting after ${timeoutMs}ms; the job is STILL RUNNING. Do not re-send ` +
    `the work — call await_job({jobId: "${jobId}"}) again to keep waiting, or get_job to read its progress.`
  );
}

function abortedWaitMessage(jobId: string): string {
  return (
    `await_job(${jobId}) was cancelled by the client. Only the wait stopped — the job is still running. ` +
    "Call await_job again to keep waiting, or cancel_job to stop the job itself."
  );
}

function numberField(v: unknown, key: string): number | undefined {
  if (!v || typeof v !== "object") return undefined;
  const n = (v as Record<string, unknown>)[key];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Ops a batch result says were attempted: what succeeded plus what failed
 * under continue-on-error (a transactional failure records its op in `errors`
 * too). Undefined for a result that is not a batch's.
 */
function opsAttempted(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { results?: unknown; errors?: unknown };
  if (!Array.isArray(r.results) && !Array.isArray(r.errors)) return undefined;
  return (Array.isArray(r.results) ? r.results.length : 0) + (Array.isArray(r.errors) ? r.errors.length : 0);
}

type ProgressEmitter =(jobId: string, progress: number, total?: number, message?: string) => void;

interface PendingResolver {
  resolve: (state: JobState) => void;
  reject: (err: Error) => void;
}

export class JobManager {
  private jobs = new Map<string, JobState>();
  private waiters = new Map<string, PendingResolver[]>();
  private progressEmitters = new Map<string, ProgressEmitter[]>();

  register(jobId: string, total?: number): JobState {
    const s: JobState = {
      jobId,
      status: "running",
      progress: 0,
      total,
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, s);
    return s;
  }

  /**
   * Forward this job's progress to `fn` until the job settles or the returned
   * function is called.
   *
   * The caller owns the lifetime, and the returned unbind is not optional: an
   * emitter is bound for the span of one MCP request — `await_job` — and one
   * left behind would keep sending `notifications/progress` on that request's
   * token after its response, which is exactly what a spec-compliant client
   * stops listening for the moment the response arrives (issue #82). `flush`
   * drops every emitter when the job finishes, so unbinding after that is a
   * no-op rather than an error.
   */
  bindProgressEmitter(jobId: string, fn: ProgressEmitter): () => void {
    const arr = this.progressEmitters.get(jobId) ?? [];
    arr.push(fn);
    this.progressEmitters.set(jobId, arr);
    return () => this.unbindProgressEmitter(jobId, fn);
  }

  unbindProgressEmitter(jobId: string, fn: ProgressEmitter): void {
    const arr = this.progressEmitters.get(jobId);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.progressEmitters.delete(jobId);
  }

  /** How many emitters a job currently has. Exists for the tests. */
  progressEmitterCount(jobId: string): number {
    return this.progressEmitters.get(jobId)?.length ?? 0;
  }

  reportProgress(jobId: string, progress: number, total?: number, message?: string): void {
    const s = this.jobs.get(jobId);
    if (s) {
      s.progress = progress;
      if (total !== undefined) s.total = total;
      // While cancelling, the message is the cancel's; a chunk's "running"
      // arriving after the cancel was accepted must not hide that.
      if (message !== undefined && s.status !== "cancelling") s.message = message;
    }
    const emitters = this.progressEmitters.get(jobId) ?? [];
    for (const e of emitters) {
      try { e(jobId, progress, total, message); } catch {}
    }
  }

  /**
   * A terminal state is sticky. The panel's `complete` event for a cancelled
   * batch arrives after `cancel_job` has answered, and a render's exit can
   * land after its cancel report — before issue #158 either one overwrote the
   * state it found, so a cancelled job read back as `completed`. Returns
   * whether this call settled the job.
   */
  complete(jobId: string, result: unknown): boolean {
    const s = this.jobs.get(jobId);
    if (!s || isTerminal(s.status)) return false;
    // A batch that stopped on a cancel reports itself complete with
    // `cancelled: true` and the ops it ran before stopping. That is the
    // cancel's own outcome, and it is recorded as one, partial result kept.
    const stoppedOnCancel =
      !!result && typeof result === "object" && (result as { cancelled?: unknown }).cancelled === true;
    if (stoppedOnCancel) {
      s.status = "cancelled";
      s.message = "cancelled; `result` holds what ran before the cancel took effect";
    } else {
      if (s.status === "cancelling") {
        s.message = "cancel_job arrived too late: the job had already run to the end, and every op in it was applied";
      }
      s.status = "completed";
    }
    // The panel's last `progress` event is the chunk boundary *before* the
    // final chunk — the chunk that finishes the job reports `done` and no
    // progress — so a finished 600-op batch used to read back as 575/600,
    // "running" (issue #222). The terminal state says where the job ended.
    const attempted = opsAttempted(result);
    if (s.status === "completed") {
      const total = s.total ?? numberField(result, "total") ?? attempted;
      if (total !== undefined) {
        s.total = total;
        s.progress = total;
      }
      if (s.message === undefined || !/too late/.test(s.message)) s.message = "completed";
    } else if (attempted !== undefined) {
      s.progress = attempted;
    }
    s.result = result;
    s.finishedAt = Date.now();
    this.flush(jobId);
    return true;
  }

  /**
   * `progress`, when the panel knows it, is how many ops had been attempted
   * when the job stopped. With `unsureThrough` it is only a lower bound: a
   * chunk failed outright, and ops `progress + 1` to `unsureThrough` may have
   * partly or fully run. Without either, the job keeps the last chunk boundary
   * it was told of, and the message says that is all it is.
   */
  fail(jobId: string, error: string, progress?: number, unsureThrough?: number): boolean {
    const s = this.jobs.get(jobId);
    if (!s || isTerminal(s.status)) return false;
    s.status = "failed";
    s.error = error;
    const of = s.total !== undefined ? ` of ${s.total}` : "";
    const known = typeof progress === "number" && Number.isFinite(progress);
    if (known && typeof unsureThrough === "number" && Number.isFinite(unsureThrough) && unsureThrough > progress) {
      s.progress = progress;
      s.message =
        `failed: at least ${progress}${of} ops ran; the failing chunk (ops ${progress + 1}–${unsureThrough}) ` +
        "may have partly run, so read back before re-running";
    } else if (known) {
      s.progress = progress;
      s.message = `failed after ${progress}${of} ops attempted`;
    } else {
      s.message = `failed; progress ${s.progress}${of} is the last point reported before it stopped, not necessarily where it stopped`;
    }
    s.finishedAt = Date.now();
    this.flush(jobId);
    return true;
  }

  /**
   * Settle the job as cancelled — for a caller that has *seen* it stop, as the
   * render runner has once aerender exits. A batch is never settled here: what
   * it did before stopping is only known when the panel's `complete` event
   * says so, so `cancel_job` marks it with `markCancelling` and waits for that.
   *
   * `result`, when given, is what `await_job` returns for the cancelled job —
   * a cancelled render says what it left on disk, which is not nothing.
   */
  cancel(jobId: string, result?: unknown): boolean {
    const s = this.jobs.get(jobId);
    if (!s || isTerminal(s.status)) return false;
    s.status = "cancelled";
    s.message = "cancelled";
    if (result !== undefined) s.result = result;
    s.finishedAt = Date.now();
    this.flush(jobId);
    return true;
  }

  /** The panel accepted a cancel; the job stops at its next chunk boundary. Not terminal. */
  markCancelling(jobId: string): boolean {
    const s = this.jobs.get(jobId);
    if (!s || isTerminal(s.status)) return false;
    s.status = "cancelling";
    s.message = "cancel accepted by the panel; the job stops at its next chunk boundary";
    return true;
  }

  /**
   * Attach a warning the job's state must carry (issue #223). Sticky; a
   * different later one is added after it, never in its place — a batch can
   * both lose the shared lock and recover a lost chunk (issue #220), and each
   * says something the result cannot.
   */
  warn(jobId: string, warning: string): void {
    const s = this.jobs.get(jobId);
    if (!s) return;
    if (!s.warning) s.warning = warning;
    else if (!s.warning.includes(warning)) s.warning = `${s.warning}\n\n${warning}`;
  }

  get(jobId: string): JobState | undefined { return this.jobs.get(jobId); }

  /**
   * Block until the job settles.
   *
   * An id this process never registered fails at once (issue #159): jobs live
   * in memory, so one from a previous server process, or a typo, used to hold
   * the call for the full ten minutes and then say nothing useful. A timeout
   * or an aborted request releases only the wait — the job goes on, and both
   * messages say so, because the right move is to wait again, not to re-send.
   */
  async waitFor(jobId: string, timeoutMs = 600_000, signal?: AbortSignal): Promise<JobState> {
    const cur = this.jobs.get(jobId);
    if (!cur) throw new Error(unknownJobMessage(jobId));
    if (isTerminal(cur.status)) {
      if (cur.status === "failed") throw new Error(cur.error || "job failed");
      return cur;
    }
    if (signal?.aborted) throw new Error(abortedWaitMessage(jobId));
    return new Promise<JobState>((resolve, reject) => {
      let done = false;
      const release = () => {
        done = true;
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        // A released waiter leaves the list, so a long-lived job does not
        // collect one dead entry per timed-out await_job.
        const list = this.waiters.get(jobId);
        if (!list) return;
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.waiters.delete(jobId);
      };
      const entry: PendingResolver = {
        resolve: (st) => { if (done) return; release(); resolve(st); },
        reject: (e) => { if (done) return; release(); reject(e); },
      };
      const onAbort = () => entry.reject(new Error(abortedWaitMessage(jobId)));
      const t = setTimeout(() => entry.reject(new Error(waitTimeoutMessage(jobId, timeoutMs))), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const arr = this.waiters.get(jobId) ?? [];
      arr.push(entry);
      this.waiters.set(jobId, arr);
    });
  }

  /**
   * Up to `ms` for the job to reach a terminal state, then its state, settled
   * or not. Never throws: a failed job is answered with its state.
   */
  async settle(jobId: string, ms: number): Promise<JobState | undefined> {
    try {
      return await this.waitFor(jobId, ms);
    } catch {
      return this.jobs.get(jobId);
    }
  }

  /** How many await_job calls are blocked on a job. Exists for the tests. */
  waiterCount(jobId: string): number {
    return this.waiters.get(jobId)?.length ?? 0;
  }

  private flush(jobId: string): void {
    const s = this.jobs.get(jobId);
    if (!s) return;
    const waiters = [...(this.waiters.get(jobId) ?? [])];
    this.waiters.delete(jobId);
    for (const w of waiters) {
      if (s.status === "failed") w.reject(new Error(s.error || "job failed"));
      else w.resolve(s);
    }
    this.progressEmitters.delete(jobId);
  }
}
