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
 * "Sent" is when the call left for the panel (`SessionLine.runOp`'s `onSent`),
 * not when it was made: a call waiting its turn behind another session at the
 * front desk is reported as queued, never as running.
 *
 * Background calls (the live-resource poll) are kept out of the report: a poll
 * is not what the agent asked about, and its timeout must not replace the
 * record of the call the agent was told timed out.
 */
export interface BusyWith {
  /** The tool name, as the agent called it (`_run_jsx` reads as `run_jsx`). */
  op: string;
  /**
   * "sent": the call is open and reached the panel. "timedOut": it gave up,
   * with no answer since. "queued": the call is open but still waiting its
   * turn — not sent, so After Effects is busy with something else.
   */
  state: "sent" | "queued" | "timedOut";
  /** How long ago the call was made. */
  calledAgoMs: number;
  /** For "sent": how long ago it left for the panel. */
  sentAgoMs?: number;
  /** For "timedOut": how long ago it gave up, and the limit it gave up at. */
  timedOutAgoMs?: number;
  limitMs?: number;
}

interface Open { op: string; at: number; sentAt: number | null; }
/** `sentAt` is when it left for the panel, or when it was made if that was never reported. */
interface TimedOut { op: string; at: number; sentAt: number; timedOutAt: number; limitMs: number; }

/** Timed-out calls kept on record at most; the oldest is the one that matters, so it is the one kept. */
const MAX_TIMED_OUT = 16;

export class CallsInFlight {
  private seq = 0;
  private open = new Map<number, Open>();
  private timedOut: TimedOut[] = [];

  constructor(private now: () => number = () => Date.now()) {}

  /**
   * Run `fn` as a call to After Effects named `op`, keeping the record straight
   * whatever it does. `fn` is handed the function to call when the call leaves
   * for the panel. A `background` call is not recorded.
   */
  async track<T>(op: string, fn: (sent: () => void) => Promise<T>, opts: { background?: boolean } = {}): Promise<T> {
    if (opts.background) {
      try {
        const v = await fn(() => {});
        this.answered();
        return v;
      } catch (e) {
        if (e instanceof AeError) this.answered();
        throw e;
      }
    }
    const id = ++this.seq;
    const rec: Open = { op: displayOp(op), at: this.now(), sentAt: null };
    this.open.set(id, rec);
    try {
      const v = await fn(() => { if (rec.sentAt === null) rec.sentAt = this.now(); });
      this.answered();
      return v;
    } catch (e) {
      if (e instanceof BridgeTimeoutError) {
        // Every timeout is kept until the panel answers, not only the newest:
        // the panel runs one call at a time, so a call that timed out while
        // waiting behind an earlier timed-out one never started, and naming it
        // would name the wrong work (issue #272).
        if (this.timedOut.length < MAX_TIMED_OUT) {
          this.timedOut.push({ op: rec.op, at: rec.at, sentAt: rec.sentAt ?? rec.at, timedOutAt: this.now(), limitMs: e.timeoutMs });
        }
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
    this.timedOut = [];
  }

  /**
   * The call After Effects is on: of every call that reached the panel and has
   * no answer — still open, or timed out with nothing answered since — the one
   * sent first, because the panel runs them one at a time and in order (issue
   * #272: a call sent later is waiting behind it, not running). Else the
   * longest-open call still waiting its turn; null when there is none.
   */
  busyWith(): BusyWith | null {
    const t = this.now();
    let sent: Open | null = null;
    let queued: Open | null = null;
    for (const o of this.open.values()) {
      if (o.sentAt !== null) { if (!sent || o.sentAt < sent.sentAt!) sent = o; }
      else if (!queued || o.at < queued.at) queued = o;
    }
    let late: TimedOut | null = null;
    for (const x of this.timedOut) if (!late || x.sentAt < late.sentAt) late = x;
    if (late && (!sent || late.sentAt <= sent.sentAt!)) {
      return { op: late.op, state: "timedOut", calledAgoMs: t - late.at, timedOutAgoMs: t - late.timedOutAt, limitMs: late.limitMs };
    }
    if (sent) return { op: sent.op, state: "sent", calledAgoMs: t - sent.at, sentAgoMs: t - sent.sentAt! };
    if (queued) return { op: queued.op, state: "queued", calledAgoMs: t - queued.at };
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
  if (b.state === "sent") {
    return `this server's \`${b.op}\` call reached the panel ${span(b.sentAgoMs ?? b.calledAgoMs)} ago and is still waiting for its answer, ` +
      "so After Effects is very probably still running it";
  }
  if (b.state === "queued") {
    return `this server's \`${b.op}\` call (made ${span(b.calledAgoMs)} ago) has not been sent yet — it is waiting its turn ` +
      "behind another session's call, which is what After Effects is busy with";
  }
  return `this server's \`${b.op}\` call (made ${span(b.calledAgoMs)} ago) gave up at its ${span(b.limitMs ?? 0)} limit ` +
    `${span(b.timedOutAgoMs ?? 0)} ago and After Effects has answered nothing since, ` +
    "so it is very probably still running that call — its changes land when it finishes";
}
