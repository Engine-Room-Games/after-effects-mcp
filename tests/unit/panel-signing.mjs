// The signed panel (issue #182).
//
// A release ships the CEP panel signed with a self-signed certificate, so After
// Effects loads it without PlayerDebugMode. A signature covers every file in the
// folder, so three things have to hold, and each one breaks silently:
//
//   - packaging signs a panel that already holds `ws` (nothing may be added
//     after), and leaves the panel unsigned when nobody asked for signing — the
//     dev flow edits installed files in place and keeps PlayerDebugMode
//   - setup_panel installs a signed panel verbatim: signature files copied, no
//     `ws` re-vendored over the signed one, and the result reported current
//   - check_setup stops demanding PlayerDebugMode for a signed panel, and says
//     so when the installed files no longer match their signature
//
// ZXPSignCmd itself is not run here — there is no Adobe tool on a CI runner,
// and the Windows runner could not run the macOS build anyway. A stub plays it:
// it writes a signatures.xml in the real tool's format (the per-file SHA-256
// manifest measured from ZXPSignCmd 4.1.3) and verifies by the same rule. What
// that leaves unexercised is the RSA signature itself and CEP's acceptance of
// it, which only a live After Effects can show (docs/verification-recipes.md).
//
//   node tests/unit/panel-signing.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const signing = await import(pathToFileURL(path.join(root, "scripts", "lib", "panel-signing.mjs")).href);
const { loadPackagingCopy } = await import(pathToFileURL(path.join(root, "scripts", "lib", "setup.mjs")).href);
const { isSignedPanel, signatureProblems, signatureIntact } = await import(dist("setup", "panelSignature.js"));
const { installPanel } = await import(dist("setup", "install.js"));
const { installedPanelDir, panelInstallDiff, panelSourceDir, wsModuleDir } = await import(dist("setup", "paths.js"));
const { buildNextSteps, checkSetup, debugModeCheck, signatureIntactCheck } = await import(dist("setup", "check.js"));
const { panelClientHash } = await import(dist("setup", "panelHash.js"));
const { assessPanel, installedPanelHashes } = await import(dist("setup", "panelVersion.js"));
const { REQUIRED_PANEL_CAPABILITIES } = await import(dist("setup", "panelCapabilities.js"));

// The server's zip code, the same the signing step reads the .zxp with.
const { writeZip } = await import(dist("frames", "mogrtThumbnail.js"));
const { crc32 } = await import(dist("frames", "pngCodec.js"));

// installPanel asks whether After Effects is running; these tests pin it closed —
// the only state it installs in (#262) — rather than reading the machine they run on.
const AE_CLOSED = { afterEffectsProcess: async () => ({ state: "not-running", detail: "stub" }) };

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`panel-signing FAILED: ${name}`);
    throw e;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-signing-"));
const savedEnv = { ...process.env };
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}
const copy = await loadPackagingCopy();
const panelSrc = path.join(root, "packages", "ae-panel");
const wsSrc = wsModuleDir();
assert.ok(wsSrc, "no ws module found — run `npm install` first");
const quiet = () => {};

// ---------------------------------------------------------------------------
// A stand-in for ZXPSignCmd
// ---------------------------------------------------------------------------

const MIMETYPE = "application/vnd.adobe.air-ucf-package+zip";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

function filesUnder(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else out.push(r);
  }
  return out;
}

/** signatures.xml as ZXPSignCmd 4.1.3 writes it, minus a real RSA value. */
function signaturesXml(dir) {
  const refs = [`<Reference URI="mimetype"><DigestMethod Algorithm="${SHA256}"/><DigestValue>${crypto.createHash("sha256").update(MIMETYPE).digest("base64")}</DigestValue></Reference>`];
  for (const rel of filesUnder(dir)) {
    if (rel === "mimetype" || rel.startsWith("META-INF/")) continue;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, ...rel.split("/")))).digest("base64");
    refs.push(`<Reference URI="${rel}"><DigestMethod Algorithm="${SHA256}"/><DigestValue>${digest}</DigestValue></Reference>`);
  }
  return (
    `<signatures>\n<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="PackageSignature">\n<SignedInfo>\n` +
    `<Reference Type="http://www.w3.org/2000/09/xmldsig#Manifest" URI="#PackageContents">\n<DigestMethod Algorithm="${SHA256}"/>\n<DigestValue>stub</DigestValue>\n</Reference>\n` +
    `</SignedInfo>\n<SignatureValue Id="PackageSignatureValue">stub</SignatureValue>\n` +
    `<Object>\n<Manifest Id="PackageContents">\n${refs.join("")}\n</Manifest>\n</Object>\n</Signature>\n</signatures>\n`
  );
}

