// get_layer_full's shape walk, run out of packages/jsx/explore.jsx.
//
// AE hangs a 48-property Material Options group — the 3D extrusion model for
// the Cinema 4D renderer — off every single vector group, and a full group
// Transform whether or not anyone has touched it. On a 2D shape layer, which
// is nearly all of them, none of it means anything: one 68x68 circle in one
// group cost 4,400 tokens to read, about 40 of which were the geometry
// (issue #42). A tool result is re-sent on every later request, so that is
// paid again for the rest of the session.
//
// What this locks in:
//   - Material Options never comes back unless it is asked for, and the skip
//     is counted rather than silent.
//   - A group Transform still at its creation values collapses to
//     `atDefaults`, and one that is modified, keyframed or expression-driven
//     never does.
//   - `index` stays the real index whatever was skipped, so a path built from
//     the response still addresses the node it names.
//   - shapeDetail:"compact" says the same things in a fraction of the bytes.
//
// There is no ExtendScript runtime on a runner, so the property tree is
// stubbed: numProperties + property(i), which is all the walk uses.
//
//   node tests/unit/shape-read.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "packages", "jsx", "explore.jsx"), "utf8");

// explore.jsx assumes core.jsx has run. It needs nothing else at load time.
const ctx = { OPS: {}, noUndo: (fn) => fn };
vm.createContext(ctx);
vm.runInContext(source, ctx, { filename: "explore.jsx" });

// Everything under test has to be built inside the VM realm: `instanceof Array`
// compares against that realm's Array, and the walk leans on it.
vm.runInContext(
  `
  var PropertyType = { NAMED_GROUP: "namedGroup", INDEXED_GROUP: "indexedGroup" };

  function grp(name, matchName, kids) {
    return {
      name: name, matchName: matchName,
      propertyType: PropertyType.NAMED_GROUP,
      numProperties: kids.length,
      property: function (i) { return kids[i - 1]; }
    };
  }
  function leaf(name, matchName, value, opts) {
    var p = {
      name: name, matchName: matchName,
      propertyType: "leafProperty",
      value: value, numKeys: 0, canSetExpression: true, expression: ""
    };
    if (opts) { for (var k in opts) p[k] = opts[k]; }
    return p;
  }

  // The seven properties AE gives a vector group's Transform, at the values it
  // gives them. \`overrides\` replaces one of them by matchName.
  function vectorTransform(overrides) {
    var kids = [
      leaf("Anchor Point", "ADBE Vector Anchor", [0, 0]),
      leaf("Position", "ADBE Vector Position", [0, 0]),
      leaf("Scale", "ADBE Vector Scale", [100, 100]),
      leaf("Skew", "ADBE Vector Skew", 0),
      leaf("Skew Axis", "ADBE Vector Skew Axis", 0),
      leaf("Rotation", "ADBE Vector Rotation", 0),
      leaf("Opacity", "ADBE Vector Group Opacity", 100)
    ];
    if (overrides) {
      for (var i = 0; i < kids.length; i++) {
        if (overrides[kids[i].matchName]) kids[i] = overrides[kids[i].matchName];
      }
      if (overrides.extra) kids.push(overrides.extra);
    }
    return grp("Transform", "ADBE Vector Transform Group", kids);
  }

  // 48 properties, the real count, so the size claims mean something.
  function materials() {
    var kids = [];
    var faces = ["Front", "Bevel", "Side", "Back"];
    var attrs = ["Color", "Ambient", "Diffuse", "Specular", "Shininess", "Metal",
                 "Reflection", "Gloss", "Fresnel", "Xparency", "XparRoll", "IOR"];
    for (var f = 0; f < faces.length; f++) {
      for (var a = 0; a < attrs.length; a++) {
        kids.push(leaf(faces[f] + " " + attrs[a], "ADBE Vec3D " + faces[f] + " " + attrs[a], 100));
      }
    }
    return grp("Material Options", "ADBE Vector Materials Group", kids);
  }

  // The reported layer: one group holding one 68x68 ellipse and one fill.
  function lampContents(transform) {
    return grp("Contents", "ADBE Root Vectors Group", [
      grp("l", "ADBE Vector Group", [
        leaf("Blend Mode", "ADBE Vector Blend Mode", 1),
        grp("Contents", "ADBE Vectors Group", [
          grp("Ellipse Path 1", "ADBE Vector Shape - Ellipse", [
            leaf("Shape Direction", "ADBE Vector Shape Direction", 1),
            leaf("Size", "ADBE Vector Ellipse Size", [68, 68]),
            leaf("Position", "ADBE Vector Ellipse Position", [0, 0])
          ]),
          grp("Fill 1", "ADBE Vector Graphic - Fill", [
            leaf("Color", "ADBE Vector Fill Color", [1, 0.6627450980392157, 0.1568627450980392, 1]),
            leaf("Opacity", "ADBE Vector Fill Opacity", 100, { numKeys: 3 })
          ])
        ]),
        transform || vectorTransform(null),
        materials()
      ])
    ]);
  }

  function lampLayer(transform) {
    var contents = lampContents(transform);
    return { property: function (n) { if (n === "Contents") return contents; return null; } };
  }
  `,
  ctx,
);

const run = (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, ctx)));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

// Walk a serialized tree looking for a node by matchName.
function find(nodes, matchName) {
  for (const n of nodes ?? []) {
    if (n.matchName === matchName) return n;
    const hit = find(n.children, matchName);
    if (hit) return hit;
  }
  return null;
}

