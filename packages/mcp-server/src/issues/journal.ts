import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageVersion } from "../setup/paths.js";

/**
 * A journal of problems previous sessions hit with these tools, and the
 * workarounds that got past them.
 *
 * The point is continuity between sessions: an agent that spends twenty minutes
 * discovering that a spatial property wants exactly one ease entry should be the
 * last one to spend it. The next session reads the entry instead.
 *
 * There are two journals, and which one an entry belongs in is a question about
 * what the entry is *about*:
 *
 * - **project** — `.ae-mcp/` inside the project folder. This project's footage,
 *   its comps, its files. It sits next to the work it came out of and travels
 *   with it.
 * - **user** — `~/.ae-mcp/` in the user's home. The tools and After Effects
 *   itself: things that will recur in every project this person ever opens, and
 *   that a fresh project folder would otherwise have to rediscover (issue #57).
 *
 * Both are untracked, and not by accident: each folder ignores itself (see
 * `ensureJournalDir`) rather than relying on a `.gitignore` rule someone has to
 * remember, since most of these folders are not repositories at all and the ones
 * that are — a dotfiles repo is the case in the home directory — should not
 * carry these notes into a commit.
 */

/** Where reports go. Read by the reporting command, not hardcoded in it. */
export const REPO = "Engine-Room-Games/after-effects-mcp";
export const NEW_ISSUE_URL = `https://github.com/${REPO}/issues/new`;

const SECTION_SYMPTOM = "What went wrong";
const SECTION_CAUSE = "Why";
const SECTION_WORKAROUND = "What worked";

/**
 * Where an entry lives, and therefore what it claims to be about.
 *
 * `home` is not a third kind of knowledge. It is the *project* journal with no
 * project to sit in — the fallback for a client that starts its servers
 * somewhere unusable — and it stays a separate directory from `user` precisely
 * so a Claude Desktop session's project notes never end up presented as curated
 * cross-project knowledge.
 */
export type JournalScope = "project" | "home" | "user";

/** The scopes a caller may choose to write to; `home` is only ever resolved to. */
export type WritableScope = "project" | "user";

export interface IssueEntry {
  id: string;
  title: string;
  /**
   * Which journal this was read from. Deliberately *not* stored in the file's
   * frontmatter: these files are meant to be hand-edited and moved, and a
   * frontmatter `scope` could be edited into disagreeing with the folder the
   * entry actually lives in. The directory is the one identity that cannot lie.
   */
  scope: JournalScope;
  /** Tool names involved, so a failing tool can be matched against the journal. */
  tools: string[];
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  reported: boolean;
  issueUrl?: string;
  symptom: string;
  cause?: string;
  workaround: string;
}

export interface LogIssueInput {
  title: string;
  symptom: string;
  workaround: string;
  cause?: string;
  tools?: string[];
  /** Default "project". "user" for tool or AE behaviour that will recur elsewhere. */
  scope?: WritableScope;
}

export interface LogIssueResult {
  id: string;
  path: string;
  /** The journal it actually landed in — "home" when "project" had nowhere to go. */
  scope: JournalScope;
  occurrences: number;
  /** True when an entry already existed *in this scope* — the agent hit a known problem. */
  previouslyLogged: boolean;
  /** Already sent to the maintainers: do not ask the user to report it again. */
  reported: boolean;
  issueUrl?: string;
  /**
   * The same id exists in the other journal too. Surfaced so an agent notices it
   * is forking one lesson into two entries rather than extending the one that
   * already answers the question.
   */
  alsoIn?: JournalScope[];
}

/** One journal: a root folder and the scope it answers as. */
export interface JournalRef {
  scope: JournalScope;
  /** The root; entries live in `<dir>/issues`. */
  dir: string;
}

