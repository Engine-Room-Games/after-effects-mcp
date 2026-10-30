import type { WriteLease } from "../bridge/writeQueue.js";

/** What the unticking needs of a write queue: the per-session one, or the session line in front of the desk (#223). */
export interface WriteLock {
  acquire(op: string, signal?: AbortSignal): Promise<WriteLease>;
  readonly held: string | null;
}
import type { RenderItemPlan } from "./aerender.js";
import type { SendInternal } from "../tools/internalOps.js";

/**
 * How long a finished render waits for the write lock before giving up on the
 * unticking. Short on purpose (issue #163): the job is not reported finished
 * until the unticking has an answer, and the queue's own ceiling — or a
 * chunked run_batch's hold, twice that — would leave `await_job` blocked on
 * an edit that has nothing to do with the render.
 */
export const MARK_DONE_WAIT_MS = 5_000;

export type MarkAnswer = { index: number; marked: boolean; reason?: string };

/**
 * Untick the rendered items in the live Render Queue, as one write — or, when
 * another write holds the project for longer than `waitMs`, say per item that
 * it was not unticked and what that means, and return at once. Never throws:
 * the render's result stands either way, and only this sentence changes.
 */
export async function markRendered(
  writes: WriteLock,
  runOp: SendInternal,
  items: RenderItemPlan[],
  waitMs: number = MARK_DONE_WAIT_MS
): Promise<MarkAnswer[]> {
  let lease;
  // A plain timer, not AbortSignal.timeout: that one is unref'd, and so is the
  // queue's own, so nothing would keep the wait alive to its end.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  try {
    lease = await writes.acquire("render_queue", stop.signal);
  } catch {
    const busy = writes.held ?? "another write";
    const reason =
      `not unticked: \`${busy}\` was writing to the project when the render finished, and the render is not ` +
      `held back waiting for it. The file is fine; untick this item in After Effects' Render Queue, or remove it ` +
      `with remove_render_item, before the next render_queue — otherwise it renders again.`;
    return items.map((i) => ({ index: i.index, marked: false, reason }));
  } finally {
    clearTimeout(timer);
  }
  try {
    const res = (await runOp("_render_mark_done", {
      items: items.map((i) => ({ index: i.index, compId: i.compId, outputPath: i.outputs[0]?.path ?? null })),
    })) as { results: MarkAnswer[] };
    return res.results;
  } finally {
    lease.release();
  }
}
