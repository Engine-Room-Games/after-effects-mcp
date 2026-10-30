// Hex colours, and property paths that miss (issue #170).
//
// Hex: a house style's palette is written in hex, and every colour field used
// to want RGB 0..1, so an agent converted by hand. Typed colour fields (bgColor,
// a solid's or text layer's color, a shape fill or stroke, ...) now take hex and
// are converted by the schema. A `value` aimed at an arbitrary property
// (add_keyframe, set_effect_param, set_shape_property) is only checked for form
// on the server: whether a colour is allowed there depends on the property, so
// After Effects converts it — and refuses it on a property that is not a colour,
// rather than writing a hex aimed at Position as three small numbers.
//
// No alpha form: measured on AE 26.5, a shape Fill Color, an effect Color and a
// text animator Fill Color all store an alpha of 0 and render exactly as with
// 1, so '#rrggbbaa' / '#rgba' are refused with a message naming Opacity.
//
// Path misses: walkProperty used to answer "segment returned null at [1]=Wobble"
// and nothing else, so the agent guessed again. It now lists what IS there —
// capped, with the remainder counted.
//
//   node tests/unit/hex-colour.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFakeAe } from "./lib/fake-ae.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sharedDist = pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href;
const serverDist = pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "server.js")).href;
const { StrictOpSchemas, hexToRgb } = await import(sharedDist);
const { toolInputSchema } = await import(serverDist);
const { prepareBatchSteps } = await import(pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "batchSteps.js")).href);

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`hex-colour FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const ORANGE = [1, 0x88 / 255, 0];
const parse = (op, args) => StrictOpSchemas[op].parse(args);
const refuses = (op, args) => assert.equal(StrictOpSchemas[op].safeParse(args).success, false, JSON.stringify(args));

// ---------------------------------------------------------------- the schema

check("hexToRgb: 3 and 6 digits, with or without #, either case", () => {
  assert.deepEqual(hexToRgb("#ff8800"), ORANGE);
  assert.deepEqual(hexToRgb("FF8800"), ORANGE);
  assert.deepEqual(hexToRgb("#f80"), ORANGE);
  assert.deepEqual(hexToRgb("#000"), [0, 0, 0]);
  assert.deepEqual(hexToRgb("#FFFFFF"), [1, 1, 1]);
});

check("a typed colour field converts hex to RGB 0..1 before it is forwarded", () => {
  assert.deepEqual(parse("create_solid_layer", { compId: 1, color: "#ff8800" }).color, ORANGE);
  assert.deepEqual(parse("create_solid_layer", { compId: 1, color: "#f80" }).color, ORANGE);
  assert.deepEqual(parse("create_comp", { bgColor: "#000000" }).bgColor, [0, 0, 0]);
  assert.deepEqual(parse("set_comp", { compId: 1, bgColor: "#fff" }).bgColor, [1, 1, 1]);
  assert.deepEqual(parse("create_text_layer", { compId: 1, color: "#ff8800" }).color, ORANGE);
  assert.deepEqual(parse("create_light_layer", { compId: 1, color: "#ff8800" }).color, ORANGE);
  const t = parse("set_text", { compId: 1, layerId: 2, fillColor: "#ff8800", strokeColor: "#000" });
  assert.deepEqual([t.fillColor, t.strokeColor], [ORANGE, [0, 0, 0]]);
  // RGB arrays are unchanged.
  assert.deepEqual(parse("create_solid_layer", { compId: 1, color: [0.1, 0.2, 0.3] }).color, [0.1, 0.2, 0.3]);
});

check("hex with alpha is refused everywhere, naming Opacity: After Effects renders a colour's alpha as 1", () => {
  const cases = [
    ["create_solid_layer", { compId: 1, color: "#ff8800cc" }],
    ["set_text", { compId: 1, layerId: 2, fillColor: "#f80c" }],
    ["add_shape_content", { compId: 1, layerId: 2, content: { type: "fill", color: "#ff8800cc" } }],
    ["add_shape_content", { compId: 1, layerId: 2, content: { type: "stroke", color: "#f80c" } }],
    ["set_effect_param", { compId: 1, layerId: 2, effectIndex: 1, paramMatchName: "x", value: "#ff000000" }],
    ["add_keyframe", { compId: 1, layerId: 2, propertyPath: ["x"], time: 0, value: "#f80c" }],
    ["set_shape_property", { compId: 1, layerId: 2, contentPath: ["x"], property: "Color", value: "#ff8800cc" }],
  ];
  for (const [op, args] of cases) {
    const r = StrictOpSchemas[op].safeParse(args);
    assert.equal(r.success, false, `${op} accepted ${JSON.stringify(args)}`);
    assert.match(JSON.stringify(r.error.issues), /ignores a colour's alpha.*Opacity/, op);
  }
});

check("a shape fill or stroke takes hex, and an RGBA array as before", () => {
  const fill = parse("add_shape_content", { compId: 1, layerId: 2, content: { type: "fill", color: "#ff8800" } });
  assert.deepEqual(fill.content.color, ORANGE);
  const stroke = parse("add_shape_content", { compId: 1, layerId: 2, content: { type: "stroke", color: "#f80" } });
  assert.deepEqual(stroke.content.color, ORANGE);
  const rgba = parse("add_shape_content", { compId: 1, layerId: 2, content: { type: "fill", color: [1, 0, 0, 1] } });
  assert.deepEqual(rgba.content.color, [1, 0, 0, 1]);
});

check("a string that is not a hex colour is refused before anything reaches After Effects", () => {
  for (const bad of ["orange", "#ff880", "#gg8800", "#ff8800cc00", "", "rgb(255,136,0)"]) {
    refuses("create_solid_layer", { compId: 1, color: bad });
    refuses("set_effect_param", { compId: 1, layerId: 2, effectIndex: 1, paramMatchName: "x", value: bad });
    refuses("add_keyframe", { compId: 1, layerId: 2, propertyPath: ["Opacity"], time: 0, value: bad });
    refuses("set_shape_property", { compId: 1, layerId: 2, contentPath: ["Contents"], property: "Color", value: bad });
  }
});

check("a property `value` passes hex through for After Effects to convert", () => {
  assert.equal(parse("set_effect_param", { compId: 1, layerId: 2, effectIndex: 1, paramMatchName: "x", value: "#ff8800" }).value, "#ff8800");
  assert.equal(parse("add_keyframe", { compId: 1, layerId: 2, propertyPath: ["x"], time: 0, value: "#f80" }).value, "#f80");
  assert.equal(parse("set_shape_property", { compId: 1, layerId: 2, contentPath: ["x"], property: "Color", value: "ff8800" }).value, "ff8800");
  // Numbers and arrays are as before.
  assert.equal(parse("add_keyframe", { compId: 1, layerId: 2, propertyPath: ["x"], time: 0, value: 50 }).value, 50);
});

check("a run_batch step is converted and refused exactly as the tool is, at any depth", () => {
  // prepareBatchSteps is what server.ts forwards a batch through.
  const good = prepareBatchSteps([
    { op: "create_solid_layer", args: { compId: 1, color: "#ff8800" } },
    { op: "run_batch", args: { ops: [{ op: "set_comp", args: { compId: 1, bgColor: "#fff" } }] } },
  ]);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.ops[0].args.color, ORANGE);
  assert.deepEqual(good.ops[1].args.ops[0].args.bgColor, [1, 1, 1]);
  const bad = prepareBatchSteps([
    { op: "create_solid_layer", args: { compId: 1, color: "#ff8800" } },
    { op: "create_solid_layer", args: { compId: 1, color: "#ff8800cc" } },
  ]);
  assert.equal(bad.problems.length, 1);
  assert.equal(bad.problems[0].path, "ops[1]");
  assert.match(bad.problems[0].problem, /Opacity/);
});

check("the emitted schema tells the model hex is accepted", () => {
  const color = toolInputSchema("create_solid_layer").properties.color;
  const kinds = (color.anyOf ?? []).map((s) => s.type);
  assert.ok(kinds.includes("string") && kinds.includes("array"), JSON.stringify(color));
  assert.match(color.description, /hex/);
  const value = toolInputSchema("set_effect_param").properties.value;
  assert.ok(JSON.stringify(value).includes('"pattern"'), JSON.stringify(value));
  assert.match(value.description, /hex/);
});

// ------------------------------------------------------------ After Effects

const FILES = ["ids.jsx", "values.jsx", "layers.jsx", "keyframes.jsx", "effects.jsx", "shapes.jsx"];

function scene() {
  const ae = loadFakeAe(FILES);
  ae.run(`
    var C = FAKE.comp(100, "Main");
    var CARD = C.addLayer(2, "Card", "av");
    CARD.property("Effects").addProperty("ADBE Fill");
    var T = PropertyValueType;
    var CONTENTS = CARD._root._add(new FakeGroup("Contents", "ADBE Root Vectors Group", false));
    var FILL = CONTENTS._add(new FakeGroup("Fill 1", "ADBE Vector Graphic - Fill", false));
    FILL._add(new FakeProperty("Color", "ADBE Vector Fill Color", [1, 1, 1, 1], T.COLOR));
    FILL._add(new FakeProperty("Opacity", "ADBE Vector Fill Opacity", 100, T.OneD));
  `);
  return ae;
}
function ok(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${res.error}`);
  return res.result;
}
function refused(res, pattern, what) {
  assert.equal(res.ok, false, `${what} should have been refused, answered ${JSON.stringify(res.result)}`);
  assert.match(res.error, pattern);
}