function storedEntry(name, data) {
  const buf = Buffer.from(data);
  return {
    name, data: buf, method: 0, flags: 0, versionMadeBy: 20, versionNeeded: 20, modTime: 0, modDate: 0,
    crc32: crc32(buf), compressedSize: buf.length, uncompressedSize: buf.length, internalAttrs: 0, externalAttrs: 0, localOffset: 0,
  };
}

/** Plays ZXPSignCmd: records every call, and fails where the real one would. */
function stubTool({ failOn } = {}) {
  const calls = [];
  const run = (tool, args) => {
    calls.push({ tool, args: [...args] });
    const [cmd] = args;
    if (failOn === cmd) throw new Error(`stub ZXPSignCmd ${cmd} failed`);
    if (cmd === "-selfSignedCert") {
      fs.writeFileSync(args[6], "stub p12");
      return "Self-signed certificate generated successfully";
    }
    if (cmd === "-sign") {
      const [, dir, zxp, cert] = args;
      assert.ok(fs.existsSync(cert), `signing with a certificate that does not exist: ${cert}`);
      fs.writeFileSync(zxp, writeZip([storedEntry("META-INF/signatures.xml", signaturesXml(dir)), storedEntry("mimetype", MIMETYPE)]));
      return "Signed successfully";
    }
    if (cmd === "-verify") {
      if (!signatureIntact(signatureProblems(args[1]))) throw new Error("Failed to verify signature. Signature might have been tampered with.");
      return "Signature verified successfully";
    }
    throw new Error(`stub ZXPSignCmd: unexpected ${cmd}`);
  };
  return { run, calls, tool: "/stub/ZXPSignCmd" };
}

// ---------------------------------------------------------------------------
// What the environment asks for
// ---------------------------------------------------------------------------

await check("signing is off unless a certificate is configured", () => {
  assert.equal(signing.signingPlan({}).sign, false);
  assert.equal(signing.signingPlan({ AE_MCP_PANEL_SIGN: "off", AE_MCP_PANEL_CERT: "ephemeral" }).sign, false);
});

await check("a release that requires signing cannot quietly ship an unsigned panel", () => {
  assert.throws(() => signing.signingPlan({ AE_MCP_PANEL_SIGN: "required" }), /nothing to sign with/);
  assert.throws(() => signing.signingPlan({ AE_MCP_PANEL_SIGN: "yes" }), /expected "required"/);
});

await check("a certificate from the environment needs its password, and must exist", () => {
  const p12 = path.join(tmp, "cert.p12");
  fs.writeFileSync(p12, "x");
  assert.throws(() => signing.signingPlan({ AE_MCP_PANEL_CERT: p12 }), /AE_MCP_PANEL_CERT_PASSWORD/);
  assert.throws(() => signing.signingPlan({ AE_MCP_PANEL_CERT: path.join(tmp, "nope.p12"), AE_MCP_PANEL_CERT_PASSWORD: "pw" }), /does not exist/);
  const plan = signing.signingPlan({ AE_MCP_PANEL_CERT: p12, AE_MCP_PANEL_CERT_PASSWORD: "pw", AE_MCP_PANEL_SIGN: "required" });
  assert.deepEqual(plan, { sign: true, cert: p12, password: "pw", tsa: signing.DEFAULT_TSA, required: true });
});

await check("an ephemeral certificate needs no secret; the timestamp server can be turned off", () => {
  const plan = signing.signingPlan({ AE_MCP_PANEL_CERT: "ephemeral", AE_MCP_PANEL_TSA: "none" });
  assert.equal(plan.sign, true);
  assert.equal(plan.password, null);
  assert.equal(plan.tsa, null);
});

// ---------------------------------------------------------------------------
// Obtaining ZXPSignCmd
// ---------------------------------------------------------------------------

await check("ZXPSignCmd is pinned to one commit with a digest for each platform", () => {
  assert.match(signing.ZXPSIGNCMD.commit, /^[0-9a-f]{40}$/);
  for (const p of ["darwin", "win32"]) assert.match(signing.ZXPSIGNCMD.builds[p].sha256, /^[0-9a-f]{64}$/);
});

await check("a download that does not match the pinned digest is never written, never run", async () => {
  const cacheDir = path.join(tmp, "zxp-cache");
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("not adobe's binary").buffer });
  await assert.rejects(signing.obtainZxpSignCmd({}, { platform: "darwin", fetchImpl, cacheDir }), /Refusing to run it/);
  assert.equal(fs.existsSync(path.join(cacheDir, "ZXPSignCmd")), false);
  await assert.rejects(signing.obtainZxpSignCmd({}, { platform: "linux", fetchImpl, cacheDir }), /no build for linux/);
});

