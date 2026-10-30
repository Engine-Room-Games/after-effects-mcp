/**
 * `analyze_motion`: how a designer's existing comps move, in numbers (issue #244).
 *
 * The panel gathers raw keys (`_motion_keys`, packages/jsx/motion.jsx); every
 * statistic is computed here, so AE's main thread does plain reads only and
 * the summary can change without a panel reinstall.
 *
 * The answer is re-sent on every later request of the session, so it is a
 * digest with fixed caps — never a key list — and it names what it could not
 * see: expressions, motion-path shape, per-dimension eases. What it is for is
 * the "Motion" section of house-style.md, written through `set_house_style`
 * only after the user has agreed with it; `suggestedLines` are worded for that.
 *
 * Vocabulary, used the same way in the result:
 *   - a **segment** is two adjacent keys of one property whose value changes;
 *   - a **move** is a run of segments with no hold between them — `0 → 108 →
 *     100` on Scale is one move of two segments, which is how a designer
 *     would describe it;
 *   - a **hold** is a stretch between keys where nothing changes (equal values,
 *     or a hold keyframe).
 */

import type { SendInternal } from "../tools/internalOps.js";

export type Interp = "l" | "b" | "h";
/** [time, inInterp, outInterp, inInfluence, inSpeed, outInfluence, outSpeed, value] */
export type RawKey = [number, Interp, Interp, number | null, number | null, number | null, number | null, number[] | null];

export interface RawProp {
  layerId: number;
  layer: string;
  path: string;
  matchName: string;
  spatial: boolean;
  keys: RawKey[];
  /** Set by the panel when the keys came descending (a time-reversed layer) and were reordered. */
  reversed?: boolean;
  /** The layer's in and out points, low to high; null when the panel could not read them. */
  inPoint?: number | null;
  outPoint?: number | null;
}

export interface RawComp {
  id: number;
  name: string;
  frameRate: number;
  duration: number;
  numLayers: number;
  props: RawProp[];
  skipped: { notMotion: number; expressionDriven: number };
}

export interface MotionKeys {
  comps: RawComp[];
  keysRead: number;
  maxKeys: number;
  truncated: boolean;
  keysNotRead: number;
  propsNotRead: number;
}

/** Below a frame at any frame rate; above JSON float noise. */
const EPS = 1e-6;
/** An ease side with |speed| under this is a stop — After Effects' easy ease is exactly 0. */
const STOP_SPEED = 0.01;
/** A middle key must pass the target by more than this share of the travel to count as overshoot. */
const OVERSHOOT_MIN = 0.02;
/** Past this share of the travel, a reversal is a new move, not an overshoot or a wind-up. */
const MAX_REVERSAL = 0.5;
/** The most keys one move is looked for across; a longer run is read as several. */
const MAX_MOVE_KEYS = 40;
/** A property with at least this many keys, spaced this close, is baked data. */
const BAKED_MIN_KEYS = 20;
const BAKED_MAX_GAP_FRAMES = 1.5;
/** Output caps. Raising one is a decision about what every later request carries. */
const MAX_PROPERTIES = 8;
const MAX_EASE_PAIRS = 4;
const MAX_STAGGERS = 5;
/** Fewer moves than this and the result says it is a hint, not a pattern. */
const FEW_MOVES = 8;

const NOT_COVERED =
  "Not read: expressions (keys under an enabled expression are skipped), motion-path shape (spatial tangents), " +
  "and per-dimension eases (the first ease entry of each side is used). Nested precomps are not followed.";

// ---------------------------------------------------------------- numbers

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const secs = (n: number): number => round(n, 3);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Spread {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

/** Median and quartiles, or null for no data. */
export function spread(values: number[], places = 3): Spread | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    median: round(quantile(s, 0.5), places),
    p25: round(quantile(s, 0.25), places),
    p75: round(quantile(s, 0.75), places),
    min: round(s[0], places),
    max: round(s[s.length - 1], places),
  };
}

const share = (n: number, of: number): number => (of > 0 ? round(n / of, 2) : 0);
const pct = (x: number): number => Math.round(x * 100);

function sameValue(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > EPS) return false;
  return true;
}

/**
 * Where `b` sits along the travel from `a` to `c`, as a share of it: 0 at `a`,
 * 1 at `c`, above 1 past the target, below 0 behind the start. Null when the
 * values are not comparable or `a` and `c` coincide (an out-and-back pulse has
 * no target to overshoot).
 */
export function travelShare(a: number[] | null, b: number[] | null, c: number[] | null): number | null {
  if (!a || !b || !c || a.length !== b.length || a.length !== c.length) return null;
  let dot = 0;
  let len2 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = c[i] - a[i];
    dot += (b[i] - a[i]) * d;
    len2 += d * d;
  }
  if (len2 < EPS) return null;
  return dot / len2;
}

// ---------------------------------------------------------------- labels

/** Transform properties are named by their own name; anything deeper keeps its parent ("Gaussian Blur > Blurriness"). */
const TRANSFORM_MATCH = new Set([
  "ADBE Anchor Point", "ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2",
  "ADBE Scale", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z", "ADBE Orientation", "ADBE Opacity",
]);

