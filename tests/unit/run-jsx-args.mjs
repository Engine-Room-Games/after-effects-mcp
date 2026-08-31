// Every field the `RunJsx` schema declares has to reach the panel.
//
// `run_jsx` is the only op whose arguments the server rewrites on the way
// through: `resolveRunJsxSource` turns `scriptPath` into `code` and `libraries`
// into `{path, text, bytes}`. Until this test existed it did that by *building a fresh
// object* and copying the fields it happened to know about — which made it a
// hand-maintained second copy of the schema, and the two diverged the moment
// the schema grew. `diff` and `diffCompId` were added to `RunJsx` and
// `RunBatch` in the same change; `run_batch` forwards its args untouched and
// worked, `run_jsx` dropped both here, and the call came back looking like an
// ordinary success with no diff on it. Nothing failed. Nothing said anything.
//
// So the guard is not "diff survives" — that is one instance. It is: enumerate
// the schema, and fail if any field it declares is unreachable after
// resolution. Same shape as the OpMutation classification guard in
// write-queue.mjs, and for the same reason: a table nobody updates is worse
// than no table, because the omission is classified by silence.
//
//   node tests/unit/run-jsx-args.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { resolveRunJsxSource } = await import(serverDist("tools", "runJsxSource.js"));
const { OpSchemas, objectShapeOf } = await import(sharedDist("schemas.js"));

const RunJsx = OpSchemas.run_jsx;
// `RunJsx` carries a cross-field rule (`code` xor `scriptPath`), which makes it
// a `ZodEffects` — and a `ZodEffects` has no `.shape`. `objectShapeOf` peels the
// wrappers off, so this enumeration keeps working the next time a rule is added.
const runJsxShape = objectShapeOf(RunJsx);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-run-jsx-args-"));
const write = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text, "utf8");
  return p;
};

let passed = 0;
const check = (name, fn) => { fn(); passed++; };

