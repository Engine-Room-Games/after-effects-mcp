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
 *    no extra argument, no wait. A client that advertised it and then failed
 *    to show the prompt for any reason but a timeout also gets today's
 *    behaviour, logged — refusing there would make the tool unusable on that
 *    client for good.
 * 2. **No answer is not a yes.** Decline, cancel, no answer within
 *    `CONFIRM_TIMEOUT_MS`, and the tool call itself being cancelled all return
 *    an error that says the tool was not run and nothing was changed.
 * 3. **No write lease while a person decides** — see `server.ts`, where this
 *    runs after the panel gate and before `line.acquire`. Holding the lease
 *    would stall every write in this session and, through the front desk,
 *    every other session on the same After Effects, for as long as someone
 *    takes to read a dialog; queued writers would hit their own deadline and
 *    fail for a bridge that was fine. The price is that the project can change
 *    between the answer and the write. The ops re-check everything they need
 *    when they run (a comp that is gone is refused, a purge lists what it
 *    actually removed), so a stale prompt costs a refusal, never a wrong
 *    success. A write the same agent issues *concurrently* with a confirmed
 *    call may run first; an agent that needs an order waits for the result.
 *
 * The pre-reads (`get_comp`, `list_checkpoints`, a `dryRun` purge) are reads:
 * no lease, no undo step. They exist so the prompt names the comp or counts
 * the items — a person shown "delete comp 4127?" cannot answer it.
 */

import type { ElicitRequestFormParams, ElicitResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

/** The tools that ask. Exported for tests and the docs; nothing else reads it. */
export const CONFIRMED_OPS: ReadonlySet<string> = new Set(["delete_comp", "purge_unused_footage", "revert_comp"]);

/**
 * How long a prompt waits for a person. The SDK's default request timeout is
 * 60s, which is a timeout for machines; a person reading a dialog needs more.
 */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;

/** True when the client can show a form prompt. */
export function clientCanElicit(caps: ClientCapabilities | undefined): boolean {
  return !!caps?.elicitation?.form;
}

export type ConfirmPrompt = {
  message: string;
  requestedSchema: ElicitRequestFormParams["requestedSchema"];
  /** Fold the person's answers into the args. Absent: the args are unchanged. */
  apply?: (args: Record<string, unknown>, content: Record<string, unknown>) => Record<string, unknown>;
};

/** A read the prompt needs. Read-only, no lease. */
export type ReadOp = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const NO_FIELDS: ElicitRequestFormParams["requestedSchema"] = { type: "object", properties: {} };

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
      wouldRemove?: { name?: unknown }[];
      wouldRemoveCount?: number;
      solidsOnly?: boolean;
      folderName?: unknown;
    } | null;
    const items = Array.isArray(plan?.wouldRemove) ? plan!.wouldRemove! : [];
    const count = typeof plan?.wouldRemoveCount === "number" ? plan.wouldRemoveCount : items.length;
    if (count === 0) return null;
    const what = plan?.solidsOnly === false ? "footage item" : "solid";
    const where = plan?.folderName !== undefined ? ` from the folder ${quoted(plan.folderName)}` : " from the project";
    const shown = items.slice(0, 5).map((i) => quoted(i.name));
    const more = count > shown.length ? ` and ${count - shown.length} more` : "";
    const list = shown.length > 0 ? ` (${shown.join(", ")}${more})` : "";
    return {
      message: `Remove ${count} unused ${what}${count === 1 ? "" : "s"}${where}${list}? No comp uses them. ${UNDO_NOTE}`,
      requestedSchema: NO_FIELDS,
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
export function notRunMessage(tool: string, why: string): string {
  return (
    `${tool} was not run: ${why}. Nothing in the After Effects project was changed. ` +
    `Do not call it again unless the user asks you to; tell them it was not done.`
  );
}

function isTimeout(e: unknown): boolean {
  // McpError carries ErrorCode.RequestTimeout (-32001) when the SDK's own
  // request timeout fires.
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === -32001;
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
    // The client said it could show a prompt and then could not. Refusing
    // here would make the tool unusable on that client for good; going on is
    // exactly what every client without elicitation gets.
    log(`${tool}: the client advertised elicitation but the confirmation prompt failed (${(e as Error).message}); running without it.`);
    return { proceed: true, args };
  }
  if (answer.action === "accept") {
    const content = (answer.content ?? {}) as Record<string, unknown>;
    return { proceed: true, args: prompt.apply ? prompt.apply(args, content) : args };
  }
  if (answer.action === "decline") return { proceed: false, message: notRunMessage(tool, "the user declined it in the confirmation prompt") };
  return { proceed: false, message: notRunMessage(tool, "the user dismissed the confirmation prompt without answering") };
}
