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
  assert.equal(s.overshoot.withBounces, 1);
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

await check("holds split moves: equal values and hold keyframes are not motion", () => {
  const p = prop(1, "Position", "ADBE Position", [
    key(0, [0, 0]), key(0.5, [100, 0]), // move
    key(2.5, [100, 0], { outI: "h" }), // equal value: a 2s hold
    key(3, [300, 0]), // after a hold keyframe: still a hold
    key(3.5, [0, 0]), // move
  ]);
  const s = summarizeMotion(raw([comp([p])]));
  assert.equal(s.moves, 2);
  assert.equal(s.holds.count, 2);
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
  assert.ok(lines.some((l) => /^Overshoot on 48% of moves \(mostly Scale\): ~8% past the target, settling over 0\.1s/.test(l)), lines.join("\n"));
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
  assert.ok(s.notes.some((n) => /maxKeys \(10\): 3 keyed properties \(40 keys\) not read/.test(n)), s.notes.join("\n"));
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
  const byPath = Object.fromEntries(pops.props.map((p) => [p.path, p]));
  assert.deepEqual(Object.keys(byPath).sort(), ["Effects > Gaussian Blur > Blurriness", "Transform > Opacity", "Transform > Scale"]);
  assert.deepEqual(byPath["Transform > Scale"].keys[1], [0.3, "b", "b", 33.33, 0, 33.33, 0, [108, 108, 100]]);
  assert.equal(byPath["Transform > Scale"].matchName, "ADBE Scale");
  assert.equal(byPath["Transform > Scale"].layerId, 1);
  assert.equal(byPath["Transform > Opacity"].keys[1][2], "h", "hold out is reported");
  assert.deepEqual(byPath["Transform > Opacity"].keys[0][7], [0], "a scalar comes back as [v]");
  assert.equal(byPath["Effects > Gaussian Blur > Blurriness"].layerId, 2);
  assert.equal(pops.skipped.expressionDriven, 1);
  assert.equal(r.keysRead, 7);
  assert.equal(r.truncated, false);
});

await check("_motion_keys stops at maxKeys and counts what it left", () => {
  const r = ae.call("_motion_keys", { compIds: [100], maxKeys: 4 }).result;
  assert.equal(r.truncated, true);
  assert.ok(r.keysRead <= 4);
  assert.equal(r.keysRead + r.keysNotRead, 7);
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
  assert.match(problems[0].problem, /raw key/);
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