try {
  // -------------------------------------------------------------------------
  // Sample values. The three source fields need real files; everything else is
  // generated from its zod type, so a field added to the schema tomorrow is
  // covered without touching this file.
  // -------------------------------------------------------------------------

  const scriptFile = write("scene.jsx", "return 1;\n");
  const libFile = write("rig.jsx", "function rig() { return 1; }\n");

  const SOURCE_FIELDS = {
    code: "return 1;",
    scriptPath: scriptFile,
    libraries: [libFile],
  };

  /** Peel `.optional()`, `.default()`, `.nullable()` off to reach the real type. */
  const unwrap = (t) => {
    let cur = t;
    for (let i = 0; i < 16 && cur?._def?.innerType; i++) cur = cur._def.innerType;
    return cur;
  };

  /**
   * A plausible value for a field this test has never heard of.
   *
   * Throws rather than skipping on a type it cannot generate. A guard that
   * quietly passes over the field it does not understand is the exact failure
   * mode it exists to catch.
   */
  const sampleFor = (key, type) => {
    const inner = unwrap(type);
    const kind = inner?._def?.typeName;
    switch (kind) {
      case "ZodString": return `sample-${key}`;
      case "ZodNumber": return 11370;
      case "ZodBoolean": return true;
      case "ZodArray": {
        const el = unwrap(inner._def.type)?._def?.typeName;
        if (el === "ZodString") return [`sample-${key}`];
        if (el === "ZodNumber") return [1];
        break;
      }
      case "ZodEnum": return inner._def.values[0];
      case "ZodLiteral": return inner._def.value;
      default: break;
    }
    throw new Error(
      `tests/unit/run-jsx-args.mjs cannot build a sample value for RunJsx.${key} (${kind ?? "unknown"}).\n` +
        "A new field was added to the RunJsx schema and this guard cannot exercise it. Teach\n" +
        "sampleFor() that type, or add the field to SOURCE_FIELDS if resolveRunJsxSource\n" +
        "transforms it. Do not delete the field from the check — being unable to test that a\n" +
        "field reaches the panel is the same as knowing it does not."
    );
  };

  const declared = Object.keys(runJsxShape);

  check("RunJsx still declares the fields this guard is built around", () => {
    for (const k of ["code", "scriptPath", "libraries"]) {
      assert.ok(declared.includes(k), `RunJsx no longer declares ${k} — update SOURCE_FIELDS`);
    }
  });

  /**
   * Resolve one full payload. `code` and `scriptPath` are mutually exclusive and
   * refused together, so coverage takes two passes and unions them.
   */
  const resolveWith = (source) => {
    const args = {};
    for (const key of declared) {
      if (key in SOURCE_FIELDS) {
        if (key === "code" || key === "scriptPath") {
          if (key !== source) continue;
        }
        args[key] = SOURCE_FIELDS[key];
      } else {
        args[key] = sampleFor(key, runJsxShape[key]);
      }
    }
    // Through zod first, exactly as server.ts does it: the sample has to be a
    // payload the schema actually accepts, or this guard proves nothing.
    return { args, out: resolveRunJsxSource(RunJsx.parse(args)) };
  };

  const viaCode = resolveWith("code");
  const viaPath = resolveWith("scriptPath");

  check("every field RunJsx declares is reachable on the resolved args", () => {
    const unreachable = declared.filter(
      (k) => !(k in viaCode.out) && !(k in viaPath.out)
    );
    assert.deepEqual(
      unreachable,
      [],
      `resolveRunJsxSource drops RunJsx field(s): ${unreachable.join(", ")}\n\n` +
        "They are declared in the schema, so the tool advertises them and an agent will\n" +
        "pass them — and the panel never sees them. The call still succeeds, which is the\n" +
        "worst possible way for this to fail.\n\n" +
        "The fix is not to copy them across one by one in runJsxSource.ts. That enumeration\n" +
        "is what produced this bug in the first place. Spread the caller's args and override\n" +
        "only what this function genuinely resolves."
    );
  });

  check("fields this function does not resolve arrive byte-for-byte", () => {
    // A field that arrives changed is a different lie from one that never
    // arrives, and just as quiet. Only the three source fields may differ.
    for (const { args, out } of [viaCode, viaPath]) {
      for (const key of Object.keys(args)) {
        if (key in SOURCE_FIELDS) continue;
        assert.deepEqual(out[key], args[key], `resolveRunJsxSource altered ${key}`);
      }
    }
  });

  check("the resolver invents nothing the caller did not send", () => {
    // The panel reads `undoGroup === false` and `args.diff` directly, so a
    // default manufactured here would be a second place that decides what the
    // call meant. Absent has to stay absent.
    const out = resolveRunJsxSource(RunJsx.parse({ code: "return 1;" }));
    assert.deepEqual(Object.keys(out), ["code"]);
  });

  // -------------------------------------------------------------------------
  // The instance that started it. Kept as its own case so the failure names
  // `diff` rather than a set — this is the one a human re-runs in After
  // Effects (verification recipe 29).
  // -------------------------------------------------------------------------

  check("diff and diffCompId survive resolution — inline code", () => {
    const out = resolveRunJsxSource(
      RunJsx.parse({ code: "return 1;", diff: true, diffCompId: 11370 })
    );
    assert.equal(out.diff, true, "the panel's __diffStart reads args.diff — no key, no diff");
    assert.equal(out.diffCompId, 11370);
  });

  check("diff and diffCompId survive resolution — scriptPath and libraries", () => {
    const out = resolveRunJsxSource(
      RunJsx.parse({ scriptPath: scriptFile, libraries: [libFile], diff: true, diffCompId: 11370 })
    );
    assert.equal(out.diff, true);
    assert.equal(out.diffCompId, 11370);
    assert.equal(out.code, "return 1;\n", "the file is still read");
    assert.equal(out.libraries.length, 1, "libraries are still resolved to {path, hash}");
    assert.equal(out.libraries[0].path, libFile);
  });

  check("diff:false is carried, not dropped as falsy", () => {
    const out = resolveRunJsxSource(RunJsx.parse({ code: "x();", diff: false }));
    assert.equal(out.diff, false);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`run-jsx-args: ${passed} checks passed`);
