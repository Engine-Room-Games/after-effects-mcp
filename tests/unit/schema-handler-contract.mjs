// Every field a tool advertises is read by the code behind it (issue #155).
//
// The failure this holds down looks exactly like success. A field in an op's
// zod schema is emitted to the model as part of the tool's input schema; if the
// handler never reads it, the model sets it, the call answers `{ok: true}`, and
// nothing it asked for happened. That is how create_shape_layer's
// fill/stroke/shapes (#148) and set_layer's trackMatte.layerId (#149) shipped —
// both advertised, neither read.
//
// What this checks, statically, with no After Effects:
//
//   For each op in `OpSchemas`, every field name the schema declares — at the
//   top level and inside nested objects, arrays, tuples and unions — must be
//   *read* somewhere in the op's reader set: its `OPS.<name>` handler plus every
//   top-level function and table that handler reaches by name, transitively. A
//   handler that forwards `args` to a helper is credited with what the helper
//   reads. "Read" is `x.field`, `x["field"]`, a whole string literal equal to
//   the name, or a key of a top-level lookup table (see `namesIn`).
//
//   A *nested* field is not credited by a read straight off `args`: otherwise
//   set_layer's `args.layerId` would vouch for `trackMatte.layerId`, which is
//   the escape this file was written to catch.
//
//   Ops the server answers, wholly or in part, are checked against the
//   TypeScript that reads them — `SERVER_READERS`. A server op missing from
//   that table fails the build, as does an op with no handler anywhere.
//
//   A field that is legitimately not read by name goes in `IGNORED_FIELDS`
//   with the reason. An entry that is no longer needed also fails the build, so
//   the table cannot rot into a list of fields that are fine.
//
// What it cannot prove: that a field which is read is read correctly, or on
// the right branch. The test is deliberately coarse — a top-level name read
// anywhere reachable passes. It catches the class of bug that actually shipped
// (a field nobody wrote a line for); tests/unit/fake-ae-ops.mjs and the other
// mock-DOM suites cover behaviour.
//
//   node tests/unit/schema-handler-contract.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;
const { OpSchemas, OpMutation } = await import(sharedDist("schemas.js"));

