// Constraints an agent can see before the call, not after it.
//
// `zod-to-json-schema` drops refinements. So a `.refine()` — "exactly one of
// these three", "not both of these two" — is enforced on the server and
// **invisible** in the JSON Schema the model is shown. The only way an agent
// learns such a rule is by breaking it: a call goes out, comes back rejected,
// and a turn is spent on something the tool definition could have said. Three
// 0.4.0 features landed on that edge independently (`reorder_layer`'s three
// destinations, `screenshot_frame`'s `time`/`times`, `run_jsx`'s
// `code`/`scriptPath`), and two more rules were being enforced further down
// still — `set_temporal_ease` from inside After Effects, `set_effect_param` as
// a bare "Effect param not found".
//
// This is the guard that keeps that from happening again, and it has the same
// shape as the `OpMutation` classification test in write-queue.mjs and the
// field-coverage test in run-jsx-args.mjs: **enumerate, and refuse to be
// silent about what you cannot classify.** A refinement with no declared rule
// fails here. So does one whose rule never reaches the emitted schema, one
// whose JSON Schema form disagrees with the zod form on any combination of its
// own fields, and one no tool description mentions.
//
// The other half is the dialect. The Anthropic API validates tool input
// schemas as draft 2020-12 and rejects what is not valid there — so a wrong
// schema does not break one tool, it breaks every tool in every session. Every
// emitted schema is therefore checked against the real 2020-12 metaschema and
// compiled by a real 2020-12 validator, exactly as it ships, with nothing
// stripped or normalised first.
//
//   node tests/unit/schema-constraints.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const sharedDist = (...p) =>
  pathToFileURL(path.join(root, "packages", "shared", "dist", ...p)).href;

const { toolInputSchema, JSON_SCHEMA_DIALECT } = await import(serverDist("server.js"));
const { descriptions } = await import(serverDist("tools", "descriptions.js"));
const shared = await import(sharedDist("schemas.js"));
const {
  OpSchemas,
  ARRAY_ELEMENT,
  crossFieldRulesIn,
  crossFieldJsonSchema,
  crossFieldMessage,
  crossFieldSatisfied,
} = shared;

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
};

const opNames = Object.keys(OpSchemas);

// ---------------------------------------------------------------------------
// 1. Every emitted schema is valid draft 2020-12 — the thing that breaks
//    everything at once if it is wrong.
// ---------------------------------------------------------------------------

// strict:false is ajv's own lint switch, not a spec relaxation. It objects to
// `type: ["string","number"]` (PropertyPath's segments), which is perfectly
// valid JSON Schema and simply something ajv wants opted into. The metaschema
// check below is the one that speaks for the spec.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const metaschema = ajv.getSchema(JSON_SCHEMA_DIALECT);

check("the validator really has the 2020-12 metaschema", () => {
  assert.ok(
    metaschema,
    `ajv could not resolve ${JSON_SCHEMA_DIALECT}. Without it this file proves nothing — ` +
      "it would be checking the schemas against no dialect at all."
  );
});

const emitted = new Map();
for (const name of opNames) emitted.set(name, toolInputSchema(name));

check(`all ${opNames.length} tool schemas exist and are objects`, () => {
  assert.equal(emitted.size, opNames.length);
  for (const [name, schema] of emitted) {
    assert.equal(schema.type, "object", `${name} must emit type:"object" — the API requires it`);
  }
});

check("every tool schema declares the dialect it actually is", () => {
  // zod-to-json-schema stamps draft-07, which after the tuple rewrite is a
  // false claim: `prefixItems` does not exist there, and `items:false` means
  // "no array items at all" — so a consumer honouring the declared dialect
  // would reject every colour and every 2D point in this API. It works today
  // only because tool schemas are read as 2020-12 regardless of what they say.
  for (const [name, schema] of emitted) {
    if (!("$schema" in schema)) continue;
    assert.equal(
      schema.$schema,
      JSON_SCHEMA_DIALECT,
      `${name} declares ${schema.$schema}, which is not the dialect it is written in`
    );
  }
});

