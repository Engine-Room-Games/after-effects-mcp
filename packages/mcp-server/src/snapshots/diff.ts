/**
 * The diff of two comp fingerprints, for `diff_comp` (issue #220, stage 1).
 *
 * Gathering a fingerprint needs After Effects, so it stays in
 * `packages/jsx/snapshot.jsx` (`_comp_fingerprint`). Comparing two of them does
 * not, and every line of it that ran in ExtendScript ran on AE's main thread —
 * and could only be fixed by a panel reinstall and an AE restart. So
 * `diff_comp` now asks the panel for a fresh fingerprint and diffs it here.
 *
 * This is a line-for-line port of `__diffFingerprints` and its helpers, and
 * the output must stay byte-for-byte identical to it: same keys, same key
 * order, same prose. `tests/unit/comp-snapshot.mjs` runs every diff case
 * against both copies and a parity sweep over generated fixtures, because
 * there are two copies until `diff:true` on `run_jsx` / `run_batch` (which
 * still diffs inside the call, in ExtendScript) moves too. Change one, change
 * both — the parity test fails otherwise.
 *
 * Older panels still carry `_comp_diff`; nothing on this server calls it any
 * more, and it is left in the bundle so a newer panel never breaks an older
 * server that does.
 */

import type { CompFingerprint } from "./store.js";

export const DIFF_COVERS =
  "Compares recorded fields only - not property values, expression text, " +
  "effect parameters, masks or shape contents. \"No differences\" means none of the recorded fields moved, " +
  "not that the two states render identically.";

/**
 * Below a frame at any sane frame rate, above the float noise a round-trip
 * through JSON leaves behind.
 */
const DIFF_EPS = 0.000001;

/** One line; past this many clauses the rest is counted, not spelled out. */
const DIFF_SUMMARY_CLAUSES = 8;

/* eslint-disable @typescript-eslint/no-explicit-any -- fingerprints are JSON from ExtendScript */
type Layer = Record<string, any>;
type Change = { from: any; to: any };
type Fp = CompFingerprint | Record<string, any>;

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function moved(a: unknown, b: unknown): boolean {
  if (typeof a !== "number") return a !== b;
  if (typeof b !== "number") return true;
  return Math.abs(a - b) > DIFF_EPS;
}

/** The "L" prefix mirrors the ExtendScript copy, which had no Map. */
function byId(fp: Fp): Record<string, Layer> {
  const m: Record<string, Layer> = {};
  for (const l of fp.layers as Layer[]) m["L" + l.id] = l;
  return m;
}

function diffKeyCounts(a: Record<string, any>, b: Record<string, any>): Record<string, Change> | null {
  let out: Record<string, Change> | null = null;
  const seen: Record<string, boolean> = {};
  for (const k in a) {
    if (!own(a, k)) continue;
    seen[k] = true;
    let bv = 0;
    if (own(b, k)) bv = b[k];
    if (a[k] !== bv) {
      if (!out) out = {};
      out[k] = { from: a[k], to: bv };
    }
  }
  for (const k in b) {
    if (!own(b, k)) continue;
    if (seen[k]) continue;
    if (!out) out = {};
    out[k] = { from: 0, to: b[k] };
  }
  return out;
}

const EXACT_FIELDS = ["name", "type", "enabled"];
const TIME_FIELDS = ["inPoint", "outPoint", "startTime"];
const COUNT_FIELDS = ["expressionCount", "effectCount"];

/**
 * `index` is deliberately not compared: inserting one layer shifts every index
 * below it. Relative order is compared separately, in `diffReordered`.
 */
function diffLayer(a: Layer, b: Layer): { id: any; name: any; changes: Record<string, any> } | null {
  const ch: Record<string, any> = {};
  let n = 0;
  for (const k of EXACT_FIELDS) {
    if (a[k] !== b[k]) { ch[k] = { from: a[k], to: b[k] }; n += 1; }
  }
  for (const k of TIME_FIELDS) {
    if (moved(a[k], b[k])) { ch[k] = { from: a[k], to: b[k] }; n += 1; }
  }
  for (const k of COUNT_FIELDS) {
    if (a[k] !== b[k]) { ch[k] = { from: a[k], to: b[k] }; n += 1; }
  }
  if (a.parentId !== b.parentId) { ch.parentId = { from: a.parentId, to: b.parentId }; n += 1; }
  const kc = diffKeyCounts(a.keyCounts || {}, b.keyCounts || {});
  if (kc) { ch.keyCounts = kc; n += 1; }
  if (n === 0) return null;
  return { id: b.id, name: b.name, changes: ch };
}

