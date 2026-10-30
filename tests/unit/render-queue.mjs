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
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { renderJobId, parseAerenderLine, LineSplitter, aerenderArgs, resolveAerender, verifyOutputs, RenderRunner, occupiedOutputs, duplicateOutputs, snapshotProject, removeSnapshot, missingFootageHint, sweepStaleSnapshots, isMissingFootageLine, touchSnapshot, loggedErrorCount, isoMediaProblem, isoMediaInfo, snapshotLayout, jobFolder, shadowDirs, strayFiles, relocateShadowOutputs, stampOutputs, cancelledPartials } =
  await import(dist("render", "aerender.js"));
const { aerenderCandidates, renderPidsFromPs, isRenderProcessArgs, isRenderProcessWin, stopProcessTreeSync, snapshotMarker } = await import(dist("setup", "platform.js"));
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

// This suite spawns real processes, and a hang would print nothing at all —
// which is how a reviewer once read it as "no result". Fail loudly instead.
// Windows gets longer: every engine lookup there is a PowerShell CIM query.
const watchdogMs = process.platform === "win32" ? 240_000 : 90_000;
const watchdog = setTimeout(() => {
  console.error(`render-queue FAILED: timed out after ${watchdogMs / 1000}s with ${passed} checks passed — something is hanging`);
  process.exit(1);
}, watchdogMs);
watchdog.unref();

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