check("values.jsx converts hex exactly as the schema does", () => {
  const ae = loadFakeAe(["values.jsx"]);
  for (const hex of ["#ff8800", "FF8800", "#f80", "#000", "#123456", "#ABCDEF", "fff"]) {
    assert.deepEqual(ae.json(`__hexToRgb(${JSON.stringify(hex)})`), hexToRgb(hex), hex);
  }
});

check("set_effect_param writes a hex colour to a colour parameter as RGB 0..1", () => {
  const ae = scene();
  ok(ae.call("set_effect_param", { compId: 100, layerId: 2, effectIndex: 1, paramMatchName: "ADBE Fill-0002", value: "#ff8800" }), "set_effect_param");
  assert.deepEqual(ae.json(`CARD.property("Effects").property(1).property("ADBE Fill-0002").value`), ORANGE);
});

check("set_effect_param refuses hex on a parameter that is not a colour, and writes nothing", () => {
  const ae = scene();
  refused(
    ae.call("set_effect_param", { compId: 100, layerId: 2, effectIndex: 1, paramMatchName: "ADBE Fill-0005", value: "#ff8800" }),
    /'#ff8800' is a hex colour, but 'Opacity' \(ADBE Fill-0005\) is not a colour property/,
    "set_effect_param"
  );
  assert.equal(ae.json(`CARD.property("Effects").property(1).property("ADBE Fill-0005").value`), 1);
});