await check("a tampered cached copy is fetched again rather than trusted", async () => {
  const cacheDir = path.join(tmp, "zxp-cache2");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "ZXPSignCmd"), "tampered");
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return { ok: false, status: 503, statusText: "stub" }; };
  await assert.rejects(signing.obtainZxpSignCmd({}, { platform: "darwin", fetchImpl, cacheDir }), /503/);
  assert.equal(fetched, 1);
});

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

await check("the dev and default path vendors the panel unsigned, with no ws inside", async () => {
  const dest = path.join(tmp, "vendored-unsigned");
  const stub = stubTool();
  const res = await signing.vendorPanel({ panelSrc, wsSrc, dest, copy, env: {}, run: stub.run, tool: stub.tool, log: quiet });
  assert.deepEqual(res, { signed: false, reason: "no AE_MCP_PANEL_CERT configured" });
  assert.equal(stub.calls.length, 0, "ZXPSignCmd was run for an unsigned build");
  assert.equal(isSignedPanel(dest), false);
  assert.equal(fs.existsSync(path.join(dest, "mimetype")), false);
  assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
  assert.ok(fs.existsSync(path.join(dest, "CSXS", "manifest.xml")));
});

await check("the checkout's own panel — what dev installs, symlinks and syncs — is never signed", () => {
  assert.equal(panelSourceDir(), panelSrc, "a checkout must install packages/ae-panel");
  assert.equal(isSignedPanel(panelSrc), false, "packages/ae-panel carries a signature; dev edits would void it");
  assert.equal(fs.existsSync(path.join(panelSrc, "mimetype")), false);
});

const signedDir = path.join(tmp, "vendored-signed");
await check("a release vendors ws inside the panel, then signs and verifies it", async () => {
  const stub = stubTool();
  const res = await signing.vendorPanel({
    panelSrc, wsSrc, dest: signedDir, copy,
    env: { AE_MCP_PANEL_SIGN: "required", AE_MCP_PANEL_CERT: "ephemeral" },
    run: stub.run, tool: stub.tool, log: quiet,
  });
  assert.deepEqual(res, { signed: true });
  assert.ok(isSignedPanel(signedDir));
  assert.equal(fs.readFileSync(path.join(signedDir, "mimetype"), "utf8"), MIMETYPE);
  assert.ok(fs.existsSync(path.join(signedDir, "node_modules", "ws", "lib", "websocket.js")), "ws must be inside the signature");
  assert.ok(signatureIntact(signatureProblems(signedDir)));

  const cmds = stub.calls.map((c) => c.args[0]);
  assert.deepEqual(cmds, ["-selfSignedCert", "-sign", "-verify"]);
  const sign = stub.calls[1].args;
  assert.equal(sign[1], signedDir);
  assert.deepEqual(sign.slice(-2), ["-tsa", signing.DEFAULT_TSA]);
  // The ephemeral certificate does not outlive the build.
  assert.equal(fs.existsSync(sign[3]), false, "the throwaway certificate was left on disk");
});

await check("a signing failure fails the build", async () => {
  const stub = stubTool({ failOn: "-sign" });
  await assert.rejects(
    signing.vendorPanel({
      panelSrc, wsSrc, dest: path.join(tmp, "vendored-fail"), copy,
      env: { AE_MCP_PANEL_CERT: "ephemeral" }, run: stub.run, tool: stub.tool, log: quiet,
    }),
    /stub ZXPSignCmd -sign failed/
  );
});

await check("the release check refuses an unsigned panel, a tampered one and one without ws", async () => {
  assert.match(await signing.panelSignatureProblem(path.join(tmp, "vendored-unsigned")), /not signed/);
  assert.equal(await signing.panelSignatureProblem(signedDir), null);
  const tampered = path.join(tmp, "tampered");
  fs.cpSync(signedDir, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, "client", "main.js"), "\n");
  assert.match(await signing.panelSignatureProblem(tampered), /changed since signing \(client\/main\.js\)/);
});

// ---------------------------------------------------------------------------
// One signing per release, shared by every artifact
// ---------------------------------------------------------------------------

await check("a release signing counts as 'required' and needs no certificate at packaging time", () => {
  assert.deepEqual(signing.signingPlan({ AE_MCP_PANEL_SIGN: "required", AE_MCP_SIGNED_PANEL: signedDir }), { sign: true, prebuilt: signedDir });
  assert.throws(
    () => signing.signingPlan({ AE_MCP_SIGNED_PANEL: path.join(tmp, "vendored-unsigned") }),
    /not a signed panel/
  );
});