await check("existing outputs are found, files and sequence frames alike", () => {
  const taken = path.join(tmp, "taken.mov");
  fs.writeFileSync(taken, "old");
  const occupied = occupiedOutputs({
    projectPath: "/p.aep",
    appPackage: null,
    items: [
      { index: 1, compId: 1, compName: "a", status: "QUEUED", frames: 1, outputs: [{ index: 1, path: taken }] },
      { index: 2, compId: 1, compName: "b", status: "QUEUED", frames: 1, outputs: [{ index: 1, path: path.join(tmp, "seq", "shot_[#####].png") }] },
      { index: 3, compId: 1, compName: "c", status: "QUEUED", frames: 1, outputs: [{ index: 1, path: path.join(tmp, "free.mov") }] },
    ],
  });
  assert.deepEqual(occupied, [taken, path.join(tmp, "seq", "shot_[#####].png")]);
});
await check("the snapshot goes to a per-job temp folder, never beside the project", () => {
  const proj = path.join(tmp, "snap-src.aep");
  fs.writeFileSync(proj, "aep");
  const tmpRoot = path.join(tmp, "osTmp");
  const layout = snapshotProject(proj, "r_1_1", tmpRoot);
  const snap = layout.snap;
  const jobDir = path.join(tmpRoot, "ae-mcp-render", "r_1_1");
  assert.equal(layout.jobDir, jobDir);
  assert.equal(snap, path.join(jobDir, ...new Array(layout.depth).fill(layout.name), "snap-src.aep"));
  assert.equal(fs.readFileSync(snap, "utf8"), "aep");
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes("ae-mcp-render")), [], "nothing new beside the project");
  removeSnapshot(layout.jobDir);
  assert.ok(!fs.existsSync(jobDir), "the per-job folder goes with it");
  // removeSnapshot only ever removes an ae-mcp-render/<job> folder.
  removeSnapshot(path.dirname(proj));
  assert.ok(fs.existsSync(proj));
  assert.throws(() => snapshotProject(path.join(tmp, "nope", "x.aep"), "r_1_2", tmpRoot), /nothing was rendered/);
});
await check("a render clears day-old snapshot folders, never a newer one or its own", () => {
  const root = path.join(tmp, "sweepTmp");
  const base = path.join(root, "ae-mcp-render");
  const now = Date.now();
  const mk = (name, ageMs) => {
    const d = path.join(base, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "show.aep"), "aep");
    const t = new Date(now - ageMs);
    fs.utimesSync(d, t, t);
    return d;
  };
  const old = mk("r_old_1", 2 * 24 * 3600_000);
  const fresh = mk("r_fresh_2", 3600_000);
  const mine = mk("r_mine_3", 3 * 24 * 3600_000);
  fs.writeFileSync(path.join(base, "stray.txt"), "not a job folder");
  // An output an older version let aerender write into the shared root (#215).
  const leaked = path.join(base, "out4.mp4");
  fs.writeFileSync(leaked, "lost render");
  fs.utimesSync(leaked, new Date(now - 2 * 24 * 3600_000), new Date(now - 2 * 24 * 3600_000));
  const removed = sweepStaleSnapshots("r_mine_3", root, 24 * 3600_000, now);
  assert.deepEqual(removed.sort(), [old, leaked].sort());
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh), "another session's newer render is left alone");
  assert.ok(fs.existsSync(mine), "the current job's folder is never touched");
  assert.ok(fs.existsSync(path.join(base, "stray.txt")));
  assert.deepEqual(sweepStaleSnapshots("x", path.join(tmp, "never-rendered")), []);
});
await check("a running job keeps its snapshot folder young, so a long render survives another session's sweep", () => {
  const root = path.join(tmp, "touchTmp");
  const src = path.join(tmp, "long.aep");
  fs.writeFileSync(src, "aep");
  const { snap, jobDir: dir } = snapshotProject(src, "r_long_9", root);
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  fs.utimesSync(dir, old, old);
  touchSnapshot(dir);
  assert.deepEqual(sweepStaleSnapshots("r_other", root), [], "a touched folder is not stale");
  assert.ok(fs.existsSync(snap));
  removeSnapshot(dir);
});
await check("missing-footage lines are recognised, ordinary ones are not", () => {
  assert.ok(isMissingFootageLine("aerender WARNING: Footage file missing: /x/clip.mov"));
  assert.ok(isMissingFootageLine("aerender ERROR: File not found: C:\\clip.mov"));
  assert.ok(!isMissingFootageLine("PROGRESS:  0:00:00:05 (6): 0 Seconds"));
  assert.ok(!isMissingFootageLine("PROGRESS:  Finished composition “Comp”."));
  assert.ok(isMissingFootageLine("ERROR: Missing footage: “clip.mov”"));
});
// Measured on AE 26.5 (macOS, English): aerender printed exactly this and then
// exited 0, leaving a corrupt file. The words that matter are INSIDE the curly
// quotes — the first matcher stripped them and passed the line.
const REAL_MISSING_FOOTAGE_LINE = "WARNING:After Effects warning: logged 9 errors, please check log.  First error was “error: Unable to Render: File Not Found /Users/x/scratch/foot/pic.png”";
await check("the measured aerender missing-footage line is caught", () => {
  assert.equal(isMissingFootageLine(REAL_MISSING_FOOTAGE_LINE), true);
  assert.equal(loggedErrorCount(REAL_MISSING_FOOTAGE_LINE), 9);
  assert.equal(loggedErrorCount("PROGRESS:  0:00:00:05 (6): 0 Seconds"), 0);
  assert.equal(loggedErrorCount("aerender WARNING: Composition “logged 3 errors” is empty"), 0);
});
await check("only aerender/aerendercore carrying THIS job's snapshot are its processes", () => {
  const snap = "/var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep";
  const out = [
    // aerender and its engine (the engine sees the /private spelling of the path).
    "  101 /Applications/Adobe After Effects 2026/aerender -project /var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep -rqindex 3",
    "  102 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/aerendercore.app/Contents/MacOS/aerendercore -noui -project /private/var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep -rqindex 3 -aerenderpid 101",
    // Decoys: a shell line with the job id and the path, a non-aerender
    // process holding the path, another job's engine, and this process.
    "  103 /bin/zsh -c echo r_1_2 /var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep",
    "  104 /usr/bin/tail -f /var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep",
    "  105 /Applications/Adobe After Effects 2026/aerender -project /var/folders/xx/T/ae-mcp-render/r_9_9/rq.aep -rqindex 1",
    "  106 grep aerender r_1_2",
    `  ${process.pid} /usr/local/bin/aerender -project /var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep`,
  ].join("\n");
  assert.deepEqual(renderPidsFromPs(out, snap), [101, 102]);
  assert.equal(isRenderProcessArgs("/opt/aerender-notes/edit -project /x/ae-mcp-render/r_1_2/rq.aep", snap), false);
});
await check("Windows: name AND command line, so the PowerShell search never matches itself", () => {
  const snap = "C:\\Users\\u\\AppData\\Local\\Temp\\ae-mcp-render\\r_1_2\\rq.aep";
  assert.equal(isRenderProcessWin("aerender.exe", '"C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\aerender.exe" -project C:\\Users\\u\\AppData\\Local\\Temp\\ae-mcp-render\\r_1_2\\rq.aep', snap), true);
  assert.equal(isRenderProcessWin("powershell.exe", "powershell -Command Get-CimInstance ... ae-mcp-render\\r_1_2\\rq.aep", snap), false);
  assert.equal(isRenderProcessWin("cmd.exe", "cmd /c echo r_1_2", snap), false);
  assert.equal(isRenderProcessWin("aerender.exe", "aerender.exe -project C:\\other\\ae-mcp-render\\r_9_9\\rq.aep", snap), false);
});
await check("a chained snapshot path still identifies its job, and only its job (#215)", () => {
  const a = "/var/folders/xx/T/ae-mcp-render/r_1_2/a/a/a/a/a/a/a/show.aep";
  const b = "/var/folders/xx/T/ae-mcp-render/r_9_9/a/a/a/a/a/a/a/show.aep";
  assert.equal(snapshotMarker(a), "ae-mcp-render/r_1_2/a/a/a/a/a/a/a/show.aep");
  const ps = [
    `  201 /Applications/Adobe After Effects 2026/aerender -project ${a} -rqindex 1`,
    `  202 /Applications/Adobe After Effects 2026/aerender -project ${b} -rqindex 1`,
  ].join("\n");
  assert.deepEqual(renderPidsFromPs(ps, a), [201], "another job on the same project is not this one");
  assert.equal(snapshotMarker("/var/folders/xx/T/ae-mcp-render/r_1_2/rq.aep"), "ae-mcp-render/r_1_2/rq.aep");
});
await check("two MCP servers starting a render in the same millisecond never share a job, so never kill each other's aerender (#260)", () => {
  // Same clock, same per-process counter: what two sessions' first renders
  // get when they start together. Only the process tells them apart.
  const one = renderJobId(1793394836543, 4101, 1);
  const two = renderJobId(1793394836543, 4102, 1);
  assert.notEqual(one, two, "the job id must differ between servers");
  const snapOf = (id) => snapshotLayout("/Users/me/show/show.aep", id, "/tmp/T", [], path.posix, (d) => d).snap;
  const ps = [
    `  301 /Applications/Adobe After Effects 2026/aerender -project ${snapOf(one)} -rqindex 1`,
    `  302 /Applications/Adobe After Effects 2026/aerender -project ${snapOf(two)} -rqindex 1`,
  ].join("\n");
  assert.deepEqual(renderPidsFromPs(ps, snapOf(one)), [301], "a cancel must not reach the other server's aerender");
  assert.deepEqual(renderPidsFromPs(ps, snapOf(two)), [302]);
});
await check("the copy sits under a chain of one-letter folders as deep as the project's, on both hosts (#215)", () => {
  const id = (d) => d;
  const L = snapshotLayout("/Users/me/show/show.aep", "r_1_1", "/tmp/T", [], path.posix, id);
  assert.deepEqual(L, {
    jobDir: "/tmp/T/ae-mcp-render/r_1_1",
    snap: "/tmp/T/ae-mcp-render/r_1_1/a/a/a/a/a/show.aep",
    depth: 5,
    name: "a",
  });
  assert.equal(jobFolder("/tmp/T", "r_1_1", path.posix), L.jobDir);
  // The letter never matches a folder name in the project's or an output's path.
  assert.equal(snapshotLayout("/A/b/show.aep", "r", "/t", ["/x/c/o.mov"], path.posix, id).name, "d");
  // A symlinked spelling: the chain is as deep as the deeper of the two.
  const sym = (d) => (d === "/Users/me/Dropbox/show" ? "/Users/me/Library/CloudStorage/Dropbox/show" : d);
  assert.equal(snapshotLayout("/Users/me/Dropbox/show/show.aep", "r", "/t", [], path.posix, sym).depth, 6 + 2);
  // Windows: short, whatever the project's depth — two characters a level.
  const deep = "C:\\Users\\someone\\Documents\\Client Work 2026\\Big Campaign\\Shots\\shot_010\\ae\\v12";
  const W = snapshotLayout(deep + "\\shot_010_comp_v12.aep", "r_1793320237670_7", "C:\\Users\\someone\\AppData\\Local\\Temp", [], path.win32, id);
  assert.equal(W.depth, 9 + 2);
  assert.ok(W.snap.length < 140, `${W.snap.length}: ${W.snap}`);
  assert.equal(W.snap, "C:\\Users\\someone\\AppData\\Local\\Temp\\ae-mcp-render\\r_1793320237670_7\\" + "a\\".repeat(11) + "shot_010_comp_v12.aep");
  // Where aerender's relative resolution puts each output: the chain folder
  // as many levels up as the output's folder is above the project's. A
  // subfolder or a sibling branch is not in the chain, so it is written absolutely.
  const at = (n) => "/tmp/T/ae-mcp-render/r_1_1" + "/a".repeat(n);
  assert.deepEqual(shadowDirs("/Users/me/show/out.mp4", "/Users/me/show/show.aep", L, path.posix, id), [at(5)]);
  assert.deepEqual(shadowDirs("/Users/me/out4.mp4", "/Users/me/show/show.aep", L, path.posix, id), [at(4)]);
  assert.deepEqual(shadowDirs("/Users/me/show/renders/o.mov", "/Users/me/show/show.aep", L, path.posix, id), []);
  assert.deepEqual(shadowDirs("/Users/other/o.mov", "/Users/me/show/show.aep", L, path.posix, id), []);
  assert.deepEqual(shadowDirs("c:\\users\\SOMEONE\\o.mov", deep + "\\p.aep", W, path.win32, id), [W.jobDir + "\\a".repeat(11 - 7)]);
});
await check("whatever aerender wrote anywhere in the job folder is moved to where it was asked (#215)", () => {
  const proj = path.join(tmp, "reloc", "show");
  fs.mkdirSync(proj, { recursive: true });
  const projFile = path.join(proj, "show.aep");
  fs.writeFileSync(projFile, "aep");
  const outs = [
    { index: 1, path: path.join(proj, "beside.mov") },
    { index: 2, path: path.join(proj, "f_[####].png") },
    { index: 3, path: path.join(path.dirname(proj), "up.mov") },
    { index: 4, path: path.join(proj, "untouched.mov") },
  ];
  const layout = snapshotProject(projFile, "r_reloc_1", path.join(tmp, "relocTmp"), outs.map((o) => o.path));
  const here = path.dirname(layout.snap);
  // Beside the project, a frame sequence beside it, one folder up — and one
  // a level nobody predicted (a spelling of the path AE counted against that
  // this did not foresee), which the whole-folder scan still finds.
  fs.writeFileSync(path.join(here, "beside.mov"), "movie");
  fs.writeFileSync(path.join(here, "f_0001.png"), "png");
  fs.writeFileSync(path.join(here, "f_0002.png"), "png");
  fs.writeFileSync(path.join(layout.jobDir, "up.mov"), "movie");
  fs.writeFileSync(path.join(here, "nobody-asked.txt"), "?");
  fs.writeFileSync(path.join(proj, "beside.mov"), "the previous render"); // overwrite:true
  const r = relocateShadowOutputs(outs, projFile, layout);
  assert.deepEqual(r.problems, []);
  assert.equal(r.moved.length, 4);
  assert.equal(fs.readFileSync(path.join(proj, "beside.mov"), "utf8"), "movie");
  assert.ok(fs.existsSync(path.join(proj, "f_0001.png")) && fs.existsSync(path.join(proj, "f_0002.png")));
  assert.equal(fs.readFileSync(path.join(path.dirname(proj), "up.mov"), "utf8"), "movie");
  assert.ok(!fs.existsSync(path.join(proj, "untouched.mov")));
  assert.ok(fs.existsSync(layout.snap), "the copy itself is never moved");
  assert.deepEqual(strayFiles(layout), [path.join(here, "nobody-asked.txt")], "a file no output claims is reported, not moved");
  removeSnapshot(layout.jobDir);
  assert.ok(!fs.existsSync(layout.jobDir));
  removeSnapshot(proj);
  assert.ok(fs.existsSync(projFile), "removeSnapshot only ever removes an ae-mcp-render/<job> folder");
});
await check("names and paths that merely contain the words do not fail a good render", () => {
  // The two examples from review: an output path and a comp name.
  for (const l of [
    "PROGRESS:  Output To: /renders/missing-source-v2.mov",
    "PROGRESS:  10/29/2026 10:00:00 AM: Starting composition “Cannot Find Me”.",
    "PROGRESS:  Finished composition “Cannot Find Me”.",
    "aerender WARNING: Output file /renders/missing-source-v2.mov will be overwritten",
    "aerender WARNING: Composition “Cannot Find Me” uses Multi-Frame Rendering",
    "aerender WARNING: Composition \"Cannot Find Me\" uses Multi-Frame Rendering",
  ]) {
    assert.equal(isMissingFootageLine(l), false, l);
  }
});
await check("a QuickTime/MP4 file must be complete: boxes tile the file and include moov", () => {
  const box = (type, body) => {
    const b = Buffer.alloc(8 + body.length);
    b.writeUInt32BE(8 + body.length, 0);
    b.write(type, 4, "latin1");
    body.copy(b, 8);
    return b;
  };
  const ftyp = box("ftyp", Buffer.from("qt  "));
  const mdat = box("mdat", Buffer.alloc(32));
  const moov = box("moov", Buffer.alloc(8));
  const f = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };
  assert.equal(isoMediaProblem(f("good.mov", Buffer.concat([ftyp, mdat, moov]))), null);
  const mv0 = Buffer.alloc(100); mv0.writeUInt32BE(600, 12); mv0.writeUInt32BE(300, 16);
  assert.equal(isoMediaInfo(f("d0.mov", Buffer.concat([ftyp, mdat, box("moov", box("mvhd", mv0))]))).durationSec, 0.5);
  const mv1 = Buffer.alloc(112); mv1.writeUInt8(1, 0); mv1.writeUInt32BE(1000, 20); mv1.writeBigUInt64BE(2500n, 24);
  assert.equal(isoMediaInfo(f("d1.mp4", Buffer.concat([ftyp, mdat, box("moov", box("mvhd", mv1))]))).durationSec, 2.5);
  assert.match(isoMediaProblem(f("nomoov.mov", Buffer.concat([ftyp, mdat]))), /no 'moov'/);
  const cut = Buffer.concat([ftyp, mdat, moov]).subarray(0, 40);
  assert.match(isoMediaProblem(f("cut.mov", cut)), /truncated|partial/);
  assert.match(isoMediaProblem(f("junk.mov", Buffer.from("not a movie at all, just bytes"))), /malformed|truncated|no 'moov'/);
  // The live corrupt file: 1 MiB of preallocated media and nothing else.
  const pre = Buffer.alloc(1048576);
  pre.writeUInt32BE(8, 0); pre.write("wide", 4, "latin1");
  pre.writeUInt32BE(0, 8); pre.write("mdat", 12, "latin1");
  assert.match(isoMediaProblem(f("prealloc.mov", pre)), /no 'moov'/);
});
await check("a missing-footage failure says how to fix it, other failures do not", () => {
  assert.match(missingFootageHint(["aerender ERROR: Footage file missing: /x/clip.mov"]), /save the project/);
  assert.equal(missingFootageHint(["aerender ERROR: Out of memory"]), "");
});

