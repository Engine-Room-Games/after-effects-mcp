import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** CEP major versions After Effects may look at, newest first. */
export const CSXS_VERSIONS = [12, 11, 10, 9];

/**
 * Everything that differs between macOS and Windows lives here, so the rest of
 * the setup code stays platform-neutral.
 *
 * The two hosts diverge in exactly three places:
 *   - where the "allow unsigned extensions" flag is stored (defaults vs registry)
 *   - how you ask whether After Effects is running (pgrep vs tasklist)
 *   - the CEP extensions directory (see paths.ts)
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
