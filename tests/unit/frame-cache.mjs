// The panel's stale-render detector.
//
// After Effects sometimes answers a screenshot request with a buffer rendered
// for an earlier one and reports success (issue #29). Content identity is the
// only signal left, so the rules about *when* identical pixels mean a stale
// buffer — and when they are merely the same picture asked for twice — are what
// decides whether an agent gets a correct error or a false alarm. There is no AE
// on a CI runner, so they are checked here.
//
//   node tests/unit/frame-cache.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { createFrameCache } = require(
  path.join(root, "packages", "ae-panel", "client", "framecache.js"),
);

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`frame-cache FAILED: ${name}`);
    throw e;
  }
  passed++;
}

/** A cache with a clock this test drives, so the TTL is testable without waiting. */
function fixture(opts = {}) {
  const clock = { t: 1_000_000 };
  const cache = createFrameCache({ ...opts, now: () => clock.t });
  return { cache, clock };
}

check("a fresh cache matches nothing", () => {
  const { cache } = fixture();
  assert.equal(cache.match("screenshot_frame|1|-|0.000000|2", "aaa"), null);
  assert.equal(cache.size(), 0);
});

check("the same pixels under a different key is the bug", () => {
  const { cache } = fixture();
  cache.remember("screenshot_frame|734|-|8.300000|4", "hash-a", {
    label: "comp 734 @ 8.300s downsample 4",
    bytes: 98489,
  });
  const m = cache.match("screenshot_frame|1221|-|8.600000|4", "hash-a");
  assert.ok(m, "byte-identical pixels for two different comps must be caught");
  assert.equal(m.label, "comp 734 @ 8.300s downsample 4");
  assert.equal(m.bytes, 98489, "the earlier byte count is what makes the report checkable");
});

check("the same pixels under the same key is not", () => {
  const { cache } = fixture();
  const key = "screenshot_frame|1|-|0.000000|2";
  cache.remember(key, "hash-a", { label: "comp 1 @ 0.000s downsample 2", bytes: 1000 });
  assert.equal(
    cache.match(key, "hash-a"),
    null,
    "repeating a screenshot is allowed to return the same picture",
  );
});

check("a retry after a stale report is not itself reported stale", () => {
  // The sequence that matters: request A renders, request B comes back with A's
  // pixels and is refused, and the agent retries B. B must not be compared
  // against itself, and A must still be the thing it collides with.
  const { cache } = fixture();
  cache.remember("A", "hash-a", { label: "A", bytes: 10 });
  const first = cache.match("B", "hash-a");
  assert.ok(first, "B should collide with A");
  // A refused frame is never remembered, so the retry sees the same state.
  const retry = cache.match("B", "hash-a");
  assert.ok(retry, "the retry still collides with A, which is the honest answer");
  assert.equal(retry.key, "A");
  assert.equal(cache.size(), 1, "a refused frame must not enter the window");
});

check("a genuinely different render clears", () => {
  const { cache } = fixture();
  cache.remember("A", "hash-a", { label: "A", bytes: 10 });
  assert.equal(cache.match("B", "hash-b"), null);
});

check("the most recent colliding request is the one reported", () => {
  const { cache, clock } = fixture();
  cache.remember("A", "hash-a", { label: "first", bytes: 1 });
  clock.t += 5_000;
  cache.remember("B", "hash-a", { label: "second", bytes: 2 });
  const m = cache.match("C", "hash-a");
  assert.equal(m.label, "second", "name the nearest collision, not the oldest");
  assert.equal(m.ageMs, 0);
});

check("age is reported so the message can say how long ago", () => {
  const { cache, clock } = fixture();
  cache.remember("A", "hash-a", { label: "A", bytes: 1 });
  clock.t += 12_000;
  assert.equal(cache.match("B", "hash-a").ageMs, 12_000);
});

check("a re-run replaces its own record rather than accumulating", () => {
  const { cache, clock } = fixture();
  cache.remember("A", "hash-a", { label: "A", bytes: 1 });
  clock.t += 1000;
  cache.remember("A", "hash-b", { label: "A", bytes: 2 });
  assert.equal(cache.size(), 1);
  assert.equal(
    cache.match("B", "hash-a"),
    null,
    "the superseded hash must not keep flagging later frames",
  );
  assert.ok(cache.match("B", "hash-b"));
});

check("entries expire", () => {
  const { cache, clock } = fixture({ ttlMs: 60_000 });
  cache.remember("A", "hash-a", { label: "A", bytes: 1 });
  clock.t += 59_000;
  assert.ok(cache.match("B", "hash-a"), "still inside the window");
  clock.t += 2_000;
  assert.equal(cache.match("B", "hash-a"), null, "past the window");
  assert.equal(cache.size(), 0);
});

check("the window is bounded, oldest first", () => {
  const { cache, clock } = fixture({ limit: 3 });
  for (const k of ["A", "B", "C", "D"]) {
    cache.remember(k, `hash-${k}`, { label: k, bytes: 1 });
    clock.t += 10;
  }
  assert.equal(cache.size(), 3);
  assert.equal(cache.match("X", "hash-A"), null, "the oldest entry should have been dropped");
  assert.ok(cache.match("X", "hash-D"));
});

check("a screenshot_layer and a screenshot_frame are different requests", () => {
  const { cache } = fixture();
  cache.remember("screenshot_frame|1|-|0.000000|2", "hash-a", { label: "frame", bytes: 1 });
  assert.ok(
    cache.match("screenshot_layer|1|9|0.000000|2", "hash-a"),
    "a solo'd layer that renders as the whole comp is still worth flagging",
  );
});

console.log(`frame-cache: ${passed} checks passed`);
