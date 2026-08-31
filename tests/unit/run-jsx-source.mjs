// run_jsx taking its script and its helper libraries from files.
//
// Every run_jsx body stays in the transcript for the rest of the session, and a
// scene build is four to ten scripts of 100-300 lines (issue #53). `scriptPath`
// and `libraries` exist so that text never enters the conversation at all — and
// the server is what reads the files, because Claude Desktop's agent has no
// filesystem tools and is the client this saves the most context for.
//
// This is the whole reason to resolve them server-side: it is directly testable
// with no After Effects anywhere. Everything below is a failure an agent could
// hit on its first attempt, and each one has to name the path it was given.
//
//   node tests/unit/run-jsx-source.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { resolveRunJsxSource, MAX_SCRIPT_BYTES, MAX_LIBRARIES } = await import(
  dist("tools", "runJsxSource.js")
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-run-jsx-"));
const write = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text, "utf8");
  return p;
};

let passed = 0;
const check = (name, fn) => { fn(); passed++; };
const rejects = (label, args, pattern) => {
  assert.throws(() => resolveRunJsxSource(args), pattern, label);
  passed++;
};

try {
  // ---------- code / scriptPath are exclusive ----------

  check("inline code passes straight through", () => {
    const out = resolveRunJsxSource({ code: "return 1;" });
    assert.equal(out.code, "return 1;");
    assert.equal(out.scriptPath, undefined);
    assert.equal(out.libraries, undefined);
  });

  check("undoGroup:false survives the resolution", () => {
    assert.equal(resolveRunJsxSource({ code: "x();", undoGroup: false }).undoGroup, false);
    // Absent stays absent rather than becoming an explicit true: the JSX side
    // reads `undoGroup === false`, and a default here would be a second place
    // that decides.
    assert.equal("undoGroup" in resolveRunJsxSource({ code: "x();" }), false);
  });

  check("diff and diffCompId survive the resolution", () => {
    // These were dropped for a release. This file passed the whole time, because
    // every case in it is built from the same list of fields the implementation
    // copied — so it could only ever confirm that the fields it already knew
    // about survived. `tests/unit/run-jsx-args.mjs` is the guard that reads the
    // list off the RunJsx schema instead; this case is the specific instance.
    const out = resolveRunJsxSource({ code: "x();", diff: true, diffCompId: 11370 });
    assert.equal(out.diff, true, "the panel's __diffStart reads args.diff — no key, no diff");
    assert.equal(out.diffCompId, 11370);
  });

  rejects(
    "neither code nor scriptPath is a clear refusal, not an empty run",
    {},
    /either `code`.*or `scriptPath`/s,
  );
  rejects("an empty string is not a script", { code: "" }, /either `code`/);
  rejects(
    "both at once is refused rather than one silently winning",
    { code: "x();", scriptPath: path.join(tmp, "a.jsx") },
    /not both/,
  );

  // ---------- scriptPath ----------

  check("a script file is read and its path echoed for error reporting", () => {
    const p = write("build.jsx", "var a = 1;\nreturn a;\n");
    const out = resolveRunJsxSource({ scriptPath: p });
    assert.equal(out.code, "var a = 1;\nreturn a;\n");
    assert.equal(out.scriptPath, p, "the panel needs the path so a failure can name the file");
  });

  rejects(
    "a relative path is refused, and the message says why",
    { scriptPath: "scripts/build.jsx" },
    /absolute path/,
  );
  rejects(
    "a missing file names the path",
    { scriptPath: path.join(tmp, "nope.jsx") },
    new RegExp(path.join(tmp, "nope.jsx").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
  );
  rejects("a directory is not a script", { scriptPath: tmp }, /is a directory/);

  check("an empty file is refused rather than reported as a completed run", () => {
    const p = write("empty.jsx", "   \n\n  ");
    // A whitespace-only script would run to completion and come back as
    // `{returned:null}` — indistinguishable from a real script that returned
    // nothing, for work that never existed.
    assert.throws(() => resolveRunJsxSource({ scriptPath: p }), /is empty/);
  });

  check("an oversized file is refused with both numbers", () => {
    const p = write("huge.jsx", "x".repeat(MAX_SCRIPT_BYTES + 10));
    assert.throws(
      () => resolveRunJsxSource({ scriptPath: p }),
      (e) =>
        new RegExp(String(MAX_SCRIPT_BYTES)).test(e.message) && /libraries/.test(e.message),
      "the limit and the way round it both belong in the message",
    );
  });

  check("UTF-8 survives the read", () => {
    const p = write("unicode.jsx", 'var name = "Grotesk — Médium";\nreturn name;\n');
    assert.match(resolveRunJsxSource({ scriptPath: p }).code, /Grotesk — Médium/);
  });

  // ---------- libraries ----------

  const libA = write("rig.jsx", "function rig() { return 1; }\n");
  const libB = write("style.jsx", "function palette() { return []; }\n");

  check("libraries become {path, hash, bytes}, in the order given", () => {
    const out = resolveRunJsxSource({ code: "rig();", libraries: [libA, libB] });
    assert.equal(out.libraries.length, 2);
    assert.equal(out.libraries[0].path, libA);
    assert.equal(out.libraries[1].path, libB);
    assert.ok(out.libraries[0].hash.length >= 8, "the panel keys its per-session cache on this");
    assert.equal(out.libraries[0].bytes, fs.statSync(libA).size);
  });

  check("the source is NOT inlined into the payload", () => {
    const out = resolveRunJsxSource({ code: "rig();", libraries: [libA] });
    assert.equal(
      JSON.stringify(out).includes("function rig"),
      false,
      "libraries go to the panel as a path and a hash. $.evalFile is the only way to\n" +
        "get them into global scope — eval would scope them to the loader and they\n" +
        "would be gone before the script ran.",
    );
  });

  check("the hash is stable across calls and moves when the file changes", () => {
    const first = resolveRunJsxSource({ code: "x();", libraries: [libA] }).libraries[0].hash;
    const again = resolveRunJsxSource({ code: "x();", libraries: [libA] }).libraries[0].hash;
    assert.equal(again, first, "an unchanged library must be a no-op on the panel, not a re-eval");
    fs.writeFileSync(libA, "function rig() { return 2; }\n", "utf8");
    const edited = resolveRunJsxSource({ code: "x();", libraries: [libA] }).libraries[0].hash;
    assert.notEqual(edited, first, "editing a library must re-evaluate it");
  });

  check("a path repeated in one call is sent once", () => {
    const out = resolveRunJsxSource({ code: "x();", libraries: [libA, libB, libA] });
    assert.deepEqual(out.libraries.map((l) => l.path), [libA, libB]);
  });

  check("no libraries means no libraries key at all", () => {
    assert.equal(resolveRunJsxSource({ code: "x();", libraries: [] }).libraries, undefined);
  });

  rejects(
    "a missing library names the file, not just 'a library'",
    { code: "x();", libraries: [path.join(tmp, "ghost.jsx")] },
    /ghost\.jsx/,
  );
  rejects(
    "a relative library path is refused like a relative script",
    { code: "x();", libraries: ["lib/rig.jsx"] },
    /absolute path/,
  );
  rejects(
    "an absurd number of libraries is refused",
    { code: "x();", libraries: new Array(MAX_LIBRARIES + 1).fill(libB) },
    new RegExp(`at most ${MAX_LIBRARIES}`),
  );

  check("a script file and libraries compose", () => {
    const p = write("scene.jsx", "return rig();\n");
    const out = resolveRunJsxSource({ scriptPath: p, libraries: [libA] });
    assert.equal(out.code, "return rig();\n");
    assert.equal(out.libraries.length, 1);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`run-jsx-source: ${passed} checks passed`);
