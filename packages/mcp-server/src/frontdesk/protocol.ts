import { displayOp } from "../util/opNames.js";
import {
  AeBusyError,
  AeError,
  BridgeAuthError,
  BridgeBusyError,
  BridgeResetError,
  BridgeTimeoutError,
  BridgeUnreachableError,
  DeskWaitError,
  WriteQueueCancelledError,
  WriteQueueFullError,
  WriteQueueWaitError,
  type AeSourceInfo,
} from "../util/errors.js";

/**
 * The front desk's wire format (issue #223).
 *
 * Every desk answer is newline-delimited JSON on one HTTP response, so the desk
 * can say "you are 2nd in line" while the caller waits, and beat on it while
 * nothing else happens, so a stalled desk is noticed.
 *
 * What a caller may re-send after losing the desk is decided by what it can
 * *prove* never reached After Effects, never by a line it did not see: a
 * `start` written by the desk can be lost in transit after the call went to the
 * panel (a hard kill, on Windows especially). So a write is re-sent only when
 * the desk positively refused it — the connection refused, a non-200, or `lost`
 * — and any other loss of a write is "may have run, read back first". Reads are
 * always re-sent.
 */

/** Who is in front, as a waiting caller is told it. */
export interface DeskAhead {
  op: string;
  /** The other session, as its own server describes itself — client name and pid. */
  session: string;
  /** How long it has held the lock, or been running at After Effects. */
  forMs: number;
}

export type LockLine =
  /** Still waiting. `position` is 1-based: 1 = next. */
  | { t: "wait"; position: number; holder: DeskAhead | null; waitedMs: number; graceMs?: number }
  | { t: "granted"; id: string; wait: GrantWait | null }
  | { t: "err"; error: WireError }
  /** The desk is closing; nothing was granted. Take the lock again wherever the desk is now. */
  | { t: "moved" }
  | { t: "beat" };

export type OpLine =
  /** Written before the desk posts to the panel: the op timeout's clock starts here. */
  | { t: "start"; ahead: DeskAhead[] }
  /** Still running at After Effects behind these, which other sessions sent first. */
  | { t: "ahead"; ahead: DeskAhead[] }
  | { t: "ok"; result: unknown; panelPort: number }
  | { t: "err"; error: WireError; panelPort: number }
  /** The lease this write claimed is not the one holding the lock. Nothing was sent. */
  | { t: "lost" }
  /** The call's deadline passed before the desk could forward it. Nothing was sent. */
  | { t: "expired" }
  | { t: "beat" };

/** What a grant reports when the call waited behind another session. */
export interface GrantWait {
  queuedBehind: string;
  queuedBehindSession: string;
  waitedMs: number;
}

export type WireError =
  | { kind: "timeout"; message: string; port: number; timeoutMs: number; op?: string }
  | { kind: "unreachable"; message: string; port: number }
  | { kind: "reset"; message: string; port: number; op?: string }
  | { kind: "auth"; message: string; port: number; sentToken: boolean }
  | { kind: "ae"; message: string; stack?: string; line?: number; code?: string; source?: AeSourceInfo }
  /** Refused unsent: After Effects is still on a call that timed out (the leader's busy guard). */
  | { kind: "ae-busy"; message: string; op: string; stuck: AeBusyError["stuck"]; evidence: AeBusyError["evidence"] }
  | { kind: "queue-wait"; op: string; waitedMs: number; behind: string; behindSession?: string }
  | { kind: "queue-full"; op: string; maxDepth: number; behind: string }
  | { kind: "queue-cancelled"; op: string }
  /** A read that yields to writes met one; nothing was sent (issue #248). */
  | { kind: "busy"; op: string; holder?: string; otherSession?: boolean }
  | { kind: "error"; message: string };

/**
 * Carry an error across the desk without changing a word of it.
 *
 * The bridge errors are rebuilt as the same classes, with the leader's message
 * restored verbatim, so `server.ts` handles a forwarded failure exactly as it
 * handles its own and the five failure kinds stay five (issue #163). The queue
 * errors are rebuilt from their fields, so the message is written by the
 * server whose caller reads it.
 */
