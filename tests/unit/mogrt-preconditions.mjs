// export_mogrt's preconditions and its failure reporting, against a mock AE DOM.
//
// `exportAsMotionGraphicsTemplate` answers with a boolean and nothing else, so
// once `beginSuppressDialogs()` is on there is no channel at all through which
// After Effects can say why it declined. The old code read that silence as the
// suppressed-dialog case and told the caller to retry unsuppressed and click
// the dialog — for a comp with an empty Essential Graphics panel, where no
// dialog exists and the real fix is to add a controller (issue #71). Two
// failures with opposite remedies sharing one message is the thing this repo
// keeps writing down and this is one more instance of it.
//
// What this locks in:
//   - Zero controllers is refused BEFORE the export, naming the count, and
//     without the word "dialog" appearing anywhere in the refusal.
//   - A refusal costs nothing: no export, no forced project save, no rename.
//   - One controller is not touched by that check.
//   - endSuppressDialogs runs on every path out of the export, including a
//     throw — leaving dialogs suppressed would silence the user's whole
//     session.
//   - A failure under suppression reports the cause as UNKNOWN and says a
//     dialog cannot be it; a failure without suppression is the one case where
//     a dialog may be named.
//   - A controller count the host will not give is null, never zero: an
//     unanswered question must not become a confident refusal.
//
//   node tests/unit/mogrt-preconditions.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "mogrt.jsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`mogrt-preconditions FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------- the mock DOM ----------

const PROJECT_DIR = "/proj";
const PROJECT_FILE = "/proj/show.aep";

/** Files, by path. Folders, by path. Folders that refuse writes, by path. */
let FILES;
let DIRS;
let UNWRITABLE;
/** Everything the handler did to the project, in order. */
let LOG;

function dirnameOf(p) {
  const s = String(p);
  const i = s.lastIndexOf("/");
  if (i <= 0) return "/";
  return s.substring(0, i);
}

class MockFile {
  constructor(p) { this.path = String(p); }
  get fsName() { return this.path; }
  get exists() { return FILES.has(this.path); }
  get length() { return (FILES.get(this.path) || "").length; }
  get parent() { return new MockFolder(dirnameOf(this.path)); }
  open(mode) {
    if (mode !== "w") return false;
    if (UNWRITABLE.has(dirnameOf(this.path))) return false;
    FILES.set(this.path, "");
    this._open = true;
    return true;
  }
  write(s) {
    if (!this._open) return false;
    FILES.set(this.path, (FILES.get(this.path) || "") + String(s));
    return true;
  }
  close() { this._open = false; return true; }
  remove() { FILES.delete(this.path); return true; }
}

class MockFolder {
  constructor(p) {
    let s = String(p);
    while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.substring(0, s.length - 1);
    this.path = s;
  }
  get fsName() { return this.path; }
  get exists() { return DIRS.has(this.path); }
  get parent() { return new MockFolder(dirnameOf(this.path)); }
  create() { DIRS.add(this.path); return true; }
}

class CompItem {}
class TextLayer {}

/**
 * @param opts.controllers  number, or "throws" for a host that will not answer.
 * @param opts.export       what exportAsMotionGraphicsTemplate does:
 *                          "ok" writes the file and returns true,
 *                          "silent" returns false and writes nothing,
 *                          "liar" returns true and writes nothing,
 *                          "throws" raises.
 */
function makeComp(opts) {
  const comp = new CompItem();
  comp.id = 7;
  comp.name = opts.name === undefined ? "Lower Third" : opts.name;
  comp.duration = 5;
  comp.numLayers = 0;
  comp.width = 1920;
  comp.height = 1080;
  let templateName = opts.templateName === undefined ? "Untitled" : opts.templateName;
  Object.defineProperty(comp, "motionGraphicsTemplateName", {
    get() { return templateName; },
    set(v) { templateName = v; LOG.push("rename:" + v); },
  });
  Object.defineProperty(comp, "motionGraphicsTemplateControllerCount", {
    get() {
      if (opts.controllers === "throws") throw new Error("Object does not support this property");
      return opts.controllers;
    },
  });
  comp.exportAsMotionGraphicsTemplate = function (_doSave, dir) {
    LOG.push("export:" + dir);
    const outPath = dir + "/" + templateName + ".mogrt";
    if (opts.export === "throws") throw new Error("AE blew up mid-export");
    if (opts.export === "silent") return false;
    if (opts.export === "liar") return true;
    FILES.set(outPath, "PKa real zip would go here");
    return true;
  };
  return comp;
}

