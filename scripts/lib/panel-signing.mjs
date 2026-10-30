#!/usr/bin/env node
// Signs the CEP panel a release ships (issue #182), so After Effects loads it
// without Adobe's PlayerDebugMode — the most fragile step of setup, ignored
// outright by CEP 12 on some Windows installs (issue #91).
//
// Signing is a packaging step and nothing else. The panel in the repo is never
// signed, and neither is anything a developer installs from a checkout: dev
// installs are edited in place (`/reload-jsx`, `--symlink`, AE_MCP_SYNC_PANEL)
// and any byte changed after signing makes CEP refuse the panel. Dev keeps
// PlayerDebugMode.
//
// **A release signs once.** `release.sh` runs `sign <dir>` a single time, on
// the release machine, before anything is tagged, and points
// AE_MCP_SIGNED_PANEL at the result. The three packaging scripts
// (prepare-package, build-mcpb, build-binaries) then put down that same folder
// through `vendorPanel`, so the npm tarball, the .mcpb and every binary carry
// byte-identical signatures — one certificate, one timestamp. CI never signs:
// release.yml publishes the tarball release.sh built (see the header there).
//
// The signed folder gets `node_modules/ws` *inside* it before signing — the
// signature covers every file, so `setup_panel` must never add `ws` afterwards —
// and is verified twice: by this repo's own manifest check and by
// `ZXPSignCmd -verify`.
//
// ---------------------------------------------------------------- environment
//
//   AE_MCP_PANEL_SIGN            "required" — the panel must come out signed or
//                                the build fails (release.sh sets this); "off" —
//                                never sign; unset — sign only when configured.
//   AE_MCP_SIGNED_PANEL          a folder `sign` produced. Packaging copies it
//                                verbatim instead of signing again, after
//                                checking it is intact and is this source's panel.
//   AE_MCP_PANEL_CERT            path to a .p12 made with `ZXPSignCmd
//                                -selfSignedCert`, or "ephemeral" for a
//                                throwaway certificate made for this one signing.
//   AE_MCP_PANEL_CERT_PASSWORD   the .p12's password (not needed for ephemeral).
//   AE_MCP_PANEL_TSA             timestamp server; "none" to skip. Defaults to
//                                DigiCert's. A timestamped signature stays valid
//                                after the certificate expires.
//   AE_MCP_ZXPSIGNCMD            a ZXPSignCmd to use instead of downloading the
//                                pinned one (an air-gapped machine; the tests).
//
// Why "ephemeral" is a first-class choice: a self-signed certificate proves
// nothing about who signed — CEP accepts any self-signed certificate, and
// checks only that the files match the signature. So a persistent one buys no
// trust, and is one more secret to keep. release.sh uses an ephemeral one
// unless AE_MCP_PANEL_CERT says otherwise; it exists for the one signing and is
// deleted with its work folder. A persistent .p12, like the Developer ID, comes
// from the environment and is never committed (`*.p12` is gitignored).
//
// The password: ZXPSignCmd takes it only as a command-line argument — it has no
// stdin or file option — so for the second or so a signing takes it is visible
// to other processes of the same user. That cannot be avoided with Adobe's tool.
// What is avoided: it is never echoed, and every error message this module
// builds has it redacted (`runTool`), including Node's own "Command failed: …"
// text, which quotes the whole command line.
//
// ----------------------------------------------------------------- ZXPSignCmd
//
// Adobe's signing tool, from Adobe-CEP/CEP-Resources on GitHub. Pinned to one
// commit and checked by SHA-256 before it is ever run: downloaded code that
// signs what we ship does not get to change underneath a release. To move to a
// new version, download both builds from the new commit, check them, and
// update ZXPSIGNCMD below — the version, the commit and both digests together.
// Cached under node_modules/.cache, so a release downloads it once.
//
// CLI:
//   node scripts/lib/panel-signing.mjs plan                 say what the environment asks for; exit 1 if unusable
//   node scripts/lib/panel-signing.mjs sign <out-dir>       vendor the checkout's panel + the lockfile's ws into <out-dir>, sign it
//   node scripts/lib/panel-signing.mjs tool                 print the path of a checked ZXPSignCmd
//   node scripts/lib/panel-signing.mjs verify <panel-dir>   exit 0 when signed and intact

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const ZXPSIGNCMD = {
  version: "4.1.3",
  // The last commit to touch ZXPSignCMD/4.1.3 (2025-04-30).
  commit: "fcee8de5537d2dd2ed3d91d5a495b7041155b280",
  builds: {
    // An x86_64 binary: on Apple silicon it runs under Rosetta.
    darwin: {
      repoPath: "ZXPSignCMD/4.1.3/macOS/ZXPSignCmd",
      file: "ZXPSignCmd",
      sha256: "bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095",
    },
    win32: {
      repoPath: "ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe",
      file: "ZXPSignCmd.exe",
      sha256: "ffc2223167225ce61d024eb463fc5ad1a1be16133f99ef334a646f7311916c98",
    },
  },
};

