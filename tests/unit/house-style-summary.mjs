// The house-style summariser.
//
// `get_house_style` now answers with a digest by default, which means every
// caller that used to receive the user's actual style rules now receives this
// module's reading of them. Two failure modes matter and neither announces
// itself: a summary that quietly drops a rule, and a summary that mangles the
// non-ASCII a designer types — curly quotes, accented font names, en dashes in
// a size range. The second one is the same encoding that CLAUDE.md's recipe 10
// says fails *silently*, and inserting a processing step between the file and
// the caller is a new place for it to break.
//
// There is no After Effects here and no panel: the summariser is server-side
// precisely so it can be tested with neither.
//
//   node tests/unit/house-style-summary.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { summarizeHouseStyle, applyHouseStyleDetail } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "style", "summary.js")).href
);

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
}

const hexes = (s) => s.summary.palette.map((p) => p.hex.toUpperCase());
const named = (s, hex) => s.summary.palette.find((p) => p.hex.toUpperCase() === hex.toUpperCase())?.name;

// ------------------------------------------------- the shape the guide hands out
// Verbatim from the "Starting point" template in src/guides/style-guide.md,
// plus the two sections a real guide grows: one the summariser knows and one
// it does not.
const CANONICAL = `# House style

## Palette
| Role | Colour | Notes |
|---|---|---|
| Background | \`#0B0D12\` | |
| Primary text | \`#FFFFFF\` | |
| Accent | \`#3DC46E\` | Emphasis and positive values |
| Negative | \`#E03333\` | |

## Type
- Headings: Inter Semibold, 56-72px, tracking -10
- Body: Inter Regular, 28-34px
- Left-aligned unless stated otherwise

## Motion
- Standard in: scale 0 -> 108 -> 100, easy ease, ~0.4s
- Standard out: scale -> 0, ~0.3s
- Easy ease on everything; no linear motion unless mechanical

## Layout
- 1920x1080 at 30fps
- 120px safe margin from every edge

## Rules
- Never put text directly on footage - always on a rounded chip
- Total runtime under 8 seconds

## Delivery
- ProRes 422 HQ, then h264 for review
`;

const canonical = summarizeHouseStyle(CANONICAL);
ok("the canonical guide summarises", canonical.summary.structured === true);
ok(
  "the palette is every hex, in document order",
  hexes(canonical).join(",") === "#0B0D12,#FFFFFF,#3DC46E,#E03333"
);
ok("a table row names its colour", named(canonical, "#3DC46E") === "Accent");
ok("a two-word role survives", named(canonical, "#FFFFFF") === "Primary text");
ok("type is three lines", canonical.summary.type.length === 3);
ok("type keeps the font and the size", /Inter Semibold/.test(canonical.summary.type[0]));
ok("motion is one line", typeof canonical.summary.motion === "string" && !canonical.summary.motion.includes("\n"));
ok("motion keeps both defaults", /Standard in/.test(canonical.summary.motion) && /Standard out/.test(canonical.summary.motion));
ok("layout is bullets", Array.isArray(canonical.summary.layout) && canonical.summary.layout.length >= 2);
// "Rules" is in the guide's own template. Folding it into layout rather than
// naming it as dropped is the difference between summarising a guide and
// summarising most of one.
ok("Rules folds into layout", canonical.summary.layout.some((l) => /rounded chip/.test(l)));
// The other half of that bargain: anything genuinely not read is named.
ok("an unrecognised section is named", canonical.summary.sectionsOmitted.includes("Delivery"));
ok("the wrapper heading is not reported as dropped", !canonical.summary.sectionsOmitted.includes("House style"));
ok("the note says it is a summary", /summary, not the style guide/.test(canonical.note));
ok("the note names the way out", /detail: "full"/.test(canonical.note));
ok("the note counts the document", canonical.note.includes(String(CANONICAL.length)));
ok("the note repeats what was dropped", /Delivery/.test(canonical.note));

// ------------------------------------------------------- a hand-written shape
// Setext headings, colours as `Name: #hex` lines, no tables anywhere. Nobody
// has to write the template's shape and plenty of people will not.
const LOOSE = `Colours
=======

- Ink: #101010 — every rule and every caption
- Paper: #FAF7F2
- Signal: #FF5A1F

Typography
----------

Titles set in Founders Grotesk X-Condensed at 96pt.
Body copy is Untitled Sans, 30pt, 40pt leading.

Timing
------

Everything moves in 12 frames with a 30% overshoot.

Grid
----

* Twelve columns, 80px gutters
* Nothing crosses the 96px margin
`;

