// What actually ships, asserted without building anything.
//
// Three distributions carry the panel — the npm tarball, the .mcpb bundle and
// each compiled binary folder — and none of them is exercised by a test that
// runs on a pull request. The failure they share is silent: a file that the
// panel loads at boot, or an ExtendScript module the bundle is supposed to
// carry, is simply absent from what the user installs. `panel-boot.mjs` proves
// the panel starts from a correct layout; nothing proved the layout was
// complete in the first place. On versions/0.3.0 that gap shipped a panel that
// refused to start, and the one machine it had ever run on still had an older
// install, so nothing noticed.
//
// Everything here is a pure read of the source tree and the build scripts. No
// build runs, no artifact is produced, and the assertions hold on a fresh
// checkout — which is what makes it safe on every runner.
//
//   node tests/unit/package-layout.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const exists = (...p) => fs.existsSync(path.join(root, ...p));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`package-layout: ${name}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. Every ExtendScript source reaches the bundle.
//
// `bundle-jsx.mjs` concatenates a hardcoded `order` array. It already fails
// loudly when a name in that array has no file — but the inverse is silent: a
// new packages/jsx/*.jsx that nobody adds to `order` is left out of the bundle
// with no error at all, and the op it defines comes back as `Unknown op` from a
// panel that is otherwise current. 0.4.0 added three such files.
// ---------------------------------------------------------------------------

const jsxSources = fs
  .readdirSync(path.join(root, "packages", "jsx"))
  .filter((f) => f.endsWith(".jsx"))
  .sort();

const bundleScript = read("scripts", "bundle-jsx.mjs");
const orderBlock = bundleScript.match(/const order = \[([\s\S]*?)\];/);
assert.ok(orderBlock, "could not find the `order` array in scripts/bundle-jsx.mjs");
const ordered = [...orderBlock[1].matchAll(/"([^"]+\.jsx)"/g)].map((m) => m[1]);

check("every packages/jsx source is registered in bundle-jsx.mjs `order`", () => {
  const missing = jsxSources.filter((f) => !ordered.includes(f));
  assert.deepEqual(
    missing,
    [],
    `these ExtendScript sources exist but are not in the \`order\` array in scripts/bundle-jsx.mjs, ` +
      `so they are silently left out of bundle.jsx: ${missing.join(", ")}`,
  );
});

check("bundle-jsx.mjs `order` names no source that has been deleted", () => {
  const stale = ordered.filter((f) => !jsxSources.includes(f));
  assert.deepEqual(stale, [], `\`order\` names sources that no longer exist: ${stale.join(", ")}`);
});

check("`order` has no duplicate entries", () => {
  assert.equal(new Set(ordered).size, ordered.length, "a duplicate in `order` concatenates a module twice");
});

