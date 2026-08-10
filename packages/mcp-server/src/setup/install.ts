import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { copyRecursive, installedPanelDir, panelSourceDir, wsModuleDir } from "./paths.js";

const exec = promisify(execFile);

const CSXS_VERSIONS = [12, 11, 10, 9];

export interface InstallResult {
  ok: boolean;
  panelPath: string;
  actions: string[];
  restartAfterEffects: boolean;
  rebootRecommended: boolean;
  notes: string[];
}

async function isDebugModeOn(): Promise<boolean> {
  for (const v of CSXS_VERSIONS) {
    try {
      const { stdout } = await exec("defaults", ["read", `com.adobe.CSXS.${v}`, "PlayerDebugMode"]);
      if (stdout.trim() === "1") return true;
    } catch {
      // Not set for this version.
    }
  }
  return false;
}

async function enableDebugMode(): Promise<number[]> {
  const enabled: number[] = [];
  for (const v of CSXS_VERSIONS) {
    try {
      await exec("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
      enabled.push(v);
    } catch {
      // Some CSXS versions are simply absent on this machine.
    }
  }
  return enabled;
}

/**
 * Install (or refresh) the CEP panel inside After Effects and turn on the
 * Adobe preference that permits unsigned extensions.
 *
 * Writes to the user's Adobe CEP extensions directory and to Adobe's
 * preference domains — both are user-scoped and reversible.
 */
export async function installPanel(opts: { enableDebugMode?: boolean; force?: boolean } = {}): Promise<InstallResult> {
  const actions: string[] = [];
  const notes: string[] = [];

  if (process.platform !== "darwin") {
    throw new Error("setup_panel supports macOS only. On Windows the CEP extensions folder and the PlayerDebugMode registry key differ; install manually.");
  }

  const source = panelSourceDir();
  if (!source) {
    throw new Error("Could not find the CEP panel assets that ship with this server. Reinstall the package.");
  }
  if (!fs.existsSync(path.join(source, "jsx", "bundle.jsx"))) {
    throw new Error(`The panel at ${source} has no jsx/bundle.jsx. In a git checkout, run \`npm run build:jsx\` first.`);
  }

  const target = installedPanelDir();

  // A symlinked install is somebody's live dev setup; replacing it with a copy
  // would silently detach their edits from the running panel.
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && !opts.force) {
    const linkTarget = fs.readlinkSync(target);
    return {
      ok: true,
      panelPath: target,
      actions: [],
      restartAfterEffects: false,
      rebootRecommended: false,
      notes: [
        `Left the existing symlinked panel alone (it points at ${linkTarget}).`,
        "That is a development install, so it already tracks its source. Pass force:true to replace it with a copy.",
      ],
    };
  }

  if (existing) {
    fs.rmSync(target, { recursive: true, force: true });
    actions.push("Removed the previously installed panel.");
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyRecursive(source, target);
  actions.push(`Installed the panel to ${target}.`);

  // The panel's CEF process resolves modules relative to itself, so `ws` has to
  // sit inside the installed extension rather than in this package.
  const ws = wsModuleDir();
  if (ws) {
    const dest = path.join(target, "node_modules", "ws");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    copyRecursive(ws, dest);
    actions.push("Copied the `ws` module the panel needs at runtime.");
  } else {
    notes.push("Could not locate the `ws` module — the panel's WebSocket events may not work. Reinstall the package if progress notifications fail.");
  }

  let rebootRecommended = false;
  if (opts.enableDebugMode !== false) {
    const wasOn = await isDebugModeOn();
    if (wasOn) {
      actions.push("Adobe's PlayerDebugMode preference was already enabled.");
    } else {
      const versions = await enableDebugMode();
      if (versions.length === 0) {
        notes.push("Failed to set PlayerDebugMode. Without it After Effects will refuse to load this panel.");
      } else {
        actions.push(`Enabled PlayerDebugMode for CSXS ${versions.join(", ")} so AE will load the unsigned panel.`);
        rebootRecommended = true;
      }
    }
  }

  if (rebootRecommended) {
    notes.push("PlayerDebugMode was just turned on. Quit and reopen After Effects; if the panel still does not connect, restart the Mac once — on some macOS builds the preference only applies after a reboot.");
  }

  return {
    ok: true,
    panelPath: target,
    actions,
    restartAfterEffects: true,
    rebootRecommended,
    notes,
  };
}
