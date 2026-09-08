// The issue journal: its read paths, its exits, and the push half.
//
// `list_known_issues` used to return the whole corpus on every call — thousands
// of tokens to answer "is there anything about screenshot_frame?", and a tool
// result is re-sent on every request for the rest of the session. The index is
// the fix, and the thing that could quietly ruin it is an index that no longer
// leads anywhere: if the `next` pointer goes missing, an agent reads one line,
// learns nothing, and guesses instead.
//
// Since 0.5.0 (issue #102) the journal is also *pushed*: a failed tool call is
// answered with the entries that match its tool and error text, an entry has
// exits (age, an older server version, `archive_issue`), a re-log with the same
// tool and error text extends the existing entry instead of forking it, and the
// index dropped its summary sentence. All of that is here too, including one
// end-to-end run through the real server's error path against a stub bridge —
// there is no After Effects on a runner, and none is needed: everything asserted
// is server-side.
//
//   node tests/unit/issue-journal.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-journal-"));
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-journal-empty-"));
// Read on every call, so it decides where each of these calls writes and reads.
process.env.AE_MCP_HOME = home;

// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unsupported URL scheme.
const {
  ARCHIVE_AFTER_DAYS,
  archiveIssue,
  archiveReason,
  compareVersions,
  entryMatchesFailure,
  errorTextsMatch,
  listIssues,
  logIssue,
  markReported,
  normalizeErrorText,
  parse,
  render,
} = await import(dist("issues", "journal.js"));
const { JournalCache, MAX_MATCHES, annotateFailure, describeMatches, matchFailure } = await import(
  dist("issues", "failures.js")
);
const { packageVersion } = await import(dist("setup", "paths.js"));
const VERSION = packageVersion();

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
}

const projectIssues = path.join(home, "issues");
const userIssues = path.join(home, "user", "issues");
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const fileOf = (dir, id) => fs.readFileSync(path.join(dir, `${id}.md`), "utf8");
/** A hand-written entry, in whatever shape a human or an older version left it in. */
function writeRaw(dir, id, fields, body = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nid: ${id}\n${fm}\n---\n\n## What went wrong\n\n${body.symptom ?? "It broke."}\n\n## What worked\n\n${body.workaround ?? "Try again."}\n`,
    "utf8"
  );
}

// Entries are the length real ones are: an agent writing for the next session
// pastes the failing call and the error verbatim, which is the whole point of
// the journal and the whole reason the corpus is expensive to return.
const LONG_SYMPTOM =
  "screenshot_frame returned a 3840x2160 PNG even though downsample was set, " +
  "and the response was large enough that the client spilled it to a file instead " +
  "of into the conversation, which is where this whole problem starts. The call " +
  "was screenshot_frame({compId: 42, time: 1.5, downsample: 3}) and the result " +
  "reported width 3840, height 2160, downsample 1 — so the factor was dropped " +
  "somewhere between the schema and the render.";

const spatial = logIssue({
  title: "Spatial ease wants exactly one entry",
  symptom:
    "set_temporal_ease threw 'Value array does not have 1 elements' on Position. " +
    "The call was set_temporal_ease({compId: 42, layerId: 7, propertyPath: " +
    "['Transform','Position'], keyIndex: 2, easeIn: [{influence: 33, speed: 0}, " +
    "{influence: 33, speed: 0}]}) — one entry per axis, which is what every other " +
    "multi-dimensional property wants.",
  workaround:
    "Send a single ease entry for spatial properties, regardless of whether the " +
    "layer is 2D or 3D. Position and Anchor Point are spatial; Scale and Color are " +
    "not, and those really do want one entry per dimension. There is no way to tell " +
    "from the schema, so check isSpatial in a get_layer_full read first. The same " +
    "applies to set_spatial_tangents, which took the single-entry form without " +
    "complaint and then applied it to the first axis only, so read the keyframe " +
    "back before believing it landed.",
  cause: "The ease applies along the motion path, not per axis.",
  tools: ["set_temporal_ease"],
});
logIssue({
  title: "Full-resolution frames blow out the context",
  symptom: LONG_SYMPTOM,
  workaround:
    "Pass downsample, or let the tool derive one from the comp size. On a 4K comp " +
    "a factor of 3 lands at 1280x720, which is still legible for checking type and " +
    "layout and costs about a tenth of the tokens. Read the width and height back " +
    "out of the result rather than assuming the factor was applied, because the " +
    "panel reports what the PNG actually contains and the render can quietly fall " +
    "back to full size on a comp whose resolution factor is already set.",
  tools: ["screenshot_frame"],
});
const third = logIssue({
  title: "Shape property names are not the display names",
  symptom:
    "add_shape_content rejected 'radius' on a star node, with an error naming the " +
    "key but not the alternative. The panel names it 'Outer Radius', and nothing " +
    "in the tool description says so.",
  workaround:
    "Read the real names out of get_layer_full first — the Contents tree carries " +
    "both name and matchName for every node, and the friendly name in the error is " +
    "the one add_shape_content will accept. On a star it is 'Outer Radius' and " +
    "'Inner Radius'; on an ellipse there is no radius at all, only Size, which is " +
    "a two-element array rather than a number.",
  tools: ["add_shape_content", "get_layer_full"],
});
markReported(third.id, "https://example.invalid/3");

// ---------------------------------------------------------------- the index
const index = listIssues();
ok("index is the default shape", index.detail === "index");
ok("index lists every entry", index.count === 3);
ok("index points at the full entry", typeof index.next === "string" && index.next.includes("id"));
for (const e of index.issues) {
  ok(`${e.id}: index carries the identity`, e.id && e.title && Array.isArray(e.tools));
  ok(`${e.id}: index carries the counts`, typeof e.occurrences === "number" && typeof e.reported === "boolean");
  ok(`${e.id}: index says what kind of thing it is`, e.kind === "tool-bug");
  ok(`${e.id}: index says when and on what it was last seen`, e.lastSeen === todayIso() && e.lastVersion === VERSION);
  // The point of the index is that it is not the corpus — and since 0.5.0 the
  // title is the summary: the clipped symptom that used to ride along roughly
  // doubled the cost of every line for a sentence the title already said.
  ok(`${e.id}: index withholds the body`, e.workaround === undefined && e.symptom === undefined);
  ok(`${e.id}: index carries no summary sentence`, e.summary === undefined);
  ok(`${e.id}: a live entry is not flagged`, e.archived === undefined && e.archivedReason === undefined);
}
ok("nothing is archived yet, and the listing says so rather than omitting the field", index.archivedCount === 0);

