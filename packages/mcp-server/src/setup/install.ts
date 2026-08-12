import fs from "node:fs";
import path from "node:path";
import {
  copyRecursive,
  installedPanelDir,
  isSupportedPlatform,
  isWsModuleDir,
  panelSourceDir,
  wsModuleDir,
} from "./paths.js";
import { debugModeLocation, enableDebugMode, isDebugModeOn } from "./platform.js";

export interface InstallResult {
  ok: boolean;
  panelPath: string;
  actions: string[];
  restartAfterEffects: boolean;
  rebootRecommended: boolean;
  notes: string[];
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

  if (!isSupportedPlatform()) {
    throw new Error(
      `After Effects runs only on macOS and Windows, so setup_panel cannot install anything on ${process.platform}.`
    );
  }

  const source = panelSourceDir();
  if (!source) {
    throw new Error("Could not find the CEP panel assets that ship with this server. Reinstall the package.");
  }
  if (!fs.existsSync(path.join(source, "jsx", "bundle.jsx"))) {
    throw new Error(`The panel at ${source} has no jsx/bundle.jsx. In a git checkout, run \`npm run build:jsx\` first.`);
  }

  // Resolved before anything is removed. The panel cannot finish starting
  // without `ws`, so an install that cannot supply it must fail while the
  // previous, working install is still on disk — v0.2.0 deleted a good copy and
  // then replaced it with an empty directory, leaving the panel permanently
  // stuck at "starting…".
  const ws = wsModuleDir();
  if (!ws) {
    throw new Error(
      "Could not find the `ws` module this server ships. The After Effects panel cannot start without it, so " +
        "nothing has been changed. Reinstall the server, and please report this with your platform and how you " +
        "installed it."
    );
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
  const dest = path.join(target, "node_modules", "ws");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  copyRecursive(ws, dest);
  // Confirmed rather than assumed. A panel whose `require('ws')` fails hangs at
  // "starting…" and never binds its port, which surfaces only as "no response
  // on port 7777" — so reporting this step as done without checking it turns a
  // precise fault into an unrecognisable one.
  if (!isWsModuleDir(dest)) {
    throw new Error(
      `Copying \`ws\` from ${ws} to ${dest} did not produce a usable copy. The panel cannot start without it. ` +
        "The panel files are installed but the extension is not yet working — please report this."
    );
  }
  actions.push("Copied the `ws` module the panel needs at runtime.");

  let rebootRecommended = false;
  if (opts.enableDebugMode !== false) {
    const existing = await isDebugModeOn();
    if (existing.on) {
      actions.push(`PlayerDebugMode was already enabled — ${existing.detail}.`);
    } else {
      const versions = await enableDebugMode();
      if (versions.length === 0) {
        notes.push(`Failed to set ${debugModeLocation()}. Without it After Effects will refuse to load this panel.`);
      } else {
        actions.push(`Enabled PlayerDebugMode for CSXS ${versions.join(", ")} so AE will load the unsigned panel.`);
        // Only macOS has the "preference cached until reboot" behaviour; on
        // Windows AE re-reads the registry on launch.
        rebootRecommended = process.platform === "darwin";
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
