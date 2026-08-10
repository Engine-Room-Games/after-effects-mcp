import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { discoverPort } from "../bridge/discovery.js";
import { installedPanelDir, panelSourceDir } from "./paths.js";

const exec = promisify(execFile);

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

/** CEP major versions AE 2026 may look at, newest first. */
const CSXS_VERSIONS = [12, 11, 10, 9];

async function playerDebugMode(): Promise<{ on: boolean; detail: string }> {
  for (const v of CSXS_VERSIONS) {
    try {
      const { stdout } = await exec("defaults", ["read", `com.adobe.CSXS.${v}`, "PlayerDebugMode"]);
      if (stdout.trim() === "1") return { on: true, detail: `enabled (CSXS.${v})` };
    } catch {
      // Key absent for this version — keep looking.
    }
  }
  return { on: false, detail: "not enabled for any CSXS version" };
}

async function aeRunning(): Promise<boolean> {
  try {
    const { stdout } = await exec("pgrep", ["-f", "Adobe After Effects"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function sha256(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

async function bridgeReachable(port: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `port ${port} returned HTTP ${res.status}` };
    return { ok: true, detail: `responding on port ${port}` };
  } catch (e) {
    return { ok: false, detail: `no response on port ${port} (${(e as Error).message})` };
  }
}

export async function checkSetup(): Promise<SetupReport> {
  const checks: Check[] = [];

  const isMac = process.platform === "darwin";
  checks.push({
    name: "platform",
    ok: isMac,
    detail: process.platform,
    fix: isMac ? undefined : "This server currently supports macOS only. Windows needs a different CEP install path and a registry edit.",
  });

  const source = panelSourceDir();
  checks.push({
    name: "panelAssetsPresent",
    ok: source !== null,
    detail: source ?? "not found in this installation",
    fix: source ? undefined : "The package is missing its CEP panel assets — reinstall the server.",
  });

  const debugMode = await playerDebugMode();
  checks.push({
    name: "cepDebugMode",
    ok: debugMode.on,
    detail: debugMode.detail,
    fix: debugMode.on ? undefined : "Run the setup_panel tool. After Effects only loads unsigned panels when this Adobe preference is set.",
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

  const running = await aeRunning();
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
    steps.push("Quit and reopen After Effects. If the panel still does not connect, restart the Mac once — the Adobe preference sometimes only takes effect after a reboot.");
  }
  if (by("afterEffectsRunning")?.ok === false) {
    steps.push("Open After Effects 2026.");
  } else if (needsInstall) {
    steps.push("Quit and reopen After Effects so it picks up the panel.");
  }
  if (steps.length === 0 && by("bridgeReachable")?.ok === false) {
    steps.push("Everything is installed but the panel is not answering. Quit and reopen After Effects.");
    steps.push("If it still fails, open Window > Extensions > AE MCP Bridge in AE to see the panel's own status log.");
  }
  return steps;
}
