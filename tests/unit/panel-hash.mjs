// The panel's client hash, and the version gate that reads it (issue #243).
//
// `bundleHash` names only `jsx/bundle.jsx`, so a panel with a current bundle and
// old client code — main.js and the modules beside it — passed the version
// gate. `clientHash` names every other file of the panel. The running panel
// computes it over its own folder (client/panelhash.js) and the server over
// the panel it ships and the installed copy (setup/panelHash.ts); they must
// agree byte for byte, or every panel is "out of date".
//
// Pinned here:
//   - the two implementations agree, on the real panel and on fixtures;
//   - stale client code moves the hash, and the gate reports it;
//   - the signature files a self-signed install adds (META-INF/, mimetype) do
//     not — a signed install is a current install (#91, #182);
//   - neither do bundle.jsx (its own hash), node_modules, .DS_Store, the root
//     package.json or the manifest's version attributes — so a release that
//     changes nothing in the panel does not ask for a reinstall;
//   - the hash is a pure function of the files.
//
//   node tests/unit/panel-hash.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const panelSrc = path.join(root, "packages", "ae-panel");

const panelSide = createRequire(import.meta.url)(path.join(panelSrc, "client", "panelhash.js"));
const { panelClientHash } = await import(dist("setup", "panelHash.js"));
const { assessPanel, installedPanelHashes, sourcePanelHashes } = await import(dist("setup", "panelVersion.js"));
const { panelInstallDiff, copyRecursive } = await import(dist("setup", "paths.js"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`panel-hash FAILED: ${name}`);
    throw e;
  }
}

assert.ok(fs.existsSync(path.join(panelSrc, "jsx", "bundle.jsx")), "no bundle.jsx — run `npm run build` first");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-panel-hash-"));
let n = 0;
/** A fresh copy of the shipped panel, laid out as setup_panel installs it. */
function installCopy() {
  const dir = path.join(tmp, `install-${n++}`);
  copyRecursive(panelSrc, dir, { skip: new Set(["node_modules", ".DS_Store"]), dereference: true });
  return dir;
}
const both = (dir) => {
  const server = panelClientHash(dir);
  const panel = panelSide.panelClientHash(dir);
  assert.equal(panel, server, `panel and server disagree on ${dir}`);
  return server;
};

const SHIPPED = sourcePanelHashes();
const run = (h) => ({ ok: true, bundleHash: h.bundle, clientHash: h.client });

check("the two implementations agree on the real panel, and match what the server ships", () => {
  const h = both(panelSrc);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, SHIPPED.client);
});

check("an installed copy hashes the same as the source", () => {
  assert.equal(both(installCopy()), SHIPPED.client);
});

check("a pure function: the same files give the same hash, however often asked", () => {
  const dir = installCopy();
  assert.equal(both(dir), both(dir));
  assert.equal(both(dir), both(installCopy()));
});

check("stale client code moves the hash, and the gate says out of date", () => {
  const dir = installCopy();
  const main = path.join(dir, "client", "main.js");
  fs.writeFileSync(main, fs.readFileSync(main, "utf8") + "\n// a 0.5.x main.js\n");
  const stale = both(dir);
  assert.notEqual(stale, SHIPPED.client);
  const disk = installedPanelHashes(dir);
  // The bundle is current; only the client code is not. This passed before #243.
  assert.equal(disk.bundle, SHIPPED.bundle);
  const verdict = assessPanel(run(disk), disk);
  assert.equal(verdict.state, "update-needed", "a current bundle beside stale client code is not current");
  assert.match(verdict.message, /setup_panel/);
  // The same running panel once setup_panel has refreshed the disk: restart.
  assert.equal(assessPanel(run(disk), SHIPPED).state, "restart-needed");
});

check("a client module added or removed moves the hash", () => {
  const added = installCopy();
  fs.writeFileSync(path.join(added, "client", "pngcodec.js"), "module.exports = {};");
  assert.notEqual(both(added), SHIPPED.client);
  const removed = installCopy();
  fs.rmSync(path.join(removed, "client", "panelhash.js"));
  assert.notEqual(both(removed), SHIPPED.client);
});

check("a self-signed install is a current install", () => {
  const dir = installCopy();
  fs.mkdirSync(path.join(dir, "META-INF"));
  fs.writeFileSync(path.join(dir, "META-INF", "signatures.xml"), "<signatures/>");
  fs.writeFileSync(path.join(dir, "mimetype"), "application/vnd.adobe.air-ucf-package+zip");
  assert.equal(both(dir), SHIPPED.client);
  const disk = installedPanelHashes(dir);
  assert.deepEqual(panelInstallDiff(panelSrc, dir), []);
  assert.equal(assessPanel(run(disk), disk, { installComplete: true }).state, "current");
});

check("bundle.jsx, node_modules, .DS_Store, Thumbs.db, desktop.ini and the root package.json are not the client's", () => {
  const dir = installCopy();
  fs.appendFileSync(path.join(dir, "jsx", "bundle.jsx"), "\n// reloaded\n");
  fs.mkdirSync(path.join(dir, "node_modules", "ws"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "ws", "index.js"), "");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
  fs.writeFileSync(path.join(dir, "client", ".DS_Store"), "x");
  // Windows Explorer's equivalents, at the root and below.
  fs.writeFileSync(path.join(dir, "Thumbs.db"), "x");
  fs.writeFileSync(path.join(dir, "client", "Thumbs.db"), "x");
  fs.writeFileSync(path.join(dir, "desktop.ini"), "x");
  fs.writeFileSync(path.join(dir, "jsx", "desktop.ini"), "x");
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(pkg, fs.readFileSync(pkg, "utf8").replace(/"version":\s*"[^"]+"/, '"version": "9.9.9"'));
  assert.equal(both(dir), SHIPPED.client);
});

check("the manifest's version attributes are ignored; the rest of it is not", () => {
  const dir = installCopy();
  const manifest = path.join(dir, "CSXS", "manifest.xml");
  const original = fs.readFileSync(manifest, "utf8");
  const bumped = original
    .replace(/(ExtensionBundleVersion=")[^"]*(")/, "$19.9.9$2")
    .replace(/(<Extension\s+Id="[^"]*"\s+Version=")[^"]*(")/, "$19.9.9$2");
  assert.notEqual(bumped, original, "the fixture must actually change the version");
  fs.writeFileSync(manifest, bumped);
  assert.equal(both(dir), SHIPPED.client, "a version bump alone must not ask for a reinstall");
  fs.writeFileSync(manifest, bumped.replace("[22.0,99.9]", "[23.0,99.9]"));
  assert.notEqual(both(dir), SHIPPED.client, "any other manifest change is a different panel");
});

check("an unreadable folder hashes to null on both sides", () => {
  const missing = path.join(tmp, "nope");
  assert.equal(panelClientHash(missing), null);
  assert.equal(panelSide.panelClientHash(missing), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`panel-hash: ${passed} checks passed`);