const jsxDir = path.join(root, "packages", "jsx");
const srcDir = path.join(root, "packages", "mcp-server", "src");

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`schema-handler-contract FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// Exceptions: `op: { "field.path": "reason" }`. The path is the one
// `schemaFields` prints — `a.b`, `a[].b`, `a|0.b` for a union's first branch.
// ---------------------------------------------------------------------------

const IGNORED_FIELDS = {
  set_layer: {
    // TODO(#149): accepted and never applied — the matte layer is never set.
    // Fixed by PR #205; remove this entry when that lands (this file fails
    // until you do).
    "trackMatte.layerId": "known bug #149, fixed in PR #205",
  },
};

// Ops the server answers, wholly or in part. A reader set is built from:
//   branch — the `if (name === "<op>") { … }` blocks in server.ts;
//   fns    — named functions in server.ts or `files`;
//   files  — further server modules, indexed so the walk can follow calls
//            into them (server.ts is always indexed);
//   ops    — ExtendScript handlers the server forwards to.
const SERVER_READERS = {
  // The panel gathers a fingerprint; the server stores and diffs it.
  snapshot_comp: { fns: ["runSnapshotOp"], ops: ["_comp_fingerprint"] },
  diff_comp: { fns: ["runSnapshotOp"], ops: ["_comp_diff"] },
  // The render itself is an aerender process; only prepare and save are AE.
  render_queue: { fns: ["runRender"], files: ["render/aerender.ts"], ops: ["_render_prepare", "_render_save"] },
  // The one op whose input is rewritten: scriptPath -> code, libraries ->
  // {path, text}, before OPS.run_jsx reads the rest.
  run_jsx: { fns: ["resolveRunJsxSource"], files: ["tools/runJsxSource.ts"], ops: ["run_jsx"] },
  // `detail` is applied by the server's summariser, not the panel (the panel
  // does not update itself — see style/summary.ts).
  get_house_style: { branch: true, files: ["style/summary.ts"], ops: ["get_house_style"] },
  await_job: { branch: true, files: ["jobs/manager.ts"] },
  get_job: { branch: true, files: ["jobs/manager.ts"] },
  cancel_job: { branch: true, files: ["jobs/manager.ts", "render/aerender.ts"] },
  check_setup: { branch: true, files: ["setup/check.ts"] },
  setup_panel: { branch: true, files: ["setup/install.ts"] },
  init_project: { branch: true, files: ["setup/scaffold.ts"] },
  ae_guide: { branch: true, files: ["tools/whatsNew.ts"] },
  log_issue: { branch: true, files: ["issues/journal.ts"] },
  list_known_issues: { branch: true, files: ["issues/journal.ts"] },
  mark_issue_reported: { branch: true, files: ["issues/journal.ts"] },
  archive_issue: { branch: true, files: ["issues/journal.ts"] },
};

// ---------------------------------------------------------------------------
// The schema side: every field name, at every depth.
// ---------------------------------------------------------------------------

const defOf = (s) => s._zod.def;

/** [{path, key}] for every object key reachable from `schema`. */
function schemaFields(schema) {
  const out = [];
  const onPath = new Set();
  const walk = (node, prefix) => {
    if (!node || onPath.has(node)) return; // a recursive schema stops at its own reference
    onPath.add(node);
    const d = defOf(node);
    switch (d.type) {
      case "object":
        for (const [k, v] of Object.entries(d.shape)) {
          const p = prefix ? `${prefix}.${k}` : k;
          out.push({ path: p, key: k });
          walk(v, p);
        }
        break;
      case "optional": case "default": case "prefault": case "nullable":
      case "readonly": case "nonoptional": case "catch":
        walk(d.innerType, prefix);
        break;
      case "array":
        walk(d.element, `${prefix}[]`);
        break;
      case "tuple":
        d.items.forEach((s, i) => walk(s, `${prefix}[${i}]`));
        if (d.rest) walk(d.rest, `${prefix}[...]`);
        break;
      case "union":
        d.options.forEach((s, i) => walk(s, `${prefix}|${i}`));
        break;
      case "record":
        walk(d.valueType, `${prefix}{}`);
        break;
      case "pipe":
        walk(d.in, prefix);
        walk(d.out, prefix);
        break;
      default:
        break;
    }
    onPath.delete(node);
  };
  walk(schema, "");
  return out;
}

// ---------------------------------------------------------------------------
// The code side: what names each piece of code reads.
// ---------------------------------------------------------------------------

/**
 * Names read under `node`, in two tiers:
 *   `any`    — every `x.name` / `x["name"]`, every whole string literal,
 *              every destructured key, and — when `inTable` — every key of the
 *              object literal (a top-level lookup table like `__SHAPE_PROPS =
 *              { size: [...] }` is how a `for (k in content)` loop reaches a
 *              field by name).
 *   `nested` — the same, minus reads straight off a variable called `args`.
 */
function namesIn(node, into, inTable = false) {
  const offArgs = (e) => ts.isIdentifier(e) && e.text === "args";
  const add = (name, viaArgs) => {
    into.any.add(name);
    if (!viaArgs) into.nested.add(name);
  };
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n)) add(n.name.text, offArgs(n.expression));
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      add(n.argumentExpression.text, offArgs(n.expression));
    } else if (ts.isStringLiteralLike(n)) add(n.text, false);
    else if (inTable && ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      add(n.name.text, false);
    } else if (ts.isBindingElement(n)) {
      // TypeScript readers: `const { compId, since } = args`.
      const key = n.propertyName ?? n.name;
      if (ts.isIdentifier(key)) add(key.text, false);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return into;
}

/** A top-level `var X = {...}` — its keys are a lookup table, not output. */
const isTable = (node) =>
  ts.isVariableDeclaration(node) && !!node.initializer && ts.isObjectLiteralExpression(node.initializer);

/** Identifiers referenced under `node` — the edges of the reachability walk. */
function identsIn(node, into = new Set()) {
  const visit = (n) => {
    if (ts.isIdentifier(n)) into.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return into;
}

const parse = ({ file, text }, kind) =>
  ts.createSourceFile(file, text ?? fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);

/**
 * Index sources: top-level functions, variables and classes by name, and every
 * `OPS.<name> = …`. Only top level — a nested helper is already inside its
 * enclosing function's body.
 */
function indexSources(sources, kind) {
  const decls = new Map(); // name -> [node]
  const ops = new Map(); // op -> node
  const files = new Map(); // file -> SourceFile
  const add = (name, node) => {
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push(node);
  };
  for (const src of sources) {
    const sf = parse(src, kind);
    files.set(src.file, sf);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) add(st.name.text, st);
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d);
      } else if (ts.isClassDeclaration(st) && st.name) add(st.name.text, st);
      else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression)) {
        const { left, right, operatorToken } = st.expression;
        if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "OPS") {
          ops.set(left.name.text, right);
        }
      }
    }
  }
  return { decls, ops, files };
}

/** Everything read by `starts` and whatever it reaches by name, transitively. */
function readerNames(index, starts, into = { any: new Set(), nested: new Set() }) {
  const visited = new Set();
  const queue = [...starts];
  while (queue.length) {
    const node = queue.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    namesIn(node, into, isTable(node));
    for (const id of identsIn(node)) {
      for (const d of index.decls.get(id) ?? []) if (!visited.has(d)) queue.push(d);
    }
  }
  return into;
}

/** The `then` blocks of every `if (name === "<op>")` in `sf`. */
function branchesFor(sf, op) {
  const found = [];
  const visit = (n) => {
    if (
      ts.isIfStatement(n) &&
      ts.isBinaryExpression(n.expression) &&
      n.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(n.expression.left) &&
      n.expression.left.text === "name" &&
      ts.isStringLiteral(n.expression.right) &&
      n.expression.right.text === op
    ) {
      found.push(n.thenStatement);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const jsxSources = fs
  .readdirSync(jsxDir)
  .filter((f) => f.endsWith(".jsx"))
  .sort()
  .map((f) => ({ file: path.join(jsxDir, f) }));
const JSX = indexSources(jsxSources, ts.ScriptKind.JS);
const SERVER_TS = path.join(srcDir, "server.ts");

function readersFor(op, jsx = JSX) {
  const spec = SERVER_READERS[op];
  if (!spec) {
    const h = jsx.ops.get(op);
    return h ? readerNames(jsx, [h]) : null;
  }
  const files = [SERVER_TS, ...(spec.files ?? []).map((f) => path.join(srcDir, f))];
  const index = indexSources([...new Set(files)].map((file) => ({ file })), ts.ScriptKind.TS);
  const starts = [];
  if (spec.branch) {
    const blocks = branchesFor(index.files.get(SERVER_TS), op);
    assert.ok(blocks.length > 0, `SERVER_READERS.${op} says branch, but server.ts has no \`if (name === "${op}")\``);
    starts.push(...blocks);
  }
  for (const fn of spec.fns ?? []) {
    const d = index.decls.get(fn);
    assert.ok(d, `SERVER_READERS.${op} names ${fn}, which none of its files declares`);
    starts.push(...d);
  }
  const names = readerNames(index, starts);
  for (const o of spec.ops ?? []) {
    assert.ok(jsx.ops.has(o), `SERVER_READERS.${op} names OPS.${o}, which no .jsx file defines`);
    readerNames(jsx, [jsx.ops.get(o)], names);
  }
  return names;
}

