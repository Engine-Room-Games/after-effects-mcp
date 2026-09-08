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
// The #85 options — loop, fadeIn/fadeOut, stretch — each move something After
// Effects then resets, so the mock does what AE is reported to do: `stretch`
// moves the start time, enabling time remap resets the out point, and removing
// the remap keyframes AE creates breaks the property (issue #86). A layer that
// lands where the caller asked proves the re-assertions are in the right order.
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

/**
 * The Time Remap property AE creates when remapping is enabled: two keyframes,
 * layer start → source 0 and layer end → source duration. Removing them is
 * the #86 trap — the property goes away and the next write throws — so the
 * mock throws on a write to a keyless remap, and counts every removal.
 */
class MockTimeRemap {
  constructor(world, layer) {
    this.world = world;
    this.keys = [{ time: 0, value: 0 }, { time: layer.source.duration, value: layer.source.duration }];
    this.expression = "";
  }
  get numKeys() { return this.keys.length; }
  removeKey(i) {
    this.keys.splice(i - 1, 1);
    this.world.remapKeysRemoved++;
  }
  setValueAtTime(t, v) {
    if (this.keys.length === 0) throw new Error("Object is invalid");
    this.keys.push({ time: t, value: v });
  }
}

class MockLayer {
  constructor(world, item) {
    this.world = world;
    this.id = world.nextLayerId++;
    this.index = world.layers.length + 1;
    this.name = item.name;
    this.source = item;
    this.label = 0;
    this.removed = false;
    this.levels = null;
    this.levelKeys = [];
    this._startTime = 0;
    this._inPoint = 0;
    this._outPoint = item.duration;
    this._stretch = 100;
    this._timeRemapEnabled = false;
    this._timeRemap = null;
    this.ordinal = world.layers.length + 1;
    // `failOnLayer` is the stand-in for whatever AE refuses on cue 30 that no
    // amount of up-front validation could have known about.
    const broken = world.audioLevelsMode === "missing" || this.ordinal === world.failOnLayer;
    if (!broken && world.audioLevelsMode === "shortcut") {
      const self = this;
      this.audioLevels = {
        setValue(v) { self.levels = plain(v); },
        setValueAtTime(t, v) {
          if (self.failsAt("keys")) throw new Error("After Effects error: unable to set keyframe");
          self.levelKeys.push({ time: t, value: plain(v) });
        },
      };
    }
  }
  failsAt(step) {
    return this.world.failStep && this.world.failStep.layer === this.ordinal && this.world.failStep.on === step;
  }
  naturalEnd() { return this._startTime + this.source.duration * this._stretch / 100; }