/**
 * The project folder is the working directory the client started this server in,
 * which is what "the folder the user has open" means for every client that has
 * such a concept.
 *
 * Some do not: Claude Desktop spawns servers from the filesystem root. Writing a
 * project journal to `/` would be wrong even where it is permitted, so an
 * unusable working directory falls back to the user's home rather than failing
 * the tool. The resolved scope is reported everywhere, so the fallback is
 * visible rather than silent — and it deliberately keeps its own folder name
 * (`~/.after-effects-mcp`) rather than sharing one with the user journal.
 */
export function journalRoot(): JournalRef {
  const override = journalOverride();
  if (override) return { dir: override, scope: "project" };

  const cwd = process.cwd();
  const unusable = cwd === path.parse(cwd).root || cwd === os.homedir();
  if (!unusable) {
    try {
      fs.accessSync(cwd, fs.constants.W_OK);
      return { dir: path.join(cwd, ".ae-mcp"), scope: "project" };
    } catch {
      // Read-only working directory — fall through.
    }
  }
  return { dir: path.join(os.homedir(), ".after-effects-mcp"), scope: "home" };
}

/**
 * The user journal: one per person, not one per project.
 *
 * `AE_MCP_HOME` has to isolate this as well as the project journal, or a test
 * that redirects the one would write real entries into the developer's actual
 * home directory. It puts the user journal in a child of the override so a
 * single environment variable still sandboxes everything, and the two journals
 * stay distinct directories under it exactly as they are in real use.
 */
export function userJournalRoot(): JournalRef {
  const override = journalOverride();
  if (override) return { dir: path.join(override, "user"), scope: "user" };
  return { dir: path.join(os.homedir(), ".ae-mcp"), scope: "user" };
}

function journalOverride(): string | null {
  const override = process.env.AE_MCP_HOME?.trim();
  return override && override.length > 0 ? override : null;
}

/**
 * Both journals, in read precedence order. Project first: an entry written about
 * *this* project is the more specific answer when a slug exists in both.
 */
export function journals(): JournalRef[] {
  const project = journalRoot();
  const user = userJournalRoot();
  // Defensive: an exotic cwd could in principle collapse the two onto one
  // folder, and listing the same entry twice would be worse than terse.
  if (path.resolve(project.dir) === path.resolve(user.dir)) return [project];
  return [project, user];
}

/** The project journal's entries folder. Kept as the default `log_issue` target. */
export function journalDir(): string {
  return issuesDir(journalRoot());
}

function issuesDir(journal: JournalRef): string {
  return path.join(journal.dir, "issues");
}

function journalFor(scope: WritableScope): JournalRef {
  return scope === "user" ? userJournalRoot() : journalRoot();
}

/**
 * Create the journal and make it invisible to git in one step. A `.gitignore`
 * of `*` inside the folder ignores the folder's whole contents — including
 * itself — without touching a rule the user maintains, and works the same in a
 * repository, a folder that becomes one later, and one that never does.
 *
 * The user journal gets one too. `~/.ae-mcp` is usually outside any repository
 * and does not need it, but home directories that *are* repositories — dotfiles
 * — are exactly the case where committing a private journal of half-diagnosed
 * failures would be an unpleasant surprise. Two bytes is a cheap way not to
 * think about which kind of home this is.
 */
