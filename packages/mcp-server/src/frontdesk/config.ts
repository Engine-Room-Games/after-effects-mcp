import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, pinnedPort } from "../bridge/discovery.js";
import { logger } from "../util/logger.js";

/**
 * Where the front desk listens, and the file that says who runs it (issue #223).
 *
 * The desk is a loopback port, not a socket file, because the bind is the
 * election: two servers cannot both bind it, on macOS or on Windows, and the
 * operating system releases it the moment the process holding it dies. A lock
 * *file* is what goes stale; a port cannot. The file written beside it carries
 * only what a follower needs to talk to the leader — its token — and a stale
 * one is harmless, because nobody believes it without the port answering.
 */

/** The wire protocol. A desk speaking another one is not joined; see line.ts. */
export const DESK_PROTOCOL = 1;

/** What a desk says it is, so a foreign listener on the port is never mistaken for one. */
export const DESK_ID = "ae-mcp-front-desk";

/** The header every desk request carries. Distinct from the panel's, so neither token opens the other. */
export const DESK_TOKEN_HEADER = "x-ae-mcp-desk-token";

/** The offset from the panel port. 7777 → 17777: memorable, and well clear of the panel's walk to 7799. */
const DESK_PORT_OFFSET = 10_000;

export interface FrontDeskOptions {
  /** The loopback port the desk binds. */
  port: number;
  /**
   * How long a desk that took over from a dead one grants nothing but resumed
   * leases — long enough for a session whose batch is still running to re-take
   * the lock before anyone slips between two of its chunks.
   */
  graceMs?: number;
  /** How long a server keeps trying to join or become the desk before falling back to direct. */
  electionDeadlineMs?: number;
}

/**
 * The desk configuration for this process, or null when there is none.
 *
 * `AE_MCP_FRONT_DESK=off` switches it off (today's per-process behaviour).
 * `AE_MCP_FRONT_DESK_PORT` names the port outright. Otherwise the port follows
 * the panel the server talks to: unpinned servers all find the same panel, so
 * they share 17777; a server pinned to a second After Effects with
 * `AE_MCP_PORT=P` uses `P + 10000`, so two After Effects instances never share
 * a desk. A pin too high to offset has no desk and says so.
 */
export function frontDeskFromEnv(): FrontDeskOptions | null {
  const raw = process.env.AE_MCP_FRONT_DESK?.trim().toLowerCase();
  if (raw && ["0", "off", "false", "no"].includes(raw)) return null;
  const explicit = process.env.AE_MCP_FRONT_DESK_PORT?.trim();
  if (explicit) {
    const n = Number.parseInt(explicit, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return { port: n };
    logger.warn(`Ignoring AE_MCP_FRONT_DESK_PORT=${explicit} — expected a port number.`);
  }
  const port = (pinnedPort() ?? DEFAULT_PORT) + DESK_PORT_OFFSET;
  if (port > 65535) {
    logger.warn(
      `No front desk: AE_MCP_PORT=${pinnedPort()} leaves no port ${DESK_PORT_OFFSET} above it. ` +
        "Set AE_MCP_FRONT_DESK_PORT to share one between sessions on that After Effects."
    );
    return null;
  }
  return { port };
}

export interface DeskFile {
  desk: typeof DESK_ID;
  protocol: number;
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  /**
   * True while a lease that spans several panel calls — a `run_batch`'s job, a
   * `render_queue`'s prepare-and-save — holds the lock. A desk that takes over
   * from this file grants a grace period only then: there is someone to wait
   * for. A leftover file from a desk that held nothing costs nobody anything.
   */
  batchHeld?: boolean;
}

/** A follower verifies the desk knows the token before routing anything through it. */
export const DESK_NONCE_HEADER = "x-ae-mcp-desk-nonce";

/**
 * How often the desk writes a heartbeat on every open stream. A follower that
 * hears nothing for five of these takes the desk for stalled — suspended,
 * stopped in a debugger — since a stalled process keeps the port bound and no
 * one could otherwise take over. `AE_MCP_FRONT_DESK_BEAT_MS` is for tests.
 */
export function deskBeatMs(): number {
  const raw = Number.parseInt(process.env.AE_MCP_FRONT_DESK_BEAT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 50 ? raw : 2000;
}

/** Five missed beats. */
export const STALL_BEATS = 5;

/**
 * Milliseconds on a monotonic clock shared by every process on the machine —
 * `uv_hrtime`: mach_absolute_time on macOS, QueryPerformanceCounter on
 * Windows, both system-wide (checked across processes in
 * tests/unit/front-desk.mjs). Deadlines cross from one server to another, and
 * a wall-clock step (NTP, a manual change) must not stretch or shrink them.
 */
export function monoMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** The largest request body the desk reads. `AE_MCP_FRONT_DESK_MAX_BODY_BYTES` is for tests. */
export function deskMaxBodyBytes(): number {
  const raw = Number.parseInt(process.env.AE_MCP_FRONT_DESK_MAX_BODY_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 256 * 1024 * 1024;
}

/**
 * Extra time for a request body to cross loopback, at a deliberately slow
 * 25 MB/s. The desk starts beating only once it has read the body, so both the
 * requester's stall threshold and the call's deadline grow by this much.
 */
export function bodyAllowanceMs(bytes: number): number {
  // Test hook: a large allowance without a large body.
  const forced = Number.parseInt(process.env.AE_MCP_FRONT_DESK_BODY_ALLOWANCE_MS ?? "", 10);
  if (Number.isFinite(forced) && forced >= 0) return forced;
  return Math.ceil(bytes / 25_000);
}

export function deskFilePath(port: number): string {
  return path.join(os.homedir(), ".engineroom-ae-mcp", `desk-${port}.json`);
}

/** The file, or null when it is absent or unreadable. Read fresh every time: a new leader rewrites it. */
export function readDeskFile(port: number): DeskFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(deskFilePath(port), "utf8")) as DeskFile;
    if (parsed && parsed.desk === DESK_ID && typeof parsed.token === "string") return parsed;
  } catch {}
  return null;
}

/**
 * Written only by a server that has already bound the port, so it can never
 * name a leader that is not one. Atomic (write then rename) so a follower never
 * reads half a token, and 0600 like the panel's token files (issue #106): the
 * token is what keeps a web page, or another user, off the desk.
 */
export function writeDeskFile(info: DeskFile): void {
  const file = deskFilePath(info.port);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  // On Windows a rename over a file another process has open for a moment (a
  // follower reading it) fails with EPERM/EBUSY; it clears in milliseconds.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Remove the file only if it is still this desk's — a successor may already have rewritten it. */
export function removeDeskFile(port: number, token: string): void {
  try {
    if (readDeskFile(port)?.token === token) fs.unlinkSync(deskFilePath(port));
  } catch {}
}