check("add_keyframe keys a hex colour, and refuses hex on Position without adding a key", () => {
  const ae = scene();
  ok(ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: ["Effects", "Fill", "Color"], time: 1, value: "#ff8800" }), "add_keyframe");
  assert.deepEqual(ae.json(`CARD.property("Effects").property(1).property("Color").keyValue(1)`), ORANGE);
  refused(
    ae.call("add_keyframe", { compId: 100, layerId: 2, propertyPath: ["Transform", "Position"], time: 1, value: "#ff8800" }),
    /not a colour property/,
    "add_keyframe"
  );
  assert.equal(ae.json(`CARD.property("Transform").property("Position").numKeys`), 0);
});

check("After Effects refuses an alpha hex that reached it by another route (run_jsx calling OPS), writing nothing", () => {
  const ae = scene();
  refused(
    ae.call("set_effect_param", { compId: 100, layerId: 2, effectIndex: 1, paramMatchName: "ADBE Fill-0002", value: "#ff880000" }),
    /not a hex colour.*alpha is ignored/,
    "set_effect_param"
  );
  assert.deepEqual(ae.json(`CARD.property("Effects").property(1).property("ADBE Fill-0002").value`), [1, 0, 0, 1]);
});

check("set_shape_property writes a hex colour to a shape fill", () => {
  const ae = scene();
  ok(ae.call("set_shape_property", { compId: 100, layerId: 2, contentPath: ["Contents", "Fill 1"], property: "Color", value: "#f80" }), "set_shape_property");
  assert.deepEqual(ae.json(`FILL.property("Color").value`), ORANGE);
});