function ensureJournalDir(journal: JournalRef): string {
  const issues = issuesDir(journal);
  fs.mkdirSync(issues, { recursive: true });
  const ignore = path.join(journal.dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf8");
  return issues;
}

/**
 * Titles become filenames, and ids arrive from model input, so this is also the
 * only thing standing between `../../` in an id and a write outside the journal.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : `issue-${Date.now()}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Frontmatter is line-oriented, so anything with a newline in it would break it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function entryPath(id: string, journal: JournalRef): string {
  const dir = path.resolve(issuesDir(journal));
  const file = path.resolve(dir, `${id}.md`);
  if (path.dirname(file) !== dir) throw new Error(`Invalid issue id: ${id}`);
  return file;
}

export function render(entry: IssueEntry): string {
  const lines = [
    "---",
    `id: ${entry.id}`,
    `title: ${oneLine(entry.title)}`,
    `tools: ${entry.tools.join(", ")}`,
    `firstSeen: ${entry.firstSeen}`,
    `lastSeen: ${entry.lastSeen}`,
    `occurrences: ${entry.occurrences}`,
    `reported: ${entry.reported}`,
    `issueUrl: ${entry.issueUrl ?? ""}`,
    "---",
    "",
    `## ${SECTION_SYMPTOM}`,
    "",
    entry.symptom.trim(),
    "",
  ];
  if (entry.cause && entry.cause.trim().length > 0) {
    lines.push(`## ${SECTION_CAUSE}`, "", entry.cause.trim(), "");
  }
  lines.push(`## ${SECTION_WORKAROUND}`, "", entry.workaround.trim(), "");
  return lines.join("\n");
}

/**
 * Split the body on the three headings this module writes, and only those. A
 * workaround is often the one place a markdown heading legitimately appears —
 * pasted output, a numbered write-up — and splitting on every `##` would tear
 * the text it is there to preserve.
 */
function readSections(body: string): Map<string, string> {
  const marks: Array<{ key: string; from: number; to: number }> = [];
  for (const heading of [SECTION_SYMPTOM, SECTION_CAUSE, SECTION_WORKAROUND]) {
    const m = new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, "im").exec(body);
    if (m) marks.push({ key: heading.toLowerCase(), from: m.index, to: m.index + m[0].length });
  }
  marks.sort((a, b) => a.from - b.from);

  const sections = new Map<string, string>();
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.from : body.length;
    sections.set(mark.key, body.slice(mark.to, end).trim());
  });
  return sections;
}

/**
 * Deliberately forgiving: these files are meant to be readable and editable by
 * hand, so a human who reflows one, drops a key or deletes a heading should get
 * a degraded entry rather than a parse error that hides the whole journal.
 */
export function parse(text: string, fallbackId: string, scope: JournalScope = "project"): IssueEntry {
  const meta: Record<string, string> = {};
  let body = text;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    for (const line of fm[1]!.split(/\r?\n/)) {
      const sep = line.indexOf(":");
      if (sep <= 0) continue;
      meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }
    body = text.slice(fm[0].length);
  }

  const sections = readSections(body);

  const occurrences = Number.parseInt(meta.occurrences ?? "1", 10);
  return {
    id: meta.id || fallbackId,
    title: meta.title || fallbackId.replace(/-/g, " "),
    // The folder decides this, never the file — see IssueEntry.scope.
    scope,
    tools: (meta.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    firstSeen: meta.firstSeen || "",
    lastSeen: meta.lastSeen || meta.firstSeen || "",
    occurrences: Number.isFinite(occurrences) && occurrences > 0 ? occurrences : 1,
    reported: meta.reported === "true",
    issueUrl: meta.issueUrl && meta.issueUrl.length > 0 ? meta.issueUrl : undefined,
    // A hand-edited file with no recognised headings still has its text kept,
    // rather than being silently reduced to an empty entry.
    symptom: sections.get(SECTION_SYMPTOM.toLowerCase()) ?? (sections.size === 0 ? body.trim() : ""),
    cause: sections.get(SECTION_CAUSE.toLowerCase()) || undefined,
    workaround: sections.get(SECTION_WORKAROUND.toLowerCase()) ?? "",
  };
}

function readEntry(file: string, scope: JournalScope): IssueEntry | null {
  try {
    return parse(fs.readFileSync(file, "utf8"), path.basename(file, ".md"), scope);
  } catch {
    return null;
  }
}

