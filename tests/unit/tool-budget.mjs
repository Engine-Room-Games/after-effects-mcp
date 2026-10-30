// The tool list's size budget (issue #170).
//
// Every tool description and every field `.describe()` is resident in every
// session, re-sent with every request, whether or not the tool is ever called.
// Nothing errors when one grows: the list just gets more expensive, a sentence
// at a time, until it was ~35k tokens. So the prose has a budget per tool, the
// whole emitted list has a ceiling, and both fail the build when crossed.
//
// Raising a number here is allowed — it is a decision, made in review, rather
// than drift. Before raising one, move behaviour detail into an ae_guide topic
// and keep a field's detail on the field, not in the tool description as well.
//
// Also held here, because both are wording the model reads and nothing else
// checks: the ae_guide `topic` description names exactly the topics the enum
// accepts, and no description carries an issue number.
//
//   node tests/unit/tool-budget.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverDist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) => pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { toolInputSchema } = await import(serverDist("server.js"));
const { descriptions } = await import(serverDist("tools", "descriptions.js"));
const { OpSchemas, GUIDE_TOPICS } = await import(sharedDist("schemas.js"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    e.message = `${name}: ${e.message}`;
    throw e;
  }
  passed++;
}

/** Every `description` string anywhere in an emitted JSON Schema. */
function fieldDescriptions(schema) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else walk(v);
    }
  };
  walk(schema);
  return out;
}

// Characters of prose per tool: its description plus every field description
// in its emitted input schema. Most tools fit the default with room to spare;
// the ones listed carry contracts that genuinely need the words.
const DEFAULT_BUDGET = 1500;
const BUDGETS = {
  run_jsx: 3300, // helper signatures are listed in full, by contract
  place_audio_cues: 2600,
  log_issue: 2200,
  run_batch: 2100,
  render_queue: 2000,
  retime_keyframes: 2000,
  copy_animation: 2000,
  get_layer_full: 1900,
  list_known_issues: 1700,
};
// The whole list as a client receives it, name + description + input schema,
// in characters (tokens are roughly a quarter of this).
const TOTAL_BUDGET = 122_000;

const ops = Object.keys(OpSchemas);
const emitted = new Map(ops.map((op) => [op, toolInputSchema(op)]));

check("every tool's prose fits its budget", () => {
  const over = [];
  for (const op of ops) {
    const size = (descriptions[op] ?? "").length + fieldDescriptions(emitted.get(op)).join("").length;
    const budget = BUDGETS[op] ?? DEFAULT_BUDGET;
    if (size > budget) over.push(`${op}: ${size} chars, budget ${budget}`);
  }
  assert.deepEqual(
    over,
    [],
    "Tool prose over budget. Move behaviour detail into an ae_guide topic, keep field detail on the field only, " +
      "or raise the budget in tests/unit/tool-budget.mjs as a deliberate decision:\n  " + over.join("\n  ")
  );
});

check("no budget names a tool that does not exist", () => {
  for (const op of Object.keys(BUDGETS)) assert.ok(OpSchemas[op], `BUDGETS names unknown op ${op}`);
});

check("the whole tool list fits its ceiling", () => {
  let total = 0;
  for (const op of ops) {
    total += JSON.stringify({ name: op, description: descriptions[op] ?? "", inputSchema: emitted.get(op) }).length;
  }
  assert.ok(
    total <= TOTAL_BUDGET,
    `tools/list is ${total} chars (~${Math.round(total / 4)} tokens), over the ${TOTAL_BUDGET} ceiling`
  );
});

check("every op has a description of its own", () => {
  const missing = ops.filter((op) => !descriptions[op]);
  assert.deepEqual(missing, [], "ops served with the `AE op: <name>` fallback");
  const stale = Object.keys(descriptions).filter((op) => !OpSchemas[op]);
  assert.deepEqual(stale, [], "descriptions for ops that do not exist");
});

check("no description carries an issue number", () => {
  const hits = [];
  for (const op of ops) {
    for (const text of [descriptions[op] ?? "", ...fieldDescriptions(emitted.get(op))]) {
      // "issue #93", "issues #93/#94", "(#91)" — not run_jsx's `[CompItem "Main" #12]`, an item id.
      const m = text.match(/issues? #\d+|\(#\d+\)/i);
      if (m) hits.push(`${op}: "${m[0]}"`);
    }
  }
  assert.deepEqual(hits, [], "issue numbers mean nothing to the model reading the tool list");
});

check("ae_guide's topic description names exactly the topics the enum accepts", () => {
  const topic = emitted.get("ae_guide").properties.topic;
  assert.deepEqual([...topic.enum].sort(), [...GUIDE_TOPICS].sort());
  // Each topic is introduced as "name:" at the start of a sentence.
  const named = [...topic.description.matchAll(/(?:^|\. )([a-z][a-z-]*):/g)].map((m) => m[1]);
  assert.deepEqual(
    [...named].sort(),
    [...GUIDE_TOPICS].sort(),
    "the topic description and GUIDE_TOPICS disagree — a topic the model is never told about is one it never reads"
  );
});

console.log(`tool-budget: ${passed} checks passed`);
