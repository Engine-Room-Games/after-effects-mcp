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
 *   lines. A lock that cannot be had within LOCK_WAIT_MS is broken if it is
 *   older than LOCK_STALE_MS (a writer that died holding it), and otherwise
 *   the append goes ahead unlocked and the compaction is skipped. The one
 *   way to lose a line is that unlocked append landing inside another
 *   process's compaction after half a second of contention, which a compaction
 *   of a few hundred short lines does not take.
 * - **Semantics.** A check replays the file through `createFrameCache` — the
 *   panel's own window logic — line by line at each line's own time, so the
 *   answers are the in-memory cache's exactly. Torn or foreign lines are
 *   skipped; an unreadable or unwritable file falls back to this process's own
 *   window, never to a failed screenshot.
 * - **Private.** 0600 inside a 0700 directory, like the token and desk files.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFrameCache, type FrameCache, type FrameCacheMatch, type FrameCacheMeta } from "./frameCache.js";

/** frameCache.ts's defaults; compaction must keep the same window the replay sees. */
const DEFAULT_LIMIT = 24;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Lines kept before a compaction. */
const DEFAULT_COMPACT_AT = 200;
const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 5000;

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
}

function readLines(file: string, instance: string): Line[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding `<file>.lock`. Returns false, without running it, when the lock cannot be had. */
function withLock(file: string, fn: () => void): boolean {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() > deadline) return false;
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
      try {
        fs.unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
    return true;
  }
}

export function createSharedFrameCache(where: () => SharedWindow | null, opts: SharedFrameCacheOptions = {}) {
  const now = opts.now ?? Date.now;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const compactAt = opts.compactAt ?? DEFAULT_COMPACT_AT;
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
  function compact(w: SharedWindow): void {
    const kept = live(readLines(w.file, w.instance));
    const tmp = `${w.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, kept.map((l) => JSON.stringify(l) + "\n").join(""), { mode: 0o600 });
      fs.renameSync(tmp, w.file);
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
      const line: Line = { key, hash, at: now(), label: meta?.label || key, bytes: meta?.bytes || 0, inst: w.instance };
      const text = JSON.stringify(line) + "\n";
      let appended = false;
      const append = () => {
        fs.appendFileSync(w.file, text, { mode: 0o600 });
        appended = true;
      };
      try {
        fs.mkdirSync(path.dirname(w.file), { recursive: true, mode: 0o700 });
        const locked = withLock(w.file, () => {
          append();
          if (lineCount(w.file) > compactAt) compact(w);
        });
        if (!locked) append();
      } catch {
        /* fall through */
      }
      if (!appended) local.remember(key, hash, meta);
    },
  };
}

export type SharedFrameCache = ReturnType<typeof createSharedFrameCache>;
