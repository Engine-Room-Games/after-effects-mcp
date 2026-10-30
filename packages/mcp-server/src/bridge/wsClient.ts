import WebSocket from "ws";
import { logger } from "../util/logger.js";
import { authHeaders } from "./discovery.js";
import type { JobManager } from "../jobs/manager.js";
import type { HttpClient } from "./httpClient.js";

/** What the panel broadcasts on /events (`broadcast` in packages/ae-panel/client/main.js). */
type WsEvent =
  | { type: "progress"; jobId: string; progress: number; total?: number; message?: string }
  | { type: "complete"; jobId: string; result: unknown }
  | { type: "error"; jobId: string; error: string; stack?: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

/**
 * The /events socket a long `run_batch` reports progress and completion on.
 *
 * It follows the HTTP client's port rather than keeping a copy of its own: a
 * copy taken at startup is exactly the stale value issue #92 is about, and a
 * socket left reconnecting to a port nobody listens on would lose every
 * completion event — which is what releases the write lease a batch holds.
 */
export class WsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private opened = false;
  private reopenListeners: (() => void)[] = [];

  constructor(private bridge: HttpClient, private jobs: JobManager) {
    // Awaited by `switchPort`, bounded there, so a retried op does not go out
    // before the socket that will carry its completion has (usually) opened.
    bridge.onPortChange(() => this.reconnect());
  }

  /**
   * Called whenever the socket opens after having been open before — a panel
   * restart, a rebind, a port move. The first open is not a reopen.
   */
  onReopen(listener: () => void): void {
    this.reopenListeners.push(listener);
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // terminate, not close: a graceful close waits up to 30s on a busy panel,
    // and shutdown (#163) must not sit on it until the fallback exit fires.
    try { this.ws?.terminate(); } catch {}
  }

  /** Drop the current socket and connect to wherever the bridge is now. Resolves on open, or on failure. */
  reconnect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const old = this.ws;
    this.ws = undefined;
    try {
      old?.removeAllListeners();
      // A socket still connecting emits `error` on the next tick when it is
      // closed ("WebSocket was closed before the connection was established"),
      // and with every listener gone that is an uncaught exception — the whole
      // server process, for a socket nobody wanted. It must never be able to
      // throw again; nothing it says matters now.
      old?.on("error", () => {});
      old?.close();
    } catch {}
    return this.connect();
  }

  private connect(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const url = `ws://127.0.0.1:${this.bridge.port}/events`;
    // Authenticated like /op (issue #106); read per connect, so a reconnect
    // after the panel rebinds picks up the new token.
    const ws = new WebSocket(url, { headers: authHeaders(this.bridge.port) });
    this.ws = ws;
    return new Promise<void>((resolve) => {
      ws.on("open", () => {
        logger.debug("WS connected", url);
        if (this.opened) {
          for (const l of this.reopenListeners) {
            try { l(); } catch (e) { logger.warn(`ws reopen listener failed: ${(e as Error).message}`); }
          }
        }
        this.opened = true;
        resolve();
      });
      ws.on("message", (data) => {
        let evt: WsEvent;
        try { evt = JSON.parse(data.toString()) as WsEvent; }
        catch { return; }
        this.handleEvent(evt);
      });
      ws.on("close", () => {
        resolve();
        // A socket replaced by `reconnect` must not schedule a second connect
        // to the old port on top of the new one.
        if (this.stopped || this.ws !== ws) return;
        this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      });
      ws.on("error", () => {
        // suppress; close handler reconnects
      });
    });
  }

  private handleEvent(evt: WsEvent): void {
    switch (evt.type) {
      case "progress":
        this.jobs.reportProgress(evt.jobId, evt.progress, evt.total, evt.message);
        break;
      case "complete":
        this.jobs.complete(evt.jobId, evt.result);
        break;
      case "error":
        this.jobs.fail(evt.jobId, evt.error);
        break;
      case "log":
        logger.debug("[ae]", evt.level, evt.message);
        break;
    }
  }
}
