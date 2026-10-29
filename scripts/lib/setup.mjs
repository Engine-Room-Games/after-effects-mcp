// Shared loader so the dev scripts reuse the same platform logic the
// check_setup / setup_panel tools use, instead of keeping a second, drifting
// copy of the CEP paths and the PlayerDebugMode handling.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = path.join(root, "packages", "mcp-server", "dist", "setup");

export async function loadSetup() {
  if (!fs.existsSync(path.join(distDir, "paths.js"))) {
    console.error("The TypeScript build is missing. Run `npm run build:ts` first.");
    process.exit(1);
  }
  const [paths, platform, install, check] = await Promise.all([
    import(path.join(distDir, "paths.js")),
    import(path.join(distDir, "platform.js")),
    import(path.join(distDir, "install.js")),
    import(path.join(distDir, "check.js")),
  ]);
  return { ...paths, ...platform, ...install, ...check };
}

// The packaging scripts' directory copy: setup_panel's copyRecursive, leaving
// out node_modules (the only dependency that ships, `ws`, is staged on its own)
// and .DS_Store, and copying a symlink's target rather than the link.
export async function loadPackagingCopy() {
  const file = path.join(distDir, "paths.js");
  if (!fs.existsSync(file)) {
    console.error("The TypeScript build is missing. Run `npm run build:ts` first.");
    process.exit(1);
  }
  const { copyRecursive } = await import(pathToFileURL(file).href);
  const opts = { skip: new Set(["node_modules", ".DS_Store"]), dereference: true };
  return (src, dst) => copyRecursive(src, dst, opts);
}
