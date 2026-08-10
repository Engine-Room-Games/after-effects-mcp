#!/usr/bin/env node
// Propagates the published package's version to every other place that records
// one. `packages/mcp-server/package.json` is the single source of truth.
//
//   node scripts/sync-version.mjs           rewrite the others to match
//   node scripts/sync-version.mjs --check   exit 1 if any has drifted
//
// Without this, a release bumps npm and silently leaves the plugin version, the
// CEP manifest and the version the MCP server reports about itself behind.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const sourceFile = path.join(root, "packages", "mcp-server", "package.json");
const version = JSON.parse(fs.readFileSync(sourceFile, "utf8")).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Source version looks wrong: ${version}`);
  process.exit(1);
}

/** [file, regex with one capture group around the version, replacement builder] */
const targets = [
  ["package.json", /("version":\s*")([^"]+)(")/],
  ["packages/shared/package.json", /("version":\s*")([^"]+)(")/],
  ["packages/ae-panel/package.json", /("version":\s*")([^"]+)(")/],
  ["plugin/.claude-plugin/plugin.json", /("version":\s*")([^"]+)(")/],
  ["packages/mcp-server/src/index.ts", /(const VERSION = ")([^"]+)(")/],
  // Only the server's own identity string, not any other `version:` key.
  ["packages/mcp-server/src/server.ts", /(name: "after-effects-mcp", version: ")([^"]+)(")/],
  // Deliberately NOT the ExtensionManifest `Version` attribute — that is the
  // CEP schema version and must stay at 11.0.
  ["packages/ae-panel/CSXS/manifest.xml", /(ExtensionBundleVersion=")([^"]+)(")/],
  ["packages/ae-panel/CSXS/manifest.xml", /(<Extension Id="games\.engine-room\.ae-mcp\.panel" Version=")([^"]+)(")/],
];

let drifted = 0;
let changed = 0;

for (const [rel, re] of targets) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const match = before.match(re);
  if (!match) {
    console.error(`Could not find a version to sync in ${rel} — the pattern needs updating.`);
    process.exit(1);
  }
  if (match[2] === version) continue;

  if (check) {
    console.error(`  ${rel}: ${match[2]} (expected ${version})`);
    drifted++;
    continue;
  }
  fs.writeFileSync(file, before.replace(re, `$1${version}$3`), "utf8");
  console.log(`  ${rel}: ${match[2]} -> ${version}`);
  changed++;
}

if (check) {
  if (drifted > 0) {
    console.error(`\n${drifted} file(s) out of sync with ${version}. Run: node scripts/sync-version.mjs`);
    process.exit(1);
  }
  console.log(`All version strings agree on ${version}.`);
} else {
  console.log(changed === 0 ? `Already at ${version}.` : `Synced ${changed} file(s) to ${version}.`);
}
