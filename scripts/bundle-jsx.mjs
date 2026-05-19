#!/usr/bin/env node
// Concatenates packages/jsx/*.jsx in dependency order into ae-panel/jsx/bundle.jsx.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "packages", "jsx");
const outFile = path.join(root, "packages", "ae-panel", "jsx", "bundle.jsx");

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
