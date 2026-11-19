// A run_jsx script that replaces the open project (issue #304).
//
// Every op runs with After Effects' dialogs suppressed, and "Save changes?" is
// a dialog. Measured on AE 27.0: with unsaved changes in a project that has a
// file, app.open(), app.newProject() and app.project.close(PROMPT_TO_SAVE_
// CHANGES) each save it over its file without a word; in a project that was
// never saved, the Save dialog comes up regardless and blocks the bridge.
//
// The rule locked in here: written out in a script, a library or a run_batch
// step, none of the three reaches After Effects while the project has unsaved
// changes — the call throws and names both ways on — and a save that happens
// by a route the rewrite cannot see is reported as `projectSaved`, on a result
// and on an error alike.
//
// The fake `app` below does what After Effects was measured to do, so a guard
// that lets a call through shows up as a written file.
//
//   node tests/unit/run-jsx-project-guard.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "packages", "jsx", f), "utf8");
const asm = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "tools", "runJsxAssembly.js")).href
);

const A = "/proj/A.aep";
const B = "/proj/B.aep";

function load({ file = A, dirty = true } = {}) {
  const log = [];
  // path -> number of times written. A write moves `modified` and `length`.
  const disk = { [A]: 1, [B]: 1 };
  const state = { file, dirty };
  const save = () => { disk[state.file] = (disk[state.file] || 0) + 1; state.dirty = false; log.push(`saved ${state.file}`); };
  const CloseOptions = { PROMPT_TO_SAVE_CHANGES: 1, SAVE_CHANGES: 2, DO_NOT_SAVE_CHANGES: 3 };
  function File(p) {
    this.fsName = p;
    this.modified = new Date(1000 * (disk[p] || 0));
    this.length = disk[p] || 0;
  }
  // What After Effects does with the prompt it was told not to show.
  const leave = (how) => {
    if (!state.dirty) return;
    if (state.file) save();
    else log.push(`SAVE DIALOG (${how})`);
  };
  const project = {
    get file() { return state.file ? new File(state.file) : null; },
    get dirty() { return state.dirty; },
    save() { save(); },
    close(opt) {
      log.push(`close ${opt}`);
      if (opt === CloseOptions.SAVE_CHANGES) save();
      else if (opt !== CloseOptions.DO_NOT_SAVE_CHANGES) leave("close");
      state.file = null;
      state.dirty = false;
      return true;
    },
  };
  const app = {
    beginUndoGroup() {},
    endUndoGroup() {},
    project,
    open(f) {
      log.push(`open ${f ? f.fsName : "(dialog)"}`);
      leave("open");
      state.file = f.fsName;
      state.dirty = false;
      return project;
    },
    newProject() {
      log.push("newProject");
      leave("newProject");
      state.file = null;
      state.dirty = false;
      return project;
    },
  };
  const ctx = { app, File, CloseOptions };
  vm.createContext(ctx);
  for (const f of ["core.jsx", "snapshot.jsx", "batch.jsx", "raw.jsx"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const dispatch = (op, args) => JSON.parse(JSON.stringify(vm.runInContext("dispatch", ctx)(JSON.stringify({ op, args }))));
  // Both ways a script reaches After Effects: assembled in ExtendScript
  // (OPS.run_jsx), and assembled by the server and sent as `_run_jsx`.
  const run = (via, code, extra = {}) => {
    if (via === "run_jsx") return dispatch("run_jsx", { code, ...extra });
    const built = asm.buildRunJsxSource(code, extra.libraries);
    return dispatch("_run_jsx", {
      built: {
        wrapper: built.wrapper,
        undoRewrites: built.undoRewrites,
        undoMentions: built.undoMentions,
        opaqueRoutes: built.opaqueRoutes,
        libraries: built.libraryChecks,
      },
      undoGroup: extra.undoGroup,
    });
  };
  return { log, disk, state, dispatch, run };
}

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`run-jsx-project-guard FAILED: ${name}`); throw e; }
}

const OPEN_B = `return app.open(new File("${B}")) ? "opened" : "no";`;