export function propertyLabel(p: Pick<RawProp, "path" | "matchName">): string {
  const parts = p.path.split(" > ");
  if (TRANSFORM_MATCH.has(p.matchName) || parts.length < 2) return parts[parts.length - 1];
  return parts.slice(-2).join(" > ");
}

// ---------------------------------------------------------------- the walk

interface Segment {
  seconds: number;
  frames: number;
  kind: "linear" | "eased" | "mixed";
  /** The ease leaving the first key, when that side is bezier. */
  out: { influence: number; stops: boolean } | null;
  /** The ease arriving at the second key, when that side is bezier. */
  in: { influence: number; stops: boolean } | null;
}

interface Move {
  label: string;
  layerId: number;
  matchName: string;
  start: number;
  end: number;
  seconds: number;
  frames: number;
  segments: number;
  overshoot: { amount: number; settleSeconds: number; oscillations: number } | null;
  anticipation: { amount: number; seconds: number } | null;
}

function segmentKind(outI: Interp, inI: Interp): Segment["kind"] {
  if (outI === "l" && inI === "l") return "linear";
  if (outI === "b" && inI === "b") return "eased";
  return "mixed";
}

function easeSide(interp: Interp, influence: number | null, speed: number | null): Segment["out"] {
  if (interp !== "b" || influence === null || speed === null) return null;
  return { influence, stops: Math.abs(speed) < STOP_SPEED };
}

/** True when keys i → i+1 change the value (a hold keyframe, or two equal values, is a hold). */
function isMove(a: RawKey, b: RawKey): boolean {
  if (a[2] === "h") return false;
  if (b[0] - a[0] <= EPS) return false;
  // A non-numeric value (shape path, text) cannot be compared; a key on it is taken to move.
  if (a[7] === null || b[7] === null) return true;
  return !sameValue(a[7], b[7]);
}

/**
 * Can keys i..e be read as ONE move? The vocabulary is a designer's:
 *
 *   - an optional wind-up at the first middle key, at most MAX_REVERSAL back;
 *   - an approach that never goes backwards (waypoints are fine);
 *   - once past the target, a settle: every later key closer to the final
 *     value than the one before, and the first pass at most MAX_REVERSAL
 *     past it. How long the settle takes does not matter — a pop's settle is
 *     usually longer than its approach.
 *
 * So `0 → 110 → 100` and `0 → 120 → 95 → 102 → 100` are one move each, while
 * `0 → 100 → 50` (a return of half the travel) and `0 → 100 → 0` (back where
 * it started, no target to overshoot) are two.
 */
function oneMove(k: RawKey[], i: number, e: number): boolean {
  let progress = -Infinity;
  let passed = false;
  let lastDev = Infinity;
  for (let m = i + 1; m < e; m++) {
    const t = travelShare(k[i][7], k[m][7], k[e][7]);
    if (t === null) return false;
    if (passed) {
      const dev = Math.abs(t - 1);
      if (dev > lastDev + EPS) return false;
      lastDev = dev;
      continue;
    }
    if (m === i + 1 && t < -OVERSHOOT_MIN) {
      if (-t > MAX_REVERSAL) return false;
      progress = t;
      continue;
    }
    if (t > 1 + OVERSHOOT_MIN) {
      if (t - 1 > MAX_REVERSAL) return false;
      passed = true;
      lastDev = t - 1;
      continue;
    }
    if (t < progress - OVERSHOOT_MIN) return false;
    progress = Math.max(progress, t);
  }
  return true;
}

/** Both sides of the key bring the speed to zero: the motion stops there. */
function stopsAt(key: RawKey): boolean {
  const side = (interp: Interp, speed: number | null) =>
    interp === "h" || (interp === "b" && speed !== null && Math.abs(speed) < STOP_SPEED);
  return side(key[1], key[4]) && side(key[2], key[6]);
}

/** True when the travel into key m turns back on itself leaving it (within ~25°). */
function reversesAt(k: RawKey[], m: number): boolean {
  const a = k[m - 1][7], b = k[m][7], c = k[m + 1][7];
  if (!a || !b || !c || a.length !== b.length || b.length !== c.length) return false;
  let dot = 0, la = 0, lb = 0;
  for (let d = 0; d < a.length; d++) {
    const u = b[d] - a[d];
    const v = c[d] - b[d];
    dot += u * v;
    la += u * u;
    lb += v * v;
  }
  if (la < EPS || lb < EPS) return false;
  return dot / Math.sqrt(la * lb) < -0.9;
}

/**
 * The first key in run i..j where the motion stops and goes on in another
 * direction (a corner) or the same one (a pause), or j. A stop that turns
 * straight back is left to oneMove, which reads it as an overshoot's peak or a
 * wind-up when it is one.
 */
function stopEnd(k: RawKey[], i: number, j: number): number {
  for (let m = i + 1; m < j; m++) if (stopsAt(k[m]) && !reversesAt(k, m)) return m;
  return j;
}

