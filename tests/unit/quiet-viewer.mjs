// Issue #266: a heavy comp in the viewer is re-rendered after every scripted
// change to its tree (695 ms against 79 ms per added layer, AE 26.5), and a
// rebuild script went past the 300 s op limit on that alone — after which
// check_setup could say only "did not answer within 2s".
//
// Locked in here:
//   1. run_jsx switches viewer rendering off with app.disableRendering by
//      default (issue #274, replacing #267's empty "parking" comp) and puts the
//      PREVIOUS value back — on success and on a throw, through both the
//      bundle's own run_jsx (run_batch steps) and the server-built `_run_jsx`.
//      A user who had it off keeps it off; a nested run_jsx owns nothing; a
//      value that will not go back is reported, never claimed restored. The
//      project is not touched: activeItem stays the user's comp. A frame
//      rendered inside the script turns rendering back on (the "resume" rule).
//   2. The server remembers which of its calls is open — sent or still queued —
//      and which timed out with no answer since, until the panel next answers,
//      and names the oldest one sent (#272).
//   3. check_setup names that call (`busyWith`) when the bridge is busy.
//
// What disableRendering saves, and what it does to a frame, needs a live
// After Effects; see recipe 77 in docs/verification-recipes.md.
//
//   node tests/unit/quiet-viewer.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsx = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { AeError, BridgeTimeoutError } = await import(dist("util", "errors.js"));
const asm = await import(dist("tools", "runJsxAssembly.js"));
const { CallsInFlight } = await import(dist("bridge", "callsInFlight.js"));
const { checkSetup, buildNextSteps, withBusyStep } = await import(dist("setup", "check.js"));

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; }
  catch (e) { console.error(`quiet-viewer FAILED: ${name}`); throw e; }
}

/**
 * An ExtendScript context with a heavy comp in the viewer and AE's
 * app.disableRendering. `initial` is the user's setting, `missing` models an
 * After Effects without the property; `refuse` makes assigning that value
 * throw, `ignore` makes assigning it silently do nothing.
 */
function es({ initial = false, refuse = null, ignore = null, missing = false } = {}) {
  const state = { rendering: initial, writes: [], frames: [], undo: [] };
  const heavy = { id: 7, name: "TR — Opener" };
  const app = {
    beginUndoGroup(n) { state.undo.push(`begin ${n}`); },
    endUndoGroup() { state.undo.push("end"); },
    project: { activeItem: heavy, items: { length: 1 } },
  };
  if (!missing) {
    Object.defineProperty(app, "disableRendering", {
      get() { return state.rendering; },
      set(v) {
        state.writes.push(v);
        if (refuse !== null && v === refuse) throw new Error("After Effects error: cannot set disableRendering");
        if (ignore !== null && v === ignore) return;
        state.rendering = v;
      },
    });
  }
  const ctx = { app, heavy, state, File: function (p) { this.path = p; } };
  // A comp whose frame records whether rendering was off at the moment it was saved.
  ctx.frameComp = {
    id: 9, width: 64, height: 64, resolutionFactor: [1, 1],
    saveFrameToPng() { state.frames.push(state.rendering); },
  };
  vm.createContext(ctx);
  for (const f of ["core.jsx", "snapshot.jsx", "batch.jsx", "raw.jsx", "helpers.jsx", "vision.jsx"]) {
    vm.runInContext(jsx(f), ctx, { filename: f });
  }
  const dispatch = (op, args) => JSON.parse(JSON.stringify(vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }))));
  return { state, heavy, dispatch, ctx };
}

/** The bundle's own run_jsx (run_batch steps, direct posts). */
function viaBundle(e, args) {
  const out = e.dispatch("run_jsx", args);
  if (!out.ok) return { err: out.error };
  return { result: out.result };
}

/** What a tool call does since #243: built on the server, run as `_run_jsx`. */
async function viaServer(e, args) {
  const send = async (op, a) => {
    const out = e.dispatch(op, a);
    if (!out.ok) throw new AeError(out.error, out.stack, out.line);
    return out.result;
  };
  try {
    return { result: await asm.runJsxViaServer(args, send, async () => { throw new Error("fell back"); }) };
  } catch (err) {
    return { err: err.message };
  }
}

const SEEN = "return [app.disableRendering, app.project.activeItem.name];";

