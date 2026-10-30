import fs from "node:fs";
import path from "node:path";
import {
  diagnosticPortCandidates,
  panelToken,
  pinnedPort,
  portFilePort,
  probePanel,
  tokenFilePath,
  type ProbeResult,
} from "../bridge/discovery.js";
import {
  BUNDLE_ID,
  cepExtensionsDir,
  installedPanelDir,
  isSupportedPlatform,
  isWsModuleDir,
  panelInstallDiff,
  panelSourceDir,
  signedInstallPresent,
} from "./paths.js";
import { assessPanel, installedPanelHashes, sourcePanelHashes } from "./panelVersion.js";
import {
  SIGNATURE_FILE,
  describeSignatureProblems,
  isSignedPanel,
  signatureIntact,
  signatureProblems,
  type SignatureProblems,
} from "./panelSignature.js";
import {
  CSXS_VERSIONS,
  cepLogDir,
  cepLogLevel,
  cepLogLevelCommand,
  cepLogPaths,
  debugModeLocation,
  isAfterEffectsRunning,
  isDebugModeOn,
} from "./platform.js";

/** Matches the probe timeout in discovery.ts; quoted at the user in two places. */
const BRIDGE_PROBE_MS = 2000;
const BRIDGE_BUSY_FIX =
  "This is a timeout, not a refused connection — something is listening, it just did not answer in time. " +
  "After Effects is most likely busy running a script, or waiting on a modal dialog nobody has clicked. " +
  "Wait and run check_setup again, up to about a minute, before restarting anything; it usually clears on its own. " +
  "On macOS, if the user has switched to another desktop, ask them to switch back to the one After Effects is on.";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Present when !ok — what to do about it, in plain language. */
  fix?: string;
  /**
   * A machine-readable qualifier for checks whose `ok` does not say everything
   * — `panelSignature` is `ok` both when the CEP log is clean and when there is
   * no log to read, and `nextSteps` has to tell those apart.
   */
  evidence?: string;
}

export interface SetupReport {
  ready: boolean;
  checks: Check[];
  nextSteps: string[];
}

export interface CheckSetupOptions {
  /**
   * The port this server is sending ops to right now. Only the MCP server
   * knows it; `doctor` and the CLI leave it out and get no `portAgreement`
   * check, since there is nothing for the answering port to disagree with.
   */
  opPort?: number;
  /** Ports to ask, in order. Defaults to the same list the bridge client uses. */
  candidates?: number[];
  /** Tests only: the panel these tools ship, instead of `panelSourceDir()`. */
  source?: string | null;
  /** Tests only: the PlayerDebugMode reading, instead of asking Adobe's preferences. */
  debugMode?: { on: boolean; detail: string };
  /** Tests only: whether After Effects is running, instead of asking the OS. */
  afterEffectsRunning?: boolean;
}

export interface BridgeProbe {
  /** The first candidate that answered as the panel, or null. */
  answering: ProbeResult | null;
  /** When nothing answered as the panel: the first port that accepted and went quiet, or null. */
  busy: ProbeResult | null;
  /** What was found at the op port specifically, when one was given. */
  atOpPort: ProbeResult | null;
  /** Everything asked, in the order asked. */
  probed: ProbeResult[];
}

/** check_setup's detail for an "unverifiable" running panel; nextSteps keys on it. */
export const UNVERIFIABLE_DETAIL = "the running panel could not read its own files to report its version";

/**
 * Where is the panel, and does that agree with where ops are going?
 *
 * The op port is asked first when given, because "the port ops go to answers"
 * is the whole question — every other candidate only matters if it does not.
 * The rest are asked in the bridge client's own order, so what this reports
 * is what a refused op would have found.
 */
export async function probeBridge(candidates: number[] = diagnosticPortCandidates(), opPort?: number): Promise<BridgeProbe> {
  const order: number[] = [];
  const push = (p: number | undefined) => { if (p !== undefined && !order.includes(p)) order.push(p); };
  push(opPort);
  for (const c of candidates) push(c);

  const probed: ProbeResult[] = [];
  let answering: ProbeResult | null = null;
  let busy: ProbeResult | null = null;
  for (const port of order) {
    const r = await probePanel(port, BRIDGE_PROBE_MS);
    probed.push(r);
    if (r.status === "panel" && !answering) answering = r;
    if (r.status === "busy" && !busy) busy = r;
    // The first port to answer as the panel ends the search. The op port went
    // first, so if it is the one answering nothing else is asked at all.
    if (answering) break;
  }
  const atOpPort = opPort === undefined ? null : probed.find((p) => p.port === opPort) ?? null;
  return { answering, busy, atOpPort, probed };
}

