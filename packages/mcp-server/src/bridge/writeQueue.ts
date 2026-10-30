import { WriteQueueCancelledError, WriteQueueFullError, WriteQueueWaitError } from "../util/errors.js";
import { logger } from "../util/logger.js";

/**
 * One writer at a time, for the whole After Effects session.
 *
 * The panel already serializes every individual `evalScript`, so two ordinary
 * writes cannot interleave *inside* one op. What it does not serialize is the
 * gap around a long `run_batch`: that handler returns the `{jobId, async}`
 * envelope immediately and the panel then drives `_continue_job` in chunks.
 * Every chunk is its own turn on the panel's chain, so any other op issued
 * meanwhile slots in *between* two chunks. That is the interleaving issue #55
 * reports, and closing it is why a lease can be held past the call that took it
 * (`extendUntil`).
 *
 * Issue #55 described the damage as an undo group being closed early by the
 * interloper's own `endUndoGroup()`. That reading was wrong in one detail: the
 * batch's group was already gone, because After Effects discards a group opened
 * in one `evalScript` and closed in another (issue #69). Each chunk now opens
 * and closes its own group, so an interleaved write can no longer break one.
 * The lease is still held for the whole job, for the reason that survives:
 * a batch is one thing the caller asked for, and a write dropped into the
 * middle of it runs out of the order the agent issued it in.
 *
 * Reads never come here. They are unaffected by an open undo group, and
 * screenshots are the slowest thing in the system — putting them behind this
 * would make every write wait on a render for no benefit.
 */

/** What a call reports when it did not get the lock immediately. */
export interface QueueWait {
  /** The op that held the lock at the moment this one joined the queue. */
  queuedBehind: string;
  waitedMs: number;
  /**
   * Present only when the call waited behind *another session's* write at the
   * front desk (issue #223) — who that session is, as its server describes it.
   */
  queuedBehindSession?: string;
}

export interface WriteLease {
  /** null when the lock was free — the overwhelmingly common case. */
  readonly wait: QueueWait | null;
  /**
   * Keep the lock past `release()` until `p` settles.
   *
   * For `run_batch`: the panel answers with a jobId while the batch is still
   * running in chunks, so the lock has to outlive the HTTP call that took it.
   * Rejections are swallowed — a failed job still frees the queue.
   */
  extendUntil(p: Promise<unknown>): void;
  /** Idempotent. A no-op after the first call. */
  release(): void;
  /**
   * Told if the lease stops protecting its work before it is released — only a
   * front-desk lease can (issue #223). Absent on this queue's own leases.
   */
  onLost?(listener: (why: string) => void): void;
  /**
   * Stop the clocks of every write queued behind this lease, until the
   * returned function is called or the lease is released (issue #245). For a
   * holder that is waiting on a *person* — a confirmation prompt — rather than
   * on After Effects: a write queued behind it must neither time out because
   * someone took a minute to read a dialog, nor blame the op in front for it.
   * Writes queued meanwhile are told what they waited for. Absent on a
   * front-desk lease; the confirmation holds only this session's queue.
   */
  pauseWaiters?(): () => void;
}

const DEFAULT_MAX_WAIT_MS = 600_000;
const DEFAULT_MAX_DEPTH = 64;

/**
 * How long a call may sit in the queue before it is dropped unrun.
 *
 * Generous on purpose: the thing in front is legitimately slow (a long batch,
 * a big `run_jsx`) far more often than it is stuck, and dropping a write the
 * user asked for costs more than waiting.
 */
export function queueWaitMs(): number {
  return envNumber("AE_MCP_WRITE_QUEUE_WAIT_MS", DEFAULT_MAX_WAIT_MS);
}

export function queueMaxDepth(): number {
  return envNumber("AE_MCP_WRITE_QUEUE_DEPTH", DEFAULT_MAX_DEPTH);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  logger.warn(`Ignoring ${name}=${raw} — expected a positive number.`);
  return fallback;
}

interface Waiter {
  op: string;
  enqueuedAt: number;
  behind: string;
  /** The queue clock's budget left, and when the running timer (if any) started. */
  remainingMs: number;
  timerStartedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  startTimer: () => void;
  /** Set when the holder in front waited on a person while this one queued. */
  behindConfirmation?: string;
  settle: (lease: WriteLease) => void;
  fail: (err: Error) => void;
  /** Set once the waiter has been resolved, rejected, cancelled or timed out. */
  done: boolean;
  cleanup: () => void;
}

export class WriteQueue {
  private holder: string | null = null;
  private waiting: Waiter[] = [];
  /** The holder waiting on a person, while it does; queue clocks are stopped. */
  private paused: string | null = null;
  /** Whose pause it is: a resume ends only the pause it started. */
  private pauseToken: object | null = null;
  /** Public for the front desk, which applies this session's limits to its cross-session wait. */
  readonly maxWaitMs: number;
  private readonly maxDepth: number;

  constructor(opts: { maxWaitMs?: number; maxDepth?: number } = {}) {
    this.maxWaitMs = opts.maxWaitMs ?? queueWaitMs();
    this.maxDepth = opts.maxDepth ?? queueMaxDepth();
  }

  /** For tests and diagnostics. */
  get depth(): number { return this.waiting.filter((w) => !w.done).length; }
  get held(): string | null { return this.holder; }
  get maxDepthLimit(): number { return this.maxDepth; }

  /**
   * The longest a lease may be held past its call by `extendUntil` — a leak
   * guard for a job that never reports completion (a dropped WS, say).
   *
   * Twice the wait ceiling on purpose. Anything already queued behind that job
   * has hit its own deadline and gone by then, so expiring the hold can never
   * hand the lock to a writer while the batch is still going.
   */
  get holdCeilingMs(): number { return this.maxWaitMs * 2; }

