import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { HttpClient } from "../bridge/httpClient.js";
import { opTimeoutMs } from "../bridge/httpClient.js";
import type { QueueWait, WriteLease, WriteQueue } from "../bridge/writeQueue.js";
import { BridgeTimeoutError, FrontDeskLostError, WriteQueueCancelledError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { DESK_ID, DESK_PROTOCOL, DESK_TOKEN_HEADER, readDeskFile, removeDeskFile, writeDeskFile, type FrontDeskOptions } from "./config.js";
import { FrontDesk, type DeskForwarder } from "./desk.js";
import { DeskClosedError } from "./lock.js";
import { describeAhead, describeLockWait, fromWire, type DeskAhead, type GrantWait, type LockLine, type OpLine } from "./protocol.js";

/**
 * One session's way to After Effects when several sessions share it (issue #223).
 *
 * Every MCP server has one of these. It is the only thing in the server that
 * knows whether there is a front desk, and whether this server is running it
 * (`leader`), using another server's (`follower`), or going straight to the
 * panel as every server did before (`direct`, and `off` when no desk is
 * configured — in which case every method is a plain pass-through to the
 * `WriteQueue` and `HttpClient` it wraps, byte for byte the old behaviour).
 *
 * Its two jobs are the ones `server.ts` used to do against those two directly:
 *
 * - `acquire` — the session's own write queue first, unchanged, so its calls
 *   stay in the order the agent issued them; then the desk's cross-session
 *   lock. The lease returned behaves exactly like a `WriteQueue` lease.
 * - `runOp` / `cancel` — through the desk, which forwards to the panel.
 *
 * And the one new job: surviving the desk's death. See `send` for the rule.
 */

/** Grace a desk that replaced a dead one gives resumed leases. */
const GRACE_MS = 1500;
/** How long a server tries to join or become the desk before going direct. */
const ELECTION_DEADLINE_MS = 5000;
/** How many times one call follows the desk to a new server before going direct. */
const MAX_HANDOVERS = 4;
/** Above the desk's own op timeout, so the desk's timeout — with its message — always lands first. */
const FOLLOWER_TIMEOUT_SLACK_MS = 10_000;
const HELLO_TIMEOUT_MS = 1000;

export interface SessionLineOptions {
  /** Null: no desk at all — today's behaviour, exactly. */
  desk: FrontDeskOptions | null;
  /** How this session is described to *other* sessions: client name and pid. */
  sessionLabel: () => string;
}

type Mode =
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "leader"; desk: FrontDesk; token: string; port: number }
  | { kind: "follower"; port: number; token: string; pid: number }
  | { kind: "direct"; retryAt: number };

type Slot =
  | { kind: "local"; id: string; desk: FrontDesk }
  | { kind: "remote"; id: string; abort: () => void; closed: Promise<unknown> };

type OnWait = (message: string) => void;

export class SessionLine {
  readonly sessionId = randomUUID();
  private mode: Mode;
  private electing: Promise<Mode> | null = null;
  /** Ever joined or ran a desk: a desk this server starts later is a takeover, and gets the grace period. */
  private everJoined = false;
  /** The desk lease this session holds now. At most one: the session's own queue is in front of it. */
  private holding: HeldDesk | null = null;
  private closed = false;
  private readonly forwarder: DeskForwarder;

  constructor(
    private bridge: HttpClient,
    private local: WriteQueue,
    private opts: SessionLineOptions
  ) {
    this.mode = opts.desk ? { kind: "none" } : { kind: "off" };
    const b = bridge;
    this.forwarder = {
      runOp: (op, args, o) => b.runOp(op, args, undefined, o),
      cancel: (jobId) => b.cancel(jobId),
      get port() { return b.port; },
    };
  }

  /** Join or start the desk now, rather than on the first call — the first server up is the desk. */
  start(): void {
    if (this.mode.kind !== "off") void this.ensure();
  }

  /** For `markRendered`, which names what holds the queue when it gives up waiting. */
  get held(): string | null {
    return this.local.held;
  }

