import fs from "node:fs";
import path from "node:path";
import {
  copyRecursive,
  installedPanelDir,
  isSupportedPlatform,
  isWsModuleDir,
  panelSourceDir,
  signedInstallPresent,
  wsModuleDir,
} from "./paths.js";
import { describeSignatureProblems, isSignedPanel, signatureIntact, signatureProblems } from "./panelSignature.js";
import { CEP_LOG_LEVEL, debugModeLocation, enableDebugMode, ensureCepLogging, isDebugModeOn } from "./platform.js";

export interface InstallResult {
  ok: boolean;
  panelPath: string;
  actions: string[];
  restartAfterEffects: boolean;
  rebootRecommended: boolean;
  notes: string[];
  /**
   * True when the install replaced a panel folder that had been self-signed
   * (issue #91). The fresh copy is unsigned, so on a machine where CEP
   * enforces signatures the signing has to be done again before AE loads it.
   */
  signedInstallOverwritten?: boolean;
  /**
   * True when the panel just installed (or left in place) is the signed one a
   * release ships (issue #182): it loads without PlayerDebugMode. False for an
   * unsigned panel — a git checkout's, or a build packed without signing.
   */
  signed: boolean;
}

/**
 * Said whenever a signed install is replaced by an unsigned one; the reader
 * needs to know before the restart, not after. Never said when the panel this
 * server ships is itself signed: the fresh copy then carries its own signature.
 */
export const SIGNED_INSTALL_OVERWRITTEN_NOTE =
  "The previous install was signed — shipped signed, or self-signed on this machine (META-INF/signatures.xml was present). " +
  "This fresh copy is NOT signed, so it loads only through PlayerDebugMode. " +
  "On a machine where CEP refuses unsigned panels despite PlayerDebugMode — the issue #91 case, seen on Windows — " +
  "After Effects will not load it until it is signed again: repeat the ZXPSignCmd steps from check_setup's " +
  "panelSignature nextSteps on the newly installed folder, then restart After Effects.";

/** The Adobe preference calls installPanel makes; replaceable in tests. */
export interface PreferenceCalls {
  isDebugModeOn: typeof isDebugModeOn;
  enableDebugMode: typeof enableDebugMode;
  ensureCepLogging: typeof ensureCepLogging;
}

/** Added to the action when PlayerDebugMode is turned on for a signed panel, which does not need it. */
export const DEBUG_MODE_FALLBACK_NOTE =
  "The panel is signed, so After Effects loads it without that preference; it is set only as a fallback, " +
  "in case CEP ever refuses the signature on this machine.";

/**
 * Install (or refresh) the CEP panel inside After Effects and turn on the
 * Adobe preference that permits unsigned extensions.
 *
 * A release ships the panel already signed (issue #182), with `ws` inside it
 * because the signature covers every file. That copy goes in **verbatim**: any
 * byte added or changed after signing — re-vendoring `ws` included — makes CEP
 * refuse it. A git checkout's panel is unsigned and gets `ws` copied in here,
 * as it always has.
 *
 * Writes to the user's Adobe CEP extensions directory and to Adobe's
 * preference domains — both are user-scoped and reversible.
 *
 * `source` and `prefs` are for tests: the panel to install instead of the one
 * this server ships, and stand-ins for the Adobe preference calls so a test
 * never writes the real ones.
 */