// ---------- the default read ----------
{
  const shape = run("__serializeShape(lampLayer(null), 4, {})");
  eq(find(shape.contents, "ADBE Vector Materials Group"), null, "Material Options must not come back unasked");
  eq(shape.materialsOmitted, 1, "the skip is counted, not silent");
  ok(/shapeMaterials/.test(shape.materialsNote), "the note has to name the way back in");

  const tr = find(shape.contents, "ADBE Vector Transform Group");
  ok(tr, "the Transform group itself is still listed — it is where you animate");
  eq(tr.atDefaults, true, "an untouched group Transform collapses");
  eq(tr.children, undefined, "…and does not also spell out its seven properties");

  // The geometry — the only reason anyone made this call — survives intact.
  eq(find(shape.contents, "ADBE Vector Ellipse Size").value, [68, 68], "the geometry is untouched");
  eq(find(shape.contents, "ADBE Vector Fill Opacity").value, 100, "so is the fill");
}

// ---------- opting back in ----------
{
  const shape = run("__serializeShape(lampLayer(null), 4, {shapeMaterials: true})");
  const mats = find(shape.contents, "ADBE Vector Materials Group");
  ok(mats, "shapeMaterials:true brings the block back");
  eq(mats.children.length, 48, "all 48 of them");
  eq(shape.materialsOmitted, undefined, "nothing was omitted, so nothing is claimed");
}

// ---------- what must never collapse ----------
{
  const cases = [
    ["a scaled group", `vectorTransform({"ADBE Vector Scale": leaf("Scale", "ADBE Vector Scale", [50, 50])})`],
    ["a keyframed group", `vectorTransform({"ADBE Vector Position": leaf("Position", "ADBE Vector Position", [0, 0], {numKeys: 2})})`],
    ["an expression-driven group", `vectorTransform({"ADBE Vector Rotation": leaf("Rotation", "ADBE Vector Rotation", 0, {expression: "time*10"})})`],
    // A future AE adding a property has to fail the test rather than be folded
    // away unread: "at defaults" would be a claim about something never looked at.
    ["a Transform with a property this build has never seen", `vectorTransform({extra: leaf("Warp", "ADBE Vector Warp", 0)})`],
  ];
  for (const [label, expr] of cases) {
    const shape = run(`__serializeShape(lampLayer(${expr}), 4, {})`);
    const tr = find(shape.contents, "ADBE Vector Transform Group");
    eq(tr.atDefaults, undefined, `${label}: must not be reported as at defaults`);
    ok(tr.children && tr.children.length >= 7, `${label}: its properties have to be serialized`);
  }
}

// ---------- indices stay real ----------
{
  // Material Options is index 4 inside the group; the Transform before it is 3.
  // Skipping a sibling must not renumber anything, or a contentPath built from
  // this response addresses the wrong node.
  const shape = run("__serializeShape(lampLayer(null), 4, {})");
  const group = shape.contents[0];
  eq(group.children.map((c) => c.index), [1, 2, 3], "indices are AE's, not the response's");
  eq(group.children[2].matchName, "ADBE Vector Transform Group", "and they still point at the right nodes");
}

// ---------- depth still bounds the walk, and still says so ----------
{
  const shape = run("__serializeShape(lampLayer(null), 1, {})");
  const inner = find(shape.contents, "ADBE Vectors Group");
  ok(inner.childrenOmitted > 0, "a walk that stopped early has to say where");
  eq(inner.children, undefined, "…and not look like an empty group");
}

// ---------- compact ----------
{
  const shape = run(`__serializeShape(lampLayer(null), 4, {shapeDetail: "compact"})`);
  eq(shape.detail, "compact", "the form is echoed, so a compact answer is never read as the full one");
  ok(Array.isArray(shape.contents), "compact is a list of lines");
  const text = shape.contents.join("\n");

  ok(/Size=\[68,68\]/.test(text), "the size is on the line");
  ok(/Color=\[1,0\.6627,0\.1569,1\]/.test(text), "float noise is rounded off, but the colour still round-trips to #ffa928");
  ok(/Opacity=100 \[3 keys\]/.test(text), "an animated property is marked, or compact would hide the animation");
  ok(/\(at defaults\)/.test(text), "the untouched Transform is named and dismissed in one line");
  ok(!/Vec3D/.test(text), "no material properties");
  eq(shape.materialsOmitted, 1, "and the skip is counted here too");
  ok(/Ellipse Path 1/.test(text) && /Fill 1/.test(text), "every node the write tools address by name is still named");

  // The reason it exists.
  const full = JSON.stringify(run("__serializeShape(lampLayer(null), 4, {})"), null, 2).length;
  const compact = JSON.stringify(shape, null, 2).length;
  ok(compact * 3 < full, `compact should be several times smaller: ${compact} vs ${full}`);

  // Depth bounds it the same way, and says so the same way.
  const shallow = run(`__serializeShape(lampLayer(null), 1, {shapeDetail: "compact"})`);
  ok(/sub-groups not walked/.test(shallow.contents.join("\n")), "a compact walk that stopped early has to say so");
}

// ---------- an unreadable Contents is reported, not dropped ----------
{
  const shape = run(`__serializeShape({property: function () { throw new Error("Object is invalid"); }}, 4, {})`);
  ok(/Object is invalid/.test(shape.error), "a shape layer with no readable contents must not look like one with no shapes");
}

console.log(`shape-read: ${passed} assertions passed`);
