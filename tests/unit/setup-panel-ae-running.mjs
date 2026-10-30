// setup_panel and a running After Effects (issue #262).
//
// Installing while After Effects is open does not work: AE holds the panel's
// files, and the install comes out half-updated. So:
//
//   - setup_panel refuses while AE runs, and the refusal writes nothing — not a
//     panel file, not an Adobe preference
//   - when the process check itself cannot run, it refuses too, unless the user
//     has confirmed AE is quit (afterEffectsClosed) — and that confirmation
//     never overrides an AE that was detected
//   - every message that sends the user to setup_panel says quit → setup_panel
//     → reopen, in that order; none says "setup_panel, then restart"
//
// The process check is stubbed: no test here reads the machine it runs on,
// except the one that asks the real check for *an* answer.
//
//   node tests/unit/setup-panel-ae-running.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const {
  installPanel,
  SetupPanelRefusedError,
  afterEffectsRunningRefusal,
  afterEffectsUnknownRefusal,
  SIGNED_INSTALL_OVERWRITTEN_NOTE,
} = await import(dist("setup", "install.js"));
const { afterEffectsProcess, afterEffectsFromPgrep, afterEffectsFromTasklist, isAfterEffectsAppCommand } = await import(
  dist("setup", "platform.js")
);
const { checkSetup } = await import(dist("setup", "check.js"));
const { installedPanelDir } = await import(dist("setup", "paths.js"));
const { buildNextSteps } = await import(dist("setup", "check.js"));
const { assessPanel, unknownOpMessage, panelDrivenBatchMessage } = await import(dist("setup", "panelVersion.js"));
const { BridgeUnreachableError } = await import(dist("util", "errors.js"));
const { SetupPanel } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`setup-panel-ae-running FAILED: ${name}`);
    throw e;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-262-"));
const savedEnv = { ...process.env };
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}
function fakeHome(name) {
  const home = path.join(tmp, name);
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  const target = installedPanelDir();
  assert.ok(target.startsWith(home), `installedPanelDir() escaped the fake home: ${target}`);
  return target;
}

/** Every file under a folder with its hash, so "nothing changed" is a byte-level claim. */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, r))).digest("hex");
    }
  };
  if (fs.existsSync(dir)) walk("");
  return out;
}

/** Stand-ins for every preference and process call, recording each write. */
function prefs(states) {
  const log = { writes: 0, asked: 0 };
  const queue = [...states];
  return {
    log,
    calls: {
      isDebugModeOn: async () => ({ on: false, detail: "off" }),
      enableDebugMode: async () => { log.writes++; return [12]; },
      ensureCepLogging: async () => { log.writes++; return { set: [12], kept: [] }; },
      afterEffectsProcess: async () => {
        log.asked++;
        return queue.length > 1 ? queue.shift() : queue[0];
      },
    },
  };
}
const RUNNING = { state: "running", detail: "12345 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app" };
const CLOSED = { state: "not-running", detail: "no After Effects process" };
const UNKNOWN = { state: "unknown", detail: "pgrep failed: spawn pgrep ENOENT" };

/**
 * The order #262 asks for, in any message that sends the reader to setup_panel:
 * a quit before it, an open/reopen after it, and never "setup_panel … then
 * restart/quit".
 */
function assertQuitInstallReopen(label, text) {
  const at = text.indexOf("setup_panel");
  assert.ok(at >= 0, `${label}: does not name setup_panel: ${text}`);
  const quit = text.search(/quit After Effects|After Effects is completely quit|Keep After Effects closed/i);
  assert.ok(quit >= 0 && quit < at, `${label}: setup_panel comes before any quit: ${text}`);
  assert.match(text.slice(at), /\b(re)?open\b/i, `${label}: nothing after setup_panel says to open After Effects: ${text}`);
  assert.doesNotMatch(text, /setup_panel[^.]*\b(then|and)\b[^.]*\b(restart|quit)\b/i, `${label}: says setup_panel, then restart/quit: ${text}`);
}

