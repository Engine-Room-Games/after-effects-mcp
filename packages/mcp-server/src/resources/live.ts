import { logger } from "../util/logger.js";
import { AeError, BridgeBusyError, aeErrorText } from "../util/errors.js";

/**
 * Live project state as MCP resources, with `resources/subscribe` (issue #248).
 *
 * - `ae://project/summary`     — `get_project_summary` without `activeItemId`.
 * - `ae://project/active-comp` — `{compId, comp}`, `comp` being get_comp's
 *   answer for the comp last active in a viewer.
 *
 * The panel's event socket carries job events only, so change detection is a
 * poll. Its cost model, which docs/architecture.md ("Live resources") spells
 * out:
 *
 * - **No subscriber, no traffic.** The timer exists only while someone is
 *   subscribed. Listing is free; a client's own read is one ordinary read.
 * - **Each tick is constant time.** `_live_probe` reads the path, the item
 *   count, the active item and the sticky comp's summary — no walk. The
 *   active-comp resource is answered from it. The summary's full walk runs
 *   only when the path or count moved, after this session ran a renaming
 *   write (`RENAMING_OPS`), or once per sweep (default 60 s).
 * - **Focus is not a change.** `activeItem` goes null or non-comp whenever the
 *   Project panel takes focus, so the active comp is sticky — it changes only
 *   when another comp becomes active — and the active item is kept out of the
 *   summary entirely. Otherwise every click in the Project panel would
 *   notify, and cost a walk.
 * - **Writes go first.** A tick is skipped while this session holds or waits
 *   on the write lease, and until no write of its own has finished for the
 *   quiet period (default 2 s). Every poll read is sent `yieldToWrites`:
 *   refused unsent while this session writes, and, through the front desk,
 *   while *any* session holds the write lock.
 * - **Failures are quiet.** A tick that fails keeps the last value, notifies
 *   nobody, logs once going and once coming back, and backs off to a minute.
 *   A refused (busy) tick is not a failure. A client's own read reports a
 *   failure with the tool path's sentence.
 */

export const PROJECT_SUMMARY_URI = "ae://project/summary";
export const ACTIVE_COMP_URI = "ae://project/active-comp";

export const LIVE_RESOURCES = [
  {
    uri: PROJECT_SUMMARY_URI,
    name: "project-summary",
    description:
      "Live: the open After Effects project — its path, item count and every item (id, name, type): " +
      "get_project_summary's answer without activeItemId (the active comp is ae://project/active-comp). " +
      "Subscribe to be told when it changes — items added or removed, a different project opened at once; " +
      "a rename made by hand within about a minute.",
    mimeType: "application/json",
  },
  {
    uri: ACTIVE_COMP_URI,
    name: "active-comp",
    description:
      "Live: the comp last active in an After Effects viewer, as `{compId, comp}` where `comp` is get_comp's answer " +
      "(size, timing, layer count); `{compId: null, comp: null, reason}` when there is none. Clicking into the " +
      "Project panel does not clear it. Subscribe to be told when another comp becomes active or this one's " +
      "settings change. Edits inside a layer are not tracked here — use snapshot_comp/diff_comp.",
    mimeType: "application/json",
  },
] as const;

const LIVE_URIS = new Set<string>(LIVE_RESOURCES.map((r) => r.uri));

export function isLiveUri(uri: string): boolean {
  return LIVE_URIS.has(uri);
}

export interface LiveResourcesOptions {
  /** A public read op through the session's line. `background` reads yield to writes. */
  read: (op: string, args: unknown, background: boolean) => Promise<unknown>;
  /** `_live_probe`, through the internal-op sender. */
  probe: (args: unknown, background: boolean) => Promise<unknown>;
  /** Sends `notifications/resources/updated` for one uri. */
  notify: (uri: string) => Promise<void>;
  /** True while this session holds or waits on the write lease. */
  writing: () => boolean;
  /** The panel version gate: a message to refuse with, or null. */
  gate: () => Promise<string | null>;
  /** Poll interval; defaults to `livePollMs()`. */
  intervalMs?: number;
  /** How long after this session's last write before a tick runs. */
  quietMs?: number;
  /** How often the summary is walked in full with nothing else prompting it. */
  sweepMs?: number;
  /** Clock and timer, replaceable so a test can drive ticks itself. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;
const DEFAULT_QUIET_MS = 2_000;
const DEFAULT_SWEEP_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Writes that can change an item's name or flags while the item count and
 * path stay put — the one change the probe cannot see. Anything that adds or
 * removes an item moves the count, so it needs no entry. An op missing here
 * costs a rename notification delayed to the sweep, never a wrong answer.
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
  /** The sticky comp's summary, asked for by id; null when it is gone. */
  comp: unknown;
}

interface Summary {
  path?: string | null;
  numItems?: number;
  activeItemId?: number | null;
  items?: { id: number; type?: string }[];
}

class GateRefusal extends Error {}

/** What, in a probe, means the item list may have changed. Not the active item: focus is not a change. */
const summaryKey = (p: { path?: string | null; numItems?: number }) => JSON.stringify([p.path ?? null, p.numItems ?? null]);

