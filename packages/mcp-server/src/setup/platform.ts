import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** CEP major versions After Effects may look at, newest first. */
export const CSXS_VERSIONS = [12, 11, 10, 9];

/**
 * Everything that differs between macOS and Windows lives here, so the rest of
 * the setup code stays platform-neutral.
 *
 * The two hosts diverge in exactly five places:
 *   - where the "allow unsigned extensions" flag is stored (defaults vs registry),
 *     and CEP's LogLevel beside it
 *   - how you ask whether After Effects is running (pgrep vs tasklist)
 *   - the CEP extensions directory (see paths.ts)
 *   - where CEP writes its own log (see cepLogDir below)
 *   - where `aerender` lives and how a render it is running is stopped
 *     (see "aerender" at the bottom — render_queue, issue #137)
 */

export async function isDebugModeOn(): Promise<{ on: boolean; detail: string }> {
  for (const v of CSXS_VERSIONS) {
    try {
      if (process.platform === "win32") {
        const { stdout } = await exec("reg", [
          "query", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode",
        ]);
        // `reg query` prints: PlayerDebugMode    REG_SZ    1
        if (/PlayerDebugMode\s+REG_SZ\s+1\b/.test(stdout)) {
          return { on: true, detail: `enabled (CSXS.${v})` };
        }
      } else {
        const { stdout } = await exec("defaults", [
          "read", `com.adobe.CSXS.${v}`, "PlayerDebugMode",
        ]);
        if (stdout.trim() === "1") return { on: true, detail: `enabled (CSXS.${v})` };
      }
    } catch {
      // Key absent for this CEP version — keep looking.
    }
  }
  return { on: false, detail: "not enabled for any CSXS version" };
}

/** Returns the CEP versions successfully flagged. */
export async function enableDebugMode(): Promise<number[]> {
  const enabled: number[] = [];
  for (const v of CSXS_VERSIONS) {
    try {
      if (process.platform === "win32") {
        await exec("reg", [
          "add", `HKCU\\Software\\Adobe\\CSXS.${v}`,
          "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f",
        ]);
      } else {
        await exec("defaults", [
          "write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1",
        ]);
      }
      enabled.push(v);
    } catch {
      // Some CEP versions simply are not present on this machine.
    }
  }
  return enabled;
}

export async function isAfterEffectsRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"]);
      return /AfterFX\.exe/i.test(stdout);
    }
    const { stdout } = await exec("pgrep", ["-f", "Adobe After Effects"]);
    return stdout.trim().length > 0;
  } catch {
    // pgrep exits non-zero when nothing matches; tasklist can too.
    return false;
  }
}

/**
 * How the debug flag is described to a user, for messages that have to name it.
 */
export function debugModeLocation(): string {
  return process.platform === "win32"
    ? "the PlayerDebugMode value under HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.*"
    : "Adobe's PlayerDebugMode preference";
}

// ---------------------------------------------------------------------------
// CEP's own log
//
// The one place CEP says why it declined to load a panel. Issue #91: on some
// Windows installs CEP 12 enforces signature verification even with
// PlayerDebugMode on — the panel never loads, no CEPHtmlEngine process ever
// starts, nothing appears in AE, and the only evidence anywhere is one line in
// this log, and only when LogLevel is high enough for the log to be written.
// ---------------------------------------------------------------------------

/**
 * The directory CEP logs into.
 *
 *   Windows: %TEMP%                      — measured: `%TEMP%\CEP12-AEFT.log` (issue #91)
 *   macOS:   ~/Library/Logs/CSXS/         — per Adobe's CEP cookbook
 *
 * Adobe's cookbook names the files `csxs<n>-<HOST>.log`; the CEP 12 log seen in
 * #91 was `CEP12-AEFT.log`. The documentation and the measurement disagree on
 * the prefix, and neither can be confirmed without a machine to look at, so
 * `cepLogPaths` matches both forms case-insensitively. If a third form turns
 * up, add it to CEP_LOG_NAME rather than special-casing a caller.
 */
export function cepLogDir(): string {
  if (process.platform === "win32") {
    return process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  }
  return path.join(os.homedir(), "Library", "Logs", "CSXS");
}

/** `CEP12-AEFT.log`, `csxs11-AEFT.log`, … — After Effects' host id is AEFT. */
const CEP_LOG_NAME = /^(?:cep|csxs)(\d+)-AEFT\.log$/i;

/**
 * Every After Effects CEP log in the log directory, most recently written
 * first. Empty when the directory is absent or holds none — which is the
 * normal state, since CEP writes nothing until LogLevel is raised.
 */