export function toWire(e: unknown): WireError {
  if (e instanceof BridgeTimeoutError) return { kind: "timeout", message: e.message, port: e.port, timeoutMs: e.timeoutMs };
  if (e instanceof BridgeUnreachableError) return { kind: "unreachable", message: e.message, port: e.port };
  if (e instanceof BridgeResetError) return { kind: "reset", message: e.message, port: e.port, op: e.op };
  if (e instanceof BridgeAuthError) return { kind: "auth", message: e.message, port: e.port, sentToken: e.sentToken };
  if (e instanceof AeError) return { kind: "ae", message: e.message, stack: e.stack_, line: e.line, code: e.code, source: e.source };
  // Before the queue waits it extends, so a follower gets the same class and words.
  if (e instanceof AeBusyError) return { kind: "ae-busy", message: e.message, op: e.op, stuck: e.stuck, evidence: e.evidence };
  if (e instanceof DeskWaitError) return { kind: "queue-wait", op: e.op, waitedMs: e.waitedMs, behind: e.behind, behindSession: e.behindSession };
  if (e instanceof WriteQueueWaitError) return { kind: "queue-wait", op: e.op, waitedMs: e.waitedMs, behind: e.behind };
  if (e instanceof WriteQueueFullError) return { kind: "queue-full", op: e.op, maxDepth: e.maxDepth, behind: e.behind };
  if (e instanceof WriteQueueCancelledError) return { kind: "queue-cancelled", op: e.op };
  if (e instanceof BridgeBusyError) return { kind: "busy", op: e.op, holder: e.holder, otherSession: e.otherSession };
  return { kind: "error", message: (e as Error)?.message ?? String(e) };
}

export function fromWire(w: WireError): Error {
  const verbatim = <T extends Error>(err: T, message: string): T => {
    err.message = message;
    return err;
  };
  switch (w.kind) {
    case "timeout":
      return verbatim(new BridgeTimeoutError(w.port, w.timeoutMs, { op: w.op }), w.message);
    case "unreachable":
      return verbatim(new BridgeUnreachableError(w.port), w.message);
    case "reset":
      return verbatim(new BridgeResetError(w.port, w.op), w.message);
    case "auth":
      return verbatim(new BridgeAuthError(w.port, w.sentToken), w.message);
    case "ae":
      return new AeError(w.message, w.stack, w.line, w.code, w.source);
    case "ae-busy":
      return verbatim(new AeBusyError(w.op, w.stuck, w.evidence), w.message);
    case "queue-wait":
      return w.behindSession
        ? new DeskWaitError(w.op, w.waitedMs, w.behind, w.behindSession)
        : new WriteQueueWaitError(w.op, w.waitedMs, w.behind);
    case "queue-full":
      return new WriteQueueFullError(w.op, w.maxDepth, w.behind);
    case "queue-cancelled":
      return new WriteQueueCancelledError(w.op);
    case "busy":
      return new BridgeBusyError(w.op, w.holder, undefined, w.otherSession === true);
    default:
      return new Error(w.message);
  }
}

/** "1st", "2nd", "3rd", "4th" … for the line a waiting caller is shown. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** What a session waiting for the lock is told, in a sentence. */
export function describeLockWait(op: string, line: Extract<LockLine, { t: "wait" }>): string {
  if (!line.holder && line.graceMs) {
    return (
      `\`${displayOp(op)}\` is waiting up to ${(line.graceMs / 1000).toFixed(1)}s for the write queue: the previous front desk went ` +
      "away while another session's long write held it, and that session gets the first chance to reclaim it."
    );
  }
  const secs = Math.round(line.waitedMs / 1000);
  const behind = line.holder
    ? `waiting behind another session's \`${displayOp(line.holder.op)}\` (${line.holder.session}), which has held it for ${Math.round(line.holder.forMs / 1000)}s`
    : "waiting for the session in front";
  return `\`${displayOp(op)}\` is ${ordinal(line.position)} in line for the After Effects write queue, ${behind}; ${secs}s so far.`;
}

/** What a session whose call reached After Effects behind others is told. */
export function describeAhead(op: string, ahead: DeskAhead[]): string {
  const first = ahead[0];
  const more = ahead.length > 1 ? ` and ${ahead.length - 1} more` : "";
  return (
    `\`${displayOp(op)}\` has reached After Effects, which is still running another session's \`${displayOp(first.op)}\` ` +
    `(${first.session})${more} ahead of it — ${Math.round(first.forMs / 1000)}s so far.`
  );
}
