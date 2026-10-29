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
//   For each op in `OpSchemas`, every field the schema declares — at the top
//   level and inside nested objects, arrays, tuples and unions — must be *read
//   off the op's own arguments*. The test follows the arguments object, not
//   names: it starts at the handler's parameter and tracks every variable that
//   holds it or a part of it —
//
//     var a = args;  var tm = args.trackMatte || {};  const { x, ...rest } = a;
//     for (var i...) { var step = args.ops[i]; }   args.items.forEach(function (it) {})
//
//   — into every function the arguments (or a part of them, or an object
//   spread from them) are passed to, across files, and from the server into the
//   ExtendScript op it forwards to. A read is `v.field` or `v["field"]` where
//   `v` holds the path above it. A string literal, a comment, or a property of
//   the same name on some other object credits nothing: a refusal message that
//   says "fill" is not a read of `fill`.
//
//   One generic form is accepted: `for (k in v)` over a tracked object reads
//   every field directly under it (add_shape_content applies whatever keys it
//   was given, by name, and fails on any it cannot place).
//
//   Ops the server answers, wholly or in part, start from the TypeScript that
//   reads them — `SERVER_READERS`. A server op missing from that table fails
//   the build, as does an op with no handler anywhere.
//
//   A field that is legitimately not read goes in `IGNORED_FIELDS` with the
//   reason. An entry that is no longer needed also fails the build, so the
//   table cannot rot into a list of fields that are fine.
//
// What it cannot prove: that a field which is read is read correctly, or on
// the right branch (set_mask's `closed` is read only when `vertices` is also
// given — #207). tests/unit/fake-ae-ops.mjs and the other mock-DOM suites
// cover behaviour.
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
  add_text_animator: {
    // Read as `args.range[key]` with `key` taken from a table of
    // [field, matchName] pairs (text.jsx, `rangeKeys`), so no read names them.
    // Behaviour is covered by tests/unit/text-animator.mjs.
    "range.start": "read through the rangeKeys table in text.jsx",
    "range.end": "read through the rangeKeys table in text.jsx",
    "range.offset": "read through the rangeKeys table in text.jsx",
  },
};

// Ops the server answers, wholly or in part. The arguments are followed from:
//   branch — the `if (name === "<op>") { … }` blocks in server.ts, where they
//            are `args` / `rawArgs`;
//   fns    — named functions in server.ts or `files`, from the parameter
//            called `args` (else the first);
//   files  — further server modules, indexed so calls can be followed into
//            them (server.ts is always indexed);
//   ops    — ExtendScript handlers the server forwards the arguments to whole.
// A `bridge.runOp("<op>", <tracked>)` inside any of these is followed into
// that op without being listed.
const SERVER_READERS = {
  // The panel gathers a fingerprint; the server stores and diffs it.
  snapshot_comp: { fns: ["runSnapshotOp"] },
  diff_comp: { fns: ["runSnapshotOp"] },
  // The render itself is an aerender process; only prepare and save are AE.
  render_queue: { fns: ["runRender"], files: ["render/aerender.ts"] },
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
// The schema side: every field, at every depth.
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

/**
 * A schema path as code addresses it: union branches, array elements, tuple
 * slots and record values are transparent (`content|2.position` and
 * `ops[].op` are read as `content.position` and `ops.op`).
 */
const fieldKey = (p) => p.replace(/\|\d+/g, "").replace(/\[(\d+|\.\.\.)?\]/g, "").replace(/\{\}/g, "");

// ---------------------------------------------------------------------------
// The code side: follow the arguments object.
// ---------------------------------------------------------------------------

const parse = ({ file, text }, kind) =>
  ts.createSourceFile(file, text ?? fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);

/** Top-level functions and variables by name, and every `OPS.<name> = …`. */
function indexSources(sources, kind) {
  const decls = new Map(); // name -> [node]
  const ops = new Map(); // op -> expression
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
      } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression)) {
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

const isFn = (n) =>
  !!n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n));

/** The function(s) an `OPS.x = …` right-hand side installs: bare, or wrapped in noUndo(…) and friends. */
function handlerFns(expr) {
  if (isFn(expr)) return [expr];
  if (ts.isCallExpression(expr)) return expr.arguments.filter(isFn);
  return [];
}

const join = (base, key) => (base ? `${base}.${key}` : key);
const unwrap = (e) => {
  while (
    e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)))
  ) e = e.expression;
  return e;
};
const ARRAY_CALLBACKS = new Set(["forEach", "map", "filter", "some", "every", "find", "findIndex", "flatMap", "reduce"]);

