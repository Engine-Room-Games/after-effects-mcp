import fs from "node:fs";
import path from "node:path";
import { AeError } from "../util/errors.js";

/**
 * `get_house_style` / `set_house_style`, done by the server (issue #220,
 * stage 2).
 *
 * The file sits beside the .aep. After Effects is needed for one thing only —
 * *which* .aep is open — and `get_project_summary` has answered that on every
 * panel ever shipped, so the reading and writing happen here and no longer cost
 * AE main-thread time or a panel release to fix.
 *
 * This is a port of `packages/jsx/style.jsx`, which stays in the bundle so an
 * older server still works against a newer panel, and still serves the op as a
 * `run_batch` step. Every key, its order and every sentence match it, and
 * `tests/unit/house-style-files.mjs` runs both against the same folders. Change
 * one, change both.
 *
 * Two ExtendScript behaviours the port has to reproduce, because the old
 * answers depended on them:
 *   - `File.read` normalises CR and CRLF to "\n", and consumes a UTF-8 BOM.
 *     A guide saved by a Windows editor read back with "\n" line endings, so
 *     this one does too — `bytes` (a string length, as it always was) depends
 *     on it.
 *   - The write is "\n" as given, never a bare "\r" (`lineFeed = "Unix"` in
 *     the jsx; Node writes what it is handed).
 */

export const HOUSE_STYLE_FILENAME = "house-style.md";

export const UNSAVED_PROJECT_REASON =
  "This After Effects project has never been saved, so there is no folder to keep the style guide in. " +
  "Ask the user to save the project, then try again.";

/** Where the guide lives for a project saved at `aepPath`, or null when it was never saved. */
export function houseStylePath(aepPath: string | null | undefined): string | null {
  if (!aepPath) return null;
  return path.join(path.dirname(aepPath), HOUSE_STYLE_FILENAME);
}

function unsavedProject() {
  return { found: false, projectSaved: false, path: null, content: null, reason: UNSAVED_PROJECT_REASON };
}

/** What ExtendScript's `File.read` hands back for the same bytes. */
function asExtendScriptReads(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function readHouseStyle(aepPath: string | null | undefined): Record<string, unknown> {
  const file = houseStylePath(aepPath);
  if (!file) return unsavedProject();

  if (!fs.existsSync(file)) {
    return {
      found: false,
      projectSaved: true,
      path: file,
      content: null,
      reason: "No style guide for this project yet. Offer to capture one from a comp the user likes.",
    };
  }

  let content: string;
  try {
    content = asExtendScriptReads(fs.readFileSync(file, "utf8"));
  } catch {
    throw new AeError("Could not open " + file + " for reading");
  }
  return { found: true, projectSaved: true, path: file, content, bytes: content.length };
}

export function writeHouseStyle(
  aepPath: string | null | undefined,
  args: { content?: unknown; overwrite?: boolean }
): Record<string, unknown> {
  const content = args && args.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new AeError("content is required and must not be empty");
  }

  const file = houseStylePath(aepPath);
  if (!file) throw new AeError(UNSAVED_PROJECT_REASON);

  const existed = fs.existsSync(file);
  // Replacing someone's hand-written style guide is not something to do on a
  // half-remembered version of it, so the caller has to have read it first.
  if (existed && args.overwrite !== true) {
    throw new AeError(
      "A style guide already exists at " + file + ". Read it with get_house_style, " +
        "merge your changes into the full document, and call again with overwrite: true."
    );
  }

  let fd: number;
  try {
    fd = fs.openSync(file, "w");
  } catch {
    throw new AeError("Could not open " + file + " for writing");
  }
  try {
    try {
      fs.writeSync(fd, content, null, "utf8");
    } catch {
      throw new AeError("Write failed for " + file);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { ok: true, path: file, bytes: content.length, created: !existed, replaced: existed };
}
