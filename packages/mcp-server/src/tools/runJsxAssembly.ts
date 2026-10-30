import { AeError, type AeSourceInfo } from "../util/errors.js";
import type { ResolvedRunJsxArgs, RunJsxLibrary } from "./runJsxSource.js";

/**
 * `run_jsx` assembled and its failures mapped on the server (issue #220, stage 6).
 *
 * This is a port of the string work in `packages/jsx/raw.jsx` — the wrapper,
 * the inlined libraries, the #221 undo-guard rewrite with its fast path, the
 * eval/Function/$.evalFile caution scan, and the line map of #46 — so that a
 * fix to any of it ships with the server instead of costing a `setup_panel`
 * and an After Effects restart. Every `run_jsx` tool call goes through it
 * (issue #243 removed the per-panel choice); a `run_batch` step still
 * assembles in ExtendScript exactly as before.
 *
 * **The output has to be byte-identical to raw.jsx's**, and
 * `tests/unit/run-jsx-assembly.mjs` holds the two together on fixtures: the
 * same wrapper, the same counts, and through `tools/call` the same result and
 * the same error text. Each function below names the jsx function it ports.
 * Change one and you change both, or the parity test fails.
 *
 * What stays in ExtendScript, because it needs ExtendScript:
 *   - each library's own parse check (`__rjCheckLibraryParses`): it is
 *     ExtendScript's parser that decides what a syntax error is, and where;
 *   - the `Error.source`/`start`/`end` reading. The error object never leaves
 *     After Effects, and `source` can be text the server never saw (an `eval`
 *     inside the script). ExtendScript sends back the line that reading
 *     arrives at (`wrapperLine`) and the server does the rest of the mapping;
 *   - the execution, the undo guard's counting, the dialog shadows, `diff`,
 *     and the result serializer.
 *
 * No regex literal anywhere in the ported functions, to keep them line for
 * line comparable with the jsx, which avoids them for its own reasons.
 */

/** raw.jsx `__RJ_WRAP_PREFIX`. Carries no newline: the caller's line 1 is line 1 of the evaluated source. */
export const WRAP_PREFIX = "(function(){ ";
/** raw.jsx `__RJ_WRAP_SUFFIX`. On its own line, so a trailing `//` comment cannot eat it. */
export const WRAP_SUFFIX = "\n})()";

/** raw.jsx `__rjLines`. */
export function sourceLines(s: string): string[] {
  return String(s).split("\r\n").join("\n").split("\r").join("\n").split("\n");
}

/** raw.jsx `__rjTrim`: spaces and tabs only, unlike `String.prototype.trim`. */
function trimSpaces(s: string): string {
  const t = String(s);
  let a = 0;
  let b = t.length;
  while (a < b && (t.charAt(a) === " " || t.charAt(a) === "\t")) a++;
  while (b > a && (t.charAt(b - 1) === " " || t.charAt(b - 1) === "\t")) b--;
  return t.substring(a, b);
}

/** raw.jsx `__rjClip`. */
function clip(s: string, max: number): string {
  const t = String(s);
  if (t.length <= max) return t;
  return t.substring(0, max) + " ...";
}

/** raw.jsx `__rjIsBlank`. */
function isBlank(s: string): boolean {
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return false;
  }
  return true;
}

/** raw.jsx `__rjEndWithNewline`. */
function endWithNewline(s: string): string {
  const t = String(s);
  if (t.length === 0) return "\n";
  const last = t.charAt(t.length - 1);
  if (last === "\n" || last === "\r") return t;
  return t + "\n";
}

/** raw.jsx `__rjMentionsUndo` — the fast path. Not "UndoGroup": `withoutUndoGroup(` must not trip it. */
export function mentionsUndo(t: string): boolean {
  return t.indexOf("beginUndoGroup") >= 0 || t.indexOf("endUndoGroup") >= 0;
}

const UNDO_WORDS: Record<string, string> = { beginUndoGroup: "__rjUndoBegin", endUndoGroup: "__rjUndoEnd" };

/** raw.jsx `__rjIsIdentChar`. */
function isIdentChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$";
}

/** raw.jsx `__rjIsSpaceChar`. */
function isSpaceChar(c: string): boolean {
  const cc = c.charCodeAt(0);
  return (
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" ||
    cc === 11 || cc === 160 || cc === 65279 || cc === 8232 || cc === 8233
  );
}

/** raw.jsx `__rjOnlyNewlines`. */
function onlyNewlines(s: string): string {
  const t = String(s);
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (c === "\n" || c === "\r") out += c;
  }
  return out;
}

