import { AeError, BridgeTimeoutError } from "../util/errors.js";
import { UnleasedInternalWriteError, type SendInternal } from "./internalOps.js";

/**
 * The viewer parked before a run_jsx and put back after it (issue #266).
 *
 * Measured on AE 26.5: every change to the project makes After Effects re-run
 * the pixel-affecting expressions of the comp in the viewer, once per change,
 * on the main thread — 3.7 s / 11.1 s / 74 s for a script making 1 / 3 / 20
 * changes with a heavy comp in view. A viewer swapped from inside the script's
 * own evalScript takes effect only after that call ends, so the park has to be
 * a call of its own, before the script. Three calls, then, all under the one
 * write lease the tool call already holds, so no other session's write lands
 * between them:
 *
 *   _viewer_park  →  the script (_run_jsx, run_batch, or one _continue_job)  →  _viewer_unpark
 *
 * The ExtendScript half is packages/jsx/viewer.jsx. It decides whether a park
 * can pay off (an enabled expression on an enabled layer of the viewed comp)
 * and answers `parked: false` with a reason when not; then no unpark is sent.
 *
 * Every failure is said, never swallowed:
 *   - a park that failed in transit may still have landed, so the unpark is
 *     sent anyway — it is idempotent, and the panel runs calls in order, so it
 *     lands after the script whatever happened to the park's answer;
 *   - a script that timed out may still be running, so no unpark is sent (it
 *     would only wait behind the script) and the session remembers it may have
 *     left the viewer parked: its next write restores it first, and so does the
 *     next park, in any session, and check_setup;
 *   - an unpark that did not reopen the comp says why, on the answer or the error.
 */

export interface ParkAnswer {
  parked: boolean;
  compId?: number;
  compName?: string;
  created?: boolean;
  recovered?: { compId: number; compName: string };
  skipped?: string;
  scan?: string;
  note?: string;
}

export interface UnparkAnswer {
  unparked: boolean;
  restored?: boolean;
  compId?: number;
  compName?: string;
  viewerComp?: { id: number; name: string };
  note?: string;
}

/** What the agent is told: on every answer with `quietViewer: true`, and on any answer where something did not go as planned. */
export interface ViewerReport {
  parked: boolean;
  compId?: number;
  compName?: string;
  /** Why it was not parked: no-expressions, no-comp-in-viewer, already-parked, failed. */
  skipped?: string;
  /** Present once parked: whether the comp was reopened in the viewer. */
  restored?: boolean;
  /** The comp the script itself put in the viewer, left there. */
  viewerComp?: { id: number; name: string };
  /** An earlier call left the viewer parked; this one took its comp over and put it back. */
  recovered?: { compId: number; compName: string };
  /** The parking comp was created by this call — one undo step of its own, the first time only. */
  created?: boolean;
  note?: string;
}

/** Per server: whether a call of this session may have left the viewer parked. */
export class ViewerParkState {
  maybeLeft = false;
}

/** An error that crossed a parked call carries what became of the viewer. */
export type WithViewerNote = { viewerNote?: string };

/** run_jsx parks unless the caller said `quietViewer: false`. */
export function runJsxWantsPark(args: unknown): boolean {
  return (args as { quietViewer?: unknown } | null)?.quietViewer !== false;
}

// batch.jsx's __BATCH_INLINE_MAX: at or under it (or with singleUndo) the batch
// runs inside the run_batch call; over it, in chunks the server drives.
export const BATCH_INLINE_MAX = 500;

type Step = { op?: unknown; args?: unknown };

function runJsxSteps(ops: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!Array.isArray(ops)) return out;
  for (const s of ops as Step[]) {
    if (!s || typeof s !== "object") continue;
    const a = (s.args ?? {}) as Record<string, unknown>;
    if (s.op === "run_jsx") out.push(a);
    else if (s.op === "run_batch") runJsxSteps(a.ops, out);
  }
  return out;
}

/**
 * Whether a run_batch parks, and around what: the run_batch call itself for an
 * inline batch, each `_continue_job` for a chunked one. Only a batch with a
 * run_jsx step parks — at any depth of nesting — and none of its run_jsx steps
 * may have asked for `quietViewer: false`.
 */
export function batchParkMode(args: unknown): { mode: "inline" | "chunks"; asked: boolean } | null {
  const a = (args ?? {}) as { ops?: unknown; singleUndo?: unknown };
  const steps = runJsxSteps(a.ops);
  if (steps.length === 0 || steps.some((s) => s.quietViewer === false)) return null;
  const n = Array.isArray(a.ops) ? a.ops.length : 0;
  return {
    mode: n <= BATCH_INLINE_MAX || a.singleUndo === true ? "inline" : "chunks",
    asked: steps.some((s) => s.quietViewer === true),
  };
}

function compLabel(id: number | undefined, name: string | undefined): string {
  return id === undefined ? "the comp that was in view" : `comp ${id}${name ? ` ("${name}")` : ""}`;
}

/** Whether the report has anything the agent must hear without having asked. */
export function viewerReportMatters(r: ViewerReport | null): boolean {
  if (!r) return false;
  if (r.note || r.recovered) return true;
  return r.parked && r.restored !== true;
}

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/**
 * Run `run` (the call that carries the script) between a park and an unpark.
 * `send` must be the call's own internal sender, under its write lease.
 */