for (const [label, run] of [["bundle run_jsx", viaBundle], ["server-built _run_jsx", viaServer]]) {
  await check(`${label}: rendering is off by default, back on after, and the answer keeps its shape`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN });
    assert.deepEqual(result, [true, "TR — Opener"], "off while the script ran; activeItem is still the user's comp");
    assert.equal(e.state.rendering, false, "back on");
    assert.deepEqual(e.state.writes, [true, false]);
  });

  await check(`${label}: quietViewer:true reports what it did`, async () => {
    const e = es();
    const { result } = await run(e, { code: "return 1;", quietViewer: true });
    assert.equal(result.returned, 1);
    assert.deepEqual(result.quietViewer, { renderingOff: true, alreadyOff: false, restored: true });
  });

  await check(`${label}: quietViewer:false leaves rendering alone`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN, quietViewer: false });
    assert.deepEqual(result, [false, "TR — Opener"]);
    assert.deepEqual(e.state.writes, [], "nothing was assigned");
  });

  await check(`${label}: undoGroup:false no longer turns it off — nothing here is an undo step`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN, undoGroup: false });
    assert.deepEqual(result, [true, "TR — Opener"]);
    assert.equal(e.state.rendering, false);
  });

  await check(`${label}: a script that throws still gets rendering back`, async () => {
    const e = es();
    const { err } = await run(e, { code: "if (!app.disableRendering) return 'not off';\nthrow new Error('boom');" });
    assert.match(err, /boom/);
    assert.doesNotMatch(err, /quietViewer/, "a clean restore adds nothing to the error");
    assert.equal(e.state.rendering, false, "back on after the throw");
  });

  await check(`${label}: a user who had rendering off keeps it off`, async () => {
    const e = es({ initial: true });
    const { result } = await run(e, { code: "return app.disableRendering;", quietViewer: true });
    assert.equal(result.returned, true);
    assert.deepEqual(result.quietViewer, { renderingOff: true, alreadyOff: true, restored: true });
    assert.equal(e.state.rendering, true, "left as the user had it");
    assert.deepEqual(e.state.writes, [], "never written");
    const thrown = await run(e, { code: "throw new Error('boom');" });
    assert.match(thrown.err, /boom/);
    assert.equal(e.state.rendering, true, "still off after a throw");
  });

  await check(`${label}: a script that changes it itself gets the previous value put back`, async () => {
    const e = es();
    const { result } = await run(e, { code: "app.disableRendering = false; return 1;" });
    assert.equal(result, 1);
    assert.equal(e.state.rendering, false);
    const e2 = es({ initial: true });
    await run(e2, { code: "app.disableRendering = false; return 1;" });
    assert.equal(e2.state.rendering, true, "the user's own `off` comes back too");
  });

  await check(`${label}: nested run_jsx owns nothing; the outer run restores once`, async () => {
    const e = es();
    const { result } = await run(e, {
      code: "var inner = OPS.run_jsx({code: 'return app.disableRendering;', quietViewer: true});\n" +
        "return [inner.returned, inner.quietViewer.alreadyOff, app.disableRendering];",
    });
    assert.deepEqual(result, [true, true, true], "still off after the inner run returned");
    assert.equal(e.state.rendering, false);
    assert.deepEqual(e.state.writes, [true, false], "one off, one on — the inner run wrote nothing");
  });

  await check(`${label}: a nested run that throws does not turn rendering back on under the outer one`, async () => {
    const e = es();
    const { result } = await run(e, {
      code: "try { OPS.run_jsx({code: 'throw new Error(\"inner\");'}); } catch (x) {}\nreturn app.disableRendering;",
    });
    assert.equal(result, true);
    assert.equal(e.state.rendering, false);
  });

  await check(`${label}: rendering that will not go back on is reported, never claimed restored`, async () => {
    const e = es({ refuse: false });
    const { result } = await run(e, { code: "return 1;" });
    assert.equal(result.returned, 1, "a CAUTION wraps the answer even by default");
    assert.equal(result.quietViewer.restored, false);
    assert.match(result.quietViewer.note, /^CAUTION: viewer rendering could not be turned back on/);
    assert.match(result.quietViewer.note, /Tell the user/);
  });

  await check(`${label}: an assignment AE silently ignores is caught by the read-back`, async () => {
    const e = es({ ignore: false });
    const { result } = await run(e, { code: "return 1;" });
    assert.equal(result.quietViewer.restored, false);
    assert.match(result.quietViewer.note, /reads true after the assignment/);
  });

  await check(`${label}: on a throw, a failed restore is on the error`, async () => {
    const e = es({ refuse: false });
    const { err } = await run(e, { code: "throw new Error('boom');" });
    assert.match(err, /boom/);
    assert.match(err, /quietViewer: CAUTION: viewer rendering could not be turned back on/);
  });

  await check(`${label}: rendering that will not go off runs the script anyway and says so`, async () => {
    const e = es({ refuse: true });
    const { result } = await run(e, { code: "return app.disableRendering;" });
    assert.equal(result.returned, false);
    assert.equal(result.quietViewer.renderingOff, false);
    assert.equal(result.quietViewer.restored, true);
    assert.match(result.quietViewer.note, /could not be turned off/);
  });

  await check(`${label}: an After Effects without the property is left alone`, async () => {
    const e = es({ missing: true });
    const { result } = await run(e, { code: "return 2;" });
    assert.equal(result, 2, "nothing to say by default");
    const asked = await run(es({ missing: true }), { code: "return 2;", quietViewer: true });
    assert.equal(asked.result.quietViewer.renderingOff, false);
    assert.match(asked.result.quietViewer.note, /not available/);
  });

  await check(`${label}: a frame rendered inside the script turns rendering back on for the rest of it`, async () => {
    const e = es();
    const { result } = await run(e, {
      code: "__saveFrameAt(frameComp, 0, {}, 1, 'screenshot_frame');\nreturn app.disableRendering;",
      quietViewer: true,
    });
    assert.deepEqual(e.state.frames, [false], "the frame was saved with rendering on");
    assert.equal(result.returned, false, "and it stayed on (\"resume\")");
    assert.deepEqual(result.quietViewer.resumedFor, ["screenshot_frame"]);
    assert.equal(result.quietViewer.restored, true);
    assert.equal(e.state.rendering, false);
  });

  await check(`${label}: a frame with the user's own rendering off is not this call's to change`, async () => {
    const e = es({ initial: true });
    await run(e, { code: "__saveFrameAt(frameComp, 0, {}, 1, 'screenshot_frame'); return 1;" });
    assert.deepEqual(e.state.frames, [true]);
    assert.deepEqual(e.state.writes, []);
  });
}