  // Setting startTime slides the whole layer — the trim goes with it.
  get startTime() { return this._startTime; }
  set startTime(v) {
    const delta = v - this._startTime;
    this._startTime = v;
    this._inPoint += delta;
    this._outPoint += delta;
  }
  get inPoint() { return this._inPoint; }
  set inPoint(v) {
    // The stricter of the two things AE might do with an in point past the out
    // point, so the tool has to extend before it trims.
    if (v > this._outPoint) throw new Error("After Effects error: in point must be before out point");
    this._inPoint = v;
  }
  get outPoint() { return this._outPoint; }
  set outPoint(v) {
    // A plain layer cannot extend past what the source supplies — AE clamps.
    // Only a time-remapped one can.
    if (!this._timeRemapEnabled && v > this.naturalEnd()) v = this.naturalEnd();
    this._outPoint = v;
  }
  get stretch() { return this._stretch; }
  set stretch(v) {
    if (this.failsAt("stretch")) throw new Error("After Effects error: cannot stretch this layer");
    this._stretch = v;
    // Which point AE holds in place is not measured; what is reported is that
    // the start time moves. Move it, so a tool that does not re-assert it fails.
    this._startTime -= 0.25;
    this._inPoint = this._startTime;
    this._outPoint = this.naturalEnd();
  }
  get canSetTimeRemapEnabled() {
    if (this.world.remapRefusedOnLayer === this.ordinal) return false;
    return true;
  }
  get timeRemapEnabled() { return this._timeRemapEnabled; }
  set timeRemapEnabled(v) {
    if (this.failsAt("remap")) throw new Error("After Effects error: cannot enable time remapping");
    this._timeRemapEnabled = v;
    if (v) {
      this._timeRemap = new MockTimeRemap(this.world, this);
      // Enabling remap resets the out point to the source's own end.
      this._outPoint = this.naturalEnd();
    }
  }
  get timeRemap() {
    if (this.world.timeRemapMode !== "shortcut") return undefined;
    return this._timeRemap;
  }
  // The trap: on a real audio layer this returns null for Audio Levels (and
  // for Time Remap). Every name answers null here, so any code path that went
  // looking through property() instead of the shortcut fails loudly.
  property(name) {
    this.world.propertyCalls.push(name);
    if (name === "Audio" && this.world.audioLevelsMode === "group") {
      const self = this;
      return { property: (k) => (k === "Audio Levels" ? { setValue(v) { self.levels = plain(v); }, setValueAtTime(t, v) { self.levelKeys.push({ time: t, value: plain(v) }); } } : null) };
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
function makeWorld({
  files = {},
  projectItems = [],
  compDuration = 30,
  audioLevelsMode = "shortcut",
  timeRemapMode = "shortcut",
  failOnLayer = 0,
  remapRefusedOnLayer = 0,
  failStep = null,
} = {}) {
  const world = {
    files,
    items: [],
    layers: [],
    imports: [],
    undoLog: [],
    propertyCalls: [],
    remapKeysRemoved: 0,
    nextItemId: 100,
    nextLayerId: 500,
    audioLevelsMode,
    timeRemapMode,
    failOnLayer,
    remapRefusedOnLayer,
    failStep,
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

/** Own keys of a result object, sorted — result objects come out of the VM realm. */
const keysOf = (o) => Object.keys(o).sort();

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
  assert.deepEqual(w.layers.map((l) => l.levelKeys), [[], [], []], "no fade asked for, no keyframes written");
  assert.equal(w.propertyCalls.length, 0, "layer.property() must not be the route to Audio Levels");
  assert.equal(r.levelUnit, "dB");
  assert.equal(r.fadeFloorDb, undefined, "the floor is only reported when something faded");
});

check("reports the layer ids and times the caller has to carry forward, and nothing it already knows", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 1.5, levelDb: -3, label: "red" }] }));
  const p = r.placed[0];
  assert.equal(p.layerId, w.layers[0].id);
  assert.equal(p.name, "SFX_whoosh");
  assert.equal(p.time, 1.5);
  // #88: a plain cue's entry is the three things the caller cannot know or
  // must carry forward. levelDb, label, index and itemId were echoes.
  assert.deepEqual(keysOf(p), ["layerId", "name", "time"]);
  assert.equal(r.sources.imported[0].itemId, w.items[0].id, "the item id lives in sources, once per file");
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
  const ids = new Set(w.layers.map((l) => l.source.id));
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
  assert.equal(w.layers[0].source.id, id);
  assert.equal(r.sources.reused[0].itemId, id);
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
  assert.equal(r.placed[0].outPoint, 5);
  assert.deepEqual(keysOf(r.placed[0]), ["inPoint", "layerId", "name", "outPoint", "time"], "in/out appear only because they were asked for");
});

