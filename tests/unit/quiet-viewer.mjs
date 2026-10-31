// Issue #266: with a heavy comp in the viewer, every change a script makes
// re-runs that comp's expressions on After Effects' main thread — measured on
// 26.5, a run_jsx making 1 / 3 / 20 changes cost 3.7 s / 11.1 s / 74 s — and a
// rebuild script went past the 300 s op limit on that alone, after which
// check_setup could say only "did not answer within 2s".
//
// Locked in here:
//   1. The viewer is parked by the SERVER, in a call of its own before the
//      script, and put back in a call of its own after it — three calls under
//      the one write lease, so nothing else lands between them (a swap from
//      inside the script's own evalScript takes effect only after it ends).
//      The parking comp is ONE persistent tagged comp, created once in its own
//      undo step and reused, so a park and an unpark are pure view changes:
//      no undo step, no item added or removed per call. It parks only when
//      the viewed comp has an enabled expression of its own; respects a comp
//      the script opened itself; says when the comp could not be put back;
//      lets a nested run_jsx see the user's comp through viewerComp(); and an
//      interrupted park is taken over by the next park, by this session's next
//      write, or by check_setup. The parking comp is hidden from list_comps,
//      get_project_summary and find_layers, and never answers as the active comp.
//   2. The server remembers which of its calls is open — sent or still queued —
//      and which timed out with no answer since, until the panel next answers,
//      and names the oldest one sent (#272).
//   3. check_setup names that call (`busyWith`) when the bridge is busy.
//
// What a park saves, whether openInViewer is ever an undo step, and whether it
// marks the project changed need a live After Effects; see recipe 77 in
// docs/verification-recipes.md.
//
//   node tests/unit/quiet-viewer.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsx = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { AeError, BridgeTimeoutError, WriteQueueWaitError, ScriptNotSentError } = await import(dist("util", "errors.js"));
const asm = await import(dist("tools", "runJsxAssembly.js"));
const park = await import(dist("tools", "viewerPark.js"));
const { CallsInFlight } = await import(dist("bridge", "callsInFlight.js"));
const { checkSetup, buildNextSteps, withBusyStep } = await import(dist("setup", "check.js"));
const { sourceBundleHash, sourceClientHash } = await import(dist("setup", "panelVersion.js"));

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; }
  catch (e) { console.error(`quiet-viewer FAILED: ${name}`); throw e; }
}

// ---------- 1. the park, in ExtendScript (packages/jsx/viewer.jsx) ----------

/**
 * A project with a heavy comp in the viewer. `expressions` is how many enabled
 * expressions its own layers carry; `nested` puts one only inside a precomp
 * layer's source (which the measurement says costs nothing). The viewer swap
 * is modelled the way it was measured: openInViewer() takes effect when the
 * evalScript ends, which `call()` does.
 */
function es({ expressions = 1, nested = false, disabledLayer = false, viewer = true } = {}) {
  // panelFocus: the Project panel has focus, so activeItem is its selection (panelItem), not the viewer's comp.
  const state = { undo: [], opened: [], view: null, pending: null, changes: 0, panelFocus: false, panelItem: null };
  const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
  const ViewerType = { VIEWER_COMPOSITION: 1, VIEWER_LAYER: 2 };
  let nextId = 1;
  class FolderItem {
    constructor(name) { this.id = nextId++; this.name = name; this.children = []; this.comment = ""; }
    get numItems() { return this.children.length; }
    item(i) { return this.children[i - 1]; }
  }
  class FootageItem {}
  const root = new FolderItem("Root");
  class CompItem {
    constructor(name, layers = []) {
      this.id = nextId++; this.name = name; this.comment = ""; this._layers = layers; this._folder = root;
      this.displayStartTime = 0; this.motionBlur = false; this.frameBlending = false;
      this.width = 16; this.height = 16; this.pixelAspect = 1; this.duration = 1; this.frameRate = 1;
      this.workAreaStart = 0; this.workAreaDuration = 1; this.bgColor = [0, 0, 0]; this.markerProperty = { numKeys: 0 };
    }
    get numLayers() { return this._layers.length; }
    layer(i) { return this._layers[i - 1]; }
    openInViewer() { state.opened.push(this.name); state.pending = this; }
    get parentFolder() { return this._folder; }
    set parentFolder(f) { this._folder = f; f.children.push(this); state.changes++; }
  }
  const prop = (on) => ({ propertyType: PropertyType.PROPERTY, canSetExpression: true, expressionEnabled: on, expression: on ? "wiggle(2, 20)" : "" });
  const group = (props) => ({ propertyType: PropertyType.NAMED_GROUP, matchName: "ADBE Transform Group", enabled: true,
    get numProperties() { return props.length; }, property(i) { return props[i - 1]; } });
  const layer = (name, props, enabled = true) => ({ name, enabled, id: nextId++,
    get numProperties() { return props.length; }, property(i) { return props[i - 1]; } });
  const items = [];
  const inner = new CompItem("Inner", [layer("deep", [group([prop(true)])])]);
  const layers = [layer("plain", [group([prop(false), prop(false)])])];
  for (let i = 0; i < expressions; i++) layers.push(layer(`expr ${i}`, [group([prop(true)])], !disabledLayer));
  if (nested) layers.push(layer("precomp", [group([prop(false)])]));
  const heavy = new CompItem("TR — Opener", layers);
  const other = new CompItem("Other", []);
  items.push(inner, heavy, other);
  state.view = viewer ? heavy : null;
  const project = {
    get numItems() { return items.length; },
    item(i) { return items[i - 1]; },
    itemByID(id) { const it = items.find((x) => x.id === id); if (!it) throw new Error("internal verification failure, sorry! {Item Not Found}"); return it; },
    get activeItem() { return state.panelFocus ? state.panelItem : state.view; },
    file: null,
    rootFolder: root,
    items: {
      addComp(name) { const c = new CompItem(name); items.push(c); state.changes++; return c; },
      addFolder(name) { const f = new FolderItem(name); items.push(f); state.changes++; return f; },
    },
  };
  const app = {
    project,
    beginUndoGroup(n) { state.undo.push(`begin ${n}`); },
    endUndoGroup() { state.undo.push("end"); },
    get activeViewer() {
      return state.view ? { type: ViewerType.VIEWER_COMPOSITION, get active() { return !state.panelFocus; },
        setActive() { state.panelFocus = false; return true; } } : null;
    },
  };
  const ctx = { app, PropertyType, ViewerType, CompItem, FolderItem, FootageItem, File: function (p) { this.path = p; },
    TextLayer: class {}, ShapeLayer: class {}, AVLayer: class {}, CameraLayer: class {}, LightLayer: class {} };
  vm.createContext(ctx);
  for (const f of ["core.jsx", "ids.jsx", "viewer.jsx", "comps.jsx", "layers.jsx", "snapshot.jsx", "checkpoint.jsx",
    "batch.jsx", "explore.jsx", "selection.jsx", "helpers.jsx", "raw.jsx"]) {
    vm.runInContext(jsx(f), ctx, { filename: f });
  }
  const call = (op, args = {}) => {
    const out = JSON.parse(JSON.stringify(vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }))));
    // The measured rule: a viewer swap lands once the evalScript has ended.
    if (state.pending) { state.view = state.pending; state.pending = null; }
    return out;
  };
  return { ctx, state, heavy, other, items, call };
}

await check("a park is a call of its own: it opens the parking comp, and only the NEXT call sees it in the viewer", () => {
  const e = es();
  const p = e.call("_viewer_park");
  assert.equal(p.ok, true, p.error);
  assert.equal(p.result.parked, true);
  assert.equal(p.result.compId, e.heavy.id);
  assert.equal(p.result.created, true, "made the first time");
  assert.match(e.state.view.name, /^AE MCP viewer parking/);
  // The script's own call: activeItem is the parking comp; viewerComp() is the user's.
  const s = e.call("run_jsx", { code: "return [app.project.activeItem.name, viewerComp().name];" });
  assert.equal(s.ok, true, s.error);
  assert.match(s.result[0], /^AE MCP viewer parking/);
  assert.equal(s.result[1], "TR — Opener");
  const u = e.call("_viewer_unpark");
  // Reopened, not "restored": the swap lands after the call, so it cannot be seen yet.
  assert.deepEqual([u.result.unparked, u.result.reopened, u.result.restored, u.result.compId], [true, true, false, e.heavy.id]);
  assert.equal(e.state.view, e.heavy, "the user's comp is back in the viewer");
});

