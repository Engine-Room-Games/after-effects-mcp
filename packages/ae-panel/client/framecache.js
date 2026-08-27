// framecache.js — recent screenshot identity, for spotting a stale render.
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
// This lives in the panel rather than in the MCP server for two reasons. The
// panel is the only thing that sees every render — the documented workaround for
// this bug POSTs /op directly, and the check has to hold for that caller too.
// And it outlives any one MCP client process, which is the right lifetime for
// "what has this After Effects session rendered recently".
//
// Kept in its own file so tests/unit/frame-cache.mjs can require it without a
// DOM or a running After Effects.

"use strict";

// Enough history to catch the bug — it shows up within a handful of calls — and
// small enough that a long session cannot turn a linear scan into a cost.
var DEFAULT_LIMIT = 24;
// Long enough to span a working sequence of screenshots, short enough that a
// comp genuinely edited between two visits is not compared against its own past.
var DEFAULT_TTL_MS = 10 * 60 * 1000;

function createFrameCache(options) {
  var opts = options || {};
  var limit = opts.limit || DEFAULT_LIMIT;
  var ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  var now = opts.now || function () { return Date.now(); };
  var entries = [];

  function prune() {
    var cutoff = now() - ttlMs;
    var kept = [];
    for (var i = 0; i < entries.length; i++) {
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
    match: function (key, hash) {
      prune();
      for (var i = entries.length - 1; i >= 0; i--) {
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
    remember: function (key, hash, meta) {
      prune();
      // One entry per request key, so re-running the same screenshot replaces
      // its own record instead of filling the window with copies of itself.
      var kept = [];
      for (var i = 0; i < entries.length; i++) {
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

    size: function () { prune(); return entries.length; },
  };
}

module.exports = { createFrameCache: createFrameCache };
