import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JobManager } from "../jobs/manager.js";
import { logger } from "../util/logger.js";
import { stopProcessTree, stopProcessTreeSync, treeSpawnOptions } from "../setup/platform.js";

/**
 * `render_queue` — rendering the project's render queue in a separate
 * `aerender` process (issue #137).
 *
 * Why not `app.project.renderQueue.render()`: it is synchronous. It holds the
 * ExtendScript thread — and After Effects' interface with it — for the whole
 * render, so every later call on the panel's evalScript chain waits behind it,
 * the op timeout fires on a render that is still going, and there is no script
 * call that stops it. Why not Media Encoder (`queueInAME`): it may not be
 * installed, it renders with its own presets rather than the output-module
 * templates #95 says to rely on, and it reports neither progress nor
 * completion to a script. aerender is the one route that renders the queue
 * exactly as configured, reports every frame on stdout, and is a process this
 * server can kill.
 *
 * The cost is that aerender renders the project **file**, so the project is
 * saved just before the render starts, and edits made while it runs are not in
 * the output. Every message an agent sees says so.
 */

export interface RenderOutputPlan {
  index: number;
  path: string | null;
  template?: string | null;
}

export interface RenderItemPlan {
  index: number;
  compId: number | null;
  compName: string | null;
  status: string;
  frames: number;
  outputs: RenderOutputPlan[];
}

/** What `_render_prepare` answers. */
export interface RenderPlan {
  projectPath: string;
  appPackage: string | null;
  version?: string;
  dirty?: boolean;
  items: RenderItemPlan[];
}

/**
 * aerender's arguments for one render queue item.
 *
 * `-rqindex` renders that item exactly as it is configured in the saved
 * project — its render settings and output-module templates included — and
 * nothing else in the queue. `ERRORS_AND_PROGRESS` is aerender's default
 * verbosity, spelled out because the progress lines are the whole of what this
 * module reads.
 */
export function aerenderArgs(projectPath: string, rqIndex: number): string[] {
  return ["-project", projectPath, "-rqindex", String(rqIndex), "-v", "ERRORS_AND_PROGRESS"];
}

/**
 * One rendered frame, as aerender prints it:
 *
 *   PROGRESS:  0:00:00:05 (6): 0 Seconds
 *   PROGRESS:  00005 (6): 1 Seconds          (frames display style)
 *
 * Each such line is one frame finished. They are **counted** rather than read
 * for their number, so neither the project's time display style nor whether
 * the bracketed number is absolute or relative to the span can skew progress.
 */
const FRAME_LINE = /^PROGRESS:\s+\S+\s+\((\d+)\):\s/;
const ERROR_LINE = /\bERROR\b/;

export type AerenderLine =
  | { kind: "frame"; n: number }
  | { kind: "error"; text: string }
  | { kind: "other"; text: string };

export function parseAerenderLine(raw: string): AerenderLine {
  const line = raw.trim();
  const m = FRAME_LINE.exec(line);
  if (m) return { kind: "frame", n: Number(m[1]) };
  if (ERROR_LINE.test(line)) return { kind: "error", text: line };
  return { kind: "other", text: line };
}

/** Splits a stream into lines across chunk boundaries; aerender ends lines with \n, \r\n or a bare \r. */
export class LineSplitter {
  private rest = "";
  constructor(private onLine: (line: string) => void) {}
  push(chunk: string | Buffer): void {
    const text = this.rest + chunk.toString();
    const parts = text.split(/\r\n|\r|\n/);
    this.rest = parts.pop() ?? "";
    for (const p of parts) if (p.trim()) this.onLine(p);
  }
  end(): void {
    if (this.rest.trim()) this.onLine(this.rest);
    this.rest = "";
  }
}

/**
 * The first candidate that is a file on disk. Throws naming every place
 * looked, and the override, when there is none — before anything is saved.
 */