export function cepLogPaths(dir: string = cepLogDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => CEP_LOG_NAME.test(n))
    .map((n) => {
      const file = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch {}
      return { file, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => e.file);
}

/**
 * The log level CEP is set to for a CSXS version, or null when unset.
 * Adobe's scale: 0 off, 1 error, 2 warn, 3 info, 4 debug, 5 trace, 6 all.
 */
export async function cepLogLevel(version: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec("reg", ["query", `HKCU\\Software\\Adobe\\CSXS.${version}`, "/v", "LogLevel"]);
      const m = /LogLevel\s+REG_\w+\s+(\d+)/.exec(stdout);
      return m ? Number(m[1]) : null;
    }
    const { stdout } = await exec("defaults", ["read", `com.adobe.CSXS.${version}`, "LogLevel"]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The level `ensureCepLogging` sets. 6 is the value measured to record the #91 line; lower ones are undocumented. */
export const CEP_LOG_LEVEL = 6;

/**
 * Turn CEP's log on where it has never been set, so the evidence exists the
 * next time a panel fails to load. A value already present — including 0 —
 * is somebody's choice and is left alone. Returns what was set and what was kept.
 */
export async function ensureCepLogging(): Promise<{ set: number[]; kept: { version: number; level: number }[] }> {
  const set: number[] = [];
  const kept: { version: number; level: number }[] = [];
  for (const v of CSXS_VERSIONS) {
    const current = await cepLogLevel(v);
    if (current !== null) {
      kept.push({ version: v, level: current });
      continue;
    }
    try {
      if (process.platform === "win32") {
        await exec("reg", [
          "add", `HKCU\\Software\\Adobe\\CSXS.${v}`,
          "/v", "LogLevel", "/t", "REG_SZ", "/d", String(CEP_LOG_LEVEL), "/f",
        ]);
      } else {
        await exec("defaults", ["write", `com.adobe.CSXS.${v}`, "LogLevel", String(CEP_LOG_LEVEL)]);
      }
      set.push(v);
    } catch {
      // Some CEP versions simply are not present on this machine.
    }
  }
  return { set, kept };
}

/**
 * The exact command that turns CEP logging up by hand, for a message that has
 * to hand it to someone. Names the newest CSXS version, which is what After
 * Effects 2026 loads through.
 */
export function cepLogLevelCommand(version: number = CSXS_VERSIONS[0]): string {
  return process.platform === "win32"
    ? `reg add HKCU\\Software\\Adobe\\CSXS.${version} /v LogLevel /t REG_SZ /d ${CEP_LOG_LEVEL} /f`
    : `defaults write com.adobe.CSXS.${version} LogLevel ${CEP_LOG_LEVEL}`;
}

// ---------------------------------------------------------------------------
// aerender (render_queue, issue #137)
//
// The render runs in a separate process the *server* spawns, not the panel:
// the panel does not update itself, so a wrong path guessed there would stay
// wrong until the user reinstalled it and relaunched After Effects, and the
// server is where host differences are already kept. Both run on the same
// machine by construction — the bridge only listens on 127.0.0.1.
// ---------------------------------------------------------------------------

/**
 * Where aerender may be, most trusted first. Not checked for existence here —
 * `resolveAerender` in render/aerender.ts does that, so this stays pure.
 *
 * `appPackage` is ExtendScript's `Folder.appPackage.fsName` from the running
 * After Effects, which is the one answer that cannot name the wrong install.
 * Documented, not yet measured on 26.x:
 *
 *   macOS:   …/Adobe After Effects 2026/Adobe After Effects 2026.app
 *            → aerender sits beside the .app, in the folder above it.
 *   Windows: …\Adobe After Effects 2026\Support Files
 *            → aerender.exe sits inside it.
 *
 * Each platform also gets the other spelling, and the stock install folders,
 * because a guess that is checked costs nothing and a missing one costs the
 * render. `AE_MCP_AERENDER` overrides everything.
 */
export function aerenderCandidates(
  appPackage: string | null | undefined,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; installRoots?: string[] } = {}
): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const p = platform === "win32" ? path.win32 : path.posix;
  const out: string[] = [];
  const add = (c: string | null | undefined) => {
    if (c && !out.includes(c)) out.push(c);
  };

  const override = env.AE_MCP_AERENDER?.trim();
  if (override) add(override);

  if (platform === "win32") {
    if (appPackage) {
      add(p.join(appPackage, "aerender.exe"));
      add(p.join(appPackage, "Support Files", "aerender.exe"));
    }
    for (const root of opts.installRoots ?? []) add(p.join(root, "Support Files", "aerender.exe"));
  } else {
    if (appPackage) {
      const pkg = appPackage.replace(/\/+$/, "");
      if (/\.app$/i.test(pkg)) add(p.join(p.dirname(pkg), "aerender"));
      add(p.join(pkg, "aerender"));
    }
    for (const root of opts.installRoots ?? []) add(p.join(root, "aerender"));
  }
  return out;
}

