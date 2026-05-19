import WebSocket from "ws";
import type { WsEvent } from "@engineroom/shared";
import { logger } from "../util/logger.js";
import type { JobManager } from "../jobs/manager.js";

export class WsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private port: number, private jobs: JobManager) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `ws://127.0.0.1:${this.port}/events`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => logger.debug("WS connected", url));
    ws.on("message", (data) => {
      let evt: WsEvent;
      try { evt = JSON.parse(data.toString()) as WsEvent; }
      catch { return; }
      this.handleEvent(evt);
    });
    ws.on("close", () => {
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    });
    ws.on("error", () => {
      // suppress; close handler reconnects
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
