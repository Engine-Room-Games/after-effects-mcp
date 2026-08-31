// The screenshot pipeline end to end, through the real panel.
//
// `tests/unit/frame-integrity.mjs` proves that a half-written PNG is recognised
// as unfinished, and `tests/unit/contact-sheet.mjs` proves the tiling. What
// neither can prove is the wiring, and the wiring is half of issue #45:
//
//   * a frame that failed to read must never be delivered as an image;
//   * and it must never enter the stale-frame cache. Before the completeness
//     gate, a truncated file was hashed and remembered, so the *next* truncation
//     at the same byte count came back as "Stale frame" — the wrong diagnosis,
//     with the wrong remedy, for a bug that was never about staleness. The
//     report on #45 is exactly that: "the same 73,877 bytes for different times
//     and downsamples".
//   * while a genuinely re-served buffer must still be caught, because the fix
//     for one bug must not disable the detector for the other.
//
// So this boots the real `client/main.js` against a stub CEP host — the same
// harness idea as panel-boot.mjs — and drives real `/op` requests whose renders
// this file decides the bytes of.
//
// Most of the corrupt cases here use a file with a wrong PNG signature rather
// than a truncated one. Both are FRAME_INCOMPLETE and take identical paths
// through the panel; the signature case is refused immediately, where a
// truncated one has to be given the stall window first. One truncated case is
// still run end to end, because it is the shape the bug was reported in.
//
//   node tests/unit/screenshot-pipeline.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const panelSrc = path.join(root, "packages", "ae-panel");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`screenshot-pipeline FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// An independent PNG writer, used only by this test.
// ---------------------------------------------------------------------------
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const TILE_W = 60;
const TILE_H = 40;
function png(shade, w = TILE_W, h = TILE_H) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) {
      row[x * 4] = shade;
      row[x * 4 + 1] = (shade + x) & 0xff;
      row[x * 4 + 2] = (shade + y) & 0xff;
      row[x * 4 + 3] = 255;
    }
    rows.push(Buffer.from([0]), row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** Not a PNG at all — refused on the first poll, no stall window needed. */
const GARBAGE = Buffer.from("After Effects wrote something that is not a PNG");
/** The shape #45 was reported in: a real frame cut off inside IDAT. */
const TRUNCATED = png(90).subarray(0, png(90).length - 60);

// ---------------------------------------------------------------------------
// The stub host: ExtendScript is replaced by a queue of bytes this file writes.
// ---------------------------------------------------------------------------
const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-shot-render-"));
let renderSeq = 0;

/** What each successive render should leave on disk. Consumed in call order. */
const plan = { queue: [], rendered: [] };

function nextBytes(time) {
  const producer = plan.queue.shift();
  assert.ok(producer, `an unplanned render happened (time ${time})`);
  plan.rendered.push(time);
  return typeof producer === "function" ? producer(time) : producer;
}

function writeFrame(time) {
  const file = path.join(renderDir, `frame-${renderSeq++}.png`);
  fs.writeFileSync(file, nextBytes(time));
  return file;
}

const COMP = { id: 7, width: TILE_W * 4, height: TILE_H * 4 };

function dispatchStub(op, args) {
  if (op !== "screenshot_frame") throw new Error(`Unknown op: ${op}`);
  if (args.times && args.times.length) {
    const ds = args.downsample || 4;
    return {
      contactSheet: true,
      downsample: ds,
      width: COMP.width,
      height: COMP.height,
      compId: COMP.id,
      times: args.times,
      tiles: args.times.map((t) => ({ time: t, downsample: ds, path: writeFrame(t) })),
    };
  }
  const ds = args.downsample || 4;
  const time = args.time === undefined ? 0 : args.time;
  return {
    path: writeFrame(time),
    width: COMP.width,
    height: COMP.height,
    downsample: ds,
    time,
    compId: COMP.id,
  };
}

function parsePayload(script) {
  const open = script.indexOf("dispatch(") + "dispatch(".length;
  const close = script.lastIndexOf("))");
  return JSON.parse(JSON.parse(script.slice(open, close)));
}

function makeHost(extDir) {
  return {
    getSystemPath: () => extDir,
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "26.3" }),
    evalScript: (script, cb) => {
      if (script.indexOf("$.evalFile") >= 0) return void setTimeout(() => cb("ok"), 0);
      let body;
      try {
        const p = parsePayload(script);
        body = JSON.stringify({ ok: true, result: dispatchStub(p.op, p.args) });
      } catch (e) {
        body = JSON.stringify({ ok: false, error: e.message });
      }
      setTimeout(() => cb(body), 0);
    },
  };
}

function makeDom() {
  const nodes = {};
  const mk = () => ({
    textContent: "",
    className: "",
    childNodes: [],
    insertBefore(n) { this.childNodes.unshift(n); },
    removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
  });
  for (const id of ["status", "port", "ae", "jsx", "reqs", "log"]) nodes[id] = mk();
  return { nodes, document: { getElementById: (id) => nodes[id] ?? null, createElement: () => mk() } };
}

function installLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-shot-panel-"));
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jsx"), { recursive: true });
  for (const f of fs.readdirSync(path.join(panelSrc, "client"))) {
    fs.copyFileSync(path.join(panelSrc, "client", f), path.join(dir, "client", f));
  }
  fs.copyFileSync(path.join(panelSrc, "jsx", "bundle.jsx"), path.join(dir, "jsx", "bundle.jsx"));
  fs.copyFileSync(path.join(panelSrc, "package.json"), path.join(dir, "package.json"));
  return dir;
}

function bootPanel(extDir) {
  const source = fs.readFileSync(path.join(extDir, "client", "main.js"), "utf8");
  const csSource = fs.readFileSync(path.join(extDir, "client", "csinterface.js"), "utf8");
  const host = makeHost(extDir);
  const dom = makeDom();
  // The panel writes a port file into the user's home and binds a real socket.
  // Neither may escape: a stray port file would point a live MCP server at a
  // port that stops existing with this test.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-shot-home-"));
  const realOs = nodeRequire("node:os");
  const realHttp = nodeRequire("node:http");
  const servers = [];
  const sandbox = {
    console,
    Promise, Date, Math, JSON, Error, Buffer, String, Number, Array, Object, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: extDir,
    __filename: path.join(extDir, "main.js"),
    document: dom.document,
    window: { __adobe_cep__: host },
    require: (id) => {
      if (id === "os") return { ...realOs, homedir: () => fakeHome };
      if (id === "http") {
        return {
          ...realHttp,
          createServer: (...a) => {
            const s = realHttp.createServer(...a);
            servers.push(s);
            return s;
          },
        };
      }
      if (["path", "fs", "crypto", "zlib", "net", "url", "stream", "events", "util", "buffer"].includes(id)) {
        return nodeRequire(`node:${id}`);
      }
      return nodeRequire(id);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(csSource, sandbox, { filename: "csinterface.js" });
  vm.runInContext(source, sandbox, { filename: "main.js" });
  const close = () => {
    for (const s of servers) { try { s.close(); s.closeAllConnections?.(); } catch {} }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  };
  return { dom, close };
}

function settled(dom, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const s = dom.nodes.status.textContent;
      if (s === "ready" || s === "failed" || s.indexOf("cannot start") === 0) return resolve(s);
      if (Date.now() > deadline) return reject(new Error(`panel never settled; stuck at "${s}"`));
      setTimeout(poll, 25);
    })();
  });
}

const dir = installLayout();
const panel = bootPanel(dir);
const status = await settled(panel.dom);
assert.equal(
  status,
  "ready",
  `panel did not boot: ${status}\n${panel.dom.nodes.log.childNodes.map((n) => n.textContent).join("\n")}`,
);
const PORT = Number(panel.dom.nodes.port.textContent);
assert.ok(PORT > 0, "no port announced");

async function op(args, expect = "ok") {
  const res = await fetch(`http://127.0.0.1:${PORT}/op`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "screenshot_frame", args }),
  });
  const body = await res.json();
  if (expect === "ok") assert.ok(body.ok, `expected success, got: ${body.error}`);
  if (expect === "err") assert.equal(body.ok, false, `expected a refusal, got a result`);
  return body;
}

// ---------------------------------------------------------------------------
// A frame that reads cleanly
// ---------------------------------------------------------------------------
await check("a whole PNG comes back as an image, sized from its own IHDR", async () => {
  plan.queue = [png(10)];
  const body = await op({ compId: COMP.id, time: 0 });
  assert.equal(body.result.width, TILE_W);
  assert.equal(body.result.height, TILE_H);
  assert.ok(body.result.base64, "no image was sent");
  assert.equal(plan.rendered.length, 1, "a frame that read cleanly must not be re-rendered");
});

// ---------------------------------------------------------------------------
// #45: corrupt frames
// ---------------------------------------------------------------------------
await check("a truncated frame is never shipped, and the automatic re-render saves it", async () => {
  // The shape reported in #45: the first render leaves a real frame cut off
  // inside IDAT. The old reader took that as settled and sent it; this one waits
  // out the stall window, refuses it, and renders again.
  plan.rendered = [];
  plan.queue = [TRUNCATED, png(20)];
  const body = await op({ compId: COMP.id, time: 1 });
  assert.equal(plan.rendered.length, 2, "the corrupt read should have been retried exactly once");
  assert.equal(body.result.width, TILE_W);
  assert.notEqual(
    Buffer.from(body.result.base64, "base64").compare(TRUNCATED),
    0,
    "the truncated bytes must never reach the client",
  );
});

await check("a frame that stays corrupt is refused, and says so as corrupt, not as a timeout", async () => {
  plan.rendered = [];
  plan.queue = [GARBAGE, GARBAGE];
  const body = await op({ compId: COMP.id, time: 2 }, "err");
  assert.equal(body.code, "FRAME_INCOMPLETE");
  assert.match(body.error, /^Corrupt frame:/);
  assert.match(body.error, /NOT a timeout/);
  assert.match(body.error, /automatic re-render/, "it should say the retry already happened");
  assert.equal(plan.rendered.length, 2, "one retry, not a loop");
  assert.equal(body.result, undefined, "a refusal must carry no image");
});

