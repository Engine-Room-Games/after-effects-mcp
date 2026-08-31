import fs from "node:fs";
import path from "node:path";

/**
 * `run_jsx` reading its script, and its helper libraries, from files instead of
 * from the conversation.
 *
 * Every `run_jsx` body stays in the transcript for the rest of the session, and
 * a scene build is four to ten scripts of 100-300 lines. By the end, a large
 * share of the context is scripts that have already run and will never be read
 * again (issue #53).
 *
 * **The server reads the files, not the panel.** This is the same call as
 * `init_project`: Claude Desktop gives its agent no filesystem tools at all, so
 * "have the agent paste the file" fails there entirely, and it is the client
 * with the smallest context that needs this most. Reading them here also means
 * one place produces the errors, and they can name the path.
 *
 * Libraries carry their **text** to the panel, not just their path. The first
 * version sent `{path, hash}` and had the panel `$.evalFile` each one, on the
 * premise that `$.evalFile` evaluates at global scope. Measured inside AE 2026,
 * it evaluates into the *calling function's* scope — so every library's
 * functions died with the loader and `libraries` never once worked. The panel
 * now inlines the source ahead of the script in one eval, which is the only
 * scoping that puts a library's `function helper(){}` where the script can call
 * it, so the source has to travel. See `packages/jsx/raw.jsx` for the probe.
 *
 * That costs payload, not context: what this feature is worth is keeping long
 * scripts out of the *conversation*, and the server-to-panel hop was never in
 * it. The hash went with the cache it keyed — inlining re-evaluates every call
 * by construction, so there was nothing left for it to decide.
 */

/** Big enough for any hand-written script; small enough that a wrong path fails loudly. */
export const MAX_SCRIPT_BYTES = 512 * 1024;
/** A helper set, not a dependency tree. Past this something has gone wrong upstream. */
export const MAX_LIBRARIES = 16;
/**
 * Script and libraries together, because they now travel together.
 *
 * Every byte reaches the panel and then ExtendScript inside a single
 * `evalScript` string literal, where the old `{path, hash}` payload was a few
 * hundred bytes however large the file was. Sixteen libraries at the per-file
 * limit would be 8MB of source pushed through that on every call.
 */
export const MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * A validated `run_jsx` payload on its way to the panel.
 *
 * The index signature is the contract, not laziness. Everything here has
 * already been through `OpSchemas.run_jsx`, which is the single source of truth
 * for what a `run_jsx` call may contain and which strips everything else — so
 * the only fields this type has to *name* are the three this module actually
 * resolves. Naming the rest would make it a second copy of that schema, and a
 * second copy is a thing that diverges. See `resolveRunJsxSource`.
 */
export interface RunJsxArgs {
  [key: string]: unknown;
  code?: string;
  scriptPath?: string;
  libraries?: string[];
}

export interface RunJsxLibrary {
  path: string;
  /** The file's contents. The panel inlines this ahead of the script. */
  text: string;
  bytes: number;
}

export interface ResolvedRunJsxArgs {
  /** Every other `RunJsx` field, carried through untouched. */
  [key: string]: unknown;
  /** Always present and non-empty: inline `code`, or the text read from `scriptPath`. */
  code: string;
  /** Echoed to the panel so a failure can name the file rather than "your script". */
  scriptPath?: string;
  /** `{path, text, bytes}` — the source travels, because the panel inlines it. */
  libraries?: RunJsxLibrary[];
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
        `Split it into smaller scripts and run them in sequence. Moving the bulk into a \`libraries\` ` +
        `file does not help: libraries are inlined ahead of the script on every call, so they count ` +
        `against the same budget.`
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
 *
 * **Everything this function does not resolve passes through by construction.**
 * It used to build a fresh object and copy the fields it knew about, which made
 * it a whitelist of the `RunJsx` schema maintained by hand in a second place.
 * The two diverged the first time the schema grew: `diff` and `diffCompId`
 * landed on `RunJsx` and `RunBatch` together, `run_batch` forwards its args
 * untouched and worked, and `run_jsx` dropped both here — so `diff: true` came
 * back looking like an ordinary success with no diff, which is the swallowed
 * error this codebase refuses everywhere else. Any field added to `RunJsx`
 * would have failed the same silent way. The whitelist belongs to the zod
 * schema, which has already run by the time we get here and has already
 * stripped anything it does not declare; spreading is what makes this function
 * about its own two jobs and nothing else.
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

  // Start from the caller's own args. `undoGroup`, `diff`, `diffCompId` and
  // whatever `RunJsx` grows next are carried by this line and need no code of
  // their own. Absent stays absent — nothing here invents a default, because
  // the panel reads several of these as `=== false` and a default here would be
  // a second place that decides.
  //
  // `libraries` is lifted out of the spread rather than overwritten after it:
  // the caller's `string[]` is not the `{path, text, bytes}[]` the panel is
  // promised, and lifting it makes that a type error rather than a convention.
  const { libraries: requestedLibraries, ...passthrough } = args;
  const out: ResolvedRunJsxArgs = { ...passthrough, code: "" };

  if (hasPath) {
    const p = args.scriptPath as string;
    out.code = readScriptFile(p, "run_jsx `scriptPath`").text;
    out.scriptPath = p;
  } else {
    out.code = args.code as string;
    // An empty-string `scriptPath` passed alongside `code` is not a file. Left
    // on the payload it would reach the panel's error reporting and blame a
    // failure on a file nobody ever read.
    delete out.scriptPath;
  }

  if (requestedLibraries && requestedLibraries.length > 0) {
    if (requestedLibraries.length > MAX_LIBRARIES) {
      throw new Error(
        `run_jsx takes at most ${MAX_LIBRARIES} libraries, got ${requestedLibraries.length}.`
      );
    }
    const libs: RunJsxLibrary[] = [];
    const seen = new Set<string>();
    for (const raw of requestedLibraries) {
      // Duplicates within one call are the caller repeating itself, not a
      // second load. Inlining the same source twice would redeclare everything
      // in it and shift the caller's line numbers for nothing.
      if (seen.has(raw)) continue;
      seen.add(raw);
      const { text, bytes } = readScriptFile(raw, `run_jsx library "${raw}"`);
      libs.push({ path: raw, text, bytes });
    }
    out.libraries = libs;
  }
  // `libraries: []` therefore leaves no key at all, which is what the panel has
  // always been sent for "no libraries".

  const total =
    Buffer.byteLength(out.code, "utf8") +
    (out.libraries ?? []).reduce((n, l) => n + l.bytes, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      `run_jsx would send ${total} bytes of source (script plus ${out.libraries?.length ?? 0} ` +
        `libraries), over the ${MAX_TOTAL_BYTES}-byte limit for one call. Libraries are inlined ` +
        `ahead of the script — they have to be, or their functions are not in its scope — so every ` +
        `byte travels on every call. Pass only the libraries this script actually uses.`
    );
  }

  return out;
}