export class LiveResources {
  private subscribed = new Set<string>();
  /**
   * The last text each uri was read as, and the generation of the read that
   * produced it. A read finishing after a newer one started never overwrites
   * it, so a client read during a tick cannot be undone by the tick's older
   * answer.
   */
  private last = new Map<string, { text: string; gen: number }>();
  private gen = 0;
  /** The comp last seen active. Kept while focus is elsewhere; cleared only when the comp is gone. */
  private stickyId: number | null = null;
  private walkKey: string | null = null;
  private walkedAt = 0;
  private renamedSinceWalk = false;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private probeSupported = true;
  private timer: unknown = null;
  private running = false;
  private failing = false;
  private backoffMs: number;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly quietMs: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;

  constructor(private opts: LiveResourcesOptions) {
    this.intervalMs = opts.intervalMs ?? livePollMs();
    this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
    this.backoffMs = this.intervalMs;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A subscription must never be what keeps an orphaned server alive (#163).
        t.unref?.();
        return t;
      });
    this.clearTimerFn = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Reads one live resource for a client and records it as the baseline. Throws the tool path's error. */
  async read(uri: string): Promise<string> {
    const stale = await this.opts.gate();
    if (stale) throw new Error(stale);
    const gen = ++this.gen;
    const text = uri === PROJECT_SUMMARY_URI ? await this.walkSummary(false) : JSON.stringify(await this.activeComp(false));
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

  /** A write of this session's finished: the next tick waits out the quiet period after it. */
  noteWrite(op: string): void {
    this.lastWriteAt = this.now();
    if (RENAMING_OPS.has(op)) this.renamedSinceWalk = true;
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

  /** One tick, now. The timer calls it; a test calls it to drive the poll by hand. */
  async poll(): Promise<void> {
    if (this.stopped || this.subscribed.size === 0 || this.running) return;
    const quietLeft = this.lastWriteAt + this.quietMs - this.now();
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
        fresh.set(ACTIVE_COMP_URI, JSON.stringify(probe ? this.fromProbe(probe) : await this.activeComp(true)));
      }
      if (this.subscribed.has(PROJECT_SUMMARY_URI)) {
        const due =
          !probe ||
          !this.last.has(PROJECT_SUMMARY_URI) ||
          this.renamedSinceWalk ||
          summaryKey(probe) !== this.walkKey ||
          this.now() - this.walkedAt >= this.sweepMs;
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
        // sent: not a failure, so no warning and no backoff.
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

  // ------------------------------------------------------------------ timer

  private clearTimer(): void {
    if (this.timer) this.clearTimerFn(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.subscribed.size === 0) return;
    this.clearTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, Math.max(delayMs, 0));
  }

  private record(uri: string, text: string, gen: number): string | undefined | null {
    const prev = this.last.get(uri);
    if (prev && prev.gen > gen) return null; // a newer read already answered
    this.last.set(uri, { text, gen });
    return prev?.text;
  }

  // ----------------------------------------------------------------- reads

  private async probe(background: boolean): Promise<Probe | null> {
    try {
      return (await this.opts.probe(this.stickyId === null ? {} : { compId: this.stickyId }, background)) as Probe;
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
    this.walkKey = summaryKey(summary);
    this.walkedAt = this.now();
    this.renamedSinceWalk = false;
    const { activeItemId: _focus, ...rest } = summary ?? {};
    return JSON.stringify(rest);
  }

  /** The sticky rule, in one place: an active comp replaces the sticky one; nothing else does. */
  private fromProbe(p: Probe): unknown {
    if (p.activeType === "comp" && p.activeItemId !== null && p.activeComp) {
      this.stickyId = p.activeItemId;
      return { compId: p.activeItemId, comp: p.activeComp };
    }
    if (this.stickyId !== null) {
      if (p.comp) return { compId: this.stickyId, comp: p.comp };
      this.stickyId = null;
      return { compId: null, comp: null, reason: "The comp that was last active no longer exists, and no other comp is active." };
    }
    return noActiveComp();
  }

  private async activeComp(background: boolean): Promise<unknown> {
    const probe = this.probeSupported ? await this.probe(background) : null;
    if (probe) return this.fromProbe(probe);
    // Without the probe: the summary names the active item, get_comp reads it.
    const summary = (await this.opts.read("get_project_summary", {}, background)) as Summary;
    const id = summary?.activeItemId ?? null;
    const item = id === null ? undefined : summary.items?.find((i) => i.id === id);
    const target = item?.type === "comp" ? id : this.stickyId;
    if (target === null) return noActiveComp();
    try {
      const comp = await this.opts.read("get_comp", { compId: target }, background);
      this.stickyId = target;
      return { compId: target, comp };
    } catch (e) {
      if (e instanceof AeError && target === this.stickyId) {
        this.stickyId = null;
        return noActiveComp();
      }
      throw e;
    }
  }
}

function noActiveComp(): unknown {
  return {
    compId: null,
    comp: null,
    reason: "No comp has been active in a viewer since this server started watching. Open one, or use list_comps.",
  };
}