  get holdCeilingMs(): number {
    return this.local.holdCeilingMs;
  }

  /** What this server is to the desk, for logs and tests. */
  get role(): "off" | "leader" | "follower" | "direct" | "none" {
    return this.mode.kind;
  }

  // ------------------------------------------------------------ write lock

  async acquire(op: string, signal?: AbortSignal, onWait?: OnWait): Promise<WriteLease> {
    const localLease = await this.local.acquire(op, signal);
    if (this.mode.kind === "off") return localLease;
    let taken: { slot: Slot; wait: GrantWait | null } | null;
    try {
      taken = await this.takeSlot(op, signal, onWait, false);
    } catch (e) {
      localLease.release();
      throw e;
    }
    if (!taken) return localLease;
    const held = new HeldDesk(this, op, taken.slot);
    this.holding = held;
    const releaseDesk = () => {
      held.release();
      if (this.holding === held) this.holding = null;
    };
    const wait: QueueWait | null = taken.wait
      ? {
          queuedBehind: taken.wait.queuedBehind,
          waitedMs: (localLease.wait?.waitedMs ?? 0) + taken.wait.waitedMs,
          queuedBehindSession: taken.wait.queuedBehindSession,
        }
      : localLease.wait;
    const ceiling = this.local.holdCeilingMs;
    let extended = false;
    return {
      wait,
      extendUntil(p: Promise<unknown>) {
        extended = true;
        // The desk is let go first, then the session's own queue: the other way
        // round, this session's next write would find its own batch still
        // holding the desk and be reported as waiting behind itself.
        const settled = Promise.race([
          p.then(() => undefined, () => undefined),
          new Promise<void>((r) => setTimeout(r, ceiling).unref?.()),
        ]).then(releaseDesk);
        localLease.extendUntil(settled);
      },
      release() {
        if (!extended) releaseDesk();
        localLease.release();
      },
    };
  }

  /** @internal Take the desk lock: from this process's own desk, from another's, or not at all (direct). */
  async takeSlot(op: string, signal: AbortSignal | undefined, onWait: OnWait | undefined, resume: boolean): Promise<{ slot: Slot; wait: GrantWait | null } | null> {
    for (let attempt = 0; attempt < MAX_HANDOVERS; attempt++) {
      const mode = await this.ensure();
      const req = {
        op,
        sessionId: this.sessionId,
        session: this.opts.sessionLabel(),
        maxWaitMs: this.local.maxWaitMs,
        maxDepth: this.local.maxDepthLimit,
        resume,
        holdCeilingMs: this.local.holdCeilingMs + 60_000,
      };
      if (mode.kind === "leader") {
        try {
          const g = await mode.desk.lock.acquire({ ...req, onUpdate: (l) => surfaceLock(op, l, onWait) }, signal);
          return { slot: { kind: "local", id: g.id, desk: mode.desk }, wait: g.wait };
        } catch (e) {
          // Only this server's own shutdown closes its desk.
          if (e instanceof DeskClosedError) return null;
          throw e;
        }
      }
      if (mode.kind !== "follower") return null;
      const r = await remoteLock(mode, req, op, signal, onWait);
      if (r.kind === "granted") return { slot: r.slot, wait: r.wait };
      if (r.kind === "error") throw r.error;
      this.deskLost(mode);
    }
    logger.warn(`Front desk: could not take the write lock for \`${op}\` after ${MAX_HANDOVERS} handovers; going direct for this call.`);
    return null;
  }

  // ------------------------------------------------------------ forwarding

  runOp(op: string, args: unknown, o: { write?: boolean; onWait?: OnWait } = {}): Promise<unknown> {
    if (this.mode.kind === "off") return this.bridge.runOp(op, args);
    return this.send({ kind: "op", op, args, timeoutMs: opTimeoutMs(op) }, o.write === true, o.onWait, () => this.bridge.runOp(op, args));
  }

  async cancel(jobId: string): Promise<{ known: boolean; error?: string }> {
    if (this.mode.kind === "off") return this.bridge.cancel(jobId);
    return (await this.send(
      { kind: "cancel", op: "cancel_job", jobId, timeoutMs: opTimeoutMs("run_batch") },
      false,
      undefined,
      () => this.bridge.cancel(jobId)
    )) as { known: boolean; error?: string };
  }