/** Only layers present on both sides, and only when their relative order changed. */
function diffReordered(before: Fp, after: Fp, aMap: Record<string, Layer>, bMap: Record<string, Layer>) {
  const seqA: any[] = [];
  const seqB: any[] = [];
  for (const l of before.layers as Layer[]) if (own(bMap, "L" + l.id)) seqA.push(l.id);
  for (const l of after.layers as Layer[]) if (own(aMap, "L" + l.id)) seqB.push(l.id);
  if (seqA.length !== seqB.length) return null;
  let same = true;
  for (let i = 0; i < seqA.length; i++) {
    if (seqA[i] !== seqB[i]) { same = false; break; }
  }
  if (same) return null;
  const posA: Record<string, number> = {};
  for (let i = 0; i < seqA.length; i++) posA["L" + seqA[i]] = i;
  const out: { id: any; name: any; fromIndex: any; toIndex: any }[] = [];
  for (let i = 0; i < seqB.length; i++) {
    const id = seqB[i];
    if (posA["L" + id] === i) continue;
    out.push({
      id,
      name: bMap["L" + id].name,
      fromIndex: aMap["L" + id].index,
      toIndex: bMap["L" + id].index,
    });
  }
  if (out.length === 0) return null;
  return out;
}

function diffMarkers(a: any[], b: any[]) {
  if (a.length !== b.length) return { from: a.length, to: b.length };
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { count: a.length, edited: true };
  }
  return null;
}

function diffCompFields(a: Fp, b: Fp): Record<string, any> | null {
  const ch: Record<string, any> = {};
  let n = 0;
  if (a.name !== b.name) { ch.name = { from: a.name, to: b.name }; n += 1; }
  if (a.width !== b.width || a.height !== b.height) {
    ch.size = { from: [a.width, a.height], to: [b.width, b.height] };
    n += 1;
  }
  if (moved(a.duration, b.duration)) { ch.duration = { from: a.duration, to: b.duration }; n += 1; }
  if (moved(a.frameRate, b.frameRate)) { ch.frameRate = { from: a.frameRate, to: b.frameRate }; n += 1; }
  if (moved(a.workAreaStart, b.workAreaStart) || moved(a.workAreaDuration, b.workAreaDuration)) {
    ch.workArea = {
      from: [a.workAreaStart, a.workAreaDuration],
      to: [b.workAreaStart, b.workAreaDuration],
    };
    n += 1;
  }
  const mk = diffMarkers((a.markers as any[]) || [], (b.markers as any[]) || []);
  if (mk) { ch.markers = mk; n += 1; }
  if (n === 0) return null;
  return ch;
}

// ---------- summary prose ----------

const plural = (n: number): string => (n === 1 ? "" : "s");

/** "512-514" for a run, "512, 517" otherwise. */
export function diffIdList(ids: number[]): string {
  if (!ids.length) return "";
  const sorted = ids.slice().sort((x, y) => x - y);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let j = 1; j <= sorted.length; j++) {
    const cur = sorted[j];
    let breaks = true;
    if (j < sorted.length && cur === prev + 1) breaks = false;
    if (breaks) {
      if (start === prev) parts.push(String(start));
      else if (prev === start + 1) parts.push(String(start) + ", " + String(prev));
      else parts.push(String(start) + "-" + String(prev));
      start = cur;
    }
    prev = cur;
  }
  return parts.join(", ");
}

const parentLabel = (v: unknown): string => (v === null || v === undefined ? "none" : String(v));

function layerPhrases(entry: { id: any; changes: Record<string, any> }): string[] {
  const label = "layer " + entry.id;
  const c = entry.changes;
  const out: string[] = [];
  if (c.name) out.push(label + ' renamed "' + c.name.from + '" -> "' + c.name.to + '"');
  if (c.enabled) out.push(label + (c.enabled.to ? " enabled" : " disabled"));
  const times: string[] = [];
  if (c.inPoint) times.push("in " + c.inPoint.from + " -> " + c.inPoint.to);
  if (c.outPoint) times.push("out " + c.outPoint.from + " -> " + c.outPoint.to);
  if (c.startTime) times.push("start " + c.startTime.from + " -> " + c.startTime.to);
  if (times.length) out.push(label + " retimed (" + times.join(", ") + ")");
  if (c.parentId) {
    out.push(label + " re-parented " + parentLabel(c.parentId.from) + " -> " + parentLabel(c.parentId.to));
  }
  if (c.keyCounts) {
    for (const k in c.keyCounts) {
      if (!own(c.keyCounts, k)) continue;
      out.push(label + " " + k + " keys " + c.keyCounts[k].from + " -> " + c.keyCounts[k].to);
    }
  }
  if (c.effectCount) out.push(label + " effects " + c.effectCount.from + " -> " + c.effectCount.to);
  if (c.expressionCount) {
    out.push(label + " expressions " + c.expressionCount.from + " -> " + c.expressionCount.to);
  }
  if (c.type) out.push(label + " type " + c.type.from + " -> " + c.type.to);
  return out;
}