// --------------------------------------------------------------- the refusal

await check("After Effects running: refused, nothing written, quit → setup_panel → reopen", async () => {
  try {
    const target = fakeHome("running-fresh");
    const p = prefs([RUNNING]);
    await assert.rejects(
      installPanel({ prefs: p.calls }),
      (e) => e instanceof SetupPanelRefusedError && e.reason === "after-effects-running" && e.message === afterEffectsRunningRefusal(RUNNING.detail)
    );
    assert.equal(fs.existsSync(target), false, "a refused install created the panel folder");
    assert.equal(fs.existsSync(path.dirname(target)), false, "a refused install created the extensions folder");
    assert.equal(p.log.writes, 0, "a refused install wrote an Adobe preference");
  } finally { restoreEnv(); }
});

await check("After Effects running over an existing install: not a byte moves, force or no force", async () => {
  try {
    const target = fakeHome("running-existing");
    await installPanel({ prefs: prefs([CLOSED]).calls, enableDebugMode: false });
    fs.appendFileSync(path.join(target, "CSXS", "manifest.xml"), " "); // an older install, so it would be replaced
    const before = snapshot(target);
    for (const opts of [{}, { force: true }, { afterEffectsClosed: true }, { force: true, afterEffectsClosed: true }]) {
      const p = prefs([RUNNING]);
      await assert.rejects(installPanel({ ...opts, prefs: p.calls }), /After Effects is open/, JSON.stringify(opts));
      assert.equal(p.log.writes, 0);
    }
    assert.deepEqual(snapshot(target), before, "a refused install changed the installed panel");
  } finally { restoreEnv(); }
});

await check("the running-refusal text, pinned", async () => {
  const m = afterEffectsRunningRefusal(RUNNING.detail);
  assert.equal(
    m,
    `After Effects is open (found: ${RUNNING.detail}), so setup_panel installed nothing — nothing has been changed. ` +
      "The panel cannot be installed while After Effects is open: it holds the panel's files, and the install comes " +
      "out half-updated. Ask the user to quit After Effects completely, then run setup_panel again, then reopen After Effects."
  );
  assert.match(m, /quit After Effects completely, then run setup_panel again, then reopen After Effects\.$/);
});

// ----------------------------------------------------- detection that fails

