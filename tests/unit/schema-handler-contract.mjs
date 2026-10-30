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
//   — into object literals built from them (`sides = {"in": args.easeIn}`),
//   through return values, into every function they (or a part of them, or
//   an object spread from them) are passed to, across files, and from the
//   server into the ExtendScript op it forwards to. It walks in source order:
//   reassigning a variable to something else drops it (both arms of an `if`
//   are merged), and a nested function's own parameters shadow the outer ones. A read is `v.field` or `v["field"]` where
//   `v` holds the path above it. A string literal, a comment, or a property of
//   the same name on some other object credits nothing: a refusal message that
//   says "fill" is not a read of `fill`.
//
//   A key taken from a table of names counts as that name (`p[FIELDS[i][0]]`
//   with `FIELDS = [["position", …], …]`), but only when it indexes the
//   arguments. One generic form is accepted: `for (k in v)` over a tracked
//   object reads every field directly under it (add_shape_content applies whatever keys it
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
  // Read beside the .aep and summarised by the server (#220 stage 2); `detail`
  // never reaches the panel. It is refused as a batch step, so no jsx reads it.
  get_house_style: { branch: true, files: ["style/summary.ts", "files/houseStyle.ts"] },
  // Written by the server (#220 stage 2). OPS.set_house_style still reads the
  // same fields when the op arrives as a run_batch step.
  set_house_style: { branch: true, files: ["files/houseStyle.ts"], ops: ["set_house_style"] },
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

// What a variable can hold, as far as this test cares: a list of abstract
// values, each either
//   { path }            — the arguments object or a part of it ("" is the root,
//                          "easeIn" is args.easeIn; arrays are transparent);
//   { rec, fields, spreads } — an object literal built from such parts, so
//                          `var sides = { "in": args.easeIn }` and a later
//                          `sides["in"].speed` read `easeIn.speed`.
// Anything else is the empty list: not the arguments, and reads off it credit
// nothing.
const P = (path) => ({ key: `p:${path}`, path });
const uniq = (list) => {
  const seen = new Map();
  for (const v of list) if (!seen.has(v.key)) seen.set(v.key, v);
  return [...seen.values()];
};
const valuesKey = (vs) => vs.map((v) => v.key).sort().join(",");
const paramNames = (fn) => {
  const out = [];
  const names = (n) => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) for (const e of n.elements) if (e.name) names(e.name);
  };
  for (const p of fn.parameters) names(p.name);
  return out;
};

/**
 * Follows the arguments of one op, in source order, through the functions it
 * reaches. `reads` collects the field paths read off them; `enumerated` the
 * paths a `for…in` walked.
 */
class ArgFlow {
  constructor(jsx) {
    this.jsx = jsx;
    this.reads = new Set();
    this.enumerated = new Set();
    this.memo = new Map(); // fn -> Map(key -> return values)
  }

  /**
   * Enter `fn` with parameter `i` holding `values`, inside the scope `outer`
   * (a closure sees its parent's variables, minus the ones its parameters
   * shadow). Returns what the function can return.
   */
  enterFn(fn, i, values, index, outer = new Map()) {
    if (!fn.parameters[i] || values.length === 0) return [];
    let m = this.memo.get(fn);
    if (!m) this.memo.set(fn, (m = new Map()));
    const key = `${i}|${valuesKey(values)}`;
    if (m.has(key)) return m.get(key);
    m.set(key, []); // recursion sees nothing
    const env = new Map(outer);
    for (const n of paramNames(fn)) env.delete(n);
    this.bind(fn.parameters[i].name, values, env);
    const returns = [];
    if (fn.body) {
      this.walk(fn.body, env, index, returns);
      if (!ts.isBlock(fn.body)) returns.push(...this.valueOf(fn.body, env, index));
    }
    const out = uniq(returns);
    m.set(key, out);
    return out;
  }

