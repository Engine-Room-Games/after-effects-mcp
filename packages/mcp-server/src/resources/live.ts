import { logger } from "../util/logger.js";
import { AeError, BridgeBusyError, aeErrorText } from "../util/errors.js";

/**
 * Live project state as MCP resources, with `resources/subscribe` (issue #248).
 *
 * - `ae://project/summary`     — `get_project_summary`: path, items, activeItemId.
 * - `ae://project/active-comp` — `get_comp` on the active item, or `comp: null` and why.
 *
 * The panel's event socket carries job events only, so change detection is a
 * poll. Its cost model, which docs/architecture.md ("Live resources") spells
 * out:
 *
 * - **No subscriber, no traffic.** The timer exists only while someone is
 *   subscribed. Listing is free; a client's own read is one ordinary read.
 * - **Each tick is constant time.** `_live_probe` reads the path, the item
 *   count, the active item and the active comp's summary — no walk. The
 *   active-comp resource is answered from it outright. The summary's full
 *   `get_project_summary` walk runs only when the probe moved, after this
 *   session ran a write that can rename an item without changing the count
 *   (`RENAMING_OPS`), or once per sweep (default 60 s), which is what catches
 *   a rename made by hand. Keyframes, transforms, effects — the writes an
 *   agent makes most — never cause a walk.
 * - **Writes go first.** A tick is skipped while this session holds or waits
 *   on the write lease, and until no write of its own has finished for the
 *   quiet period (default 2 s) — so a steadily writing agent pays nothing
 *   until it stops. Every poll read is sent `yieldToWrites`: refused unsent
 *   while this session writes, and, through the front desk, while *any*
 *   session holds the write lock — a `run_batch` holds it between chunks.
 * - **Failures are quiet.** A tick that fails keeps the last value, notifies
 *   nobody, logs once going and once coming back, and backs off to a minute.
 *   A client's own read reports the failure with the tool path's sentence.
 */

export const PROJECT_SUMMARY_URI = "ae://project/summary";
export const ACTIVE_COMP_URI = "ae://project/active-comp";

export const LIVE_RESOURCES = [
  {
    uri: PROJECT_SUMMARY_URI,
    name: "project-summary",
    description:
      "Live: the open After Effects project — its path, every item (id, name, type) and the active item's id. " +
      "The same answer as get_project_summary. Subscribe to be told when it changes (items added or removed, a " +
      "different project opened, the active item switched; a rename made by hand within about a minute).",
    mimeType: "application/json",
  },
  {
    uri: ACTIVE_COMP_URI,
    name: "active-comp",
    description:
      "Live: the comp the user has active in After Effects, as get_comp answers it (size, timing, layer count), " +
      "or `comp: null` with the reason when the active item is not a comp. Subscribe to be told when the user " +
      "switches comps or the comp's settings change. Edits inside a layer are not tracked here — use snapshot_comp/diff_comp.",
    mimeType: "application/json",
  },
] as const;

const LIVE_URIS = new Set<string>(LIVE_RESOURCES.map((r) => r.uri));

export function isLiveUri(uri: string): boolean {
  return LIVE_URIS.has(uri);
}

/**
 * A read op through the session's line — never a write. `background` reads
 * are the poll's, sent `yieldToWrites`, and may be refused as BridgeBusyError.
 */
export type LiveReader = (op: string, args: unknown, background: boolean) => Promise<unknown>;

export interface LiveResourcesOptions {
  read: LiveReader;
  /** Sends `notifications/resources/updated` for one uri. */
  notify: (uri: string) => Promise<void>;
  /** True while this session holds or waits on the write lease. */
  writing: () => boolean;
  /** The panel version gate: a message to refuse with, or null. */
  gate: () => Promise<string | null>;
  /** Poll interval; defaults to `livePollMs()`. Tests pass a short one. */
  intervalMs?: number;
  /** How long after this session's last write before a tick runs. */
  quietMs?: number;
  /** How often the summary is walked in full with nothing else prompting it. */
  sweepMs?: number;
}

const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;
const DEFAULT_QUIET_MS = 2_000;
const DEFAULT_SWEEP_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Writes that can change an item's name or flags while the item count, path
 * and active item stay put — the one change the probe cannot see. Anything
 * that adds or removes an item moves the count, so it needs no entry. An op
 * missing here costs a rename notification delayed to the sweep, never a
 * wrong answer.
 */
