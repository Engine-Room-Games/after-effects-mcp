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
 * A script that reads `app.project.activeItem` is never parked: while parked,
 * that is the parking comp, and whatever the script builds there lands in the
 * wrong comp. The server has the whole source (script and libraries), so it
 * looks; a hit costs only a dry-run park, to say whether parking would have
 * paid off and so whether `viewerComp()` is worth suggesting.
 *
 * Every failure is said, never swallowed:
 *   - a park that timed out means After Effects is stuck: the script is not
 *     sent into it, and the call fails with that timeout;
 *   - a park that failed some other way in transit may still have landed, so
 *     the unpark is sent anyway — it is idempotent, and the panel runs calls in
 *     order, so it lands after the script whatever happened to the park;
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
  wouldPark?: boolean;
  note?: string;
}

export interface UnparkAnswer {
  unparked: boolean;
  restored?: boolean;
  compId?: number;
  compName?: string;
  viewerComp?: { id: number; name: string };
  caution?: string;
  note?: string;
}

/** What the agent is told: on every answer with `quietViewer: true`, and on any answer where something did not go as planned. */
export interface ViewerReport {
  parked: boolean;
  compId?: number;
  compName?: string;
  /** Why it was not parked: no-expressions, no-comp-in-viewer, already-parked, reads-activeItem, failed. */
  skipped?: string;
  /** Present once parked: whether the comp was reopened in the viewer. */
  restored?: boolean;
  /** The comp the script itself put in the viewer, left there. */
  viewerComp?: { id: number; name: string };
  /** An earlier call left the viewer parked; this one took its comp over and put it back. */
  recovered?: { compId: number; compName: string };
  /** The parking comp was created by this call — one undo step of its own, the first time only. */
  created?: boolean;
  /** Something the script wrote landed in the parking comp. */
  caution?: string;
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

/**
 * Whether a script reads `activeItem` anywhere — the script or any inlined
 * library, through `app.project`, an alias of it, or `["activeItem"]`. A name
 * built at run time is not seen; the guide and the CAUTION on the answer cover that.
 */
const ACTIVE_ITEM = /\bactiveItem\b/;
export function readsActiveItem(args: unknown): boolean {
  const a = (args ?? {}) as { code?: unknown; libraries?: unknown };
  if (typeof a.code === "string" && ACTIVE_ITEM.test(a.code)) return true;
  if (Array.isArray(a.libraries)) {
    for (const l of a.libraries) {
      const t = typeof l === "string" ? l : (l as { text?: unknown } | null)?.text;
      if (typeof t === "string" && ACTIVE_ITEM.test(t)) return true;
    }
  }
  return false;
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
 * may have asked for `quietViewer: false`. `readsActiveItem` means a step reads
 * it, and the batch is not parked.
 */
export function batchParkMode(
  args: unknown
): { mode: "inline" | "chunks"; asked: boolean; readsActiveItem: boolean } | null {
  const a = (args ?? {}) as { ops?: unknown; singleUndo?: unknown };
  const steps = runJsxSteps(a.ops);
  if (steps.length === 0 || steps.some((s) => s.quietViewer === false)) return null;
  const n = Array.isArray(a.ops) ? a.ops.length : 0;
  return {
    mode: n <= BATCH_INLINE_MAX || a.singleUndo === true ? "inline" : "chunks",
    asked: steps.some((s) => s.quietViewer === true),
    readsActiveItem: steps.some((s) => readsActiveItem(s)),
  };
}

function compLabel(id: number | undefined, name: string | undefined): string {
  return id === undefined ? "the comp that was in view" : `comp ${id}${name ? ` ("${name}")` : ""}`;
}

/** Whether the report has anything the agent must hear without having asked. */
export function viewerReportMatters(r: ViewerReport | null): boolean {
  if (!r) return false;
  if (r.note || r.recovered || r.caution) return true;
  return r.parked && r.restored !== true;
}

/** A failure in a few words — the error class, not its whole remedy text. */
function failureName(e: unknown): string {
  if (e instanceof AeError) return e.message.slice(0, 160);
  if (e instanceof BridgeTimeoutError) return "no answer in time";
  const n = (e as Error)?.name;
  return n && n !== "Error" ? n : ((e as Error)?.message ?? String(e)).slice(0, 120);
}

/**
 * Not parked because the script reads app.project.activeItem. A dry run says
 * whether parking would have paid off; only then is viewerComp() suggested.
 */
export async function notParkedForActiveItem(send: SendInternal): Promise<ViewerReport | null> {
  let dry: ParkAnswer;
  try {
    dry = (await send("_viewer_park", { dryRun: true })) as ParkAnswer;
  } catch (e) {
    if (e instanceof UnleasedInternalWriteError) throw e;
    return null;
  }
  if (!dry || dry.wouldPark !== true) return null;
  return {
    parked: false,
    compId: dry.compId,
    compName: dry.compName,
    skipped: "reads-activeItem",
    note: `not parked, because the script reads app.project.activeItem: ${compLabel(dry.compId, dry.compName)} stayed ` +
      "in the viewer and After Effects re-ran its expressions after every change. Use viewerComp() for the user's comp " +
      "instead and the next run is parked",
  };
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
    if (e instanceof BridgeTimeoutError) {
      // After Effects is stuck: the script is not sent into it. The park may
      // still land, so the session remembers.
      state.maybeLeft = true;
      (e as WithViewerNote).viewerNote =
        "The script itself was not sent: After Effects did not answer the viewer park that goes before it, so " +
        "nothing of the script ran. Send it again once check_setup shows After Effects answering.";
      throw e;
    }
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
      ? { parked: false, skipped: "failed", note: `the viewer could not be parked (${failureName(parkError)}), so the script ran with the comp in view` }
      : { parked: false, skipped: "failed", note: `the viewer park's answer was lost (${failureName(parkError)}); it may have landed, so it is undone after the script` };
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
      r.note = joinNotes(r.note, `the viewer could not be put back (${failureName(e)}): it may still show AE MCP's parking comp ` +
        `instead of ${compLabel(r.compId, r.compName)}. The next write of this session, any run_jsx, or check_setup puts it back`);
      return;
    }
    if (!u || u.unparked !== true) {
      if (parkInDoubt) {
        // A park whose answer was lost and that never landed.
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
    if (u.caution) r.caution = u.caution;
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
    const parts: string[] = [];
    if (r.caution) parts.push(r.caution);
    if (r.restored !== true && r.note) parts.push(r.note);
    return parts.length ? `quietViewer: ${parts.join("; ")}.` : null;
  }
}

function joinNotes(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}

/**
 * Put back a viewer an interrupted call may have left parked. Sent before this
 * session's next write when it knows it may have, and by check_setup. Answers
 * the sentence to show, or null when nothing needed doing. A failure is said —
 * the session keeps knowing, and tries again before its next write — and costs
 * the write at most the unpark's own short timeout (bridge/httpClient.ts).
 */
export async function recoverParkedViewer(send: SendInternal, state: ViewerParkState | null): Promise<string | null> {
  let u: UnparkAnswer;
  try {
    u = (await send("_viewer_unpark", { recover: true })) as UnparkAnswer;
  } catch (e) {
    if (e instanceof UnleasedInternalWriteError) throw e;
    if (state) state.maybeLeft = true;
    return `An earlier call may have left the viewer on AE MCP's parking comp, and putting it back failed ` +
      `(${failureName(e)}${e instanceof BridgeTimeoutError ? ": After Effects is busy" : ""}). It is tried again before ` +
      "this session's next write, and by check_setup; tell the user if the viewer shows an empty comp.";
  }
  if (state) state.maybeLeft = false;
  if (!u || u.unparked !== true) return null;
  // The user (or a script) has since put a comp of their own in the viewer.
  if (u.viewerComp) return u.caution ?? null;
  const what = compLabel(u.compId, u.compName);
  const caution = u.caution ? ` ${u.caution}.` : "";
  if (u.restored === true) {
    return `An earlier call had left the viewer on AE MCP's parking comp; ${what} was reopened in the viewer.${caution}`;
  }
  return `An earlier call had left the viewer on AE MCP's parking comp; ${u.note ?? `${what} could not be reopened`}.${caution}`;
}