/**
 * raw.jsx `__rjRewriteUndoText` (issue #221): each literal `app.beginUndoGroup`
 * / `app.endUndoGroup` becomes the counted function, keeping every newline so
 * no line moves. Skips string and comment literals; does not recognise regex
 * literals, exactly as the jsx does not.
 */
export function rewriteUndoText(src: string): { text: string; rewrites: number } {
  const s = String(src);
  const n = s.length;
  const out: string[] = [];
  const sig: { tok: string; at: number }[] = [];
  let rewrites = 0;
  let i = 0;
  while (i < n) {
    const c = s.charAt(i);
    const d = i + 1 < n ? s.charAt(i + 1) : "";
    let j: number;
    if (c === "/" && d === "/") {
      j = i + 2;
      while (j < n && s.charAt(j) !== "\n" && s.charAt(j) !== "\r") j++;
      out.push(s.substring(i, j));
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      j = s.indexOf("*" + "/", i + 2);
      j = j < 0 ? n : j + 2;
      out.push(s.substring(i, j));
      i = j;
      continue;
    }
    if (c === "\"" || c === "'") {
      j = i + 1;
      while (j < n) {
        const ch = s.charAt(j);
        if (ch === "\\") { j += 2; continue; }
        if (ch === c) { j++; break; }
        if (ch === "\n" || ch === "\r") break;
        j++;
      }
      if (j > n) j = n;
      out.push(s.substring(i, j));
      sig.push({ tok: "'", at: out.length - 1 });
      i = j;
      continue;
    }
    if (isIdentChar(c)) {
      j = i;
      while (j < n && isIdentChar(s.charAt(j))) j++;
      const word = s.substring(i, j);
      const target = word === "beginUndoGroup" || word === "endUndoGroup" ? UNDO_WORDS[word] : null;
      const t1 = sig.length > 0 ? sig[sig.length - 1] : null;
      const t2 = sig.length > 1 ? sig[sig.length - 2] : null;
      const t3 = sig.length > 2 ? sig[sig.length - 3] : null;
      if (target && t1 && t1.tok === "." && t2 && t2.tok === "app" && !(t3 && t3.tok === ".")) {
        out[t2.at] = target;
        for (let k = t2.at + 1; k < out.length; k++) out[k] = onlyNewlines(out[k]);
        rewrites++;
        sig.length = sig.length - 2;
        out.push("");
        sig.push({ tok: target, at: out.length - 1 });
      } else {
        out.push(word);
        sig.push({ tok: word, at: out.length - 1 });
      }
      i = j;
      continue;
    }
    out.push(c);
    if (!isSpaceChar(c)) sig.push({ tok: c, at: out.length - 1 });
    i++;
  }
  return { text: out.join(""), rewrites };
}

/** raw.jsx `__rjSkipSpaceForward`. */
function skipSpaceForward(s: string, i: number): number {
  while (i < s.length && isSpaceChar(s.charAt(i))) i++;
  return i;
}

/** raw.jsx `__rjSkipSpaceBack`. */
function skipSpaceBack(s: string, i: number): number {
  while (i >= 0 && isSpaceChar(s.charAt(i))) i--;
  return i;
}

/** raw.jsx `__rjFindWord`. */
function findWord(s: string, word: string, test: (s: string, at: number, end: number) => boolean): boolean {
  let at = s.indexOf(word);
  while (at >= 0) {
    const end = at + word.length;
    const before = at === 0 ? "" : s.charAt(at - 1);
    const after = end < s.length ? s.charAt(end) : "";
    if ((before === "" || !isIdentChar(before)) && (after === "" || !isIdentChar(after)) && test(s, at, end)) return true;
    at = s.indexOf(word, at + 1);
  }
  return false;
}

/** raw.jsx `__rjCalledHere`. */
function calledHere(s: string, _at: number, end: number): boolean {
  const j = skipSpaceForward(s, end);
  return j < s.length && s.charAt(j) === "(";
}

/** raw.jsx `__rjOnDollar`. */
function onDollar(s: string, at: number): boolean {
  const dot = skipSpaceBack(s, at - 1);
  if (dot < 0 || s.charAt(dot) !== ".") return false;
  const d = skipSpaceBack(s, dot - 1);
  return d >= 0 && s.charAt(d) === "$" && (d === 0 || !isIdentChar(s.charAt(d - 1)));
}