// The measurement this exists for.
const full = listIssues({ detail: "full" });
const indexBytes = JSON.stringify(index).length;
const fullBytes = JSON.stringify(full).length;
// Compare the part that scales with the corpus. The envelope — journal path,
// repo, version — is a fixed floor that a real journal of a dozen long entries
// amortises away, and these fixtures are shorter than real entries.
ok(
  "the index is a fraction of the corpus",
  JSON.stringify(index.issues).length * 3 < JSON.stringify(full.issues).length
);

// ------------------------------------------------------------------- detail
ok("full returns whole entries", full.detail === "full" && full.issues.every((e) => e.workaround));
ok("full keeps a known cause", full.issues.some((e) => e.cause === "The ease applies along the motion path, not per axis."));

// --------------------------------------------------------------- one entry
const one = listIssues({ id: third.id });
ok("id returns exactly one entry", one.count === 1 && one.issues.length === 1);
ok("id returns it in full", one.detail === "full" && one.issues[0].workaround.includes("get_layer_full"));
// The filters must not be able to hide something asked for by name.
const named = listIssues({ id: third.id, status: "unreported", tool: "set_temporal_ease" });
ok("id outranks the filters", named.count === 1 && named.issues[0].id === third.id);

// An id that is not there is an error naming the ones that are — an empty
// listing would read as "no such problem was ever logged".
assert.throws(
  () => listIssues({ id: "no-such-entry" }),
  (e) => /no-such-entry/.test(e.message) && /Known ids:/.test(e.message)
);
passed++;
// Titles slugify to ids, so an agent quoting the title still lands on the entry.
ok("a title resolves like an id", listIssues({ id: "Shape property names are not the display names" }).count === 1);

// ------------------------------------------------------------------ filters
ok("tool filter narrows", listIssues({ tool: "screenshot_frame" }).count === 1);
ok("status filter still applies", listIssues({ status: "reported" }).count === 1);
ok("query matches the title", listIssues({ query: "spatial ease" }).count === 1);
ok("query matches the symptom", listIssues({ query: "3840x2160" }).count === 1);
ok("query terms are ANDed", listIssues({ query: "downsample radius" }).count === 0);
ok("query is case-insensitive", listIssues({ query: "POSITION" }).count === 1);
// Matching is by substring, and the one entry mentioning "radius" is the
// reported one, so the pair is empty.
ok("query composes with status", listIssues({ query: "radius", status: "unreported" }).count === 0);

// ------------------------------------------------------------- empty journal
process.env.AE_MCP_HOME = empty;
const none = listIssues();
ok("an empty journal is not an error", none.count === 0 && none.issues.length === 0);
ok("nothing to open, nothing to point at", none.next === undefined);
process.env.AE_MCP_HOME = home;

// ============================================================= the two scopes
//
// Entries used to live only in `<project>/.ae-mcp`, so a new project started
// ignorant of every tool behaviour the last one had worked out (issue #57).
// There is now a second journal in the user's home, and three things have to
// hold at once: the merge has to say which journal each entry came from, an id
// has to be able to name one of two entries with the same slug, and the *home
// fallback* — the project journal with no project to sit in — must not quietly
// become the cross-project one.
//
// Everything here still runs inside the AE_MCP_HOME sandbox. A regression that
// wrote to the real home directory would be a bug, so it is asserted rather
// than assumed.

const before = listIssues();
const user = logIssue({
  title: "Screenshots come back as a frame AE rendered earlier",
  symptom:
    "screenshot_frame returned pixel-identical PNGs for two unrelated comps at two unrelated times, " +
    "with ok:true and a fresh temp path each time.",
  workaround: "Vary the downsample factor to force a real render, and read the comp back rather than trusting the picture.",
  cause: "AE re-serves a render buffer past some per-frame cost.",
  tools: ["screenshot_frame"],
  scope: "user",
});
ok("a user entry reports the user scope", user.scope === "user");
ok("a user entry is a new entry, not an extension", user.previouslyLogged === false && user.occurrences === 1);
// The whole point: it is not in the project folder.
ok("the user journal is a different directory", !user.path.startsWith(path.join(home, "issues")));
// And the whole *risk*: a single override has to sandbox it, or this test wrote
// into whoever ran it.
ok("the user journal stays inside the override", path.resolve(user.path).startsWith(path.resolve(home)));
ok("the user journal ignores itself too", fs.readFileSync(path.join(home, "user", ".gitignore"), "utf8").trim() === "*");

// -------------------------------------------------------------- the merge
const merged = listIssues();
ok("both journals are read", merged.count === before.count + 1);
ok("every entry says where it came from", merged.issues.every((e) => e.scope === "project" || e.scope === "user"));
ok("the user entry is tagged user", merged.issues.find((e) => e.id === user.id).scope === "user");
ok("the project entries are still tagged project", merged.issues.some((e) => e.scope === "project"));
// The envelope still names the project journal, because that is where log_issue
// writes by default and the agent has to be able to say where its notes live.
ok("the envelope still names the project journal", merged.scope === "project" && merged.dir === path.join(home, "issues"));
ok("the envelope names every journal it read", merged.journals.length === 2);
ok(
  "each journal is counted",
  merged.journals.find((j) => j.scope === "user").count === 1 &&
    merged.journals.find((j) => j.scope === "project").count === before.count
);
// The index has to lead somewhere, and an id alone no longer identifies an
// entry, so the pointer spells the qualified form out on a real one.
ok("the pointer names a scope-qualified id", /list_known_issues\(\{ id: "(project|home|user):[a-z0-9-]+" \}\)/.test(merged.next));

// -------------------------------------------------------------- the filter
ok("scope:user reads only the user journal", listIssues({ scope: "user" }).issues.every((e) => e.scope === "user"));
ok("scope:user finds the entry", listIssues({ scope: "user" }).count === 1);
ok("scope:project excludes it", listIssues({ scope: "project" }).count === before.count);
ok("filters compose with scope", listIssues({ scope: "user", tool: "screenshot_frame" }).count === 1);
ok("the filtered envelope names one journal", listIssues({ scope: "user" }).journals.length === 1);

// -------------------------------------------- the same title in both journals
// Nothing stops a lesson being written down twice, so the merge has to be able
// to hold both and the reader has to be able to say which one they want.
const TITLE = "Shape property names are not the display names";
const forked = logIssue({
  title: TITLE,
  symptom: "Same problem, written down as a tool behaviour rather than a fact about this project.",
  workaround: "Read the real names out of get_layer_full first.",
  scope: "user",
});
ok("the same title in the other scope is a new entry", forked.previouslyLogged === false && forked.occurrences === 1);
ok("the fork names the journal that already had it", forked.alsoIn.includes("project"));
ok("the project entry was not touched", listIssues({ id: `project:${third.id}` }).issues[0].occurrences === 1);
// Reporting state is per entry per journal: the project one was marked reported
// near the top of this file, and that says nothing about this new one.
ok("reporting state does not cross journals", listIssues({ id: `user:${forked.id}` }).issues[0].reported === false);
ok("the project one is still reported", listIssues({ id: `project:${third.id}` }).issues[0].reported === true);

