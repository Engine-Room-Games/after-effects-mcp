// The render queue (issue #137): everything about it that can be proved
// without After Effects.
//
// The render itself runs in an aerender process the server owns, so most of
// what can go wrong is server-side and testable here with a fake aerender:
//   - progress is read off aerender's stdout, one frame per PROGRESS line,
//     whatever the project's time display style;
//   - a render is reported done only when every output file exists, is not
//     empty, and was written by THIS render — an exit code is not evidence;
//   - cancel ends the whole process tree (the fake starts a grandchild, as
//     aerender starts a render engine) and reports `stopped` only once the
//     process has been seen to exit;
//   - aerender's location is derived from the running AE's appPackage on both
//     hosts, and a missing one refuses before anything is saved.
// And the .jsx half, against a mock DOM: nothing is left in the user's queue
// by a refused add, and render_queue refuses before saving.
//
//   node tests/unit/render-queue.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { parseAerenderLine, LineSplitter, aerenderArgs, resolveAerender, verifyOutputs, RenderRunner } =
  await import(dist("render", "aerender.js"));
const { aerenderCandidates } = await import(dist("setup", "platform.js"));
const { JobManager } = await import(dist("jobs", "manager.js"));
const { OpMutation } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`render-queue FAILED: ${name}`);
    throw e;
  }
  passed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-render-"));

// ---------------------------------------------------------------------------
// aerender's output
// ---------------------------------------------------------------------------

await check("a timecode frame line is one frame", () => {
  assert.deepEqual(parseAerenderLine("PROGRESS:  0:00:00:05 (6): 0 Seconds"), { kind: "frame", n: 6 });
});
await check("a frames-display line is one frame", () => {
  assert.deepEqual(parseAerenderLine("PROGRESS:  00005 (6): 1 Seconds"), { kind: "frame", n: 6 });
});
await check("the header and summary lines are not frames", () => {
  for (const l of [
    "PROGRESS:  10/29/2026 10:00:00 AM: Starting composition “Comp 1”.",
    "PROGRESS:  Duration: 0:00:05:00",
    "PROGRESS:  Frame Rate: 30.00 (comp)",
    "PROGRESS:  Total Time Elapsed: 3 Seconds",
    "PROGRESS:  Finished composition “Comp 1”.",
  ]) {
    assert.equal(parseAerenderLine(l).kind, "other", l);
  }
});
await check("error lines are recognised", () => {
  assert.equal(parseAerenderLine("aerender ERROR: No comp was found with the given name.").kind, "error");
  assert.equal(parseAerenderLine("ERROR: Unable to render").kind, "error");
});
await check("lines are split across chunk boundaries and bare carriage returns", () => {
  const lines = [];
  const s = new LineSplitter((l) => lines.push(l));
  s.push("PROGRESS:  0:00:00:00 (1): 0 Sec");
  s.push("onds\r\nPROGRESS:  0:00:00:01 (2): 0 Seconds\rPROG");
  s.push(Buffer.from("RESS:  done\n"));
  s.push("tail without newline");
  s.end();
  assert.deepEqual(lines, [
    "PROGRESS:  0:00:00:00 (1): 0 Seconds",
    "PROGRESS:  0:00:00:01 (2): 0 Seconds",
    "PROGRESS:  done",
    "tail without newline",
  ]);
});
await check("aerender is asked for exactly one render queue item", () => {
  assert.deepEqual(aerenderArgs("/p/show.aep", 3), ["-project", "/p/show.aep", "-rqindex", "3", "-v", "ERRORS_AND_PROGRESS"]);
});

// ---------------------------------------------------------------------------
// Where aerender is
// ---------------------------------------------------------------------------