await check("the parking comp is made once, in its own undo step, and reused: later parks are pure view changes", () => {
  const e = es();
  e.call("_viewer_park");
  e.call("_viewer_unpark");
  assert.deepEqual(e.state.undo, ["begin AE MCP: create viewer parking comp", "end"]);
  const madeChanges = e.state.changes;
  const madeItems = e.items.length;
  for (let i = 0; i < 3; i++) {
    const p = e.call("_viewer_park");
    assert.equal(p.result.parked, true);
    assert.equal(p.result.created, undefined, "not made again");
    e.call("run_jsx", { code: "app.project.items.addComp('built'); return 1;" });
    e.call("_viewer_unpark");
  }
  // The only undo steps after the first park are the scripts' own, so Cmd-Z
  // after a run undoes the script — never the parking comp.
  assert.deepEqual(e.state.undo.slice(2), Array(3).fill(["begin AE MCP: run_jsx", "end"]).flat());
  assert.equal(e.items.length, madeItems + 3, "only the scripts' comps were added");
  assert.equal(e.state.changes, madeChanges + 3, "park and unpark changed nothing in the project");
  const tagged = e.items.filter((it) => String(it.comment).startsWith("ae-mcp-viewer-parking:v1"));
  assert.equal(tagged.length, 1, "one parking comp, however many runs");
  assert.equal(tagged[0].parentFolder.name, "Root", "no folder: two fewer project changes, and none left behind empty");
});

await check("a leftover parking comp (from a crash, or a project saved with it) is found by its tag and reused", () => {
  const e = es();
  e.call("_viewer_park");
  e.call("_viewer_unpark");
  // A fresh bundle — the panel reloaded, or After Effects restarted — knows nothing.
  vm.runInContext("__PARK_ID = null; __PARK = null; __PARK_LAST = null;", e.ctx);
  const p = e.call("_viewer_park");
  assert.equal(p.result.parked, true);
  assert.equal(p.result.created, undefined, "the comp already in the project is reused");
});

await check("no park when it cannot pay off: no expression of the viewed comp's own, or only a disabled layer's, or nothing in view", () => {
  for (const [label, opts] of [["no expressions", { expressions: 0 }], ["only in a precomp", { expressions: 0, nested: true }],
    ["only on a disabled layer", { disabledLayer: true }]]) {
    const e = es(opts);
    const p = e.call("_viewer_park");
    assert.equal(p.result.parked, false, label);
    assert.equal(p.result.skipped, "no-expressions", label);
    assert.deepEqual(e.state.opened, [], `${label}: the viewer was not touched`);
    assert.equal(e.state.changes, 0, `${label}: nothing was created`);
    assert.deepEqual(e.call("_viewer_unpark").result, { unparked: false }, `${label}: an unpark finds nothing to do`);
  }
  const none = es({ viewer: false });
  assert.equal(none.call("_viewer_park").result.skipped, "no-comp-in-viewer");
});

await check("a comp the script opened in the viewer itself is left there, and the answer says which", () => {
  const e = es();
  e.call("_viewer_park");
  e.call("run_jsx", { code: `compById(${e.other.id}).openInViewer(); return 1;` });
  const u = e.call("_viewer_unpark").result;
  assert.equal(u.restored, false);
  assert.deepEqual(u.viewerComp, { id: e.other.id, name: "Other" });
  assert.match(u.note, /the script opened comp \d+ \("Other"\)/);
  assert.equal(e.state.view, e.other, "the script's choice stands");
  // OPS.set_active_comp from a script is the same choice.
  const f = es();
  f.call("_viewer_park");
  f.call("run_jsx", { code: `return OPS.set_active_comp({compId: ${f.other.id}});` });
  assert.equal(f.call("_viewer_unpark").result.viewerComp.name, "Other");
});

await check("a comp the script removed cannot be put back, and that is said — never a quiet success", () => {
  const e = es();
  e.call("_viewer_park");
  e.items.splice(e.items.indexOf(e.heavy), 1);
  const u = e.call("_viewer_unpark").result;
  assert.equal(u.unparked, true);
  assert.equal(u.restored, false);
  assert.match(u.note, /no longer exists — the script removed it/);
});

await check("a nested run_jsx parks nothing and still sees the user's comp through viewerComp()", () => {
  const e = es();
  e.call("_viewer_park");
  const opened = e.state.opened.length;
  const s = e.call("run_jsx", { code: "var r = OPS.run_jsx({code: 'return viewerComp().name;'}); return r;" });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.result, "TR — Opener");
  assert.equal(e.state.opened.length, opened, "nothing was opened from inside the script");
});

await check("an interrupted park is taken over by the next one, which reopens the user's comp after its script", () => {
  const e = es();
  e.call("_viewer_park");
  e.call("run_jsx", { code: "return 1;" });
  // The server died (or the script timed out): no unpark ever came.
  const p = e.call("_viewer_park").result;
  assert.equal(p.parked, true);
  assert.deepEqual(p.recovered, { compId: e.heavy.id, compName: "TR — Opener" });
  assert.equal(p.compId, e.heavy.id, "the comp to go back to is the user's, not the parking comp");
  const u = e.call("_viewer_unpark").result;
  assert.equal(u.reopened, true);
  assert.equal(e.state.view, e.heavy);
});

await check("check_setup's recover reopens a comp an unpark could not, and is a no-op otherwise", () => {
  const e = es();
  assert.deepEqual(e.call("_viewer_unpark", { recover: true }).result, { unparked: false });
  e.call("_viewer_park");
  assert.equal(e.call("_viewer_unpark", { recover: true }).result.reopened, true, "a park still in force is undone");
  assert.equal(e.state.view, e.heavy);
});

await check("while parked, the parking comp is never the user's comp to a read, and is hidden from the project lists", () => {
  const e = es();
  e.call("_viewer_park");
  const comps = e.call("list_comps").result;
  assert.equal(comps.some((c) => /parking/.test(c.name)), false, "list_comps leaves it out");
  const sum = e.call("get_project_summary").result;
  assert.equal(sum.activeItemId, e.heavy.id, "the active item is the comp it replaced");
  assert.equal(sum.items.some((it) => /parking|^AE MCP$/.test(it.name)), false);
  assert.equal(sum.aeMcpItemsHidden, 1, "what was left out is counted");
  assert.equal(sum.numItems, e.items.length);
  const probe = e.call("_live_probe").result;
  assert.equal(probe.activeItemId, e.heavy.id, "the live resource does not flip to the parking comp");
  const fl = e.call("find_layers", {});
  assert.equal(fl.ok, true, fl.error);
  assert.equal(JSON.stringify(fl.result).includes("parking"), false);
  // diff:true with no compId fingerprints the user's comp, not the parking comp.
  assert.deepEqual(Array.from(vm.runInContext("__diffCompIds({diff: true}, null)", e.ctx)), [e.heavy.id]);
});