check("an outPoint past the file's end reports where AE actually stopped the layer", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/impact.wav", time: 1, outPoint: 9 }] }));
  assert.equal(r.placed[0].outPoint, 1.8, "0.8s file from 1s: AE clamps, and the caller sees the clamp");
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

// ---------- loop (#85) ----------

check("loop: remap on, AE's keys kept, the wrap expression set, out point re-asserted to the comp's end", () => {
  const w = makeWorld({ files: THREE_FILES, compDuration: 30 });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 2, loop: true, name: "Bed" }] }));
  const l = w.layers[0];
  assert.equal(l.timeRemapEnabled, true);
  assert.equal(l.timeRemap.numKeys, 2, "the default remap keys must stay — removing them hides the property (#86)");
  assert.equal(w.remapKeysRemoved, 0);
  assert.equal(l.timeRemap.expression, "(time - startTime) % thisLayer.source.duration");
  assert.equal(l.startTime, 2);
  assert.equal(l.outPoint, 30, "the mock reset the out point when remap went on; the tool must put it back");
  assert.equal(r.placed[0].looped, true);
  assert.equal(r.placed[0].outPoint, 30);
  assert.deepEqual(keysOf(r.placed[0]), ["layerId", "looped", "name", "outPoint", "time"]);
  assert.deepEqual(l.levels, [0, 0], "a loop with no fade still gets its level written");
  assert.equal(w.propertyCalls.length, 0, "Time Remap is reached through the shortcut, never layer.property()");
});

check("loop: a given outPoint is the loop's end, and an in point past the file's own end lands", () => {
  // 1.2s file at 5s ends naturally at 6.2s. An in point at 8s only makes
  // sense once the layer can extend, which is why the out point goes first.
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 5, inPoint: 8, outPoint: 20, loop: true }] }));
  assert.equal(w.layers[0].inPoint, 8);
  assert.equal(w.layers[0].outPoint, 20);
  assert.equal(r.placed[0].inPoint, 8);
  assert.equal(r.placed[0].outPoint, 20);
});

check("loop: an in point at or past the loop's end is a planning error, naming which end", () => {
  const w = makeWorld({ files: THREE_FILES, compDuration: 10 });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 5, inPoint: 10, loop: true },
      { path: "/snd/whoosh.wav", time: 5, inPoint: 9, outPoint: 9, loop: true },
    ],
  }));
  assert.match(msg, /cue 0: inPoint 10s is not before the end of the loop at 10s \(the comp's end, since no outPoint was given\)/);
  assert.match(msg, /cue 1: outPoint 9s is not after the cue starts at 9s/, "the plain trim check gets there first");
  assert.equal(w.layers.length, 0);
});

check("loop: refused where AE says remapping cannot be enabled, and rolled back with everything before it", () => {
  const w = makeWorld({ files: THREE_FILES, remapRefusedOnLayer: 3 });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 0 },
      { path: "/snd/impact.wav", time: 1 },
      { path: "/snd/riser.aif", time: 2, loop: true, name: "Bed" },
      { path: "/snd/whoosh.wav", time: 3 },
    ],
  }));
  assert.match(msg, /cue 2 \("Bed" at 2s\)/);
  assert.match(msg, /cannot loop/);
  assert.match(msg, /3 layer\(s\) and 3 import\(s\)/, "the layer that failed counts, and so do the two before it");
  assert.equal(w.layers.length, 0);
  assert.equal(w.items.length, 0);
  assert.deepEqual(w.undoLog, ["begin:AE MCP: place_audio_cues", "end"]);
});

check("loop: a Time Remap property that cannot be found is reported, not skipped", () => {
  const w = makeWorld({ files: THREE_FILES, timeRemapMode: "missing" });
  const msg = failure(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0, loop: true }] }));
  assert.match(msg, /Time Remap property could not be found/);
  assert.match(msg, /loop expression could not be set/);
  assert.equal(w.layers.length, 0, "a layer that is remapped but not looping is not what was asked for");
});

// ---------- stretch (#85) ----------

check("stretch: set on the layer, start time re-asserted after it, the new end reported", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 4, stretch: 200 }] }));
  const l = w.layers[0];
  assert.equal(l.stretch, 200);
  assert.equal(l.startTime, 4, "the mock moved the start when stretch was set; the tool must put it back");
  assert.equal(l.inPoint, 4);
  assert.equal(l.outPoint, 6.4, "1.2s at half speed is 2.4s long");
  assert.equal(r.placed[0].stretch, 200, "read back from the layer");
  assert.equal(r.placed[0].outPoint, 6.4);
  assert.deepEqual(keysOf(r.placed[0]), ["layerId", "name", "outPoint", "stretch", "time"]);
});

