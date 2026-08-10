#!/usr/bin/env node
// Removes the CEP panel from the user's Adobe extensions folder.

import fs from "node:fs";
import { loadSetup } from "./lib/setup.mjs";

const { installedPanelDir, isSupportedPlatform } = await loadSetup();

if (!isSupportedPlatform()) {
  console.error(`After Effects does not run on ${process.platform}; nothing to remove.`);
  process.exit(1);
}

const target = installedPanelDir();
if (!fs.lstatSync(target, { throwIfNoEntry: false })) {
  console.log(`Nothing to remove at ${target}`);
  process.exit(0);
}

fs.rmSync(target, { recursive: true, force: true });
console.log(`Removed ${target}`);
console.log("Restart After Effects to unload it.");
