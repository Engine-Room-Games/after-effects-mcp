import { AeError, BridgeUnreachableError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { discoverPort } from "./discovery.js";

interface OpResultOk { ok: true; result: unknown; }
interface OpResultErr { ok: false; error: string; stack?: string; line?: number; }
type OpResult = OpResultOk | OpResultErr;

export class HttpClient {
  port: number;
  base: string;

  constructor(port?: number) {
    this.port = port ?? discoverPort();
    this.base = `http://127.0.0.1:${this.port}`;
  }

  async health(): Promise<{ ok: boolean; port: number; bundleLoaded?: boolean }> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`health HTTP ${r.status}`);
      return (await r.json()) as { ok: boolean; port: number; bundleLoaded?: boolean };
    } catch (e) {
      throw new BridgeUnreachableError(this.port, e as Error);
    }
  }

  async runOp(op: string, args: unknown, progressToken?: string | number): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/op`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, args: args ?? {}, progressToken }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new BridgeUnreachableError(this.port, e as Error);
    }
    let data: OpResult;
    try { data = (await resp.json()) as OpResult; }
    catch {
      throw new AeError(`Bridge returned non-JSON (HTTP ${resp.status})`);
    }
    if (!data.ok) {
      throw new AeError(data.error, data.stack, data.line);
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