await check("the frame rule is one switch: \"around\" turns rendering off again after the save", async () => {
  const e = es();
  const out = e.dispatch("run_jsx", {
    code: "__RJ_FRAMES_WHILE_QUIET = 'around';\n__saveFrameAt(frameComp, 0, {}, 1, 'screenshot_layer');\nreturn app.disableRendering;",
  });
  assert.ok(out.ok, out.error);
  assert.equal(out.result, true);
  assert.deepEqual(e.state.frames, [false]);
  assert.equal(e.state.rendering, false);
  assert.match(jsx("raw.jsx"), /var __RJ_FRAMES_WHILE_QUIET = "resume";/, "the shipped default is \"resume\"");
});

await check("a run_batch run_jsx step follows the same rule, each for its own step", () => {
  const e = es();
  const out = e.dispatch("run_batch", { ops: [
    { op: "run_jsx", args: { code: "return app.disableRendering;" } },
    { op: "run_jsx", args: { code: "return app.disableRendering;", quietViewer: false } },
    { op: "run_jsx", args: { code: "return app.disableRendering;" } },
  ] });
  assert.ok(out.ok, out.error);
  assert.deepEqual(out.result.results, [true, false, true]);
  assert.equal(e.state.rendering, false, "back on after the batch");
  assert.deepEqual(e.state.writes, [true, false, true, false], "switched and restored inside each step");
});

await check("outside run_jsx a frame never touches rendering", () => {
  const e = es();
  vm.runInContext("__saveFrameAt(frameComp, 0, {}, 1, 'screenshot_frame');", e.ctx);
  assert.deepEqual(e.state.frames, [false]);
  assert.deepEqual(e.state.writes, []);
});

// ---------- 2. the server's record of open and timed-out calls ----------

