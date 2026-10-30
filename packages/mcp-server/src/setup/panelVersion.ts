import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { panelSourceDir } from "./paths.js";
import { panelClientHash } from "./panelHash.js";
import {
  CAP_PROJECT_PATH,
  CAP_SERVER_DRIVES_JOBS,
  CAP_SERVER_IMAGES,
  CAP_SERVER_RUN_JSX,
  missingCapabilities,
} from "./panelCapabilities.js";

/**
 * Is the panel currently running inside After Effects the one this server ships?
 *
 * The failure this prevents is specific and, before this existed, baffling: the
 * user updates the tools, does not update the panel, and the next call comes
 * back `Unknown op: get_house_style`. Nothing in that says "your panel is older
 * than your tools". An agent retries, or concludes the tool is broken.
 *
 * Two copies matter and they are not the same:
 *
 *   - the panel on disk in the CEP extension folder — what AE would load *next*
 *     time it starts
 *   - the panel AE actually loaded — what it is running *now*
 *
 * They diverge for the whole window between `setup_panel` and restarting AE,
 * which is precisely the window where things break. Only the running one is
 * worth gating on, so it is read from the panel's own /health.
 *
 * And each copy has two halves (issue #243): `bundleHash` names the
 * ExtendScript, `clientHash` names every other file of the panel. Both have
 * to match. Comparing the bundle alone let a panel with a current bundle and
 * old client code through, and since #243 the server has no older path left
 * for such a panel to fall back on.
 */

export type PanelState =
  /** The running panel matches this server. */
  | "current"
  /** Panel files have been updated but AE is still running the old code. */
  | "restart-needed"
  /** The installed panel predates this server; setup_panel then restart. */
  | "update-needed"
  /** Files on disk are a mix of versions; no restart can resolve it. */
  | "partial-install"
  /**
   * The running panel reports that it could not hash its own folder
   * (`clientHash: null`), so whether it is current cannot be known. A restart
   * would hash the same unreadable folder again, so it is never the advice.
   */
  | "unverifiable"
  /**
   * No shipped panel to compare against, and the running one lists every
   * capability this server relies on. The only state besides "current" that
   * the gate lets through.
   */
  | "unknown";

export interface PanelAssessment {
  state: PanelState;
  /** Written for the agent to act on and to relay; empty when current. */
  message: string;
}

/**
 * The two halves of "which panel is this". `bundle` names the ExtendScript
 * (`jsx/bundle.jsx`); `client` names every other shipped file — main.js and
 * its modules, index.html, the manifest (`setup/panelHash.ts`).
 */
export interface PanelHashes {
  bundle: string | null;
  client: string | null;
}

/** The fields of a panel's `/health` the assessment reads. Any of them may be missing. */
export interface RunningPanel {
  bundleHash?: unknown;
  clientHash?: unknown;
  capabilities?: unknown;
}

let cachedSource: PanelHashes | null | undefined;

/**
 * Hashes of the panel this server would install, or null when it has none to
 * compare against. Cached: it cannot change at runtime.
 */
export function sourcePanelHashes(): PanelHashes | null {
  if (cachedSource !== undefined) return cachedSource;
  const source = panelSourceDir();
  const hashes = source ? installedPanelHashes(source) : null;
  cachedSource = hashes && hashes.bundle && hashes.client ? hashes : null;
  return cachedSource;
}

/** Hash of the bundle this server would install. */
export function sourceBundleHash(): string | null {
  return sourcePanelHashes()?.bundle ?? null;
}

/** Hash of every other file of the panel this server would install. */
export function sourceClientHash(): string | null {
  return sourcePanelHashes()?.client ?? null;
}

/** Hashes of a panel folder on disk. For the CEP extension folder, that is what AE loads next launch. */
export function installedPanelHashes(dir: string): PanelHashes {
  return { bundle: hashFile(path.join(dir, "jsx", "bundle.jsx")), client: panelClientHash(dir) };
}

