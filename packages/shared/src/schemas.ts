import { z } from "zod";

/**
 * Single source of truth for op input contracts. The MCP server uses these as
 * tool input schemas (via `z.toJSONSchema`). The ExtendScript side validates
 * loosely — it trusts that the MCP server already validated.
 */

// ---------- primitives ----------
export const Color = z.tuple([z.number(), z.number(), z.number()]).describe("RGB 0..1");
export const ColorRGBA = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Vec2 = z.tuple([z.number(), z.number()]);
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const VecAny = z.union([z.number(), Vec2, Vec3, z.array(z.number())]);

/**
 * A closed set of names, matched without regard to case and forwarded in the
 * canonical spelling (issue #150). The emitted schema is a plain `enum`, so the
 * model sees every accepted value, and `Multiply` reaches the handler as
 * `MULTIPLY` instead of missing After Effects' enumeration and changing nothing.
 */
export function namedEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  aliases: Record<string, T[number]> = {}
) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const key = v.trim().toLowerCase();
    const hit = values.find((x) => x.toLowerCase() === key);
    if (hit) return hit;
    const alias = Object.keys(aliases).find((a) => a.toLowerCase() === key);
    return alias ? aliases[alias] : v;
  }, z.enum(values));
}

/** Adobe spells it SILHOUETE_ALPHA (one T); the English spelling is accepted and forwarded as AE's. */
export const BLENDING_MODE_ALIASES = { SILHOUETTE_ALPHA: "SILHOUETE_ALPHA" } as const;

// Keys into After Effects' own enumerations. The .jsx looks each one up by name
// and refuses a miss rather than leaving the layer as it was, so a name here
// that some AE build does not define is an error, never a silent no-op.
export const BLENDING_MODES = [
  "NORMAL", "DISSOLVE", "DANCING_DISSOLVE",
  "DARKEN", "MULTIPLY", "COLOR_BURN", "CLASSIC_COLOR_BURN", "LINEAR_BURN", "DARKER_COLOR",
  "ADD", "LIGHTEN", "SCREEN", "COLOR_DODGE", "CLASSIC_COLOR_DODGE", "LINEAR_DODGE", "LIGHTER_COLOR",
  "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "LINEAR_LIGHT", "VIVID_LIGHT", "PIN_LIGHT", "HARD_MIX",
  "DIFFERENCE", "CLASSIC_DIFFERENCE", "EXCLUSION", "SUBTRACT", "DIVIDE",
  "HUE", "SATURATION", "COLOR", "LUMINOSITY",
  "STENCIL_ALPHA", "STENCIL_LUMA", "SILHOUETE_ALPHA", "SILHOUETTE_LUMA",
  "ALPHA_ADD", "LUMINESCENT_PREMUL",
] as const;
export const TRACK_MATTE_TYPES = ["NO_TRACK_MATTE", "ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"] as const;
export const MASK_MODES = ["ADD", "NONE", "SUBTRACT", "INTERSECT", "LIGHTEN", "DARKEN", "DIFFERENCE"] as const;

export const PropertyPath = z
  .array(z.union([z.string(), z.number()]))
  .min(1)
  .describe("Dotted property path into a layer, e.g. ['Transform','Position'] or ['Effects','Gaussian Blur','Blurriness'].");

export const Interpolation = z.object({
  in: z.enum(["linear", "bezier", "hold"]).optional(),
  out: z.enum(["linear", "bezier", "hold"]).optional(),
  easeIn: z.object({ influence: z.number(), speed: z.number() }).optional(),
  easeOut: z.object({ influence: z.number(), speed: z.number() }).optional(),
});

/**
 * The scoping vocabulary shared by the read tools. Every one of them names the
 * optional sections of its own response; omitting `include` returns all of them,
 * which is what every caller written before this existed already gets. `[]`
 * returns the identifying core alone — the cheapest useful answer.
 */
const includeParam = <T extends [string, ...string[]]>(sections: T, hint: string) =>
  z
    .array(z.enum(sections))
    .optional()
    .describe(`Sections to return: ${sections.join(", ")}. Omit for all of them; [] for ${hint}.`);

// ---------- cross-field rules ----------
/**
 * The rules about which *combinations* of fields are legal — "exactly one of
 * these three", "at least one of these two".
 *
 * **The JSON Schema conversion drops refinements.** A `.refine()` is invisible in the
 * JSON Schema the model is shown, so the only way an agent learns the rule is
 * by breaking it: the call goes out, the server rejects it, and a turn is spent
 * on something the tool definition could have said up front. Three separate
 * 0.4.0 features landed on that edge independently (`reorder_layer`'s three
 * destinations, `screenshot_frame`'s `time`/`times`, `run_jsx`'s
 * `code`/`scriptPath`), and two more rules were being enforced further down
 * still — `set_temporal_ease` inside After Effects, `set_effect_param` as a
 * bare "Effect param not found".
 *
 * So a rule is **declared once, here**, and three things are generated from
 * that single declaration:
 *
 *   1. the zod check that rejects the call (`crossField`, below),
 *   2. the JSON Schema keywords the model sees before it calls
 *      (`crossFieldJsonSchema`, applied in `server.ts`'s emission pass),
 *   3. the sentence in the error when it is broken anyway
 *      (`crossFieldMessage`).
 *
 * Declaring it in one place is the point. A rule enforced in zod and described
 * in prose somewhere else is two statements that drift; the drift is invisible,
 * because the schema keeps working and only the *advice* goes stale.
 *
 * `tests/unit/schema-constraints.mjs` enumerates every refinement in every op
 * schema and fails on any that is not one of these — a refinement it cannot
 * classify is the exact thing it exists to catch, so it throws rather than
 * skipping.
 */
export type CrossFieldKind =
  /** Exactly one field present. Neither zero nor two. */
  | "exactlyOne"
  /** Zero or one. Both together are two readings of the same question. */
  | "atMostOne"
  /** One or more. Zero means the call would do nothing. */
  | "atLeastOne"
  /**
   * When the first field is `true`, every other field is required too.
   * `keyframe: true` with no `time` has no keyframe to write (issue #151);
   * `keyframe: false` or absent asks for nothing, so needs nothing.
   */
  | "whenTrue";

export interface CrossFieldRule {
  kind: CrossFieldKind;
  /** At least two — a rule about one field is just `.optional()` or not. */
  fields: readonly [string, string, ...string[]];
  /**
   * Appended to the error. Say what to pass *instead*, not what went wrong —
   * the rest of the message already covers that.
   */
  then?: string;
}

/** Where `crossField` stashes the rule so the emission pass can find it again. */
export const CROSS_FIELD_RULE = Symbol.for("engineRoom.aeMcp.crossFieldRule");

const backticked = (fields: readonly string[]) => fields.map((f) => "`" + f + "`");

const joinWith = (parts: readonly string[], conjunction: string) => {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} ${conjunction} ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} ${conjunction} ${parts[parts.length - 1]}`;
};

/**
 * The sentence an agent gets when it breaks the rule.
 *
 * It has to do two things a raw zod dump does not: name **which** fields
 * arrived, and say what to do next. "Pass exactly one of a, b or c" is the same
 * sentence whether you passed none or all three, and an agent that cannot tell
 * those apart re-sends the same mistake.
 */
export function crossFieldMessage(rule: CrossFieldRule, present: readonly string[]): string {
  if (rule.kind === "whenTrue") {
    const [trigger, ...needed] = rule.fields;
    const missing = needed.filter((f) => !present.includes(f));
    const listed = missing.length ? missing : needed;
    return (
      `\`${trigger}: true\` requires ${joinWith(backticked(needed), "and")}` +
      ` — ${joinWith(backticked(listed), "and")} ${listed.length === 1 ? "was" : "were"} not passed.` +
      ` Pass ${joinWith(backticked(listed), "and")}, or drop \`${trigger}\` to set a static value.` +
      (rule.then ? " " + rule.then : "")
    );
  }
  const want = joinWith(backticked(rule.fields), "or");
  const got = joinWith(backticked(present), "and");
  const head =
    rule.kind === "exactlyOne"
      ? `Pass exactly one of ${want}`
      : rule.kind === "atLeastOne"
        ? `Pass at least one of ${want}`
        : `Pass at most one of ${want}`;
  const body =
    present.length === 0
      ? rule.fields.length === 2
        ? " — neither was passed."
        : " — none of them was passed."
      : ` — got ${got}. Keep the one you meant and drop ${present.length === 2 ? "the other" : "the others"}.`;
  return head + body + (rule.then ? " " + rule.then : "");
}

/** Which of the rule's fields the caller actually sent. */
export function crossFieldPresent(rule: CrossFieldRule, value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  return rule.fields.filter((f) => obj[f] !== undefined);
}

export function crossFieldSatisfied(rule: CrossFieldRule, value: unknown): boolean {
  if (rule.kind === "whenTrue") {
    const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (obj[rule.fields[0]] !== true) return true;
    return rule.fields.slice(1).every((f) => obj[f] !== undefined);
  }
  const n = crossFieldPresent(rule, value).length;
  if (rule.kind === "exactlyOne") return n === 1;
  if (rule.kind === "atLeastOne") return n >= 1;
  return n <= 1;
}

/**
 * The JSON Schema form of a rule, in draft 2020-12 and nothing else.
 *
 * All three shapes are plain composition over `required`, which is the oldest
 * and most portable part of JSON Schema — no `if`/`then`, no `dependentRequired`,
 * nothing a converter or a client is likely to have skipped. `oneOf` means
 * exactly one subschema matches, and a subschema that only says
 * `{"required": ["x"]}` matches precisely when `x` is present, so `oneOf` over
 * one-element `required` lists *is* exclusive choice.
 *
 * Nothing here narrows what was already legal in a way the zod check does not:
 * `tests/unit/schema-constraints.mjs` probes every combination of the rule's
 * fields against both and fails if the two disagree on a single one.
 */