await check("a script that wrote into the parking comp: a CAUTION names what landed, and the comp is never reused or hidden", () => {
  const e = es();
  e.call("_viewer_park");
  // The old habit, through a name the server's scan cannot see.
  const s1 = e.call("run_jsx", { code: "var p = app.project['active' + 'Item']; p._layers.push({name: 'Title', id: 99}); return 1;" });
  assert.equal(s1.ok, true, s1.error);
  const parking = e.items.find((it) => String(it.comment).startsWith("ae-mcp-viewer-parking:v1"));
  const u = e.call("_viewer_unpark").result;
  assert.equal(u.reopened, true);
  assert.match(u.caution, /^CAUTION: 1 layer\(s\) \("Title"\) landed in AE MCP's parking comp/);
  assert.match(u.caution, /viewerComp\(\)/);
  // What landed there is the user's now: listed, and the next park makes a fresh comp.
  assert.equal(e.call("list_comps").result.some((c) => c.id === parking.id), true, "a dirty parking comp is not hidden");
  const p2 = e.call("_viewer_park").result;
  assert.equal(p2.created, true, "a dirty parking comp is never reused");
  assert.notEqual(e.state.view.id, parking.id);
});

await check("viewerComp() does not trust a park an interrupted call left once the user is back in a comp of their own", () => {
  const e = es();
  e.call("_viewer_park");
  // No unpark ever came; the user opened Other by hand.
  e.state.view = e.other;
  const s1 = e.call("run_jsx", { code: "return viewerComp().name;" });
  assert.equal(s1.result, "Other");
  assert.equal(e.call("get_project_summary").result.activeItemId, e.other.id);
});

await check("a dry-run park says whether parking would pay off and opens nothing; it undoes a park an interrupted call left", () => {
  const e = es();
  const d = e.call("_viewer_park", { dryRun: true }).result;
  assert.deepEqual([d.parked, d.wouldPark, d.compId], [false, true, e.heavy.id]);
  assert.deepEqual(e.state.opened, []);
  assert.equal(e.state.changes, 0, "and creates nothing");
  assert.equal(es({ expressions: 0 }).call("_viewer_park", { dryRun: true }).result.wouldPark, undefined);
  // Left parked, then a script that reads activeItem: the dry run puts the user's comp back first.
  e.call("_viewer_park");
  const again = e.call("_viewer_park", { dryRun: true }).result;
  assert.deepEqual(again.recovered, { compId: e.heavy.id, compName: "TR — Opener" });
  assert.equal(e.state.view, e.heavy, "the script that reads activeItem gets the user's comp");
});

await check("an unpark knows its own park by token: one another call ended is named, never taken for a reload (#277)", () => {
  // Another call's park took it over (two sessions with the front desk off).
  const e = es();
  const a = e.call("_viewer_park").result;
  assert.equal(typeof a.token, "number", "a park answers its token");
  const b = e.call("_viewer_park").result;
  assert.deepEqual(b.recovered, { compId: e.heavy.id, compName: "TR — Opener" });
  assert.notEqual(b.token, a.token);
  assert.deepEqual(e.call("_viewer_unpark", { token: a.token }).result, { unparked: false, takenBy: "park", reopened: false });
  assert.notEqual(e.state.view, e.heavy, "the other call's park is left alone: its own unpark reopens the comp");
  const ub = e.call("_viewer_unpark", { token: b.token }).result;
  assert.equal(ub.reopened, true);
  assert.equal(e.state.view, e.heavy);
  // A dry run before a script that reads activeItem undid it — and did reopen the comp.
  const d = es();
  const p1 = d.call("_viewer_park").result;
  d.call("_viewer_park", { dryRun: true });
  assert.deepEqual(d.call("_viewer_unpark", { token: p1.token }).result, { unparked: false, takenBy: "dry-run", reopened: true });
  // check_setup (or a session's next write) recovered it, reopening the comp.
  const r = es();
  const p2 = r.call("_viewer_park").result;
  assert.equal(r.call("_viewer_unpark", { recover: true }).result.reopened, true);
  assert.deepEqual(r.call("_viewer_unpark", { token: p2.token }).result, { unparked: false, takenBy: "recover", reopened: true });
  // A token nobody ended (the bundle was reloaded since): no cause is made up.
  assert.deepEqual(es().call("_viewer_unpark", { token: 12345 }).result, { unparked: false });
  // The park's own unpark with its token is the ordinary one.
  const o = es();
  const p3 = o.call("_viewer_park").result;
  assert.equal(o.call("_viewer_unpark", { token: p3.token }).result.reopened, true);
});

await check("review #1: a park that skipped records that it forgot the park and reopened nothing, never a takeover", () => {
  // A parks; A's script opens a comp with no expressions; B's park skips.
  const e = es();
  const a = e.call("_viewer_park").result;
  e.call("run_jsx", { code: "compById(" + e.other.id + ").openInViewer(); return 1;" });
  assert.equal(e.state.view, e.other);
  const b = e.call("_viewer_park").result;
  assert.equal(b.skipped, "no-expressions");
  const u = e.call("_viewer_unpark", { token: a.token }).result;
  assert.equal(u.takenBy, "dropped");
  assert.equal(u.reopened, false);
  assert.match(u.why, /the viewer was showing comp \d+ \("Other"\) by then, not the parking comp/);
  assert.equal(e.state.view, e.other, "nothing was reopened, and nothing is");
  // The same through a dry run: no reopen claimed when none happened.
  const d = es();
  const pd = d.call("_viewer_park").result;
  d.call("run_jsx", { code: "compById(" + d.other.id + ").openInViewer(); return 1;" });
  d.call("_viewer_park", { dryRun: true });
  const ud = d.call("_viewer_unpark", { token: pd.token }).result;
  assert.deepEqual([ud.takenBy, ud.reopened, ud.dryRun], ["dropped", false, true], "said as a dry run's doing (round 2)");
  // A real park's skip is not marked as a dry run.
  const e2 = es();
  const pa2 = e2.call("_viewer_park").result;
  e2.call("run_jsx", { code: "compById(" + e2.other.id + ").openInViewer(); return 1;" });
  e2.call("_viewer_park");
  assert.equal(e2.call("_viewer_unpark", { token: pa2.token }).result.dryRun, undefined);
  // A dry run whose reopen threw says it did not reopen.
  const f = es();
  const pf = f.call("_viewer_park").result;
  f.heavy.openInViewer = () => { throw new Error("nope"); };
  f.call("_viewer_park", { dryRun: true });
  assert.deepEqual(f.call("_viewer_unpark", { token: pf.token }).result, { unparked: false, takenBy: "dry-run", reopened: false });
  // A recover that found the parking comp written into reopened nothing, and says why.
  const w = es();
  const pw = w.call("_viewer_park").result;
  w.call("run_jsx", { code: "var p = app.project['active' + 'Item']; p._layers.push({name: 'Title', id: 99}); return 1;" });
  w.call("_viewer_unpark", { recover: true });
  const uw = w.call("_viewer_unpark", { token: pw.token }).result;
  assert.deepEqual([uw.takenBy, uw.reopened], ["recover", false]);
  assert.match(uw.why, /written into/);
});

await check("round 2: a token-less unpark that found the user's comp already back says it is in view, not 'not reopened'", () => {
  const e = es();
  const a = e.call("_viewer_park").result;
  // The script put the user's comp back itself.
  e.call("run_jsx", { code: "compById(" + e.heavy.id + ").openInViewer(); return 1;" });
  assert.equal(e.state.view, e.heavy);
  e.call("_viewer_unpark");
  const u = e.call("_viewer_unpark", { token: a.token }).result;
  assert.deepEqual([u.takenBy, u.reopened, u.restored, u.why], ["unpark", false, true, undefined]);
});

await check("round 3: a park forgotten with the user's comp already back is restored; re-parked by the other call it says so", () => {
  // A parks; A's script puts the user's comp back itself; B parks that comp.
  const e = es();
  const a = e.call("_viewer_park").result;
  e.call("run_jsx", { code: "compById(" + e.heavy.id + ").openInViewer(); return 1;" });
  assert.equal(e.state.view, e.heavy);
  assert.equal(e.call("_viewer_park").result.parked, true);
  const u = e.call("_viewer_unpark", { token: a.token }).result;
  assert.deepEqual([u.takenBy, u.restored, u.reparked], ["dropped", true, true]);
  // The same comp with no expressions left: B skips, the comp stays in view.
  const d = es();
  const pd = d.call("_viewer_park").result;
  d.call("run_jsx", { code: "compById(" + d.heavy.id + ").openInViewer(); return 1;" });
  d.heavy._layers.length = 1; // the expression layers removed meanwhile
  assert.equal(d.call("_viewer_park").result.skipped, "no-expressions");
  const ud = d.call("_viewer_unpark", { token: pd.token }).result;
  assert.deepEqual([ud.takenBy, ud.restored, ud.reparked], ["dropped", true, undefined]);
  // A different comp in view is not restored.
  const o = es();
  const po = o.call("_viewer_park").result;
  o.call("run_jsx", { code: "compById(" + o.other.id + ").openInViewer(); return 1;" });
  o.call("_viewer_park");
  assert.equal(o.call("_viewer_unpark", { token: po.token }).result.restored, undefined);
});

await check("review #2: an unpark sent without a token records that it ended another call's park", () => {
  const e = es();
  const a = e.call("_viewer_park").result;
  // Another call whose own park answer was lost unparks without a token.
  assert.equal(e.call("_viewer_unpark").result.reopened, true);
  assert.deepEqual(e.call("_viewer_unpark", { token: a.token }).result, { unparked: false, takenBy: "unpark", reopened: true });
});

await check("_viewer_parked is a read that says whether a park is in force", () => {
  const e = es();
  assert.equal(e.call("_viewer_parked").result.parked, false);
  e.call("_viewer_park");
  assert.equal(e.call("_viewer_parked").result.parked, true);
  e.call("_viewer_unpark");
  assert.equal(e.call("_viewer_parked").result.parked, false);
});

await check("a Project-panel selection is never taken for the viewer's comp: the park focuses the viewer to ask it", () => {
  const e = es();
  e.state.panelFocus = true;
  e.state.panelItem = e.other; // a comp selected in the Project panel, not in view
  const p = e.call("_viewer_park").result;
  assert.equal(p.parked, true);
  assert.equal(p.compId, e.heavy.id, "the comp in the viewer, not the panel's selection");
  e.call("_viewer_unpark");
  assert.equal(e.state.view, e.heavy, "and the one reopened is the one that was in view");
});

await check("get_selection, with the Project panel focused while parked, names the user's comp, not the parking comp", () => {
  const e = es();
  e.call("_viewer_park");
  e.state.panelFocus = true;
  e.state.panelItem = null;
  const r = vm.runInContext("(function(){ var x = __selResolveComp(); return x.comp ? x.comp.name : null; })()", e.ctx);
  assert.equal(r, "TR — Opener");
});

await check("any change to the parking comp — name, duration, frame rate, size, markers, layers — is a CAUTION, and ends its use", () => {
  for (const [label, change, word] of [
    ["name", (c) => { c.name = "Renamed"; }, /name/],
    ["duration", (c) => { c.duration = 10; }, /duration/],
    ["frame rate", (c) => { c.frameRate = 24; }, /frame rate/],
    ["markers", (c) => { c.markerProperty.numKeys = 1; }, /markers/],
    ["size", (c) => { c.width = 1920; }, /width/],
    ["background colour", (c) => { c.bgColor = [1, 0, 0]; }, /background colour/],
    ["work area", (c) => { c.workAreaDuration = 0.5; }, /work area/],
    ["motion blur", (c) => { c.motionBlur = true; }, /motion blur/],
    ["frame blending", (c) => { c.frameBlending = true; }, /frame blending/],
    ["start timecode", (c) => { c.displayStartTime = 10; }, /start timecode/],
    ["folder", (c) => { c._folder = { id: -5, name: "Elsewhere" }; }, /folder/],
  ]) {
    const e = es();
    e.call("_viewer_park");
    const parking = e.items.find((it) => String(it.comment).startsWith("ae-mcp-viewer-parking:v1"));
    change(parking);
    const u = e.call("_viewer_unpark").result;
    assert.match(u.caution ?? "", /^CAUTION: a change to its /, label);
    assert.match(u.caution, word, label);
    assert.equal(e.call("_viewer_park").result.created, true, `${label}: not reused`);
  }
});

await check("a parking comp written into is the user's everywhere: not parked, not recovered over, and named as the comp in view", () => {
  const e = es();
  e.call("_viewer_park");
  const parking = e.items.find((it) => String(it.comment).startsWith("ae-mcp-viewer-parking:v1"));
  e.call("run_jsx", { code: "var p = app.project['active' + 'Item']; p._layers.push({name: 'Title', id: 99}); return 1;" });
  // The unpark never came (the server died). The user is looking at the comp the script built in.
  assert.equal(e.call("_viewer_parked").result.parked, false, "check_setup sees no park to undo");
  const rec = e.call("_viewer_unpark", { recover: true }).result;
  assert.equal(rec.unparked, false, "nothing reopens the old comp over it");
  assert.match(rec.caution, /^CAUTION: 1 layer\(s\) \("Title"\)/, "and what landed there is said");
  assert.equal(e.state.view, parking);
  assert.deepEqual(e.call("_viewer_unpark", { recover: true }).result, { unparked: false }, "the park is forgotten");
  assert.equal(e.call("get_project_summary").result.activeItemId, parking.id);
  assert.equal(e.call("run_jsx", { code: "return viewerComp().id;" }).result, parking.id, "viewerComp() names it, never null");
  assert.deepEqual(Array.from(vm.runInContext("__diffCompIds({diff: true}, null)", e.ctx)), [parking.id]);
  const p = e.call("_viewer_park").result;
  assert.equal(p.recovered, undefined, "a later park does not take it for a leftover");
});

await check("a parking comp's own settings are recorded when it is made, so After Effects' defaults never read as a change", () => {
  const e = es();
  e.call("_viewer_park");
  const parking = e.items.find((it) => String(it.comment).startsWith("ae-mcp-viewer-parking:v1"));
  assert.match(parking.comment, /made=16\|16\|1\|1\|1\|0\+1\|0\|false\|false\|0\.0\.0 /);
  // Whatever AE defaults to is what is compared against: a comp made with a
  // different work area is still clean.
  e.call("_viewer_unpark");
  parking.workAreaDuration = 0.9;
  parking.comment = parking.comment.replace("0+1", "0+0.9");
  assert.equal(e.call("_viewer_park").result.created, undefined, "reused");
  // comp.time is not a setting: moving it changes nothing.
  e.call("_viewer_unpark");
  parking.time = 0.5;
  assert.equal(e.call("_viewer_park").result.created, undefined);
});

await check("viewerComp() trusts a park only for its own parking comp (the park id), not any clean one", () => {
  const e = es();
  e.call("_viewer_park");
  e.call("_viewer_unpark");
  const first = e.items.find((it) => String(it.comment).startsWith("ae-mcp-viewer-parking:v1"));
  const other = e.ctx.app.project.items.addComp("AE MCP viewer parking (safe to delete)");
  other.comment = first.comment;
  vm.runInContext(`__PARK = { fromId: ${e.heavy.id}, fromName: "TR — Opener", parkId: ${first.id}, at: 0 };`, e.ctx);
  e.state.view = other;
  const r = e.call("run_jsx", { code: "var c = viewerComp(); return c ? c.id : null;" }).result;
  assert.equal(r && typeof r === "object" ? r.returned : r, null, "not the stale park's comp");
});

await check("the server's inline-batch limit is batch.jsx's", () => {
  const m = /var __BATCH_INLINE_MAX = (\d+);/.exec(jsx("batch.jsx"));
  assert.equal(Number(m[1]), park.BATCH_INLINE_MAX);
});

// ---------- 1b. the server's three calls (tools/viewerPark.ts, server.ts) ----------

/** A sender that answers like a panel would, recording what was sent. */
function sender(answers) {
  const sent = [];
  const send = async (op, a) => {
    sent.push(a && a.recover ? `${op}(recover)` : op);
    const r = answers[op];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(a) : r;
  };
  return { sent, send };
}
const PARKED = { parked: true, compId: 7, compName: "TR — Opener" };
const BACK = { unparked: true, restored: true, compId: 7, compName: "TR — Opener" };

await check("park → script → unpark, in that order; a clean run reports nothing", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: PARKED, _viewer_unpark: BACK });
  const out = await park.withParkedViewer(s.send, st, async () => { s.sent.push("script"); return 42; });
  assert.deepEqual(s.sent, ["_viewer_park", "script", "_viewer_unpark"]);
  assert.equal(out.value, 42);
  assert.equal(park.viewerReportMatters(out.report), false);
});