await check("macOS: aerender sits beside the .app", () => {
  const c = aerenderCandidates("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app", {
    platform: "darwin",
    env: {},
  });
  assert.equal(c[0], "/Applications/Adobe After Effects 2026/aerender");
});
await check("Windows: aerender.exe sits in Support Files", () => {
  const c = aerenderCandidates("C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files", {
    platform: "win32",
    env: {},
  });
  assert.equal(c[0], "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\aerender.exe");
  assert.ok(c.every((x) => x.endsWith("aerender.exe")));
});
await check("AE_MCP_AERENDER is tried first", () => {
  const c = aerenderCandidates("/Applications/AE/AE.app", { platform: "darwin", env: { AE_MCP_AERENDER: "/opt/aerender" } });
  assert.equal(c[0], "/opt/aerender");
});
await check("install roots are a fallback behind appPackage", () => {
  const c = aerenderCandidates(null, { platform: "darwin", env: {}, installRoots: ["/Applications/Adobe After Effects 2026"] });
  assert.deepEqual(c, ["/Applications/Adobe After Effects 2026/aerender"]);
});
await check("no aerender refuses naming every place looked and the override", () => {
  assert.throws(
    () => resolveAerender(["/nope/aerender", "/also/nope"], () => false),
    (e) => /\/nope\/aerender/.test(e.message) && /AE_MCP_AERENDER/.test(e.message) && /nothing was saved/.test(e.message)
  );
  assert.equal(resolveAerender(["/a", "/b"], (p) => p === "/b"), "/b");
});

// ---------------------------------------------------------------------------
// Verifying outputs
// ---------------------------------------------------------------------------

await check("a missing, an empty and a stale file are all refused", () => {
  const empty = path.join(tmp, "empty.mov");
  fs.writeFileSync(empty, "");
  const stale = path.join(tmp, "stale.mov");
  fs.writeFileSync(stale, "old render");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(stale, past, past);
  const { verified, problems } = verifyOutputs(
    [
      { index: 1, path: path.join(tmp, "missing.mov") },
      { index: 2, path: empty },
      { index: 3, path: stale },
    ],
    Date.now()
  );
  assert.equal(verified.length, 0);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /does not exist/);
  assert.match(problems[1], /empty/);
  assert.match(problems[2], /older than this render/);
});
await check("a fresh file and a fresh sequence are verified", () => {
  const start = Date.now();
  const mov = path.join(tmp, "fresh.mov");
  fs.writeFileSync(mov, "frames");
  const seqDir = path.join(tmp, "seq");
  fs.mkdirSync(seqDir);
  for (const n of ["00000", "00001", "00002"]) fs.writeFileSync(path.join(seqDir, `shot_${n}.png`), "png");
  fs.writeFileSync(path.join(seqDir, "other_00000.png"), "png");
  const { verified, problems } = verifyOutputs(
    [
      { index: 1, path: mov },
      { index: 2, path: path.join(seqDir, "shot_[#####].png") },
    ],
    start
  );
  assert.deepEqual(problems, []);
  assert.equal(verified[0].bytes, 6);
  assert.equal(verified[1].files, 3);
});

// ---------------------------------------------------------------------------
// The runner, against a fake aerender. POSIX only: the fake is a script with a
// shebang, which Windows will not execute without a shell. The pure parts
// above are what differ by host, and they run everywhere.
// ---------------------------------------------------------------------------

const fake = path.join(tmp, "aerender");
fs.writeFileSync(
  fake,
  `#!${process.execPath}
const fs = require("fs");
const { spawn } = require("child_process");
const mode = process.env.FAKE_MODE;
const out = process.env.FAKE_OUT;
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args));
console.log("PROGRESS:  10/29/2026 10:00:00 AM: Starting composition “Comp”.");
console.log("PROGRESS:  Duration: 0:00:00:04");
if (mode === "fail") { console.log("aerender ERROR: Unable to find comp"); process.exit(3); }
if (mode === "hang") {
  // Stands in for the render engine aerender starts: a grandchild that keeps
  // running unless the whole group is stopped.
  const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(g.pid));
  fs.writeFileSync(out, "partial");
  console.log("PROGRESS:  0:00:00:00 (1): 0 Seconds");
  setInterval(() => {}, 1000);
  return;
}
let i = 0;
const t = setInterval(() => {
  console.log("PROGRESS:  0:00:00:0" + i + " (" + (i + 1) + "): 0 Seconds");
  i++;
  if (i === 4) {
    clearInterval(t);
    if (mode !== "liar") fs.writeFileSync(out, "rendered movie");
    console.log("PROGRESS:  Total Time Elapsed: 1 Seconds");
    process.exit(0);
  }
}, 20);
`
);
fs.chmodSync(fake, 0o755);

