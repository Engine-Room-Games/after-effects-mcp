// The panel-version decision table.
//
// Worth a test of its own because every branch is a different sentence said to
// a user, and three of the four are only reachable during an upgrade — which is
// exactly when nobody is running the manual verification recipes.
//
// Since issue #243 a panel is two hashes, `bundleHash` (the ExtendScript) and
// `clientHash` (every other file), and both must match. A current bundle beside
// old client code is out of date; a panel too old to report either is out of
// date, and enforced; and with no shipped panel to compare against the
// capabilities decide, never "pass everything".
//
//   node tests/unit/panel-version.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unsupported URL scheme.
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { assessPanel, panelDrivenBatchMessage, sourcePanelHashes, sourceBundleHash, sourceClientHash, unknownOpMessage } = await import(
  dist("setup", "panelVersion.js")
);
const { buildNextSteps, UNVERIFIABLE_DETAIL } = await import(dist("setup", "check.js"));
const { REQUIRED_PANEL_CAPABILITIES, missingCapabilities, panelCapabilities } = await import(
  dist("setup", "panelCapabilities.js")
);

const SHIPPED = sourcePanelHashes();
assert.ok(SHIPPED && SHIPPED.bundle && SHIPPED.client, "no source panel hashes — run `npm run build` first");
assert.equal(sourceBundleHash(), SHIPPED.bundle);
assert.equal(sourceClientHash(), SHIPPED.client);
const OLD = "0".repeat(64);

/** A /health body. */
const run = (bundle, client, extra = {}) => ({ ok: true, bundleHash: bundle, clientHash: client, ...extra });
const disk = (bundle, client) => ({ bundle, client });
const CURRENT_DISK = disk(SHIPPED.bundle, SHIPPED.client);
const OLD_DISK = disk(OLD, OLD);

let passed = 0;
function check(name, actual, expected) {
  assert.equal(actual, expected, `${name}: expected "${expected}", got "${actual}"`);
  passed++;
}

// Running the shipped panel: forward, say nothing.
check("running current", assessPanel(run(SHIPPED.bundle, SHIPPED.client), CURRENT_DISK).state, "current");
check("running current, disk somehow older", assessPanel(run(SHIPPED.bundle, SHIPPED.client), OLD_DISK).state, "current");

// ------------------------------------------------- the client half (issue #243)
// The gap this issue closes: the bundle is current, the client code beside it
// is not. Comparing the bundle alone called this current.
const staleClient = assessPanel(run(SHIPPED.bundle, OLD), OLD_DISK);
check("current bundle, stale client code", staleClient.state, "update-needed");
assert.match(staleClient.message, /setup_panel/);
check(
  "current bundle, stale client code, disk updated",
  assessPanel(run(SHIPPED.bundle, OLD), CURRENT_DISK).state,
  "restart-needed"
);
// And the other way round: a disk whose client files are current but whose
// bundle is not is not a current install.
check(
  "stale bundle on disk, current client on disk",
  assessPanel(run(OLD, OLD), disk(OLD, SHIPPED.client)).state,
  "update-needed"
);

// Updated on disk, AE not restarted. The distinction that matters: telling
// someone to run setup_panel again here would waste their time.
const restart = assessPanel(run(OLD, OLD), CURRENT_DISK);
check("updated but not restarted", restart.state, "restart-needed");
assert.match(restart.message, /quit and reopen/i);
assert.match(restart.message, /will not help/i, "must say re-running setup_panel is pointless");

// Never updated.
const update = assessPanel(run(OLD, OLD), OLD_DISK);
check("panel predates the server", update.state, "update-needed");
assert.match(update.message, /setup_panel/);
assert.match(update.message, /quit and reopen/i);

