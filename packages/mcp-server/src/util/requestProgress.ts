import { EmptyResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { logger } from "./logger.js";

export interface ProgressParams {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * How long `settle()` waits for the client to answer its ping. A compliant
 * client answers at once (the spec says MUST, promptly); this only bounds what
 * a client that never answers costs a call that reported progress.
 */
export const SETTLE_PING_TIMEOUT_MS = 500;

/**
 * The one way a `tools/call` request sends `notifications/progress` on its own
 * token, and the one thing that decides when its response may follow them.
 *
 * Every progress notification has to be *handled* by the client before the
 * response is, not merely written before it. The SDK client
 * (@modelcontextprotocol/sdk 1.32.2) dispatches a notification one microtask
 * after reading it but a response at once, and the response deletes the
 * request's progress handler. A final notification that arrives in the same
 * read as the response therefore finds no handler: `onprogress` never sees the
 * last step, and the client reports "Received a progress notification for an
 * unknown token" (issue #261). Measured over stdio, a chunked batch's final
 * 100% was lost that way on 37 of 200 `await_job` calls, 64 of 200 under load.
 *
 * A pause before the response does not close that window, it only narrows it:
 * the client reads whatever has reached the pipe since it last looked, so a
 * client that is busy for longer than the pause still reads both at once.
 * Measured: `setImmediate` lost 20 of 200 under load, a 10 ms timer 3 of 400
 * with no load at all.
 *
 * What closes it is a round trip. After the last notification, `settle()`
 * sends the client a `ping` (every MCP peer must answer one) and waits for the
 * answer. The client reads the notification no later than the ping, queues its
 * handler first, and can only answer the ping after that handler has run — so
 * when the answer arrives the notification has been handled, and the response
 * can no longer overtake it. A request that sent no progress pays nothing; one
 * that did pays one round trip, or SETTLE_PING_TIMEOUT_MS at worst from a
 * client that ignores pings. A ping that fails for any reason (a client that
 * refuses it, a cancelled request, a closed transport) falls back to one turn
 * of the event loop and the response goes out as before.
 *
 * Both go through the SDK's request-scoped senders on purpose: they tag each
 * message with the request id, so a Streamable HTTP transport delivers them on
 * that request's own stream, and the notification sender drops anything sent
 * after the request was cancelled.
 */
export class RequestProgress {
  private readonly inFlight = new Set<Promise<void>>();
  private sentAny = false;

  constructor(
    private readonly extra: Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, "sendNotification" | "sendRequest" | "signal">,
    readonly token: string | number | undefined
  ) {}

  /** Whether the client asked for progress on this request. */
  get wanted(): boolean {
    return this.token !== undefined;
  }

  /** Send one notification on this request's token; a no-op when none was given. */
  send(params: ProgressParams, what = "progress notification"): void {
    if (this.token === undefined) return;
    this.sentAny = true;
    const p = this.extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: this.token, ...params } })
      .catch((e) => logger.warn(`${what} was not sent: ${(e as Error).message}`));
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /**
   * Await before the response is written. Call it after whatever could still
   * send has been stopped (an unbound job emitter), or a notification started
   * after it could still land behind the response.
   */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
    if (!this.sentAny || this.extra.signal?.aborted) return;
    try {
      await this.extra.sendRequest({ method: "ping" }, EmptyResultSchema, { timeout: SETTLE_PING_TIMEOUT_MS });
    } catch (e) {
      logger.debug(`progress settle ping went unanswered: ${(e as Error).message}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
