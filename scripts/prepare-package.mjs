#!/usr/bin/env node
// Produces the two artifacts that only exist in the published tarball:
//
//   packages/mcp-server/bin/server.js  a single-file build with the workspace
//                                      `@engineroom/shared` inlined, since that
//                                      package is never published on its own
//   packages/mcp-server/panel/         a copy of the CEP panel, so `setup_panel`
//                                      can install it without a git checkout
//
// Runs from `prepack`, so `npm publish` and `npm pack` pick it up automatically.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPkg = path.join(root, "packages", "mcp-server");
const panelSrc = path.join(root, "packages", "ae-panel");
const panelDst = path.join(serverPkg, "panel");
const outFile = path.join(serverPkg, "bin", "server.js");

// Real npm dependencies stay external so npm installs them normally. `ws` in
// particular MUST remain a resolvable directory on disk — setup_panel copies it
// into the installed CEP extension, and a bundled copy could not be copied.
const external = ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "ws", "zod", "zod-to-json-schema"];

const bundleJsx = path.join(panelSrc, "jsx", "bundle.jsx");
if (!fs.existsSync(bundleJsx)) {
  console.error(`Missing ${bundleJsx}. Run \`npm run build:jsx\` first.`);
  process.exit(1);
}

// The guidance the agent reads is compiled in from generated/content.ts. Packing
// a stale copy would ship tool guidance that disagrees with the tools, silently
// — so check here as well as in CI, since `npm publish` can be run by hand.
execFileSync(process.execPath, [path.join(root, "scripts", "build-guides.mjs"), "--check"], {
  stdio: "inherit",
});

await build({
  entryPoints: [path.join(serverPkg, "src", "index.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  // Match the `engines` floor, not the version that happens to be building:
  // this is the oldest runtime the published bundle has to parse on.
  target: "node22",
  format: "esm",
  external,
  // No `banner` here: esbuild preserves the entry point's own hashbang, and
  // adding one produces a second `#!` on line 2, which is a syntax error.
  logLevel: "warning",
});
fs.chmodSync(outFile, 0o755);

const firstLine = fs.readFileSync(outFile, "utf8").split("\n", 1)[0];
if (!firstLine.startsWith("#!")) {
  console.error("Bundle lost its hashbang — the published bin would not be executable.");
  process.exit(1);
}

// npm's publish-time normalization silently DROPS bin entries whose path starts
// with "./" — it only warns, so the package publishes without an executable and
// `npx` breaks. `npm pack` does not apply the same rule, so a local tarball test
// will not catch it. Keep bin paths bare.
const manifest = JSON.parse(fs.readFileSync(path.join(serverPkg, "package.json"), "utf8"));
for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  if (typeof target !== "string" || target.startsWith("./") || target.startsWith("../")) {
    console.error(`bin["${name}"] is "${target}" — npm will strip it on publish. Use a bare path like "bin/server.js".`);
    process.exit(1);
  }
}
console.log(`Bundled ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);

// Vendor the panel. node_modules is excluded: setup_panel re-vendors `ws` from
// the server's own dependency tree at install time.
const SKIP = new Set(["node_modules", ".DS_Store"]);
fs.rmSync(panelDst, { recursive: true, force: true });
copy(panelSrc, panelDst);
console.log(`Vendored panel -> ${path.relative(root, panelDst)}`);

// npm renders the package README on the registry page, and `files` only picks
// up ones that physically sit in the package directory.
for (const name of ["README.md", "LICENSE"]) {
  const from = path.join(root, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(serverPkg, name));
}
console.log("Copied README.md + LICENSE into the package");

function copy(src, dst) {
  if (SKIP.has(path.basename(src))) return;
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.copyFileSync(src, dst);
  }
}
