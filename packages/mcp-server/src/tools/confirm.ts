/**
 * Asking the user before the few calls that throw work away (issue #245).
 *
 * MCP elicitation (`elicitation/create`) lets a server put a question in front
 * of the person at the client, in a proper prompt, and wait for accept /
 * decline / cancel. Three tools use it, and only these three:
 *
 * - `delete_comp` — a whole comp, and with `force` the precomp layers that nest it.
 * - `purge_unused_footage` — a sweep whose size nobody can see from the call.
 * - `revert_comp` — replaces every layer in the comp; the one choice worth
 *   offering is `saveCurrent`, so the revert itself can be reverted.
 *
 * Everything else is deliberately not asked about. Each call is one undo step,
 * and a prompt on every `delete_layer` trains a person to click through the
 * prompt that matters. Every tool takes ids, never names, so there is no
 * ambiguous target to ask about either. `run_batch` steps are not asked about:
 * a batch is one thing the agent planned, the client's own tool approval
 * covers it, and this is a convenience for the person — not a security
 * boundary, which a step inside a batch would have to make it.
 *
 * Three rules hold it together.
 *
 * 1. **Only when the client said it can answer.** `elicitation.form` in the
 *    client's capabilities (the SDK normalises the 2025-06-18 `elicitation: {}`
 *    to that). A client without it gets exactly today's behaviour: no prompt,
 *    no extra argument, no wait. A client that advertised it but answers
 *    "method not found" also gets today's behaviour, logged (`cannotElicit`);
 *    every other prompt failure is refused.
 * 2. **No answer is not a yes.** Decline, cancel, no answer within
 *    `CONFIRM_TIMEOUT_MS`, a failed prompt and the tool call itself being
 *    cancelled all return an error that says the tool was not run and nothing
 *    was changed.
 * 3. **This session's order is kept; no other session waits on a person.**
 *    `server.ts` takes only the session's own place in line
 *    (`SessionLine.reserve`) before the prompt, and the front desk's lock
 *    (`withDesk`) after the answer. Later writes from this session queue
 *    behind the pending confirmation, so a revert cannot land after edits the
 *    agent issued after it; other sessions on the same After Effects are not
 *    held by a dialog. A purge's approved list is re-read under the full lease
 *    (`verify`) and refused if it changed.
 *
 * The pre-reads (`get_comp`, `list_checkpoints`, a `dryRun` purge) are reads:
 * no lease, no undo step. They exist so the prompt names the comp or counts
 * the items — a person shown "delete comp 4127?" cannot answer it.
 */

