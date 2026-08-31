// place_audio_cues, run out of packages/jsx/audio.jsx against a mock AE DOM.
//
// Scoring a scene is 40-90 audio layers, and the two things that make a batch
// of that size safe are exactly the two things no screenshot or property read
// would ever reveal:
//
//   - It is all-or-nothing. Every cue is resolved and checked before a single
//     layer exists, and anything created before a late failure is removed
//     again. A run that dies on cue 30 of 90 leaves 29 sound effects in
//     someone's timeline and an error naming none of them.
//   - A file named by nine cues is imported once, and one already in the
//     project is not imported at all.
//
// Plus the trap the tool exists to remove: Audio Levels is reachable through
// `layer.audioLevels` and NOT through `layer.property("ADBE Audio Levels")`,
// which returns null on an audio layer (issue #48). The mock's `property()`
// answers null for everything, so a level that lands proves the shortcut was
// used rather than the trap.
//
// It runs through the real `dispatch` out of core.jsx, so the undo grouping is
// under test too: a dryRun must not even be an undo step.
//
//   node tests/unit/audio-cues.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
// core.jsx for dispatch/noUndoWhen, footage.jsx for the import and the project
// scan audio.jsx reuses. In the shipped bundle all three share one scope.
const sources = [["core.jsx", read("core.jsx")], ["footage.jsx", read("footage.jsx")], ["audio.jsx", read("audio.jsx")]];

const plain = (a) => Array.prototype.slice.call(a);

// ---------- the mock DOM ----------

class FolderItem {}
class CompItem {}

class MockLayer {
  constructor(world, item) {
    this.world = world;
    this.id = world.nextLayerId++;
    this.index = world.layers.length + 1;
    this.name = item.name;
    this.source = item;
    this.startTime = 0;
    this.inPoint = 0;
    this.outPoint = item.duration;
    this.label = 0;
    this.removed = false;
    this.levels = null;
    // `failOnLayer` is the stand-in for whatever AE refuses on cue 30 that no
    // amount of up-front validation could have known about.
    const broken = world.audioLevelsMode === "missing" || world.layers.length + 1 === world.failOnLayer;
    if (!broken && world.audioLevelsMode === "shortcut") {
      const self = this;
      this.audioLevels = { setValue(v) { self.levels = plain(v); } };
    }
  }
  // The trap: on a real audio layer this returns null for Audio Levels. Every
  // name answers null here, so any code path that went looking through
  // property() instead of the shortcut fails loudly.
  property(name) {
    this.world.propertyCalls.push(name);
    if (name === "Audio" && this.world.audioLevelsMode === "group") {
      const self = this;
      return { property: (k) => (k === "Audio Levels" ? { setValue(v) { self.levels = plain(v); } } : null) };
    }
    return null;
  }
  remove() {
    this.removed = true;
    this.world.layers = this.world.layers.filter((l) => l !== this);
  }
}

class MockItem {
  constructor(world, { id, name, filePath = null, hasAudio = true, duration = 2, footageMissing = false }) {
    this.world = world;
    this.id = id;
    this.name = name;
    this.filePath = filePath;
    this.hasAudio = hasAudio;
    this.duration = duration;
    this.footageMissing = footageMissing;
    this.removed = false;
  }
  get mainSource() {
    if (!this.filePath) return null;
    return { file: { fsName: this.filePath } };
  }
  remove() {
    this.removed = true;
    this.world.items = this.world.items.filter((i) => i !== this);
  }
}

/**
 * `files` maps an on-disk path to what AE would make of it.
 * `projectItems` is what the project already holds before the call.
 */