  /**
   * Send one call through the desk, following it if it moves.
   *
   * The rule that keeps a handover from losing or doubling a write rests on the
   * desk's `start` line, written and flushed before it posts to the panel:
   *
   * - lost **before** `start` — the call never reached After Effects. Sent again,
   *   to whichever server has the desk now. Nothing is lost, nothing runs twice.
   * - lost **after** `start` — it may have run. A write is never re-sent: it fails
   *   with `FrontDeskLostError`, a reset, whose remedy is to read back first. A
   *   read is sent again — running it twice changes nothing.
   * - `lost` — the desk says the lease this write claims is not the one holding
   *   the lock (it died with the previous desk). Nothing was sent; the lease is
   *   re-taken, with priority, and the call goes again.
   */
  private async send(
    body: { kind: "op" | "cancel"; op: string; args?: unknown; jobId?: string; timeoutMs: number },
    write: boolean,
    onWait: OnWait | undefined,
    direct: () => Promise<unknown>
  ): Promise<unknown> {
    const { op } = body;
    for (let attempt = 0; attempt <= MAX_HANDOVERS; attempt++) {
      const mode = await this.ensure();
      if (mode.kind !== "leader" && mode.kind !== "follower") return direct();
      if (attempt === MAX_HANDOVERS) {
        logger.warn(`Front desk: \`${op}\` followed the desk through ${MAX_HANDOVERS} handovers; sending it direct.`);
        return direct();
      }
      const slot = write && this.holding ? await this.holding.current() : null;
      if (mode.kind === "leader") {
        // Promoted while holding a lease on the desk that just died: wait for
        // that lease to be noticed lost and re-taken here, then go.
        if (slot?.kind === "remote") {
          await slot.closed;
          continue;
        }
        return mode.desk.forward(
          { sessionId: this.sessionId, session: this.opts.sessionLabel(), ...body },
          {
            onStart: (ahead) => surfaceAhead(op, ahead, onWait),
            onAhead: (ahead) => surfaceAhead(op, ahead, onWait),
          }
        );
      }
      const leaseId = slot?.kind === "remote" ? slot.id : undefined;
      const r = await remoteOp(mode, { ...body, leaseId, sessionId: this.sessionId, session: this.opts.sessionLabel() }, (ahead) => surfaceAhead(op, ahead, onWait));
      switch (r.kind) {
        case "ok":
          this.followPanel(r.panelPort);
          return r.result;
        case "err":
          this.followPanel(r.panelPort);
          throw r.error;
        case "lost":
          if (leaseId) this.holding?.invalidate(leaseId);
          continue;
        case "before-start":
          this.deskLost(mode);
          continue;
        case "after-start":
          this.deskLost(mode);
          if (write) throw new FrontDeskLostError(mode.port, op);
          continue;
        case "timeout":
          throw new BridgeTimeoutError(this.bridge.port, body.timeoutMs, { op });
      }
    }
    return direct();
  }

  /**
   * The desk found the panel somewhere else (issue #92's drift, seen by the
   * leader). This session's event socket follows the same bridge port, so it
   * moves too — otherwise a batch's completion would go to a socket on a port
   * nobody listens on, and the lease it releases would be held to its ceiling.
   */
  private followPanel(port: number | undefined): void {
    if (typeof port === "number" && port > 0 && port !== this.bridge.port) {
      void this.bridge.switchPort(port);
    }
  }

  // ------------------------------------------------------------ election

  private deskLost(mode: Mode): void {
    if (this.mode === mode) this.mode = { kind: "none" };
  }

  private ensure(): Promise<Mode> {
    const m = this.mode;
    if (m.kind === "off" || m.kind === "leader" || m.kind === "follower") return Promise.resolve(m);
    if (m.kind === "direct" && (this.closed || Date.now() < m.retryAt)) return Promise.resolve(m);
    if (!this.electing) {
      this.electing = this.elect()
        .then((next) => {
          if (!this.closed) this.mode = next;
          return this.mode;
        })
        .finally(() => {
          this.electing = null;
        });
    }
    return this.electing;
  }

