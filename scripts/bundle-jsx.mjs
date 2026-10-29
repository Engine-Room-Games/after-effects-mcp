#!/usr/bin/env node
// Concatenates packages/jsx/*.jsx in dependency order into ae-panel/jsx/bundle.jsx.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extendScriptProblems } from "./lib/extendscript-syntax.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "packages", "jsx");
const outFile = path.join(root, "packages", "ae-panel", "jsx", "bundle.jsx");
const BUNDLE_ID = "games.engine-room.ae-mcp";

const order = [
  "core.jsx",
  "ids.jsx",
  "values.jsx",
  "comps.jsx",
  "layers.jsx",
  "snapshot.jsx",
  "checkpoint.jsx",
  "transforms.jsx",
  "keyframes.jsx",
  "expressions.jsx",
  "effects.jsx",
  "text.jsx",
  "shapes.jsx",
  "masks.jsx",
  "markers.jsx",
  "vision.jsx",
  "footage.jsx",
  "audio.jsx",
  "mogrt.jsx",
  "render.jsx",
  "style.jsx",
  "batch.jsx",
  "explore.jsx",
  "selection.jsx",
  "helpers.jsx",
  "raw.jsx",
];

// No build timestamp in here, deliberately. This file is hashed on both sides
// of the panel version gate — sha256 of the installed copy against the panel's
// own `bundleHash` — so whatever goes in defines what "the same bundle" means.
// A timestamp made that build identity rather than code identity: two builds of
// an unchanged tree disagreed, and an upgrade that touched no JSX still told
// the user to restart After Effects. The file's mtime already records when it
// was written. `tests/unit/bundle-determinism.mjs` holds this.
//
// The whole bundle is ONE function scope (issue #185). After Effects runs every
// CEP extension's evalScript, File > Scripts, ScriptUI panels and osascript's
// DoScript in the same `main` ExtendScript engine, so a bare top-level
// `function dispatch` or `var OPS` is a global anyone can overwrite — measured
// on 26.5: a ScriptUI panel's `OPS = {}` failed every op, an osascript
// `function dispatch(){}` failed every op, a File > Scripts `getCompById`
// hijacked get_comp. And the reverse: our `ease`/`shape` clobbered theirs.
//
// Wrapping the concatenation in a function makes every declaration in
// packages/jsx/*.jsx a local of this closure, with no edit to any of those
// files: they are still written as plain top-level code, and the unit tests
// still load them one at a time at a vm's global scope. The closure publishes
// exactly one global, `__AEMCP` (`$.global.__AEMCP`), which the panel calls.
// `OPS` and `JOBS` are deliberately not on it: nothing outside can reach the
// closure's tables, so replacing a global cannot change what an op runs. run_jsx still
// sees every helper, because its direct `eval` runs inside OPS.run_jsx, whose
// scope chain is this closure. `tests/unit/bundle-namespace.mjs` holds this.
const NAMESPACE = "__AEMCP";
const parts = [];
parts.push("// Auto-generated bundle. Do not edit directly — edit files in packages/jsx/.");
parts.push("(function () {");
for (const f of order) {
  const p = path.join(srcDir, f);
  if (!fs.existsSync(p)) {
    console.error(`Missing source: ${p}`);
    process.exit(1);
  }
  parts.push(`\n// ===== ${f} =====\n`);
  parts.push(fs.readFileSync(p, "utf8"));
}
// The one global. `call` takes the payload JSON string and answers a JSON
// string, stringified with the bundle's own JSON (core.jsx), so a script that
// replaces the engine's global JSON afterwards cannot break the envelope.
parts.push(`\n// ===== namespace =====\n`);
parts.push(
  `$.global.${NAMESPACE} = {\n` +
  `  id: ${JSON.stringify(BUNDLE_ID)},\n` +
  `  call: function (payloadJson) { return JSON.stringify(dispatch(payloadJson)); },\n` +
  `  dispatch: dispatch\n` +
  `};`
);
parts.push("})();");

const bundleText = parts.join("\n");

// Refuse to write a bundle After Effects cannot load (issue #164). Node runs
// every unit test happily on syntax ExtendScript rejects, and AE rejects the
// whole bundle for one such line, so this is the only gate there is. Each
// problem is reported against the source file it came from.
const problems = extendScriptProblems(bundleText);
if (problems.length) {
  const bundleLines = bundleText.split("\n");
  for (const p of problems) {
    let file = "bundle.jsx";
    let markerLine = 0;
    for (let i = p.line - 1; i >= 0; i--) {
      const m = /^\/\/ ===== (.+) =====$/.exec(bundleLines[i]);
      if (m) { file = m[1]; markerLine = i + 1; break; }
    }
    // The source starts two lines below its marker ("\n// ===== f =====\n", then a join newline).
    const srcLine = markerLine ? p.line - markerLine - 1 : p.line;
    const where = file.endsWith(".jsx") ? `packages/jsx/${file}:${srcLine}:${p.column}` : `bundle.jsx:${p.line}:${p.column}`;
    console.error(`${where}: ${p.message}\n    ${(bundleLines[p.line - 1] ?? "").trim()}`);
  }
  console.error(`\n${problems.length} problem(s): ExtendScript cannot run this, so bundle.jsx was not written.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, bundleText, "utf8");
console.log(`Wrote ${outFile} (${order.length} modules concatenated)`);

// Sync the bundle into the installed panel (mac copy installs only — symlink
// installs already point at outFile). Without this, `/reload-jsx` would
// re-evaluate the stale installed bundle and silently no-op the JSX change.
//
// Opt-in, because a build must not write outside the repo by default. The
// installed bundle is one half of the panel version gate, so an ordinary
// `npm run build` used to change what a *live* After Effects session compares
// itself against — a second session on the same machine, mid-project, would
// start being told to restart AE by a build it never ran. `install:panel` and
// the `setup_panel` tool remain the explicit ways to update an install; this
// flag is for the tight `build:jsx` -> `/reload-jsx` loop against your own AE.
const syncToInstalledPanel = process.env.AE_MCP_SYNC_PANEL === "1";
if (syncToInstalledPanel && (process.platform === "darwin" || process.platform === "win32")) {
  const extensionsDir = process.platform === "win32"
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Adobe", "CEP", "extensions")
    : path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
  const installedBundle = path.join(extensionsDir, BUNDLE_ID, "jsx", "bundle.jsx");
  if (fs.existsSync(path.dirname(installedBundle))) {
    try {
      const installedStat = fs.lstatSync(path.dirname(path.dirname(installedBundle)));
      // If the panel dir is a symlink to the source, copying is a self-write — skip.
      if (!installedStat.isSymbolicLink()) {
        fs.copyFileSync(outFile, installedBundle);
        console.log(`Synced -> ${installedBundle}`);
      }
    } catch {
      // Best-effort: missing install dir or perms — leave the source bundle in place.
    }
  }
}