await check("every artifact gets the same signed panel, byte for byte, and nothing signs again", async () => {
  const env = { AE_MCP_PANEL_SIGN: "required", AE_MCP_SIGNED_PANEL: signedDir };
  const stub = stubTool();
  const dests = ["npm", "mcpb", "binary"].map((n) => path.join(tmp, `artifact-${n}`, "panel"));
  for (const dest of dests) {
    assert.deepEqual(
      await signing.vendorPanel({ panelSrc, wsSrc, dest, copy, env, run: stub.run, tool: stub.tool, log: quiet }),
      { signed: true, prebuilt: true }
    );
  }
  assert.equal(stub.calls.length, 0, "a packaging step signed again instead of copying the release's signed panel");
  const sig = (d) => fs.readFileSync(path.join(d, "META-INF", "signatures.xml"));
  for (const dest of dests) {
    assert.ok(sig(dest).equals(sig(signedDir)), `${dest} carries a different signature`);
    assert.ok(fs.existsSync(path.join(dest, "node_modules", "ws", "index.js")), "the verbatim copy dropped ws");
    assert.ok(signatureIntact(signatureProblems(dest)));
  }
});

await check("a signed panel from another build of the source is refused, not shipped", async () => {
  const stale = path.join(tmp, "stale-signed");
  fs.cpSync(signedDir, stale, { recursive: true });
  // Re-signed after an edit: intact against its own signature, but not this source.
  fs.appendFileSync(path.join(stale, "client", "main.js"), "// older build\n");
  stubTool().run("/stub", ["-sign", stale, path.join(tmp, "stale.zxp"), path.join(tmp, "cert.p12"), "pw"]);
  await signing.extractSignature(path.join(tmp, "stale.zxp"), stale);
  assert.ok(signatureIntact(signatureProblems(stale)));
  await assert.rejects(
    signing.vendorPanel({
      panelSrc, wsSrc, dest: path.join(tmp, "artifact-stale"), copy,
      env: { AE_MCP_SIGNED_PANEL: stale }, log: quiet,
    }),
    /not this checkout's panel: it differs from the source in client\/main\.js/
  );
  // And one tampered after signing is refused before anything is compared.
  fs.appendFileSync(path.join(stale, "jsx", "bundle.jsx"), "x");
  await assert.rejects(
    signing.vendorPanel({ panelSrc, wsSrc, dest: path.join(tmp, "artifact-stale2"), copy, env: { AE_MCP_SIGNED_PANEL: stale }, log: quiet }),
    /no longer matches its signature/
  );
});

await check("a failing signing tool never puts the certificate password in the error", () => {
  const secret = "hunter2-very-secret";
  // Prints the password to stderr and fails — the worst case: the tool's own
  // output and Node's "Command failed: <full command line>" both carry it.
  const script = path.join(tmp, "fail.mjs");
  fs.writeFileSync(script, "console.error('bad password ' + process.argv[2]); process.exit(3);");
  let msg = "";
  try {
    signing.runTool(process.execPath, [script, secret], { secrets: [secret] });
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, /failed \(exit 3\)/);
  assert.match(msg, /bad password \[redacted\]/);
  assert.equal(msg.includes(secret), false, `the password leaked: ${msg}`);
  // A tool that cannot even start: Node's message would quote the command line.
  try {
    signing.runTool(path.join(tmp, "no-such-tool"), ["-sign", "dir", "out.zxp", "cert.p12", secret], { secrets: [secret] });
  } catch (e) {
    msg = e.message;
  }
  assert.equal(msg.includes(secret), false, `the password leaked: ${msg}`);
});

// ---------------------------------------------------------------------------
// What CEP would make of the files (the manifest check)
// ---------------------------------------------------------------------------

await check("the manifest check catches a changed, a missing and an extra file, and ignores what CEP ignores", () => {
  const d = path.join(tmp, "manifest");
  fs.cpSync(signedDir, d, { recursive: true });
  assert.ok(signatureIntact(signatureProblems(d)));
  fs.writeFileSync(path.join(d, ".DS_Store"), "finder");
  fs.writeFileSync(path.join(d, "client", ".DS_Store"), "finder");
  fs.mkdirSync(path.join(d, "empty-dir"));
  assert.ok(signatureIntact(signatureProblems(d)), "measured: ZXPSignCmd -verify ignores .DS_Store and empty directories");

  fs.appendFileSync(path.join(d, "jsx", "bundle.jsx"), "// synced from a dev build\n");
  fs.rmSync(path.join(d, "mimetype"));
  fs.writeFileSync(path.join(d, "client", "extra.js"), "");
  const p = signatureProblems(d);
  assert.deepEqual(p, { modified: ["jsx/bundle.jsx"], missing: ["mimetype"], extra: ["client/extra.js"] });
  assert.equal(signatureIntact(p), false);
  assert.equal(signatureProblems(path.join(tmp, "vendored-unsigned")), null, "an unsigned folder has no manifest to break");
});