export const DEFAULT_TSA = "http://timestamp.digicert.com";

/**
 * What the environment asks for. Throws for a configuration that cannot be
 * honoured — `required` with nothing to sign with, a certificate with no
 * password — rather than quietly shipping an unsigned panel.
 *
 * @returns {{sign: false, reason: string}
 *   | {sign: true, prebuilt: string}
 *   | {sign: true, cert: string, password: string | null, tsa: string | null, required: boolean}}
 */
export function signingPlan(env = process.env) {
  const mode = (env.AE_MCP_PANEL_SIGN ?? "").trim().toLowerCase();
  if (mode && !["required", "off", "auto"].includes(mode)) {
    throw new Error(`AE_MCP_PANEL_SIGN is "${env.AE_MCP_PANEL_SIGN}"; expected "required", "off" or unset.`);
  }
  if (mode === "off") return { sign: false, reason: "AE_MCP_PANEL_SIGN=off" };
  const required = mode === "required";
  const prebuilt = (env.AE_MCP_SIGNED_PANEL ?? "").trim();
  if (prebuilt) {
    if (!fs.existsSync(path.join(prebuilt, "META-INF", "signatures.xml"))) {
      throw new Error(`AE_MCP_SIGNED_PANEL points at ${prebuilt}, which is not a signed panel (no META-INF/signatures.xml).`);
    }
    return { sign: true, prebuilt };
  }
  const cert = (env.AE_MCP_PANEL_CERT ?? "").trim();
  if (!cert) {
    if (required) {
      throw new Error(
        "AE_MCP_PANEL_SIGN=required, but there is nothing to sign with. Set AE_MCP_SIGNED_PANEL to a panel signed " +
          "with `panel-signing.mjs sign`, or AE_MCP_PANEL_CERT to a .p12 (with AE_MCP_PANEL_CERT_PASSWORD) or \"ephemeral\"."
      );
    }
    return { sign: false, reason: "no AE_MCP_PANEL_CERT configured" };
  }
  const tsaEnv = (env.AE_MCP_PANEL_TSA ?? "").trim();
  const tsa = tsaEnv.toLowerCase() === "none" ? null : tsaEnv || DEFAULT_TSA;
  if (cert === "ephemeral") return { sign: true, cert, password: null, tsa, required };
  const password = env.AE_MCP_PANEL_CERT_PASSWORD ?? "";
  if (!password) throw new Error("AE_MCP_PANEL_CERT is set but AE_MCP_PANEL_CERT_PASSWORD is not.");
  if (!fs.existsSync(cert)) throw new Error(`AE_MCP_PANEL_CERT points at ${cert}, which does not exist.`);
  return { sign: true, cert, password, tsa, required };
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * A ZXPSignCmd that is safe to run: the override, or the pinned build for this
 * platform, downloaded once and checked against its digest every time.
 */
export async function obtainZxpSignCmd(
  env = process.env,
  {
    platform = process.platform,
    fetchImpl = fetch,
    cacheDir = path.join(root, "node_modules", ".cache", "zxpsigncmd", ZXPSIGNCMD.version),
  } = {}
) {
  if (env.AE_MCP_ZXPSIGNCMD) {
    if (!fs.existsSync(env.AE_MCP_ZXPSIGNCMD)) throw new Error(`AE_MCP_ZXPSIGNCMD points at ${env.AE_MCP_ZXPSIGNCMD}, which does not exist.`);
    return env.AE_MCP_ZXPSIGNCMD;
  }
  const build = ZXPSIGNCMD.builds[platform];
  if (!build) throw new Error(`ZXPSignCmd has no build for ${platform}; the panel can be signed on macOS or Windows only.`);
  const file = path.join(cacheDir, build.file);
  if (fs.existsSync(file) && sha256File(file) === build.sha256) return file;

  const url = `https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/${ZXPSIGNCMD.commit}/${build.repoPath}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Downloading ZXPSignCmd failed: ${res.status} ${res.statusText} (${url})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== build.sha256) {
    throw new Error(`ZXPSignCmd from ${url} has SHA-256 ${got}, expected ${build.sha256}. Refusing to run it.`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o755 });
  fs.renameSync(tmp, file);
  return file;
}

/** Every occurrence of each secret replaced. Empty and very short values are left alone — they would redact noise. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * Run a tool, and on failure throw a message built from its exit status and its
 * own output only — never from Node's `err.message`, which quotes the whole
 * command line, password included — with every secret redacted from what is
 * left. Replaced in tests by a function that plays ZXPSignCmd.
 */
export function runTool(tool, args, { secrets = [] } = {}) {
  try {
    return execFileSync(tool, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const out = redact(`${err.stdout ?? ""}${err.stderr ?? ""}`.trim(), secrets);
    const why = err.status != null ? `exit ${err.status}` : err.signal ? `signal ${err.signal}` : redact(err.code ?? "did not run", secrets);
    throw new Error(`${path.basename(tool)} ${args[0]} failed (${why})${out ? `: ${out}` : ""}`);
  }
}

async function loadDist(...rel) {
  const file = path.join(root, "packages", "mcp-server", "dist", ...rel);
  if (!fs.existsSync(file)) throw new Error("The TypeScript build is missing. Run `npm run build:ts` first.");
  return import(pathToFileURL(file).href);
}

/** The two files signing adds, out of the .zxp ZXPSignCmd wrote, into `dir` — with the server's own zip reader. */
export async function extractSignature(zxp, dir) {
  const { readEntries, inflateEntry } = await loadDist("frames", "mogrtThumbnail.js");
  const entries = readEntries(fs.readFileSync(zxp));
  for (const name of ["META-INF/signatures.xml", "mimetype"]) {
    const entry = entries.find((e) => e.name === name);
    if (!entry) throw new Error(`${path.basename(zxp)} has no ${name}; ZXPSignCmd did not produce a signed package.`);
    const out = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, inflateEntry(entry));
  }
}

/**
 * Sign `dir` in place. `dir` must already hold everything the installed panel
 * will hold — `ws` included — because nothing may be added afterwards.
 */
export async function signPanelDir(dir, plan, { env = process.env, run = runTool, tool } = {}) {
  const zxpTool = tool ?? (await obtainZxpSignCmd(env));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-sign-"));
  try {
    let cert = plan.cert;
    let password = plan.password;
    if (cert === "ephemeral") {
      cert = path.join(work, "ephemeral.p12");
      password = crypto.randomBytes(24).toString("base64url");
      // 100 years: the timestamp is what keeps a signature valid past its
      // certificate, and a build without one should not expire either.
      run(zxpTool, ["-selfSignedCert", "US", "CA", "Engine Room", "AE MCP Bridge", password, cert, "-validityDays", "36500"], {
        secrets: [password],
      });
    }
    const zxp = path.join(work, "panel.zxp");
    run(zxpTool, ["-sign", dir, zxp, cert, password, ...(plan.tsa ? ["-tsa", plan.tsa] : [])], { secrets: [password] });
    await extractSignature(zxp, dir);

    const { signatureProblems, signatureIntact, describeSignatureProblems } = await loadDist("setup", "panelSignature.js");
    const problems = signatureProblems(dir);
    if (!signatureIntact(problems)) {
      throw new Error(
        `The signed panel at ${dir} does not match its own signature` +
          (problems ? `: ${describeSignatureProblems(problems)}` : " (no file manifest in signatures.xml)")
      );
    }
    run(zxpTool, ["-verify", dir]);
  } finally {
    // The ephemeral certificate and its password never outlive the signing.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Relative paths (forward slashes) of every file under `dir`, skipping .DS_Store. */
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

/**
 * Why the pre-signed panel at `signed` is not this checkout's panel, or null.
 * It must hold exactly the source's files (its own node_modules aside), `ws`
 * exactly as `wsSrc`, and the two signature files — so a stale signed folder
 * from an earlier build can never ship with a newer server.
 */
export function prebuiltMismatch(signed, panelSrc, wsSrc) {
  const expected = new Map();
  for (const rel of filesUnder(panelSrc)) {
    if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;
    expected.set(rel, path.join(panelSrc, ...rel.split("/")));
  }
  for (const rel of filesUnder(wsSrc)) expected.set(`node_modules/ws/${rel}`, path.join(wsSrc, ...rel.split("/")));
  const actual = filesUnder(signed).filter((rel) => rel !== "META-INF/signatures.xml" && rel !== "mimetype");
  const extra = actual.filter((rel) => !expected.has(rel));
  if (extra.length) return `it holds files the source does not: ${extra.slice(0, 4).join(", ")}`;
  const differ = [];
  for (const [rel, from] of expected) {
    const at = path.join(signed, ...rel.split("/"));
    if (!fs.existsSync(at) || !fs.readFileSync(at).equals(fs.readFileSync(from))) differ.push(rel);
  }
  if (differ.length) return `it differs from the source in ${differ.slice(0, 4).join(", ")}${differ.length > 4 ? ", …" : ""}`;
  return null;
}

/**
 * Vendor the panel into `dest`, signed when the environment asks for it. The
 * one place the packaging scripts put a panel down.
 *
 * @param {{panelSrc: string, wsSrc: string, dest: string, copy: (src: string, dst: string) => void,
 *          env?: NodeJS.ProcessEnv, run?: Function, tool?: string, log?: (line: string) => void}} o
 * @returns {Promise<{signed: boolean, prebuilt?: boolean, reason?: string}>}
 */
export async function vendorPanel({ panelSrc, wsSrc, dest, copy, env = process.env, run, tool, log = console.log }) {
  const plan = signingPlan(env);
  fs.rmSync(dest, { recursive: true, force: true });

  if (plan.sign && plan.prebuilt) {
    // The release's one signed panel, copied byte for byte — node_modules and
    // all, which the packaging copy would skip — after proving it is still
    // intact and still this source's panel.
    const { signatureProblems, signatureIntact, describeSignatureProblems } = await loadDist("setup", "panelSignature.js");
    const problems = signatureProblems(plan.prebuilt);
    if (!signatureIntact(problems)) {
      throw new Error(
        `AE_MCP_SIGNED_PANEL (${plan.prebuilt}) no longer matches its signature` +
          (problems ? `: ${describeSignatureProblems(problems)}` : "")
      );
    }
    const mismatch = prebuiltMismatch(plan.prebuilt, panelSrc, wsSrc);
    if (mismatch) throw new Error(`AE_MCP_SIGNED_PANEL (${plan.prebuilt}) is not this checkout's panel: ${mismatch}. Sign again.`);
    fs.cpSync(plan.prebuilt, dest, { recursive: true });
    log(`Panel: the release's signed panel copied verbatim -> ${dest}`);
    return { signed: true, prebuilt: true };
  }

  copy(panelSrc, dest);
  if (!plan.sign) {
    // Unsigned, exactly as before: `ws` is supplied by setup_panel at install.
    log(`Panel vendored unsigned (${plan.reason}); it will need PlayerDebugMode to load.`);
    return { signed: false, reason: plan.reason };
  }
  if (!fs.existsSync(path.join(wsSrc, "package.json"))) throw new Error(`No ws module at ${wsSrc}; run \`npm install\` first.`);
  copy(wsSrc, path.join(dest, "node_modules", "ws"));
  await signPanelDir(dest, plan, { env, run, tool });
  log(`Panel signed (${plan.cert === "ephemeral" ? "ephemeral certificate" : "certificate from AE_MCP_PANEL_CERT"}) and verified -> ${dest}`);
  return { signed: true };
}