export async function withParkedViewer<T>(
  send: SendInternal,
  state: ViewerParkState,
  run: () => Promise<T>
): Promise<{ value: T; report: ViewerReport }> {
  let park: ParkAnswer | null = null;
  let parkError: unknown = null;
  try {
    park = (await send("_viewer_park", {})) as ParkAnswer;
  } catch (e) {
    // A bug in the caller, not a bridge failure: nothing was sent.
    if (e instanceof UnleasedInternalWriteError) throw e;
    parkError = e;
  }
  const report: ViewerReport = park
    ? {
        parked: park.parked === true,
        compId: park.compId,
        compName: park.compName,
        ...(park.skipped ? { skipped: park.skipped } : {}),
        ...(park.recovered ? { recovered: park.recovered } : {}),
        ...(park.created ? { created: true } : {}),
        ...(park.note ? { note: park.note } : {}),
      }
    : parkError instanceof AeError
      ? { parked: false, skipped: "failed", note: `the viewer could not be parked (${errText(parkError)}), so the script ran with the comp in view` }
      : { parked: false, skipped: "failed", note: `the viewer park did not answer (${errText(parkError)}); it may have landed, so it is undone after the script` };
  // A park that answered has taken over whatever an earlier call left behind.
  if (park) state.maybeLeft = false;
  // After Effects answering with an error means the park ran and threw, or was
  // never there (an outdated panel, which the version gate refuses first):
  // either way nothing is parked. Any other failure may have landed.
  const parkInDoubt = parkError !== null && !(parkError instanceof AeError);
  const mayBeParked = report.parked || parkInDoubt;

  let value: T;
  try {
    value = await run();
  } catch (e) {
    if (mayBeParked) {
      const note = await afterFailure(e);
      if (note) (e as WithViewerNote).viewerNote = note;
    }
    throw e;
  }
  if (mayBeParked) await unparkInto(report);
  return { value, report };

  async function unparkInto(r: ViewerReport): Promise<void> {
    let u: UnparkAnswer;
    try {
      u = (await send("_viewer_unpark", {})) as UnparkAnswer;
    } catch (e) {
      state.maybeLeft = true;
      r.restored = false;
      r.note = joinNotes(r.note, `the viewer could not be put back (${errText(e)}): it may still show AE MCP's parking comp ` +
        `instead of ${compLabel(r.compId, r.compName)}. The next write of this session, any run_jsx, or check_setup puts it back`);
      return;
    }
    if (!u || u.unparked !== true) {
      // Nothing was parked after all (a park whose answer was lost and never landed).
      if (parkInDoubt) {
        r.note = joinNotes(r.note, "nothing had been parked");
      } else {
        r.restored = false;
        r.note = joinNotes(r.note, `After Effects no longer had the park on record (its script was reloaded?), so ` +
          `${compLabel(r.compId, r.compName)} was not reopened — if the viewer shows AE MCP's parking comp, open it from the Project panel`);
      }
      return;
    }
    r.parked = true;
    r.restored = u.restored === true;
    if (u.compId !== undefined) r.compId = u.compId;
    if (u.compName !== undefined) r.compName = u.compName;
    if (u.viewerComp) r.viewerComp = u.viewerComp;
    if (u.note) r.note = joinNotes(r.note, u.note);
  }

  async function afterFailure(e: unknown): Promise<string | null> {
    const what = compLabel(report.compId, report.compName);
    if (e instanceof BridgeTimeoutError) {
      // It may still be running: an unpark now would only queue behind it.
      state.maybeLeft = true;
      return `The viewer was left on AE MCP's parking comp because the script may still be running. ` +
        `Once it is done, this session's next write, any run_jsx or check_setup reopens ${what}.`;
    }
    const r: ViewerReport = { ...report };
    await unparkInto(r);
    if (r.restored === true) return null;
    if (r.note) return `quietViewer: ${r.note}.`;
    return null;
  }
}

function joinNotes(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}

/**
 * Put back a viewer an interrupted call may have left parked. Sent before this
 * session's next write when it knows it may have, and by check_setup. Answers
 * the sentence to show, or null when nothing needed doing.
 */
export async function recoverParkedViewer(send: SendInternal, state: ViewerParkState | null): Promise<string | null> {
  let u: UnparkAnswer;
  try {
    u = (await send("_viewer_unpark", { recover: true })) as UnparkAnswer;
  } catch (e) {
    if (e instanceof UnleasedInternalWriteError) throw e;
    return null;
  }
  if (state) state.maybeLeft = false;
  if (!u || u.unparked !== true) return null;
  // The user (or a script) has since put a comp of their own in the viewer.
  if (u.viewerComp) return null;
  const what = compLabel(u.compId, u.compName);
  if (u.restored === true) {
    return `An earlier call had left the viewer on AE MCP's parking comp; ${what} was reopened in the viewer.`;
  }
  return `An earlier call had left the viewer on AE MCP's parking comp; ${u.note ?? `${what} could not be reopened`}.`;
}