  /** Bind a name or a destructuring pattern to `values`, crediting what a pattern reads. */
  bind(name, values, env) {
    if (ts.isIdentifier(name)) {
      if (values.length) env.set(name.text, values);
      else env.delete(name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const el of name.elements) {
      if (el.dotDotDotToken) {
        this.bind(el.name, values, env);
        continue;
      }
      const k = el.propertyName ?? el.name;
      if (!ts.isIdentifier(k) && !ts.isStringLiteral(k)) continue;
      this.bind(el.name, this.member(values, k.text, true), env);
    }
  }

  /** `values[key]` (or every member, when `key` is null), crediting path reads when `credit`. */
  member(values, key, credit) {
    const out = [];
    for (const v of values) {
      if (v.str !== undefined) {
        if (key === null) out.push(v); // an element of a table of names
        continue;
      }
      if (v.path !== undefined) {
        if (key === null) out.push(v); // an index into an array of them
        else {
          const p = v.path ? `${v.path}.${key}` : key;
          if (credit) this.reads.add(p);
          out.push(P(p));
        }
      } else {
        if (key === null) for (const f of v.fields.values()) out.push(...f);
        else if (v.fields.has(key)) out.push(...v.fields.get(key));
        else out.push(...this.member(v.spreads, key, credit));
      }
    }
    return uniq(out);
  }

  /**
   * The names `v[k]` can read: a string literal, or every name `k` can hold
   * when it comes from a table of names (`p[__TRANSFORM_FIELDS[i][0]]`).
   * Null for anything else — an array index.
   */
  keysOf(k, env, index) {
    k = unwrap(k);
    if (ts.isStringLiteralLike(k)) return [k.text];
    const strs = this.valueOf(k, env, index).filter((v) => v.str !== undefined).map((v) => v.str);
    return strs.length ? strs : null;
  }

  /** The values `e` can evaluate to. Pure apart from entering functions it calls. */
  valueOf(e, env, index) {
    e = unwrap(e);
    if (!e) return [];
    if (ts.isStringLiteralLike(e)) return [{ key: `s:${e.text}`, str: e.text }];
    if (ts.isIdentifier(e)) {
      if (env.has(e.text)) return env.get(e.text);
      // A top-level table of names, like transforms.jsx's __TRANSFORM_FIELDS:
      // only its strings, which matter only as keys (see keysOf).
      const out = [];
      for (const d of index.decls.get(e.text) ?? []) {
        const init = ts.isVariableDeclaration(d) ? unwrap(d.initializer) : null;
        if (init && ts.isArrayLiteralExpression(init)) out.push(...this.valueOf(init, new Map(), index).filter((v) => v.str !== undefined));
      }
      return uniq(out);
    }
    if (ts.isPropertyAccessExpression(e)) return this.member(this.valueOf(e.expression, env, index), e.name.text, false);
    if (ts.isElementAccessExpression(e)) {
      const base = this.valueOf(e.expression, env, index);
      const keys = this.keysOf(e.argumentExpression, env, index);
      return keys ? uniq(keys.flatMap((k) => this.member(base, k, false))) : this.member(base, null, false);
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return uniq([...this.valueOf(e.left, env, index), ...this.valueOf(e.right, env, index)]);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken) {
        return this.valueOf(e.right, env, index);
      }
      return [];
    }
    if (ts.isConditionalExpression(e)) {
      return uniq([...this.valueOf(e.whenTrue, env, index), ...this.valueOf(e.whenFalse, env, index)]);
    }
    if (ts.isObjectLiteralExpression(e)) {
      const fields = new Map();
      const spreads = [];
      for (const prop of e.properties) {
        if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))) {
          fields.set(prop.name.text, this.valueOf(prop.initializer, env, index));
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          fields.set(prop.name.text, env.get(prop.name.text) ?? []);
        } else if (ts.isSpreadAssignment(prop)) {
          spreads.push(...this.valueOf(prop.expression, env, index));
        }
      }
      const any = spreads.length || [...fields.values()].some((f) => f.some((v) => v.str === undefined));
      // Keyed by the literal's position: the same literal is the same record.
      return any ? [{ key: `r:${e.getSourceFile().fileName}:${e.pos}`, fields, spreads: uniq(spreads) }] : [];
    }
    if (ts.isArrayLiteralExpression(e)) {
      return uniq(e.elements.flatMap((x) => this.valueOf(ts.isSpreadElement(x) ? x.expression : x, env, index)));
    }
    if (ts.isCallExpression(e)) {
      const c = unwrap(e.expression);
      // zod's `.parse(args)` hands back the same fields.
      if (ts.isPropertyAccessExpression(c) && c.name.text === "parse" && e.arguments.length === 1) {
        return this.valueOf(e.arguments[0], env, index);
      }
      const out = [];
      e.arguments.forEach((arg, i) => {
        const vs = this.valueOf(arg, env, index).filter((v) => v.str === undefined);
        if (!vs.length) return;
        for (const [f, idx, scope] of this.callees(e, index, env)) out.push(...this.enterFn(f, i, vs, idx, scope));
      });
      return uniq(out);
    }
    return [];
  }

  /** Functions a callee names: [fn, index, closure scope]. */
  callees(call, index, env) {
    const c = unwrap(call.expression);
    const out = [];
    if (ts.isIdentifier(c)) {
      // A function local to the one being walked shadows a top-level one.
      const local = env.get(`\u0000fn:${c.text}`);
      if (local) return [[local.fn, index, local.scope]];
      for (const d of index.decls.get(c.text) ?? []) {
        if (isFn(d)) out.push([d, index, new Map()]);
        else if (ts.isVariableDeclaration(d) && isFn(unwrap(d.initializer))) out.push([unwrap(d.initializer), index, new Map()]);
      }
    } else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "OPS") {
      for (const f of handlerFns(this.jsx.ops.get(c.name.text))) out.push([f, this.jsx, new Map()]);
    }
    return out;
  }

  /**
   * Walk `body` in source order. An assignment replaces what a variable holds
   * — `o = getCompById(…)` stops `o` being the arguments from there on — and a
   * nested function is walked in its own scope, where its parameters shadow
   * the outer names.
   */
  walk(body, env, index, returns) {
    // Function declarations are hoisted: register them before anything runs.
    const hoist = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n !== body) env.set(`\u0000fn:${n.name.text}`, { fn: n, scope: env });
      if (!isFn(n) || n === body) ts.forEachChild(n, hoist);
    };
    if (ts.isBlock(body)) ts.forEachChild(body, hoist);

    const closure = (fn, bound) => {
      const inner = new Map(env);
      for (const n of paramNames(fn)) inner.delete(n);
      if (bound) this.bind(fn.parameters[bound.i].name, bound.values, inner);
      if (fn.body) this.walk(fn.body, inner, index, []);
    };

    const visit = (n) => {
      if (isFn(n)) {
        closure(n, null);
        return;
      }
      if (ts.isVariableDeclaration(n)) {
        if (n.initializer) visit(n.initializer);
        const init = unwrap(n.initializer);
        if (ts.isIdentifier(n.name) && isFn(init)) env.set(`\u0000fn:${n.name.text}`, { fn: init, scope: env });
        this.bind(n.name, n.initializer ? this.valueOf(n.initializer, env, index) : [], env);
        return;
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(n.left))) {
        visit(n.right);
        this.bind(unwrap(n.left), this.valueOf(n.right, env, index), env);
        return;
      }
      if (ts.isForInStatement(n) || ts.isForOfStatement(n)) {
        visit(n.expression);
        const vs = this.valueOf(n.expression, env, index);
        const v = n.initializer;
        const name = ts.isVariableDeclarationList(v) ? v.declarations[0].name : v;
        if (ts.isForInStatement(n)) {
          for (const x of vs) if (x.path !== undefined) this.enumerated.add(x.path);
          if (ts.isIdentifier(name)) env.delete(name.text); // the key, a string
        } else this.bind(name, this.member(vs, null, false), env);
        visit(n.statement);
        return;
      }
      if (ts.isIfStatement(n)) {
        // Either branch may have run: afterwards a variable holds what it held
        // on either side (`if (!args) args = {};` leaves args the arguments).
        visit(n.expression);
        const before = new Map(env);
        visit(n.thenStatement);
        const afterThen = new Map(env);
        env.clear();
        for (const [k, v] of before) env.set(k, v);
        if (n.elseStatement) visit(n.elseStatement);
        for (const [k, v] of afterThen) env.set(k, env.has(k) && Array.isArray(v) ? uniq([...env.get(k), ...v]) : v);
        return;
      }
      if (ts.isReturnStatement(n)) {
        if (n.expression) {
          visit(n.expression);
          returns.push(...this.valueOf(n.expression, env, index));
        }
        return;
      }
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const keys = ts.isPropertyAccessExpression(n) ? [n.name.text] : this.keysOf(n.argumentExpression, env, index);
        if (keys) {
          const base = this.valueOf(n.expression, env, index);
          for (const k of keys) this.member(base, k, true);
        }
        ts.forEachChild(n, visit);
        return;
      }
      if (ts.isCallExpression(n)) {
        const c = unwrap(n.expression);
        visit(n.expression);
        // args.items.forEach(function (item) { … }) — the callback's parameter
        // is an element of the array.
        if (ts.isPropertyAccessExpression(c) && ARRAY_CALLBACKS.has(c.name.text) && isFn(unwrap(n.arguments[0]))) {
          const cb = unwrap(n.arguments[0]);
          const vs = this.member(this.valueOf(c.expression, env, index), null, false);
          const i = c.name.text === "reduce" ? 1 : 0;
          closure(cb, vs.length && cb.parameters[i] ? { i, values: vs } : null);
          n.arguments.slice(1).forEach(visit);
        } else n.arguments.forEach(visit);
        // bridge.runOp("<op>", <tracked>) — the server forwarding to a panel op.
        if (ts.isPropertyAccessExpression(c) && c.name.text === "runOp" && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0])) {
          const vs = this.valueOf(n.arguments[1], env, index);
          for (const f of handlerFns(this.jsx.ops.get(n.arguments[0].text))) this.enterFn(f, 0, vs, this.jsx);
        }
        this.valueOf(n, env, index); // enters every callee handed a tracked value
        return;
      }
      ts.forEachChild(n, visit);
    };
    if (ts.isBlock(body)) ts.forEachChild(body, visit);
    else visit(body); // an arrow's expression body
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
    for (const f of fns) flow.enterFn(f, 0, [P("")], jsx);
    return flow;
  }
  const files = [...new Set([SERVER_TS, ...(spec.files ?? []).map((f) => path.join(srcDir, f))])];
  const cacheKey = files.join("|");
  if (!tsIndexCache.has(cacheKey)) tsIndexCache.set(cacheKey, indexSources(files.map((file) => ({ file })), ts.ScriptKind.TS));
  const index = tsIndexCache.get(cacheKey);
  if (spec.branch) {
    const blocks = branchesFor(index.files.get(SERVER_TS), op);
    assert.ok(blocks.length > 0, `SERVER_READERS.${op} says branch, but server.ts has no \`if (name === "${op}")\``);
    for (const b of blocks) flow.walk(b, new Map([["args", [P("")]], ["rawArgs", [P("")]]]), index, []);
  }
  for (const fn of spec.fns ?? []) {
    const d = (index.decls.get(fn) ?? []).filter(isFn);
    assert.ok(d.length, `SERVER_READERS.${op} names ${fn}, which none of its files declares as a function`);
    for (const f of d) {
      const i = f.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === "args");
      flow.enterFn(f, i < 0 ? 0 : i, [P("")], index);
    }
  }
  for (const o of spec.ops ?? []) {
    assert.ok(jsx.ops.has(o), `SERVER_READERS.${op} names OPS.${o}, which no .jsx file defines`);
    for (const f of handlerFns(jsx.ops.get(o))) flow.enterFn(f, 0, [P("")], jsx);
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

check("a variable reassigned to something else stops being the arguments", () => {
  const paths = unreadIn("add_marker", `
    OPS.add_marker = function (args) {
      var o = args;
      var t = [o.compId, o.layerId, o.time, o.duration, o.label, o.chapter, o.url];
      o = getCompById(args.compId);
      return [t, o.comment, o.frameTarget];
    };
  `);
  assert.deepEqual(paths, ["comment", "frameTarget"]);
});

check("an inner function's own parameter shadows the arguments", () => {
  const paths = unreadIn("add_marker", `
    OPS.add_marker = function (args) {
      function f(args) { return [args.comment, args.url]; }
      var g = function (args) { return args.label; };
      f(getCompById(1));
      g({});
      return [args.compId, args.layerId, args.time, args.duration, args.chapter, args.frameTarget];
    };
  `);
  assert.deepEqual(paths, ["comment", "label", "url"]);
  // …and is followed when it is handed the arguments.
  assert.deepEqual(
    unreadIn("add_marker", `
      OPS.add_marker = function (args) {
        function f(a) { return [a.comment, a.url, a.label]; }
        f(args);
        return [args.compId, args.layerId, args.time, args.duration, args.chapter, args.frameTarget];
      };
    `),
    []
  );
});

check("a part of the arguments carried in an object literal and a return value is followed", () => {
  // keyframes.jsx's shape: sides = {"in": easeIn, "out": easeOut}, returned
  // from one helper and read as sides["in"][i].speed in another.
  const paths = unreadIn("set_temporal_ease", `
    function __sides(a, b) { var s = { "in": a, "out": b, known: null }; return s; }
    function __apply(spec) { return [spec[0].speed, spec[0].influence]; }
    OPS.set_temporal_ease = function (args) {
      var sides = __sides(args.easeIn, null);
      __apply(sides["in"]);
      return [args.compId, args.layerId, args.propertyPath, args.keyIndex, args.easeOut];
    };
  `);
  // easeOut is one pair or a per-dimension list of them (issue #181).
  assert.deepEqual(paths, ["easeOut|0.influence", "easeOut|0.speed", "easeOut|1[].influence", "easeOut|1[].speed"]);
});

check("a field read by a key from a table of names is credited, and only off the arguments", () => {
  // transforms.jsx and text.jsx: p[__TRANSFORM_FIELDS[i][0]], args.range[rangeKeys[i][0]].
  const paths = unreadIn("add_marker", `
    var __FIELDS = [["comment", "x"], ["url", "y"]];
    var __OTHER = [["label", "z"]];
    OPS.add_marker = function (args) {
      var o = {};
      for (var i = 0; i < __FIELDS.length; i++) { var f = __FIELDS[i][0]; if (args[f] !== undefined) o[f] = 1; }
      for (var j = 0; j < __OTHER.length; j++) o[__OTHER[j][0]] = 2;
      return [args.compId, args.layerId, args.time, args.duration, args.chapter, args.frameTarget];
    };
  `);
  assert.deepEqual(paths, ["label"]);
});

console.log(`schema-handler-contract: ${passed} checks passed (${Object.keys(OpSchemas).length} ops)`);
