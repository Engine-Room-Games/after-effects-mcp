import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverPort } from "../bridge/discovery.js";
import {
  cepExtensionsDir,
  installedPanelDir,
  isSupportedPlatform,
  isWsModuleDir,
  panelInstallDiff,
  panelSourceDir,
} from "./paths.js";
import { assessPanel } from "./panelVersion.js";
import { debugModeLocation, isAfterEffectsRunning, isDebugModeOn } from "./platform.js";
import { isTimeoutError } from "../util/errors.js";

/** Matches the probe timeout below; quoted at the user in two places. */
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
}

export interface SetupReport {
  ready: boolean;
  checks: Check[];
  nextSteps: string[];
}

function sha256(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

async function bridgeReachable(
  port: number
): Promise<{ ok: boolean; detail: string; bundleHash?: string | null; timedOut?: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(BRIDGE_PROBE_MS),
    });
    if (!res.ok) return { ok: false, detail: `port ${port} returned HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { bundleHash?: string | null };
    return { ok: true, detail: `responding on port ${port}`, bundleHash: body.bundleHash };
  } catch (e) {
    // A timeout and a refused connection are opposite diagnoses: one means the
    // panel is busy and will come back, the other means nothing is listening.
    // Reporting both as "no response" is what sends people restarting a bridge
    // that was only blocked behind a long script (issue #26).
    if (isTimeoutError(e)) {
      return {
        ok: false,
        timedOut: true,
        detail: `port ${port} accepted the connection but did not answer within ${BRIDGE_PROBE_MS / 1000}s — After Effects is probably busy`,
      };
    }
    return { ok: false, detail: `no response on port ${port} (${(e as Error).message})` };
  }
}

export async function checkSetup(): Promise<SetupReport> {
  const checks: Check[] = [];

  const supported = isSupportedPlatform();
  checks.push({
    name: "platform",
    ok: supported,
    detail: process.platform,
    fix: supported ? undefined : "After Effects runs only on macOS and Windows, so this server supports only those two.",
  });

  const source = panelSourceDir();
  checks.push({
    name: "panelAssetsPresent",
    ok: source !== null,
    detail: source ?? "not found in this installation",
    fix: source ? undefined : "The package is missing its CEP panel assets — reinstall the server.",
  });

  const debugMode = await isDebugModeOn();
  checks.push({
    name: "cepDebugMode",
    ok: debugMode.on,
    detail: debugMode.detail,
    fix: debugMode.on
      ? undefined
      : `Run the setup_panel tool. After Effects only loads unsigned panels when ${debugModeLocation()} is set.`,
  });

  const installed = installedPanelDir();
  const isInstalled = fs.existsSync(path.join(installed, "CSXS", "manifest.xml"));
  checks.push({
    name: "panelInstalled",
    ok: isInstalled,
    detail: isInstalled ? installed : `not present at ${installed}`,
    fix: isInstalled ? undefined : "Run the setup_panel tool to install it.",
  });

  // Every shipped file, not just bundle.jsx. Checking the bundle alone passed a
  // half-updated install as current, which sent the user round a restart loop
  // that could not terminate — the client files were still the old version and
  // no restart was ever going to change that.
  let installComplete = true;
  if (isInstalled && source) {
    const differing = panelInstallDiff(source, installed);
    installComplete = differing.length === 0;
    const shown = differing.slice(0, 4).join(", ");
    checks.push({
      name: "panelUpToDate",
      ok: installComplete,
      detail: installComplete
        ? "all installed panel files match the version shipped with this server"
        : `${differing.length} file(s) differ from the version shipped with this server: ${shown}${differing.length > 4 ? ", …" : ""}`,
      fix: installComplete
        ? undefined
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

  const running = await isAfterEffectsRunning();
  checks.push({
    name: "afterEffectsRunning",
    ok: running,
    detail: running ? "running" : "not running",
    fix: running ? undefined : "Launch After Effects. The panel starts automatically with it.",
  });

  const port = discoverPort();
  const bridge = await bridgeReachable(port);
  checks.push({
    name: "bridgeReachable",
    ok: bridge.ok,
    detail: bridge.detail,
    fix: bridge.ok
      ? undefined
      : bridge.timedOut
        ? BRIDGE_BUSY_FIX
        : "If the other checks pass, restart After Effects so the panel reloads.",
  });

  // `panelUpToDate` above compares files on disk, which start matching the
  // instant setup_panel runs — while AE carries on running the old code until it
  // restarts. This is the check that notices that window, and it is the one that
  // predicts whether calls will actually work.
  if (bridge.ok && source) {
    const assessment = assessPanel(bridge.bundleHash, sha256(path.join(installed, "jsx", "bundle.jsx")), {
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
          : assessment.state === "restart-needed"
            ? "After Effects is still running the previous panel — the update needs a restart to take effect"
            : assessment.state === "unknown"
              ? "the running panel is too old to report its version"
              : "After Effects is running a panel older than these tools",
      fix: ok ? undefined : assessment.message,
    });
  }

  // A live bridge with no panel at the expected path means some older build is
  // serving — most often one installed under a previous bundle id. Everything
  // works right now, but an upgrade will not reach the running panel, and the
  // two checks contradict each other unless we say so explicitly.
  if (bridge.ok && !isInstalled) {
    checks.push({
      name: "panelIdentity",
      ok: false,
      detail: `a panel is answering on port ${port}, but not the one at ${installed}`,
      fix: `An older install is serving the bridge. Look in ${cepExtensionsDir()} for a differently named folder, remove it, then run setup_panel and restart After Effects.`,
    });
  }

  const ready = checks.every((c) => c.ok);
  return { ready, checks, nextSteps: buildNextSteps(checks, ready, bridge.timedOut === true) };
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
    by("cepDebugMode")?.ok !== false;
  if (bridgeTimedOut && installSound) {
    return [
      "Wait — do not restart anything yet. The panel is answering its port but is too busy to reply, which almost always means After Effects is still running a script.",
      "Run check_setup again in about ten seconds, and keep checking for up to a minute. It usually clears on its own.",
      "While waiting, ask the user to look at After Effects: a dialog it is waiting on (unsaved project, missing fonts) blocks it the same way and may be hidden behind another window.",
      "On macOS, if they have moved to a different desktop, ask them to switch back to the one After Effects is on.",
      "Only if it is still not answering after a minute should you treat it as disconnected and quit and reopen After Effects.",
    ];
  }

  // A half-updated install or a missing dependency is not fixed by restarting;
  // both are fixed by reinstalling, and reinstalling only works with AE closed.
  const brokenInstall = by("panelUpToDate")?.ok === false || by("panelDependencies")?.ok === false;
  const needsInstall = by("panelInstalled")?.ok === false || brokenInstall;
  const needsDebug = by("cepDebugMode")?.ok === false;
  const aeRunning = by("afterEffectsRunning")?.ok === true;

  // Closing AE first is part of the remedy, not an afterthought: installing
  // while it holds the panel's files open is what produces this state.
  if (brokenInstall && aeRunning) {
    steps.push("Quit After Effects completely — installing while it is open is what leaves the panel half-updated.");
  }
  if (needsDebug || needsInstall) {
    steps.push("Run the setup_panel tool — it installs the After Effects panel and enables the Adobe preference that lets AE load it.");
  }
  const identity = by("panelIdentity");
  if (identity && identity.ok === false) {
    steps.push(identity.fix!);
  }
  if (!aeRunning) {
    // Installing before AE is open is the cheaper order: the panel is simply
    // there when it launches, with no restart to ask for.
    steps.push(needsInstall ? "Open After Effects 2026 — the panel loads with it." : "Open After Effects 2026.");
  } else if (needsInstall || by("panelRunningCurrent")?.ok === false) {
    steps.push(brokenInstall ? "Reopen After Effects." : "Quit and reopen After Effects so it picks up the panel.");
  }
  if (needsDebug) {
    steps.push(
      process.platform === "win32"
        ? "After Effects re-reads the registry when it launches, so the preference takes effect then."
        : "If the panel still does not connect after reopening, restart the Mac once — the Adobe preference sometimes only takes effect after a reboot."
    );
  }
  if (steps.length === 0 && by("bridgeReachable")?.ok === false) {
    steps.push("Everything is installed but the panel is not answering. Quit and reopen After Effects.");
    steps.push("If it still fails, open Window > Extensions > AE MCP Bridge in AE to see the panel's own status log.");
  }
  return steps;
}