await check("nothing worth parking: no unpark is sent", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: { parked: false, skipped: "no-expressions", compId: 7 } });
  await park.withParkedViewer(s.send, st, async () => { s.sent.push("script"); });
  assert.deepEqual(s.sent, ["_viewer_park", "script"]);
});

await check("an unpark that could not reopen the comp is on the answer; one that failed in transit too", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: PARKED, _viewer_unpark: { unparked: true, restored: false, compId: 7, note: "comp 7 could not be reopened (boom)" } });
  const out = await park.withParkedViewer(s.send, st, async () => 1);
  assert.equal(park.viewerReportMatters(out.report), true);
  assert.equal(out.report.restored, false);
  assert.match(out.report.note, /could not be reopened/);
  const t = sender({ _viewer_park: PARKED, _viewer_unpark: new Error("socket hang up") });
  const out2 = await park.withParkedViewer(t.send, st, async () => 1);
  assert.equal(out2.report.restored, false);
  assert.match(out2.report.note, /could not be put back \(socket hang up\)/);
  assert.equal(st.maybeLeft, true, "the session knows it may have left the viewer parked");
});

await check("a script that throws is still unparked; one whose comp could not be put back says so on the error", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: PARKED, _viewer_unpark: BACK });
  const err = new AeError("boom");
  await assert.rejects(park.withParkedViewer(s.send, st, async () => { throw err; }), (e) => e === err);
  assert.deepEqual(s.sent, ["_viewer_park", "_viewer_unpark"]);
  assert.equal(err.viewerNote, undefined, "a clean unpark adds nothing to the error");
  const t = sender({ _viewer_park: PARKED, _viewer_unpark: { unparked: true, restored: false, note: "comp 7 no longer exists" } });
  const err2 = new AeError("boom");
  await assert.rejects(park.withParkedViewer(t.send, st, async () => { throw err2; }));
  assert.match(err2.viewerNote, /comp 7 no longer exists/);
});

