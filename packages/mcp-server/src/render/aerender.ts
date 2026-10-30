import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobManager } from "../jobs/manager.js";
import { logger } from "../util/logger.js";
import {
  findRenderProcesses,
  findRenderProcessesSync,
  isStillRenderProcess,
  isStillRenderProcessSync,
  pidAlive,
  stopPid,
  stopPidSync,
  stopProcessTree,
  stopProcessTreeSync,
  treeSpawnOptions,
} from "../setup/platform.js";

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
  /** Seconds of comp time this item renders, as After Effects reports it. */
  timeSpanDuration?: number;
  outputs: RenderOutputPlan[];
  /** Every file-backed footage item this item reads, as After Effects resolves it now (#145). */
  footage?: FootageRef[];
  /** Missing footage the render probably does not read, but might (#144). Reported, never refused. */
  footageWarnings?: string[];
  /** Missing footage the render provably does not read, with why (#144). */
  footageSkipped?: string[];
}

/** A footage file a render reads: its project item's name and its path on disk. */
export interface FootageRef {
  name: string;
  path: string;
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

/**
 * Evidence beyond "a fresh file exists" that the render actually happened.
 *
 * A live run (26.5, 1 in 8) reported a missing-footage render as completed: a
 * 1 MiB file, `frames: 0`, and none of aerender's lines past "Launching After
 * Effects". So the file is judged, and how depends on whether aerender's
 * frame lines could be read:
 *
 * - **Frame lines counted** (an English AE): a sequence needs at least that
 *   many fresh frame files; a QuickTime/MP4 must be a complete ISO media file
 *   with a `moov` index, and its duration must match the item's span within
 *   one frame when the span is known.
 * - **No frame line parsed** — an AE in another language words them
 *   differently (recipe 63), or aerender's output never arrived: the file has
 *   to stand on its own. A sequence needs at least as many fresh frame files
 *   as the span has frames; a QuickTime/MP4 needs `moov` AND a duration within
 *   one frame of the span. Any other format (AVI, MXF, WAV …) cannot be judged
 *   from its bytes here, so it fails, saying exactly that.
 *
 * A render that stopped early leaves `mdat` (the media) without `moov`: the
 * corrupt live file had no readable duration.
 */
export function renderEvidenceProblems(
  item: RenderItemPlan,
  framesCounted: number,
  verified: VerifiedOutput[]
): string[] {
  const problems: string[] = [];
  const span = item.timeSpanDuration && item.timeSpanDuration > 0 ? item.timeSpanDuration : null;
  const fps = span && item.frames > 0 ? item.frames / span : null;
  const noLines = framesCounted === 0;
  if (noLines && !(item.frames > 0)) {
    problems.push(
      "aerender printed no frame line this server recognises and the item's frame count is unknown, so " +
        "nothing shows a frame was rendered"
    );
    return problems;
  }
  for (const v of verified) {
    if (v.files !== undefined) {
      const need = noLines ? item.frames : framesCounted;
      if (v.files < need) {
        problems.push(
          `${v.files} fresh frame files of ${v.path} were written where ${need} were ` +
            (noLines ? "expected from the comp's span" : "reported by aerender")
        );
      }
      continue;
    }
    if (/\.(?:mov|mp4|m4v|3gp)$/i.test(v.path)) {
      const info = isoMediaInfo(v.path);
      if (info.problem) {
        problems.push(`${v.path} ${info.problem}`);
        continue;
      }
      if (span && fps) {
        if (info.durationSec === undefined) {
          problems.push(`${v.path} has no readable movie duration (no 'mvhd' in its index)`);
        } else if (Math.abs(info.durationSec - span) > 1 / fps + 1e-6) {
          problems.push(
            `${v.path} lasts ${info.durationSec.toFixed(3)}s where the render span is ${span.toFixed(3)}s — ` +
              "more than a frame apart, so it is not the whole render"
          );
        }
      } else if (noLines) {
        problems.push(`${v.path} cannot be checked against the render span, which After Effects did not report`);
      }
      continue;
    }
    if (noLines) {
      problems.push(
        `aerender printed no frame line this server recognises (an After Effects in a language other than ` +
          `English words them differently — recipe 63), and ${v.path} is a format whose contents this server ` +
          "cannot check, so the render cannot be verified. QuickTime/MP4 and image-sequence output can be checked " +
          "without those lines."
      );
    }
  }
  return problems;
}

/**
 * How many frames the verified output proves, or null when no output says.
 * The largest across an item's outputs — each output module renders the same
 * frames. Only called once `renderEvidenceProblems` has passed the outputs.
 */
export function verifiedFrameCount(item: RenderItemPlan, verified: VerifiedOutput[]): number | null {
  const span = item.timeSpanDuration && item.timeSpanDuration > 0 ? item.timeSpanDuration : null;
  const fps = span && item.frames > 0 ? item.frames / span : null;
  let best: number | null = null;
  for (const v of verified) {
    let n: number | null = null;
    if (v.files !== undefined) n = v.files;
    else if (fps && /\.(?:mov|mp4|m4v|3gp)$/i.test(v.path)) {
      const d = isoMediaInfo(v.path).durationSec;
      if (d !== undefined) n = Math.round(d * fps);
    }
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

/** Back-compat: just the structural problem, or null. */
export function isoMediaProblem(file: string): string | null {
  return isoMediaInfo(file).problem;
}

/**
 * Whether `file` is a structurally complete ISO base media file (QuickTime,
 * MP4) — the top-level boxes tile the file exactly and one of them is `moov`
 * — and its duration, from `moov`'s `mvhd`, when present.
 */
export function isoMediaInfo(file: string): { problem: string | null; durationSec?: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    return { problem: `cannot be read (${(e as Error).message})` };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let off = 0;
    let moovAt = -1;
    let moovLen = 0;
    let moovHeader = 8;
    let boxes = 0;
    while (off < size) {
      if (size - off < 8) return { problem: "ends in a partial box header" };
      fs.readSync(fd, head, 0, 16, off);
      let len = head.readUInt32BE(0);
      let hdr = 8;
      const type = head.toString("latin1", 4, 8);
      if (len === 1) {
        if (size - off < 16) return { problem: "ends in a partial box header" };
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { problem: "has a box too large to be real" };
        len = Number(big);
        hdr = 16;
      } else if (len === 0) {
        len = size - off;
      }
      if (len < hdr) return { problem: `has a malformed '${type}' box` };
      if (off + len > size) return { problem: `is truncated: its '${type}' box runs past the end of the file` };
      if (type === "moov") {
        moovAt = off;
        moovLen = len;
        moovHeader = hdr;
      }
      off += len;
      if (++boxes > 100000) return { problem: "has an implausible number of boxes" };
    }
    if (moovAt < 0) {
      return { problem: "has no 'moov' index — the movie was never finished, and players will read no duration" };
    }
    // mvhd is a direct child of moov, normally first. Read at most 1 MiB.
    const want = Math.min(moovLen - moovHeader, 1 << 20);
    const body = Buffer.alloc(want);
    fs.readSync(fd, body, 0, want, moovAt + moovHeader);
    let p = 0;
    while (p + 8 <= body.length) {
      const len = body.readUInt32BE(p);
      const type = body.toString("latin1", p + 4, p + 8);
      if (len < 8) break;
      if (type === "mvhd" && p + len <= body.length) {
        const version = body.readUInt8(p + 8);
        let timescale: number;
        let duration: number;
        if (version === 1) {
          timescale = body.readUInt32BE(p + 8 + 4 + 16);
          duration = Number(body.readBigUInt64BE(p + 8 + 4 + 20));
        } else {
          timescale = body.readUInt32BE(p + 8 + 4 + 8);
          duration = body.readUInt32BE(p + 8 + 4 + 12);
        }
        if (timescale > 0) return { problem: null, durationSec: duration / timescale };
        return { problem: null };
      }
      p += len;
    }
    return { problem: null };
  } catch (e) {
    return { problem: `could not be checked (${(e as Error).message})` };
  } finally {
    try { fs.closeSync(fd); } catch {}
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
    const re = sequenceMatcher(path.basename(o.path));
    if (re) {
      const dir = path.dirname(o.path);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        problems.push(`the folder ${dir} cannot be read`);
        continue;
      }
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
   * Frames the output on disk proves: fresh frame files for a sequence, the
   * movie's duration × the span's frame rate for QuickTime/MP4. Absent for a
   * format that cannot be read. `frames` is never lower than this.
   */
  framesVerified?: number;
  /** Set when the frame count differs from the comp span's, or could only be read from the file. */
  framesNote?: string;
  /** Carried from the plan: missing footage this item probably did not read, but might have (#144). */
  footageWarnings?: string[];
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
  /** Where the copy sits, and the folder everything the job writes is inside (#215). */
  layout: SnapshotLayout;
  /** When the snapshot folder's mtime was last refreshed (see touchSnapshot). */
  touchedAt: number;
  /** Outputs that could not be moved out of the job folder (#215), for a cancel's report. */
  relocateProblems: string[];
  /** The current item's output files as they were before it rendered. */
  before: Map<string, FileStamp>;
  /**
   * Partial output of a cancelled item left in the job folder because the
   * asked path held a file from before the render. The job folder is then
   * kept (only the copy is removed) so these survive the job's end.
   */
  kept: string[];
  /** Set while cancel() runs; run() waits on it before removing the job folder. */
  cancelDone: Promise<void> | null;
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
  /** The longest the output may stay open after aerender exits before its engine is killed. */
  drainCapMs?: number;
  /**
   * This job's render processes — executable aerender/aerendercore AND the
   * job's snapshot path in the arguments. The platform's
   * (`findRenderProcesses`), unless a test needs one that finds nothing.
   */
  findEngines?: (snapshotPath: string) => Promise<number[]>;
  /** Re-check of one pid immediately before it is signalled (`isStillRenderProcess`). */
  confirmEngine?: (pid: number, snapshotPath: string) => Promise<boolean>;
  /**
   * A program to start aerender through: `spawn(interpreter, [aerender, ...args])`
   * instead of `spawn(aerender, args)`. Unset in the server. The tests set it
   * to `process.execPath` on Windows, which will not execute the fake
   * aerender's shebang line (issue #173); the spawned child is still the
   * process whose tree cancel stops.
   */
  interpreter?: string;
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
 * project that was moved and never re-saved since — refused before this runs
 * by `checkPlanFootage`, which reads the paths the saved file records (issue
 * #145). aerender's own missing-footage line, and `missingFootageHint`, remain
 * the second layer. The copy keeps the project's file name, so aerender's
 * messages read the same.
 *
 * Why the copy sits at the bottom of a CHAIN OF ONE-LETTER FOLDERS as deep as
 * the project's own folder (`<tmp>/ae-mcp-render/<jobId>/a/a/a/a/a/show.aep`
 * for `/Users/me/work/show/show.aep`, two spare levels included) — issue #215,
 * MEASURED on 26.5 (macOS): an output module's folder is saved as an alias
 * (`fullpath` plus ascend counts) and a file name, and aerender uses the
 * RELATIVE form whenever the folder it names exists next to the project it
 * was given. With the copy directly in `<jobId>/`, an output beside the
 * project was written into the job folder and deleted with it, and an output
 * one folder up landed in the shared `ae-mcp-render/` root and was never
 * cleaned. In the chain, every folder the ascend counts can climb to is one
 * of this job's own. The relative form of an output that is not in the
 * project's folder or an ancestor of it continues below the climb with a
 * real folder name — never the chain's letter, which is chosen to match no
 * name in the project's or any output's path — so it names nothing, and
 * aerender uses the absolute path. An output in the project's folder or an
 * ancestor lands in a chain folder; `relocateShadowOutputs` moves it to
 * where the user asked. The chain is as deep as the deeper of the project's
 * given and real (symlinks resolved) spellings, plus spare levels, because
 * which spelling After Effects counts against is not measured. Letters keep
 * the path short on Windows, where a mirror of real names doubled it.
 */
export function snapshotProject(
  projectPath: string,
  jobId: string,
  tmpRoot: string = os.tmpdir(),
  outputPaths: string[] = []
): SnapshotLayout {
  const layout = snapshotLayout(projectPath, jobId, tmpRoot, outputPaths);
  try {
    fs.mkdirSync(path.dirname(layout.snap), { recursive: true });
    fs.copyFileSync(projectPath, layout.snap);
  } catch (e) {
    removeSnapshot(layout.jobDir);
    throw new Error(
      `Could not copy the project to ${layout.snap} for the render (${(e as Error).message}), so nothing was rendered.`
    );
  }
  return layout;
}

/** Where a job's copy lives, and the chain of folders above it (#215). */
export interface SnapshotLayout {
  /** `<tmpRoot>/ae-mcp-render/<jobId>` — everything the job writes is inside it. */
  jobDir: string;
  /** The copy aerender renders. */
  snap: string;
  /** How many chain folders lie between `jobDir` and the copy. */
  depth: number;
  /** The one name every chain folder has. */
  name: string;
}

/** Levels the ascend counts may climb past the deepest spelling of the project's folder we know. */
export const SPARE_LEVELS = 2;
const CHAIN_NAMES = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A job's own folder. Derived, never searched for. */
export function jobFolder(tmpRoot: string, jobId: string, p: path.PlatformPath = path): string {
  return p.join(tmpRoot, "ae-mcp-render", jobId);
}

/** The folder names of a path below its root. */
function segments(dir: string, p: path.PlatformPath): string[] {
  return dir.slice(p.parse(dir).root.length).split(/[\\/]+/).filter(Boolean);
}

/**
 * Lay out a job's copy. `real` resolves symlinks (a test's stand-in); the
 * chain's letter is the first that is no folder or file name, in any case, of
 * the project's or any output's path in either spelling.
 */
export function snapshotLayout(
  projectPath: string,
  jobId: string,
  tmpRoot: string = os.tmpdir(),
  outputPaths: string[] = [],
  p: path.PlatformPath = path,
  real: (dir: string) => string = realOrSelf
): SnapshotLayout {
  const given = p.dirname(projectPath);
  const depth = Math.max(segments(given, p).length, segments(real(given), p).length) + SPARE_LEVELS;
  const used = new Set<string>();
  for (const f of [projectPath, ...outputPaths]) {
    const d = p.dirname(f);
    for (const s of [...segments(f, p), ...segments(real(d), p)]) used.add(s.toLowerCase());
  }
  let name = "";
  for (const c of CHAIN_NAMES) {
    if (!used.has(c)) {
      name = c;
      break;
    }
  }
  if (!name) {
    let n = 0;
    while (used.has(`m${n}`)) n++;
    name = `m${n}`;
  }
  const jobDir = jobFolder(tmpRoot, jobId, p);
  const snap = p.join(jobDir, ...new Array<string>(depth).fill(name), p.basename(projectPath));
  return { jobDir, snap, depth, name };
}

/** Levels from `dir` up to `anc`, or null when `anc` is not `dir` or above it. */
function levelsUp(anc: string, dir: string, p: path.PlatformPath): number | null {
  const rel = p.relative(anc, dir);
  if (rel === "") return 0;
  if (rel.startsWith("..") || p.isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).filter(Boolean).length;
}

/**
 * The chain folders aerender writes `outputPath` into if it resolves the
 * output's folder relative to the copy (#215): one per spelling (given, real)
 * of the project's and the output's folders in which the output's folder is
 * the project's or an ancestor of it. Empty for any other output — aerender
 * writes those by their absolute path.
 */
export function shadowDirs(
  outputPath: string,
  projectPath: string,
  layout: SnapshotLayout,
  p: path.PlatformPath = path,
  real: (dir: string) => string = realOrSelf
): string[] {
  const projDirs = [p.dirname(projectPath), real(p.dirname(projectPath))];
  const outDirs = [p.dirname(outputPath), real(p.dirname(outputPath))];
  const out: string[] = [];
  for (const pd of projDirs) {
    for (const od of outDirs) {
      const k = levelsUp(od, pd, p);
      if (k === null || k > layout.depth) continue;
      const dir = p.join(layout.jobDir, ...new Array<string>(layout.depth - k).fill(layout.name));
      if (!out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

/** The frame files of an `[####]` image-sequence name, or null when `base` is not one. */
function sequenceMatcher(base: string): RegExp | null {
  const seq = /\[(#+)\]/.exec(base);
  if (!seq) return null;
  const prefix = base.slice(0, seq.index);
  const suffix = base.slice(seq.index + seq[0].length);
  return new RegExp("^" + escapeRe(prefix) + "\\d+" + escapeRe(suffix) + "$");
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    // The temp folder and the output are on different volumes.
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/** Every file in a job folder other than the copy itself — output aerender wrote there. */
export function strayFiles(layout: SnapshotLayout): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 256) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (f !== layout.snap) out.push(f);
    }
  };
  walk(layout.jobDir, 0);
  return out;
}

/**
 * Move every file aerender wrote inside the job folder to the output it
 * belongs to (#215). The WHOLE job folder is scanned, not only the folders
 * `shadowDirs` predicts, so a resolution counted against a spelling of the
 * project's path this did not foresee is still caught. A file belongs to the
 * output whose file name it has (or whose `[####]` pattern it matches); when
 * two outputs share a name, the one whose predicted folder it is in. A file
 * no output claims is left, and reported by the caller through `strayFiles`.
 *
 * Called after every aerender exit — success, failure or cancel — so a file
 * is where the user asked whenever there is a file at all: a failure that
 * says "left in place", or a cancel that names the partial file, must be
 * true. Never throws: a move that fails is a problem the job reports, because
 * the file is about to be deleted with the copy.
 */
export function relocateShadowOutputs(
  outputs: RenderOutputPlan[],
  projectPath: string,
  layout: SnapshotLayout,
  /**
   * A cancelled render's partial output must never replace a file that was
   * there before the render: when this says so for a destination, the file
   * stays in the job folder and is named in `kept` — each file exactly, a
   * sequence's frames one by one — instead of being moved.
   */
  keep?: (dest: string) => boolean
): { moved: string[]; problems: string[]; kept: string[] } {
  const moved: string[] = [];
  const problems: string[] = [];
  const kept: string[] = [];
  const claims = outputs
    .filter((o): o is RenderOutputPlan & { path: string } => !!o.path)
    .map((o) => {
      const base = path.basename(o.path);
      const re = sequenceMatcher(base);
      return { o, seq: !!re, matches: (n: string) => (re ? re.test(n) : n === base), dirs: shadowDirs(o.path, projectPath, layout) };
    });
  for (const f of strayFiles(layout)) {
    const name = path.basename(f);
    let owners = claims.filter((c) => c.matches(name));
    if (owners.length > 1) owners = owners.filter((c) => c.dirs.includes(path.dirname(f)));
    if (owners.length !== 1) continue;
    const to = path.join(path.dirname(owners[0].o.path), name);
    if (keep?.(to)) {
      if (!kept.includes(f)) kept.push(f);
      continue;
    }
    try {
      moveFile(f, to);
      moved.push(to);
    } catch (e) {
      problems.push(
        `After Effects wrote ${to} into the render's private copy folder (${f}) and moving it out failed: ` +
          `${(e as Error).message}`
      );
    }
  }
  return { moved, problems, kept };
}

/** What a file looked like before a render, to tell it from one the render wrote. */
export interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

function stampOf(f: string): FileStamp | null {
  try {
    const st = fs.statSync(f);
    return st.isFile() ? { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The files in `o`'s folder that a `[####]` pattern names, or `[o]` itself. */
function outputFiles(o: string): string[] {
  const re = sequenceMatcher(path.basename(o));
  if (!re) return [o];
  try {
    return fs.readdirSync(path.dirname(o)).filter((n) => re.test(n)).map((n) => path.join(path.dirname(o), n));
  } catch {
    return [];
  }
}

/**
 * Every file an item's outputs could land on that exists before it renders —
 * a movie's path, every frame of a sequence's pattern — with its stamp. A
 * render with `overwrite:true` starts with these in place.
 */
export function stampOutputs(outputs: RenderOutputPlan[]): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>();
  for (const o of outputs) {
    if (!o.path) continue;
    for (const f of outputFiles(o.path)) {
      const st = stampOf(f);
      if (st) out.set(f, st);
    }
  }
  return out;
}

/** True when `f` is still exactly the file it was before the render: same inode, size and time. */
export function unchangedSince(f: string, before: Map<string, FileStamp>): boolean {
  const was = before.get(f);
  if (!was) return false;
  const now = stampOf(f);
  return !!now && now.ino === was.ino && now.size === was.size && now.mtimeMs === was.mtimeMs;
}

/**
 * The partial output a cancelled item left (#215 review): an output at the
 * asked path counts only when this render wrote it — a file that was there
 * before and is unchanged is a previous render's, complete, and never a
 * partial — plus anything `kept` in the job folder because the asked path
 * held such a file. Every file is named exactly — a sequence's frames one by
 * one, never by its pattern, which would also cover frames from an earlier
 * render that are left as they were (#217 review).
 */
export function cancelledPartials(
  outputs: RenderOutputPlan[],
  before: Map<string, FileStamp>,
  kept: string[] = []
): string[] {
  const found: string[] = [];
  for (const o of outputs) {
    if (!o.path) continue;
    for (const f of outputFiles(o.path)) {
      if (stampOf(f) && !unchangedSince(f, before) && !found.includes(f)) found.push(f);
    }
  }
  for (const k of kept) if (!found.includes(k)) found.push(k);
  return found;
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
/**
 * Mark a job's snapshot folder as in use, so a render longer than the sweep's
 * age limit is not mistaken for a leftover by another session's sweep. Called
 * as the job runs; never throws.
 */
export function touchSnapshot(jobDir: string, now: Date = new Date()): void {
  try { fs.utimesSync(jobDir, now, now); } catch {}
}

/** How often a running job refreshes its snapshot folder's age. */
const TOUCH_EVERY_MS = 60_000;

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
      // A plain file here is an output an older version let aerender write
      // into this folder (#215) — never anything a render still needs.
      if (now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (e) {
      logger.warn(`could not clear an old render snapshot at ${dir}: ${(e as Error).message}`);
    }
  }
  return removed;
}

/**
 * Remove a job's folder (`jobFolder`), copy and chain included — and nothing
 * else: a path that is not an `ae-mcp-render/<jobId>` folder is left alone.
 */
export function removeSnapshot(jobDir: string): void {
  if (path.basename(path.dirname(jobDir)) !== "ae-mcp-render") return;
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
}

/**
 * aerender lines that say footage could not be found.
 *
 * aerender has been seen to exit 0 with footage missing, rendering AE's
 * placeholder (colour bars) into the file — a file that exists, is fresh and
 * is not empty, so the on-disk check alone would accept it. Any such line
 * fails the item instead.
 *
 * MEASURED (AE 26.5, macOS, English) — the line aerender prints, verbatim, and
 * then it exits 0 with a corrupt file:
 *
 *   WARNING:After Effects warning: logged 9 errors, please check log.  First error was “error: Unable to Render: File Not Found /…/foot/pic.png”
 *
 * Note where the words are: inside the curly quotes. AE quotes the first
 * error's own text, so quoted spans cannot all be thrown away — the first
 * version of this did, and passed exactly the line it exists to catch.
 *
 * What keeps a good render from failing on a coincidence of words:
 *   - only aerender's diagnostic lines are read — `aerender ERROR:`,
 *     `aerender WARNING:`, `ERROR:`/`WARNING:` (with or without a space) —
 *     never a PROGRESS line, which echoes comp names and output paths;
 *   - a quoted span is removed UNLESS it is a quoted error (“error: …”), which
 *     is AE's own message, so a comp called "Cannot Find Me" is not read as a
 *     complaint while “error: Unable to Render: File Not Found …” is;
 *   - anything that looks like a path is removed, so an output at
 *     /renders/missing-source-v2.mov does not count.
 */
const DIAGNOSTIC_LINE = /^\s*(?:aerender\s+)?(?:ERROR|WARNING)\b\s*:?/i;
const MISSING_FOOTAGE_LINE =
  /file not found|could not (?:be )?(?:found|located)|unable to (?:find|locate)|cannot find/i;

/** A diagnostic line with its quoted names and paths taken out. */
export function stripNamesAndPaths(line: string): string {
  return line
    .replace(/“([^”]*)”|"([^"]*)"|‘([^’]*)’|'([^']*)'/g, (_m, a, b, c, d) => {
      const inner = String(a ?? b ?? c ?? d ?? "");
      return /^\s*error\s*:/i.test(inner) ? " " + inner + " " : " ";
    })
    // Any token holding a path separator, a drive letter, or a file extension.
    .replace(/(?:[A-Za-z]:)?[^\s:]*[\\/][^\s]*/g, " ")
    .replace(/\S+\.[A-Za-z0-9]{2,5}\b/g, " ");
}

export function isMissingFootageLine(line: string): boolean {
  if (!DIAGNOSTIC_LINE.test(line)) return false;
  const text = stripNamesAndPaths(line.replace(DIAGNOSTIC_LINE, " "));
  if (MISSING_FOOTAGE_LINE.test(text)) return true;
  // "Footage file missing", "missing footage", "media is missing", …
  return /\bmissing\b/i.test(text) && /\b(?:footage|file|files|media|source)\b/i.test(text);
}

/**
 * How many errors After Effects says it logged during the render, from the
 * measured summary line (above): `After Effects warning: logged 9 errors`.
 * 0 for every other line. Any error logged means the file cannot be trusted —
 * the live run's file had no readable duration — even when the first error is
 * not one this server recognises.
 */
export function loggedErrorCount(line: string): number {
  if (!DIAGNOSTIC_LINE.test(line)) return 0;
  const m = /\blogged\s+(\d+)\s+errors?\b/i.exec(stripNamesAndPaths(line));
  return m ? Number(m[1]) : 0;
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
 * The absolute footage paths a saved project records (issue #145).
 *
 * After Effects stores two paths for every footage file — an absolute one and
 * one relative to the project — and opens the absolute one first. The render
 * reads a copy of the project in the temp folder, where the relative path
 * points nowhere. So footage the user's After Effects found only through the
 * relative path (the project folder was moved and has not been saved since) is
 * footage the copy cannot find: aerender renders the missing-footage
 * placeholder, and only its English wording ever said so.
 *
 * MEASURED on .aep files saved by 26.x on macOS (RIFX, big-endian): each
 * footage item holds a LIST `Als2` whose `alas` chunk is UTF-8 JSON —
 *   {"ascendcount_base":1,"ascendcount_target":3,"fullpath":"/Users/…/pop.wav",
 *    "platform":2,"server_name":"","server_volume_name":"","target_is_folder":false}
 * `fullpath` is the absolute path; the ascend counts are the relative one. An
 * .aepx is assumed to carry the same as `fullpath="…"` attributes on a
 * `<fileReference>` (not measured; character references are decoded). This is
 * a byte scan, not a parse of the format: a chunk it does not recognise is
 * passed over, and `records` says how many were read, so a file this cannot
 * read is known as such rather than mistaken for one with no footage.
 */
export interface StoredFootagePaths {
  paths: string[];
  folders: string[];
  records: number;
}

/** The longest `alas` record read; anything larger is not one. */
const MAX_ALIAS_RECORD = 1 << 20;

/**
 * Scan `data` for `alas` records whose tag starts before `limit`, into `out`.
 * A record has to lie wholly inside `data`; the chunked reader keeps an
 * overlap longer than any record, so one cut by a chunk edge is read whole
 * from the next pass.
 */
function scanAliasRecords(data: Buffer, limit: number, out: StoredFootagePaths): void {
  const tag = Buffer.from("alas", "latin1");
  let at = data.indexOf(tag);
  while (at !== -1 && at < limit && at + 8 <= data.length) {
    const size = data.readUInt32BE(at + 4);
    const start = at + 8;
    if (size > 0 && size < MAX_ALIAS_RECORD && start + size <= data.length && data[start] === 0x7b /* { */) {
      try {
        const rec = JSON.parse(data.toString("utf8", start, start + size).replace(/\0+$/, "")) as {
          fullpath?: unknown;
          target_is_folder?: unknown;
        };
        if (typeof rec.fullpath === "string") {
          out.records++;
          (rec.target_is_folder === true ? out.folders : out.paths).push(rec.fullpath);
        }
      } catch {
        // Not an alias record after all; keep scanning.
      }
    }
    at = data.indexOf(tag, at + 4);
  }
}

/** XML character references and the five named entities, as an .aepx attribute holds them. */
function decodeXmlAttr(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function storedFootagePaths(bytes: Buffer, isXml = false): StoredFootagePaths {
  const out: StoredFootagePaths = { paths: [], folders: [], records: 0 };
  if (isXml) {
    const text = bytes.toString("utf8");
    for (const m of text.matchAll(/<fileReference\b[^>]*>/g)) {
      const full = /\bfullpath="([^"]*)"/.exec(m[0]);
      if (!full) continue;
      out.records++;
      (/\btarget_is_folder="(?:1|true)"/.test(m[0]) ? out.folders : out.paths).push(decodeXmlAttr(full[1]));
    }
    return out;
  }
  scanAliasRecords(bytes, bytes.length, out);
  return out;
}

/**
 * `storedFootagePaths` for a file on disk, read in chunks: an .aep with
 * embedded media can be several gigabytes, past what `readFileSync` will hold
 * in one Buffer, and reading it whole would refuse exactly the projects that
 * have the most footage. Null when the file cannot be read at all. An .aepx
 * (text) is read whole up to 512 MB and reported unreadable above that.
 */
export function readStoredFootagePaths(
  projectPath: string,
  chunkSize = 16 << 20,
  /** How far a record may run past a chunk's edge; a test shrinks it to exercise the edges. */
  maxRecord = MAX_ALIAS_RECORD
): StoredFootagePaths | null {
  const out: StoredFootagePaths = { paths: [], folders: [], records: 0 };
  let fd: number | null = null;
  try {
    if (/\.aepx$/i.test(projectPath)) {
      if (fs.statSync(projectPath).size > 512 << 20) return out;
      return storedFootagePaths(fs.readFileSync(projectPath), true);
    }
    fd = fs.openSync(projectPath, "r");
    const overlap = maxRecord + 16;
    const chunk = Buffer.alloc(chunkSize);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunkSize, null);
      const last = n === 0;
      const data = n ? Buffer.concat([carry, chunk.subarray(0, n)]) : carry;
      // Tags before `limit` are decided now; the rest, and any record that
      // might run past the end of `data`, are carried into the next pass.
      const limit = last ? data.length : Math.max(0, data.length - overlap);
      scanAliasRecords(data, limit, out);
      if (last) break;
      carry = Buffer.from(data.subarray(limit));
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * One spelling for a path, so a stored path and a resolved one compare equal
 * when they name the same file: Unicode NFC (Finder hands out NFD), forward
 * slashes, no trailing slash, and on Windows no case and `/c/…` read as `c:/…`.
 */
export function canonicalFootagePath(p: string, platform: NodeJS.Platform = process.platform): string {
  let s = p.normalize("NFC");
  if (platform === "win32") s = s.replace(/\\/g, "/").toLowerCase().replace(/^\/([a-z])\//, "$1:/");
  return s.replace(/\/+$/, "");
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export interface FootageCheck {
  /** Footage After Effects still shows, whose file is no longer on disk. */
  gone: FootageRef[];
  /** Footage on disk that the saved project does not record at any path leading to it. */
  stale: FootageRef[];
  /**
   * The items read footage, and no footage path at all could be read from the
   * saved file (a format this does not know, or a file it cannot open). The
   * render goes ahead on the older checks, with a warning — see footageWarning.
   */
  unreadable: boolean;
}

/** Every file-backed footage the plan's items read, once each. */
function planFootage(plan: RenderPlan): FootageRef[] {
  const used = new Map<string, FootageRef>();
  for (const item of plan.items) for (const f of item.footage ?? []) if (!used.has(f.path)) used.set(f.path, f);
  return [...used.values()];
}

/**
 * Footage After Effects still shows whose file is no longer on disk. Measured
 * on 26.5: a file deleted while the project is open reads as present
 * (`footageMissing` false) until the project is reopened. Nothing a save
 * writes changes this, so it is checked before any save.
 */
export function goneFootage(plan: RenderPlan): FootageRef[] {
  return planFootage(plan).filter((f) => !fs.existsSync(f.path));
}

/**
 * Check every file the plan's items read against the disk and against the
 * paths the SAVED project records (issue #145). Language-independent by
 * construction: nothing here reads aerender's output.
 *
 * Only meaningful on a file that holds the project as it is now — call it
 * after any save, never on the file a dirty project is about to replace: the
 * old file does not record footage imported since, and would call it stale.
 *
 *  - `gone`: see goneFootage.
 *  - `stale`: the file is on disk, but no absolute path the saved project
 *    records leads to it — After Effects found it through the relative path,
 *    which the temp copy cannot follow. A save fixes it: After Effects writes
 *    the absolute path it resolved.
 *  - `unreadable`: the items read footage and no footage path could be read
 *    from the file. Reported, not refused: see footageWarning.
 */
export function checkPlanFootage(
  plan: RenderPlan,
  projectPath: string,
  platform: NodeJS.Platform = process.platform
): FootageCheck {
  const gone: FootageRef[] = [];
  const present: FootageRef[] = [];
  for (const f of planFootage(plan)) (fs.existsSync(f.path) ? present : gone).push(f);
  if (!present.length) return { gone, stale: [], unreadable: false };

  const stored = readStoredFootagePaths(projectPath);
  if (!stored || !stored.records) return { gone, stale: [], unreadable: true };
  const canon = (p: string) => canonicalFootagePath(p, platform);
  const files = new Set<string>();
  for (const p of stored.paths) {
    files.add(canon(p));
    // /tmp and /private/tmp, a symlinked volume: one file under two names.
    if (fs.existsSync(p)) files.add(canon(realOrSelf(p)));
  }
  const folders = stored.folders.map((d) => canon(d) + "/");
  const stale = present.filter((f) => {
    const a = canon(f.path);
    const b = canon(realOrSelf(f.path));
    if (files.has(a) || files.has(b)) return false;
    return !folders.some((d) => a.startsWith(d) || b.startsWith(d));
  });
  return { gone, stale, unreadable: false };
}

/**
 * Why a render must not start, given a footage check — or null when it may.
 *
 * `gone` refuses outright: no save brings a deleted file back. `stale` is
 * fixed by a save, so before one it refuses unless the caller passed
 * saveProject:true (the save is never a surprise, the same rule as unsaved
 * changes), and after one — `afterSave`, the check run on the file just
 * written — any stale path left means the save did not record it, and it
 * refuses rather than render. `unreadable` never refuses: see footageWarning.
 * Refusing over rendering from a copy beside the original: see "Footage the
 * copy cannot find" in docs/fragile-areas-ae.md.
 */
export function footageRefusal(check: FootageCheck, opts: { saveProject: boolean; afterSave: boolean }): string | null {
  const lead = opts.afterSave ? "The project WAS saved, but nothing was rendered: " : "Nothing was saved or rendered: ";
  if (check.gone.length) {
    return (
      lead +
      `After Effects still shows this footage as present, but its file is no longer on disk: ${footageList(check.gone)}. ` +
      "It was moved, renamed or deleted while the project was open — After Effects only notices when the project " +
      "is reopened, and the render would carry the missing-footage placeholder. Ask the user to put the file back " +
      "or relink it (File > Dependencies > Find Missing Footage), then call render_queue again."
    );
  }
  if (check.stale.length && opts.afterSave) {
    return (
      lead +
      `the saved file still does not record where this footage is: ${footageList(check.stale)}. The render reads a ` +
      "copy of the project in the temp folder, which can only find footage by the absolute path the project " +
      "records. Ask the user to relink the footage (File > Dependencies > Find Missing Footage) and save, then " +
      "call render_queue again."
    );
  }
  if (check.stale.length && !opts.saveProject) {
    return (
      lead +
      `After Effects found this footage only through its path relative to the project, which usually means the ` +
      `project folder was moved and has not been saved since: ${footageList(check.stale)}. The render reads a copy ` +
      "of the project in the temp folder, where that relative path leads nowhere, so it would render the " +
      "missing-footage placeholder. Saving makes After Effects record where the files are now: tell the user the " +
      "project will be saved, then call render_queue again with saveProject:true."
    );
  }
  return null;
}

/**
 * The warning a render carries when the saved file's footage paths could not
 * be read — FAIL-OPEN, deliberately. An unreadable file is a project format
 * this does not know (an older project, an .aepx, a future AE), not evidence
 * of moved footage, and refusing it would refuse every render with footage
 * from such a project. The render goes ahead on what held before #145:
 * `footageMissing` up front, the on-disk check above, aerender's
 * missing-footage and logged-error lines, and the judging of the file. What
 * that leaves open is one case — a project moved and not saved, in a format
 * this cannot read, on a non-English AE, in an output format the file judge
 * cannot inspect — and the warning names it so the agent can tell the user.
 */
export function footageWarning(check: FootageCheck): string | null {
  if (!check.unreadable) return null;
  return (
    "The footage paths in the saved project could not be read (a project format this server does not know), so " +
    "it could not check that the render's copy of the project finds every file. If the project folder was moved " +
    "since it was last saved, the render may show the missing-footage placeholder — open the output and look, or " +
    "have the user save the project first."
  );
}

/**
 * render_queue's refusals and save, in the order that makes each one true.
 *
 * The order is the point (review of #146). The saved-path check reads the
 * .aep on disk, so on a project with unsaved changes it must run AFTER the
 * save: before it, the file is the old one, which does not record footage
 * imported since — a new project, an import, then a render would be called
 * "moved since saved", or unreadable. So:
 *   1. unsaved changes without saveProject → the unsaved-changes refusal;
 *   2. footage gone from disk → refused (no save brings it back);
 *   3. a CLEAN project's file is checked now: stale paths refuse without
 *      saveProject, and with it the project is saved (`force`);
 *   4. read-only, then `beforeSave` (resolving aerender — anything that can
 *      refuse does so before the save), then the save;
 *   5. after any save, the file just written is checked, and a path it still
 *      does not record refuses with "The project WAS saved".
 * An unreadable file never refuses; it comes back as `pathsWarning`.
 */
export async function saveAndCheckFootage(opts: {
  plan: RenderPlan;
  saveProject: boolean;
  readOnly?: boolean | null;
  save: (force: boolean) => Promise<{ saved: boolean }>;
  beforeSave?: () => void;
  platform?: NodeJS.Platform;
}): Promise<{ saved: boolean; savedForFootage: boolean; pathsWarning: string | null }> {
  const { plan, saveProject } = opts;
  const dirty = plan.dirty === true;
  if (dirty && !saveProject) {
    throw new Error(
      "The project has unsaved changes, and the render reads the saved file, so it would not contain them. " +
        "Nothing was saved or rendered. Tell the user the project will be saved, then call render_queue again " +
        "with saveProject:true — or ask them to save it themselves."
    );
  }
  const gone = goneFootage(plan);
  if (gone.length) {
    throw new Error(footageRefusal({ gone, stale: [], unreadable: false }, { saveProject, afterSave: false }) as string);
  }
  const pre = dirty ? null : checkPlanFootage(plan, plan.projectPath, opts.platform);
  if (pre) {
    const refused = footageRefusal(pre, { saveProject, afterSave: false });
    if (refused) throw new Error(refused);
  }
  const stale = !!pre && pre.stale.length > 0;
  const needSave = dirty || stale;
  if (needSave && opts.readOnly === true) {
    throw new Error(
      `The project file ${plan.projectPath} is read-only and ` +
        (dirty ? "has unsaved changes" : "records footage at paths that have moved") +
        ", so it cannot be saved for the render. Nothing was rendered. Ask the user to make it writable or Save As " +
        "somewhere else."
    );
  }
  opts.beforeSave?.();
  if (!needSave) return { saved: false, savedForFootage: false, pathsWarning: pre ? footageWarning(pre) : null };
  // `force` only for a clean project: a dirty one is saved anyway, and its
  // dirty flag is what proves the save happened.
  const save = await opts.save(!dirty);
  // A clean project's dirty flag cannot show whether the save happened, and a
  // dirty one's old file never held the new footage: read what was written.
  const post = checkPlanFootage(plan, plan.projectPath, opts.platform);
  const refused = footageRefusal(post, { saveProject: true, afterSave: true });
  if (refused) throw new Error(refused);
  return { saved: save.saved, savedForFootage: stale, pathsWarning: footageWarning(post) };
}

/** Footage for a message: at most `cap` of them, then how many more. */
export function footageList(refs: FootageRef[], cap = 10): string {
  const shown = refs.slice(0, cap).map((f) => `"${f.name}" (${f.path})`);
  return shown.join(", ") + (refs.length > cap ? ` and ${refs.length - cap} more` : "");
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
/** After aerender exits and no render process for the job is left, how long the pipe may stay open. */
const CLOSE_WAIT_MS = 2000;
/** The cap on that whole wait while an engine for the job is still alive. */
const DRAIN_CAP_MS = 60_000;
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
  private readonly findEngines: (snapshotPath: string) => Promise<number[]>;
  private readonly drainCapMs: number;
  private readonly confirmEngine: (pid: number, snapshotPath: string) => Promise<boolean>;
  private readonly interpreter?: string;
  private disarm: (() => void) | null = null;

  constructor(private jobs: JobManager, opts: RenderRunnerOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.onRendered = opts.onRendered;
    this.tmpRoot = opts.tmpRoot ?? os.tmpdir();
    this.stop = opts.stop ?? ((pid, force) => stopProcessTree(pid, force));
    this.findEngines = opts.findEngines ?? ((snap) => findRenderProcesses(snap));
    this.confirmEngine = opts.confirmEngine ?? ((pid, snap) => isStillRenderProcess(pid, snap));
    this.drainCapMs = opts.drainCapMs ?? DRAIN_CAP_MS;
    this.interpreter = opts.interpreter;
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
    const outputPaths = plan.items.flatMap((i) => i.outputs.map((o) => o.path).filter((x): x is string => !!x));
    const layout = snapshotProject(plan.projectPath, jobId, this.tmpRoot, outputPaths);
    const snapshot = layout.snap;
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
      layout,
      touchedAt: Date.now(),
      relocateProblems: [],
      before: new Map(),
      kept: [],
      cancelDone: null,
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
        r.before = stampOutputs(item.outputs);
        r.touchedAt = itemStart;
        touchSnapshot(r.layout.jobDir);
        const outcome = await this.renderItem(r, item, label);
        // Before any verdict, and before a cancel's: an output aerender
        // resolved relative to the copy is in the job folder, and goes where
        // it was asked (#215) — a partial one too, so a cancel can name it.
        const relocated = this.relocate(r, item);
        if (r.cancelled) break;
        if (relocated.problems.length) {
          status = "failed";
          r.settled = true;
          await this.unqueue(r);
          this.jobs.fail(
            r.jobId,
            `aerender finished ${label} but its output could not be put where it was asked: ` +
              `${relocated.problems.join("; ")}. Nothing is claimed rendered for that item.` +
              this.renderedSoFar(r) +
              this.unqueueText(r)
          );
          return;
        }
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
            `aerender finished ${label} (exit ${outcome.code}) but reported ` +
              (outcome.missing.some(isMissingFootageLine) ? "missing footage" : "errors logged during the render") +
              `, so the file at ${item.outputs.map((x) => x.path).join(", ")} cannot be trusted — it may hold ` +
              `After Effects' missing-footage placeholder, or be unreadable. It is NOT reported as rendered. The file ` +
              `was left in place: if the user opens it and judges the errors below harmless, it is theirs to use. ` +
              `aerender said: ` +
              `${outcome.missing.join(" | ")}.` +
              missingFootageHint(outcome.missing) +
              this.renderedSoFar(r) +
              this.unqueueText(r)
          );
          return;
        }
        const checked = verifyOutputs(item.outputs, itemStart);
        const verified = checked.verified;
        const problems = [...checked.problems, ...renderEvidenceProblems(item, r.itemFrames, verified)];
        if (problems.length) {
          status = "failed";
          r.settled = true;
          await this.unqueue(r);
          const stray = strayFiles(r.layout);
          this.jobs.fail(
            r.jobId,
            `aerender reported success on ${label} but the output cannot be verified: ${problems.join("; ")}. ` +
              `Nothing is claimed rendered for that item.` +
              (stray.length
                ? ` aerender wrote ${stray.slice(0, 5).join(", ")} inside the render's private copy folder, which is ` +
                  `deleted as the job ends — After Effects resolved an output path relative to the copy in a way ` +
                  `this server did not foresee (issue #215).`
                : "") +
              (outcome.errors.length ? ` aerender's error lines: ${outcome.errors.join(" | ")}.` : "") +
              ` Last output: ${outcome.tail.join(" | ")}` +
              this.renderedSoFar(r) +
              this.unqueueText(r)
          );
          return;
        }
        // The count reported is never lower than what the file proves: the
        // live run (26.5) read 26–29 of 30 progress lines on 6 of 14 good
        // renders — late or coalesced lines — while the files were complete.
        const onDisk = verifiedFrameCount(item, verified);
        const frames = Math.max(r.itemFrames, onDisk ?? 0);
        const done: RenderedItem = {
          index: item.index,
          compName: item.compName,
          outputs: verified,
          frames,
          ...(onDisk !== null ? { framesVerified: onDisk } : {}),
          elapsedMs: Date.now() - itemStart,
          ...(item.footageWarnings?.length ? { footageWarnings: item.footageWarnings } : {}),
        };
        if (r.itemFrames === 0) {
          done.framesNote =
            "aerender printed no frame line this server can read (an After Effects in another language words " +
            "them differently), so this item was verified from the file alone: its frame files, or its movie " +
            "index and duration against the render span.";
        } else if (item.frames > 0 && frames !== item.frames) {
          done.framesNote =
            `${frames} frames where the comp's span at its own frame rate is ${item.frames} — ` +
            "expected when the render settings override the frame rate or skip frames; otherwise worth a look.";
        }
        r.rendered.push(done);
        r.framesBefore += Math.max(item.frames, r.itemFrames);
      }
      if (r.cancelled) {
        status = "cancelled";
        // cancel() is still stopping the engine, which may yet write the
        // partial file into the job folder; that folder must not be removed
        // under it (#215 review: a cancelled partial beside the project was
        // deleted with the copy, and partialFiles came back empty).
        if (r.cancelDone) await r.cancelDone;
        // Normally cancel() has settled the job with its own report. When it
        // could not see the process exit it reported stopped:false and left the
        // job open — and this is that exit, arriving late. Settle it here, or
        // await_job waits for ever on a render that is over.
        if (!r.settled && r.cancelGaveUp) {
          r.settled = true;
          const cut = r.plan.items[r.itemPos];
          if (cut) this.relocate(r, cut);
          await this.unqueue(r);
          this.jobs.cancel(r.jobId, {
            jobId: r.jobId,
            stopped: true,
            wasRunning: true,
            rendered: r.rendered,
            partialFiles: cut ? cancelledPartials(cut.outputs, r.before, r.kept) : [],
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
      removeJobFolder(r);
      this.disarm?.();
      // Last, because it is the one async step: the job is settled and its
      // copy gone by now, and an engine that outlived aerender (see cancel)
      // has nothing left to render from, but must still not outlive the job.
      await this.reapEngines(r);
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

  /** `relocateShadowOutputs` for one item, remembering what could not be moved. */
  private relocate(r: Running, item: RenderItemPlan): { moved: string[]; problems: string[] } {
    // A cancelled item's output is partial: it never replaces a file that was
    // there before the render, which is a previous render's and complete.
    const keep = r.cancelled ? (dest: string) => unchangedSince(dest, r.before) : undefined;
    const res = relocateShadowOutputs(item.outputs, r.plan.projectPath, r.layout, keep);
    for (const k of res.kept) if (!r.kept.includes(k)) r.kept.push(k);
    if (res.moved.length) {
      logger.info(`render ${r.jobId}: moved ${res.moved.length} output file(s) out of the copy's folder (#215)`);
    }
    for (const x of res.problems) if (!r.relocateProblems.includes(x)) r.relocateProblems.push(x);
    return res;
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
        const args = aerenderArgs(r.snapshot, item.index);
        child = spawn(this.interpreter ?? r.aerender, this.interpreter ? [r.aerender, ...args] : args, {
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
        // Settle on `close`, which comes only once stdout and stderr have both
        // drained — never on `exit`, which can come first. Two live runs on
        // 26.5 showed why: one counted 299 of 300 frames, and one (1 in 8)
        // reported a missing-footage render as completed because the WARNING
        // line, printed last, had not been read when the item was decided.
        //
        // `close` can be held off by a render engine that inherited the pipe
        // and outlives aerender. Waiting for it is right while that engine is
        // alive — it may still write the line that matters — so after `exit`
        // the wait only gives up once no render process for this job is left
        // and the pipe has stayed open for CLOSE_WAIT_MS more.
        let closed = false;
        child.on("close", (code, signal) => {
          closed = true;
          finish(code, signal);
        });
        child.on("exit", (code, signal) => {
          let quietSince = 0;
          const exitedAt = Date.now();
          const poll = async () => {
            if (closed || settled) return;
            // Never for ever: an engine stuck after aerender has gone would
            // hold this wait, and the job, open indefinitely. Past the cap it
            // is killed (the same name-and-path matcher cancel uses) and the
            // item is decided on what was read — which the file checks then
            // judge on their own.
            if (Date.now() - exitedAt >= this.drainCapMs) {
              const n = await this.signalEngines(r, true).catch(() => 0);
              logger.warn(`render ${r.jobId}: output still open ${Math.round(this.drainCapMs / 1000)}s after aerender exited; killed ${n} render engine process(es) and deciding on what was read`);
              finish(code, signal);
              return;
            }
            const engines = await this.findEngines(r.snapshot).catch(() => []);
            if (engines.length) quietSince = 0;
            else if (!quietSince) quietSince = Date.now();
            if (quietSince && Date.now() - quietSince >= CLOSE_WAIT_MS) {
              logger.warn(`render ${r.jobId}: aerender exited but its output pipe stayed open with no render process left; deciding on what was read`);
              finish(code, signal);
              return;
            }
            setTimeout(() => void poll(), 250).unref?.();
          };
          setTimeout(() => void poll(), 250).unref?.();
        });
      });
      const onLine = (line: string) => {
        tail.push(line.trim());
        if (tail.length > TAIL_LINES) tail.shift();
        if ((isMissingFootageLine(line) || loggedErrorCount(line) > 0) && missing.length < 20) missing.push(line.trim());
        const parsed = parseAerenderLine(line);
        if (parsed.kind === "frame") {
          r.itemFrames++;
          if (Date.now() - r.touchedAt >= TOUCH_EVERY_MS) {
            r.touchedAt = Date.now();
            touchSnapshot(r.layout.jobDir);
          }
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
   * Two things have to stop, and the live run (AE 26.5, macOS) showed they are
   * not one tree: aerender, and the render engine it launches — aerendercore,
   * with PPID 1 and a process group of its own, which ignored SIGTERM for 8s and
   * kept rendering at 3 GB after aerender was gone. Signalling aerender's group
   * reached aerender only. So the engine is found by the job's snapshot path on
   * its command line (`findRenderProcesses`), both are asked to stop, and
   * anything still alive after `graceMs` is killed outright.
   *
   * `stopped` is only true when aerender has been *seen* to exit AND no process
   * carrying this job's snapshot path is left: a signal sent is not a render
   * stopped, and a cancel that reports success while the engine keeps writing
   * frames is the lie this exists to avoid. On Windows, `taskkill /T /F` takes
   * aerender's tree and the same command-line lookup covers an engine that is
   * not in it — UNVERIFIED there (recipe 60).
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
    if (r.settled) {
      // The job's outcome is already decided — every item rendered, or the
      // job failed — and only its last steps (unticking the queue) remain.
      // Nothing is rendering, and nothing it wrote is partial (#217 review).
      return {
        jobId,
        stopped: false,
        wasRunning: false,
        status: "finishing",
        note: "This render had already finished and was only tidying up the Render Queue — there was nothing to cancel. await_job or get_job returns its outcome.",
      };
    }
    if (r.cancelDone) {
      // A second cancel while the first is still stopping: wait for it, then
      // answer from where things stand (finished, or this cancel tries again).
      await r.cancelDone;
      if (this.current !== r) return this.cancel(jobId);
    }
    let done = () => {};
    r.cancelDone = new Promise<void>((res) => (done = res));
    try {
      return await this.cancelRunning(r);
    } finally {
      done();
    }
  }

  private async cancelRunning(r: Running): Promise<CancelReport> {
    const jobId = r.jobId;
    r.cancelled = true;
    // An item already verified and listed in `rendered` is not interrupted,
    // whatever itemPos still says: its files are finished work.
    const pos = r.plan.items[r.itemPos];
    const item = pos && !r.rendered.some((x) => x.index === pos.index) ? pos : undefined;
    const child = r.child;
    const exited = r.exited;
    let aerenderGone = true;
    let survivors: number[] = [];
    if (child && child.pid !== undefined && exited) {
      // Polite first: aerender's tree, and every engine for this job.
      await this.stop(child.pid, false);
      await this.signalEngines(r, false);
      aerenderGone = await within(exited, this.graceMs);
      survivors = await this.engineSurvivors(r, this.graceMs);
      if (!aerenderGone || survivors.length) {
        // Then not: SIGKILL (Windows: taskkill /F, which was already forceful).
        if (!aerenderGone) await this.stop(child.pid, true);
        await this.signalEngines(r, true);
        if (!aerenderGone) aerenderGone = await within(exited, this.graceMs);
        survivors = await this.engineSurvivors(r, this.graceMs);
      }
    } else {
      // Between two items there is no aerender, but an engine could linger.
      await this.signalEngines(r, true);
      survivors = await this.engineSurvivors(r, this.graceMs);
    }
    const stopped = aerenderGone && survivors.length === 0;
    // From here on the late exit, if it ever comes, is run()'s to settle —
    // run() waits for this cancel to finish before it looks (cancelDone).
    if (!stopped) r.cancelGaveUp = true;
    // run() relocates as aerender exits; this catches what an engine that
    // outlived aerender wrote after that (#215).
    if (item) this.relocate(r, item);
    const partialFiles = item ? cancelledPartials(item.outputs, r.before, r.kept) : [];
    const leftAlone = item ? [...r.before.keys()].filter((f) => unchangedSince(f, r.before)) : [];
    const moved = partialFiles.filter((f) => !r.kept.includes(f));
    const list = (fs_: string[]) => fs_.slice(0, 10).join(", ") + (fs_.length > 10 ? ` and ${fs_.length - 10} more` : "");
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
        ? "aerender and its render engine were stopped and have exited; no later item was started. " +
          (partialFiles.length
            ? `The interrupted item's output is INCOMPLETE: exactly the ${partialFiles.length} file(s) in \`partialFiles\` — tell the user, or delete those files by name (never by a folder or a [####] pattern), rather than presenting them as a render. `
            : "No partial output was found on disk. ") +
          (moved.length ? `At the asked location: ${list(moved)}. ` : "") +
          (r.kept.length
            ? `In the temp folder, because a file from before this render was at the asked path and was NOT replaced: ${list(r.kept)}. ` +
              "These are cleared by the first render_queue started a day or more from now. "
            : "") +
          (leftAlone.length
            ? `Not partial — these existed before this render and are unchanged; do not delete them: ${list(leftAlone)}. `
            : "") +
          (r.relocateProblems.length
            ? `Part of the output could not be moved out of the render's private copy folder, which is deleted: ${r.relocateProblems.join("; ")}. `
            : "") +
          (r.rendered.length ? "Items listed in `rendered` finished and were verified before the cancel." : "No item had finished.")
        : (aerenderGone ? "" : `aerender (pid ${child?.pid}) did not exit after being told to stop and then killed. `) +
          (survivors.length
            ? `Render engine process(es) ${survivors.join(", ")} for this job are still alive after SIGTERM and SIGKILL. `
            : "") +
          "The render may still be running. Ask the user to end any aerender / aerendercore (Windows: aerender.exe, " +
          "AfterFX) process in Activity Monitor or Task Manager.",
    };
    if (stopped && !r.settled) {
      r.settled = true;
      await this.unqueue(r);
      this.jobs.cancel(jobId, report);
    }
    return report;
  }

  /**
   * Signal this job's render processes, each re-checked by name and arguments
   * the moment before — a pid found a second ago may belong to something else
   * now. Returns how many were signalled.
   */
  private async signalEngines(r: Running, force: boolean): Promise<number> {
    let n = 0;
    for (const pid of await this.findEngines(r.snapshot)) {
      if (!(await this.confirmEngine(pid, r.snapshot))) continue;
      await stopPid(pid, force);
      n++;
    }
    return n;
  }

  /** Engine processes for this job still alive after waiting up to `ms` for them to go. */
  private async engineSurvivors(r: Running, ms: number): Promise<number[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const alive = (await this.findEngines(r.snapshot)).filter(pidAlive);
      if (!alive.length || Date.now() >= deadline) return alive;
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  /** After a job ends, however it ends: no engine for it may outlive it. */
  private async reapEngines(r: Running): Promise<void> {
    try {
      const n = await this.signalEngines(r, true);
      if (n) logger.warn(`render ${r.jobId}: killed ${n} render engine process(es) left after the job ended`);
    } catch {}
  }

  private killSync(): void {
    const r = this.current;
    const pid = r?.child?.pid;
    if (pid !== undefined) stopProcessTreeSync(pid);
    // The engine is outside aerender's tree (see cancel), so it is found by
    // the snapshot path; SIGKILL, because nothing async runs here.
    if (r) {
      for (const p of findRenderProcessesSync(r.snapshot)) {
        if (isStillRenderProcessSync(p, r.snapshot)) stopPidSync(p);
      }
    }
    if (r) {
      // A partial output in the job folder goes where it was asked, not with the copy (#215).
      const cut = r.plan.items[r.itemPos];
      if (cut) {
        const res = relocateShadowOutputs(cut.outputs, r.plan.projectPath, r.layout, (dest) => unchangedSince(dest, r.before));
        for (const k of res.kept) if (!r.kept.includes(k)) r.kept.push(k);
      }
      removeJobFolder(r);
    }
  }
}

/**
 * The end of a job: its folder goes, copy and chain — unless a cancelled
 * item's partial output was kept in it (see Running.kept), in which case only
 * the copy goes and the folder is left for the stale sweep of the first render
 * started a day or more later.
 */
function removeJobFolder(r: Running): void {
  if (!r.kept.length) {
    removeSnapshot(r.layout.jobDir);
    return;
  }
  try { fs.rmSync(r.snapshot, { force: true }); } catch {}
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

