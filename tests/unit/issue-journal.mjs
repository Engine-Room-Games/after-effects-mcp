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

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log(
  `issue-journal: ${passed} assertions passed ` +
    `(index ${indexBytes} bytes vs full ${fullBytes} bytes for 3 entries)`
);
