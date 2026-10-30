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
 * Lock-free: `remember` appends one JSON line (O_APPEND, one small write, so
 * concurrent writers interleave whole lines). `match` replays the file into
 * `createFrameCache` — the same window logic the panel uses, line by line at
 * each line's own time — so the semantics are the in-memory cache's exactly.
 * When the file passes COMPACT_AT lines it is rewritten to the live window
 * through a temp file and a rename; a line another process appends between
 * that read and the rename is lost, which can only make one later check miss,
 * never invent a match. Unreadable lines are skipped; an unreadable or
 * unwritable file degrades to no history, never to a failed screenshot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFrameCache, type FrameCache, type FrameCacheMatch, type FrameCacheMeta } from "./frameCache.js";

/** Lines kept before a compaction; the live window is 24, so this is generous. */
const COMPACT_AT = 200;
/** frameCache.ts's defaults, which the replay uses; compaction must keep the same window. */
const WINDOW_LIMIT = 24;
const WINDOW_TTL_MS = 10 * 60 * 1000;

export function sharedFrameCacheFile(port: number): string {
  return path.join(os.homedir(), ".engineroom-ae-mcp", `frames-${port}.jsonl`);
}

interface Line {
  key: string;
  hash: string;
  at: number;
  label: string;
  bytes: number;
}

function readLines(file: string): Line[] {
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
      if (typeof l.key === "string" && typeof l.hash === "string" && typeof l.at === "number") out.push(l);
    } catch {
      /* a torn or foreign line: skip it */
    }
  }
  return out;
}

/** Replay the log into the panel's window logic, each remember at its own time. */
function replay(lines: Line[], now: () => number): { cache: FrameCache; live: Line[] } {
  let clock = 0;
  const cache = createFrameCache({ now: () => clock });
  for (const l of lines) {
    clock = l.at;
    cache.remember(l.key, l.hash, { label: l.label, bytes: l.bytes });
  }
  clock = now();
  // What survives the window, for compaction: the newest line per key, in the
  // order of that newest remember, inside the TTL, the last LIMIT of them —
  // exactly what the replayed cache holds (one entry per key, oldest shifted).
  const survivors = new Map<string, Line>();
  for (const l of lines) {
    survivors.delete(l.key);
    survivors.set(l.key, l);
  }
  const live = [...survivors.values()].filter((l) => l.at > clock - WINDOW_TTL_MS).slice(-WINDOW_LIMIT);
  return { cache, live };
}

export function createSharedFrameCache(file: () => string | null, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  // When there is no file to share (no port known), the window is this process's.
  const local = createFrameCache({ now });

  function compact(f: string, live: Line[]): void {
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, live.map((l) => JSON.stringify(l) + "\n").join(""));
      fs.renameSync(tmp, f);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing written */
      }
    }
  }

  return {
    match(key: string, hash: string): FrameCacheMatch | null {
      const f = file();
      if (!f) return local.match(key, hash);
      // `local` holds only what could not be appended to the file.
      return replay(readLines(f), now).cache.match(key, hash) ?? local.match(key, hash);
    },
    remember(key: string, hash: string, meta?: FrameCacheMeta | null): void {
      const f = file();
      if (!f) return local.remember(key, hash, meta);
      const line: Line = { key, hash, at: now(), label: meta?.label || key, bytes: meta?.bytes || 0 };
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, JSON.stringify(line) + "\n");
      } catch {
        local.remember(key, hash, meta);
        return;
      }
      const lines = readLines(f);
      if (lines.length > COMPACT_AT) compact(f, replay(lines, now).live);
    },
  };
}

export type SharedFrameCache = ReturnType<typeof createSharedFrameCache>;