/** The longest stretch from key i, within run end j, that reads as one move. */
function moveEnd(k: RawKey[], i: number, j: number): number {
  for (let e = Math.min(j, i + MAX_MOVE_KEYS); e > i + 1; e--) if (oneMove(k, i, e)) return e;
  return i + 1;
}

/** A key the value bounces off: the direction flips and nothing eases into or out of it. */
function isImpact(a: RawKey, b: RawKey, c: RawKey): boolean {
  const va = a[7], vb = b[7], vc = c[7];
  if (!va || !vb || !vc || va.length !== vb.length || vb.length !== vc.length) return false;
  let dot = 0;
  for (let d = 0; d < va.length; d++) dot += (vb[d] - va[d]) * (vc[d] - vb[d]);
  if (dot >= 0) return false;
  const sharp = (interp: Interp, speed: number | null) => interp === "l" || (interp === "b" && speed !== null && Math.abs(speed) >= STOP_SPEED);
  return sharp(b[1], b[4]) || sharp(b[2], b[6]);
}

export interface Reversals {
  /** Keys the value bounced off with no ease (a floor hit, a sharp turn). */
  impacts: number;
  /** Moves straight back to where the previous one started (a pulse, an out-and-back). */
  returns: number;
  impactsOn: Map<string, number>;
}

/** Everything the walk collects across properties. */
interface Walk {
  segments: Segment[];
  moves: Move[];
  holds: number[];
  /** How long each value stood before a hold keyframe stepped it to the next (a blink, a step, Source Text). */
  steps: number[];
  rev: Reversals;
  /** Moves, holds and steps wholly outside their layer's in/out: never on screen. */
  offscreen: number;
}

/** A hold keyframe into a different value: an instantaneous change, not a move and not a hold. */
function isStep(a: RawKey, b: RawKey): boolean {
  if (a[2] !== "h" || b[0] - a[0] <= EPS) return false;
  // Text and other non-numeric values are hold-keyed by nature: a key is there because something changed.
  if (a[7] === null || b[7] === null) return true;
  return !sameValue(a[7], b[7]);
}

/** Split one property's keys into moves, segments, holds and steps. */
function walkProperty(p: RawProp, fps: number, w: Walk): void {
  const k = p.keys;
  const label = propertyLabel(p);
  const lo = typeof p.inPoint === "number" ? p.inPoint : -Infinity;
  const hi = typeof p.outPoint === "number" ? p.outPoint : Infinity;
  /** True when [t0, t1] never overlaps the layer's in/out: nothing of it is seen. */
  const offscreen = (t0: number, t1: number) => t1 < lo - EPS || t0 > hi + EPS;
  let i = 0;
  let prevMoveStart = -1;
  let prevMoveEnd = -1;
  // Impacts are counted once per key: the walk restarts inside a run after
  // each move, and a key it has already looked at must not count again.
  let impactsSeen = 0;
  while (i < k.length - 1) {
    if (!isMove(k[i], k[i + 1])) {
      const d = k[i + 1][0] - k[i][0];
      if (offscreen(k[i][0], k[i + 1][0])) {
        if (d > EPS) w.offscreen++;
      } else if (isStep(k[i], k[i + 1])) w.steps.push(d);
      else if (d > EPS) w.holds.push(d);
      prevMoveStart = -1;
      i++;
      continue;
    }
    // A run of moving segments, i .. j (keys), then the stretch of it that is
    // one move by oneMove's rules; the rest of the run is read from there.
    let j = i;
    while (j < k.length - 1 && isMove(k[j], k[j + 1])) j++;
    for (let m = Math.max(i + 1, impactsSeen); m < j; m++) {
      if (isImpact(k[m - 1], k[m], k[m + 1]) && !offscreen(k[m][0], k[m][0])) {
        w.rev.impacts++;
        w.rev.impactsOn.set(label, (w.rev.impactsOn.get(label) ?? 0) + 1);
      }
    }
    impactsSeen = Math.max(impactsSeen, j);
    j = moveEnd(k, i, stopEnd(k, i, j));
    if (offscreen(k[i][0], k[j][0])) {
      // Wholly before the in point or after the out point. A move that is
      // seen even in part is kept whole.
      w.offscreen++;
      prevMoveStart = -1;
      i = j;
      continue;
    }
    for (let m = i; m < j; m++) {
      const a = k[m];
      const b = k[m + 1];
      const seconds = b[0] - a[0];
      w.segments.push({
        seconds,
        frames: seconds * fps,
        kind: segmentKind(a[2], b[1]),
        out: easeSide(a[2], a[5], a[6]),
        in: easeSide(b[1], b[3], b[4]),
      });
    }
    if (prevMoveStart >= 0 && prevMoveEnd === i && sameValue(k[j][7], k[prevMoveStart][7])) w.rev.returns++;
    prevMoveStart = i;
    prevMoveEnd = j;
    const seconds = k[j][0] - k[i][0];
    const move: Move = {
      label, layerId: p.layerId, matchName: p.matchName, start: k[i][0], end: k[j][0],
      seconds, frames: seconds * fps, segments: j - i, overshoot: null, anticipation: null,
    };

    // Overshoot: the middle key furthest past where the move ends, measured
    // along the travel from its first key to its last; each later crossing of
    // the target is an oscillation, so 0 → 120 → 95 → 102 → 100 is one
    // overshoot of 20% with two. Anticipation: a first middle key behind the
    // start. oneMove has already split off anything that is neither.
    let peak = -1;
    let peakShare = 1 + OVERSHOOT_MIN;
    for (let m = i + 1; m < j; m++) {
      const t = travelShare(k[i][7], k[m][7], k[j][7]);
      if (t === null) continue;
      if (t > peakShare) {
        peak = m;
        peakShare = t;
      }
      if (m === i + 1 && t < -OVERSHOOT_MIN) move.anticipation = { amount: -t, seconds: k[m][0] - k[i][0] };
    }
    if (peak >= 0) {
      let oscillations = 0;
      let above = true;
      for (let m = peak + 1; m < j; m++) {
        const t = travelShare(k[i][7], k[m][7], k[j][7]);
        if (t === null) continue;
        const nowAbove = t > 1;
        if (nowAbove !== above && Math.abs(t - 1) > OVERSHOOT_MIN) {
          oscillations++;
          above = nowAbove;
        }
      }
      move.overshoot = { amount: peakShare - 1, settleSeconds: k[j][0] - k[peak][0], oscillations };
    }
    w.moves.push(move);
    i = j;
  }
}