check("stretch: a trim is applied after it, in comp time, as asked", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/riser.aif", time: 1, stretch: 50, inPoint: 1.5, outPoint: 2.5 }] }));
  assert.equal(w.layers[0].startTime, 1);
  assert.equal(w.layers[0].inPoint, 1.5);
  assert.equal(w.layers[0].outPoint, 2.5);
  assert.equal(r.placed[0].stretch, 50);
});

check("stretch: a looped, stretched cue has the factor baked into its expression", () => {
  const w = makeWorld({ files: THREE_FILES });
  success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0, loop: true, stretch: 200 }] }));
  assert.equal(w.layers[0].timeRemap.expression, "((time - startTime) * 100 / 200) % thisLayer.source.duration");
  assert.equal(w.layers[0].stretch, 200);
  assert.equal(w.layers[0].outPoint, 30);
});

check("stretch: a stretch of 100 leaves the loop expression plain", () => {
  const w = makeWorld({ files: THREE_FILES });
  success(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0, loop: true, stretch: 100 }] }));
  assert.equal(w.layers[0].timeRemap.expression, "(time - startTime) % thisLayer.source.duration");
});

check("stretch: 0, negative and non-numeric are planning errors, reported by cue with the others", () => {
  const w = makeWorld({ files: THREE_FILES });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 0, stretch: 0 },
      { path: "/snd/whoosh.wav", time: 1, stretch: -50 },
      { path: "/snd/whoosh.wav", time: 2, stretch: "fast" },
      { path: "/snd/nope.wav", time: 3 },
    ],
  }));
  assert.match(msg, /cue 0: stretch must be a percentage greater than 0 \(100 is unchanged, 200 is half speed\); got 0/);
  assert.match(msg, /cue 1: stretch must be .*; got -50/);
  assert.match(msg, /cue 2: stretch must be .*; got fast/);
  assert.match(msg, /cue 3: no file at/);
  assert.match(msg, /4 of 4 cues/);
  assert.equal(w.layers.length, 0);
  assert.equal(w.imports.length, 0);
});

check("stretch: an AE refusal while stretching rolls back the lot", () => {
  const w = makeWorld({ files: THREE_FILES, failStep: { layer: 2, on: "stretch" } });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/whoosh.wav", time: 0 },
      { path: "/snd/whoosh.wav", time: 1, stretch: 150, name: "Slow" },
      { path: "/snd/whoosh.wav", time: 2 },
    ],
  }));
  assert.match(msg, /cue 1 \("Slow" at 1s\): After Effects error: cannot stretch this layer/);
  assert.match(msg, /2 layer\(s\) and 1 import\(s\)/);
  assert.equal(w.layers.length, 0);
  assert.equal(w.items.length, 0);
});

// ---------- fades (#85) ----------

check("fade: four keys on Audio Levels at the layer's real in/out, floor to level and back, default floor -48", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, cues: [{ path: "/snd/riser.aif", time: 2, levelDb: -6, fadeIn: 0.5, fadeOut: 1 }] }));
  const l = w.layers[0];
  assert.equal(l.levels, null, "a faded cue is keyframed, not set flat first and then keyed over");
  assert.deepEqual(l.levelKeys, [
    { time: 2, value: [-48, -48] },
    { time: 2.5, value: [-6, -6] },
    { time: 5, value: [-6, -6] },
    { time: 6, value: [-48, -48] },
  ]);
  assert.equal(r.placed[0].fadeIn, 0.5);
  assert.equal(r.placed[0].fadeOut, 1);
  assert.deepEqual(keysOf(r.placed[0]), ["fadeIn", "fadeOut", "layerId", "name", "time"]);
  assert.equal(r.fadeFloorDb, -48, "the floor the keys used, reported once at the top");
  assert.equal(w.propertyCalls.length, 0, "keys go through the shortcut too");
});