/**
 * For the release checks: why the panel in `dir` is not a correctly signed
 * one, or null when it is. Runs the real verifier too when a tool is given.
 */
export async function panelSignatureProblem(dir, { run = runTool, tool } = {}) {
  const { isSignedPanel, signatureProblems, signatureIntact, describeSignatureProblems } = await loadDist("setup", "panelSignature.js");
  if (!isSignedPanel(dir)) return "the panel is not signed (no META-INF/signatures.xml)";
  const problems = signatureProblems(dir);
  if (!signatureIntact(problems)) {
    return `the panel does not match its signature: ${problems ? describeSignatureProblems(problems) : "no file manifest"}`;
  }
  if (!fs.existsSync(path.join(dir, "node_modules", "ws", "package.json"))) {
    return "the signed panel does not carry node_modules/ws, so setup_panel would have to add it and void the signature";
  }
  if (tool) {
    try {
      run(tool, ["-verify", dir]);
    } catch (err) {
      return `ZXPSignCmd -verify refused it: ${err.message}`;
    }
  }
  return null;
}

/**
 * The `ws` the lockfile pins, as `{version, integrity}`. The signed panel
 * carries `ws` inside its signature for as long as that release is installed,
 * so it is taken from the lockfile, not from whatever `node_modules` holds.
 */