// ---------------------------------------------------------------------------
// setup_panel with a signed panel
// ---------------------------------------------------------------------------

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

await check("a signed panel is installed verbatim — signature files and its own ws — and reported current", async () => {
  try {
    const target = fakeHome("home-signed");
    const first = await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    assert.equal(first.signed, true);
    assert.equal(first.changed, true);
    assert.equal(first.signedInstallOverwritten, undefined);
    assert.ok(first.actions.some((a) => /signed panel/.test(a)), first.actions.join(" | "));
    assert.equal(first.actions.some((a) => /Copied the `ws` module/.test(a)), false, "ws was re-vendored over the signed copy");

    for (const rel of ["META-INF/signatures.xml", "mimetype", "node_modules/ws/index.js", "jsx/bundle.jsx"]) {
      assert.ok(
        fs.readFileSync(path.join(target, ...rel.split("/"))).equals(fs.readFileSync(path.join(signedDir, ...rel.split("/")))),
        `${rel} differs from the signed source`
      );
    }
    assert.ok(signatureIntact(signatureProblems(target)), "the installed copy no longer matches its signature");
    assert.deepEqual(panelInstallDiff(signedDir, target), [], "a verbatim signed install must read as current");

    // The version gate (#243) hashes the whole panel. A signed install is the
    // same panel as the unsigned source it was signed from: the signature
    // files and the ws inside it must not move either hash, or every signed
    // install would be told it is out of date.
    const source = panelSourceDir();
    assert.equal(panelClientHash(target), panelClientHash(source), "a signed install hashes differently from the unsigned source");
    assert.equal(panelClientHash(signedDir), panelClientHash(source));
    const bundle = (d) => crypto.createHash("sha256").update(fs.readFileSync(path.join(d, "jsx", "bundle.jsx"))).digest("hex");
    assert.equal(bundle(target), bundle(source), "signing changed bundle.jsx, which bundleHash names");
    assert.ok(panelClientHash(target), "the whole-panel hash could not read the signed install");

    // The gate's verdict, the way check_setup asks it: a signed install of the
    // current version, running, is current — whether the server ships the
    // signed or the unsigned copy of it.
    for (const shippedFrom of [source, signedDir]) {
      const shipped = installedPanelHashes(shippedFrom);
      const running = { bundleHash: shipped.bundle, clientHash: shipped.client, capabilities: REQUIRED_PANEL_CAPABILITIES };
      const verdict = assessPanel(running, installedPanelHashes(target), {
        installComplete: panelInstallDiff(shippedFrom, target).length === 0,
        shipped,
      });
      assert.equal(verdict.state, "current", `signed install judged ${verdict.state} against ${shippedFrom}`);
    }

    // Running it again over the identical signed install changes nothing (#163).
    const again = await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    assert.equal(again.changed, false);
    assert.ok(again.actions.some((a) => /already identical/.test(a)), again.actions.join(" | "));

    // A dev sync into the signed install voids the signature; reinstalling puts it back.
    fs.appendFileSync(path.join(target, "jsx", "bundle.jsx"), "// AE_MCP_SYNC_PANEL\n");
    assert.deepEqual(signatureProblems(target).modified, ["jsx/bundle.jsx"]);
    // Once that tampered folder is what runs (PlayerDebugMode let it load), the
    // gate sees one half current and one not: mixed, never "uniformly older".
    {
      const shipped = installedPanelHashes(signedDir);
      const onDisk = installedPanelHashes(target);
      const verdict = assessPanel(
        { bundleHash: onDisk.bundle, clientHash: onDisk.client, capabilities: REQUIRED_PANEL_CAPABILITIES },
        onDisk,
        { installComplete: panelInstallDiff(signedDir, target).length === 0, shipped }
      );
      assert.equal(verdict.state, "partial-install", `a tampered signed install was judged ${verdict.state}`);
    }
    // A stray file in a signed install moves the client hash too, and breaks the signature.
    fs.writeFileSync(path.join(target, "client", "stray.js"), "");
    assert.deepEqual(signatureProblems(target).extra, ["client/stray.js"]);
    assert.notEqual(panelClientHash(target), panelClientHash(source));
    fs.rmSync(path.join(target, "client", "stray.js"));
    const repaired = await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    assert.equal(repaired.changed, true);
    assert.ok(signatureIntact(signatureProblems(target)));
  } finally { restoreEnv(); }
});