await check("a script that timed out is not unparked (it may still run); the session remembers, and its next write recovers", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: PARKED, _viewer_unpark: BACK });
  const err = new BridgeTimeoutError(7777, 300_000, { op: "_run_jsx" });
  await assert.rejects(park.withParkedViewer(s.send, st, async () => { throw err; }));
  assert.deepEqual(s.sent, ["_viewer_park"], "no unpark queued behind a script that may still be running");
  assert.match(err.viewerNote, /left on AE MCP's parking comp because the script may still be running/);
  assert.equal(st.maybeLeft, true);
  const msg = await park.recoverParkedViewer(s.send, st);
  assert.deepEqual(s.sent, ["_viewer_park", "_viewer_unpark(recover)"]);
  assert.match(msg, /comp 7 \("TR — Opener"\) was reopened/);
  assert.equal(st.maybeLeft, false);
});

await check("a park that timed out: the script is not sent, and the call fails as never sent — not with the timeout's wording", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: new BridgeTimeoutError(7777, 300_000, { op: "_viewer_park" }) });
  let thrown;
  await assert.rejects(park.withParkedViewer(s.send, st, async () => { s.sent.push("script"); }, { op: "run_jsx" }), (e) => (thrown = e, true));
  assert.deepEqual(s.sent, ["_viewer_park"], "the script was never sent");
  assert.ok(thrown instanceof WriteQueueWaitError, "the write-queue-wait kind: re-sending is safe");
  assert.equal(thrown instanceof BridgeTimeoutError, false);
  assert.match(thrown.message, /^`run_jsx` was not sent: After Effects did not answer the viewer park/);
  assert.match(thrown.message, /send this same call again/);
  assert.doesNotMatch(thrown.message, /do not re-send|Do not re-send|may still be running/i, "says one thing, once");
  assert.equal(st.maybeLeft, true, "the park may still land");
  // A chunk says so as a chunk, and the batch driver reads it as surely unsent.
  const t = sender({ _viewer_park: new BridgeTimeoutError(7777, 300_000, { op: "_viewer_park" }) });
  await assert.rejects(park.withParkedViewer(t.send, st, async () => 1, { op: "run_batch", what: "The next chunk of batch j_1" }),
    (e) => /^The next chunk of batch j_1 was not sent/.test(e.message));
});