const RENAMING_OPS = new Set(["set_comp", "run_jsx", "run_batch", "revert_comp", "checkpoint_comp", "delete_checkpoints"]);

export function livePollMs(): number {
  const raw = process.env.AE_MCP_RESOURCE_POLL_MS?.trim();
  if (!raw) return DEFAULT_POLL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(`Ignoring AE_MCP_RESOURCE_POLL_MS=${raw} — expected a positive number of milliseconds.`);
    return DEFAULT_POLL_MS;
  }
  return Math.max(n, MIN_POLL_MS);
}

/** What a refresh failure says, or a read failure throws: the tool path's sentence. */
export function liveErrorText(e: unknown): string {
  if (e instanceof AeError) return e.code ? e.message : aeErrorText(e);
  return (e as Error)?.message ?? String(e);
}

interface Probe {
  path: string | null;
  numItems: number;
  activeItemId: number | null;
  activeType: string | null;
  activeComp: unknown;
}

interface Summary {
  path?: string | null;
  numItems?: number;
  activeItemId?: number | null;
  items?: { id: number; type?: string }[];
}

class GateRefusal extends Error {}

/** What, in a probe, means the item list may have changed. */
const probeKey = (p: { path?: string | null; numItems?: number; activeItemId?: number | null }) =>
  JSON.stringify([p.path ?? null, p.numItems ?? null, p.activeItemId ?? null]);

export class LiveResources {
  private subscribed = new Set<string>();
  /**
   * The last text each uri was read as, and the generation of the read that
   * produced it. A read finishing after a newer one started never overwrites
   * it, so a client read during a tick cannot be undone by the tick's older
   * answer — which used to cost two spurious notifications.
   */
  private last = new Map<string, { text: string; gen: number }>();
  private gen = 0;
  /** The probe key at the last full summary walk, and when it was. */
  private summaryKey: string | null = null;
  private summaryAt = 0;
  private wroteSinceWalk = false;
  private lastWriteAt = 0;
  /** False once the panel answered Unknown op to `_live_probe`: fall back to the full reads. */
  private probeSupported = true;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failing = false;
  private backoffMs: number;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly quietMs: number;
  private readonly sweepMs: number;

  constructor(private opts: LiveResourcesOptions) {
    this.intervalMs = opts.intervalMs ?? livePollMs();
    this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
    this.backoffMs = this.intervalMs;
  }

  /** Reads one live resource for a client and records it as the baseline. Throws the tool path's error. */
  async read(uri: string): Promise<string> {
    const stale = await this.opts.gate();
    if (stale) throw new Error(stale);
    const gen = ++this.gen;
    const text =
      uri === PROJECT_SUMMARY_URI ? await this.walkSummary(false) : JSON.stringify(await this.activeComp(false));
    this.record(uri, text, gen);
    return text;
  }

