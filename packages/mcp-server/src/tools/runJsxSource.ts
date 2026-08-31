import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * `run_jsx` reading its script from a file instead of from the conversation.
 *
 * Every `run_jsx` body stays in the transcript for the rest of the session, and
 * a scene build is four to ten scripts of 100-300 lines. By the end, a large
 * share of the context is scripts that have already run and will never be read
 * again (issue #53).
 *
 * **The server reads the file, not the panel.** This is the same call as
 * `init_project`: Claude Desktop gives its agent no filesystem tools at all, so
 * "have the agent paste the file" fails there entirely, and it is the client
 * with the smallest context that needs this most. Reading it here also means
 * one place produces the errors, and they can name the path.
 *
 * Libraries are the other half. Those are *not* inlined — the server reads each
 * one only to validate it and hash it, and sends `{path, hash}`. The panel
 * evaluates them with `$.evalFile`, which is the only way to get them into
 * global scope: `eval` runs in the calling function's scope, so a library's
 * functions would vanish the moment the loader returned, and "load once, call
 * for the rest of the session" would be a lie. The hash is what makes
 * re-passing an unchanged library free and an edited one re-evaluate.
 */

/** Big enough for any hand-written script; small enough that a wrong path fails loudly. */
export const MAX_SCRIPT_BYTES = 512 * 1024;
/** A helper set, not a dependency tree. Past this something has gone wrong upstream. */
export const MAX_LIBRARIES = 16;

export interface RunJsxArgs {
  code?: string;
  scriptPath?: string;
  libraries?: string[];
  undoGroup?: boolean;
}

export interface RunJsxLibrary {
  path: string;
  /** sha256 of the file's bytes, truncated. The panel's per-session cache key. */
  hash: string;
  bytes: number;
}

export interface ResolvedRunJsxArgs {
  code: string;
  /** Echoed to the panel so a failure can name the file rather than "your script". */
  scriptPath?: string;
  libraries?: RunJsxLibrary[];
  undoGroup?: boolean;
}

function readScriptFile(p: string, what: string): { text: string; bytes: number } {
  if (!path.isAbsolute(p)) {
    throw new Error(
      `${what} must be an absolute path — got "${p}". Relative paths have no meaning here: ` +
        `the server resolves them against its own working directory, which is not the user's project folder ` +
        `(Claude Desktop starts it at "/").`
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    throw new Error(`${what} could not be read: ${p} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
  }
  if (stat.isDirectory()) throw new Error(`${what} is a directory, not a file: ${p}`);
  if (!stat.isFile()) throw new Error(`${what} is not a regular file: ${p}`);
  if (stat.size > MAX_SCRIPT_BYTES) {
    throw new Error(
      `${what} is ${stat.size} bytes, over the ${MAX_SCRIPT_BYTES}-byte limit: ${p}. ` +
        `Split it, or move the bulk into a \`libraries\` file that loads once per After Effects session.`
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`${what} could not be read: ${p} (${(e as Error).message}).`);
  }
  // An empty file would run to completion and report success for nothing.
  if (text.trim() === "") throw new Error(`${what} is empty: ${p}`);
  return { text, bytes: stat.size };
}

/**
 * Turn `{code | scriptPath, libraries}` into what the panel is sent.
 *
 * Throws with a message written for the agent — every failure names the path,
 * because the one thing the caller can act on is which file was wrong.
 */
export function resolveRunJsxSource(args: RunJsxArgs): ResolvedRunJsxArgs {
  const hasCode = typeof args.code === "string" && args.code.length > 0;
  const hasPath = typeof args.scriptPath === "string" && args.scriptPath.length > 0;
  if (hasCode && hasPath) {
    throw new Error(
      "run_jsx takes either `code` or `scriptPath`, not both. Pass the path on its own — " +
        "the file is read here, so its text never has to enter the conversation."
    );
  }
  if (!hasCode && !hasPath) {
    throw new Error(
      "run_jsx needs either `code` (ExtendScript inline) or `scriptPath` (an absolute path to a .jsx file)."
    );
  }

  const out: ResolvedRunJsxArgs = { code: "" };
  if (args.undoGroup !== undefined) out.undoGroup = args.undoGroup;

  if (hasPath) {
    const p = args.scriptPath as string;
    out.code = readScriptFile(p, "run_jsx `scriptPath`").text;
    out.scriptPath = p;
  } else {
    out.code = args.code as string;
  }

  if (args.libraries && args.libraries.length > 0) {
    if (args.libraries.length > MAX_LIBRARIES) {
      throw new Error(
        `run_jsx takes at most ${MAX_LIBRARIES} libraries, got ${args.libraries.length}.`
      );
    }
    const libs: RunJsxLibrary[] = [];
    const seen = new Set<string>();
    for (const raw of args.libraries) {
      // Duplicates within one call are the caller repeating itself, not a
      // second load — the panel's cache would collapse them anyway, and
      // collapsing them here keeps the payload honest about what is sent.
      if (seen.has(raw)) continue;
      seen.add(raw);
      const { text, bytes } = readScriptFile(raw, `run_jsx library "${raw}"`);
      libs.push({
        path: raw,
        hash: crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
        bytes,
      });
    }
    out.libraries = libs;
  }

  return out;
}
