#!/usr/bin/env node
// Builds `dist-release/after-effects-mcp.mcpb` — the one-click bundle for
// Claude Desktop.
//
// This is the install path for people who do not have Node and should not have
// to get it: Claude Desktop ships its own runtime and runs the bundle on that.
// Double-click, approve, done. No terminal, no PATH, no version manager.
//
// The layout inside the zip has to satisfy what the server looks for at runtime
// (see packages/mcp-server/src/setup/paths.ts):
//
//   manifest.json          what Claude Desktop reads
//   package.json           packageRoot() walks up to this; carries the version
//   server/index.js        esbuild bundle, ESM
//   node_modules/ws/       must be a real directory — setup_panel copies it
//                          into the CEP extension, so it cannot be inlined
//   panel/                 the CEP panel, vendored like the npm tarball does
//
// Usage: node scripts/build-mcpb.mjs [--out <dir>]

import Ajv from "ajv";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPkg = path.join(root, "packages", "mcp-server");
const panelSrc = path.join(root, "packages", "ae-panel");

const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(root, "dist-release");
const staging = path.join(outDir, "mcpb-staging");
const manifestJson = JSON.parse(fs.readFileSync(path.join(serverPkg, "package.json"), "utf8"));
const version = manifestJson.version;
const bundleFile = path.join(outDir, `after-effects-mcp-${version}.mcpb`);

if (!fs.existsSync(path.join(panelSrc, "jsx", "bundle.jsx"))) {
  console.error("Missing packages/ae-panel/jsx/bundle.jsx. Run `npm run build` first.");
  process.exit(1);
}

// `zip` is the only external tool here. Releases are cut from a Mac, where it
// is always present; fail loudly rather than producing a broken archive.
try {
  execFileSync("zip", ["-v"], { stdio: "ignore" });
} catch {
  console.error("`zip` is not available. It is needed to package the .mcpb (a zip archive).");
  process.exit(1);
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

// ---------------------------------------------------------------- server
// `ws` stays external because setup_panel copies the directory itself. Anything
// else is inlined: there is no npm install step inside a bundle.
await build({
  entryPoints: [path.join(serverPkg, "src", "index.ts")],
  outfile: path.join(staging, "server", "index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["ws"],
  logLevel: "warning",
});

// ------------------------------------------------------------- package.json
// Trimmed to what the runtime actually reads: the version (reported in issue
// reports and by check_setup) and `type: module` so the ESM bundle loads.
fs.writeFileSync(
  path.join(staging, "package.json"),
  JSON.stringify(
    {
      name: manifestJson.name,
      version,
      type: "module",
      private: true,
      dependencies: { ws: manifestJson.dependencies.ws },
    },
    null,
    2
  ) + "\n"
);

// ------------------------------------------------------------------- ws
const wsSrc = path.join(root, "node_modules", "ws");
if (!fs.existsSync(wsSrc)) {
  console.error(`Missing ${wsSrc}. Run \`npm install\` first.`);
  process.exit(1);
}
copy(wsSrc, path.join(staging, "node_modules", "ws"));

// ----------------------------------------------------------------- panel
copy(panelSrc, path.join(staging, "panel"));

// -------------------------------------------------------------- manifest
const { schemas } = await import("@engineroom/shared");
const { OpSchemas } = schemas;
// pathToFileURL: a bare Windows absolute path is an unsupported URL scheme to
// the ESM loader.
const dist = (...parts) => pathToFileURL(path.join(serverPkg, "dist", ...parts)).href;
const { descriptions } = await import(dist("tools", "descriptions.js"));
const { PROMPTS } = await import(dist("generated", "content.js"));

const manifest = {
  manifest_version: "0.2",
  name: "after-effects-mcp",
  display_name: "After Effects",
  version,
  description: manifestJson.description,
  long_description:
    "Describe the animation you want — a lower third, a logo reveal, an animated counter — and it gets built " +
    "in your open After Effects project: layers, keyframes, easing, effects, expressions and text, all editable " +
    "afterwards like anything you would make by hand. Requires After Effects 2026. A small panel is installed " +
    "into After Effects the first time you use it; just ask it to set up After Effects.",
  author: { name: "Engine Room", url: "https://github.com/Engine-Room-Games" },
  homepage: manifestJson.homepage,
  documentation: manifestJson.homepage,
  support: manifestJson.bugs.url,
  license: manifestJson.license,
  keywords: manifestJson.keywords,
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
    },
  },
  tools: Object.keys(OpSchemas).map((name) => ({
    name,
    description: (descriptions[name] ?? `AE op: ${name}`).split(". ")[0] + ".",
  })),
  // `text` is required — MANIFEST.md's prose calls it optional, but the schema
  // Claude Desktop validates against lists it alongside `name`, and a bundle
  // missing it fails to install with "Invalid manifest: prompts: Required".
  // The body is the real prompt, so it goes in verbatim with the placeholder
  // rewritten from the server's `$ARGUMENTS` to the manifest's
  // `${arguments.<name>}` form. The argument is named "arguments" because that
  // is the name server.ts declares for it over MCP; the two have to agree.
  // The replacer is a function so `$` in the replacement stays literal —
  // the string form would read `$…` as a substitution pattern.
  prompts: PROMPTS.map((p) => ({
    name: p.name,
    description: p.description,
    ...(p.argumentHint ? { arguments: ["arguments"] } : {}),
    text: p.body.replaceAll("$ARGUMENTS", () => "${arguments.arguments}"),
  })),
  compatibility: {
    platforms: ["darwin", "win32"],
    runtimes: { node: ">=22.0.0" },
  },
};
// Claude Desktop validates this on install, so an invalid manifest is not
// discovered until someone double-clicks the .mcpb — which is to say, after the
// release is public. v0.2.0 shipped with `text` missing from every prompt and
// installed as "Invalid manifest: prompts: Required, Required, Required".
// Checking here turns that into a failed build. The schema is the frozen v0.2
// copy from anthropics/mcpb matching `manifest_version` above, so it cannot
// drift underneath us; bump both together. Note that MANIFEST.md's prose
// disagrees with the schema on which prompt fields are required — the schema is
// what actually runs.
// strict:false: the schema uses `format` keywords ajv does not load by default,
// and an unrecognised format must not fail the build.
const schema = JSON.parse(
  fs.readFileSync(path.join(root, "scripts", "schemas", "mcpb-manifest-v0.2.schema.json"), "utf8")
);
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
if (!ajv.validate(schema, manifest)) {
  console.error("The generated manifest does not satisfy the MCPB v0.2 schema:");
  for (const e of ajv.errors) console.error(`  ${e.instancePath || "(root)"} ${e.message}`);
  process.exit(1);
}

fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// ------------------------------------------------------------------- zip
fs.rmSync(bundleFile, { force: true });
// -X drops the extended attributes macOS would otherwise scatter through the
// archive; the exclusions keep Finder debris out of a file users install.
execFileSync("zip", ["-r", "-q", "-X", bundleFile, ".", "-x", ".DS_Store", "-x", "__MACOSX/*"], {
  cwd: staging,
});
fs.rmSync(staging, { recursive: true, force: true });

const mb = (fs.statSync(bundleFile).size / 1024 / 1024).toFixed(1);
console.log(`Built ${path.relative(root, bundleFile)} (${mb} MB, ${manifest.tools.length} tools)`);

function copy(src, dst) {
  const base = path.basename(src);
  // The panel carries a dev node_modules; the only dependency that ships is the
  // `ws` copy staged explicitly above.
  if (base === "node_modules" || base === ".DS_Store") return;
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.copyFileSync(src, dst);
  }
}
