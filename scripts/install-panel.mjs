#!/usr/bin/env node
// Symlinks packages/ae-panel into ~/Library/Application Support/Adobe/CEP/extensions/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "packages", "ae-panel");
const bundleId = "com.engineroom.ae-mcp";

if (process.platform !== "darwin") {
  console.error("This installer targets macOS. Adapt manually for Windows.");
  process.exit(1);
}

const cepDir = path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
const targetPath = path.join(cepDir, bundleId);

if (!fs.existsSync(sourcePath)) {
  console.error(`Source missing: ${sourcePath}`);
  process.exit(1);
}

fs.mkdirSync(cepDir, { recursive: true });

if (fs.existsSync(targetPath) || fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
  const backup = `${targetPath}.bak-${Date.now()}`;
  fs.renameSync(targetPath, backup);
  console.log(`Existing install backed up to ${backup}`);
}

// Use copy by default on macOS to avoid Adobe's symlink-rejection quirks.
// User can pass --symlink to override.
const useSymlink = process.argv.includes("--symlink");

if (useSymlink) {
  fs.symlinkSync(sourcePath, targetPath, "dir");
  console.log(`Symlinked ${sourcePath} -> ${targetPath}`);
} else {
  copyRecursive(sourcePath, targetPath);
  console.log(`Copied ${sourcePath} -> ${targetPath}`);
  console.log("Tip: re-run `npm run install:panel` after edits, or pass --symlink for live updates.");
}

// Ensure `ws` is available to the panel's Node-enabled CEF context. npm
// workspaces hoist deps to the repo root, but the installed panel lives outside
// the repo and has no access to that. Copy ws into the panel's own
// node_modules. (ws has zero runtime deps; peerDeps are optional speedups.)
const wsSrc = path.join(root, "node_modules", "ws");
if (fs.existsSync(wsSrc)) {
  const wsDst = useSymlink
    ? path.join(sourcePath, "node_modules", "ws")
    : path.join(targetPath, "node_modules", "ws");
  fs.mkdirSync(path.dirname(wsDst), { recursive: true });
  if (fs.existsSync(wsDst)) fs.rmSync(wsDst, { recursive: true, force: true });
  copyRecursive(wsSrc, wsDst);
  console.log(`Copied ws -> ${wsDst}`);
} else {
  console.error("Warning: node_modules/ws not found at repo root. Run `npm install` and re-run install:panel.");
}

console.log("\nNext:");
console.log("  1. If you haven't yet, run: npm run enable:debug  (then reboot)");
console.log("  2. Launch After Effects 2026 — panel auto-loads.");
console.log("  3. (optional) Window > Extensions > AE MCP Bridge to see status.");
console.log("  4. npm run doctor  to verify.");

function copyRecursive(src, dst) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
  } else {
    fs.copyFileSync(src, dst);
  }
}
