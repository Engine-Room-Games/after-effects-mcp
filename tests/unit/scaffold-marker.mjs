// The version marker the scaffold writes into AGENTS.md (issue #99).
//
// `Tools version last absorbed: <version>` is the line the absorb-release
// prompt reads after an upgrade, and the version in it has to be the one the
// user actually installed — read from package.json when the scaffold runs, not
// compiled in — or the first absorb pass re-reads releases the project was
// scaffolded on. The CI smoke test proves the scaffold writes files; this proves
// what is in the one that matters, through both entry points, and that the
// never-clobber rule still holds with the marker in place.
//
//   node tests/unit/scaffold-marker.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { scaffold, ScaffoldError, absorbedVersionIn, absorbedMarkerLine, ABSORBED_MARKER_PREFIX } =
  await import(dist("setup", "scaffold.js"));
const { packageVersion } = await import(dist("setup", "paths.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-scaffold-marker-"));
const read = (...p) => fs.readFileSync(path.join(tmp, ...p), "utf8");

const version = packageVersion();
assert.match(version, /^\d+\.\d+\.\d+$/, `packageVersion() must resolve in a checkout, got ${version}`);

// ------------------------------------------------------------- the reader
assert.equal(absorbedVersionIn(`# Notes\n\n${ABSORBED_MARKER_PREFIX} 0.5.0\n\nmore\n`), "0.5.0");
assert.equal(absorbedVersionIn("Tools version last absorbed: v0.10.0"), "0.10.0", "a leading v is tolerated");
assert.equal(absorbedVersionIn("  Tools version last absorbed: 1.2.3  "), "1.2.3", "surrounding whitespace is fine");
assert.equal(absorbedVersionIn("Tools version last absorbed: unknown"), null, "a non-version is no marker");
assert.equal(absorbedVersionIn("nothing here"), null);
assert.equal(
  absorbedVersionIn("the absorb flow greps for Tools version last absorbed: 0.5.0 in AGENTS.md"),
  null,
  "the marker is a whole line, so prose that mentions it is not a marker"
);
assert.equal(absorbedMarkerLine("0.5.0"), "Tools version last absorbed: 0.5.0");
assert.equal(absorbedVersionIn(absorbedMarkerLine("0.5.0")), "0.5.0", "what it writes, it reads");

// ------------------------------------------------- through scaffold() itself
const dir = path.join(tmp, "project");
const result = scaffold({ dir, client: "claude-code", withMcpConfig: false });
assert.ok(result.written.includes("AGENTS.md"));

const agents = read("project", "AGENTS.md");
assert.equal(absorbedVersionIn(agents), version, "AGENTS.md records the version of the server that wrote it");
assert.ok(agents.includes(`\n${absorbedMarkerLine(version)}\n`), "as its own line");
assert.ok(agents.includes("## Tool updates"), "under a heading a person can find");
assert.ok(/absorb-release/.test(agents), "and says which flow moves it on");

// The pointer file stays a pointer. Two copies of the marker would be two
// versions to keep in step, and the absorb flow would find whichever came first.
const claude = read("project", "CLAUDE.md");
assert.equal(absorbedVersionIn(claude), null, "CLAUDE.md is a pointer to AGENTS.md, not a second copy of the marker");

// Never clobber, marker included: a second init must refuse and leave the
// first AGENTS.md byte for byte — the recorded version is state, and a re-run
// silently resetting it to the current version would skip a release.
assert.throws(() => scaffold({ dir, client: "claude-code", withMcpConfig: false }), ScaffoldError);
assert.equal(read("project", "AGENTS.md"), agents, "a refused init leaves AGENTS.md untouched");

// The other layouts carry it too — the marker is in AGENTS.md, which every client gets.
for (const client of ["cursor", "claude-desktop", "generic"]) {
  const d = path.join(tmp, client);
  scaffold({ dir: d, client, withMcpConfig: false });
  assert.equal(absorbedVersionIn(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8")), version, `${client} layout`);
}

// ------------------------------------------------------- the CLI entry point
// Same scaffold, but this is the path the version has to reach through a
// process that was not started by an MCP client.
const cliDir = path.join(tmp, "cli-project");
const cli = spawnSync(process.execPath, [path.join(root, "packages", "mcp-server", "dist", "index.js"), "init", cliDir, "--no-mcp"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, `init failed:\n${cli.stderr}`);
assert.equal(absorbedVersionIn(fs.readFileSync(path.join(cliDir, "AGENTS.md"), "utf8")), version, "the CLI writes the same marker");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("scaffold-marker: ok");
