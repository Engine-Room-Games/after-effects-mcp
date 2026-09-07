#!/usr/bin/env node
// Allows After Effects to load unsigned CEP panels.
//   macOS:   defaults write com.adobe.CSXS.N PlayerDebugMode 1
//   Windows: HKCU\Software\Adobe\CSXS.N\PlayerDebugMode = "1"
// Restart AE afterwards (and, on some macOS builds, reboot once).

import { loadSetup } from "./lib/setup.mjs";

const { enableDebugMode, ensureCepLogging, isDebugModeOn, isSupportedPlatform, CEP_LOG_LEVEL } = await loadSetup();

if (!isSupportedPlatform()) {
  console.error(`After Effects does not run on ${process.platform}; nothing to enable.`);
  process.exit(1);
}

// Same step setup_panel takes: CEP's own log is the only place a refusal to
// load the panel is ever written (issue #91), and it is written only once
// LogLevel is set. Left alone wherever a value — any value — is already there.
const logging = await ensureCepLogging();
if (logging.set.length > 0) {
  console.log(`CEP LogLevel=${CEP_LOG_LEVEL} set for CSXS ${logging.set.join(", ")} so the CEP log records why a panel failed to load.`);
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
