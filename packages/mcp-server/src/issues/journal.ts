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
 * last one to spend it. The next session reads the entry instead — or, since
 * 0.5.0, is *handed* it: a failed tool call names the entries that match its
 * tool and error text (see `failures.ts`), so nobody has to read the journal
 * ahead of time and its size no longer costs every session (issue #102).
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
 *
 * An entry also has exits now. It is hidden from the index — archived — when it
 * has not been seen for `ARCHIVE_AFTER_DAYS`, when it was last seen on an older
 * server than the one running (unless it is a permanent After Effects quirk,
 * which no release fixes), or when `archive_issue` retired it by hand. The first
 * two are *computed* on every read from `lastSeen` and `lastVersion`, never
 * written into the file, which is what lets a fresh sighting bring an entry back
 * without anyone un-archiving it. Only the third is a flag in the frontmatter.
 */

/** Where reports go. Read by the reporting command, not hardcoded in it. */
export const REPO = "Engine-Room-Games/after-effects-mcp";
export const NEW_ISSUE_URL = `https://github.com/${REPO}/issues/new`;

/** An entry nobody has seen for this long is stale until it is seen again. */
export const ARCHIVE_AFTER_DAYS = 30;

const SECTION_SYMPTOM = "What went wrong";
const SECTION_CAUSE = "Why";
const SECTION_WORKAROUND = "What worked";

/** The frontmatter is one line per key, so an error message has to fit on one. */
const ERROR_TEXT_CHARS = 400;

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

/**
 * What kind of thing an entry records, which decides whether a release can
 * retire it.
 *
 * - `tool-bug` — something these tools get wrong. A later server version may
 *   fix it, so an entry last seen on an older version than the one running is
 *   presumed fixed until it is seen again.
 * - `ae-quirk` — After Effects itself behaving unlike its documentation. No
 *   release of this server changes that, so the version rule never applies; only
 *   the age rule and `archive_issue` do.
 */
export type IssueKind = "tool-bug" | "ae-quirk";
export const ISSUE_KINDS: readonly IssueKind[] = ["tool-bug", "ae-quirk"];

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
  kind: IssueKind;
  /**
   * The error text the failure produced, one line. This is what a later failure
   * is matched against — see `failures.ts` — and what `logIssue` merges on, so
   * the same bug logged under two titles lands in one entry.
   */
  errorText?: string;
  firstSeen: string;
  lastSeen: string;
  /** Server version at the first and the most recent sighting. Absent on files that predate 0.5.0. */
  firstVersion?: string;
  lastVersion?: string;
  occurrences: number;
  reported: boolean;
  issueUrl?: string;
  /**
   * The explicit exit: set by `archive_issue`, and by nothing else. The two
   * computed exits (age, version) are never written here — see `archiveReason`.
   * A later `log_issue` that lands on the entry clears it and says so.
   */
  archived: boolean;
  archivedReason?: string;
  archivedAt?: string;
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
  /** The exact error text, so the next failure with the same text is matched to this entry. */
  errorText?: string;
  /** Default "tool-bug". "ae-quirk" for a permanent After Effects behaviour no release will change. */
  kind?: IssueKind;
  /** Default "project". "user" for tool or AE behaviour that will recur elsewhere. */
  scope?: WritableScope;
}

