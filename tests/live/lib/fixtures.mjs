// Recipe fixtures: loading, validating, templating and asserting. Pure — no
// After Effects, no server — so all of it is tested offline in
// tests/unit/live-driver.mjs.
//
// A fixture is one JSON file under tests/live/recipes/, scripting the part of
// one recipe in docs/verification-recipes.md that a JSON result can answer.
// What only a person can see (an Edit menu, a rendered frame) goes in
// `manual`, and the runner prints it beside the result.
//
//   {
//     "recipe": 6,
//     "title": "run_batch of 50 is one undo step",
//     "manual": "Edit menu reads Undo AE MCP Batch; one Cmd-Z removes all 50.",
//     "needsSavedProject": false,
//     "steps": [
//       { "call": "create_comp", "args": { "name": "t" }, "save": "comp",
//         "expect": [{ "path": "id", "type": "number" }] },
//       { "call": "run_batch", "args": { "ops": { "$repeat": 50, "item":
//           { "op": "create_solid_layer", "args": { "compId": "${comp.id}", "color": [1, 0, 0], "name": "s${n}" } } } },
//         "expect": [{ "path": "undoSteps", "equals": 1 }] }
//     ]
//   }
//
// Step kinds: `call` (a tool), `writeFile` (a file inside the scratch folder),
// `saveProject` (save the scratch project inside the scratch folder — the only
// way a fixture may save), `parallel` (several `call` steps sent at once).
//
// Templates: a string that is exactly "${a.b[0]}" becomes that value with its
// type; "${…}" inside a longer string is interpolated. Names resolve against
// what earlier steps `save`d, plus `scratch` (the folder) and, inside a
// `$repeat`, `i` (from 0) and `n` (from 1).

import fs from "node:fs";
import path from "node:path";
import { checkToolUse, forbiddenJsx } from "./safety.mjs";

export const MATCHERS = ["equals", "type", "exists", "matches", "notMatches", "length", "gte", "lte", "includes", "oneOf"];
const STEP_KINDS = ["call", "writeFile", "saveProject", "parallel"];
const CALL_KEYS = new Set(["call", "args", "save", "expect", "expectError", "timeoutMs", "progress", "label", "note"]);
const FIXTURE_KEYS = new Set(["recipe", "title", "manual", "needsSavedProject", "steps", "note"]);

// ---------------------------------------------------------------------------
// Paths and templates
// ---------------------------------------------------------------------------

