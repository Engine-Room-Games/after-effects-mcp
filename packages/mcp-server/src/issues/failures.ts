import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/logger.js";
import {
  archiveReason,
  archiveContext,
  entryMatchesFailure,
  issuesDir,
  journals,
  readEntry,
  writeEntry,
  type ArchiveContext,
  type IssueEntry,
  type JournalRef,
} from "./journal.js";

/**
 * The push half of the journal: a failed tool call is answered with the entries
 * that match it, rather than every session being told to read the journal in
 * case something in it applies (issue #102).
 *
 * The moment an agent needs a workaround is the moment a call fails, and the
 * failure already carries both halves of the key — the tool name and the error
 * text. So `annotateFailure` appends one line per matching entry to the error
 * the agent was going to see anyway, and nothing else in the session pays for
 * the journal's size.
 *
 * Two rules, and both are about what happens on the *failure* path, which is
 * the one place a second failure is least welcome:
 *
 * - **It never throws and never masks the real error.** Any problem reading or
 *   writing the journal is logged to stderr and the original message goes back
 *   untouched. A pointer to a workaround is a bonus; the error it rides on is
 *   the thing the agent has to see.
 * - **It is cheap.** Both journals are read once and cached per file, keyed by
 *   size and mtime, so a lookup costs a `readdir` and a `stat` per entry and
 *   re-parses only what changed. Note the key is per *file*, not the directory:
 *   rewriting an existing file in place — which is what every `mark_issue_reported`
 *   and every re-log does — leaves the directory's own mtime exactly where it
 *   was, so a directory-keyed cache would serve stale entries for the rest of
 *   the session.
 *
 * A match is also a sighting. The entry's `lastSeen` and `lastVersion` move,
 * best-effort and silently, so an entry that keeps biting stays out of the
 * archive and one that was presumed fixed by a release comes back the first
 * time it is seen on that release. Only the stamps move: a match never clears
 * an `archive_issue` retirement, because a failure matching an entry is not a
 * person deciding it is live again — the pointer says it is archived, and the
 * agent decides.
 */

/** At most this many entries are named on one failure. Three is a pointer; ten is a listing. */
export const MAX_MATCHES = 3;

interface CachedFile {
  size: number;
  mtimeMs: number;
  entry: IssueEntry | null;
}

/**
 * Entries of both journals, re-read only for files whose size or mtime changed.
 * Exported for the test; the server holds one per process.
 */
export class JournalCache {
  private files = new Map<string, CachedFile>();
  /** Files parsed since construction — the number the test watches to prove the cache is one. */
  reads = 0;

  entries(refs: JournalRef[] = journals()): IssueEntry[] {
    const out: IssueEntry[] = [];
    const seen = new Set<string>();
    for (const journal of refs) {
      const dir = issuesDir(journal);
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue; // No journal yet is the normal state, not an error.
      }
      for (const name of names) {
        const file = path.join(dir, name);
        seen.add(file);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        const cached = this.files.get(file);
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          if (cached.entry) out.push(cached.entry);
          continue;
        }
        this.reads++;
        const entry = readEntry(file, journal.scope);
        this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, entry });
        if (entry) out.push(entry);
      }
    }
    // A deleted file must not keep answering from the cache.
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
    return out;
  }

  /**
   * After this module writes an entry, the cached copy is the one it wrote —
   * so the next lookup does not re-parse a file whose content it already holds
   * even on a filesystem whose mtime resolution would not show the write.
   */
  refresh(file: string, entry: IssueEntry): void {
    try {
      const st = fs.statSync(file);
      this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, entry });
    } catch {
      this.files.delete(file);
    }
  }
}

export interface FailureMatch {
  entry: IssueEntry;
  /** Why it is hidden from the index, when it is; the pointer says so rather than sending the agent to an empty listing. */
  archivedReason: string | null;
}

/**
 * Entries about this failure, most recently seen first, capped at `MAX_MATCHES`.
 * Pure apart from the cache: nothing is written here.
 */
export function matchFailure(
  cache: JournalCache,
  tool: string,
  errorText: string,
  ctx: ArchiveContext = archiveContext(),
  refs: JournalRef[] = journals()
): { matches: FailureMatch[]; total: number } {
  const hits = cache
    .entries(refs)
    .filter((e) => entryMatchesFailure(e, tool, errorText))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.occurrences - a.occurrences);
  return {
    matches: hits.slice(0, MAX_MATCHES).map((entry) => ({ entry, archivedReason: archiveReason(entry, ctx) })),
    total: hits.length,
  };
}

/** The lines appended under an error. Exported so the test can pin the exact wording the agent reads. */
export function describeMatches(found: { matches: FailureMatch[]; total: number }): string {
  const lines = found.matches.map(({ entry, archivedReason }) => {
    const where = `${entry.scope}:${entry.id}`;
    const tail = archivedReason ? ` (archived: ${archivedReason})` : "";
    return `Known from earlier sessions: ${where} — ${entry.title}${tail}`;
  });
  const more = found.total - found.matches.length;
  if (more > 0) lines.push(`…and ${more} more matching ${more === 1 ? "entry" : "entries"}.`);
  const first = found.matches[0]!;
  lines.push(
    `list_known_issues({ id: "${first.entry.scope}:${first.entry.id}" }) has the cause and the workaround.`
  );
  return lines.join("\n");
}

/** Move an entry's sighting stamps to now. Best-effort: a failure to write is logged and swallowed. */
function bumpSighting(cache: JournalCache, match: FailureMatch, ctx: ArchiveContext): void {
  const { entry } = match;
  if (entry.lastSeen === ctx.today && entry.lastVersion === ctx.version) return;
  const journal = journals().find((j) => j.scope === entry.scope);
  if (!journal) return;
  try {
    entry.lastSeen = ctx.today;
    entry.lastVersion = ctx.version;
    const file = writeEntry(entry, journal);
    cache.refresh(file, entry);
  } catch (e) {
    logger.warn(`Could not update journal entry ${entry.scope}:${entry.id} after a matching failure: ${(e as Error).message}`);
  }
}

/**
 * The error text an agent sees for a failed call, with any matching journal
 * entries named under it. Returns the message unchanged when nothing matches
 * or anything goes wrong — see the module comment.
 */
export function annotateFailure(
  cache: JournalCache,
  tool: string,
  message: string,
  ctx?: ArchiveContext
): string {
  try {
    const context = ctx ?? archiveContext();
    const found = matchFailure(cache, tool, message, context);
    if (found.matches.length === 0) return message;
    for (const match of found.matches) bumpSighting(cache, match, context);
    return `${message}\n\n${describeMatches(found)}`;
  } catch (e) {
    logger.warn(`Journal lookup for a failed ${tool} call was skipped: ${(e as Error).message}`);
    return message;
  }
}