function makeWorld({ files = {}, projectItems = [], compDuration = 30, audioLevelsMode = "shortcut", failOnLayer = 0 } = {}) {
  const world = {
    files,
    items: [],
    layers: [],
    imports: [],
    undoLog: [],
    propertyCalls: [],
    nextItemId: 100,
    nextLayerId: 500,
    audioLevelsMode,
    failOnLayer,
  };
  for (const spec of projectItems) {
    world.items.push(new MockItem(world, { id: world.nextItemId++, ...spec }));
  }

  const comp = {
    id: 7,
    name: "Scene 01",
    duration: compDuration,
    layers: {
      add(item) {
        const l = new MockLayer(world, item);
        world.layers.push(l);
        return l;
      },
    },
  };
  world.comp = comp;

  class MockFile {
    constructor(p) {
      this.path = String(p);
      this.fsName = String(p);
    }
    get exists() { return Object.prototype.hasOwnProperty.call(files, this.path); }
  }

  const ctx = {
    // Deliberately no Array/JSON here: dispatch parses the payload with the
    // VM's JSON, and `cues instanceof Array` has to be checked against the same
    // realm's Array — one realm, as inside After Effects. The mock DOM classes
    // below are the exception; the objects they make are host objects, so the
    // constructors the JSX tests them against have to be the host's too.
    File: MockFile,
    FolderItem,
    CompItem,
    ImportOptions: class { constructor(f) { this.file = f; } canImportAs() { return true; } },
    ImportAsType: { FOOTAGE: "footage" },
    app: {
      beginUndoGroup: (n) => world.undoLog.push(`begin:${n}`),
      endUndoGroup: () => world.undoLog.push("end"),
      project: {
        get numItems() { return world.items.length; },
        item: (i) => world.items[i - 1],
        itemByID: (id) => world.items.find((it) => it.id === id) ?? null,
        importFile: (opts) => {
          const p = opts.file.fsName;
          world.imports.push(p);
          const meta = files[p] ?? {};
          const item = new MockItem(world, {
            id: world.nextItemId++,
            name: p.split("/").pop(),
            filePath: p,
            hasAudio: meta.hasAudio !== false,
            duration: meta.duration ?? 2,
          });
          world.items.push(item);
          return item;
        },
      },
    },
    getCompById: (id) => {
      if (id !== comp.id) throw new Error(`No comp with id ${id}`);
      return comp;
    },
  };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });

  world.call = (args) => vm.runInContext("dispatch", ctx)(JSON.stringify({ op: "place_audio_cues", args }));
  world.ctx = ctx;
  return world;
}

/** Asserts the call failed and hands back the message. */
function failure(r) {
  assert.equal(r.ok, false, `expected a failure, got: ${JSON.stringify(r.result)}`);
  return r.error;
}

