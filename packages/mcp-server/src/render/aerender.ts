import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
 * The cost is that aerender renders the project **file**: the project has to be
 * saved (with the caller's explicit saveProject:true when it has unsaved
 * changes), the render reads a private copy in the temp folder taken at its start
 * (`snapshotProject`), and edits made while it runs are not in the output.
 * Every message an agent sees says so.
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
  /**
   * Whether the live queue item was switched off afterwards so it does not
   * render again, and why not when it was not. Absent when no hook was given.
   */
  unqueued?: { marked: boolean; reason?: string };
  /**
   * Set when aerender rendered the item but printed no line this server reads
   * as a frame — so progress sat at 0% throughout. The likeliest cause is an
   * After Effects running in another language, whose PROGRESS lines are worded
   * differently. Said out loud so a stuck-looking progress bar is explained.
   */
  progressWarning?: string;
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
  /** True once the JobManager entry has been settled, by whichever path got there first. */
  settled: boolean;
  /** cancel() could not see the exit and reported stopped:false; a late exit settles the job. */
  cancelGaveUp: boolean;
  /** The once-per-job unticking has run (or been claimed). */
  unqueueDone: boolean;
  rendered: RenderedItem[];
  startedAt: number;
  /** The private copy of the saved .aep every item renders from. */
  snapshot: string;
}

export interface RenderRunnerOptions {
  /** How long a polite stop gets before the tree is killed outright, and again before giving up. */
  graceMs?: number;
  /**
   * Called ONCE as the job ends — completed, failed or cancelled — with every
   * item whose outputs were verified. The server unticks those items in the
   * live queue there, as one named undo step, so the next render_queue does
   * not render them again. Once rather than per item on purpose: one step the
   * user can read in Edit > Undo ("AE MCP: mark rendered") instead of a step
   * landing in their undo history every few minutes while they work, and an
   * item rendered before a failure or cancel is still unticked, because its
   * file is good. A hook failure is reported on the items, never thrown.
   */
  onRendered?: (items: RenderItemPlan[]) => Promise<{ index: number; marked: boolean; reason?: string }[]>;
  /** Where snapshots go. The OS temp folder, unless a test needs its own. */
  tmpRoot?: string;
  /** How a process tree is stopped. The platform's, unless a test needs one that fails. */
  stop?: (pid: number, force: boolean) => Promise<void>;
}

/**
 * Copy the saved project into the OS temp folder, for this job alone.
 *
 * Why a copy: aerender opens the project once per item. Rendering the live
 * .aep would let anything that saves it mid-job — the user's Cmd-S,
 * export_mogrt — change what the later items render, and move the `-rqindex`
 * the plan was made against onto a different item. A copy taken while the
 * write lease is still held is a project nothing else can touch.
 *
 * Why the temp folder and not beside the .aep: a project folder is very often
 * a Dropbox / iCloud / OneDrive folder, and a sibling copy — a dot prefix hides
 * nothing on Windows — would be uploaded in full on every render, and could
 * be picked up by the user's own tools. The cost is footage After Effects can
 * only find through the path it stored *relative* to the project: AE stores
 * both an absolute and a relative path for each file and tries the absolute
 * one first, and the project was just saved by an AE that had every file
 * resolved, so the absolute paths in the copy are current. What is left is a
 * project that was moved and never re-saved since (a clean project is not
 * saved by render_queue) — aerender then reports missing footage, the job
 * fails with its own error lines, and `missingFootageHint` names the fix. The
 * copy keeps the project's file name, so aerender's messages read the same.
 */
export function snapshotProject(projectPath: string, jobId: string, tmpRoot: string = os.tmpdir()): string {
  const dir = path.join(tmpRoot, "ae-mcp-render", jobId);
  const snap = path.join(dir, path.basename(projectPath));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(projectPath, snap);
  } catch (e) {
    removeSnapshot(snap);
    throw new Error(
      `Could not copy the project to ${snap} for the render (${(e as Error).message}), so nothing was rendered.`
    );
  }
  return snap;
}

/** How old another job's snapshot folder must be before a new render clears it away. */
export const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1000;

