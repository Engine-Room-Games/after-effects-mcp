#!/usr/bin/env node
// Concatenates packages/jsx/*.jsx in dependency order into ae-panel/jsx/bundle.jsx.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "packages", "jsx");
const outFile = path.join(root, "packages", "ae-panel", "jsx", "bundle.jsx");
const BUNDLE_ID = "games.engine-room.ae-mcp";

const order = [
  "core.jsx",
  "ids.jsx",
  "comps.jsx",
  "layers.jsx",
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
  "style.jsx",
  "batch.jsx",
  "explore.jsx",
  "raw.jsx",
];

// No build timestamp in here, deliberately. This file is hashed on both sides
// of the panel version gate — sha256 of the installed copy against the panel's
// own `bundleHash` — so whatever goes in defines what "the same bundle" means.
// A timestamp made that build identity rather than code identity: two builds of
// an unchanged tree disagreed, and an upgrade that touched no JSX still told
// the user to restart After Effects. The file's mtime already records when it
// was written. `tests/unit/bundle-determinism.mjs` holds this.
const parts = [];
parts.push("// Auto-generated bundle. Do not edit directly — edit files in packages/jsx/.");
for (const f of order) {
  const p = path.join(srcDir, f);
  if (!fs.existsSync(p)) {
    console.error(`Missing source: ${p}`);
    process.exit(1);
  }
  parts.push(`\n// ===== ${f} =====\n`);
  parts.push(fs.readFileSync(p, "utf8"));
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, parts.join("\n"), "utf8");
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