/** {unread: [{op, path}], used: Set("op:path")} for one op. */
function audit(op, schema, names, ignored = {}) {
  const unread = [];
  const used = new Set();
  for (const { path: p, key } of schemaFields(schema)) {
    const nested = p !== key;
    if ((nested ? names.nested : names.any).has(key)) continue;
    if (p in ignored) {
      used.add(`${op}:${p}`);
      continue;
    }
    unread.push({ op, path: p });
  }
  return { unread, used };
}

// ---------------------------------------------------------------------------
// The check itself.
// ---------------------------------------------------------------------------

const unread = [];
const usedIgnores = new Set();

check("every op has somewhere its arguments are read", () => {
  const nowhere = [];
  for (const op of Object.keys(OpSchemas)) {
    if (OpMutation[op] === "server" && !SERVER_READERS[op]) {
      nowhere.push(`${op} (server op: add it to SERVER_READERS)`);
    } else if (!SERVER_READERS[op] && !JSX.ops.has(op)) {
      nowhere.push(`${op} (no OPS.${op} in packages/jsx, and not in SERVER_READERS)`);
    }
  }
  assert.deepEqual(nowhere, []);
});

check("SERVER_READERS and IGNORED_FIELDS only name real ops", () => {
  for (const op of [...Object.keys(SERVER_READERS), ...Object.keys(IGNORED_FIELDS)]) {
    assert.ok(op in OpSchemas, `${op} is not in OpSchemas`);
  }
});

