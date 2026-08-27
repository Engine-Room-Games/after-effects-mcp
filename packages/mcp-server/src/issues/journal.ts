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
 * It lives in `.ae-mcp/` inside the project folder, so it sits next to the work
 * it came out of and travels with it. Untracked, but not by accident: the folder
 * ignores itself (see `ensureJournalDir`) rather than relying on the project
 * keeping a .gitignore rule, since most of these folders are not repositories at
 * all and the ones that are should not carry these notes into a commit.
 */

/** Where reports go. Read by the reporting command, not hardcoded in it. */
export const REPO = "Engine-Room-Games/after-effects-mcp";
export const NEW_ISSUE_URL = `https://github.com/${REPO}/issues/new`;

const SECTION_SYMPTOM = "What went wrong";
const SECTION_CAUSE = "Why";
const SECTION_WORKAROUND = "What worked";

export interface IssueEntry {
  id: string;
  title: string;
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
}

export interface LogIssueResult {
  id: string;
  path: string;
  occurrences: number;
  /** True when an entry already existed — the agent hit a known problem. */
  previouslyLogged: boolean;
  /** Already sent to the maintainers: do not ask the user to report it again. */
  reported: boolean;
  issueUrl?: string;
}

/** Where the journal ended up — reported so the agent can always say where its notes live. */
export type JournalScope = "project" | "home";

/**
 * The project folder is the working directory the client started this server in,
 * which is what "the folder the user has open" means for every client that has
 * such a concept.
 *
 * Some do not: Claude Desktop spawns servers from the filesystem root. Writing a
 * project journal to `/` would be wrong even where it is permitted, so an
 * unusable working directory falls back to the user's home rather than failing
 * the tool. `list_known_issues` reports the scope it resolved to, so the fallback
 * is visible rather than silent.
 */
export function journalRoot(): { dir: string; scope: JournalScope } {
  const override = process.env.AE_MCP_HOME?.trim();
  if (override && override.length > 0) return { dir: override, scope: "project" };

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

export function journalDir(): string {
  return path.join(journalRoot().dir, "issues");
}

/**
 * Create the journal and make it invisible to git in one step. A `.gitignore`
 * of `*` inside the folder ignores the folder's whole contents — including
 * itself — without touching a rule the user maintains, and works the same in a
 * repository, a folder that becomes one later, and one that never does.
 */
function ensureJournalDir(): string {
  const { dir } = journalRoot();
  const issues = path.join(dir, "issues");
  fs.mkdirSync(issues, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
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

function entryPath(id: string): string {
  const dir = path.resolve(journalDir());
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
export function parse(text: string, fallbackId: string): IssueEntry {
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

function readEntry(file: string): IssueEntry | null {
  try {
    return parse(fs.readFileSync(file, "utf8"), path.basename(file, ".md"));
  } catch {
    return null;
  }
}

export function logIssue(input: LogIssueInput): LogIssueResult {
  const id = slugify(input.title);
  const file = entryPath(id);
  const existing = fs.existsSync(file) ? readEntry(file) : null;

  const entry: IssueEntry = {
    id,
    title: oneLine(input.title),
    tools: input.tools ?? existing?.tools ?? [],
    firstSeen: existing?.firstSeen || today(),
    lastSeen: today(),
    // Repeats are worth counting: an entry seen five times is the one most
    // worth reporting, and the count is the only evidence of that.
    occurrences: (existing?.occurrences ?? 0) + 1,
    // Reporting state belongs to the entry, not to this sighting — a fresh
    // description of a known problem must not un-report it.
    reported: existing?.reported ?? false,
    issueUrl: existing?.issueUrl,
    symptom: input.symptom,
    // A cause worked out once is not lost because a later sighting was logged
    // without one.
    cause: input.cause ?? existing?.cause,
    workaround: input.workaround,
  };

  ensureJournalDir();
  fs.writeFileSync(file, render(entry), "utf8");

  return {
    id,
    path: file,
    occurrences: entry.occurrences,
    previouslyLogged: existing !== null,
    reported: entry.reported,
    issueUrl: entry.issueUrl,
  };
}

export type IssueStatus = "all" | "unreported" | "reported";

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
  /** One entry, in full. Takes precedence over every filter. */
  id?: string;
  detail?: IssueDetail;
}

export interface IssueListing {
  dir: string;
  /** "project" for this folder's own journal; "home" when there was no usable working directory. */
  scope: JournalScope;
  repo: string;
  newIssueUrl: string;
  serverVersion: string;
  platform: string;
  /** Which shape `issues` is in, so a short answer is never mistaken for a complete one. */
  detail: IssueDetail;
  count: number;
  issues: Array<IssueEntry | IssueIndexEntry>;
  /** Present on an index: the call that turns one line into the fix it summarises. */
  next?: string;
}

const SUMMARY_CHARS = 160;

function summarize(entry: IssueEntry): string {
  const text = oneLine(entry.symptom || entry.workaround || "");
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS).trimEnd()}…` : text;
}

function toIndexEntry(e: IssueEntry): IssueIndexEntry {
  return {
    id: e.id,
    title: e.title,
    tools: e.tools,
    lastSeen: e.lastSeen,
    occurrences: e.occurrences,
    reported: e.reported,
    summary: summarize(e),
  };
}

function readAllEntries(): IssueEntry[] {
  const dir = journalDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readEntry(path.join(dir, f)))
      .filter((e): e is IssueEntry => e !== null);
  } catch {
    return []; // No journal yet is the normal state, not an error.
  }
}

function matchesQuery(entry: IssueEntry, terms: string[]): boolean {
  const haystack = `${entry.title} ${entry.symptom} ${entry.tools.join(" ")}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function listIssues(options: ListIssuesOptions = {}): IssueListing {
  const { scope } = journalRoot();
  const dir = journalDir();
  const entries = readAllEntries();
  const envelope = {
    dir,
    scope,
    repo: REPO,
    newIssueUrl: NEW_ISSUE_URL,
    serverVersion: packageVersion(),
    platform: process.platform,
  };

  // A named entry is a read, not a search: the filters would only be able to
  // hide the thing that was asked for by name.
  const wantedId = options.id?.trim();
  if (wantedId) {
    const found = entries.find((e) => e.id === slugify(wantedId));
    if (!found) {
      throw new Error(
        `No journal entry with id "${wantedId}".` +
          (entries.length > 0 ? ` Known ids: ${entries.map((e) => e.id).join(", ")}` : " The journal is empty.")
      );
    }
    return { ...envelope, detail: "full", count: 1, issues: [found] };
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
  filtered.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.occurrences - a.occurrences);

  const detail = options.detail ?? "index";
  return {
    ...envelope,
    detail,
    count: filtered.length,
    issues: detail === "full" ? filtered : filtered.map(toIndexEntry),
    // The reason to read this journal is that something failed, so an index
    // that stopped short of the workaround would be worse than useless. Say
    // how to reach it, every time there is one to reach.
    ...(detail === "index" && filtered.length > 0
      ? { next: 'list_known_issues({ id: "<id>" }) for the cause and the workaround.' }
      : {}),
  };
}

export function markReported(id: string, url?: string): IssueEntry {
  const file = entryPath(slugify(id));
  const entry = fs.existsSync(file) ? readEntry(file) : null;
  if (!entry) {
    const known = readAllEntries().map((e) => e.id);
    throw new Error(
      `No journal entry with id "${id}".` + (known.length > 0 ? ` Known ids: ${known.join(", ")}` : "")
    );
  }
  entry.reported = true;
  if (url) entry.issueUrl = oneLine(url);
  fs.writeFileSync(file, render(entry), "utf8");
  return entry;
}
