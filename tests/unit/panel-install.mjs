// Install integrity: is the `ws` module really there, and is the installed
// panel really the shipped one?
//
// Both questions used to be answered by `existsSync`, and both answers were
// wrong in the same way — a path that exists while containing nothing useful.
// v0.2.0 shipped an empty node_modules/ws and a panel that was a mix of two
// versions, and reported each as fine.
//
//   node tests/unit/panel-install.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { isWsModuleDir, panelInstallDiff, wsModuleDir } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "setup", "paths.js")).href
);

let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-install-"));
const dir = (...p) => path.join(tmp, ...p);
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(dir(rel)), { recursive: true });
  fs.writeFileSync(dir(rel), body);
};

// ----------------------------------------------------------------- isWsModuleDir
// A complete copy, shaped like the real module.
write("good/package.json", JSON.stringify({ name: "ws", version: "8.0.0" }));
write("good/index.js", "module.exports = {};");
write("good/lib/websocket.js", "");
check("complete ws copy", isWsModuleDir(dir("good")), true);

// The exact v0.2.0 failure: the directory exists and is empty.
fs.mkdirSync(dir("empty"), { recursive: true });
check("empty directory", isWsModuleDir(dir("empty")), false);

// Half a copy — package.json arrived, lib/ did not.
write("truncated/package.json", JSON.stringify({ name: "ws" }));
write("truncated/index.js", "");
check("missing lib/", isWsModuleDir(dir("truncated")), false);

// Some other package that happens to sit at that path.
write("impostor/package.json", JSON.stringify({ name: "not-ws" }));
write("impostor/index.js", "");
write("impostor/lib/websocket.js", "");
check("a different package", isWsModuleDir(dir("impostor")), false);

check("nonexistent path", isWsModuleDir(dir("nope")), false);
check("not a directory", isWsModuleDir(dir("good/index.js")), false);

// The regression that matters: `wsModuleDir` resolved to "." in a compiled
// build, so the working directory was copied into the extension folder. A cwd
// must never be mistaken for the module.
check("the working directory is not ws", isWsModuleDir(process.cwd()), false);
check("a bare relative path is not ws", isWsModuleDir("."), false);

// ------------------------------------------------------------------ wsModuleDir
// Under plain Node this resolves through the module system; whatever it returns
// must be a real copy, never an unvalidated guess.
const resolved = wsModuleDir();
assert.ok(resolved, "wsModuleDir() found nothing — run `npm install` first");
assert.ok(path.isAbsolute(resolved), `wsModuleDir() returned a relative path: ${resolved}`);
check("wsModuleDir returns a real module", isWsModuleDir(resolved), true);
passed += 2;

// --------------------------------------------------------------- panelInstallDiff
write("src/CSXS/manifest.xml", "<manifest/>");
write("src/client/main.js", "boot();");
write("src/jsx/bundle.jsx", "OPS = {};");

// An exact copy is complete.
write("dst-same/CSXS/manifest.xml", "<manifest/>");
write("dst-same/client/main.js", "boot();");
write("dst-same/jsx/bundle.jsx", "OPS = {};");
check("identical trees", panelInstallDiff(dir("src"), dir("dst-same")), []);

// node_modules is excluded on both sides: the installed panel gets `ws` copied
// in beside these files, and that says nothing about whether it is current.
fs.cpSync(dir("dst-same"), dir("dst-ws"), { recursive: true });
write("dst-ws/node_modules/ws/package.json", JSON.stringify({ name: "ws" }));
write("src/node_modules/leftover/index.js", "// a dev copy in the checkout");
check("node_modules ignored on both sides", panelInstallDiff(dir("src"), dir("dst-ws")), []);

// The v0.2.0 shape: bundle.jsx updated, client files left at the old version.
// Comparing only the bundle called this current; it must not.
fs.cpSync(dir("dst-same"), dir("dst-partial"), { recursive: true });
write("dst-partial/client/main.js", "boot(); // 0.1.1");
write("dst-partial/CSXS/manifest.xml", "<manifest version='0.1.1'/>");
check("half-updated install", panelInstallDiff(dir("src"), dir("dst-partial")), [
  "CSXS/manifest.xml",
  "client/main.js",
]);

// A file that never arrived counts as differing, not as absent-and-fine.
fs.cpSync(dir("dst-same"), dir("dst-missing"), { recursive: true });
fs.rmSync(dir("dst-missing/client/main.js"));
check("missing file", panelInstallDiff(dir("src"), dir("dst-missing")), ["client/main.js"]);

// Same length, different bytes — a size-only comparison would miss this.
fs.cpSync(dir("dst-same"), dir("dst-samesize"), { recursive: true });
write("dst-samesize/jsx/bundle.jsx", "OPS = [];");
check("same size, different content", panelInstallDiff(dir("src"), dir("dst-samesize")), ["jsx/bundle.jsx"]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`panel-install: ${passed} assertions passed`);