await check("a failed read is never cached, so the next failure is still reported as corrupt", async () => {
  // This is the second half of #45. The identical corrupt bytes at a *different*
  // time used to hash into the frame cache and come back as "Stale frame",
  // which sends the reader after a completely different problem.
  plan.rendered = [];
  plan.queue = [GARBAGE, GARBAGE];
  const body = await op({ compId: COMP.id, time: 3 }, "err");
  assert.equal(body.code, "FRAME_INCOMPLETE", `got ${body.code}: ${body.error}`);
  assert.doesNotMatch(body.error, /Stale frame/);
});

await check("the stale-buffer detector still fires on a genuinely re-served frame", async () => {
  // The fix for the corrupt case must not disable the check for issue #29:
  // byte-identical pixels for two *different* requests is one buffer handed out
  // twice, and that is still an error.
  const same = png(33);
  plan.queue = [same];
  const first = await op({ compId: COMP.id, time: 10 });
  assert.ok(first.result.base64);
  plan.queue = [same];
  const second = await op({ compId: COMP.id, time: 11 }, "err");
  assert.equal(second.code, "STALE_FRAME");
  assert.match(second.error, /^Stale frame/);
});

// ---------------------------------------------------------------------------
// #56: contact sheets
// ---------------------------------------------------------------------------
await check("times[] returns one image with one cell per requested time, in order", async () => {
  plan.rendered = [];
  plan.queue = [png(40), png(50), png(60)];
  const body = await op({ compId: COMP.id, times: [0, 0.5, 1] });
  const r = body.result;
  assert.equal(r.contactSheet, true);
  assert.equal(plan.rendered.length, 3, "one render per requested time");
  assert.deepEqual(r.tiles.map((t) => t.time), [0, 0.5, 1]);
  assert.deepEqual(r.tiles.map((t) => t.status), ["ok", "ok", "ok"]);
  assert.deepEqual(r.tiles.map((t) => t.label), ["0s", "0.5s", "1s"]);
  assert.equal(r.cols, 3);
  assert.equal(r.rows, 1);
  assert.equal(r.cellWidth, TILE_W);
  assert.equal(r.cellHeight, TILE_H);
  assert.ok(r.base64, "no sheet was sent");
  assert.equal(r.warning, undefined, "nothing was left out, so nothing to warn about");
  // One image, not three: the whole point of the feature.
  assert.equal(r.bytes, Buffer.from(r.base64, "base64").length);
});

await check("one bad tile is a marked block and does not invalidate the sheet", async () => {
  plan.rendered = [];
  // ExtendScript renders all three first, then the panel retries only the one
  // that failed to read — and that retry fails too.
  plan.queue = [png(70), GARBAGE, png(80), GARBAGE];
  const body = await op({ compId: COMP.id, times: [0, 1, 2] });
  const r = body.result;
  assert.equal(r.tiles.length, 3, "a failed tile must keep its cell");
  assert.deepEqual(r.tiles.map((t) => t.status), ["ok", "failed", "ok"]);
  assert.match(r.warning, /1 of 3 tiles are marked blocks/);
  assert.match(r.tiles[1].label, /FAILED/);
  assert.ok(r.base64, "the two good tiles should still have been sent");
  assert.equal(plan.rendered.length, 4, "the bad tile is retried once, the good ones not at all");
});

await check("a static comp flags identical tiles instead of refusing them", async () => {
  // A genuinely unchanging comp screenshotted at three times really does produce
  // three identical frames. Inside one sheet that is the answer, not the bug.
  plan.rendered = [];
  const still = png(99);
  plan.queue = [still, still, still];
  const body = await op({ compId: COMP.id, times: [4, 5, 6] });
  const r = body.result;
  assert.deepEqual(r.tiles.map((t) => t.status), ["ok", "ok", "ok"]);
  assert.equal(r.tiles[0].note, undefined, "the first of a set has nothing to be identical to");
  assert.match(r.tiles[1].note, /pixel-identical to the 4s tile/);
  assert.match(r.tiles[2].note, /pixel-identical to the 4s tile/);
  assert.ok(r.base64, "identical tiles are still a picture worth sending");
});

await check("a sheet where nothing rendered is refused rather than sent as coloured blocks", async () => {
  plan.rendered = [];
  plan.queue = [GARBAGE, GARBAGE, GARBAGE, GARBAGE];
  const body = await op({ compId: COMP.id, times: [7, 8] }, "err");
  assert.equal(body.code, "CONTACT_SHEET_FAILED");
  assert.match(body.error, /No tile of the contact sheet rendered/);
  assert.match(body.error, /7s: failed/);
  assert.match(body.error, /A sheet of coloured blocks is not a screenshot/);
});

await check("every temp frame was cleaned up, whatever the verdict", () => {
  const left = fs.readdirSync(renderDir);
  assert.deepEqual(left, [], `temp frames left behind: ${left.join(", ")}`);
});

panel.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(renderDir, { recursive: true, force: true });
console.log(`screenshot-pipeline: ${passed} checks passed`);
process.exit(0);
