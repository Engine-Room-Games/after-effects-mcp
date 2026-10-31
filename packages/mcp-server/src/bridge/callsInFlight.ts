import { AeError, BridgeTimeoutError } from "../util/errors.js";
import { displayOp } from "../util/opNames.js";

/**
 * Which of this server's calls After Effects may still be working on (issue #266).
 *
 * While ExtendScript runs, the panel cannot answer anything — not the op, not
 * `/health` — so `check_setup` sees a port that accepts and goes quiet, and
 * nothing else. The panel cannot say "busy with run_jsx" because it is the
 * thing that is stuck. This server can: it knows which call it sent and has not
 * had an answer to, and which call timed out without one. A call that timed out
 * reached After Effects and is very probably still running (a timeout is never
 * re-sent for exactly that reason), so it stays on record until the panel next
 * answers anything — the panel answering is the proof After Effects is free.
 *
 * What this cannot see is another session's call through the same panel; the
 * report says it is this server's.
 */
export interface BusyWith {
  /** The tool name, as the agent called it (`_run_jsx` reads as `run_jsx`). */
  op: string;
  /** "waiting": the call is still open. "timedOut": it gave up, with no answer since. */
  state: "waiting" | "timedOut";
  /** How long ago the call was made. */
  calledAgoMs: number;
  /** For "timedOut": how long ago it gave up, and the limit it gave up at. */
  timedOutAgoMs?: number;
  limitMs?: number;
}

interface Open { op: string; at: number; }
interface TimedOut { op: string; at: number; timedOutAt: number; limitMs: number; }

export class CallsInFlight {
  private seq = 0;
  private open = new Map<number, Open>();
  private timedOut: TimedOut | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  /** Run `fn` as a call to After Effects named `op`, keeping the record straight whatever it does. */
  async track<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const id = ++this.seq;
    const at = this.now();
    this.open.set(id, { op: displayOp(op), at });
    try {
      const v = await fn();
      this.answered();
      return v;
    } catch (e) {
      if (e instanceof BridgeTimeoutError) {
        // The newest timeout is the one worth naming: it is the one the agent
        // just read, and the older one cannot have outlived it on a panel that
        // runs one call at a time.
        this.timedOut = { op: displayOp(op), at, timedOutAt: this.now(), limitMs: e.timeoutMs };
      }
      // An After Effects error is an answer: the panel replied, so it is free.
      // Any other failure proves nothing either way.
      if (e instanceof AeError) this.answered();
      throw e;
    } finally {
      this.open.delete(id);
    }
  }

  /** The panel answered something: After Effects is free, so nothing sent earlier is still running. */
  answered(): void {
    this.timedOut = null;
  }

  /** The longest-open call, else the last one that timed out with no answer since; null when neither. */
  busyWith(): BusyWith | null {
    const t = this.now();
    let oldest: Open | null = null;
    for (const o of this.open.values()) if (!oldest || o.at < oldest.at) oldest = o;
    if (oldest) return { op: oldest.op, state: "waiting", calledAgoMs: t - oldest.at };
    if (this.timedOut) {
      const x = this.timedOut;
      return { op: x.op, state: "timedOut", calledAgoMs: t - x.at, timedOutAgoMs: t - x.timedOutAt, limitMs: x.limitMs };
    }
    return null;
  }
}

/** "4.2s", "3m 07s" — a span someone is waiting through. */
function span(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** check_setup's sentence for a busy bridge with one of this server's calls outstanding. */
export function busyWithText(b: BusyWith): string {
  if (b.state === "waiting") {
    return `this server's \`${b.op}\` call was made ${span(b.calledAgoMs)} ago and is still waiting for its answer, ` +
      "so After Effects is very probably still running it";
  }
  return `this server's \`${b.op}\` call (made ${span(b.calledAgoMs)} ago) gave up at its ${span(b.limitMs ?? 0)} limit ` +
    `${span(b.timedOutAgoMs ?? 0)} ago and After Effects has answered nothing since, ` +
    "so it is very probably still running that call — its changes land when it finishes";
}
