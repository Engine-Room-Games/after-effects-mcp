// get_house_style / set_house_style moved from style.jsx to the server
// (issue #220, stage 2). The jsx copy stays in the bundle — an older server,
// and a `run_batch` step, still reach it — so the two must give the same
// answer, key for key and sentence for sentence, and leave the same bytes on
// disk.
//
// Each scenario is set up in a real temporary folder, run through the jsx
// handler (with ExtendScript's File modelled on the real filesystem, see
// lib/es-file.mjs), reset, set up again, and run through the TypeScript port.
// The answers are compared as serialized JSON, so key order counts.
//
//   node tests/unit/house-style-files.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EsFile, EsFolder, outcome, resetDir, scratchDir, snapshotTree } from "./lib/es-file.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { readHouseStyle, writeHouseStyle, houseStylePath } = await import(dist("files", "houseStyle.js"));

const ctx = { OPS: {}, noUndo: (fn) => fn, File: EsFile, Folder: EsFolder, app: { project: { file: null } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "packages", "jsx", "style.jsx"), "utf8"), ctx);

const dir = scratchDir("style");
const aep = path.join(dir, "show.aep");
const guide = path.join(dir, "house-style.md");
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

let passed = 0;

/**
 * @param name     what the scenario is
 * @param setup    builds the folder; returns the .aep path, or null for an unsaved project
 * @param op       "get" | "set"
 * @param args     the op's args
 */
function parity(name, setup, op, args = {}) {
  resetDir(dir);
  const aepPath = setup();
  ctx.app.project.file = aepPath ? new EsFile(aepPath) : null;
  const jsx = outcome(() => (op === "get" ? ctx.OPS.get_house_style(args) : ctx.OPS.set_house_style(args)));
  const jsxDisk = snapshotTree(dir);

  resetDir(dir);
  setup();
  const ts = outcome(() => (op === "get" ? readHouseStyle(aepPath) : writeHouseStyle(aepPath, args)));
  const tsDisk = snapshotTree(dir);
  resetDir(dir);

  try {
    assert.equal(JSON.stringify(ts), JSON.stringify(jsx), "same answer, same key order, same wording");
    assert.deepEqual(tsDisk, jsxDisk, "same bytes left on disk");
  } catch (e) {
    console.error(`house-style-files FAILED: ${name}`);
    throw e;
  }
  passed++;
  return ts;
}

const saved = () => { fs.writeFileSync(aep, "aep"); return aep; };
const withGuide = (text, enc = "utf8") => () => { saved(); fs.writeFileSync(guide, text, enc); return aep; };

// ---------- get ----------

let r = parity("unsaved project", () => null, "get");
assert.equal(r.value.projectSaved, false);

r = parity("saved, no guide yet", saved, "get");
assert.equal(r.value.path, guide);
assert.equal(r.value.found, false);

r = parity("a guide with LF endings", withGuide("# Style\n\n## Palette\n- Ink #111111\n"), "get");
assert.equal(r.value.bytes, r.value.content.length);

r = parity("CRLF endings read back as LF", withGuide("# Style\r\n\r\nline\r\n"), "get");
assert.equal(r.value.content, "# Style\n\nline\n");

parity("bare CR endings (the 0.5.0 bug's output) read back as LF", withGuide("# Style\rline\r"), "get");
parity("a UTF-8 BOM is not part of the content", withGuide("﻿# Style\n"), "get");
parity("non-ASCII survives: curly quotes, em dash, accented font", withGuide("“Söhne” — Bréton\n"), "get");
parity("an empty guide", withGuide(""), "get");

if (canChmod) {
  parity("a guide that cannot be read", () => { withGuide("# x\n")(); fs.chmodSync(guide, 0o000); return aep; }, "get");
}
parity("a folder where the guide should be", () => { saved(); fs.mkdirSync(guide); return aep; }, "get");

// ---------- set ----------

parity("unsaved project refuses", () => null, "set", { content: "# x\n" });
r = parity("new guide is created, LF on disk", saved, "set", { content: "# Style\n\n- one\n" });
assert.equal(r.value.created, true);
parity("existing guide without overwrite refuses", withGuide("old\n"), "set", { content: "new\n" });
r = parity("existing guide with overwrite replaces", withGuide("old\n"), "set", { content: "new “one”\n", overwrite: true });
assert.equal(r.value.replaced, true);
parity("empty content refuses", saved, "set", { content: "" });
parity("missing content refuses", saved, "set", {});
if (canChmod) {
  parity("a folder that refuses writes", () => { saved(); fs.chmodSync(dir, 0o555); return aep; }, "set", { content: "# x\n" });
}

// The path is the one the jsx would have built from the same .aep.
assert.equal(houseStylePath(aep), new EsFile(new EsFile(aep).parent.fsName + "/house-style.md").fsName);
assert.equal(houseStylePath(null), null);
passed++;

fs.rmSync(dir, { recursive: true, force: true });
console.log(`house-style-files: ${passed} checks passed`);
