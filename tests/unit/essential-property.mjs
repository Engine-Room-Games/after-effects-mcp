// add_essential_property, out of packages/jsx/mogrt.jsx (issue #177).
//
// export_mogrt refuses a comp whose Essential Graphics panel is empty (#71),
// and the only remedy used to be the user dragging a property in by hand. This
// op adds one through `Property.addToMotionGraphicsTemplate[As]`, whose answer
// is a bare boolean — so the op reads the panel back and trusts that instead.
//
// What this locks in:
//   - A property AE says it can add is added, and the result reports the
//     controller found by comparing the panel's names before and after —
//     whichever end of the list AE puts it at.
//   - `name` goes through addToMotionGraphicsTemplateAs, is read back, and is
//     corrected once with setMotionGraphicsControllerName if AE ignored it; a
//     name that still does not take is a throw, not an ok.
//   - A group, a property canAdd refuses, and an AE without the API are all
//     refused before anything is added.
//   - An add that leaves the count where it was is a refusal, whatever the
//     boolean said; a "false" that did add a controller is reported as added.
//   - export_mogrt's zero-controller refusal now points at this tool.
//
//   node tests/unit/essential-property.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jsxDir = path.join(root, "packages", "jsx");
const read = (f) => fs.readFileSync(path.join(jsxDir, f), "utf8");
const sources = [["ids.jsx", read("ids.jsx")], ["expressions.jsx", read("expressions.jsx")], ["mogrt.jsx", read("mogrt.jsx")]];

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`essential-property FAILED: ${name}`);
    throw e;
  }
  passed++;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PropertyValueType = {
  NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417,
  COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423,
  TEXT_DOCUMENT: 6424,
};

class CompItem {}

/**
 * @param opts.order        "newestFirst" | "newestLast" — where AE lists a new controller.
 * @param opts.existing     controller names already in the panel.
 * @param opts.canAdd       canAddToMotionGraphicsTemplate's answer.
 * @param opts.adds         whether the add actually creates a controller.
 * @param opts.returns      what the add returns.
 * @param opts.ignoresName  AE adds under the property's own name whatever it was asked.
 * @param opts.renameWorks  setMotionGraphicsControllerName takes effect.
 * @param opts.noApi        the property has none of the three methods.
 * @param opts.group        the path ends at a property group.
 * @param opts.noCount      the comp will not report a controller count.
 */
function scene(opts = {}) {
  const log = [];
  const names = (opts.existing || []).slice();
  const comp = new CompItem();
  comp.id = 100;
  comp.numLayers = 1;
  comp.motionGraphicsTemplateName = "Untitled";
  Object.defineProperty(comp, "motionGraphicsTemplateControllerCount", {
    get() { if (opts.noCount) throw new Error("no"); return names.length; },
  });
  comp.getMotionGraphicsTemplateControllerName = (i) => {
    if (i < 1 || i > names.length) throw new Error("index out of range");
    return names[i - 1];
  };
  comp.setMotionGraphicsControllerName = (i, n) => {
    log.push(`rename:${i}:${n}`);
    if (opts.renameWorks !== false) names[i - 1] = n;
  };

  const add = (label) => {
    if (opts.adds === false) return opts.returns ?? false;
    if (opts.order === "newestLast") names.push(label);
    else names.unshift(label);
    return opts.returns ?? true;
  };
  const prop = {
    name: "Source Text",
    propertyType: opts.group ? PropertyType.NAMED_GROUP : PropertyType.PROPERTY,
    propertyValueType: opts.valueType ?? PropertyValueType.TEXT_DOCUMENT,
  };
  if (!opts.noApi) {
    prop.canAddToMotionGraphicsTemplate = (c) => { log.push("canAdd"); assert.equal(c, comp); return opts.canAdd !== false; };
    prop.addToMotionGraphicsTemplate = (c) => { log.push("add"); assert.equal(c, comp); return add("Source Text"); };
    prop.addToMotionGraphicsTemplateAs = (c, n) => {
      log.push(`addAs:${n}`);
      assert.equal(c, comp);
      return add(opts.ignoresName ? "Source Text" : n);
    };
  }
  const layer = { id: 7, property: (n) => (n === "Source Text" ? prop : null) };
  comp.layer = () => layer;

  const ctx = { OPS: {}, noUndo: (fn) => fn, Error, String, Math, PropertyType, PropertyValueType, CompItem };
  vm.createContext(ctx);
  for (const [filename, src] of sources) vm.runInContext(src, ctx, { filename });
  ctx.getCompById = (id) => { assert.equal(id, 100); return comp; };
  const call = (extra) => ctx.OPS.add_essential_property({ compId: 100, layerId: 7, propertyPath: ["Source Text"], ...extra });
  return { call, log, names, comp };
}

function messageOf(fn) {
  try { fn(); } catch (e) { return String(e.message); }
  throw new assert.AssertionError({ message: "expected a throw, got a result" });
}

