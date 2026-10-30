import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AeError } from "../util/errors.js";

/**
 * The filesystem checks `export_mogrt`, `add_to_render_queue` and
 * `import_footage` make before they touch the project, done by the server
 * (issue #220, stage 2).
 *
 * None of these needs After Effects: they ask whether a folder exists, whether
 * a file is already there, whether a folder accepts writes. Run here they cost
 * AE no main-thread time, and their wording can be fixed with a server update
 * rather than a panel reinstall and an AE restart.
 *
 * They are ports of the checks in `mogrt.jsx`, `render.jsx` and `footage.jsx`,
 * with the same sentences, and those checks stay where they are: the old panel
 * code runs them again after these pass, which costs a stat or two, and they
 * still guard the ops as `run_batch` steps (which go straight to ExtendScript).
 * `tests/unit/destination-checks.mjs` runs each port against the jsx it came
 * from, on real folders. Change one, change both.
 *
 * The one rule every function here follows: **a check runs only where Node and
 * ExtendScript's `File` are known to agree about the path.** ExtendScript
 * decodes `%XX` escapes in a path, reads `~` as the home folder, and on
 * Windows reads a leading "/c/" as a drive. A path that could mean something
 * different to the two is not judged here at all — it is forwarded untouched,
 * and the jsx check, which is the one that always ran, decides as before.
 * Skipping is never a refusal.
 */

/** `/a/b`, `C:\a\b`, `\\server\share` — a path Node and `File` read the same way on this platform. */
export function isPlainAbsolute(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (p.includes("%")) return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  return p.startsWith("/");
}

/** `~` and `~/…` as ExtendScript reads them on macOS. Windows is left to the jsx. */
function expandHome(p: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---------- add_to_render_queue (render.jsx) ----------

/** `__rqIsSequencePath`: an image-sequence output names its frame number as [###]. */
export function isSequencePath(p: string): boolean {
  return /\[#+\]/.test(String(p));
}

/** `__rqIsAbsolutePath`, verbatim: the test the refusal has always used. */
export function rqIsAbsolutePath(p: string): boolean {
  const s = String(p);
  if (s.charAt(0) === "/" || s.charAt(0) === "~") return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s.substring(0, 2) === "\\\\") return true;
  return false;
}

/**
 * The three checks `add_to_render_queue` makes before it adds anything to the
 * queue: the path is absolute, its folder exists, and a file already there is
 * replaced only on `overwrite: true`. Throws the jsx's own refusal; returns
 * quietly when every check passed *or* the path is one it will not judge.
 */
export function checkRenderOutput(
  args: { outputPath?: unknown; overwrite?: boolean },
  platform: NodeJS.Platform = process.platform
): void {
  const outputPath = String(args.outputPath || "");
  if (!rqIsAbsolutePath(outputPath)) {
    throw new AeError(
      "outputPath must be absolute (got \"" + outputPath + "\"). A relative path would be resolved " +
        "against After Effects' own working folder, not the project's."
    );
  }
  const expanded = expandHome(outputPath, platform);
  if (!isPlainAbsolute(expanded, platform)) return;

  const file = path.resolve(expanded);
  const parent = path.dirname(file);
  if (!fs.existsSync(parent)) {
    throw new AeError(
      "The folder for outputPath does not exist: " + parent + ". " +
        "Create it first — a render into a missing folder fails only when it runs."
    );
  }
  if (!isSequencePath(outputPath) && fs.existsSync(file) && args.overwrite !== true) {
    throw new AeError(
      "A file already exists at " + file + ". Pass overwrite:true to replace it when the " +
        "render runs, or choose another outputPath."
    );
  }
}

// ---------- import_footage (footage.jsx) ----------

/**
 * The file-existence half of `import_footage`'s up-front checks. The SVG
 * viewBox check (#33) is not here: it compares against the *imported item*,
 * and removes it when the comparison fails, and both of those need After
 * Effects. See "Filesystem checks on the server" in docs/subsystems.md.
 */
export function checkFootageExists(args: { path?: unknown }, platform: NodeJS.Platform = process.platform): void {
  const p = args && args.path;
  if (typeof p !== "string" || p.length === 0) return; // the jsx's own "path is required"
  if (!isPlainAbsolute(p, platform)) return;
  if (!fs.existsSync(p)) throw new AeError("No file at " + p);
}

// ---------- export_mogrt (mogrt.jsx) ----------

/** `__joinPath`: one trailing separator off the folder, then "/" and the leaf. */
export function joinPath(dir: string, leaf: string): string {
  let d = String(dir);
  if (d.charAt(d.length - 1) === "/" || d.charAt(d.length - 1) === "\\") d = d.substring(0, d.length - 1);
  return d + "/" + leaf;
}

/** `__trimTrailingSeparator`. */
export function trimTrailingSeparator(p: string): string {
  let s = String(p);
  while (s.length > 1) {
    const last = s.charAt(s.length - 1);
    if (last !== "/" && last !== "\\") break;
    s = s.substring(0, s.length - 1);
  }
  return s;
}

/** `__isBlank`. */
export function isBlank(s: string): boolean {
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return false;
  }
  return true;
}

