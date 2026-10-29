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

const { parseAerenderLine, LineSplitter, aerenderArgs, resolveAerender, verifyOutputs, RenderRunner, occupiedOutputs, snapshotProject, removeSnapshot, missingFootageHint, sweepStaleSnapshots, isMissingFootageLine, touchSnapshot, loggedErrorCount, isoMediaProblem, isoMediaInfo } =
  await import(dist("render", "aerender.js"));
const { aerenderCandidates, renderPidsFromPs, isRenderProcessArgs, isRenderProcessWin, stopProcessTreeSync } = await import(dist("setup", "platform.js"));
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
  const snap = snapshotProject(proj, "r_1_1", tmpRoot);
  assert.equal(snap, path.join(tmpRoot, "ae-mcp-render", "r_1_1", "snap-src.aep"));
  assert.equal(fs.readFileSync(snap, "utf8"), "aep");
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes("ae-mcp-render")), [], "nothing new beside the project");
  removeSnapshot(snap);
  assert.ok(!fs.existsSync(path.dirname(snap)), "the per-job folder goes with it");
  // removeSnapshot only ever removes an ae-mcp-render/<job> folder.
  removeSnapshot(proj);
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
  const removed = sweepStaleSnapshots("r_mine_3", root, 24 * 3600_000, now);
  assert.deepEqual(removed, [old]);
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
  const snap = snapshotProject(src, "r_long_9", root);
  const dir = path.dirname(snap);
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  fs.utimesSync(dir, old, old);
  touchSnapshot(snap);
  assert.deepEqual(sweepStaleSnapshots("r_other", root), [], "a touched folder is not stale");
  assert.ok(fs.existsSync(snap));
  removeSnapshot(snap);
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
  const g = spawn(process.env.FAKE_ENGINE, ["-e", "process.on('SIGTERM',()=>{}); require('fs').writeFileSync(process.env.FAKE_GRANDCHILD, String(process.pid)); setInterval(()=>{}, 1000)", "--", "-noui", "-project", project], { stdio: ["ignore", "inherit", "inherit"] });
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
  const g = spawn(process.env.FAKE_ENGINE, ["-e", "setTimeout(() => { console.log(process.env.FAKE_LINE); process.exit(0); }, 400)", "--", "-noui", "-project", project], { stdio: ["ignore", "inherit", "inherit"] });
  g.unref();
  for (let n = 0; n < 4; n++) console.log("PROGRESS:  0:00:00:0" + n + " (" + (n + 1) + "): 0 Seconds");
  writeMovie(out);
  process.exit(0);
}
console.log("PROGRESS:  10/29/2026 10:00:00 AM: Starting composition “Comp”.");
console.log("PROGRESS:  Duration: 0:00:00:04");
if (mode === "fail") { console.log("aerender ERROR: Unable to find comp"); process.exit(3); }
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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    assert.equal(path.basename(path.dirname(path.dirname(args[1]))), "ae-mcp-render");
    assert.notEqual(path.dirname(args[1]), tmp);
    assert.deepEqual(args.slice(2), aerenderArgs("x", 2).slice(2));
    assert.ok(!fs.existsSync(args[1]), "the snapshot must be removed when the job ends");
    assert.deepEqual(hooked, [[2]], "unticked once, at the end");
    assert.deepEqual(st.result.rendered[0].unqueued, { marked: true });
    const frames = seen.filter((s) => /frame \d+ of 4/.test(s.message ?? "")).map((s) => s.progress);
    assert.deepEqual(frames, [1, 2, 3, 4]);
    assert.equal(runner.activeJobId, null);
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
    const engine = Number(fs.readFileSync(process.env.FAKE_GRANDCHILD, "utf8"));
    for (let i = 0; i < 50 && alive(engine); i++) await sleep(20);
    assert.ok(!alive(engine), "the stuck engine is killed at the cap");
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
    for (let i = 0; i < 100 && !fs.existsSync(process.env.FAKE_GRANDCHILD); i++) await sleep(20);
    const engine = Number(fs.readFileSync(process.env.FAKE_GRANDCHILD, "utf8"));
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
    for (let i = 0; i < 100 && !fs.existsSync(process.env.FAKE_GRANDCHILD); i++) await sleep(20);
    const snapDir = path.join(runTmp, "ae-mcp-render", jobId);
    const snapPath = path.join(snapDir, "show.aep");
    // A non-aerender process whose arguments hold this job's snapshot path and id.
    const decoy = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", "--", jobId, snapPath], { detached: true, stdio: "ignore" });
    decoy.unref();
    await sleep(100);
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, true, report.note);
    assert.ok(alive(decoy.pid), "a process that only mentions the snapshot must survive the cancel");
    process.kill(decoy.pid, "SIGKILL");
    try { process.kill(Number(fs.readFileSync(process.env.FAKE_GRANDCHILD, "utf8")), "SIGKILL"); } catch {}
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

  await check("a cancel that could not see the exit still settles the job when the exit comes", async () => {
    const jobs = new JobManager();
    // A stop that does nothing: the process outlives the cancel, as an engine
    // started outside aerender's group would.
    const runner = runnerFor(jobs, { tmpRoot: runTmp, graceMs: 100, stop: async () => {}, findEngines: async () => [] });
    const out = path.join(tmp, "stubborn.mov");
    env("hang", out);
    const { jobId } = runner.start(plan(out, 100), fake);
    for (let i = 0; i < 100 && !fs.existsSync(process.env.FAKE_GRANDCHILD); i++) await sleep(20);
    const pid = Number(fs.readFileSync(process.env.FAKE_SELF, "utf8"));
    const grandchild = Number(fs.readFileSync(process.env.FAKE_GRANDCHILD, "utf8"));
    const report = await runner.cancel(jobId);
    assert.equal(report.stopped, false);
    assert.equal(jobs.get(jobId).status, "running");
    const waiting = jobs.waitFor(jobId, 5000);
    killTree(pid);
    const st = await waiting;
    assert.equal(st.status, "cancelled");
    assert.equal(st.result.stopped, true);
    assert.match(st.result.note, /after cancel_job had reported it still running/);
    try { process.kill(grandchild, "SIGKILL"); } catch {}
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
  class MockFolder {
    constructor(p) { this.fsName = p; }
    get exists() { return dirs.has(this.fsName); }
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