// ---------- the happy path, in both list orders ----------

for (const order of ["newestFirst", "newestLast"]) {
  check(`adds the property and finds the new controller (${order})`, () => {
    const { call, log, names } = scene({ order, existing: ["Title", "Accent"] });
    const r = plain(call());
    assert.equal(r.ok, true);
    assert.equal(r.controllerCount, 3);
    assert.equal(r.controllerName, "Source Text");
    assert.equal(names[r.controllerIndex - 1], "Source Text", "the index must point at the new controller");
    assert.equal(r.controllerIndex, order === "newestFirst" ? 1 : 3);
    assert.deepEqual(log, ["canAdd", "add"]);
    assert.equal(r.templateName, "Untitled");
    assert.equal(r.note, undefined);
  });

  check(`a name is passed to addToMotionGraphicsTemplateAs and read back (${order})`, () => {
    const { call, log } = scene({ order, existing: ["Title"] });
    const r = plain(call({ name: "Headline" }));
    assert.equal(r.controllerName, "Headline");
    assert.deepEqual(log, ["canAdd", "addAs:Headline"]);
  });
}

check("into an empty panel: count goes 0 -> 1", () => {
  const { call } = scene({ existing: [] });
  const r = plain(call({ name: "Headline" }));
  assert.equal(r.controllerCount, 1);
  assert.equal(r.controllerIndex, 1);
});

check("a name AE ignored is corrected once on the found index", () => {
  const { call, log } = scene({ order: "newestLast", existing: ["A", "B"], ignoresName: true });
  const r = plain(call({ name: "Headline" }));
  assert.equal(r.controllerName, "Headline");
  assert.ok(log.includes("rename:3:Headline"), "the rename must target the new controller's index");
});

check("a name that will not take is a throw, not an ok", () => {
  const { call } = scene({ existing: [], ignoresName: true, renameWorks: false });
  const msg = messageOf(() => call({ name: "Headline" }));
  assert.match(msg, /was added .* under the name "Source Text", not "Headline"/);
  assert.match(msg, /undo this step/);
});

// ---------- refusals before anything is added ----------

check("a group is refused before AE is asked", () => {
  const { call, log } = scene({ group: true });
  const msg = messageOf(call);
  assert.match(msg, /Source Text is a property group/);
  assert.match(msg, /Nothing was added/);
  assert.deepEqual(log, []);
});

check("a property AE says it cannot add is refused, naming its value type and the workaround", () => {
  const { call, log, names } = scene({ canAdd: false, valueType: PropertyValueType.SHAPE });
  const msg = messageOf(call);
  assert.match(msg, /cannot go into this comp's Essential Graphics panel/);
  assert.match(msg, /value type SHAPE/);
  assert.match(msg, /expression control/);
  assert.match(msg, /Nothing was added/);
  assert.deepEqual(log, ["canAdd"], "the add must not be attempted");
  assert.equal(names.length, 0);
});

check("an AE without the API is refused, saying so", () => {
  const { call } = scene({ noApi: true });
  assert.match(messageOf(call), /no scripting call for adding a property to Essential Graphics/);
});

check("a blank name is refused before anything is added", () => {
  const { call, log } = scene({});
  assert.match(messageOf(() => call({ name: "   " })), /blank/);
  assert.deepEqual(log, []);
});

// ---------- the boolean is not the answer ----------

check("true with no new controller is a refusal", () => {
  const { call } = scene({ existing: ["Source Text"], adds: false, returns: true });
  const msg = messageOf(call);
  assert.match(msg, /did not add Source Text/);
  assert.match(msg, /returned true/);
  assert.match(msg, /still holds 1 controller\./);
  assert.match(msg, /already in the panel/);
});

check("false that did add a controller is reported as added", () => {
  const { call } = scene({ existing: [], returns: false });
  const r = plain(call());
  assert.equal(r.ok, true);
  assert.equal(r.controllerCount, 1);
});

check("a host that will not count: false is a throw, true is ok with a note", () => {
  const a = scene({ noCount: true, returns: false });
  assert.match(messageOf(a.call), /whether anything was added cannot be told/);
  const b = scene({ noCount: true, returns: true });
  const r = plain(b.call({ name: "X" }));
  assert.equal(r.ok, true);
  assert.equal(r.controllerIndex, null);
  assert.match(r.note, /could not be read back/);
  assert.match(r.note, /name asked for is unconfirmed/);
});

// ---------- export_mogrt points here ----------

check("export_mogrt's zero-controller refusal names add_essential_property", () => {
  const src = read("mogrt.jsx");
  const start = src.indexOf("has 0 Essential Graphics controllers");
  assert.ok(start > 0);
  assert.ok(src.slice(start, start + 800).includes("add_essential_property"));
});

console.log(`essential-property: ${passed} checks passed`);
