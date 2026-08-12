import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverPort } from "../bridge/discovery.js";
import { cepExtensionsDir, installedPanelDir, isSupportedPlatform, panelSourceDir } from "./paths.js";
import { assessPanel } from "./panelVersion.js";
import { debugModeLocation, isAfterEffectsRunning, isDebugModeOn } from "./platform.js";

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
): Promise<{ ok: boolean; detail: string; bundleHash?: string | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `port ${port} returned HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { bundleHash?: string | null };
    return { ok: true, detail: `responding on port ${port}`, bundleHash: body.bundleHash };
  } catch (e) {
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

  // A stale bundle.jsx is the usual cause of "the tool exists but errors in AE"
  // after upgrading the server, so compare against the shipped copy.
  if (isInstalled && source) {
    const installedHash = sha256(path.join(installed, "jsx", "bundle.jsx"));
    const sourceHash = sha256(path.join(source, "jsx", "bundle.jsx"));
    const upToDate = installedHash !== null && installedHash === sourceHash;
    checks.push({
      name: "panelUpToDate",
      ok: upToDate,
      detail: upToDate ? "installed panel matches this server version" : "installed panel differs from the version shipped with this server",
      fix: upToDate ? undefined : "Run setup_panel to refresh it, then restart After Effects.",
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
    fix: bridge.ok ? undefined : "If the other checks pass, restart After Effects so the panel reloads.",
  });

  // `panelUpToDate` above compares files on disk, which start matching the
  // instant setup_panel runs — while AE carries on running the old code until it
  // restarts. This is the check that notices that window, and it is the one that
  // predicts whether calls will actually work.
  if (bridge.ok && source) {
    const assessment = assessPanel(bridge.bundleHash, sha256(path.join(installed, "jsx", "bundle.jsx")));
    const ok = assessment.state === "current";
    checks.push({
      name: "panelRunningCurrent",
      ok,
      detail: ok
        ? "After Effects is running the panel that ships with these tools"
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
  return { ready, checks, nextSteps: buildNextSteps(checks, ready) };
}

/**
 * Ordered remediation, phrased so the agent can read it straight out to a user
 * who has never opened a terminal.
 */
function buildNextSteps(checks: Check[], ready: boolean): string[] {
  if (ready) return ["Everything is connected. After Effects is ready to drive."];

  const by = (name: string) => checks.find((c) => c.name === name);
  const steps: string[] = [];

  if (by("platform")?.ok === false) return [by("platform")!.fix!];
  if (by("panelAssetsPresent")?.ok === false) return [by("panelAssetsPresent")!.fix!];

  const needsInstall = by("panelInstalled")?.ok === false || by("panelUpToDate")?.ok === false;
  const needsDebug = by("cepDebugMode")?.ok === false;

  if (needsDebug || needsInstall) {
    steps.push("Run the setup_panel tool — it installs the After Effects panel and enables the Adobe preference that lets AE load it.");
  }
  if (needsDebug) {
    steps.push(
      process.platform === "win32"
        ? "Quit and reopen After Effects so it re-reads the registry."
        : "Quit and reopen After Effects. If the panel still does not connect, restart the Mac once — the Adobe preference sometimes only takes effect after a reboot."
    );
  }
  const identity = by("panelIdentity");
  if (identity && identity.ok === false) {
    steps.push(identity.fix!);
  }
  if (by("afterEffectsRunning")?.ok === false) {
    // Installing before AE is open is the cheaper order: the panel is simply
    // there when it launches, with no restart to ask for.
    steps.push(needsInstall ? "Open After Effects 2026 — the panel loads with it." : "Open After Effects 2026.");
  } else if (needsInstall || by("panelRunningCurrent")?.ok === false) {
    steps.push("Quit and reopen After Effects so it picks up the panel.");
  }
  if (steps.length === 0 && by("bridgeReachable")?.ok === false) {
    steps.push("Everything is installed but the panel is not answering. Quit and reopen After Effects.");
    steps.push("If it still fails, open Window > Extensions > AE MCP Bridge in AE to see the panel's own status log.");
  }
  return steps;
}
