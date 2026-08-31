/**
 * A few-hundred-token digest of `house-style.md`.
 *
 * ## Why this is here and not in `packages/jsx/style.jsx`
 *
 * The *reading* stays over the bridge, for the reason it always has: the bridge
 * is the one channel every client has, and it needs no working directory, no
 * `roots` and no filesystem tools on the client. Nothing here changes that — the
 * panel still opens the file beside the .aep and hands back the whole document.
 *
 * The *summarising* is a different question, and it belongs on this side for two
 * reasons. First, the panel does not update itself: a summariser shipped in the
 * ExtendScript bundle would be dark until the user reinstalled the panel and
 * relaunched After Effects, and in the meantime an old panel would return the
 * full document to a caller that believes it asked for a digest — which is the
 * one failure mode worse than not having the feature. Here it is live the moment
 * the server updates, on whatever panel is already running. Second, this is
 * regex-heavy parsing of a markdown document nobody controls; ExtendScript is
 * ES3-ish, and doing it there would be miserable and untestable without AE.
 *
 * ## What it must not do
 *
 * The document is written by a designer, in whatever shape they like. Recognise
 * what can be recognised and *say what was left out*; when nothing can be
 * recognised, return the opening of the document verbatim and say so. A summary
 * that silently drops the user's style rules is the same class of lie as a
 * swallowed error — and it would be an invisible one, because the caller would
 * go on to build something plausible in the wrong colours.
 */

export interface PaletteEntry {
  /** Whatever the document calls it. Empty when the line carried a hex and nothing else. */
  name: string;
  hex: string;
}

export interface HouseStyleSummary {
  /** False when nothing recognisable was found — `head` carries the document instead. */
  structured: boolean;
  palette: PaletteEntry[];
  /** Fonts, sizes, weights: three lines at most. */
  type: string[];
  /** Durations, easing, defaults: one line. */
  motion: string;
  layout: string[];
  /** Headings that had content and were not recognised, named rather than dropped in silence. */
  sectionsOmitted?: string[];
  /** Present only when `structured` is false: the opening of the document, verbatim. */
  head?: string;
}

export interface HouseStyleSummaryResult {
  summary: HouseStyleSummary;
  note: string;
}

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

const SECTION_KEYWORDS: Array<{ key: "palette" | "type" | "motion" | "layout"; words: string[] }> = [
  { key: "palette", words: ["palette", "colour", "color", "swatch"] },
  { key: "type", words: ["type", "typograph", "font", "lettering", "typeface"] },
  { key: "motion", words: ["motion", "animation", "timing", "easing", "ease", "transition"] },
  // "Rules" is in the template this project's own style-guide guide hands out,
  // and it holds constraints of exactly the kind the layout bullets carry. It
  // would otherwise be named as unsummarised on almost every guide written.
  {
    key: "layout",
    words: ["layout", "grid", "spacing", "composition", "margin", "safe area", "framing", "rule", "constraint"],
  },
];

const MAX_PALETTE = 24;
const MAX_TYPE_LINES = 3;
const MAX_LAYOUT_LINES = 8;
const MAX_MOTION_CHARS = 240;
const MAX_LINE_CHARS = 160;
const MAX_SECTIONS_OMITTED = 12;
const HEAD_CHARS = 900;

interface Heading {
  level: number;
  text: string;
  /** Index of the first content line after the heading. */
  from: number;
}

/**
 * ATX headings, plus the setext forms a hand-written document is quite likely to
 * use. Two things that look like headings and are not: a `#` line inside a
 * fenced code block, and the closing `---` of YAML frontmatter, which would
 * otherwise turn the last frontmatter key into a section title.
 */
function findHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fenced = false;
  // Frontmatter only exists when the very first line opens it.
  let frontmatter = /^---\s*$/.test(lines[0] ?? "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (frontmatter) {
      if (i > 0 && /^---\s*$/.test(line)) frontmatter = false;
      continue;
    }

    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      headings.push({ level: atx[1]!.length, text: atx[2]!.trim(), from: i + 1 });
      continue;
    }
    const underline = /^ {0,3}(={3,}|-{3,})\s*$/.exec(line);
    if (underline && i > 0) {
      const above = lines[i - 1]!.trim();
      // The heading text is the line above, so that line must be real text —
      // not blank, not another heading, not a rule.
      if (above.length > 0 && !/^ {0,3}#{1,6}\s/.test(above) && !/^[-=*_\s]+$/.test(above)) {
        headings.push({ level: underline[1]!.startsWith("=") ? 1 : 2, text: above, from: i + 1 });
      }
    }
  }
  return headings;
}

