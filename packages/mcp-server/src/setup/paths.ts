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
 * The directory the executable sits in.
 *
 * In a compiled single-file build there is no `packageRoot()` to find: the
 * module paths point inside the executable's virtual filesystem, so nothing
 * resolves relative to them. Those builds ship the panel, `ws` and a package.json
 * as real files beside the binary instead, and this is how they are found.
 *
 * Harmless under plain Node, where it resolves to whatever directory the `node`
 * binary lives in and none of the candidates exist there — so it is always
 * consulted last rather than being gated on detecting the build type.
 */
function executableDir(): string {
  return path.dirname(process.execPath);
}

/**
 * The version of the published package, read at runtime rather than compiled in
 * so that it cannot drift from what the user actually installed. Used when a
 * problem report needs to say which build hit it.
 */
export function packageVersion(): string {
  for (const dir of [packageRoot(), executableDir()]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // Try the next layout.
    }
  }
  return "unknown";
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
    // Compiled single-file build: the panel ships beside the executable.
    path.join(executableDir(), "panel"),
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
    // Compiled build: `ws` is inlined into the executable, so it cannot be
    // resolved as a module — but a copyable directory ships beside the binary
    // precisely because the panel needs one.
    const beside = path.join(executableDir(), "node_modules", "ws");
    return fs.existsSync(beside) ? beside : null;
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
