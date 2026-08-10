import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const BUNDLE_ID = "games.engine-room.ae-mcp";

export type SupportedPlatform = "darwin" | "win32";

export function isSupportedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/**
 * Walk up to the nearest directory containing a package.json. The depth differs
 * between layouts — `<package>/dist/setup/paths.js` in a checkout versus
 * `<package>/bin/server.js` once esbuild has bundled everything into one file —
 * so a fixed number of `..` segments resolves correctly in only one of them.
 */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * The CEP panel lives in a different place depending on how the server was
 * obtained: inside the published tarball it is vendored at `<package>/panel`,
 * while in the git checkout it is a sibling workspace.
 */
export function panelSourceDir(): string | null {
  const candidates = [
    // The live workspace copy comes first so a git checkout always installs
    // what the developer is editing, never a stale vendored copy left behind by
    // a previous `npm pack`. Only the second path exists in the tarball.
    path.resolve(packageRoot(), "..", "ae-panel"),
    path.join(packageRoot(), "panel"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "CSXS", "manifest.xml"))) return dir;
  }
  return null;
}

/**
 * Per-user CEP extensions directory.
 *   macOS:   ~/Library/Application Support/Adobe/CEP/extensions
 *   Windows: %APPDATA%\Adobe\CEP\extensions
 */
export function cepExtensionsDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Adobe", "CEP", "extensions");
  }
  return path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
}

export function installedPanelDir(): string {
  return path.join(cepExtensionsDir(), BUNDLE_ID);
}

/**
 * Locate the `ws` package directory so it can be copied next to the installed
 * panel. The panel runs inside AE's CEF process, which cannot resolve modules
 * out of this package's node_modules.
 */
export function wsModuleDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("ws");
    const marker = `${path.sep}node_modules${path.sep}ws${path.sep}`;
    const idx = entry.lastIndexOf(marker);
    if (idx >= 0) return entry.slice(0, idx + marker.length - 1);
    return path.dirname(entry);
  } catch {
    return null;
  }
}

export function copyRecursive(src: string, dst: string): void {
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
