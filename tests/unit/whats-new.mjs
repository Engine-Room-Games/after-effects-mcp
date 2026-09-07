// The `since` filter on ae_guide's whats-new topic, and the contract the guide
// is written to so the filter can work (issue #99).
//
// Three layers, because each fails in a different silence:
//
//   - the pure functions in tools/whatsNew.ts — the splitter and the semver
//     compare. A string compare puts 0.10.0 before 0.9.0 and nothing would say
//     so until a release past 0.9.0;
//   - the real guides/whats-new.md against its own contract — every `##` a
//     release, newest first, a section for the version being built, every entry
//     leading with the rule as it now stands, `supersedes:` lines plain enough
//     to grep for. A file that drifts from this still renders fine as prose and
//     the filter quietly returns the wrong slice;
//   - the tool as an agent meets it, through tools/call on the real server:
//     the version header, the rejection on other topics, and the resource left
//     untouched.
//
//   node tests/unit/whats-new.mjs

import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { parseSemver, compareSemver, splitReleases, h2Headings, supersedesLines, renderWhatsNew } =
  await import(dist("tools", "whatsNew.js"));
const { packageVersion } = await import(dist("setup", "paths.js"));
const { getGuide } = await import(dist("generated", "content.js"));

// ------------------------------------------------------------------ semver
assert.deepEqual(parseSemver("0.10.0"), [0, 10, 0]);
assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3], "a leading v is tolerated");
assert.equal(parseSemver("1.2"), null);
assert.equal(parseSemver("abc"), null);
assert.equal(parseSemver("0.5.0-beta"), null, "only plain three-part versions; this project ships no others");

assert.ok(compareSemver("0.10.0", "0.9.0") > 0, "0.10.0 is newer than 0.9.0 — a string compare gets this backwards");
assert.ok(compareSemver("0.9.0", "0.10.0") < 0);
assert.equal(compareSemver("0.4.0", "0.4.0"), 0);
assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
assert.ok(compareSemver("0.4.1", "0.4.0") > 0);
assert.ok(compareSemver("v0.5.0", "0.4.0") > 0);
assert.throws(() => compareSemver("0.4", "0.4.0"), /Not a version/, "a malformed version is refused, not guessed");

const sorted = ["0.9.0", "0.10.0", "0.4.0", "1.0.0"].sort((a, b) => compareSemver(b, a));
assert.deepEqual(sorted, ["1.0.0", "0.10.0", "0.9.0", "0.4.0"]);
assert.notDeepEqual([...sorted].sort().reverse(), sorted, "the case the default sort would get wrong");

// ---------------------------------------------------------------- splitter
const DOC = [
  "# What changed",
  "",
  "Preamble line.",
  "",
  "## 0.10.0",
  "",
  "- **Ten.**",
  "  supersedes: nine is the latest",
  "",
  "## 0.9.0",
  "",
  "### Group",
  "",
  "- **Nine.** Reason.",
  "  supersedes: eight rule",
  "  supersedes: another eight rule",
  "",
  "## 0.4.0",
  "",
  "- **Four.**",
  "",
].join("\n");

const s = splitReleases(DOC);
assert.equal(s.preamble, "# What changed\n\nPreamble line.");
assert.deepEqual(s.sections.map((x) => x.version), ["0.10.0", "0.9.0", "0.4.0"]);
assert.ok(s.sections[1].text.startsWith("## 0.9.0"), "a section keeps its own heading");
assert.ok(s.sections[1].text.includes("### Group"), "### groupings stay inside their release");
assert.ok(!s.sections[1].text.includes("## 0.4.0"), "and stop at the next release");
assert.deepEqual(supersedesLines(s.sections[1].text), ["eight rule", "another eight rule"]);
assert.deepEqual(supersedesLines(DOC), ["nine is the latest", "eight rule", "another eight rule"]);
assert.deepEqual(h2Headings(DOC), ["## 0.10.0", "## 0.9.0", "## 0.4.0"]);

const none = splitReleases("# Only prose\n\nno releases\n");
assert.equal(none.sections.length, 0);
assert.equal(none.preamble, "# Only prose\n\nno releases");

assert.deepEqual(
  splitReleases(DOC.replace(/\n/g, "\r\n")).sections.map((x) => x.version),
  ["0.10.0", "0.9.0", "0.4.0"],
  "CRLF sources split the same way"
);
assert.deepEqual(splitReleases("## v0.4.0\n\n- **x**\n").sections.map((x) => x.version), ["0.4.0"]);

// A `supersedes:` mention in running prose is not a supersedes line: only an
// indented one directly under a bullet counts, so the preamble can explain the
// convention without becoming a grep target itself.
assert.deepEqual(supersedesLines("A `supersedes:` line quotes the old rule.\nsupersedes: not indented"), []);

