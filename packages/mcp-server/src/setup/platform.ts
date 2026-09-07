import { execFile } from "node:child_process";
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
 * The two hosts diverge in exactly four places:
 *   - where the "allow unsigned extensions" flag is stored (defaults vs registry),
 *     and CEP's LogLevel beside it
 *   - how you ask whether After Effects is running (pgrep vs tasklist)
 *   - the CEP extensions directory (see paths.ts)
 *   - where CEP writes its own log (see cepLogDir below)
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
