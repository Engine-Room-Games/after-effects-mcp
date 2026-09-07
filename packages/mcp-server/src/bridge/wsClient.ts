import WebSocket from "ws";
import type { WsEvent } from "@engineroom/shared";
import { logger } from "../util/logger.js";
import type { JobManager } from "../jobs/manager.js";
import type { HttpClient } from "./httpClient.js";

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

  constructor(private bridge: HttpClient, private jobs: JobManager) {
    // Awaited by `switchPort`, bounded there, so a retried op does not go out
    // before the socket that will carry its completion has (usually) opened.
    bridge.onPortChange(() => this.reconnect());
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }

  /** Drop the current socket and connect to wherever the bridge is now. Resolves on open, or on failure. */
  reconnect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const old = this.ws;
    this.ws = undefined;
    try { old?.removeAllListeners(); old?.close(); } catch {}
    return this.connect();
  }

  private connect(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const url = `ws://127.0.0.1:${this.bridge.port}/events`;
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise<void>((resolve) => {
      ws.on("open", () => { logger.debug("WS connected", url); resolve(); });
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
