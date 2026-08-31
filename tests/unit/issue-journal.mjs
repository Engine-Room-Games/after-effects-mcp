// The issue journal's read paths.
//
// `list_known_issues` used to return the whole corpus on every call — thousands
// of tokens to answer "is there anything about screenshot_frame?", and a tool
// result is re-sent on every request for the rest of the session. The index is
// the fix, and the thing that could quietly ruin it is an index that no longer
// leads anywhere: if the summary or the `next` pointer goes missing, an agent
// reads one line, learns nothing, and guesses instead.
//
//   node tests/unit/issue-journal.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-journal-"));
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-journal-empty-"));
// Read on every call, so it decides where each of these calls writes and reads.
process.env.AE_MCP_HOME = home;

// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unsupported URL scheme.
const { listIssues, logIssue, markReported } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "issues", "journal.js")).href
);

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
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

logIssue({
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
  ok(`${e.id}: index carries enough to choose`, typeof e.summary === "string" && e.summary.length > 0);
  // The point of the index is that it is not the corpus.
  ok(`${e.id}: index withholds the body`, e.workaround === undefined && e.symptom === undefined);
}

// A clipped summary must look clipped, or it reads as the whole symptom.
const clipped = index.issues.find((e) => e.tools.includes("screenshot_frame"));
ok("long summaries are clipped", clipped.summary.length < LONG_SYMPTOM.length);
ok("clipping is visible", clipped.summary.endsWith("…"));

// The measurement this exists for.
const full = listIssues({ detail: "full" });
const indexBytes = JSON.stringify(index).length;
const fullBytes = JSON.stringify(full).length;
// Compare the part that scales with the corpus. The envelope — journal path,
// repo, version — is a fixed floor that a real journal of a dozen long entries
// amortises away, and these fixtures are shorter than real entries.
ok(
  "the index is a fraction of the corpus",
  JSON.stringify(index.issues).length * 2 < JSON.stringify(full.issues).length
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
// Nothing here writes: `listIssues` only reads, so the real journals stay
// untouched and uncreated. The condition is reproduced the way Claude Desktop
// produces it — a working directory of the filesystem root — rather than with
// a chmod, which is a no-op on Windows and CI runs there.
delete process.env.AE_MCP_HOME;
const cwd = process.cwd();
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
} finally {
  process.chdir(cwd);
  process.env.AE_MCP_HOME = home;
}

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log(
  `issue-journal: ${passed} assertions passed ` +
    `(index ${indexBytes} bytes vs full ${fullBytes} bytes for 3 entries)`
);
