import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { panelSourceDir } from "./paths.js";

/**
 * Is the panel currently running inside After Effects the one this server ships?
 *
 * The failure this prevents is specific and, before this existed, baffling: the
 * user updates the tools, does not update the panel, and the next call comes
 * back `Unknown op: get_house_style`. Nothing in that says "your panel is older
 * than your tools". An agent retries, or concludes the tool is broken.
 *
 * Two hashes matter and they are not the same:
 *
 *   - the bundle on disk in the CEP extension folder — what AE would load *next*
 *     time it starts
 *   - the bundle the panel actually evaluated — what it is running *now*
 *
 * They diverge for the whole window between `setup_panel` and restarting AE,
 * which is precisely the window where things break. Only the running one is
 * worth gating on, so it is read from the panel's own /health.
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
  /** A panel too old to report its hash, or no source to compare against. */
  | "unknown";

export interface PanelAssessment {
  state: PanelState;
  /** Written for the agent to act on and to relay; empty when current. */
  message: string;
}

let cachedSourceHash: string | null | undefined;

/** Hash of the bundle this server would install. Cached: it cannot change at runtime. */
export function sourceBundleHash(): string | null {
  if (cachedSourceHash !== undefined) return cachedSourceHash;
  const source = panelSourceDir();
  cachedSourceHash = source ? hashFile(path.join(source, "jsx", "bundle.jsx")) : null;
  return cachedSourceHash;
}

/** Hash of the bundle sitting in the CEP extension folder, i.e. what AE loads next launch. */
export function installedBundleHash(installedPanel: string): string | null {
  return hashFile(path.join(installedPanel, "jsx", "bundle.jsx"));
}

function hashFile(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

const STALE_PANEL_ADVICE =
  "Tell the user this in plain language, then do it: the After Effects panel is older than these tools and does not " +
  "understand everything they can do now. Run setup_panel, then ask them to quit and reopen After Effects. " +
  "Do not retry the failed call until they confirm it has restarted.";

const PARTIAL_INSTALL_ADVICE =
  "The installed After Effects panel is a mix of two versions — some files were updated and others were not, which " +
  "happens when it is installed while After Effects is open and holding them. Restarting will not fix this. Tell the " +
  "user to quit After Effects completely, then run setup_panel, then reopen it.";

/**
 * @param runningHash  `bundleHash` from the panel's /health, or null/undefined
 *                     from a panel too old to report one.
 * @param installedHash Hash of the extension folder's bundle, when known.
 * @param opts.installComplete `false` when the files on disk are known to be a
 *   mix of versions. Defaults to `true` — callers that have not checked keep the
 *   old behaviour rather than silently claiming an install is sound.
 */
export function assessPanel(
  runningHash: string | null | undefined,
  installedHash: string | null,
  opts: { installComplete?: boolean } = {}
): PanelAssessment {
  const shipped = sourceBundleHash();
  if (!shipped) return { state: "unknown", message: "" };

  if (runningHash === shipped) return { state: "current", message: "" };

  // Checked before anything else that could recommend a restart. Every branch
  // below reasons from bundle.jsx alone, and bundle.jsx being current says
  // nothing about the client files beside it — so a half-updated install would
  // otherwise be told to restart, which cannot possibly resolve it. That loop is
  // not theoretical: it is what v0.2.0 did, three restarts running.
  if (opts.installComplete === false) {
    return { state: "partial-install", message: PARTIAL_INSTALL_ADVICE };
  }

  if (typeof runningHash !== "string" || runningHash.length === 0) {
    // Panels from before /health reported a hash. That alone means it predates
    // this server, but say so cautiously — the disk copy is the only evidence.
    if (installedHash === shipped) {
      return {
        state: "restart-needed",
        message:
          "The After Effects panel has been updated on disk, but After Effects is still running the previous version. " +
          "Ask the user to quit and reopen After Effects, then try again.",
      };
    }
    return {
      state: "unknown",
      message:
        "The After Effects panel is too old to report its version, which means it predates these tools. " +
        STALE_PANEL_ADVICE,
    };
  }

  if (installedHash === shipped) {
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