export function crossFieldJsonSchema(rule: CrossFieldRule): Record<string, unknown> {
  const each = rule.fields.map((f) => ({ required: [f] }));
  if (rule.kind === "exactlyOne") return { oneOf: each };
  if (rule.kind === "atLeastOne") return { anyOf: each };
  if (rule.kind === "whenTrue") {
    // "Either the trigger is not `true`, or the rest are all there." Written
    // as `anyOf` over a negation rather than `if`/`then`, for the same
    // portability reason as the other three shapes.
    const [trigger, ...needed] = rule.fields;
    return {
      anyOf: [
        { not: { required: [trigger], properties: { [trigger]: { const: true } } } },
        { required: needed },
      ],
    };
  }
  // "at most one" is the absence of every pair. Written as a negated `anyOf`
  // rather than as `oneOf` + an all-absent branch, because the negation is what
  // the rule actually says and reads that way to anything parsing it.
  const pairs: { required: string[] }[] = [];
  for (let i = 0; i < rule.fields.length; i++) {
    for (let j = i + 1; j < rule.fields.length; j++) {
      pairs.push({ required: [rule.fields[i], rule.fields[j]] });
    }
  }
  return { not: pairs.length === 1 ? pairs[0] : { anyOf: pairs } };
}

/**
 * Attach a rule to an object schema.
 *
 * In zod 4 a refinement is a check on the schema itself rather than a wrapper
 * around it, so the result is still a `ZodObject` with a `.shape`. The rule is
 * stashed on the check, not on the schema: a schema can carry several checks,
 * and each has to be classifiable on its own.
 */
function crossField<T extends z.ZodType>(schema: T, rule: CrossFieldRule): T {
  const refined = schema.superRefine((value, ctx) => {
    if (crossFieldSatisfied(rule, value)) return;
    ctx.addIssue({
      code: "custom",
      message: crossFieldMessage(rule, crossFieldPresent(rule, value)),
      // The first field of the rule, so the issue has somewhere to point. The
      // message names all of them, which is the part that matters.
      path: [rule.fields[0]],
    });
  }) as T;
  const checks = (refined as unknown as { _zod: { def: { checks?: unknown[] } } })._zod.def.checks ?? [];
  Object.defineProperty(checks[checks.length - 1], CROSS_FIELD_RULE, { value: rule, enumerable: false });
  return refined;
}

/** The rule attached to a refinement check by `crossField`, if it carries one. */
export function crossFieldRuleOf(check: unknown): CrossFieldRule | undefined {
  if (!check || typeof check !== "object") return undefined;
  return (check as Record<symbol, CrossFieldRule | undefined>)[CROSS_FIELD_RULE];
}

/**
 * Where a rule sits inside a schema. `[]` is "into this array's element", so
 * `["cues", "[]"]` is the object inside `cues: z.array(...)`. An empty path is
 * the op's own arguments object.
 */
export const ARRAY_ELEMENT = "[]";

interface ZodNodeDef {
  type?: string;
  checks?: { _zod?: { def?: { check?: string } } }[];
  [k: string]: unknown;
}

/**
 * Every refinement in a schema, located.
 *
 * **A refinement with no rule on it is returned with `rule: undefined`**, and
 * that is the whole reason this returns a list rather than a map. The emission
 * pass and the guard test both need to see an unclassified refinement — one
 * is a constraint that will not reach the model, and silently walking past it
 * is the failure both of them exist to catch.
 *
 * A refinement is a `custom` check in the node's `checks` (zod 4). Size and
 * range checks (`.min()`, `.max()`) are other check kinds, and the JSON Schema
 * converter represents those, so they are not listed. A `.transform()` is a
 * `pipe`, walked through its input side — the side a caller fills in.
 */
export function crossFieldRulesIn(
  schema: unknown
): { path: string[]; rule: CrossFieldRule | undefined }[] {
  const found: { path: string[]; rule: CrossFieldRule | undefined }[] = [];
  const walk = (node: unknown, path: string[], depth: number): void => {
    const def = (node as { _zod?: { def?: ZodNodeDef } } | undefined)?._zod?.def;
    if (!def || depth > 16) return;
    for (const check of def.checks ?? []) {
      if (check?._zod?.def?.check === "custom") found.push({ path: [...path], rule: crossFieldRuleOf(check) });
    }
    switch (def.type) {
      case "optional":
      case "default":
      case "prefault":
      case "nullable":
      case "readonly":
      case "nonoptional":
        return walk(def.innerType, path, depth + 1);
      case "pipe":
        return walk(def.in, path, depth + 1);
      case "object": {
        const shape = def.shape as Record<string, unknown>;
        for (const key of Object.keys(shape)) walk(shape[key], [...path, key], depth + 1);
        return;
      }
      case "array":
        return walk(def.element, [...path, ARRAY_ELEMENT], depth + 1);
      case "union": {
        // Union branches share one JSON Schema location, so a rule inside one
        // has nowhere unambiguous to be injected. None exists today; the walk
        // still descends so the guard test can refuse one that appears.
        for (const opt of def.options as unknown[]) walk(opt, path, depth + 1);
        return;
      }
      default:
        return;
    }
  };
  walk(schema, [], 0);
  return found;
}

/**
 * The object shape of an op schema. Under zod 3 a cross-field rule wrapped the
 * object in a `ZodEffects` with no `.shape`; zod 4 keeps the object, so this is
 * now a plain read. Kept so callers need not know which schemas carry a rule.
 */
export function objectShapeOf(schema: unknown): Record<string, z.ZodType> | undefined {
  return (schema as { shape?: Record<string, z.ZodType> } | undefined)?.shape;
}

// ---------- comps ----------
export const ListComps = z
  .object({
    include: includeParam(["size", "timing", "bg", "counts"], "id + name only"),
  })
  .strict();
export const GetComp = z.object({ compId: z.number() });
export const GetCompTree = z.object({ compId: z.number(), depth: z.number().int().min(0).max(8).optional().meta({ default: 2 }) });
export const CreateComp = z.object({
  name: z.string().default("Untitled"),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  frameRate: z.number().positive().default(30),
  duration: z.number().positive().default(5),
  pixelAspect: z.number().positive().optional().meta({ default: 1 }),
  bgColor: Color.optional(),
});
export const SetComp = z.object({
  compId: z.number(),
  name: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  duration: z.number().positive().optional(),
  workAreaStart: z.number().optional(),
  workAreaDuration: z.number().positive().optional(),
  bgColor: Color.optional(),
});
export const DeleteComp = z
  .object({
    compId: z.number(),
    purgeUnusedSolids: z.boolean().optional().meta({ default: false })
      .describe(
        "Also remove the solid footage items this comp's own layers used, once nothing else uses them. Off by default because a solid can be shared: one another comp still uses is kept and reported with the comps using it."
      ),
    force: z.boolean().optional().meta({ default: false })
      .describe(
        "Delete the comp even though other comps nest it. After Effects removes every precomp layer that uses this comp along with it; the result lists them in removedFromComps. Without it, a nested comp is refused and the nesting comps are named."
      ),
  })
  .strict();
export const SetActiveComp = z.object({ compId: z.number() });
export const DuplicateComp = z
  .object({
    compId: z.number(),
    name: z.string().optional().describe("Name for the copy. Omit to take AE's own ('<name> 2')."),
    folderId: z.number().optional()
      .describe("Project folder to put the copy in. Must be a folder item id from get_project_summary."),
    deep: z.boolean().optional().meta({ default: false })
      .describe(
        "Also duplicate the nested precomps and re-point the copy's layers at them. Off by default, which matches AE's own Duplicate: a shallow copy shares its nested comps with the original, so editing one edits both."
      ),
    nameSuffix: z.string().optional()
      .describe("With deep:true, name each duplicated nested comp '<original><nameSuffix>'. Omit to let AE name them."),
  })
  .strict();

// ---------- comp checkpoints (issue #136) ----------
// A way back that does not depend on AE's undo stack. A checkpoint is a copy of
// the comp kept in the project; revert_comp restores it INTO the original comp,
// so the comp id never changes. See packages/jsx/checkpoint.jsx.
export const CheckpointComp = z
  .object({
    compId: z.number(),
    label: z.string().min(1).optional()
      .describe("A short name for this restore point, e.g. 'before easing pass'. Omit for '#1', '#2', ..."),
  })
  .strict();
export const ListCheckpoints = z
  .object({
    compId: z.number().optional()
      .describe("Only the checkpoints of this comp. Omit to list every checkpoint in the project."),
  })
  .strict();
export const RevertComp = z
  .object({
    checkpointId: z.number().describe("The checkpointId from checkpoint_comp or list_checkpoints - not the comp's own id."),
    compId: z.number().optional()
      .describe("The comp being reverted. Optional - the checkpoint knows which comp it belongs to. Pass it to confirm a comp that was renamed since the checkpoint, or to name the same comp under a new id after its project was imported (it must then carry the recorded name, and the checkpoint is re-bound to it)."),
    saveCurrent: z.boolean().optional().meta({ default: false })
      .describe("Checkpoint the comp's current state first, so the revert itself can be reverted. Its id comes back in savedCheckpoint."),
    keepCheckpoint: z.boolean().optional().meta({ default: true })
      .describe("Keep the checkpoint after reverting to it. Pass false to delete it - only done when the revert verified clean."),
  })
  .strict();
export const DeleteCheckpoints = crossField(
  z.object({
    checkpointIds: z.array(z.number()).min(1).optional()
      .describe("The checkpoints to delete. Every id is checked first; one that is not a checkpoint deletes nothing."),
    compId: z.number().optional()
      .describe("Delete every checkpoint of this comp."),
  }),
  { kind: "exactlyOne", fields: ["checkpointIds", "compId"] },
).strict();

// ---------- comp snapshots (half server-resident: the panel gathers, the server remembers) ----------
export const SnapshotComp = z
  .object({
    compId: z.number(),
    includeFingerprint: z.boolean().optional().meta({ default: false })
      .describe(
        "Return the fingerprint itself as well as its id. Off by default — returning it reintroduces exactly the context cost a snapshot exists to avoid."
      ),
  })
  .strict();