  /**
   * Become the desk, or find the one there is.
   *
   * Bind first: the bind is the election, atomic on both platforms and released
   * by the OS when its holder dies, so two servers can never both win and a
   * dead one never holds it. Losing the bind means a desk exists — or something
   * else holds the port, which is told apart by asking. Every way this can fail
   * ends in `direct`, today's behaviour, with a warning, and is tried again later.
   */
  private async elect(): Promise<Mode> {
    const cfg = this.opts.desk!;
    const port = cfg.port;
    const deadline = Date.now() + (cfg.electionDeadlineMs ?? ELECTION_DEADLINE_MS);
    const direct = (why: string, retryMs: number): Mode => {
      logger.warn(`Front desk: ${why} This session talks to After Effects directly, as before; other sessions are not serialized against it.`);
      return { kind: "direct", retryAt: Date.now() + retryMs };
    };
    for (;;) {
      if (this.closed) return { kind: "direct", retryAt: Infinity };
      const takeover = this.everJoined || readDeskFile(port) !== null;
      const token = randomBytes(32).toString("hex");
      const desk = new FrontDesk(this.forwarder, { port, token, graceMs: takeover ? (cfg.graceMs ?? GRACE_MS) : 0 });
      try {
        await desk.listen();
        try {
          writeDeskFile({ desk: DESK_ID, protocol: DESK_PROTOCOL, pid: process.pid, port, token, startedAt: Date.now() });
        } catch (e) {
          await desk.close();
          return direct(`bound 127.0.0.1:${port} but could not write ${port}'s desk file (${(e as Error).message}).`, 60_000);
        }
        this.everJoined = true;
        logger.info(`Front desk: this server runs the desk for every session on this After Effects (127.0.0.1:${port}${takeover ? ", taking over" : ""}).`);
        return { kind: "leader", desk, token, port };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") return direct(`could not bind 127.0.0.1:${port} (${(e as Error).message}).`, 60_000);
      }
      const info = readDeskFile(port);
      const hello = await deskHello(port, info?.token ?? null);
      if (hello.kind === "desk") {
        if (hello.protocol !== DESK_PROTOCOL) {
          return direct(`the desk on 127.0.0.1:${port} speaks protocol ${hello.protocol} and this server speaks ${DESK_PROTOCOL} — a different version of the server is running it.`, 60_000);
        }
        this.everJoined = true;
        logger.info(`Front desk: joined the desk on 127.0.0.1:${port}, run by pid ${hello.pid}.`);
        return { kind: "follower", port, token: info!.token, pid: hello.pid };
      }
      if (hello.kind === "foreign") {
        return direct(`port ${port} is held by something that is not a front desk. Set AE_MCP_FRONT_DESK_PORT to a free port in every session to share one.`, 60_000);
      }
      // A desk we read the file of too early, or one that died between the bind
      // and the hello: go round again.
      if (Date.now() > deadline) return direct(`no desk on 127.0.0.1:${port} answered within ${Math.round((cfg.electionDeadlineMs ?? ELECTION_DEADLINE_MS) / 1000)}s.`, 10_000);
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
    }
  }

  /** Release whatever this session holds and, if it runs the desk, hand the desk on. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.holding?.release();
    this.holding = null;
    const m = this.mode;
    this.mode = { kind: "direct", retryAt: Infinity };
    if (m.kind === "leader") {
      await m.desk.close();
      removeDeskFile(m.port, m.token);
      logger.info(`Front desk: closed; the next server to need it takes it over.`);
    }
  }
}

/**
 * A desk lease that survives the desk. If the desk it was granted on goes away
 * while the session still holds it — most often while its `run_batch` is still
 * running chunks — it is re-taken at the next desk with priority, and every
 * write under it waits for that before it goes.
 */
class HeldDesk {
  private slot: Slot | null = null;
  private released = false;
  private pending: Promise<void> | null = null;

