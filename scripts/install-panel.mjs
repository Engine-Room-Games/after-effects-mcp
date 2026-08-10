#!/usr/bin/env node
// Dev equivalent of the setup_panel tool: installs the CEP panel into the
// user's Adobe extensions folder on macOS or Windows.
//
//   --symlink   point the extensions folder at the working copy instead of
//               copying, so .jsx edits are picked up by /reload-jsx with no
//               reinstall. On Windows this needs Developer Mode or an elevated
//               shell, since it creates a directory symlink.

import fs from "node:fs";
import path from "node:path";
import { loadSetup } from "./lib/setup.mjs";

const { installPanel, installedPanelDir, panelSourceDir, wsModuleDir, copyRecursive, isSupportedPlatform } =
  await loadSetup();

if (!isSupportedPlatform()) {
  console.error(`After Effects does not run on ${process.platform}.`);
  process.exit(1);
}

if (process.argv.includes("--symlink")) {
  const source = panelSourceDir();
  if (!source) {
    console.error("Could not locate packages/ae-panel.");
    process.exit(1);
  }
  const target = installedPanelDir();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(source, target, "junction");
  } catch (e) {
    console.error(`Could not create the symlink: ${e.message}`);
    if (process.platform === "win32") {
      console.error("On Windows, enable Developer Mode or run this from an elevated shell.");
    }
    process.exit(1);
  }
  // The symlinked panel resolves modules from the working copy, so `ws` has to
  // live there rather than in the installed location.
  const ws = wsModuleDir();
  if (ws) {
    const dest = path.join(source, "node_modules", "ws");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    copyRecursive(ws, dest);
  }
  console.log(`Symlinked ${source} -> ${target}`);
} else {
  const result = await installPanel({ enableDebugMode: true });
  for (const line of result.actions) console.log(line);
  for (const line of result.notes) console.log(`note: ${line}`);
  console.log(`\nPanel: ${result.panelPath}`);
}

console.log("\nNext:");
console.log("  1. Launch After Effects — the panel auto-loads.");
console.log("  2. Window > Extensions > AE MCP Bridge to see its status.");
console.log("  3. npm run doctor to verify the whole chain.");