await check("a park's own token goes back with its unpark; one another call ended says which, not 'reloaded?' (#277)", async () => {
  const st = new park.ViewerParkState();
  const args = [];
  const s = sender({ _viewer_park: { ...PARKED, token: 41 }, _viewer_unpark: (a) => (args.push(a), { unparked: false, takenBy: "park" }) });
  const out = await park.withParkedViewer(s.send, st, async () => 1);
  assert.deepEqual(args, [{ token: 41 }]);
  assert.equal(out.report.takenBy, "park");
  assert.match(out.report.note, /another call parked the viewer between this call's park and its unpark/);
  assert.match(out.report.note, /AE_MCP_FRONT_DESK=off/);
  assert.match(out.report.note, /that call tries to reopen it when its own script is done, unless that script puts another comp in the viewer/);
  assert.doesNotMatch(out.report.note, /that call reopens it/);
  assert.doesNotMatch(out.report.note, /reloaded/);
  assert.equal(park.viewerReportMatters(out.report), true);
  for (const [by, who] of [["dry-run", /a dry-run park, before a script that reads activeItem\)/], ["recover", /check_setup, or another session's write\)/],
    ["unpark", /another call's unpark, sent without knowing its own park/]]) {
    const t = sender({ _viewer_park: { ...PARKED, token: 42 }, _viewer_unpark: { unparked: false, takenBy: by, reopened: true } });
    const o = await park.withParkedViewer(t.send, st, async () => 1);
    assert.match(o.report.note, who);
    assert.match(o.report.note, /and reopened comp 7 \("TR — Opener"\) in the viewer/);
    assert.doesNotMatch(o.report.note, /reloaded/);
    // Ended, but nothing reopened: never claimed (review #1 and the recover nit).
    const n = sender({ _viewer_park: { ...PARKED, token: 42 }, _viewer_unpark: { unparked: false, takenBy: by, reopened: false, why: "the parking comp had been written into" } });
    const no = await park.withParkedViewer(n.send, st, async () => 1);
    assert.match(no.report.note, /without reopening comp 7 \("TR — Opener"\) \(the parking comp had been written into\)/);
    assert.doesNotMatch(no.report.note, / reopened /);
    assert.equal(no.report.restored, false);
  }
  const dr = sender({ _viewer_park: { ...PARKED, token: 44 }, _viewer_unpark: { unparked: false, takenBy: "dropped", reopened: false, why: "the viewer was showing comp 9 (\"Other\") by then, not the parking comp" } });
  const dn = (await park.withParkedViewer(dr.send, st, async () => 1)).report.note;
  assert.match(dn, /another call's park forgot this call's park .* without reopening comp 7 \("TR — Opener"\) \(the viewer was showing comp 9/);
  assert.doesNotMatch(dn, /took .* over|that call reopens it/);
  assert.match(dn, /^another call's park forgot/);
  // Round 2: a dry run's skip is said as a dry run's.
  const dd = sender({ _viewer_park: { ...PARKED, token: 45 }, _viewer_unpark: { unparked: false, takenBy: "dropped", dryRun: true, reopened: false, why: "x" } });
  assert.match((await park.withParkedViewer(dd.send, st, async () => 1)).report.note, /^a dry-run park \(before another call's script that reads activeItem\) forgot this call's park/);
  // Round 2: the user's comp read back in view is said so, and not as restored:false.
  const rs = sender({ _viewer_park: { ...PARKED, token: 46 }, _viewer_unpark: { unparked: false, takenBy: "unpark", reopened: false, restored: true } });
  const rr = (await park.withParkedViewer(rs.send, st, async () => 1)).report;
  assert.equal(rr.restored, true);
  assert.match(rr.note, /the viewer already shows comp 7 \("TR — Opener"\) again \(read back\)/);
  assert.doesNotMatch(rr.note, /without reopening/);
  // Nothing on record ended it: a reload is the likely cause, not stated as fact (review #2).
  const u = sender({ _viewer_park: { ...PARKED, token: 43 }, _viewer_unpark: { unparked: false } });
  const un = (await park.withParkedViewer(u.send, st, async () => 1)).report.note;
  assert.match(un, /no call is recorded as ending it \(most likely its script was reloaded since\)/);
});

await check("round 3: a dropped park with the comp back in view is never 'without reopening' or 'open it from the Project panel'", async () => {
  const st = new park.ViewerParkState();
  const a = sender({ _viewer_park: { ...PARKED, token: 50 }, _viewer_unpark: { unparked: false, takenBy: "dropped", reopened: false, restored: true, reparked: true, why: "x" } });
  const ra = (await park.withParkedViewer(a.send, st, async () => 1)).report;
  assert.match(ra.note, /found comp 7 \("TR — Opener"\) already back in the viewer .* parked that comp itself: it tries to reopen it/);
  assert.doesNotMatch(ra.note, /without reopening|Project panel/);
  assert.equal(ra.restored, undefined, "parked again since: restored is claimed neither way");
  const b = sender({ _viewer_park: { ...PARKED, token: 51 }, _viewer_unpark: { unparked: false, takenBy: "dropped", reopened: false, restored: true, why: "x" } });
  const rb = (await park.withParkedViewer(b.send, st, async () => 1)).report;
  assert.match(rb.note, /already back in the viewer .* nothing needed reopening/);
  assert.doesNotMatch(rb.note, /without reopening|Project panel/);
  assert.equal(rb.restored, true);
  // Nit: a reopen by another call is said as of that moment, not as what the viewer shows now.
  const c = sender({ _viewer_park: { ...PARKED, token: 52 }, _viewer_unpark: { unparked: false, takenBy: "recover", reopened: true } });
  const rc = (await park.withParkedViewer(c.send, st, async () => 1)).report.note;
  assert.match(rc, /it was in the viewer from then on, unless a later call moved it/);
  assert.doesNotMatch(rc, /the viewer already shows it/);
});

await check("review #3: a dry-run park that timed out is a never-sent error that claims no parking comp", async () => {
  const s = sender({ _viewer_park: new BridgeTimeoutError(7777, 300_000, { op: "_viewer_park" }) });
  let thrown;
  await assert.rejects(park.notParkedForActiveItem(s.send), (e) => (thrown = e, true));
  assert.ok(thrown instanceof ScriptNotSentError && thrown instanceof WriteQueueWaitError, "still the never-sent kind");
  assert.match(thrown.message, /^`run_jsx` was not sent: After Effects did not answer the viewer check/);
  assert.match(thrown.message, /creates nothing and parks nothing/);
  assert.doesNotMatch(thrown.message, /creates it at the project root|park landing late|switches the viewer to an empty comp/);
  assert.match(thrown.message, /send this same call again/);
});

await check("a dry-run park that recovered a dead session's park says so (#277)", async () => {
  const s = sender({ _viewer_park: { parked: false, wouldPark: true, compId: 7, compName: "TR — Opener", recovered: { compId: 7, compName: "TR — Opener" } } });
  const r = await park.notParkedForActiveItem(s.send);
  assert.deepEqual(r.recovered, { compId: 7, compName: "TR — Opener" });
  assert.match(r.note, /an earlier call had left the viewer on AE MCP's parking comp; comp 7 \("TR — Opener"\) was reopened/);
  assert.equal(park.viewerReportMatters(r), true);
  // No way back known: the script reads the parking comp, and is told.
  const t = sender({ _viewer_park: { parked: false, skipped: "already-parked", note: "the viewer was already showing the AE MCP parking comp and the comp it replaced is not known (or no longer exists), so the script ran with the parking comp in view and nothing will be reopened" } });
  const r2 = await park.notParkedForActiveItem(t.send);
  assert.equal(r2.skipped, "already-parked");
  assert.match(r2.note, /its app\.project\.activeItem was that comp/);
  // Nothing to report: no expressions, nothing left parked.
  assert.equal(await park.notParkedForActiveItem(sender({ _viewer_park: { parked: false, skipped: "no-expressions" } }).send), null);
});

await check("ScriptNotSentError says only what is true: the park may still create the comp; check_setup names only this session's calls (#277)", () => {
  const m = new ScriptNotSentError("run_jsx").message;
  assert.doesNotMatch(m, /nothing in the project was changed/i);
  assert.match(m, /creates it at the project root as one undo step of its own/);
  assert.doesNotMatch(m, /\(it names what it is busy with\)/);
  assert.match(m, /If the earlier work is a call this session made, check_setup\s+names it under `busyWith`/);
  assert.match(m, /a render, another session's call or a dialog it cannot name/);
});

await check("check_setup's recovery: nothing in read-only mode, no lock unless a park is unfinished", async () => {
  const run = async ({ readOnly = false, maybeLeft = false, parked = false, lockFree = true } = {}) => {
    const calls = [];
    const st = new park.ViewerParkState();
    st.maybeLeft = maybeLeft;
    const s = sender({ _viewer_unpark: BACK });
    const msg = await park.recoverForCheck({
      readOnly, state: st,
      isParked: async () => { calls.push("isParked"); return parked; },
      acquire: async () => { calls.push("acquire"); if (!lockFree) throw new Error("timed out"); return { release() { calls.push("release"); } }; },
      send: async (op, a) => { calls.push(op); return s.send(op, a); },
    });
    return { calls, msg };
  };
  assert.deepEqual((await run({ readOnly: true, maybeLeft: true, parked: true })).calls, [], "read-only: nothing at all");
  assert.deepEqual((await run()).calls, ["isParked"], "no park: a read, and no lock");
  const r = await run({ parked: true });
  assert.deepEqual(r.calls, ["isParked", "acquire", "_viewer_unpark", "release"]);
  assert.match(r.msg, /was reopened/);
  assert.deepEqual((await run({ maybeLeft: true })).calls, ["acquire", "_viewer_unpark", "release"], "this session knows: no read needed");
  const busy = await run({ parked: true, lockFree: false });
  assert.deepEqual(busy.calls, ["isParked", "acquire"], "a lock held elsewhere is left alone");
  assert.match(busy.msg, /another call holds the write lock/);
});

await check("a next-write recovery that fails is said, and the session keeps knowing", async () => {
  const st = new park.ViewerParkState();
  st.maybeLeft = true;
  const s = sender({ _viewer_unpark: new BridgeTimeoutError(7777, 10_000, { op: "_viewer_unpark" }) });
  const msg = await park.recoverParkedViewer(s.send, st);
  assert.match(msg, /putting it back failed \(no answer in time: After Effects is busy\)/);
  assert.equal(st.maybeLeft, true);
});

await check("a script that mentions activeItem — in its code or a library — is found by the scan", () => {
  assert.equal(park.readsActiveItem({ code: "var c = app.project.activeItem;" }), true);
  assert.equal(park.readsActiveItem({ code: "var p = app.project; p['activeItem'].layers.addNull();" }), true);
  assert.equal(park.readsActiveItem({ code: "return viewerComp().name;", libraries: [{ path: "/l.jsx", text: "function f(){ return app.project.activeItem; }" }] }), true);
  assert.equal(park.readsActiveItem({ code: "return viewerComp().name; // activeItems" }), false);
  const step = { op: "run_jsx", args: { code: "app.project.activeItem.name" } };
  assert.equal(park.batchParkMode({ ops: [step] }).readsActiveItem, true);
});

await check("a park whose answer was lost is undone anyway — it may have landed, and the unpark is idempotent", async () => {
  const st = new park.ViewerParkState();
  const s = sender({ _viewer_park: new Error("socket hang up"), _viewer_unpark: { unparked: false } });
  const out = await park.withParkedViewer(s.send, st, async () => { s.sent.push("script"); return 1; });
  assert.deepEqual(s.sent, ["_viewer_park", "script", "_viewer_unpark"]);
  assert.match(out.report.note, /nothing had been parked/);
  // After Effects answering with an error is an answer: nothing is parked.
  const t = sender({ _viewer_park: new AeError("Unknown op: _viewer_park") });
  await park.withParkedViewer(t.send, st, async () => { t.sent.push("script"); });
  assert.deepEqual(t.sent, ["_viewer_park", "script"]);
});

await check("a batch parks only with a run_jsx step (at any depth) and none opting out; inline or per chunk", () => {
  const jsxStep = (a = {}) => ({ op: "run_jsx", args: { code: "1", ...a } });
  assert.equal(park.batchParkMode({ ops: [{ op: "set_layer", args: {} }] }), null);
  assert.deepEqual(park.batchParkMode({ ops: [jsxStep()] }), { mode: "inline", asked: false, readsActiveItem: false });
  assert.deepEqual(park.batchParkMode({ ops: [{ op: "run_batch", args: { ops: [jsxStep({ quietViewer: true })] } }] }), { mode: "inline", asked: true, readsActiveItem: false });
  assert.equal(park.batchParkMode({ ops: [jsxStep(), jsxStep({ quietViewer: false })] }), null);
  const many = Array.from({ length: 501 }, () => jsxStep());
  assert.equal(park.batchParkMode({ ops: many }).mode, "chunks");
  assert.equal(park.batchParkMode({ ops: many, singleUndo: true }).mode, "inline");
  assert.equal(park.runJsxWantsPark({ code: "1" }), true);
  assert.equal(park.runJsxWantsPark({ code: "1", quietViewer: false }), false);
});

// Through tools/call, against a stub panel: the three calls hold ONE lease, so
// a write issued while the script runs reaches the panel only after the unpark.
{
  const seen = [];
  let release;
  const held = new Promise((r) => (release = r));
  let unparkAnswer = BACK;
  let runJsxHold = null;
  let parkHold = null;
  let parkedAnswer = { parked: false };
  const chunks = new Map();
  const bridge = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), clientHash: sourceClientHash() }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { op, args } = JSON.parse(body || "{}");
      seen.push(args?.recover ? `${op}(recover)` : args?.dryRun ? `${op}(dryRun)` : op);
      let result = { ok: true };
      if (op === "_viewer_park") {
        if (parkHold) await parkHold;
        result = args?.dryRun ? { parked: false, wouldPark: true, compId: 7, compName: "TR — Opener" } : PARKED;
      }
      if (op === "_viewer_parked") result = parkedAnswer;
      if (op === "_viewer_unpark") result = unparkAnswer;
      if (op === "_run_jsx") { await (runJsxHold ?? held); result = { made: 3 }; }
      if (op === "run_batch" && args.ops.length > 500) {
        result = { jobId: "j_1", async: true, total: args.ops.length, chunkSize: 25, driver: "server" };
      }
      if (op === "_continue_job") {
        const n = (chunks.get(args.jobId) ?? 0) + 1;
        chunks.set(args.jobId, n);
        result = n >= 2
          ? { done: true, jobId: args.jobId, results: [], errors: [], total: 501, undoSteps: n }
          : { done: false, jobId: args.jobId, progress: 25, total: 501, undoSteps: n };
      }
      try { res.end(JSON.stringify({ ok: true, result })); } catch {}
    });
  });
  const wss = new WebSocketServer({ server: bridge, path: "/events" });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
  process.env.AE_MCP_PORT = String(bridge.address().port);
  const { createServer } = await import(dist("server.js"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const callsRecord = new CallsInFlight();
  const server = createServer({ callsInFlight: callsRecord });
  const client = new Client({ name: "quiet-viewer-test", version: "0" }, { capabilities: {} });
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]);
  const until = async (what, cond) => {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), `never saw: ${what}`);
  };

  await check("tools/call: park, script and unpark hold one write lease; another write waits for all three", async () => {
    seen.length = 0;
    const script = client.callTool({ name: "run_jsx", arguments: { code: "return 1;" } });
    await until("the script at the panel", () => seen.includes("_run_jsx"));
    const other = client.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, name: "x" } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.includes("set_layer"), false, "a write landed while the viewer was parked");
    release();
    const [r1, r2] = await Promise.all([script, other]);
    assert.equal(r1.isError, undefined, r1.content[0].text);
    assert.equal(r2.isError, undefined, r2.content[0].text);
    assert.deepEqual(seen, ["_viewer_park", "_run_jsx", "_viewer_unpark", "set_layer"]);
    assert.deepEqual(JSON.parse(r1.content[0].text), { made: 3 }, "the script's value keeps its shape");
    assert.equal(r1.content.length, 1, "a clean park adds nothing to the answer");
  });

  await check("tools/call: quietViewer:true reports the park; an unpark that failed is reported unasked", async () => {
    const asked = await client.callTool({ name: "run_jsx", arguments: { code: "return 1;", quietViewer: true } });
    assert.deepEqual(JSON.parse(asked.content[1].text).quietViewer, { ...PARKED, restored: true });
    unparkAnswer = { unparked: true, restored: false, compId: 7, compName: "TR — Opener", viewerComp: { id: 9, name: "Other" },
      note: "the script opened comp 9 (\"Other\") in the viewer, so it was left there" };
    const told = await client.callTool({ name: "run_jsx", arguments: { code: "return 1;" } });
    const rep = JSON.parse(told.content[1].text).quietViewer;
    assert.deepEqual(rep.viewerComp, { id: 9, name: "Other" });
    assert.match(rep.note, /left there/);
    unparkAnswer = BACK;
  });

  await check("tools/call: quietViewer:false sends neither a park nor an unpark", async () => {
    seen.length = 0;
    await client.callTool({ name: "run_jsx", arguments: { code: "return 1;", quietViewer: false } });
    assert.deepEqual(seen, ["_run_jsx"]);
  });

  await check("tools/call: an inline run_batch with a run_jsx step is parked once around the whole call", async () => {
    seen.length = 0;
    await client.callTool({ name: "run_batch", arguments: { ops: [{ op: "run_jsx", args: { code: "return 1;" } }, { op: "set_layer", args: { compId: 1, layerId: 1, name: "x" } }] } });
    assert.deepEqual(seen, ["_viewer_park", "run_batch", "_viewer_unpark"]);
    seen.length = 0;
    await client.callTool({ name: "run_batch", arguments: { ops: [{ op: "set_layer", args: { compId: 1, layerId: 1, name: "x" } }] } });
    assert.deepEqual(seen, ["run_batch"], "no run_jsx step, no park");
  });

  await check("tools/call: a script that reads app.project.activeItem is not parked, and the answer suggests viewerComp()", async () => {
    seen.length = 0;
    const r = await client.callTool({ name: "run_jsx", arguments: { code: "return app.project.activeItem.name;" } });
    assert.deepEqual(seen, ["_viewer_park(dryRun)", "_run_jsx"], "no park, no unpark: only the dry run");
    const rep = JSON.parse(r.content[1].text).quietViewer;
    assert.equal(rep.skipped, "reads-activeItem");
    assert.match(rep.note, /use viewerComp\(\)/i);
    seen.length = 0;
    await client.callTool({ name: "run_batch", arguments: { ops: [{ op: "run_jsx", args: { code: "return app.project.activeItem.name;" } }] } });
    assert.deepEqual(seen, ["_viewer_park(dryRun)", "run_batch"], "a batch whose step reads it is not parked either");
  });

  await check("tools/call: a long run_batch with a run_jsx step parks around each chunk, never across two", async () => {
    seen.length = 0;
    const ops = Array.from({ length: 501 }, () => ({ op: "run_jsx", args: { code: "return 1;" } }));
    const env = JSON.parse((await client.callTool({ name: "run_batch", arguments: { ops } })).content[0].text);
    assert.equal(env.jobId, "j_1");
    await client.callTool({ name: "await_job", arguments: { jobId: "j_1" } });
    assert.deepEqual(seen, ["run_batch", "_viewer_park", "_continue_job", "_viewer_unpark", "_viewer_park", "_continue_job", "_viewer_unpark"]);
  });

  await check("tools/call: after a script timed out, this session's next write puts the viewer back first", async () => {
    seen.length = 0;
    let open;
    runJsxHold = new Promise((r) => (open = r));
    process.env.AE_MCP_OP_TIMEOUT_MS = "400";
    let timedOut;
    try {
      timedOut = await client.callTool({ name: "run_jsx", arguments: { code: "return 1;" } });
    } finally {
      delete process.env.AE_MCP_OP_TIMEOUT_MS;
    }
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.content.map((c) => c.text).join("\n"), /left on AE MCP's parking comp because the script may still be running/);
    assert.deepEqual(seen, ["_viewer_park", "_run_jsx"], "no unpark behind a script that may still be running");
    open();
    runJsxHold = null;
    const w = await client.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, name: "x" } });
    assert.equal(w.isError, undefined, w.content[0].text);
    assert.deepEqual(seen.slice(2), ["_viewer_unpark(recover)", "set_layer"]);
    assert.match(w.content.map((c) => c.text).join("\n"), /comp 7 \("TR — Opener"\) was reopened/);
    seen.length = 0;
    await client.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, name: "y" } });
    assert.deepEqual(seen, ["set_layer"], "once put back, the next write sends nothing extra");
  });

  await check("tools/call: a park that times out says the script was not sent — and busyWith never contradicts it", async () => {
    seen.length = 0;
    let open;
    parkHold = new Promise((res) => (open = res));
    process.env.AE_MCP_OP_TIMEOUT_MS = "400";
    let r;
    try {
      r = await client.callTool({ name: "run_jsx", arguments: { code: "return 1;" } });
    } finally {
      delete process.env.AE_MCP_OP_TIMEOUT_MS;
    }
    const text = r.content.map((c) => c.text).join("\n");
    assert.equal(r.isError, true);
    assert.match(text, /^`run_jsx` was not sent: After Effects did not answer the viewer park/);
    assert.doesNotMatch(text, /do not re-send/i);
    assert.deepEqual(seen, ["_viewer_park"], "the script was never sent");
    assert.equal(callsRecord.busyWith(), null, "check_setup would not name run_jsx as still running");
    // The dry-run park before a script that reads activeItem is held to the same rule.
    process.env.AE_MCP_OP_TIMEOUT_MS = "400";
    try {
      r = await client.callTool({ name: "run_jsx", arguments: { code: "return app.project.activeItem.name;" } });
    } finally {
      delete process.env.AE_MCP_OP_TIMEOUT_MS;
    }
    assert.match(r.content.map((c) => c.text).join("\n"), /^`run_jsx` was not sent/);
    assert.equal(seen.includes("_run_jsx"), false, "nothing sent into a stuck After Effects");
    assert.equal(callsRecord.busyWith(), null);
    open();
    parkHold = null;
    // The parks landed late; put back what they left, so later checks start clean.
    await client.callTool({ name: "set_layer", arguments: { compId: 1, layerId: 1, name: "z" } });
  });

  await check("tools/call: quietViewer:false and a script reading activeItem — a park a dead session left is found first", async () => {
    seen.length = 0;
    parkedAnswer = { parked: true, compId: 7 };
    await client.callTool({ name: "run_jsx", arguments: { code: "return app.project.activeItem.name;", quietViewer: false } });
    assert.deepEqual(seen, ["_viewer_parked", "_viewer_unpark(recover)", "_run_jsx"]);
    parkedAnswer = { parked: false };
    seen.length = 0;
    await client.callTool({ name: "run_jsx", arguments: { code: "return app.project.activeItem.name;", quietViewer: false } });
    assert.deepEqual(seen, ["_viewer_parked", "_run_jsx"], "nothing to undo: a read, then the script");
    seen.length = 0;
    await client.callTool({ name: "run_jsx", arguments: { code: "return 1;", quietViewer: false } });
    assert.deepEqual(seen, ["_run_jsx"], "a script that does not read activeItem costs nothing extra");
  });

  await check("tools/call: a chunk whose park another session took back warns with that cause, not 'reloaded?' (#277)", async () => {
    seen.length = 0;
    chunks.clear();
    unparkAnswer = { unparked: false, takenBy: "dry-run", reopened: true };
    try {
      const ops = Array.from({ length: 501 }, () => ({ op: "run_jsx", args: { code: "return 1;" } }));
      const env = JSON.parse((await client.callTool({ name: "run_batch", arguments: { ops } })).content[0].text);
      const done = await client.callTool({ name: "await_job", arguments: { jobId: env.jobId } });
      const text = done.content.map((c) => c.text).join("\n");
      assert.match(text, /a dry-run park, before a script that reads activeItem\) ended this call.s park .* and reopened comp 7/);
      assert.match(text, /AE_MCP_FRONT_DESK=off/);
      assert.doesNotMatch(text, /reloaded/);
    } finally {
      unparkAnswer = BACK;
    }
  });

  await client.close();
  await server.close();
  wss.close();
  await new Promise((r) => bridge.close(r));
}

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

