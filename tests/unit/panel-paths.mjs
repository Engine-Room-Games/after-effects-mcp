// getSystemPath's URL-to-native-path conversion.
//
// Worth a test of its own because the only failure it has ever produced looks
// like a missing file: CEP returns a file URL, and on Windows the drive letter
// keeps the URL's leading slash, so path.join yields \C:\...\bundle.jsx and the
// panel says bundle.jsx is not there while it sits at that exact location.
// There is no AE on a CI runner to catch it, so the conversion is checked here.
//
//   node tests/unit/panel-paths.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(
  path.join(root, "packages", "ae-panel", "client", "csinterface.js"),
  "utf8",
);

// The panel's csinterface.js is a plain browser script, not a module: run it in
// a context holding a stubbed CEP host and read the globals back out.
function loadWith(raw) {
  const context = { window: { __adobe_cep__: { getSystemPath: () => raw } } };
  vm.runInNewContext(source, context);
  return new context.CSInterface().getSystemPath(context.SystemPath.EXTENSION);
}

let passed = 0;
function check(name, actual, expected) {
  assert.equal(actual, expected, `${name}: expected "${expected}", got "${actual}"`);
  passed++;
}

const WIN_EXT = "C:/Users/rougt/AppData/Roaming/Adobe/CEP/extensions/games.engine-room.ae-mcp";
const MAC_EXT = "/Users/migs/Library/Application Support/Adobe/CEP/extensions/games.engine-room.ae-mcp";

// The reported bug: file:/// leaves /C: behind once the scheme is stripped.
check("windows file url", loadWith("file:///" + WIN_EXT), WIN_EXT);
// Some CEP builds hand back the slashed path with no scheme at all.
check("windows bare path", loadWith("/" + WIN_EXT), WIN_EXT);
// Already native: nothing to strip.
check("windows native path", loadWith("C:\\Users\\rougt\\AppData"), "C:\\Users\\rougt\\AppData");

// macOS paths start with a slash that is part of the path. Stripping it there
// would break the platform that currently works.
check("mac file url", loadWith("file://" + MAC_EXT.replace(/ /g, "%20")), MAC_EXT);
check("mac bare path", loadWith(MAC_EXT), MAC_EXT);

// What the panel actually does with the result, on the platform that broke.
const bundle = path.win32.join(loadWith("file:///" + WIN_EXT), "jsx", "bundle.jsx");
assert.ok(path.win32.isAbsolute(bundle), `not absolute on Windows: ${bundle}`);
assert.doesNotMatch(bundle, /^[\\/]/, `drive letter still behind a slash: ${bundle}`);
passed += 2;

console.log(`panel-paths: ${passed} assertions passed`);