  /**
   * Wait for the lock, then return the lease.
   *
   * Rejects rather than resolving late when the request was cancelled, when the
   * wait ran past `maxWaitMs`, or when the queue is full. In every one of those
   * cases the caller must not go on to hit the bridge — nothing was written,
   * and the error says so, which is what makes re-sending safe there and unsafe
   * after a bridge timeout.
   */
  acquire(op: string, signal?: AbortSignal): Promise<WriteLease> {
    if (signal?.aborted) {
      return Promise.reject(new WriteQueueCancelledError(op));
    }
    if (this.holder === null && this.depth === 0) {
      this.holder = op;
      return Promise.resolve(this.makeLease(null));
    }
    if (this.depth >= this.maxDepth) {
      return Promise.reject(new WriteQueueFullError(op, this.maxDepth, this.holder ?? "another write", this.paused ?? undefined));
    }

    const behind = this.holder ?? this.waiting.find((w) => !w.done)?.op ?? "another write";
    return new Promise<WriteLease>((resolve, reject) => {
      const waiter: Waiter = {
        op,
        enqueuedAt: Date.now(),
        behind,
        remainingMs: this.maxWaitMs,
        timerStartedAt: 0,
        timer: null,
        startTimer: () => {},
        behindConfirmation: this.paused ?? undefined,
        done: false,
        settle: resolve,
        fail: reject,
        cleanup: () => {},
      };

      const onTimeout = () => {
        if (waiter.done) return;
        waiter.done = true;
        waiter.cleanup();
        // Timing out in the queue frees nothing: whoever is in front still holds
        // the lock. Just stop waiting.
        reject(new WriteQueueWaitError(op, this.maxWaitMs, waiter.behind, waiter.behindConfirmation));
        this.pump();
      };
      waiter.startTimer = () => {
        waiter.timerStartedAt = Date.now();
        waiter.timer = setTimeout(onTimeout, Math.max(0, waiter.remainingMs));
        // A queued write must never be the reason the process stays alive.
        waiter.timer.unref?.();
      };
      // Behind a holder waiting on a person, the clock starts when it stops.
      if (this.paused === null) waiter.startTimer();

      const onAbort = () => {
        if (waiter.done) return;
        waiter.done = true;
        waiter.cleanup();
        // Dropped, never executed. A cancelled request whose work runs later is
        // the leak this exists to avoid.
        reject(new WriteQueueCancelledError(op));
        this.pump();
      };

      waiter.cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = null;
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.waiting.push(waiter);
    });
  }

  private makeLease(wait: QueueWait | null): WriteLease {
    let released = false;
    let hold: Promise<unknown> | null = null;
    const queue = this;
    return {
      wait,
      extendUntil(p: Promise<unknown>) {
        hold = p;
        if (released) settleHold();
      },
      release() {
        if (released) return;
        released = true;
        if (hold) settleHold();
        else queue.handOff();
      },
      pauseWaiters() {
        if (released) return () => {};
        const token = queue.pause();
        return () => { if (token) queue.resume(token); };
      },
    };

    function settleHold() {
      const p = hold;
      hold = null;
      if (!p) return;
      const ceiling = queue.holdCeilingMs;
      let fired = false;
      const done = () => {
        if (fired) return;
        fired = true;
        queue.handOff();
      };
      const t = setTimeout(() => {
        if (fired) return;
        logger.warn(
          `A write held the After Effects queue for over ${Math.round(ceiling / 1000)}s without its job reporting completion; releasing it.`
        );
        done();
      }, ceiling);
      t.unref?.();
      p.then(done, done).finally(() => clearTimeout(t));
    }
  }

  private handOff(): void {
    this.holder = null;
    // The holder is gone, so whatever it paused ends with it.
    if (this.pauseToken) this.resume(this.pauseToken);
    this.pump();
  }

  /** Null when a pause is already running or nothing holds the queue: there is then nothing for this caller to end. */
  private pause(): object | null {
    if (this.paused !== null || this.holder === null) return null;
    const token = {};
    this.pauseToken = token;
    this.paused = this.holder;
    const now = Date.now();
    for (const w of this.waiting) {
      if (w.done) continue;
      w.behindConfirmation = this.paused;
      if (w.timer) {
        clearTimeout(w.timer);
        w.timer = null;
        w.remainingMs -= now - w.timerStartedAt;
      }
    }
    return token;
  }

  private resume(token: object): void {
    if (this.pauseToken !== token) return;
    this.pauseToken = null;
    this.paused = null;
    for (const w of this.waiting) if (!w.done && w.timer === null) w.startTimer();
  }

  private pump(): void {
    if (this.holder !== null) return;
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (next.done) continue;
      next.done = true;
      next.cleanup();
      this.holder = next.op;
      const queuedBehind = next.behindConfirmation
        ? `${next.behind}${next.behind === next.behindConfirmation ? "" : ` and ${next.behindConfirmation}`}, while ${next.behindConfirmation} waited for the user to answer a confirmation`
        : next.behind;
      next.settle(this.makeLease({ queuedBehind, waitedMs: Date.now() - next.enqueuedAt }));
      return;
    }
  }
}

/**
 * Fold the queue note into a result.
 *
 * Returns the merged object, or `null` when there is nothing safe to merge
 * into: `run_jsx` hands back whatever the caller's script returned — arrays,
 * numbers, strings — and rewrapping those would change what every existing
 * caller reads. The server sends those as a second text block instead, which
 * cannot corrupt any envelope.
 */
export function mergeWait(value: unknown, wait: QueueWait): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if ("queuedBehind" in obj || "waitedMs" in obj) return null;
  return { ...obj, ...wait };
}
