import type { AeSourceInfo } from "../util/errors.js";
import { AeError, BridgeTimeoutError, BridgeUnreachableError, isTimeoutError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { discoverPort, locatePanel, portCandidates, type LocateResult } from "./discovery.js";

interface OpResultOk { ok: true; result: unknown; }
interface OpResultErr { ok: false; error: string; code?: string; stack?: string; line?: number; source?: AeSourceInfo; }
type OpResult = OpResultOk | OpResultErr;

/** Long enough that a normal op never trips it; short enough to be a signal. */
const DEFAULT_OP_TIMEOUT_MS = 120_000;

/**
 * Ops whose slowness is expected rather than a symptom.
 *
 * `screenshot_*` is the load-bearing case: `saveFrameToPng` is asynchronous, so
 * the panel itself waits up to 120s for the PNG to appear on disk (see
 * `waitForPngFile` in the panel's client). With the same 120s here, the server
 * gave up at the exact moment the panel might still have succeeded — a cold 4K
 * render was measured taking over 15s and the ceiling is far higher. The
 * server's limit has to sit *above* the panel's, not on it.
 *
 * `run_jsx` and `run_batch` are here because their duration is chosen by the
 * caller, not by us. `place_audio_cues` for the same reason — one call can
 * import dozens of files and build a layer for each, all synchronously.
 * `purge_unused_footage` because its duration is chosen by the project: one
 * `usedIn` per footage item, over a bin that reached 1,863 orphaned solids
 * before the op existed (issue #83).
 */
const SLOW_OPS = new Set([
  "run_batch", "run_jsx", "screenshot_frame", "screenshot_layer", "export_mogrt",
  "import_footage", "place_audio_cues", "purge_unused_footage",
]);
const SLOW_OP_TIMEOUT_MS = 300_000;

/**
 * `AE_MCP_OP_TIMEOUT_MS` overrides the limit for *every* op, slow ones included.
 * One number with no exceptions is the only version a user can reason about
 * when they are raising it because something of theirs times out.
 */
export function opTimeoutMs(op?: string): number {
  const raw = process.env.AE_MCP_OP_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
    logger.warn(`Ignoring AE_MCP_OP_TIMEOUT_MS=${raw} — expected a positive number of milliseconds.`);
  }
  return op && SLOW_OPS.has(op) ? SLOW_OP_TIMEOUT_MS : DEFAULT_OP_TIMEOUT_MS;
}

/** Liveness probe only, so it stays short whatever the op timeout is set to. */
const HEALTH_TIMEOUT_MS = 2000;

/** Told when the client moves to a different port. May be async; awaited, bounded. */
export type PortChangeListener = (next: number, previous: number) => void | Promise<void>;

/** How long a port-change listener gets to settle before the retried op goes out. */
const LISTENER_SETTLE_MS = 750;

export interface HttpClientOptions {
  /**
   * Where to look when the cached port refuses. Defaults to `portCandidates()`;
   * a test hands in its own list so nothing real on the machine is ever asked.
   */
  candidates?: () => number[];
}

/**
 * One line appended to the unreachable message when a refusal was followed by
 * a search that found nothing better. Names what was asked so the reader is
 * not left assuming the server only ever looked at one port — and says which
 * one, if any, is there and merely busy, since that changes the next move.
 */
function probeSummary(located: LocateResult): string {
  if (located.probed.length === 0) return "";
  const busy = located.probed.find((p) => p.status === "busy");
  const parts = located.probed.map((p) => p.detail);
  const head = `Also looked for the panel on port${located.probed.length > 1 ? "s" : ""} ${located.probed.map((p) => p.port).join(", ")}: ${parts.join("; ")}.`;
  return busy
    ? `${head} A listener on port ${busy.port} may be the panel with After Effects busy; the next call looks again.`
    : head;
}

export class HttpClient {
  port: number;
  base: string;
  /** The port this client started on — what a later drift is measured against. */
  readonly initialPort: number;
  private listeners: PortChangeListener[] = [];
  private candidatesFn: () => number[];

  constructor(port?: number, opts: HttpClientOptions = {}) {
    this.port = port ?? discoverPort();
    this.initialPort = this.port;
    this.base = `http://127.0.0.1:${this.port}`;
    this.candidatesFn = opts.candidates ?? portCandidates;
  }

  /** The ports a rediscovery will ask, in order. Exposed so `check_setup` asks the same ones. */
  candidates(): number[] {
    return this.candidatesFn();
  }

