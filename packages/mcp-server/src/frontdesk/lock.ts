import { randomUUID } from "node:crypto";
import { DeskWaitError, WriteQueueCancelledError, WriteQueueFullError, WriteQueueWaitError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import type { DeskAhead, GrantWait, LockLine } from "./protocol.js";

/**
 * The one write lock every session on an After Effects shares (issue #223).
 *
 * Each server still runs its own `WriteQueue` first, so a session's own calls
 * leave it in the order the agent issued them, exactly as before. This is the
 * second gate: one writer *across* sessions, held for the whole of a chunked
 * `run_batch` the same way the per-session queue is, so no other session's
 * write lands between two chunks.
 *
 * Three things it adds to `WriteQueue`, all for the desk:
 *
 * - **It knows who everyone is.** A waiter is told its position, what holds the
 *   lock, whose it is and for how long — the truth, measured here, outside
 *   After Effects, where the clock keeps running while ExtendScript does.
 * - **Resumed leases jump the line.** A session whose lease was lost with a dead
 *   desk while its batch still runs re-takes the lock at the new desk ahead of
 *   anyone else.
 * - **A grace period after a takeover.** For `graceMs` after a desk replaces a
 *   dead one, only resumed leases are granted — so a session that noticed the
 *   death a few milliseconds sooner cannot slip a write between two chunks of a
 *   batch whose owner is still reconnecting.
 */

export interface LockRequest {
  op: string;
  /** Stable for the life of a server process; how the lock tells sessions apart. */
  sessionId: string;
  /** Human: client name and pid. Only ever shown to *another* session. */
  session: string;
  maxWaitMs: number;
  maxDepth: number;
  /** Re-taking a lease lost with a dead desk. Granted ahead of everything else. */
  resume?: boolean;
  /** The longest the grant may be held before the desk frees it regardless. */
  holdCeilingMs: number;
  onUpdate?: (line: Extract<LockLine, { t: "wait" }>) => void;
}

export interface LockGrant {
  id: string;
  /** Null unless it waited behind another session — single-session results are unchanged. */
  wait: GrantWait | null;
}

interface Holder {
  id: string;
  op: string;
  sessionId: string;
  session: string;
  since: number;
  ceiling: NodeJS.Timeout;
}

interface Waiter {
  req: LockRequest;
  enqueuedAt: number;
  /** The first thing from another session this waiter was behind, if any. */
  behindOther: { op: string; session: string } | null;
  done: boolean;
  settle: (g: LockGrant) => void;
  fail: (e: Error) => void;
  cleanup: () => void;
}

/** How often a waiter is reminded where it stands, so a long wait never goes quiet. */
export const UPDATE_EVERY_MS = 2000;

export class DeskLock {
  private holder: Holder | null = null;
  private waiting: Waiter[] = [];
  private graceUntil: number;
  private graceTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private closed = false;

  private onHolderChange?: (holder: { op: string } | null) => void;

  constructor(opts: { graceMs?: number; onHolderChange?: (holder: { op: string } | null) => void } = {}) {
    this.graceUntil = Date.now() + (opts.graceMs ?? 0);
    this.onHolderChange = opts.onHolderChange;
  }

  private setHolder(h: Holder | null): void {
    this.holder = h;
    if (this.closed) return;
    try { this.onHolderChange?.(h && { op: h.op }); } catch {}
  }

  get held(): { op: string; sessionId: string; session: string; since: number } | null {
    return this.holder && { op: this.holder.op, sessionId: this.holder.sessionId, session: this.holder.session, since: this.holder.since };
  }

  get depth(): number {
    return this.waiting.filter((w) => !w.done).length;
  }

  isHolder(id: string): boolean {
    return this.holder?.id === id;
  }

  status() {
    const now = Date.now();
    return {
      holder: this.holder && { op: this.holder.op, session: this.holder.session, heldMs: now - this.holder.since },
      waiting: this.live().map((w, i) => ({
        position: i + 1,
        op: w.req.op,
        session: w.req.session,
        waitedMs: now - w.enqueuedAt,
        resume: !!w.req.resume,
      })),
    };
  }

  acquire(req: LockRequest, signal?: AbortSignal): Promise<LockGrant> {
    if (this.closed) return Promise.reject(new DeskClosedError());
    if (signal?.aborted) return Promise.reject(new WriteQueueCancelledError(req.op));
    if (this.holder === null && this.depth === 0 && (req.resume || Date.now() >= this.graceUntil)) {
      return Promise.resolve(this.grant(req, null, Date.now()));
    }
    if (this.depth >= req.maxDepth) {
      return Promise.reject(new WriteQueueFullError(req.op, req.maxDepth, this.holder?.op ?? "another write"));
    }
    const ahead = this.holder ? [{ op: this.holder.op, sessionId: this.holder.sessionId, session: this.holder.session }] : [];
    for (const w of this.live()) if (!req.resume || w.req.resume) ahead.push({ op: w.req.op, sessionId: w.req.sessionId, session: w.req.session });
    const other = ahead.find((a) => a.sessionId !== req.sessionId);

    return new Promise<LockGrant>((resolve, reject) => {
      const waiter: Waiter = {
        req,
        enqueuedAt: Date.now(),
        behindOther: other ? { op: other.op, session: other.session } : null,
        done: false,
        settle: resolve,
        fail: reject,
        cleanup: () => {},
      };
      const timer = setTimeout(() => {
        if (waiter.done) return;
        this.drop(waiter);
        // Behind another session, the error says so — and that get_job cannot see its work.
        reject(
          waiter.behindOther
            ? new DeskWaitError(req.op, req.maxWaitMs, waiter.behindOther.op, waiter.behindOther.session)
            : new WriteQueueWaitError(req.op, req.maxWaitMs, this.holder?.op ?? "another write")
        );
      }, req.maxWaitMs);
      timer.unref?.();
      const onAbort = () => {
        if (waiter.done) return;
        this.drop(waiter);
        reject(new WriteQueueCancelledError(req.op));
      };
      waiter.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      if (req.resume) {
        // Behind other resumed leases only: they were all holding something.
        const firstPlain = this.waiting.findIndex((w) => !w.done && !w.req.resume);
        if (firstPlain < 0) this.waiting.push(waiter);
        else this.waiting.splice(firstPlain, 0, waiter);
      } else {
        this.waiting.push(waiter);
      }
      this.pump();
      this.announce();
    });
  }

  /** Free the lock if `id` holds it. Idempotent: a stale id is a no-op. */
  release(id: string): void {
    if (this.holder?.id !== id) return;
    clearTimeout(this.holder.ceiling);
    this.setHolder(null);
    this.pump();
    this.announce();
  }

  /** Refuse every waiter (they re-take the lock at the next desk) and drop the holder. */
  close(): void {
    this.closed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.ticker) clearInterval(this.ticker);
    if (this.holder) clearTimeout(this.holder.ceiling);
    this.holder = null;
    for (const w of this.live()) {
      w.done = true;
      w.cleanup();
      w.fail(new DeskClosedError());
    }
    this.waiting = [];
  }

  private live(): Waiter[] {
    return this.waiting.filter((w) => !w.done);
  }

  private drop(w: Waiter): void {
    w.done = true;
    w.cleanup();
    this.waiting = this.waiting.filter((x) => x !== w);
    this.pump();
    this.announce();
  }

  private grant(req: LockRequest, waiter: Waiter | null, now: number): LockGrant {
    const id = randomUUID();
    const ceiling = setTimeout(() => {
      if (this.holder?.id !== id) return;
      logger.warn(
        `Front desk: \`${req.op}\` (${req.session}) held the After Effects write lock for over ` +
          `${Math.round(req.holdCeilingMs / 1000)}s without releasing it; freeing it.`
      );
      this.release(id);
    }, req.holdCeilingMs);
    ceiling.unref?.();
    this.setHolder({ id, op: req.op, sessionId: req.sessionId, session: req.session, since: now, ceiling });
    const wait: GrantWait | null =
      waiter && waiter.behindOther
        ? { queuedBehind: waiter.behindOther.op, queuedBehindSession: waiter.behindOther.session, waitedMs: now - waiter.enqueuedAt }
        : null;
    return { id, wait };
  }

  private pump(): void {
    if (this.holder !== null || this.closed) return;
    const next = this.waiting.find((w) => !w.done);
    if (!next) return;
    const now = Date.now();
    if (!next.req.resume && now < this.graceUntil) {
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          this.pump();
          this.announce();
        }, this.graceUntil - now);
      }
      return;
    }
    next.done = true;
    next.cleanup();
    this.waiting = this.waiting.filter((w) => w !== next);
    next.settle(this.grant(next.req, next, now));
  }

  /** Tell every waiter where it stands now, and keep doing so while anyone waits. */
  private announce(): void {
    const live = this.live();
    if (live.length === 0) {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      return;
    }
    const now = Date.now();
    const holder: DeskAhead | null = this.holder && { op: this.holder.op, session: this.holder.session, forMs: now - this.holder.since };
    live.forEach((w, i) => {
      if (!w.req.onUpdate) return;
      // The holder is reported only when it is another session's: a session is
      // never told it is waiting behind itself.
      const shown = holder && this.holder!.sessionId !== w.req.sessionId ? holder : null;
      // Held back by a takeover's grace with nothing holding the lock: said so,
      // rather than leaving the wait unexplained.
      const graceMs = !this.holder && !w.req.resume && now < this.graceUntil ? this.graceUntil - now : undefined;
      try {
        w.req.onUpdate({ t: "wait", position: i + 1, holder: shown, waitedMs: now - w.enqueuedAt, graceMs });
      } catch {}
    });
    if (!this.ticker) {
      this.ticker = setInterval(() => this.announce(), UPDATE_EVERY_MS);
      this.ticker.unref?.();
    }
  }
}

/** The desk is shutting down. Internal: a caller re-takes the lock at whichever desk is next. */
export class DeskClosedError extends Error {
  constructor() {
    super("The front desk is closing; nothing was granted.");
    this.name = "DeskClosedError";
  }
}