export function lockedWs(lock) {
  const entry = lock?.packages?.["node_modules/ws"];
  if (!entry?.version || !entry?.integrity) throw new Error("package-lock.json pins no node_modules/ws with an integrity hash.");
  return { version: entry.version, integrity: entry.integrity };
}

/** Throws unless `tarballBytes` is exactly the tarball an SRI `integrity` string names. */
export function checkIntegrity(tarballBytes, integrity, label = "tarball") {
  const ok = integrity
    .trim()
    .split(/\s+/)
    .some((sri) => {
      const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(sri);
      return !!m && crypto.createHash(m[1]).update(tarballBytes).digest("base64") === m[2];
    });
  if (!ok) throw new Error(`${label} does not match the lockfile's integrity ${integrity}.`);
}

/**
 * `ws` exactly as the lockfile pins it: fetched by version from the registry,
 * its tarball checked against the lockfile's integrity hash, and unpacked into
 * `stagingDir`. Returns the unpacked module's directory.
 */
export function fetchLockedWs(stagingDir, { lockPath = path.join(root, "package-lock.json") } = {}) {
  const { version, integrity } = lockedWs(JSON.parse(fs.readFileSync(lockPath, "utf8")));
  fs.mkdirSync(stagingDir, { recursive: true });
  const out = execFileSync("npm", ["pack", `ws@${version}`, "--pack-destination", stagingDir, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
  const file = path.join(stagingDir, JSON.parse(out)[0].filename);
  checkIntegrity(fs.readFileSync(file), integrity, `ws@${version} from the registry`);
  execFileSync("tar", ["-xzf", file, "-C", stagingDir]);
  return path.join(stagingDir, "package");
}

async function cli(argv) {
  const [cmd, target] = argv;
  if (cmd === "plan") {
    // Throws (exit 1, with the reason) for a configuration that cannot be honoured.
    const plan = signingPlan();
    console.log(
      !plan.sign
        ? `panel signing: off (${plan.reason})`
        : plan.prebuilt
          ? `panel signing: the signed panel at ${plan.prebuilt}`
          : `panel signing: on (${plan.cert === "ephemeral" ? "ephemeral certificate" : plan.cert})`
    );
    return 0;
  }
  if (cmd === "sign" && target) {
    // Never from AE_MCP_SIGNED_PANEL: this is what makes one.
    const env = { ...process.env, AE_MCP_SIGNED_PANEL: "", AE_MCP_PANEL_SIGN: "required" };
    const { loadPackagingCopy } = await import("./setup.mjs");
    // `ws` from the lockfile, integrity-checked — never node_modules, which
    // could hold anything a local `npm install` left there. The packaging
    // steps then compare their own node_modules/ws against this copy
    // (prebuiltMismatch), so a drifted install fails the release too.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-ws-"));
    try {
      await vendorPanel({
        panelSrc: path.join(root, "packages", "ae-panel"),
        wsSrc: fetchLockedWs(staging),
        dest: path.resolve(target),
        copy: await loadPackagingCopy(),
        env,
      });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return 0;
  }
  if (cmd === "tool") {
    console.log(await obtainZxpSignCmd());
    return 0;
  }
  if (cmd === "verify" && target) {
    const problem = await panelSignatureProblem(path.resolve(target), { tool: await obtainZxpSignCmd() });
    if (problem) {
      console.error(`${target}: ${problem}`);
      return 1;
    }
    console.log(`${target}: signed, intact, and verified by ZXPSignCmd`);
    return 0;
  }
  console.error("usage: panel-signing.mjs plan | sign <out-dir> | tool | verify <panel-dir>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}
