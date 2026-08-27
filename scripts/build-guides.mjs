#!/usr/bin/env node
// Generates everything that carries prose to an agent, from one source each.
//
//   packages/mcp-server/src/guides/*.md    <- guidance, loaded when relevant
//   packages/mcp-server/src/prompts/*.md   <- user-invoked flows
//        |
//        +-> packages/mcp-server/src/generated/content.ts
//        |     MCP resources, prompts/get, the ae_guide tool, and the condensed
//        |     `instructions` sent in the initialize result. Reaches every client.
//        |
//        +-> plugin/skills/<name>/SKILL.md    Claude Code / claude.ai only
//        +-> plugin/commands/<name>.md        Claude Code only
//
// Skills and slash commands exist only in Claude's clients, so anything written
// only there reaches maybe half the users. Writing it twice reaches all of them
// and drifts within a release. So: write once, generate both.
//
//   node scripts/build-guides.mjs           regenerate
//   node scripts/build-guides.mjs --check   exit 1 if the outputs are stale

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guidesDir = path.join(root, "packages", "mcp-server", "src", "guides");
const promptsDir = path.join(root, "packages", "mcp-server", "src", "prompts");
const skillsDir = path.join(root, "plugin", "skills");
const commandsDir = path.join(root, "plugin", "commands");
const generatedFile = path.join(root, "packages", "mcp-server", "src", "generated", "content.ts");
const check = process.argv.includes("--check");

/**
 * The condensed core that goes into the MCP `instructions` field, which clients
 * fold into the system prompt at connection time. This is the one piece of
 * guidance that is always resident, in every client, so it is deliberately short
 * — the full guides sit behind `ae_guide` and the MCP resources for when an
 * agent needs the detail.
 */
const INSTRUCTIONS = `You are driving a live After Effects session through this server. The user sees
every change as it happens and every call is a real undo step in their project.

Six things that are not obvious from the tool list:

1. Read the house style before you build. \`get_house_style\` returns the user's
   palette, type and motion defaults for the project that is open. One cheap call.
2. Orient before you touch anything. \`get_layer_full\` returns a layer's
   transforms with keyframes and expressions, every effect and parameter, masks,
   markers and visible bounds in a single call — prefer it over several narrow reads.
3. Identify by id, never by index. Layer \`index\` shifts whenever layers are
   added, deleted or reordered. Carry \`(compId, layerId)\`.
4. Verify by reading properties back, not by screenshotting. Screenshots are
   one-off diagnostics: 2-3 across an animation, never per frame.
5. Bulk work goes through \`run_batch\` — one ExtendScript pass, one undo step.
6. When a tool fails in a way you do not understand, call \`list_known_issues\`
   before guessing; an earlier session may have solved it already. When you solve
   a new one, \`log_issue\` it.

Call \`ae_guide\` for the full guidance on any of this — topics: __TOPICS__.
If a tool reports it cannot reach After Effects, call \`check_setup\` and relay
its \`nextSteps\` verbatim; do not diagnose CEP by hand.`;

/**
 * Line endings are normalised everywhere in this script — on read, on write and
 * on both sides of `--check`. A Windows checkout with `core.autocrlf` gives you
 * CRLF sources, which would otherwise miss the frontmatter fence entirely and
 * make the generated files differ from the committed ones on that host alone.
 */
const lf = (text) => text.replace(/\r\n/g, "\n");

/** Split `---\nkey: value\n---\nbody` into its parts. */
function parse(file, text, required) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${path.basename(file)} has no frontmatter block`);
  const meta = {};
  // Only `key: value` on one line; descriptions are long but never wrapped.
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  for (const key of required) {
    if (!meta[key]) throw new Error(`${path.basename(file)} frontmatter is missing \`${key}\``);
  }
  // Trimmed at both ends: the leading newline after the frontmatter fence is an
  // artefact of the file format, not part of the prose.
  return { meta, body: m[2].trim(), raw: text };
}

function load(dir, required) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) {
    console.error(`No markdown found in ${path.relative(root, dir)}`);
    process.exit(1);
  }
  return files.map((f) => {
    const { meta, body, raw } = parse(f, lf(fs.readFileSync(path.join(dir, f), "utf8")), required);
    if (meta.name !== path.basename(f, ".md")) {
      throw new Error(`${f}: frontmatter name "${meta.name}" must match the filename`);
    }
    return { ...meta, body, raw };
  });
}

const guides = load(guidesDir, ["name", "description"]);
const prompts = load(promptsDir, ["name", "description"]);
const guideNames = guides.map((g) => g.name);

