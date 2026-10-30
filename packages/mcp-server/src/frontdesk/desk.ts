import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../util/logger.js";
import { BridgeBusyError } from "../util/errors.js";
import {
  DESK_ID,
  DESK_NONCE_HEADER,
  DESK_PROTOCOL,
  DESK_TOKEN_HEADER,
  deskBeatMs,
  deskMaxBodyBytes,
  monoMs,
  removeDeskFile,
  writeDeskFile,
} from "./config.js";
import { DeskClosedError, DeskLock, UPDATE_EVERY_MS, type LockRequest } from "./lock.js";
import { toWire, type DeskAhead, type LockLine, type OpLine } from "./protocol.js";

/**
 * The front desk itself (issue #223): run by whichever MCP server bound the desk
 * port first, used in-process by that server's own session and over loopback
 * HTTP by every other session on the same After Effects.
 *
 * It does two things and nothing else. It holds the one cross-session write lock
 * (`DeskLock`), and it forwards every After Effects-bound call — keeping an
 * ordered record of what it has handed to the panel and not yet heard back
 * about, which is what lets it tell a waiting session the truth. It does not
 * gate on the panel version, apply read-only mode, or own jobs: each session
 * does those for itself before anything reaches the desk (see line.ts).
 */

/** What the desk needs from the session that runs it: its own way to the panel. */
export interface DeskForwarder {
  runOp(op: string, args: unknown, opts: { timeoutMs?: number; beforeRetry?: () => void }): Promise<unknown>;
  cancel(jobId: string): Promise<{ known: boolean; error?: string }>;
  /** The panel port the forwarder is on now — followers' event sockets follow it. */
  readonly port: number;
}

export interface ForwardRequest {
  sessionId: string;
  session: string;
  kind: "op" | "cancel";
  op: string;
  args?: unknown;
  jobId?: string;
  timeoutMs?: number;
  /** A write: refused unless `leaseId` is the lease holding the lock now. */
  write?: boolean;
  leaseId?: string;
  /**
   * `monoMs()` time after which the requester has given up on this call, or
   * may have. Checked immediately before forwarding: a desk that was stalled
   * and wakes up must never forward what its requester already reported as
   * lost and may have re-sent elsewhere. One machine, one monotonic clock.
   */
  deadline?: number;
  /**
   * A background read (the live-resource poll, issue #248): refused unsent,
   * as `BridgeBusyError`, while any session holds the write lock — a
   * `run_batch` holds it between its chunks, so this is what keeps the poll
   * from landing in the middle of another session's batch.
   */
  yieldToWrites?: boolean;
}

export interface ForwardHooks {
  /** Called immediately before the call is posted to the panel, with what is ahead of it. */
  onStart?: (ahead: DeskAhead[]) => Promise<void> | void;
  onAhead?: (ahead: DeskAhead[]) => void;
  /** False once the requester is known to have gone. Asked right before forwarding. */
  stillWanted?: () => boolean;
}

/** The call's deadline passed before it could be forwarded. Nothing was sent. */
export class DeadlinePassedError extends Error {
  constructor() {
    super("The call's deadline passed before the front desk could forward it; nothing was sent.");
    this.name = "DeadlinePassedError";
  }
}

/** The write claimed a lease that is not the one holding the lock. Nothing was sent. */
export class LeaseNotHeldError extends Error {
  constructor() {
    super("This write's lease does not hold the front desk's lock; nothing was sent.");
    this.name = "LeaseNotHeldError";
  }
}

/** The leases that span several panel calls, and so are what a takeover's grace protects. */
const LONG_HOLD_OPS = new Set(["run_batch", "render_queue"]);

/** The proof a desk gives that it knows the token: HMAC of the follower's nonce. */
export function deskProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(nonce).digest("hex");
}

interface InFlight {
  seq: number;
  sessionId: string;
  session: string;
  op: string;
  since: number;
}

const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** A request body larger than this is refused. A run_batch of 2000 steps is a few MB. */

export class FrontDesk {
  readonly lock: DeskLock;
  readonly beatMs: number;
  private server: http.Server | null = null;
  private inflight: InFlight[] = [];
  private seq = 0;
  /** Open /desk/lock responses, so `close()` can tell each one the desk is moving. */
  private lockStreams = new Set<http.ServerResponse>();
  private closing = false;
  private published = false;
  private batchHeld = false;
  private readonly startedAt = Date.now();