import { BridgeTimeoutError } from "../util/errors.js";
import { MAX_BATCH_DEPTH } from "./policy.js";
import type { ElicitRequestFormParams, ElicitResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

/** The tools that ask. Exported for tests and the docs; nothing else reads it. */
export const CONFIRMED_OPS: ReadonlySet<string> = new Set(["delete_comp", "purge_unused_footage", "revert_comp"]);

/**
 * True for a call that may ask: one of `CONFIRMED_OPS`, or a `run_batch`,
 * which asks once, up front, when any step at any depth is one of them —
 * otherwise wrapping `delete_comp` in a batch would be a way round the prompt.
 */
export function mayAsk(name: string): boolean {
  return CONFIRMED_OPS.has(name) || name === "run_batch";
}

export type BatchStep = { path: string; op: string; args: Record<string, unknown> };

/** Every confirmed step in a batch, nested batches included, in run order. */
export function confirmedBatchSteps(ops: unknown): BatchStep[] {
  const out: BatchStep[] = [];
  const walk = (list: unknown, prefix: string, depth: number) => {
    if (!Array.isArray(list) || depth > MAX_BATCH_DEPTH) return;
    list.forEach((raw, i) => {
      if (raw === null || typeof raw !== "object") return;
      const step = raw as { op?: unknown; args?: unknown };
      const path = `${prefix}ops[${i}]`;
      const args = (step.args && typeof step.args === "object" ? step.args : {}) as Record<string, unknown>;
      if (typeof step.op === "string" && CONFIRMED_OPS.has(step.op)) out.push({ path, op: step.op, args });
      if (step.op === "run_batch") walk(args.ops, `${path}.args.`, depth + 1);
    });
  };
  walk(ops, "", 0);
  return out;
}

function describeStep(s: BatchStep): string {
  if (s.op === "delete_comp") return `delete comp ${String(s.args.compId)}${s.args.force === true ? " and the precomp layers that use it" : ""}`;
  if (s.op === "revert_comp") return `revert a comp to checkpoint ${String(s.args.checkpointId)}`;
  if (s.args.dryRun === true) return "list unused footage (a dry run, removes nothing)";
  return `remove whatever ${s.args.solidsOnly === false ? "footage items" : "solids"} are unused when it runs`;
}

/**
 * How long a prompt waits for a person. The SDK's default request timeout is
 * 60s, which is a timeout for machines; a person reading a dialog needs more.
 * Kept under the write queue's own wait (`AE_MCP_WRITE_QUEUE_WAIT_MS`, 600s by
 * default): this session's later writes queue behind a pending confirmation,
 * and the prompt must give up before they do.
 */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** True when the client can show a form prompt. */
export function clientCanElicit(caps: ClientCapabilities | undefined): boolean {
  return !!caps?.elicitation?.form;
}

export type ConfirmPrompt = {
  message: string;
  requestedSchema: ElicitRequestFormParams["requestedSchema"];
  /** Fold the person's answers into the args. Absent: the args are unchanged. */
  apply?: (args: Record<string, unknown>, content: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Run once the write lease is held, just before the forward: re-read what
   * the person approved and return why it no longer holds, or null. A
   * non-null answer refuses the call with nothing changed. Under the lease, no
   * other MCP write can land between this read and the write.
   */
  verify?: (read: ReadOp) => Promise<string | null>;
};

/** A read the prompt needs. Read-only, no lease. */
export type ReadOp = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const NO_FIELDS: ElicitRequestFormParams["requestedSchema"] = { type: "object", properties: {} };

/** A canonical id list, to compare an approved plan with the one at write time. */
function idSet(items: { id?: unknown }[]): string {
  return items.map((i) => String(i.id)).sort().join(",");
}

function quoted(s: unknown): string {
  return `"${String(s)}"`;
}

const UNDO_NOTE = "It can be undone in After Effects with Edit > Undo.";

/**
 * The question for this call, or null when there is nothing to ask — not a
 * confirmed tool, a dry run, a purge that would remove nothing, a checkpoint
 * the pre-read does not know (the tool's own refusal is the better answer).
 * A pre-read that throws propagates: it is the same failure the tool would
 * have met, and nothing has been changed.
 */
export async function buildPrompt(name: string, args: Record<string, unknown>, read: ReadOp): Promise<ConfirmPrompt | null> {
  if (name === "run_batch") {
    // No pre-read: a step can name a comp an earlier step creates. Asked once,
    // for the whole batch, before any of it runs; a dry-run purge is no reason.
    const steps = confirmedBatchSteps(args.ops).filter((s) => !(s.op === "purge_unused_footage" && s.args.dryRun === true));
    if (steps.length === 0) return null;
    const total = Array.isArray(args.ops) ? args.ops.length : 0;
    const shown = steps.slice(0, 10).map((s) => `${s.path}: ${describeStep(s)}`);
    const more = steps.length > shown.length ? `; and ${steps.length - shown.length} more` : "";
    return {
      message:
        `Run this batch of ${total} step${total === 1 ? "" : "s"}? ${steps.length === 1 ? "One step throws" : `${steps.length} steps throw`} work away — ` +
        `${shown.join("; ")}${more}. Declining runs none of it.`,
      requestedSchema: NO_FIELDS,
    };
  }
  if (name === "delete_comp") {
    const comp = (await read("get_comp", { compId: args.compId })) as { name?: unknown } | null;
    const label = comp && comp.name !== undefined ? `the comp ${quoted(comp.name)}` : `comp ${String(args.compId)}`;
    let message = `Delete ${label}?`;
    if (args.force === true) message += " Any precomp layers that use it in other comps are deleted with it.";
    if (args.purgeUnusedSolids === true) message += " Solids only this comp used are removed too.";
    return { message: `${message} ${UNDO_NOTE}`, requestedSchema: NO_FIELDS };
  }

  if (name === "purge_unused_footage") {
    if (args.dryRun === true) return null;
    const plan = (await read("purge_unused_footage", { ...args, dryRun: true })) as {
      wouldRemove?: { id?: unknown; name?: unknown }[];
      wouldRemoveCount?: number;
      solidsOnly?: boolean;
      folderName?: unknown;
    } | null;
    const items = Array.isArray(plan?.wouldRemove) ? plan!.wouldRemove! : [];
    const count = typeof plan?.wouldRemoveCount === "number" ? plan.wouldRemoveCount : items.length;
    if (count === 0) return null;
    const approved = idSet(items);
    const what = plan?.solidsOnly === false ? "footage item" : "solid";
    const where = plan?.folderName !== undefined ? ` from the folder ${quoted(plan.folderName)}` : " from the project";
    const shown = items.slice(0, 5).map((i) => quoted(i.name));
    const more = count > shown.length ? ` and ${count - shown.length} more` : "";
    const list = shown.length > 0 ? ` (${shown.join(", ")}${more})` : "";
    return {
      message: `Remove ${count} unused ${what}${count === 1 ? "" : "s"}${where}${list}? No comp uses them. ${UNDO_NOTE}`,
      requestedSchema: NO_FIELDS,
      // The purge removes whatever is unused when it runs, not a list. The
      // person approved a list, so the plan is read again under the lease and
      // the call refused unless it is the same items.
      verify: async (read) => {
        const now = (await read("purge_unused_footage", { ...args, dryRun: true })) as { wouldRemove?: { id?: unknown }[] } | null;
        const current = idSet(Array.isArray(now?.wouldRemove) ? now!.wouldRemove! : []);
        if (current === approved) return null;
        const n = current === "" ? 0 : current.split(",").length;
        return `what is unused changed after the user confirmed (${count} item${count === 1 ? "" : "s"} approved, ${n} unused now). Ask the user again`;
      },
    };
  }

  if (name === "revert_comp") {
    const listed = (await read("list_checkpoints", {})) as { checkpoints?: Record<string, unknown>[] } | null;
    const cp = (listed?.checkpoints ?? []).find((c) => c.checkpointId === args.checkpointId);
    if (!cp) return null;
    const comp = cp.compName !== undefined ? `the comp ${quoted(cp.compName)}` : "this comp";
    const which = cp.label ? `checkpoint ${quoted(cp.label)}` : `checkpoint ${String(cp.checkpointId)}`;
    const when = cp.createdAt ? `, saved ${String(cp.createdAt)}` : "";
    return {
      message: `Revert ${comp} to ${which}${when}? Every layer in it is replaced by the checkpoint's; changes made since are lost unless saved first.`,
      requestedSchema: {
        type: "object",
        properties: {
          saveCurrent: {
            type: "boolean",
            title: "Save the current state first",
            description: "Keep a checkpoint of the comp as it is now, so this revert can itself be reverted.",
            default: args.saveCurrent === true,
          },
        },
      },
      apply: (a, content) =>
        typeof content.saveCurrent === "boolean" ? { ...a, saveCurrent: content.saveCurrent } : a,
    };
  }

  return null;
}

export type Elicit = (params: ElicitRequestFormParams) => Promise<ElicitResult>;

export type ConfirmOutcome =
  | { proceed: true; args: Record<string, unknown> }
  | { proceed: false; message: string };

/** The refusal, in words that cannot be read as a success. */
export function notRunMessage(
  tool: string,
  why: string,
  next = "Do not call it again unless the user asks you to; tell them it was not done."
): string {
  return `${tool} was not run: ${why}. Nothing in the After Effects project was changed. ${next}`;
}

function isTimeout(e: unknown): boolean {
  // McpError carries ErrorCode.RequestTimeout (-32001) when the SDK's own
  // request timeout fires.
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === -32001;
}

/**
 * The only failures that mean "this client cannot show a prompt at all": the
 * method is not implemented (JSON-RPC -32601), or the SDK refused to send for
 * want of the capability. Anything else — an answer that failed the SDK's
 * schema check, a client signalling dismissal as an error, a transport fault —
 * may be a person who said no, and is refused.
 */
export function cannotElicit(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === -32601) return true;
  return /does not support (form |url )?elicitation/i.test(String((e as { message?: unknown }).message ?? ""));
}

/**
 * A read made for the prompt (or its re-check) failed. Said in this call's
 * own words: the bridge's timeout sentence warns that a write may still land,
 * and here no write was ever sent.
 */
export function preReadFailureMessage(tool: string, op: string, e: unknown): string {
  // Not the timeout's own sentence: it says the op may still land in After
  // Effects, true of a write and false here, where only a read was sent.
  const what =
    e instanceof BridgeTimeoutError
      ? `After Effects did not answer the read before its confirmation (${op}) in time — it may be busy`
      : `the read before its confirmation (${op}) failed: ${(e as Error)?.message ?? String(e)}`;
  return notRunMessage(
    tool,
    `${what}. Nothing that changes the project was sent`,
    "Calling it again once After Effects answers is safe."
  );
}

/**
 * Ask, and say whether to go on. `signal` is the tool call's own: a client
 * that cancels the call has withdrawn the question too.
 */
export async function confirmWithUser(
  tool: string,
  args: Record<string, unknown>,
  prompt: ConfirmPrompt,
  elicit: Elicit,
  signal?: AbortSignal,
  log: (message: string) => void = () => {}
): Promise<ConfirmOutcome> {
  let answer: ElicitResult;
  try {
    answer = await elicit({ mode: "form", message: prompt.message, requestedSchema: prompt.requestedSchema });
  } catch (e) {
    if (signal?.aborted) return { proceed: false, message: notRunMessage(tool, "the call was cancelled while the confirmation prompt was open") };
    if (isTimeout(e)) {
      return {
        proceed: false,
        message: notRunMessage(tool, `nobody answered the confirmation prompt within ${Math.round(CONFIRM_TIMEOUT_MS / 60_000)} minutes`),
      };
    }
    if (cannotElicit(e)) {
      // The client said it could show a prompt and then turned out not to
      // implement it. Refusing would make the tool unusable on that client for
      // good; going on is exactly what every client without elicitation gets.
      log(`${tool}: the client advertised elicitation but does not implement it (${(e as Error).message}); running without a prompt.`);
      return { proceed: true, args };
    }
    return { proceed: false, message: notRunMessage(tool, `the confirmation prompt failed (${(e as Error)?.message ?? String(e)})`) };
  }
  if (answer.action === "accept") {
    const content = (answer.content ?? {}) as Record<string, unknown>;
    return { proceed: true, args: prompt.apply ? prompt.apply(args, content) : args };
  }
  if (answer.action === "decline") return { proceed: false, message: notRunMessage(tool, "the user declined it in the confirmation prompt") };
  return { proceed: false, message: notRunMessage(tool, "the user dismissed the confirmation prompt without answering") };
}