// ------------------------------------------------------------------ filter
let r = renderWhatsNew(DOC, { since: "0.9.0", serverVersion: "0.10.0" });
assert.deepEqual(r.versions, ["0.10.0"]);
assert.equal(r.newest, "0.10.0");
assert.ok(
  r.text.startsWith("This server is after-effects-mcp 0.10.0. Showing releases after 0.9.0: 0.10.0."),
  `header line wrong:\n${r.text.split("\n")[0]}`
);
assert.ok(r.text.includes("Preamble line."), "the preamble is kept");
assert.ok(r.text.includes("## 0.10.0"));
assert.ok(!r.text.includes("## 0.9.0"), "the version named in `since` is the one already absorbed — excluded");
assert.ok(!r.text.includes("## 0.4.0"));

r = renderWhatsNew(DOC, { since: "0.4.0", serverVersion: "0.10.0" });
assert.deepEqual(r.versions, ["0.10.0", "0.9.0"]);
assert.ok(r.text.indexOf("## 0.10.0") < r.text.indexOf("## 0.9.0"), "newest first, as in the file");
assert.match(r.text, /Showing releases after 0\.4\.0: 0\.10\.0, 0\.9\.0\./);

r = renderWhatsNew(DOC, { since: "0.10.0", serverVersion: "0.10.0" });
assert.deepEqual(r.versions, []);
assert.equal(
  r.text,
  "This server is after-effects-mcp 0.10.0. Nothing newer than 0.10.0: the newest release described here is 0.10.0.",
  "nothing newer is one explicit line, never an empty string and never the preamble"
);

r = renderWhatsNew(DOC, { since: "9.0.0", serverVersion: "0.10.0" });
assert.deepEqual(r.versions, []);
assert.match(r.text, /Nothing newer than 9\.0\.0: the newest release described here is 0\.10\.0\./);

assert.deepEqual(renderWhatsNew(DOC, { since: "v0.9.0", serverVersion: "x" }).versions, ["0.10.0"]);

r = renderWhatsNew(DOC, { serverVersion: "0.10.0" });
assert.ok(r.text.startsWith("This server is after-effects-mcp 0.10.0. Pass `since`"), "unfiltered still names the version");
assert.ok(r.text.includes("## 0.4.0") && r.text.includes("## 0.10.0"), "and carries every release");
assert.deepEqual(r.versions, ["0.10.0", "0.9.0", "0.4.0"]);

r = renderWhatsNew("# Only prose\n", { since: "0.1.0", serverVersion: "1.0.0" });
assert.equal(r.newest, null);
assert.match(r.text, /this guide describes no releases/);

// --------------------------------------------- the real file, its contract
const guide = getGuide("whats-new");
assert.ok(guide, "whats-new is a guide");
const real = splitReleases(guide.body);
assert.ok(real.sections.length >= 3, "0.3.0, 0.3.1 and 0.4.0 at the least");

