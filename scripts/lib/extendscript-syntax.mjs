// What ExtendScript cannot run, found before After Effects does (issue #164).
//
// The unit tests run packages/jsx/*.jsx under Node, which accepts ES2015+, so
// a modern-JavaScript slip passes every test and then breaks every tool: After
// Effects refuses the whole bundle at load. That happened in PR #192 — a
// parameter named `native`, an ES3 future-reserved word, made AE 26.5 answer
// `SyntaxError: Illegal use of reserved word` and load nothing.
//
// Three checks over the generated bundle, all deterministic:
//
//  1. It parses as ES5 (acorn, ecmaVersion 5). That rejects let/const, arrow
//     functions, template literals, classes, destructuring, spread, default
//     parameters, for-of, shorthand properties and methods, and the newer
//     regex flags. Not ES3: ExtendScript accepts trailing commas in object and
//     array literals (measured — the bundle has them and loads), which an ES3
//     parse rejects.
//  2. No ES3 reserved or future-reserved word is used as an identifier — a
//     variable, function, parameter or label name. ES5 freed most of the
//     future-reserved list, ExtendScript did not. Property names (`o.native`,
//     `{class: 1}`) are not checked: nothing here has measured them either way.
//  3. No call to an ES5 built-in ExtendScript lacks (Object.keys, the Array
//     iteration methods, String#trim, Function#bind, Date.now, …), and no
//     getter/setter in an object literal. These parse, and fail only when the
//     line runs — later, and in front of a user.

import * as acorn from "acorn";

// ES3 §7.5.3, the future-reserved words, plus the ES3 keywords ES5 parses
// without complaint in some positions.
export const ES3_RESERVED = new Set([
  "abstract", "boolean", "byte", "char", "class", "const", "debugger", "double", "enum", "export",
  "extends", "final", "float", "goto", "implements", "import", "int", "interface", "long", "native",
  "package", "private", "protected", "public", "short", "static", "super", "synchronized", "throws",
  "transient", "volatile", "let", "yield",
]);

// `Object.<name>(` and `Array.<name>(` / `Date.<name>(` — static ES5 additions.
const MISSING_STATICS = {
  Object: new Set([
    "keys", "create", "defineProperty", "defineProperties", "getPrototypeOf", "getOwnPropertyNames",
    "getOwnPropertyDescriptor", "freeze", "seal", "preventExtensions", "isFrozen", "isSealed",
    "isExtensible", "assign", "entries", "values",
  ]),
  Array: new Set(["isArray", "from", "of"]),
  Date: new Set(["now"]),
};

// `.<name>(` on anything. None of these names is a method of an After Effects
// object, so a call is the ES5 built-in. `indexOf`/`lastIndexOf` are left out:
// strings have them in ES3, and the receiver's type is not knowable here.
const MISSING_METHODS = new Set([
  "forEach", "map", "filter", "reduce", "reduceRight", "some", "every", "trim", "trimLeft",
  "trimRight", "bind", "toISOString", "includes", "startsWith", "endsWith", "find", "findIndex",
]);

function lineCol(source, pos) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < pos; i++) {
    if (source.charCodeAt(i) === 10) { line++; last = i; }
  }
  return { line, column: pos - last };
}

/**
 * Every problem in `source`, in source order. Empty means ExtendScript can run it
 * as far as these checks can tell.
 * @returns {{line:number, column:number, message:string}[]}
 */
export function extendScriptProblems(source) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 5, sourceType: "script", allowReserved: true, locations: true });
  } catch (e) {
    const loc = e.loc ?? { line: 0, column: 0 };
    return [{ line: loc.line, column: loc.column + 1, message: `not ES5, so not ExtendScript: ${e.message.replace(/ \(\d+:\d+\)$/, "")}` }];
  }

  const problems = [];
  const report = (node, message) => {
    problems.push({ ...lineCol(source, node.start), message });
  };
  const binding = (id, what) => {
    if (id && id.type === "Identifier" && ES3_RESERVED.has(id.name)) {
      report(id, `\`${id.name}\` is reserved in ExtendScript (ES3) and cannot be a ${what} name — After Effects refuses the whole bundle`);
    }
  };

  (function walk(node, parent) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "VariableDeclarator": binding(node.id, "variable"); break;
      case "FunctionDeclaration":
      case "FunctionExpression":
        binding(node.id, "function");
        for (const p of node.params) binding(p, "parameter");
        break;
      case "CatchClause": binding(node.param, "catch parameter"); break;
      case "LabeledStatement": binding(node.label, "label"); break;
      case "Identifier": {
        // A reference (not a property key, not a declaration handled above).
        const isKey = parent && ((parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
          (parent.type === "Property" && parent.key === node));
        const isDecl = parent && (parent.type === "VariableDeclarator" && parent.id === node ||
          (parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") ||
          parent.type === "CatchClause" || parent.type === "LabeledStatement" ||
          parent.type === "BreakStatement" || parent.type === "ContinueStatement");
        if (!isKey && !isDecl && ES3_RESERVED.has(node.name)) {
          report(node, `\`${node.name}\` is reserved in ExtendScript (ES3) and cannot be used as an identifier`);
        }
        break;
      }
      case "Property":
        if (node.kind === "get" || node.kind === "set") {
          report(node, `a ${node.kind}ter in an object literal is ES5; ExtendScript cannot run it`);
        }
        break;
      case "CallExpression": {
        const c = node.callee;
        if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
          const name = c.property.name;
          if (c.object.type === "Identifier" && MISSING_STATICS[c.object.name]?.has(name)) {
            report(c.property, `\`${c.object.name}.${name}\` is ES5+; ExtendScript does not have it`);
          } else if (MISSING_METHODS.has(name)) {
            report(c.property, `\`.${name}()\` is an ES5+ built-in ExtendScript does not have — write the loop`);
          }
        }
        break;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const child of v) walk(child, node); }
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v, node);
    }
  })(ast, null);

  problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return problems;
}

/** The problems as one printable block, each with its line of source. */
export function formatProblems(source, problems, file) {
  const lines = source.split("\n");
  return problems
    .map((p) => `${file}:${p.line}:${p.column}: ${p.message}\n    ${(lines[p.line - 1] ?? "").trim()}`)
    .join("\n");
}
