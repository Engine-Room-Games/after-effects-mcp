#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  console.error("This uninstaller targets macOS.");
  process.exit(1);
}

const cepDir = path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
const targetPath = path.join(cepDir, "games.engine-room.ae-mcp");

if (!fs.existsSync(targetPath) && !fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
  console.log("Nothing to remove at " + targetPath);
  process.exit(0);
}

fs.rmSync(targetPath, { recursive: true, force: true });
console.log("Removed " + targetPath);