for (const via of ["run_jsx", "_run_jsx"]) {
  check(`${via}: app.open with unsaved changes is refused, and nothing is saved`, () => {
    const e = load();
    const out = e.run(via, OPEN_B);
    assert.equal(out.ok, false);
    assert.match(out.error, /app\.open\(\) was not run: the open project has unsaved changes/);
    assert.match(out.error, /would save them over \/proj\/A\.aep/);
    assert.match(out.error, /app\.project\.save\(\)/);
    assert.match(out.error, /DO_NOT_SAVE_CHANGES/);
    assert.deepEqual(e.log, []);
    assert.equal(e.disk[A], 1);
    assert.equal(e.state.dirty, true);
  });

  check(`${via}: a project never saved is refused before its Save dialog can block`, () => {
    const e = load({ file: null });
    const out = e.run(via, OPEN_B);
    assert.equal(out.ok, false);
    assert.match(out.error, /never been saved/);
    assert.match(out.error, /Save dialog that blocks this connection/);
    assert.deepEqual(e.log, []);
  });

  check(`${via}: app.newProject and a prompting close are refused the same way`, () => {
    for (const [code, named] of [
      ["app.newProject();", /app\.newProject\(\) was not run/],
      ["app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES);", /app\.project\.close\(\) was not run/],
      ["app.project.close();", /app\.project\.close\(\) was not run/],
      ["app\n  .project\n  .close( CloseOptions.PROMPT_TO_SAVE_CHANGES );", /app\.project\.close\(\) was not run/],
    ]) {
      const e = load();
      const out = e.run(via, code);
      assert.equal(out.ok, false, code);
      assert.match(out.error, named);
      assert.deepEqual(e.log, [], code);
    }
  });

  check(`${via}: a clean project opens, with nothing added to the result`, () => {
    const e = load({ dirty: false });
    const out = e.run(via, OPEN_B);
    assert.equal(out.ok, true);
    assert.equal(out.result, "opened");
    assert.deepEqual(e.log, [`open ${B}`]);
  });

  check(`${via}: a close that says what it wants is passed through`, () => {
    const discard = load();
    const d = discard.run(via, `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.open(new File("${B}")); return 1;`);
    assert.equal(d.ok, true);
    assert.equal(d.result, 1, "nothing was saved, so nothing is reported");
    assert.equal(discard.disk[A], 1);
    assert.deepEqual(discard.log, ["close 3", `open ${B}`]);

    const keep = load();
    const k = keep.run(via, `app.project.close(CloseOptions.SAVE_CHANGES); return 1;`);
    assert.equal(k.ok, true);
    assert.equal(keep.disk[A], 2);
    assert.equal(k.result.projectSaved, true);
  });

  check(`${via}: saving first is the way through, and the save is reported`, () => {
    const e = load();
    const out = e.run(via, `app.project.save(); app.open(new File("${B}")); return "there";`);
    assert.equal(out.ok, true);
    assert.equal(out.result.returned, "there");
    assert.equal(out.result.projectSaved, true);
    assert.match(out.result.projectSavedNote, /\/proj\/A\.aep was written while the script ran/);
    assert.match(out.result.projectSavedNote, /File > Revert/);
    assert.equal(e.state.file, B);
  });

  check(`${via}: a save through a route the rewrite cannot see is still reported`, () => {
    const e = load();
    const out = e.run(via, `var a = app; a["open"](new File("${B}")); return 7;`);
    assert.equal(out.ok, true);
    assert.equal(e.disk[A], 2, "the fake saved, as After Effects does");
    assert.deepEqual(out.result.returned, 7);
    assert.equal(out.result.projectSaved, true);
    assert.match(out.result.projectSavedNote, /This call saved the project/);
  });

  check(`${via}: and on an error, when the script threw after the save`, () => {
    const e = load();
    const out = e.run(via, `var a = app; a.newProject(); throw new Error("later");`);
    assert.equal(out.ok, false);
    assert.match(out.error, /later/);
    assert.match(out.error, /\|\| project: This call saved the project/);
  });

  check(`${via}: a script that leaves the project alone is not annotated`, () => {
    const dirty = load();
    assert.deepEqual(dirty.run(via, "return 2;"), { ok: true, result: 2 });
    const io = load();
    const out = io.run(via, "var f = { open: function(){ return 1; }, close: function(){ return 2; } }; return f.open('r') + f.close();");
    assert.deepEqual(out, { ok: true, result: 3 });
  });

  check(`${via}: a library's call is guarded like the script's`, () => {
    const e = load();
    const libraries = [{ path: "/t/lib.jsx", text: `function swap(){ return app.open(new File("${B}")); }` }];
    const out = e.run(via, "swap(); return 1;", { libraries });
    assert.equal(out.ok, false);
    assert.match(out.error, /app\.open\(\) was not run/);
    assert.deepEqual(e.log, []);
  });
}

check("a run_batch step running a script is guarded too", () => {
  const e = load();
  const out = e.dispatch("run_batch", { ops: [{ op: "run_jsx", args: { code: OPEN_B } }] });
  assert.match(JSON.stringify(out), /app\.open\(\) was not run/);
  assert.deepEqual(e.log, []);
  assert.equal(e.disk[A], 1);
});

check("only the written-out calls are rewritten, and no line moves", () => {
  const cases = [
    ["app.open(f)", "__rjAppOpen(f)", 1],
    ["app . newProject ( )", "__rjAppNewProject ( )", 1],
    ["app\n.\nopen(f)", "__rjAppOpen\n\n(f)", 1],
    ["app.project.close(x)", "__rjProjectClose(x)", 1],
    ["app\n .project\n .close(x)", "__rjProjectClose\n\n(x)", 1],
    ["foo.app.open(f); myapp.open(f); f.open('r'); f.close();", null, 0],
    ["x.app.project.close(); project.close(); app.project.item(1).close();", null, 0],
    ["var s = 'app.open(f)'; // app.newProject()", null, 0],
    ["app.project.closest; app.opened; app.newProjects", null, 0],
  ];
  for (const [src, want, n] of cases) {
    const got = asm.rewriteUndoText(src);
    assert.equal(got.text, want === null ? src : want, src);
    assert.equal(got.projectRewrites, n, src);
    assert.equal(got.rewrites, 0, "a project rewrite is not an undo rewrite");
    assert.equal(got.text.split("\n").length, src.split("\n").length);
  }
});

check("a project call puts no undo note on the result", () => {
  const b = asm.buildRunJsxSource("app.newProject();");
  assert.equal(b.undoMentions, false);
  assert.equal(b.undoRewrites, 0);
  assert.match(b.wrapper, /__rjAppNewProject\(\);/);
});

check("the fast path: only a script that names one of the three pays for the rewrite", () => {
  for (const t of ["app.open(f)", "app . open", "app.project.close()", "project\n.close", "x.newProject"]) {
    assert.equal(asm.mentionsProject(t), true, t);
  }
  for (const t of ["f.open('r'); f.close();", "myapp.open()", "app.opened", "subproject.close()", "return 1;"]) {
    assert.equal(asm.mentionsProject(t), false, t);
  }
});

console.log(`run-jsx-project-guard: ${passed} checks passed`);
