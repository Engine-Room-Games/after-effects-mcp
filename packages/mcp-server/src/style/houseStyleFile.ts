import fs from "node:fs";
import path from "node:path";
import { isPlainAbsolute } from "../files/destinations.js";
import { AeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import type { SendInternal } from "../tools/internalOps.js";

/**
 * `house-style.md`, read and written by the server (issue #220, stage 3).
 *
 * The file sits beside the .aep, and the panel used to open it on AE's main
 * thread (`style.jsx`). The server sees the same files, so all it needs from
 * After Effects is the .aep's path — which `_project_path` answers with no
 * project walk. Since issue #243 every panel the version gate lets through has
 * it; one that answers `Unknown op: _project_path` anyway is told to update by
 * the backstop in `server.ts`, not routed to the panel's own op.
 *
 * Ports of `style.jsx`, with the same sentences and the same result shapes;
 * `tests/unit/panel-capabilities.mjs` runs both against one folder. Change one,
 * change both.
 *
 * **The server answers only where it can see.** On macOS, privacy access to
 * Desktop, Documents and removable or network volumes is granted per app, so
 * After Effects can read a folder this process cannot. A file is "not there"
 * only when the .aep beside it is visible; anything else the server cannot
 * read or write here goes back to the panel's op, which decides as it always
 * did. Falling back is never a refusal, and never leaves anything on disk.
 */

export const HOUSE_STYLE_FILENAME = "house-style.md";

const UNSAVED_REASON =
  "This After Effects project has never been saved, so there is no folder to keep the style guide in. " +
  "Ask the user to save the project, then try again.";

/** `_project_path`'s answer. */
export interface ProjectPath {
  projectSaved: boolean;
  path: string | null;
  unsavedChanges?: boolean | null;
}

/** The server cannot judge this folder; the panel's own op should run instead. */
export class NotVisibleHere extends Error {}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

/** The guide's path, or NotVisibleHere when the server cannot see the .aep's folder. */
function guidePath(aep: string): string {
  if (!isPlainAbsolute(aep)) throw new NotVisibleHere(`not a plain absolute path: ${aep}`);
  try {
    fs.statSync(aep);
  } catch (e) {
    throw new NotVisibleHere(`cannot see ${aep} (${errCode(e) ?? (e as Error).message})`);
  }
  return path.join(path.dirname(aep), HOUSE_STYLE_FILENAME);
}

/** `OPS.get_house_style`. */
export function readHouseStyle(where: ProjectPath): Record<string, unknown> {
  if (!where.path) {
    return { found: false, projectSaved: false, path: null, content: null, reason: UNSAVED_REASON };
  }
  const file = guidePath(where.path);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        found: false,
        projectSaved: true,
        path: file,
        content: null,
        reason: "No style guide for this project yet. Offer to capture one from a comp the user likes.",
      };
    }
    throw new NotVisibleHere(`cannot read ${file} (${code ?? (e as Error).message})`);
  }
  // As ExtendScript's File.read does in UTF-8: the BOM is consumed and CR and
  // CRLF come back as "\n". A guide saved on Windows, or by an editor that
  // writes CR (the 0.5.0 bug), reads the same as one saved anywhere else.
  const content = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  return { found: true, projectSaved: true, path: file, content, bytes: content.length };
}

/** `OPS.set_house_style`. Throws AeError with the jsx's sentences. */
export function writeHouseStyle(
  where: ProjectPath,
  args: { content?: unknown; overwrite?: unknown }
): Record<string, unknown> {
  const content = args?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new AeError("content is required and must not be empty");
  }
  if (!where.path) throw new AeError(UNSAVED_REASON);
  const file = guidePath(where.path);

  let existed: boolean;
  try {
    fs.statSync(file);
    existed = true;
  } catch (e) {
    const code = errCode(e);
    if (code !== "ENOENT") throw new NotVisibleHere(`cannot see ${file} (${code ?? (e as Error).message})`);
    existed = false;
  }
  const exists = () =>
    new AeError(
      "A style guide already exists at " + file + ". Read it with get_house_style, " +
        "merge your changes into the full document, and call again with overwrite: true."
    );
  // Replacing someone's hand-written style guide is not something to do on a
  // half-remembered version of it, so the caller has to have read it first.
  if (existed && args.overwrite !== true) throw exists();

  try {
    // `wx` when there was nothing: a guide that appeared since the stat is not
    // overwritten without `overwrite`. Every line ending lands as LF, as the
    // jsx's `lineFeed = "Unix"` writes it — measured on AE 26.5: "\r\n" and a
    // bare "\r" from the caller both reached disk as "\n". The file is meant
    // to be hand-edited, and ExtendScript's macOS default would write bare CRs.
    fs.writeFileSync(file, content.replace(/\r\n?/g, "\n"), { encoding: "utf8", flag: existed ? "w" : "wx" });
  } catch (e) {
    const code = errCode(e);
    if (code === "EEXIST") throw exists();
    // Refused at open, so nothing was written: After Effects may be allowed
    // where this process is not.
    if (code === "EACCES" || code === "EPERM") throw new NotVisibleHere(`cannot write ${file} (${code})`);
    throw new AeError(`Write failed for ${file}: ${(e as Error).message}`);
  }
  return { ok: true, path: file, bytes: content.length, created: !existed, replaced: existed };
}

function asProjectPath(v: unknown): ProjectPath | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.projectSaved !== "boolean") return null;
  if (r.path !== null && typeof r.path !== "string") return null;
  if (r.projectSaved !== (r.path !== null)) return null;
  return {
    projectSaved: r.projectSaved,
    path: r.path as string | null,
    unsavedChanges: typeof r.unsavedChanges === "boolean" ? r.unsavedChanges : null,
  };
}

/**
 * `get_house_style` / `set_house_style` with the file I/O on the server.
 * Goes to the bundle's own op (`style.jsx`) when `_project_path` answers in a
 * shape this does not recognise, or the folder is one this process cannot see
 * — both cases of After Effects knowing better, not of an older panel. An
 * `Unknown op: _project_path` is thrown as it came: the panel predates this
 * server, and the caller's backstop says so.
 */
export async function houseStyleOnServer(
  op: "get_house_style" | "set_house_style",
  args: unknown,
  send: SendInternal,
  runOp: (op: string, args: unknown) => Promise<unknown>
): Promise<unknown> {
  const where = asProjectPath(await send("_project_path", {}));
  if (!where) {
    logger.warn(`_project_path answered in an unexpected shape; ${op} goes to the panel.`);
    return runOp(op, args);
  }
  try {
    return op === "get_house_style"
      ? readHouseStyle(where)
      : writeHouseStyle(where, args as { content?: unknown; overwrite?: unknown });
  } catch (e) {
    if (!(e instanceof NotVisibleHere)) throw e;
    logger.info(`${op}: ${e.message}; the panel opens the file instead.`);
    return runOp(op, args);
  }
}