// Both are listed. Hiding one would lose whichever the reader needed.
const bothListed = listIssues().issues.filter((e) => e.id === third.id);
ok("both are listed", bothListed.length === 2);
ok("and they are distinguishable", new Set(bothListed.map((e) => e.scope)).size === 2);

// A bare id still works — no caller that predates the user journal breaks — and
// resolves to the project entry, which is the more specific answer. The other
// one is named rather than silently losing.
const bare = listIssues({ id: third.id });
ok("a bare id still resolves", bare.count === 1);
ok("a bare id prefers the project entry", bare.issues[0].scope === "project");
ok("the other scope is named, not hidden", /user:/.test(bare.next));
ok("a qualified id reaches the user entry", listIssues({ id: `user:${third.id}` }).issues[0].scope === "user");
ok("a qualified id reaches the project entry", listIssues({ id: `project:${third.id}` }).issues[0].scope === "project");
// An id in no journal names the ones that exist, qualified, so the next call works.
assert.throws(
  () => listIssues({ id: "user:no-such-entry" }),
  (e) => /Known ids: /.test(e.message) && /user:/.test(e.message)
);
passed++;

// A title that happens to begin "user:" must stay reachable — the qualified
// form is tried first and falls back to the whole string as a bare id.
const awkward = logIssue({
  title: "user: prefs got wiped by an unrelated plugin",
  symptom: "The Character panel came back at tracking -20 on a fresh layer.",
  workaround: "Set tracking explicitly on every text layer.",
});
ok("a title beginning 'user:' is still reachable", listIssues({ id: "user: prefs got wiped by an unrelated plugin" }).count === 1);
ok("and it went to the project journal", awkward.scope === "project");

// ------------------------------------------------------- marking either scope
markReported(`user:${forked.id}`, "https://example.invalid/user");
ok("a qualified id marks the user entry", listIssues({ id: `user:${forked.id}` }).issues[0].reported === true);
ok("the project entry keeps its own URL", listIssues({ id: `project:${third.id}` }).issues[0].issueUrl === "https://example.invalid/3");
ok("the user entry got the new URL", listIssues({ id: `user:${forked.id}` }).issues[0].issueUrl === "https://example.invalid/user");
// A re-log of the user entry must not un-report it, exactly as in one journal.
const relogged = logIssue({ title: TITLE, symptom: "again", workaround: "same", scope: "user" });
ok("a new sighting does not un-report a user entry", relogged.reported === true && relogged.occurrences === 2);
ok("a re-log by title says so", relogged.mergedBy === "title" && relogged.previouslyLogged === true);
markReported(user.id, "https://example.invalid/bare");
ok("a bare id still marks", listIssues({ id: `user:${user.id}` }).issues[0].reported === true);

// ------------------------------------------------------------------ bounded
// Two journals double the listing, so there is a cap — and a cap that did not
// say it had bitten would be a short answer that looked complete.
const capped = listIssues({ limit: 2 });
const total = listIssues().count;
ok("the cap holds the listing down", capped.issues.length === 2);
ok("the count is still the truth", capped.count === total);
ok("what was held back is counted", capped.omitted === total - 2);
ok("and the pointer says so", /more matched/.test(capped.next));
ok("an uncapped listing says nothing about omissions", listIssues().omitted === undefined);