/**
 * Follows the arguments of one op. `reads` collects the field paths read off
 * them; `enumerated` the paths a `for…in` walked.
 */
class ArgFlow {
  constructor(jsx) {
    this.jsx = jsx;
    this.reads = new Set();
    this.enumerated = new Set();
    this.entered = new Set();
  }

  /** Enter function `fn` with parameter `i` holding the path `p`. */
  enterFn(fn, i, p, index) {
    const key = `${i}\u0000${p}`;
    fn.__entered ??= new WeakMap();
    let seen = fn.__entered.get(this);
    if (!seen) fn.__entered.set(this, (seen = new Set()));
    if (seen.has(key)) return;
    seen.add(key);
    const param = fn.parameters[i];
    if (!param) return;
    const env = new Map();
    if (ts.isIdentifier(param.name)) env.set(param.name.text, p);
    else this.bindPattern(param.name, p, env);
    if (fn.body) this.walk(fn.body, env, index);
  }

  /** `{ a, b: c, ...rest }` bound from path `p`. */
  bindPattern(pat, p, env) {
    if (!ts.isObjectBindingPattern(pat)) return;
    for (const el of pat.elements) {
      if (el.dotDotDotToken) {
        if (ts.isIdentifier(el.name)) env.set(el.name.text, p);
        continue;
      }
      const k = el.propertyName ?? el.name;
      if (!ts.isIdentifier(k) && !ts.isStringLiteral(k)) continue;
      const fp = join(p, k.text);
      this.reads.add(fp);
      if (ts.isIdentifier(el.name)) env.set(el.name.text, fp);
      else this.bindPattern(el.name, fp, env);
    }
  }