/** What the CEP log says about this panel's signature, if anything. */
export interface SignatureFinding {
  file: string;
  line: string;
  mtime: Date;
}

/** Only the tail is read: a CEP log at LogLevel 6 grows without bound, and check_setup must not stall on it. */
const CEP_LOG_TAIL_BYTES = 256 * 1024;

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Scan the newest CEP log for the line that says CEP refused this panel's
 * signature. The needle is built from the bundle id, never spelled out: the
 * extension id in the log is `<bundleId>.panel`, and a literal here would be
 * one more copy of a name that already lives in the manifest.
 */
export function findSignatureFailure(logs: string[], bundleId: string = BUNDLE_ID): SignatureFinding | null {
  const needle = `Signature verification failed for extension ${bundleId}`;
  for (const file of logs) {
    let text: string;
    let mtime: Date;
    try {
      text = readTail(file, CEP_LOG_TAIL_BYTES);
      mtime = fs.statSync(file).mtime;
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.includes(needle));
    if (lines.length > 0) {
      return { file, line: lines[lines.length - 1].trim().slice(0, 240), mtime };
    }
  }
  return null;
}

/**
 * The self-signing workaround from issue #91, as steps. Kept as a list so
 * `nextSteps` can hand it over one line at a time; the commands are exact
 * because the person following them may never have signed anything.
 */
export function signatureWorkaroundSteps(installed: string, opts: { shippedSigned?: boolean } = {}): string[] {
  const lead = opts.shippedSigned
    ? "After Effects is refusing to load the panel because CEP rejected its signature — and this panel is already signed, with every installed file still matching that signature. " +
      "Nothing here needs reinstalling, and restarting After Effects again will not change it. Please report it with log_issue, quoting the panelSignature line. " +
      "What has worked on such machines is signing the installed folder again locally, with Adobe's own tool (Adobe advises signing on the platform the panel runs on):"
    : "After Effects is refusing to load the panel because CEP's signature check is running even though PlayerDebugMode is on. " +
      "That is an Adobe CEP 12 bug, not a broken install — nothing here needs reinstalling, and restarting After Effects again will not change it. " +
      "The fix is to sign the installed panel folder yourself, with Adobe's own tool, so it passes the check.";
  return [
    lead,
    "1. Download ZXPSignCmd from Adobe's CEP-Resources repository on GitHub (folder `ZXPSignCMD/4.1.3`, the build for this platform). It is a single command-line program.",
    '2. Make a self-signed certificate: `ZXPSignCmd -selfSignedCert US CA "AE MCP" "AE MCP Bridge" password cert.p12` (the country, state and names are free text; keep the password).',
    `3. Sign the installed panel folder into a zip: \`ZXPSignCmd -sign "${installed}" signed.zxp cert.p12 password -tsa http://timestamp.digicert.com\``,
    `4. Unzip signed.zxp back into that same folder, overwriting in place. That adds \`META-INF/signatures.xml\` and a \`mimetype\` file next to the panel's own files and changes nothing else. check_setup keeps reporting the panel as up to date with those extra files present.`,
    "5. Then restart After Effects — the signed panel loads on launch. Run check_setup to confirm.",
    "Caveat: setup_panel replaces the folder with the copy these tools ship, which drops a signature made on this machine. After any reinstall here, steps 3-5 have to be done again.",
  ];
}

/**
 * The `cepDebugMode` check. PlayerDebugMode is what lets CEP load an
 * *unsigned* panel; a signed one loads without it (issue #182), so for a signed
 * panel the flag being off is not a fault and must not fail the check — that
 * would send the user to setup_panel and a reboot for nothing.
 *
 * @param signedLoads true when the panel After Effects will load carries an
 *   intact signature: the installed one if it is installed, otherwise the one
 *   setup_panel would install.
 */
