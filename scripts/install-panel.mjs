#!/usr/bin/env node
// Dev equivalent of the setup_panel tool: installs the CEP panel into the
// user's Adobe extensions folder on macOS or Windows.
//
//   --symlink   point the extensions folder at the working copy instead of
//               copying, so .jsx edits are picked up by /reload-jsx with no
//               reinstall. On Windows this needs Developer Mode or an elevated
//               shell, since it creates a directory symlink.
//   --ae-closed only when the check for a running After Effects cannot run on
//               this machine and you know it is quit (mirrors setup_panel's
//               afterEffectsClosed). Never overrides a detected running AE.
//
// Like setup_panel, this refuses while After Effects is running (issue #262),
// in both modes. The symlink flow is no exception: creating the link deletes
// the very folder the running AE loaded and rewrites `ws` beside it, which is
// the half-updated state #262 is about. The live-AE part of the dev loop is
// `/reload-jsx` after the link exists, and that does not come through here. The
// one thing allowed with AE open is a no-op: the link already points at this
// working copy, so there is nothing to write.

import fs from "node:fs";
import path from "node:path";
import { loadSetup } from "./lib/setup.mjs";

const {
  installPanel,
  installedPanelDir,
  panelSourceDir,
  wsModuleDir,
  copyRecursive,
  isSupportedPlatform,
  afterEffectsProcess,
} = await loadSetup();

if (!isSupportedPlatform()) {
  console.error(`After Effects does not run on ${process.platform}.`);
  process.exit(1);
}

const symlink = process.argv.includes("--symlink");
const aeClosed = process.argv.includes("--ae-closed");

function alreadyLinked(source, target) {
  try {
    return fs.lstatSync(target).isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(source);
  } catch {
    return false;
  }
}

const ae = await afterEffectsProcess();
if (ae.state !== "not-running" && !(ae.state === "unknown" && aeClosed)) {
  const source = panelSourceDir();
  if (symlink && ae.state === "running" && source && alreadyLinked(source, installedPanelDir())) {
    console.log(`Already symlinked ${installedPanelDir()} -> ${source}; nothing to do. Use /reload-jsx for .jsx edits.`);
    process.exit(0);
  }
  if (ae.state === "running") {
    console.error(`After Effects is open (found: ${ae.detail}), so nothing was installed and nothing has been changed.`);
    console.error("Installing while it is open leaves the panel half-updated. Quit After Effects completely,");
    console.error("run this again, then reopen After Effects.");
  } else {
    console.error(`Could not tell whether After Effects is open (${ae.detail}), so nothing was installed.`);
    console.error("Make sure After Effects is completely quit, then run this again with --ae-closed.");
  }
  process.exit(1);
}

if (symlink) {
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
  let result;
  try {
    // installPanel asks again; the answer above only decided the wording.
    result = await installPanel({ enableDebugMode: true, afterEffectsClosed: aeClosed });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const line of result.actions) console.log(line);
  for (const line of result.notes) console.log(`note: ${line}`);
  console.log(`\nPanel: ${result.panelPath}`);
}

console.log("\nNext:");
console.log("  1. Open After Effects — the panel auto-loads.");
console.log("  2. Window > Extensions > AE MCP Bridge to see its status.");
console.log("  3. npm run doctor to verify the whole chain.");
