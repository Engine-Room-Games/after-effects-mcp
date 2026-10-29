import type { HttpClient } from "./httpClient.js";
import { BridgeUnreachableError } from "../util/errors.js";
import { assessPanel, installedBundleHash, type PanelAssessment } from "../setup/panelVersion.js";
import { installedPanelDir, panelInstallDiff, panelSourceDir } from "../setup/paths.js";
import { logger } from "../util/logger.js";

/** How often a healthy verdict is re-checked. */
export const HEALTHY_RECHECK_MS = 60_000;
/**
 * How often a stale verdict is re-checked. Short, because the only thing that
 * ends a stale state is the user restarting After Effects, and from then on
 * every call quoting the old verdict is telling them to do what they just did.
 */
export const STALE_RECHECK_MS = 5_000;

type Health = Awaited<ReturnType<HttpClient["health"]>>;

export interface PanelGateBridge {
  health(): Promise<Health>;
  onPortChange(listener: () => void): void;
}

export interface PanelGateOptions {
  /** Decides the verdict from a /health answer. Defaults to the on-disk comparison. */
  assess?: (health: Health) => PanelAssessment;
  now?: () => number;
}

/** The real assessment: the running hash against what is installed on disk. */
function assessFromDisk(health: Health): PanelAssessment {
  // The gate is what every failed call quotes, so it has to know whether the
  // files on disk are internally consistent. Without this it tells the user to
  // restart After Effects for a half-updated install, which no number of
  // restarts can resolve.
  const installed = installedPanelDir();
  const source = panelSourceDir();
  return assessPanel(health.bundleHash, installedBundleHash(installed), {
    installComplete: source ? panelInstallDiff(source, installed).length === 0 : undefined,
  });
}

/**
 * Caches the panel-version verdict so it costs about one /health per session
 * rather than one per tool call.
 *
 * A healthy verdict is re-checked every minute, so a panel replaced mid-session
 * is noticed. A *stale* verdict is re-checked every few seconds (issue #156): it
 * used to be remembered forever on the theory that restarting After Effects
 * drops the bridge and clears the cache — but AE rebinds the same port, so no
 * port change fires, and every call kept saying "restart After Effects" after
 * the user had. `invalidate()` is also wired to the event socket reopening,
 * which is what a restart looks like from here.
 *
 * An unreachable bridge caches nothing and drops a stale verdict: the panel the
 * verdict was about is not answering, and "cannot reach After Effects" is
 * `runOp`'s error to report, with a much better message than this. A *timeout*
 * keeps the stale verdict — a busy After Effects is still running the old code.
 */
export function createPanelGate(bridge: PanelGateBridge, opts: PanelGateOptions = {}) {
  const assess = opts.assess ?? assessFromDisk;
  const now = opts.now ?? Date.now;
  let verdict: string | null = null;
  let checkedAt = 0;
  let checkedOnce = false;

  const invalidate = () => {
    verdict = null;
    checkedAt = 0;
    checkedOnce = false;
  };

  // A verdict is about the panel on one port. When the bridge moves, whatever
  // was decided about the old one — stale or healthy — says nothing about the
  // panel now answering, so the next call has to ask again.
  bridge.onPortChange(invalidate);

  return {
    /** The message to return instead of forwarding, or null to proceed. */
    async check(): Promise<string | null> {
      const interval = verdict !== null ? STALE_RECHECK_MS : HEALTHY_RECHECK_MS;
      if (checkedOnce && now() - checkedAt < interval) return verdict;
      try {
        const health = await bridge.health();
        const assessment = assess(health);
        checkedAt = now();
        checkedOnce = true;
        verdict = assessment.state === "current" || assessment.state === "unknown" ? null : assessment.message;
        // "unknown" covers a panel too old to report a hash. Its message is a
        // warning rather than a certainty, so it is logged, not enforced — the
        // Unknown-op backstop catches it the moment it actually matters.
        if (assessment.state === "unknown" && assessment.message) logger.warn(assessment.message);
        return verdict;
      } catch (e) {
        if (e instanceof BridgeUnreachableError) {
          invalidate();
          return null;
        }
        // Timed out (After Effects busy) or answered oddly: whatever was known
        // before still stands, and the next call asks again.
        return verdict;
      }
    },
    invalidate,
  };
}
