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
 *
 * The viewer unpark (`_viewer_unpark`, issue #266) is kept on record — After
 * Effects may really be on it — but never under a tool's name: its display
 * name is run_jsx/run_batch/check_setup, and "that call is still running, do
 * not re-send it" is false for it (issue #277). It writes nothing to the
 * project, nothing needs re-sending for it, and this session retries it on
 * its own, so it is reported as `kind: "viewer-unpark"` with its own wording.
 */
export interface BusyWith {
  /** The tool name, as the agent called it (`_run_jsx` reads as `run_jsx`); "viewer unpark" for that one. */
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
  /**
   * "viewer-unpark": the call is the viewer unpark that follows a run_jsx or
   * run_batch (or check_setup's recovery) — not the script, nothing to re-send.
   */
  kind?: "viewer-unpark";
}

type Kind = BusyWith["kind"];
interface Open { op: string; kind: Kind; at: number; sentAt: number | null; }
/** `sentAt` is when it left for the panel, or when it was made if that was never reported. */
interface TimedOut { op: string; kind: Kind; at: number; sentAt: number; timedOutAt: number; limitMs: number; }

function kindOf(op: string): Kind {
  return op === "_viewer_unpark" ? "viewer-unpark" : undefined;
}

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
    const kind = kindOf(op);
    // Not "run_jsx/run_batch/check_setup": an agent reading `op` alone must not take it for the script.
    const rec: Open = { op: kind ? "viewer unpark" : displayOp(op), kind, at: this.now(), sentAt: null };
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
          this.timedOut.push({ op: rec.op, kind: rec.kind, at: rec.at, sentAt: rec.sentAt ?? rec.at, timedOutAt: this.now(), limitMs: e.timeoutMs });
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
      return { op: late.op, state: "timedOut", calledAgoMs: t - late.at, timedOutAgoMs: t - late.timedOutAt, limitMs: late.limitMs, ...kindField(late.kind) };
    }
    if (sent) return { op: sent.op, state: "sent", calledAgoMs: t - sent.at, sentAgoMs: t - sent.sentAt!, ...kindField(sent.kind) };
    if (queued) return { op: queued.op, state: "queued", calledAgoMs: t - queued.at, ...kindField(queued.kind) };
    return null;
  }
}

function kindField(k: Kind): { kind?: "viewer-unpark" } {
  return k ? { kind: k } : {};
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
  if (b.kind === "viewer-unpark") {
    const what = "this server's viewer unpark (the call that puts the user's comp back in the viewer after a run_jsx or run_batch has finished)";
    const tail = "it changes nothing in the project, and nothing needs re-sending for it: the script it follows has already answered, " +
      "and this session's next write, any run_jsx, or check_setup puts the viewer back once After Effects answers";
    if (b.state === "sent") return `${what} reached the panel ${span(b.sentAgoMs ?? b.calledAgoMs)} ago and is still waiting for its answer; ${tail}`;
    if (b.state === "queued") {
      return `${what} (made ${span(b.calledAgoMs)} ago) has not been sent yet — it is waiting its turn behind another session's call, ` +
        `which is what After Effects is busy with; ${tail}`;
    }
    return `${what} gave up at its ${span(b.limitMs ?? 0)} limit ${span(b.timedOutAgoMs ?? 0)} ago and After Effects has answered nothing since; ${tail}`;
  }
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
