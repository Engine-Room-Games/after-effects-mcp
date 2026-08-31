import { z } from "zod";

/**
 * Single source of truth for op input contracts. The MCP server uses these as
 * tool input schemas (via zod-to-json-schema). The ExtendScript side validates
 * loosely — it trusts that the MCP server already validated.
 */

// ---------- primitives ----------
export const Color = z.tuple([z.number(), z.number(), z.number()]).describe("RGB 0..1");
export const ColorRGBA = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Vec2 = z.tuple([z.number(), z.number()]);
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const VecAny = z.union([z.number(), Vec2, Vec3, z.array(z.number())]);

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

// ---------- comps ----------
export const ListComps = z
  .object({
    include: includeParam(["size", "timing", "bg", "counts"], "id + name only"),
  })
  .strict();
export const GetComp = z.object({ compId: z.number() });
export const GetCompTree = z.object({ compId: z.number(), depth: z.number().int().min(0).max(8).default(2).optional() });
export const CreateComp = z.object({
  name: z.string().default("Untitled"),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  frameRate: z.number().positive().default(30),
  duration: z.number().positive().default(5),
  pixelAspect: z.number().positive().default(1).optional(),
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
export const DeleteComp = z.object({ compId: z.number() });
export const SetActiveComp = z.object({ compId: z.number() });
export const DuplicateComp = z
  .object({
    compId: z.number(),
    name: z.string().optional().describe("Name for the copy. Omit to take AE's own ('<name> 2')."),
    folderId: z.number().optional()
      .describe("Project folder to put the copy in. Must be a folder item id from get_project_summary."),
    deep: z.boolean().default(false).optional()
      .describe(
        "Also duplicate the nested precomps and re-point the copy's layers at them. Off by default, which matches AE's own Duplicate: a shallow copy shares its nested comps with the original, so editing one edits both."
      ),
    nameSuffix: z.string().optional()
      .describe("With deep:true, name each duplicated nested comp '<original><nameSuffix>'. Omit to let AE name them."),
  })
  .strict();

// ---------- comp snapshots (half server-resident: the panel gathers, the server remembers) ----------
export const SnapshotComp = z
  .object({
    compId: z.number(),
    includeFingerprint: z.boolean().default(false).optional()
      .describe(
        "Return the fingerprint itself as well as its id. Off by default — returning it reintroduces exactly the context cost a snapshot exists to avoid."
      ),
  })
  .strict();
export const DiffComp = z
  .object({
    since: z.string().describe("A snapshotId from an earlier snapshot_comp or diff_comp."),
    compId: z.number().optional().describe("Defaults to the comp the snapshot was taken of; pass it only to assert which comp you mean."),
    includeFingerprint: z.boolean().default(false).optional()
      .describe("Return the new fingerprint as well as the diff. Off by default."),
  })
  .strict();

// ---------- layers ----------
export const ListLayers = z.object({
  compId: z.number(),
  include: includeParam(["flags", "timing", "parent"], "the id/index/name/type map alone"),
});
export const GetLayerFull = z.object({
  compId: z.number(),
  layerId: z.number(),
  includeChildren: z.boolean().default(false).optional(),
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
    .default(false)
    .optional()
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
  anchorAlign: z.enum(["left", "center", "right", "none"]).default("left").optional()
    .describe("How the text aligns to `position`, implemented as live paragraph justification with the anchor point left at [0,0]. Default 'left' makes `position` the start of the first baseline; 'center' and 'right' put it at the centre/end. Because it is justification rather than a measured anchor offset, the alignment stays correct when the Source Text changes later — retyped, driven by an expression, or edited through Essential Graphics. 'none' leaves AE's raw defaults alone: no justification, no anchor move, no tracking reset."),
  name: z.string().optional(),
});
export const CreateShapeLayer = z.object({
  compId: z.number(),
  name: z.string().optional(),
  shapes: z.array(z.record(z.string(), z.unknown())).default([]),
  fill: Color.optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().nonnegative().optional(),
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
export const DuplicateLayer = z.object({ compId: z.number(), layerId: z.number(), count: z.number().int().positive().default(1).optional() });
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
  blendingMode: z.string().optional(),
  label: z.number().int().min(0).max(16).optional(),
  inPoint: z.number().optional(),
  outPoint: z.number().optional(),
  startTime: z.number().optional(),
  stretch: z.number().optional(),
  preserveTransparency: z.boolean().optional(),
  trackMatte: z.object({ type: z.string(), layerId: z.number().optional() }).optional(),
});
export const ParentLayer = z.object({
  compId: z.number(),
  layerId: z.number(),
  parentLayerId: z.number().nullable(),
  preserveTransform: z.boolean().default(true).optional()
    .describe("Keep the layer visually where it is (what AE's UI does). Leave on unless you want the layer to jump into the parent's coordinate space."),
});
export const ReorderLayer = z.object({ compId: z.number(), layerId: z.number(), toIndex: z.number().int().positive() });

// ---------- transforms ----------
export const SetTransform = z.object({
  compId: z.number(),
  layerId: z.number(),
  time: z.number().optional(),
  keyframe: z.boolean().default(false).optional(),
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
});

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
export const SetTemporalEase = z.object({
  compId: z.number(),
  layerId: z.number(),
  propertyPath: PropertyPath,
  keyIndex: z.number().int().positive(),
  easeIn: z.object({ influence: z.number(), speed: z.number() }).optional()
    .describe("One influence/speed pair, applied to every dimension of the property. At least one of easeIn/easeOut is required."),
  easeOut: z.object({ influence: z.number(), speed: z.number() }).optional()
    .describe("One influence/speed pair, applied to every dimension of the property."),
});
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
export const ListEffects = z.object({ compId: z.number(), layerId: z.number() });
export const AddEffect = z.object({ compId: z.number(), layerId: z.number(), matchName: z.string() });
export const RemoveEffect = z.object({ compId: z.number(), layerId: z.number(), effectIndex: z.number().int().positive() });
export const SetEffectParam = z.object({
  compId: z.number(),
  layerId: z.number(),
  effectIndex: z.number().int().positive(),
  paramName: z.string().optional(),
  paramMatchName: z.string().optional(),
  value: VecAny,
  time: z.number().optional(),
  keyframe: z.boolean().default(false).optional(),
});
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
  closed: z.boolean().default(true).optional(),
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
    fillRule: z.number().optional(),
  }).strict(),
  z.object({
    type: z.literal("stroke"),
    name: z.string().optional(),
    color: ShapeColor.optional(),
    opacity: z.number().optional().describe("0..100"),
    width: z.number().optional(),
    lineCap: z.number().optional(),
    lineJoin: z.number().optional(),
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
export const SetShapeProperty = z.object({
  compId: z.number(),
  layerId: z.number(),
  contentPath: PropertyPath,
  property: z.string(),
  value: VecAny,
  time: z.number().optional(),
  keyframe: z.boolean().default(false).optional(),
});

// ---------- masks ----------
export const AddMask = z.object({
  compId: z.number(),
  layerId: z.number(),
  vertices: z.array(Vec2),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().default(true).optional(),
  mode: z.string().default("ADD").optional(),
});
export const SetMask = z.object({
  compId: z.number(),
  layerId: z.number(),
  maskIndex: z.number().int().positive(),
  vertices: z.array(Vec2).optional(),
  inTangents: z.array(Vec2).optional(),
  outTangents: z.array(Vec2).optional(),
  closed: z.boolean().optional(),
  mode: z.string().optional(),
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
  duration: z.number().nonnegative().default(0).optional(),
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
    "Render at 1/N resolution. Omit and one is chosen from the comp size (long edge ~1280px: 2 at 1080p, 3 at 4K). Pass 1 for a full-resolution frame."
  );
export const ScreenshotFrame = z
  .object({
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
  })
  // Enforced here rather than in the panel: two readings of "which frame did
  // you want" reaching ExtendScript at all is a contract the schema should
  // never have let through.
  .refine((v) => !(v.time !== undefined && v.times !== undefined), {
    message: "Pass either `time` (one frame) or `times` (a contact sheet), not both.",
    path: ["times"],
  });
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
  .default(false)
  .optional()
  .describe(
    "Fingerprint the comp before and after this call and append only what changed (layers added/removed/renamed/retimed/re-parented, keyframe counts, expression and effect counts). A few dozen tokens instead of reading the comp back. If the call fails, the diff of what landed before it stopped is appended to the error."
  );
const diffCompIdParam = z
  .number()
  .optional()
  .describe("Which comp `diff` should fingerprint. Defaults to the comps this call names, else the comp open in the viewer.");

// ---------- batch ----------
export const RunBatch = z.object({
  ops: z.array(z.object({ op: z.string(), args: z.unknown() })),
  transactional: z.boolean().default(true).optional()
    .describe("Stop at the first failing op instead of running the rest. Nothing rolls back either way — the ops before the failure stay applied, and the error says where it stopped."),
  undoGroupName: z.string().default("AE MCP Batch").optional()
    .describe("What the user sees in After Effects' Edit > Undo menu. A chunked batch numbers its steps from this, e.g. \"AE MCP Batch (3)\"."),
  singleUndo: z.boolean().default(false).optional()
    .describe("Force the whole batch into ONE undo step, whatever its size, by running it in a single blocking ExtendScript call. Up to 2000 ops. The cost is real: After Effects' interface is frozen for the entire batch and no progress is reported, so the user sees nothing until it finishes. Without it a batch over 500 ops is chunked and lands as one undo step per chunk of 25 — the result reports the exact count. Reach for this only when the user has to be able to undo the work with a single Cmd-Z."),
  diff: diffParam,
  diffCompId: diffCompIdParam,
});

// ---------- explore ----------
export const GetProjectSummary = z.object({}).strict();
export const FindLayers = z.object({
  compId: z.number().optional(),
  namePattern: z.string().optional(),
  type: z.string().optional(),
  hasEffectMatchName: z.string().optional(),
});

// ---------- raw ----------
export const RunJsx = z.object({
  code: z.string().optional()
    .describe("The ExtendScript to run. Exactly one of `code` or `scriptPath`."),
  scriptPath: z.string().optional()
    .describe("Absolute path to a .jsx file to run instead of `code`. The server reads it, so a long script never enters the conversation. Exactly one of `code` or `scriptPath`."),
  libraries: z.array(z.string()).optional()
    .describe("Absolute paths to .jsx files evaluated at global scope before the script, once per After Effects session. Re-passing an unchanged file is free; editing it re-evaluates it. Put shared helpers here rather than pasting them into every script."),
  undoGroup: z.boolean().default(true).optional()
    .describe("Wrap the script in one undo step. Set false only for the operations AE refuses while an undo group is open — copyToComp on a layer with a parent or a linked expression. The script's changes then land as whatever undo steps AE records on its own."),
  diff: diffParam,
  diffCompId: diffCompIdParam,
});

// ---------- footage ----------
export const ImportFootage = z
  .object({
    path: z.string().min(1).describe("Absolute path to the file to import."),
    name: z.string().optional().describe("Rename the project item after import. Omit to keep the filename."),
    sequence: z.boolean().default(false).optional()
      .describe("Import a numbered still as an image sequence rather than a single frame."),
    force: z.boolean().default(false).optional()
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
  })
  .strict();
export const PlaceAudioCues = z
  .object({
    compId: z.number(),
    cues: z.array(AudioCue).min(1).max(200),
    namePrefix: z.string().default("SFX_").optional()
      .describe("Prefix for cues that do not name themselves. Pass \"\" for no prefix."),
    dryRun: z.boolean().default(false).optional()
      .describe("Resolve and check the whole list without importing, creating or changing anything — not even an undo step. Reports which paths do not exist and what would be placed."),
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
    overwrite: z.boolean().default(false).optional()
      .describe("Required to replace an existing .mogrt at that path."),
    posterTime: z.number().optional()
      .describe(
        "Comp time to render as the template's still thumbnail, replacing the black one AE writes. Omit to leave AE's thumbnail alone."
      ),
    suppressDialogs: z.boolean().default(true).optional()
      .describe(
        "Suppress the modal font warning during export. Leave true: an unsuppressed dialog freezes the bridge until someone clicks it in AE. Set false only to see the dialog deliberately."
      ),
  })
  .strict();

// ---------- house style (a markdown file beside the .aep, read over the bridge) ----------
export const GetHouseStyle = z
  .object({
    detail: z.enum(["summary", "full"]).default("summary").optional()
      .describe(
        "'summary' (default) is a few hundred tokens: palette as named hexes, type, motion defaults, layout rules, and what it could not summarise. 'full' returns the whole document — use it before editing the guide with set_house_style, or when the summary is not enough."
      ),
  })
  .strict();
export const SetHouseStyle = z
  .object({
    content: z.string().min(1).describe("The complete style guide as markdown. Replaces the file, so send the whole document."),
    overwrite: z.boolean().default(false).optional()
      .describe("Required to replace an existing guide. Read it with get_house_style and merge first — this is not a patch."),
  })
  .strict();

// ---------- jobs ----------
// ---------- setup (handled in the MCP server, never forwarded to the panel) ----------
export const CheckSetup = z.object({}).strict();
export const SetupPanel = z.object({
  enableDebugMode: z.boolean().default(true).optional()
    .describe("Also enable Adobe's PlayerDebugMode preference, which AE requires to load this unsigned panel. Default true."),
  force: z.boolean().default(false).optional()
    .describe("Replace an existing symlinked (development) install with a copy. Default false."),
}).strict();

/**
 * Guide topics. The prose lives in `packages/mcp-server/src/guides/*.md`, but the
 * names are part of the tool contract, so they are declared here and
 * `scripts/build-guides.mjs` fails the build if the two ever disagree.
 */
export const GUIDE_TOPICS = ["ae-setup", "after-effects", "extendscript-gotchas", "style-guide", "whats-new"] as const;
export const AeGuide = z
  .object({
    topic: z.enum(GUIDE_TOPICS).describe(
      "after-effects: building, animating, easing, expressions, the traps — start here. extendscript-gotchas: read before writing raw ExtendScript for run_jsx. whats-new: what changed recently, when a call behaves differently from what you expected. style-guide: capturing the user's look. ae-setup: connecting to AE when a tool cannot reach it."
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
      .default("auto").optional()
      .describe("Which client's layout to write. 'auto' detects it from the MCP handshake — leave it alone unless the user says otherwise."),
    withMcpConfig: z.boolean().default(false).optional()
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
    tools: z.array(z.string()).optional().describe("Tool names involved, e.g. ['set_temporal_ease']."),
    scope: z.enum(["project", "user"]).default("project").optional()
      .describe(
        "'project' (default) for this project's footage, comps or files. 'user' for how these tools or After Effects behave — that journal travels with the person, so every future project starts knowing it. Reported back as 'home' when there is no project folder to write into."
      ),
  })
  .strict();
export const ListKnownIssues = z
  .object({
    status: z.enum(["all", "unreported", "reported"]).default("all").optional(),
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
      .default("index")
      .optional()
      .describe(
        "'index' (default) is one line per entry: id, title, tools, counts and a one-line summary — read the one you need with `id`. 'full' returns every matching entry's whole body and costs thousands of tokens."
      ),
    scope: z.enum(["all", "project", "user"]).default("all").optional()
      .describe(
        "Which journal to read. 'all' (default) merges this project's with the user's cross-project one and tags every entry with the scope it came from."
      ),
    limit: z.number().int().positive().max(500).default(50).optional()
      .describe("Most entries to return. Anything held back is counted in `omitted`."),
  })
  .strict();
export const MarkIssueReported = z
  .object({
    id: z.string().describe("The entry id returned by log_issue or list_known_issues. Prefix with its scope ('user:my-entry') when the same id exists in both journals."),
    url: z.string().optional().describe("Link to the issue that was opened."),
  })
  .strict();

export const AwaitJob = z.object({ jobId: z.string(), timeoutMs: z.number().int().positive().default(600_000).optional() });
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
  find_layers: FindLayers,
  // footage
  import_footage: ImportFootage,
  create_footage_layer: CreateFootageLayer,
  // audio
  place_audio_cues: PlaceAudioCues,
  // motion graphics templates
  export_mogrt: ExportMogrt,
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
  // borrows the comp's resolutionFactor and restores it in a `finally`;
  // nothing in the project changes.
  screenshot_frame: "read",
  screenshot_layer: "read",
  // batch
  run_batch: "write",
  // explore
  get_project_summary: "read",
  find_layers: "read",
  // footage
  import_footage: "write",
  create_footage_layer: "write",
  // audio cues — imports footage and adds layers.
  place_audio_cues: "write",
  // motion graphics templates — saves the project before exporting.
  export_mogrt: "write",
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
} as const satisfies Record<OpName, "write" | "read" | "server">;

export type OpEffect = (typeof OpMutation)[OpName];