await check("replacing a self-signed install with the signed panel strips nothing worth warning about", async () => {
  try {
    const target = fakeHome("home-selfsigned");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false });                // an unsigned checkout install…
    fs.mkdirSync(path.join(target, "META-INF"), { recursive: true }); // …signed in place per #91
    fs.writeFileSync(path.join(target, "META-INF", "signatures.xml"), "<signatures/>");
    const res = await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    assert.equal(res.signedInstallOverwritten, undefined);
    assert.equal(res.notes.some((n) => /NOT signed/.test(n)), false);
    assert.ok(signatureIntact(signatureProblems(target)));
  } finally { restoreEnv(); }
});

await check("a signed panel without its own ws is refused before the old install is touched", async () => {
  try {
    const target = fakeHome("home-nows");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    const broken = path.join(tmp, "signed-no-ws");
    fs.cpSync(signedDir, broken, { recursive: true });
    fs.rmSync(path.join(broken, "node_modules"), { recursive: true });
    fs.appendFileSync(path.join(broken, "client", "main.js"), "\n"); // so it would not count as identical
    await assert.rejects(installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: broken, force: true }), /does not carry a complete `ws`/);
    assert.ok(signatureIntact(signatureProblems(target)), "the working signed install was damaged by a refused one");
  } finally { restoreEnv(); }
});

// ---------------------------------------------------------------------------
// check_setup
// ---------------------------------------------------------------------------

await check("PlayerDebugMode off is a failure for an unsigned panel and not for a signed one", () => {
  const off = { on: false, detail: "not enabled for any CSXS version" };
  assert.equal(debugModeCheck(off, false).ok, false);
  assert.match(debugModeCheck(off, false).fix, /setup_panel/);
  const signed = debugModeCheck(off, true);
  assert.equal(signed.ok, true);
  assert.match(signed.detail, /not required: the panel is signed/);
});

await check("a signature the files no longer match fails only where nothing else lets the panel load", () => {
  const p = { modified: ["jsx/bundle.jsx"], missing: [], extra: [] };
  const off = signatureIntactCheck(p, false);
  assert.equal(off.ok, false);
  assert.match(off.detail, /1 changed since signing \(jsx\/bundle\.jsx\)/);
  assert.match(off.fix, /force:true/);
  const on = signatureIntactCheck(p, true);
  assert.equal(on.ok, true, "a dev sync with PlayerDebugMode on still loads");
  assert.match(on.detail, /only because PlayerDebugMode is on/);
  assert.equal(signatureIntactCheck({ modified: [], missing: [], extra: [] }, false).ok, true);
});

const ok = (name, detail = "") => ({ name, ok: true, detail });
const bad = (name, detail = "", fix = "…") => ({ name, ok: false, detail, fix });
const installedFine = [
  ok("platform"), ok("panelAssetsPresent"), ok("cepDebugMode"), ok("panelInstalled"),
  ok("panelUpToDate"), ok("panelDependencies"), ok("afterEffectsRunning"),
  bad("bridgeReachable", "no response on port 7777"),
];
const LINE = "ERROR Signature verification failed for extension games.engine-room.ae-mcp.panel";

await check("files changed after signing explain a logged refusal: reinstall, not re-sign", () => {
  const steps = buildNextSteps(
    [
      ...installedFine,
      signatureIntactCheck({ modified: ["jsx/bundle.jsx"], missing: [], extra: [] }, false),
      { name: "panelSignature", ok: false, evidence: "failure-logged-signed", detail: LINE, fix: "…" },
    ],
    false
  );
  const text = steps.join("\n");
  assert.match(text, /setup_panel tool with force:true/);
  assert.doesNotMatch(text, /ZXPSignCmd/);
  assert.match(steps[0], /^Quit After Effects completely/);
});

await check("an intact signature (any certificate) that CEP still refuses gets its own explanation", () => {
  const steps = buildNextSteps(
    [...installedFine, { name: "panelSignature", ok: false, evidence: "failure-logged-signed", detail: LINE, fix: "…" }],
    false
  );
  assert.match(steps[0], /already signed, with every installed file still matching that signature/);
  assert.match(steps[0], /log_issue/);
  assert.match(steps.join("\n"), /-selfSignedCert/);
});

