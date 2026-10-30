// check_setup and the gate on a cleanly installed OLDER panel (issue #243).
//
// Found in the live test: a 0.5.x panel installed cleanly, months ago, differs
// from the shipped one in many files, so the file diff called it incomplete
// and every message said "a mix of two versions — installed while After
// Effects was open". The panel was simply older, and the message these tools
// exist to give — update your panel — never reached the users it was for.
// Pinned here, with a real installed folder under a scratch home and a fake
// panel answering /health on an ephemeral port (never 7777, never the real AE):
//   - uniformly older install: update-needed, from the gate's assessment and
//     from check_setup's panelRunningCurrent and panelUpToDate;
//   - genuinely mixed install (bundle current, client files old): partial-install;
//   - current install, current running panel: current.
//
//   node tests/unit/check-setup-panel.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const panelSrc = path.join(root, "packages", "ae-panel");

// A scratch home before anything resolves the CEP folder from it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-check-setup-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, "AppData", "Roaming");

const { checkSetup } = await import(dist("setup", "check.js"));
const { installedPanelDir, copyRecursive } = await import(dist("setup", "paths.js"));
const { assessPanel, installedPanelHashes, sourcePanelHashes } = await import(dist("setup", "panelVersion.js"));

const installed = installedPanelDir();
assert.ok(installed.startsWith(home), `the CEP folder must resolve under the scratch home, got ${installed}`);
const SHIPPED = sourcePanelHashes();

let health = {};
const panel = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, port: panel.address().port, bundleLoaded: true, ...health }));
});
await new Promise((r) => panel.listen(0, "127.0.0.1", r));
const port = panel.address().port;
assert.notEqual(port, 7777);

function install() {
  fs.rmSync(installed, { recursive: true, force: true });
  copyRecursive(panelSrc, installed, { skip: new Set(["node_modules", ".DS_Store"]), dereference: true });
}
const edit = (rel, tail) => fs.appendFileSync(path.join(installed, rel), tail);
const byName = (report, name) => report.checks.find((c) => c.name === name);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`check-setup-panel FAILED: ${name}`);
    throw e;
  }
}

try {
  await check("a cleanly installed older panel is told to update, never that it is a mix", async () => {
    install();
    // An older release: its bundle and its client code both differ.
    edit("jsx/bundle.jsx", "\n// 0.5.2\n");
    edit("client/main.js", "\n// 0.5.2\n");
    const disk = installedPanelHashes(installed);
    // What the old panel reports: pre-#243, so no clientHash.
    health = { bundleHash: disk.bundle };
    const report = await checkSetup({ candidates: [port], opPort: port });
    const running = byName(report, "panelRunningCurrent");
    assert.equal(running.ok, false);
    assert.match(running.detail, /older than these tools/, running.detail);
    assert.doesNotMatch(running.fix, /mix of two versions/);
    assert.match(running.fix, /setup_panel/);
    const upToDate = byName(report, "panelUpToDate");
    assert.equal(upToDate.ok, false);
    assert.match(upToDate.fix, /older version/);
    assert.doesNotMatch(upToDate.fix, /which is what this is/);
    assert.ok(!report.nextSteps.join("\n").includes("is what leaves the panel half-updated"));
    // The gate's own assessment, as panelGate makes it (file diff non-empty).
    assert.equal(assessPanel(health, disk, { installComplete: false }).state, "update-needed");
  });

  await check("a genuinely mixed install is partial-install", async () => {
    install();
    edit("client/main.js", "\n// 0.5.2\n"); // the bundle landed, the client code did not
    const disk = installedPanelHashes(installed);
    assert.equal(disk.bundle, SHIPPED.bundle);
    health = { bundleHash: "0".repeat(64) };
    const report = await checkSetup({ candidates: [port], opPort: port });
    assert.match(byName(report, "panelRunningCurrent").detail, /mix of versions/);
    assert.match(byName(report, "panelUpToDate").fix, /which is what this is/);
    assert.equal(assessPanel(health, disk, { installComplete: false }).state, "partial-install");
  });

  await check("a current install running the current panel is current", async () => {
    install();
    health = { bundleHash: SHIPPED.bundle, clientHash: SHIPPED.client };
    const report = await checkSetup({ candidates: [port], opPort: port });
    assert.equal(byName(report, "panelRunningCurrent").ok, true);
    assert.equal(byName(report, "panelUpToDate").ok, true);
  });
} finally {
  panel.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`check-setup-panel: ${passed} checks passed`);