function makeContext(opts) {
  FILES = new Map([[PROJECT_FILE, "aep bytes"]]);
  DIRS = new Set(["/", PROJECT_DIR]);
  UNWRITABLE = new Set(opts.unwritable || []);
  LOG = [];
  if (opts.existingTemplate) FILES.set(opts.existingTemplate, "an older .mogrt");

  const comp = makeComp(opts);
  const project = {
    get file() { return opts.projectSaved === false ? null : new MockFile(PROJECT_FILE); },
    save() { LOG.push("save"); },
    itemByID(id) { return id === comp.id ? comp : null; },
  };

  const ctx = {
    OPS: {},
    noUndo: (fn) => fn,
    File: MockFile,
    Folder: MockFolder,
    CompItem,
    TextLayer,
    String,
    Error,
    app: {
      project,
      beginSuppressDialogs() { LOG.push("beginSuppressDialogs"); },
      endSuppressDialogs(alert) { LOG.push("endSuppressDialogs:" + String(alert)); },
    },
    getCompById(id) {
      const item = project.itemByID(id);
      if (!item) throw new Error("No comp with id " + id);
      return item;
    },
    // vision.jsx supplies these; only the posterTime path reaches them.
    __tmpPngPath: () => "/tmp/poster.png",
    __saveFrameAt: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "mogrt.jsx" });
  ctx.__comp = comp;
  return ctx;
}

function run(opts, args) {
  const ctx = makeContext(opts);
  const call = (extra) => ctx.OPS.export_mogrt({ compId: 7, ...(args || {}), ...(extra || {}) });
  return { ctx, call };
}

function messageOf(fn) {
  try {
    fn();
  } catch (e) {
    return String(e.message);
  }
  throw new assert.AssertionError({ message: "expected a throw, got a result" });
}

// ---------- the empty Essential Graphics panel: issue #71 ----------

check("zero controllers is refused, naming the count and the panel", () => {
  const { call } = run({ controllers: 0, export: "ok" });
  const msg = messageOf(call);
  assert.match(msg, /0 Essential Graphics controllers/, "should name the count it measured");
  assert.match(msg, /Essential Graphics/, "should name the panel the user has to open");
  assert.match(msg, /Window > Essential Graphics/, "should say how to get there in AE");
  assert.match(msg, /export_mogrt again/, "should say what to do after fixing it");
});

check("the zero-controller refusal never mentions a dialog", () => {
  // The whole of #71. There is no dialog: naming one — even to deny it — sends
  // the reader to look for something that does not exist, and the remedy that
  // follows from it (retry unsuppressed and click) leads nowhere.
  const { call } = run({ controllers: 0, export: "ok" });
  const msg = messageOf(call);
  assert.doesNotMatch(msg, /dialog/i, "a dialog is not what happened and must not be named");
  assert.doesNotMatch(msg, /suppressDialogs/, "must not offer the suppression toggle as a remedy");
  assert.doesNotMatch(msg, /click/i, "there is nothing to click");
});

check("the refusal comes before the export, the save and the rename", () => {
  const { ctx, call } = run({ controllers: 0, export: "ok", templateName: "Untitled" });
  assert.throws(call);
  assert.deepEqual(LOG, [], "nothing may be done to the project before this check");
  assert.equal(ctx.__comp.motionGraphicsTemplateName, "Untitled", "the template must not be renamed");
  assert.equal(FILES.has("/proj/Lower Third.mogrt"), false, "nothing may be written");
});

check("one controller is not refused by that check", () => {
  const { call } = run({ controllers: 1, export: "ok" });
  const r = call();
  assert.equal(r.ok, true);
  assert.equal(r.path, "/proj/Lower Third.mogrt");
  assert.equal(r.controllerCount, 1);
  assert.ok(LOG.indexOf("export:/proj") >= 0, "the export must actually have been attempted");
});

check("a controller count the host will not give is null, never zero", () => {
  // An unanswered question must not become a confident refusal — that is the
  // same mistake as blaming a dialog, pointed the other way.
  const { call } = run({ controllers: "throws", export: "ok" });
  const r = call();
  assert.equal(r.ok, true);
  assert.equal(r.controllerCount, null);
});

// ---------- what the failure message may and may not claim ----------

check("a silent failure under suppression reports the cause as unknown", () => {
  const { call } = run({ controllers: 2, export: "silent" });
  const msg = messageOf(call);
  assert.match(msg, /the cause is unknown/, "unknown has to report as unknown");
  assert.match(msg, /a modal dialog cannot be what stopped this/,
    "suppression rules a dialog out by construction, and the message must say so");
  assert.doesNotMatch(msg, /likeliest cause/, "must not blame the dialog it just ruled out");
  assert.match(msg, /Export Motion Graphics Template/,
    "the only place the real reason exists is AE's own UI, so send the user there");
});

check("a silent failure names everything it did rule out", () => {
  const { call } = run({ controllers: 2, export: "silent" });
  const msg = messageOf(call);
  assert.match(msg, /2 Essential Graphics controllers/, "the count it checked");
  assert.match(msg, /show\.aep/, "the saved project");
  assert.match(msg, /accepts writes/, "the destination folder");
  assert.match(msg, /returned false/, "AE's own answer, whatever it was worth");
});

check("without suppression, a dialog is the one thing that may be named", () => {
  const { call } = run({ controllers: 2, export: "silent" }, { suppressDialogs: false });
  const msg = messageOf(call);
  assert.match(msg, /NOT suppressed/);
  assert.match(msg, /modal dialog waiting in After Effects is the likeliest cause/);
  assert.doesNotMatch(msg, /cannot be what stopped this/);
});