/**
 * The stock After Effects install folders on this machine, newest name first.
 * Only a fallback behind `appPackage`; "newest" is by name, which is the year.
 */
export function afterEffectsInstallRoots(platform: NodeJS.Platform = process.platform): string[] {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const base = platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Adobe") : "/Applications";
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^Adobe After Effects/i.test(n))
    .sort()
    .reverse()
    .map((n) => join(base, n));
}

/**
 * Spawn options for a process whose whole tree has to be stoppable.
 *
 * POSIX: a process group of its own (`detached`), so `stopProcessTree` can
 * signal aerender *and* the render engine it starts in one call — killing only
 * aerender's own pid can leave the engine rendering. Windows has no groups;
 * `taskkill /T` walks the tree instead, and `detached` there would open a
 * console window, so it is off.
 */
export function treeSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide: boolean } {
  return platform === "win32" ? { detached: false, windowsHide: true } : { detached: true, windowsHide: true };
}

/**
 * Signal a process tree started with `treeSpawnOptions` to stop. `force` skips
 * the polite signal (Windows only has the forceful one). Never throws — a tree
 * that is already gone is the outcome being asked for. Whether it actually
 * stopped is for the caller to observe, from the child's own `exit` event.
 */
export async function stopProcessTree(pid: number, force = false, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    try {
      await exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Exits non-zero when the process has already gone.
    }
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

/** The synchronous last resort, for `process.on("exit")`, where nothing async runs. */
export function stopProcessTreeSync(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

/**
 * Finding a job's render processes — aerender and the engine it starts.
 *
 * Measured on macOS, AE 26.5 (live run of PR #143): aerender starts the render
 * engine as `…/aerendercore.app/Contents/MacOS/aerendercore -noui -project
 * <the job's snapshot> -rqindex N … -aerenderpid <aerender pid>`, with PPID 1
 * and a process group of its own from the start — so neither a group signal
 * nor a walk of aerender's children reaches it, and it ignored SIGTERM for 8s.
 *
 * A process is this job's only when BOTH hold: its executable is named
 * `aerender` or `aerendercore` (`.exe` on Windows), and its arguments contain
 * this job's snapshot path. The first matcher used the job id alone, and
 * review found what that kills: any shell or agent command that merely
 * mentions the id, and on Windows the PowerShell search itself — whose pid has
 * usually exited and may be reused by the time `taskkill /T` runs, taking an
 * unrelated process tree with it. Hence also: the searcher's own pid is
 * excluded, and every pid is re-checked by name and arguments immediately
 * before it is signalled (`isStillRenderProcess`).
 *
 *   POSIX:   `ps -axww -o pid=,args=` (ww: never truncate). The executable is
 *            the part of the arguments before the first ` -` flag — install
 *            paths have spaces ("Adobe After Effects 2026"), flags start with
 *            a dash after one.
 *   Windows: CIM's Win32_Process (Name, CommandLine) through PowerShell.
 *            UNVERIFIED — nobody has watched aerender.exe start its engine on
 *            Windows. If the engine there is named something else (AfterFX),
 *            this misses it; `taskkill /T` on aerender's own tree is then what
 *            stops it, if it is a child.
 */

const RENDER_EXE = /^(?:aerender|aerendercore)(?:\.exe)?$/i;

/** Snapshot path with separators normalised, for comparing against a command line. */
function normSep(s: string): string {
  return s.replace(/\\/g, "/");
}

/**
 * The tail of a snapshot path that any spelling of it contains:
 * `ae-mcp-render/<jobId>/a/a/…/<file>` — everything from the `ae-mcp-render`
 * folder on, which since #215 includes a chain of one-letter folders. A
 * /var vs /private/var symlink, or a Windows path with either slash, still
 * ends in that, and the job id in it keeps two jobs on the same project apart.
 * The last `ae-mcp-render` segment is always the job's own: below it come only
 * the job id, letters that `snapshotLayout` chose, and the file name — no
 * folder name of the user's — so the search cannot land on the wrong one.
 */
export function snapshotMarker(snapshotPath: string): string {
  const parts = normSep(snapshotPath).split("/").filter(Boolean);
  const at = parts.lastIndexOf("ae-mcp-render");
  return (at >= 0 && at < parts.length - 2 ? parts.slice(at) : parts.slice(-3)).join("/");
}

/** POSIX: is this `ps` args string one of this job's render processes? Exported for the test. */
export function isRenderProcessArgs(args: string, snapshotPath: string): boolean {
  const flag = args.search(/\s-/);
  const exe = (flag >= 0 ? args.slice(0, flag) : args).trim();
  const base = normSep(exe).split("/").pop() ?? "";
  if (!RENDER_EXE.test(base)) return false;
  return normSep(args).includes(snapshotMarker(snapshotPath));
}

/** Windows: the same test over Win32_Process's Name and CommandLine. Exported for the test. */
export function isRenderProcessWin(name: string, commandLine: string, snapshotPath: string): boolean {
  if (!RENDER_EXE.test(name.trim())) return false;
  return normSep(commandLine).includes(snapshotMarker(snapshotPath));
}

/** `ps -o pid=,args=` output → this job's render pids, never this process. Exported for the test. */
export function renderPidsFromPs(psOutput: string, snapshotPath: string, selfPid: number = process.pid): number[] {
  const out: number[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid) continue;
    if (isRenderProcessArgs(m[2], snapshotPath)) out.push(pid);
  }
  return out;
}

/**
 * PowerShell that prints `pid<TAB>name<TAB>commandline` per process, for the
 * named render executables only, never itself ($PID). The node side applies
 * the same `isRenderProcessWin` test, so the filter here only narrows.
 */
function winQuery(pidFilter?: number): string {
  const filter =
    pidFilter !== undefined
      ? `ProcessId=${pidFilter}`
      : "Name='aerender.exe' OR Name='aerendercore.exe'";
  return (
    `Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.ProcessId -ne $PID } | ` +
    "ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }"
  );
}

function winRows(stdout: string, snapshotPath: string): number[] {
  const out: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidS, name = "", cmd = ""] = line.split("\t");
    const pid = Number(pidS);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isRenderProcessWin(name, cmd, snapshotPath)) out.push(pid);
  }
  return out;
}