// ---------------------------------------------------------------------------
// The runner, against a fake aerender, on both hosts (issue #173). The fake is
// a Node script with a shebang: POSIX executes it directly, as the server
// executes aerender; Windows will not run a shebang without a shell, so there
// the runner starts it through `process.execPath` (the `interpreter` option)
// and the child cancel stops is still the fake itself. The render engine the
// fake starts is node under the engine's name -- a symlink on POSIX, a copy of
// node.exe on Windows, where a process's name is its executable's file name --
// because only processes named aerendercore are ever treated as the engine.
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
// On Windows, libuv puts a non-detached child in a job object that is closed,
// killing the child, when its parent exits. The real engine outlives aerender,
// so an engine that must outlive the fake is detached there (it still inherits
// the stdout pipe). On POSIX a plain child already outlives its parent.
const survive = process.platform === "win32";
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args));
// A minimal complete ISO media file: ftyp, mdat, moov — what a finished
// QuickTime/MP4 render looks like to the structural check.
function box(type, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(8 + body.length, 0);
  b.write(type, 4, "latin1");
  body.copy(b, 8);
  return b;
}
// mvhd v0 with timescale 600 and the duration in FAKE_DUR seconds (default:
// the 4 frames at 30fps every plan() asks for).
function mvhd(seconds) {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(600, 12);
  b.writeUInt32BE(Math.round(seconds * 600), 16);
  return box("mvhd", b);
}
function writeMovie(p) {
  const dur = Number(process.env.FAKE_DUR || 4 / 30);
  fs.writeFileSync(p, Buffer.concat([box("ftyp", Buffer.from("qt  ")), box("mdat", Buffer.alloc(64)), box("moov", mvhd(dur))]));
}
if (mode === "relative") {
  // After Effects as measured on 26.5 (#215): the output folder is saved as
  // ascend counts from the project's folder plus the names below the common
  // ancestor, and aerender uses that relative form, resolved against the
  // project it was GIVEN, whenever the folder it names exists.
  const path = require("path");
  const project = args[args.indexOf("-project") + 1];
  const spell = (d) => (process.env.FAKE_SPELLING === "given" ? path.resolve(d) : fs.realpathSync(d));
  for (let n = 0; n < 4; n++) console.log("PROGRESS:  0:00:00:0" + n + " (" + (n + 1) + "): 0 Seconds");
  for (const o of [out, process.env.FAKE_OUT2].filter(Boolean)) {
    const a = spell(process.env.FAKE_REAL_PROJ_DIR).split(path.sep);
    const b = spell(path.dirname(o)).split(path.sep);
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    let base = path.dirname(project);
    for (let n = 0; n < a.length - k; n++) base = path.dirname(base);
    const rel = path.join(base, ...b.slice(k));
    const dir = fs.existsSync(rel) ? rel : path.dirname(o);
    const name = path.basename(o);
    if (name.includes("[####]")) {
      for (let n = 0; n < 4; n++) fs.writeFileSync(path.join(dir, name.replace("[####]", String(n).padStart(4, "0"))), "png");
    } else {
      writeMovie(path.join(dir, name));
    }
  }
  process.exit(0);
}
if (mode === "shortlines") {
  console.log("PROGRESS:  0:00:00:00 (1): 0 Seconds");
  console.log("PROGRESS:  0:00:00:01 (2): 0 Seconds");
  writeMovie(out);
  process.exit(0);
}
if (mode === "silent") {
  // Exit 0, not one line of output, and the measured corrupt file: media, no index.
  const pre = Buffer.alloc(4096);
  pre.writeUInt32BE(8, 0); pre.write("wide", 4, "latin1");
  pre.writeUInt32BE(0, 8); pre.write("mdat", 12, "latin1");
  fs.writeFileSync(out, pre);
  process.exit(0);
}
if (mode === "quietseq") {
  // Another language: no line this server can read, but the frames are on disk.
  const n = Number(process.env.FAKE_SEQ_N);
  for (let i = 0; i < n; i++) fs.writeFileSync(out.replace("[####]", String(i).padStart(4, "0")), "png");
  console.log("FORTSCHRITT:  fertig");
  process.exit(0);
}
if (mode === "stuckengine") {
  // aerender exits; its engine keeps the pipe open and never goes, deaf to SIGTERM.
  const project = args[args.indexOf("-project") + 1];
  const g = spawn(process.env.FAKE_ENGINE, ["-e", "process.on('SIGTERM',()=>{}); require('fs').writeFileSync(process.env.FAKE_GRANDCHILD, String(process.pid)); setInterval(()=>{}, 1000)", "--", "-noui", "-project", project], { stdio: ["ignore", "inherit", "inherit"], detached: survive });
  g.unref();
  for (let n = 0; n < 4; n++) console.log("PROGRESS:  0:00:00:0" + n + " (" + (n + 1) + "): 0 Seconds");
  writeMovie(out);
  setTimeout(() => process.exit(0), 200);
  return;
}
if (mode === "warnlast") {
  // Frames, then the measured warning written as the very last thing before exit.
  let text = "";
  for (let n = 0; n < 4; n++) text += "PROGRESS:  0:00:00:0" + n + " (" + (n + 1) + "): 0 Seconds\\n";
  writeMovie(out);
  process.stdout.write(text + process.env.FAKE_LINE + "\\n");
  process.exit(0);
}
if (mode === "lateengine") {
  // aerender exits at once; its engine, which inherited stdout, prints the
  // warning 400ms later — the shape of the 1-in-8 live failure.
  const project = args[args.indexOf("-project") + 1];
  const g = spawn(process.env.FAKE_ENGINE, ["-e", "setTimeout(() => { console.log(process.env.FAKE_LINE); process.exit(0); }, 400)", "--", "-noui", "-project", project], { stdio: ["ignore", "inherit", "inherit"], detached: survive });
  g.unref();
  for (let n = 0; n < 4; n++) console.log("PROGRESS:  0:00:00:0" + n + " (" + (n + 1) + "): 0 Seconds");
  writeMovie(out);
  process.exit(0);
}
console.log("PROGRESS:  10/29/2026 10:00:00 AM: Starting composition “Comp”.");
console.log("PROGRESS:  Duration: 0:00:00:04");
if (mode === "fail") { console.log("aerender ERROR: Unable to find comp"); process.exit(3); }
if (mode === "inuse") {
  // #228, measured on 26.5: aerender will not render an item whose output
  // another item shares, writes nothing, and still exits 0.
  console.log("Unable to render: output module name already in use");
  process.exit(0);
}
if (mode === "realmissing") {
  // The measured 26.5 output for missing footage, then exit 0.
  console.log("PROGRESS:  0:00:00:00 (1): 0 Seconds");
  console.log(process.env.FAKE_LINE);
  console.log("Error Code: 1");
  console.log("Please restart After Effects and retry the export.");
  fs.writeFileSync(out, "not a movie");
  process.exit(0);
}
if (mode === "burst") {
  // Many frames, then an immediate exit: the last lines must still be read.
  let text = "";
  for (let n = 0; n < 300; n++) text += "PROGRESS:  0:00:00:00 (" + (n + 1) + "): 0 Seconds\\n";
  process.stdout.write(text);
  writeMovie(out);
  process.exit(0);
}
if (mode === "engine") {
  // Stands in for aerendercore as measured on 26.5: started detached (its own
  // process group, reparented away), carrying the job's -project path, and
  // deaf to SIGTERM.
  const project = args[args.indexOf("-project") + 1];
  // Named aerendercore (a symlink to node), because only processes with that
  // name are ever treated as the engine.
  const g = spawn(process.env.FAKE_ENGINE, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)", "--", "-noui", "-project", project], { detached: true, stdio: "ignore" });
  g.unref();
  fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(g.pid));
  fs.writeFileSync(out, "partial");
  console.log("PROGRESS:  0:00:00:00 (1): 0 Seconds");
  setInterval(() => {}, 1000);
  return;
}
if (mode === "placeholder") {
  // Exit 0 with a fresh, non-empty file — but the footage was missing, so
  // the file holds AE's placeholder rather than the real media.
  console.log("aerender WARNING: Footage file missing: /proj/footage/clip.mov");
  console.log("PROGRESS:  0:00:00:00 (1): 0 Seconds");
  fs.writeFileSync(out, "colour bars");
  process.exit(0);
}
if (mode === "hang") {
  fs.writeFileSync(process.env.FAKE_SELF, String(process.pid));
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
  // "quiet" stands in for an AE in another language: frames are rendered, but
  // the lines are worded differently.
  console.log(mode === "quiet" ? "FORTSCHRITT:  Bild " + (i + 1) + " fertig" : "PROGRESS:  0:00:00:0" + i + " (" + (i + 1) + "): 0 Seconds");
  i++;
  if (i === 4) {
    clearInterval(t);
    if (mode !== "liar") writeMovie(out);
    console.log("PROGRESS:  Total Time Elapsed: 1 Seconds");
    process.exit(0);
  }
}, 20);
`
);
fs.chmodSync(fake, 0o755);
const win = process.platform === "win32";
if (win) {
  process.env.FAKE_ENGINE = path.join(tmp, "aerendercore.exe");
  fs.copyFileSync(process.execPath, process.env.FAKE_ENGINE);
} else {
  process.env.FAKE_ENGINE = path.join(tmp, "aerendercore");
  fs.symlinkSync(process.execPath, process.env.FAKE_ENGINE);
}
function runnerFor(jobs, opts = {}) {
  return new RenderRunner(jobs, win ? { interpreter: process.execPath, ...opts } : opts);
}
// Kill a process and everything it started: its group on POSIX (the runner
// spawns aerender detached), `taskkill /T` on Windows.
function killTree(pid) {
  if (win) stopProcessTreeSync(pid);
  else process.kill(-pid, "SIGKILL");
}

const projectFile = path.join(tmp, "show.aep");
// Snapshots from the runner tests go here, never into the real temp folder,
// where the stale sweep could reach another session's leftovers.
const runTmp = path.join(tmp, "runTmp");
fs.writeFileSync(projectFile, "aep bytes");

function plan(out, frames = 4, timeSpanDuration = frames / 30) {
  return {
    projectPath: projectFile,
    appPackage: null,
    items: [{ index: 2, compId: 7, compName: "Comp", status: "QUEUED", frames, timeSpanDuration, outputs: [{ index: 1, path: out }] }],
  };
}
function env(mode, out) {
  delete process.env.FAKE_DUR;
  process.env.FAKE_MODE = mode;
  process.env.FAKE_OUT = out;
  process.env.FAKE_ARGS = path.join(tmp, `args-${mode}.json`);
  process.env.FAKE_GRANDCHILD = path.join(tmp, `grandchild-${mode}`);
  process.env.FAKE_SELF = path.join(tmp, `self-${mode}`);
  fs.rmSync(process.env.FAKE_SELF, { force: true });
  fs.rmSync(process.env.FAKE_GRANDCHILD, { force: true });
}
function alive(pid) {
  // kill(0) and kill(-1) mean "my own process group" and "everything I may
  // signal": a pid that is not a real one must never reach a signal (#260).
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`alive(${pid}): not a pid`);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every wait below is on something observed, bounded, and names what it was
// waiting for when it gives up (issue #260). A loaded machine makes these
// things slow; it does not change whether they happen. The old waits were
// fixed counts of short sleeps that fell through to the assertion after a
// second or two, which under load read as a product failure.
const WAIT_MS = win ? 60_000 : 20_000;
async function until(cond, what, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`gave up after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(20);
  }
}
// A pid file written by the fake or its engine. Existing is not enough:
// writeFileSync creates the file before it writes the number, a reader in
// between gets "", and Number("") is 0 — which alive() reported as a running
// process (kill(0, 0) signals this test's own group) and a cleanup
// kill(0, "SIGKILL") turned into the test killing its own process group (#260).
function pidIn(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
async function pidFrom(file, what) {
  await until(() => pidIn(file) !== null, `${what} to write its pid to ${file}`);
  return pidIn(file);
}
// Cleanup for a process the cancel should already have ended.
function killLeftover(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
}
// aerender has exited 0 on the current item, and the runner has seen it. The
// draining checks used to sleep 500ms and assume this; under load the cancel
// then came while aerender was still running, and took the other path.
async function exitedOk(runner) {
  await until(() => runner.current?.exitedOk === true, "the runner to see aerender exit 0");
}

{
  await check("a render reports per-frame progress and completes with the verified file", async () => {
    const jobs = new JobManager();
    const hooked = [];
    const runner = runnerFor(jobs, {
      tmpRoot: runTmp,
      onRendered: async (items) => { hooked.push(items.map((i) => i.index)); return items.map((i) => ({ index: i.index, marked: true })); },
    });
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
    assert.equal(st.result.rendered[0].outputs[0].bytes, fs.statSync(out).size);
    assert.equal(st.result.rendered[0].frames, 4);
    // Rendered from a private copy beside the project, never the live .aep,
    // and the copy is gone afterwards.
    const args = JSON.parse(fs.readFileSync(process.env.FAKE_ARGS, "utf8"));
    assert.equal(args[0], "-project");
    assert.equal(path.basename(args[1]), "show.aep");
    assert.ok(path.relative(path.join(runTmp, "ae-mcp-render"), args[1]).split(path.sep).length > 2, args[1]);
    assert.notEqual(path.dirname(args[1]), tmp);
    assert.deepEqual(args.slice(2), aerenderArgs("x", 2).slice(2));
    assert.ok(!fs.existsSync(args[1]), "the snapshot must be removed when the job ends");
    assert.deepEqual(hooked, [[2]], "unticked once, at the end");
    assert.deepEqual(st.result.rendered[0].unqueued, { marked: true });
    const frames = seen.filter((s) => /frame \d+ of 4/.test(s.message ?? "")).map((s) => s.progress);
    assert.deepEqual(frames, [1, 2, 3, 4]);
    assert.equal(runner.activeJobId, null);
  });

  await check("an item aerender refuses while exiting 0 fails, never reports rendered (#228)", async () => {
    const jobs = new JobManager();
    const hooked = [];
    const runner = runnerFor(jobs, { tmpRoot: runTmp, onRendered: async (items) => { hooked.push(items.map((i) => i.index)); return []; } });
    // No file at all.
    const out = path.join(tmp, "inuse.mov");
    env("inuse", out);
    const first = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(first.jobId, 10_000), /does not exist/);
    // A file from an earlier render (overwrite:true): left as it was, so not this render's.
    const old = path.join(tmp, "inuse-old.mov");
    fs.writeFileSync(old, "an earlier render");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    env("inuse", old);
    const second = runner.start(plan(old), fake);
    await assert.rejects(jobs.waitFor(second.jobId, 10_000));
    assert.equal(jobs.get(first.jobId).status, "failed");
    assert.equal(jobs.get(second.jobId).status, "failed");
    assert.deepEqual(hooked.flat(), [], "nothing is unticked as rendered");
  });

  await check("no readable frame lines: a movie with the right duration is judged rendered", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "quiet.mov");
    env("quiet", out);
    const { jobId } = runner.start(plan(out), fake);
    const st = await jobs.waitFor(jobId, 10_000);
    assert.equal(st.status, "completed");
    assert.equal(st.result.rendered[0].frames, 4, "counted from the movie, since no line was readable");
    assert.match(st.result.rendered[0].framesNote, /verified from the file/);
  });

  await check("no readable frame lines: a movie of the wrong length is not a render", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "quietshort.mov");
    env("quiet", out);
    process.env.FAKE_DUR = String(2 / 30); // two frames short of four
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), /more than a frame apart/);
  });

  await check("no readable frame lines: a format that cannot be checked fails, saying why", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "quiet.avi");
    env("quiet", out);
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), /format whose contents this server\s+cannot check|cannot check/);
  });

  await check("no readable frame lines: a sequence is judged by its frame files", async () => {
    const seqDir = path.join(tmp, "quietseq");
    fs.mkdirSync(seqDir, { recursive: true });
    const out = path.join(seqDir, "shot_[####].png");
    for (const [n, ok] of [[4, true], [3, false]]) {
      for (const f of fs.readdirSync(seqDir)) fs.rmSync(path.join(seqDir, f));
      const jobs = new JobManager();
      const runner = runnerFor(jobs, { tmpRoot: runTmp });
      env("quietseq", out);
      process.env.FAKE_SEQ_N = String(n);
      const { jobId } = runner.start(plan(out), fake);
      if (ok) assert.equal((await jobs.waitFor(jobId, 10_000)).status, "completed");
      else await assert.rejects(jobs.waitFor(jobId, 10_000), /3 fresh frame files .* where 4 were expected/);
    }
  });

  await check("outputs beside the project, one folder up, in a subfolder and on a sibling branch all land where asked (#215)", async () => {
    // The measured failure: aerender resolved an output beside the project
    // against the temp copy, wrote it into the job folder, and it was deleted
    // with the copy; one folder up it leaked into ae-mcp-render/ for good.
    const top = path.join(tmp, "p215");
    const projDir = path.join(top, "show");
    fs.mkdirSync(path.join(projDir, "renders"), { recursive: true });
    fs.mkdirSync(path.join(top, "other"), { recursive: true });
    const proj = path.join(projDir, "show.aep");
    fs.writeFileSync(proj, "aep bytes");
    process.env.FAKE_REAL_PROJ_DIR = projDir;
    const outs = [
      path.join(projDir, "beside.mov"),
      path.join(top, "up.mov"),
      path.join(projDir, "renders", "sub.mov"),
      path.join(top, "other", "sib.mov"),
      path.join(projDir, "shot_[####].png"),
    ];
    for (const out of outs) {
      const jobs = new JobManager();
      const runner = runnerFor(jobs, { tmpRoot: runTmp });
      env("relative", out);
      const p = { ...plan(out), projectPath: proj };
      const { jobId } = runner.start(p, fake);
      const st = await jobs.waitFor(jobId, 10_000);
      assert.equal(st.status, "completed", `${out}: ${st.error ?? ""}`);
      assert.equal(st.result.rendered[0].outputs[0].path, out);
      if (out.includes("[####]")) assert.ok(fs.existsSync(path.join(projDir, "shot_0003.png")));
      else assert.ok(fs.statSync(out).size > 0, out);
      assert.ok(!fs.existsSync(path.join(runTmp, "ae-mcp-render", jobId)), "the job folder is gone");
    }
    const root215 = path.join(runTmp, "ae-mcp-render");
    const leaked = fs.existsSync(root215) ? fs.readdirSync(root215).filter((n) => !fs.statSync(path.join(root215, n)).isDirectory()) : [];
    assert.deepEqual(leaked, [], "nothing written into the shared ae-mcp-render folder");
    delete process.env.FAKE_REAL_PROJ_DIR;
  });

  await check("a project reached through a symlink of another depth: outputs still land where asked, either way AE counts (#215)", async () => {
    if (win) return; // symlinked folders need privileges on Windows
    const top = path.join(tmp, "sl215");
    const real = path.join(top, "x", "y", "z", "show");
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(top, "ln");
    fs.symlinkSync(real, link);
    const proj = path.join(link, "show.aep");
    fs.writeFileSync(proj, "aep bytes");
    process.env.FAKE_REAL_PROJ_DIR = link;
    for (const spelling of ["given", "real"]) {
      process.env.FAKE_SPELLING = spelling;
      for (const out of [path.join(link, `beside-${spelling}.mov`), path.join(top, `up-${spelling}.mov`)]) {
        const jobs = new JobManager();
        const runner = runnerFor(jobs, { tmpRoot: runTmp });
        env("relative", out);
        const { jobId } = runner.start({ ...plan(out), projectPath: proj }, fake);
        const st = await jobs.waitFor(jobId, 10_000);
        assert.equal(st.status, "completed");
        assert.ok(fs.statSync(out).size > 0, `${spelling}: ${out}`);
      }
    }
    delete process.env.FAKE_SPELLING;
    delete process.env.FAKE_REAL_PROJ_DIR;
  });

  await check("a cancelled render's partial output beside the project is moved out and named, not deleted (#215)", async () => {
    const projDir = path.join(tmp, "cancel215");
    fs.mkdirSync(projDir, { recursive: true });
    const proj = path.join(projDir, "show.aep");
    fs.writeFileSync(proj, "aep bytes");
    const out = path.join(projDir, "partial.mov");
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, graceMs: 500 });
    // The hanging fake's own file goes elsewhere; the partial output is
    // written into the job folder, where aerender resolving the output
    // relative to the copy puts it.
    env("hang", path.join(tmp, "cancel215-elsewhere.mov"));
    const { jobId } = runner.start({ ...plan(out, 100), projectPath: proj }, fake);
    const shadow = path.join(path.dirname(snapshotLayout(proj, jobId, runTmp, [out]).snap), "partial.mov");
    await pidFrom(process.env.FAKE_SELF, "the fake aerender");
    fs.writeFileSync(shadow, "partial");
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, true, report.note);
    assert.deepEqual(report.partialFiles, [out]);
    assert.equal(fs.readFileSync(out, "utf8"), "partial");
    killLeftover(pidIn(process.env.FAKE_GRANDCHILD));
  });

  // The live AE check of #215: aerender exits on cancel at once, while its
  // engine — still being stopped — is what writes the partial file into the
  // job folder. The engine here is a sleeper the test owns: the runner sees
  // it through `findEngines`, never signals it (`confirmEngine` says no), and
  // the test ends it once the partial file is written — the same on both hosts.
  async function cancelWithLateEngineWrite(name, { prior, outName = "beside.mp4", priorFiles = {}, late }) {
    const projDir = path.join(tmp, `cancellate-${name}`);
    fs.mkdirSync(projDir, { recursive: true });
    const proj = path.join(projDir, "show.aep");
    fs.writeFileSync(proj, "aep bytes");
    const out = path.join(projDir, outName);
    if (prior !== undefined) fs.writeFileSync(out, prior);
    for (const [n, c] of Object.entries(priorFiles)) fs.writeFileSync(path.join(projDir, n), c);
    const priorStat = prior !== undefined ? fs.statSync(out) : null;
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
    const jobs = new JobManager();
    const runner = runnerFor(jobs, {
      tmpRoot: runTmp,
      graceMs: 4000,
      findEngines: async () => (alive(sleeper.pid) ? [sleeper.pid] : []),
      confirmEngine: async () => false,
    });
    env("hang", path.join(tmp, `cancellate-${name}-elsewhere.mov`));
    const { jobId } = runner.start({ ...plan(out, 100), projectPath: proj }, fake);
    const shadowDir = path.dirname(snapshotLayout(proj, jobId, runTmp, [out]).snap);
    const shadow = path.join(shadowDir, outName);
    const aerenderPid = await pidFrom(process.env.FAKE_SELF, "the fake aerender");
    const cancelling = runner.cancel(jobId);
    await until(() => !alive(aerenderPid), "aerender to exit on the cancel");
    await sleep(300);
    // The engine writes its partial file after aerender has gone — into the
    // job folder as it stands, never re-creating a folder that was removed.
    let wrote = true;
    try {
      if (late) late(shadowDir, projDir);
      else fs.writeFileSync(shadow, "partial");
    } catch { wrote = false; }
    sleeper.kill("SIGKILL");
    const report = await cancelling;
    await until(() => !runner.activeJobId, "the cancelled job to end");
    return { out, shadow, shadowDir, projDir, wrote, report, priorStat, jobs, jobId };
  }

  await check("cancel: a partial the engine writes after aerender exits is moved where asked and named, not deleted with the copy (#215 review)", async () => {
    const { out, wrote, report, jobs, jobId } = await cancelWithLateEngineWrite("fresh", {});
    assert.ok(wrote, "the job folder was removed while cancel was still stopping the engine");
    assert.equal(report.stopped, true, report.note);
    assert.deepEqual(report.partialFiles, [out]);
    assert.equal(fs.readFileSync(out, "utf8"), "partial");
    assert.match(report.note, /may be INCOMPLETE: the render was stopped before After Effects confirmed it finished/);
    assert.match(report.note, /check its duration or frame count/);
    assert.doesNotMatch(report.note, /or delete those files by name/, "never a bare instruction to delete");
    assert.equal(jobs.get(jobId).status, "cancelled");
  });

  await check("cancel: a correctly named output whose move failed is named as a move failure, never as discarded (#217 final)", async () => {
    const { wrote, report } = await cancelWithLateEngineWrite("movefail", {
      late: (sd, pd) => {
        fs.mkdirSync(path.join(pd, "beside.mp4")); // the move onto it fails
        fs.writeFileSync(path.join(sd, "beside.mp4"), "partial");
      },
    });
    assert.ok(wrote);
    assert.match(report.note, /could not be moved out of the render's private copy folder/);
    assert.doesNotMatch(report.note, /discarded with it/, report.note);
  });

  await check("cancel: an unfinished file After Effects wrote under another name is said to be discarded, not 'nothing found' (#217 live)", async () => {
    const { wrote, report } = await cancelWithLateEngineWrite("tmpname", {
      late: (sd) => fs.writeFileSync(path.join(sd, "beside_inprogress.m4v"), Buffer.alloc(4096)),
    });
    assert.ok(wrote);
    assert.equal(report.stopped, true, report.note);
    assert.deepEqual(report.partialFiles, []);
    assert.doesNotMatch(report.note, /No partial output was found on disk/);
    assert.match(report.note, /unfinished file\(s\)[^]*discarded[^]*beside_inprogress\.m4v/);
  });

  await check("cancel: a complete file from an earlier render is never reported as partial, nor replaced (#215 review)", async () => {
    const { out, shadow, wrote, report, priorStat } = await cancelWithLateEngineWrite("prior", { prior: "old complete render" });
    assert.ok(wrote);
    assert.equal(report.stopped, true, report.note);
    assert.ok(!report.partialFiles.includes(out), `the earlier render's file was named as partial: ${report.partialFiles}`);
    assert.equal(fs.readFileSync(out, "utf8"), "old complete render", "the earlier render's file must be untouched");
    assert.equal(fs.statSync(out).mtimeMs, priorStat.mtimeMs);
    assert.deepEqual(report.partialFiles, [shadow], "the partial is named where it actually is");
    assert.equal(fs.readFileSync(shadow, "utf8"), "partial", "the kept partial survives the job's end");
    assert.ok(!fs.existsSync(path.join(path.dirname(shadow), "show.aep")), "the project copy itself is still removed");
    assert.ok(report.note.slice(report.note.indexOf("do not delete them:")).includes(out), report.note);
    assert.match(report.note, /NOT replaced/);
    assert.match(report.note, /first render_queue started a day or more from now/);
  });

  await check("cancel: a sequence partly over an earlier render's frames names each file where it is, never the pattern (#217 review)", async () => {
    const { out, shadowDir, projDir, wrote, report } = await cancelWithLateEngineWrite("mixedseq", {
      outName: "f_[####].png",
      priorFiles: { "f_0000.png": "old 0", "f_0001.png": "old 1", "f_0003.png": "old 3" },
      late: (sd, pd) => {
        fs.writeFileSync(path.join(pd, "f_0000.png"), "new 0, written in place"); // aerender overwrote it
        fs.writeFileSync(path.join(sd, "f_0001.png"), "new 1"); // would replace an old frame
        fs.writeFileSync(path.join(sd, "f_0002.png"), "new 2"); // a frame that did not exist
      },
    });
    assert.ok(wrote);
    assert.equal(report.stopped, true, report.note);
    const want = [path.join(projDir, "f_0000.png"), path.join(projDir, "f_0002.png"), path.join(shadowDir, "f_0001.png")];
    assert.deepEqual([...report.partialFiles].sort(), [...want].sort());
    assert.ok(!report.partialFiles.includes(out), "never the pattern, which also covers old frames");
    assert.equal(fs.readFileSync(path.join(projDir, "f_0001.png"), "utf8"), "old 1");
    assert.equal(fs.readFileSync(path.join(projDir, "f_0003.png"), "utf8"), "old 3");
    assert.equal(fs.readFileSync(path.join(shadowDir, "f_0001.png"), "utf8"), "new 1");
    assert.equal(fs.readFileSync(path.join(projDir, "f_0002.png"), "utf8"), "new 2");
    assert.ok(!report.note.includes(out), "the note never names the pattern as something to delete");
    const part = (label) => report.note.slice(report.note.indexOf(label)).split(". ")[0];
    assert.ok(part("At the asked location:").includes(path.join(projDir, "f_0002.png")));
    assert.ok(part("In the temp folder").includes(path.join(shadowDir, "f_0001.png")));
    const keepList = report.note.slice(report.note.indexOf("do not delete them:"));
    assert.ok(keepList.includes(path.join(projDir, "f_0001.png")) && keepList.includes(path.join(projDir, "f_0003.png")));
  });

  await check("cancel while the last item's queue is being unticked: nothing is called partial (#217 review)", async () => {
    const jobs = new JobManager();
    let release;
    const hookEntered = new Promise((res) => {
      release = res;
    });
    let unblock;
    const gate = new Promise((res) => (unblock = res));
    const runner = runnerFor(jobs, {
      tmpRoot: runTmp,
      onRendered: async (items) => {
        release();
        await gate;
        return items.map((i) => ({ index: i.index, marked: true }));
      },
    });
    const out = path.join(tmp, "settling.mov");
    env("ok", out);
    const { jobId } = runner.start(plan(out), fake);
    await hookEntered;
    const report = await runner.cancel(jobId);
    unblock();
    const st = await jobs.waitFor(jobId, 10_000);
    assert.equal(st.status, "completed");
    assert.equal(st.result.rendered[0].outputs[0].path, out);
    assert.ok(!(report.partialFiles ?? []).includes(out), "a verified output is never partial");
    assert.equal(report.stopped, false);
    assert.equal(report.wasRunning, false);
    assert.doesNotMatch(report.note, /INCOMPLETE/);
  });

  await check("cancel: an earlier render's file the cancelled render never touched is not a partial; a sequence's old frames neither", async () => {
    const dir = path.join(tmp, "partials-pure");
    fs.mkdirSync(dir, { recursive: true });
    const mov = path.join(dir, "old.mov");
    const seq = path.join(dir, "f_[####].png");
    fs.writeFileSync(mov, "old");
    fs.writeFileSync(path.join(dir, "f_0000.png"), "old");
    const outputs = [{ index: 1, path: mov }, { index: 2, path: seq }];
    const before = stampOutputs(outputs);
    assert.deepEqual(cancelledPartials(outputs, before), [], "nothing new was written");
    fs.writeFileSync(path.join(dir, "f_0001.png"), "new frame");
    const f1 = path.join(dir, "f_0001.png");
    assert.deepEqual(cancelledPartials(outputs, before), [f1], "the new frame, by name; never the pattern");
    await sleep(20);
    fs.writeFileSync(mov, "rewritten by aerender in place");
    assert.deepEqual(cancelledPartials(outputs, before), [mov, f1], "a file the render rewrote in place is partial");
  });

  await check("cancel while a finished item's output is still draining: it is verified and reported rendered, never INCOMPLETE (#217 round 3)", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, drainCapMs: 1500 });
    const out = path.join(tmp, "draining.mov");
    env("stuckengine", out);
    const { jobId } = runner.start(plan(out), fake);
    await pidFrom(process.env.FAKE_GRANDCHILD, "the stuck engine");
    await exitedOk(runner); // aerender has exited 0; its engine still holds the output open
    const t0 = Date.now();
    const report = await runner.cancel(jobId);
    assert.ok(Date.now() - t0 < 1000, `the cancel held the caller ${Date.now() - t0}ms for the drain`);
    assert.equal(report.status, "finishing");
    assert.match(report.note, /being verified now/);
    assert.match(jobs.get(jobId).message ?? "", /Cancel requested/);
    const st = await jobs.waitFor(jobId, 15_000);
    assert.equal(st.status, "completed", st.error);
    assert.equal(st.result.rendered[0].outputs[0].path, out);
    assert.ok(!(report.partialFiles ?? []).includes(out), `a finished file was called partial: ${report.note}`);
    assert.doesNotMatch(report.note, /INCOMPLETE/);
    assert.equal(report.wasRunning, false);
  });

  await check("cancel while a finished item drains, with a later item queued: verified, the later one never starts, the job is cancelled (#217 round 4)", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, drainCapMs: 1500 });
    const out = path.join(tmp, "draining2.mov");
    env("stuckengine", out);
    const p = plan(out);
    p.items.push({ ...p.items[0], index: 3, outputs: [{ index: 1, path: path.join(tmp, "never.mov") }] });
    const { jobId } = runner.start(p, fake);
    await pidFrom(process.env.FAKE_GRANDCHILD, "the stuck engine");
    await exitedOk(runner);
    const report = await runner.cancel(jobId);
    assert.equal(report.status, "finishing");
    const st = await jobs.waitFor(jobId, 15_000).catch((e) => ({ status: "threw", error: e.message }));
    const final = jobs.get(jobId);
    assert.equal(final.status, "cancelled", JSON.stringify(st));
    assert.deepEqual(final.result.rendered.map((x) => x.index), [2]);
    assert.equal(final.result.stopped, true, final.result.note);
    assert.match(final.result.note, /no later item was started/);
    assert.ok(!fs.existsSync(path.join(tmp, "never.mov")));
  });

  for (const [ok, dur] of [[false, 2 / 30], [true, 4 / 30]]) {
    await check(`an output beside the project over an earlier file: ${ok ? "replaces it once verified" : "a failed render never replaces it, and says where its file is"} (#217 round 3)`, async () => {
      const projDir = path.join(tmp, `over-${ok}`);
      fs.mkdirSync(projDir, { recursive: true });
      const proj = path.join(projDir, "show.aep");
      fs.writeFileSync(proj, "aep bytes");
      const out = path.join(projDir, "beside.mov");
      fs.writeFileSync(out, "old complete render");
      process.env.FAKE_REAL_PROJ_DIR = projDir;
      const jobs = new JobManager();
      const runner = runnerFor(jobs, { tmpRoot: runTmp });
      env("relative", out);
      process.env.FAKE_DUR = String(dur);
      const { jobId } = runner.start({ ...plan(out), projectPath: proj }, fake);
      const kept = path.join(path.dirname(snapshotLayout(proj, jobId, runTmp, [out]).snap), "beside.mov");
      if (ok) {
        const st = await jobs.waitFor(jobId, 10_000);
        assert.equal(st.status, "completed", st.error);
        assert.equal(st.result.rendered[0].outputs[0].path, out);
        assert.notEqual(fs.readFileSync(out, "utf8"), "old complete render", "the verified render replaced the earlier file");
        assert.ok(!fs.existsSync(path.join(runTmp, "ae-mcp-render", jobId)), "nothing left in the job folder");
      } else {
        let err = "";
        await jobs.waitFor(jobId, 10_000).catch((e) => (err = e.message));
        assert.match(err, /more than a frame apart/);
        assert.equal(fs.readFileSync(out, "utf8"), "old complete render", "a failed render must not replace the earlier file");
        assert.ok(fs.existsSync(kept), "the failed render's file is kept in the temp folder");
        assert.ok(err.includes(kept) && /NOT replaced/.test(err), err);
        assert.ok(err.includes(`Unchanged from before this render, not its output: ${out}`), err);
        assert.doesNotMatch(err, /deleted as the job ends/, "a kept file is not an unforeseen #215 stray");
      }
      delete process.env.FAKE_REAL_PROJ_DIR;
    });
  }

  await check("two same-named outputs in different folders over earlier files: each lands at its own path (#217 round 4)", async () => {
    const top = path.join(tmp, "twin");
    const projDir = path.join(top, "show");
    fs.mkdirSync(projDir, { recursive: true });
    const proj = path.join(projDir, "show.aep");
    fs.writeFileSync(proj, "aep bytes");
    const a = path.join(projDir, "out.mov");
    const b = path.join(top, "out.mov");
    fs.writeFileSync(a, "old a");
    fs.writeFileSync(b, "old b");
    process.env.FAKE_REAL_PROJ_DIR = projDir;
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    env("relative", a);
    process.env.FAKE_OUT2 = b;
    const p = { ...plan(a), projectPath: proj };
    p.items[0].outputs = [{ index: 1, path: a }, { index: 2, path: b }];
    const { jobId } = runner.start(p, fake);
    const st = await jobs.waitFor(jobId, 10_000);
    delete process.env.FAKE_OUT2;
    delete process.env.FAKE_REAL_PROJ_DIR;
    assert.equal(st.status, "completed", st.error);
    assert.deepEqual(st.result.rendered[0].outputs.map((o) => o.path), [a, b]);
    assert.notEqual(fs.readFileSync(a, "utf8"), "old a");
    assert.notEqual(fs.readFileSync(b, "utf8"), "old b", "the second folder's earlier file must be replaced too");
  });

  await check("a stuck engine cannot hold the job open: killed at the cap, then decided", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, drainCapMs: 1200 });
    const out = path.join(tmp, "stuck.mov");
    env("stuckengine", out);
    const t0 = Date.now();
    const { jobId } = runner.start(plan(out), fake);
    const st = await jobs.waitFor(jobId, 15_000);
    assert.equal(st.status, "completed");
    assert.ok(Date.now() - t0 < 10_000);
    const engine = await pidFrom(process.env.FAKE_GRANDCHILD, "the stuck engine");
    await until(() => !alive(engine), "the stuck engine, killed at the cap, to exit");
  });

  await check("an aerender that prints nothing and exits 0 is not a render", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "silent.mov");
    env("silent", out);
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), /no 'moov' index/);
  });

  await check("a warning written just before exit is read before the item is decided", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "warnlast.mov");
    env("warnlast", out);
    process.env.FAKE_LINE = REAL_MISSING_FOOTAGE_LINE;
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), /missing footage/);
  });

  await check("a warning the engine prints after aerender has exited is still read", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "lateengine.mov");
    env("lateengine", out);
    process.env.FAKE_LINE = REAL_MISSING_FOOTAGE_LINE;
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), /missing footage/);
  });

  await check("the measured missing-footage output fails the job although aerender exits 0", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "realmissing.mov");
    env("realmissing", out);
    process.env.FAKE_LINE = REAL_MISSING_FOOTAGE_LINE;
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(
      jobs.waitFor(jobId, 10_000),
      (e) => /missing footage/.test(e.message) && /NOT reported as rendered/.test(e.message) && /File Not Found/.test(e.message)
    );
  });

  await check("the reported frame count is never lower than the file proves", async () => {
    // Progress lines short of the truth (late or coalesced, as measured on
    // 26.5): two lines read for a movie that holds all four frames.
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "short.mov");
    env("shortlines", out);
    const { jobId } = runner.start(plan(out), fake);
    const st = await jobs.waitFor(jobId, 10_000);
    assert.equal(st.status, "completed");
    assert.equal(st.result.rendered[0].frames, 4);
    assert.equal(st.result.rendered[0].framesVerified, 4);
    assert.equal(st.result.rendered[0].framesNote, undefined);
  });

  await check("frames printed just before exit are all counted", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "burst.mov");
    env("burst", out);
    process.env.FAKE_DUR = "10";
    const { jobId } = runner.start(plan(out, 300), fake);
    const st = await jobs.waitFor(jobId, 10_000);
    assert.equal(st.result.rendered[0].frames, 300);
  });

  await check("cancel finds and kills a detached render engine that ignores SIGTERM", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, graceMs: 500 });
    const out = path.join(tmp, "engine.mov");
    env("engine", out);
    const { jobId } = runner.start(plan(out, 100), fake);
    const engine = await pidFrom(process.env.FAKE_GRANDCHILD, "the detached render engine");
    assert.ok(alive(engine));
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, true, report.note);
    assert.ok(!alive(engine), "the engine must be dead before stopped:true is reported");
    assert.equal(jobs.get(jobId).status, "cancelled");
  });

  await check("cancel never signals a decoy that mentions the job's snapshot", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, graceMs: 500 });
    const out = path.join(tmp, "decoy.mov");
    env("hang", out);
    const { jobId } = runner.start(plan(out, 100), fake);
    await pidFrom(process.env.FAKE_GRANDCHILD, "the fake's grandchild");
    const snapPath = snapshotLayout(projectFile, jobId, runTmp, [out]).snap;
    // A non-aerender process whose arguments hold this job's snapshot path and id.
    const decoy = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", "--", jobId, snapPath], { detached: true, stdio: "ignore" });
    decoy.unref();
    await sleep(100);
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, true, report.note);
    assert.ok(alive(decoy.pid), "a process that only mentions the snapshot must survive the cancel");
    process.kill(decoy.pid, "SIGKILL");
    killLeftover(pidIn(process.env.FAKE_GRANDCHILD));
  });

  await check("exit 0 with missing footage is a failure, even with a fresh file on disk", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "placeholder.mov");
    env("placeholder", out);
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(
      jobs.waitFor(jobId, 10_000),
      (e) => /reported missing footage/.test(e.message) && /NOT reported as rendered/.test(e.message) && /clip\.mov/.test(e.message)
    );
    assert.ok(fs.existsSync(out), "the file exists — which is exactly why the on-disk check alone was not enough");
  });

  await check("exit 0 with no file written is a failure, not a render", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "liar.mov");
    env("liar", out);
    const { jobId } = runner.start(plan(out), fake);
    await assert.rejects(jobs.waitFor(jobId, 10_000), (e) => /output cannot be verified/.test(e.message) && /does not exist/.test(e.message));
    assert.equal(jobs.get(jobId).status, "failed");
  });

  await check("a non-zero exit fails with aerender's own error lines", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
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
    // Never through the interpreter: node would start and fail to find the
    // script, which is an exit code, not the spawn failure tested here.
    const runner = new RenderRunner(jobs, { tmpRoot: runTmp });
    const { jobId } = runner.start(plan(path.join(tmp, "x.mov")), path.join(tmp, "no-such-aerender"));
    await assert.rejects(jobs.waitFor(jobId, 10_000), /could not be started/);
  });

  await check("cancel kills the whole tree and reports stopped only after the exit", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp, graceMs: 3000 });
    const out = path.join(tmp, "hang.mov");
    env("hang", out);
    const { jobId } = runner.start(plan(out, 100), fake);
    const grandchild = await pidFrom(process.env.FAKE_GRANDCHILD, "the fake's grandchild");
    assert.ok(alive(grandchild), "the fake's grandchild should be running before the cancel");
    // The fake writes its partial file just after the grandchild's pid: wait
    // for it, or a fast cancel lands in between (a CI flake, #217).
    await until(() => fs.existsSync(out), `the fake to write its partial file ${out}`);
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, true);
    assert.equal(report.wasRunning, true);
    assert.deepEqual(report.partialFiles, [out]);
    assert.match(report.note, /may be INCOMPLETE/);
    assert.equal(jobs.get(jobId).status, "cancelled");
    assert.equal(jobs.get(jobId).result.stopped, true);
    // The signal has been sent; on a loaded machine the exit can take a while.
    // A grandchild the cancel never signalled stays alive, and this times out.
    await until(() => !alive(grandchild), "the grandchild to exit — cancel must stop the render engine too, not only aerender");
    await until(() => runner.activeJobId === null, "the runner to let go of the cancelled job");
  });

  await check("a cancel that could not see the exit still settles the job when the exit comes", async () => {
    const jobs = new JobManager();
    // A stop that does nothing: the process outlives the cancel, as an engine
    // started outside aerender's group would.
    const runner = runnerFor(jobs, { tmpRoot: runTmp, graceMs: 100, stop: async () => {}, findEngines: async () => [] });
    const out = path.join(tmp, "stubborn.mov");
    env("hang", out);
    const { jobId } = runner.start(plan(out, 100), fake);
    const pid = await pidFrom(process.env.FAKE_SELF, "the fake aerender");
    const grandchild = await pidFrom(process.env.FAKE_GRANDCHILD, "the fake's grandchild");
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, false);
    assert.equal(jobs.get(jobId).status, "running");
    const waiting = jobs.waitFor(jobId, 5000);
    killTree(pid);
    const st = await waiting;
    assert.equal(st.status, "cancelled");
    assert.equal(st.result.stopped, true);
    assert.match(st.result.note, /after cancel_job had reported it still running/);
    assert.match(st.result.note, /may be INCOMPLETE|No partial output was found/, "the follow-up names where the partial is, like a normal cancel");
    killLeftover(grandchild);
  });

  await check("cancelling a finished render says there was nothing to cancel", async () => {
    const jobs = new JobManager();
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
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
    const runner = runnerFor(jobs, { tmpRoot: runTmp });
    const out = path.join(tmp, "ok3.mov");
    env("ok", out);
    const { jobId } = runner.start(plan(out), fake);
    assert.throws(() => runner.start(plan(out), fake), /already running/);
    await jobs.waitFor(jobId, 10_000);
  });
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
  // A symlinked or aliased folder: path -> where it leads.
  const links = opts.links ?? {};
  class MockFolder {
    constructor(p) { this.fsName = p; }
    get exists() { return dirs.has(this.fsName); }
    get alias() { return Object.prototype.hasOwnProperty.call(links, this.fsName); }
    resolve() { return this.alias ? new MockFolder(links[this.fsName]) : null; }
  }
  let mtime = 1000;
  class MockFile {
    constructor(p) { this.fsName = String(p); }
    get readonly() { return opts.readOnly === true && this.fsName === "/proj/show.aep"; }
    get modified() { return { getTime: () => mtime }; }
    get exists() { return files.has(this.fsName); }
    get parent() { return new MockFolder(this.fsName.substring(0, this.fsName.lastIndexOf("/")) || "/"); }
  }
  class CompItem {}
  class FootageItem {}
  const comp = Object.assign(new CompItem(), { id: 7, name: "Lower Third", frameRate: 30, numLayers: 0 });
  if (opts.missingFootage) {
    // comp -> [ok footage, nested comp -> [missing footage], the same nested comp again]
    const ok = Object.assign(new FootageItem(), { id: 20, name: "bg.png", footageMissing: false });
    const gone = Object.assign(new FootageItem(), { id: 21, name: "pic.png", footageMissing: true });
    const nested = Object.assign(new CompItem(), { id: 30, name: "Inner", numLayers: 1, layer: () => ({ source: gone }) });
    const layers = [{ source: ok }, { source: nested }, { source: nested }, { source: null }];
    comp.numLayers = layers.length;
    comp.layer = (i) => layers[i - 1];
  }
  const items = [];
  function makeItem(c, status) {
    let omFile = null;
    const om = {
      // With `forceExt`, After Effects changes the extension to match the format.
      get file() { return omFile; },
      set file(f) { omFile = f && opts.forceExt ? new MockFile(f.fsName.replace(/\.[^./]+$/, opts.forceExt)) : f; },
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
  (opts.existing ?? []).forEach((s, i) => {
    const it = makeItem(comp, RQItemStatus[s]);
    it.outputModule().file = new MockFile(opts.existingPaths?.[i] ?? "/renders/existing.mov");
    items.push(it);
  });
  const project = {
    file: opts.unsaved ? null : new MockFile("/proj/show.aep"),
    dirty: opts.dirty !== false,
    save() {
      log.push("save");
      if (opts.saveNoop) return; // a converted or locked project, under suppressed dialogs
      if (!opts.sameSecond) mtime += 1000; // File.modified has 1s resolution
      this.dirty = false;
    },
    itemByID: (id) => (id === 7 ? comp : null),
    renderQueue: {
      get numItems() { return items.length; },
      item: (i) => items[i - 1],
      items: { add: (c) => { const it = makeItem(c); items.push(it); log.push("add"); return it; } },
    },
  };
  const ctx = {
    OPS: {},
    JSON,
    getCompById: (id) => { const c = project.itemByID(id); if (!c) throw new Error("No comp with id " + id); return c; },
    File: MockFile,
    Folder: Object.assign(MockFolder, { appPackage: new MockFolder("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app") }),
    RQItemStatus,
    CompItem,
    FootageItem,
    GetSettingsFormat: { STRING: 1 },
    app: {
      project,
      version: "26.3",
      beginSuppressDialogs() { log.push("suppress"); },
      beginUndoGroup(n) { log.push("undo:begin:" + n); },
      endUndoGroup() { log.push("undo:end"); },
      endSuppressDialogs() { log.push("unsuppress"); },
    },
  };
  vm.createContext(ctx);
  // core.jsx for dispatch(), undo grouping and noUndo/undoNamed — the real
  // ones, so the undo step a handler takes is the one After Effects would get.
  vm.runInContext(fs.readFileSync(path.join(root, "packages", "jsx", "core.jsx"), "utf8"), ctx, { filename: "core.jsx" });
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
// Issue #228: aerender will not render an item whose output another item has
// ("output module name already in use") — any item but a DONE one, UNQUEUED
// included, and [####] patterns too (measured on 26.5) — and exits 0.
await check("add_to_render_queue refuses a path another QUEUED item writes, naming it, and queues nothing (#228)", () => {
  const { ctx, items, log } = makeAe({ existing: ["QUEUED"] });
  const msg = throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/existing.mov" }));
  assert.match(msg, /item 1 \(comp "Lower Third", compId 7\) already has the output \/renders\/existing\.mov/);
  assert.match(msg, /output module name already in use/);
  assert.match(msg, /remove_render_item/);
  assert.equal(items.length, 1);
  assert.deepEqual(log, [], "refused before the queue is touched");
  // overwrite:true is about a file on disk; it does not lift this.
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/existing.mov", overwrite: true })), /already has the output/);
});
await check("the same file in another spelling is the same file: case, NFD, a linked folder (#228)", () => {
  const { ctx, items } = makeAe({
    existing: ["QUEUED", "QUEUED"],
    existingPaths: ["/renders/Caf\u00e9.mov", "/private/tmp/out.mov"],
    dirs: ["/renders", "/RENDERS", "/tmp", "/private/tmp"], // the mock is case-sensitive; the volume is not
    links: { "/tmp": "/private/tmp" },
  });
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/RENDERS/cafe\u0301.MOV" })), /item 1 .*Caf\u00e9\.mov, the same file as/);
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/tmp/out.mov" })), /item 2 .*\/private\/tmp\/out\.mov/);
  assert.equal(items.length, 2);
  // A different file is still fine.
  ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/cafe.mov" });
  assert.equal(items.length, 3);
});
await check("an UNQUEUED item still counts and is named as such; a DONE one does not (#228, measured)", () => {
  const un = makeAe({ existing: ["UNQUEUED"], files: ["/renders/existing.mov"] });
  const msg = throwsMsg(() => un.ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/existing.mov", overwrite: true }));
  assert.match(msg, /item 1 \(comp "Lower Third", compId 7\), UNQUEUED \(already rendered, or switched off\), already has the output/);
  assert.match(msg, /even an unticked one/);
  assert.match(msg, /Remove it first with remove_render_item\(\{index: 1, compId: 7\}\) \(a file it rendered stays on disk\)/);
  assert.equal(un.items.length, 1);
  const done = makeAe({ existing: ["DONE"], files: ["/renders/existing.mov"] });
  done.ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/existing.mov", overwrite: true });
  assert.equal(done.items.length, 2);
});
await check("a /tmp-style link ExtendScript resolves against /Volumes still matches /private/tmp (#228, measured)", () => {
  const { ctx } = makeAe({
    existing: ["QUEUED"],
    existingPaths: ["/private/tmp/out.mov"],
    dirs: ["/renders", "/tmp", "/private/tmp"],
    links: { "/tmp": "/Volumes/private/tmp" }, // what Folder("/tmp").resolve() answered on 26.5
  });
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/tmp/out.mov" })), /item 1 .*\/private\/tmp\/out\.mov/);
  const key = (q) => vm.runInContext(`__rqPathKey(${JSON.stringify(q)})`, ctx);
  assert.equal(key("/tmp/a.mov"), key("/private/tmp/a.mov"));
  // An answer that leads nowhere is not used: the path is kept as written.
  const odd = makeAe({ dirs: ["/x"], links: { "/x": "/Volumes/nowhere" } });
  assert.equal(vm.runInContext(`__rqPathKey("/x/a.mov")`, odd.ctx), "/x/a.mov");
});
await check("a clash that appears only once After Effects changes the extension is refused, and the item removed (#228)", () => {
  const { ctx, items, log } = makeAe({ existing: ["QUEUED"], existingPaths: ["/renders/lt.mp4"], forceExt: ".mp4" });
  const msg = throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/lt.mov" }));
  assert.match(msg, /item 1 .*\/renders\/lt\.mp4/);
  assert.equal(items.length, 1);
  assert.deepEqual(log, ["add", "remove"]);
});
await check("the NFC table composes exactly as Node does (#228)", () => {
  const { ctx } = makeAe();
  const table = vm.runInContext("__RQ_NFC_PAIRS", ctx);
  assert.equal(table.length % 3, 0);
  for (let i = 0; i < table.length; i += 3) {
    assert.equal((table[i] + table[i + 1]).normalize("NFC"), table[i + 2], `entry ${i / 3}`);
  }
  const nfc = (s) => vm.runInContext(`__rqNfc(${JSON.stringify(s)})`, ctx);
  for (const word of ["Caf\u00e9", "\u1EC7", "\u00c5ngstr\u00f6m", "\u30ac\u30d1", "\ud55c\uae00", "\u0419", "\u1F04", "plain"]) {
    assert.equal(nfc(word.normalize("NFD")), word.normalize("NFC"), word);
  }
});
await check("_render_prepare lists every item but DONE ones it leaves alone, for the duplicate check (#228)", () => {
  const { ctx } = makeAe({ existing: ["QUEUED", "DONE", "QUEUED", "UNQUEUED"], existingPaths: ["/r/a.mov", "/r/b.mov", "/r/c.mov", "/r/d.mov"] });
  const plan = ctx.OPS._render_prepare({ indices: [1] });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.otherQueued)), [
    { index: 3, compId: 7, compName: "Lower Third", status: "QUEUED", outputs: [{ index: 1, path: "/r/c.mov", template: "High Quality" }] },
    { index: 4, compId: 7, compName: "Lower Third", status: "UNQUEUED", outputs: [{ index: 1, path: "/r/d.mov", template: "High Quality" }] },
  ]);
});
await check("render_queue's plan check: one file written by two QUEUED items is named, rendered or not (#228)", () => {
  const item = (index, p, compName = "A") => ({ index, compId: 1, compName, status: "QUEUED", frames: 1, outputs: [{ index: 1, path: p }] });
  const dir = fs.mkdtempSync(path.join(tmp, "dup-"));
  const link = path.join(tmp, "dup-link");
  fs.symlinkSync(dir, link);
  const base = { projectPath: "/p.aep", appPackage: null };
  // Two rendered items, one file.
  assert.deepEqual(duplicateOutputs({ ...base, items: [item(1, path.join(dir, "x.mov")), item(2, path.join(dir, "x.mov"), "B")] }), [
    `${path.join(dir, "x.mov")} is written by item 1 ("A", compId 1) and item 2 ("B", compId 1)`,
  ]);
  // A rendered item and one left in the queue, through a symlinked folder.
  const viaLink = duplicateOutputs({ ...base, items: [item(2, path.join(link, "y.mov"))], otherQueued: [item(1, path.join(dir, "y.mov"), "B")] });
  assert.equal(viaLink.length, 1);
  assert.match(viaLink[0], /item 1 \("B", compId 1\) and item 2 \("A", compId 1\) as .*dup-link/);
  // Unicode spelling and case, as on macOS and Windows.
  assert.equal(duplicateOutputs({ ...base, items: [item(1, "/r/Caf\u00e9.mov"), item(2, "/r/cafe\u0301.MOV")] }, "darwin").length, 1);
  assert.equal(duplicateOutputs({ ...base, items: [item(1, "C:\\r\\A.mov"), item(2, "c:/r/a.mov")] }, "win32").length, 1);
  assert.equal(duplicateOutputs({ ...base, items: [item(1, "/r/A.mov"), item(2, "/r/a.mov")] }, "linux").length, 0);
  // Two items left alone that clash with each other are not this render's business; distinct files are fine.
  assert.deepEqual(duplicateOutputs({ ...base, items: [item(1, "/r/a.mov")], otherQueued: [item(2, "/r/b.mov"), item(3, "/r/b.mov")] }), []);
  // Two output modules of one item writing one file.
  const twoOms = { ...item(1, "/r/a.mov"), outputs: [{ index: 1, path: "/r/a.mov" }, { index: 2, path: "/r/a.mov" }] };
  assert.equal(duplicateOutputs({ ...base, items: [twoOms] }).length, 1);
  // One item named twice is one item.
  assert.deepEqual(duplicateOutputs({ ...base, items: [item(2, "/r/a.mov"), item(2, "/r/a.mov")] }), []);
  // A shared [####] pattern is refused too: aerender refuses it whatever the frame ranges (measured).
  assert.equal(duplicateOutputs({ ...base, items: [item(1, "/r/s_[####].png"), item(2, "/r/s_[####].png")] }).length, 1);
  // An UNQUEUED item left alone counts, and is named as such; a DONE one does not.
  const un = { ...item(1, "/r/z.mov", "Old"), status: "UNQUEUED" };
  assert.deepEqual(duplicateOutputs({ ...base, items: [item(2, "/r/z.mov")], otherQueued: [un] }), [
    `/r/z.mov is written by item 1 ("Old", compId 1), UNQUEUED, and item 2 ("A", compId 1)`,
  ]);
  assert.deepEqual(duplicateOutputs({ ...base, items: [item(2, "/r/z.mov")], otherQueued: [{ ...un, status: "DONE" }] }), []);
});
await check("_render_prepare renders an index named twice once (#228 review)", () => {
  const { ctx } = makeAe({ existing: ["QUEUED", "QUEUED"], existingPaths: ["/r/a.mov", "/r/b.mov"] });
  const plan = ctx.OPS._render_prepare({ indices: [2, 2] });
  assert.deepEqual(Array.from(plan.items, (i) => i.index), [2]);
  assert.deepEqual(Array.from(plan.otherQueued, (i) => i.index), [1]);
});
await check("add_to_render_queue refuses a shared image-sequence pattern (#228, measured)", () => {
  const { ctx, items } = makeAe({ existing: ["QUEUED"], existingPaths: ["/renders/s_[####].png"] });
  assert.match(throwsMsg(() => ctx.OPS.add_to_render_queue({ compId: 7, outputPath: "/renders/s_[####].png" })), /item 1 .*s_\[####\]\.png/);
  assert.equal(items.length, 1);
});
await check("the path key keeps a UNC double slash and every folder however deep (#228 review)", () => {
  const { ctx } = makeAe();
  const key = (p) => vm.runInContext(`__rqPathKey(${JSON.stringify(p)})`, ctx);
  assert.equal(key("\\\\Server\\Share\\out.mov"), "//server/share/out.mov");
  assert.notEqual(key("//server/share/out.mov"), key("/server/share/out.mov"));
  assert.equal(key("C:\\R\\Out.mov"), "c:/r/out.mov");
  const deep = (leaf) => "/" + Array.from({ length: 80 }, (_, i) => `d${i}`).join("/") + `/${leaf}/out.mov`;
  assert.notEqual(key(deep("x")), key(deep("y")), "folders past 64 levels still count");
  assert.equal(key(deep("x")), deep("x"));
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
  const plan = ctx.OPS._render_prepare({ all: true });
  assert.deepEqual(Array.from(plan.items, (i) => i.index), [1, 3]);
  assert.equal(plan.projectPath, "/proj/show.aep");
  assert.match(plan.appPackage, /\.app$/);
  assert.deepEqual(log, []);
});
await check("_render_prepare refuses missing footage, found through nested comps, before anything renders", () => {
  const { ctx, log } = makeAe({ existing: ["QUEUED"], missingFootage: true });
  const msg = throwsMsg(() => ctx.OPS._render_prepare({ indices: [1] }));
  assert.match(msg, /cannot find: "pic\.png"/);
  assert.doesNotMatch(msg, /bg\.png/);
  assert.equal((msg.match(/pic\.png/g) || []).length, 1, "a footage item used twice is named once");
  assert.deepEqual(log, []);
});
await check("_render_prepare with nothing queued refuses", () => {
  const { ctx } = makeAe({ existing: ["DONE"] });
  assert.match(throwsMsg(() => ctx.OPS._render_prepare({ all: true })), /Nothing in the render queue is QUEUED/);
});
await check("_render_prepare never falls back to rendering items nobody named", () => {
  const { ctx } = makeAe({ existing: ["QUEUED"] });
  assert.match(throwsMsg(() => ctx.OPS._render_prepare({})), /indices.*all:true/);
});
await check("_render_save skips a clean project and suppresses dialogs for a dirty one", () => {
  const clean = makeAe({ dirty: false });
  assert.equal(clean.ctx.OPS._render_save({}).saved, false);
  assert.deepEqual(clean.log, []);
  const dirty = makeAe({});
  assert.equal(dirty.ctx.OPS._render_save({}).saved, true);
  assert.deepEqual(dirty.log, ["suppress", "save", "unsuppress"]);
});
await check("_render_save refuses a read-only project before trying", () => {
  const { ctx, log } = makeAe({ readOnly: true });
  assert.match(throwsMsg(() => ctx.OPS._render_save({})), /read-only/);
  assert.deepEqual(log, []);
});
await check("a save in the same second as the last one is still a save (measured on 26.5)", () => {
  const { ctx, log } = makeAe({ sameSecond: true });
  assert.equal(ctx.OPS._render_save({}).saved, true);
  assert.deepEqual(log, ["suppress", "save", "unsuppress"]);
});
await check("a save that silently did not happen is reported, not trusted", () => {
  const { ctx, log } = makeAe({ saveNoop: true });
  assert.match(throwsMsg(() => ctx.OPS._render_save({})), /did not save the project.*Save As/);
  assert.deepEqual(log, ["suppress", "save", "unsuppress"]);
});
await check("_render_mark_done unticks every matching item in ONE named undo step", () => {
  const { ctx, items, log } = makeAe({ existing: ["QUEUED", "QUEUED"] });
  const out = ctx.dispatch(JSON.stringify({
    op: "_render_mark_done",
    args: { items: [
      { index: 1, compId: 7, outputPath: "/renders/existing.mov" },
      { index: 2, compId: 7, outputPath: "/renders/other.mov" },
      { index: 5, compId: 7, outputPath: "x" },
    ] },
  }));
  assert.equal(out.ok, true);
  const marked = Array.from(out.result.results, (r) => r.marked);
  assert.deepEqual(marked, [true, false, false]);
  assert.equal(items[0].render, false);
  assert.equal(items[1].render, true, "an item that no longer matches is left alone");
  assert.deepEqual(log.filter((l) => l.startsWith("undo")), ["undo:begin:AE MCP: mark rendered", "undo:end"]);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`render-queue: ${passed} checks passed`);
// The fake grandchild of a failed run must not keep the process alive.
process.exit(0);
