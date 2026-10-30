// The stale-frame window is one per After Effects, shared by every server
// process on the same panel port (issue #220, stage 4 review).
//
// AE can hand one session a buffer it rendered for another (#29), and with the
// front desk (#227) several sessions on one AE is the ordinary case. So this
// runs two real server-side processes against one port: A delivers a frame,
// then B is handed A's exact pixels for a different request and must refuse
// them as stale. Then the file's own guarantees: compaction keeps the live
// window, concurrent writers lose no window semantics, and a broken line or
// an unwritable file never fails a screenshot.
//
//   node tests/unit/frame-cache-shared.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const frames = path.join(root, "packages", "mcp-server", "dist", "frames");
const url = (f) => pathToFileURL(path.join(frames, f)).href;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`frame-cache-shared FAILED: ${name}`);
    throw e;
  }
  passed++;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ae-frames-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ae-frames-work-"));
const PORT = 7931;

/**
 * One screenshot in its own process, as one MCP server would take it: the
 * pipeline with the shared window for PORT, a stub panel that writes `seed`'s
 * pixels and reports `time`. Prints the verdict as JSON.
 */
const CHILD = `
import fs from "node:fs";
import path from "node:path";
const [, , seed, time, work, port, framesUrl] = process.argv;
const { createFramePipeline } = await import(framesUrl + "/pipeline.js");
const { createSharedFrameCache, sharedFrameCacheFile } = await import(framesUrl + "/sharedFrameCache.js");
const { encodePng8 } = await import(framesUrl + "/pngCodec.js");
const px = Buffer.alloc(8 * 6 * 4);
for (let i = 0; i < px.length; i += 4) { px[i] = Number(seed); px[i + 1] = (i * 7) & 255; px[i + 2] = 40; px[i + 3] = 255; }
const pipeline = createFramePipeline({
  warn: () => {},
  frameCache: createSharedFrameCache(() => sharedFrameCacheFile(Number(port))),
});
const send = async () => {
  const file = path.join(work, "f-" + process.pid + "-" + Date.now() + ".png");
  fs.writeFileSync(file, encodePng8(8, 6, 6, px));
  return { path: file, width: 32, height: 24, downsample: 4, time: Number(time), compId: 5 };
};
try {
  const r = await pipeline.run("screenshot_frame", { compId: 5, time: Number(time) }, send);
  process.stderr.write(JSON.stringify({ ok: true, bytes: r.bytes }) + "\\n");
} catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, code: e.code, message: e.message }) + "\\n");
}
`;
const childFile = path.join(work, "child.mjs");
fs.writeFileSync(childFile, CHILD);

function run(seed, time) {
  const r = spawnSync(process.execPath, [childFile, String(seed), String(time), work, String(PORT), pathToFileURL(frames).href], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "a server process wrote to stdout");
  const lines = r.stderr.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

const sharedFile = path.join(home, ".engineroom-ae-mcp", `frames-${PORT}.jsonl`);

await check("server A delivers a frame and records it in the port's shared window", () => {
  const a = run(90, 0);
  assert.equal(a.ok, true, a.message);
  assert.ok(fs.existsSync(sharedFile), "no shared window file for the port");
  assert.equal(fs.readFileSync(sharedFile, "utf8").trim().split("\n").length, 1);
});

await check("server B, a different process, is handed A's pixels for another time and refuses them as stale", () => {
  const b = run(90, 1);
  assert.equal(b.ok, false, "B delivered a buffer AE rendered for A");
  assert.equal(b.code, "STALE_FRAME");
  assert.match(b.message, /comp 5 @ 0\.000s/, "the refusal names A's request");
});

await check("B's own fresh frame goes through, and repeating A's request is not stale", () => {
  assert.equal(run(91, 1).ok, true);
  assert.equal(run(90, 0).ok, true);
});

await check("another port is another After Effects: no cross-talk", async () => {
  const { createSharedFrameCache, sharedFrameCacheFile } = await import(url("sharedFrameCache.js"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const other = createSharedFrameCache(() => sharedFrameCacheFile(PORT + 1));
  assert.equal(other.match("x", "anything"), null);
});

const { createSharedFrameCache } = await import(url("sharedFrameCache.js"));
const { createFrameCache } = await import(url("frameCache.js"));

await check("compaction keeps exactly the in-memory window", () => {
  const f = path.join(work, "compact.jsonl");
  let t = 1_000_000;
  const now = () => t;
  const shared = createSharedFrameCache(() => f, { now });
  const mem = createFrameCache({ now });
  for (let i = 0; i < 450; i++) {
    t += 1000;
    const key = `k${i % 37}`;
    const hash = `h${i % 53}`;
    shared.remember(key, hash, { label: key, bytes: i });
    mem.remember(key, hash, { label: key, bytes: i });
    if (i % 7 === 0) {
      for (const probe of ["h1", "h5", `h${i % 53}`, "nope"]) {
        assert.deepEqual(shared.match("zz", probe), mem.match("zz", probe), `step ${i}, ${probe}`);
      }
    }
  }
  const lines = fs.readFileSync(f, "utf8").trim().split("\n").length;
  assert.ok(lines <= 201, `the file was never compacted (${lines} lines)`);
  t += 11 * 60 * 1000;
  assert.equal(shared.match("zz", "h1"), null, "the TTL holds after a replay");
  assert.deepEqual(fs.readdirSync(work).filter((n) => n.includes(".tmp")), [], "a compaction left its temp file");
});

await check("two writers at once: every line is whole, and both writers' frames are seen", async () => {
  const f = path.join(work, "concurrent.jsonl");
  const WRITER = `
const { createSharedFrameCache } = await import(${JSON.stringify(url("sharedFrameCache.js"))});
const c = createSharedFrameCache(() => ${JSON.stringify(f)});
const who = process.argv[2];
for (let i = 0; i < 120; i++) c.remember(who + i, who + "-hash-" + i, { label: who, bytes: i });
`;
  const wf = path.join(work, "writer.mjs");
  fs.writeFileSync(wf, WRITER);
  const { spawn } = await import("node:child_process");
  const done = (who) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [wf, who], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(err))));
  });
  await Promise.all([done("A"), done("B")]);
  const text = fs.readFileSync(f, "utf8");
  for (const l of text.trim().split("\n")) JSON.parse(l);
  const c = createSharedFrameCache(() => f);
  assert.ok(c.match("other", "A-hash-119"), "A's last frame is missing");
  assert.ok(c.match("other", "B-hash-119"), "B's last frame is missing");
});

await check("a torn line or an unwritable file never fails a check", () => {
  const f = path.join(work, "torn.jsonl");
  fs.writeFileSync(f, '{"key":"k","hash":"h","at":' + Date.now() + ',"label":"k","bytes":1}\n{"key":"k2","ha');
  const c = createSharedFrameCache(() => f);
  assert.ok(c.match("other", "h"));
  const blocked = createSharedFrameCache(() => path.join(f, "not-a-dir", "x.jsonl"));
  blocked.remember("a", "h9", { label: "a", bytes: 1 });
  assert.ok(blocked.match("b", "h9"), "an unwritable file falls back to this process's own window");
});

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(`frame-cache-shared: ${passed} checks passed`);
