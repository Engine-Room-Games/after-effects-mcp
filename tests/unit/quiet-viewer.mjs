// Issue #266: a heavy comp in the viewer is re-rendered after every scripted
// change to its tree (695 ms against 79 ms per added layer, AE 26.5), and a
// rebuild script went past the 300 s op limit on that alone — after which
// check_setup could say only "did not answer within 2s".
//
// Locked in here:
//   1. run_jsx parks the active viewer on an empty comp by default, reopens the
//      comp that was there and removes the parking comp — on success and on a
//      throw, through both the bundle's own run_jsx (run_batch steps) and the
//      server-built `_run_jsx`. quietViewer:false and undoGroup:false leave the
//      viewer alone; quietViewer:true with undoGroup:false is refused. The comp
//      is read from the viewer, never from a Project-panel selection, and
//      "restored" is claimed only when the viewer shows it again. viewerComp()
//      answers the user's comp while parked.
//   2. The server remembers which of its calls is open — sent or still queued —
//      and which timed out with no answer since, until the panel next answers.
//   3. check_setup names that call (`busyWith`) when the bridge is busy.
//
// The viewer re-render itself needs a live After Effects; see recipe 77 in
// docs/verification-recipes.md.
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
const shared = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { AeError, BridgeTimeoutError } = await import(dist("util", "errors.js"));
const asm = await import(dist("tools", "runJsxAssembly.js"));
const { CallsInFlight } = await import(dist("bridge", "callsInFlight.js"));
const { checkSetup, buildNextSteps, withBusyStep } = await import(dist("setup", "check.js"));
const { StrictOpSchemas } = await import(shared("schemas.js"));

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; }
  catch (e) { console.error(`quiet-viewer FAILED: ${name}`); throw e; }
}

/**
 * An ExtendScript context with a project, one composition viewer and a heavy
 * comp in it. `activeItem` follows focus as in AE: the viewer's comp while the
 * viewer has focus, the Project panel's selection while that panel does.
 */
function es({ viewerComp = true, projectFocus = false } = {}) {
  const state = { viewer: null, selection: null, focus: "viewer", items: [], nextId: 100, opened: [], undo: [] };
  class CompItem {
    constructor(id, name) { this._id = id; this._name = name; this.removed = false; }
    get id() { if (this.removed) throw new Error("Object is invalid"); return this._id; }
    get name() { if (this.removed) throw new Error("Object is invalid"); return this._name; }
    openInViewer() {
      if (this.removed) throw new Error("Object is invalid");
      state.viewer = this;
      state.focus = "viewer";
      state.opened.push(this._name);
      return {};
    }
    remove() {
      if (this.removed) throw new Error("Object is invalid");
      this.removed = true;
      state.items = state.items.filter((c) => c !== this);
      if (state.viewer === this) state.viewer = null;
    }
  }
  const heavy = new CompItem(7, "TR — Opener");
  const other = new CompItem(8, "Selected in Project panel");
  state.items.push(heavy, other);
  if (viewerComp) state.viewer = heavy;
  if (projectFocus) { state.focus = "project"; state.selection = other; }
  const ctx = {
    CompItem,
    ViewerType: { VIEWER_COMPOSITION: 1 },
    app: {
      beginUndoGroup(n) { state.undo.push(`begin ${n}`); },
      endUndoGroup() { state.undo.push("end"); },
      get activeViewer() {
        if (!state.viewer) return null;
        return { type: 1, setActive() { state.focus = "viewer"; return true; } };
      },
      project: {
        get activeItem() { return state.focus === "viewer" ? state.viewer : state.selection; },
        items: {
          addComp(name) {
            const c = new CompItem(++state.nextId, name);
            state.items.push(c);
            return c;
          },
        },
      },
    },
  };
  ctx.heavy = heavy;
  vm.createContext(ctx);
  for (const f of ["core.jsx", "snapshot.jsx", "batch.jsx", "raw.jsx", "helpers.jsx"]) {
    vm.runInContext(jsx(f), ctx, { filename: f });
  }
  const dispatch = (op, args) => JSON.parse(JSON.stringify(vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }))));
  return { state, heavy, other, dispatch };
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

const SEEN = "return app.project.activeItem ? app.project.activeItem.name : null;";
const PARK = /quiet viewer/i;

