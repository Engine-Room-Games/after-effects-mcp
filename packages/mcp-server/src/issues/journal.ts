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
 * It lives in the user's home directory rather than in whatever project folder
 * happens to be open, for two reasons: the knowledge is about the tools, not
 * about one video, so it should follow the user across projects; and a home
 * directory is untracked by construction — nothing here is ever committed by
 * accident, and no .gitignore has to be maintained to keep it that way.
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

export function journalDir(): string {
  const override = process.env.AE_MCP_HOME?.trim();
  const home = override && override.length > 0 ? override : path.join(os.homedir(), ".after-effects-mcp");
  return path.join(home, "issues");
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

  fs.mkdirSync(path.dirname(file), { recursive: true });
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

export interface IssueListing {
  dir: string;
  repo: string;
  newIssueUrl: string;
  serverVersion: string;
  platform: string;
  count: number;
  issues: IssueEntry[];
}

export function listIssues(status: IssueStatus = "all", tool?: string): IssueListing {
  const dir = journalDir();
  let entries: IssueEntry[] = [];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readEntry(path.join(dir, f)))
      .filter((e): e is IssueEntry => e !== null);
  } catch {
    entries = []; // No journal yet is the normal state, not an error.
  }

  const wanted = tool?.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    const byStatus = status === "all" ? true : status === "reported" ? e.reported : !e.reported;
    if (!byStatus) return false;
    if (!wanted) return true;
    // The title is matched too: an entry logged before the `tools` field was
    // filled in still names the tool it is about.
    return e.tools.some((t) => t.toLowerCase() === wanted) || e.title.toLowerCase().includes(wanted);
  });
  // Most recent first, and among same-day entries the ones that keep recurring.
  filtered.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.occurrences - a.occurrences);

  return {
    dir,
    repo: REPO,
    newIssueUrl: NEW_ISSUE_URL,
    serverVersion: packageVersion(),
    platform: process.platform,
    count: filtered.length,
    issues: filtered,
  };
}

export function markReported(id: string, url?: string): IssueEntry {
  const file = entryPath(slugify(id));
  const entry = fs.existsSync(file) ? readEntry(file) : null;
  if (!entry) {
    const known = listIssues("all").issues.map((e) => e.id);
    throw new Error(
      `No journal entry with id "${id}".` + (known.length > 0 ? ` Known ids: ${known.join(", ")}` : "")
    );
  }
  entry.reported = true;
  if (url) entry.issueUrl = oneLine(url);
  fs.writeFileSync(file, render(entry), "utf8");
  return entry;
}