export async function installPanel(
  opts: { enableDebugMode?: boolean; force?: boolean; source?: string; prefs?: Partial<PreferenceCalls> } = {}
): Promise<InstallResult> {
  const actions: string[] = [];
  const notes: string[] = [];
  const prefs: PreferenceCalls = { isDebugModeOn, enableDebugMode, ensureCepLogging, ...opts.prefs };

  if (!isSupportedPlatform()) {
    throw new Error(
      `After Effects runs only on macOS and Windows, so setup_panel cannot install anything on ${process.platform}.`
    );
  }

  const source = opts.source ?? panelSourceDir();
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
  //
  // A signed panel carries its own `ws`, inside the signature, and nothing else
  // may supply it: a copy added after signing voids the signature.
  const signed = isSignedPanel(source);
  const ownWs = path.join(source, "node_modules", "ws");
  if (signed && !isWsModuleDir(ownWs)) {
    throw new Error(
      `The signed panel at ${source} does not carry a complete \`ws\` module, and adding one after signing would ` +
        "break its signature. Nothing has been changed. Reinstall the server, and please report this with how you installed it."
    );
  }
  const ws = signed ? ownWs : wsModuleDir();
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
      signed: isSignedPanel(target),
    };
  }

  // Nothing to replace (issue #163): the folder on disk already holds exactly
  // what this server would write. Re-copying it changes nothing, and saying
  // "restart After Effects" for it sends the user to restart for no reason. A
  // self-signed copy of an unsigned panel never matches (its META-INF is
  // extra), so the #91 warning path below is unaffected; `force` always replaces.
  const unchanged =
    !!existing && !existing.isSymbolicLink() && !opts.force && installMatches(source, ws, target, { verbatim: signed });

  // Decided before anything is removed: the evidence is the folder itself.
  // Replacing a signed folder with the signed panel strips nothing.
  const wasSigned = existing && !unchanged && !signed ? signedInstallPresent(target) : false;
  if (unchanged) {
    actions.push(`The panel at ${target} is already identical to the one this server ships; left it in place.`);
  } else {
    if (existing) {
      fs.rmSync(target, { recursive: true, force: true });
      actions.push(wasSigned ? "Removed the previously installed (self-signed) panel." : "Removed the previously installed panel.");
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyRecursive(source, target);
    actions.push(
      signed
        ? `Installed the signed panel to ${target}, exactly as shipped — its signature covers every file, so it loads without Adobe's debug preference.`
        : `Installed the panel to ${target}.`
    );

    // The panel's CEF process resolves modules relative to itself, so `ws` has to
    // sit inside the installed extension rather than in this package. A signed
    // panel brought its own in the copy above, and touching it would void the
    // signature.
    const dest = path.join(target, "node_modules", "ws");
    if (!signed) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      copyRecursive(ws, dest);
    }
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
    if (!signed) actions.push("Copied the `ws` module the panel needs at runtime.");

    // The copy is checked against the signature it carries, so a copy that
    // came out different — a file skipped, one written short — is reported
    // here rather than as a panel CEP silently declines to load.
    if (signed) {
      const problems = signatureProblems(target);
      if (!signatureIntact(problems)) {
        throw new Error(
          `The installed panel at ${target} no longer matches its signature` +
            (problems ? `: ${describeSignatureProblems(problems)}` : "") +
            ". After Effects would refuse to load it. Quit After Effects, run setup_panel again with force:true, " +
            "and if this repeats please report it."
        );
      }
    }
  }

  let rebootRecommended = false;
  let debugModeEnabledNow = false;
  if (opts.enableDebugMode !== false) {
    const existing = await prefs.isDebugModeOn();
    if (existing.on) {
      actions.push(`PlayerDebugMode was already enabled — ${existing.detail}.`);
    } else {
      const versions = await prefs.enableDebugMode();
      if (versions.length === 0) {
        notes.push(
          signed
            ? `Failed to set ${debugModeLocation()}. The panel is signed, so After Effects should load it without that preference.`
            : `Failed to set ${debugModeLocation()}. Without it After Effects will refuse to load this panel.`
        );
      } else if (signed) {
        // Still set for a signed panel, on purpose: the signed install has not
        // yet been seen loading on every machine, and with the flag on CEP
        // skips the check — so a refused signature degrades to how things
        // worked before, not to a panel that never loads. It is not *needed*,
        // so it asks for no restart and no reboot.
        actions.push(`Enabled PlayerDebugMode for CSXS ${versions.join(", ")}. ${DEBUG_MODE_FALLBACK_NOTE}`);
      } else {
        actions.push(`Enabled PlayerDebugMode for CSXS ${versions.join(", ")} so AE will load the unsigned panel.`);
        debugModeEnabledNow = true;
        // Only macOS has the "preference cached until reboot" behaviour; on
        // Windows AE re-reads the registry on launch.
        rebootRecommended = process.platform === "darwin";
      }
    }
  }

  // CEP's own log is the only place a refusal to load the panel is ever
  // written (issue #91), and it is written only when LogLevel is set. Turning it
  // on now, while everything works, is what lets check_setup diagnose the day
  // it does not. Same opt-out as the debug flag: both are Adobe preferences.
  if (opts.enableDebugMode !== false) {
    const logging = await prefs.ensureCepLogging();
    if (logging.set.length > 0) {
      actions.push(
        `Set CEP's LogLevel to ${CEP_LOG_LEVEL} for CSXS ${logging.set.join(", ")} so that, if After Effects ever refuses to load the panel, its CEP log says why.`
      );
    }
  }

  if (wasSigned) notes.push(SIGNED_INSTALL_OVERWRITTEN_NOTE);
  // A restart loads what changed on disk or in Adobe's preferences. When
  // neither did, this call gives no reason for one — but the disk is not what
  // After Effects is running, so an EARLIER install may still be waiting for
  // its restart; check_setup compares against the running panel and says so.
  const restartAfterEffects = !unchanged || debugModeEnabledNow;
  if (!restartAfterEffects) {
    notes.push(
      "Nothing this call does needs After Effects restarted: the installed panel was already this version. " +
        "If check_setup still reports the running panel as out of date, an earlier install has not been loaded " +
        "yet, and quitting and reopening After Effects is what loads it."
    );
  }
  if (rebootRecommended) {
    notes.push("PlayerDebugMode was just turned on. Quit and reopen After Effects; if the panel still does not connect, restart the Mac once — on some macOS builds the preference only applies after a reboot.");
  }

  return {
    ok: true,
    panelPath: target,
    actions,
    restartAfterEffects,
    rebootRecommended,
    notes,
    signedInstallOverwritten: wasSigned || undefined,
    signed,
  };
}

/**
 * Whether `target` holds exactly what an install would write there: every file
 * of `source`, with `node_modules/ws` taken from `ws`, byte for byte, and
 * nothing else. Any difference — an extra file, a missing one, a symlink where
 * a file should be — means "replace", which is always the safe answer.
 *
 * `verbatim` is the signed panel's rule: the install is `source` itself, its own
 * `ws` and signature included, with nothing substituted.
 */
export function installMatches(source: string, ws: string, target: string, opts: { verbatim?: boolean } = {}): boolean {
  const WS = path.join("node_modules", "ws");
  const expected = new Map<string, string>();
  for (const rel of listFiles(source)) {
    if (!opts.verbatim && (rel === WS || rel.startsWith(WS + path.sep))) continue;
    expected.set(rel, path.join(source, rel));
  }
  if (!opts.verbatim) for (const rel of listFiles(ws)) expected.set(path.join(WS, rel), path.join(ws, rel));
  let actual: string[];
  try {
    actual = listFiles(target);
  } catch {
    return false;
  }
  if (actual.length !== expected.size) return false;
  for (const rel of actual) {
    const from = expected.get(rel);
    if (!from) return false;
    try {
      const a = fs.lstatSync(path.join(target, rel));
      const b = fs.lstatSync(from);
      if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
      if (!fs.readFileSync(path.join(target, rel)).equals(fs.readFileSync(from))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Relative paths of every non-directory entry under `root`, symlinks included (and never followed). */
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}
