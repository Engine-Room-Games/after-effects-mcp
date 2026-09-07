// CEP's signature check, and the one place it says so.
//
// Issue #91: on some Windows installs CEP 12 enforces signature verification on
// the unsigned panel even with PlayerDebugMode on. The panel never loads, no
// CEPHtmlEngine process starts, nothing appears in After Effects, and
// check_setup — every check green, bridge refused — sent the user round
// "restart After Effects" indefinitely. The only evidence is one ERROR line in
// CEP's own log, written only when LogLevel is high enough.
//
// Pinned here: where that log lives on each platform, that the scan finds the
// line (and is bounded), that check_setup's advice moves from "restart" to the
// self-signing workaround once the line is found, that it says how to turn the
// log on when there is none, that a self-signed install is never reported as
// partial, and that setup_panel warns before it strips a signature.
//
//   node tests/unit/cep-signature.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { cepLogDir, cepLogPaths, cepLogLevelCommand, CEP_LOG_LEVEL } = await import(dist("setup", "platform.js"));
const { findSignatureFailure, signatureWorkaroundSteps, buildNextSteps } = await import(dist("setup", "check.js"));
const { BUNDLE_ID, signedInstallPresent, installedPanelDir } = await import(dist("setup", "paths.js"));
const { installPanel } = await import(dist("setup", "install.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`cep-signature FAILED: ${name}`);
    throw e;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-cep-sig-"));
const realPlatform = process.platform;
const savedEnv = { ...process.env };
function setPlatform(p) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function restore() {
  setPlatform(realPlatform);
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

// ---------------------------------------------------------------------------
// Where the log lives
// ---------------------------------------------------------------------------

await check("the CEP log directory has the Windows shape under %TEMP%", () => {
  setPlatform("win32");
  process.env.TEMP = path.join(tmp, "wintemp");
  try {
    assert.equal(cepLogDir(), path.join(tmp, "wintemp"));
    assert.match(cepLogLevelCommand(), /^reg add HKCU\\Software\\Adobe\\CSXS\.12 \/v LogLevel \/t REG_SZ \/d 6 \/f$/);
  } finally { restore(); }
});

await check("the CEP log directory has the macOS shape under ~/Library/Logs/CSXS", () => {
  setPlatform("darwin");
  process.env.HOME = path.join(tmp, "machome");
  process.env.USERPROFILE = path.join(tmp, "machome");
  try {
    assert.equal(cepLogDir(), path.join(tmp, "machome", "Library", "Logs", "CSXS"));
    assert.equal(cepLogLevelCommand(), `defaults write com.adobe.CSXS.12 LogLevel ${CEP_LOG_LEVEL}`);
  } finally { restore(); }
});

await check("cepLogPaths matches both documented and measured names, newest first, AE only", () => {
  const dir = path.join(tmp, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  const newer = new Date();
  // The name measured in #91, and the one Adobe's cookbook documents.
  fs.writeFileSync(path.join(dir, "CEP12-AEFT.log"), "");
  fs.utimesSync(path.join(dir, "CEP12-AEFT.log"), old, old);
  fs.writeFileSync(path.join(dir, "csxs11-AEFT.log"), "");
  fs.utimesSync(path.join(dir, "csxs11-AEFT.log"), newer, newer);
  // Another host's log, and noise.
  fs.writeFileSync(path.join(dir, "CEP12-PHXS.log"), "");
  fs.writeFileSync(path.join(dir, "notes.txt"), "");
  assert.deepEqual(cepLogPaths(dir).map((f) => path.basename(f)), ["csxs11-AEFT.log", "CEP12-AEFT.log"]);
  assert.deepEqual(cepLogPaths(path.join(tmp, "nowhere")), [], "an absent directory is no logs, not a throw");
});

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

const LINE = `2026-09-05 10:12:33 : ERROR Signature verification failed for extension ${BUNDLE_ID}.panel`;

await check("findSignatureFailure finds the line and reports the file it came from", () => {
  const withLine = path.join(tmp, "with.log");
  fs.writeFileSync(withLine, ["INFO CEP starting", "INFO loading extensions", LINE, "INFO done"].join("\r\n"));
  const clean = path.join(tmp, "clean.log");
  fs.writeFileSync(clean, "INFO CEP starting\nINFO loaded extension something.else\n");

  const found = findSignatureFailure([withLine, clean]);
  assert.equal(found?.file, withLine);
  assert.match(found.line, new RegExp(`Signature verification failed for extension ${BUNDLE_ID.replace(/\./g, "\\.")}`));
  assert.ok(found.mtime instanceof Date);
  assert.equal(findSignatureFailure([clean]), null);
  assert.equal(findSignatureFailure([]), null);
  assert.equal(findSignatureFailure([path.join(tmp, "missing.log")]), null, "an unreadable log is skipped, not a throw");
});

await check("the needle is built from the bundle id, never a literal", () => {
  const otherId = path.join(tmp, "other.log");
  fs.writeFileSync(otherId, "ERROR Signature verification failed for extension com.example.other\n");
  assert.equal(findSignatureFailure([otherId]), null, "another extension's refusal is not ours");
  assert.ok(findSignatureFailure([otherId], "com.example.other"), "…but is found under its own id");
});

await check("the read is bounded to the tail, so a huge log cannot stall check_setup", () => {
  const big = path.join(tmp, "big.log");
  const filler = "INFO something happened that is of no consequence whatsoever\n";
  // The line at the very start of a log far larger than the tail window: not found.
  fs.writeFileSync(big, LINE + "\n" + filler.repeat(20_000));
  assert.ok(fs.statSync(big).size > 512 * 1024);
  assert.equal(findSignatureFailure([big]), null);
  // The same line at the end: found.
  fs.appendFileSync(big, LINE + "\n");
  assert.ok(findSignatureFailure([big]));
});

// ---------------------------------------------------------------------------
// What check_setup says
// ---------------------------------------------------------------------------

const ok = (name, detail = "") => ({ name, ok: true, detail });
const bad = (name, detail = "", fix = "…") => ({ name, ok: false, detail, fix });
const installedFine = [
  ok("platform"), ok("panelAssetsPresent"), ok("cepDebugMode"), ok("panelInstalled"),
  ok("panelUpToDate"), ok("panelDependencies"), ok("afterEffectsRunning"),
  bad("bridgeReachable", "no response on port 7777 (nothing is listening on port 7777 (fetch failed))"),
];

await check("a logged signature failure replaces the restart advice with the signing workaround", () => {
  const steps = buildNextSteps(
    [...installedFine, { name: "panelSignature", ok: false, evidence: "failure-logged", detail: LINE, fix: "…" }],
    false,
    false
  );
  const text = steps.join("\n");
  assert.match(steps[0], /Adobe CEP 12 bug/);
  assert.match(steps[0], /restarting After Effects again will not change it/i);
  assert.doesNotMatch(steps[0], /^(Quit|Reopen)/);
  // The workaround from the issue, verbatim enough to follow.
  assert.match(text, /ZXPSignCmd/);
  assert.match(text, /CEP-Resources/);
  assert.match(text, /-selfSignedCert/);
  assert.match(text, /-sign "/);
  assert.match(text, /-tsa http:\/\/timestamp\.digicert\.com/);
  assert.match(text, /META-INF\/signatures\.xml/);
  assert.match(text, /mimetype/);
  assert.match(text, /Caveat: setup_panel installs a fresh, unsigned copy/);
  assert.doesNotMatch(text, /Run the setup_panel tool/, "reinstalling is exactly what must not be suggested");
  // The one restart is the last step, after signing — the panel loads at launch.
  const restartIdx = steps.findIndex((s) => /restart After Effects/i.test(s) && !/will not/.test(s));
  assert.ok(restartIdx >= 5, `the restart must come after the signing steps, found at ${restartIdx}`);
});

await check("the workaround names the installed folder in the sign command", () => {
  const steps = signatureWorkaroundSteps("C:\\Users\\x\\AppData\\Roaming\\Adobe\\CEP\\extensions\\games.engine-room.ae-mcp");
  assert.match(steps.join("\n"), /-sign "C:\\Users\\x\\AppData\\Roaming\\Adobe\\CEP\\extensions\\games\.engine-room\.ae-mcp"/);
});

await check("with no CEP log, a silent bridge on a sound install names the signature check and how to confirm it", () => {
  const steps = buildNextSteps(
    [...installedFine, { name: "panelSignature", ok: true, evidence: "no-log", detail: "no CEP log found" }],
    false,
    false
  );
  const text = steps.join("\n");
  // One restart is still reasonable — the panel loads only at launch — but it
  // is conditional, not the third time round.
  assert.match(steps[0], /If After Effects has not been restarted since the panel was installed/);
  assert.match(text, /signature/i);
  assert.match(text, /issue #91/);
  assert.match(text, /LogLevel/);
  assert.match(text, /CSXS\.12/);
  assert.match(text, /run check_setup again/);
  assert.doesNotMatch(text, /Quit and reopen After Effects so it picks up the panel/);
});

await check("with a clean CEP log, the signature check is ruled out rather than suggested", () => {
  const steps = buildNextSteps(
    [...installedFine, { name: "panelSignature", ok: true, evidence: "log-clean", detail: "no signature failure recorded in C:\\Temp\\CEP12-AEFT.log (CEP LogLevel 6)" }],
    false,
    false
  );
  const text = steps.join("\n");
  assert.match(text, /no signature refusal/i);
  assert.doesNotMatch(text, /LogLevel is not set|turn CEP's own logging up/i);
  assert.match(text, /AE MCP Bridge/);
});

await check("a busy bridge still outranks the signature advice", () => {
  const steps = buildNextSteps(
    [...installedFine, { name: "panelSignature", ok: true, evidence: "no-log", detail: "" }],
    false,
    true
  );
  assert.match(steps[0], /^Wait/);
  assert.doesNotMatch(steps.join("\n"), /signature/i);
});

// ---------------------------------------------------------------------------
// A signed install on disk
// ---------------------------------------------------------------------------

await check("signedInstallPresent recognises what ZXPSignCmd leaves behind", () => {
  const signed = path.join(tmp, "signed");
  fs.mkdirSync(path.join(signed, "META-INF"), { recursive: true });
  fs.writeFileSync(path.join(signed, "META-INF", "signatures.xml"), "<signatures/>");
  assert.equal(signedInstallPresent(signed), true);
  const mimeOnly = path.join(tmp, "mimeonly");
  fs.mkdirSync(mimeOnly, { recursive: true });
  fs.writeFileSync(path.join(mimeOnly, "mimetype"), "application/vnd.adobe.air-ucf-package+zip");
  assert.equal(signedInstallPresent(mimeOnly), true);
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(path.join(plain, "CSXS"), { recursive: true });
  assert.equal(signedInstallPresent(plain), false);
});

await check("setup_panel warns when it is about to overwrite a signed install", async () => {
  // Real installPanel into a fake home, so the target is a temp directory and
  // nothing under the real CEP extensions folder is touched. enableDebugMode
  // is off so no Adobe preference is written either.
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  try {
    const target = installedPanelDir();
    assert.ok(target.startsWith(home), `installedPanelDir() escaped the fake home: ${target}`);

    const first = await installPanel({ enableDebugMode: false });
    assert.equal(first.ok, true);
    assert.equal(first.signedInstallOverwritten, undefined);
    assert.equal(first.notes.some((n) => /self-signed/.test(n)), false);

    // The user signs it in place, per the #91 workaround.
    fs.mkdirSync(path.join(target, "META-INF"), { recursive: true });
    fs.writeFileSync(path.join(target, "META-INF", "signatures.xml"), "<signatures/>");
    fs.writeFileSync(path.join(target, "mimetype"), "application/vnd.adobe.air-ucf-package+zip");

    const second = await installPanel({ enableDebugMode: false });
    assert.equal(second.signedInstallOverwritten, true);
    const note = second.notes.find((n) => /self-signed/.test(n));
    assert.ok(note, "no warning about the stripped signature");
    assert.match(note, /NOT signed/);
    assert.match(note, /ZXPSignCmd/);
    assert.match(note, /signed again/);
    assert.equal(fs.existsSync(path.join(target, "META-INF")), false, "the fresh copy is unsigned, as the note says");
    assert.ok(second.actions.some((a) => /self-signed/.test(a)));
  } finally { restore(); }
});

restore();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`cep-signature: ${passed} checks passed`);