// ---------------------------------------------- the home fallback is not user
// `home` is the project journal with no project. If it were merged into the
// user journal, a Claude Desktop session's notes about one project's footage
// would start arriving in every other project as cross-project knowledge.
//
// The condition is reproduced the way Claude Desktop produces it — a working
// directory of the filesystem root — rather than with a chmod, which is a no-op
// on Windows and CI runs there. The fallback lands in the home directory, which
// this test must never write into, so for the duration the home is a temporary
// folder: os.homedir() reads HOME (USERPROFILE on Windows), and the sandbox is
// asserted before anything is written.
delete process.env.AE_MCP_HOME;
const cwd = process.cwd();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-journal-home-"));
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
try {
  process.chdir(path.parse(cwd).root);
  const fallback = listIssues();
  const home_ = fallback.journals.find((j) => j.scope === "home");
  const user_ = fallback.journals.find((j) => j.scope === "user");
  ok("an unusable working directory still resolves", fallback.scope === "home");
  ok("the fallback is its own journal", home_ !== undefined && user_ !== undefined);
  ok("the fallback is not the user journal", path.resolve(home_.dir) !== path.resolve(user_.dir));
  ok("the fallback keeps its own folder name", /\.after-effects-mcp/.test(home_.dir));
  ok("the user journal has the other name", /[/\\]\.ae-mcp[/\\]/.test(user_.dir + path.sep));
  // scope:"project" reads the fallback, because that is what it is.
  ok("scope:project covers the fallback", listIssues({ scope: "project" }).journals.some((j) => j.scope === "home"));
  // And so does the `project:` handle. An agent under Claude Desktop sees
  // `scope: "home"` on every result, but the qualified id it reaches for is the
  // project one, and either has to open the entry — `archive_issue` included.
  assert.ok(path.resolve(home_.dir).startsWith(path.resolve(fakeHome)), `the fallback must resolve into the sandbox, not ${home_.dir}`);
  const desk = logIssue({ title: "Footage lives on the NAS", symptom: "Relinks fail while it is asleep.", workaround: "Wake it first." });
  ok("a default-scope log lands in the fallback", desk.scope === "home" && path.resolve(desk.path).startsWith(path.resolve(fakeHome)));
  ok("project:<id> reaches the fallback entry", listIssues({ id: `project:${desk.id}` }).issues[0].scope === "home");
  ok("home:<id> still reaches it", listIssues({ id: `home:${desk.id}` }).issues[0].scope === "home");
  ok("archive_issue takes the project: form too", archiveIssue(`project:${desk.id}`, "noted in the project docs").scope === "home");
} finally {
  process.chdir(cwd);
  for (const [k, v] of Object.entries(realHome)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.AE_MCP_HOME = home;
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

// =========================================================== version stamps
//
// Every entry records the server version it was first and last seen on. That
// is what makes "stale" visible at all (issue #102): without it there is no way
// to tell an entry a release fixed from one that is still biting.

const stamped = fileOf(projectIssues, spatial.id);
ok("the file records the first and last version", stamped.includes(`firstVersion: ${VERSION}`) && stamped.includes(`lastVersion: ${VERSION}`));
ok("the file records the kind", stamped.includes("kind: tool-bug"));
ok("the result reports the version", spatial.lastVersion === VERSION && spatial.kind === "tool-bug");
const quirk = logIssue({
  title: "Expression time is comp time, not layer time",
  symptom: "An expression using `time` on a layer starting at 2s ran two seconds early.",
  workaround: "Subtract inPoint, or use `time - inPoint` in the expression.",
  tools: ["set_expression"],
  kind: "ae-quirk",
  scope: "user",
});
ok("an AE quirk is recorded as one", quirk.kind === "ae-quirk" && fileOf(userIssues, quirk.id).includes("kind: ae-quirk"));

// ------------------------------------------------------ round trip, all keys
const everything = {
  id: "round-trip",
  title: "Round trip",
  scope: "project",
  tools: ["run_jsx", "run_batch"],
  kind: "ae-quirk",
  errorText: "Object is invalid",
  firstSeen: "2026-01-01",
  lastSeen: "2026-02-02",
  firstVersion: "0.4.0",
  lastVersion: "0.5.0",
  occurrences: 7,
  reported: true,
  issueUrl: "https://example.invalid/7",
  archived: true,
  archivedReason: "moved into the project notes",
  archivedAt: "2026-03-03",
  symptom: "It broke.\n\nBadly.",
  cause: "Because.",
  workaround: "## Step 1\n\nA heading inside the workaround must survive.",
};
assert.deepEqual(parse(render(everything), "round-trip", "project"), everything);
passed++;

// ------------------------------------------------ files that predate 0.5.0
// A hand-edited or older file has none of the new keys. It must still load,
// as a live tool-bug with no version — and "no version" must never be read as
// "an older version", or every entry ever written before the stamp existed
// would be archived the day the stamp shipped.
writeRaw(
  projectIssues,
  "pre-stamp",
  { title: "Written by 0.4.0", tools: "add_marker", firstSeen: todayIso(), lastSeen: todayIso(), occurrences: 2, reported: "false", issueUrl: "" },
  { symptom: "add_marker threw 'Marker time is outside the comp duration' at 4.9s on a 5s comp." }
);
const old = listIssues({ id: "pre-stamp" }).issues[0];
ok("an old file loads", old.title === "Written by 0.4.0" && old.occurrences === 2);
ok("an old file is a tool-bug by default", old.kind === "tool-bug");
ok("an old file has no version", old.lastVersion === undefined && old.firstVersion === undefined);
ok("an old file is live, not presumed fixed", old.archived === false && listIssues({ tool: "add_marker" }).count === 1);

// ================================================================ the matcher
//
// Two sightings of one bug never produce byte-identical text: the layer name,
// the line number, the path and the server's own decorations all vary. What
// stays is the letters of the message, so that is what is compared.

ok(
  "normalisation keeps the letters and drops the rest",
  normalizeErrorText("Value array does not have 1 elements") === "valuearraydoesnothaveelements"
);
ok("normalisation drops the AE: prefix", normalizeErrorText("AE: Object is invalid") === normalizeErrorText("Object is invalid"));
ok("normalisation drops paths", normalizeErrorText("Cannot read /Users/migs/rig.jsx") === normalizeErrorText("Cannot read C:\\Users\\migs\\rig.jsx"));
ok("normalisation drops quoted names", normalizeErrorText("Layer 'Card' not found") === normalizeErrorText('Layer "Title" not found'));
ok("an apostrophe is not a quote", normalizeErrorText("doesn't accept it") === "doesntacceptit");
ok(
  "normalisation drops the server's decorations",
  normalizeErrorText(
    "AE: Object is invalid\n  at line 4 of the script you submitted, 9 lines:\n    comp.layer(2).remove();\n  Everything before the failure already ran and nothing rolls back: read the state back rather than re-running the script."
  ) === "objectisinvalid"
);
ok("normalisation drops a trailing line number", normalizeErrorText("Object is invalid (line 12)") === "objectisinvalid");
// The cuts are anchored on whitespace, not a newline, so a line number that is
// part of After Effects' own sentence must not be mistaken for the mapped one.
ok(
  "a line number inside the message itself is not a decoration",
  normalizeErrorText("Unable to execute script at line 4. Object is invalid") === "unabletoexecutescriptatlineobjectisinvalid"
);
ok(
  "normalisation drops a pointer block pasted from an earlier failure",
  normalizeErrorText("Object is invalid\n\nKnown from earlier sessions: user:x — X\nlist_known_issues({ id: \"user:x\" }) has the cause and the workaround.") ===
    "objectisinvalid"
);

ok("equal texts match", errorTextsMatch("Value array does not have 1 elements", "AE: Value array does not have 1 elements (line 3)"));
ok("a number does not break a match", errorTextsMatch("Value array does not have 1 elements", "Value array does not have 3 elements"));
ok("a name does not break a match", errorTextsMatch("Unable to find layer 'Card' in comp 'Main'", "Unable to find layer 'Title' in comp 'Scene 4'"));
ok("a variable tail matches by prefix", errorTextsMatch("Unable to execute script at line 4. Object is invalid", "Unable to execute script at line 4. Object is invalid; the layer it referred to was deleted by the earlier remove()"));
ok("different messages do not match", !errorTextsMatch("Value array does not have 1 elements", "Object is invalid"));
ok("a short text is not trusted as a prefix", !errorTextsMatch("AE: error", "AE: error in the render queue while exporting"));
ok("empty never matches", !errorTextsMatch("", "Object is invalid") && !errorTextsMatch(undefined, "x"));
// Every schema rejection for one tool begins the same way; the prefix rule must
// not fold them into one.
ok(
  "two schema rejections for one tool are two errors",
  !errorTextsMatch(
    "Invalid arguments for set_temporal_ease:\n  - easeIn: required, and was not passed",
    "Invalid arguments for set_temporal_ease:\n  - keyIndex: expected number, got string"
  )
);

const spatialEntry = listIssues({ id: `project:${spatial.id}` }).issues[0];
ok("a failure on another tool never matches", !entryMatchesFailure(spatialEntry, "add_keyframe", "Value array does not have 1 elements"));
ok("the tool match is case-insensitive", entryMatchesFailure(spatialEntry, "SET_TEMPORAL_EASE", "AE: Value array does not have 1 elements (line 9)"));
// This entry has no errorText — it was logged the way every pre-0.5.0 entry
// was, with the error quoted inside the symptom. That has to be enough.
ok("an entry without errorText matches on its symptom", entryMatchesFailure(spatialEntry, "set_temporal_ease", "AE: Value array does not have 1 elements (line 9)"));
ok("but not on a different error", !entryMatchesFailure(spatialEntry, "set_temporal_ease", "AE: Object is invalid (line 9)"));
ok("and not on a fragment too short to trust", !entryMatchesFailure(spatialEntry, "set_temporal_ease", "AE: Value array"));

// ====================================================== merge on error text
//
// One week of one project produced two entries for one bug, under two titles
// (issue #102). The title is still the identity — but a log with the same tool
// and a matching error text is the same bug under a new name, and extends the
// entry that already answers it instead of forking it.

const filesBefore = fs.readdirSync(projectIssues).length;
const twin = logIssue({
  title: "set_temporal_ease rejects a per-axis ease array on Position",
  symptom: "Second session, same failure, nearly the same words.",
  workaround: "One entry, not one per axis.",
  tools: ["set_temporal_ease"],
  errorText: "AE: Value array does not have 1 elements (line 41)",
});
ok("the twin merged into the existing entry", twin.mergedBy === "errorText" && twin.id === spatial.id);
ok("the existing title stayed", twin.title === "Spatial ease wants exactly one entry");
ok("the merge counts as a sighting", twin.occurrences === 2 && twin.previouslyLogged === true);
ok("the merge says what it did", typeof twin.note === "string" && twin.note.includes(spatial.id) && twin.note.includes("not used"));
ok("no second file was written", fs.readdirSync(projectIssues).length === filesBefore);
// Stored bare: the `AE:` prefix and the line number are the server's, not the error's.
ok("the merge recorded the error text on the entry", /^errorText: Value array does not have 1 elements$/m.test(fileOf(projectIssues, spatial.id)));
ok("the entry now matches by errorText rather than symptom", entryMatchesFailure(listIssues({ id: `project:${spatial.id}` }).issues[0], "set_temporal_ease", "Value array does not have 1 elements"));
const other = logIssue({
  title: "Another tool, same words",
  symptom: "add_keyframe said the same thing.",
  workaround: "Different fix.",
  tools: ["add_keyframe"],
  errorText: "Value array does not have 1 elements",
});
ok("a different tool with the same text is a new entry", other.mergedBy === undefined && other.id !== spatial.id);
const untooled = logIssue({
  title: "Same words, no tool named",
  symptom: "No tool given.",
  workaround: "None.",
  errorText: "Value array does not have 1 elements",
});
ok("no tool means no error-text merge", untooled.mergedBy === undefined && untooled.id === "same-words-no-tool-named");
ok("a re-log by title still merges by title", logIssue({ title: "Another tool, same words", symptom: "x", workaround: "y" }).mergedBy === "title");
// The merge is per journal: the same tool and text in the *other* journal is a
// separate record, exactly as a title is.
const crossScope = logIssue({
  title: "Spatial ease, user scope",
  symptom: "x",
  workaround: "y",
  tools: ["set_temporal_ease"],
  errorText: "Value array does not have 1 elements",
  scope: "user",
});
ok("an error-text merge does not cross journals", crossScope.mergedBy === undefined && crossScope.scope === "user");

// ===================================================================== exits
//
// An entry used to have exactly one exit — a report the user may never file —
// so a journal only ever grew. Now: not seen for ARCHIVE_AFTER_DAYS, or last
// seen on an older server than this one (unless it is an AE quirk, which no
// release fixes), or retired by hand. The first two are computed on every read
// and never written, which is what lets a fresh sighting bring an entry back.

const live = { ...everything, archived: false, archivedReason: undefined, archivedAt: undefined, kind: "tool-bug", lastSeen: todayIso(), lastVersion: VERSION };
const ctx = { today: todayIso(), version: VERSION };
ok("a fresh entry is live", archiveReason(live, ctx) === null);
ok("an entry unseen for the window is archived", /not seen for 40 days/.test(archiveReason({ ...live, lastSeen: daysAgo(40) }, ctx)));
ok("the window is a threshold, not a fence", archiveReason({ ...live, lastSeen: daysAgo(ARCHIVE_AFTER_DAYS - 1) }, ctx) === null);
ok("an entry last seen on an older server is presumed fixed", /last seen on 0\.0\.1/.test(archiveReason({ ...live, lastVersion: "0.0.1" }, ctx)));
ok("an AE quirk is never presumed fixed by a release", archiveReason({ ...live, lastVersion: "0.0.1", kind: "ae-quirk" }, ctx) === null);
ok("no version is not an older version", archiveReason({ ...live, lastVersion: undefined }, ctx) === null);
ok("a newer version is not an older version", archiveReason({ ...live, lastVersion: "99.0.0" }, ctx) === null);
ok("an unreadable version is not an older version", archiveReason({ ...live, lastVersion: "yesterday" }, ctx) === null);
ok("a retired entry quotes its reason", archiveReason({ ...live, archived: true, archivedReason: "fixed in 0.5.0" }, ctx) === "fixed in 0.5.0");
ok("a retired entry with no reason still says why it is hidden", typeof archiveReason({ ...live, archived: true }, ctx) === "string");
ok("semver: older", compareVersions("0.4.0", "0.5.0") < 0 && compareVersions("0.4.9", "0.5.0") < 0);
ok("semver: equal", compareVersions("0.5.0", "0.5.0") === 0 && compareVersions("v0.5.0", "0.5.0") === 0);
ok("semver: newer", compareVersions("1.0.0", "0.9.9") > 0);
ok("semver: a prerelease precedes its release", compareVersions("0.5.0-beta.1", "0.5.0") < 0 && compareVersions("0.5.0", "0.5.0-beta.1") > 0);
ok("semver: garbage is unknown, not older", compareVersions("garbage", "0.5.0") === null);

// -------------------------------------------------------- through the index
const STALE_ERROR = "Source text cannot be set while a text animator is selected";
writeRaw(projectIssues, "stale-entry", { title: "Went quiet", tools: "set_text", kind: "tool-bug", errorText: STALE_ERROR, firstSeen: "2020-01-01", lastSeen: "2020-01-01", lastVersion: VERSION, occurrences: 1, reported: "false" });
writeRaw(projectIssues, "old-version", { title: "Seen on an older server", tools: "set_text", kind: "tool-bug", firstSeen: todayIso(), lastSeen: todayIso(), lastVersion: "0.0.1", occurrences: 1, reported: "false" });
writeRaw(projectIssues, "old-quirk", { title: "An AE quirk seen on an older server", tools: "set_text", kind: "ae-quirk", firstSeen: todayIso(), lastSeen: todayIso(), lastVersion: "0.0.1", occurrences: 1, reported: "false" });
const setText = listIssues({ tool: "set_text" });
ok("archived entries are hidden", !setText.issues.some((e) => e.id === "stale-entry" || e.id === "old-version"));
ok("live ones are not", setText.issues.some((e) => e.id === "old-quirk"));
ok("what is hidden is counted", setText.archivedCount === 2 && setText.count === 1);
ok("and the pointer says how to see it", /2 archived entries are hidden/.test(setText.next) && /includeArchived: true/.test(setText.next));
const withArchived = listIssues({ tool: "set_text", includeArchived: true });
ok("includeArchived lists them", withArchived.count === 3 && withArchived.archivedCount === 2);
ok("each flagged with its reason", withArchived.issues.find((e) => e.id === "stale-entry").archived === true && /not seen for/.test(withArchived.issues.find((e) => e.id === "stale-entry").archivedReason));
ok("the version reason names both versions", new RegExp(`0\\.0\\.1.*${VERSION.replace(/\./g, "\\.")}`).test(withArchived.issues.find((e) => e.id === "old-version").archivedReason));
ok("the live one is not flagged", withArchived.issues.find((e) => e.id === "old-quirk").archived === undefined);
ok("includeArchived says nothing about hiding", !/hidden/.test(withArchived.next));
// A named read is a read: the failure pointer names archived entries, and it
// has to lead somewhere.
const staleRead = listIssues({ id: "stale-entry" });
ok("an id read returns an archived entry", staleRead.count === 1 && staleRead.issues[0].archived === true && /not seen for/.test(staleRead.issues[0].archivedReason));
// The verdict is computed, never written: the same files under a different
// clock and version are live again, and nothing was edited to make it so.
const then = listIssues({ tool: "set_text", context: { today: "2020-01-02", version: "0.0.1" } });
ok("the archive is a function of now, not a flag in the file", then.count === 3 && then.archivedCount === 0);
ok("nothing was written to the stale file", !fileOf(projectIssues, "stale-entry").includes("archived"));
// Everything that was all-archived must still say so, even with nothing to list.
writeRaw(projectIssues, "lonely-stale", { title: "Only match, and stale", tools: "toggle_expression", lastSeen: "2020-01-01", lastVersion: VERSION });
const lonely = listIssues({ tool: "toggle_expression" });
ok("an all-archived match is not an empty answer", lonely.count === 0 && lonely.archivedCount === 1 && /includeArchived/.test(lonely.next));

// ------------------------------------------------------------ archive_issue
const retired = archiveIssue("full-resolution-frames-blow-out-the-context", "already closed upstream: https://example.invalid/99");
ok("archive_issue returns the entry", retired.id === "full-resolution-frames-blow-out-the-context" && retired.archived === true && retired.archivedAt === todayIso());
const retiredFile = fileOf(projectIssues, retired.id);
ok("the file stays, flagged", retiredFile.includes("archived: true") && retiredFile.includes("archivedReason: already closed upstream: https://example.invalid/99"));
ok("and is gone from the index", !listIssues().issues.some((e) => e.id === retired.id));
ok("but an id read still opens it, with the reason", listIssues({ id: retired.id }).issues[0].archivedReason === "already closed upstream: https://example.invalid/99");
ok("includeArchived shows it", listIssues({ includeArchived: true }).issues.find((e) => e.id === retired.id).archived === true);
// Marking it reported does not un-retire it: reporting state and archive state
// are two different facts about the entry.
markReported(retired.id, "https://example.invalid/99");
ok("mark_issue_reported leaves the retirement alone", fileOf(projectIssues, retired.id).includes("archived: true") && listIssues({ id: retired.id }).issues[0].reported === true);
// A scope-qualified id moves exactly the one named.
archiveIssue(`user:${third.id}`, "the project one is the record");
ok("a qualified archive moves the user entry", listIssues({ id: `user:${third.id}` }).issues[0].archived === true);
ok("and not the project one", listIssues({ id: `project:${third.id}` }).issues[0].archived === false);
assert.throws(() => archiveIssue("no-such-entry", "why"), (e) => /no-such-entry/.test(e.message) && /Known ids:/.test(e.message));
passed++;
// A deliberate new sighting outranks a retirement: the entry was archived as
// gone, and here it is. The flag clears and the result says so.
const back = logIssue({
  title: "Full-resolution frames blow out the context",
  symptom: "It is back on 0.5.0.",
  workaround: "Same as before.",
  tools: ["screenshot_frame"],
});
ok("a re-log reopens a retired entry", back.reopened === true && back.previousArchiveReason === "already closed upstream: https://example.invalid/99");
ok("and it is listed again", listIssues().issues.some((e) => e.id === retired.id));
ok("reporting state survived the round trip", back.reported === true && back.issueUrl === "https://example.invalid/99");
ok("the flag is gone from the file", !fileOf(projectIssues, retired.id).includes("archived: true"));

// ============================================================ the index sort
// Entries that name the tool outrank ones that only mention it in the title;
// then most recent first. Occurrences used to be able to push a title-only
// match above the entry actually about the tool.
writeRaw(projectIssues, "title-only-ease", { title: "set_temporal_ease acts up sometimes", tools: "", lastSeen: todayIso(), lastVersion: VERSION, occurrences: 99 });
const byTool = listIssues({ tool: "set_temporal_ease" });
ok("an entry naming the tool sorts first", byTool.issues[0].id === spatial.id);
ok(
  "a title-only match sorts after every entry that names the tool, however often it recurred",
  byTool.issues.at(-1).id === "title-only-ease" &&
    byTool.issues.slice(0, -1).every((e) => e.tools.includes("set_temporal_ease"))
);
ok("without a tool, recency and recurrence decide", listIssues().issues[0].id === "title-only-ease");

// ============================================================ push on failure
//
// The moment an agent needs a workaround is the moment a call fails, and the
// failure already carries the key. So the journal is read *then*, cached per
// file, and the matching entries are named under the error.

const cache = new JournalCache();
const firstRead = cache.entries().length;
const readsAfterFirst = cache.reads;
ok("the cache reads every file once", firstRead > 0 && readsAfterFirst === firstRead);
cache.entries();
ok("a second lookup reads nothing", cache.reads === readsAfterFirst);
// An in-place rewrite. This is what every mark_issue_reported and every re-log
// does, and it leaves the *directory's* mtime alone — so a cache keyed on the
// directory would keep serving the old entry for the rest of the session.
markReported("pre-stamp", "https://example.invalid/pre");
cache.entries();
ok("a rewritten file is re-read, and only it", cache.reads === readsAfterFirst + 1);
ok("and the fresh content is what is served", cache.entries().find((e) => e.id === "pre-stamp").reported === true);
fs.rmSync(path.join(projectIssues, "lonely-stale.md"));
ok("a deleted file stops answering", !cache.entries().some((e) => e.id === "lonely-stale"));

// Five entries about one error; only three are named, and the total is honest.
for (let i = 1; i <= 5; i++) {
  writeRaw(userIssues, `marker-${i}`, { title: `Marker attempt ${i}`, tools: "add_marker", errorText: "Marker time is outside the comp duration", lastSeen: daysAgo(i), lastVersion: VERSION });
}
// Six entries match: the five above by errorText, and `pre-stamp` — the
// pre-0.5.0 file with no errorText at all — by the error quoted in its symptom.
const many = matchFailure(cache, "add_marker", "AE: Marker time is outside the comp duration (line 2)");
ok("matches are capped", many.matches.length === MAX_MATCHES && MAX_MATCHES === 3);
ok("but counted in full", many.total === 6);
ok(
  "most recently seen first, across both journals and both ways of matching",
  many.matches[0].entry.id === "pre-stamp" && many.matches[1].entry.id === "marker-1" && many.matches[2].entry.id === "marker-2"
);
const described = describeMatches(many);
ok("one line per match, in the agreed form", (described.match(/^Known from earlier sessions: (project|user):[a-z0-9-]+ — .+$/gm) ?? []).length === 3);
ok("each names its own journal", /project:pre-stamp — Written by 0\.4\.0/.test(described) && /user:marker-1 — Marker attempt 1/.test(described));
ok("the overflow is counted", /…and 3 more matching entries\./.test(described));
ok("the pointer leads somewhere", /list_known_issues\(\{ id: "project:pre-stamp" \}\) has the cause and the workaround\./.test(described));

// A match is a sighting: the stamps move, so an entry that keeps biting stays
// out of the archive and a stale one comes back.
ok("the stale entry is archived before the failure", listIssues({ id: "stale-entry" }).issues[0].archived === true);
const staleMessage = `AE: ${STALE_ERROR} (line 3)`;
const annotated = annotateFailure(cache, "set_text", staleMessage);
ok("the error text is kept, with the pointer under it", annotated.startsWith(`${staleMessage}\n\n`) && /Known from earlier sessions: project:stale-entry — Went quiet/.test(annotated));
ok("the pointer said it was archived", /stale-entry — Went quiet \(archived: not seen for \d+ days\)/.test(annotated));
const bumped = fileOf(projectIssues, "stale-entry");
ok("the sighting moved lastSeen", bumped.includes(`lastSeen: ${todayIso()}`));
ok("and lastVersion", bumped.includes(`lastVersion: ${VERSION}`));
ok("so the entry is back in the index", listIssues({ id: "stale-entry" }).issues[0].archived === false);
ok("and the cache served its own write", cache.entries().find((e) => e.id === "stale-entry").lastSeen === todayIso());
// A retirement is a decision, and a match is not a person: the pointer names
// the archived entry with its reason and leaves the flag exactly where it was.
const retiredAgain = archiveIssue(`user:${crossScope.id}`, "the project one is the record");
const viaArchived = annotateFailure(cache, "set_temporal_ease", "AE: Value array does not have 1 elements (line 7)");
ok("the live entry is named plainly", /Known from earlier sessions: project:spatial-ease-wants-exactly-one-entry — Spatial ease wants exactly one entry$/m.test(viaArchived));
ok("a retired entry is still named, marked archived", /Known from earlier sessions: user:spatial-ease-user-scope — Spatial ease, user scope \(archived: the project one is the record\)$/m.test(viaArchived));
ok("and stays retired", fileOf(userIssues, retiredAgain.id).includes("archived: true"));
ok("no match leaves the message byte-identical", annotateFailure(cache, "set_text", "AE: Nothing anyone has ever seen before") === "AE: Nothing anyone has ever seen before");
ok("a match on the wrong tool is no match", annotateFailure(cache, "create_comp", staleMessage) === staleMessage);

// An agent pastes the *whole* tool error into errorText — the tool description
// tells it to — and that text carries the server's own decorations: the mapped
// line, the "nothing rolls back" reminder, and the pointer block from an
// earlier failure. None of it may reach the stored text, and the bare error
// recurring must find the entry. It did not: the text was flattened to one line
// *before* the decorations were cut, and four of the five cuts were anchored on
// the newline that had just been removed — so the stored text was the whole
// paste, and the recurrence, fifteen letters long, matched none of it.
const PASTED_ERROR =
  "AE: nope is undefined\n" +
  "  at line 2 of the script you submitted, 3 lines:\n" +
  "    nope.boom();\n" +
  "  Everything before the failure already ran and nothing rolls back: read the state back rather than re-running the script.\n" +
  "\n" +
  "Known from earlier sessions: project:some-other-entry — Some other entry\n" +
  'list_known_issues({ id: "project:some-other-entry" }) has the cause and the workaround.';
const pasted = logIssue({
  title: "run_jsx cannot see the helpers",
  symptom: "A script calling a helper by the wrong name threw.",
  workaround: "Check the name against the list in the run_jsx description.",
  tools: ["run_jsx"],
  errorText: PASTED_ERROR,
});
const pastedFile = fileOf(projectIssues, pasted.id);
ok("the stored errorText is the bare error", /^errorText: nope is undefined$/m.test(pastedFile));
ok("the pointer block pasted with it is not stored", !pastedFile.includes("Known from earlier sessions"));
ok("nor the mapped line or the reminder", !pastedFile.includes("at line 2 of") && !pastedFile.includes("Everything before the failure"));
const recurrence = annotateFailure(cache, "run_jsx", "AE: nope is undefined (line 7)");
ok(
  "the bare error recurring finds the entry",
  /Known from earlier sessions: project:run-jsx-cannot-see-the-helpers — run_jsx cannot see the helpers/.test(recurrence)
);
// A re-log of the same error keeps the text that has been matching, however
// the new sighting was pasted; a genuinely different error under the same title
// is the caller's statement, and replaces it.
const relogSame = logIssue({
  title: "run_jsx cannot see the helpers",
  symptom: "Again.",
  workaround: "Same.",
  tools: ["run_jsx"],
  errorText: "AE: Nope is undefined (line 9)\n\nKnown from earlier sessions: project:run-jsx-cannot-see-the-helpers — run_jsx cannot see the helpers",
});
ok("a re-log of the same error keeps the recorded text", relogSame.occurrences === 2 && /^errorText: nope is undefined$/m.test(fileOf(projectIssues, pasted.id)));
logIssue({ title: "run_jsx cannot see the helpers", symptom: "Different.", workaround: "Same.", tools: ["run_jsx"], errorText: "AE: Object is invalid (line 3)" });
ok("a different error under the same title replaces it", /^errorText: Object is invalid$/m.test(fileOf(projectIssues, pasted.id)));
// Never a second failure on the failure path: point the journal at something
// that is not a directory and the error comes back untouched.
const broken = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-journal-broken-"));
fs.writeFileSync(path.join(broken, "issues"), "not a directory", "utf8");
process.env.AE_MCP_HOME = broken;
ok("an unreadable journal never masks the error", annotateFailure(new JournalCache(), "set_text", staleMessage) === staleMessage);
process.env.AE_MCP_HOME = home;

// ======================================================= through the server
//
// The wiring is the half that would fail silently: `annotateFailure` could be
// perfect and never called. So: the real MCP server over an in-memory transport
// against a stub bridge on an ephemeral port, a call the stub fails with a
// known error, and the pointer in the error the client receives.

const stubBridge = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: bundleHash }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op } = JSON.parse(body || "{}");
    if (op === "set_temporal_ease") {
      res.end(JSON.stringify({ ok: false, error: "Value array does not have 1 elements", line: 12 }));
    } else {
      res.end(JSON.stringify({ ok: true, result: [] }));
    }
  });
});
const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
// Report the hash this server ships so the panel-version gate is a no-op
// rather than a variable of whatever is installed on the test machine.
const bundleHash = sourceBundleHash();
const stubWss = new WebSocketServer({ server: stubBridge, path: "/events" });
await new Promise((r) => stubBridge.listen(0, "127.0.0.1", r));
const port = stubBridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

