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
  "mogrt.jsx",
  "style.jsx",
  "batch.jsx",
  "explore.jsx",
  "raw.jsx",
];

const parts = [];
parts.push("// Auto-generated bundle. Do not edit directly — edit files in packages/jsx/.");
parts.push("// Generated " + new Date().toISOString());
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
console.log(`Wrote ${outFile} (${parts.length - 2} modules concatenated)`);

// Sync the bundle into the installed panel (mac copy installs only — symlink
// installs already point at outFile). Without this, `/reload-jsx` would
// re-evaluate the stale installed bundle and silently no-op the JSX change.
if (process.platform === "darwin" || process.platform === "win32") {
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