export const DiffComp = z
  .object({
    since: z.string().describe("A snapshotId from an earlier snapshot_comp or diff_comp."),
    compId: z.number().optional().describe("Defaults to the comp the snapshot was taken of; pass it only to assert which comp you mean."),
    includeFingerprint: z.boolean().optional().meta({ default: false })
      .describe("Return the new fingerprint as well as the diff. Off by default."),
  })
  .strict();

// ---------- layers ----------
// The sections __layerSummary (layers.jsx) can add to its id/index/name/type
// core. One list for list_layers and find_layers, because both read through
// that one function — a section named here and not there is a field the
// schema advertises and the panel never fills, which no test can see.
export const LAYER_SUMMARY_SECTIONS: ["flags", "timing", "parent"] = ["flags", "timing", "parent"];
export const ListLayers = z.object({
  compId: z.number(),
  include: includeParam(LAYER_SUMMARY_SECTIONS, "the id/index/name/type map alone"),
});
// Effect parameters are bounded by DEFAULT (issue #115) — the deliberate
// exception to "absent means everything", like find_layers' bounded default.
// A third-party effect can carry thousands of parameters (Trapcode Particular:
// 7,401, ~1 MB in one read); every built-in one has under 15. The panel applies
// the same number (`__EFFECT_PARAMS_DEFAULT` in effects.jsx), and
// tests/unit/effect-params.mjs holds the two together.
export const EFFECT_PARAMS_DEFAULT = 200;
const effectParamFields = {
  maxParams: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Cap the parameters serialized per effect. Default ${EFFECT_PARAMS_DEFAULT}, applied even when omitted, because a third-party effect can carry thousands (Trapcode Particular: 7,401). Every effect reports paramCount; a capped one also reports paramsOmitted and paramsTruncated, so a capped read is never mistaken for a complete one.`
    ),
  paramFilter: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Case-insensitive regex over each parameter's display name and matchName; only matches are returned (still under maxParams) and paramsMatched counts them. The way to read a few parameters of a heavy effect, e.g. 'velocity|emitter'."
    ),
};
export const GetLayerFull = z.object({
  compId: z.number(),
  layerId: z.number(),
  includeChildren: z.boolean().optional().meta({ default: false }),
  include: includeParam(
    ["transform", "effects", "masks", "markers", "bounds", "text", "shape", "source"],
    "the layer header alone"
  ),
  maxKeyframes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Cap the keyframes serialized per property. Over the cap you get the first and last few plus a count of what was omitted — never a silent truncation. Omit for all of them."
    ),
  ...effectParamFields,
  shapeDepth: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe("How deep to walk a shape layer's Contents tree. Default 4; drop to 1-2 on heavy shape layers."),
  // Not a member of `include`: that list's contract is that omitting it returns
  // everything, and materials have to be off unless asked for.
  shapeMaterials: z
    .boolean()
    .optional()
    .meta({ default: false })
    .describe(
      "Include each shape group's Material Options — the 48-property 3D extrusion block. Off by default: it applies only to an extruded shape under the Cinema 4D renderer, and on an ordinary 2D shape layer it is most of the bytes of the read. What was skipped is counted in the response."
    ),
  shapeDetail: z
    .enum(["full", "compact"])
    .optional()
    .describe(
      "How to serialize a shape layer's Contents. 'full' (default) is one JSON node per property. 'compact' is one indented line per group with that group's own properties folded onto it as name=value — several times smaller, and enough to see what a layer is made of and address its nodes by name."
    ),
});

export const CreateTextLayer = z.object({
  compId: z.number(),
  text: z.string().default(""),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  color: Color.optional(),
  position: VecAny.optional(),
  tracking: z.number().optional()
    .describe("Letter-spacing. Omit it and the layer is created with tracking 0, because AE's addText() otherwise inherits whatever the user's Character panel was last left on (-20 is common) and the same call then renders differently on two machines. Not normalised when anchorAlign is 'none'."),
  anchorAlign: z.enum(["left", "center", "right", "none"]).optional().meta({ default: "left" })
    .describe("How the text aligns to `position`, implemented as live paragraph justification with the anchor point left at [0,0]. Default 'left' makes `position` the start of the first baseline; 'center' and 'right' put it at the centre/end. Because it is justification rather than a measured anchor offset, the alignment stays correct when the Source Text changes later — retyped, driven by an expression, or edited through Essential Graphics. 'none' leaves AE's raw defaults alone: no justification, no anchor move, no tracking reset."),
  name: z.string().optional(),
});
export const CreateShapeLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  // No shapes/fill/stroke/strokeWidth (issue #148): they were declared and never
  // applied, so a filled shape came back as an empty layer behind {ok:true}.
  // Contents go through add_shape_content, which builds them all-or-nothing;
  // the strict parse now refuses those keys by name instead.
  position: z.union([Vec2, Vec3, z.literal("center")]).optional()
    .describe("Where the layer's origin goes. Defaults to [0,0], which makes the layer's coordinate space the comp's — so vertices and shape positions you write afterwards are in comp pixels. 'center' is After Effects' own spawn point (the comp centre), which offsets every path you add by half a frame. The Anchor Point stays at [0,0] either way. A new shape layer is 2D, so use [x,y]; a three-component position needs set_layer threeDLayer:true first."),
});
export const CreateSolidLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  color: Color,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
});
export const CreateNullLayer = z.object({ compId: z.number(), name: z.string().optional() });
export const CreateAdjustmentLayer = z.object({ compId: z.number(), name: z.string().optional() });
export const CreatePrecompLayer = z.object({ compId: z.number(), sourceCompId: z.number(), position: VecAny.optional() });
export const CreateCameraLayer = z.object({ compId: z.number(), name: z.string().optional(), oneNode: z.boolean().default(false), position: VecAny.optional() });
export const CreateLightLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  lightType: z.enum(["parallel", "spot", "point", "ambient"]).default("point"),
  color: Color.optional(),
  intensity: z.number().optional(),
  position: VecAny.optional(),
});
export const DuplicateLayer = z.object({ compId: z.number(), layerId: z.number(), count: z.number().int().positive().optional().meta({ default: 1 }) });
export const DeleteLayer = z.object({ compId: z.number(), layerId: z.number() });
export const SetLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  locked: z.boolean().optional(),
  shy: z.boolean().optional(),
  solo: z.boolean().optional(),
  threeDLayer: z.boolean().optional(),
  // Keys into After Effects' own `BlendingMode` and `TrackMatteType`
  // enumerations (issue #150). Closed here so the model sees the names, and
  // refused again in `layers.jsx` if the running AE does not define one.
  blendingMode: namedEnum(BLENDING_MODES, BLENDING_MODE_ALIASES).optional()
    .describe("After Effects' BlendingMode name, case-insensitive. SILHOUETE_ALPHA is After Effects' own spelling; SILHOUETTE_ALPHA is accepted for it."),
  label: z.number().int().min(0).max(16).optional(),
  inPoint: z.number().optional(),
  outPoint: z.number().optional(),
  startTime: z.number().optional(),
  stretch: z.number().optional(),
  preserveTransparency: z.boolean().optional(),
  trackMatte: z.object({
    type: namedEnum(TRACK_MATTE_TYPES)
      .describe("How the matte is read, case-insensitive. NO_TRACK_MATTE removes the matte and takes no layerId."),
    layerId: z.number().optional()
      .describe("Id of the layer to use as the matte: same comp, anywhere in the stack (AE 2023+). Omit to keep the current matte layer and change only the type; required when the layer has no matte yet."),
  }).optional(),
});
export const ParentLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  parentLayerId: z.number().nullable(),
  preserveTransform: z.boolean().optional().meta({ default: true })
    .describe("Keep the layer visually where it is (what AE's UI does). Leave on unless you want the layer to jump into the parent's coordinate space."),
});
/**
 * Reorder is the one op whose whole job is invalidating layer indexes, so an
 * index is the worst possible way to address its destination — the caller read
 * it before the move that is about to change it. The id-relative forms are
 * therefore first-class here rather than sugar, and `toIndex` stays for the
 * cases where the position is genuinely absolute ("put it on top").
 */
export const ReorderLayer = crossField(
  z.object({
    compId: z.number(),
    layerId: z.number(),
    toIndex: z.number().int().positive().optional()
      .describe("Where the layer ENDS UP: its 1-based index after the move, counting from the front (1 renders in front of everything, numLayers is the back). Clamped to the stack. Prefer beforeLayerId/afterLayerId when you are placing this layer relative to another one — an index you read earlier may already be stale."),
    beforeLayerId: z.number().optional()
      .describe("Put this layer directly IN FRONT OF (above) the layer with this id."),
    afterLayerId: z.number().optional()
      .describe("Put this layer directly BEHIND (below) the layer with this id."),
  }),
  // One destination, resolved before it can reach ExtendScript — two readings of
  // "where does it go" are a contract the schema should never let through.
  {
    kind: "exactlyOne",
    fields: ["toIndex", "beforeLayerId", "afterLayerId"],
    then: "`beforeLayerId`/`afterLayerId` are the safer two: this is the op that shifts every index below it, so an index read before the move may already be stale.",
  }
);

// ---------- transforms ----------
// A keyframe with no time used to fall through to a static write and report
// ok (issue #151). Declared here so the model sees it in the schema and the
// server refuses before anything reaches After Effects.
const keyframeNeedsTime: CrossFieldRule = {
  kind: "whenTrue",
  fields: ["keyframe", "time"],
  then: "`time` is the keyframe's time in comp seconds.",
};

export const SetTransform = crossField(z.object({
  compId: z.number(),
  layerId: z.number(),
  time: z.number().optional(),
  keyframe: z.boolean().optional().meta({ default: false }),
  properties: z.object({
    position: VecAny.optional(),
    scale: VecAny.optional(),
    rotation: z.number().optional(),
    anchorPoint: VecAny.optional(),
    opacity: z.number().min(0).max(100).optional(),
    orientation: Vec3.optional(),
    xRotation: z.number().optional(),
    yRotation: z.number().optional(),
    zRotation: z.number().optional(),
  }),
}), keyframeNeedsTime);

// ---------- keyframes ----------
export const AddKeyframe = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  time: z.number(),
  value: VecAny,
  interpolation: Interpolation.optional(),
});
export const RemoveKeyframe = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  time: z.number(),
});
export const GetKeyframes = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
});
export const SetInterpolation = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  keyIndex: z.number().int().positive(),
  in: z.enum(["linear", "bezier", "hold"]).optional(),
  out: z.enum(["linear", "bezier", "hold"]).optional(),
});
export const SetTemporalEase = crossField(
  z.object({
    compId: z.number(),
    layerId: z.number(),
    propertyPath: PropertyPath,
    keyIndex: z.number().int().positive(),
    easeIn: z.object({ influence: z.number(), speed: z.number() }).optional()
      .describe("One influence/speed pair, applied to every dimension of the property. At least one of easeIn/easeOut is required."),
    easeOut: z.object({ influence: z.number(), speed: z.number() }).optional()
      .describe("One influence/speed pair, applied to every dimension of the property."),
  }),
  // `keyframes.jsx` has always refused this, and still does — but it refused
  // from inside After Effects, which meant a round trip and a write lease spent
  // on a call that was never going to change anything.
  {
    kind: "atLeastOne",
    fields: ["easeIn", "easeOut"],
    then: "Each is one {influence, speed} pair; this tool sizes the ease array for the property itself.",
  }
);
export const SetSpatialTangents = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  keyIndex: z.number().int().positive(),
  inTangent: z.array(z.number()).min(2).max(3),
  outTangent: z.array(z.number()).min(2).max(3),
});

// ---------- expressions ----------
export const GetExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath });
export const SetExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath, expression: z.string() });
export const ToggleExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath, enabled: z.boolean() });
export const ClearExpression = z.object({ compId: z.number(), layerId: z.number(), propertyPath: PropertyPath });

// ---------- effects ----------
export const ListEffects = z.object({ compId: z.number(), layerId: z.number(), ...effectParamFields });
export const AddEffect = z.object({ compId: z.number(), layerId: z.number(), matchName: z.string() });
export const RemoveEffect = z.object({ compId: z.number(), layerId: z.number(), effectIndex: z.number().int().positive() });
const SetEffectParamBase = crossField(
  z.object({
    compId: z.number(),
    layerId: z.number(),
    effectIndex: z.number().int().positive(),
    paramName: z.string().optional()
      .describe("The parameter's display name as list_effects reports it, in After Effects' UI language — 'Blurriness' on an English install, not on a localised one. Prefer paramMatchName."),
    paramMatchName: z.string().optional()
      .describe("Preferred. The parameter's matchName, e.g. 'ADBE Gaussian Blur 2-0001' — the same in every UI language. Tried before paramName when both are given."),
    value: VecAny,
    time: z.number().optional(),
    keyframe: z.boolean().optional().meta({ default: false }),
  }),
  // Neither one is not a call with a default — it is a call that resolves no
  // property at all, and `effects.jsx` answers it with a bare "Effect param not
  // found"-style miss, which reads like the *name* was wrong rather than absent.
  // Both together is legal and useful: matchName wins, name is the fallback.
  {
    kind: "atLeastOne",
    fields: ["paramName", "paramMatchName"],
    then: "list_effects on the layer reports both for every parameter of every effect.",
  }
);
export const SetEffectParam = crossField(SetEffectParamBase, keyframeNeedsTime);
export const SetEffectEnabled = z.object({ compId: z.number(), layerId: z.number(), effectIndex: z.number().int().positive(), enabled: z.boolean() });
// The result is cached for the AE session because enumerating app.effects is
// slow enough to time the bridge out (issue #26). `filter` is a case-insensitive
// substring match over displayName + matchName + category, so an agent looking
// for one effect never has to pull ~250 entries into its context.
export const ListAvailableEffects = z.object({
  filter: z.string().optional(),
  refresh: z.boolean().optional(),
}).strict();

// ---------- text ----------
export const SetText = z.object({
  compId: z.number(),
  layerId: z.number(),
  text: z.string().optional(),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  fillColor: Color.optional(),
  strokeColor: Color.optional(),
  strokeWidth: z.number().nonnegative().optional(),
  tracking: z.number().optional(),
  leading: z.number().optional(),
  justification: z.enum(["left", "center", "right", "full"]).optional(),
  applyFill: z.boolean().optional(),
  applyStroke: z.boolean().optional(),
  fauxBold: z.boolean().optional(),
  fauxItalic: z.boolean().optional(),
  allCaps: z.boolean().optional(),
  smallCaps: z.boolean().optional(),
  baselineShift: z.number().optional(),
});
export const AddTextAnimator = z.object({
  compId: z.number(),
  layerId: z.number(),
  type: z.enum(["position", "scale", "rotation", "opacity", "tracking", "skew", "fillColor", "strokeColor"]),
  range: z.object({ start: z.number().default(0), end: z.number().default(100), offset: z.number().default(0) }).optional(),
});

// ---------- shapes ----------
export const SetShapePath = z.object({
  compId: z.number(),
  layerId: z.number(),
  shapePath: PropertyPath,
  vertices: z.array(Vec2),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().optional().meta({ default: true }),
});
/**
 * One closed variant per shape node type. These are `.strict()` on purpose: an
 * unrecognised key must be a loud validation error, because zod's default
 * behaviour is to strip unknown keys, which would let a typo reach ExtendScript
 * as a silently-missing property and produce an empty shape that still reports
 * success.
 */
const ShapeColor = z.union([Color, ColorRGBA]);

export const ShapeContent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rect"),
    name: z.string().optional(),
    size: Vec2.optional(),
    position: Vec2.optional(),
    roundness: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("ellipse"),
    name: z.string().optional(),
    size: Vec2.optional(),
    position: Vec2.optional(),
  }).strict(),
  z.object({
    type: z.literal("star"),
    name: z.string().optional(),
    starType: z.number().optional().describe("1 = star, 2 = polygon"),
    points: z.number().optional().describe("Number of points/sides"),
    position: Vec2.optional(),
    rotation: z.number().optional(),
    innerRadius: z.number().optional(),
    outerRadius: z.number().optional(),
    innerRoundness: z.number().optional(),
    outerRoundness: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("path"),
    name: z.string().optional(),
    vertices: z.array(Vec2).optional().describe("Bezier vertices in layer space"),
    inTangents: z.array(Vec2).optional(),
    outTangents: z.array(Vec2).optional(),
    closed: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("fill"),
    name: z.string().optional(),
    color: ShapeColor.optional(),
    opacity: z.number().optional().describe("0..100"),
    fillRule: z.union([namedEnum(["nonzero", "evenodd"]), z.literal(1), z.literal(2)]).optional()
      .describe("nonzero (After Effects' 1, the default) or evenodd (2)."),
  }).strict(),
  z.object({
    type: z.literal("stroke"),
    name: z.string().optional(),
    color: ShapeColor.optional(),
    opacity: z.number().optional().describe("0..100"),
    width: z.number().optional(),
    lineCap: z.union([namedEnum(["butt", "round", "projecting"]), z.literal(1), z.literal(2), z.literal(3)]).optional()
      .describe("butt (After Effects' 1, the default), round (2) or projecting (3)."),
    lineJoin: z.union([namedEnum(["miter", "round", "bevel"]), z.literal(1), z.literal(2), z.literal(3)]).optional()
      .describe("miter (After Effects' 1, the default), round (2) or bevel (3)."),
    miterLimit: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("trim"),
    name: z.string().optional(),
    start: z.number().optional().describe("0..100"),
    end: z.number().optional().describe("0..100"),
    offset: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("repeater"),
    name: z.string().optional(),
    copies: z.number().optional(),
    offset: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("merge"),
    name: z.string().optional(),
    mode: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("group"),
    name: z.string().optional(),
  }).strict(),
]);

export const AddShapeContent = z.object({
  compId: z.number(),
  layerId: z.number(),
  parentGroupPath: PropertyPath.optional(),
  content: ShapeContent,
  zOrder: z.enum(["front", "back"]).optional()
    .describe("Where the new node sits in its group's render stack. Index 1 renders in FRONT, and AE appends new content to the end — so the default, 'back', puts each node behind everything already there. 'front' moves it to index 1. Prefer ordering your calls front-to-back (details first, background rects last) over reaching for 'front': it needs an internal moveTo, which has been seen to disturb nested renders of the comp in AE 26.3."),
});
export const SetShapeProperty = crossField(z.object({
  compId: z.number(),
  layerId: z.number(),
  contentPath: PropertyPath,
  property: z.string(),
  value: VecAny,
  time: z.number().optional(),
  keyframe: z.boolean().optional().meta({ default: false }),
}), keyframeNeedsTime);

// ---------- masks ----------
export const AddMask = z.object({
  compId: z.number(),
  layerId: z.number(),
  vertices: z.array(Vec2),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().optional().meta({ default: true }),
  // A key into AE's `MaskMode`, looked up by name in `masks.jsx`, which
  // refuses a miss (issue #150).
  mode: namedEnum(MASK_MODES).optional().meta({ default: "ADD" })
    .describe("Mask blend mode, case-insensitive."),
});
export const SetMask = z.object({
  compId: z.number(),
  layerId: z.number(),
  maskIndex: z.number().int().positive(),
  vertices: z.array(Vec2).optional(),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().optional(),
  mode: namedEnum(MASK_MODES).optional()
    .describe("Mask blend mode, case-insensitive."),
  inverted: z.boolean().optional(),
  expansion: z.number().optional(),
  feather: Vec2.optional(),
  opacity: z.number().optional(),
});
export const RemoveMask = z.object({ compId: z.number(), layerId: z.number(), maskIndex: z.number().int().positive() });

// ---------- markers ----------
export const AddMarker = z.object({
  compId: z.number(),
  layerId: z.number().optional(),
  time: z.number(),
  duration: z.number().nonnegative().optional().meta({ default: 0 }),
  comment: z.string().optional(),
  label: z.number().int().min(0).max(16).optional(),
  chapter: z.string().optional(),
  url: z.string().optional(),
  frameTarget: z.string().optional(),
});
export const RemoveMarker = z.object({
  compId: z.number(),
  layerId: z.number().optional(),
  markerIndex: z.number().int().positive(),
});

// ---------- vision ----------
/**
 * Omitted means "pick one from the comp size", not 1. The right factor is
 * derivable from the comp's dimensions, and a caller who forgets it was
 * previously served a full-resolution 4K frame — the single most expensive
 * accident available through these tools.
 */
const downsampleParam = z
  .number()
  .int()
  .min(1)
  .max(8)
  .optional()
  .describe(
    "Render at 1/N resolution. Omit and one is chosen from the comp size (long edge ~1280px: 2 at 1080p, 3 at 4K). Pass 1 for a full-resolution frame. The factor is always exactly what you asked for: the render sets the comp's resolution and puts it back, so a viewer left on Quarter or Third does not change the size of the frame you get."
  );
export const ScreenshotFrame = crossField(
  z.object({
    compId: z.number(),
    time: z.number().optional(),
    /**
     * Several times in one call, returned as one tiled sheet.
     *
     * Judging motion is a single visual question, and answering it used to cost
     * one call per frame — three image blocks resident for the rest of the
     * session, and three chances for After Effects to re-serve a stale buffer.
     * Capped at six because past that each tile is too small to read at the
     * pixel budget of one frame.
     */
    times: z
      .array(z.number())
      .min(2)
      .max(6)
      .optional()
      .describe(
        "2-6 times to render into one tiled contact sheet, in order, with the time burned into each tile. Cheaper than one call per frame and the whole point of it is judging motion. Mutually exclusive with `time`."
      ),
    downsample: downsampleParam,
  }),
  // Enforced here rather than in the panel: two readings of "which frame did
  // you want" reaching ExtendScript at all is a contract the schema should
  // never have let through. `atMostOne` and not `exactlyOne` — neither is a
  // legal call, and means the comp's current time.
  {
    kind: "atMostOne",
    fields: ["time", "times"],
    then: "`time` is one frame, `times` is a contact sheet of 2-6 of them; omit both for the comp's current time.",
  }
);
export const ScreenshotLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  time: z.number().optional(),
  downsample: downsampleParam,
});

/**
 * The write ops' opt-in structural diff. The before-fingerprint has to be taken
 * inside the same bridge call as the write — a separate snapshot_comp is a
 * second round-trip during which anything can happen — so these two are read by
 * the panel, not the server.
 */
const diffParam = z
  .boolean()
  .optional()
  .meta({ default: false })
  .describe(
    "Fingerprint the comp before and after this call and append only what changed (layers added/removed/renamed/retimed/re-parented, keyframe counts, expression and effect counts). A few dozen tokens instead of reading the comp back. If the call fails, the diff of what landed before it stopped is appended to the error."
  );
const diffCompIdParam = z
  .number()
  .optional()
  .describe("Which comp `diff` should fingerprint. Defaults to the comps this call names, else the comp open in the viewer.");

// ---------- batch ----------
export const RunBatch = z.object({
  ops: z.array(z.object({ op: z.string(), args: z.unknown().optional() })),
  transactional: z.boolean().optional().meta({ default: true })
    .describe("Stop at the first failing op instead of running the rest. Nothing rolls back either way — the ops before the failure stay applied, and the error says where it stopped."),
  undoGroupName: z.string().optional().meta({ default: "AE MCP Batch" })
    .describe("What the user sees in After Effects' Edit > Undo menu. A chunked batch numbers its steps from this, e.g. \"AE MCP Batch (3)\"."),
  singleUndo: z.boolean().optional().meta({ default: false })
    .describe("Force the whole batch into ONE undo step, whatever its size, by running it in a single blocking ExtendScript call. Up to 2000 ops. The cost is real: After Effects' interface is frozen for the entire batch and no progress is reported, so the user sees nothing until it finishes. Without it a batch over 500 ops is chunked and lands as one undo step per chunk of 25 — the result reports the exact count. Reach for this only when the user has to be able to undo the work with a single Cmd-Z."),
  diff: diffParam,
  diffCompId: diffCompIdParam,
});

// ---------- explore ----------
export const GetProjectSummary = z.object({}).strict();
export const GetSelection = z.object({}).strict();
export const FindLayers = z.object({
  compId: z.number().optional(),
  namePattern: z.string().optional(),
  type: z.string().optional(),
  hasEffectMatchName: z.string().optional(),
  // Same section names as list_layers, opposite default: a search is for
  // learning which layers exist and what to address them by, so omitting this
  // means the core alone rather than everything (issue #87). `includeParam`
  // is not reused because its sentence says "omit for all of them".
  include: z
    .array(z.enum(LAYER_SUMMARY_SECTIONS))
    .optional()
    .describe(
      `Sections to add to each match: ${LAYER_SUMMARY_SECTIONS.join(", ")} — the same names as list_layers. Omit it (or pass []) for id/index/name/sourceType plus compId/compName only; unlike list_layers, omitting it here does NOT return every section. The result echoes what was included.`
    ),
});

// ---------- raw ----------
export const RunJsx = crossField(
  z.object({
    code: z.string().optional()
      .describe("The ExtendScript to run. Exactly one of `code` or `scriptPath`."),
    scriptPath: z.string().optional()
      .describe("Absolute path to a .jsx file to run instead of `code`. The server reads it, so a long script never enters the conversation. Exactly one of `code` or `scriptPath`."),
    libraries: z.array(z.string()).optional()
      .describe("Absolute paths to .jsx files inlined ahead of the script, sharing its scope, so their functions are callable from it. The server reads them, so their text never enters the conversation. They are re-evaluated on every call — keep them to declarations, not to work. Put shared helpers here rather than pasting them into every script."),
    undoGroup: z.boolean().optional().meta({ default: true })
      .describe("Wrap the script in one undo step. Set false only for the operations AE refuses while an undo group is open — copyToComp on a layer with a parent or a linked expression. The script's changes then land as whatever undo steps AE records on its own."),
    diff: diffParam,
    diffCompId: diffCompIdParam,
  }),
  // `resolveRunJsxSource` refuses both and neither too, and keeps doing so —
  // it is reachable from a hand-rolled `POST /op`, which nothing validates. What
  // the rule buys here is the half that runs *before* the call: declared, it
  // reaches the emitted JSON Schema, so the model sees the choice rather than
  // discovering it.
  {
    kind: "exactlyOne",
    fields: ["code", "scriptPath"],
    then: "Prefer `scriptPath` for anything long — the server reads the file, so the script never enters the conversation.",
  }
);

// ---------- footage ----------
export const ImportFootage = z
  .object({
    path: z.string().min(1).describe("Absolute path to the file to import."),
    name: z.string().optional().describe("Rename the project item after import. Omit to keep the filename."),
    sequence: z.boolean().optional().meta({ default: false })
      .describe("Import a numbered still as an image sequence rather than a single frame."),
    force: z.boolean().optional().meta({ default: false })
      .describe(
        "Keep an item that failed validation instead of deleting it and throwing. The problem is still reported in `validation`. Only pass this when you know the dimensions are wrong and want the item anyway."
      ),
  })
  .strict();
export const CreateFootageLayer = z.object({
  compId: z.number(),
  itemId: z.number().describe("Project item id from import_footage or get_project_summary."),
  name: z.string().optional(),
  position: VecAny.optional(),
  startTime: z.number().optional(),
});
export const PurgeUnusedFootage = z
  .object({
    solidsOnly: z.boolean().optional().meta({ default: true })
      .describe(
        "Only remove solids — the items behind solid and adjustment layers. Pass false to remove every footage item no comp uses, imported files and placeholders included, which is what AE's own Remove Unused Footage does. Comps and folders are never removed either way."
      ),
    dryRun: z.boolean().optional().meta({ default: false })
      .describe("List what would be removed without removing anything — not even an undo step."),
    folderId: z.number().optional()
      .describe("Restrict the sweep to one project folder and everything nested under it. A folder id from get_project_summary; omit for the whole project."),
  })
  .strict();

// ---------- audio ----------
export const AudioCue = z
  .object({
    footageId: z.number().optional()
      .describe("Project item id of an already-imported sound. Give this or `path`, not both."),
    path: z.string().min(1).optional()
      .describe("Absolute path to a sound file. Imported once per call however many cues name it, and an item already in the project from that path is reused rather than imported again."),
    time: z.number().describe("Comp time in seconds where the cue starts."),
    levelDb: z.number().optional()
      .describe("Level in decibels, the same unit After Effects shows. 0 is the file untouched, -6 is roughly half as loud, negative is quieter. Defaults to 0, written explicitly so the result is the same on every machine."),
    name: z.string().optional().describe("Layer name. Defaults to namePrefix + the file's basename without its extension."),
    inPoint: z.number().optional().describe("Trim the layer's in point to this COMP time. Must not be earlier than `time`. Omit to play from the start of the file."),
    outPoint: z.number().optional().describe("Trim the layer's out point to this COMP time. Omit to play to the end of the file."),
    label: z.union([z.number().int().min(0).max(16), z.string()]).optional()
      .describe("AE label colour, as an index 0-16 or a name (red, yellow, aqua, pink, lavender, peach, seafoam, blue, green, purple, orange, brown, fuchsia, cyan, sandstone, darkgreen)."),
    loop: z.boolean().optional()
      .describe("Loop the sound until `outPoint`, or until the end of the comp when no outPoint is given — for beds and ambiences. Enables time remapping with a wrap-around expression on Time Remap; the layer's in point still trims the front of the file the way it does on any layer. Default false: the file plays once."),
    fadeIn: z.number().min(0).optional()
      .describe("Seconds to fade in from `fadeFloorDb` up to `levelDb`, as keyframes on Audio Levels starting at the layer's in point. Default 0 (no fade). fadeIn + fadeOut must fit inside the cue's placed length or the cue is refused by index."),
    fadeOut: z.number().min(0).optional()
      .describe("Seconds to fade out from `levelDb` down to `fadeFloorDb`, ending at the layer's out point. Default 0 (no fade). fadeIn + fadeOut must fit inside the cue's placed length or the cue is refused by index."),
    stretch: z.number().positive().optional()
      .describe("Time stretch as a percentage: 100 is unchanged, 200 plays at half speed (lower pitch, twice as long), 50 at double speed. Must be greater than 0. The layer's start time and any trim are re-asserted after it, since After Effects moves them when stretch changes. Default 100."),
  })
  .strict();
export const PlaceAudioCues = z
  .object({
    compId: z.number(),
    cues: z.array(AudioCue).min(1).max(200),
    namePrefix: z.string().optional().meta({ default: "SFX_" })
      .describe("Prefix for cues that do not name themselves. Pass \"\" for no prefix."),
    fadeFloorDb: z.number().optional()
      .describe("The level in decibels that every fadeIn starts from and every fadeOut ends at. Default -48, the bottom of After Effects' own Audio Levels slider and 1/256 of the recorded amplitude — near-silence. Must be below each faded cue's levelDb. One floor for the whole list."),
    dryRun: z.boolean().optional().meta({ default: false })
      .describe("Resolve and check the whole list without importing, creating or changing anything — not even an undo step. Returns counts, the files it would import, the items it would reuse and the failing cues by index — never the whole resolved list."),
  })
  .strict();

// ---------- motion graphics templates ----------
export const ExportMogrt = z
  .object({
    compId: z.number(),
    destDir: z.string().optional()
      .describe("Folder to write the .mogrt into. Defaults to the folder holding the .aep."),
    name: z.string().optional()
      .describe(
        "Template name, which is also the output filename. Defaults to the comp name — AE's own default is the literal 'Untitled', so every scripted export would otherwise overwrite the same file."
      ),
    overwrite: z.boolean().optional().meta({ default: false })
      .describe("Required to replace an existing .mogrt at that path."),
    posterTime: z.number().optional()
      .describe(
        "Comp time to render as the template's still thumbnail, replacing the black one AE writes. Omit to leave AE's thumbnail alone."
      ),
    suppressDialogs: z.boolean().optional().meta({ default: true })
      .describe(
        "Suppress the modal font warning during export. Leave true: an unsuppressed dialog freezes the bridge until someone clicks it in AE. Set false only to see the dialog deliberately."
      ),
  })
  .strict();

// ---------- render queue (issue #137) ----------
export const AddToRenderQueue = z
  .object({
    compId: z.number(),
    outputPath: z.string()
      .describe("Absolute path of the file to write. Its folder must already exist. For an image sequence put the frame number in as [####], e.g. /renders/shot_[####].png."),
    outputModuleTemplate: z.string().optional()
      .describe("Output module template by name, e.g. 'High Quality with Alpha' or one the user saved. Omit for After Effects' default. An unknown name is refused with the list of names that exist. Codec, bit depth and alpha can only be chosen this way — a script cannot set them directly."),
    renderSettingsTemplate: z.string().optional()
      .describe("Render settings template by name, e.g. 'Best Settings'. Omit for After Effects' default."),
    startTime: z.number().optional().describe("Seconds, comp time. Omit to start where After Effects defaults the item (the work area)."),
    duration: z.number().optional().describe("Seconds to render from startTime. Omit for After Effects' default span."),
    overwrite: z.boolean().optional().meta({ default: false })
      .describe("Required when a file already exists at outputPath; the render replaces it."),
  })
  .strict();
export const ListRenderQueue = z
  .object({
    includeSettings: z.boolean().optional().meta({ default: false })
      .describe("Read back each output module's format, channels, depth and color as After Effects reports them."),
    includeTemplates: z.boolean().optional().meta({ default: false })
      .describe("Also list every render settings and output module template name. Only readable when the queue has at least one item."),
  })
  .strict();
export const RemoveRenderItem = z
  .object({
    index: z.number().int().positive().describe("1-based index, as list_render_queue reports it now."),
    compId: z.number().describe("The comp that item renders. Checked against the item, because indices shift when an earlier item is removed."),
  })
  .strict();
export const RenderQueue = crossField(
  z
    .object({
      indices: z.array(z.number().int().positive()).min(1).optional()
        .describe("Which render queue items to render, 1-based, as add_to_render_queue or list_render_queue reported them. The normal way to call this."),
      all: z.literal(true).optional()
        .describe("Render EVERY QUEUED item — including ones the user queued by hand, not just yours. Only when the user asked for the whole queue."),
      overwrite: z.boolean().optional().meta({ default: false })
        .describe("Required when an output file (or any frame of an output sequence) already exists; the render replaces it."),
      saveProject: z.boolean().optional().meta({ default: false })
        .describe("Required when the project has unsaved changes: the render reads the saved file, so it saves first. Tell the user before passing it. Also required, and saves a project with no unsaved changes, when the saved file records footage at paths it has since moved from (the refusal says so). Otherwise ignored for a saved project."),
    })
    .strict(),
  // Rendering items the agent never added is a choice the caller has to make
  // out loud, never the default of an omitted field.
  {
    kind: "exactlyOne",
    fields: ["indices", "all"],
    then: "Prefer `indices` with the items you added; `all:true` also renders whatever the user queued by hand.",
  }
);

// ---------- house style (a markdown file beside the .aep, read over the bridge) ----------
export const GetHouseStyle = z
  .object({
    detail: z.enum(["summary", "full"]).optional().meta({ default: "summary" })
      .describe(
        "'summary' (default) is a few hundred tokens: palette as named hexes, type, motion defaults, layout rules, and what it could not summarise. 'full' returns the whole document — use it before editing the guide with set_house_style, or when the summary is not enough."
      ),
  })
  .strict();
export const SetHouseStyle = z
  .object({
    content: z.string().min(1).describe("The complete style guide as markdown. Replaces the file, so send the whole document."),
    overwrite: z.boolean().optional().meta({ default: false })
      .describe("Required to replace an existing guide. Read it with get_house_style and merge first — this is not a patch."),
  })
  .strict();

// ---------- jobs ----------
// ---------- setup (handled in the MCP server, never forwarded to the panel) ----------
export const CheckSetup = z.object({}).strict();
export const SetupPanel = z.object({
  enableDebugMode: z.boolean().optional().meta({ default: true })
    .describe("Also set Adobe's PlayerDebugMode preference, which AE requires to load this unsigned panel, and CEP's LogLevel where it was never set, so CEP's own log records why a panel failed to load (issue #91). Default true."),
  force: z.boolean().optional().meta({ default: false })
    .describe("Replace an existing symlinked (development) install with a copy. Default false."),
}).strict();

/**
 * Guide topics. The prose lives in `packages/mcp-server/src/guides/*.md`, but the
 * names are part of the tool contract, so they are declared here and
 * `scripts/build-guides.mjs` fails the build if the two ever disagree.
 */
export const GUIDE_TOPICS = [
  "ae-setup",
  "after-effects",
  "animation",
  "assembly",
  "extendscript-gotchas",
  "issue-journal",
  "mogrt-and-footage",
  "rendering",
  "shapes",
  "sound",
  "style-guide",
  "text",
  "whats-new",
] as const;
export const AeGuide = z
  .object({
    topic: z.enum(GUIDE_TOPICS).describe(
      "after-effects: the core — orienting, bounded reads, verifying a write, screenshots, the bridge failures — start here; it points at one topic per subject. animation: keyframes, easing, rigging, expressions. shapes: shape layers and their Contents. text: text layers. assembly: shots placed into a master comp, markers, retiming. extendscript-gotchas: read before writing raw ExtendScript for run_jsx. sound: sound effects and levels. mogrt-and-footage: exporting a .mogrt, importing footage. issue-journal: when a tool fought back. whats-new: what changed, one section per release, when a call behaves differently from what you expected or a project is being brought up to date after an upgrade. style-guide: capturing the user's look. ae-setup: connecting to AE when a tool cannot reach it."
    ),
    since: z
      .string()
      .regex(/^v?\d+\.\d+\.\d+$/, "must be a version like 0.4.0")
      .optional()
      .describe(
        "whats-new only: return just the releases newer than this version — the version named is the one already absorbed and is excluded — behind the guide's preamble, or one line saying nothing is newer. Use the version a project's docs record as last absorbed, or 0.0.0 for the whole history; omitted, only the two newest releases are returned and the older ones are named. The answer opens with the server's own version. Rejected on any other topic, since there is nothing there to filter."
      ),
  })
  .strict();

// ---------- project scaffold (handled in the MCP server, never forwarded to the panel) ----------
export const InitProject = z
  .object({
    dir: z.string().optional()
      .describe("Folder to create or fill, absolute or relative to the server's working directory. Ask the user if you do not know; do not invent one."),
    name: z.string().optional().describe("Project name for the generated docs. Defaults to the folder name."),
    client: z.enum(["auto", "claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex", "generic"])
      .optional().meta({ default: "auto" })
      .describe("Which client's layout to write. 'auto' detects it from the MCP handshake — leave it alone unless the user says otherwise."),
    withMcpConfig: z.boolean().optional().meta({ default: false })
      .describe("Also write a client MCP config pointing at this server. Default false: you are already connected, so the user does not need one."),
  })
  .strict();

// ---------- issue journal (handled in the MCP server, never forwarded to the panel) ----------
export const LogIssue = z
  .object({
    title: z.string().min(3).describe("One line naming the problem, specific enough to recognise again. Becomes the entry's id."),
    symptom: z.string().min(3).describe("What went wrong, including the exact error text and the call that produced it."),
    workaround: z.string().min(3).describe("What actually worked — concrete enough for the next session to apply without rediscovering it."),
    cause: z.string().optional().describe("Why it happens, if you worked it out."),
    tools: z.array(z.string()).optional().describe("Tool names involved, e.g. ['set_temporal_ease']. With errorText, this is what a later failure is matched on."),
    errorText: z.string().optional()
      .describe(
        "The exact error text the failing call returned, verbatim. The next time a call to one of `tools` fails with matching text, its error names this entry — and a later log_issue with the same tool and error text extends this entry instead of creating a second one under a different title."
      ),
    kind: z.enum(["tool-bug", "ae-quirk"]).optional().meta({ default: "tool-bug" })
      .describe(
        "'tool-bug' (default): something these tools get wrong, which a later release may fix — so the entry is archived once it was last seen on an older server than the one running. 'ae-quirk': After Effects itself behaving unlike its documentation; no release changes that, so it is never archived by version."
      ),
    scope: z.enum(["project", "user"]).optional().meta({ default: "project" })
      .describe(
        "'project' (default) for this project's footage, comps or files. 'user' for how these tools or After Effects behave — that journal travels with the person, so every future project starts knowing it. Reported back as 'home' when there is no project folder to write into."
      ),
  })
  .strict();
export const ListKnownIssues = z
  .object({
    status: z.enum(["all", "unreported", "reported"]).optional().meta({ default: "all" }),
    tool: z.string().optional().describe("Only entries about this tool, e.g. 'set_temporal_ease'. Omit for everything."),
    query: z
      .string()
      .optional()
      .describe("Free-text filter: every whitespace-separated term must appear in an entry's title, symptom or tools."),
    id: z
      .string()
      .optional()
      .describe("Read one entry in full — cause and workaround included — by the id from a previous listing. Ignores the filters. Ids are unique only within a journal, so prefix with the entry's scope ('user:my-entry') when the listing shows one in each."),
    detail: z
      .enum(["index", "full"])
      .optional()
      .meta({ default: "index" })
      .describe(
        "'index' (default) is one line per entry: id, title, tools, kind, when and on which version it was last seen, counts — read the one you need with `id`. 'full' returns every matching entry's whole body and costs thousands of tokens."
      ),
    scope: z.enum(["all", "project", "user"]).optional().meta({ default: "all" })
      .describe(
        "Which journal to read. 'all' (default) merges this project's with the user's cross-project one and tags every entry with the scope it came from."
      ),
    limit: z.number().int().positive().max(500).optional().meta({ default: 50 })
      .describe("Most entries to return. Anything held back is counted in `omitted`."),
    includeArchived: z.boolean().optional().meta({ default: false })
      .describe(
        "Also list archived entries — not seen for 30 days, last seen on an older server than this one, or retired with archive_issue — each flagged with its reason. Default false: they are hidden and only counted in `archivedCount`. An `id` read always returns the entry, archived or not."
      ),
  })
  .strict();
export const MarkIssueReported = z
  .object({
    id: z.string().describe("The entry id returned by log_issue or list_known_issues. Prefix with its scope ('user:my-entry') when the same id exists in both journals."),
    url: z.string().optional().describe("Link to the issue that was opened."),
  })
  .strict();
export const ArchiveIssue = z
  .object({
    id: z.string().describe("The entry id from log_issue or list_known_issues. Prefix with its scope ('user:my-entry') when the same id exists in both journals — only the one named moves."),
    reason: z.string().min(3).describe("Why it is being retired, one line — the URL of the report that already covers it, the release that fixed it, or where the lesson was moved to."),
  })
  .strict();

export const AwaitJob = z.object({ jobId: z.string(), timeoutMs: z.number().int().positive().optional().meta({ default: 600_000 }) });
export const GetJob = z.object({ jobId: z.string() });
export const CancelJob = z.object({ jobId: z.string() });

/**
 * Registry: op name -> zod schema. Used by MCP server to register tools and
 * by the panel/ExtendScript dispatcher as authoritative op list.
 */
export const OpSchemas = {
  // comps
  list_comps: ListComps,
  get_comp: GetComp,
  get_comp_tree: GetCompTree,
  create_comp: CreateComp,
  set_comp: SetComp,
  delete_comp: DeleteComp,
  set_active_comp: SetActiveComp,
  duplicate_comp: DuplicateComp,
  checkpoint_comp: CheckpointComp,
  list_checkpoints: ListCheckpoints,
  revert_comp: RevertComp,
  delete_checkpoints: DeleteCheckpoints,
  snapshot_comp: SnapshotComp,
  diff_comp: DiffComp,
  // layers
  list_layers: ListLayers,
  get_layer_full: GetLayerFull,
  create_text_layer: CreateTextLayer,
  create_shape_layer: CreateShapeLayer,
  create_solid_layer: CreateSolidLayer,
  create_null_layer: CreateNullLayer,
  create_adjustment_layer: CreateAdjustmentLayer,
  create_precomp_layer: CreatePrecompLayer,
  create_camera_layer: CreateCameraLayer,
  create_light_layer: CreateLightLayer,
  duplicate_layer: DuplicateLayer,
  delete_layer: DeleteLayer,
  set_layer: SetLayer,
  parent_layer: ParentLayer,
  reorder_layer: ReorderLayer,
  // transforms
  set_transform: SetTransform,
  // keyframes
  add_keyframe: AddKeyframe,
  remove_keyframe: RemoveKeyframe,
  get_keyframes: GetKeyframes,
  set_interpolation: SetInterpolation,
  set_temporal_ease: SetTemporalEase,
  set_spatial_tangents: SetSpatialTangents,
  // expressions
  get_expression: GetExpression,
  set_expression: SetExpression,
  toggle_expression: ToggleExpression,
  clear_expression: ClearExpression,
  // effects
  list_effects: ListEffects,
  add_effect: AddEffect,
  remove_effect: RemoveEffect,
  set_effect_param: SetEffectParam,
  set_effect_enabled: SetEffectEnabled,
  list_available_effects: ListAvailableEffects,
  // text
  set_text: SetText,
  add_text_animator: AddTextAnimator,
  // shapes
  set_shape_path: SetShapePath,
  add_shape_content: AddShapeContent,
  set_shape_property: SetShapeProperty,
  // masks
  add_mask: AddMask,
  set_mask: SetMask,
  remove_mask: RemoveMask,
  // markers
  add_marker: AddMarker,
  remove_marker: RemoveMarker,
  // vision
  screenshot_frame: ScreenshotFrame,
  screenshot_layer: ScreenshotLayer,
  // batch
  run_batch: RunBatch,
  // explore
  get_project_summary: GetProjectSummary,
  get_selection: GetSelection,
  find_layers: FindLayers,
  // footage
  import_footage: ImportFootage,
  create_footage_layer: CreateFootageLayer,
  purge_unused_footage: PurgeUnusedFootage,
  // audio
  place_audio_cues: PlaceAudioCues,
  // motion graphics templates
  export_mogrt: ExportMogrt,
  // render queue
  add_to_render_queue: AddToRenderQueue,
  list_render_queue: ListRenderQueue,
  remove_render_item: RemoveRenderItem,
  render_queue: RenderQueue,
  // raw
  run_jsx: RunJsx,
  // house style
  get_house_style: GetHouseStyle,
  set_house_style: SetHouseStyle,
  // jobs
  await_job: AwaitJob,
  get_job: GetJob,
  cancel_job: CancelJob,
  // setup
  check_setup: CheckSetup,
  setup_panel: SetupPanel,
  init_project: InitProject,
  // guidance
  ae_guide: AeGuide,
  // issue journal
  log_issue: LogIssue,
  list_known_issues: ListKnownIssues,
  mark_issue_reported: MarkIssueReported,
  archive_issue: ArchiveIssue,
} as const;

export type OpName = keyof typeof OpSchemas;

/**
 * What each op does to the live After Effects session.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  ADDING AN OP? ADD IT HERE TOO. `tests/unit/write-queue.mjs` fails the build
 *  when an op is in `OpSchemas` and not in this table, or the other way round.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * There is deliberately no default. Guessing "read" for an op nobody
 * classified would let a new writing tool run inside another write's undo group
 * and corrupt it silently, which is the exact failure this table exists to
 * prevent (issue #55) — so an unclassified op has to fail the build instead.
 *
 *   "write"  — changes the project or the application. The server serializes
 *              these behind one mutex: After Effects applies every change
 *              through a single undo stack, and two in flight interleave.
 *   "read"   — reaches the bridge and changes nothing. Never queued. Screenshots
 *              are here on purpose: they are slow *and* read-only, and putting
 *              them behind the write mutex would make every write wait on a render.
 *   "server" — never reaches the bridge at all (`SERVER_OPS` in server.ts).
 *              Not queued, and that is load-bearing: `await_job` blocks for as
 *              long as a batch runs and `cancel_job` is how a stuck one is
 *              released, so queueing either would deadlock against the job
 *              holding the lock.
 */
export const OpMutation = {
  // comps
  list_comps: "read",
  get_comp: "read",
  get_comp_tree: "read",
  create_comp: "write",
  set_comp: "write",
  delete_comp: "write",
  set_active_comp: "write",
  duplicate_comp: "write",
  // Checkpoints are comps in the project: taking, reverting and deleting one
  // all change it. Listing reads item comments and nothing else.
  checkpoint_comp: "write",
  list_checkpoints: "read",
  revert_comp: "write",
  delete_checkpoints: "write",
  // Fingerprints: they forward a read to the panel and keep the answer in the
  // server. Nothing is written to the project or the undo stack, so they must
  // not queue — the point of a diff is checking on a write that is in flight.
  snapshot_comp: "read",
  diff_comp: "read",
  // layers
  list_layers: "read",
  get_layer_full: "read",
  create_text_layer: "write",
  create_shape_layer: "write",
  create_solid_layer: "write",
  create_null_layer: "write",
  create_adjustment_layer: "write",
  create_precomp_layer: "write",
  create_camera_layer: "write",
  create_light_layer: "write",
  duplicate_layer: "write",
  delete_layer: "write",
  set_layer: "write",
  parent_layer: "write",
  reorder_layer: "write",
  // transforms
  set_transform: "write",
  // keyframes
  add_keyframe: "write",
  remove_keyframe: "write",
  get_keyframes: "read",
  set_interpolation: "write",
  set_temporal_ease: "write",
  set_spatial_tangents: "write",
  // expressions
  get_expression: "read",
  set_expression: "write",
  toggle_expression: "write",
  clear_expression: "write",
  // effects
  list_effects: "read",
  add_effect: "write",
  remove_effect: "write",
  set_effect_param: "write",
  set_effect_enabled: "write",
  list_available_effects: "read",
  // text
  set_text: "write",
  add_text_animator: "write",
  // shapes
  set_shape_path: "write",
  add_shape_content: "write",
  set_shape_property: "write",
  // masks
  add_mask: "write",
  set_mask: "write",
  remove_mask: "write",
  // markers
  add_marker: "write",
  remove_marker: "write",
  // vision — read-only despite being the slowest thing here. `screenshot_*`
  // borrows the comp's resolutionFactor (and screenshot_layer the solo
  // switches) and restores them in a `finally`; nothing in the project changes.
  // The borrow can cost one undo step, "AE MCP: screenshot", when the comp was
  // not already at the requested factor (#116) — a step whose net effect is
  // nil, so landing between two chunks of a long batch moves nothing the batch
  // wrote. Queuing a render behind every write would cost far more than that.
  screenshot_frame: "read",
  screenshot_layer: "read",
  // batch
  run_batch: "write",
  // explore
  get_project_summary: "read",
  // The user's selection and playhead in the active comp; reads only.
  get_selection: "read",
  find_layers: "read",
  // footage
  import_footage: "write",
  create_footage_layer: "write",
  // Removes project items. A dryRun changes nothing, but the table is per op,
  // not per call — a dry run waiting behind a batch costs a little time and a
  // real one interleaving with it costs the batch's undo step.
  purge_unused_footage: "write",
  // audio cues — imports footage and adds layers.
  place_audio_cues: "write",
  // motion graphics templates — saves the project before exporting.
  export_mogrt: "write",
  // render queue. Adding and removing items edits the project's queue.
  add_to_render_queue: "write",
  list_render_queue: "read",
  remove_render_item: "write",
  // Saves the project, so it takes the lease — but only for the save. The
  // render itself runs in a separate aerender process from the file on disk,
  // and holding the lock for it would freeze every write for minutes to
  // protect a render that cannot see them anyway. See server.ts.
  render_queue: "write",
  // raw — the script is the caller's and may do anything. Assume the worst.
  run_jsx: "write",
  // house style — written over the bridge into a file beside the .aep.
  get_house_style: "read",
  set_house_style: "write",
  // jobs
  await_job: "server",
  get_job: "server",
  cancel_job: "server",
  // setup
  check_setup: "server",
  setup_panel: "server",
  init_project: "server",
  // guidance
  ae_guide: "server",
  // issue journal
  log_issue: "server",
  list_known_issues: "server",
  mark_issue_reported: "server",
  archive_issue: "server",
} as const satisfies Record<OpName, "write" | "read" | "server">;

export type OpEffect = (typeof OpMutation)[OpName];

type ServerOpName = { [K in OpName]: (typeof OpMutation)[K] extends "server" ? K : never }[OpName];

/**
 * What each `"server"` op does, as a read or a write (issue #165).
 *
 * `OpMutation` says only that these never reach the bridge, and
 * `READ_ONLY_SERVER_OPS` (tools/policy.ts) answers a different question —
 * whether read-only mode offers them, which drops `get_job` and `await_job`
 * for having nothing to read, not for writing. This is the plain answer, used
 * for `readOnlyHint`. Typed over every server op, so a new one does not
 * compile until it is decided: no default, like `OpMutation`.
 */
export const ServerOpEffect = {
  await_job: "read",
  get_job: "read",
  // Stops a batch or kills an aerender process.
  cancel_job: "write",
  check_setup: "read",
  setup_panel: "write",
  init_project: "write",
  ae_guide: "read",
  log_issue: "write",
  list_known_issues: "read",
  mark_issue_reported: "write",
  archive_issue: "write",
} as const satisfies Record<ServerOpName, "read" | "write">;

/**
 * Ops that write files outside After Effects' undo stack (issue #165), and
 * whether that can lose what was there.
 *
 *   "overwrites" — can replace an existing file's content: Edit > Undo does
 *                  not bring it back, so the tool is `destructiveHint: true`.
 *   "adds"       — only creates files, or merges into one without losing what
 *                  it held. Not destructive.
 *
 * An op whose arguments carry an `overwrite` field is treated as "overwrites"
 * whether or not it is listed here (tools/annotations.ts reads the schema), so
 * this table is for the ops that write disk without one. An op absent from
 * both writes nothing outside the project.
 */
export const OpDiskWrite = {
  // Saves the .aep, then writes the .mogrt (overwrite field too).
  export_mogrt: "overwrites",
  // Can save the .aep (`saveProject`) and replace render outputs.
  render_queue: "overwrites",
  // Replaces house-style.md beside the .aep.
  set_house_style: "overwrites",
  // Replaces the installed panel and can change Adobe's debug preference.
  setup_panel: "overwrites",
  // Refuses to clobber any existing file.
  init_project: "adds",
  // The journal: a repeat merges into its entry, a report or an archive adds a
  // field to it. The file and what it said are kept.
  log_issue: "adds",
  mark_issue_reported: "adds",
  archive_issue: "adds",
} as const satisfies Partial<Record<OpName, "overwrites" | "adds">>;

// ---------- runtime strictness ----------
/**
 * Every object in an op schema, closed — at every depth (issue #147).
 *
 * zod's default for an object is to **strip** a key it does not declare, and
 * the emitted JSON Schema says the opposite: `toolInputSchema()` closes every
 * object (`additionalProperties: false`), so the model is told an unknown key
 * is refused. Before this, a misspelt `positon` reached no handler, nothing
 * failed, and the tool answered `{ok: true}` for a change that never happened
 * — the swallowed error this repo refuses everywhere else. The agent never
 * learnt it had to try again.
 *
 * Writing `.strict()` on every object by hand is a rule that holds until the
 * next schema somebody adds, and the failure is invisible. So the closing is
 * done here, once, over every op: a `ZodObject` with no catchall of its own is
 * cloned with `catchall: never`, which is what `.strict()` does, and every
 * wrapper around it is cloned onto the closed copy. A clone keeps its `checks`,
 * so `crossField()` rules travel with it; it does not keep `.describe()`/
 * `.meta()`, which is why the **emitted** schema is still built from the
 * originals in `OpSchemas` and only the **parse** uses these.
 *
 * A `z.record()` or `z.unknown()` is free-form by declaration and stays so.
 * A node type this does not know is left as it was and named in
 * `STRICT_UNHANDLED`; `tests/unit/strict-args.mjs` fails the build on any, for
 * the same reason the cross-field guard throws rather than skips. It does not
 * throw here: this runs at module load, and a throw would take down every tool
 * in the session rather than leave one of them lenient.
 */
type AnyZod = z.ZodType;
interface CloneableDef {
  type: string;
  [k: string]: unknown;
}
const defOf = (s: unknown): CloneableDef => (s as { _zod: { def: CloneableDef } })._zod.def;
const cloneWith = (s: AnyZod, patch: Record<string, unknown>): AnyZod =>
  (s as unknown as { clone(def: unknown): AnyZod }).clone({ ...defOf(s), ...patch });

/** Node types that hold no object, and are returned as they are. */
const STRICT_LEAVES = new Set([
  "string", "number", "int", "boolean", "bigint", "date", "enum", "literal", "unknown", "any",
  "never", "null", "undefined", "void", "nan", "symbol", "file", "transform", "custom", "template_literal",
]);

/** Paths of nodes `strictDeep` did not know how to close. Empty in a healthy build. */
export const STRICT_UNHANDLED: string[] = [];

export function strictDeep<T extends AnyZod>(schema: T, where = "(root)"): T {
  const cache = new Map<unknown, AnyZod>();
  const walk = (node: AnyZod, path: string): AnyZod => {
    const hit = cache.get(node);
    if (hit) return hit;
    const def = defOf(node);
    let out: AnyZod;
    switch (def.type) {
      case "object": {
        const shape = def.shape as Record<string, AnyZod>;
        const closed: Record<string, AnyZod> = {};
        for (const key of Object.keys(shape)) closed[key] = walk(shape[key], `${path}.${key}`);
        // An object that declared its own catchall (`.loose()`, `.catchall(x)`)
        // said so on purpose; only the default — strip — is closed.
        const catchall = def.catchall === undefined ? z.never() : walk(def.catchall as AnyZod, `${path}.*`);
        out = cloneWith(node, { shape: closed, catchall });
        break;
      }
      case "optional":
      case "default":
      case "prefault":
      case "nullable":
      case "readonly":
      case "nonoptional":
      case "catch":
        out = cloneWith(node, { innerType: walk(def.innerType as AnyZod, path) });
        break;
      case "array":
        out = cloneWith(node, { element: walk(def.element as AnyZod, `${path}[]`) });
        break;
      case "tuple":
        out = cloneWith(node, {
          items: (def.items as AnyZod[]).map((s, i) => walk(s, `${path}[${i}]`)),
          rest: def.rest ? walk(def.rest as AnyZod, `${path}[...]`) : def.rest,
        });
        break;
      case "union":
        // Covers `discriminatedUnion` too: same node type, with a
        // `discriminator` in the def that the spread carries over.
        out = cloneWith(node, { options: (def.options as AnyZod[]).map((s, i) => walk(s, `${path}|${i}`)) });
        break;
      case "record":
        out = cloneWith(node, { valueType: walk(def.valueType as AnyZod, `${path}{}`) });
        break;
      case "pipe":
        out = cloneWith(node, { in: walk(def.in as AnyZod, path), out: walk(def.out as AnyZod, path) });
        break;
      default:
        if (!STRICT_LEAVES.has(def.type)) STRICT_UNHANDLED.push(`${where}${path === "(root)" ? "" : path}: ${def.type}`);
        out = node;
    }
    cache.set(node, out);
    return out;
  };
  return walk(schema, "") as T;
}

/**
 * `OpSchemas`, closed at every depth. **Parse with these; emit from
 * `OpSchemas`.** Used for every direct tool call and for every `run_batch`
 * step (issue #157), so a step is held to exactly what the tool itself is.
 */
export const StrictOpSchemas: { readonly [K in OpName]: (typeof OpSchemas)[K] } = Object.fromEntries(
  Object.entries(OpSchemas).map(([name, s]) => [name, strictDeep(s as AnyZod, name)])
) as { readonly [K in OpName]: (typeof OpSchemas)[K] };