export function debugModeCheck(
  debugMode: { on: boolean; detail: string },
  signedLoads: boolean,
  signatureVoided = false
): Check {
  // A signed panel whose files changed since signing is not an unsigned panel:
  // the flag is only the fallback that would let AE load the modified files,
  // and the fault — with its fix — belongs to panelSignatureIntact. Failing
  // here as well sent the user to "turn on the preference" and "restart the
  // Mac" for a panel that only needs putting back (live test of #182).
  if (signatureVoided) {
    return {
      name: "cepDebugMode",
      ok: true,
      detail: debugMode.on
        ? `${debugMode.detail} — the installed panel's signature no longer matches its files, and this preference is what still lets After Effects load it; the fix is setup_panel with force:true (see panelSignatureIntact)`
        : `${debugMode.detail} — not the fault: the installed panel is signed but its files changed since. This preference, if on, would let After Effects load the modified panel anyway; the fix is setup_panel with force:true (see panelSignatureIntact)`,
    };
  }
  if (signedLoads) {
    return {
      name: "cepDebugMode",
      ok: true,
      detail: `${debugMode.detail} — not required: the panel is signed, so After Effects loads it without this preference`,
    };
  }
  return {
    name: "cepDebugMode",
    ok: debugMode.on,
    detail: debugMode.detail,
    fix: debugMode.on
      ? undefined
      : `Quit After Effects completely if it is open, then run the setup_panel tool, then reopen After Effects. It only loads unsigned panels when ${debugModeLocation()} is set.`,
  };
}

/**
 * The `panelSignatureIntact` check, for an installed folder that carries a
 * signature. A signature over files that have since changed is worse than none:
 * CEP refuses the panel outright unless PlayerDebugMode is on and honoured.
 * The usual cause is development — `AE_MCP_SYNC_PANEL=1`, `/reload-jsx` edits,
 * or a hand copy into a signed install — and there the flag is on, so it still
 * loads. That case passes, with the detail saying why.
 */
export function signatureIntactCheck(
  problems: SignatureProblems | null,
  debugModeOn: boolean,
  sourceSigned = true
): Check {
  if (signatureIntact(problems)) {
    return { name: "panelSignatureIntact", ok: true, detail: "every installed file matches the panel's signature" };
  }
  const what = problems
    ? describeSignatureProblems(problems)
    : `${SIGNATURE_FILE} lists no files, so nothing it covers can be checked`;
  if (debugModeOn) {
    // `evidence: "voided"` lets nextSteps tell this apart from an intact
    // signature: on a #91 machine CEP checks signatures despite the flag, and
    // then the fix is to put the signed files back, not to sign by hand.
    return {
      name: "panelSignatureIntact",
      ok: true,
      evidence: "voided",
      detail:
        `the installed files no longer match the panel's signature — ${what}. It loads only because PlayerDebugMode is on; ` +
        "a development sync or reload into a signed install does this",
    };
  }
  return {
    name: "panelSignatureIntact",
    ok: false,
    detail: `the installed files no longer match the panel's signature — ${what}`,
    fix: sourceSigned
      ? "After Effects refuses a panel whose files changed after it was signed. Quit After Effects completely, then run setup_panel " +
        "with force:true to put the signed panel back exactly as shipped, then reopen it."
      : "After Effects refuses a panel whose files changed after it was signed. Quit After Effects completely, then run setup_panel " +
        "with force:true: these tools ship an unsigned panel, which replaces this one and loads through the Adobe preference setup_panel turns on. Then reopen it.",
  };
}