const SEPARATED_POSITION = ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"];
/** Separated X/Y moves on one layer this close (or overlapping) are one motion. */
const SEPARATED_GAP = 0.1;

/**
 * Separated X / Y (/ Z) Position moves on one layer that overlap in time, or
 * meet within SEPARATED_GAP, are one motion — a Y keyed a little after X is
 * still one move to the designer. Merged moves span both and keep the larger
 * overshoot and wind-up. Moves keyed at the very same times were already
 * merged at the key level (mergeSeparatedPosition).
 */
export function mergeSeparatedMoves(moves: Move[]): Move[] {
  const out: Move[] = [];
  const sep = new Map<number, Move[]>();
  for (const m of moves) {
    if (!SEPARATED_POSITION.includes(m.matchName)) {
      out.push(m);
      continue;
    }
    const list = sep.get(m.layerId) ?? [];
    list.push(m);
    sep.set(m.layerId, list);
  }
  for (const list of sep.values()) {
    list.sort((a, b) => a.start - b.start);
    let cur: Move | null = null;
    for (const m of list) {
      if (cur && m.start <= cur.end + SEPARATED_GAP) {
        const c: Move = cur;
        const end = Math.max(c.end, m.end);
        const fps: number = c.seconds > 0 ? c.frames / c.seconds : m.seconds > 0 ? m.frames / m.seconds : 30;
        const bigger = <T extends { amount: number }>(a: T | null, b: T | null): T | null =>
          !a ? b : !b ? a : a.amount >= b.amount ? a : b;
        cur = {
          ...c,
          label: "Position",
          end,
          seconds: end - c.start,
          frames: (end - c.start) * fps,
          segments: c.segments + m.segments,
          overshoot: bigger(c.overshoot, m.overshoot),
          anticipation: bigger(c.anticipation, m.anticipation),
        };
        continue;
      }
      if (cur) out.push(cur);
      cur = m;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * A layer's separated X / Y (/ Z) Position keyed at the same times is one
 * motion, the way the designer sees it, not two or three moves. Those
 * properties are merged into one Position whose values are the dimensions
 * side by side, eases taken from X. Keyed at different times, they stay
 * apart — each is then its own move.
 */
export function mergeSeparatedPosition(props: RawProp[]): RawProp[] {
  const byLayer = new Map<number, RawProp[]>();
  for (const p of props) {
    if (!SEPARATED_POSITION.includes(p.matchName)) continue;
    const list = byLayer.get(p.layerId) ?? [];
    list.push(p);
    byLayer.set(p.layerId, list);
  }
  const merged = new Map<RawProp, RawProp | null>();
  for (const dims of byLayer.values()) {
    if (dims.length < 2) continue;
    dims.sort((a, b) => SEPARATED_POSITION.indexOf(a.matchName) - SEPARATED_POSITION.indexOf(b.matchName));
    const first = dims[0];
    const same = dims.every(
      (d) => d.keys.length === first.keys.length && d.keys.every((key, n) => Math.abs(key[0] - first.keys[n][0]) <= EPS)
    );
    if (!same) continue;
    const keys = first.keys.map((key, n): RawKey => {
      const values = dims.map((d) => d.keys[n][7]);
      const value = values.every((v) => v && v.length === 1) ? values.map((v) => v![0]) : null;
      return [key[0], key[1], key[2], key[3], key[4], key[5], key[6], value];
    });
    const parts = first.path.split(" > ");
    parts[parts.length - 1] = "Position";
    merged.set(first, { ...first, matchName: "ADBE Position", path: parts.join(" > "), keys });
    for (const d of dims.slice(1)) merged.set(d, null);
  }
  if (!merged.size) return props;
  const out: RawProp[] = [];
  for (const p of props) {
    if (!merged.has(p)) out.push(p);
    else if (merged.get(p)) out.push(merged.get(p)!);
  }
  return out;
}

/**
 * Keys on (nearly) every frame: baked from an expression, tracked, or
 * converted audio. That is data, not a designer's timing, and a few hundred
 * one-frame "moves" would drown every statistic, so such a property is left
 * out and named.
 */
export function isBaked(p: RawProp, fps: number): boolean {
  const pieces = splitBaked(p, fps);
  return pieces.bakedKeys > 0 && pieces.kept.length === 0;
}

/**
 * The designer's stretches of a property, with any baked run cut out: a run
 * of BAKED_MIN_KEYS or more keys, each within BAKED_MAX_GAP_FRAMES of the
 * last. A property keyed by hand and then baked for its tail keeps its hand
 * keys; one baked throughout keeps nothing. A kept stretch ends on the key
 * where the baked run begins, so a move into it is still whole.
 */
export function splitBaked(p: RawProp, fps: number): { kept: RawProp[]; bakedKeys: number } {
  const k = p.keys;
  const runs: [number, number][] = [];
  let s = 0;
  for (let i = 1; i <= k.length; i++) {
    const dense = i < k.length && Math.abs(k[i][0] - k[i - 1][0]) * fps <= BAKED_MAX_GAP_FRAMES;
    if (dense) continue;
    if (i - s >= BAKED_MIN_KEYS) runs.push([s, i - 1]);
    s = i;
  }
  if (!runs.length) return { kept: [p], bakedKeys: 0 };
  const kept: RawProp[] = [];
  let from = 0;
  let bakedKeys = 0;
  for (const [a, b] of runs) {
    if (a - from >= 1) kept.push({ ...p, keys: k.slice(from, a + 1) });
    bakedKeys += b - a + 1;
    from = b;
  }
  if (k.length - 1 - from >= 1) kept.push({ ...p, keys: k.slice(from) });
  // A stretch that is only the baked run's own end key and nothing after it is not a stretch.
  return { kept: kept.filter((piece) => piece.keys.length >= 2), bakedKeys };
}

/**
 * Keys in comp-time order. A time-reversed layer's keys arrive descending
 * (the panel already reorders them and swaps each key's ease sides, and says
 * so with `reversed`); anything still out of order is sorted here.
 */
function inTimeOrder(p: RawProp): { prop: RawProp; reordered: boolean } {
  for (let i = 1; i < p.keys.length; i++) {
    if (p.keys[i][0] < p.keys[i - 1][0]) {
      return { prop: { ...p, keys: [...p.keys].sort((a, b) => a[0] - b[0]) }, reordered: true };
    }
  }
  return { prop: p, reordered: false };
}

// ---------------------------------------------------------------- staggers

export interface Stagger {
  comp: string;
  properties: string[];
  layers: number;
  offsetSeconds: number;
  offsetFrames: number;
  /** Share of the gaps within a frame of the typical one. 1 is a perfectly even cascade. */
  evenness: number;
}

/**
 * Per comp, per property: when each layer's animation starts. Three or more
 * layers starting at different times on the same property is a stagger; the
 * typical gap between neighbours is its offset. The same cascade on Scale and
 * Opacity is one stagger, not two.
 */
function staggersOf(comp: RawComp): Stagger[] {
  const fps = comp.frameRate > 0 ? comp.frameRate : 30;
  const byProp = new Map<string, { label: string; starts: Map<number, number> }>();
  for (const p of comp.props) {
    const start = p.keys.findIndex((key, idx) => idx < p.keys.length - 1 && isMove(key, p.keys[idx + 1]));
    if (start < 0) continue;
    const id = `${p.matchName}|${p.path}`;
    let g = byProp.get(id);
    if (!g) byProp.set(id, (g = { label: propertyLabel(p), starts: new Map() }));
    const t = p.keys[start][0];
    const prev = g.starts.get(p.layerId);
    if (prev === undefined || t < prev) g.starts.set(p.layerId, t);
  }
  const found = new Map<string, Stagger>();
  for (const g of byProp.values()) {
    if (g.starts.size < 3) continue;
    const times = [...g.starts.values()].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap * fps >= 0.5) gaps.push(gap);
    }
    if (gaps.length < 2) continue;
    const typical = quantile([...gaps].sort((a, b) => a - b), 0.5);
    const even = gaps.filter((gap) => Math.abs(gap - typical) * fps <= 1).length / gaps.length;
    const key = `${g.starts.size}|${Math.round(typical * fps)}|${times.map((t) => Math.round(t * fps)).join(",")}`;
    const seen = found.get(key);
    if (seen) {
      if (seen.properties.length < 3) seen.properties.push(g.label);
      continue;
    }
    found.set(key, {
      comp: comp.name,
      properties: [g.label],
      layers: g.starts.size,
      offsetSeconds: secs(typical),
      offsetFrames: round(typical * fps, 1),
      evenness: round(even, 2),
    });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------- summary

export interface EaseSideSummary {
  /** Bezier sides that bring the speed to zero — a real ease. */
  stops: number;
  /** Bezier sides that keep speed through the key. */
  flows: number;
  /** Influence of the stopping sides, in percent. */
  influence: Spread | null;
}

export function summarizeMotion(raw: MotionKeys) {
  const segments: Segment[] = [];
  const moves: Move[] = [];
  const holds: number[] = [];
  const steps: number[] = [];
  const staggers: Stagger[] = [];
  const fpsSet = new Set<number>();
  let expressionDriven = 0;
  let notMotion = 0;
  let reordered = 0;
  const baked: string[] = [];
  const rev: Reversals = { impacts: 0, returns: 0, impactsOn: new Map() };
  const walk: Walk = { segments, moves, holds, steps, rev, offscreen: 0 };
  const comps = raw.comps.map((c) => {
    const fps = c.frameRate > 0 ? c.frameRate : 30;
    fpsSet.add(round(fps, 3));
    expressionDriven += c.skipped?.expressionDriven ?? 0;
    notMotion += c.skipped?.notMotion ?? 0;
    const before = moves.length;
    let keys = 0;
    const layers = new Set<number>();
    const clean: RawProp[] = [];
    for (const raw of c.props) keys += raw.keys.length;
    for (const raw of mergeSeparatedPosition(c.props)) {
      const { prop: p, reordered: sorted } = inTimeOrder(raw);
      if (sorted || p.reversed) reordered++;
      const { kept, bakedKeys } = splitBaked(p, fps);
      if (bakedKeys) baked.push(`${p.layer} ${propertyLabel(p)}${kept.length ? " (baked part only)" : ""}`);
      if (!kept.length) continue;
      layers.add(p.layerId);
      clean.push(kept[0]);
      for (const piece of kept) walkProperty(piece, fps, walk);
    }
    moves.push(...mergeSeparatedMoves(moves.splice(before)));
    staggers.push(...staggersOf({ ...c, props: clean }));
    return { id: c.id, name: c.name, frameRate: c.frameRate, animatedLayers: layers.size, keys, moves: moves.length - before };
  });

  const fps = fpsSet.size === 1 ? [...fpsSet][0] : null;

  // Durations.
  const moveSeconds = spread(moves.map((m) => m.seconds));
  const moveFrames = spread(moves.map((m) => m.frames), 1);
  const segmentSeconds = spread(segments.map((s) => s.seconds));

  // Eases.
  const kinds = { eased: 0, linear: 0, mixed: 0 };
  for (const s of segments) kinds[s.kind]++;
  const side = (pick: (s: Segment) => Segment["out"]): EaseSideSummary => {
    const sides = segments.map(pick).filter((x): x is NonNullable<Segment["out"]> => x !== null);
    const stopping = sides.filter((x) => x.stops);
    return { stops: stopping.length, flows: sides.length - stopping.length, influence: spread(stopping.map((x) => x.influence), 1) };
  };
  const pairs = new Map<string, { out: number; in: number; segments: number }>();
  let pairable = 0;
  for (const s of segments) {
    if (!s.out?.stops || !s.in?.stops) continue;
    pairable++;
    const o = Math.round(s.out.influence);
    const n = Math.round(s.in.influence);
    const id = `${o}/${n}`;
    const e = pairs.get(id) ?? { out: o, in: n, segments: 0 };
    e.segments++;
    pairs.set(id, e);
  }
  const common = [...pairs.values()]
    .sort((a, b) => b.segments - a.segments)
    .slice(0, MAX_EASE_PAIRS)
    .map((p) => ({ outInfluence: p.out, inInfluence: p.in, segments: p.segments, share: share(p.segments, segments.length) }));

  // Overshoot and anticipation.
  const over = moves.filter((m) => m.overshoot);
  const antic = moves.filter((m) => m.anticipation);
  const overByProp = new Map<string, number>();
  for (const m of over) overByProp.set(m.label, (overByProp.get(m.label) ?? 0) + 1);
  const overshoot = over.length
    ? {
        moves: over.length,
        share: share(over.length, moves.length),
        amountPercent: spread(over.map((m) => m.overshoot!.amount * 100), 1),
        settleSeconds: spread(over.map((m) => m.overshoot!.settleSeconds)),
        /** Moves that cross the target again after the peak: an elastic settle. */
        elastic: over.filter((m) => m.overshoot!.oscillations > 0).length,
        /** Crossings of the target after the peak, summed over every move. */
        oscillations: over.reduce((n, m) => n + m.overshoot!.oscillations, 0),
        mostOn: [...overByProp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p),
      }
    : { moves: 0, share: 0 };
  const anticipation = antic.length
    ? {
        moves: antic.length,
        share: share(antic.length, moves.length),
        amountPercent: spread(antic.map((m) => m.anticipation!.amount * 100), 1),
        seconds: spread(antic.map((m) => m.anticipation!.seconds)),
      }
    : { moves: 0, share: 0 };

  // Per property.
  const byLabel = new Map<string, Move[]>();
  for (const m of moves) {
    const list = byLabel.get(m.label) ?? [];
    list.push(m);
    byLabel.set(m.label, list);
  }
  const propList = [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length);
  const byProperty = propList.slice(0, MAX_PROPERTIES).map(([property, list]) => ({
    property,
    moves: list.length,
    medianSeconds: spread(list.map((m) => m.seconds))!.median,
    overshoots: list.filter((m) => m.overshoot).length,
  }));

  staggers.sort((a, b) => b.layers - a.layers || b.evenness - a.evenness);
  const staggerOffsets = staggers.map((s) => s.offsetSeconds);

  const holdSeconds = spread(holds);
  const startEase = side((s) => s.out);
  const endEase = side((s) => s.in);

  const result = {
    comps,
    keysRead: raw.keysRead,
    moves: moves.length,
    segments: segments.length,
    durations: {
      moveSeconds,
      moveFrames,
      segmentSeconds,
      frameRate: fps ?? "mixed",
    },
    eases: {
      segments: kinds,
      leaving: startEase,
      arriving: endEase,
      /** Segments eased to a stop at both ends; commonPairs' shares are of ALL segments. */
      stoppingBothEnds: pairable,
      commonPairs: common,
    },
    overshoot,
    anticipation,
    staggers: {
      found: staggers.length,
      offsetSeconds: spread(staggerOffsets),
      top: staggers.slice(0, MAX_STAGGERS),
    },
    holds: { count: holds.length, seconds: holdSeconds },
    steps: { count: steps.length, intervalSeconds: spread(steps) },
    reversals: {
      impacts: rev.impacts,
      impactsOn: [...rev.impactsOn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([prop]) => prop),
      returns: rev.returns,
    },
    bakedProperties: baked.length,
    byProperty,
    propertiesOmitted: Math.max(0, propList.length - MAX_PROPERTIES),
    suggestedLines: suggestLines({
      moves: moves.length, moveSeconds, moveFrames, fps, kinds, segments: segments.length, common, pairable,
      overshoot: over.length ? overshoot as OvershootSummary : null,
      anticipation: antic.length ? anticipation as AnticipationSummary : null,
      staggers, holdSeconds, holds: holds.length, impacts: rev.impacts, steps: steps.length, stepSeconds: spread(steps),
      impactsOn: [...rev.impactsOn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }),
    notes: [] as string[],
  };

  if (raw.truncated) {
    result.notes.push(
      `maxKeys (${raw.maxKeys}) reached: ${raw.propsNotRead} keyed propert${raw.propsNotRead === 1 ? "y" : "ies"} ` +
        `(${raw.keysNotRead} keys) did not fit and ${raw.propsNotRead === 1 ? "was" : "were"} not read. Raise maxKeys or pass fewer comps for the whole picture.`
    );
  }
  if (moves.length === 0 && steps.length === 0) {
    result.notes.push("No keyframed moves found in these comps — nothing to learn a motion style from. Is the animation in expressions or in a precomp?");
  } else if (moves.length === 0) {
    result.notes.push(`No eased or linear moves: the animation here is ${steps.length} hold-keyed step${steps.length === 1 ? "" : "s"} (blinks, cuts, text changes), summarised under steps.`);
  } else if (moves.length < FEW_MOVES) {
    result.notes.push(`Only ${moves.length} move${moves.length === 1 ? "" : "s"} read — a hint, not a pattern. Read another comp before writing these as rules.`);
  }
  if (expressionDriven) result.notes.push(`${expressionDriven} keyed propert${expressionDriven === 1 ? "y is" : "ies are"} driven by an expression and ${expressionDriven === 1 ? "was" : "were"} skipped.`);
  if (walk.offscreen) {
    result.notes.push(
      `${walk.offscreen} move${walk.offscreen === 1 ? "" : "s"}, hold${walk.offscreen === 1 ? "" : "s"} or step${walk.offscreen === 1 ? " lies" : "s lie"} wholly outside ${walk.offscreen === 1 ? "its" : "their"} layer's in/out and ${walk.offscreen === 1 ? "was" : "were"} ignored — never on screen. A move seen in part is kept whole.`
    );
  }
  if (notMotion) result.notes.push(`${notMotion} keyed Time Remap / audio propert${notMotion === 1 ? "y was" : "ies were"} skipped as not motion.`);
  if (baked.length) {
    const named = baked.slice(0, 3).join(", ") + (baked.length > 3 ? `, and ${baked.length - 3} more` : "");
    result.notes.push(
      `${baked.length} propert${baked.length === 1 ? "y is" : "ies are"} keyed on nearly every frame (baked or tracked) and that part is left out of the statistics: ${named}.`
    );
  }
  if (reordered) {
    result.notes.push(
      `${reordered} propert${reordered === 1 ? "y's" : "ies'"} keys ran backwards in comp time (a time-reversed layer) and were read in comp-time order.`
    );
  }
  result.notes.push(NOT_COVERED);
  return result;
}

// ---------------------------------------------------------------- lines for the house style

type OvershootSummary = {
  moves: number;
  share: number;
  amountPercent: Spread | null;
  settleSeconds: Spread | null;
  mostOn: string[];
  elastic: number;
};
type AnticipationSummary = { moves: number; share: number; amountPercent: Spread | null; seconds: Spread | null };

interface LineInputs {
  moves: number;
  moveSeconds: Spread | null;
  moveFrames: Spread | null;
  fps: number | null;
  kinds: { eased: number; linear: number; mixed: number };
  segments: number;
  common: { outInfluence: number; inInfluence: number; segments: number; share: number }[];
  pairable: number;
  overshoot: OvershootSummary | null;
  anticipation: AnticipationSummary | null;
  staggers: Stagger[];
  holdSeconds: Spread | null;
  holds: number;
  impacts: number;
  impactsOn: string | null;
  steps: number;
  stepSeconds: Spread | null;
}

/**
 * Draft lines for the Motion section, numbers first. They are a proposal for
 * the user to correct, never written by this tool; the house-style digest
 * keeps about 240 characters of motion, so they are short and the most
 * telling come first.
 */
export function suggestLines(x: LineInputs): string[] {
  const lines: string[] = [];
  const stepLine =
    x.steps && x.stepSeconds
      ? x.steps === 1
        ? `One step (a hold key — blink, cut or text change), after ${x.stepSeconds.median}s`
        : `Steps (hold keys — blinks, cuts, text changes): ${x.steps}, typically ${x.stepSeconds.median}s apart`
      : null;
  if (!x.moves || !x.moveSeconds || !x.moveFrames) return stepLine ? [stepLine] : lines;
  const at = x.fps ? ` at ${x.fps}fps` : "";
  const range = x.moveSeconds.p25 === x.moveSeconds.p75 ? "" : `; most ${x.moveSeconds.p25}–${x.moveSeconds.p75}s`;
  lines.push(`Typical move: ${x.moveSeconds.median}s (${Math.round(x.moveFrames.median)}f${at})${range}`);
  const top = x.common[0];
  // Every share here is of all segments, so the lines add up to what was read.
  if (top && top.share >= 0.25) {
    const ease =
      top.outInfluence === top.inInfluence
        ? `${top.outInfluence}% influence both ends`
        : `${top.outInfluence}% out / ${top.inInfluence}% in`;
    lines.push(`Ease: ${ease}, speed 0 (${pct(top.share)}% of segments)`);
  }
  if (x.segments >= FEW_MOVES) {
    if (x.kinds.linear === 0) lines.push("No linear motion");
    else lines.push(`Linear on ${pct(x.kinds.linear / x.segments)}% of segments`);
    if (x.kinds.mixed / x.segments >= 0.1) lines.push(`Eased one end only on ${pct(x.kinds.mixed / x.segments)}% of segments`);
  }
  if (x.overshoot && x.overshoot.amountPercent && x.overshoot.settleSeconds) {
    const on = x.overshoot.mostOn.length ? ` (mostly ${x.overshoot.mostOn.slice(0, 2).join(", ")})` : "";
    const e = x.overshoot.elastic;
    const elastic = !e
      ? ""
      : e === x.overshoot.moves
        ? "; elastic (oscillating before settling)"
        : `; ${e} of ${x.overshoot.moves} elastic (oscillating before settling)`;
    lines.push(
      `Overshoot on ${pct(x.overshoot.share)}% of moves${on}: ~${Math.round(x.overshoot.amountPercent.median)}% of the travel past the target, settling over ${x.overshoot.settleSeconds.median}s${elastic}`
    );
  }
  if (x.anticipation && x.anticipation.amountPercent && x.anticipation.seconds) {
    lines.push(
      `Anticipation on ${pct(x.anticipation.share)}% of moves: ~${Math.round(x.anticipation.amountPercent.median)}% of the travel back, over ${x.anticipation.seconds.median}s`
    );
  }
  if (x.staggers.length) {
    const offs = [...x.staggers.map((s) => s.offsetFrames)].sort((a, b) => a - b);
    const f = quantile(offs, 0.5);
    const s = x.staggers.find((st) => Math.abs(st.offsetFrames - f) < 0.5) ?? x.staggers[0];
    lines.push(`Stagger: ${round(f, 1)}f (${s.offsetSeconds}s) between layers`);
  }
  if (x.impacts) {
    lines.push(`Bounces (impact and return): ${x.impacts} sharp reversal${x.impacts === 1 ? "" : "s"} with no ease at contact${x.impactsOn ? ` (mostly ${x.impactsOn})` : ""}`);
  }
  if (x.holds >= 3 && x.holdSeconds) lines.push(`Holds between moves: ~${x.holdSeconds.median}s`);
  if (stepLine) lines.push(stepLine);
  return lines;
}

/** The tool: gather in After Effects, summarise here. A comp named twice is read once. */
export async function runAnalyzeMotion(args: { compIds: number[]; maxKeys?: number }, send: SendInternal) {
  const compIds = [...new Set(args.compIds)];
  const raw = (await send("_motion_keys", { compIds, maxKeys: args.maxKeys ?? 2000 })) as MotionKeys;
  return summarizeMotion(raw);
}