check("fade: fadeIn alone is two keys and the level holds after; fadeOut alone the mirror", () => {
  const w = makeWorld({ files: THREE_FILES });
  success(w.call({
    compId: 7,
    cues: [
      { path: "/snd/riser.aif", time: 0, fadeIn: 1 },
      { path: "/snd/riser.aif", time: 10, fadeOut: 2, levelDb: -3 },
    ],
  }));
  assert.deepEqual(w.layers[0].levelKeys, [{ time: 0, value: [-48, -48] }, { time: 1, value: [0, 0] }]);
  assert.deepEqual(w.layers[1].levelKeys, [{ time: 12, value: [-3, -3] }, { time: 14, value: [-48, -48] }]);
});

check("fade: fadeFloorDb is honoured, and a fade of 0 is no fade", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({
    compId: 7,
    fadeFloorDb: -60,
    cues: [
      { path: "/snd/riser.aif", time: 0, fadeIn: 1 },
      { path: "/snd/riser.aif", time: 5, fadeIn: 0, fadeOut: 0 },
    ],
  }));
  assert.deepEqual(w.layers[0].levelKeys[0], { time: 0, value: [-60, -60] });
  assert.deepEqual(w.layers[1].levelKeys, []);
  assert.deepEqual(w.layers[1].levels, [0, 0]);
  assert.equal(r.fadeFloorDb, -60);
  assert.deepEqual(keysOf(r.placed[1]), ["layerId", "name", "time"], "a zero fade is not reported as a fade");
});

check("fade: keys follow the trim, the stretch and the loop end, since they sit at the real in/out", () => {
  const w = makeWorld({ files: THREE_FILES, compDuration: 30 });
  success(w.call({
    compId: 7,
    cues: [
      { path: "/snd/riser.aif", time: 1, inPoint: 2, outPoint: 4, fadeIn: 0.5, fadeOut: 0.5 },
      { path: "/snd/whoosh.wav", time: 10, stretch: 200, fadeOut: 1 },
      { path: "/snd/whoosh.wav", time: 20, loop: true, fadeIn: 2, fadeOut: 2 },
    ],
  }));
  assert.deepEqual(w.layers[0].levelKeys.map((k) => k.time), [2, 2.5, 3.5, 4]);
  assert.deepEqual(w.layers[1].levelKeys.map((k) => k.time), [11.4, 12.4], "1.2s at half speed ends at 12.4s");
  assert.deepEqual(w.layers[2].levelKeys.map((k) => k.time), [20, 22, 28, 30], "a loop fades out at the comp's end");
});