export function logIssue(input: LogIssueInput): LogIssueResult {
  const journal = journalFor(input.scope ?? "project");
  const id = slugify(input.title);
  const file = entryPath(id, journal);
  const existing = fs.existsSync(file) ? readEntry(file, journal.scope) : null;

  const entry: IssueEntry = {
    id,
    title: oneLine(input.title),
    scope: journal.scope,
    tools: input.tools ?? existing?.tools ?? [],
    firstSeen: existing?.firstSeen || today(),
    lastSeen: today(),
    // Repeats are worth counting: an entry seen five times is the one most
    // worth reporting, and the count is the only evidence of that.
    occurrences: (existing?.occurrences ?? 0) + 1,
    // Reporting state belongs to the entry, not to this sighting — a fresh
    // description of a known problem must not un-report it. And it belongs to
    // the entry *in this scope*: the two journals are separate records of
    // separate claims, so reporting one says nothing about the other.
    reported: existing?.reported ?? false,
    issueUrl: existing?.issueUrl,
    symptom: input.symptom,
    // A cause worked out once is not lost because a later sighting was logged
    // without one.
    cause: input.cause ?? existing?.cause,
    workaround: input.workaround,
  };

  ensureJournalDir(journal);
  fs.writeFileSync(file, render(entry), "utf8");

  const alsoIn = journals()
    .filter((j) => j.scope !== journal.scope)
    .filter((j) => fs.existsSync(entryPath(id, j)))
    .map((j) => j.scope);

  return {
    id,
    path: file,
    scope: journal.scope,
    occurrences: entry.occurrences,
    previouslyLogged: existing !== null,
    reported: entry.reported,
    issueUrl: entry.issueUrl,
    ...(alsoIn.length > 0 ? { alsoIn } : {}),
  };
}

export type IssueStatus = "all" | "unreported" | "reported";

/** Which journals a read consults. */
export type ScopeFilter = "all" | WritableScope;

/**
 * How much of each entry to return.
 *
 * "full" was the only behaviour, and it returned the whole corpus on every call
 * — five thousand tokens to answer "is there anything about screenshot_frame?",
 * re-sent on every request for the rest of the session. The index answers that
 * question for a few hundred, and names the id to open for the rest.
 */
export type IssueDetail = "index" | "full";

/** One line per entry: enough to decide which one is worth opening. */
export interface IssueIndexEntry {
  id: string;
  title: string;
  /** Which journal it came from — and half of the handle that opens it. */
  scope: JournalScope;
  tools: string[];
  lastSeen: string;
  occurrences: number;
  reported: boolean;
  /** The opening of the symptom, deliberately clipped — the workaround is in the full entry. */
  summary: string;
}

export interface ListIssuesOptions {
  status?: IssueStatus;
  tool?: string;
  /** Every whitespace-separated term must appear in the title, symptom or tools. */
  query?: string;
  /** One entry, in full. Takes precedence over every filter. Accepts `"user:<id>"`. */
  id?: string;
  detail?: IssueDetail;
  /** Which journal(s) to read. Default "all" — both, merged. */
  scope?: ScopeFilter;
  /** Cap on lines returned; anything dropped is counted in `omitted`. */
  limit?: number;
}

/** One journal's contribution to a listing, so "empty" is never ambiguous. */
export interface JournalSummary {
  scope: JournalScope;
  dir: string;
  count: number;
}

export interface IssueListing {
  /** The project journal's entries folder — where `log_issue` writes by default. */
  dir: string;
  /** "project" for this folder's own journal; "home" when there was no usable working directory. */
  scope: JournalScope;
  /** Every journal that was read, with how many entries each holds. */
  journals: JournalSummary[];
  repo: string;
  newIssueUrl: string;
  serverVersion: string;
  platform: string;
  /** Which shape `issues` is in, so a short answer is never mistaken for a complete one. */
  detail: IssueDetail;
  /** Entries that matched. `issues.length` is smaller when `omitted` is present. */
  count: number;
  issues: Array<IssueEntry | IssueIndexEntry>;
  /** Matches the cap kept back. Present only when the cap actually bit. */
  omitted?: number;
  /** Present on an index: the call that turns one line into the fix it summarises. */
  next?: string;
}