export interface LogIssueResult {
  id: string;
  /** The title the entry actually carries — not the one passed, after an error-text merge. */
  title: string;
  path: string;
  /** The journal it actually landed in — "home" when "project" had nowhere to go. */
  scope: JournalScope;
  kind: IssueKind;
  occurrences: number;
  /** True when an entry already existed *in this scope* — the agent hit a known problem. */
  previouslyLogged: boolean;
  /**
   * How the existing entry was found: by the same title, or by a shared tool and
   * a matching error text under a different title. Absent on a new entry.
   */
  mergedBy?: "title" | "errorText";
  /** Already sent to the maintainers: do not ask the user to report it again. */
  reported: boolean;
  issueUrl?: string;
  lastVersion: string;
  /**
   * The entry had been retired by `archive_issue` and this sighting brought it
   * back. The previous reason is kept so the agent can tell the user a problem
   * that was supposed to be gone is not.
   */
  reopened?: true;
  previousArchiveReason?: string;
  /**
   * The same id exists in the other journal too. Surfaced so an agent notices it
   * is forking one lesson into two entries rather than extending the one that
   * already answers the question.
   */
  alsoIn?: JournalScope[];
  note?: string;
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

/** A journal's entries folder. Exported for the failure cache, which stats the files itself. */
export function issuesDir(journal: JournalRef): string {
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

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Frontmatter is line-oriented, so anything with a newline in it would break it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipErrorText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = oneLine(text);
  if (line.length === 0) return undefined;
  return line.length > ERROR_TEXT_CHARS ? line.slice(0, ERROR_TEXT_CHARS) : line;
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
    `kind: ${entry.kind}`,
    `errorText: ${entry.errorText ?? ""}`,
    `firstSeen: ${entry.firstSeen}`,
    `lastSeen: ${entry.lastSeen}`,
    `firstVersion: ${entry.firstVersion ?? ""}`,
    `lastVersion: ${entry.lastVersion ?? ""}`,
    `occurrences: ${entry.occurrences}`,
    `reported: ${entry.reported}`,
    `issueUrl: ${entry.issueUrl ?? ""}`,
  ];
  // Only a retired entry carries the flag, so an ordinary file keeps the shape
  // it has always had and a hand-edit can retire one by adding a single line.
  if (entry.archived) {
    lines.push("archived: true");
    lines.push(`archivedReason: ${oneLine(entry.archivedReason ?? "")}`);
    lines.push(`archivedAt: ${entry.archivedAt ?? ""}`);
  }
  lines.push("---", "", `## ${SECTION_SYMPTOM}`, "", entry.symptom.trim(), "");
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

function parseKind(raw: string | undefined): IssueKind {
  const kind = (raw ?? "").trim().toLowerCase();
  return (ISSUE_KINDS as readonly string[]).includes(kind) ? (kind as IssueKind) : "tool-bug";
}

/**
 * Deliberately forgiving: these files are meant to be readable and editable by
 * hand, so a human who reflows one, drops a key or deletes a heading should get
 * a degraded entry rather than a parse error that hides the whole journal. A
 * file written before 0.5.0 has none of `kind`, `errorText`, `firstVersion`,
 * `lastVersion` or `archived`, and loads as a live `tool-bug` with no version —
 * which the version rule then treats as "unknown", never as "older".
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
  const nonEmpty = (v: string | undefined) => (v && v.length > 0 ? v : undefined);

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
    kind: parseKind(meta.kind),
    errorText: clipErrorText(meta.errorText),
    firstSeen: meta.firstSeen || "",
    lastSeen: meta.lastSeen || meta.firstSeen || "",
    firstVersion: nonEmpty(meta.firstVersion),
    lastVersion: nonEmpty(meta.lastVersion),
    occurrences: Number.isFinite(occurrences) && occurrences > 0 ? occurrences : 1,
    reported: meta.reported === "true",
    issueUrl: nonEmpty(meta.issueUrl),
    archived: meta.archived === "true",
    archivedReason: nonEmpty(meta.archivedReason),
    archivedAt: nonEmpty(meta.archivedAt),
    // A hand-edited file with no recognised headings still has its text kept,
    // rather than being silently reduced to an empty entry.
    symptom: sections.get(SECTION_SYMPTOM.toLowerCase()) ?? (sections.size === 0 ? body.trim() : ""),
    cause: sections.get(SECTION_CAUSE.toLowerCase()) || undefined,
    workaround: sections.get(SECTION_WORKAROUND.toLowerCase()) ?? "",
  };
}

/** Read one entry file. Null for anything unreadable — one bad file must not hide the journal. */
export function readEntry(file: string, scope: JournalScope): IssueEntry | null {
  try {
    return parse(fs.readFileSync(file, "utf8"), path.basename(file, ".md"), scope);
  } catch {
    return null;
  }
}

/** Write an entry back into its journal. The one writer, so every path renders the same file. */
export function writeEntry(entry: IssueEntry, journal: JournalRef): string {
  ensureJournalDir(journal);
  const file = entryPath(entry.id, journal);
  fs.writeFileSync(file, render(entry), "utf8");
  return file;
}

// ------------------------------------------------------------------ versions

/**
 * `major.minor.patch[-prerelease]`, or null for anything else. Null is "cannot
 * say", and every caller treats that as *not older* — an entry whose version
 * nobody can read must not be presumed fixed.
 */
function parseVersion(v: string): { nums: number[]; pre: string | null } | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** Semver order: negative when `a` is older than `b`, positive when newer, 0 when equal, null when either is unreadable. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  // A prerelease sorts below the release it precedes.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/** Whole days from one ISO date to another, or null when either does not parse. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

// ------------------------------------------------------------------- archive

/** What "now" is, for the two computed exits. Injected so the rules can be tested against a fixed date and version. */
export interface ArchiveContext {
  today: string;
  version: string;
}

export function archiveContext(): ArchiveContext {
  return { today: today(), version: packageVersion() };
}

/**
 * Why an entry is hidden from the index, or null when it is live.
 *
 * Three exits, checked in this order:
 *
 * 1. `archive_issue` retired it. Its reason is quoted back.
 * 2. Nobody has seen it for `ARCHIVE_AFTER_DAYS`. It comes back the moment a
 *    failure matches it or `log_issue` extends it, because both move `lastSeen`.
 * 3. It is a `tool-bug` last seen on a server *older* than this one — presumed
 *    fixed by a release until a sighting on this version says otherwise. An
 *    `ae-quirk` is exempt: no release of this server changes After Effects. An
 *    entry with no `lastVersion` at all is exempt too, because "unknown" is not
 *    "older" — it predates the stamp and will be archived by age or by a later
 *    sighting's stamp, never by a guess.
 */
export function archiveReason(entry: IssueEntry, ctx: ArchiveContext): string | null {
  if (entry.archived) return entry.archivedReason || "archived by hand";
  const age = daysBetween(entry.lastSeen, ctx.today);
  if (age !== null && age >= ARCHIVE_AFTER_DAYS) return `not seen for ${age} days`;
  if (entry.kind !== "ae-quirk" && entry.lastVersion) {
    const cmp = compareVersions(entry.lastVersion, ctx.version);
    if (cmp !== null && cmp < 0) {
      return `last seen on ${entry.lastVersion}; this server is ${ctx.version}, so it is presumed fixed until seen again`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ matching

/**
 * Two lists of tool names share at least one, case-insensitively. Used by the
 * error-text merge and by the failure matcher, so both agree on what "the same
 * tool" means.
 */
export function toolsOverlap(a: string[], b: string[]): boolean {
  const set = new Set(a.map((t) => t.trim().toLowerCase()));
  return b.some((t) => set.has(t.trim().toLowerCase()));
}

function uniqueTools(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const t of list ?? []) {
      const key = t.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(t.trim());
    }
  }
  return out;
}

/**
 * Everything the server itself adds around an error, cut off before matching.
 * These vary with the call, not with the bug: the mapped line and its text, the
 * "nothing rolls back" reminder (`aeErrorText`), a `diff:true` annotation, and —
 * since an agent will paste a tool error straight into `errorText` — the
 * pointer block this very module appends. Each is a cut: the text ends where
 * the decoration begins.
 */
const DECORATION_CUTS = [
  /\n\s*at line \d+ of /,
  /\n\s*After Effects reported line/,
  /\n\s*Everything before the failure already ran/,
  /\s\|\|\s*Changed before it stopped/,
  /\n\s*Known from earlier sessions:/,
];

export function stripDecorations(text: string): string {
  let out = text.replace(/^\s*AE\s*:\s*/i, "");
  for (const cut of DECORATION_CUTS) {
    const m = cut.exec(out);
    if (m) out = out.slice(0, m.index);
  }
  return out.replace(/\s*\(line \d+\)\s*$/, "").trim();
}

/**
 * The error text with everything that varies between two sightings of the same
 * failure stripped out: the server's decorations, paths, quoted names, numbers,
 * punctuation, case and whitespace. What is left is the letters of the message,
 * which is what two occurrences of one bug have in common. `keepQuotes` leaves
 * quoted spans in — a *symptom* usually quotes the error verbatim, and stripping
 * the quotes there would strip the very text the fallback is looking for.
 */
export function normalizeErrorText(text: string, opts: { keepQuotes?: boolean } = {}): string {
  let t = stripDecorations(text)
    .toLowerCase()
    // Windows and POSIX paths, and file URLs.
    .replace(/\b[a-z]:\\[^\s'"`]+/g, " ")
    .replace(/file:\/\/[^\s'"`]+/g, " ")
    .replace(/(?:^|[\s(=:,])\/[^\s'"`)]+/g, " ");
  // Quoted spans in an error message are almost always the caller's own names
  // and values. A single quote only counts when it is not an apostrophe.
  if (!opts.keepQuotes) {
    t = t.replace(/"[^"\n]*"|`[^`\n]*`/g, " ").replace(/(?<![a-z])'[^'\n]*'(?![a-z])/g, " ");
  }
  return t.replace(/[^a-z]+/g, "");
}

/** The shortest normalised text worth trusting as a prefix of another. */
const MATCH_MIN_CHARS = 20;
/** Two long messages that agree this far are the same message with different tails. */
const MATCH_PREFIX_CHARS = 60;

/**
 * Whether two error texts are the same error.
 *
 * Equal after normalisation, or one is a prefix of the other (a message with a
 * variable tail — a count, a name — against one without), or both are long and
 * agree for their first `MATCH_PREFIX_CHARS`. The minimum length is what stops
 * "ae" matching everything; the prefix length is what stops every schema
 * rejection for one tool — all of which begin `Invalid arguments for <tool>` —
 * matching every other.
 */
export function errorTextsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeErrorText(a);
  const nb = normalizeErrorText(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  const shorter = Math.min(na.length, nb.length);
  if (shorter >= MATCH_MIN_CHARS && (na.startsWith(nb) || nb.startsWith(na))) return true;
  return shorter >= MATCH_PREFIX_CHARS && na.slice(0, MATCH_PREFIX_CHARS) === nb.slice(0, MATCH_PREFIX_CHARS);
}

/**
 * Whether an entry is about this failure: it names the tool, and its error text
 * matches. An entry logged before `errorText` existed is matched on its symptom
 * instead — agents were always told to paste the exact error there — but only
 * by containment of a substantial opening of the failure's text, since a
 * symptom is prose around the error rather than the error itself. The symptom
 * is tried with its quotes kept as well as stripped, because the error is very
 * often sitting inside a pair of them.
 */
export function entryMatchesFailure(entry: IssueEntry, tool: string, errorText: string): boolean {
  if (!toolsOverlap(entry.tools, [tool])) return false;
  if (entry.errorText) return errorTextsMatch(entry.errorText, errorText);
  const needle = normalizeErrorText(errorText).slice(0, MATCH_PREFIX_CHARS);
  if (needle.length < MATCH_MIN_CHARS) return false;
  return (
    normalizeErrorText(entry.symptom, { keepQuotes: true }).includes(needle) ||
    normalizeErrorText(entry.symptom).includes(needle)
  );
}

// ------------------------------------------------------------------- writing

export function logIssue(input: LogIssueInput): LogIssueResult {
  const journal = journalFor(input.scope ?? "project");
  const version = packageVersion();
  const tools = uniqueTools(input.tools);

  // The title is the identity: the same title extends the entry. Failing that,
  // the same tool with the same error text is the same bug under a new name —
  // which is exactly how one week of one project produced two entries for one
  // problem (issue #102) — so it extends that entry instead of forking it.
  let id = slugify(input.title);
  let existing = fs.existsSync(entryPath(id, journal)) ? readEntry(entryPath(id, journal), journal.scope) : null;
  let mergedBy: LogIssueResult["mergedBy"];
  if (existing) {
    mergedBy = "title";
  } else if (input.errorText && tools.length > 0) {
    const errorText = input.errorText;
    const twin = readJournalEntries(journal).find(
      (e) => e.id !== id && tools.some((t) => entryMatchesFailure(e, t, errorText))
    );
    if (twin) {
      existing = twin;
      id = twin.id;
      mergedBy = "errorText";
    }
  }

  const reopened = existing?.archived === true;
  const entry: IssueEntry = {
    id,
    // On an error-text merge the existing title stays: it is the id, and the
    // one the index has been showing.
    title: mergedBy === "errorText" ? existing!.title : oneLine(input.title),
    scope: journal.scope,
    tools: uniqueTools(existing?.tools, tools),
    kind: input.kind ?? existing?.kind ?? "tool-bug",
    errorText: clipErrorText(input.errorText) ?? existing?.errorText,
    firstSeen: existing?.firstSeen || today(),
    lastSeen: today(),
    firstVersion: existing?.firstVersion || version,
    lastVersion: version,
    // Repeats are worth counting: an entry seen five times is the one most
    // worth reporting, and the count is the only evidence of that.
    occurrences: (existing?.occurrences ?? 0) + 1,
    // Reporting state belongs to the entry, not to this sighting — a fresh
    // description of a known problem must not un-report it. And it belongs to
    // the entry *in this scope*: the two journals are separate records of
    // separate claims, so reporting one says nothing about the other.
    reported: existing?.reported ?? false,
    issueUrl: existing?.issueUrl,
    // A deliberate new sighting outranks a retirement: the entry was archived
    // as gone, and here it is. The flag clears and the result says so.
    archived: false,
    symptom: input.symptom,
    // A cause worked out once is not lost because a later sighting was logged
    // without one.
    cause: input.cause ?? existing?.cause,
    workaround: input.workaround,
  };

  const file = writeEntry(entry, journal);

  const alsoIn = journals()
    .filter((j) => j.scope !== journal.scope)
    .filter((j) => fs.existsSync(entryPath(id, j)))
    .map((j) => j.scope);

  return {
    id,
    title: entry.title,
    path: file,
    scope: journal.scope,
    kind: entry.kind,
    occurrences: entry.occurrences,
    previouslyLogged: existing !== null,
    ...(mergedBy ? { mergedBy } : {}),
    reported: entry.reported,
    issueUrl: entry.issueUrl,
    lastVersion: version,
    ...(reopened ? { reopened: true as const, previousArchiveReason: existing?.archivedReason } : {}),
    ...(alsoIn.length > 0 ? { alsoIn } : {}),
    ...(mergedBy === "errorText"
      ? {
          note:
            `Merged into the existing entry "${entry.title}" (${journal.scope}:${id}): same tool, same error text. ` +
            `The title you passed was not used — reuse this one to extend it again.`,
        }
      : {}),
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

/**
 * One line per entry: enough to decide which one is worth opening. The title
 * is the summary — a clipped opening of the symptom used to ride along, and it
 * roughly doubled the cost of every line for a sentence the title already said.
 */
export interface IssueIndexEntry {
  id: string;
  title: string;
  /** Which journal it came from — and half of the handle that opens it. */
  scope: JournalScope;
  tools: string[];
  kind: IssueKind;
  lastSeen: string;
  /** The server version it was last seen on. Absent on entries older than the stamp. */
  lastVersion?: string;
  occurrences: number;
  reported: boolean;
  /** Present only on an archived entry, which is only listed with `includeArchived`. */
  archived?: true;
  archivedReason?: string;
}

/** A full entry as the listing returns it: the file, plus the computed archive verdict. */
export type IssueView = IssueEntry & { archivedReason?: string };

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
  /** List archived entries too, flagged. Default false: they are counted in `archivedCount` and hidden. */
  includeArchived?: boolean;
  /** Injected by tests; the real clock and version otherwise. */
  context?: ArchiveContext;
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
  /**
   * Matching entries that are archived. Hidden unless `includeArchived`, in
   * which case they are in `issues` too, flagged. Always present on a search so
   * "nothing matched" and "everything that matched is archived" read differently.
   */
  archivedCount?: number;
  issues: Array<IssueView | IssueIndexEntry>;
  /** Matches the cap kept back. Present only when the cap actually bit. */
  omitted?: number;
  /** Present on an index: the call that turns one line into the fix it summarises. */
  next?: string;
}

/** Two journals double the listing; this is what keeps it from being unbounded. */
const DEFAULT_LIMIT = 50;

function withVerdict(e: IssueEntry, reason: string | null): IssueView {
  // The output's `archived` is the computed verdict, not only the file's flag:
  // "hidden from the index" is the question a reader of this field is asking.
  return reason === null
    ? { ...e, archived: false, archivedReason: undefined }
    : { ...e, archived: true, archivedReason: reason };
}

function toIndexEntry(e: IssueEntry, reason: string | null): IssueIndexEntry {
  return {
    id: e.id,
    title: e.title,
    scope: e.scope,
    tools: e.tools,
    kind: e.kind,
    lastSeen: e.lastSeen,
    ...(e.lastVersion ? { lastVersion: e.lastVersion } : {}),
    occurrences: e.occurrences,
    reported: e.reported,
    ...(reason !== null ? { archived: true as const, archivedReason: reason } : {}),
  };
}

export function readJournalEntries(journal: JournalRef): IssueEntry[] {
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
  const ctx = options.context ?? archiveContext();

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
    serverVersion: ctx.version,
    platform: process.platform,
  };

  // A named entry is a read, not a search: the filters would only be able to
  // hide the thing that was asked for by name — and that includes the archive,
  // since the failure pointer names archived entries and has to lead somewhere.
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
      issues: [withVerdict(resolved.found, archiveReason(resolved.found, ctx))],
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
  const namesTool = (e: IssueEntry) => wanted !== undefined && e.tools.some((t) => t.toLowerCase() === wanted);
  const matched = entries.filter((e) => {
    const byStatus = status === "all" ? true : status === "reported" ? e.reported : !e.reported;
    if (!byStatus) return false;
    if (terms.length > 0 && !matchesQuery(e, terms)) return false;
    if (!wanted) return true;
    // The title is matched too: an entry logged before the `tools` field was
    // filled in still names the tool it is about.
    return namesTool(e) || e.title.toLowerCase().includes(wanted);
  });

  // The archive is an exit, not a filter: hidden by default, counted always.
  const verdicts = new Map(matched.map((e) => [e, archiveReason(e, ctx)] as const));
  const archivedCount = matched.filter((e) => verdicts.get(e) !== null).length;
  const filtered = options.includeArchived ? matched : matched.filter((e) => verdicts.get(e) === null);

  // Entries that name the tool outrank ones that only mention it in the title;
  // then most recent first, and among same-day entries the ones that keep
  // recurring. Scope is not a tiebreak: a lesson is worth reading because it is
  // recent and recurring, not because of which folder it happens to sit in.
  filtered.sort(
    (a, b) =>
      Number(namesTool(b)) - Number(namesTool(a)) ||
      b.lastSeen.localeCompare(a.lastSeen) ||
      b.occurrences - a.occurrences
  );

  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const shown = filtered.slice(0, limit);
  const omitted = filtered.length - shown.length;

  const detail = options.detail ?? "index";
  const first = shown[0];
  const hidden = options.includeArchived ? 0 : archivedCount;
  const nextParts: string[] = [];
  if (detail === "index" && first) {
    nextParts.push(
      `list_known_issues({ id: "${first.scope}:${first.id}" }) for the cause and the workaround. ` +
        `Prefix any id from this list with its own scope.`
    );
  }
  if (omitted > 0) nextParts.push(`${omitted} more matched — narrow with tool/query, or raise limit.`);
  if (hidden > 0) {
    nextParts.push(
      `${hidden} archived ${hidden === 1 ? "entry is" : "entries are"} hidden (not seen for ${ARCHIVE_AFTER_DAYS} days, ` +
        `last seen on an older server, or retired with archive_issue) — includeArchived: true lists them.`
    );
  }
  return {
    ...envelope,
    detail,
    count: filtered.length,
    archivedCount,
    issues:
      detail === "full"
        ? shown.map((e) => withVerdict(e, verdicts.get(e) ?? null))
        : shown.map((e) => toIndexEntry(e, verdicts.get(e) ?? null)),
    // Truncation is named and counted. A short answer that looked complete
    // would be the same class of lie as a swallowed error.
    ...(omitted > 0 ? { omitted } : {}),
    // The reason to read this journal is that something failed, so an index
    // that stopped short of the workaround would be worse than useless. Say
    // how to reach it, every time there is one to reach — and since ids are
    // only unique within a journal, spell the scope-qualified form out on a
    // real entry rather than leaving the caller to guess the syntax.
    ...(nextParts.length > 0 ? { next: nextParts.join(" ") } : {}),
  };
}

/** Find an entry by id across both journals, with the journal that holds it. */
function locate(id: string): { entry: IssueEntry; journal: JournalRef } {
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
  return { entry, journal };
}

/**
 * Mark an entry reported, in whichever journal holds it.
 *
 * Reporting state is per entry per journal: the same lesson written down in both
 * is two records of two claims, and sending one to the maintainers says nothing
 * about the other. Pass a scope-qualified id to be sure which one moves.
 */
export function markReported(id: string, url?: string): IssueEntry {
  const { entry, journal } = locate(id);
  entry.reported = true;
  if (url) entry.issueUrl = oneLine(url);
  writeEntry(entry, journal);
  return entry;
}

/**
 * Retire an entry by hand: hidden from the index until a deliberate `log_issue`
 * lands on it again. The file stays — it is the record, and it is meant to be
 * hand-edited — with the reason in its frontmatter, so a reader who opens it
 * by id or with `includeArchived` sees why it was put away. Calling it twice
 * replaces the reason.
 */
export function archiveIssue(id: string, reason: string): IssueEntry {
  const { entry, journal } = locate(id);
  entry.archived = true;
  entry.archivedReason = oneLine(reason);
  entry.archivedAt = today();
  writeEntry(entry, journal);
  return entry;
}