/** Asserts the call succeeded and hands back the result. */
function success(r) {
  assert.equal(r.ok, true, `expected success, got: ${r.error}`);
  return r.result;
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`audio-cues FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const THREE_FILES = {
  "/snd/whoosh.wav": { duration: 1.2 },
  "/snd/impact.wav": { duration: 0.8 },
  "/snd/riser.aif": { duration: 4 },
};

// ---------- the happy path ----------

check("places a cue per entry, one undo step, levels through the shortcut", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 1 },
      { path: "/snd/impact.wav", time: 2.5, levelDb: -6 },
      { path: "/snd/riser.aif", time: 4, levelDb: 3 },
    ],
  }));
  assert.equal(r.count, 3);
  assert.equal(w.layers.length, 3);
  assert.deepEqual(w.undoLog, ["begin:AE MCP: place_audio_cues", "end"], "one undo step for the whole batch");

  assert.deepEqual(w.layers.map((l) => l.name), ["SFX_whoosh", "SFX_impact", "SFX_riser"]);
  assert.deepEqual(w.layers.map((l) => l.startTime), [1, 2.5, 4]);
  assert.deepEqual(w.layers.map((l) => l.levels), [[0, 0], [-6, -6], [3, 3]],
    "dB on both channels, and 0 written explicitly rather than left to the file");
  assert.equal(w.propertyCalls.length, 0, "layer.property() must not be the route to Audio Levels");
  assert.equal(r.levelUnit, "dB");
});

check("reports the layer ids and times the caller has to carry forward", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 1.5 }] }));
  const p = r.placed[0];
  assert.equal(p.layerId, w.layers[0].id);
  assert.equal(p.name, "SFX_whoosh");
  assert.equal(p.time, 1.5);
  assert.equal(p.levelDb, 0);
  assert.equal(p.itemId, w.items[0].id);
});

check("falls back to the Audio group when the shortcut is absent", () => {
  const w = makeWorld({ files: THREE_FILES, audioLevelsMode: "group" });
  success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0, levelDb: -12 }] }));
  assert.deepEqual(w.layers[0].levels, [-12, -12]);
});

// ---------- one import per file ----------

check("a file named by many cues is imported exactly once", () => {
  const w = makeWorld({ files: THREE_FILES });
  const cues = [];
  for (let i = 0; i < 9; i++) cues.push({ path: "/snd/whoosh.wav", time: i * 0.5 });
  const r = success(w.call({ compId: 7, cues }));
  assert.equal(w.imports.length, 1, "nine cues on one .wav is the normal shape of a cue list");
  assert.equal(w.layers.length, 9);
  assert.equal(r.sources.imported.length, 1);
  assert.equal(r.sources.imported[0].path, "/snd/whoosh.wav");
  const ids = new Set(r.placed.map((p) => p.itemId));
  assert.equal(ids.size, 1, "every layer should point at the same project item");
});

check("an item already in the project from that path is reused, not re-imported", () => {
  const w = makeWorld({
    files: THREE_FILES,
    projectItems: [{ name: "whoosh (already here)", filePath: "/snd/whoosh.wav" }],
  });
  const r = success(w.call({
    compId: 7,
    cues: [{ path: "/snd/whoosh.wav", time: 1 }, { path: "/snd/impact.wav", time: 2 }],
  }));
  assert.deepEqual(w.imports, ["/snd/impact.wav"], "only the one that was actually missing");
  assert.equal(r.sources.reused.length, 1);
  assert.equal(r.sources.reused[0].path, "/snd/whoosh.wav");
  assert.equal(w.items.length, 2, "no duplicate project item");
});

check("a footageId cue uses that item and imports nothing", () => {
  const w = makeWorld({ files: THREE_FILES, projectItems: [{ name: "Boom", filePath: "/snd/boom.wav" }] });
  const id = w.items[0].id;
  const r = success(w.call({ compId: 7, cues: [{ footageId: id, time: 3 }] }));
  assert.deepEqual(w.imports, []);
  assert.equal(r.placed[0].itemId, id);
  assert.equal(w.layers[0].name, "SFX_Boom", "an id cue is named from the item, not from a path it never gave");
});

// ---------- naming ----------

check("names: prefix + basename without extension, overridable, prefix removable", () => {
  const w = makeWorld({ files: THREE_FILES });
  success(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 0 },
      { path: "/snd/impact.wav", time: 1, name: "Hit — beat 3" },
    ],
    namePrefix: "",
  }));
  assert.deepEqual(w.layers.map((l) => l.name), ["whoosh", "Hit — beat 3"]);
});

// ---------- trims and labels ----------

check("trims in comp time, and reports what AE ended up with", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({
    compId: 7,
    cues: [{ path: "/snd/riser.aif", time: 2, inPoint: 2.5, outPoint: 5 }],
  }));
  assert.equal(w.layers[0].startTime, 2);
  assert.equal(w.layers[0].inPoint, 2.5);
  assert.equal(w.layers[0].outPoint, 5);
  assert.equal(r.placed[0].inPoint, 2.5, "read back from the layer, not echoed from the request");
});

check("labels by name and by index", () => {
  const w = makeWorld({ files: THREE_FILES });
  success(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 0, label: "sea foam" },
      { path: "/snd/impact.wav", time: 1, label: 11 },
    ],
  }));
  assert.deepEqual(w.layers.map((l) => l.label), [7, 11]);
});

check("an unknown label is refused, naming what it takes", () => {
  const w = makeWorld({ files: THREE_FILES });
  const msg = failure(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0, label: "chartreuse" }] }));
  assert.match(msg, /cue 0/);
  assert.match(msg, /chartreuse/);
  assert.match(msg, /sandstone/, "list the colours it does know");
  assert.equal(w.layers.length, 0);
});

// ---------- validation, before anything is created ----------

check("one bad cue among many places nothing at all", () => {
  const w = makeWorld({ files: THREE_FILES });
  const cues = [];
  for (let i = 0; i < 10; i++) cues.push({ path: "/snd/whoosh.wav", time: i });
  cues[7] = { path: "/snd/missing.wav", time: 7 };
  const msg = failure(w.call({ compId: 7, cues }));
  assert.match(msg, /cue 7/, "name the cue that is wrong");
  assert.match(msg, /no file at \/snd\/missing\.wav/);
  assert.match(msg, /untouched/);
  assert.equal(w.layers.length, 0, "the other nine must not be left in the timeline");
  assert.equal(w.imports.length, 0, "and nothing should have been imported for them");
});

check("every problem is reported at once, not one per round trip", () => {
  const w = makeWorld({ files: THREE_FILES, compDuration: 10 });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 1 },
      { path: "/snd/nope.wav", time: 2 },
      { path: "/snd/whoosh.wav", time: 99 },
      { footageId: 4242, time: 3 },
      { time: 4 },
      { path: "/snd/whoosh.wav", footageId: 1, time: 5 },
    ],
  }));
  assert.match(msg, /cue 1: no file at/);
  assert.match(msg, /cue 2: time 99s is outside the comp, which runs 0 to 10s/);
  assert.match(msg, /cue 3: no project item with id 4242/);
  assert.match(msg, /cue 4: has neither footageId nor path/);
  assert.match(msg, /cue 5: has both footageId and path/);
  assert.match(msg, /5 of 6 cues/);
});

check("refuses a source with no audio track before making a layer for it", () => {
  const w = makeWorld({
    files: THREE_FILES,
    projectItems: [{ name: "logo.png", filePath: "/art/logo.png", hasAudio: false }],
  });
  const msg = failure(w.call({ compId: 7, cues: [{ footageId: w.items[0].id, time: 1 }] }));
  assert.match(msg, /has no audio track/);
  assert.equal(w.layers.length, 0);
});

check("refuses a comp, a folder and an offline item, each in its own words", () => {
  const w = makeWorld({ files: THREE_FILES });
  const folder = new FolderItem();
  Object.assign(folder, { id: 900, name: "Audio", remove() {} });
  const comp = new CompItem();
  Object.assign(comp, { id: 901, name: "Nested", remove() {} });
  w.items.push(folder, comp, new MockItem(w, { id: 902, name: "gone.wav", filePath: "/snd/gone.wav", footageMissing: true }));
  const msg = failure(w.call({
    compId: 7,
    cues: [{ footageId: 900, time: 1 }, { footageId: 901, time: 2 }, { footageId: 902, time: 3 }],
  }));
  assert.match(msg, /cue 0: "Audio" is a folder/);
  assert.match(msg, /cue 1: "Nested" is a comp/);
  assert.match(msg, /cue 2: "gone.wav" is offline/);
});

check("refuses a trim that cannot mean anything", () => {
  const w = makeWorld({ files: THREE_FILES });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 5, inPoint: 4 },
      { path: "/snd/whoosh.wav", time: 5, outPoint: 5 },
    ],
  }));
  assert.match(msg, /cue 0: inPoint 4s is before the cue's own time 5s/);
  assert.match(msg, /cue 1: outPoint 5s is not after the cue starts/);
});

check("caps the list, and says what to do about it", () => {
  const w = makeWorld({ files: THREE_FILES });
  const cues = [];
  for (let i = 0; i < 201; i++) cues.push({ path: "/snd/whoosh.wav", time: 0 });
  const msg = failure(w.call({ compId: 7, cues }));
  assert.match(msg, /201 cues/);
  assert.match(msg, /limit is 200/);
  assert.match(msg, /Split the list/);
  assert.equal(w.layers.length, 0);
});

// ---------- rollback, for what validation cannot see ----------

check("an import that turns out to have no audio takes itself back out", () => {
  const w = makeWorld({ files: { "/snd/silent.mov": { hasAudio: false } } });
  const msg = failure(w.call({ compId: 7, cues: [{ path: "/snd/silent.mov", time: 1 }] }));
  assert.match(msg, /has no audio track/);
  assert.equal(w.items.length, 0, "the import must not be left behind in the project");
  assert.equal(w.layers.length, 0);
  assert.deepEqual(w.undoLog, ["begin:AE MCP: place_audio_cues", "end"], "still balanced");
});

check("a failure part-way through removes every layer and import it had made", () => {
  // The shape of the failure this whole design is for: cue 3 of 5 is refused by
  // AE for a reason nothing could have checked in advance, and the four layers
  // and two imports that already exist have to go with it.
  const w = makeWorld({ files: THREE_FILES, failOnLayer: 4 });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 0 },
      { path: "/snd/impact.wav", time: 1 },
      { path: "/snd/whoosh.wav", time: 2 },
      { path: "/snd/whoosh.wav", time: 3, name: "SFX_late" },
      { path: "/snd/impact.wav", time: 4 },
    ],
  }));
  assert.match(msg, /cue 3 \("SFX_late" at 3s\)/, "name the cue it died on");
  assert.match(msg, /no Audio Levels property/);
  assert.match(msg, /4 layer\(s\) and 2 import\(s\)/, "say how much was taken back");
  assert.equal(w.layers.length, 0, "no half-built score left in the timeline");
  assert.equal(w.items.length, 0, "and no orphan imports either");
  assert.deepEqual(w.undoLog, ["begin:AE MCP: place_audio_cues", "end"], "still one balanced undo step");
});

check("the layer that failed is itself removed, not just the ones before it", () => {
  const w = makeWorld({ files: THREE_FILES, audioLevelsMode: "missing" });
  const msg = failure(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0 }] }));
  assert.match(msg, /1 layer\(s\)/);
  assert.equal(w.layers.length, 0);
  assert.equal(w.items.length, 0);
});

// ---------- dryRun ----------

check("dryRun reports the plan and touches nothing — not even the undo stack", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({
    compId: 7,
    dryRun: true,
    cues: [
      { path: "/snd/whoosh.wav", time: 1 },
      { path: "/snd/whoosh.wav", time: 2 },
      { path: "/snd/impact.wav", time: 3, levelDb: -4 },
    ],
  }));
  assert.equal(r.dryRun, true);
  assert.equal(r.ok, true);
  assert.equal(r.wouldPlace, 3);
  assert.deepEqual(plain(r.wouldImport), ["/snd/whoosh.wav", "/snd/impact.wav"], "distinct files, in the order first named");
  assert.equal(r.cues[2].levelDb, -4);
  assert.equal(r.cues[0].name, "SFX_whoosh");
  assert.equal(w.imports.length, 0);
  assert.equal(w.layers.length, 0);
  assert.equal(w.items.length, 0);
  assert.deepEqual(w.undoLog, [], "a plan that appeared in the user's undo history would be a lie");
});

check("dryRun names the paths that are not there instead of throwing", () => {
  // This is most of its value: checking a cue list against the disk is the
  // cheap thing to do before committing 90 layers to someone's project.
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({
    compId: 7,
    dryRun: true,
    cues: [
      { path: "/snd/whoosh.wav", time: 1 },
      { path: "/snd/typo.wav", time: 2 },
      { path: "/snd/also-missing.aif", time: 3 },
    ],
  }));
  assert.equal(r.ok, false, "ok:true on a list that cannot be placed would be the lie");
  assert.equal(r.wouldPlace, 1);
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[0].cue, 1);
  assert.match(r.problems[0].reason, /no file at \/snd\/typo\.wav/);
  assert.match(r.problems[1].reason, /also-missing\.aif/);
});

check("dryRun says what it could not check", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, dryRun: true, cues: [{ path: "/snd/whoosh.wav", time: 1 }] }));
  assert.match(r.unverified, /audio track/, "whether an un-imported file has audio is not knowable yet");
  assert.match(r.note, /Nothing was imported, created or changed/);
});

check("dryRun on a list that is entirely already in the project has nothing to import", () => {
  const w = makeWorld({
    files: THREE_FILES,
    projectItems: [{ name: "whoosh", filePath: "/snd/whoosh.wav" }],
  });
  const r = success(w.call({ compId: 7, dryRun: true, cues: [{ path: "/snd/whoosh.wav", time: 1 }] }));
  assert.deepEqual(plain(r.wouldImport), []);
  assert.equal(r.unverified, undefined, "nothing unverified means the field should not be there");
  assert.equal(r.cues[0].source.kind, "reused");
});

check("a bad comp id fails the same way whether or not it is a dry run", () => {
  const w = makeWorld({ files: THREE_FILES });
  for (const dryRun of [false, true]) {
    const msg = failure(w.call({ compId: 999, dryRun, cues: [{ path: "/snd/whoosh.wav", time: 1 }] }));
    assert.match(msg, /No comp with id 999/);
  }
});

console.log(`audio-cues: ${passed} checks passed`);