  constructor(
    private forwarder: DeskForwarder,
    readonly opts: { port: number; token: string; graceMs?: number; beatMs?: number }
  ) {
    this.beatMs = opts.beatMs ?? deskBeatMs();
    this.lock = new DeskLock({
      graceMs: opts.graceMs,
      onHolderChange: (h) => this.noteHolder(h),
    });
  }

  /** Bind the desk port. Rejects with the bind error — `EADDRINUSE` means another server holds it. */
  listen(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        logger.warn(`front desk: request failed: ${(e as Error).message}`);
        try { res.destroy(); } catch {}
      });
    });
    // A follower's lock connection is a lifeline that may legitimately stay
    // open for a whole long batch; Node's default timeouts would cut it.
    server.requestTimeout = 0;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    return new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        server.removeListener("listening", onListening);
        reject(e);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (e) => logger.warn(`front desk: ${(e as Error).message}`));
        this.server = server;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ port: this.opts.port, host: "127.0.0.1", exclusive: true });
    });
  }

  /** Write the desk file that tells followers the token. Only ever after the bind. */
  publish(): void {
    this.published = true;
    this.writeFile();
    // Every exit this process can still run code on removes the file: a normal
    // exit or an uncaught exception ('exit'), and the terminating signals,
    // which are re-raised afterwards so they still terminate. SIGKILL and a
    // crash cannot be caught; the next server's sweep removes those files.
    process.on("exit", this.onExit);
    for (const sig of EXIT_SIGNALS) process.on(sig, this.onSignal);
  }

  private unhook(): void {
    process.removeListener("exit", this.onExit);
    for (const sig of EXIT_SIGNALS) process.removeListener(sig, this.onSignal);
  }

  private readonly onExit = () => this.dropFile();

  private readonly onSignal = (sig: NodeJS.Signals) => {
    this.dropFile();
    this.unhook();
    // Someone else handles this signal: leave the decision to them.
    if (process.listenerCount(sig) > 0) return;
    process.kill(process.pid, sig);
  };

  /** The file goes unless a long lease holds the lock — the successor needs it then. */
  private dropFile(): void {
    if (this.published && !this.batchHeld) removeDeskFile(this.opts.port, this.opts.token);
  }

  private writeFile(): void {
    writeDeskFile({
      desk: DESK_ID,
      protocol: DESK_PROTOCOL,
      pid: process.pid,
      port: this.opts.port,
      token: this.opts.token,
      startedAt: this.startedAt,
      batchHeld: this.batchHeld,
    });
  }

  /**
   * Keep `batchHeld` in the file true exactly while a long lease holds the lock,
   * so whoever takes over from this desk — after a crash or a graceful close —
   * knows whether there is a session to wait for. Written only when it changes:
   * twice per batch, never per ordinary write.
   */
  private noteHolder(h: { op: string } | null): void {
    const long = !!h && LONG_HOLD_OPS.has(h.op);
    if (long === this.batchHeld || !this.published || this.closing) return;
    this.batchHeld = long;
    try { this.writeFile(); } catch (e) { logger.warn(`front desk: could not update the desk file: ${(e as Error).message}`); }
  }

  status() {
    const now = Date.now();
    return {
      desk: DESK_ID,
      protocol: DESK_PROTOCOL,
      pid: process.pid,
      port: this.opts.port,
      panelPort: this.forwarder.port,
      lock: this.lock.status(),
      inFlight: this.inflight.map((f) => ({ op: f.op, session: f.session, runningMs: now - f.since })),
    };
  }

  /**
   * Hand one call to After Effects, and keep track of it until it answers.
   *
   * Never queued here: the write lock is taken before a write gets this far,
   * and reads do not take it — a screenshot must never stall a write (see
   * docs/architecture.md, "Serializing writes"). A write must name the lease
   * holding the lock, or nothing is sent. The panel's own evalScript chain is a
   * FIFO, so calls forwarded in this order run in this order; the record, plus
   * whatever holds the lock, is how the desk says what is ahead of whom.
   */
  async forward(req: ForwardRequest, hooks: ForwardHooks = {}): Promise<unknown> {
    if (req.write && (!req.leaseId || !this.lock.isHolder(req.leaseId))) throw new LeaseNotHeldError();
    if (req.yieldToWrites && this.lock.held) throw new BridgeBusyError(req.op, this.lock.held.op);
    const entry: InFlight = { seq: ++this.seq, sessionId: req.sessionId, session: req.session, op: req.op, since: Date.now() };
    const ahead = () => {
      const now = Date.now();
      const out = this.inflight
        .filter((f) => f.seq < entry.seq && f.sessionId !== req.sessionId)
        .map((f) => ({ op: f.op, session: f.session, forMs: now - f.since }));
      // A batch's chunks are driven inside the panel, not through here, so the
      // only trace of one running is the lease its session still holds. Named,
      // so a read waiting in After Effects behind it is told what it is behind.
      const held = this.lock.held;
      if (held && held.sessionId !== req.sessionId && !this.inflight.some((f) => f.sessionId === held.sessionId)) {
        out.unshift({ op: held.op, session: held.session, forMs: now - held.since });
      }
      return out;
    };
    const before = ahead();
    await hooks.onStart?.(before);
    // The last moment before the panel: let pending I/O land first — a closed
    // requester or a released lease is often already in the kernel's queue when
    // a stalled desk wakes up and reads the request ahead of it — then check
    // everything again. Measured as a double write on SIGSTOP/SIGCONT before this.
    await new Promise<void>((r) => setImmediate(r));
    // Run again before any re-post the forwarder makes after a refusal: its
    // port search takes seconds, and the caller may have given up meanwhile.
    // A freeze between this and the bytes reaching the panel cannot be closed
    // from here; the stalled-desk message says so.
    const stillGo = () => {
      if (req.deadline !== undefined && monoMs() > req.deadline) throw new DeadlinePassedError();
      if (req.yieldToWrites && this.lock.held) throw new BridgeBusyError(req.op, this.lock.held.op);
      if (hooks.stillWanted && !hooks.stillWanted()) throw new CallerGoneError();
      if (req.write && (!req.leaseId || !this.lock.isHolder(req.leaseId))) throw new LeaseNotHeldError();
    };
    stillGo();
    entry.since = Date.now();
    this.inflight.push(entry);
    let ticker: NodeJS.Timeout | null = null;
    if (hooks.onAhead && before.length > 0) {
      ticker = setInterval(() => {
        const now = ahead();
        if (now.length === 0) {
          clearInterval(ticker!);
          ticker = null;
          return;
        }
        try { hooks.onAhead!(now); } catch {}
      }, UPDATE_EVERY_MS);
      ticker.unref?.();
    }
    try {
      if (req.kind === "cancel") return await this.forwarder.cancel(req.jobId ?? "");
      return await this.forwarder.runOp(req.op, req.args, { timeoutMs: req.timeoutMs, beforeRetry: stillGo });
    } finally {
      if (ticker) clearInterval(ticker);
      this.inflight = this.inflight.filter((f) => f !== entry);
    }
  }

  /**
   * Stop being the desk. The port is released at once, so another server can
   * take over while calls already handed to After Effects finish and answer
   * here. Waiters and lock holders are told the desk is moving. The desk file is
   * left in place when a long lease was holding the lock, so the successor knows
   * to give that session its grace period; otherwise it is removed.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.lock.close();
    for (const res of this.lockStreams) {
      try { if (!res.writableEnded) res.end(line({ t: "moved" })); } catch {}
    }
    this.lockStreams.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        // Resolve once the port is released; in-flight answers keep their sockets.
        setTimeout(resolve, 50).unref?.();
      });
    }
    this.dropFile();
    this.unhook();
  }

  // ---------------------------------------------------------------- HTTP

  private authorised(req: http.IncomingMessage): boolean {
    const sent = req.headers[DESK_TOKEN_HEADER];
    if (typeof sent !== "string") return false;
    const a = Buffer.from(sent);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A browser always sends Origin, and nothing of ours does: a request
    // carrying one is a web page, whatever token it has (as on the panel, #106).
    if (req.headers.origin !== undefined) return json(res, 403, { desk: DESK_ID, error: "origin" });
    // Refused before the body is read, and the 401 still says it is a desk, so a
    // server starting up can tell "a desk whose file I read too early" from a
    // foreign process on the port.
    if (!this.authorised(req)) return json(res, 401, { desk: DESK_ID, error: "token" });
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url === "/desk/hello") {
      // Mutual: the follower proved it has the token by sending it; the desk
      // proves it has it too, so a process that merely answers 200 with the
      // right id is never mistaken for the desk.
      const nonce = req.headers[DESK_NONCE_HEADER];
      return json(res, 200, {
        desk: DESK_ID,
        protocol: DESK_PROTOCOL,
        pid: process.pid,
        beatMs: this.beatMs,
        proof: typeof nonce === "string" ? deskProof(this.opts.token, nonce) : null,
      });
    }
    if (req.method === "GET" && url === "/desk/status") return json(res, 200, this.status());
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const body = await readBody(req);
    if (body === null) return json(res, 413, { error: "body too large" });
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; }
    catch { return json(res, 400, { error: "bad json" }); }
    if (url === "/desk/lock") return this.handleLock(parsed, res);
    if (url === "/desk/op") return this.handleOp(parsed, res);
    return json(res, 404, { error: "unknown route" });
  }

  private handleLock(b: Record<string, unknown>, res: http.ServerResponse): void {
    this.stream(res);
    if (this.closing) {
      res.end(line({ t: "moved" }));
      return;
    }
    const abort = new AbortController();
    let grantedId: string | null = null;
    let finished = false;
    this.lockStreams.add(res);
    // The connection is the lease: when it closes — released, or the session's
    // server died — the lock is freed. A waiter that goes is dropped unrun.
    res.on("close", () => {
      finished = true;
      this.lockStreams.delete(res);
      abort.abort();
      if (grantedId) this.lock.release(grantedId);
    });
    const request: LockRequest = {
      op: String(b.op ?? "write"),
      sessionId: String(b.sessionId ?? ""),
      session: String(b.session ?? "another session"),
      maxWaitMs: num(b.maxWaitMs, 600_000),
      maxDepth: num(b.maxDepth, 64),
      resume: b.resume === true,
      holdCeilingMs: num(b.holdCeilingMs, 1_200_000),
      heldForMs: typeof b.heldForMs === "number" && b.heldForMs > 0 && b.resume === true ? b.heldForMs : undefined,
      onUpdate: (l) => { if (!finished && !res.writableEnded) res.write(line(l)); },
    };
    this.lock.acquire(request, abort.signal).then(
      (grant) => {
        if (finished) {
          this.lock.release(grant.id);
          return;
        }
        grantedId = grant.id;
        res.write(line({ t: "granted", id: grant.id, wait: grant.wait }));
      },
      (e) => {
        if (finished || res.writableEnded) return;
        this.lockStreams.delete(res);
        res.end(line(e instanceof DeskClosedError ? { t: "moved" } : { t: "err", error: toWire(e) }));
      }
    );
  }

  private async handleOp(b: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    this.stream(res);
    let gone = false;
    res.on("close", () => { gone = true; });
    const panelPort = () => this.forwarder.port;
    try {
      const result = await this.forward(
        {
          sessionId: String(b.sessionId ?? ""),
          session: String(b.session ?? "another session"),
          kind: b.kind === "cancel" ? "cancel" : "op",
          op: String(b.op ?? ""),
          args: b.args,
          jobId: typeof b.jobId === "string" ? b.jobId : undefined,
          timeoutMs: typeof b.timeoutMs === "number" && b.timeoutMs > 0 ? b.timeoutMs : undefined,
          write: b.write === true,
          leaseId: typeof b.leaseId === "string" ? b.leaseId : undefined,
          deadline: typeof b.deadline === "number" ? b.deadline : undefined,
          yieldToWrites: b.yieldToWrites === true,
        },
        {
          onStart: (ahead) => {
            // The caller went before anything was sent: send nothing.
            if (gone || res.destroyed) throw new CallerGoneError();
            res.write(line({ t: "start", ahead }));
          },
          onAhead: (ahead) => { if (!gone) res.write(line({ t: "ahead", ahead })); },
          stillWanted: () => !gone && !res.destroyed && !(res.socket?.destroyed ?? true),
        }
      );
      if (!gone) res.end(line({ t: "ok", result, panelPort: panelPort() }));
    } catch (e) {
      if (e instanceof CallerGoneError) return;
      if (e instanceof LeaseNotHeldError) {
        if (!gone) res.end(line({ t: "lost" }));
        return;
      }
      if (e instanceof DeadlinePassedError) {
        if (!gone) res.end(line({ t: "expired" }));
        return;
      }
      if (!gone) res.end(line({ t: "err", error: toWire(e), panelPort: panelPort() }));
    }
  }

  /** Open an NDJSON answer that beats until it ends, so a caller can tell a stalled desk from a busy one. */
  private stream(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    // Each line is a message the caller is waiting on; never let Nagle sit on one.
    res.socket?.setNoDelay(true);
    res.flushHeaders();
    const beat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(beat);
      res.write(line({ t: "beat" }));
    }, this.beatMs);
    beat.unref?.();
    res.on("close", () => clearInterval(beat));
  }
}

export class CallerGoneError extends Error {}

function line(l: LockLine | OpLine): string {
  return JSON.stringify(l) + "\n";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > deskMaxBodyBytes()) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}
