import { logger } from "../util/logger.js";
import { AeError, aeErrorText } from "../util/errors.js";

/**
 * Live project state as MCP resources, with `resources/subscribe` (issue #248).
 *
 * Two resources, both read through ops every panel ever shipped has — so this
 * needs no panel update (the thin-panel principle: everything that is not
 * After Effects happens here):
 *
 * - `ae://project/summary`     — `get_project_summary`: path, items, activeItemId.
 * - `ae://project/active-comp` — the comp `activeItemId` names, via `get_comp`.
 *
 * **Nothing is asked of After Effects unless a client is subscribed.** The
 * panel broadcasts job events only — nothing on its event socket says the
 * project changed — so change detection is a poll, and the poll exists only
 * while the subscription set is non-empty. Reading a resource is one ordinary
 * read; listing them costs nothing.
 *
 * Three rules keep the poll from costing more than it is worth:
 *
 * - **Bounded rate.** One refresh at a time, never closer together than the
 *   interval (default 5 s, `AE_MCP_RESOURCE_POLL_MS`, floor 1 s). A finished
 *   write nudges a refresh sooner — the change an agent most wants to hear
 *   about is usually its own — but still not inside the floor.
 * - **Never beside a write.** The refresh is a read through the session's line
 *   like any other read, and it is skipped outright while this session holds
 *   or waits on the write lease: a long `run_batch` holds it for its whole
 *   job, and a summary read between two of its chunks would describe half a
 *   batch and spend After Effects time the batch is waiting on.
 * - **Failures are quiet.** A refresh that cannot reach After Effects keeps the
 *   last value, notifies nobody, logs once when the bridge goes and once when
 *   it comes back, and backs off to a minute. A read the client makes itself
 *   is the one that reports the failure, with the same message a tool would.
 */

export const PROJECT_SUMMARY_URI = "ae://project/summary";
export const ACTIVE_COMP_URI = "ae://project/active-comp";

export const LIVE_RESOURCES = [
  {
    uri: PROJECT_SUMMARY_URI,
    name: "project-summary",
    description:
      "Live: the open After Effects project — its path, every item (id, name, type) and the active item's id. " +
      "The same answer as get_project_summary. Subscribe to be told when it changes (items added, removed, renamed; " +
      "a different project opened; the active item switched).",
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

/** A read op through the session's line — never a write, never past the queue. */
export type LiveReader = (op: string, args: unknown) => Promise<unknown>;

export interface LiveResourcesOptions {
  read: LiveReader;
  /** Sends `notifications/resources/updated` for one uri. */
  notify: (uri: string) => Promise<void>;
  /** True while this session holds or waits on the write lease. */
  writing: () => boolean;
  /** Poll interval; defaults to `livePollMs()`. Tests pass a short one. */
  intervalMs?: number;
}

const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** How soon after a finished write a nudge refreshes, floor permitting. */
const NUDGE_MS = 250;

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

interface Summary {
  activeItemId?: number | null;
  items?: { id: number; type?: string }[];
}

export class LiveResources {
  private subscribed = new Set<string>();
  /** The last text each live uri was read as — the baseline a change is measured against. */
  private last = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt = 0;
  private failing = false;
  private backoffMs: number;
  private stopped = false;
  private readonly intervalMs: number;

  constructor(private opts: LiveResourcesOptions) {
    this.intervalMs = opts.intervalMs ?? livePollMs();
    this.backoffMs = this.intervalMs;
  }

  /** Reads one live resource, records it as the baseline, and returns its text. Throws the bridge's own error. */
  async read(uri: string): Promise<string> {
    const text = (await this.fetch([uri])).get(uri)!;
    this.last.set(uri, text);
    return text;
  }

  subscribe(uri: string): void {
    if (!isLiveUri(uri) || this.stopped) return;
    this.subscribed.add(uri);
    // The first refresh takes the baseline, so a change after subscribing is
    // reported even when the client never read the resource first.
    if (!this.timer && !this.running) this.schedule(this.last.has(uri) ? this.intervalMs : 0);
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri);
    if (this.subscribed.size === 0) this.clearTimer();
  }

  /** A write finished: refresh soon, if anyone is listening. */
  nudge(): void {
    if (this.subscribed.size === 0 || this.stopped || this.running) return;
    this.schedule(NUDGE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.subscribed.clear();
    this.clearTimer();
  }

  /** For tests and logs. */
  get subscriptions(): string[] {
    return [...this.subscribed];
  }

  // ------------------------------------------------------------------ poll

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** (Re)arms the one timer, never sooner than the floor after the last refresh. */
  private schedule(delayMs: number): void {
    if (this.stopped || this.subscribed.size === 0) return;
    const floor = Math.min(this.intervalMs, MIN_POLL_MS);
    const earliest = this.lastRunAt + floor - Date.now();
    const delay = Math.max(delayMs, earliest, 0);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    // A subscription must never be what keeps an orphaned server alive (#163).
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.subscribed.size === 0) return;
    if (this.opts.writing()) {
      this.schedule(this.intervalMs);
      return;
    }
    this.running = true;
    this.lastRunAt = Date.now();
    const uris = [...this.subscribed];
    try {
      const fresh = await this.fetch(uris);
      if (this.failing) logger.info("Live resources: After Effects is answering again; change notifications resumed.");
      this.failing = false;
      this.backoffMs = this.intervalMs;
      for (const [uri, text] of fresh) {
        const before = this.last.get(uri);
        this.last.set(uri, text);
        if (before !== undefined && before !== text && this.subscribed.has(uri)) {
          await this.opts.notify(uri).catch((e) =>
            logger.warn(`resources/updated for ${uri} was not sent: ${(e as Error).message}`)
          );
        }
      }
    } catch (e) {
      if (!this.failing) {
        logger.warn(
          `Live resources: could not refresh (${liveErrorText(e).split("\n")[0]}). ` +
            "Keeping the last values and retrying quietly; no notification is sent until After Effects answers."
        );
      }
      this.failing = true;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    } finally {
      this.running = false;
    }
    this.schedule(this.failing ? this.backoffMs : this.intervalMs);
  }

  // ----------------------------------------------------------------- reads

  /** One summary read serves both resources; the active comp costs one more read only when asked for. */
  private async fetch(uris: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const summary = (await this.opts.read("get_project_summary", {})) as Summary;
    if (uris.includes(PROJECT_SUMMARY_URI)) out.set(PROJECT_SUMMARY_URI, JSON.stringify(summary));
    if (uris.includes(ACTIVE_COMP_URI)) out.set(ACTIVE_COMP_URI, JSON.stringify(await this.activeComp(summary)));
    return out;
  }

  private async activeComp(summary: Summary): Promise<unknown> {
    const id = summary?.activeItemId ?? null;
    if (id === null || id === undefined) {
      return {
        activeItemId: null,
        comp: null,
        reason:
          "After Effects reports no active item — nothing is open in a viewer, or the Project panel has focus with nothing selected.",
      };
    }
    const item = summary.items?.find((i) => i.id === id);
    if (item && item.type !== "comp") {
      return { activeItemId: id, comp: null, reason: `The active item is a ${item.type ?? "non-comp item"}, not a comp.` };
    }
    return { activeItemId: id, comp: await this.opts.read("get_comp", { compId: id }) };
  }
}
