import { isTerminal, type JobManager } from "./manager.js";
import { logger } from "../util/logger.js";

/**
 * The safety net for one case only (issue #243): a panel older than #220 that
 * got past the version gate and drives its own `run_batch`. Such a panel
 * reports progress and the end over `/events`, so the server follows the job
 * there and `await_job` is the agent's completion signal.
 *
 * What it must never do is wait for ever. If the end event can no longer
 * arrive — the socket closed and did not come back within a short grace (After
 * Effects quit or is unreachable), the panel answering after a reconnect is a
 * different instance (After Effects restarted, so the job is gone), or nothing
 * at all has been heard for a long while (an event was missed) — the job ends
 * as lost: how far it was last seen, that it may have partly applied, not to
 * re-send it, and that the panel can now be updated.
 *
 * Every other batch is driven by the server (jobs/batchDriver.ts) and never
 * comes here.
 */

export interface FollowedJobsOptions {
  /** How long a closed event socket may stay closed before the job is lost. */
  graceMs?: number;
  /** How long a job may go without any event before it is lost. */
  silenceMs?: number;
  /** Identifies the running panel (its session token), or null when unknown. */
  instance: () => string | null;
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const FOLLOW_GRACE_MS = 15_000;
export const FOLLOW_SILENCE_MS = 5 * 60_000;

interface Followed {
  instance: string | null;
  silence: NodeJS.Timeout;
  ended?: NodeJS.Timeout;
  unbind: () => void;
}

export class FollowedJobs {
  private followed = new Map<string, Followed>();
  private grace: NodeJS.Timeout | null = null;
  private readonly graceMs: number;
  private readonly silenceMs: number;

  constructor(private jobs: JobManager, private opts: FollowedJobsOptions) {
    this.graceMs = opts.graceMs ?? envMs("AE_MCP_FOLLOW_GRACE_MS", FOLLOW_GRACE_MS);
    this.silenceMs = opts.silenceMs ?? envMs("AE_MCP_FOLLOW_SILENCE_MS", FOLLOW_SILENCE_MS);
  }

  /** Follow a registered job until it ends, one way or another. */
  follow(jobId: string): void {
    const silenceTimer = () => {
      const t = setTimeout(
        () =>
          this.lose(
            jobId,
            `the panel has reported nothing about it for ${Math.max(1, Math.round(this.silenceMs / 1000))}s, so its end was missed or it stopped`
          ),
        this.silenceMs
      );
      t.unref?.();
      return t;
    };
    const f: Followed = {
      instance: this.opts.instance(),
      silence: silenceTimer(),
      unbind: () => {},
    };
    // Every progress event proves the panel is still reporting.
    f.unbind = this.jobs.bindProgressEmitter(jobId, () => {
      clearTimeout(f.silence);
      f.silence = silenceTimer();
    });
    this.followed.set(jobId, f);
    // However it ends — complete, failed, cancelled, lost — stop following.
    // A poll, not a waiter: unref'd, so a closing server is never held open
    // by a job it can no longer hear about (#163).
    f.ended = setInterval(() => {
      const s = this.jobs.get(jobId);
      if (!s || isTerminal(s.status)) this.drop(jobId);
    }, 250);
    f.ended.unref?.();
  }

  /** Stop following everything, without ending any job. For a closing server. */
  stopAll(): void {
    for (const id of [...this.followed.keys()]) this.drop(id);
  }

  /** The event socket closed. Lose every followed job unless it reopens in time. */
  socketClosed(): void {
    if (this.followed.size === 0 || this.grace) return;
    this.grace = setTimeout(() => {
      this.grace = null;
      for (const id of [...this.followed.keys()]) {
        this.lose(id, `the panel's event socket closed and did not come back within ${Math.max(1, Math.round(this.graceMs / 1000))}s — After Effects quit, restarted or stopped answering`);
      }
    }, this.graceMs);
    this.grace.unref?.();
  }

  /** The event socket reopened. A different panel instance cannot know the job. */
  socketReopened(): void {
    if (this.grace) {
      clearTimeout(this.grace);
      this.grace = null;
    }
    const now = this.opts.instance();
    for (const [id, f] of [...this.followed]) {
      if (f.instance !== null && now !== f.instance) {
        this.lose(id, "After Effects restarted, so the panel that was running it is gone");
      }
    }
  }

  /** Jobs currently followed. For the tests. */
  get size(): number {
    return this.followed.size;
  }

  private lose(jobId: string, why: string): void {
    const s = this.jobs.get(jobId);
    if (!s) return this.drop(jobId);
    const of = s.total !== undefined ? ` of ${s.total}` : "";
    const message =
      `Lost track of batch ${jobId}: ${why}. The last progress the panel reported was ${s.progress}${of} ops; it may ` +
      `have run further, and part of it may have been applied. Do NOT send the batch again — read the comp back and ` +
      `send only what is missing. The panel can now be updated: run setup_panel, then ask the user to quit and ` +
      `reopen After Effects.`;
    if (this.jobs.fail(jobId, message)) logger.warn(message);
    this.drop(jobId);
  }

  private drop(jobId: string): void {
    const f = this.followed.get(jobId);
    if (!f) return;
    clearTimeout(f.silence);
    if (f.ended) clearInterval(f.ended);
    f.unbind();
    this.followed.delete(jobId);
    if (this.followed.size === 0 && this.grace) {
      clearTimeout(this.grace);
      this.grace = null;
    }
  }
}