/** "a.b[0].c" -> ["a","b",0,"c"]. */
export function parsePath(p) {
  if (p === "" || p === undefined) return [];
  const out = [];
  for (const part of String(p).split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new Error(`Bad path segment "${part}" in "${p}"`);
    if (m[1] !== "") out.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

export function getPath(value, p) {
  let cur = value;
  for (const seg of parsePath(p)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const WHOLE = /^\$\{([^{}]+)\}$/;
const ANY = /\$\{([^{}]+)\}/g;

/** A scope in which every variable is the placeholder 1 — for validating a fixture with nothing run. */
export const PLACEHOLDER = Symbol("placeholder");
/** What `${scratch}` stands for while validating, so a path built on it is known to be inside the scratch folder. */
export const SCRATCH_SENTINEL = "/__live_scratch__";

function lookup(expr, scope) {
  if (scope[PLACEHOLDER]) return expr.trim().split(/[.[]/)[0] === "scratch" ? SCRATCH_SENTINEL : 1;
  const segs = parsePath(expr.trim());
  const [head, ...rest] = segs;
  if (!(head in scope)) throw new Error(`Unknown template variable "${head}" in \${${expr}}`);
  let cur = scope[head];
  for (const seg of rest) {
    if (cur === null || cur === undefined) throw new Error(`\${${expr}}: nothing at "${seg}"`);
    cur = cur[seg];
  }
  if (cur === undefined) throw new Error(`\${${expr}} resolved to undefined`);
  return cur;
}

/**
 * Resolves templates and `$repeat` blocks. `onTemplate(pathArray)` is told the
 * location of every whole-string template — the validator uses it to know which
 * argument values are placeholders.
 */
export function resolve(value, scope, onTemplate, at = []) {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) {
      onTemplate?.(at);
      return lookup(whole[1], scope);
    }
    return value.replace(ANY, (_, e) => {
      const v = lookup(e, scope);
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => resolve(v, scope, onTemplate, [...at, i]));
  if (value && typeof value === "object") {
    if ("$repeat" in value) {
      const n = value.$repeat;
      if (!Number.isInteger(n) || n < 0) throw new Error(`$repeat must be a non-negative integer, got ${n}`);
      const out = [];
      for (let i = 0; i < n; i++) out.push(resolve(value.item, { ...scope, i, n: i + 1 }, onTemplate, [...at, i]));
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, scope, onTemplate, [...at, k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * The value an expectation's `path` reads. Paths starting with `$` read the
 * result envelope rather than the JSON: `$text` (the raw first text block),
 * `$isError`, `$images` (count), `$progress` (notifications received for this
 * call), `$extra` (text blocks after the first).
 */
export function viewOf(result) {
  return {
    $text: result.text,
    $isError: result.isError,
    $images: result.images?.length ?? 0,
    $progress: result.progress ?? 0,
    $extra: result.extra ?? [],
  };
}

function read(result, p) {
  const s = p ?? "";
  if (s.startsWith("$")) {
    const dot = s.search(/[.[]/);
    const head = dot < 0 ? s : s.slice(0, dot);
    const rest = dot < 0 ? "" : s.slice(dot).replace(/^\./, "");
    return getPath(viewOf(result)[head], rest);
  }
  return getPath(result.json, s);
}

const show = (v) => (v === undefined ? "undefined" : JSON.stringify(v)?.slice(0, 300));

/** Checks one expectation; returns null when it holds, or what went wrong. */
export function checkExpectation(exp, result) {
  const v = read(result, exp.path);
  const where = exp.path ? `"${exp.path}"` : "result";
  const asText = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  if ("equals" in exp && !deepEqual(v, exp.equals)) return `${where} is ${show(v)}, expected ${show(exp.equals)}`;
  if ("type" in exp && typeOf(v) !== exp.type) return `${where} is ${typeOf(v)} (${show(v)}), expected ${exp.type}`;
  if ("exists" in exp && (v !== undefined) !== exp.exists)
    return exp.exists ? `${where} is missing` : `${where} should be absent but is ${show(v)}`;
  if ("matches" in exp && !new RegExp(exp.matches, exp.flags ?? "").test(asText))
    return `${where} ${show(v)} does not match /${exp.matches}/`;
  if ("notMatches" in exp && new RegExp(exp.notMatches, exp.flags ?? "").test(asText))
    return `${where} ${show(v)} matches /${exp.notMatches}/, and must not`;
  if ("length" in exp && (v?.length ?? -1) !== exp.length)
    return `${where} has length ${v?.length}, expected ${exp.length}`;
  if ("gte" in exp && !(typeof v === "number" && v >= exp.gte)) return `${where} is ${show(v)}, expected >= ${exp.gte}`;
  if ("lte" in exp && !(typeof v === "number" && v <= exp.lte)) return `${where} is ${show(v)}, expected <= ${exp.lte}`;
  if ("includes" in exp) {
    const ok = Array.isArray(v) ? v.some((x) => deepEqual(x, exp.includes)) : typeof v === "string" && v.includes(exp.includes);
    if (!ok) return `${where} ${show(v)} does not include ${show(exp.includes)}`;
  }
  if ("oneOf" in exp && !exp.oneOf.some((o) => deepEqual(o, v))) return `${where} is ${show(v)}, expected one of ${show(exp.oneOf)}`;
  return null;
}

/** Every failure of a call step's result against its `expect` and `expectError`. */
export function checkCallResult(step, result) {
  const failures = [];
  if (step.expectError) {
    if (!result.isError) failures.push(`expected an error, got success: ${show(result.json ?? result.text)}`);
    else if (typeof step.expectError === "string" && !new RegExp(step.expectError).test(result.text))
      failures.push(`error text does not match /${step.expectError}/: ${result.text.slice(0, 400)}`);
  } else if (result.isError) {
    failures.push(`tool reported an error: ${result.text.slice(0, 800)}`);
    return failures;
  }
  for (const exp of step.expect ?? []) {
    const f = checkExpectation(exp, result);
    if (f) failures.push(f);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Loading and validating
// ---------------------------------------------------------------------------

export function recipeNumbersInDocs(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/^(\d+)\.\s/gm)) out.add(Number(m[1]));
  return out;
}

export function loadFixtures(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { id: f.replace(/\.json$/, ""), file: path.join(dir, f), ...fx };
    });
}

function shapeOf(schema) {
  let cur = schema;
  for (let i = 0; i < 8 && cur; i++) {
    const d = cur._zod?.def;
    if (!d) return null;
    if (d.shape) return d.shape;
    cur = d.innerType ?? d.in ?? d.schema;
  }
  return null;
}

/**
 * Checks a call's tool and arguments against the real op schema. Templated
 * values are placeholders (a whole-string template stands for an id, so `1`),
 * and schema complaints about exactly those locations are ignored; every other
 * complaint — a misspelt key, a wrong literal — is a problem. Unknown keys are
 * caught by name too, because a non-strict schema strips them silently and the
 * live call would then pass while testing nothing.
 */
export function validateCallArgs(tool, args, opSchemas, where, { expectsRejection = false, writtenFiles = new Map(), projectSaved = false, top = true } = {}) {
  const problems = [];
  const schema = opSchemas[tool];
  if (!schema) return [`${where}: no tool named "${tool}" in OpSchemas`];
  const templated = [];
  const dummyScope = { [PLACEHOLDER]: true };
  let resolved;
  try {
    resolved = resolve(args ?? {}, dummyScope, (p) => templated.push(p.join(".")));
  } catch (e) {
    return [`${where}: ${e.message}`];
  }
  const shape = shapeOf(schema);
  if (shape && resolved && typeof resolved === "object") {
    for (const k of Object.keys(resolved)) {
      if (!(k in shape)) problems.push(`${where}: ${tool} has no argument "${k}" (has: ${Object.keys(shape).join(", ")})`);
    }
  }
  // A step that expects an error may send a value the schema refuses on
  // purpose (recipe 26's position:"middle"); its misspelt keys are still caught above.
  const parsed = schema.safeParse(resolved);
  if (!parsed.success && !expectsRejection) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.join(".");
      if (templated.some((t) => t === p || p.startsWith(t + "."))) continue;
      problems.push(`${where}: ${tool} rejects ${p || "args"}: ${issue.message}`);
    }
  }
  if (tool === "run_jsx") {
    const bad = forbiddenJsx(resolved?.code);
    if (bad.length) problems.push(`${where}: run_jsx code does what only the driver may: ${bad.join(", ")}`);
    // A script file is checkable only if this fixture wrote it: scriptPath and
    // libraries must each be exactly "${name}" of an earlier writeFile step,
    // whose content is then checked like inline code.
    const files = [args?.scriptPath, ...(Array.isArray(args?.libraries) ? args.libraries : [])].filter((f) => f !== undefined);
    for (const f of files) {
      const m = typeof f === "string" ? WHOLE.exec(f) : null;
      const name = m?.[1].trim();
      if (!name || !writtenFiles.has(name)) {
        problems.push(`${where}: run_jsx file ${JSON.stringify(f)} must be "\${name}" of a file this fixture writes first, so its code can be checked`);
        continue;
      }
      const badFile = forbiddenJsx(writtenFiles.get(name));
      if (badFile.length) problems.push(`${where}: ${name} does what only the driver may: ${badFile.join(", ")}`);
    }
  }
  if (tool === "run_batch" && Array.isArray(resolved?.ops)) {
    resolved.ops.forEach((o, i) => {
      if (o && typeof o.op === "string") {
        const rawOp = Array.isArray(args.ops) ? args.ops[i] : args.ops?.item;
        problems.push(
          ...validateCallArgs(o.op, rawOp?.args ?? o.args, opSchemas, `${where} ops[${i}]`, { writtenFiles, projectSaved, top: false })
        );
      }
    });
  }
  // Which tools, and where they may write. Checked once, from the top: it walks
  // run_batch steps itself. Only a path built on ${scratch} is known to be
  // inside the scratch folder before the run; the runner checks the real paths.
  if (top) {
    const use = checkToolUse(tool, resolved, (p) => p.startsWith(SCRATCH_SENTINEL + "/"), where);
    problems.push(...use.problems);
    if (use.needsOurProject.length && !projectSaved) {
      problems.push(`${where}: writes beside the open project, so the fixture must saveProject into the scratch folder first`);
    }
  }
  return problems;
}

function validateExpectations(list, where) {
  const problems = [];
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [`${where}: expect must be an array`];
  list.forEach((e, i) => {
    const used = MATCHERS.filter((m) => m in e);
    if (used.length !== 1) problems.push(`${where} expect[${i}]: needs exactly one of ${MATCHERS.join("/")}, has ${used.join(",") || "none"}`);
    for (const k of Object.keys(e)) {
      if (!["path", "flags", ...MATCHERS].includes(k)) problems.push(`${where} expect[${i}]: unknown key "${k}"`);
    }
    try {
      if ("matches" in e) new RegExp(e.matches, e.flags ?? "");
      if ("notMatches" in e) new RegExp(e.notMatches, e.flags ?? "");
      if (e.path) parsePath(e.path.replace(/^\$\w+\.?/, ""));
    } catch (err) {
      problems.push(`${where} expect[${i}]: ${err.message}`);
    }
  });
  return problems;
}

function validateStep(step, i, opSchemas, where, state, nested = false) {
  const problems = [];
  const kinds = STEP_KINDS.filter((k) => k in step);
  const at = `${where} step ${i}`;
  if (kinds.length !== 1) return [`${at}: needs exactly one of ${STEP_KINDS.join("/")}, has ${kinds.join(",") || "none"}`];
  const kind = kinds[0];
  if (kind === "call") {
    for (const k of Object.keys(step)) if (!CALL_KEYS.has(k)) problems.push(`${at}: unknown key "${k}"`);
    problems.push(
      ...validateCallArgs(step.call, step.args, opSchemas, `${at} (${step.call})`, {
        expectsRejection: !!step.expectError,
        writtenFiles: state.writtenFiles,
        projectSaved: state.projectSaved,
      })
    );
    problems.push(...validateExpectations(step.expect, at));
    if (step.expectError !== undefined && typeof step.expectError !== "boolean" && typeof step.expectError !== "string")
      problems.push(`${at}: expectError must be true or a regex string`);
  } else if (kind === "parallel") {
    if (nested) problems.push(`${at}: parallel cannot nest`);
    if (!Array.isArray(step.parallel) || step.parallel.length < 2) problems.push(`${at}: parallel needs two or more call steps`);
    else
      step.parallel.forEach((s, j) => {
        if (!("call" in s)) problems.push(`${at}.${j}: only call steps run in parallel`);
        problems.push(...validateStep(s, `${i}.${j}`, opSchemas, where, state, true));
      });
  } else if (kind === "writeFile") {
    if (typeof step.writeFile !== "string" || path.isAbsolute(step.writeFile) || step.writeFile.split(/[\\/]/).includes(".."))
      problems.push(`${at}: writeFile must be a relative path inside the scratch folder`);
    if (typeof step.content !== "string") problems.push(`${at}: writeFile needs string content`);
    else {
      // Any written file can become a scriptPath or library, so it is held to the same rules.
      const bad = forbiddenJsx(step.content);
      if (bad.length) problems.push(`${at}: writeFile content does what only the driver may: ${bad.join(", ")}`);
      state.writtenFiles.set(step.save ?? "file", step.content);
    }
  } else if (kind === "saveProject") {
    if (typeof step.saveProject !== "string" || !/^[^\\/]+\.aep$/.test(step.saveProject))
      problems.push(`${at}: saveProject must be a bare file name ending .aep`);
    state.projectSaved = true;
  }
  return problems;
}

/** Every problem with one fixture; an empty array means it is runnable. */
export function validateFixture(fx, { opSchemas, recipeNumbers }) {
  const problems = [];
  const where = fx.id ?? "(fixture)";
  for (const k of Object.keys(fx)) if (!FIXTURE_KEYS.has(k) && k !== "id" && k !== "file") problems.push(`${where}: unknown key "${k}"`);
  if (!Number.isInteger(fx.recipe)) problems.push(`${where}: recipe must be the recipe's number`);
  else if (recipeNumbers && !recipeNumbers.has(fx.recipe)) problems.push(`${where}: recipe ${fx.recipe} is not in docs/verification-recipes.md`);
  if (typeof fx.title !== "string" || !fx.title) problems.push(`${where}: needs a title`);
  if (!Array.isArray(fx.steps) || fx.steps.length === 0) problems.push(`${where}: needs steps`);
  else {
    // What earlier steps made, in step order: writeFile name -> content, and whether a project was saved.
    const state = { writtenFiles: new Map(), projectSaved: false };
    fx.steps.forEach((s, i) => problems.push(...validateStep(s, i, opSchemas, where, state)));
  }
  const savesProject = (fx.steps ?? []).some((s) => "saveProject" in s);
  if (fx.needsSavedProject && !savesProject) problems.push(`${where}: needsSavedProject but never saves one`);
  return problems;
}

/** Fixtures selected by the command line: nothing means all; otherwise ids, id prefixes or recipe numbers. */
export function selectFixtures(all, selectors) {
  if (!selectors.length) return all;
  return all.filter((fx) =>
    selectors.some((s) => fx.id === s || fx.id.startsWith(s) || (/^\d+$/.test(s) && fx.recipe === Number(s)))
  );
}
