/**
 * The stale-frame window, shared by every server process on one After Effects
 * (issue #220, stage 4 review).
 *
 * The bug the window catches (#29) is After Effects' own: it can hand any
 * caller a buffer it rendered for another one. With the front desk (#227)
 * several sessions on one AE is the ordinary case, so a window per server
 * process would miss exactly the re-serve that crosses sessions. The window is
 * therefore a file per panel port, `~/.engineroom-ae-mcp/frames-<port>.jsonl`,
 * which works whether the desk is on or off.
 *
 * - **One running After Effects, not one port.** AE can only re-serve a buffer
 *   from the process that rendered it, and the file outlives AE. Every line is
 *   tagged with the panel instance — a hash of the per-session bridge token the
 *   panel writes each time it binds (never the token itself) — and lines from
 *   any other instance are ignored, so a restart starts an empty window rather
 *   than refusing a fresh render for matching a dead one.
 * - **Lossless.** Every write (an append, or a compaction) is made under a
 *   short lock file, so a compaction can never drop a line another process
 *   appended while it ran. A check reads without the lock: appends are single
 *   small writes and a compaction lands by rename, so a reader sees whole
 *   lines. A lock older than LOCK_STALE_MS is a writer that died holding it,
 *   and is broken. Nothing is ever written to the file without the lock.
 *   On Windows a lock its holder has just deleted can still be on disk, and
 *   taking it then fails EPERM rather than EEXIST: that is contention, waited
 *   out like a held lock, never a reason to skip the record (TRANSIENT). A
 *   compaction that cannot read the file skips itself rather than rewrite it
 *   from nothing.
 * - **Semantics.** A check replays the file through `createFrameCache` — the
 *   panel's own window logic — line by line at each line's own time, so the
 *   answers are the in-memory cache's exactly. Torn or foreign lines are
 *   skipped; an unreadable or unwritable file falls back to this process's own
 *   window, never to a failed screenshot.
 * - **Private.** The file is 0600, set on every append (an append's `mode`
 *   does nothing to an existing file), and its directory is tightened to 0700
 *   (see privateDir). Not on Windows, where POSIX modes do not apply and the
 *   profile directory's ACL is what protects it.
 * - **Never a hang.** A record has one deadline, LOCK_WAIT_MS, covering the
 *   lock and every retry made under it. A record that misses it — the lock
 *   held, stale and unremovable, or the file unwritable — is kept by this
 *   process alone, and so is every record for the next COOL_OFF_MS, without
 *   waiting: a persistent failure costs one wait a minute, not one per
 *   screenshot. Warned once on stderr.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../util/logger.js";
import { createFrameCache, type FrameCache, type FrameCacheMatch, type FrameCacheMeta } from "./frameCache.js";

/** frameCache.ts's defaults; compaction must keep the same window the replay sees. */
const DEFAULT_LIMIT = 24;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Lines kept before a compaction. */
const DEFAULT_COMPACT_AT = 200;
const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 5000;
/** After a record could not be written, how long later ones skip the file without waiting. */
const COOL_OFF_MS = 60_000;

export function sharedFrameCacheFile(port: number): string {
  return path.join(os.homedir(), ".engineroom-ae-mcp", `frames-${port}.jsonl`);
}

/** The panel instance a token names, without writing the token anywhere. */
export function panelInstanceId(token: string | null): string | null {
  return token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 16) : null;
}

/** Where the window lives and which running panel it is about. */
export interface SharedWindow {
  file: string;
  instance: string;
}

interface Line {
  key: string;
  hash: string;
  at: number;
  label: string;
  bytes: number;
  inst: string;
}

export interface SharedFrameCacheOptions {
  now?: () => number;
  limit?: number;
  ttlMs?: number;
  compactAt?: number;
  /**
   * How long a record waits for the lock before this process keeps it alone.
   * Defaults to LOCK_WAIT_MS. Tests that hammer the file raise it, so that a
   * loaded CI machine's ordinary lock wait is not mistaken for a lost line.
   */
  lockWaitMs?: number;
  /** How long records skip the shared file after one could not be written. Defaults to COOL_OFF_MS. */
  coolOffMs?: number;
  /** Where the one "could not write the shared window" warning goes. Defaults to stderr. */
  warn?: (message: string) => void;
}