const loose = summarizeHouseStyle(LOOSE);
ok("setext headings are headings", loose.summary.structured === true);
ok("loose palette is found", hexes(loose).join(",") === "#101010,#FAF7F2,#FF5A1F");
ok("a bullet names its colour", named(loose, "#101010") === "Ink");
ok("a trailing description is not the name", named(loose, "#101010") === "Ink");
ok("'Typography' reads as type", loose.summary.type.some((l) => /Founders Grotesk/.test(l)));
ok("'Timing' reads as motion", /12 frames/.test(loose.summary.motion));
ok("'Grid' reads as layout", loose.summary.layout.some((l) => /Twelve columns/.test(l)));
ok("nothing was silently dropped", loose.summary.sectionsOmitted === undefined);

// ---------------------------------------------- the one it cannot make sense of
// The failure this test exists for. A style guide written as prose, with no
// headings and no hexes, must not come back as an empty summary that reads as
// "this project has no rules" — it has to hand back the document and say so.
const PROSE = `Everything we make is quiet. Nothing flashes, nothing bounces, and
nothing arrives faster than the eye can follow it. If a thing has to move, it
should look like it was always going to end up there.

Keep the frame calm. When in doubt, take something out rather than making the
remaining things smaller, and never let a caption fight the footage behind it
for attention.
`;

const prose = summarizeHouseStyle(PROSE);
ok("an unreadable guide is not structured", prose.summary.structured === false);
ok("an unreadable guide returns no invented palette", prose.summary.palette.length === 0);
ok("an unreadable guide hands back the document", typeof prose.summary.head === "string" && prose.summary.head.length > 0);
ok("the head is verbatim", PROSE.trim().startsWith(prose.summary.head.replace(/…$/, "")));
ok("the note admits it could not structure it", /could not|no palette, type, motion or layout/i.test(prose.note));
ok("the note still names the way out", /detail: "full"/.test(prose.note));
ok("the note counts the document", prose.note.includes(String(PROSE.length)));

// A document with nothing but hexes is still partly readable, and saying so is
// more useful than falling back on the whole text.
const HEX_ONLY = "Brand: #112233 and #445566 and #778899.\n";
const hexOnly = summarizeHouseStyle(HEX_ONLY);
ok("hexes alone count as structure", hexOnly.summary.structured === true && hexOnly.summary.palette.length === 3);
ok("hexes alone leave the rest empty", hexOnly.summary.type.length === 0 && hexOnly.summary.motion === "");
// Only the first hex on a line may take the line's name; the others are not
// all called "Brand".
ok("one name per line, not per hex", named(hexOnly, "#112233") === "Brand" && named(hexOnly, "#445566") === "");

// -------------------------------------------------------------- non-ASCII
// CLAUDE.md recipe 10: this is the encoding that fails silently. The summariser
// is a new step between the file and the caller, so every non-ASCII character
// that reaches it has to come out the other side unchanged.
const CURLY = "“quiet”";
const NON_ASCII = `# Maison — style

## Palette
| Rôle | Couleur |
|---|---|
| Encre | #1B1B1B |
| Crème | #F4EFE6 |

## Type
- Titres : Söhne Breit, 72–96 px, ${CURLY} et discret
- Corps : Neue Haas Grotesk Düsseldorf, 30 px

## Motion
- Tout bouge en 12 images, ease « doux », ±0,4 s

## Layout
- Marge de 96 px — jamais moins
`;

const nonAscii = summarizeHouseStyle(NON_ASCII);
ok("accented palette names survive", named(nonAscii, "#F4EFE6") === "Crème");
ok("accented font names survive", nonAscii.summary.type.some((l) => l.includes("Söhne Breit")));
ok("an en dash in a size range survives", nonAscii.summary.type.some((l) => l.includes("72–96")));
ok("curly quotes survive", nonAscii.summary.type.some((l) => l.includes(CURLY)));
ok("guillemets survive", nonAscii.summary.motion.includes("«") && nonAscii.summary.motion.includes("»"));
ok("an em dash in a layout rule survives", nonAscii.summary.layout.some((l) => l.includes("—")));
// The heading itself carries an em dash, and it is classified, so it must not
// turn up in the dropped list.
ok("nothing non-ASCII was dropped", nonAscii.summary.sectionsOmitted === undefined);