export function resolveAerender(candidates: string[], exists: (p: string) => boolean = isFile): string {
  for (const c of candidates) if (exists(c)) return c;
  throw new Error(
    "Could not find aerender, the command-line renderer that ships with After Effects, so nothing was " +
      "saved or rendered. Looked in: " +
      (candidates.length ? candidates.join(", ") : "(nowhere — After Effects did not say where it is installed)") +
      ". If After Effects is installed somewhere else, set AE_MCP_AERENDER to the full path of aerender " +
      "(aerender.exe on Windows) in this MCP server's environment and reconnect it."
  );
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Files older than this before the render began are a previous render's, not this one's. */
const MTIME_SLACK_MS = 2000;

export interface VerifiedOutput {
  path: string;
  bytes: number;
  /** Image sequences only: how many frame files this render wrote. */
  files?: number;
}

/**
 * Check that a finished render actually wrote what it was asked to.
 *
 * aerender has been known to exit 0 having written nothing (a missing font, a
 * missing plug-in, an output folder it could not write), so an exit code is not
 * evidence. A file that exists but predates the render is the previous
 * render's — `overwrite:true` exists precisely because the path can already be
 * occupied — so the modification time has to be on or after the start.
 */
export function verifyOutputs(
  outputs: RenderOutputPlan[],
  startedAt: number
): { verified: VerifiedOutput[]; problems: string[] } {
  const verified: VerifiedOutput[] = [];
  const problems: string[] = [];
  const since = startedAt - MTIME_SLACK_MS;
  for (const o of outputs) {
    if (!o.path) {
      problems.push(`output module ${o.index} has no file`);
      continue;
    }
    const seq = /\[(#+)\]/.exec(path.basename(o.path));
    if (seq) {
      const dir = path.dirname(o.path);
      const base = path.basename(o.path);
      const prefix = base.slice(0, seq.index);
      const suffix = base.slice(seq.index + seq[0].length);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        problems.push(`the folder ${dir} cannot be read`);
        continue;
      }
      const re = new RegExp("^" + escapeRe(prefix) + "\\d+" + escapeRe(suffix) + "$");
      let files = 0;
      let bytes = 0;
      for (const n of names) {
        if (!re.test(n)) continue;
        try {
          const st = fs.statSync(path.join(dir, n));
          if (st.isFile() && st.size > 0 && st.mtimeMs >= since) {
            files++;
            bytes += st.size;
          }
        } catch {}
      }
      if (files === 0) problems.push(`no frames matching ${o.path} were written by this render`);
      else verified.push({ path: o.path, bytes, files });
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(o.path);
    } catch {
      problems.push(`${o.path} does not exist`);
      continue;
    }
    if (!st.isFile() || st.size === 0) problems.push(`${o.path} is empty`);
    else if (st.mtimeMs < since) problems.push(`${o.path} was not rewritten — it is older than this render`);
    else verified.push({ path: o.path, bytes: st.size });
  }
  return { verified, problems };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface RenderedItem {
  index: number;
  compName: string | null;
  outputs: VerifiedOutput[];
  frames: number;
  elapsedMs: number;
}

export interface CancelReport {
  jobId: string;
  /** True only when the aerender process was seen to exit. */
  stopped: boolean;
  wasRunning: boolean;
  status?: string;
  rendered?: RenderedItem[];
  interruptedItem?: { index: number; compName: string | null; framesDone: number; frames: number } | null;
  partialFiles?: string[];
  note: string;
}

interface Running {
  jobId: string;
  plan: RenderPlan;
  aerender: string;
  totalFrames: number;
  framesBefore: number;
  itemPos: number;
  itemFrames: number;
  child: ChildProcess | null;
  exited: Promise<void> | null;
  cancelled: boolean;
  rendered: RenderedItem[];
  startedAt: number;
}

export interface RenderRunnerOptions {
  /** How long a polite stop gets before the tree is killed outright, and again before giving up. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 5000;
const TAIL_LINES = 12;

let seq = 0;

/**
 * Runs one render job at a time, item by item, one aerender process per item.
 *
 * One at a time on purpose: every aerender is a whole headless After Effects,
 * and two of them beside the user's own session is the way to run a machine
 * out of memory. Item by item so progress can be reported per item and so a
 * cancel stops the queue rather than only the item in front of it.
 */
export class RenderRunner {
  private current: Running | null = null;
  private finished = new Map<string, string>();
  private readonly graceMs: number;

  constructor(private jobs: JobManager, opts: RenderRunnerOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    // A render nobody is left to report to is still writing files and eating a
    // machine's worth of memory. The server going away takes it with it.
    process.on("exit", () => this.killSync());
  }

  get activeJobId(): string | null {
    return this.current?.jobId ?? null;
  }

  isRenderJob(jobId: string): boolean {
    return this.current?.jobId === jobId || this.finished.has(jobId);
  }

  start(plan: RenderPlan, aerender: string): { jobId: string; totalFrames: number } {
    if (this.current) throw new Error(`A render is already running (job ${this.current.jobId}).`);
    const jobId = `r_${Date.now()}_${++seq}`;
    const totalFrames = Math.max(1, plan.items.reduce((n, i) => n + Math.max(0, i.frames || 0), 0));
    const r: Running = {
      jobId,
      plan,
      aerender,
      totalFrames,
      framesBefore: 0,
      itemPos: 0,
      itemFrames: 0,
      child: null,
      exited: null,
      cancelled: false,
      rendered: [],
      startedAt: Date.now(),
    };
    this.current = r;
    this.jobs.register(jobId, totalFrames);
    void this.run(r);
    return { jobId, totalFrames };
  }

  private async run(r: Running): Promise<void> {
    let status = "completed";
    try {
      const items = r.plan.items;
      for (let i = 0; i < items.length; i++) {
        if (r.cancelled) break;
        const item = items[i];
        r.itemPos = i;
        r.itemFrames = 0;
        const label = `"${item.compName ?? "?"}" (render queue item ${item.index}, ${i + 1} of ${items.length})`;
        this.jobs.reportProgress(
          r.jobId,
          r.framesBefore,
          r.totalFrames,
          `Starting aerender for ${label} — a background copy of After Effects takes a while to launch`
        );
        const itemStart = Date.now();
        const outcome = await this.renderItem(r, item, label);
        if (r.cancelled) break;
        if (outcome.spawnError || outcome.code !== 0) {
          status = "failed";
          this.jobs.fail(r.jobId, this.failureText(r, item, outcome));
          return;
        }
        const { verified, problems } = verifyOutputs(item.outputs, itemStart);
        if (problems.length) {
          status = "failed";
          this.jobs.fail(
            r.jobId,
            `aerender reported success on ${label} but the output is not there: ${problems.join("; ")}. ` +
              `Nothing is claimed rendered for that item.` +
              (outcome.errors.length ? ` aerender's error lines: ${outcome.errors.join(" | ")}.` : "") +
              ` Last output: ${outcome.tail.join(" | ")}` +
              this.renderedSoFar(r)
          );
          return;
        }
        r.rendered.push({
          index: item.index,
          compName: item.compName,
          outputs: verified,
          frames: r.itemFrames,
          elapsedMs: Date.now() - itemStart,
        });
        r.framesBefore += Math.max(item.frames, r.itemFrames);
      }
      if (r.cancelled) {
        status = "cancelled";
        return; // cancel() settles the job, with its own report.
      }
      this.jobs.reportProgress(r.jobId, r.totalFrames, r.totalFrames, "done");
      this.jobs.complete(r.jobId, {
        rendered: r.rendered,
        projectPath: r.plan.projectPath,
        elapsedMs: Date.now() - r.startedAt,
        note:
          "Every file listed was checked on disk after the render: it exists, is not empty, and was written " +
          "by this render. After Effects' Render Queue panel still shows these items as Queued — they were " +
          "rendered by a separate aerender process from the saved project, not by the queue itself. Remove " +
          "them with remove_render_item if they should not render again.",
      });
    } catch (e) {
      status = "failed";
      this.jobs.fail(r.jobId, `The render stopped unexpectedly: ${(e as Error).message}${this.renderedSoFar(r)}`);
    } finally {
      this.finished.set(r.jobId, status);
      if (this.current === r) this.current = null;
    }
  }

  private renderItem(
    r: Running,
    item: RenderItemPlan,
    label: string
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error; errors: string[]; tail: string[] }> {
    return new Promise((resolve) => {
      const errors: string[] = [];
      const tail: string[] = [];
      let child: ChildProcess;
      try {
        child = spawn(r.aerender, aerenderArgs(r.plan.projectPath, item.index), {
          ...treeSpawnOptions(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ code: null, signal: null, spawnError: e as Error, errors, tail });
        return;
      }
      r.child = child;
      let settled = false;
      r.exited = new Promise<void>((res) => {
        const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
          if (settled) return;
          settled = true;
          out.end();
          err.end();
          r.child = null;
          res();
          resolve({ code, signal, spawnError, errors, tail });
        };
        child.on("error", (e) => finish(null, null, e));
        child.on("exit", (code, signal) => finish(code, signal));
      });
      const onLine = (line: string) => {
        tail.push(line.trim());
        if (tail.length > TAIL_LINES) tail.shift();
        const parsed = parseAerenderLine(line);
        if (parsed.kind === "frame") {
          r.itemFrames++;
          const done = Math.min(r.framesBefore + r.itemFrames, r.totalFrames);
          this.jobs.reportProgress(
            r.jobId,
            done,
            r.totalFrames,
            `Rendering ${label}: frame ${r.itemFrames} of ${item.frames || "?"}`
          );
        } else if (parsed.kind === "error") {
          if (errors.length < 20) errors.push(parsed.text);
        }
      };
      const out = new LineSplitter(onLine);
      const err = new LineSplitter(onLine);
      child.stdout?.on("data", (c) => out.push(c));
      child.stderr?.on("data", (c) => err.push(c));
    });
  }

  private failureText(
    r: Running,
    item: RenderItemPlan,
    o: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error; errors: string[]; tail: string[] }
  ): string {
    const head = o.spawnError
      ? `aerender could not be started (${r.aerender}): ${o.spawnError.message}.`
      : `aerender failed on render queue item ${item.index} ("${item.compName ?? "?"}") with ` +
        (o.signal ? `signal ${o.signal}` : `exit code ${o.code}`) +
        ` after ${r.itemFrames} of ${item.frames} frames.`;
    const errs = o.errors.length ? ` Its error lines: ${o.errors.join(" | ")}.` : "";
    const tail = o.tail.length ? ` Last output: ${o.tail.join(" | ")}` : "";
    const partial = o.spawnError ? "" : ` Any file it started at ${item.outputs.map((x) => x.path).join(", ")} is incomplete.`;
    return head + errs + tail + partial + this.renderedSoFar(r);
  }

  private renderedSoFar(r: Running): string {
    if (!r.rendered.length) return " No item finished before this one.";
    return (
      " Finished and verified before it: " +
      r.rendered.map((x) => `item ${x.index} -> ${x.outputs.map((o) => o.path).join(", ")}`).join("; ") +
      "."
    );
  }

  /**
   * Stop a render and report what was left. Null when `jobId` is not a render
   * job this runner has seen — the caller then treats it as a batch job.
   *
   * `stopped` is only true when the aerender process was *seen* to exit: a
   * signal sent is not a render stopped, and a cancel that reports success
   * while the engine keeps writing frames is the lie this exists to avoid.
   */
  async cancel(jobId: string): Promise<CancelReport | null> {
    const r = this.current;
    if (!r || r.jobId !== jobId) {
      const status = this.finished.get(jobId);
      if (status === undefined) return null;
      return {
        jobId,
        stopped: false,
        wasRunning: false,
        status,
        note: `This render had already finished (${status}) — there was nothing to cancel. await_job or get_job returns its outcome.`,
      };
    }
    r.cancelled = true;
    const item = r.plan.items[r.itemPos];
    const child = r.child;
    const exited = r.exited;
    let stopped = true;
    if (child && child.pid !== undefined && exited) {
      await stopProcessTree(child.pid, false);
      stopped = await within(exited, this.graceMs);
      if (!stopped) {
        await stopProcessTree(child.pid, true);
        stopped = await within(exited, this.graceMs);
      }
    }
    const partialFiles = item ? existingOutputs(item.outputs) : [];
    const report: CancelReport = {
      jobId,
      stopped,
      wasRunning: true,
      rendered: r.rendered,
      interruptedItem: item
        ? { index: item.index, compName: item.compName, framesDone: r.itemFrames, frames: item.frames }
        : null,
      partialFiles,
      note: stopped
        ? "The aerender process was stopped and has exited; no later item was started. " +
          (partialFiles.length
            ? `The interrupted item's output is INCOMPLETE and was left on disk: ${partialFiles.join(", ")} — tell the user, or delete it, rather than presenting it as a render. `
            : "") +
          (r.rendered.length ? "Items listed in `rendered` finished and were verified before the cancel." : "No item had finished.")
        : `aerender (pid ${child?.pid}) did not exit after being told to stop and then killed. It may still be ` +
          "rendering. Ask the user to check for an aerender or After Effects render process in Activity " +
          "Monitor / Task Manager and end it.",
    };
    if (stopped) this.jobs.cancel(jobId, report);
    return report;
  }

  private killSync(): void {
    const pid = this.current?.child?.pid;
    if (pid !== undefined) stopProcessTreeSync(pid);
  }
}

function within(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function existingOutputs(outputs: RenderOutputPlan[]): string[] {
  const found: string[] = [];
  for (const o of outputs) {
    if (!o.path) continue;
    if (/\[#+\]/.test(path.basename(o.path))) {
      // A sequence's partial frames are the frames that exist; name the pattern.
      const { verified } = verifyOutputs([o], 0);
      if (verified.length) found.push(o.path);
      continue;
    }
    try {
      if (fs.statSync(o.path).isFile()) found.push(o.path);
    } catch {}
  }
  return found;
}

export function logRenderStart(jobId: string, aerender: string, plan: RenderPlan): void {
  logger.info(`render ${jobId}: ${aerender} on ${plan.projectPath}, items ${plan.items.map((i) => i.index).join(",")}`);
}