function readLines(file: string, instance: string): Line[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseLines(text, instance);
}

function parseLines(text: string, instance: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      const l = JSON.parse(raw) as Line;
      if (typeof l.key === "string" && typeof l.hash === "string" && typeof l.at === "number" && l.inst === instance) {
        out.push(l);
      }
    } catch {
      /* a torn or foreign line: skip it */
    }
  }
  return out;
}

/**
 * Create the state directory 0700, and tighten it to 0700 if it exists: the
 * panel creates `~/.engineroom-ae-mcp` with no mode (so 0755 under a usual
 * umask), and mkdir's mode does nothing to a directory that is already there.
 * Safe for everything else in it — the port, token and desk files are read
 * and written only by this same user (the panel runs as the user, inside AE).
 * Best effort: a directory this user does not own stays as it is.
 */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    if ((fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours to change */
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The codes Windows gives for a file another process is in the middle of
 * using. A lock file its holder has just unlinked can stay on disk, "delete
 * pending", until every handle on it closes — another server's `stat` of it
 * is one — and creating it again in that window fails EPERM, not EEXIST. A
 * rename or an open that meets a handle opened without delete sharing (a virus
 * scanner, the indexer) fails EPERM, EBUSY or EACCES. All of them clear in
 * milliseconds.
 */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | null)?.code ?? "";
}

/**
 * Run `fn`, retrying a transient sharing failure (TRANSIENT) until `deadline`
 * — the one deadline of the whole record, so retries inside the lock can
 * never stretch a record past it. Always makes at least one attempt.
 */
function retrying<T>(deadline: number, fn: () => T): T {
  for (;;) {
    try {
      return fn();
    } catch (e) {
      const left = deadline - Date.now();
      if (left <= 0 || !TRANSIENT.has(errCode(e))) throw e;
      sleepSync(Math.min(5, left));
    }
  }
}

/**
 * Run `fn` holding `<file>.lock`. Returns null once `fn` has run, or — without
 * running it — why the lock could not be had by `deadline`. `fn` is handed the
 * same deadline for its own retries, and the release honours it too, so a
 * record costs at most `deadline` in all. Every failed
 * attempt — a held lock, one its holder is still deleting (Windows: EPERM, see
 * TRANSIENT), a stale one that will not unlink (EACCES, a Windows sharing
 * violation, a lock path that is a directory), a stat that fails — goes
 * through the same deadline and sleep, so no path can spin: a stuck lock costs
 * half a second, never a hung server. An error that cannot be contention
 * (ENOENT, ENOTDIR, …) gives up at once. EPERM and EACCES are waited out on
 * every platform, so a directory this user cannot write costs that half
 * second once — the caller then skips the shared file for COOL_OFF_MS rather
 * than pay it on every screenshot.
 */
function withLock(file: string, deadline: number, fn: () => void): string | null {
  const lock = `${file}.lock`;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      const code = errCode(e) || (e as Error).message;
      if (code !== "EEXIST" && !TRANSIENT.has(code)) return code;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {
        /* released meanwhile, or not removable: the deadline below decides */
      }
      if (Date.now() > deadline) return code === "EEXIST" ? "held" : code;
      sleepSync(5);
      continue;
    }
    try {
      fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
      // A lock left behind costs every server LOCK_STALE_MS of skipped
      // records, so a release that meets a transient sharing failure retries
      // while the deadline allows.
      try {
        retrying(deadline, () => fs.unlinkSync(lock));
      } catch {
        /* already gone */
      }
    }
    return null;
  }
}

