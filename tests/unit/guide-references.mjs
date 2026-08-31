// The reference mechanism in scripts/build-guides.mjs.
//
// Guidance has five carriers and only one of them — the Claude Code skill — has
// a per-session cost. So a guide that should not be resident whenever its parent
// is carries `reference: <parent>` in its frontmatter: it stays a full `ae_guide`
// topic and a full `ae://guide/...` resource, because those are the carriers the
// non-Claude clients have, and on the skill side it lands in the parent's
// `references/` folder instead of becoming a skill of its own.
//
// That asymmetry is the thing worth testing. Getting it wrong in the quiet
// direction — a reference that generates a topic nobody can ask for, or a file
// nothing points at — produces no error and no output anyone would notice.
//
// The generator resolves everything from its own location, so most of this runs
// it against a synthetic tree in a temp dir: the real thing, on a repo it cannot
// damage, where a hand-edit and an orphan can actually be staged. The last block
// checks the wiring of the real repo, which no fixture can stand in for.
//
//   node tests/unit/guide-references.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "build-guides.mjs");

// ---------------------------------------------------------------- fixture
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-guide-refs-"));
const write = (rel, text) => {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
};
const read = (rel) => fs.readFileSync(path.join(tmp, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(tmp, rel));

const guidesDir = "packages/mcp-server/src/guides";
const skillsDir = "plugin/skills";

const PARENT = `---
name: parent
description: The narrative guide.
---

# Parent

The detail lives in \`references/child.md\`, which is not resident here.
`;

const CHILD = `---
name: child
reference: parent
description: The detail, loaded at the point it is needed.
---

# Child

One measured fact.
`;

function seed() {
  fs.rmSync(path.join(tmp, "packages"), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "plugin"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(tmp, "scripts", "build-guides.mjs"));
  write(`${guidesDir}/parent.md`, PARENT);
  write(`${guidesDir}/child.md`, CHILD);
  write("packages/mcp-server/src/prompts/flow.md", `---
name: flow
description: A user-invoked flow.
---

Do the thing with $ARGUMENTS.
`);
  // Only the GUIDE_TOPICS line is read out of this file, but the shape has to
  // match what the real schemas.ts declares or the assertion is meaningless.
  write("packages/shared/src/schemas.ts",
    `export const GUIDE_TOPICS = ["child", "parent"] as const;\n`);
}

const run = (...args) =>
  spawnSync(process.execPath, [path.join(tmp, "scripts", "build-guides.mjs"), ...args], {
    encoding: "utf8",
  });

seed();

// ------------------------------------------------- a reference is not a skill
let r = run();
assert.equal(r.status, 0, `generate failed:\n${r.stderr}`);

assert.ok(exists(`${skillsDir}/parent/SKILL.md`), "the parent guide is still a skill");
assert.ok(
  exists(`${skillsDir}/parent/references/child.md`),
  "a reference generates into its parent skill's references/ folder"
);
assert.ok(
  !exists(`${skillsDir}/child`),
  "a reference must NOT also become a skill of its own — that is the cost it exists to avoid"
);
assert.equal(
  read(`${skillsDir}/parent/references/child.md`).trim(),
  CHILD.trim(),
  "the reference file is the source verbatim, frontmatter included"
);

// -------------------------------------- but it IS a topic and a resource
// Every client can reach `ae_guide` and most can reach resources; only Claude's
// clients can reach a skill. A reference that narrowed to the skill would be a
// regression in reach for everyone else, and nothing else would say so.
const generated = read("packages/mcp-server/src/generated/content.ts");
assert.match(generated, /name: "child"/, "a reference is still an ae_guide topic / resource");
assert.match(generated, /name: "parent"/);
assert.match(generated, /One measured fact\./, "the reference body ships in content.ts");

// ------------------------------------------------------ --check is honest
r = run("--check");
assert.equal(r.status, 0, `--check should pass on freshly generated output:\n${r.stderr}`);

// A hand-edit of a generated reference is exactly the mistake the `plugin/` files
// invite, since they look like ordinary markdown sitting in the repo.
fs.appendFileSync(path.join(tmp, skillsDir, "parent/references/child.md"), "\nhand-edited\n");
r = run("--check");
assert.equal(r.status, 1, "--check must catch a hand-edited reference file");
assert.match(r.stderr, /stale:.*references[\\/]child\.md/, "and name the file it caught");

run();
assert.equal(run("--check").status, 0, "regenerating restores it");

// An orphan in references/ is the other half: a renamed or dropped source must
// not leave a file behind that an agent would still be told to read.
write(`${skillsDir}/parent/references/ghost.md`, "left behind by an earlier build\n");
r = run("--check");
assert.equal(r.status, 1, "--check must catch an orphan in references/");
assert.match(r.stderr, /orphaned:.*ghost\.md/);
run();
assert.ok(!exists(`${skillsDir}/parent/references/ghost.md`), "and generating removes it");

// ------------------------------------------- a reference nothing points at
// The whole mechanism rests on the parent naming the file, because that pointer
// is the only thing that ever opens it in Claude Code. Drop the pointer and the
// reference is dead weight that still costs a generate — so the build stops.
seed();
write(`${guidesDir}/parent.md`, PARENT.replace("The detail lives in `references/child.md`, which is not resident here.", "No pointer here."));
r = run();
assert.equal(r.status, 1, "a reference the parent never points at must fail the build");
assert.match(r.stderr, /never points at/);

// A parent that does not exist at all, and a reference of a reference.
seed();
write(`${guidesDir}/child.md`, CHILD.replace("reference: parent", "reference: nobody"));
r = run();
assert.equal(r.status, 1, "an unknown reference parent must fail the build");
assert.match(r.stderr, /is not a guide/);

seed();
write(`${guidesDir}/parent.md`, PARENT.replace("description: The narrative guide.", "reference: child\ndescription: The narrative guide."));
r = run();
assert.equal(r.status, 1, "skills nest one level only");
assert.match(r.stderr, /itself a reference/);

// ------------------------------------ re-parenting cleans up after itself
// Drop the `reference:` line and the guide becomes a skill; the folder it used
// to live in has to go with it, or two copies ship and drift.
seed();
write(`${guidesDir}/child.md`, CHILD.replace("reference: parent\n", ""));
write(`${guidesDir}/parent.md`, PARENT.replace("The detail lives in `references/child.md`, which is not resident here.", "No pointer here."));
assert.equal(run().status, 0);
assert.ok(exists(`${skillsDir}/child/SKILL.md`), "it is a skill of its own now");
assert.ok(
  !exists(`${skillsDir}/parent/references`),
  "and the empty references/ folder is gone, not left behind"
);

fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------------- the real repo
// The fixture proves the mechanism; this proves it is actually wired to the
// guides that ship. Both shipped references are reachable from every carrier.
const REAL_REFERENCES = [
  ["extendscript-gotchas", "after-effects"],
  ["whats-new", "after-effects"],
];
const schemas = fs.readFileSync(path.join(root, "packages", "shared", "src", "schemas.ts"), "utf8");
const realGenerated = fs.readFileSync(
  path.join(root, "packages", "mcp-server", "src", "generated", "content.ts"),
  "utf8"
);
for (const [name, parent] of REAL_REFERENCES) {
  assert.ok(
    fs.existsSync(path.join(root, "plugin", "skills", parent, "references", `${name}.md`)),
    `${name} should generate into plugin/skills/${parent}/references/`
  );
  assert.ok(
    !fs.existsSync(path.join(root, "plugin", "skills", name)),
    `${name} must not also be a skill`
  );
  assert.match(schemas, new RegExp(`"${name}"`), `${name} must be in GUIDE_TOPICS or nobody can ask for it`);
  assert.match(realGenerated, new RegExp(`name: "${name}"`), `${name} must be an ae_guide topic`);
}

// The instructions block is resident in every session of every client, so its
// size is a tax on every request the user ever makes. This is not a style rule:
// it is the reason the guides exist at all. 1.5 KB is roughly the ten-line
// pointer it is meant to be; if this fails, the paragraph belongs in a guide.
const instructions = /export const SERVER_INSTRUCTIONS = ("(?:[^"\\]|\\.)*")/.exec(realGenerated);
assert.ok(instructions, "SERVER_INSTRUCTIONS should be a string literal in content.ts");
const text = JSON.parse(instructions[1]);
assert.ok(
  text.length < 1500,
  `instructions is ${text.length} chars and always resident — move detail into a guide, not here`
);
assert.match(text, /ae_guide/, "instructions must point at the full guidance");

console.log("guide-references: ok");