  constructor(private line: SessionLine, private op: string, first: Slot) {
    this.attach(first);
  }

  private attach(slot: Slot): void {
    this.slot = slot;
    if (slot.kind === "remote") slot.closed.then(() => { if (this.slot === slot) this.lost(); });
  }

  /** The desk says `id` is not the lease holding the lock. */
  invalidate(id: string): void {
    if (this.slot?.kind === "remote" && this.slot.id === id) {
      this.slot.abort();
      this.lost();
    }
  }

  private lost(): void {
    if (this.released || this.pending) return;
    this.slot = null;
    logger.warn(`Front desk: the desk holding \`${this.op}\`'s write lock went away; re-taking it at the next one.`);
    this.pending = this.line
      .takeSlot(this.op, undefined, undefined, true)
      .then(
        (r) => {
          if (!r) return;
          if (this.released) return releaseSlot(r.slot);
          this.attach(r.slot);
        },
        (e) => logger.warn(`Front desk: could not re-take the write lock for \`${this.op}\`: ${(e as Error).message}`)
      )
      .finally(() => { this.pending = null; });
  }

  async current(): Promise<Slot | null> {
    while (this.pending) await this.pending;
    return this.slot;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.slot) releaseSlot(this.slot);
    this.slot = null;
  }
}

function releaseSlot(slot: Slot): void {
  if (slot.kind === "local") slot.desk.lock.release(slot.id);
  else slot.abort();
}

function surfaceLock(op: string, l: Extract<LockLine, { t: "wait" }>, onWait: OnWait | undefined): void {
  // Only ever about another session: a session is never told it waits behind itself.
  if (!l.holder) return;
  const text = describeLockWait(op, l);
  logger.debug(text);
  try { onWait?.(text); } catch {}
}

function surfaceAhead(op: string, ahead: DeskAhead[], onWait: OnWait | undefined): void {
  if (ahead.length === 0) return;
  const text = describeAhead(op, ahead);
  logger.debug(text);
  try { onWait?.(text); } catch {}
}

// ------------------------------------------------------------------ wire

type StreamEnd = { kind: "ended" } | { kind: "refused" } | { kind: "broken"; error?: Error } | { kind: "status"; status: number } | { kind: "aborted" };

/**
 * One NDJSON request to the desk. `closed` settles exactly once, however the
 * exchange ends; `abort` ends it from this side, which for a lock is the release.
 * `node:http` with no agent, so closing it closes the socket and the desk sees it.
 */
function deskStream(port: number, token: string, route: string, body: unknown, onLine: (l: unknown) => void): { abort: () => void; closed: Promise<StreamEnd> } {
  let settle!: (e: StreamEnd) => void;
  let settled = false;
  const closed = new Promise<StreamEnd>((r) => { settle = (e) => { if (!settled) { settled = true; r(e); } }; });
  const payload = Buffer.from(JSON.stringify(body));
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: route,
    method: "POST",
    agent: false,
    headers: { "content-type": "application/json", "content-length": payload.length, [DESK_TOKEN_HEADER]: token },
  });
  let responded = false;
  req.on("response", (res) => {
    responded = true;
    if (res.statusCode !== 200) {
      res.resume();
      settle({ kind: "status", status: res.statusCode ?? 0 });
      return;
    }
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!text.trim()) continue;
        try { onLine(JSON.parse(text)); } catch {}
      }
    });
    res.on("end", () => settle({ kind: "ended" }));
    res.on("error", (e) => settle({ kind: "broken", error: e }));
    res.on("close", () => settle({ kind: "broken" }));
  });
  req.on("error", (e: NodeJS.ErrnoException) => {
    settle(!responded && e.code === "ECONNREFUSED" ? { kind: "refused" } : { kind: "broken", error: e });
  });
  req.end(payload);
  return {
    abort: () => {
      settle({ kind: "aborted" });
      req.destroy();
    },
    closed,
  };
}

type LockOutcome =
  | { kind: "granted"; slot: Slot; wait: GrantWait | null }
  | { kind: "error"; error: Error }
  | { kind: "gone" };