/** raw.jsx `__rjDecodeUnicodeEscapes`, including its `parseInt` leniency. */
function decodeUnicodeEscapes(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "\\" && s.charAt(i + 1) === "u" && i + 6 <= s.length) {
      const code = parseInt(s.substring(i + 2, i + 6), 16);
      if (!isNaN(code) && s.substring(i + 2, i + 6).length === 4) {
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** raw.jsx `__rjCountUndoNames`. */
function countUndoNames(t: string): number {
  let n = 0;
  for (const w of ["beginUndoGroup", "endUndoGroup"]) {
    let at = t.indexOf(w);
    while (at >= 0) { n++; at = t.indexOf(w, at + 1); }
  }
  return n;
}

/** raw.jsx `__rjOpaqueRoutes`: the routes the rewrite cannot see into, reported as a CAUTION. */
export function opaqueRoutes(src: string): string[] {
  const s = String(src);
  const found: string[] = [];
  if (findWord(s, "eval", calledHere)) found.push("eval");
  if (findWord(s, "Function", calledHere)) found.push("Function");
  if (findWord(s, "evalFile", onDollar)) found.push("$.evalFile");
  if (s.indexOf("\\u") >= 0 && countUndoNames(decodeUnicodeEscapes(s)) > countUndoNames(s)) {
    found.push("a \\u escape spelling beginUndoGroup/endUndoGroup");
  }
  return found;
}

/** raw.jsx `__rjMergeRoutes`. */
function mergeRoutes(a: string[], b: string[]): string[] {
  const out = a.slice(0);
  for (const r of b) if (out.indexOf(r) < 0) out.push(r);
  return out;
}

/** One inlined library: where it sits in the evaluated source, and its own lines. */
export interface RunJsxSegment {
  path: string;
  /** 1-based line of the evaluated source the library's line 1 sits on. */
  firstLine: number;
  /** The library's own text (newline-terminated, not rewritten), split into lines. */
  lines: string[];
}

/**
 * What ExtendScript needs to parse-check one library. `text` travels only when
 * the undo rewrite changed the library, so the check parses the library as
 * written; otherwise it is `wrapper.substring(start, end)`, which is the same
 * string, and the source does not cross the bridge twice.
 */
export interface RunJsxLibraryCheck {
  path: string;
  start: number;
  end: number;
  text?: string;
}

export interface BuiltRunJsx {
  /** The evaluated source: wrapper opener, libraries, script, closer. */
  wrapper: string;
  /** Lines ahead of the caller's line 1 — counted from what was built, never asserted (#46). */
  preambleLines: number;
  segments: RunJsxSegment[];
  undoRewrites: number;
  undoMentions: boolean;
  opaqueRoutes: string[];
  libraryChecks: RunJsxLibraryCheck[];
}

/**
 * raw.jsx `__rjBuildSource`, minus the library parse check, which ExtendScript
 * still makes on what `libraryChecks` points at.
 *
 * Returns null when a library would not pass raw.jsx's `__rjLibrarySource`
 * (no path, no text, blank). The tool path never produces one —
 * `resolveRunJsxSource` reads every library and refuses an empty file — and
 * the caller sends such a call down the old path rather than inventing an
 * error ExtendScript would have worded with its own line number.
 */
export function buildRunJsxSource(code: string, libraries?: readonly Pick<RunJsxLibrary, "path" | "text">[]): BuiltRunJsx | null {
  let prefix = WRAP_PREFIX;
  const segments: RunJsxSegment[] = [];
  const libraryChecks: RunJsxLibraryCheck[] = [];
  let rewrites = 0;
  let mentions = false;
  let opaque = opaqueRoutes(code);
  if (libraries && libraries.length) {
    for (const raw of libraries) {
      if (!raw || typeof raw.path !== "string" || !raw.path || typeof raw.text !== "string" || isBlank(raw.text)) return null;
      const lib = { path: String(raw.path), text: endWithNewline(raw.text) };
      let libText = lib.text;
      if (mentionsUndo(libText)) {
        mentions = true;
        const gl = rewriteUndoText(libText);
        rewrites += gl.rewrites;
        libText = gl.text;
      }
      opaque = mergeRoutes(opaque, opaqueRoutes(lib.text));
      segments.push({ path: lib.path, firstLine: sourceLines(prefix).length, lines: sourceLines(lib.text) });
      const check: RunJsxLibraryCheck = { path: lib.path, start: prefix.length, end: prefix.length + libText.length };
      if (libText !== lib.text) check.text = lib.text;
      libraryChecks.push(check);
      prefix = prefix + libText;
    }
  }
  let text = code;
  if (mentionsUndo(code)) {
    mentions = true;
    const gc = rewriteUndoText(code);
    rewrites += gc.rewrites;
    text = gc.text;
  }
  return {
    wrapper: prefix + text + WRAP_SUFFIX,
    preambleLines: sourceLines(prefix).length - 1,
    segments,
    undoRewrites: rewrites,
    undoMentions: mentions,
    opaqueRoutes: opaque,
    libraryChecks,
  };
}

/**
 * What `OPS._run_jsx` sends back on a failure, through the panel's named
 * forward (`client/main.js`): AE's own line, the line of the evaluated source
 * the failure sits on, and for a library that did not parse, which one.
 */
export interface RunJsxRawFailure extends AeSourceInfo {
  wrapperLine?: number | null;
  libraryIndex?: number | null;
}

/** True when the failure came from `_run_jsx` with its mapping left to the server. */
export function needsServerMapping(s: unknown): s is RunJsxRawFailure {
  if (!s || typeof s !== "object") return false;
  return "wrapperLine" in s || "libraryIndex" in s;
}

/**
 * raw.jsx `__rjSourceInfo` after the `Error.source`/`start`/`end` reading,
 * which ExtendScript has already made — and `__rjCheckLibraryParses`'s detail
 * for a library that did not parse. The mapping refuses to guess: a line
 * outside every file the caller knows about stays null, never clamped.
 */
export function mapRunJsxFailure(
  raw: RunJsxRawFailure,
  code: string,
  scriptPath: string | undefined,
  built: Pick<BuiltRunJsx, "preambleLines" | "segments">
): AeSourceInfo {
  const rawLine = typeof raw.rawLine === "number" && isFinite(raw.rawLine) ? raw.rawLine : null;

  if (typeof raw.libraryIndex === "number") {
    const seg = built.segments[raw.libraryIndex];
    if (seg) {
      const count = seg.lines.length - 1;
      const detail: AeSourceInfo = { lineCount: count, rawLine, sourceLine: null, sourceText: null, sourceName: seg.path };
      if (rawLine !== null && rawLine >= 1 && rawLine <= count) {
        detail.sourceLine = rawLine;
        detail.sourceText = clip(trimSpaces(seg.lines[rawLine - 1]), 200);
      }
      return detail;
    }
  }

  const lines = sourceLines(code);
  const info: AeSourceInfo = { lineCount: lines.length, rawLine, sourceLine: null, sourceText: null };
  if (scriptPath) info.sourceName = String(scriptPath);
  const wrapperLine = typeof raw.wrapperLine === "number" && isFinite(raw.wrapperLine) ? raw.wrapperLine : null;
  if (wrapperLine === null) return info;

  const mapped = wrapperLine - built.preambleLines;
  if (mapped >= 1 && mapped <= lines.length) {
    info.sourceLine = mapped;
    info.sourceText = clip(trimSpaces(lines[mapped - 1]), 200);
    return info;
  }
  for (const seg of built.segments) {
    const count = seg.lines.length - 1;
    const within = wrapperLine - seg.firstLine + 1;
    if (within >= 1 && within <= count) {
      info.sourceName = seg.path;
      info.lineCount = count;
      info.sourceLine = within;
      info.sourceText = clip(trimSpaces(seg.lines[within - 1]), 200);
      return info;
    }
  }
  return info;
}

/** The internal op a `server-run-jsx` panel runs a pre-built script through. */
export const RUN_JSX_BUILT_OP = "_run_jsx";

/**
 * `run_jsx`: build here, run there, map the failure here.
 *
 * Goes to the bundle's own `run_jsx` (raw.jsx), with the args it has always
 * been sent, only when the call cannot be built here (see
 * `buildRunJsxSource`) — nothing has run by then. An `Unknown op: _run_jsx`
 * is thrown as it came (issue #243): the panel predates this server, and the
 * caller's backstop tells the user to update it rather than retrying under
 * another name.
 */
export async function runJsxViaServer(
  args: ResolvedRunJsxArgs,
  send: (op: typeof RUN_JSX_BUILT_OP, args: unknown) => Promise<unknown>,
  runOp: (op: string, args: unknown) => Promise<unknown>
): Promise<unknown> {
  const built = buildRunJsxSource(args.code, args.libraries);
  if (!built) return runOp("run_jsx", args);
  // Everything the caller passed rides along — undoGroup, diff, diffCompId and
  // whatever RunJsx grows next — except what has been turned into `built`.
  const { code, scriptPath, libraries: _libraries, ...rest } = args;
  const payload = {
    ...rest,
    built: {
      wrapper: built.wrapper,
      undoRewrites: built.undoRewrites,
      undoMentions: built.undoMentions,
      opaqueRoutes: built.opaqueRoutes,
      libraries: built.libraryChecks,
    },
  };
  try {
    return await send(RUN_JSX_BUILT_OP, payload);
  } catch (e) {
    if (e instanceof AeError && needsServerMapping(e.source)) {
      e.source = mapRunJsxFailure(e.source, code, scriptPath, built);
    }
    throw e;
  }
}