  /** The argument path `e` evaluates to, or null when it is not one. */
  pathOf(e, env) {
    e = unwrap(e);
    if (!e) return null;
    if (ts.isIdentifier(e)) return env.has(e.text) ? env.get(e.text) : null;
    if (ts.isPropertyAccessExpression(e)) {
      const b = this.pathOf(e.expression, env);
      return b === null ? null : join(b, e.name.text);
    }
    if (ts.isElementAccessExpression(e)) {
      const b = this.pathOf(e.expression, env);
      if (b === null) return null;
      // A literal key is a field; anything else indexes an array (or a record).
      return ts.isStringLiteralLike(e.argumentExpression) ? join(b, e.argumentExpression.text) : b;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return this.pathOf(e.left, env) ?? this.pathOf(e.right, env);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.pathOf(e.right, env);
      return null;
    }
    if (ts.isConditionalExpression(e)) return this.pathOf(e.whenTrue, env) ?? this.pathOf(e.whenFalse, env);
    // zod's `.parse(args)` hands back the same fields.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "parse") {
      return e.arguments.length === 1 ? this.pathOf(e.arguments[0], env) : null;
    }
    return null;
  }

  /** What a call argument hands over: a tracked path, or an object spread from one. */
  passedPath(arg, env) {
    const p = this.pathOf(arg, env);
    if (p !== null) return p;
    const a = unwrap(arg);
    if (a && ts.isObjectLiteralExpression(a)) {
      for (const prop of a.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const s = this.pathOf(prop.expression, env);
          if (s !== null) return s;
        }
      }
    }
    return null;
  }

  /** Functions a callee names, with the index they live in. */
  callees(call, index) {
    const c = unwrap(call.expression);
    const out = [];
    const fromDecls = (name, idx) => {
      for (const d of idx.decls.get(name) ?? []) {
        if (isFn(d)) out.push([d, idx]);
        else if (ts.isVariableDeclaration(d) && isFn(unwrap(d.initializer))) out.push([unwrap(d.initializer), idx]);
      }
    };
    if (ts.isIdentifier(c)) fromDecls(c.text, index);
    else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "OPS") {
      for (const f of handlerFns(this.jsx.ops.get(c.name.text))) out.push([f, this.jsx]);
    }
    return out;
  }

  walk(body, env, index) {
    // Aliases first, to a fixed point, so a use above its declaration in the
    // source (hoisting, loops) is still seen.
    let size = -1;
    while (size !== env.size + this.enumerated.size) {
      size = env.size + this.enumerated.size;
      const collect = (n) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const p = this.pathOf(n.initializer, env);
          if (p !== null) {
            if (ts.isIdentifier(n.name)) env.set(n.name.text, p);
            else this.bindPattern(n.name, p, env);
          }
        } else if (
          ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)
        ) {
          const p = this.pathOf(n.right, env);
          if (p !== null) env.set(n.left.text, p);
        } else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
          const p = this.pathOf(n.expression, env);
          if (p !== null) {
            if (ts.isForInStatement(n)) this.enumerated.add(p);
            else {
              const v = n.initializer;
              const name = ts.isVariableDeclarationList(v) ? v.declarations[0].name : v;
              if (ts.isIdentifier(name)) env.set(name.text, p);
              else this.bindPattern(name, p, env);
            }
          }
        } else if (
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          ARRAY_CALLBACKS.has(n.expression.name.text)
        ) {
          // args.items.forEach(function (item) { … }) — the element is the array's path.
          const p = this.pathOf(n.expression.expression, env);
          const cb = n.arguments[0] && unwrap(n.arguments[0]);
          if (p !== null && isFn(cb)) {
            const at = n.expression.name.text === "reduce" ? 1 : 0;
            const prm = cb.parameters[at];
            if (prm && ts.isIdentifier(prm.name)) env.set(prm.name.text, p);
            else if (prm) this.bindPattern(prm.name, p, env);
          }
        }
        ts.forEachChild(n, collect);
      };
      collect(body);
    }

    const visit = (n) => {
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const p = this.pathOf(n, env);
        const base = this.pathOf(n.expression, env);
        if (p !== null && p !== base) this.reads.add(p);
      } else if (ts.isCallExpression(n)) {
        const c = unwrap(n.expression);
        // bridge.runOp("<op>", <tracked>) — the server forwarding to a panel op.
        if (
          ts.isPropertyAccessExpression(c) && c.name.text === "runOp" && n.arguments.length >= 2 &&
          ts.isStringLiteralLike(n.arguments[0])
        ) {
          const p = this.passedPath(n.arguments[1], env);
          if (p !== null) for (const f of handlerFns(this.jsx.ops.get(n.arguments[0].text))) this.enterFn(f, 0, p, this.jsx);
        }
        n.arguments.forEach((arg, i) => {
          const p = this.passedPath(arg, env);
          if (p === null) return;
          for (const [f, idx] of this.callees(n, index)) this.enterFn(f, i, p, idx);
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  }
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
const tsIndexCache = new Map();

/** The flow of one op's arguments, or null when nothing reads them. */
function readersFor(op, jsx = JSX) {
  const flow = new ArgFlow(jsx);
  const spec = SERVER_READERS[op];
  if (!spec) {
    const fns = handlerFns(jsx.ops.get(op));
    if (fns.length === 0) return null;
    for (const f of fns) flow.enterFn(f, 0, "", jsx);
    return flow;
  }
  const files = [...new Set([SERVER_TS, ...(spec.files ?? []).map((f) => path.join(srcDir, f))])];
  const cacheKey = files.join("|");
  if (!tsIndexCache.has(cacheKey)) tsIndexCache.set(cacheKey, indexSources(files.map((file) => ({ file })), ts.ScriptKind.TS));
  const index = tsIndexCache.get(cacheKey);
  if (spec.branch) {
    const blocks = branchesFor(index.files.get(SERVER_TS), op);
    assert.ok(blocks.length > 0, `SERVER_READERS.${op} says branch, but server.ts has no \`if (name === "${op}")\``);
    for (const b of blocks) flow.walk(b, new Map([["args", ""], ["rawArgs", ""]]), index);
  }
  for (const fn of spec.fns ?? []) {
    const d = (index.decls.get(fn) ?? []).filter(isFn);
    assert.ok(d.length, `SERVER_READERS.${op} names ${fn}, which none of its files declares as a function`);
    for (const f of d) {
      const i = f.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === "args");
      flow.enterFn(f, i < 0 ? 0 : i, "", index);
    }
  }
  for (const o of spec.ops ?? []) {
    assert.ok(jsx.ops.has(o), `SERVER_READERS.${op} names OPS.${o}, which no .jsx file defines`);
    for (const f of handlerFns(jsx.ops.get(o))) flow.enterFn(f, 0, "", jsx);
  }
  return flow;
}

/** {unread: [{op, path}], used: Set("op:path")} for one op. */
function audit(op, schema, flow, ignored = {}) {
  const unread = [];
  const used = new Set();
  for (const { path: p } of schemaFields(schema)) {
    const k = fieldKey(p);
    const parent = k.includes(".") ? k.slice(0, k.lastIndexOf(".")) : "";
    if (flow.reads.has(k) || flow.enumerated.has(parent)) continue;
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
    } else if (!SERVER_READERS[op] && handlerFns(JSX.ops.get(op)).length === 0) {
      nowhere.push(`${op} (no OPS.${op} function in packages/jsx, and not in SERVER_READERS)`);
    }
  }
  assert.deepEqual(nowhere, []);
});