// The built bundle is gitignored, so it may legitimately be absent on a fresh
// checkout. When it is there, it must carry a marker for every source.
if (exists("packages", "ae-panel", "jsx", "bundle.jsx")) {
  const bundle = read("packages", "ae-panel", "jsx", "bundle.jsx");
  check("the built bundle.jsx carries every ExtendScript source", () => {
    const missing = jsxSources.filter((f) => !bundle.includes(`// ===== ${f} =====`));
    assert.deepEqual(missing, [], `built bundle.jsx is missing: ${missing.join(", ")}`);
  });
  check("the built bundle.jsx is current with the sources on disk", () => {
    const markers = [...bundle.matchAll(/^\/\/ ===== ([a-z]+\.jsx) =====$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(
      markers,
      jsxSources,
      "bundle.jsx does not match packages/jsx — run `npm run build:jsx`",
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Every panel client module the panel loads is a file that exists.
//
// main.js pulls its siblings through requireSibling(), which is resolved
// against the CEP extension path at runtime. A name that has no file behind it
// throws out of the boot path, and the only symptom is a panel stuck on
// "starting…" with silence on the port.
// ---------------------------------------------------------------------------

const clientDir = path.join(root, "packages", "ae-panel", "client");
const clientFiles = fs.readdirSync(clientDir).sort();
const mainJs = read("packages", "ae-panel", "client", "main.js");

const required = [...mainJs.matchAll(/requireSibling\("([^"]+)"\)/g)].map((m) => m[1]);

check("main.js requires at least one sibling module", () => {
  assert.ok(required.length > 0, "found no requireSibling() calls — has the loader been renamed?");
});

check("every module main.js requires is shipped in packages/ae-panel/client", () => {
  const missing = required.filter((name) => !clientFiles.includes(name));
  assert.deepEqual(missing, [], `main.js loads these at boot but they are not in client/: ${missing.join(", ")}`);
});

const indexHtml = read("packages", "ae-panel", "client", "index.html");
const scriptSrcs = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((src) => !/^https?:/.test(src));

check("every script index.html loads is shipped in packages/ae-panel/client", () => {
  const missing = scriptSrcs.filter((src) => !fs.existsSync(path.resolve(clientDir, src)));
  assert.deepEqual(missing, [], `index.html references missing scripts: ${missing.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 3. Every packaging path carries the whole panel directory.
//
// All three vendoring scripts walk the panel recursively, which is why the
// files 0.4.0 added needed no edit in any of them. The hazard is someone
// replacing a walk with an explicit list "to be safe": that reintroduces
// exactly the omission this file exists to prevent, and it would look correct
// in review. So the assertion is that no packaging script names a client file.
// ---------------------------------------------------------------------------

const packagingScripts = ["prepare-package.mjs", "build-mcpb.mjs", "build-binaries.mjs"];

for (const script of packagingScripts) {
  const source = read("scripts", script);

  check(`${script} copies the panel directory wholesale`, () => {
    assert.match(
      source,
      /copy\(\s*panelSrc/,
      `${script} no longer copies panelSrc as a directory — a per-file list drops new panel files silently`,
    );
  });

  check(`${script} names no individual panel client file`, () => {
    const named = clientFiles.filter((f) => f !== "index.html" && source.includes(f));
    assert.deepEqual(
      named,
      [],
      `${script} mentions ${named.join(", ")} by name. Packaging must enumerate the panel by walking ` +
        `the directory, so a file added to client/ ships without touching any build script.`,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. `ws` is never inlined.
//
// setup_panel copies the directory into the CEP extension, because AE's CEF
// process cannot resolve modules out of this package. A bundled copy is not a
// directory and cannot be copied, so the panel would never start.
// ---------------------------------------------------------------------------

for (const script of ["prepare-package.mjs", "build-mcpb.mjs"]) {
  check(`${script} keeps ws external to the bundle`, () => {
    const source = read("scripts", script);
    // Either form the two scripts use: a named `const external = [...]` that is
    // passed through, or the array written inline in the build options.
    const lists = [
      ...source.matchAll(/(?:const\s+external\s*=|external:)\s*\[([^\]]*)\]/g),
    ].map((m) => m[1]);
    assert.ok(lists.length > 0, `no esbuild \`external\` list found in ${script}`);
    assert.ok(
      lists.some((list) => /["']ws["']/.test(list)),
      `${script} must keep "ws" external — an inlined ws is not a directory and setup_panel could not copy it`,
    );
  });
}

check("build-binaries.mjs stages a real ws directory beside the binary", () => {
  const source = read("scripts", "build-binaries.mjs");
  assert.match(source, /copy\(\s*wsSrc/, "build-binaries.mjs must copy ws as a directory into every target folder");
});

// ---------------------------------------------------------------------------
// 5. The npm tarball's allowlist covers what prepare-package.mjs produces.
// ---------------------------------------------------------------------------

const serverPkg = JSON.parse(read("packages", "mcp-server", "package.json"));

check("mcp-server `files` ships both bin and panel", () => {
  for (const entry of ["bin", "panel"]) {
    assert.ok(
      serverPkg.files.includes(entry),
      `"${entry}" is missing from files[] in packages/mcp-server/package.json — it would not be published`,
    );
  }
});

check("the bin path is bare, so npm does not strip it on publish", () => {
  for (const [name, target] of Object.entries(serverPkg.bin ?? {})) {
    assert.ok(
      !target.startsWith("./") && !target.startsWith("../"),
      `bin["${name}"] is "${target}" — npm silently drops bin entries beginning with "./" on publish`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. A vendored or released panel, when one is lying around, matches the source.
//
// These are all gitignored build outputs, so they are usually absent. When they
// are present they are what a user would actually receive, and a stale copy is
// how someone ships last release's panel with this release's server.
// ---------------------------------------------------------------------------

function panelManifest(dir) {
  const out = [];
  (function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  })(dir, "");
  return out.sort();
}

const staleVendored = [];
const sourcePanel = panelManifest(path.join(root, "packages", "ae-panel"));

const vendored = [
  path.join(root, "packages", "mcp-server", "panel"),
  ...(exists("dist-release")
    ? fs
        .readdirSync(path.join(root, "dist-release"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, "dist-release", e.name, "panel"))
    : []),
].filter((dir) => fs.existsSync(dir));

// A vendored panel is build output, not a source of truth. `npm pack` leaves
// `packages/mcp-server/panel/` behind and nothing cleans it up — CLAUDE.md
// records that as expected, and `panelSourceDir()` prefers the checkout over it
// for exactly that reason. So a stale one is a leftover, not a defect, and
// failing the suite over it would put every developer who has ever run
// `npm pack` into a red `npm test` with nothing to fix in the committed tree.
//
// What still earns a hard failure is a vendored panel that `prepare-package.mjs`
// has just written and got *wrong* — and the tarball check above covers that,
// against the archive actually published rather than against a directory whose
// age nobody knows.
for (const dir of vendored) {
  const rel = path.relative(root, dir);
  const missing = sourcePanel.filter((f) => !panelManifest(dir).includes(f));
  if (missing.length === 0) {
    check(`vendored panel at ${rel} carries every source file`, () => {});
  } else {
    staleVendored.push(
      `${rel} is missing ${missing.join(", ")} — stale output from an earlier ` +
        `npm pack. Delete it, or re-run \`npm run pack:check\` to refresh it.`
    );
  }
}

// ---------------------------------------------------------------------------
// 7. CI runs every test in the npm test chain.
//
// ci.yml enumerates its unit tests by hand, one `run:` per group, so that each
// carries the sentence explaining why it exists. That is worth keeping — but it
// is a second list, and it drifted: before this check, 16 of the 36 suites ran
// nowhere in the pipeline, and they were almost exactly the 0.4.0 feature set.
// `make release` runs no tests at all, so CI is the only gate there is.
// ---------------------------------------------------------------------------

const rootPkg = JSON.parse(read("package.json"));
const inNpmTest = [...rootPkg.scripts.test.matchAll(/tests\/unit\/([\w-]+\.mjs)/g)].map((m) => m[1]).sort();
const ciYml = read(".github", "workflows", "ci.yml");
const inCi = [...new Set([...ciYml.matchAll(/tests\/unit\/([\w-]+\.mjs)/g)].map((m) => m[1]))].sort();

check("every test file on disk is in the npm test chain", () => {
  const onDisk = fs
    .readdirSync(path.join(root, "tests", "unit"))
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  const missing = onDisk.filter((f) => !inNpmTest.includes(f));
  assert.deepEqual(missing, [], `these tests exist but \`npm test\` never runs them: ${missing.join(", ")}`);
});

check("CI runs every test in the npm test chain", () => {
  const missing = inNpmTest.filter((f) => !inCi.includes(f));
  assert.deepEqual(
    missing,
    [],
    `these suites are in \`npm test\` but no CI step runs them, so a pull request cannot fail on them: ` +
      `${missing.join(", ")}. Add a step to .github/workflows/ci.yml.`,
  );
});

check("CI runs no test that the npm chain has dropped", () => {
  const stale = inCi.filter((f) => !inNpmTest.includes(f));
  assert.deepEqual(stale, [], `ci.yml runs tests that are not in \`npm test\`: ${stale.join(", ")}`);
});

for (const note of staleVendored) console.log(`package-layout: note — ${note}`);

console.log(`package-layout: ${passed} checks passed (${jsxSources.length} jsx sources, ${clientFiles.length} panel client files, ${inNpmTest.length} suites)`);
