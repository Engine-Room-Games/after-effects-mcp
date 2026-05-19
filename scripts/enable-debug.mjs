#!/usr/bin/env node
// Toggles CEP PlayerDebugMode so unsigned panels can load. Restart AE (and
// sometimes the OS) for the change to take effect.

import { execSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.error("Only macOS supported by this script. On Windows: regedit -> HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.12 -> PlayerDebugMode = \"1\"");
  process.exit(1);
}

const domains = ["com.adobe.CSXS.12", "com.adobe.CSXS.11", "com.adobe.CSXS.10", "com.adobe.CSXS.9"];
for (const d of domains) {
  try {
    execSync(`defaults write ${d} PlayerDebugMode 1`, { stdio: "pipe" });
    console.log(`PlayerDebugMode=1 set on ${d}`);
  } catch (e) {
    console.error(`Failed for ${d}: ${e.message}`);
  }
}

console.log("\nDone. Restart After Effects. If unsigned panels still don't load, reboot the Mac once.");