// Imported only after AE_MCP_PORT is set: HttpClient resolves the port in its
// constructor, which runs inside createServer().
const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const server = createServer();
const client = new Client({ name: "issue-journal-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (res) => res.content[0].text;

const failed = await call("set_temporal_ease", {
  compId: 1,
  layerId: 1,
  propertyPath: ["Transform", "Position"],
  keyIndex: 1,
  easeIn: { influence: 33, speed: 0 },
});
ok("the call failed as it should", failed.isError === true);
ok("the error is the error", text(failed).startsWith("AE: Value array does not have 1 elements (line 12)"));
ok("with the matching entry named under it", /Known from earlier sessions: project:spatial-ease-wants-exactly-one-entry — Spatial ease wants exactly one entry/.test(text(failed)));
ok("and the call that opens it", /list_known_issues\(\{ id: "project:spatial-ease-wants-exactly-one-entry" \}\)/.test(text(failed)));
ok("the sighting was counted on the entry", listIssues({ id: `project:${spatial.id}` }).issues[0].lastVersion === VERSION);

// A schema rejection is a failure too, and the natural thing to log is the
// text it produced. Log it, and the next rejection points at the entry.
const rejected = await call("set_temporal_ease", { compId: 1, layerId: 1, propertyPath: ["Transform", "Position"], keyIndex: 1 });
ok("a schema rejection is an error", rejected.isError === true && /Pass at least one of/.test(text(rejected)));
ok("nothing matched it yet", !/Known from earlier sessions/.test(text(rejected)));
const logged = await call("log_issue", {
  title: "set_temporal_ease needs an ease on at least one side",
  symptom: "Called with neither easeIn nor easeOut.",
  workaround: "Pass one of them.",
  tools: ["set_temporal_ease"],
  errorText: text(rejected),
  kind: "tool-bug",
  scope: "user",
});
ok("log_issue takes errorText and kind over the wire", !logged.isError && JSON.parse(text(logged)).kind === "tool-bug" && JSON.parse(text(logged)).lastVersion === VERSION);
const rejectedAgain = await call("set_temporal_ease", { compId: 1, layerId: 1, propertyPath: ["Transform", "Position"], keyIndex: 1 });
ok("the next rejection is answered with the entry", /Known from earlier sessions: user:set-temporal-ease-needs-an-ease-on-at-least-one-side/.test(text(rejectedAgain)));
ok("the rejection itself is unchanged in front of it", text(rejectedAgain).startsWith(text(rejected)));

// A success is never annotated, and archive_issue is reachable as a tool.
const fine = await call("list_comps", {});
ok("a successful call carries no pointer", !fine.isError && !/Known from earlier sessions/.test(text(fine)));
const archivedViaTool = await call("archive_issue", { id: "user:set-temporal-ease-needs-an-ease-on-at-least-one-side", reason: "already reported: https://example.invalid/100" });
ok("archive_issue answers", !archivedViaTool.isError && JSON.parse(text(archivedViaTool)).archived === true && JSON.parse(text(archivedViaTool)).scope === "user");
// Two user-scope entries about this tool are archived by now: the one just
// retired over the wire, and `spatial-ease-user-scope` from the push section.
const listing = JSON.parse(text(await call("list_known_issues", { tool: "set_temporal_ease", scope: "user" })));
ok("the listing hides it and counts it", listing.archivedCount === 2 && !listing.issues.some((e) => e.id === "set-temporal-ease-needs-an-ease-on-at-least-one-side"));
const listingAll = JSON.parse(text(await call("list_known_issues", { tool: "set_temporal_ease", scope: "user", includeArchived: true })));
ok("includeArchived reaches the server", listingAll.issues.some((e) => e.id === "set-temporal-ease-needs-an-ease-on-at-least-one-side" && e.archived === true));
const rejectedThird = await call("set_temporal_ease", { compId: 1, layerId: 1, propertyPath: ["Transform", "Position"], keyIndex: 1 });
ok("a retired entry is still named on failure, marked", /set-temporal-ease-needs-an-ease-on-at-least-one-side — .*\(archived: already reported: https:\/\/example\.invalid\/100\)/.test(text(rejectedThird)));

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
fs.rmSync(broken, { recursive: true, force: true });

console.log(
  `issue-journal: ${passed} assertions passed ` +
    `(index ${indexBytes} bytes vs full ${fullBytes} bytes for 3 entries)`
);
// Shut down in order — the MCP pair, then the stub the server's sockets point
// at — and settle before exiting. `process.exit()` straight after a `fetch`
// crashes Node 24 on Windows with a libuv assertion at exit, after every line
// above has passed (nodejs/node#56645: fixed in Node 26, never backported, and
// this file hit it twice in a row on the 0.5.0 PR while its siblings passed).
// The settle is the workaround every affected project uses. Exiting is still
// explicit because the server's WS client reconnects on a timer it owns, so
// the process would never drain on its own.
await client.close();
await server.close();
for (const c of stubWss.clients) c.terminate();
stubWss.close();
stubBridge.closeAllConnections?.();
stubBridge.close();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