for (const h of h2Headings(guide.body)) {
  assert.match(h, /^## \d+\.\d+\.\d+$/, `every ## heading in whats-new.md must be a release, found: ${h}`);
}
for (let i = 1; i < real.sections.length; i++) {
  assert.ok(
    compareSemver(real.sections[i - 1].version, real.sections[i].version) > 0,
    `releases must be newest first with no duplicates: ${real.sections[i - 1].version} then ${real.sections[i].version}`
  );
}

// A release that ships without a section is a release nobody can absorb. The
// package version is read the way the server reads it, so this holds on a
// release branch (where the section is written before the bump) and after it.
const pkg = packageVersion();
assert.match(pkg, /^\d+\.\d+\.\d+$/, `packageVersion() should be a version, got ${pkg}`);
assert.ok(
  compareSemver(real.sections[0].version, pkg) >= 0,
  `whats-new.md's newest section is ${real.sections[0].version} but the package is ${pkg} — add a ## ${pkg} section`
);

// The preamble travels with every filtered read, so it is a per-absorb tax.
assert.ok(real.preamble.length < 3000, `whats-new.md's preamble is ${real.preamble.length} chars — it is returned on every filtered read, keep it short`);
assert.deepEqual(supersedesLines(real.preamble), [], "supersedes lines belong to entries, not the preamble");

// Every entry leads with the rule as it now stands, in bold. An entry that leads
// with the old story is the thing an agent then repeats to a user.
for (const sec of real.sections) {
  for (const line of sec.text.split("\n")) {
    if (/^- /.test(line)) {
      assert.match(line, /^- \*\*/, `an entry in ${sec.version} must open with the current rule in bold: ${line.slice(0, 70)}`);
    }
  }
}

// Every supersedes line sits directly inside a bullet, and is a grep target:
// plain words, no markdown to defeat a search of a project's notes.
{
  let inBullet = false;
  for (const line of guide.body.split("\n")) {
    if (/^- /.test(line)) inBullet = true;
    else if (line.trim() === "" || /^#/.test(line)) inBullet = false;
    if (/^\s+supersedes:/.test(line)) {
      assert.ok(inBullet, `a supersedes line outside a bullet: ${line.trim()}`);
    }
  }
  for (const old of supersedesLines(guide.body)) {
    // Underscores stay: tool names carry them, and a grep for `run_batch` wants them.
    assert.ok(!/[`*\[\]]/.test(old), `supersedes lines are grep targets and carry no markdown: ${old}`);
    assert.ok(old.length >= 10 && old.length <= 120, `a supersedes line should be a short literal phrase: ${old}`);
  }
}

// The ones issue #99 named for 0.4.0, in the words a project doc would use.
const v040 = real.sections.find((x) => x.version === "0.4.0");
assert.ok(v040, "0.4.0 must keep its section");
const sup040 = supersedesLines(v040.text);
for (const want of [
  "run_batch is one undo step",
  "reorder_layer is broken, use run_jsx",
  "downsample: 1 means the viewer's resolution",
]) {
  assert.ok(sup040.includes(want), `0.4.0 must carry "supersedes: ${want}"; has:\n  ${sup040.join("\n  ")}`);
}
// A supersedes line belongs to the release that shipped the change and no
// earlier one: written under an older release it would send the absorb flow
// deleting a rule that is still true. Nothing offline can know which release a
// change shipped in, so that is a review rule, not an assertion here.

// ------------------------------------------- through the server, as a tool
// The bridge is never touched by ae_guide, but createServer() probes it, so
// point it at a port nothing listens on rather than the real panel's 7777.
const free = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
assert.notEqual(free, 7777);
process.env.AE_MCP_PORT = String(free);

const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "whats-new-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const call = (args) => client.callTool({ name: "ae_guide", arguments: args });

let res = await call({ topic: "whats-new", since: "0.4.0" });
assert.equal(res.isError, undefined, res.content[0]?.text);
assert.equal(res.content.length, 1, "prose, one block — not JSON");
let text = res.content[0].text;
assert.ok(text.startsWith(`This server is after-effects-mcp ${pkg}.`), `the answer opens with the server's own version:\n${text.split("\n")[0]}`);
assert.ok(!text.includes("## 0.4.0"), "0.4.0 is the version absorbed, so it is not returned");
assert.ok(!text.includes("## 0.3.1"));
const expected = real.sections.filter((x) => compareSemver(x.version, "0.4.0") > 0).map((x) => x.version);
for (const v of expected) assert.ok(text.includes(`## ${v}`), `section ${v} should be in the answer`);
assert.ok(text.includes("**When this topic and a tool's own schema disagree, believe the schema.**"), "the preamble rides along");

res = await call({ topic: "whats-new", since: real.sections[0].version });
assert.equal(res.isError, undefined);
assert.match(res.content[0].text, /^This server is after-effects-mcp .*\. Nothing newer than /);
assert.equal(res.content[0].text.split("\n").length, 1, "nothing newer is a single line");

res = await call({ topic: "whats-new" });
assert.equal(res.isError, undefined);
assert.ok(res.content[0].text.startsWith(`This server is after-effects-mcp ${pkg}. Pass \`since\``));
assert.ok(res.content[0].text.includes("## 0.3.0"), "unfiltered is the whole history");

res = await call({ topic: "after-effects", since: "0.4.0" });
assert.equal(res.isError, true, "`since` on any other topic is refused, not silently ignored");
assert.match(res.content[0].text, /whats-new topic only/);
assert.match(res.content[0].text, /ae_guide\(\{topic: "after-effects"\}\)/, "and the rejection names the call that works");

res = await call({ topic: "after-effects" });
assert.equal(res.isError, undefined, "the other topics are unchanged");
assert.ok(res.content[0].text.startsWith("# Driving After Effects"), "no version header on a topic that is not whats-new");

res = await call({ topic: "whats-new", since: "0.4" });
assert.equal(res.isError, true, "a non-semver since is rejected by the schema");
assert.match(res.content[0].text, /since/);
assert.match(res.content[0].text, /like 0\.4\.0/, "and the rejection says what a version looks like");

// The resource is the raw guide: no header, no filter. Only the tool answers
// with the server's version, because only the tool can be asked `since`.
const resource = await client.readResource({ uri: "ae://guide/whats-new" });
assert.equal(resource.contents[0].text, guide.body);

console.log("whats-new: ok");
// The bridge's WS client reconnects on a timer the server owns; nothing to await.
process.exit(0);