await check("a sent call is running, a queued one is not, a timed-out one stays until the panel answers", async () => {
  let t = 1_000;
  const calls = new CallsInFlight(() => t);
  assert.equal(calls.busyWith(), null);
  let release;
  let markSent;
  const open = calls.track("_run_jsx", (sent) => { markSent = sent; return new Promise((r) => { release = r; }); });
  t = 3_000;
  assert.deepEqual(calls.busyWith(), { op: "run_jsx", state: "queued", calledAgoMs: 2_000 }, "not sent: queued, not running");
  markSent();
  t = 5_000;
  assert.deepEqual(calls.busyWith(), { op: "run_jsx", state: "sent", calledAgoMs: 4_000, sentAgoMs: 2_000 });
  release(1);
  assert.equal(await open, 1);
  assert.equal(calls.busyWith(), null, "answered: nothing outstanding");

  t = 10_000;
  await assert.rejects(calls.track("run_jsx", async (sent) => { sent(); t = 310_000; throw new BridgeTimeoutError(7777, 300_000, { op: "run_jsx" }); }));
  t = 370_000;
  assert.deepEqual(calls.busyWith(), {
    op: "run_jsx", state: "timedOut", calledAgoMs: 360_000, timedOutAgoMs: 60_000, limitMs: 300_000,
  });
  await assert.rejects(calls.track("get_project_summary", async () => { throw new BridgeTimeoutError(7777, 120_000, { op: "get_project_summary" }); }, { background: true }));
  assert.equal(calls.busyWith()?.op, "run_jsx", "a background poll's timeout does not replace the one the agent was told about");
  await assert.rejects(calls.track("get_comp", async () => { throw new Error("refused"); }));
  assert.equal(calls.busyWith()?.state, "timedOut", "a failure that is not an answer clears nothing");
  await assert.rejects(calls.track("get_comp", async () => { throw new AeError("no such comp"); }));
  assert.equal(calls.busyWith(), null, "an After Effects error is an answer: AE is free");
});

await check("busyWith names the oldest unanswered call, not one queued behind it at the panel (#272)", async () => {
  let t = 0;
  const calls = new CallsInFlight(() => t);
  // run_jsx is sent at 1s and times out at 301s; After Effects is still running it.
  await assert.rejects(calls.track("_run_jsx", async (sent) => {
    t = 1_000; sent(); t = 301_000;
    throw new BridgeTimeoutError(7777, 300_000, { op: "run_jsx" });
  }));
  // A later call is sent and is still open: it is waiting behind run_jsx in the panel.
  t = 310_000;
  let release;
  const later = calls.track("get_comp", (sent) => { sent(); return new Promise((r) => { release = r; }); });
  t = 320_000;
  assert.deepEqual(calls.busyWith(), {
    op: "run_jsx", state: "timedOut", calledAgoMs: 320_000, timedOutAgoMs: 19_000, limitMs: 300_000,
  }, "the timed-out run_jsx is what After Effects is on");
  // The later call is answered: the panel replied, so run_jsx is over too.
  release(1);
  await later;
  assert.equal(calls.busyWith(), null);

  t = 400_000;
  await assert.rejects(calls.track("run_jsx", async (sent) => { sent(); t = 700_000; throw new BridgeTimeoutError(7777, 300_000, { op: "run_jsx" }); }));
  await assert.rejects(calls.track("set_layer", async (sent) => { t = 701_000; sent(); t = 821_000; throw new BridgeTimeoutError(7777, 120_000, { op: "set_layer" }); }));
  t = 830_000;
  assert.equal(calls.busyWith()?.op, "run_jsx", "two timeouts: the first one sent is the one running");
  // An open call sent before every timed-out one is named instead.
  const calls2 = new CallsInFlight(() => t);
  let r2;
  const first = calls2.track("run_jsx", (sent) => { sent(); return new Promise((r) => { r2 = r; }); });
  t = 840_000;
  await assert.rejects(calls2.track("get_comp", async (sent) => { sent(); t = 960_000; throw new BridgeTimeoutError(7777, 120_000, { op: "get_comp" }); }));
  assert.deepEqual(calls2.busyWith(), { op: "run_jsx", state: "sent", calledAgoMs: 130_000, sentAgoMs: 130_000 });
  r2(1);
  await first;
});