function plan(out, frames = 4) {
  return {
    projectPath: "/proj/show.aep",
    appPackage: null,
    items: [{ index: 2, compId: 7, compName: "Comp", status: "QUEUED", frames, outputs: [{ index: 1, path: out }] }],
  };
}
function env(mode, out) {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_OUT = out;
  process.env.FAKE_ARGS = path.join(tmp, `args-${mode}.json`);
  process.env.FAKE_GRANDCHILD = path.join(tmp, `grandchild-${mode}`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.platform !== "win32") {
  await check("a render reports per-frame progress and completes with the verified file", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs);
    const out = path.join(tmp, "ok.mov");
    env("ok", out);
    const seen = [];
    const { jobId, totalFrames } = runner.start(plan(out), fake);
    jobs.bindProgressEmitter(jobId, (_j, progress, total, message) => seen.push({ progress, total, message }));
    assert.equal(totalFrames, 4);
    assert.equal(runner.activeJobId, jobId);
    const st = await jobs.waitFor(jobId, 10_000);
    assert.equal(st.status, "completed");
    assert.equal(st.result.rendered[0].outputs[0].path, out);
    assert.equal(st.result.rendered[0].outputs[0].bytes, "rendered movie".length);
    assert.equal(st.result.rendered[0].frames, 4);
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.FAKE_ARGS, "utf8")), aerenderArgs("/proj/show.aep", 2));
    const frames = seen.filter((s) => /frame \d+ of 4/.test(s.message ?? "")).map((s) => s.progress);
    assert.deepEqual(frames, [1, 2, 3, 4]);
    assert.equal(runner.activeJobId, null);
  });

  await check("exit 0 with no file written is a failure, not a render", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs);
    const out = path.join(tmp, "liar.mov");
    env("liar", out);
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), (e) => /output is not there/.test(e.message) && /does not exist/.test(e.message));
    assert.equal(jobs.get(jobId).status, "failed");
  });

  await check("a non-zero exit fails with aerender's own error lines", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs);
    const out = path.join(tmp, "fail.mov");
    env("fail", out);
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(
      jobs.waitFor(jobId, 10_000),
      (e) => /exit code 3/.test(e.message) && /Unable to find comp/.test(e.message)
    );
  });

  await check("an aerender that cannot be started fails the job instead of hanging it", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs);
    const { jobId } = runner.start(plan(path.join(tmp, "x.mov")), path.join(tmp, "no-such-aerender"));
    await assert.rejects(jobs.waitFor(jobId, 10_000), /could not be started/);
  });

  await check("cancel kills the whole tree and reports stopped only after the exit", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs, { graceMs: 3000 });
    const out = path.join(tmp, "hang.mov");
    env("hang", out);
    const { jobId } = runner.start(plan(out, 100), fake);
    for (let i = 0; i < 100 && !fs.existsSync(process.env.FAKE_GRANDCHILD); i++) await sleep(20);
    const grandchild = Number(fs.readFileSync(process.env.FAKE_GRANDCHILD, "utf8"));
    assert.ok(alive(grandchild), "the fake's grandchild should be running before the cancel");
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, true);
    assert.equal(report.wasRunning, true);
    assert.deepEqual(report.partialFiles, [out]);
    assert.match(report.note, /INCOMPLETE/);
    assert.equal(jobs.get(jobId).status, "cancelled");
    assert.equal(jobs.get(jobId).result.stopped, true);
    for (let i = 0; i < 50 && alive(grandchild); i++) await sleep(20);
    assert.ok(!alive(grandchild), "cancel must stop the render engine too, not only aerender");
    await sleep(50);
    assert.equal(runner.activeJobId, null);
  });

  await check("cancelling a finished render says there was nothing to cancel", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs);
    const out = path.join(tmp, "ok2.mov");
    env("ok", out);
    const { jobId } = runner.start(plan(out), fake);
    await jobs.waitFor(jobId, 10_000);
    const report = await runner.cancel(jobId);
    assert.equal(report.wasRunning, false);
    assert.equal(report.stopped, false);
    assert.equal(jobs.get(jobId).status, "completed");
    assert.equal(await runner.cancel("j_not_a_render"), null);
  });

  await check("one render at a time", async () => {
    const jobs = new JobManager();
    const runner = new RenderRunner(jobs);
    const out = path.join(tmp, "ok3.mov");
    env("ok", out);
    const { jobId } = runner.start(plan(out), fake);
    assert.throws(() => runner.start(plan(out), fake), /already running/);
    await jobs.waitFor(jobId, 10_000);
  });
} else {
  console.log("render-queue: runner checks skipped on Windows (the fake aerender is a shebang script)");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

await check("the render queue ops are classified", () => {
  assert.equal(OpMutation.add_to_render_queue, "write");
  assert.equal(OpMutation.remove_render_item, "write");
  assert.equal(OpMutation.list_render_queue, "read");
  assert.equal(OpMutation.render_queue, "write");
});

// ---------------------------------------------------------------------------
// render.jsx against a mock DOM
// ---------------------------------------------------------------------------

const source = fs.readFileSync(path.join(root, "packages", "jsx", "render.jsx"), "utf8");

// The bundle is a concatenation, so a helper that shares a name with one in an
// earlier module silently replaces it for every caller. render.jsx first
// shipped a `__nameList` that would have replaced footage.jsx's, with a
// different signature, and broken purge_unused_footage's messages.
await check("no two .jsx modules define the same global function", () => {
  const jsxDir = path.join(root, "packages", "jsx");
  const owner = new Map();
  const dupes = [];
  for (const f of fs.readdirSync(jsxDir).filter((n) => n.endsWith(".jsx"))) {
    const text = fs.readFileSync(path.join(jsxDir, f), "utf8");
    for (const m of text.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      if (owner.has(m[1]) && owner.get(m[1]) !== f) dupes.push(`${m[1]} (${owner.get(m[1])} and ${f})`);
      owner.set(m[1], f);
    }
  }
  assert.deepEqual(dupes, []);
});

function makeAe(opts = {}) {
  const files = new Set(opts.files ?? []);
  const dirs = new Set(opts.dirs ?? ["/renders"]);
  const log = [];
  const RQItemStatus = { QUEUED: 3013, UNQUEUED: 3012, NEEDS_OUTPUT: 3011, RENDERING: 3015, WILL_CONTINUE: 3014, USER_STOPPED: 3016, ERR_STOPPED: 3017, DONE: 3018 };
  class MockFolder {
    constructor(p) { this.fsName = p; }
    get exists() { return dirs.has(this.fsName); }
  }
  class MockFile {
    constructor(p) { this.fsName = String(p); }
    get exists() { return files.has(this.fsName); }
    get parent() { return new MockFolder(this.fsName.substring(0, this.fsName.lastIndexOf("/")) || "/"); }
  }
  const comp = { id: 7, name: "Lower Third", frameRate: 30 };
  const items = [];
  function makeItem(c, status) {
    const om = {
      file: null,
      name: "High Quality",
      templates: ["High Quality", "High Quality with Alpha"],
      applyTemplate(n) { this.name = n; log.push("om:" + n); },
      getSettings() { return { Format: "QuickTime", "Video Output": { Channels: "RGB + Alpha", Depth: "Millions of Colors+", Color: "Straight (Unmatted)" } }; },
    };
    const item = {
      comp: c,
      render: true,
      timeSpanStart: 0,
      timeSpanDuration: 2,
      templates: ["Best Settings", "Draft Settings"],
      numOutputModules: 1,
      outputModule: () => om,
      applyTemplate(n) { log.push("rs:" + n); },
      remove() { items.splice(items.indexOf(item), 1); log.push("remove"); },
      get status() {
        if (status) return status;
        return om.file ? RQItemStatus.QUEUED : RQItemStatus.NEEDS_OUTPUT;
      },
    };
    return item;
  }
  for (const s of opts.existing ?? []) {
    const it = makeItem(comp, RQItemStatus[s]);
    it.outputModule().file = new MockFile("/renders/existing.mov");
    items.push(it);
  }
  const project = {
    file: opts.unsaved ? null : new MockFile("/proj/show.aep"),
    dirty: true,
    save() { log.push("save"); },
    itemByID: (id) => (id === 7 ? comp : null),
    renderQueue: {
      get numItems() { return items.length; },
      item: (i) => items[i - 1],
      items: { add: (c) => { const it = makeItem(c); items.push(it); log.push("add"); return it; } },
    },
  };
  const ctx = {
    OPS: {},
    noUndo: (fn) => { fn.__meta = { noUndo: true }; return fn; },
    getCompById: (id) => { const c = project.itemByID(id); if (!c) throw new Error("No comp with id " + id); return c; },
    File: MockFile,
    Folder: Object.assign(MockFolder, { appPackage: new MockFolder("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app") }),
    RQItemStatus,
    GetSettingsFormat: { STRING: 1 },
    app: { project, version: "26.3" },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "render.jsx" });
  return { ctx, items, log };
}