const PS_ARGS = ["-axww", "-o", "pid=,args="];

/** This job's render processes. [] when the lookup itself fails — aerender's own exit is still known. */
export async function findRenderProcesses(snapshotPath: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  try {
    if (platform === "win32") {
      const { stdout } = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", winQuery()], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return winRows(stdout, snapshotPath);
    }
    const { stdout } = await exec("ps", PS_ARGS, { maxBuffer: 64 * 1024 * 1024 });
    return renderPidsFromPs(stdout, snapshotPath);
  } catch {
    return [];
  }
}

/** The synchronous form, for `process.on("exit")` and signal handlers. */
export function findRenderProcessesSync(snapshotPath: string, platform: NodeJS.Platform = process.platform): number[] {
  try {
    if (platform === "win32") {
      return winRows(
        execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", winQuery()], { windowsHide: true, encoding: "utf8" }),
        snapshotPath
      );
    }
    return renderPidsFromPs(execFileSync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), snapshotPath);
  } catch {
    return [];
  }
}

/**
 * Whether `pid` is, right now, still one of this job's render processes. Asked
 * immediately before every signal: between the search and the kill, a process
 * can exit and its pid be given to something else.
 */
export async function isStillRenderProcess(pid: number, snapshotPath: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === "win32") {
      const { stdout } = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", winQuery(pid)], { windowsHide: true });
      return winRows(stdout, snapshotPath).includes(pid);
    }
    const { stdout } = await exec("ps", ["-ww", "-o", "args=", "-p", String(pid)]);
    return isRenderProcessArgs(stdout.trim(), snapshotPath);
  } catch {
    return false; // gone (ps exits non-zero for a pid that does not exist)
  }
}

export function isStillRenderProcessSync(pid: number, snapshotPath: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === "win32") {
      return winRows(
        execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", winQuery(pid)], { windowsHide: true, encoding: "utf8" }),
        snapshotPath
      ).includes(pid);
    }
    return isRenderProcessArgs(execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim(), snapshotPath);
  } catch {
    return false;
  }
}

/**
 * Signal ONE process — never its tree; a verified pid is all this kills.
 * Windows has only the forceful kill. Never throws.
 */
export async function stopPid(pid: number, force: boolean, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    try { await exec("taskkill", ["/PID", String(pid), "/F"]); } catch {}
    return;
  }
  try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
}

export function stopPidSync(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

/** Whether a pid is still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but is not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