check("a truthy return with no file on disk is still a failure", () => {
  const { call } = run({ controllers: 2, export: "liar" });
  const msg = messageOf(call);
  assert.match(msg, /returned true/, "AE's claim is quoted, not believed");
  assert.match(msg, /there is no file at \/proj\/Lower Third\.mogrt/);
});

check("an unreadable count degrades the failure message rather than faking one", () => {
  const { call } = run({ controllers: "throws", export: "silent" });
  const msg = messageOf(call);
  assert.match(msg, /would not count/, "say the host would not answer");
  assert.doesNotMatch(msg, /0 Essential Graphics/, "and never invent a zero");
});

// ---------- endSuppressDialogs, on every path ----------

check("endSuppressDialogs runs after a successful export", () => {
  const { call } = run({ controllers: 1, export: "ok" });
  call();
  assert.deepEqual(
    LOG.filter((l) => l.indexOf("SuppressDialogs") >= 0),
    ["beginSuppressDialogs", "endSuppressDialogs:false"],
  );
});

check("endSuppressDialogs runs after a silent failure", () => {
  const { call } = run({ controllers: 1, export: "silent" });
  assert.throws(call);
  assert.deepEqual(
    LOG.filter((l) => l.indexOf("SuppressDialogs") >= 0),
    ["beginSuppressDialogs", "endSuppressDialogs:false"],
  );
});

check("endSuppressDialogs runs when the export itself throws", () => {
  // The path that matters most: leaving dialogs suppressed would silence every
  // warning for the rest of the user's After Effects session.
  const { call } = run({ controllers: 1, export: "throws" });
  assert.throws(call, /AE blew up mid-export/);
  assert.deepEqual(
    LOG.filter((l) => l.indexOf("SuppressDialogs") >= 0),
    ["beginSuppressDialogs", "endSuppressDialogs:false"],
  );
});

check("suppressDialogs:false neither begins nor ends suppression", () => {
  const { call } = run({ controllers: 1, export: "ok" }, { suppressDialogs: false });
  const r = call();
  assert.equal(r.dialogsSuppressed, false);
  assert.match(r.warning, /not suppressed/);
  assert.deepEqual(LOG.filter((l) => l.indexOf("SuppressDialogs") >= 0), []);
});

// ---------- the other preconditions, all before the export ----------

check("an unsaved project is refused naming the save, not a dialog to click", () => {
  const { call } = run({ controllers: 3, export: "ok", projectSaved: false });
  const msg = messageOf(call);
  assert.match(msg, /never been saved/);
  assert.match(msg, /save the project once/);
  assert.deepEqual(LOG, [], "nothing may happen before this either");
});

check("a template name that resolves outside the destination is refused", () => {
  // The name becomes the filename, so a separator sends the write elsewhere and
  // AE says nothing about it.
  const { call } = run({ controllers: 3, export: "ok" }, { name: "brand/Lower Third" });
  const msg = messageOf(call);
  assert.match(msg, /is not inside \/proj/);
  assert.match(msg, /no slashes/);
  assert.deepEqual(LOG, []);
});

check("a blank template name is refused", () => {
  const { call } = run({ controllers: 3, export: "ok" }, { name: "   " });
  assert.throws(call, /template name is empty/);
  assert.deepEqual(LOG, []);
});

check("a destination folder that refuses writes is refused, before the export", () => {
  const { call } = run({ controllers: 3, export: "ok", unwritable: [PROJECT_DIR] });
  const msg = messageOf(call);
  assert.match(msg, /cannot write into \/proj/);
  assert.match(msg, /Nothing was exported/);
  assert.deepEqual(LOG, []);
});

check("the write probe never survives the call", () => {
  const { call } = run({ controllers: 1, export: "ok" });
  call();
  assert.equal(FILES.has("/proj/.ae-mcp-write-probe"), false, "the probe must be cleaned up");
});

check("an existing template is refused without overwrite and replaced with it", () => {
  const existing = "/proj/Lower Third.mogrt";
  const refused = run({ controllers: 3, export: "ok", existingTemplate: existing });
  assert.throws(refused.call, /A template already exists at \/proj\/Lower Third\.mogrt/);
  assert.deepEqual(LOG, [], "a collision must be caught before the export");

  const replaced = run({ controllers: 3, export: "ok", existingTemplate: existing });
  const r = replaced.call({ overwrite: true });
  assert.equal(r.replaced, true);
});

check("a name the user set on the comp is kept; AE's Untitled default is not", () => {
  const kept = run({ controllers: 1, export: "ok", templateName: "Brand Lower Third" });
  assert.equal(kept.call().name, "Brand Lower Third");

  const replaced = run({ controllers: 1, export: "ok", templateName: "Untitled" });
  assert.equal(replaced.call().name, "Lower Third", "Untitled collides with every other comp");
});

console.log(`mogrt-preconditions: ${passed} checks passed`);
