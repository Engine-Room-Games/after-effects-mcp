// analyze_motion: a motion style read off comps the designer already animated
// (issue #244).
//
// Three halves, each held here:
//   - `_motion_keys` (packages/jsx/motion.jsx) gathers raw keys in After
//     Effects. Run against tests/unit/lib/fake-ae.mjs through the real
//     dispatch(): it must read every keyed property, skip what is not motion
//     (markers, expression-driven keys), resolve every comp before reading any,
//     and stop at maxKeys saying what it did not read.
//   - `summarizeMotion` (mcp-server style/motion.ts) is pure statistics: the
//     designer's vocabulary — a move, its ease, overshoot, stagger — has to
//     come out of plain key arrays the way a person would describe them.
//   - The tool itself goes through tools/call against a stub bridge: it asks
//     the panel for `_motion_keys` and nothing else, and answers with a
//     bounded summary, never the keys — a tool result is re-sent every turn.
//
//   node tests/unit/motion-style.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { loadFakeAe } from "./lib/fake-ae.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { summarizeMotion, travelShare, propertyLabel, spread } = await import(dist("style", "motion.js"));
const { OpMutation, InternalOpMutation, StrictOpSchemas } = await import(sharedDist("schemas.js"));
const { prepareBatchSteps } = await import(dist("tools", "batchSteps.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`motion-style FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------- fixtures

const EASY = [33.33, 0];
/** A key: [time, in, out, inInfl, inSpeed, outInfl, outSpeed, value]. */
const key = (t, v, { inI = "b", outI = "b", inE = EASY, outE = EASY } = {}) => [t, inI, outI, inE[0], inE[1], outE[0], outE[1], v];
const prop = (layerId, label, matchName, keys) => ({
  layerId, layer: "L" + layerId, path: `Transform > ${label}`, matchName, spatial: matchName === "ADBE Position", keys,
});
const comp = (props, over = {}) => ({
  id: 7, name: "Lower third", frameRate: 30, duration: 10, numLayers: 6, props,
  skipped: { notMotion: 0, expressionDriven: 0 }, ...over,
});
const raw = (comps, over = {}) => ({
  comps, keysRead: comps.reduce((n, c) => n + c.props.reduce((m, p) => m + p.keys.length, 0), 0),
  maxKeys: 2000, truncated: false, keysNotRead: 0, propsNotRead: 0, ...over,
});

/** The house-style example: scale 0 → 108 → 100 over 0.4s, easy ease, one layer every 2 frames. */
function popIn(layerId, start) {
  return prop(layerId, "Scale", "ADBE Scale", [
    key(start, [0, 0, 100]),
    key(start + 0.3, [108, 108, 100]),
    key(start + 0.4, [100, 100, 100]),
  ]);
}

// ---------------------------------------------------------------- pure summary

await check("travelShare: 1 at the target, above past it, below 0 behind the start, null without a target", () => {
  assert.equal(travelShare([0], [100], [100]), 1);
  assert.equal(travelShare([0, 0], [108, 108], [100, 100]), 1.08);
  assert.equal(travelShare([0], [-10], [100]), -0.1);
  assert.equal(travelShare([0], [50], [0]), null, "an out-and-back has no target to overshoot");
  assert.equal(travelShare([0], null, [1]), null);
  assert.equal(travelShare([0], [1, 2], [1]), null);
});

await check("labels: a transform property by its own name, anything deeper with its parent", () => {
  assert.equal(propertyLabel({ path: "Transform > Scale", matchName: "ADBE Scale" }), "Scale");
  assert.equal(propertyLabel({ path: "Effects > Gaussian Blur > Blurriness", matchName: "ADBE Gaussian Blur 2-0001" }), "Gaussian Blur > Blurriness");
  assert.deepEqual(spread([]), null);
  assert.deepEqual(spread([1, 2, 3, 4, 5]), { median: 3, p25: 2, p75: 4, min: 1, max: 5 });
});

await check("a 0 → 108 → 100 pop is ONE move of 0.4s with an 8% overshoot settling over 0.1s", () => {
  const s = summarizeMotion(raw([comp([popIn(1, 0)])]));
  assert.equal(s.moves, 1);
  assert.equal(s.segments, 2);
  assert.equal(s.durations.moveSeconds.median, 0.4);
  assert.equal(s.durations.moveFrames.median, 12);
  assert.equal(s.overshoot.moves, 1);
  assert.equal(s.overshoot.amountPercent.median, 8);
  assert.equal(s.overshoot.settleSeconds.median, 0.1);
  assert.deepEqual(s.overshoot.mostOn, ["Scale"]);
  assert.equal(s.anticipation.moves, 0);
  assert.ok(s.notes.some((n) => /a hint, not a pattern/.test(n)), "one move is not a style, and the result says so");
});

await check("a settle with a bounce is one overshoot, not two", () => {
  const p = prop(1, "Opacity", "ADBE Opacity", [key(0, [0]), key(0.3, [110]), key(0.45, [97]), key(0.6, [100])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 1);
  assert.equal(s.overshoot.moves, 1);
  assert.equal(s.overshoot.amountPercent.median, 10);
  assert.equal(s.overshoot.elastic, 1);
  assert.equal(s.overshoot.settleSeconds.median, 0.3);
});

await check("anticipation: a wind-up behind the start at the beginning of a move", () => {
  const p = prop(1, "Position", "ADBE Position", [key(0, [100, 500]), key(0.2, [80, 500]), key(0.7, [900, 500])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.anticipation.moves, 1);
  assert.equal(s.anticipation.amountPercent.median, 2.5);
  assert.equal(s.anticipation.seconds.median, 0.2);
  assert.equal(s.overshoot.moves, 0);
});

await check("a reversal past any plausible overshoot is two moves, not a 100% overshoot (review of #254)", () => {
  const p = prop(1, "Position", "ADBE Position", [key(0, [0, 0]), key(0.5, [100, 0]), key(1, [50, 0])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.overshoot.moves, 0);
  assert.ok(!s.suggestedLines.some((l) => /Overshoot/.test(l)), s.suggestedLines.join("\n"));
});

// The fixtures a designer would recognise (second review of #254): the
// settle of a pop is LONGER than its approach, and that is still one move.
const f = (n) => n / 30;
await check("scale pop: 0 → 110 in 6f, settle to 100 over 14f, is one 20f move with a 10% overshoot", () => {
  const p = prop(1, "Scale", "ADBE Scale", [key(0, [0, 0, 100]), key(f(6), [110, 110, 100]), key(f(20), [100, 100, 100])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 1);
  assert.equal(s.durations.moveFrames.median, 20);
  assert.equal(s.overshoot.moves, 1);
  assert.equal(s.overshoot.amountPercent.median, 10);
  assert.equal(s.overshoot.settleSeconds.median, 0.467);
  assert.equal(s.suggestedLines[0], "Typical move: 0.667s (20f at 30fps)");
});

await check("keyed elastic: 0 → 120 → 95 → 102 → 100 is one move, 20% overshoot, two oscillations", () => {
  const p = prop(1, "Scale", "ADBE Scale", [
    key(0, [0, 0]), key(f(6), [120, 120]), key(f(12), [95, 95]), key(f(17), [102, 102]), key(f(22), [100, 100]),
  ]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 1);
  assert.equal(s.overshoot.moves, 1);
  assert.equal(s.overshoot.amountPercent.median, 20);
  assert.equal(s.overshoot.elastic, 1);
  assert.equal(s.overshoot.oscillations, 2);
  assert.equal(s.reversals.impacts, 0, "eased peaks are not impacts");
});

await check("an amplitude that grows instead of settling is not one move", () => {
  const p = prop(1, "Rotation", "ADBE Rotate Z", [key(0, [0]), key(f(6), [110]), key(f(12), [80]), key(f(18), [100])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.ok(s.moves >= 2, `${s.moves} moves`);
});

await check("floor bounce: a sharp reversal at the extreme is reported, not hidden in one move", () => {
  const p = prop(1, "Position", "ADBE Position", [
    key(0, [960, 500]), key(f(10), [960, 900], { inI: "l", outI: "l" }), key(f(20), [960, 500]),
  ]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.reversals.impacts, 1);
  assert.deepEqual(s.reversals.impactsOn, ["Position"]);
  assert.equal(s.reversals.returns, 1);
  assert.ok(s.suggestedLines.some((l) => /^Bounces \(impact and return\): 1 sharp reversal with no ease at contact \(on Position\)/.test(l)), s.suggestedLines.join("\n"));
});

await check("a baked track on every frame is left out and named; the designer's moves are the statistics", () => {
  const track = [];
  for (let i = 0; i < 300; i++) track.push(key(f(i), [i * 3, 500 + (i % 7)], { inI: "l", outI: "l" }));
  const props = [prop(50, "Position", "ADBE Position", track)];
  for (let i = 0; i < 10; i++) props.push(popIn(i + 1, f(i * 2)));
  const s = summarizeMotion(raw([comp(props)]));
  assert.equal(s.bakedProperties, 1);
  assert.equal(s.moves, 10);
  assert.equal(s.eases.segments.linear, 0);
  assert.ok(s.suggestedLines.includes("No linear motion"), s.suggestedLines.join("\n"));
  assert.ok(s.notes.some((n) => /1 property is keyed on nearly every frame \(baked or tracked\) and that part is left out of the statistics: L50 Position\./.test(n)), s.notes.join("\n"));
  assert.equal(s.staggers.top[0].layers, 10, "the track does not join the stagger");
});

await check("reversed layer: keys arriving descending are read in comp-time order, and said so", () => {
  const p = prop(1, "Scale", "ADBE Scale", [key(f(20), [100, 100]), key(f(6), [110, 110]), key(0, [0, 0])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 1);
  assert.equal(s.overshoot.moves, 1);
  assert.ok(s.notes.some((n) => /ran backwards in comp time/.test(n)), s.notes.join("\n"));
});

await check("a wind-up bigger than half the travel is a move of its own, not anticipation", () => {
  const p = prop(1, "Rotation", "ADBE Rotate Z", [key(0, [0]), key(0.2, [-80]), key(0.7, [100])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.anticipation.moves, 0);
});

await check("one move prints one duration, not a 'most 0.4–0.4s' range", () => {
  const s = summarizeMotion(raw([comp([popIn(1, 0)])]));
  assert.equal(s.suggestedLines[0], "Typical move: 0.4s (12f at 30fps)");
});

// Round-3 review fixtures (#254).
const linear = { inI: "l", outI: "l" };
const hold = { outI: "h" };

await check("a linear zigzag with 17 reversals counts 17 impacts, once each", () => {
  const keys = [];
  for (let i = 0; i < 19; i++) keys.push(key(f(i * 4), [i % 2 ? 100 : 0], linear));
  const s = summarizeMotion(raw([comp([prop(1, "Rotation", "ADBE Rotate Z", keys)])]));
  assert.equal(s.reversals.impacts, 17);
  assert.ok(s.suggestedLines.some((l) => /: 17 sharp reversals/.test(l)), s.suggestedLines.join("\n"));
});

await check("a ball with two floor hits counts two impacts", () => {
  const keys = [
    key(0, [960, 200]), key(f(12), [960, 900], linear), key(f(20), [960, 500]),
    key(f(28), [960, 900], linear), key(f(34), [960, 700]),
  ];
  const s = summarizeMotion(raw([comp([prop(1, "Position", "ADBE Position", keys)])]));
  assert.equal(s.reversals.impacts, 2);
});

await check("hold-keyed blinks are steps, not 'no moves' and not holds", () => {
  const props = [];
  for (let l = 0; l < 3; l++) {
    const keys = [];
    for (let i = 0; i < 6; i++) keys.push(key(f(i * 8), [i % 2 ? 0 : 100], hold));
    props.push(prop(l + 1, "Opacity", "ADBE Opacity", keys));
  }
  const s = summarizeMotion(raw([comp(props)]));
  assert.equal(s.moves, 0);
  assert.equal(s.steps.count, 15);
  assert.equal(s.steps.intervalSeconds.median, 0.267);
  assert.equal(s.holds.count, 0, "a step is not a hold");
  assert.equal(s.eases.segments.eased + s.eases.segments.linear + s.eases.segments.mixed, 0, "no eases on a step");
  assert.ok(!s.notes.some((n) => /No keyframed moves/.test(n)), s.notes.join("\n"));
  assert.ok(s.notes.some((n) => /15 hold-keyed steps/.test(n)), s.notes.join("\n"));
  assert.deepEqual(s.suggestedLines, ["Steps (hold keys — blinks, cuts, text changes): 15, typically 0.267s apart"]);
});

await check("Source Text style: hold keys on a non-numeric value are steps", () => {
  const keys = [key(0, null, hold), key(1, null, hold), key(2, null, hold)];
  const s = summarizeMotion(raw([comp([{ ...prop(1, "Source Text", "ADBE Text Document", keys), path: "Text > Source Text" }])]));
  assert.equal(s.steps.count, 2);
  assert.equal(s.moves, 0);
});

await check("a move that starts before the in point is kept whole; one wholly outside is dropped and counted", () => {
  const p = {
    ...prop(1, "Scale", "ADBE Scale", [
      key(0, [0, 0]), key(f(6), [110, 110]), key(f(20), [100, 100]), // starts before in (f(10)), seen in part
      key(f(200), [100, 100]), key(f(210), [0, 0]), // wholly after out (f(150))
    ]),
    inPoint: f(10), outPoint: f(150),
  };
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 1);
  assert.equal(s.durations.moveFrames.median, 20, "the whole move, not the visible part");
  assert.equal(s.overshoot.moves, 1);
  assert.ok(s.notes.some((n) => /1 move, hold or step lies wholly outside its layer.s in\/out/.test(n)), s.notes.join("\n"));
});

await check("separated X and Y keyed together are one move, not two", () => {
  const x = { ...prop(1, "X Position", "ADBE Position_0", [key(0, [0]), key(f(6), [110]), key(f(20), [100])]) };
  const y = { ...prop(1, "Y Position", "ADBE Position_1", [key(0, [500]), key(f(6), [500]), key(f(20), [500])]) };
  const s = summarizeMotion(raw([comp([x, y])]));
  assert.equal(s.moves, 1);
  assert.equal(s.byProperty[0].property, "Position");
  assert.equal(s.overshoot.moves, 1);
  // Keyed at different times, they stay two moves.
  const y2 = { ...y, keys: [key(f(30), [500]), key(f(40), [600])] };
  assert.equal(summarizeMotion(raw([comp([x, y2])])).moves, 2);
});

await check("an elastic overshoot is worded as elastic, never as a bounce", () => {
  const p = prop(1, "Scale", "ADBE Scale", [
    key(0, [0, 0]), key(f(6), [120, 120]), key(f(12), [95, 95]), key(f(17), [102, 102]), key(f(22), [100, 100]),
  ]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.ok(s.suggestedLines.some((l) => /; elastic \(oscillating before settling\)$/.test(l)), s.suggestedLines.join("\n"));
  assert.ok(!s.suggestedLines.some((l) => /Bounce/.test(l)), s.suggestedLines.join("\n"));
});

// Round-4 review fixtures (#254).
await check("ease shares are of every segment: 1 eased in 10 is 10%, not 100% of eased", () => {
  const props = [prop(1, "Opacity", "ADBE Opacity", [key(0, [0]), key(f(10), [100])])];
  for (let i = 0; i < 9; i++) props.push(prop(i + 2, "Rotation", "ADBE Rotate Z", [key(0, [0], linear), key(f(10), [90], linear)]));
  const s = summarizeMotion(raw([comp(props)]));
  assert.equal(s.eases.commonPairs[0].share, 0.1);
  assert.equal(s.eases.stoppingBothEnds, 1);
  assert.ok(!s.suggestedLines.some((l) => /^Ease:/.test(l)), "10% is not the house ease");
  assert.ok(s.suggestedLines.includes("Linear on 90% of segments"), s.suggestedLines.join("\n"));
});

await check("half-eased segments are reported as such", () => {
  const props = [];
  for (let i = 0; i < 10; i++) props.push(prop(i + 1, "Opacity", "ADBE Opacity", [key(0, [0], { outI: "l" }), key(f(10), [100])]));
  const s = summarizeMotion(raw([comp(props)]));
  assert.ok(s.suggestedLines.includes("Eased one end only on 100% of segments"), s.suggestedLines.join("\n"));
});

await check("a stop at a corner ends the move: right, stop, then down is two moves", () => {
  const p = prop(1, "Position", "ADBE Position", [key(0, [0, 0]), key(f(15), [500, 0]), key(f(30), [500, 400])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.overshoot.moves, 0);
});

await check("a pause mid-travel (stop, same direction) ends the move; a waypoint that flows does not", () => {
  const stop = prop(1, "Rotation", "ADBE Rotate Z", [key(0, [0]), key(f(10), [45]), key(f(20), [90])]);
  assert.equal(summarizeMotion(raw([comp([stop])])).moves, 2);
  const flow = prop(1, "Rotation", "ADBE Rotate Z", [key(0, [0]), key(f(10), [45], { inE: [33, 120], outE: [33, 120] }), key(f(20), [90])]);
  assert.equal(summarizeMotion(raw([comp([flow])])).moves, 1);
});

await check("separated X and Y keyed a little apart on one layer are one move", () => {
  const x = prop(1, "X Position", "ADBE Position_0", [key(0, [0]), key(f(15), [500])]);
  const y = prop(1, "Y Position", "ADBE Position_1", [key(0.2, [0]), key(0.2 + f(15), [300])]);
  const s = summarizeMotion(raw([comp([x, y])]));
  assert.equal(s.moves, 1);
  assert.equal(s.durations.moveSeconds.median, 0.7);
  assert.equal(s.byProperty[0].property, "Position");
  // Far apart they stay two.
  const y2 = prop(1, "Y Position", "ADBE Position_1", [key(2, [0]), key(2.5, [300])]);
  assert.equal(summarizeMotion(raw([comp([x, y2])])).moves, 2);
  // And another layer's Y never joins this layer's X.
  const y3 = prop(2, "Y Position", "ADBE Position_1", [key(0.2, [0]), key(0.7, [300])]);
  assert.equal(summarizeMotion(raw([comp([x, y3])])).moves, 2);
});

await check("designer keys plus a baked tail: the designer moves are kept, only the baked run is cut", () => {
  const keys = [key(0, [0, 0]), key(f(6), [110, 110]), key(f(20), [100, 100])];
  for (let i = 1; i <= 60; i++) keys.push(key(f(20 + i), [100 + i, 100], linear));
  const s = summarizeMotion(raw([comp([prop(1, "Scale", "ADBE Scale", keys)])]));
  assert.equal(s.moves, 1, "the pop, and nothing from the baked tail");
  assert.equal(s.overshoot.moves, 1);
  assert.equal(s.bakedProperties, 1);
  assert.ok(s.notes.some((n) => /L1 Scale \(baked part only\)/.test(n)), s.notes.join("\n"));
  assert.ok(!s.notes.some((n) => /expressions or in a precomp/.test(n)), "moves were found");
});

await check("singulars: one step, one elastic move of several", () => {
  const blink = prop(1, "Opacity", "ADBE Opacity", [key(0, [100], hold), key(1, [0], hold)]);
  const s = summarizeMotion(raw([comp([blink])]));
  assert.deepEqual(s.suggestedLines, ["One step (a hold key — blink, cut or text change), after 1s"]);
  const elastic = prop(1, "Scale", "ADBE Scale", [key(0, [0, 0]), key(f(6), [120, 120]), key(f(12), [95, 95]), key(f(17), [102, 102]), key(f(22), [100, 100])]);
  const s2 = summarizeMotion(raw([comp([elastic, popIn(2, 0)])]));
  assert.ok(s2.suggestedLines.some((l) => /; 1 of 2 elastic \(oscillating before settling\)$/.test(l)), s2.suggestedLines.join("\n"));
});

// Round-5 review fixtures (#254).
const pathKey = (t, id, opts) => { const k = key(t, null, opts); k.push(id); return k; };

await check("a path A → B, B copied to hold, B → A is two moves and a hold, not three moves", () => {
  const p = { ...prop(1, "Path", "ADBE Vector Shape", [
    pathKey(0, "sA"), pathKey(f(10), "sB"), pathKey(f(38), "sB"), pathKey(f(48), "sA"),
  ]), path: "Contents > Shape 1 > Path 1 > Path" };
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.holds.count, 1);
  assert.equal(s.durations.moveFrames.median, 10, "no fake 28f move");
  // Without an identity the panel could not compare them, and a key is taken to move.
  const blind = { ...p, keys: p.keys.map((k) => k.slice(0, 8)) };
  assert.equal(summarizeMotion(raw([comp([blind])])).moves, 3);
});

await check("repeated identical Source Text keys are a hold, a changed text is a step", () => {
  const p = { ...prop(1, "Source Text", "ADBE Text Document", [
    pathKey(0, "tHello", hold), pathKey(1, "tHello", hold), pathKey(2, "tWorld", hold),
  ]), path: "Text > Source Text" };
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.steps.count, 1);
  assert.equal(s.holds.count, 1);
});

await check("a sharp 2-D corner (about 120°) is not a bounce; a turn back along the axis is", () => {
  const corner = prop(1, "Position", "ADBE Position", [
    key(0, [0, 0]), key(f(10), [500, 0], linear), key(f(20), [250, 433]),
  ]);
  assert.equal(summarizeMotion(raw([comp([corner])])).reversals.impacts, 0);
  const back = prop(1, "Position", "ADBE Position", [
    key(0, [0, 0]), key(f(10), [500, 0], linear), key(f(20), [0, 40]),
  ]);
  assert.equal(summarizeMotion(raw([comp([back])])).reversals.impacts, 1);
});

await check("'mostly' only when there is more than one property to choose from", () => {
  const two = [
    prop(1, "Position", "ADBE Position", [key(0, [0, 0]), key(f(10), [0, 500], linear), key(f(20), [0, 0])]),
    prop(1, "Rotation", "ADBE Rotate Z", [key(0, [0]), key(f(10), [90], linear), key(f(20), [0])]),
  ];
  const s = summarizeMotion(raw([comp(two)]));
  assert.ok(s.suggestedLines.some((l) => /^Bounces .*\(mostly (Position|Rotation)\)$/.test(l)), s.suggestedLines.join("\n"));
  const one = summarizeMotion(raw([comp([popIn(1, 0)])]));
  assert.ok(one.suggestedLines.some((l) => /^Overshoot on 100% of moves \(on Scale\):/.test(l)), one.suggestedLines.join("\n"));
});

await check("anticipation is worded as a share of the travel", () => {
  const p = prop(1, "Position", "ADBE Position", [key(0, [100, 500]), key(0.2, [80, 500]), key(0.7, [900, 500])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.ok(s.suggestedLines.some((l) => /~3% of the travel back, over 0\.2s/.test(l)), s.suggestedLines.join("\n"));
});

await check("holds and steps split moves: equal values hold, a hold keyframe into a new value steps", () => {
  const p = prop(1, "Position", "ADBE Position", [
    key(0, [0, 0]), key(0.5, [100, 0]), // move
    key(2.5, [100, 0], { outI: "h" }), // equal value: a 2s hold
    key(3, [300, 0]), // hold keyframe into a new value: a step after 0.5s
    key(3.5, [0, 0]), // move
  ]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.holds.count, 1);
  assert.equal(s.steps.count, 1);
  assert.equal(s.steps.intervalSeconds.median, 0.5);
  assert.deepEqual(s.durations.moveSeconds, { median: 0.5, p25: 0.5, p75: 0.5, min: 0.5, max: 0.5 });
});

// Ten layers popping in two frames apart, plus an opacity fade on each that
// starts with them, plus one linear slide.
const cascade = [];
for (let i = 0; i < 10; i++) {
  const t = (i * 2) / 30;
  cascade.push(popIn(100 + i, t));
  cascade.push(prop(100 + i, "Opacity", "ADBE Opacity", [key(t, [0], { outE: [75, 0] }), key(t + 0.5, [100], { inE: [75, 0] })]));
}
cascade.push(prop(200, "Position", "ADBE Position", [key(0, [0, 0], { outI: "l" }), key(1, [500, 0], { inI: "l" })]));
const big = summarizeMotion(raw([comp(cascade)]));

await check("eases: stopping sides counted, influences spread, the commonest pair first", () => {
  assert.equal(big.eases.segments.linear, 1);
  assert.equal(big.eases.segments.eased, 30);
  assert.equal(big.eases.leaving.stops, 30);
  assert.equal(big.eases.leaving.flows, 0);
  assert.equal(big.eases.commonPairs[0].outInfluence, 33);
  assert.equal(big.eases.commonPairs[0].inInfluence, 33);
  assert.equal(big.eases.commonPairs[0].segments, 20);
  assert.equal(big.eases.commonPairs[1].outInfluence, 75);
});

await check("a non-zero speed is a flow-through, not an ease", () => {
  const p = prop(1, "Rotation", "ADBE Rotate Z", [key(0, [0], { outE: [20, 45] }), key(1, [90])]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.eases.leaving.flows, 1);
  assert.equal(s.eases.leaving.stops, 0);
  assert.equal(s.eases.commonPairs.length, 0);
});

await check("staggers: ten layers two frames apart are one cascade, found once for Scale and Opacity together", () => {
  assert.equal(big.staggers.found, 1);
  const st = big.staggers.top[0];
  assert.equal(st.layers, 10);
  assert.equal(st.offsetFrames, 2);
  assert.equal(st.offsetSeconds, 0.067);
  assert.equal(st.evenness, 1);
  assert.deepEqual(st.properties.sort(), ["Opacity", "Scale"]);
});

await check("layers starting together are not a stagger", () => {
  const s = summarizeMotion(raw([comp([popIn(1, 0), popIn(2, 0), popIn(3, 0), popIn(4, 0)])]));
  assert.equal(s.staggers.found, 0);
});

await check("suggestedLines: numbers first, in the house style's own vocabulary", () => {
  const lines = big.suggestedLines;
  assert.equal(lines[0], "Typical move: 0.5s (15f at 30fps); most 0.4–0.5s");
  assert.ok(lines.some((l) => /^Ease: 33% influence both ends, speed 0/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^Linear on 3% of segments/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^Overshoot on 48% of moves \(on Scale\): ~8% of the travel past the target, settling over 0\.1s/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^Stagger: 2f \(0\.067s\) between layers/.test(l)), lines.join("\n"));
  assert.ok(!big.notes.some((n) => /a hint/.test(n)), "21 moves is a pattern");
  for (const l of lines) assert.ok(l.length <= 120, `a line for a 240-character digest: ${l}`);
});

await check("nothing keyed: an explicit note, never an empty success", () => {
  const s = summarizeMotion(raw([comp([])]));
  assert.equal(s.moves, 0);
  assert.deepEqual(s.suggestedLines, []);
  assert.ok(s.notes.some((n) => /No keyframed moves/.test(n)));
});

await check("what was skipped and what was cut short are named", () => {
  const s = summarizeMotion(raw([comp([popIn(1, 0)], { skipped: { notMotion: 1, expressionDriven: 2 } })], {
    truncated: true, keysNotRead: 40, propsNotRead: 3, maxKeys: 10,
  }));
  assert.ok(s.notes.some((n) => /maxKeys \(10\) reached: 3 keyed properties \(40 keys\) did not fit and were not read/.test(n)), s.notes.join("\n"));
  assert.ok(s.notes.some((n) => /2 keyed properties are driven by an expression/.test(n)));
  assert.ok(s.notes.some((n) => /Time Remap/.test(n)));
  assert.ok(s.notes.some((n) => /Not read: expressions/.test(n)), "says what it cannot see");
});

await check("bounded: a thousand animated properties summarise in a few kilobytes, no keys", () => {
  const many = [];
  for (let i = 0; i < 1000; i++) {
    many.push(prop(i, `Effect ${i % 40} > Param`, `X-${i % 40}`, [key(i / 30, [0]), key(i / 30 + 0.5, [i])]));
    many[i].path = `Effects > Effect ${i % 40} > Param`;
  }
  const s = summarizeMotion(raw([comp(many)]));
  const size = JSON.stringify(s).length;
  assert.ok(size < 4000, `summary is ${size} characters`);
  assert.equal(s.byProperty.length, 8);
  assert.equal(s.propertiesOmitted, 32);
  assert.ok(s.staggers.top.length <= 5);
  assert.ok(!/"keys":\s*\[/.test(JSON.stringify(s)), "never the key arrays");
});

// ---------------------------------------------------------------- _motion_keys in (fake) After Effects

const ae = loadFakeAe(["ids.jsx", "keyframes.jsx", "motion.jsx"]);
ae.run(`
  var c = FAKE.comp(100, "Pops");
  var a = c.addLayer(1, "Title", "text");
  var sc = a.property("Transform").property("Scale");
  sc.setValueAtTime(0, [0, 0, 100]); sc.setValueAtTime(0.3, [108, 108, 100]); sc.setValueAtTime(0.4, [100, 100, 100]);
  for (var i = 1; i <= 3; i++) {
    sc.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    var e = [new KeyframeEase(0, 33.333), new KeyframeEase(0, 33.333), new KeyframeEase(0, 33.333)];
    sc.setTemporalEaseAtKey(i, e, e);
  }
  var op = a.property("Transform").property("Opacity");
  op.setValueAtTime(0, 0); op.setValueAtTime(0.5, 100);
  op.setInterpolationTypeAtKey(2, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
  // Driven by an expression: its keys are not what plays.
  var rot = a.property("Transform").property("Rotation");
  rot.setValueAtTime(0, 0); rot.setValueAtTime(1, 90);
  rot.expression = "wiggle(2, 5)"; rot.expressionEnabled = true;
  // A marker is not motion.
  a.property("Marker").setValueAtTime(1, new MarkerValue("beat"));
  var b = c.addLayer(2, "Chip", "shape");
  var blur = b.property("Effects").addProperty("ADBE Gaussian Blur 2").property("Blurriness");
  blur.setValueAtTime(0.1, 20); blur.setValueAtTime(0.6, 0);
  c.addLayer(3, "Still", "shape");
  // A path keyed A, B, B: the panel sends an identity per key so equal paths read as a hold.
  var g = c.addLayer(7, "Morph", "shape");
  var pathProp = new FakeProperty("Path", "ADBE Vector Shape", new Shape(), PropertyValueType.SHAPE);
  g._root._add(pathProp);
  var shA = new Shape(); shA.vertices = [[0, 0], [100, 0], [100, 100]]; shA.inTangents = [[0, 0], [0, 0], [0, 0]]; shA.outTangents = [[0, 0], [0, 0], [0, 0]];
  var shB = new Shape(); shB.vertices = [[0, 0], [200, 0], [200, 200]]; shB.inTangents = [[0, 0], [0, 0], [0, 0]]; shB.outTangents = [[0, 0], [0, 0], [0, 0]];
  pathProp.setValueAtTime(0, shA); pathProp.setValueAtTime(0.5, shB); pathProp.setValueAtTime(1, shB);
  // Separated dimensions: the master Position is not what plays.
  var d = c.addLayer(4, "Slider", "shape");
  var pos = d.property("Transform").property("Position");
  pos.setValueAtTime(0, [0, 0]); pos.setValueAtTime(1, [100, 0]);
  pos.dimensionsSeparated = true;
  // A key past the layer's out point never plays.
  var e2 = c.addLayer(5, "Short", "shape");
  e2.outPoint = 1;
  var o2 = e2.property("Transform").property("Opacity");
  o2.setValueAtTime(0, 0); o2.setValueAtTime(0.5, 100); o2.setValueAtTime(3, 0);
  // A time-reversed layer: its in point is after its out point, and keyTime
  // answers descending. Both keys are inside the swapped range.
  var rl = c.addLayer(6, "Reversed", "shape");
  rl.inPoint = 2; rl.outPoint = 0;
  var rs = rl.property("Transform").property("Rotation");
  rs.setValueAtTime(0, 0); rs.setValueAtTime(1, 90);
  rs.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
  rs.setTemporalEaseAtKey(1, [new KeyframeEase(0, 20)], [new KeyframeEase(0, 80)]);
  var layerTime = rs.keyTime;
  rs.keyTime = function (i) { return 2 - layerTime.call(rs, i); };
  FAKE.comp(200, "Empty");
`);

await check("_motion_keys reads every keyed property, compactly, with the first ease entry", () => {
  const res = ae.call("_motion_keys", { compIds: [100, 200], maxKeys: 2000 });
  assert.equal(res.ok, true, String(res.error));
  const r = res.result;
  assert.equal(r.comps.length, 2);
  const [pops, empty] = r.comps;
  assert.equal(pops.name, "Pops");
  assert.equal(pops.frameRate, 30);
  assert.deepEqual(empty.props, []);
  const byPath = Object.fromEntries(pops.props.filter((p) => p.layerId <= 2).map((p) => [p.path, p]));
  assert.deepEqual(Object.keys(byPath).sort(), ["Effects > Gaussian Blur > Blurriness", "Transform > Opacity", "Transform > Scale"]);
  assert.deepEqual(byPath["Transform > Scale"].keys[1], [0.3, "b", "b", 33.33, 0, 33.33, 0, [108, 108, 100], null]);
  assert.equal(byPath["Transform > Scale"].matchName, "ADBE Scale");
  assert.equal(byPath["Transform > Scale"].layerId, 1);
  assert.equal(byPath["Transform > Opacity"].keys[1][2], "h", "hold out is reported");
  assert.deepEqual(byPath["Transform > Opacity"].keys[0][7], [0], "a scalar comes back as [v]");
  assert.equal(byPath["Effects > Gaussian Blur > Blurriness"].layerId, 2);
  assert.equal(pops.skipped.expressionDriven, 1);
  assert.equal(pops.skipped.notMotion, 0, "a marker is passed over, not reported as Time Remap / audio");
  assert.ok(!pops.props.some((p) => p.layerId === 4), "a separated master Position is not read");
  const short = pops.props.find((p) => p.layerId === 5);
  assert.deepEqual(short.keys.map((k) => k[0]), [0, 0.5, 3], "every key is sent; the server drops what is never on screen");
  assert.deepEqual([short.inPoint, short.outPoint], [0, 1]);
  const rev = pops.props.find((p) => p.layerId === 6);
  assert.ok(rev, "keys inside a reversed layer's swapped in/out range are read");
  assert.equal(rev.reversed, true);
  assert.deepEqual(rev.keys.map((k) => k[0]), [1, 2], "comp-time order");
  assert.deepEqual(rev.keys[1].slice(1, 7), ["b", "b", 80, 0, 20, 0], "the layer-time first key's ease sides swap");
  assert.deepEqual([rev.inPoint, rev.outPoint], [0, 2], "a reversed layer's in/out arrive low to high");
  assert.equal(byPath["Transform > Scale"].reversed, false);
  const morph = pops.props.find((p) => p.layerId === 7);
  assert.equal(morph.keys[0][7], null, "a path has no numeric value");
  assert.match(morph.keys[0][8], /^s[0-9a-f]{8}$/);
  assert.notEqual(morph.keys[0][8], morph.keys[1][8], "different paths, different identities");
  assert.equal(morph.keys[1][8], morph.keys[2][8], "the same path, the same identity");
  assert.equal(byPath["Transform > Scale"].keys[0][8], null, "numeric values carry no identity");
  assert.equal(r.keysRead, 15);
  assert.equal(r.truncated, false);
});

await check("_motion_keys stops at maxKeys and counts what it left", () => {
  const r = ae.call("_motion_keys", { compIds: [100], maxKeys: 4 }).result;
  assert.equal(r.truncated, true);
  assert.ok(r.keysRead <= 4);
  assert.equal(r.keysRead + r.keysNotRead, 15);
  assert.ok(r.propsNotRead >= 1);
});

await check("_motion_keys resolves every comp before reading any: a bad id fails the call, naming it", () => {
  const res = ae.call("_motion_keys", { compIds: [100, 999] });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /No comp with id 999/);
});

await check("the fake's reading of a real comp summarises as the designer would say it", () => {
  const s = summarizeMotion(ae.call("_motion_keys", { compIds: [100] }).result);
  assert.equal(s.overshoot.moves, 1);
  assert.equal(s.overshoot.amountPercent.median, 8);
  assert.ok(s.notes.some((n) => /driven by an expression/.test(n)));
});

// ---------------------------------------------------------------- contract tables

await check("classified: the tool and its gathering op are reads; it is refused as a batch step", () => {
  assert.equal(OpMutation.analyze_motion, "read");
  assert.equal(InternalOpMutation._motion_keys, "read");
  assert.ok(StrictOpSchemas.analyze_motion.safeParse({ compIds: [1] }).success);
  assert.ok(!StrictOpSchemas.analyze_motion.safeParse({ compIds: [] }).success, "at least one comp");
  assert.ok(!StrictOpSchemas.analyze_motion.safeParse({ compIds: [1], layers: [2] }).success, "strict");
  const { problems } = prepareBatchSteps([{ op: "analyze_motion", args: { compIds: [1] } }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /no analyze_motion of its own/);
});

// ---------------------------------------------------------------- the tool, through tools/call

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const seen = [];
const bridge = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op, args } = JSON.parse(body || "{}");
    seen.push({ op, args });
    if (op === "_motion_keys") {
      res.end(JSON.stringify({ ok: true, result: raw([comp(cascade)]) }));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: { message: `Unknown op: ${op}` } }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const server = createServer();
const client = new Client({ name: "motion-style-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

await check("analyze_motion asks the panel for _motion_keys once, comps de-duplicated, and answers with the summary", async () => {
  const res = await client.callTool({ name: "analyze_motion", arguments: { compIds: [7, 7] } });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(seen.map((s) => s.op), ["_motion_keys"]);
  assert.deepEqual(seen[0].args, { compIds: [7], maxKeys: 2000 });
  const text = res.content[0].text;
  const s = JSON.parse(text);
  assert.equal(s.moves, big.moves);
  assert.deepEqual(s.suggestedLines, big.suggestedLines);
  assert.ok(!/"keys":\s*\[/.test(text), "the raw keys never reach the agent");
});

await client.close();
await new Promise((r) => wss.close(r));
await new Promise((r) => bridge.close(r));

console.log(`motion-style: ${passed} checks passed`);
process.exit(0);