/**
 * Remove snapshot folders that earlier jobs left behind.
 *
 * A render's copy is removed when its job ends, and on exit and on signals —
 * but not after a hard kill (Task Manager's End task, `kill -9`, a crash), and
 * Windows never empties %TEMP% by itself, so every such kill would leave a
 * full .aep behind for good. Each new render sweeps them. Only folders older
 * than a day go: another server session on this machine may be rendering from
 * a newer one right now, and the current job's folder is never touched.
 * Failures are logged to stderr and otherwise ignored — housekeeping must not
 * stop a render. Returns the folders removed, for the test.
 */
export function sweepStaleSnapshots(
  currentJobId: string,
  tmpRoot: string = os.tmpdir(),
  maxAgeMs: number = STALE_SNAPSHOT_MS,
  now: number = Date.now()
): string[] {
  const root = path.join(tmpRoot, "ae-mcp-render");
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed; // nothing has ever rendered here
  }
  for (const n of names) {
    if (n === currentJobId) continue;
    const dir = path.join(root, n);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (e) {
      logger.warn(`could not clear an old render snapshot at ${dir}: ${(e as Error).message}`);
    }
  }
  return removed;
}

/** Remove a snapshot and the per-job folder it was made in — and nothing else. */
export function removeSnapshot(snap: string): void {
  const dir = path.dirname(snap);
  if (path.basename(path.dirname(dir)) !== "ae-mcp-render") return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * aerender lines that say footage could not be found.
 *
 * aerender has been seen to exit 0 with footage missing, rendering AE's
 * placeholder (colour bars) into the file — a file that exists, is fresh and
 * is not empty, so the on-disk check alone would accept it. Any such line
 * fails the item instead. The wording is aerender's own and not yet measured
 * on 26.x (recipe 57); this matches the forms After Effects uses in its UI.
 */
const MISSING_FOOTAGE_LINE =
  /file not found|could not (?:be )?(?:found|located)|unable to (?:find|locate)|cannot find/i;

export function isMissingFootageLine(line: string): boolean {
  if (MISSING_FOOTAGE_LINE.test(line)) return true;
  // "Footage file missing", "missing footage", "media is missing", …
  return /\bmissing\b/i.test(line) && /\b(?:footage|file|files|media|source)\b/i.test(line);
}

/** Appended to a failure whose lines talk about footage — see snapshotProject. */
export function missingFootageHint(lines: string[]): string {
  if (!lines.some((l) => /footage|missing|could not (?:be )?f(?:ou|i)nd|not found/i.test(l))) return "";
  return (
    " The render read a copy of the project in the temp folder. If the comp's footage is only found " +
    "through a path relative to the project (the project was moved since it was last saved), ask the " +
    "user to save the project in After Effects so it records where the files are now, then render again."
  );
}

/**
 * Output paths that already hold something: a file, or any frame of a sequence.
 * render_queue refuses these unless `overwrite:true`, the same guard
 * add_to_render_queue applies — an item the user queued by hand never went
 * through that one.
 */
export function occupiedOutputs(plan: RenderPlan): string[] {
  const out: string[] = [];
  for (const item of plan.items) out.push(...existingOutputs(item.outputs));
  return out;
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

  private readonly onRendered?: RenderRunnerOptions["onRendered"];
  private readonly tmpRoot: string;
  private readonly stop: (pid: number, force: boolean) => Promise<void>;
  private disarm: (() => void) | null = null;

  constructor(private jobs: JobManager, opts: RenderRunnerOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.onRendered = opts.onRendered;
    this.tmpRoot = opts.tmpRoot ?? os.tmpdir();
    this.stop = opts.stop ?? ((pid, force) => stopProcessTree(pid, force));
  }

  /**
   * While a render runs, the server going away takes it with it: a render
   * nobody is left to report to is still writing files and holding a whole
   * headless After Effects. aerender runs in its own process group (so cancel
   * can stop the tree), which also means a signal to the server no longer
   * reaches it by itself.
   *
   * Armed only for the length of a render, so the server's shutdown is exactly
   * what it always was the rest of the time. On a signal the tree is killed and
   * the signal is re-raised once this handler is gone, so when nothing else
   * listens the default action — terminate — still happens. stdin closing is
   * how an MCP client says it has gone; that stops the render and nothing else.
   * Nothing here writes to stdout.
   */
  private arm(): void {
    if (this.disarm) return;
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const onExit = () => this.killSync();
    const onSignal = (sig: NodeJS.Signals) => {
      this.killSync();
      this.disarm?.();
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    const onStdinGone = () => {
      logger.warn("MCP client went away during a render; stopping aerender.");
      this.killSync();
    };
    process.on("exit", onExit);
    for (const sig of signals) process.on(sig, onSignal);
    // Only a piped stdin is an MCP client. A terminal's stdin (a test run by
    // hand) is never the client going away, and touching it creates a TTY
    // stream that can hold the process open.
    const watchStdin = !process.stdin.isTTY;
    if (watchStdin) {
      process.stdin.on("close", onStdinGone);
      process.stdin.on("end", onStdinGone);
    }
    this.disarm = () => {
      process.off("exit", onExit);
      for (const sig of signals) process.off(sig, onSignal);
      if (watchStdin) {
        process.stdin.off("close", onStdinGone);
        process.stdin.off("end", onStdinGone);
      }
      this.disarm = null;
    };
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
    sweepStaleSnapshots(jobId, this.tmpRoot);
    const snapshot = snapshotProject(plan.projectPath, jobId, this.tmpRoot);
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
      settled: false,
      cancelGaveUp: false,
      unqueueDone: false,
      rendered: [],
      startedAt: Date.now(),
      snapshot,
    };
    this.current = r;
    this.arm();
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
          r.settled = true;
          await this.unqueue(r);
          this.jobs.fail(r.jobId, this.failureText(r, item, outcome) + this.unqueueText(r));
          return;
        }
        if (outcome.missing.length) {
          status = "failed";
          r.settled = true;
          await this.unqueue(r);
          this.jobs.fail(
            r.jobId,
            `aerender finished ${label} but reported missing footage, so the file at ` +
              `${item.outputs.map((x) => x.path).join(", ")} may contain After Effects' missing-footage ` +
              `placeholder instead of the real media. It is NOT reported as rendered. aerender said: ` +
              `${outcome.missing.join(" | ")}.` +
              missingFootageHint(outcome.missing) +
              this.renderedSoFar(r) +
              this.unqueueText(r)
          );
          return;
        }
        const { verified, problems } = verifyOutputs(item.outputs, itemStart);
        if (problems.length) {
          status = "failed";
          r.settled = true;
          await this.unqueue(r);
          this.jobs.fail(
            r.jobId,
            `aerender reported success on ${label} but the output is not there: ${problems.join("; ")}. ` +
              `Nothing is claimed rendered for that item.` +
              (outcome.errors.length ? ` aerender's error lines: ${outcome.errors.join(" | ")}.` : "") +
              ` Last output: ${outcome.tail.join(" | ")}` +
              this.renderedSoFar(r) +
              this.unqueueText(r)
          );
          return;
        }
        const done: RenderedItem = {
          index: item.index,
          compName: item.compName,
          outputs: verified,
          frames: r.itemFrames,
          elapsedMs: Date.now() - itemStart,
        };
        if (r.itemFrames === 0 && item.frames > 0) {
          done.progressWarning =
            `aerender wrote the output but printed no frame line this server recognises (last lines: ${outcome.tail
              .slice(-3)
              .join(" | ")}), so progress for this item was never reported. If After Effects runs in a language ` +
            "other than English, that is the likely cause; the render itself is verified on disk.";
          logger.warn(`render ${r.jobId}: ${done.progressWarning}`);
        }
        r.rendered.push(done);
        r.framesBefore += Math.max(item.frames, r.itemFrames);
      }
      if (r.cancelled) {
        status = "cancelled";
        // Normally cancel() has settled the job with its own report. When it
        // could not see the process exit it reported stopped:false and left the
        // job open — and this is that exit, arriving late. Settle it here, or
        // await_job waits for ever on a render that is over.
        if (!r.settled && r.cancelGaveUp) {
          r.settled = true;
          await this.unqueue(r);
          this.jobs.cancel(r.jobId, {
            jobId: r.jobId,
            stopped: true,
            wasRunning: true,
            rendered: r.rendered,
            partialFiles: existingOutputs(r.plan.items[r.itemPos]?.outputs ?? []),
            note:
              "aerender exited after cancel_job had reported it still running; the render is stopped now. " +
              "The interrupted item's output, if any, is incomplete.",
          });
        }
        return;
      }
      this.jobs.reportProgress(r.jobId, r.totalFrames, r.totalFrames, "done");
      r.settled = true;
      await this.unqueue(r);
      this.jobs.complete(r.jobId, {
        rendered: r.rendered,
        projectPath: r.plan.projectPath,
        elapsedMs: Date.now() - r.startedAt,
        note:
          "Every file listed was checked on disk after the render: it exists, is not empty, and was written " +
          "by this render, which rendered a private copy of the project saved at its start. Each rendered " +
          "item was switched off in After Effects' Render Queue (its Render box unticked, status Unqueued) so " +
          "it does not render again — all of them in ONE undo step, \"AE MCP: mark rendered\", added to the " +
          "user's undo history as the render finished; `unqueued.marked:false` on an item says why that one " +
          "was not.",
      });
    } catch (e) {
      status = "failed";
      if (!r.settled) {
        r.settled = true;
        await this.unqueue(r).catch(() => {});
        this.jobs.fail(r.jobId, `The render stopped unexpectedly: ${(e as Error).message}${this.renderedSoFar(r)}${this.unqueueText(r)}`);
      }
    } finally {
      this.finished.set(r.jobId, status);
      if (this.current === r) this.current = null;
      removeSnapshot(r.snapshot);
      this.disarm?.();
    }
  }

  /**
   * Untick every verified item in the live queue, once per job, and record the
   * answer on each rendered item. Never throws: the files are rendered either
   * way, and a failure here is said on the items rather than raised over them.
   */
  private async unqueue(r: Running): Promise<void> {
    if (r.unqueueDone || !this.onRendered) return;
    r.unqueueDone = true;
    if (!r.rendered.length) return;
    const plans = r.rendered
      .map((x) => r.plan.items.find((i) => i.index === x.index))
      .filter((x): x is RenderItemPlan => !!x);
    let answers: { index: number; marked: boolean; reason?: string }[];
    try {
      answers = await this.onRendered(plans);
    } catch (e) {
      answers = plans.map((p) => ({ index: p.index, marked: false, reason: (e as Error).message }));
    }
    for (const done of r.rendered) {
      const a = answers.find((x) => x.index === done.index);
      done.unqueued = a ? { marked: a.marked, ...(a.reason ? { reason: a.reason } : {}) } : { marked: false, reason: "no answer" };
    }
  }

  /** The sentence a failure message carries about the unticking, when any happened. */
  private unqueueText(r: Running): string {
    const marked = r.rendered.filter((x) => x.unqueued?.marked).map((x) => x.index);
    if (!marked.length) return "";
    return ` The item(s) that did finish (${marked.join(", ")}) were unticked in the Render Queue in one undo step, "AE MCP: mark rendered".`;
  }

  private renderItem(
    r: Running,
    item: RenderItemPlan,
    label: string
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error; errors: string[]; tail: string[]; missing: string[] }> {
    return new Promise((resolve) => {
      const errors: string[] = [];
      const missing: string[] = [];
      const tail: string[] = [];
      let child: ChildProcess;
      try {
        child = spawn(r.aerender, aerenderArgs(r.snapshot, item.index), {
          ...treeSpawnOptions(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ code: null, signal: null, spawnError: e as Error, errors, tail, missing });
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
          resolve({ code, signal, spawnError, errors, tail, missing });
        };
        child.on("error", (e) => finish(null, null, e));
        child.on("exit", (code, signal) => finish(code, signal));
      });
      const onLine = (line: string) => {
        tail.push(line.trim());
        if (tail.length > TAIL_LINES) tail.shift();
        if (isMissingFootageLine(line) && missing.length < 20) missing.push(line.trim());
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
    return head + errs + tail + partial + missingFootageHint([...o.errors, ...o.tail]) + this.renderedSoFar(r);
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
      await this.stop(child.pid, false);
      stopped = await within(exited, this.graceMs);
      if (!stopped) {
        await this.stop(child.pid, true);
        stopped = await within(exited, this.graceMs);
      }
      if (!stopped) {
        // From here on the late exit, if it ever comes, is run()'s to settle.
        // It may already have come in the instant since the last check, in
        // which case run() has finished and this report can say so honestly.
        r.cancelGaveUp = true;
        if (this.current !== r) stopped = true;
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
    if (stopped && !r.settled) {
      r.settled = true;
      await this.unqueue(r);
      this.jobs.cancel(jobId, report);
    }
    return report;
  }

  private killSync(): void {
    const r = this.current;
    const pid = r?.child?.pid;
    if (pid !== undefined) stopProcessTreeSync(pid);
    if (r) {
      removeSnapshot(r.snapshot);
    }
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