await check("on a #91 machine, a voided signature with PlayerDebugMode on gets a forced reinstall, not a hand signing", () => {
  const steps = buildNextSteps(
    [
      ...installedFine,
      signatureIntactCheck({ modified: ["jsx/bundle.jsx"], missing: [], extra: [] }, true),
      { name: "panelSignature", ok: false, evidence: "failure-logged-voided", detail: LINE, fix: "…" },
    ],
    false
  );
  const text = steps.join("\n");
  assert.match(text, /setup_panel tool with force:true/);
  assert.doesNotMatch(text, /ZXPSignCmd|-selfSignedCert/);
  assert.doesNotMatch(text, /unsigned/);
});

// ---------------------------------------------------------------------------
// The release's ws is the lockfile's, and its tarball is the one npm publishes
// ---------------------------------------------------------------------------

await check("the signed panel's ws is pinned by the lockfile and checked against its integrity", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const pinned = signing.lockedWs(lock);
  assert.match(pinned.version, /^\d+\.\d+\.\d+/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(wsSrc, "package.json"), "utf8")).version, pinned.version,
    "node_modules/ws is not the version the lockfile pins — run npm ci");
  assert.throws(() => signing.lockedWs({ packages: {} }), /pins no node_modules\/ws/);

  const bytes = Buffer.from("a tarball");
  const sri = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  signing.checkIntegrity(bytes, sri);
  assert.throws(() => signing.checkIntegrity(Buffer.from("another tarball"), sri, "ws@x"), /ws@x does not match the lockfile's integrity/);
  assert.throws(() => signing.checkIntegrity(bytes, "md5-nope"), /does not match/);
  // `sign` takes ws from fetchLockedWs, never from node_modules.
  const src = fs.readFileSync(path.join(root, "scripts", "lib", "panel-signing.mjs"), "utf8");
  const signBlock = src.slice(src.indexOf('if (cmd === "sign"'), src.indexOf('if (cmd === "tool"'));
  assert.match(signBlock, /wsSrc: fetchLockedWs\(/);
});

await check("the tarball's digest travels in the tag, and CI refuses an asset that does not match it", () => {
  const sh = fs.readFileSync(path.join(root, "scripts", "release.sh"), "utf8");
  const yml = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(sh, /git tag -a "\$TAG" -m "\$VERSION" -m "npm-tarball-sha256: \$TARBALL_SHA"/);
  assert.match(yml, /npm-tarball-sha256:/);
  const compare = yml.indexOf('if [ "$ACTUAL" != "$EXPECTED" ]');
  assert.ok(compare > 0, "release.yml no longer compares the asset with the tag's digest");
  assert.ok(compare < yml.indexOf("npm publish \"${{ steps.tarball.outputs.path }}\" --ignore-scripts --provenance"),
    "the digest check must come before the publish");
  // The draft is made, assets and all, before anything is pushed.
  assert.ok(sh.indexOf("--draft") < sh.indexOf('git push --quiet origin "$TAG"'), "the release must be drafted before the tag is pushed");
  assert.ok(sh.indexOf('git push --quiet origin "$TAG"') < sh.lastIndexOf("--draft=false"));
  // CI signs and builds nothing.
  const steps = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(steps, /AE_MCP_PANEL_CERT|ZXPSignCmd|npm ci|npm pack|install-rosetta|panel-signing/);
});

// ---------------------------------------------------------------------------
// check_setup end to end, against a fake home — the Adobe preference and the
// AE process are stand-ins, so no real setting is read or written
// ---------------------------------------------------------------------------

const OFF = { on: false, detail: "not enabled for any CSXS version" };
const ON = { on: true, detail: "enabled (CSXS.12)" };
const byName = (report, name) => report.checks.find((c) => c.name === name);
const quietPrefs = (state) => ({
  isDebugModeOn: async () => (state.on ? ON : OFF),
  enableDebugMode: async () => { state.enabled = (state.enabled ?? 0) + 1; state.on = true; return [12, 11]; },
  ensureCepLogging: async () => ({ set: [], kept: [] }),
  afterEffectsProcess: async () => ({ state: "not-running", detail: "stub" }),
});

await check("check_setup: a signed install loads without PlayerDebugMode, and says so", async () => {
  try {
    fakeHome("home-check-signed");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    const report = await checkSetup({ source: signedDir, debugMode: OFF, afterEffectsRunning: false, candidates: [] });
    const debug = byName(report, "cepDebugMode");
    assert.equal(debug.ok, true, `cepDebugMode failed for a signed install: ${debug.detail}`);
    assert.match(debug.detail, /not required: the panel is signed/);
    assert.equal(byName(report, "panelSignatureIntact").ok, true);
    assert.match(byName(report, "panelInstalled").detail, /\(signed: META-INF\/signatures\.xml present\)/);
    assert.doesNotMatch(byName(report, "panelInstalled").detail, /not the signature/);
    assert.equal(byName(report, "panelUpToDate").ok, true);
    assert.doesNotMatch(report.nextSteps.join("\n"), /setup_panel|reboot|restart the Mac/i);
  } finally { restoreEnv(); }
});