export async function checkSetup(opts: CheckSetupOptions = {}): Promise<SetupReport> {
  const checks: Check[] = [];

  const supported = isSupportedPlatform();
  checks.push({
    name: "platform",
    ok: supported,
    detail: process.platform,
    fix: supported ? undefined : "After Effects runs only on macOS and Windows, so this server supports only those two.",
  });

  const source = opts.source !== undefined ? opts.source : panelSourceDir();
  checks.push({
    name: "panelAssetsPresent",
    ok: source !== null,
    detail: source ?? "not found in this installation",
    fix: source ? undefined : "The package is missing its CEP panel assets — reinstall the server.",
  });

  const installed = installedPanelDir();
  const isInstalled = fs.existsSync(path.join(installed, "CSXS", "manifest.xml"));
  const signed = isInstalled && signedInstallPresent(installed);
  // Issue #182: a release ships the panel signed. Whether the installed copy's
  // signature still covers its files decides whether PlayerDebugMode matters.
  const sourceSigned = source !== null && isSignedPanel(source);
  const installedProblems = isInstalled && isSignedPanel(installed) ? signatureProblems(installed) : null;
  // Integrity only, never which certificate: every artifact of a release
  // carries the same signature, but a self-signed (#91) install or one signed
  // by an earlier release is just as loadable, so the question is only whether
  // the files still match the signature they carry.
  const installedSignedIntact = isInstalled && isSignedPanel(installed) && signatureIntact(installedProblems);

  const debugMode = opts.debugMode ?? (await isDebugModeOn());
  checks.push(
    debugModeCheck(
      debugMode,
      isInstalled ? installedSignedIntact : sourceSigned,
      isInstalled && isSignedPanel(installed) && !installedSignedIntact
    )
  );

  checks.push({
    name: "panelInstalled",
    ok: isInstalled,
    detail: isInstalled
      ? `${installed}${
          !signed
            ? ""
            : isSignedPanel(installed)
              ? " (signed: META-INF/signatures.xml present)"
              : " (self-signed: META-INF present)"
        }`
      : `not present at ${installed}`,
    fix: isInstalled
      ? undefined
      : "Quit After Effects completely if it is open, then run the setup_panel tool to install it, then reopen After Effects.",
  });

  if (isInstalled && isSignedPanel(installed)) {
    checks.push(signatureIntactCheck(installedProblems, debugMode.on, sourceSigned));
  }

  // Every shipped file, not just bundle.jsx. Checking the bundle alone passed a
  // half-updated install as current, which sent the user round a restart loop
  // that could not terminate — the client files were still the old version and
  // no restart was ever going to change that.
  let installComplete = true;
  if (isInstalled && source) {
    const differing = panelInstallDiff(source, installed);
    installComplete = differing.length === 0;
    const shown = differing.slice(0, 4).join(", ");
    // A cleanly installed older panel differs too — in both halves. Only one
    // half current is a mix (panelVersion.ts), and only that is worded as one.
    const shipped = opts.source !== undefined ? (source ? installedPanelHashes(source) : null) : sourcePanelHashes();
    const onDisk = installedPanelHashes(installed);
    const olderVersion =
      !installComplete && !!shipped && onDisk.bundle !== shipped.bundle && onDisk.client !== shipped.client;
    checks.push({
      name: "panelUpToDate",
      ok: installComplete,
      detail: installComplete
        ? "all installed panel files match the version shipped with this server"
        : `${differing.length} file(s) differ from the version shipped with this server: ${shown}${differing.length > 4 ? ", …" : ""}`,
      fix: installComplete
        ? undefined
        : olderVersion
          ? "The installed panel is an older version than these tools. Quit After Effects completely, then run setup_panel, then reopen it."
          : "Quit After Effects completely, then run setup_panel, then reopen it. Installing while AE is open can leave some files updated and others not, which is what this is — restarting alone will not fix it.",
    });
  }

  // The panel's `require('ws')` runs before it can display anything, so a
  // missing or truncated copy shows up only as silence on the port. Naming it
  // here turns "no response on port 7777" into something actionable.
  if (isInstalled) {
    const panelWs = path.join(installed, "node_modules", "ws");
    const wsOk = isWsModuleDir(panelWs);
    checks.push({
      name: "panelDependencies",
      ok: wsOk,
      detail: wsOk
        ? "the panel's `ws` module is present and complete"
        : `the panel's \`ws\` module is missing or incomplete at ${panelWs}`,
      fix: wsOk
        ? undefined
        : "Quit After Effects completely, then run setup_panel, then reopen it. Without `ws` the panel cannot finish starting, so it never answers on its port.",
    });
  }

  const running = opts.afterEffectsRunning ?? (await isAfterEffectsRunning());
  checks.push({
    name: "afterEffectsRunning",
    ok: running,
    detail: running ? "running" : "not running",
    fix: running ? undefined : "Launch After Effects. The panel starts automatically with it.",
  });

  // The socket is the authority. The port file is asked, and so is the port
  // ops are going to, but what is *reported* is which port actually answers as
  // the panel — issue #92 was a week of this check saying "responding on 7777"
  // from the port file while every op went to 7778 and was refused.
  const bridge = await probeBridge(opts.candidates, opts.opPort);
  const fromFile = portFilePort();
  const bridgeTimedOut = !bridge.answering && bridge.busy !== null;
  let bridgeDetail: string;
  if (bridge.answering) {
    bridgeDetail = `responding on port ${bridge.answering.port}`;
    if (fromFile !== null && fromFile !== bridge.answering.port) {
      bridgeDetail += ` (the port file says ${fromFile}, which is stale — the socket is the authority)`;
    }
  } else if (bridge.busy) {
    bridgeDetail = `port ${bridge.busy.port} accepted the connection but did not answer within ${BRIDGE_PROBE_MS / 1000}s — After Effects is probably busy`;
  } else {
    const ports = bridge.probed.map((p) => p.port).join(", ");
    const reasons = bridge.probed.map((p) => p.detail).join("; ");
    bridgeDetail = `no response on port${bridge.probed.length > 1 ? "s" : ""} ${ports} (${reasons})`;
  }
  checks.push({
    name: "bridgeReachable",
    ok: bridge.answering !== null,
    detail: bridgeDetail,
    fix: bridge.answering
      ? undefined
      : bridgeTimedOut
        ? BRIDGE_BUSY_FIX
        : "If the other checks pass, restart After Effects so the panel reloads.",
  });

  // Do ops and the panel agree on a port? Only the server can ask — it is the
  // one holding a port — and the answer decides between "retry" and "restart",
  // which is why it is its own check rather than a clause in the one above.
  if (opts.opPort !== undefined && (bridge.answering || bridge.busy)) {
    const opPort = opts.opPort;
    const agrees = bridge.answering !== null && bridge.answering.port === opPort;
    let detail: string;
    let fix: string | undefined;
    if (agrees) {
      detail = `tool calls go to port ${opPort} and the panel answers there`;
    } else if (bridge.answering) {
      // A pin is never walked past, so "retry" is the wrong advice there: the
      // server will keep sending to the pinned port however many times it is
      // refused. The detail carries the word so buildNextSteps can branch on it.
      const pinned = pinnedPort() === opPort;
      detail = pinned
        ? `tool calls are pinned to port ${opPort} by AE_MCP_PORT (${bridge.atOpPort?.detail ?? "not probed"}), ` +
          `but the panel is answering on port ${bridge.answering.port}`
        : `tool calls are being sent to port ${opPort} (${bridge.atOpPort?.detail ?? "not probed"}), ` +
          `but the panel is answering on port ${bridge.answering.port}`;
      fix = pinned
        ? `AE_MCP_PORT pins tool calls to port ${opPort}, and a pin is never walked past, so retrying changes nothing. ` +
          `Set AE_MCP_PORT to ${bridge.answering.port}, or unset it, then reconnect the MCP server (restart the client's connection to it). ` +
          "Do NOT restart After Effects for this: a panel is listening, and a restart would cost the user their work in progress for nothing."
        : `The server's port is stale; the panel is fine. Retry the failed call — the server re-checks the port whenever a call is refused and switches to ${bridge.answering.port} by itself. ` +
          "If it still fails, reconnect the MCP server (restart the client's connection to it) so it starts on the right port. " +
          "Do NOT restart After Effects for this: a panel is listening, and a restart would cost the user their work in progress for nothing.";
    } else {
      detail =
        `tool calls are being sent to port ${opPort} (${bridge.atOpPort?.detail ?? "not probed"}); ` +
        `port ${bridge.busy!.port} accepted a connection but is busy and could not be confirmed as the panel`;
      fix =
        `Wait for After Effects to finish what it is doing, then retry the call — once port ${bridge.busy!.port} answers, the server switches to it on the next refused call. ` +
        "Do not restart After Effects: something is listening there.";
    }
    checks.push({ name: "portAgreement", ok: agrees, detail, fix });
  }

  // A panel that answers and then refuses every call looks, to every other
  // check here, like one that is working. Pre-#106 panels send no flag.
  if (bridge.answering?.health?.auth === true) {
    const port = bridge.answering.port;
    const have = panelToken(port) !== null;
    checks.push({
      name: "bridgeToken",
      ok: have,
      detail: have
        ? `the panel's token for port ${port} is readable at ${tokenFilePath(port)}`
        : `the panel on port ${port} requires a token and none is readable at ${tokenFilePath(port)}`,
      fix: have
        ? undefined
        : `Every tool call will be refused until this is resolved, and the panel itself is fine — do not restart After Effects for it, and do not run setup_panel. ` +
          `The panel writes that file each time it binds, so either it could not (its log inside After Effects says so, under Window > Extensions) or this server is reading a different home directory than the panel wrote to, which happens when the MCP client runs it sandboxed or as another user. Ask the user to open the panel and read the path it logged at startup.`,
    });
  }

  // `panelUpToDate` above compares files on disk, which start matching the
  // instant setup_panel runs — while AE carries on running the old code until it
  // restarts. This is the check that notices that window, and it is the one that
  // predicts whether calls will actually work.
  if (bridge.answering && source) {
    const assessment = assessPanel(bridge.answering.health, installedPanelHashes(installed), {
      installComplete,
    });
    const ok = assessment.state === "current";
    checks.push({
      name: "panelRunningCurrent",
      ok,
      detail: ok
        ? "After Effects is running the panel that ships with these tools"
        : assessment.state === "partial-install"
          ? "the installed panel files are a mix of versions — a restart cannot resolve this"
          : assessment.state === "unverifiable"
            ? UNVERIFIABLE_DETAIL
          : assessment.state === "restart-needed"
            ? "After Effects is still running the previous panel — the update needs a restart to take effect"
            : assessment.state === "unknown"
              ? "these tools cannot find the panel they ship, so the running panel's version cannot be checked"
              : "After Effects is running a panel older than these tools",
      fix: ok ? undefined : assessment.message,
    });
  }

  // A live bridge with no panel at the expected path means some older build is
  // serving — most often one installed under a previous bundle id. Everything
  // works right now, but an upgrade will not reach the running panel, and the
  // two checks contradict each other unless we say so explicitly.
  if (bridge.answering && !isInstalled) {
    checks.push({
      name: "panelIdentity",
      ok: false,
      detail: `a panel is answering on port ${bridge.answering.port}, but not the one at ${installed}`,
      fix: `An older install is serving the bridge. Quit After Effects completely, then look in ${cepExtensionsDir()} for a differently named folder and remove it, then run setup_panel, then reopen After Effects.`,
    });
  }

  // The panel is installed, After Effects is up, and nothing is listening at
  // all — the shape of issue #91, where CEP refused the unsigned panel's
  // signature despite PlayerDebugMode and said so only in its own log. Read
  // that log. It is the one piece of evidence that separates "restart it" from
  // "no restart will ever help".
  if (running && isInstalled && !bridge.answering && !bridgeTimedOut) {
    const logs = cepLogPaths();
    const finding = findSignatureFailure(logs);
    if (finding) {
      // A signed panel whose files still match its signature was refused for
      // the signature itself, not for being unsigned — a different sentence,
      // and the evidence value lets nextSteps say it. Which certificate signed
      // it does not enter into it.
      checks.push(
        installedSignedIntact
          ? {
              name: "panelSignature",
              ok: false,
              evidence: "failure-logged-signed",
              detail:
                `the CEP log ${finding.file} (last written ${finding.mtime.toISOString()}) records: "${finding.line}" — ` +
                "CEP rejected the signature on this panel, although every installed file still matches it",
              fix:
                "CEP is refusing the panel's signature even though the files are exactly as signed. No reinstall and no restart changes that; " +
                "nextSteps carries the steps to sign it again on this machine with Adobe's ZXPSignCmd. Please also report it with log_issue.",
            }
          : isInstalled && isSignedPanel(installed)
            ? {
                // Signed, but the files changed since: the refusal is explained
                // by that, even with PlayerDebugMode on (the #91 machine checks
                // signatures anyway). Putting the signed files back fixes it.
                name: "panelSignature",
                ok: false,
                evidence: "failure-logged-voided",
                detail:
                  `the CEP log ${finding.file} (last written ${finding.mtime.toISOString()}) records: "${finding.line}" — ` +
                  "the installed files no longer match the signature they carry",
                fix:
                  "Quit After Effects completely, then run setup_panel with force:true to put back the panel exactly as these tools ship it, then reopen it.",
              }
          : {
              name: "panelSignature",
              ok: false,
              evidence: "failure-logged",
              detail:
                `the CEP log ${finding.file} (last written ${finding.mtime.toISOString()}) records: "${finding.line}" — ` +
                "CEP is enforcing signature verification on this panel even though PlayerDebugMode is on",
              fix:
                "CEP is refusing the unsigned panel's signature despite PlayerDebugMode — an Adobe CEP 12 bug, not a broken install. " +
                "No reinstall and no restart changes that; the panel folder has to be self-signed with Adobe's ZXPSignCmd. nextSteps carries the exact steps.",
            }
      );
    } else if (logs.length > 0) {
      const level = await cepLogLevel(CSXS_VERSIONS[0]);
      checks.push({
        name: "panelSignature",
        ok: true,
        evidence: "log-clean",
        detail:
          `no signature failure recorded in ${logs[0]}` +
          (level === null ? " (CEP LogLevel is not set, so the log may predate this launch)" : ` (CEP LogLevel ${level})`),
      });
    } else {
      checks.push({
        name: "panelSignature",
        ok: true,
        evidence: "no-log",
        detail:
          `no CEP log found in ${cepLogDir()} — CEP is not logging, so a signature refusal cannot be ruled out; ` +
          "nextSteps says how to turn the log on",
      });
    }
  }

  const ready = checks.every((c) => c.ok);
  return { ready, checks, nextSteps: buildNextSteps(checks, ready, bridgeTimedOut) };
}

