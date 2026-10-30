import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { HttpClient } from "../bridge/httpClient.js";
import { opTimeoutMs } from "../bridge/httpClient.js";
import type { QueueWait, WriteLease, WriteQueue } from "../bridge/writeQueue.js";
import { BridgeBusyError, BridgeTimeoutError, DeskPlaceLostError, FrontDeskLostError, WriteQueueCancelledError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { DESK_ID, DESK_NONCE_HEADER, DESK_PROTOCOL, FEATURE_YIELD_READS, DESK_TOKEN_HEADER, STALL_BEATS, bodyAllowanceMs, monoMs, readDeskFile, sweepStaleDeskFiles, type FrontDeskOptions } from "./config.js";
import { DeadlinePassedError, FrontDesk, LeaseNotHeldError, deskProof, type DeskForwarder } from "./desk.js";
import { DeskClosedError } from "./lock.js";
import { describeAhead, describeLockWait, fromWire, type DeskAhead, type GrantWait, type LockLine, type OpLine } from "./protocol.js";
import { displayOp } from "../util/opNames.js";

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
 * And the one new job: surviving the desk's death or stall. See `send`.
 */

/** Grace a desk that replaced one holding a long lease gives that lease to come back. */
const GRACE_MS = 1500;
/** How long a server tries to join or become the desk before going direct. */
const ELECTION_DEADLINE_MS = 5000;
/** How long a session that found the desk stalled goes direct before asking again. */
const STALLED_RETRY_MS = 10_000;
/** How many times one call follows the desk to a new server. */
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
  | { kind: "leader"; desk: FrontDesk; port: number }
  | { kind: "follower"; port: number; token: string; pid: number; idleMs: number; features: readonly string[] }
  | { kind: "direct"; retryAt: number };

type Follower = Extract<Mode, { kind: "follower" }>;

type Slot =
  | { kind: "local"; id: string; desk: FrontDesk }
  | { kind: "remote"; id: string; abort: () => void; closed: Promise<unknown> };

type OnWait = (message: string) => void;

export class SessionLine {
  readonly sessionId = randomUUID();
  private mode: Mode;
  private electing: Promise<Mode> | null = null;
  /** Has followed or run a desk before — only so the log can say "taking over". */
  private everJoined = false;
  /** Stale desk files are swept once per process, at the first election. */
  private swept = false;
  /** The desk lease this session holds now. At most one: the session's own queue is in front of it. */
  private holding: HeldDesk | null = null;
  private closed = false;
  private warnedNoYield = false;
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

  /** Settles once the first election has (for tests). */
  async ready(): Promise<string> {
    return (await this.ensure()).kind;
  }

  // ------------------------------------------------------------ write lock

  async acquire(op: string, signal?: AbortSignal, onWait?: OnWait): Promise<WriteLease> {
    return this.withDesk(op, await this.reserve(op, signal), signal, onWait);
  }

  /**
   * Take this session's own place in line and nothing more: later writes from
   * this session queue behind it, and no other session is held. For a write
   * that waits on a person before it runs (a confirmation, issue #245) — its
   * place in this session's order is kept while it waits, without stalling
   * every other session on the same After Effects behind a dialog. Hand the
   * result to `withDesk` once the write is ready to go.
   */
  reserve(op: string, signal?: AbortSignal): Promise<WriteLease> {
    return this.local.acquire(op, signal);
  }

  /** The second half of `acquire`: the front desk's lock, on top of a reserved place. Releases it on failure. */
  async withDesk(op: string, localLease: WriteLease, signal?: AbortSignal, onWait?: OnWait): Promise<WriteLease> {
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
      onLost(listener) {
        held.onLost(listener);
      },
    };
  }

  /**
   * @internal Take the desk lock: from this process's own desk or another's.
   * Null only when there is no desk to take it from (direct); a desk that
   * cannot grant it — stalled, or changing hands too often — is an explicit
   * failure, never a write sent without it.
   */
  async takeSlot(
    op: string,
    signal: AbortSignal | undefined,
    onWait: OnWait | undefined,
    resume: boolean,
    heldForMs?: number
  ): Promise<{ slot: Slot; wait: GrantWait | null } | null> {
    // The wait is this call's, not one desk's: a handover in the middle of it
    // must not shorten it, or lose who it was behind, in the result.
    const startedAt = monoMs();
    let behind: { op: string; session: string } | null = null;
    let handedOver = false;
    const watch = (l: Extract<LockLine, { t: "wait" }>) => {
      if (!behind && l.holder) behind = { op: l.holder.op, session: l.holder.session };
      surfaceLock(op, l, onWait);
    };
    const whole = (w: GrantWait | null): GrantWait | null => {
      const first = handedOver && behind ? behind : w ? { op: w.queuedBehind, session: w.queuedBehindSession } : behind;
      if (!first || (!w && !handedOver)) return w;
      return { queuedBehind: first.op, queuedBehindSession: first.session, waitedMs: Math.max(w?.waitedMs ?? 0, monoMs() - startedAt) };
    };
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
        // A resumed lease keeps the age it had: "held for 40s", not "for 0s".
        heldForMs,
      };
      if (mode.kind === "leader") {
        try {
          const g = await mode.desk.lock.acquire({ ...req, onUpdate: watch }, signal);
          return { slot: { kind: "local", id: g.id, desk: mode.desk }, wait: whole(g.wait) };
        } catch (e) {
          // Only this server's own shutdown closes its desk.
          if (e instanceof DeskClosedError) return null;
          throw e;
        }
      }
      if (mode.kind !== "follower") return null;
      const r = await remoteLock(mode, req, op, signal, watch);
      if (r.kind === "granted") return { slot: r.slot, wait: whole(r.wait) };
      if (r.kind === "error") throw r.error;
      if (r.kind === "stalled") {
        this.deskStalled(mode);
        throw new DeskPlaceLostError(op, stalledWhy(mode, "before this call's turn came"));
      }
      this.deskLost(mode);
      handedOver = true;
    }
    throw new DeskPlaceLostError(op, `the front desk changed hands ${MAX_HANDOVERS} times while this call waited for its turn.`);
  }

  // ------------------------------------------------------------ forwarding

  /**
   * `yieldToWrites` marks a background read (the live-resource poll, issue
   * #248): refused unsent, as `BridgeBusyError`, while this session holds or
   * waits on its write lease, and — through the desk — while any session holds
   * the shared write lock. Never set on a read an agent asked for.
   */
  runOp(op: string, args: unknown, o: { write?: boolean; onWait?: OnWait; yieldToWrites?: boolean } = {}): Promise<unknown> {
    const yieldToWrites = o.yieldToWrites === true && o.write !== true;
    if (yieldToWrites && (this.local.held !== null || this.local.depth > 0)) {
      return Promise.reject(new BridgeBusyError(op, this.local.held ?? undefined));
    }
    if (this.mode.kind === "off") return this.bridge.runOp(op, args);
    return this.send(
      { kind: "op", op, args, timeoutMs: opTimeoutMs(op), ...(yieldToWrites ? { yieldToWrites: true } : {}) },
      o.write === true,
      o.onWait,
      () => this.bridge.runOp(op, args)
    );
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
   * A write is re-sent only when the desk *positively* did not forward it: the
   * connection was refused, the desk answered with a refusal status, or it said
   * `lost` (the lease this write claimed does not hold the lock — re-taken
   * first, with priority). Any other way of losing a write — the connection
   * dropped, the desk stalled — is "may have run": `FrontDeskLostError`, a
   * reset, read back before re-sending. No line the desk wrote is trusted to
   * have arrived: the desk can post to the panel and die before its bytes
   * reach this side. Reads are always re-sent; running one twice changes nothing.
   *
   * A write under a lease this session has lost and could not take back is
   * refused before it goes anywhere (`DeskPlaceLostError`, nothing ran).
   */
  private async send(
    body: { kind: "op" | "cancel"; op: string; args?: unknown; jobId?: string; timeoutMs: number; yieldToWrites?: boolean },
    write: boolean,
    onWait: OnWait | undefined,
    direct: () => Promise<unknown>
  ): Promise<unknown> {
    const { op } = body;
    /** Why the last attempt went round again — what the final refusal says. */
    let again: "handover" | "expired" = "handover";
    for (let attempt = 0; attempt < MAX_HANDOVERS; attempt++) {
      let slot: Slot | null = null;
      if (write) {
        // No desk lease at all: it was taken with no desk to take it from, so
        // this write goes the way the lease did.
        if (!this.holding) return direct();
        slot = await this.holding.current();
        if (!slot) {
          throw new DeskPlaceLostError(op, "this session lost its turn in the shared write queue when the front desk changed hands, and could not take it back.");
        }
      }
      const mode = await this.ensure();
      if (mode.kind !== "leader" && mode.kind !== "follower") {
        // Holding a lease on a desk that is going away: wait until that is
        // noticed and the lease is re-taken (or given up), then decide again.
        if (slot?.kind === "remote") {
          await slot.closed;
          continue;
        }
        // A desk is configured but this session is not on one (not elected
        // yet, or gone direct): other sessions' writes are invisible from
        // here, so a background read could land inside one of their batches.
        // Not sent; the poll skips the tick, without a word.
        if (body.yieldToWrites) throw new BridgeBusyError(op, undefined, "this session is not on the shared front desk, so other sessions' writes cannot be seen");
        return direct();
      }
      if (mode.kind === "leader") {
        if (slot?.kind === "remote") {
          await slot.closed;
          continue;
        }
        try {
          return await mode.desk.forward(
            {
              sessionId: this.sessionId,
              session: this.opts.sessionLabel(),
              ...body,
              write,
              leaseId: slot?.id,
              // The same rule as a follower's: if this process stalls between
              // here and the panel, followers have given up on the desk and gone
              // direct, and what was queued here must not go out on waking.
              deadline: monoMs() + forwardWindowMs(mode.desk.beatMs * STALL_BEATS),
            },
            { onStart: (ahead) => surfaceAhead(op, ahead, onWait), onAhead: (ahead) => surfaceAhead(op, ahead, onWait) }
          );
        } catch (e) {
          if (e instanceof LeaseNotHeldError && slot) {
            this.holding?.invalidate(slot.id);
            continue;
          }
          // Never forwarded: safe to go again, with a fresh deadline.
          if (e instanceof DeadlinePassedError) {
            again = "expired";
            continue;
          }
          throw e;
        }
      }
      if (body.yieldToWrites && !mode.features.includes(FEATURE_YIELD_READS)) {
        // The desk is an older server's: it would forward this background read
        // into the middle of another session's batch. Not sent; the poll skips
        // the tick. Every other call still goes through this desk, so the
        // sessions stay serialized against each other.
        if (!this.warnedNoYield) {
          this.warnedNoYield = true;
          logger.info(
            "Front desk: the desk is run by an older server that cannot hold background reads back for other sessions' " +
              "writes, so live-resource change notifications are paused while this session shares it."
          );
        }
        throw new BridgeBusyError(op, undefined, "the shared front desk is run by an older server, which cannot hold a background read back for other sessions' writes");
      }
      if (slot?.kind === "local") {
        // A lease from a desk this server ran and no longer does; it is gone.
        this.holding?.invalidate(slot.id);
        continue;
      }
      const leaseId = slot?.id;
      again = "handover";
      const r = await remoteOp(
        mode,
        {
          ...body,
          write,
          leaseId,
          sessionId: this.sessionId,
          session: this.opts.sessionLabel(),
        },
        (ahead) => surfaceAhead(op, ahead, onWait)
      );
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
        case "refused":
          this.deskLost(mode);
          continue;
        case "expired":
          // The desk was slow to reach it and said so; it was never forwarded.
          again = "expired";
          continue;
        case "rejected":
          throw new Error(
            r.status === 413
              ? `\`${displayOp(op)}\` was not sent: its request is larger than the front desk accepts. Nothing reached ` +
                  "After Effects. Split the work into smaller calls — several smaller run_batch calls rather than one."
              : `\`${displayOp(op)}\` was not sent: the front desk refused it with HTTP ${r.status}, which this server does not ` +
                  "expect — probably a different version of the server is running the desk. Nothing reached After Effects; " +
                  "re-sending is safe, and restarting the other AI session's MCP server would end the mismatch."
          );
        case "dropped":
          this.deskLost(mode);
          if (write) throw new FrontDeskLostError(mode.port, op, "exited");
          continue;
        case "stalled":
          this.deskStalled(mode);
          if (write) throw new FrontDeskLostError(mode.port, op, "stalled");
          continue;
        case "timeout":
          throw new BridgeTimeoutError(this.bridge.port, body.timeoutMs, { op });
      }
    }
    if (write) {
      throw new DeskPlaceLostError(
        op,
        again === "expired"
          ? `the front desk did not get to it within its forwarding window, ${MAX_HANDOVERS} times running — the server running the desk is overloaded or keeps stalling.`
          : `the front desk changed hands ${MAX_HANDOVERS} times before this call could be sent.`
      );
    }
    // Out of handovers: a read an agent asked for goes direct, as ever; a
    // background read does not, for the reason above.
    if (body.yieldToWrites) throw new BridgeBusyError(op, undefined, "the front desk kept changing hands, so other sessions' writes cannot be seen");
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

  /**
   * A desk that keeps its port bound and answers nothing cannot be replaced —
   * nobody can bind the port it holds — so this session goes to After Effects
   * directly for a while, as before the desk existed, and then asks again.
   */
  private deskStalled(mode: Follower): void {
    if (this.mode !== mode) return;
    logger.warn(
      `Front desk: the desk on 127.0.0.1:${mode.port} (pid ${mode.pid}) has answered nothing for ${Math.round(mode.idleMs / 1000)}s. ` +
        `Talking to After Effects directly for ${STALLED_RETRY_MS / 1000}s; other sessions are not serialized against this one meanwhile.`
    );
    this.mode = { kind: "direct", retryAt: Date.now() + STALLED_RETRY_MS };
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
   * else holds the port, which is told apart by asking, and by the desk proving
   * it knows the token. Every way this can fail ends in `direct`, today's
   * behaviour, with a warning, and is tried again later.
   */
  private async elect(): Promise<Mode> {
    const cfg = this.opts.desk!;
    const port = cfg.port;
    const deadline = Date.now() + (cfg.electionDeadlineMs ?? ELECTION_DEADLINE_MS);
    let portStuck = false;
    const direct = (why: string, retryMs: number): Mode => {
      logger.warn(`Front desk: ${why} This session talks to After Effects directly, as before; other sessions are not serialized against it.`);
      return { kind: "direct", retryAt: Date.now() + retryMs };
    };
    for (;;) {
      if (this.closed) return { kind: "direct", retryAt: Infinity };
      // A grace period only when the desk before held a long lease: then a
      // session is coming back for it. A leftover file from a desk that held
      // nothing makes nobody wait.
      if (!this.swept) {
        this.swept = true;
        const n = sweepStaleDeskFiles(port);
        if (n > 0) logger.info(`Front desk: removed ${n} desk file${n > 1 ? "s" : ""} left by servers that are no longer running.`);
      }
      const previous = readDeskFile(port);
      const graceMs = previous?.batchHeld ? (cfg.graceMs ?? GRACE_MS) : 0;
      const token = randomBytes(32).toString("hex");
      const desk = new FrontDesk(this.forwarder, { port, token, graceMs });
      try {
        await desk.listen();
        try {
          desk.publish();
        } catch (e) {
          await desk.close();
          return direct(`bound 127.0.0.1:${port} but could not write its desk file (${(e as Error).message}).`, 60_000);
        }
        const takeover = this.everJoined || previous !== null;
        this.everJoined = true;
        logger.info(
          `Front desk: this server runs the desk for every session on this After Effects (127.0.0.1:${port}` +
            `${takeover ? ", taking over" : ""}${graceMs ? `, ${graceMs}ms grace for a long write in progress` : ""}).`
        );
        return { kind: "leader", desk, port };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") return direct(`could not bind 127.0.0.1:${port} (${(e as Error).message}).`, 60_000);
      }
      const info = readDeskFile(port);
      const hello = await deskHello(port, info?.token ?? null);
      if (hello.kind === "desk" && info) {
        if (hello.protocol !== DESK_PROTOCOL) {
          return direct(`the desk on 127.0.0.1:${port} speaks protocol ${hello.protocol} and this server speaks ${DESK_PROTOCOL} — a different version of the server is running it.`, 60_000);
        }
        this.everJoined = true;
        logger.info(`Front desk: joined the desk on 127.0.0.1:${port}, run by pid ${hello.pid}.`);
        return { kind: "follower", port, token: info.token, pid: hello.pid, idleMs: hello.beatMs * STALL_BEATS, features: hello.features };
      }
      if (hello.kind === "foreign") {
        return direct(`port ${port} is held by something that is not a front desk. Set AE_MCP_FRONT_DESK_PORT to a free port in every session to share one.`, 60_000);
      }
      // A desk whose file is not there yet or is a dead desk's, or one that
      // died between the bind and the hello: go round again.
      if (hello.kind === "refused") portStuck = true;
      if (Date.now() > deadline) {
        // Bind refused, yet nothing listening: on Windows the previous desk's
        // closed connections can hold the port (TIME_WAIT under
        // SO_EXCLUSIVEADDRUSE) for minutes after it exits. Said as such, and
        // tried again soon rather than after the usual wait.
        if (portStuck && hello.kind === "refused") {
          return direct(
            `127.0.0.1:${port} cannot be bound although nothing is listening on it — the previous desk's closed connections ` +
              "are probably still holding it (Windows keeps them for up to 4 minutes). Trying again every 5s.",
            5_000
          );
        }
        return direct(`no desk on 127.0.0.1:${port} answered within ${Math.round((cfg.electionDeadlineMs ?? ELECTION_DEADLINE_MS) / 1000)}s.`, 10_000);
      }
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
      logger.info(`Front desk: closed; the next server to need it takes it over.`);
    }
  }
}

/**
 * How long the desk has to forward a call: half the stall threshold, so the
 * deadline always passes before the requester can give up on the desk.
 */
function forwardWindowMs(stallMs: number): number {
  return Math.max(50, Math.floor(stallMs / 2));
}

function stalledWhy(mode: Follower, when: string): string {
  return `the front desk (run by pid ${mode.pid}) stopped answering ${when} — it has said nothing for ${Math.round(mode.idleMs / 1000)}s.`;
}

/**
 * A desk lease that survives the desk. If the desk it was granted on goes away
 * while the session still holds it — most often while its `run_batch` is still
 * running chunks — it is re-taken at the next desk with priority, and every
 * write under it waits for that before it goes. If it cannot be re-taken, the
 * lease says so to whoever is listening (the batch's job), and every write
 * under it is refused.
 */
class HeldDesk {
  private slot: Slot | null = null;
  private released = false;
  private pending: Promise<void> | null = null;
  private lostFor: string | null = null;
  private listeners: ((why: string) => void)[] = [];
  private readonly grantedAt = monoMs();

  constructor(private line: SessionLine, private op: string, first: Slot) {
    this.attach(first);
  }

  onLost(listener: (why: string) => void): void {
    if (this.lostFor) listener(this.lostFor);
    else this.listeners.push(listener);
  }

  private attach(slot: Slot): void {
    this.slot = slot;
    if (slot.kind === "remote") {
      slot.closed.then((end) => {
        if (this.slot === slot) this.lost((end as { kind?: string } | undefined)?.kind === "stalled" ? "stalled" : "went away");
      });
    }
  }

  /** The desk says `id` is not the lease holding the lock. */
  invalidate(id: string): void {
    if (this.slot?.id === id) {
      if (this.slot.kind === "remote") this.slot.abort();
      this.lost("no longer recognises the lease");
    }
  }

  private lost(how: string): void {
    if (this.released || this.pending || this.lostFor) return;
    this.slot = null;
    logger.warn(`Front desk: the desk holding \`${displayOp(this.op)}\`'s write lock ${how}; re-taking it at the next one.`);
    const giveUp = (reason: string) => {
      this.lostFor =
        `This ${displayOp(this.op)} lost the shared After Effects write lock when the front desk changed hands (${reason}), ` +
        "so another AI session's writes may have landed between its steps. Read the comp back before relying on its order.";
      logger.warn(`Front desk: ${this.lostFor}`);
      for (const l of this.listeners.splice(0)) { try { l(this.lostFor); } catch {} }
    };
    this.pending = this.line
      .takeSlot(this.op, undefined, undefined, true, monoMs() - this.grantedAt)
      .then(
        (r) => {
          if (this.released) {
            if (r) releaseSlot(r.slot);
            return;
          }
          if (!r) return giveUp("no desk answered to take it back from");
          this.attach(r.slot);
        },
        (e) => { if (!this.released) giveUp((e as Error).message.split("\n")[0]); }
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
  // Only ever about another session, or a takeover's grace: a session is never
  // told it waits behind itself.
  if (!l.holder && !l.graceMs) return;
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

type StreamEnd =
  | { kind: "ended" }
  /** Nothing reached the desk: the connection was refused. */
  | { kind: "refused" }
  /** The desk answered with something other than a stream: refused before reading. */
  | { kind: "status"; status: number }
  | { kind: "broken"; error?: Error }
  /** Nothing — not even a heartbeat — for `idleMs`. */
  | { kind: "stalled" }
  | { kind: "aborted" };

/**
 * One NDJSON request to the desk. `closed` settles exactly once, however the
 * exchange ends; `abort` ends it from this side, which for a lock is the release.
 * `node:http` with no agent, so closing it closes the socket and the desk sees it.
 * The desk beats on every stream, so silence for `idleMs` means it is stalled.
 */
function deskStream(
  port: number,
  token: string,
  route: string,
  body: unknown,
  idleMs: number,
  onLine: (l: unknown) => void,
  /**
   * A stall is never declared before this `monoMs()` time: the call's deadline.
   * Declaring one earlier would let a desk that wakes inside its deadline
   * forward a write this side has already reported lost.
   */
  notBefore = 0
): { abort: () => void; closed: Promise<StreamEnd> } {
  let settle!: (e: StreamEnd) => void;
  let settled = false;
  let idle: NodeJS.Timeout | null = null;
  const closed = new Promise<StreamEnd>((r) => {
    settle = (e) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      r(e);
    };
  });
  const payload = Buffer.from(JSON.stringify(body));
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: route,
    method: "POST",
    agent: false,
    headers: { "content-type": "application/json", "content-length": payload.length, [DESK_TOKEN_HEADER]: token },
  });
  let heardCount = 0;
  const heard = (extraMs = 0) => {
    heardCount++;
    if (idle) clearTimeout(idle);
    const at = heardCount;
    // Every path to `stalled` goes through here: after this process was itself
    // blocked (a long synchronous stretch, the machine asleep), timers fire
    // before the beats waiting in the socket are read, so the poll phase reads
    // them first (setImmediate); and a timer — the loop's clock can run a few
    // ms ahead — is never trusted to mean the deadline has passed: it is
    // re-read on the monotonic clock, and re-armed while still early.
    const check = () => {
      setImmediate(() => {
        if (heardCount !== at || settled) return;
        const early = notBefore - monoMs();
        if (early >= 0) {
          idle = setTimeout(check, early + 1);
          return;
        }
        settle({ kind: "stalled" });
        req.destroy();
      });
    };
    idle = setTimeout(check, idleMs + extraMs);
  };
  // Until the desk answers it is still reading the body, and beats only after.
  heard(bodyAllowanceMs(payload.length));
  let responded = false;
  req.on("response", (res) => {
    responded = true;
    heard();
    if (res.statusCode !== 200) {
      res.resume();
      settle({ kind: "status", status: res.statusCode ?? 0 });
      return;
    }
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk: string) => {
      heard();
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
  | { kind: "stalled" }
  | { kind: "gone" };

function remoteLock(
  mode: Follower,
  req: Record<string, unknown>,
  op: string,
  signal: AbortSignal | undefined,
  onWaitLine: (l: Extract<LockLine, { t: "wait" }>) => void
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
    const s = deskStream(mode.port, mode.token, "/desk/lock", req, mode.idleMs, (raw) => {
      const l = raw as LockLine;
      if (l.t === "wait") onWaitLine(l);
      else if (l.t === "granted") finish({ kind: "granted", slot: { kind: "remote", id: l.id, abort: s.abort, closed: s.closed }, wait: l.wait });
      else if (l.t === "err") finish({ kind: "error", error: fromWire(l.error) });
      else if (l.t === "moved") finish({ kind: "gone" });
    });
    const onAbort = () => {
      s.abort();
      finish({ kind: "error", error: new WriteQueueCancelledError(op) });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    s.closed.then((end) => finish(end.kind === "stalled" ? { kind: "stalled" } : { kind: "gone" }));
  });
}

type OpOutcome =
  | { kind: "ok"; result: unknown; panelPort: number }
  | { kind: "err"; error: Error; panelPort: number }
  | { kind: "lost" }
  /** Provably never forwarded. */
  | { kind: "refused" }
  /** The desk refused it as malformed or too large: never forwarded, and re-sending will not help. */
  | { kind: "rejected"; status: number }
  /** The desk reached it after its deadline and did not forward it. */
  | { kind: "expired" }
  /** Lost after the request may have been delivered. */
  | { kind: "dropped" }
  | { kind: "stalled" }
  | { kind: "timeout" };

function remoteOp(mode: Follower, body: { timeoutMs: number } & Record<string, unknown>, onAhead: (ahead: DeskAhead[]) => void): Promise<OpOutcome> {
  return new Promise<OpOutcome>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (o: OpOutcome) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };
    // The deadline sits strictly before this side can call the desk stalled,
    // so a desk that wakes from a stall finds it passed and never forwards what
    // was given up on. Both grow with the body: the desk beats only once it has
    // read it, so a large request must not look like a stall on its way in.
    const allowance = bodyAllowanceMs(Buffer.byteLength(JSON.stringify(body)));
    const sent = { ...body, deadline: monoMs() + forwardWindowMs(mode.idleMs) + allowance };
    const s = deskStream(mode.port, mode.token, "/desk/op", sent, mode.idleMs, (raw) => {
      const l = raw as OpLine;
      if (l.t === "start") {
        // The desk applies this session's own timeout to the panel and reports
        // it; this is only the backstop for a desk that beats but never
        // answers. Started at `start` — never at enqueue.
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
      else if (l.t === "expired") finish({ kind: "expired" });
    }, sent.deadline);
    s.closed.then((end) => {
      if (end.kind === "refused") finish({ kind: "refused" });
      // A token refusal means the desk changed hands: look again. Anything else
      // is a refusal of this request itself, and looking again changes nothing.
      else if (end.kind === "status") finish(end.status === 401 || end.status === 403 ? { kind: "refused" } : { kind: "rejected", status: end.status });
      else if (end.kind === "stalled") finish({ kind: "stalled" });
      else finish({ kind: "dropped" });
    });
  });
}

type Hello =
  | { kind: "desk"; protocol: number; pid: number; beatMs: number; features: string[] }
  | { kind: "starting" }
  | { kind: "foreign" }
  | { kind: "refused" }
  | { kind: "timeout" };

/**
 * Ask whoever holds the desk port what it is. Never throws. A desk must prove it
 * knows the token — an HMAC of a fresh nonce — before anything is routed to it,
 * so a process that merely answers with the desk's id is treated as foreign.
 */
function deskHello(port: number, token: string | null): Promise<Hello> {
  const nonce = randomBytes(16).toString("hex");
  return new Promise<Hello>((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/desk/hello",
        agent: false,
        headers: token ? { [DESK_TOKEN_HEADER]: token, [DESK_NONCE_HEADER]: nonce } : {},
        timeout: HELLO_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { if (text.length < 4096) text += c; });
        res.on("end", () => {
          let b: { desk?: string; protocol?: number; pid?: number; beatMs?: number; proof?: string; features?: unknown } | null = null;
          try { b = JSON.parse(text); } catch {}
          if (!b || b.desk !== DESK_ID) return resolve({ kind: "foreign" });
          // A desk refusing this token: its file is being written, or is a dead desk's.
          if (res.statusCode !== 200 || !token) return resolve({ kind: "starting" });
          if (b.proof !== deskProof(token, nonce)) return resolve({ kind: "foreign" });
          const beatMs = Number(b.beatMs);
          // A desk older than feature negotiation lists none: it is still
          // joined (same protocol), and simply offered nothing beyond it.
          const features = Array.isArray(b.features) ? b.features.filter((f): f is string => typeof f === "string") : [];
          resolve({ kind: "desk", protocol: Number(b.protocol), pid: Number(b.pid), beatMs: Number.isFinite(beatMs) && beatMs > 0 ? beatMs : 2000, features });
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