check("every tool schema validates against the 2020-12 metaschema", () => {
  const bad = [];
  for (const [name, schema] of emitted) {
    if (!metaschema(schema)) {
      bad.push(`${name}: ${JSON.stringify(metaschema.errors?.slice(0, 3))}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "Schemas that are not valid draft 2020-12:\n" +
      bad.join("\n") +
      "\n\nThe Anthropic API rejects a tool schema it cannot read, and a rejected schema " +
      "takes down every tool in the session, not just this one."
  );
});

check("every tool schema compiles in a real 2020-12 validator", () => {
  // Metaschema-valid is not the same statement as usable: a `$ref` that does
  // not resolve, or a keyword combination ajv refuses, only shows up here.
  const bad = [];
  for (const [name, schema] of emitted) {
    try {
      new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    } catch (e) {
      bad.push(`${name}: ${e.message}`);
    }
  }
  assert.deepEqual(bad, [], "Schemas a 2020-12 validator refused to compile:\n" + bad.join("\n"));
});

check("the tuple rewrite still enforces arity", () => {
  // The one property the draft-07 → 2020-12 pass exists for. If `prefixItems`
  // were dropped or `items` left as an array, a colour of the wrong length
  // would sail through — and nothing else in this suite would notice.
  const validate = new Ajv2020({ strict: false }).compile(emitted.get("create_comp"));
  assert.equal(validate({ bgColor: [0, 0, 0] }), true, "a 3-tuple must be accepted");
  assert.equal(validate({ bgColor: [0, 0] }), false, "a short tuple must be rejected");
  assert.equal(validate({ bgColor: [0, 0, 0, 0] }), false, "a long tuple must be rejected");
});

// ---------------------------------------------------------------------------
// 2. Every refinement is a declared rule. This is the part that fails loudly
//    rather than skipping: a refinement this file cannot classify is exactly
//    the constraint it exists to catch.
// ---------------------------------------------------------------------------

/** [{ op, path, rule }] for every ZodEffects in every op schema. */
const located = [];
for (const name of opNames) {
  for (const found of crossFieldRulesIn(OpSchemas[name])) {
    located.push({ op: name, path: found.path, rule: found.rule });
  }
}

check("no op carries a refinement that is not a declared cross-field rule", () => {
  const unclassified = located.filter((l) => !l.rule).map((l) => `${l.op} at ${l.path.join(".") || "(root)"}`);
  assert.deepEqual(
    unclassified,
    [],
    `Undeclared refinement(s): ${unclassified.join(", ")}\n\n` +
      "zod-to-json-schema drops refinements, so this rule is enforced by the server and\n" +
      "invisible in the schema the model is shown. The agent can only learn it by having a\n" +
      "call rejected — which is a wasted turn on every session that hits it.\n\n" +
      "Declare it with crossField() in packages/shared/src/schemas.ts. If the rule genuinely\n" +
      "cannot be expressed as exactlyOne / atMostOne / atLeastOne, add the vocabulary rather\n" +
      "than removing the check: not being able to classify a constraint is the same as knowing\n" +
      "it does not reach the agent."
  );
});

check("an undeclared refinement degrades the tool, never the session", () => {
  // The build is where this is refused (the check above). At runtime the
  // emission has to fail towards what shipped before — `tools/list` is the call
  // every session begins with, and throwing there would replace one
  // under-specified tool with no tools at all. Same reasoning as `isWriteOp()`
  // falling back to "write" rather than raising on an unclassified op.
  const original = OpSchemas.get_comp;
  // The warning below is the point of the case, so say so — otherwise it reads
  // as a real problem in the CI log of an otherwise green run.
  const restore = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    OpSchemas.get_comp = original.refine(() => true, { message: "invisible" });
    const schema = toolInputSchema("get_comp");
    assert.ok(
      logged.some((line) => line.includes("get_comp") && line.includes("crossField")),
      "an undeclared refinement has to say so in the log, or it is invisible twice over"
    );
    assert.equal(schema.type, "object", "the tool must still get a usable schema");
    assert.ok(schema.properties?.compId, "and it must still describe its fields");
  } finally {
    console.error = restore;
    OpSchemas.get_comp = original;
  }
});

const rules = located.filter((l) => l.rule);

check("there is at least one declared rule, so the rest of this file means something", () => {
  assert.ok(rules.length >= 5, `expected the known constrained ops, found ${rules.length}`);
});

check("every rule is well formed", () => {
  for (const { op, rule } of rules) {
    assert.ok(
      ["exactlyOne", "atMostOne", "atLeastOne"].includes(rule.kind),
      `${op}: unknown rule kind ${JSON.stringify(rule.kind)}`
    );
    assert.ok(rule.fields.length >= 2, `${op}: a cross-field rule needs at least two fields`);
    assert.equal(new Set(rule.fields).size, rule.fields.length, `${op}: duplicate field in rule`);
  }
});

/** Walk to the schema node a rule's path names, in either tree. */
const nodeAt = (schema, rulePath) => {
  let node = schema;
  for (const step of rulePath) {
    node = step === ARRAY_ELEMENT ? node?.items : node?.properties?.[step];
    if (!node) return undefined;
  }
  return node;
};

check("every rule names fields the schema actually declares", () => {
  for (const { op, path: rulePath, rule } of rules) {
    const node = nodeAt(emitted.get(op), rulePath);
    assert.ok(node, `${op}: rule at ${rulePath.join(".")} has no node in the emitted schema`);
    for (const field of rule.fields) {
      assert.ok(
        node.properties && field in node.properties,
        `${op}: rule names \`${field}\`, which the schema does not declare — a rule about a ` +
          "field that no longer exists is a rule nothing can satisfy"
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Every rule reaches the emitted schema, and means there what it means in zod.
// ---------------------------------------------------------------------------

check("every rule's keywords are present in the emitted schema", () => {
  for (const { op, path: rulePath, rule } of rules) {
    const node = nodeAt(emitted.get(op), rulePath);
    const fragment = crossFieldJsonSchema(rule);
    const inline = Object.keys(fragment).every(
      (k) => JSON.stringify(node[k]) === JSON.stringify(fragment[k])
    );
    const composed =
      Array.isArray(node.allOf) &&
      node.allOf.some((branch) => JSON.stringify(branch) === JSON.stringify(fragment));
    assert.ok(
      inline || composed,
      `${op}: the cross-field rule at ${rulePath.join(".") || "(root)"} is enforced by zod and ` +
        "absent from the emitted JSON Schema, so the model never sees it.\n" +
        `expected ${JSON.stringify(fragment)}`
    );
  }
});

check("the JSON Schema form and the zod form agree on every combination", () => {
  // The property that makes injection safe: for a rule over N fields there are
  // 2^N ways to pass them, and both enforcers must accept and reject exactly
  // the same ones. A `oneOf` that is subtly stricter than the refine would
  // advertise a call the server accepts as illegal; one that is looser is the
  // status quo this change exists to end.
  //
  // Only root-level rules can be probed this way — an argument object is what
  // a validator is handed — which is every rule that exists today. A rule
  // nested inside an array would need its own probe and the assertion below
  // makes that a failure rather than an omission.
  const nested = rules.filter((r) => r.path.length > 0);
  assert.deepEqual(
    nested.map((r) => `${r.op}:${r.path.join(".")}`),
    [],
    "A cross-field rule now sits below the root and this probe cannot reach it. Extend the " +
      "probe to build a payload around it; do not narrow the check."
  );

  /** A value the schema will accept for a field, so only the rule is under test. */
  const sampleFor = (op, node) => {
    if (!node || typeof node !== "object") {
      throw new Error(`${op}: no schema node to build a sample value from`);
    }
    if (Array.isArray(node.enum)) return node.enum[0];
    if ("const" in node) return node.const;
    if (Array.isArray(node.anyOf)) return sampleFor(op, node.anyOf[0]);
    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    switch (type) {
      case "string":
        return "sample";
      case "number":
      case "integer":
        // Clears `exclusiveMinimum: 0` / `minimum: 1` wherever those appear.
        return typeof node.maximum === "number" ? Math.min(2, node.maximum) : 2;
      case "boolean":
        return true;
      case "object": {
        const out = {};
        for (const key of node.required ?? []) out[key] = sampleFor(op, node.properties?.[key]);
        return out;
      }
      case "array": {
        if (Array.isArray(node.prefixItems)) return node.prefixItems.map((n) => sampleFor(op, n));
        const n = Math.max(node.minItems ?? 1, 1);
        return Array.from({ length: n }, () => sampleFor(op, node.items));
      }
      default:
        // Never guess. A type this cannot build is a field the probe would
        // silently leave out, and then the payload fails for the wrong reason
        // and the comparison below passes by accident.
        throw new Error(
          `${op}: tests/unit/schema-constraints.mjs cannot build a sample value for ` +
            `${JSON.stringify(node).slice(0, 120)}. Teach sampleFor() that shape — skipping it ` +
            "would make this comparison meaningless rather than merely incomplete."
        );
    }
  };

  for (const { op, rule } of rules) {
    const schema = emitted.get(op);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const zodSchema = OpSchemas[op];

    // Everything the schema requires that is not part of the rule, so the only
    // thing varying between probes is the rule's own fields.
    const base = {};
    for (const key of schema.required ?? []) {
      if (rule.fields.includes(key)) continue;
      base[key] = sampleFor(op, schema.properties[key]);
    }

    for (let mask = 0; mask < 1 << rule.fields.length; mask++) {
      const payload = { ...base };
      const present = [];
      rule.fields.forEach((field, i) => {
        if (!(mask & (1 << i))) return;
        payload[field] = sampleFor(op, schema.properties[field]);
        present.push(field);
      });

      const bySchema = validate(payload);
      const byZod = zodSchema.safeParse(payload).success;
      assert.equal(
        bySchema,
        byZod,
        `${op} with {${present.join(", ") || "none of the rule's fields"}}: the emitted JSON ` +
          `Schema says ${bySchema ? "valid" : "invalid"} and zod says ${byZod ? "valid" : "invalid"}. ` +
          "The two have to agree exactly — a schema stricter than the server advertises calls as " +
          "illegal that would have worked, and one looser is the invisible constraint this file " +
          "exists to prevent.\n" +
          `payload: ${JSON.stringify(payload)}\n` +
          `ajv: ${JSON.stringify(validate.errors?.slice(0, 2))}`
      );
      // And the rule is the *reason*, not a coincidence of some other keyword.
      assert.equal(
        byZod,
        crossFieldSatisfied(rule, payload),
        `${op}: zod's verdict on {${present.join(", ")}} does not match the declared rule`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The description says it too. Belt and braces on purpose: the schema
//    keyword is machine-readable, the sentence is what a model actually reads,
//    and a converter or a client can drop the first but never the second.
// ---------------------------------------------------------------------------

const PHRASES = {
  exactlyOne: ["exactly one"],
  atLeastOne: ["at least one"],
  atMostOne: ["mutually exclusive", "not both", "at most one"],
};

check("every rule is stated in its tool description", () => {
  for (const { op, rule } of rules) {
    const text = descriptions[op];
    assert.ok(text, `${op} has no description at all`);
    const lower = text.toLowerCase();

    const missing = rule.fields.filter((f) => !text.includes(f));
    assert.deepEqual(
      missing,
      [],
      `${op}'s description does not name ${missing.join(", ")}, which the rule is about.\n` +
        "A field the description never mentions is one the model has to infer the role of."
    );

    assert.ok(
      PHRASES[rule.kind].some((p) => lower.includes(p)),
      `${op}'s description never says the rule out loud. It is a "${rule.kind}" over ` +
        `${rule.fields.join("/")}, so it needs one of: ${PHRASES[rule.kind].join(", ")}.\n\n` +
        "The JSON Schema keyword carries this too, but the description is the carrier that\n" +
        "reaches every client and every model and cannot be dropped by a converter."
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The message when it is broken anyway. An agent can only correct a failure
//    it is told about — so the fields have to be named, and passing none has
//    to read differently from passing two.
// ---------------------------------------------------------------------------

check("the runtime message names the fields and says what to do", () => {
  for (const { op, rule } of rules) {
    const none = crossFieldMessage(rule, []);
    const several = crossFieldMessage(rule, rule.fields.slice(0, 2));
    for (const [label, message] of [["none", none], ["several", several]]) {
      for (const field of rule.fields) {
        assert.ok(
          message.includes(field),
          `${op} (${label} present): the message does not name \`${field}\`:\n${message}`
        );
      }
    }
    assert.notEqual(
      none,
      several,
      `${op}: passing none and passing two produce the same sentence, so the agent cannot tell ` +
        "which mistake it made and the obvious next move is to re-send the same call"
    );
    assert.ok(
      /drop/i.test(several),
      `${op}: the too-many message has to say what to remove, not only that it is wrong:\n${several}`
    );
  }
});

check("a rejected call reads as prose, not as a zod dump", () => {
  const { invalidArgsText } = require(path.join(root, "packages", "mcp-server", "dist", "util", "errors.js"));
  let err;
  try {
    OpSchemas.reorder_layer.parse({ compId: 1, layerId: 2, toIndex: 1, beforeLayerId: 3 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "reorder_layer with two destinations must be rejected");
  const text = invalidArgsText("reorder_layer", err);
  assert.ok(text.includes("toIndex") && text.includes("beforeLayerId"), text);
  assert.ok(!text.includes('"code":'), `the raw zod issue objects leaked into the message:\n${text}`);
  assert.ok(!text.includes("[\n"), `the message is still a JSON array:\n${text}`);

  // A non-zod error has to survive untouched — this must never swallow one.
  assert.equal(
    invalidArgsText("run_jsx", new Error("boom")),
    "Invalid arguments for run_jsx: boom"
  );
});

// ---------------------------------------------------------------------------
// 6. The known set, named. The enumeration above is what keeps this file
//    honest; this is what makes a deletion show up as a deletion.
// ---------------------------------------------------------------------------

check("the ops known to carry a cross-field rule still carry one", () => {
  const byOp = Object.fromEntries(rules.map((r) => [r.op, r.rule]));
  const expected = {
    reorder_layer: "exactlyOne",
    screenshot_frame: "atMostOne",
    run_jsx: "exactlyOne",
    set_temporal_ease: "atLeastOne",
    set_effect_param: "atLeastOne",
  };
  for (const [op, kind] of Object.entries(expected)) {
    assert.ok(byOp[op], `${op} lost its cross-field rule`);
    assert.equal(byOp[op].kind, kind, `${op} changed rule kind`);
  }
});

console.log(
  `schema-constraints: ${passed} checks passed ` +
    `(${emitted.size} schemas valid draft 2020-12, ${rules.length} cross-field rules surfaced)`
);