/**
 * Every kind a heading names, not the first. "Colour and type" is both, and
 * picking one would drop the other's lines without ever saying so.
 */
function classifyAll(heading: string): Set<"palette" | "type" | "motion" | "layout"> {
  const text = heading.toLowerCase();
  const kinds = new Set<"palette" | "type" | "motion" | "layout">();
  for (const { key, words } of SECTION_KEYWORDS) {
    if (words.some((w) => text.includes(w))) kinds.add(key);
  }
  return kinds;
}

/**
 * Only the prose directly under a heading, stopping at the next heading of any
 * rank. Sections are assembled from these rather than from whole subtrees: a
 * parent that took its subtree would double every nested line into its own
 * bucket, and the walk below decides subsection by subsection which of them a
 * classified parent may claim.
 */
function ownLines(lines: string[], headings: Heading[], index: number): string[] {
  const here = headings[index]!;
  const next = headings[index + 1];
  // A setext heading's text is the line above its underline, so it is not part
  // of the section that ends there.
  const end = next === undefined ? lines.length : next.from - (isSetext(lines, next) ? 2 : 1);
  return lines.slice(here.from, Math.max(here.from, end));
}

function isSetext(lines: string[], heading: Heading): boolean {
  const underline = lines[heading.from - 1];
  return underline !== undefined && /^ {0,3}(={3,}|-{3,})\s*$/.test(underline);
}

/** Bullet markers, emphasis, table pipes and code ticks are noise in a digest. */
function condense(line: string): string {
  let text = line.trim();
  if (/^\|/.test(text)) {
    const cells = text
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    // A table's `|---|---|` separator carries nothing.
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return "";
    text = cells.join(" · ");
  }
  text = text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS).trimEnd()}…` : text;
}

function contentLines(lines: string[]): string[] {
  return lines.map(condense).filter((l) => l.length > 0 && !/^```/.test(l));
}

/**
 * Palette entries are hunted across the whole document, not only inside a
 * colour-named section: plenty of style guides list hexes inline under
 * "Brand", "Chips" or nothing at all, and a hex is unambiguous evidence in a
 * way a heading is not.
 */
