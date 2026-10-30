// frameCache.ts — recent screenshot identity, for spotting a stale render.
//
// This is the MCP server's copy of `packages/ae-panel/client/framecache.js`
// (issue #220 stage 4: the server now does the stale-frame check itself). The
// panel keeps its copy for legacy MCP servers that still ask it to, and the two
// must behave identically — tests/unit/image-parity.mjs holds them together.
// Change both or neither.
//
// After Effects' render path sometimes answers a screenshot request with a
// buffer it produced for an earlier one, and reports success either way. Nothing
// else in the response distinguishes the two: the temp file is freshly named,
// the op returns ok, the PNG is well formed. The one signal that survives is
// content identity — two *different* requests coming back with byte-identical
// pixels is not a coincidence, it is one buffer handed out twice. Reported and
// evidenced as issue #29: byte-identical results for unrelated comps at
// unrelated times, and at different downsample factors, which cannot even be the
// same number of pixels.
//
// The cache is per server process. Two MCP clients sharing one panel therefore
// no longer see each other's frames, and a direct POST /op bypasses it — but
// such a caller is handed a raw file path, not a picture, so nothing stale is
// ever shown to it as an image anyway.

// Enough history to catch the bug — it shows up within a handful of calls — and
// small enough that a long session cannot turn a linear scan into a cost.
const DEFAULT_LIMIT = 24;
// Long enough to span a working sequence of screenshots, short enough that a
// comp genuinely edited between two visits is not compared against its own past.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface FrameCacheOptions {
  limit?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface FrameCacheMatch {
  key: string;
  label: string;
  bytes: number;
  ageMs: number;
}

export interface FrameCacheMeta {
  label?: string;
  bytes?: number;
}

export interface FrameCache {
  match(key: string, hash: string): FrameCacheMatch | null;
  remember(key: string, hash: string, meta?: FrameCacheMeta | null): void;
  size(): number;
}

interface FrameCacheEntry {
  key: string;
  hash: string;
  at: number;
  label: string;
  bytes: number;
}

export function createFrameCache(options?: FrameCacheOptions): FrameCache {
  const opts = options || {};
  const limit = opts.limit || DEFAULT_LIMIT;
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const now = opts.now || function () { return Date.now(); };
  let entries: FrameCacheEntry[] = [];

  function prune(): void {
    const cutoff = now() - ttlMs;
    const kept: FrameCacheEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].at > cutoff) kept.push(entries[i]);
    }
    entries = kept;
  }

  return {
    /**
     * The most recent *different* request that produced these exact pixels, or
     * null. Matching the same key proves nothing: repeating a screenshot is
     * allowed to return the same picture, and an agent retrying after a stale
     * report must not be told the retry is stale too.
     */
    match: function (key: string, hash: string): FrameCacheMatch | null {
      prune();
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].hash === hash && entries[i].key !== key) {
          return {
            key: entries[i].key,
            label: entries[i].label,
            bytes: entries[i].bytes,
            ageMs: now() - entries[i].at,
          };
        }
      }
      return null;
    },

    /**
     * Record a frame that was actually delivered. Only successful, non-empty
     * renders belong here: an empty frame is legitimately identical to every
     * other empty frame, and remembering rejected ones would make the first
     * stale buffer poison every later request that happens to repeat it.
     */
    remember: function (key: string, hash: string, meta?: FrameCacheMeta | null): void {
      prune();
      // One entry per request key, so re-running the same screenshot replaces
      // its own record instead of filling the window with copies of itself.
      const kept: FrameCacheEntry[] = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].key !== key) kept.push(entries[i]);
      }
      entries = kept;
      entries.push({
        key: key,
        hash: hash,
        at: now(),
        label: (meta && meta.label) || key,
        bytes: (meta && meta.bytes) || 0,
      });
      while (entries.length > limit) entries.shift();
    },

    size: function (): number { prune(); return entries.length; },
  };
}
