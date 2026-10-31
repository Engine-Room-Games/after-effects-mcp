// Issue #266: a heavy comp in the viewer is re-rendered after every scripted
// change to its tree (695 ms against 79 ms per added layer, AE 26.5), and a
// rebuild script went past the 300 s op limit on that alone — after which
// check_setup could say only "did not answer within 2s".
//
// Locked in here:
//   1. run_jsx's `quietViewer: true` parks the viewer on an empty comp for the
//      script, reopens the comp that was there and removes the parking comp —
//      on success and on a throw, through both the bundle's own run_jsx and the
//      server-built `_run_jsx` — and says so on the answer. Off, nothing moves.
//   2. The server remembers which of its calls is open, and which timed out
//      with no answer since, until the panel next answers.
//   3. check_setup names that call (`busyWith`) when the bridge is busy.
//
// The viewer re-render itself needs a live After Effects; see recipe 77 in docs/verification-recipes.md.
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

/** An ExtendScript context with a project, a viewer and one heavy comp in it. */
function es({ viewerComp = true } = {}) {
  const state = { active: null, items: [], nextId: 100, opened: [] };
  class CompItem {
    constructor(id, name) { this.id = id; this.name = name; this.removed = false; }
    openInViewer() {
      if (this.removed) throw new Error("Object is invalid");
      state.active = this;
      state.opened.push(this.name);
      return {};
    }
    remove() {
      if (this.removed) throw new Error("Object is invalid");
      this.removed = true;
      state.items = state.items.filter((c) => c !== this);
      if (state.active === this) state.active = null;
    }
  }
  const heavy = new CompItem(7, "TR — Opener");
  state.items.push(heavy);
  if (viewerComp) state.active = heavy;
  const ctx = {
    CompItem,
    ViewerType: { VIEWER_COMPOSITION: 1 },
    app: {
      beginUndoGroup() {},
      endUndoGroup() {},
      activeViewer: null,
      project: {
        get activeItem() { return state.active; },
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
  for (const f of ["core.jsx", "snapshot.jsx", "raw.jsx"]) vm.runInContext(jsx(f), ctx, { filename: f });
  const dispatch = (op, args) => JSON.parse(JSON.stringify(vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }))));
  return { state, heavy, dispatch };
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

for (const [label, run] of [["bundle run_jsx", viaBundle], ["server-built _run_jsx", viaServer]]) {
  await check(`${label}: quietViewer parks during the script and restores after`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN, quietViewer: true });
    assert.ok(result, "the call succeeded");
    assert.notEqual(result.returned, "TR — Opener", "the heavy comp was not in the viewer while the script ran");
    assert.match(String(result.returned), /quiet viewer/i, "the parking comp was");
    assert.equal(e.state.active, e.heavy, "the user's comp is back in the viewer");
    assert.deepEqual(e.state.items.map((c) => c.name), ["TR — Opener"], "the parking comp is gone");
    assert.deepEqual(result.quietViewer, { parked: true, restored: true, compId: 7 });
  });

  await check(`${label}: a script that throws still gets the viewer back`, async () => {
    const e = es();
    const { err } = await run(e, { code: "throw new Error('boom');", quietViewer: true });
    assert.match(err, /boom/);
    assert.equal(e.state.active, e.heavy);
    assert.equal(e.state.items.length, 1, "no parking comp left behind");
  });

  await check(`${label}: a comp the script removed is reported, never claimed restored`, async () => {
    const e = es();
    const { result } = await run(e, { code: "heavy.remove(); return 1;", quietViewer: true });
    assert.equal(result.quietViewer.parked, true);
    assert.equal(result.quietViewer.restored, false);
    assert.match(result.quietViewer.note, /could not be reopened/);
    assert.equal(result.returned, 1);
    assert.equal(e.state.items.length, 0, "the parking comp is removed anyway");
  });

  await check(`${label}: nothing in the viewer means nothing parked, and says so`, async () => {
    const e = es({ viewerComp: false });
    const { result } = await run(e, { code: "return 2;", quietViewer: true });
    assert.equal(result.returned, 2);
    assert.equal(result.quietViewer.parked, false);
    assert.match(result.quietViewer.note, /nothing to park/);
    assert.equal(e.state.items.length, 1);
  });

  await check(`${label}: without quietViewer the viewer is left alone`, async () => {
    const e = es();
    const { result } = await run(e, { code: SEEN });
    assert.equal(result, "TR — Opener");
    assert.deepEqual(e.state.opened, [], "nothing was opened");
  });
}

// ---------- 2. the server's record of open and timed-out calls ----------

await check("an open call is reported as waiting, a timed-out one until the panel answers", async () => {
  let t = 1_000;
  const calls = new CallsInFlight(() => t);
  assert.equal(calls.busyWith(), null);
  let release;
  const open = calls.track("_run_jsx", () => new Promise((r) => { release = r; }));
  t = 5_000;
  assert.deepEqual(calls.busyWith(), { op: "run_jsx", state: "waiting", calledAgoMs: 4_000 });
  release(1);
  assert.equal(await open, 1);
  assert.equal(calls.busyWith(), null, "answered: nothing outstanding");

  t = 10_000;
  await assert.rejects(calls.track("run_jsx", async () => { t = 310_000; throw new BridgeTimeoutError(7777, 300_000, { op: "run_jsx" }); }));
  t = 370_000;
  assert.deepEqual(calls.busyWith(), {
    op: "run_jsx", state: "timedOut", calledAgoMs: 360_000, timedOutAgoMs: 60_000, limitMs: 300_000,
  });
  await assert.rejects(calls.track("get_comp", async () => { throw new Error("refused"); }));
  assert.equal(calls.busyWith()?.state, "timedOut", "a failure that is not an answer clears nothing");
  await assert.rejects(calls.track("get_comp", async () => { throw new AeError("no such comp"); }));
  assert.equal(calls.busyWith(), null, "an After Effects error is an answer: AE is free");
});

// ---------- 3. check_setup names it ----------

await check("check_setup on a busy bridge names this server's outstanding call", async () => {
  const sockets = new Set();
  const silent = http.createServer(() => { /* accepts, never answers */ });
  silent.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const port = silent.address().port;
  try {
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
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  }
});

await check("a busy bridge's nextSteps say what it is busy with, right after the wait step", async () => {
  const ok = (name) => ({ name, ok: true, detail: "" });
  const checks = ["platform", "panelAssetsPresent", "cepDebugMode", "panelInstalled", "panelUpToDate",
    "panelDependencies", "afterEffectsRunning"].map(ok);
  checks.push({ name: "bridgeReachable", ok: false, detail: "", fix: "…" });
  const steps = withBusyStep(buildNextSteps(checks, false, true), { op: "run_jsx", state: "waiting", calledAgoMs: 200_000 });
  assert.match(steps[0], /^Wait — /);
  assert.match(steps[1], /^What it is busy with: this server's `run_jsx` call was made 3m 20s ago/);
  assert.match(steps[1], /Do not re-send/);
  // A broken install leads with its own remedy; the busy line is not forced in.
  const broken = checks.map((c) => (c.name === "panelDependencies" ? { ...c, ok: false, fix: "…" } : c));
  const plain = buildNextSteps(broken, false, true);
  assert.deepEqual(withBusyStep(plain, { op: "run_jsx", state: "waiting", calledAgoMs: 1 }), plain);
});

console.log(`quiet-viewer: ${passed} checks passed`);