function compPhrases(ch: Record<string, any>): string[] {
  const out: string[] = [];
  if (ch.name) out.push('comp renamed "' + ch.name.from + '" -> "' + ch.name.to + '"');
  if (ch.size) {
    out.push("comp resized " + ch.size.from[0] + "x" + ch.size.from[1] + " -> " + ch.size.to[0] + "x" + ch.size.to[1]);
  }
  if (ch.duration) out.push("comp duration " + ch.duration.from + " -> " + ch.duration.to);
  if (ch.frameRate) out.push("comp frame rate " + ch.frameRate.from + " -> " + ch.frameRate.to);
  if (ch.workArea) out.push("comp work area moved");
  if (ch.markers) {
    if (ch.markers.edited) out.push("comp markers edited");
    else out.push("comp markers " + ch.markers.from + " -> " + ch.markers.to);
  }
  return out;
}

function summary(d: Record<string, any>): string {
  let parts: string[] = [];
  if (d.added) {
    const ids = d.added.map((a: Layer) => a.id);
    parts.push(d.added.length + " layer" + plural(d.added.length) + " added: ids " + diffIdList(ids));
  }
  if (d.removed) {
    const ids = d.removed.map((r: Layer) => r.id);
    parts.push(d.removed.length + " layer" + plural(d.removed.length) + " removed: ids " + diffIdList(ids));
  }
  if (d.reordered) {
    parts.push(d.reordered.length + " layer" + plural(d.reordered.length) + " moved in the stack");
  }
  if (d.changed) {
    for (const entry of d.changed) parts.push(...layerPhrases(entry));
  }
  if (d.comp) parts.push(...compPhrases(d.comp));
  if (parts.length === 0) {
    return "No differences in the recorded fields. Property values, expression text, effect parameters " +
      "and shape contents are not compared, so this is not a claim that nothing changed at all.";
  }
  if (parts.length > DIFF_SUMMARY_CLAUSES) {
    const extra = parts.length - DIFF_SUMMARY_CLAUSES;
    parts = parts.slice(0, DIFF_SUMMARY_CLAUSES);
    parts.push("and " + extra + " more change" + plural(extra) + " (see the fields below)");
  }
  return parts.join("; ");
}

/**
 * Two fingerprints -> only what moved. Unchanged layers are counted, never
 * listed: listing them is the cost this whole thing exists to avoid.
 */
export function diffFingerprints(before: Fp, after: Fp): Record<string, unknown> {
  const aMap = byId(before);
  const bMap = byId(after);
  const added: Layer[] = [];
  const removed: Layer[] = [];
  const changed: NonNullable<ReturnType<typeof diffLayer>>[] = [];
  let unchanged = 0;
  for (const l of after.layers as Layer[]) {
    const prev = aMap["L" + l.id];
    if (!prev) {
      added.push({ id: l.id, name: l.name, index: l.index, type: l.type });
      continue;
    }
    const d = diffLayer(prev, l);
    if (d) changed.push(d);
    else unchanged += 1;
  }
  for (const l of before.layers as Layer[]) {
    if (own(bMap, "L" + l.id)) continue;
    removed.push({ id: l.id, name: l.name, index: l.index, type: l.type });
  }
  const reordered = diffReordered(before, after, aMap, bMap);
  const comp = diffCompFields(before, after);

  const out: Record<string, any> = { compId: after.compId, compName: after.name };
  if (added.length) out.added = added;
  if (removed.length) out.removed = removed;
  if (changed.length) out.changed = changed;
  if (reordered) out.reordered = reordered;
  if (comp) out.comp = comp;
  out.unchangedLayers = unchanged;
  let count = added.length + removed.length + changed.length;
  if (reordered) count += reordered.length;
  if (comp) count += 1;
  out.changeCount = count;
  out.summary = summary(out);
  out.covers = DIFF_COVERS;
  return out;
}