  subscribe(uri: string): void {
    if (!isLiveUri(uri) || this.stopped) return;
    this.subscribed.add(uri);
    // The first tick takes the baseline, so a change after subscribing is
    // reported even when the client never read the resource first.
    if (!this.timer && !this.running) this.schedule(this.last.has(uri) ? this.intervalMs : 0);
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri);
    if (this.subscribed.size === 0) this.clearTimer();
  }

  /**
   * A write of this session's finished. The next tick waits for a quiet
   * period after the last one; a write that can rename an item without moving
   * the probe also earns the summary one full walk then.
   */
  noteWrite(op: string): void {
    this.lastWriteAt = Date.now();
    if (RENAMING_OPS.has(op)) this.wroteSinceWalk = true;
    if (this.subscribed.size === 0 || this.stopped || this.running) return;
    this.schedule(this.quietMs);
  }

  stop(): void {
    this.stopped = true;
    this.subscribed.clear();
    this.clearTimer();
  }

  get subscriptions(): string[] {
    return [...this.subscribed];
  }

  // ------------------------------------------------------------------ poll

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.subscribed.size === 0) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(delayMs, 0));
    // A subscription must never be what keeps an orphaned server alive (#163).
    this.timer.unref?.();
  }

  private record(uri: string, text: string, gen: number): string | undefined | null {
    const prev = this.last.get(uri);
    if (prev && prev.gen > gen) return null; // a newer read already answered
    this.last.set(uri, { text, gen });
    return prev?.text;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.subscribed.size === 0) return;
    const quietLeft = this.lastWriteAt + this.quietMs - Date.now();
    if (this.opts.writing() || quietLeft > 0) {
      this.schedule(Math.max(quietLeft, Math.min(this.intervalMs, this.quietMs)));
      return;
    }
    this.running = true;
    let busy = false;
    try {
      const stale = await this.opts.gate();
      if (stale) throw new GateRefusal(stale);
      const gen = ++this.gen;
      const fresh = new Map<string, string>();
      const probe = this.probeSupported ? await this.probe(true) : null;
      if (this.subscribed.has(ACTIVE_COMP_URI)) {
        fresh.set(ACTIVE_COMP_URI, JSON.stringify(probe ? fromProbe(probe) : await this.activeComp(true)));
      }
      if (this.subscribed.has(PROJECT_SUMMARY_URI)) {
        const due =
          !probe ||
          !this.last.has(PROJECT_SUMMARY_URI) ||
          this.wroteSinceWalk ||
          probeKey(probe) !== this.summaryKey ||
          Date.now() - this.summaryAt >= this.sweepMs;
        if (due) fresh.set(PROJECT_SUMMARY_URI, await this.walkSummary(true));
      }
      if (this.failing) logger.info("Live resources: After Effects is answering again; change notifications resumed.");
      this.failing = false;
      this.backoffMs = this.intervalMs;
      for (const [uri, text] of fresh) {
        const before = this.record(uri, text, gen);
        if (typeof before === "string" && before !== text && this.subscribed.has(uri)) {
          await this.opts.notify(uri).catch((e) =>
            logger.warn(`resources/updated for ${uri} was not sent: ${(e as Error).message}`)
          );
        }
      }
    } catch (e) {
      if (e instanceof BridgeBusyError) {
        // A write — ours or another session's — holds the lock. Nothing was
        // sent; try again later, not as a failure.
        busy = true;
      } else {
        if (!this.failing) {
          logger.warn(
            `Live resources: could not refresh (${liveErrorText(e).split("\n")[0]}). ` +
              "Keeping the last values and retrying quietly; no notification is sent until After Effects answers."
          );
        }
        this.failing = true;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }
    } finally {
      this.running = false;
    }
    this.schedule(this.failing && !busy ? this.backoffMs : this.intervalMs);
  }

  // ----------------------------------------------------------------- reads

  private async probe(background: boolean): Promise<Probe | null> {
    try {
      return (await this.opts.read("_live_probe", {}, background)) as Probe;
    } catch (e) {
      // A panel older than this server's bundle, behind no version gate: the
      // full reads every panel has still answer.
      if (e instanceof AeError && /^Unknown op: /.test(e.message)) {
        this.probeSupported = false;
        return null;
      }
      throw e;
    }
  }

  private async walkSummary(background: boolean): Promise<string> {
    const summary = (await this.opts.read("get_project_summary", {}, background)) as Summary;
    this.summaryKey = probeKey(summary);
    this.summaryAt = Date.now();
    this.wroteSinceWalk = false;
    return JSON.stringify(summary);
  }

  private async activeComp(background: boolean): Promise<unknown> {
    const probe = this.probeSupported ? await this.probe(background) : null;
    if (probe) return fromProbe(probe);
    const summary = (await this.opts.read("get_project_summary", {}, background)) as Summary;
    const id = summary?.activeItemId ?? null;
    const item = id === null ? undefined : summary.items?.find((i) => i.id === id);
    if (id === null || (item && item.type !== "comp")) {
      return fromProbe({ path: null, numItems: 0, activeItemId: id, activeType: item?.type ?? null, activeComp: null });
    }
    return { activeItemId: id, comp: await this.opts.read("get_comp", { compId: id }, background) };
  }
}

function fromProbe(p: Probe): unknown {
  if (p.activeItemId === null || p.activeItemId === undefined) {
    return {
      activeItemId: null,
      comp: null,
      reason:
        "After Effects reports no active item — nothing is open in a viewer, or the Project panel has focus with nothing selected.",
    };
  }
  if (!p.activeComp) {
    return { activeItemId: p.activeItemId, comp: null, reason: `The active item is a ${p.activeType ?? "non-comp item"}, not a comp.` };
  }
  return { activeItemId: p.activeItemId, comp: p.activeComp };
}