for (const [op, schema] of Object.entries(OpSchemas)) {
  const r = audit(op, schema, readersFor(op), IGNORED_FIELDS[op]);
  unread.push(...r.unread);
  for (const u of r.used) usedIgnores.add(u);
}

check("every schema field is read by its handler", () => {
  assert.deepEqual(
    unread.map((u) => `${u.op}: ${u.path}`),
    [],
    "These fields are advertised to the model and never read, so setting one does nothing and still " +
      "reports success. Read it in the handler, remove it from the schema, or — only if it is genuinely " +
      "consumed some other way — add it to IGNORED_FIELDS with the reason."
  );
});

check("every IGNORED_FIELDS entry is still needed", () => {
  const stale = [];
  for (const [op, fields] of Object.entries(IGNORED_FIELDS)) {
    for (const p of Object.keys(fields)) if (!usedIgnores.has(`${op}:${p}`)) stale.push(`${op}: ${p}`);
  }
  assert.deepEqual(stale, [], "These fields are read now (or no longer exist); delete their IGNORED_FIELDS entries.");
});

// ---------------------------------------------------------------------------
// The detector itself, on code written to fail it. Without these, a walker
// that credited everything would pass every check above.
// ---------------------------------------------------------------------------

const synthetic = (text) => indexSources([{ file: "synthetic.jsx", text }], ts.ScriptKind.JS);

check("a field nobody reads is reported", () => {
  const jsx = synthetic(`
    OPS.set_layer = function (args) {
      var l = getLayerById(getCompById(args.compId), args.layerId);
      if (args.name !== undefined) l.name = args.name;
      return { ok: true };
    };
  `);
  const { unread: u } = audit("set_layer", OpSchemas.set_layer, readersFor("set_layer", jsx));
  const paths = u.map((x) => x.path);
  assert.ok(paths.includes("enabled"), `enabled was credited: ${paths}`);
  assert.ok(paths.includes("trackMatte"), `trackMatte was credited: ${paths}`);
  assert.ok(!paths.includes("name"));
});

check("a nested field is not credited by a top-level read of the same name", () => {
  // The exact shape of #149: trackMatte.type read, trackMatte.layerId not,
  // and args.layerId read for the layer itself.
  const jsx = synthetic(`
    OPS.set_layer = function (args) {
      var l = getLayerById(getCompById(args.compId), args.layerId);
      if (args.trackMatte) l.trackMatteType = TrackMatteType[args.trackMatte.type];
    };
  `);
  const { unread: u } = audit("set_layer", OpSchemas.set_layer, readersFor("set_layer", jsx));
  const paths = u.map((x) => x.path);
  assert.ok(paths.includes("trackMatte.layerId"), `trackMatte.layerId was credited: ${paths}`);
  assert.ok(!paths.includes("trackMatte.type"));
});

check("a helper the handler forwards to is credited with what it reads", () => {
  const jsx = synthetic(`
    function __mk(a) { return [a.comment, a.duration, a.label, a.chapter, a.url, a.frameTarget]; }
    OPS.add_marker = function (args) {
      var c = getCompById(args.compId);
      if (args.layerId !== undefined) c = 0;
      return __mk(args).concat(args.time);
    };
  `);
  assert.deepEqual(audit("add_marker", OpSchemas.add_marker, readersFor("add_marker", jsx)).unread, []);
});

check("a function the handler never reaches is not credited", () => {
  const jsx = synthetic(`
    function __unrelated(a) { return a.comment; }
    OPS.remove_marker = function (args) { return [args.compId, args.layerId, args.markerIndex]; };
    OPS.add_marker = function (args) { return [args.compId, args.layerId, args.time]; };
  `);
  const paths = audit("add_marker", OpSchemas.add_marker, readersFor("add_marker", jsx)).unread.map((x) => x.path);
  assert.ok(paths.includes("comment"), `comment was credited from an unreachable function: ${paths}`);
});

console.log(`schema-handler-contract: ${passed} checks passed (${Object.keys(OpSchemas).length} ops)`);