await check("a timed-out viewer unpark is never named as a run_jsx/run_batch/check_setup to keep from re-sending (#277)", async () => {
  let t = 1_000;
  const calls = new CallsInFlight(() => t);
  await assert.rejects(calls.track("_viewer_unpark", async (sent) => { sent(); t = 11_000; throw new BridgeTimeoutError(7777, 10_000, { op: "_viewer_unpark" }); }));
  t = 20_000;
  const b = calls.busyWith();
  assert.deepEqual(b, { op: "viewer unpark", state: "timedOut", calledAgoMs: 19_000, timedOutAgoMs: 9_000, limitMs: 10_000, kind: "viewer-unpark" });
  const ok = (name) => ({ name, ok: true, detail: "" });
  const checks = ["platform", "panelAssetsPresent", "cepDebugMode", "panelInstalled", "panelUpToDate",
    "panelDependencies", "afterEffectsRunning"].map(ok);
  checks.push({ name: "bridgeReachable", ok: false, detail: "", fix: "…" });
  for (const bw of [b, { op: "viewer unpark", state: "sent", calledAgoMs: 3_000, sentAgoMs: 2_000, kind: "viewer-unpark" },
    { op: "viewer unpark", state: "queued", calledAgoMs: 3_000, kind: "viewer-unpark" }]) {
    const steps = withBusyStep(buildNextSteps(checks, false, true), bw);
    assert.match(steps[1], /^What it is busy with: this server's viewer unpark/);
    assert.match(steps[1], /nothing needs re-sending for it/);
    // Round 2: true for a chunk of a running batch and for a recovery with no script before it.
    assert.doesNotMatch(steps[1], /has finished|already answered/);
    assert.doesNotMatch(steps[1], /run_jsx\/run_batch|check_setup`|Do not re-send|run a second time|very probably still running that call/);
  }
  // The script it follows still reads as the script.
  await assert.rejects(calls.track("_run_jsx", async (sent) => { sent(); throw new BridgeTimeoutError(7777, 300_000, { op: "_run_jsx" }); }));
  assert.equal(calls.busyWith().kind, "viewer-unpark", "the oldest sent is still named first (#272)");
  calls.answered();
  await assert.rejects(calls.track("_run_jsx", async (sent) => { sent(); throw new BridgeTimeoutError(7777, 300_000, { op: "_run_jsx" }); }));
  assert.deepEqual([calls.busyWith().op, calls.busyWith().kind], ["run_jsx", undefined]);
});

console.log(`quiet-viewer: ${passed} checks passed`);