await check("SessionLine says when a call leaves for the panel, and not before", async () => {
  const { SessionLine } = await import(dist("frontdesk", "line.js"));
  const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));
  const order = [];
  const bridge = { port: 7777, runOp: async () => { order.push("posted"); return 1; }, cancel: async () => ({ known: true }) };
  const line = new SessionLine(bridge, new WriteQueue(), { desk: null, sessionLabel: () => "test" });
  assert.equal(await line.runOp("get_comp", {}, { onSent: () => order.push("sent") }), 1);
  assert.deepEqual(order, ["sent", "posted"]);
});

// ---------- 3. check_setup names it ----------

async function silentPort(fn) {
  const sockets = new Set();
  const silent = http.createServer(() => { /* accepts, never answers */ });
  silent.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  try { await fn(silent.address().port); }
  finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  }
}

await check("check_setup on a busy bridge names this server's outstanding call", () => silentPort(async (port) => {
  const busy = { op: "run_jsx", state: "timedOut", calledAgoMs: 420_000, timedOutAgoMs: 120_000, limitMs: 300_000 };
  let answered = 0;
  const report = await checkSetup({
    candidates: [port], opPort: port, source: null,
    debugMode: { on: true, detail: "test" }, afterEffectsRunning: true,
    busyWith: () => busy, onPanelAnswered: () => answered++,
  });
  assert.deepEqual(report.busyWith, busy);
  const bridge = report.checks.find((c) => c.name === "bridgeReachable");
  assert.equal(bridge.ok, false);
  assert.match(bridge.detail, /`run_jsx` call .*gave up at its 5m 00s limit/);
  assert.equal(answered, 0, "a silent port is not an answer");

  const plain = await checkSetup({
    candidates: [port], opPort: port, source: null,
    debugMode: { on: true, detail: "test" }, afterEffectsRunning: true,
  });
  assert.equal(plain.busyWith, undefined, "doctor and the CLI have no calls to name");
}));

await check("only the op port answering clears the record, not a panel on a diagnostic port", async () => {
  const panel = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bundleLoaded: true }));
  });
  await new Promise((r) => panel.listen(0, "127.0.0.1", r));
  const port = panel.address().port;
  try {
    let answered = 0;
    const opts = { source: null, debugMode: { on: true, detail: "test" }, afterEffectsRunning: true, onPanelAnswered: () => answered++ };
    const elsewhere = await checkSetup({ ...opts, candidates: [port], opPort: 1 });
    assert.equal(elsewhere.checks.find((c) => c.name === "bridgeReachable").ok, true);
    assert.equal(answered, 0, "a panel answering on another port proves nothing about the op port's call");
    const here = await checkSetup({ ...opts, candidates: [port], opPort: port });
    assert.equal(here.checks.find((c) => c.name === "bridgeReachable").ok, true);
    assert.equal(answered, 1, "the op port answering does");
  } finally {
    await new Promise((r) => panel.close(r));
  }
});

await check("a busy bridge's nextSteps say what it is busy with, right after the wait step", () => {
  const ok = (name) => ({ name, ok: true, detail: "" });
  const checks = ["platform", "panelAssetsPresent", "cepDebugMode", "panelInstalled", "panelUpToDate",
    "panelDependencies", "afterEffectsRunning"].map(ok);
  checks.push({ name: "bridgeReachable", ok: false, detail: "", fix: "…" });
  const steps = withBusyStep(buildNextSteps(checks, false, true), { op: "run_jsx", state: "sent", calledAgoMs: 210_000, sentAgoMs: 200_000 });
  assert.match(steps[0], /^Wait — /);
  assert.match(steps[1], /^What it is busy with: this server's `run_jsx` call reached the panel 3m 20s ago/);
  assert.match(steps[1], /Do not re-send/);
  const queued = withBusyStep(buildNextSteps(checks, false, true), { op: "set_layer", state: "queued", calledAgoMs: 5_000 });
  assert.match(queued[1], /has not been sent yet/);
  // A broken install leads with its own remedy; the busy line is not forced in.
  const broken = checks.map((c) => (c.name === "panelDependencies" ? { ...c, ok: false, fix: "…" } : c));
  const plain = buildNextSteps(broken, false, true);
  assert.deepEqual(withBusyStep(plain, { op: "run_jsx", state: "sent", calledAgoMs: 1 }), plain);
});

console.log(`quiet-viewer: ${passed} checks passed`);