// ------------------------------------------------------------- nested headings
const NESTED = `# House style

## Type

### Display
- Canela Deck, 84px

### Body
- Söhne, 28px

## Motion
- 10 frames, ease out
`;

const nested = summarizeHouseStyle(NESTED);
ok("a classified section absorbs its subsections", nested.summary.type.some((l) => /Canela Deck/.test(l)));
ok("subsection headings are not reported as dropped", nested.summary.sectionsOmitted === undefined);

// ------------------------------------------------- things that look like headings
const FRONTMATTER = `---
title: House style
updated: 2026-08-01
---

## Palette
- Ink: #222222

## Motion
- 8 frames
`;
const front = summarizeHouseStyle(FRONTMATTER);
ok("frontmatter is not a section", front.summary.sectionsOmitted === undefined);
ok("frontmatter does not stop the read", named(front, "#222222") === "Ink" && /8 frames/.test(front.summary.motion));

const FENCED = `## Palette
- Ink: #333333

\`\`\`
## Motion
- this is a code sample, not a rule
\`\`\`

## Layout
- 64px margin
`;
const fenced = summarizeHouseStyle(FENCED);
ok("a heading inside a code fence is not a section", fenced.summary.motion === "");
ok("the fence does not swallow what follows", fenced.summary.layout.some((l) => /64px margin/.test(l)));

// ------------------------------------------------------------- the envelope
const unsaved = {
  found: false,
  projectSaved: false,
  path: null,
  content: null,
  reason: "This After Effects project has never been saved, so there is no folder to keep the style guide in.",
};
ok("an unsaved project passes straight through", applyHouseStyleDetail(unsaved, "summary") === unsaved);
ok("an unsaved project passes through on full too", applyHouseStyleDetail(unsaved, "full") === unsaved);

const missing = { found: false, projectSaved: true, path: "/p/house-style.md", content: null, reason: "No style guide yet." };
ok("a missing guide passes straight through", applyHouseStyleDetail(missing, "summary") === missing);

const raw = { found: true, projectSaved: true, path: "/p/house-style.md", content: NON_ASCII, bytes: NON_ASCII.length };
const full = applyHouseStyleDetail(raw, "full");
ok("full still carries the document", full.content === NON_ASCII);
ok("full says which it is", full.detail === "full");

const summary = applyHouseStyleDetail(raw, "summary");
ok("summary drops the document", summary.content === undefined);
ok("summary says which it is", summary.detail === "summary");
ok("summary keeps where the file is", summary.path === "/p/house-style.md");
ok("summary keeps the found/saved answers", summary.found === true && summary.projectSaved === true);
// A caller has to be able to judge whether the full read is worth it.
ok("summary sizes the source", summary.characters === NON_ASCII.length && summary.lines > 10);
ok("summary carries the digest and the note", summary.summary.structured === true && typeof summary.note === "string");

// ------------------------------------------------------------ the measurement
// The reason the default changed. A guide that has grown past a page is the
// case the issue describes, so measure on one of those rather than on the
// four-section template.
const LONG =
  CANONICAL +
  "\n" +
  Array.from(
    { length: 40 },
    (_, i) =>
      `## Rules ${i}\n- Chips sit ${20 + i}px from the lower third baseline and never overlap the safe margin.\n` +
      `- Captions run at ${28 + i}px with 1.35 leading, and wrap before they reach two thirds of the frame width.\n`
  ).join("\n");

const long = summarizeHouseStyle(LONG);
const longBytes = JSON.stringify(long).length;
ok("a long guide still summarises", long.summary.structured === true);
ok("the digest is a fraction of the document", longBytes * 3 < LONG.length);
// And it says how much it held back, rather than reading as the whole guide.
ok("the digest says what it capped", /more layout lines/.test(long.note));

console.log(
  `house-style-summary: ${passed} assertions passed ` +
    `(a ${LONG.length}-character guide summarises to ${longBytes} bytes)`
);