const SUMMARY_CHARS = 160;
/** Two journals double the listing; this is what keeps it from being unbounded. */
const DEFAULT_LIMIT = 50;

function summarize(entry: IssueEntry): string {
  const text = oneLine(entry.symptom || entry.workaround || "");
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS).trimEnd()}…` : text;
}

function toIndexEntry(e: IssueEntry): IssueIndexEntry {
  return {
    id: e.id,
    title: e.title,
    scope: e.scope,
    tools: e.tools,
    lastSeen: e.lastSeen,
    occurrences: e.occurrences,
    reported: e.reported,
    summary: summarize(e),
  };
}

function readJournalEntries(journal: JournalRef): IssueEntry[] {
  const dir = issuesDir(journal);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readEntry(path.join(dir, f), journal.scope))
      .filter((e): e is IssueEntry => e !== null);
  } catch {
    return []; // No journal yet is the normal state, not an error.
  }
}

/** Journals the filter admits, still in precedence order. */
function selectedJournals(filter: ScopeFilter): JournalRef[] {
  if (filter === "all") return journals();
  if (filter === "user") return journals().filter((j) => j.scope === "user");
  // "project" includes the home fallback: it is the project journal, relocated.
  return journals().filter((j) => j.scope === "project" || j.scope === "home");
}

function readAllEntries(filter: ScopeFilter = "all"): IssueEntry[] {
  return selectedJournals(filter).flatMap(readJournalEntries);
}

const SCOPE_PREFIX = /^(project|home|user)\s*:\s*(.+)$/i;

/**
 * Resolve an id to exactly one entry.
 *
 * Two journals can hold the same slug — the title is the identity and nothing
 * stops the same lesson being written down in both — so the handle has to be
 * able to say which. `"user:some-slug"` does; a bare id keeps working and
 * resolves in precedence order, with the other scope named in the error-free
 * case too so the caller knows there was a choice.
 *
 * The qualified form is tried first and *falls back* to the whole string as a
 * bare id, because `list_known_issues({id})` also accepts a title, and a title
 * beginning "user: …" would otherwise be unreachable.
 */
function resolveEntry(
  raw: string,
  entries: IssueEntry[]
): { found: IssueEntry; alsoIn: JournalScope[] } | null {
  const qualified = SCOPE_PREFIX.exec(raw.trim());
  if (qualified) {
    const scope = qualified[1]!.toLowerCase() as JournalScope;
    const slug = slugify(qualified[2]!);
    const hit = entries.find((e) => e.scope === scope && e.id === slug);
    if (hit) return { found: hit, alsoIn: [] };
  }

  const slug = slugify(raw);
  const matches = entries.filter((e) => e.id === slug);
  if (matches.length === 0) return null;
  return { found: matches[0]!, alsoIn: matches.slice(1).map((e) => e.scope) };
}

/** Ids are only unique within a journal, so an error has to name both halves. */
function knownIds(entries: IssueEntry[]): string {
  return entries.map((e) => `${e.scope}:${e.id}`).join(", ");
}

function matchesQuery(entry: IssueEntry, terms: string[]): boolean {
  const haystack = `${entry.title} ${entry.symptom} ${entry.tools.join(" ")}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function listIssues(options: ListIssuesOptions = {}): IssueListing {
  const project = journalRoot();
  const filter = options.scope ?? "all";
  const consulted = selectedJournals(filter);
  const perJournal = consulted.map((j) => ({ journal: j, entries: readJournalEntries(j) }));
  const entries = perJournal.flatMap((p) => p.entries);

  const envelope = {
    dir: issuesDir(project),
    scope: project.scope,
    journals: perJournal.map(({ journal, entries: e }) => ({
      scope: journal.scope,
      dir: issuesDir(journal),
      count: e.length,
    })),
    repo: REPO,
    newIssueUrl: NEW_ISSUE_URL,
    serverVersion: packageVersion(),
    platform: process.platform,
  };

  // A named entry is a read, not a search: the filters would only be able to
  // hide the thing that was asked for by name.
  const wantedId = options.id?.trim();
  if (wantedId) {
    const resolved = resolveEntry(wantedId, entries);
    if (!resolved) {
      throw new Error(
        `No journal entry with id "${wantedId}".` +
          (entries.length > 0 ? ` Known ids: ${knownIds(entries)}` : " The journal is empty.")
      );
    }
    return {
      ...envelope,
      detail: "full",
      count: 1,
      issues: [resolved.found],
      // Same slug in the other journal: say so, and name the call that opens it,
      // rather than letting one of the two silently win.
      ...(resolved.alsoIn.length > 0
        ? {
            next:
              `Also written down in the ${resolved.alsoIn.join(" and ")} journal — ` +
              `list_known_issues({ id: "${resolved.alsoIn[0]}:${resolved.found.id}" }) reads that one.`,
          }
        : {}),
    };
  }

  const status = options.status ?? "all";
  const wanted = options.tool?.trim().toLowerCase();
  const terms = (options.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const filtered = entries.filter((e) => {
    const byStatus = status === "all" ? true : status === "reported" ? e.reported : !e.reported;
    if (!byStatus) return false;
    if (terms.length > 0 && !matchesQuery(e, terms)) return false;
    if (!wanted) return true;
    // The title is matched too: an entry logged before the `tools` field was
    // filled in still names the tool it is about.
    return e.tools.some((t) => t.toLowerCase() === wanted) || e.title.toLowerCase().includes(wanted);
  });
  // Most recent first, and among same-day entries the ones that keep recurring.
  // Scope is not a tiebreak: a lesson is worth reading because it is recent and
  // recurring, not because of which folder it happens to sit in.
  filtered.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.occurrences - a.occurrences);

  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const shown = filtered.slice(0, limit);
  const omitted = filtered.length - shown.length;

  const detail = options.detail ?? "index";
  const first = shown[0];
  return {
    ...envelope,
    detail,
    count: filtered.length,
    issues: detail === "full" ? shown : shown.map(toIndexEntry),
    // Truncation is named and counted. A short answer that looked complete
    // would be the same class of lie as a swallowed error.
    ...(omitted > 0 ? { omitted } : {}),
    // The reason to read this journal is that something failed, so an index
    // that stopped short of the workaround would be worse than useless. Say
    // how to reach it, every time there is one to reach — and since ids are
    // only unique within a journal, spell the scope-qualified form out on a
    // real entry rather than leaving the caller to guess the syntax.
    ...(detail === "index" && first
      ? {
          next:
            `list_known_issues({ id: "${first.scope}:${first.id}" }) for the cause and the workaround. ` +
            `Prefix any id from this list with its own scope.` +
            (omitted > 0 ? ` ${omitted} more matched — narrow with tool/query, or raise limit.` : ""),
        }
      : {}),
  };
}

/**
 * Mark an entry reported, in whichever journal holds it.
 *
 * Reporting state is per entry per journal: the same lesson written down in both
 * is two records of two claims, and sending one to the maintainers says nothing
 * about the other. Pass a scope-qualified id to be sure which one moves.
 */
export function markReported(id: string, url?: string): IssueEntry {
  const entries = readAllEntries();
  const resolved = resolveEntry(id, entries);
  if (!resolved) {
    throw new Error(
      `No journal entry with id "${id}".` + (entries.length > 0 ? ` Known ids: ${knownIds(entries)}` : "")
    );
  }

  const entry = resolved.found;
  const journal = journals().find((j) => j.scope === entry.scope);
  if (!journal) throw new Error(`Journal for scope "${entry.scope}" is no longer readable.`);

  entry.reported = true;
  if (url) entry.issueUrl = oneLine(url);
  fs.writeFileSync(entryPath(entry.id, journal), render(entry), "utf8");
  return entry;
}
