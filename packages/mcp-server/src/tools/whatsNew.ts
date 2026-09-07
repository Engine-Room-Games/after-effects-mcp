/**
 * The `since` filter on `ae_guide({topic: "whats-new"})`, and the contract the
 * guide is written to so that filter can work.
 *
 * `guides/whats-new.md` is the one home of release history. It is read by an
 * agent in two situations: something behaves differently from what it expected,
 * and — the case this module exists for — a project is being brought up to date
 * after an upgrade by the absorb-release prompt. That second reader wants only
 * the releases it has not seen, once, and then never again. So the guide is
 * structured for a machine as well as a reader:
 *
 *   - one `## <semver>` section per release, newest first;
 *   - everything above the first release heading is the preamble, returned with
 *     every filtered read;
 *   - an entry is a bullet that opens with the rule as it now stands, and may
 *     carry indented `supersedes: <old rule>` lines quoting what a project's own
 *     docs would have said — the grep targets the absorb flow rewrites.
 *
 * Pure functions over text, so `tests/unit/whats-new.mjs` can hold the splitter,
 * the comparison (0.10.0 is newer than 0.9.0) and the real file's shape with no
 * server running.
 */

/** `## 0.4.0` — the only `##` headings allowed below the preamble. */
const RELEASE_HEADING = /^## v?(\d+\.\d+\.\d+)\s*$/;
/** An indented `supersedes:` line under a bullet. */
const SUPERSEDES_LINE = /^\s+supersedes:\s*(.+?)\s*$/;

export interface ReleaseSection {
  version: string;
  /** The heading line and everything under it, up to the next release heading. */
  text: string;
}

export interface SplitGuide {
  preamble: string;
  sections: ReleaseSection[];
}

/** `"0.10.0"` → `[0, 10, 0]`; anything that is not three dotted integers → `null`. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Numeric, field by field — never a string compare, which would put 0.10.0
 * before 0.9.0. Throws on a malformed version rather than guessing an order.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`Not a version: ${JSON.stringify(a)}`);
  if (!pb) throw new Error(`Not a version: ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * Split the guide body on its release headings. Lenient about anything else: a
 * non-release `##` below the first release is folded into the section it sits
 * in, because at runtime `ae_guide` must answer with what shipped rather than
 * throw. The contract itself is asserted by the unit test against the real file.
 */
export function splitReleases(body: string): SplitGuide {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const sections: ReleaseSection[] = [];
  let current: { version: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = RELEASE_HEADING.exec(line);
    if (m) {
      if (current) sections.push({ version: current.version, text: current.lines.join("\n").trimEnd() });
      current = { version: m[1]!, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push({ version: current.version, text: current.lines.join("\n").trimEnd() });

  return { preamble: preamble.join("\n").trimEnd(), sections };
}

/** Every `##` heading in the body — the unit test uses it to prove only releases sit there. */
export function h2Headings(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => /^## /.test(l))
    .map((l) => l.trim());
}

/** The old rules a piece of the guide names, in the order they appear. */
export function supersedesLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = SUPERSEDES_LINE.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

export interface WhatsNewRender {
  text: string;
  /** Versions of the sections in the answer, newest first. Empty when nothing was newer. */
  versions: string[];
  /** The newest release the guide describes, or null for a guide with no release sections. */
  newest: string | null;
}

/**
 * What `ae_guide({topic: "whats-new"})` answers.
 *
 * With `since`, only the sections strictly newer than it — the version named is
 * the one already absorbed, so it is excluded — behind the preamble. Nothing
 * newer is a short, explicit sentence rather than an empty string: an agent
 * that gets an empty answer cannot tell "up to date" from "broken". Either way
 * the first line names the server's own version, which is what the absorb flow
 * writes back into the project's docs; the guide cannot carry that itself, since
 * a build between releases is ahead of its newest section.
 */
export function renderWhatsNew(body: string, opts: { since?: string; serverVersion: string }): WhatsNewRender {
  const { preamble, sections } = splitReleases(body);
  const newest = sections.length > 0 ? sections[0]!.version : null;
  const server = `This server is after-effects-mcp ${opts.serverVersion}.`;

  if (opts.since === undefined) {
    return {
      text: `${server} Pass \`since\` to see only the releases after a version.\n\n${body.trim()}`,
      versions: sections.map((s) => s.version),
      newest,
    };
  }

  const since = opts.since.replace(/^v/, "");
  const newer = sections.filter((s) => compareSemver(s.version, since) > 0);
  if (newer.length === 0) {
    const described = newest ? `the newest release described here is ${newest}` : "this guide describes no releases";
    return {
      text: `${server} Nothing newer than ${since}: ${described}.`,
      versions: [],
      newest,
    };
  }

  const versions = newer.map((s) => s.version);
  const header = `${server} Showing releases after ${since}: ${versions.join(", ")}.`;
  const parts = [header, preamble, ...newer.map((s) => s.text)].filter((p) => p.length > 0);
  return { text: parts.join("\n\n"), versions, newest };
}
