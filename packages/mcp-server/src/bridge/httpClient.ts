import { AeError, BridgeTimeoutError, BridgeUnreachableError, isTimeoutError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { discoverPort } from "./discovery.js";

interface OpResultOk { ok: true; result: unknown; }
interface OpResultErr { ok: false; error: string; code?: string; stack?: string; line?: number; }
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
 * caller, not by us.
 */
const SLOW_OPS = new Set(["run_batch", "run_jsx", "screenshot_frame", "screenshot_layer"]);
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

export class HttpClient {
  port: number;
  base: string;

  constructor(port?: number) {
    this.port = port ?? discoverPort();
    this.base = `http://127.0.0.1:${this.port}`;
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

  async runOp(op: string, args: unknown, progressToken?: string | number): Promise<unknown> {
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
      throw new AeError(data.error, data.stack, data.line, data.code);
    }
    return data.result;
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