check("SERVER_READERS and IGNORED_FIELDS only name real ops", () => {
  for (const op of [...Object.keys(SERVER_READERS), ...Object.keys(IGNORED_FIELDS)]) {
    assert.ok(op in OpSchemas, `${op} is not in OpSchemas`);
  }
});

check("no handler walks its whole arguments object with for…in", () => {
  // That would credit every top-level field at once and blind this test.
  const whole = Object.keys(OpSchemas).filter((op) => readersFor(op)?.enumerated.has(""));
  assert.deepEqual(whole, []);
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
    "These fields are advertised to the model and never read off the arguments, so setting one does nothing " +
      "and still reports success. Read it in the handler, remove it from the schema, or — only if it is " +
      "genuinely consumed some other way — add it to IGNORED_FIELDS with the reason."
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
const unreadIn = (op, text) => audit(op, OpSchemas[op], readersFor(op, synthetic(text))).unread.map((x) => x.path);
const topLevel = (op) => schemaFields(OpSchemas[op]).filter((f) => !f.path.includes(".")).map((f) => f.path);

check("set_layer with every read removed has every field flagged", () => {
  const paths = unreadIn("set_layer", `
    OPS.set_layer = function (args) {
      var l = { name: "x", enabled: true, trackMatte: 1 };
      l.name = "name"; l.enabled = l.locked; // same names, other objects
      __layerSummary(l);
      return { ok: true, compId: 1, layerId: 2, label: "label" };
    };
    function __layerSummary(l) { return [l.name, l.enabled, l.shy, l.solo, l.inPoint, l.outPoint, l.stretch]; }
  `);
  assert.deepEqual(paths.filter((p) => !p.includes(".")), topLevel("set_layer"));
  assert.ok(paths.includes("trackMatte.type") && paths.includes("trackMatte.layerId"), String(paths));
});

check("a field named only in a string or a comment is flagged", () => {
  // The create_shape_layer shape: a refusal message lists the field names.
  const paths = unreadIn("add_marker", `
    OPS.add_marker = function (args) {
      // args.comment and args.url are documented here, and never read
      var unsupported = ["comment", "duration", "label", "chapter", "url", "frameTarget"];
      var msg = "args.comment";
      return [args.compId, args.layerId, args.time, unsupported, msg];
    };
  `);
  assert.deepEqual(paths, ["duration", "comment", "label", "chapter", "url", "frameTarget"]);
});

check("a nested field is not credited by a top-level read of the same name", () => {
  // The exact shape of #149: trackMatte.type read, trackMatte.layerId not,
  // and args.layerId read for the layer itself.
  const paths = unreadIn("set_layer", `
    OPS.set_layer = function (args) {
      var l = getLayerById(getCompById(args.compId), args.layerId);
      var tm = args.trackMatte || {};
      if (tm.type) l.trackMatteType = TrackMatteType[tm.type];
    };
  `);
  assert.ok(paths.includes("trackMatte.layerId"), `trackMatte.layerId was credited: ${paths}`);
  assert.ok(!paths.includes("trackMatte.type") && !paths.includes("trackMatte"));
});

check("arguments forwarded to a helper are followed, under any name", () => {
  assert.deepEqual(
    unreadIn("add_marker", `
      function __mk(a) { var o = a; return [o.comment, o["duration"], a.label, a.chapter, a.url, a.frameTarget]; }
      OPS.add_marker = noUndo(function (args) {
        var c = getCompById(args.compId);
        if (args.layerId !== undefined) c = 0;
        return __mk(args).concat(args.time);
      });
    `),
    []
  );
});

check("a helper that reads the same names off something else credits nothing", () => {
  const paths = unreadIn("add_marker", `
    function __unrelated(a) { return [a.comment, a.url]; }
    function __mv(c) { return c.comment; }
    OPS.add_marker = function (args) {
      __mv(getCompById(args.compId));
      return [args.layerId, args.time, args.duration, args.label, args.chapter, args.frameTarget];
    };
  `);
  assert.deepEqual(paths, ["comment", "url"]);
});

console.log(`schema-handler-contract: ${passed} checks passed (${Object.keys(OpSchemas).length} ops)`);