/**
 * Ordered remediation, phrased so the agent can read it straight out to a user
 * who has never opened a terminal.
 */
export function buildNextSteps(checks: Check[], ready: boolean, bridgeTimedOut = false): string[] {
  if (ready) return ["Everything is connected. After Effects is ready to drive."];

  const by = (name: string) => checks.find((c) => c.name === name);
  const steps: string[] = [];

  if (by("platform")?.ok === false) return [by("platform")!.fix!];
  if (by("panelAssetsPresent")?.ok === false) return [by("panelAssetsPresent")!.fix!];

  // A panel answering on a port other than the one ops go to is not a broken
  // panel. It outranks everything below because every remedy below costs a
  // restart, and a restart is precisely the wrong move when something is
  // listening: the user loses their work in progress and the server comes
  // back on the same stale port (issue #92).
  const agreement = by("portAgreement");
  if (agreement && agreement.ok === false && by("bridgeReachable")?.ok === true && /pinned to port/.test(agreement.detail)) {
    return [
      `Do not restart After Effects — the panel is running and answering. ${agreement.detail}.`,
      "AE_MCP_PORT pins the server to that port and a pin is never walked past, so retrying will not help: set AE_MCP_PORT to the port the panel answers on, or unset it, then reconnect the MCP server — restart the client's connection to it, not After Effects.",
      "Nothing about the install is wrong; setup_panel would change nothing here.",
    ];
  }
  if (agreement && agreement.ok === false && by("bridgeReachable")?.ok === true) {
    return [
      `Do not restart After Effects — the panel is running and answering. ${agreement.detail}.`,
      "Retry the call that failed. The server re-checks the port whenever a call is refused and switches to the port that answers, so the retry normally succeeds on its own.",
      "If it still fails, reconnect the MCP server — restart the client's connection to it, not After Effects — so it starts on the right port.",
      "Nothing about the install is wrong; setup_panel would change nothing here.",
    ];
  }

  // Not a broken install either, and every remedy below costs a restart that
  // cannot fix it. After the port branches: a wrong port is the basic mistake.
  const token = by("bridgeToken");
  if (token && token.ok === false) {
    return [
      `Do not restart After Effects and do not run setup_panel — the panel is running and answering. ${token.detail}.`,
      token.fix!,
      "Until the token is readable every tool call is refused before it reaches After Effects, so nothing in the user's project is being changed or half-changed.",
    ];
  }

  // A busy panel outranks everything below: the install is fine, and every
  // remedy further down costs the user a restart they do not need. The one
  // thing that must not be said here is "restart After Effects".
  //
  // Only when nothing *else* is broken, though. A panel that is genuinely
  // half-installed still needs its own remediation, and a timeout is not
  // evidence against it — so fall through and let the normal path speak, with
  // the busy explanation still attached to the bridgeReachable check itself.
  const installSound =
    by("panelInstalled")?.ok !== false &&
    by("panelUpToDate")?.ok !== false &&
    by("panelDependencies")?.ok !== false &&
    by("panelSignatureIntact")?.ok !== false &&
    by("cepDebugMode")?.ok !== false;
  if (bridgeTimedOut && installSound) {
    const out = [
      "Wait — do not restart anything yet. The panel is answering its port but is too busy to reply, which almost always means After Effects is still running a script.",
      "Run check_setup again in about ten seconds, and keep checking for up to a minute. It usually clears on its own.",
      "While waiting, ask the user to look at After Effects: a dialog it is waiting on (unsaved project, missing fonts) blocks it the same way and may be hidden behind another window.",
      "On macOS, if they have moved to a different desktop, ask them to switch back to the one After Effects is on.",
    ];
    if (agreement && agreement.ok === false) {
      out.push(`${agreement.detail}. Once it answers, the server switches to it on the next refused call — no reconnect needed.`);
    }
    out.push("Only if it is still not answering after a minute should you treat it as disconnected and quit and reopen After Effects.");
    return out;
  }

  // CEP has said, in its own log, that it refused this panel's signature. No
  // reinstall and no restart changes that; only signing does. The steps are
  // the whole workaround, and they come before anything that says "reopen".
  //
  // Unless the installed files no longer match a signature they carry: then the
  // refusal is explained, and putting the signed files back is the fix — so
  // that case falls through to the reinstall below instead.
  const signature = by("panelSignature");
  // Voided counts as broken once CEP has said it refused the panel: the
  // PlayerDebugMode that was meant to let the voided signature through is
  // being ignored (#91), so the fix is the signed files, not a hand signing.
  const intact = by("panelSignatureIntact");
  const signatureBroken =
    intact?.ok === false || (intact?.evidence === "voided" && signature?.ok === false);
  if (signature && signature.ok === false && !signatureBroken) {
    return signatureWorkaroundSteps(installedPanelDir(), { shippedSigned: signature.evidence === "failure-logged-signed" });
  }

  // A half-updated install, a missing dependency or files that no longer match
  // their signature are not fixed by restarting; all are fixed by reinstalling,
  // and reinstalling only works with AE closed. An unverifiable running panel
  // (it could not hash its own folder) is the same: a restart re-reads the same
  // folder, so the remedy is a reinstall.
  const brokenInstall =
    by("panelUpToDate")?.ok === false ||
    by("panelDependencies")?.ok === false ||
    by("panelRunningCurrent")?.detail === UNVERIFIABLE_DETAIL ||
    signatureBroken;
  const needsInstall = by("panelInstalled")?.ok === false || brokenInstall;
  const needsDebug = by("cepDebugMode")?.ok === false;
  const aeRunning = by("afterEffectsRunning")?.ok === true;

  // Closing AE first is part of the remedy, not an afterthought: installing
  // while it holds the panel's files open is what produces a half-updated
  // install, and setup_panel refuses while it is open (issue #262). So any
  // step that runs setup_panel is preceded by "quit" and followed by "reopen",
  // in that order, never "setup_panel, then restart".
  const identityBroken = by("panelIdentity")?.ok === false;
  const willInstall = signatureBroken || needsDebug || needsInstall;
  if (willInstall && aeRunning) {
    steps.push(
      brokenInstall
        ? signatureBroken && by("panelUpToDate")?.ok !== false && by("panelDependencies")?.ok !== false
          ? "Quit After Effects completely — the panel's files have to be replaced while it is closed."
          : "Quit After Effects completely — installing while it is open can leave the panel half-updated."
        : "Quit After Effects completely — setup_panel installs only while it is closed, because After Effects holds the panel's files."
    );
  }
  if (identityBroken) {
    steps.push(
      `Look in ${cepExtensionsDir()} for a differently named AE MCP panel folder and remove it — an older install is serving the bridge.`
    );
  }
  if (signatureBroken) {
    steps.push("Run the setup_panel tool with force:true — the installed files no longer match the panel's signature, and a forced install puts back exactly what these tools ship.");
  } else if (willInstall) {
    steps.push("Run the setup_panel tool — it installs the After Effects panel and enables the Adobe preference that lets AE load it.");
  }
  if (!aeRunning) {
    // Installing before AE is open is the cheaper order: the panel is simply
    // there when it launches, with no restart to ask for.
    steps.push(needsInstall ? "Open After Effects — the panel loads with it." : "Open After Effects.");
  } else if (willInstall) {
    steps.push("Reopen After Effects — the panel loads with it.");
  } else if (by("panelRunningCurrent")?.ok === false) {
    // Restart-needed: the files on disk are already current, only the running
    // copy is old. No setup_panel — it would change nothing.
    steps.push("Quit and reopen After Effects so it picks up the panel.");
  }
  if (needsDebug && !signatureBroken) {
    steps.push(
      process.platform === "win32"
        ? "After Effects re-reads the registry when it launches, so the preference takes effect then."
        : "If the panel still does not connect after reopening, restart the Mac once — the Adobe preference sometimes only takes effect after a reboot."
    );
  }
  if (steps.length === 0 && by("bridgeReachable")?.ok === false) {
    // Everything is installed, AE is up, nothing is listening. One restart is
    // reasonable — the panel loads only at launch. A second and a third are
    // not: after the first, the likely cause is the one only the CEP log can
    // confirm (issue #91), and the advice has to move on to reading it.
    steps.push(
      "Everything is installed but the panel is not answering. If After Effects has not been restarted since the panel was installed, quit and reopen After Effects once — the panel loads only at launch."
    );
    if (signature?.evidence === "log-clean") {
      steps.push(
        `If it has already been restarted, the CEP log shows no signature refusal (${signature.detail}), so that is not the cause. ` +
          "Ask the user to open Window > Extensions > AE MCP Bridge in After Effects and read back what the panel says; if nothing opens at all, report it with log_issue."
      );
    } else {
      steps.push(
        "If it has already been restarted and still does not answer, the likely cause is CEP refusing the unsigned panel's signature even though PlayerDebugMode is on — an Adobe CEP 12 bug, seen on Windows (issue #91). Nothing about the install is wrong, and restarting again will not help."
      );
      steps.push(
        `To confirm it, turn CEP's own logging up so it records why the panel did not load: run \`${cepLogLevelCommand()}\` ` +
          `(After Effects 2026 uses CSXS.${CSXS_VERSIONS[0]}; setup_panel sets this for new installs). ` +
          "Then relaunch After Effects and run check_setup again — it reads the CEP log, and if the signature check is what is failing it reports panelSignature with the exact fix."
      );
      steps.push("Also ask the user to open Window > Extensions > AE MCP Bridge in AE: if nothing appears at all, that is the same symptom.");
    }
  }
  return steps;
}