// A panel too old to report one hash or both. Every panel since #243 reports
// both, so this is certain, and since #243 it is enforced: "unknown" would let
// it through to a path it does not have.
for (const missing of [undefined, null, ""]) {
  const tag = JSON.stringify(missing);
  // An explicit null beside a bundle hash is a #243 panel that could not hash
  // its folder — "unverifiable", pinned below — not a too-old one.
  if (missing !== null) {
    const noClient = assessPanel(run(SHIPPED.bundle, missing), OLD_DISK);
    check(`current bundle, no clientHash (${tag}), old disk`, noClient.state, "update-needed");
    assert.match(noClient.message, /too old to report/);
  }
  check(`no hashes (${tag}), old disk`, assessPanel(run(missing, missing), OLD_DISK).state, "update-needed");
  // Disk already refreshed: a restart is the only remaining step, and we can say so.
  check(`no hashes (${tag}), fresh disk`, assessPanel(run(missing, missing), CURRENT_DISK).state, "restart-needed");
}
// A panel since #243 that could not hash its own folder says so with an
// explicit null. A restart would read the same folder, so the advice must not
// be a restart, whatever the disk says — that would loop for ever.
for (const diskNow of [CURRENT_DISK, OLD_DISK]) {
  const v = assessPanel(run(SHIPPED.bundle, null), diskNow);
  check(`clientHash null (${diskNow === CURRENT_DISK ? "current" : "old"} disk)`, v.state, "unverifiable");
  // The gate's text is quoted inside check_setup's own output, so it must not
  // send that reader back to check_setup.
  assert.doesNotMatch(v.message, /check_setup/);
  assert.match(v.message, /setup_panel/);
  assert.match(v.message, /will not change that/, "says a restart alone is not the fix");
  assert.doesNotMatch(v.message, /^Ask the user to quit and reopen/m);
}
// The key absent is a pre-#243 panel, not an unreadable folder.
check("no clientHash key, current disk", assessPanel({ ok: true, bundleHash: SHIPPED.bundle }, CURRENT_DISK).state, "restart-needed");

// A pre-0.3 /health: no hash fields at all.
check("pre-0.3 health", assessPanel({ ok: true, bundleLoaded: true }, OLD_DISK).state, "update-needed");
check("no health at all", assessPanel(null, OLD_DISK).state, "update-needed");

// A half-updated install. Every branch above that could recommend a restart
// would, and a restart cannot fix files that were never written. This is the
// state that cost three restarts in issue #20, so it outranks the restart
// verdict rather than being a special case after it.
const partial = assessPanel(run(OLD, OLD), CURRENT_DISK, { installComplete: false });
check("bundle current but install incomplete", partial.state, "partial-install");
assert.match(partial.message, /will not fix|not fix this/i, "must say a restart is not the remedy");
assert.match(partial.message, /quit after effects/i, "must say to close AE before reinstalling");
assert.match(partial.message, /setup_panel/, "must name the tool that reinstalls");
passed += 3;

// The same incomplete install, from a panel too old to report a hash.
check("no hash, install incomplete", assessPanel(run(undefined, undefined), CURRENT_DISK, { installComplete: false }).state, "partial-install");
check("stale disk, install incomplete", assessPanel(run(OLD, OLD), OLD_DISK, { installComplete: false }).state, "partial-install");

// A complete install must be unaffected, whether stated explicitly or left out.
check("explicitly complete", assessPanel(run(OLD, OLD), CURRENT_DISK, { installComplete: true }).state, "restart-needed");
check("unstated defaults to complete", assessPanel(run(OLD, OLD), CURRENT_DISK, {}).state, "restart-needed");
// A running panel that already matches is current regardless — there is nothing
// to reinstall when the code answering calls is the code we ship.
check(
  "running current beats an incomplete disk",
  assessPanel(run(SHIPPED.bundle, SHIPPED.client), CURRENT_DISK, { installComplete: false }).state,
  "current"
);