check("fade: longer than the cue is a planning error where the length is known, with every other problem", () => {
  const w = makeWorld({
    files: THREE_FILES,
    compDuration: 10,
    projectItems: [{ name: "Boom", filePath: "/snd/boom.wav", duration: 2 }],
  });
  const boom = w.items[0].id;
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { footageId: boom, time: 0, fadeIn: 1.5, fadeOut: 1 },
      { footageId: boom, time: 1, fadeIn: 3 },
      { path: "/snd/whoosh.wav", time: 2, outPoint: 2.5, fadeOut: 1 },
      { path: "/snd/whoosh.wav", time: 8, loop: true, fadeIn: 1, fadeOut: 1.5 },
      { footageId: boom, time: 3, fadeIn: -1 },
      { footageId: boom, time: 3, fadeOut: "long" },
      { footageId: boom, time: 3, fadeIn: 1, levelDb: -50 },
      { footageId: boom, time: 3, fadeIn: 1, fadeOut: 1 },
    ],
  }));
  assert.match(msg, /cue 0: fadeIn 1\.5s \+ fadeOut 1s = 2\.5s is longer than the cue, which runs 2s \(from 0s to 2s\) — the file's own length/);
  assert.match(msg, /cue 1: fadeIn 3s is longer than the cue, which runs 2s/);
  assert.match(msg, /cue 2: fadeOut 1s is longer than the cue, which runs 0\.5s \(from 2s to 2\.5s\)/, "a capped outPoint is a known length even before import");
  assert.match(msg, /cue 3: fadeIn 1s \+ fadeOut 1\.5s = 2\.5s is longer than the cue, which runs 2s \(from 8s to 10s\)/, "a loop is measured to its end, not the file's");
  assert.doesNotMatch(msg, /cue 3: .*file's own length/, "the file-length hint is wrong for a loop");
  assert.match(msg, /cue 4: fadeIn must be a number of seconds, 0 or more; got -1/);
  assert.match(msg, /cue 5: fadeOut must be a number of seconds, 0 or more; got long/);
  assert.match(msg, /cue 6: fadeFloorDb -48 is not below the cue's level -50 dB/);
  assert.doesNotMatch(msg, /cue 7/, "1s + 1s fits a 2s cue exactly");
  assert.match(msg, /7 of 8 cues/);
  assert.equal(w.layers.length, 0);
  assert.equal(w.imports.length, 0);
});

check("fade: on a file not yet imported the check runs after the import, before any layer, and rolls the import back", () => {
  const w = makeWorld({ files: THREE_FILES });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/impact.wav", time: 0 },
      { path: "/snd/impact.wav", time: 1, fadeIn: 1 },
      { path: "/snd/whoosh.wav", time: 2, fadeOut: 0.5 },
      { path: "/snd/impact.wav", time: 3, fadeOut: 2 },
    ],
  }));
  assert.match(msg, /the fades on 2 cue\(s\) do not fit the files once imported/);
  assert.match(msg, /cue 1: fadeIn 1s is longer than the cue, which runs 0\.8s/);
  assert.match(msg, /cue 3: fadeOut 2s is longer than the cue, which runs 0\.8s/);
  assert.doesNotMatch(msg, /cue 2/, "0.5s fits a 1.2s file");
  assert.match(msg, /0 layer\(s\) and 2 import\(s\) it had already made were removed/);
  assert.equal(w.layers.length, 0, "no layer may exist before the deferred check passes");
  assert.equal(w.items.length, 0, "and the imports it cost are taken back");
});

check("fade: a bad fadeFloorDb is refused for the whole call", () => {
  const w = makeWorld({ files: THREE_FILES });
  const msg = failure(w.call({ compId: 7, fadeFloorDb: "quiet", cues: [{ path: "/snd/whoosh.wav", time: 0 }] }));
  assert.match(msg, /fadeFloorDb must be a number of decibels \(the default is -48\); got quiet/);
});

check("fade: an AE refusal while keyframing rolls back the lot, including the layer that failed", () => {
  const w = makeWorld({ files: THREE_FILES, failStep: { layer: 3, on: "keys" } });
  const msg = failure(w.call({
    compId: 7,
    cues: [
      { path: "/snd/riser.aif", time: 0, fadeIn: 1 },
      { path: "/snd/riser.aif", time: 5 },
      { path: "/snd/riser.aif", time: 10, fadeOut: 1, name: "Tail" },
      { path: "/snd/riser.aif", time: 15 },
    ],
  }));
  assert.match(msg, /cue 2 \("Tail" at 10s\): After Effects error: unable to set keyframe/);
  assert.match(msg, /3 layer\(s\) and 1 import\(s\)/);
  assert.equal(w.layers.length, 0);
  assert.equal(w.items.length, 0);
  assert.deepEqual(w.undoLog, ["begin:AE MCP: place_audio_cues", "end"], "still one balanced undo step");
});