await check("check_setup: the same install voided by a dev sync fails without PlayerDebugMode, passes with it", async () => {
  try {
    const target = fakeHome("home-check-voided");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    fs.writeFileSync(path.join(target, "client", "stray.js"), "");
    const off = await checkSetup({ source: signedDir, debugMode: OFF, afterEffectsRunning: true, candidates: [] });
    assert.equal(byName(off, "panelSignatureIntact").ok, false);
    // The fault is the signature, not the preference (live test of #182):
    // cepDebugMode does not call this an unsigned panel, and does not fail too.
    const debug = byName(off, "cepDebugMode");
    assert.equal(debug.ok, true, "a broken signature was blamed on the debug preference");
    assert.doesNotMatch(debug.detail, /only loads unsigned panels/);
    assert.match(debug.detail, /files changed since/);
    assert.match(debug.detail, /setup_panel with force:true/);
    const text = off.nextSteps.join("\n");
    assert.match(text, /setup_panel tool with force:true/);
    assert.doesNotMatch(text, /restart the Mac|reboot|re-reads the registry/i, "a broken signature is not fixed by a reboot");
    const on = await checkSetup({ source: signedDir, debugMode: ON, afterEffectsRunning: false, candidates: [] });
    assert.equal(byName(on, "panelSignatureIntact").ok, true);
    assert.equal(byName(on, "panelSignatureIntact").evidence, "voided");
  } finally { restoreEnv(); }
});

await check("setup_panel with After Effects closed asks for no restart — opening it is enough", async () => {
  try {
    fakeHome("home-ae-closed");
    for (const source of [signedDir, undefined]) {
      const res = await installPanel({ enableDebugMode: false, force: true, source, prefs: AE_CLOSED });
      assert.equal(res.restartAfterEffects, false, "a closed After Effects cannot be restarted");
      assert.ok(res.notes.some((n) => /^Next: open After Effects/.test(n)), res.notes.join(" | "));
      assert.ok(!res.notes.some((n) => /restart After Effects|quit and reopen/i.test(n)), res.notes.join(" | "));
    }
    // And check_setup, with the fresh install and AE closed, says open it — never restart it.
    await installPanel({ enableDebugMode: false, force: true, source: signedDir, prefs: AE_CLOSED });
    const after = await checkSetup({ source: signedDir, debugMode: OFF, afterEffectsRunning: false, candidates: [] });
    assert.deepEqual(after.nextSteps, ["Open After Effects."]);
  } finally { restoreEnv(); }
});

await check("check_setup: an unsigned install still needs PlayerDebugMode", async () => {
  try {
    fakeHome("home-check-unsigned");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false });
    const report = await checkSetup({ source: panelSrc, debugMode: OFF, afterEffectsRunning: false, candidates: [] });
    assert.equal(byName(report, "cepDebugMode").ok, false);
    assert.equal(byName(report, "panelSignatureIntact"), undefined);
  } finally { restoreEnv(); }
});

await check("setup_panel with the debug preference on: signed sets it as a fallback with no restart, unsigned asks for one", async () => {
  try {
    fakeHome("home-prefs");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false, source: signedDir });
    const state = { on: false };
    const signed = await installPanel({ source: signedDir, prefs: quietPrefs(state) });
    assert.equal(state.enabled, 1, "the fallback preference was not set");
    assert.equal(signed.changed, false, "turning on a preference the signed panel does not need counted as a change");
    assert.equal(signed.rebootRecommended, false);
    assert.ok(signed.actions.some((a) => /only as a fallback/.test(a)), signed.actions.join(" | "));

    fakeHome("home-prefs-unsigned");
    await installPanel({ prefs: AE_CLOSED, enableDebugMode: false });
    const state2 = { on: false };
    const unsigned = await installPanel({ prefs: quietPrefs(state2) });
    assert.equal(state2.enabled, 1);
    assert.equal(unsigned.changed, true, "an unsigned panel needs the preference loaded, which is a change");
    assert.equal(unsigned.rebootRecommended, process.platform === "darwin");
  } finally { restoreEnv(); }
});

restoreEnv();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`panel-signing: ${passed} checks passed`);