// ------------------------------------------------------- property path misses

check("a path that misses lists the children of the group it missed in", () => {
  const ae = scene();
  const res = ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Transform", "Positon"] });
  refused(res, /no "Positon" \(segment 1\) under \["Transform"\]/, "get_keyframes");
  for (const name of ["'Anchor Point' = ADBE Anchor Point", "'Position' = ADBE Position", "'Opacity' = ADBE Opacity"]) {
    assert.ok(res.error.includes(name), `${name} missing from: ${res.error}`);
  }
  assert.doesNotMatch(res.error, /more not listed/);
});

check("a miss on the first segment lists the layer's own groups", () => {
  const ae = scene();
  const res = ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Effect", "Fill", "Color"] });
  refused(res, /no "Effect" \(segment 0\) under the layer/, "get_keyframes");
  assert.match(res.error, /'Effects' = ADBE Effect Parade/);
});

check("a 1-based index past the end lists the children and says what the number means", () => {
  const ae = scene();
  refused(
    ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Transform", 9] }),
    /no 9 \(segment 1\).*'Rotation' = ADBE Rotate Z.*A number is a 1-based index/,
    "get_keyframes"
  );
});

check("a path that runs past a leaf property says the path ends there", () => {
  const ae = scene();
  refused(
    ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Transform", "Position", "X"] }),
    /no "X" \(segment 2\) under \["Transform", "Position"\] \('Position', ADBE Position\)\. That is a property with no children/,
    "get_keyframes"
  );
});

check("a long list of children is capped, and the rest are counted, not dumped", () => {
  const ae = scene();
  ae.run(`
    var BIG = CARD._root._add(new FakeGroup("Big", "ADBE Big", false));
    for (var i = 1; i <= 45; i++) BIG._add(new FakeProperty("P" + i, "ADBE P" + i, 0, PropertyValueType.OneD));
  `);
  const res = ae.call("get_keyframes", { compId: 100, layerId: 2, propertyPath: ["Big", "Nope"] });
  refused(res, /and 15 more not listed/, "get_keyframes");
  assert.ok(res.error.includes("'P30' = ADBE P30"));
  assert.ok(!res.error.includes("'P31'"), "listed past the cap");
});

check("set_shape_property naming a property the node lacks lists what it has, and writes nothing", () => {
  const ae = scene();
  refused(
    ae.call("set_shape_property", { compId: 100, layerId: 2, contentPath: ["Contents", "Fill 1"], property: "Colour", value: [1, 0, 0] }),
    /no property "Colour" on 'Fill 1' .*'Color' = ADBE Vector Fill Color; 'Opacity' = ADBE Vector Fill Opacity/,
    "set_shape_property"
  );
  assert.deepEqual(ae.json(`FILL.property("Color").value`), [1, 1, 1, 1]);
});

console.log(`hex-colour: ${passed} checks passed`);