  onPortChange(listener: PortChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * Move to another port and let the dependants follow before anything else
   * is sent there. The wait is bounded: a listener that never settles must not
   * turn a port switch into a hang.
   */
  async switchPort(next: number): Promise<void> {
    const previous = this.port;
    if (next === previous) return;
    this.port = next;
    this.base = `http://127.0.0.1:${next}`;
    logger.warn(`Bridge port changed: ${previous} -> ${next}`);
    await Promise.race([
      Promise.all(this.listeners.map((l) => Promise.resolve().then(() => l(next, previous)).catch((e) => {
        logger.warn(`port-change listener failed: ${(e as Error).message}`);
      }))),
      new Promise<void>((r) => setTimeout(r, LISTENER_SETTLE_MS).unref?.()),
    ]);
  }

  /**
   * Ask the candidate ports where the panel is now. Returns the probe that
   * answered as the panel, or null — and the whole list of what was asked, so
   * a failure can say what it looked at.
   */
  async rediscover(): Promise<LocateResult> {
    return locatePanel(this.candidates());
  }

  // `bundleHash` is absent on panels installed before it was added; callers must
  // treat undefined as "too old to say" rather than as a mismatch.
  async health(): Promise<{ ok: boolean; port: number; bundleLoaded?: boolean; bundleHash?: string | null }> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`health HTTP ${r.status}`);
      return (await r.json()) as { ok: boolean; port: number; bundleLoaded?: boolean; bundleHash?: string | null };
    } catch (e) {
      // A busy AE blows this 2s probe long before it blows the op timeout, and
      // check_setup is exactly what a confused user runs next — so this failure
      // must not claim the panel is gone either.
      if (isTimeoutError(e)) {
        throw new BridgeTimeoutError(this.port, HEALTH_TIMEOUT_MS, { op: "health", adjustable: false });
      }
      throw new BridgeUnreachableError(this.port, e as Error);
    }
  }

  /**
   * One POST to /op on the current port. Its own `AbortSignal.timeout`, created
   * here, so a retry after a port switch gets the full budget rather than the
   * remainder of a clock that started before the refusal.
   */
  private async postOp(op: string, args: unknown, progressToken?: string | number): Promise<unknown> {
    let resp: Response;
    const timeoutMs = opTimeoutMs(op);
    try {
      resp = await fetch(`${this.base}/op`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, args: args ?? {}, progressToken }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Timed out and refused are different diagnoses with different remedies.
      // Collapsing them into "cannot reach the panel" is what sends people off
      // restarting a bridge that was only busy.
      if (isTimeoutError(e)) throw new BridgeTimeoutError(this.port, timeoutMs, { op });
      throw new BridgeUnreachableError(this.port, e as Error);
    }
    let data: OpResult;
    try { data = (await resp.json()) as OpResult; }
    catch {
      throw new AeError(`Bridge returned non-JSON (HTTP ${resp.status})`);
    }
    if (!data.ok) {
      throw new AeError(data.error, data.stack, data.line, data.code, data.source);
    }
    return data.result;
  }

  /**
   * Forward an op, following the panel if it has moved.
   *
   * The port is discovered once, at construction, and every op posts there —
   * which is how `check_setup` could report the panel healthy on 7777 while
   * every op failed on 7778 for a week (issue #92): the panel had moved after
   * this server read the port file. So a *refused* connection is taken as a
   * cue to look again. Only a refusal, and this is the whole safety argument:
   * refused means the request never reached a panel, so sending it again
   * cannot run anything twice. A timeout is the opposite case — the call did
   * reach After Effects and may still be running — and must never be retried
   * (issue #43 is what a duplicated `run_jsx` costs).
   *
   * The retry happens only when the search turns up a *different* port that
   * answers as the panel. The same port answering again means the refusal was
   * something else, and that is the original error's story to tell.
   */
  async runOp(op: string, args: unknown, progressToken?: string | number): Promise<unknown> {
    try {
      return await this.postOp(op, args, progressToken);
    } catch (e) {
      if (!(e instanceof BridgeUnreachableError)) throw e;
      const refusedPort = this.port;
      const located = await this.rediscover();
      if (located.found && located.found.port !== refusedPort) {
        logger.warn(
          `\`${op}\` was refused on port ${refusedPort}; the panel is answering on port ${located.found.port}. Switching and re-sending once.`
        );
        await this.switchPort(located.found.port);
        return await this.postOp(op, args, progressToken);
      }
      // Nothing better found. The refusal stands, but the message says what
      // was looked at — a reader told only "cannot reach 7780" would go and
      // check 7777 by hand, which the server has just done for them.
      const summary = probeSummary(located);
      if (summary) (e as BridgeUnreachableError).message += `\n${summary}`;
      throw e;
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await fetch(`${this.base}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
    } catch (e) {
      logger.warn("cancel failed", (e as Error).message);
    }
  }
}