function hashFile(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function sameHashes(a: PanelHashes, b: PanelHashes | null | undefined): boolean {
  return !!b && !!a.bundle && !!a.client && a.bundle === b.bundle && a.client === b.client;
}

const STALE_PANEL_ADVICE =
  "Tell the user this in plain language, then do it: the After Effects panel is older than these tools and does not " +
  "understand everything they can do now. Run setup_panel, then ask them to quit and reopen After Effects. " +
  "Do not retry the failed call until they confirm it has restarted.";

/** What each capability lets the server do, in words a user would recognise. */
const CAPABILITY_WORDS: Readonly<Record<string, string>> = {
  [CAP_PROJECT_PATH]: "finding the project's folder for the house style",
  [CAP_SERVER_IMAGES]: "handing screenshots over to these tools",
  [CAP_SERVER_RUN_JSX]: "running scripts these tools prepare",
  [CAP_SERVER_DRIVES_JOBS]: "letting these tools run long batches",
};

/**
 * A long `run_batch` the panel started and is driving itself — only a panel
 * from before issue #220 does that. Such a panel reports the job's progress
 * and end over its event socket, and the server registers the job, so
 * `await_job` is a real completion signal (After Effects answering between
 * chunks is not one). The batch is real and running, so the message says so
 * before it says to update; it never claims the panel did not recognise the
 * op, which it plainly did.
 */
export function panelDrivenBatchMessage(jobId: string): string {
  return (
    `The After Effects panel started batch ${jobId} and is running it itself. It must not be sent again: it is ` +
    `still applying in After Effects, and a second copy would apply every op twice. Call ` +
    `await_job({jobId: "${jobId}"}) and wait until it reports the batch finished — that is the only sign it is ` +
    `done; After Effects answering other calls is not. If After Effects quits or restarts first, await_job ends ` +
    `it as lost and says how far it got. To stop it early, call cancel_job({jobId: "${jobId}"}). ` +
    `Only a panel older than these tools runs a batch on its ` +
    `own, so once await_job reports it finished, and never before: run setup_panel, and ask the user to quit and ` +
    `reopen After Effects.`
  );
}

const UNVERIFIABLE_ADVICE =
  "The After Effects panel is running but could not read its own files to report its version, so these tools " +
  "cannot tell whether it is current. Restarting After Effects will not change that — it reads the same folder " +
  "again. Tell the user to quit After Effects completely, then run setup_panel to reinstall the panel, then " +
  "reopen it. If this comes back after a reinstall, After Effects cannot read the panel's own folder — ask the " +
  "user to check the permissions on it.";

const PARTIAL_INSTALL_ADVICE =
  "The installed After Effects panel is a mix of two versions — some files were updated and others were not, which " +
  "happens when it is installed while After Effects is open and holding them. Restarting will not fix this. Tell the " +
  "user to quit After Effects completely, then run setup_panel, then reopen it.";

/**
 * @param running   The panel's `/health` body, or null when there is none.
 *                  `bundleHash` and `clientHash` name the code it is running;
 *                  a panel from before #243 sends no `clientHash`.
 * @param installed Hashes of the extension folder's files, when known.
 * @param opts.installComplete `false` when the files on disk are known to be a
 *   mix of versions. Defaults to `true` — callers that have not checked keep the
 *   old behaviour rather than silently claiming an install is sound.
 * @param opts.shipped The panel to compare against. Defaults to the one this
 *   server ships; tests pass their own, null included.
 */
export function assessPanel(
  running: RunningPanel | null | undefined,
  installed: PanelHashes | null,
  opts: { installComplete?: boolean; shipped?: PanelHashes | null } = {}
): PanelAssessment {
  const shipped = opts.shipped !== undefined ? opts.shipped : sourcePanelHashes();

  // No shipped panel to hash — a packaging fault, since every distribution
  // carries one. This used to pass everything, which is how a panel older than
  // the server could reach a path it does not have. Without hashes "is this the
  // current panel" has no answer, but "can it do what this server will ask of
  // it" still does: every path the server takes needs the capabilities in
  // REQUIRED_PANEL_CAPABILITIES, and since #243 there is no older path to fall
  // back on. So the list is the gate here, and a panel missing any of it is
  // told to update rather than forwarded to fail obscurely.
  if (!shipped) {
    const missing = missingCapabilities(running);
    if (missing.length === 0) {
      return {
        state: "unknown",
        message:
          "This copy of the AE MCP tools cannot find the panel it ships, so it cannot check the running panel's " +
          "version. The panel reports everything these tools rely on, so calls go ahead.",
      };
    }
    return {
      state: "update-needed",
      message:
        `The After Effects panel is out of date: it lacks support for ${missing.map((c) => CAPABILITY_WORDS[c] ?? c).join(", ")}, ` +
        "which these tools need. " +
        STALE_PANEL_ADVICE +
        " If setup_panel says it has no panel to install, these tools are installed incompletely — reinstall them first.",
    };
  }

  const r = running ?? {};
  const runningHashes: PanelHashes = {
    bundle: typeof r.bundleHash === "string" && r.bundleHash ? r.bundleHash : null,
    client: typeof r.clientHash === "string" && r.clientHash ? r.clientHash : null,
  };
  if (sameHashes(runningHashes, shipped)) return { state: "current", message: "" };

  // Checked before anything else that could recommend a restart. A half-updated
  // install can hash however it likes, and telling the user to restart for it
  // cannot possibly resolve it. That loop is not theoretical: it is what v0.2.0
  // did, three restarts running.
  //
  // But "some files differ" is not "mixed": a cleanly installed older panel
  // differs in every file that changed since, and calling that partial told
  // every 0.5.x user that they had installed with After Effects open, never
  // that their panel was out of date (live test, #243). Mixed means one half
  // of the installed panel is the shipped one and the other is not; an install
  // whose bundle and client files both differ from the shipped panel is
  // uniformly older, and gets the update message below. The file diff
  // (`installComplete`) still counts when both halves are current — a file the
  // hashes leave out did not land.
  const installedBundleCurrent = !!installed?.bundle && installed.bundle === shipped.bundle;
  const installedClientCurrent = !!installed?.client && installed.client === shipped.client;
  const mixed = installed !== null && installedBundleCurrent !== installedClientCurrent;
  const uniformlyOlder = installed !== null && !installedBundleCurrent && !installedClientCurrent;
  if (mixed || (opts.installComplete === false && !uniformlyOlder)) {
    return { state: "partial-install", message: PARTIAL_INSTALL_ADVICE };
  }

  const installedCurrent = !!installed && sameHashes(shipped, installed);

  // A panel since #243 that tried to hash its own folder and could not sends
  // `clientHash: null` (a panel from before #243 sends no key at all). Its
  // bundle may be current; its client code cannot be known. Telling the user
  // to restart would loop for ever — the restarted panel reads the same folder
  // — so the advice is the diagnosis, then a reinstall.
  if (runningHashes.bundle && "clientHash" in r && r.clientHash === null) {
    return { state: "unverifiable", message: UNVERIFIABLE_ADVICE };
  }

  if (!runningHashes.bundle || !runningHashes.client) {
    // A panel that does not report both halves predates the one it is missing,
    // and therefore this server: every panel since #243 reports both. That is a
    // certainty, not a guess, so it is enforced like any other stale verdict
    // rather than left to an `Unknown op:` later.
    if (installedCurrent) {
      return {
        state: "restart-needed",
        message:
          "The After Effects panel has been updated on disk, but After Effects is still running the previous version. " +
          "Ask the user to quit and reopen After Effects, then try again.",
      };
    }
    return {
      state: "update-needed",
      message:
        "The After Effects panel is too old to report its full version, which means it predates these tools. " +
        STALE_PANEL_ADVICE,
    };
  }

  if (installedCurrent) {
    return {
      state: "restart-needed",
      message:
        "The After Effects panel has been updated on disk, but After Effects is still running the previous version. " +
        "Ask the user to quit and reopen After Effects, then try again. Running setup_panel again will not help — " +
        "only a restart loads the new panel.",
    };
  }

  return { state: "update-needed", message: `The After Effects panel is out of date. ${STALE_PANEL_ADVICE}` };
}

/**
 * The message for an op the panel rejected as unknown.
 *
 * This is always a version mismatch, never a genuine typo: `server.ts` validates
 * the tool name against `OpSchemas` and refuses unknown ones before anything is
 * forwarded, so an op that reached the panel at all is one this server defines.
 */
export function unknownOpMessage(op: string): string {
  return (
    `The After Effects panel does not recognise "${op}". That always means the installed panel is older than these ` +
    `tools — this op did not exist when it was installed. ${STALE_PANEL_ADVICE}`
  );
}