function readPalette(lines: string[]): PaletteEntry[] {
  const found: PaletteEntry[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    HEX.lastIndex = 0;
    const hexes = raw.match(HEX);
    if (!hexes) continue;

    const isTableRow = /^\s*\|/.test(raw);
    let name = "";
    if (isTableRow) {
      const cells = raw
        .split("|")
        .map((c) => c.trim().replace(/\*\*|__|`/g, "").trim())
        .filter((c) => c.length > 0);
      name = cells.find((c) => !/^#[0-9a-fA-F]{3,8}$/.test(c) && !/^:?-{2,}:?$/.test(c)) ?? "";
    } else {
      // Only the text *before* the first hex. Taking the whole line with the
      // hexes cut out drags the description in with it — "Ink: #101010 — body
      // copy and rules" would be named "Ink: body copy and rules" — and on a
      // line carrying several colours it produces nonsense.
      name = raw
        .slice(0, raw.indexOf(hexes[0]!))
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+[.)]\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/[|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[:=–—-]+$/, "")
        .trim();
    }
    if (name.length > 40) name = `${name.slice(0, 40).trimEnd()}…`;

    for (const hex of hexes) {
      const key = hex.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name, hex });
      // Only the first hex on a line gets the line's name; a row listing several
      // would otherwise claim they are all called the same thing.
      name = "";
      if (found.length >= MAX_PALETTE) return found;
    }
  }
  return found;
}

export function summarizeHouseStyle(content: string): HouseStyleSummaryResult {
  const lines = content.split(/\r\n|\r|\n/);
  const headings = findHeadings(lines);

  const buckets: Record<"type" | "motion" | "layout", string[]> = { type: [], motion: [], layout: [] };
  const omitted: string[] = [];

  // A classified section absorbs its subsections, so `### Display` under
  // `## Type` is summarised as type rather than reported as unsummarised.
  const absorbed = new Array<boolean>(headings.length).fill(false);
  const ownCache = new Map<number, string[]>();
  const own = (i: number): string[] => {
    let value = ownCache.get(i);
    if (!value) ownCache.set(i, (value = contentLines(ownLines(lines, headings, i))));
    return value;
  };
  headings.forEach((heading, i) => {
    if (absorbed[i]) return;
    const kinds = classifyAll(heading.text);

    if (kinds.size === 0) {
      // Judged on its own prose only: a `# House style` wrapper around the
      // whole document has none, and must not be reported as dropped when
      // every section beneath it was read.
      if (own(i).length > 0 && !omitted.includes(heading.text)) omitted.push(heading.text);
      return;
    }

    // Absorb the subsections that mean nothing on their own — `### Display`
    // under `## Type` — and stop at the first one that classifies itself.
    // That stop is what keeps a document whose first heading is underlined
    // `===` and whose others are underlined `---` readable: markdown ranks
    // those as parent and children, but the author meant them as peers, and
    // swallowing Motion into Type would lose it without a word.
    const body = [...own(i)];
    for (let j = i + 1; j < headings.length && headings[j]!.level > heading.level; j++) {
      if (classifyAll(headings[j]!.text).size > 0) break;
      absorbed[j] = true;
      const sub = own(j);
      if (sub.length === 0) continue;
      // Keep the label: "Display: Canela Deck, 84px" reads better in three
      // lines than the size on its own.
      body.push(`${headings[j]!.text}: ${sub[0]}`, ...sub.slice(1));
    }

    // A palette section needs no bucket — the hex scan across the whole
    // document already has it — but it still absorbs, so its subsections are
    // not reported as dropped when their colours were in fact read.
    const bucketed = [...kinds].filter((k) => k !== "palette") as Array<"type" | "motion" | "layout">;
    if (bucketed.length === 0 || body.length === 0) return;
    for (const kind of bucketed) buckets[kind].push(...body);
  });

  const palette = readPalette(lines);
  const type = buckets.type.slice(0, MAX_TYPE_LINES);
  const layout = buckets.layout.slice(0, MAX_LAYOUT_LINES);
  const motionJoined = buckets.motion.join("; ");
  const motion =
    motionJoined.length > MAX_MOTION_CHARS
      ? `${motionJoined.slice(0, MAX_MOTION_CHARS).trimEnd()}…`
      : motionJoined;

  const structured = palette.length > 0 || type.length > 0 || layout.length > 0 || motion.length > 0;
  const chars = content.length;

  if (!structured) {
    const head = content.trim().slice(0, HEAD_CHARS);
    return {
      summary: {
        structured: false,
        palette: [],
        type: [],
        motion: "",
        layout: [],
        head: head + (content.trim().length > head.length ? "…" : ""),
        ...(omitted.length > 0 ? { sectionsOmitted: omitted.slice(0, MAX_SECTIONS_OMITTED) } : {}),
      },
      note:
        `This style guide has no palette, type, motion or layout section this summariser could recognise, ` +
        `so the text above is the opening of the document verbatim and nothing has been interpreted. ` +
        `Call get_house_style({ detail: "full" }) to read all ${chars} characters.`,
    };
  }

  const dropped: string[] = [];
  if (buckets.type.length > type.length) dropped.push(`${buckets.type.length - type.length} more type lines`);
  if (buckets.layout.length > layout.length)
    dropped.push(`${buckets.layout.length - layout.length} more layout lines`);
  if (omitted.length > 0) dropped.push(`sections: ${omitted.slice(0, MAX_SECTIONS_OMITTED).join(", ")}`);

  return {
    summary: {
      structured: true,
      palette,
      type,
      motion,
      layout,
      ...(omitted.length > 0 ? { sectionsOmitted: omitted.slice(0, MAX_SECTIONS_OMITTED) } : {}),
    },
    note:
      `This is a summary, not the style guide. The document is ${chars} characters; ` +
      `call get_house_style({ detail: "full" }) for all of it before editing it or ` +
      `when a detail here is not enough.` +
      (dropped.length > 0 ? ` Not summarised — ${dropped.join("; ")}.` : ""),
  };
}

export type HouseStyleDetail = "summary" | "full";

/**
 * Post-process the panel's `get_house_style` answer.
 *
 * Anything without a document — an unsaved project, or a project with no style
 * guide yet — is passed straight through. Those two answers are the tool's two
 * reported costs, they are already worded for the agent, and a summariser has
 * nothing to add to them.
 */
export function applyHouseStyleDetail(result: unknown, detail: HouseStyleDetail): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (typeof r.content !== "string" || r.content.length === 0) return result;
  if (detail === "full") return { ...r, detail: "full" };

  const { summary, note } = summarizeHouseStyle(r.content);
  const { content, ...rest } = r;
  return {
    ...rest,
    detail: "summary",
    // The caller has to be able to judge whether the full read is worth it.
    characters: content.length,
    lines: content.split(/\r\n|\r|\n/).length,
    summary,
    note,
  };
}