/** `__folderIsWritable`: write a probe, remove it on every path. */
export function folderIsWritable(folder: string): boolean {
  const probe = joinPath(folder, ".ae-mcp-write-probe");
  let opened = false;
  try {
    fs.writeFileSync(probe, "");
    opened = true;
  } catch {
    opened = false;
  }
  try {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  } catch {
    /* never outlives the call, but a failed unlink is not the caller's problem */
  }
  return opened;
}

/**
 * The destination checks `export_mogrt` makes before it renames, saves or
 * exports anything: the name resolves into the folder, an existing file needs
 * `overwrite`, the folder accepts writes. Throws the jsx's own refusal;
 * returns quietly when every check it could make passed.
 *
 * **No side effects.** It never creates the destination folder. A folder that
 * does not exist yet is left for the jsx to create, after its own checks, so a
 * refusal here never leaves a folder behind. In that case the only check made
 * here is the one that needs no folder, that the name resolves into it; the
 * existing-template check is moot and the write probe has nowhere to run. The
 * probe's test file is removed on every path.
 *
 * Only for an explicit `destDir`. The default is the .aep's folder, and the
 * only op in an installed bundle that reports the .aep path,
 * `get_project_summary`, walks every project item on AE's main thread; asking
 * it on every export would cost more than these checks save. Without
 * `destDir` nothing is checked here and the jsx checks everything, as before.
 *
 * Nothing is checked either when `name` is blank, which the jsx refuses
 * first, or `destDir` is not a plain absolute path. When `name` is omitted,
 * the template name is read off the comp, so the two name checks are left to
 * the jsx and only the probe runs here.
 *
 * The refusals reach the caller in a different order from the jsx's in some
 * cases; "Filesystem checks on the server" in docs/subsystems.md lists them.
 */
export function checkMogrtDestination(
  args: { compId: number; destDir?: string; name?: string; overwrite?: boolean },
  platform: NodeJS.Platform = process.platform
): void {
  const destDir = args.destDir;
  if (typeof destDir !== "string" || destDir.length === 0) return;

  const hasName = typeof args.name === "string" && args.name.length > 0;
  if (hasName && isBlank(args.name as string)) return;
  if (!isPlainAbsolute(destDir, platform)) return;

  const folder = path.resolve(destDir);
  const folderExists = fs.existsSync(folder);

  // A name the two path readers might split differently is left to the jsx.
  const templateName = hasName ? (args.name as string) : null;
  const judgeable =
    templateName !== null && !/[%:]/.test(templateName) && (platform === "win32" || !templateName.includes("\\"));
  if (judgeable) {
    const outPath = joinPath(folder, templateName + ".mogrt");
    const resolvedParent = path.dirname(path.resolve(outPath));
    if (trimTrailingSeparator(resolvedParent) !== trimTrailingSeparator(folder)) {
      throw new AeError(
        "The template name \"" + templateName + "\" is used as the .mogrt filename, and it resolves to " +
          outPath + ", which is not inside " + folder + ". Pass a `name` with no slashes in it, and " +
          "a `destDir` if you want it written somewhere else."
      );
    }
    if (folderExists && fs.existsSync(outPath) && args.overwrite !== true) {
      throw new AeError(
        "A template already exists at " + outPath + ". Pass overwrite: true to replace it, or a " +
          "different `name`."
      );
    }
  }

  if (folderExists && !folderIsWritable(folder)) {
    throw new AeError(
      "After Effects cannot write into " + folder + " — a test file could not be created there. " +
        "Nothing was exported. Pass a `destDir` the user can write to, or ask them to fix the folder's " +
        "permissions."
    );
  }
}