for (const [label, run] of [["bundle run_jsx", viaBundle], ["server-built _run_jsx", viaServer]]) {
  await check(`${label}: parked by default, restored after, and the answer keeps its shape`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN });
    assert.match(String(result), PARK, "the parking comp was in the viewer while the script ran");
    assert.equal(e.state.viewer, e.heavy, "the user's comp is back in the viewer");
    assert.deepEqual(e.state.items.map((c) => c.name), ["TR — Opener", "Selected in Project panel"], "the parking comp is gone");
  });

  await check(`${label}: viewerComp() is the user's comp while parked`, async () => {
    const e = es();
    const { result } = await run(e, { code: "return [viewerComp().id, app.project.activeItem.id === viewerComp().id];" });
    assert.deepEqual(result, [7, false]);
  });

  await check(`${label}: quietViewer:true reports what it did`, async () => {
    const e = es();
    const { result } = await run(e, { code: "return 1;", quietViewer: true });
    assert.equal(result.returned, 1);
    assert.deepEqual(result.quietViewer, { parked: true, restored: true, compId: 7 });
  });

  await check(`${label}: quietViewer:false leaves the viewer alone`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN, quietViewer: false });
    assert.equal(result, "TR — Opener");
    assert.deepEqual(e.state.opened, [], "nothing was opened");
  });

  await check(`${label}: undoGroup:false leaves the viewer alone by itself`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN, undoGroup: false });
    assert.equal(result, "TR — Opener");
    assert.deepEqual(e.state.opened, []);
  });

  await check(`${label}: quietViewer:true with undoGroup:false is refused before anything runs`, async () => {
    const e = es();
    const { err } = await run(e, { code: "heavy.remove(); return 1;", quietViewer: true, undoGroup: false });
    assert.match(err, /cannot be combined with undoGroup: false/);
    assert.equal(e.heavy.removed, false, "the script did not run");
    assert.deepEqual(e.state.opened, []);
  });

  await check(`${label}: a script that throws still gets the viewer back`, async () => {
    const e = es();
    const { err } = await run(e, { code: "throw new Error('boom');" });
    assert.match(err, /boom/);
    assert.equal(e.state.viewer, e.heavy);
    assert.equal(e.state.items.length, 2, "no parking comp left behind");
  });

  await check(`${label}: a comp the script removed is reported, never claimed restored`, async () => {
    const e = es();
    const { result } = await run(e, { code: "heavy.remove(); return 1;" });
    assert.equal(result.returned, 1, "a note wraps the answer even by default");
    assert.equal(result.quietViewer.parked, true);
    assert.equal(result.quietViewer.restored, false);
    assert.match(result.quietViewer.note, /no longer exists/);
    assert.equal(e.state.items.length, 1, "the parking comp is removed anyway");
  });

  await check(`${label}: a parking comp the script removed itself is not the user's to delete`, async () => {
    const e = es();
    const { result } = await run(e, { code: "app.project.activeItem.remove(); return 1;" });
    assert.equal(result, 1, "nothing to report: the viewer is back and nothing is left over");
    assert.equal(e.state.viewer, e.heavy);
  });

  await check(`${label}: a Project-panel selection is not what gets parked or reopened`, async () => {
    const e = es({ projectFocus: true });
    const { result } = await run(e, { code: "return viewerComp().id;", quietViewer: true });
    assert.equal(result.returned, 7, "the viewer's comp, not the selected one");
    assert.equal(result.quietViewer.compId, 7);
    assert.equal(e.state.viewer, e.heavy);
    assert.ok(!e.state.opened.includes("Selected in Project panel"), "the selection was never opened");
  });

  await check(`${label}: nothing in the viewer, nothing parked`, async () => {
    const e = es({ viewerComp: false });
    const { result } = await run(e, { code: "return 2;" });
    assert.equal(result, 2);
    assert.equal(e.state.items.length, 2);
    const asked = await run(es({ viewerComp: false }), { code: "return 2;", quietViewer: true });
    assert.equal(asked.result.quietViewer.parked, false);
    assert.match(asked.result.quietViewer.note, /nothing to park/);
  });

  await check(`${label}: a reopen the viewer does not show is not claimed restored`, async () => {
    const e = es();
    // The script leaves the parking comp's viewer in a state where reopening
    // does not land: openInViewer on the user's comp becomes a no-op.
    const { result } = await run(e, { code: "heavy.openInViewer = function () { return {}; }; return 1;" });
    assert.equal(result.quietViewer.restored, false);
    assert.match(result.quietViewer.note, /does not show it/);
  });

  await check(`${label}: withoutUndoGroup() inside a parked run carries a CAUTION`, async () => {
    const e = es();
    const { result } = await run(e, { code: "withoutUndoGroup(function () {}); return 1;" });
    assert.equal(result.returned, 1);
    assert.match(result.quietViewer.note, /CAUTION: the script split its undo step/);
    assert.equal(e.state.viewer, e.heavy);
  });
}

await check("a run_batch run_jsx step follows the same default", () => {
  const e = es();
  const out = e.dispatch("run_batch", { ops: [{ op: "run_jsx", args: { code: SEEN } }, { op: "run_jsx", args: { code: SEEN, quietViewer: false } }] });
  assert.ok(out.ok, out.error);
  assert.match(String(out.result.results[0]), PARK);
  assert.equal(out.result.results[1], "TR — Opener");
  assert.equal(e.state.viewer, e.heavy);
  assert.equal(e.state.items.length, 2);
});

await check("the schema refuses quietViewer:true with undoGroup:false, and only that", () => {
  const S = StrictOpSchemas.run_jsx;
  assert.equal(S.safeParse({ code: "1", quietViewer: true, undoGroup: false }).success, false);
  assert.match(S.safeParse({ code: "1", quietViewer: true, undoGroup: false }).error.message, /cannot be combined/);
  for (const ok of [{}, { undoGroup: false }, { quietViewer: false, undoGroup: false }, { quietViewer: true }, { quietViewer: true, undoGroup: true }]) {
    assert.equal(S.safeParse({ code: "1", ...ok }).success, true, JSON.stringify(ok));
  }
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