// The topic names are part of the `ae_guide` tool contract, and that schema
// lives in the shared package where this script's output cannot reach. Adding a
// guide without widening the enum would make it unreachable, so fail loudly
// instead of shipping a topic nobody can ask for.
const schemasFile = path.join(root, "packages", "shared", "src", "schemas.ts");
const topicsMatch = /export const GUIDE_TOPICS = \[([^\]]*)\] as const;/.exec(
  fs.readFileSync(schemasFile, "utf8")
);
if (!topicsMatch) {
  console.error(`Could not find GUIDE_TOPICS in ${path.relative(root, schemasFile)} — the pattern needs updating.`);
  process.exit(1);
}
const declared = [...topicsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (declared.join("|") !== guideNames.join("|")) {
  console.error(`GUIDE_TOPICS is out of step with packages/mcp-server/src/guides/.`);
  console.error(`  schemas.ts: ${declared.join(", ") || "(empty)"}`);
  console.error(`  guides:     ${guideNames.join(", ")}`);
  console.error(`\nUpdate GUIDE_TOPICS in ${path.relative(root, schemasFile)} to match.`);
  process.exit(1);
}

// ------------------------------------------------------------- content.ts
const guideEntries = guides
  .map(
    (g) => `  {
    name: ${JSON.stringify(g.name)},
    description: ${JSON.stringify(g.description)},
    body: ${JSON.stringify(g.body)},
  },`
  )
  .join("\n");

const promptEntries = prompts
  .map(
    (p) => `  {
    name: ${JSON.stringify(p.name)},
    description: ${JSON.stringify(p.description)},
    argumentHint: ${JSON.stringify(p["argument-hint"] ?? "")},
    body: ${JSON.stringify(p.body)},
  },`
  )
  .join("\n");

const generated = `// Generated by scripts/build-guides.mjs — do not edit.
// Sources: packages/mcp-server/src/{guides,prompts}/*.md

export interface Guide {
  /** Doubles as the skill folder name and the \`ae://guide/<name>\` resource path. */
  name: string;
  description: string;
  body: string;
}

export interface PromptTemplate {
  name: string;
  description: string;
  /** What the free-text argument is for; empty when the prompt takes none. */
  argumentHint: string;
  /** Contains \`$ARGUMENTS\` where the caller's text belongs. */
  body: string;
}

export const GUIDES: readonly Guide[] = [
${guideEntries}
];

export const PROMPTS: readonly PromptTemplate[] = [
${promptEntries}
];

export const GUIDE_NAMES: readonly string[] = GUIDES.map((g) => g.name);

export function getGuide(name: string): Guide | undefined {
  return GUIDES.find((g) => g.name === name);
}

export function getPrompt(name: string): PromptTemplate | undefined {
  return PROMPTS.find((p) => p.name === name);
}

/**
 * Sent to the client in the initialize result, which most clients fold into the
 * system prompt. Always resident, so it stays short and points at \`ae_guide\`
 * for the rest.
 */
export const SERVER_INSTRUCTIONS = ${JSON.stringify(INSTRUCTIONS.replace("__TOPICS__", guideNames.join(", ")))};
`;

// --------------------------------------------------------- skills + commands
/** Every file this script owns: path -> exact intended content. */
const outputs = new Map([[generatedFile, generated]]);
for (const g of guides) outputs.set(path.join(skillsDir, g.name, "SKILL.md"), `${g.raw.trimEnd()}\n`);
for (const p of prompts) outputs.set(path.join(commandsDir, `${p.name}.md`), `${p.raw.trimEnd()}\n`);

/** Generated dirs are owned wholesale: a renamed source must not leave the old file behind. */
const owned = [
  [skillsDir, guides.map((g) => g.name)],
  [commandsDir, prompts.map((p) => `${p.name}.md`)],
];

function orphansIn(dir, expected) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((e) => e !== ".DS_Store" && !expected.includes(e));
}

if (check) {
  const stale = [...outputs].filter(
    ([file, content]) => !fs.existsSync(file) || lf(fs.readFileSync(file, "utf8")) !== lf(content)
  );
  const orphans = owned.flatMap(([dir, expected]) =>
    orphansIn(dir, expected).map((e) => path.join(path.relative(root, dir), e))
  );
  if (stale.length > 0 || orphans.length > 0) {
    for (const [file] of stale) console.error(`  stale: ${path.relative(root, file)}`);
    for (const o of orphans) console.error(`  orphaned: ${o}`);
    console.error(`\nRun: node scripts/build-guides.mjs`);
    process.exit(1);
  }
  console.log(`${guides.length} guides and ${prompts.length} prompts in sync.`);
} else {
  for (const [file, content] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  for (const [dir, expected] of owned) {
    for (const e of orphansIn(dir, expected)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
  console.log(`Generated ${guides.length} guides + ${prompts.length} prompts`);
  for (const g of guides) console.log(`  guide  ${g.name} (${(g.body.length / 1024).toFixed(1)} KB)`);
  for (const p of prompts) console.log(`  prompt ${p.name}`);
}
