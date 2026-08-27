// Asserts that bundling the same sources twice produces the same bytes.
//
// `bundle.jsx` is hashed on both sides of the panel version gate: `check_setup`
// and the gate in server.ts take sha256 of the installed copy and compare it
// against the `bundleHash` the panel reports for the code it actually
// evaluated. That comparison is the only thing standing between a user and
// `Unknown op: …`, and it is only meaningful if the hash identifies the *code*.
//
// It did not. The bundler stamped `// Generated <ISO timestamp>` into the
// header, so two builds of an identical tree disagreed, and an upgrade that
// changed no ExtendScript at all still told the user to quit After Effects and
// restart it. Build identity is not code identity.
//
// Nothing else catches this: every other test reads the bundle once, and a
// single build is self-consistent by construction. The failure only appears
// when two builds are compared, which is exactly what this does.
//
//   node tests/unit/bundle-determinism.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundler = path.join(root, "scripts", "bundle-jsx.mjs");
const bundle = path.join(root, "packages", "ae-panel", "jsx", "bundle.jsx");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
let passed = 0;
const check = (label, fn) => { fn(); passed++; };

// Build twice. The bundler also syncs into an installed CEP panel when one is
// present; both writes carry identical content, so a developer's live panel is
// left exactly as it was found.
const build = () => {
  execFileSync(process.execPath, [bundler], { cwd: root, stdio: "pipe" });
  return fs.readFileSync(bundle);
};

const first = build();
const second = build();

check("two builds of an unchanged tree are byte-identical", () => {
  assert.equal(
    sha(second),
    sha(first),
    "bundle.jsx changed between two builds of identical sources.\n\n" +
      "The panel version gate compares this file's hash against the hash the\n" +
      "panel reports for the bundle it evaluated. A hash that moves on its own\n" +
      "makes that comparison mean 'a different build' rather than 'different\n" +
      "code', so users get sent to restart After Effects for no reason.\n\n" +
      "Something non-deterministic was added to scripts/bundle-jsx.mjs — a\n" +
      "timestamp, a random id, or a directory read whose order is not sorted.\n",
  );
});

// The specific regression, named, so a reintroduced timestamp fails with the
// reason rather than just "the hashes differ".
check("no build timestamp in the header", () => {
  const header = first.toString("utf8").split("\n").slice(0, 10).join("\n");
  assert.ok(
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(header),
    "bundle.jsx header carries an ISO timestamp. It makes the bundle hash a\n" +
      "build identity rather than a code identity — see the note at the top of\n" +
      "scripts/bundle-jsx.mjs. The file's mtime already records the build time.\n",
  );
});

check("the bundle is non-trivial and carries its module markers", () => {
  assert.ok(first.length > 10000, `bundle.jsx is only ${first.length} bytes`);
  const modules = first.toString("utf8").match(/^\/\/ ===== .+\.jsx =====$/gm) ?? [];
  assert.ok(modules.length >= 15, `expected the concatenated modules, found ${modules.length}`);
});

// A stable hash is only useful if it still moves when the code does.
check("a changed source still changes the hash", () => {
  const target = path.join(root, "packages", "jsx", "core.jsx");
  const original = fs.readFileSync(target);
  const backup = path.join(os.tmpdir(), `core.jsx.${process.pid}.bak`);
  fs.writeFileSync(backup, original);
  try {
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from("\n// determinism probe\n")]));
    assert.notEqual(sha(build()), sha(first), "editing a source did not change the bundle hash");
  } finally {
    fs.writeFileSync(target, original);
    fs.unlinkSync(backup);
    // Leave the tree as it was found, bundle included.
    assert.equal(sha(build()), sha(first), "failed to restore the original bundle");
  }
});

console.log(`bundle-determinism: ${passed} assertions passed`);