export function createSharedFrameCache(where: () => SharedWindow | null, opts: SharedFrameCacheOptions = {}) {
  const now = opts.now ?? Date.now;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const compactAt = opts.compactAt ?? DEFAULT_COMPACT_AT;
  const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const coolOffMs = opts.coolOffMs ?? COOL_OFF_MS;
  const warn = opts.warn ?? ((m: string) => logger.warn(m));
  let warned = false;
  /** Wall-clock time before which a record skips the shared file. */
  let coolUntil = 0;
  // What could not be written to the file (or every frame, when no window is known).
  const local = createFrameCache({ now, limit, ttlMs });

  /** Replay the log into the window logic, each remember at its own time. */
  function replay(lines: Line[]): FrameCache {
    let clock = 0;
    const cache = createFrameCache({ now: () => clock, limit, ttlMs });
    for (const l of lines) {
      clock = l.at;
      cache.remember(l.key, l.hash, { label: l.label, bytes: l.bytes });
    }
    clock = now();
    return cache;
  }

  /**
   * The lines the replayed window still holds: the newest per key, in the
   * order of that newest remember, inside the TTL, the last `limit` of them.
   */
  function live(lines: Line[]): Line[] {
    const newest = new Map<string, Line>();
    for (const l of lines) {
      newest.delete(l.key);
      newest.set(l.key, l);
    }
    const cutoff = now() - ttlMs;
    return [...newest.values()].filter((l) => l.at > cutoff).slice(-limit);
  }

  /** Under the lock: rewrite the file to its live window. Other instances' lines go. */
  function compact(w: SharedWindow, deadline: number): void {
    // A file that cannot be read right now is not an empty one: compacting it
    // from nothing would replace every line with none. Leave it for the next.
    let text: string;
    try {
      text = retrying(deadline, () => fs.readFileSync(w.file, "utf8"));
    } catch {
      return;
    }
    const kept = live(parseLines(text, w.instance));
    const tmp = `${w.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, kept.map((l) => JSON.stringify(l) + "\n").join(""), { mode: 0o600 });
      // A reader holding the file for a moment makes the rename EPERM on Windows.
      retrying(deadline, () => fs.renameSync(tmp, w.file));
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing written */
      }
    }
  }

  function lineCount(file: string): number {
    try {
      const text = fs.readFileSync(file, "utf8");
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      return n;
    } catch {
      return 0;
    }
  }

  return {
    match(key: string, hash: string): FrameCacheMatch | null {
      const w = where();
      if (!w) return local.match(key, hash);
      return replay(readLines(w.file, w.instance)).match(key, hash) ?? local.match(key, hash);
    },
    remember(key: string, hash: string, meta?: FrameCacheMeta | null): void {
      const w = where();
      if (!w) return local.remember(key, hash, meta);
      // Cooling off after a failed record: this process keeps it, and the
      // screenshot does not block on a lock that just cost a full wait.
      if (Date.now() < coolUntil) return local.remember(key, hash, meta);
      const line: Line = { key, hash, at: now(), label: meta?.label || key, bytes: meta?.bytes || 0, inst: w.instance };
      const text = JSON.stringify(line) + "\n";
      const deadline = Date.now() + lockWaitMs;
      let appended = false;
      const append = () => {
        // `mode` applies only when the append creates the file; a file left
        // 0644 by an earlier writer is tightened on every append.
        const fd = retrying(deadline, () => fs.openSync(w.file, "a", 0o600));
        try {
          if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
          fs.writeSync(fd, text);
        } finally {
          fs.closeSync(fd);
        }
        appended = true;
      };
      let refused: string | null = null;
      let failure: string | null = null;
      try {
        privateDir(path.dirname(w.file));
        refused = withLock(w.file, deadline, () => {
          append();
          if (lineCount(w.file) > compactAt) compact(w, deadline);
        });
      } catch (e) {
        failure = (e as Error).message;
      }
      // Not written to the shared file: this process still keeps it, skips
      // the file for coolOffMs, and says why once rather than on every
      // screenshot.
      if (!appended) {
        local.remember(key, hash, meta);
        coolUntil = Date.now() + coolOffMs;
        if (!warned) {
          warned = true;
          warn(
            `the shared stale-frame window ${w.file} could not be written` +
              (failure !== null
                ? ` (${failure})`
                : refused === null
                  ? ""
                  : ` (its lock ${w.file}.lock could not be taken within ${lockWaitMs}ms: ${refused})`) +
              `; this server keeps its own window and tries again in ${Math.round(coolOffMs / 1000)}s. Screenshots are unaffected.`
          );
        }
      }
    },
  };
}

export type SharedFrameCache = ReturnType<typeof createSharedFrameCache>;