function remoteLock(
  mode: Extract<Mode, { kind: "follower" }>,
  req: Record<string, unknown>,
  op: string,
  signal: AbortSignal | undefined,
  onWait: OnWait | undefined
): Promise<LockOutcome> {
  if (signal?.aborted) return Promise.resolve({ kind: "error", error: new WriteQueueCancelledError(op) });
  return new Promise<LockOutcome>((resolve) => {
    let done = false;
    const finish = (o: LockOutcome) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    const s = deskStream(mode.port, mode.token, "/desk/lock", req, (raw) => {
      const l = raw as LockLine;
      if (l.t === "wait") surfaceLock(op, l, onWait);
      else if (l.t === "granted") finish({ kind: "granted", slot: { kind: "remote", id: l.id, abort: s.abort, closed: s.closed }, wait: l.wait });
      else if (l.t === "err") finish({ kind: "error", error: fromWire(l.error) });
      else if (l.t === "moved") finish({ kind: "gone" });
    });
    const onAbort = () => {
      s.abort();
      finish({ kind: "error", error: new WriteQueueCancelledError(op) });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    s.closed.then(() => finish({ kind: "gone" }));
  });
}

type OpOutcome =
  | { kind: "ok"; result: unknown; panelPort: number }
  | { kind: "err"; error: Error; panelPort: number }
  | { kind: "lost" }
  | { kind: "before-start" }
  | { kind: "after-start" }
  | { kind: "timeout" };

function remoteOp(
  mode: Extract<Mode, { kind: "follower" }>,
  body: { timeoutMs: number } & Record<string, unknown>,
  onAhead: (ahead: DeskAhead[]) => void
): Promise<OpOutcome> {
  return new Promise<OpOutcome>((resolve) => {
    let done = false;
    let started = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (o: OpOutcome) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };
    const s = deskStream(mode.port, mode.token, "/desk/op", body, (raw) => {
      const l = raw as OpLine;
      if (l.t === "start") {
        started = true;
        // The desk applies this session's own timeout to the panel and reports
        // it; this is only the backstop for a desk that stops answering
        // without dying. Started here, at `start` — never at enqueue.
        timer = setTimeout(() => {
          s.abort();
          finish({ kind: "timeout" });
        }, body.timeoutMs + FOLLOWER_TIMEOUT_SLACK_MS);
        timer.unref?.();
        onAhead(l.ahead);
      } else if (l.t === "ahead") onAhead(l.ahead);
      else if (l.t === "ok") finish({ kind: "ok", result: l.result, panelPort: l.panelPort });
      else if (l.t === "err") finish({ kind: "err", error: fromWire(l.error), panelPort: l.panelPort });
      else if (l.t === "lost") finish({ kind: "lost" });
    });
    s.closed.then(() => finish(started ? { kind: "after-start" } : { kind: "before-start" }));
  });
}

type Hello = { kind: "desk"; protocol: number; pid: number } | { kind: "starting" } | { kind: "foreign" } | { kind: "refused" } | { kind: "timeout" };

/** Ask whoever holds the desk port what it is. Never throws. */
function deskHello(port: number, token: string | null): Promise<Hello> {
  return new Promise<Hello>((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/desk/hello",
        agent: false,
        headers: token ? { [DESK_TOKEN_HEADER]: token } : {},
        timeout: HELLO_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { if (text.length < 4096) text += c; });
        res.on("end", () => {
          let b: { desk?: string; protocol?: number; pid?: number } | null = null;
          try { b = JSON.parse(text); } catch {}
          if (!b || b.desk !== DESK_ID) return resolve({ kind: "foreign" });
          if (res.statusCode === 200) return resolve({ kind: "desk", protocol: Number(b.protocol), pid: Number(b.pid) });
          // A desk refusing this token: its file is being written, or is a dead desk's.
          resolve({ kind: "starting" });
        });
        res.on("error", () => resolve({ kind: "timeout" }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ kind: "timeout" });
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED" ? { kind: "refused" } : { kind: "timeout" }));
  });
}