// ------------------------------------ no shipped panel to compare (issue #243)
// This used to pass every panel. Now the capabilities decide: the server has
// one path per tool, and each needs them.
const ALL = [...REQUIRED_PANEL_CAPABILITIES];
assert.deepEqual(
  ALL.slice().sort(),
  ["project-path", "server-drives-jobs", "server-images", "server-run-jsx"],
  "the required list names every path the server has"
);
passed++;
const capable = assessPanel(run(OLD, OLD, { capabilities: ALL }), null, { shipped: null });
check("no source, every capability", capable.state, "unknown");
assert.ok(capable.message.length > 0, "the let-through is explained, so the gate can log it");
for (const caps of [undefined, "server-images", [], ALL.slice(1), [1, 2, 3]]) {
  const verdict = assessPanel(run(OLD, OLD, caps === undefined ? {} : { capabilities: caps }), null, { shipped: null });
  check(`no source, capabilities ${JSON.stringify(caps)}`, verdict.state, "update-needed");
  assert.match(verdict.message, /setup_panel/);
  assert.match(verdict.message, /reinstall/, "says what to do when setup_panel has nothing to install");
}
check("no source, no health", assessPanel(null, null, { shipped: null }).state, "update-needed");
// The message says what is missing in plain words, never the capability ids.
{
  const m = assessPanel(run(OLD, OLD, { capabilities: ["project-path"] }), null, { shipped: null }).message;
  assert.match(m, /screenshots/);
  assert.match(m, /long batches/);
  for (const id of ALL) assert.ok(!m.includes(id), `message names the internal id ${id}: ${m}`);
  passed++;
}

// A batch the panel drives itself: it did recognise run_batch, so the message
// must not say it did not — it says the batch is running and to update.
{
  const m = panelDrivenBatchMessage("j_1");
  assert.match(m, /j_1/);
  assert.match(m, /must not be sent again/);
  // The batch is still applying: nothing may tell the agent to retry it, or the
  // user to quit After Effects before it has finished.
  assert.doesNotMatch(m, /retry/i);
  // The completion signal is await_job on this job, and the update comes after.
  assert.match(m, /await_job\(\{jobId: "j_1"\}\)/);
  assert.match(m, /once await_job reports it finished, and never before/);
  assert.doesNotMatch(m, /responds again/, "After Effects answering is not a completion signal");
  assert.match(m, /older than these tools/);
  assert.match(m, /setup_panel/);
  assert.doesNotMatch(m, /does not recognise/);
  passed++;
}

// panelCapabilities / missingCapabilities: a malformed field lists nothing.
assert.deepEqual(panelCapabilities({ capabilities: "server-images" }), []);
assert.deepEqual(panelCapabilities({ capabilities: ["a", 1, "b"] }), ["a", "b"]);
assert.deepEqual(panelCapabilities(null), []);
assert.deepEqual(missingCapabilities({ capabilities: ALL }), []);
assert.deepEqual(missingCapabilities({}), ALL);
passed += 5;

// check_setup's next steps for an unverifiable panel: reinstall with After
// Effects closed, never a bare restart (which re-reads the same folder).
{
  const steps = buildNextSteps(
    [
      { name: "afterEffectsRunning", ok: true, detail: "" },
      { name: "panelRunningCurrent", ok: false, detail: UNVERIFIABLE_DETAIL, fix: "x" },
    ],
    false
  ).join("\n");
  assert.match(steps, /Quit After Effects completely/);
  assert.match(steps, /setup_panel/);
  assert.match(steps, /Reopen After Effects/);
  assert.doesNotMatch(steps, /Quit and reopen After Effects so it picks up the panel/);
  passed++;
}

// Unknown-op is always a version mismatch: server.ts rejects unknown tool names
// before forwarding, so anything the panel rejects is an op this server defines.
const unknown = unknownOpMessage("get_house_style");
assert.match(unknown, /get_house_style/);
assert.match(unknown, /older than these tools/);
assert.match(unknown, /setup_panel/);
passed++;

console.log(`panel-version: ${passed} assertions passed`);
