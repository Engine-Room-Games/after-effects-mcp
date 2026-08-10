#!/usr/bin/env node
// Allows After Effects to load unsigned CEP panels.
//   macOS:   defaults write com.adobe.CSXS.N PlayerDebugMode 1
//   Windows: HKCU\Software\Adobe\CSXS.N\PlayerDebugMode = "1"
// Restart AE afterwards (and, on some macOS builds, reboot once).

import { loadSetup } from "./lib/setup.mjs";

const { enableDebugMode, isDebugModeOn, isSupportedPlatform } = await loadSetup();

if (!isSupportedPlatform()) {
  console.error(`After Effects does not run on ${process.platform}; nothing to enable.`);
  process.exit(1);
}

const before = await isDebugModeOn();
if (before.on) {
  console.log(`Already enabled — ${before.detail}. Nothing to do.`);
  process.exit(0);
}

const versions = await enableDebugMode();
if (versions.length === 0) {
  console.error("Could not set PlayerDebugMode for any CEP version.");
  process.exit(1);
}

console.log(`PlayerDebugMode=1 set for CSXS ${versions.join(", ")}.`);
console.log("\nRestart After Effects.");
if (process.platform === "darwin") {
  console.log("If unsigned panels still do not load, reboot the Mac once.");
}