await check("process check failed: refused and nothing written, unless the user confirmed AE is quit", async () => {
  try {
    const target = fakeHome("unknown");
    const p = prefs([UNKNOWN]);
    await assert.rejects(
      installPanel({ prefs: p.calls }),
      (e) => e instanceof SetupPanelRefusedError && e.reason === "after-effects-unknown" && e.message === afterEffectsUnknownRefusal(UNKNOWN.detail)
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(p.log.writes, 0);

    const m = afterEffectsUnknownRefusal(UNKNOWN.detail);
    assert.match(m, /could not tell whether After Effects is open \(pgrep failed: spawn pgrep ENOENT\)/);
    assert.match(m, /does not install blind/);
    assert.match(m, /make sure After Effects is completely quit.*afterEffectsClosed:true, then have them reopen After Effects\.$/s);

    const confirmed = await installPanel({ prefs: prefs([UNKNOWN]).calls, afterEffectsClosed: true });
    assert.equal(confirmed.ok, true);
    assert.ok(fs.existsSync(path.join(target, "jsx", "bundle.jsx")));
    assert.ok(confirmed.notes.some((n) => /on the user's word that it is closed/.test(n)), confirmed.notes.join(" | "));
    assert.equal(confirmed.restartAfterEffects, false);
  } finally { restoreEnv(); }
});

await check("afterEffectsClosed is in the setup_panel schema, and strict", async () => {
  assert.deepEqual(SetupPanel.parse({ afterEffectsClosed: true }), { afterEffectsClosed: true });
  assert.throws(() => SetupPanel.parse({ aeClosed: true }));
});

await check("the real process check gives an answer on this machine, not unknown", async () => {
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  const r = await afterEffectsProcess();
  assert.ok(["running", "not-running"].includes(r.state), `afterEffectsProcess() could not run here: ${JSON.stringify(r)}`);
  assert.ok(typeof r.detail === "string" && r.detail.length > 0);
});

// ------------------------------------------------------------ after install

await check("a successful install says open After Effects — never restart it", async () => {
  try {
    fakeHome("closed");
    const p = prefs([CLOSED]);
    const res = await installPanel({ prefs: p.calls });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.restartAfterEffects, false);
    assert.ok(res.notes.some((n) => /^Next: open After Effects — the panel loads when it starts\./.test(n)), res.notes.join(" | "));
    const all = [...res.notes, ...res.actions].join("\n");
    assert.doesNotMatch(all, /restart After Effects|quit and reopen|Quit and reopen/);
    if (res.rebootRecommended) assert.ok(res.notes.some((n) => /^PlayerDebugMode was just turned on\. Open After Effects;/.test(n)));
    const again = await installPanel({ prefs: prefs([CLOSED]).calls, enableDebugMode: false });
    assert.equal(again.changed, false);
    assert.ok(again.notes.some((n) => /Open After Effects — the panel loads when it starts\.$/.test(n)), again.notes.join(" | "));
    assert.doesNotMatch(SIGNED_INSTALL_OVERWRITTEN_NOTE, /restart After Effects/);
  } finally { restoreEnv(); }
});

await check("After Effects opened mid-install: restartAfterEffects, with the full sequence", async () => {
  try {
    fakeHome("opened-mid-install");
    const p = prefs([CLOSED, RUNNING]);
    const res = await installPanel({ prefs: p.calls, enableDebugMode: false });
    assert.equal(p.log.asked, 2, "the process was not asked again after the install");
    assert.equal(res.restartAfterEffects, true);
    const note = res.notes.find((n) => /opened while setup_panel was installing/.test(n));
    assert.ok(note, res.notes.join(" | "));
    assertQuitInstallReopen("mid-install note", note.slice(note.indexOf("Ask the user")));
  } finally { restoreEnv(); }
});

// ------------------------------------------------ every message, in order

const OLD = "a".repeat(64);
const SHIPPED = { bundle: "b".repeat(64), client: "c".repeat(64) };
const run = (bundleHash, clientHash, extra = {}) => ({ ok: true, bundleHash, clientHash, ...extra });
const disk = (bundle, client) => ({ bundle, client });

await check("the version gate: update-needed, partial, unverifiable say quit → setup_panel → reopen", async () => {
  const update = assessPanel(run(OLD, OLD), disk(OLD, OLD), { shipped: SHIPPED });
  assert.equal(update.state, "update-needed");
  assertQuitInstallReopen("update-needed", update.message);
  const partial = assessPanel(run(OLD, OLD), disk(SHIPPED.bundle, SHIPPED.client), { installComplete: false, shipped: SHIPPED });
  assert.equal(partial.state, "partial-install");
  assertQuitInstallReopen("partial-install", partial.message);
  const unverifiable = assessPanel(run(SHIPPED.bundle, null), disk(SHIPPED.bundle, SHIPPED.client), { shipped: SHIPPED });
  assert.equal(unverifiable.state, "unverifiable");
  assertQuitInstallReopen("unverifiable", unverifiable.message);
  assertQuitInstallReopen("unknown op", unknownOpMessage("set_layer"));
  const batch = panelDrivenBatchMessage("j_1");
  assertQuitInstallReopen("panel-driven batch", batch.slice(batch.indexOf("never before")));
});

await check("restart-needed says quit and reopen, and no setup_panel step", async () => {
  const restart = assessPanel(run(OLD, OLD), disk(SHIPPED.bundle, SHIPPED.client), { shipped: SHIPPED });
  assert.equal(restart.state, "restart-needed");
  assert.match(restart.message, /quit and reopen After Effects/);
  assert.doesNotMatch(restart.message, /\brun setup_panel\b/i);
});

await check("bridge unreachable names the install in the new order", async () => {
  assertQuitInstallReopen("unreachable", BridgeUnreachableError.message(7777).replace(/\n/g, " "));
});

const ae = (running) => ({ name: "afterEffectsRunning", ok: running, detail: running ? "running" : "not running" });
const steps = (checks) => buildNextSteps(checks, false);
/** quit (if AE runs) before setup_panel, reopen after it, and nothing in between reversing that. */
function assertStepOrder(label, list, aeRunning) {
  const i = list.findIndex((s) => /^Run the setup_panel/.test(s));
  assert.ok(i >= 0, `${label}: no setup_panel step: ${list.join(" | ")}`);
  if (aeRunning) {
    const q = list.findIndex((s) => /^Quit After Effects completely/.test(s));
    assert.ok(q >= 0 && q < i, `${label}: no quit before setup_panel: ${list.join(" | ")}`);
    assert.ok(list.slice(i + 1).some((s) => /^Reopen After Effects/.test(s)), `${label}: no reopen after: ${list.join(" | ")}`);
  } else {
    assert.ok(list.slice(i + 1).some((s) => /^Open After Effects/.test(s)), `${label}: no open after: ${list.join(" | ")}`);
  }
  assert.ok(!list.some((s) => /^Quit and reopen/.test(s)), `${label}: a bare restart beside a reinstall: ${list.join(" | ")}`);
}

await check("check_setup nextSteps: every reinstall is quit → setup_panel → reopen", async () => {
  for (const running of [true, false]) {
    const tag = running ? "AE open" : "AE closed";
    assertStepOrder(`missing, ${tag}`, steps([ae(running), { name: "panelInstalled", ok: false, detail: "" }]), running);
    assertStepOrder(`debug off, ${tag}`, steps([ae(running), { name: "cepDebugMode", ok: false, detail: "" }]), running);
    assertStepOrder(`out of date, ${tag}`, steps([ae(running), { name: "panelUpToDate", ok: false, detail: "" }]), running);
    assertStepOrder(`no ws, ${tag}`, steps([ae(running), { name: "panelDependencies", ok: false, detail: "" }]), running);
  }
  // The other install serving the bridge: quit, remove it, install, reopen — in that order.
  const identity = steps([
    ae(true),
    { name: "panelInstalled", ok: false, detail: "" },
    { name: "panelIdentity", ok: false, detail: "", fix: "x" },
  ]);
  assertStepOrder("panelIdentity", identity, true);
  const remove = identity.findIndex((s) => /differently named/.test(s));
  assert.ok(remove > 0 && remove < identity.findIndex((s) => /^Run the setup_panel/.test(s)), identity.join(" | "));
  // Restart-needed: the files are current, so no setup_panel at all.
  const restart = steps([ae(true), { name: "panelRunningCurrent", ok: false, detail: "older" }]);
  assert.deepEqual(restart, ["Quit and reopen After Effects so it picks up the panel."]);
});

await check("check_setup texts that sequence setup_panel put quitting first", async () => {
  // Read from the source, so a fix text added later is held to the same rule.
  const raw = fs.readFileSync(path.join(root, "packages", "mcp-server", "src", "setup", "check.ts"), "utf8");
  // Concatenated literals ("a " +\n "b") joined, so a sentence split over lines reads whole.
  const src = raw.replace(/(["`])\s*\+\s*\n\s*(["`])/g, "");
  // Every one-line literal that is a sequence naming setup_panel ("… then run setup_panel, then …").
  const fixes = [...src.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)]
    .map((m) => m[1] ?? m[2])
    .filter((t) => /\brun (the )?setup_panel\b/i.test(t) && /\bthen\b/i.test(t));
  assert.ok(fixes.length >= 3, `found only ${fixes.length} fix texts naming setup_panel`);
  for (const f of fixes) assertQuitInstallReopen("fix", f);
});

// The #262 bug as an instruction: "run setup_panel … then/and … restart/quit".
const OLD_ORDER = /\brun(?:ning)? (?:the )?`?setup_panel`?(?: tool)?[^.\n]{0,60}\b(then|and)\b[^.\n]{0,40}\b(restart|quit)/i;

// A scan of every message source for the old order. Prose that merely names
// setup_panel is fine; "setup_panel … then/and … restart/quit" is the #262 bug.
await check("no message anywhere says setup_panel before quitting", async () => {
  const roots = [
    path.join(root, "packages", "mcp-server", "src"),
    path.join(root, "packages", "ae-panel", "client"),
    path.join(root, "scripts"),
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "generated") walk(p);
      } else if (/\.(ts|mjs|js|md)$/.test(e.name)) {
        fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          // whats-new quotes the old rule on purpose, as a grep target.
          if (/^\s*supersedes:/.test(line)) return;
          if (OLD_ORDER.test(line)) offenders.push(`${p}:${i + 1}: ${line.trim()}`);
          if (/run setup_panel, then (ask|have|tell)[^.\n]*(quit|restart)/i.test(line)) offenders.push(`${p}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  // The scan would have caught what #262 replaced.
  for (const was of [
    "Run setup_panel, then ask them to quit and reopen After Effects.",
    "remove it, then run setup_panel and restart After Effects.",
    "run setup_panel, and ask the user to quit and reopen After Effects.",
  ]) assert.match(was, OLD_ORDER);
  for (const r of roots) walk(r);
  for (const f of ["README.md"]) {
    fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((line, i) => {
      if (OLD_ORDER.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `the old order survives:\n${offenders.join("\n")}`);
});

// ------------------------------------------- only the application counts

const AE_APP = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
const AERENDER = "/Applications/Adobe After Effects 2026/aerender -project /tmp/x.aep -comp Main -output /tmp/x.mov";
const AERENDERCORE =
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/aerendercore.app/Contents/MacOS/aerendercore -project /tmp/x.aep";
const CEP =
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/Frameworks/CEPHtmlEngine.framework/Versions/A/Helpers/CEPHtmlEngine.app/Contents/MacOS/CEPHtmlEngine";

const DYNAMICLINK = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/dynamiclinkmanager";
const CRASHPAD =
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/crashpad_handler --database=/Users/me/Library/Application Support/Adobe/After Effects/26.5/Crashpad --annotation=prod=AfterEffects";

await check("macOS: only the After Effects main binary counts — not aerender, aerendercore, dynamiclinkmanager, crashpad_handler or CEP", async () => {
  assert.equal(isAfterEffectsAppCommand(AE_APP), true);
  assert.equal(isAfterEffectsAppCommand(`${AE_APP} -psn_0_12345`), true, "launch arguments do not hide it");
  assert.equal(isAfterEffectsAppCommand(`${AE_APP} /Users/me/Projects/spot.aep`), true, "nor does a project path");
  assert.equal(isAfterEffectsAppCommand("/Applications/Adobe After Effects (Beta)/Adobe After Effects (Beta).app/Contents/MacOS/After Effects"), true);
  assert.equal(isAfterEffectsAppCommand("/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/After Effects"), true);
  for (const other of [
    AERENDER,
    AERENDERCORE,
    CEP,
    DYNAMICLINK,
    CRASHPAD,
    "grep Adobe After Effects",
    "/Applications/Adobe After Effects 2026/aerender",
    "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects Helper",
  ]) {
    assert.equal(isAfterEffectsAppCommand(other), false, other);
  }
  // Measured live (#262 review): AE quit, aerender rendering → dynamiclinkmanager and crashpad_handler only.
  assert.equal(afterEffectsFromPgrep(`7927 ${DYNAMICLINK}\n7930 ${CRASHPAD}\n7900 ${AERENDER}\n7901 ${AERENDERCORE}\n`).state, "not-running");
  assert.equal(afterEffectsFromPgrep(`7927 ${DYNAMICLINK}\n7930 ${CRASHPAD}\n777 ${AE_APP}\n`).state, "running");
  // pgrep -lf lines are "<pid> <command line>".
  assert.equal(afterEffectsFromPgrep(`4242 ${AERENDER}\n4243 ${AERENDERCORE}\n`).state, "not-running", "a render alone is not After Effects open");
  assert.match(afterEffectsFromPgrep(`4242 ${AERENDER}\n`).detail, /not counted/);
  assert.equal(afterEffectsFromPgrep(`4243 ${CEP}\n`).state, "not-running");
  const both = afterEffectsFromPgrep(`4242 ${AERENDER}\n777 ${AE_APP}\n4243 ${CEP}\n`);
  assert.equal(both.state, "running");
  assert.match(both.detail, /^777 .*MacOS\/After Effects$/);
  assert.equal(afterEffectsFromPgrep("").state, "not-running");
});

await check("Windows: only an AfterFX.exe row counts, never aerender.exe", async () => {
  const row = (img) => `${img.padEnd(25)} 1234 Console                    1    812,345 K`;
  assert.equal(afterEffectsFromTasklist(`\r\n${row("AfterFX.exe")}\r\n`).state, "running");
  assert.equal(afterEffectsFromTasklist(`\r\n${row("aerender.exe")}\r\n`).state, "not-running");
  assert.equal(afterEffectsFromTasklist(`\r\n${row("NotAfterFX.exe")}\r\n`).state, "not-running");
  assert.equal(afterEffectsFromTasklist("INFO: No tasks are running which match the specified criteria.\r\n").state, "not-running");
});

await check("a running aerender does not stop setup_panel", async () => {
  try {
    const target = fakeHome("aerender");
    const res = await installPanel({ prefs: prefs([afterEffectsFromPgrep(`4242 ${AERENDER}\n`)]).calls, enableDebugMode: false });
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(path.join(target, "jsx", "bundle.jsx")));
  } finally { restoreEnv(); }
});

// ------------------------------- check_setup when the process check failed

await check("check_setup: an unknown process check is not 'not running', and nextSteps match setup_panel", async () => {
  const unknown = { name: "afterEffectsRunning", ok: false, detail: "could not tell (x)", evidence: "unknown" };
  const list = steps([unknown, { name: "panelInstalled", ok: false, detail: "" }, { name: "bridgeReachable", ok: false, detail: "" }]);
  const confirm = list.findIndex((s) => /make sure After Effects is completely quit, and to confirm it/.test(s));
  const install = list.findIndex((s) => /^Run the setup_panel tool, with afterEffectsClosed:true once the user has confirmed/.test(s));
  assert.ok(confirm >= 0 && install > confirm, list.join(" | "));
  assert.ok(list.slice(install + 1).some((s) => /^Open After Effects/.test(s)), list.join(" | "));
  // A panel answering proves After Effects is open: then it is the ordinary quit → setup_panel → reopen.
  const open = steps([unknown, { name: "panelUpToDate", ok: false, detail: "" }, { name: "bridgeReachable", ok: true, detail: "" }]);
  assertStepOrder("unknown but answering", open, true);
  assert.ok(!open.some((s) => /afterEffectsClosed/.test(s)), open.join(" | "));

  try {
    fakeHome("check-unknown");
    const report = await checkSetup({
      source: path.join(root, "packages", "ae-panel"),
      debugMode: { on: true, detail: "on" },
      afterEffectsRunning: "unknown",
      candidates: [],
    });
    const c = report.checks.find((x) => x.name === "afterEffectsRunning");
    assert.equal(c.ok, false);
    assert.equal(c.evidence, "unknown");
    assert.match(c.detail, /^could not tell/);
    assert.match(c.fix, /afterEffectsClosed:true/);
    assert.ok(report.nextSteps.some((s) => /afterEffectsClosed:true/.test(s)), report.nextSteps.join(" | "));
  } finally { restoreEnv(); }
});

restoreEnv();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`setup-panel-ae-running: ${passed} checks passed`);