check("a bad loop flag is a planning error too", () => {
  const w = makeWorld({ files: THREE_FILES });
  const msg = failure(w.call({ compId: 7, cues: [{ path: "/snd/whoosh.wav", time: 0, loop: "yes" }] }));
  assert.match(msg, /cue 0: loop must be true or false; got yes/);
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

// ---------- dryRun (#88: counts and the failing cues, never the list) ----------

check("dryRun reports counts and touches nothing — not even the undo stack", () => {
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
  assert.equal(r.cueCount, 3);
  assert.equal(r.wouldPlace, 3);
  assert.deepEqual(plain(r.wouldImport), ["/snd/whoosh.wav", "/snd/impact.wav"], "distinct files, in the order first named");
  assert.deepEqual(plain(r.wouldReuse), []);
  assert.deepEqual(plain(r.problems), []);
  assert.equal(r.cues, undefined, "an all-fine answer must not echo the resolved list back (#88)");
  assert.deepEqual(keysOf(r), ["compId", "compName", "cueCount", "dryRun", "note", "ok", "problems", "unverified", "wouldImport", "wouldPlace", "wouldReuse"]);
  assert.equal(w.imports.length, 0);
  assert.equal(w.layers.length, 0);
  assert.equal(w.items.length, 0);
  assert.deepEqual(w.undoLog, [], "a plan that appeared in the user's undo history would be a lie");
});

check("dryRun names the paths that are not there instead of throwing, and only those", () => {
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
  assert.equal(r.problems[1].cue, 2);
  assert.match(r.problems[1].reason, /also-missing\.aif/);
  assert.equal(r.cues, undefined);
});

check("dryRun says what it could not check, fades included", () => {
  const w = makeWorld({ files: THREE_FILES });
  const r = success(w.call({ compId: 7, dryRun: true, cues: [{ path: "/snd/whoosh.wav", time: 1 }] }));
  assert.match(r.unverified, /audio track/, "whether an un-imported file has audio is not knowable yet");
  assert.doesNotMatch(r.unverified, /fade/, "no fade asked for, nothing to say about one");
  assert.match(r.note, /Nothing was imported, created or changed/);

  const r2 = success(w.call({
    compId: 7,
    dryRun: true,
    cues: [
      { path: "/snd/whoosh.wav", time: 1, fadeIn: 5 },
      { path: "/snd/whoosh.wav", time: 2, fadeIn: 1, outPoint: 2.5 },
      { path: "/snd/whoosh.wav", time: 3, loop: true, fadeOut: 3 },
    ],
  }));
  assert.equal(r2.ok, false);
  assert.equal(r2.problems.length, 1, "the capped one is a known misfit; the loop fits its end");
  assert.equal(r2.problems[0].cue, 1);
  assert.match(r2.unverified, /for 1 cue\(s\) with a fade, whether the fade fits the file's length/, "the uncapped one is only checkable after import");
  assert.equal(r2.faded, 2);
  assert.equal(r2.looped, 1);
  assert.equal(r2.stretched, undefined, "zero counts are not reported");
});

check("dryRun on a list that is entirely already in the project has nothing to import", () => {
  const w = makeWorld({
    files: THREE_FILES,
    projectItems: [{ name: "whoosh", filePath: "/snd/whoosh.wav" }, { name: "Boom", filePath: "/snd/boom.wav" }],
  });
  const boom = w.items[1].id;
  const r = success(w.call({
    compId: 7,
    dryRun: true,
    cues: [
      { path: "/snd/whoosh.wav", time: 1 },
      { path: "/snd/whoosh.wav", time: 2 },
      { footageId: boom, time: 3, stretch: 90 },
    ],
  }));
  assert.deepEqual(plain(r.wouldImport), []);
  assert.equal(r.unverified, undefined, "nothing unverified means the field should not be there");
  assert.equal(r.wouldReuse.length, 2, "one entry per distinct item, however many cues name it");
  assert.equal(r.wouldReuse[0].itemId, w.items[0].id);
  assert.equal(r.wouldReuse[0].path, "/snd/whoosh.wav");
  assert.equal(r.wouldReuse[1].itemId, boom);
  assert.equal(r.wouldReuse[1].name, "Boom");
  assert.equal(r.wouldReuse[1].path, undefined, "an id cue gave no path");
  assert.equal(r.stretched, 1);
});

check("a bad comp id fails the same way whether or not it is a dry run", () => {
  const w = makeWorld({ files: THREE_FILES });
  for (const dryRun of [false, true]) {
    const msg = failure(w.call({ compId: 999, dryRun, cues: [{ path: "/snd/whoosh.wav", time: 1 }] }));
    assert.match(msg, /No comp with id 999/);
  }
});

console.log(`audio-cues: ${passed} checks passed`);