const throwsMsg = (fn) => {
  try { fn(); } catch (e) { return String(e.message); }
  throw new assert.AssertionError({ message: "expected a throw" });
};

await check("add_to_render_queue applies templates by name and reads back what will be written", () => {
  const { ctx, items } = makeAe();
  const r = ctx.OPS.add_to_render_queue({
    compId: 7, outputPath: "/renders/lt.mov", outputModuleTemplate: "High Quality with Alpha", renderSettingsTemplate: "Best Settings",
  });
  assert.equal(items.length, 1);
  assert.equal(r.index, 1);
  assert.equal(r.status, "QUEUED");
  assert.equal(r.frames, 60);
  assert.equal(r.outputs[0].path, "/renders/lt.mov");
  assert.equal(r.outputs[0].template, "High Quality with Alpha");
  assert.equal(r.outputs[0].settings.channels, "RGB + Alpha");
  assert.equal(r.outputs[0].settings.format, "QuickTime");
});
await check("an unknown template is refused with the list, and the item is taken back out", () => {
  const { ctx, items, log } = makeAe();
  const msg = throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/lt.mov", outputModuleTemplate: "ProRes 4444" }));
  assert.match(msg, /No output module template named "ProRes 4444"/);
  assert.match(msg, /High Quality with Alpha/);
  assert.equal(items.length, 0);
  assert.deepEqual(log, ["add", "remove"]);
});
await check("path problems are refused before the queue is touched", () => {
  const { ctx, log } = makeAe({ files: ["/renders/taken.mov"] });
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "renders/lt.mov" })), /absolute/);
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/missing/lt.mov" })), /does not exist/);
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/taken.mov" })), /overwrite:true/);
  assert.deepEqual(log, []);
  ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/taken.mov", overwrite: true });
});
await check("remove_render_item refuses an index that now renders another comp", () => {
  const { ctx, items } = makeAe({ existing: ["QUEUED"] });
  assert.match(throwsMsg(() => ctx.OPS.remove_render_item({ index: 1, compId: 99 })), /list_render_queue/);
  assert.equal(items.length, 1);
  const r = ctx.OPS.remove_render_item({ index: 1, compId: 7 });
  assert.equal(r.remaining, 0);
});
await check("_render_prepare refuses an unsaved project and never saves", () => {
  const { ctx, log } = makeAe({ unsaved: true, existing: ["QUEUED"] });
  assert.match(throwsMsg(() => ctx.OPS._render_prepare({})), /never been saved/);
  assert.deepEqual(log, []);
});
await check("_render_prepare refuses a DONE item and says to add a fresh one", () => {
  const { ctx, log } = makeAe({ existing: ["QUEUED", "DONE"] });
  const msg = throwsMsg(() => ctx.OPS._render_prepare({ indices: [1, 2] }));
  assert.match(msg, /item 2 .* DONE/);
  assert.match(msg, /add a fresh one/);
  assert.deepEqual(log, []);
});
await check("_render_prepare with no indices picks every QUEUED item, and changes nothing", () => {
  const { ctx, log } = makeAe({ existing: ["QUEUED", "DONE", "QUEUED"] });
  const plan = ctx.OPS._render_prepare({});
  assert.deepEqual(Array.from(plan.items, (i) => i.index), [1, 3]);
  assert.equal(plan.projectPath, "/proj/show.aep");
  assert.match(plan.appPackage, /\.app$/);
  assert.deepEqual(log, []);
});
await check("_render_prepare with nothing queued refuses", () => {
  const { ctx } = makeAe({ existing: ["DONE"] });
  assert.match(throwsMsg(() => ctx.OPS._render_prepare({})), /Nothing in the render queue is QUEUED/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`render-queue: ${passed} checks passed`);
// The fake grandchild of a failed run must not keep the process alive.
process.exit(0);
