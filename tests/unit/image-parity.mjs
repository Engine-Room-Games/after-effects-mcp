// The panel's image code and the server's copy of it must give identical
// answers (issue #220, stage 4).
//
// Stage 4 moved the screenshot, contact-sheet and .mogrt-thumbnail work from
// the panel (`packages/ae-panel/client/*.js`) to the server
// (`packages/mcp-server/src/frames/*.ts`). The panel keeps its copy, because an
// MCP server older than this one still asks it for base64 — so there are two
// implementations of the same measured behaviour, and this file is what holds
// them together:
//
//   * module by module: the same fixtures through both, compared byte for byte
//     (PNG bytes, decoded samples, the stale-check hash input, sheet and zip
//     bytes) and message for message (frame errors, stale and timeout text);
//   * end to end: the real `client/main.js`, booted against a stub CEP host,
//     answers the public op the way it always has, and the server's pipeline
//     answers the same render through the raw op the panel passes through. The
//     two results must be equal — the image, the metadata, the refusals.
//
// The measured traps each get a fixture: a 16-bit frame, premultiplied soft
// edges (#130), an empty frame, partial writes and a corrupt file (#45), a
// re-served render buffer (#29), and a static comp inside one contact sheet.
//
//   node tests/unit/image-parity.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const panelSrc = path.join(root, "packages", "ae-panel");
const clientDir = path.join(panelSrc, "client");
const framesDist = path.join(root, "packages", "mcp-server", "dist", "frames");
const load = (f) => import(pathToFileURL(path.join(framesDist, f)).href);

const old = {
  png: nodeRequire(path.join(clientDir, "pngcodec.js")),
  reader: nodeRequire(path.join(clientDir, "framereader.js")),
  cache: nodeRequire(path.join(clientDir, "framecache.js")),
  sheet: nodeRequire(path.join(clientDir, "contactsheet.js")),
  mogrt: nodeRequire(path.join(clientDir, "mogrt.js")),
};
const neu = {
  png: await load("pngCodec.js"),
  reader: await load("frameReader.js"),
  cache: await load("frameCache.js"),
  sheet: await load("contactSheet.js"),
  mogrt: await load("mogrtThumbnail.js"),
};
const { createFramePipeline } = await load("pipeline.js");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`image-parity FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// Fixtures: an independent PNG writer, so neither side builds its own inputs.
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
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG from a sample function. `sample(x, y, c)` returns a value in the bit
 * depth's range. Rows are filtered with a rotating filter type so the
 * unfilter paths are all exercised; `idatSplit` splits the stream across
 * several IDAT chunks; `extra` adds chunks before IDAT (PLTE, tEXt, …).
 */
function makePng({ w, h, depth = 8, colorType = 6, sample, interlace = 0, idatSplit = 1, extra = [] }) {
  const ch = CHANNELS[colorType];
  const bps = depth / 8;
  const rowBytes = w * ch * bps;
  const rows = [];
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(rowBytes);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        const v = sample(x, y, c);
        if (depth === 16) row.writeUInt16BE(v, (x * ch + c) * 2);
        else row[x * ch + c] = v;
      }
    }
    const ft = y % 3 === 0 ? 0 : y % 3 === 1 ? 1 : 2;
    const out = Buffer.alloc(rowBytes + 1);
    out[0] = ft;
    const bpp = ch * bps;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      out[i + 1] = (row[i] - (ft === 0 ? 0 : ft === 1 ? a : b)) & 0xff;
    }
    rows.push(out);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const z = zlib.deflateSync(Buffer.concat(rows));
  const parts = [];
  const step = Math.ceil(z.length / idatSplit);
  for (let i = 0; i < z.length; i += step) parts.push(chunk("IDAT", z.subarray(i, i + step)));
  return Buffer.concat([SIG, chunk("IHDR", ihdr), ...extra, ...parts, chunk("IEND", Buffer.alloc(0))]);
}

// Premultiplied soft edge: colour scaled by alpha, as saveFrameToPng writes it.
const soft8 = (seed) => (x, y, c) => {
  const a = Math.max(0, Math.min(255, (x * 37 + y * 11 + seed) % 300 - 20));
  if (c === 3) return a;
  const straight = (x * 13 + y * 7 + c * 50 + seed) & 0xff;
  return Math.round((straight * a) / 255);
};
const soft16 = (seed) => (x, y, c) => {
  const a = Math.max(0, Math.min(65535, ((x * 4099 + y * 1531 + seed) % 70000) - 2000));
  if (c === 3) return a;
  const straight = ((x * 977 + y * 433 + c * 12000 + seed) * 7) & 0xffff;
  return Math.round((straight * a) / 65535);
};
const opaque = (seed) => (x, y, c) => (c === 3 ? 255 : (x * 3 + y * 5 + c * 40 + seed) & 0xff);

const FIXTURES = {
  "8-bit RGBA opaque": makePng({ w: 23, h: 17, sample: opaque(1) }),
  "8-bit RGBA premultiplied soft edges": makePng({ w: 31, h: 19, sample: soft8(3), idatSplit: 3 }),
  "8-bit RGB": makePng({ w: 20, h: 9, colorType: 2, sample: (x, y, c) => (x + y * 2 + c * 70) & 0xff }),
  "8-bit grey+alpha": makePng({ w: 12, h: 12, colorType: 4, sample: (x, y, c) => (c === 1 ? (x * 20) & 0xff : (y * 9) & 0xff) }),
  "16-bit RGBA premultiplied": makePng({ w: 29, h: 21, depth: 16, sample: soft16(5) }),
  "16-bit RGBA opaque": makePng({ w: 16, h: 10, depth: 16, sample: (x, y, c) => (c === 3 ? 65535 : ((x * 3000 + y * 700 + c * 9000) & 0xffff)) }),
  "16-bit RGB": makePng({ w: 14, h: 8, depth: 16, colorType: 2, sample: (x, y, c) => (x * 4000 + y * 300 + c) & 0xffff }),
  "empty (every pixel clear)": makePng({ w: 40, h: 30, sample: (x, y, c) => (c === 3 ? 0 : 17) }),
  "16-bit empty": makePng({ w: 20, h: 10, depth: 16, sample: () => 0 }),
  "interlaced (passed through)": makePng({ w: 8, h: 8, interlace: 1, sample: opaque(9) }),
  "indexed (passed through)": makePng({
    w: 6, h: 4, colorType: 3, sample: (x) => x % 2,
    extra: [chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255]))],
  }),
  "with ancillary chunk": makePng({ w: 10, h: 6, sample: soft8(11), extra: [chunk("tEXt", Buffer.from("Software\0AE"))] }),
};

/** Normalise both results into comparable plain values. */
function plainNorm(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) o[k] = Buffer.isBuffer(v) ? v.toString("hex") : v;
  return o;
}

// ---------------------------------------------------------------------------
// Module parity
// ---------------------------------------------------------------------------
for (const [name, buf] of Object.entries(FIXTURES)) {
  await check(`normalizePng: ${name}`, () => {
    assert.deepEqual(plainNorm(neu.png.normalizePng(buf)), plainNorm(old.png.normalizePng(buf)));
  });
  await check(`decodePng8: ${name}`, () => {
    let a, b, ea, eb;
    try { a = plainNorm(old.png.decodePng8(buf)); } catch (e) { ea = e.message; }
    try { b = plainNorm(neu.png.decodePng8(buf)); } catch (e) { eb = e.message; }
    assert.equal(eb, ea);
    assert.deepEqual(b, a);
  });
}

await check("normalizePng: the 16-bit and soft-edge fixtures really are converted (the parity is not vacuous)", () => {
  const r16 = neu.png.normalizePng(FIXTURES["16-bit RGBA premultiplied"]);
  assert.equal(r16.converted, true);
  assert.equal(r16.unpremultiplied, true);
  const r8 = neu.png.normalizePng(FIXTURES["8-bit RGBA premultiplied soft edges"]);
  assert.equal(r8.unpremultiplied, true);
  assert.equal(neu.png.normalizePng(FIXTURES["empty (every pixel clear)"]).empty, true);
  assert.equal(neu.png.normalizePng(FIXTURES["indexed (passed through)"]).passthrough, "indexed colour");
});

await check("normalizePng: the same refusal for what is not a readable PNG", () => {
  const bad = [
    Buffer.from("not a png"),
    FIXTURES["8-bit RGB"].subarray(0, 40),
    Buffer.concat([SIG, chunk("IHDR", Buffer.alloc(12))]),
  ];
  for (const b of bad) {
    let ea, eb;
    try { old.png.normalizePng(b); } catch (e) { ea = e.message; }
    try { neu.png.normalizePng(b); } catch (e) { eb = e.message; }
    assert.ok(ea, "the panel accepted a broken file");
    assert.equal(eb, ea);
  }
});

await check("inspectPngStructure: every prefix of a frame, and garbage, read the same (#45)", () => {
  const whole = FIXTURES["16-bit RGBA premultiplied"];
  for (let n = 0; n <= whole.length; n++) {
    const p = whole.subarray(0, n);
    assert.deepEqual(neu.png.inspectPngStructure(p), old.png.inspectPngStructure(p), `prefix of ${n} bytes`);
  }
  for (const g of [Buffer.from("After Effects wrote this"), Buffer.concat([SIG, chunk("IDAT", Buffer.alloc(3))])]) {
    assert.deepEqual(neu.png.inspectPngStructure(g), old.png.inspectPngStructure(g));
  }
});

await check("encodePng8 and crc32: identical bytes", () => {
  const px = Buffer.alloc(7 * 5 * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 31) & 0xff;
  assert.ok(neu.png.encodePng8(7, 5, 6, px).equals(old.png.encodePng8(7, 5, 6, px)));
  assert.equal(neu.png.crc32(px), old.png.crc32(px));
});

// --- frame reader: partial writes, corrupt files, timeouts ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-image-parity-"));
let seq = 0;
const tmpFile = () => path.join(tmp, `f-${seq++}.png`);

/** Write `bytes` to a fresh file in `pieces`, `gapMs` apart, starting now. */
function writeInPieces(bytes, pieces, gapMs) {
  const file = tmpFile();
  const step = Math.ceil(bytes.length / pieces);
  let at = 0;
  fs.writeFileSync(file, bytes.subarray(0, 0));
  const timers = [];
  for (let i = 0; i < pieces; i++) {
    timers.push(setTimeout(() => {
      fs.appendFileSync(file, bytes.subarray(at, at + step));
      at += step;
    }, gapMs * (i + 1)));
  }
  return file;
}

async function outcome(p) {
  try {
    const buf = await p;
    return { ok: true, hex: buf.toString("hex") };
  } catch (e) {
    return { ok: false, code: e.code, detail: e.detail.replace(/f-\d+\.png/g, "f-N.png") };
  }
}

await check("waitForCompletePng: a frame written in pauses longer than the poll arrives whole on both", async () => {
  const bytes = FIXTURES["8-bit RGBA premultiplied soft edges"];
  const o = { stallMs: 2000, pollMs: 10 };
  const [a, b] = await Promise.all([
    outcome(old.reader.waitForCompletePng(writeInPieces(bytes, 4, 60), o)),
    outcome(neu.reader.waitForCompletePng(writeInPieces(bytes, 4, 60), o)),
  ]);
  assert.deepEqual(b, a);
  assert.equal(a.ok, true);
  assert.equal(a.hex, bytes.toString("hex"));
});

await check("waitForCompletePng: a write that stalls short of IEND is FRAME_INCOMPLETE on both, with the same detail", async () => {
  const cut = FIXTURES["8-bit RGBA opaque"].subarray(0, FIXTURES["8-bit RGBA opaque"].length - 30);
  const fa = tmpFile();
  const fb = tmpFile();
  fs.writeFileSync(fa, cut);
  fs.writeFileSync(fb, cut);
  const o = { stallMs: 150, pollMs: 10 };
  const [a, b] = await Promise.all([
    outcome(old.reader.waitForCompletePng(fa, o)),
    outcome(neu.reader.waitForCompletePng(fb, o)),
  ]);
  assert.equal(a.code, "FRAME_INCOMPLETE");
  assert.equal(b.code, a.code);
  // The stall length is measured, so it may differ by a rounding step.
  assert.equal(b.detail.replace(/\d+s/, "Ns"), a.detail.replace(/\d+s/, "Ns"));
  assert.ok(!fs.existsSync(fa) && !fs.existsSync(fb), "a failed read must remove the temp file");
});

await check("waitForCompletePng: not a PNG is refused at once, and nothing arriving is RENDER_TIMEOUT", async () => {
  const fa = tmpFile();
  const fb = tmpFile();
  fs.writeFileSync(fa, "not a png at all");
  fs.writeFileSync(fb, "not a png at all");
  const [a, b] = await Promise.all([
    outcome(old.reader.waitForCompletePng(fa, { pollMs: 10 })),
    outcome(neu.reader.waitForCompletePng(fb, { pollMs: 10 })),
  ]);
  assert.deepEqual(b, a);
  assert.equal(a.code, "FRAME_INCOMPLETE");
  const [ta, tb] = await Promise.all([
    outcome(old.reader.waitForCompletePng(tmpFile(), { budgetMs: 120, pollMs: 10 })),
    outcome(neu.reader.waitForCompletePng(tmpFile(), { budgetMs: 120, pollMs: 10 })),
  ]);
  assert.deepEqual(tb, ta);
  assert.equal(ta.code, "RENDER_TIMEOUT");
});

await check("dressFrameError: the same message for both failures and both attempt counts", () => {
  for (const code of ["FRAME_INCOMPLETE", "RENDER_TIMEOUT"]) {
    for (const n of [1, 2]) {
      const a = old.reader.dressFrameError(old.reader.frameError(code, "a detail"), n);
      const b = neu.reader.dressFrameError(neu.reader.frameError(code, "a detail"), n);
      assert.equal(b.message, a.message);
      assert.equal(b.code, a.code);
      assert.doesNotMatch(b.message, /restart After Effects|setup_panel/);
    }
  }
  const other = new Error("ExtendScript said no");
  assert.equal(neu.reader.dressFrameError(other, 1), other);
  assert.equal(neu.reader.FRAME_RENDER_BUDGET_MS, old.reader.FRAME_RENDER_BUDGET_MS);
  assert.equal(neu.reader.FRAME_STALL_MS, old.reader.FRAME_STALL_MS);
});

await check("frame cache: the same answers over the same sequence (#29)", () => {
  let t = 0;
  const now = () => t;
  const a = old.cache.createFrameCache({ limit: 3, ttlMs: 1000, now });
  const b = neu.cache.createFrameCache({ limit: 3, ttlMs: 1000, now });
  const steps = [
    ["remember", "k1", "h1"], ["match", "k2", "h1"], ["match", "k1", "h1"], ["remember", "k2", "h2"],
    ["remember", "k3", "h3"], ["remember", "k4", "h4"], ["match", "k9", "h1"], ["match", "k9", "h2"],
    ["tick", 2000], ["match", "k9", "h4"], ["remember", "k1", "h1"], ["remember", "k1", "h5"], ["match", "k2", "h1"],
  ];
  for (const s of steps) {
    if (s[0] === "tick") { t += s[1]; continue; }
    t += 10;
    if (s[0] === "remember") {
      a.remember(s[1], s[2], { label: s[1], bytes: 5 });
      b.remember(s[1], s[2], { label: s[1], bytes: 5 });
    } else {
      assert.deepEqual(b.match(s[1], s[2]), a.match(s[1], s[2]), JSON.stringify(s));
    }
    assert.equal(b.size(), a.size());
  }
});

await check("contact sheet: identical sheet bytes and tile map for ok, empty, stale and failed cells", () => {
  const tile = (seed, w = 30, h = 20) => {
    const n = neu.png.normalizePng(makePng({ w, h, sample: soft8(seed) }));
    return { pixels: n.pixels, channels: n.channels, width: w, height: h };
  };
  const rgb = neu.png.normalizePng(FIXTURES["8-bit RGB"]);
  for (const count of [1, 2, 3, 4, 5, 6]) {
    const specs = [];
    for (let i = 0; i < count; i++) {
      const status = ["ok", "empty", "stale", "failed", "ok", "ok"][i];
      const spec = { time: i * 0.5 + 0.04, status, note: status === "ok" ? undefined : "why " + i };
      if (status === "ok") Object.assign(spec, i === 4 ? { pixels: rgb.pixels, channels: 3, width: 20, height: 9 } : tile(i));
      specs.push(spec);
    }
    const opts = { cellWidth: 30, cellHeight: 20 };
    const a = old.sheet.composeContactSheet(specs, opts);
    const b = neu.sheet.composeContactSheet(specs, opts);
    assert.ok(b.buffer.equals(a.buffer), `${count}-tile sheet bytes differ`);
    assert.deepEqual({ ...b, buffer: null }, { ...a, buffer: null });
  }
  for (const t of [0, 0.04, 1, 59.999, 61.5, 3600.25]) assert.equal(neu.sheet.formatTime(t), old.sheet.formatTime(t));
  for (const n of [1, 2, 3, 4, 5, 6, 7, 9]) assert.deepEqual(neu.sheet.layoutFor(n), old.sheet.layoutFor(n));
  assert.equal(neu.sheet.CONTACT_SHEET_BUDGET_MS, old.sheet.CONTACT_SHEET_BUDGET_MS);
  assert.equal(neu.sheet.RETRY_MIN_MS, old.sheet.RETRY_MIN_MS);
  for (const left of [0, 500, 1500, 60000, 500000]) {
    assert.equal(neu.sheet.tileBudgetMs(left, 0, 120000), old.sheet.tileBudgetMs(left, 0, 120000));
  }
});

// --- .mogrt: a zip with a thumbnail, built here ---
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const MOGRT_RGBA = makeZip([
  { name: "definition.json", data: Buffer.from('{"a":1}'), deflate: true },
  { name: "thumb.png", data: makePng({ w: 24, h: 16, sample: opaque(2) }), deflate: true },
  { name: "project.aegraphic", data: Buffer.from("x".repeat(300)), deflate: false },
]);
const MOGRT_RGB = makeZip([
  { name: "thumb.png", data: makePng({ w: 20, h: 20, colorType: 2, sample: (x, y, c) => (x * c) & 0xff }), deflate: false },
  { name: "definition.json", data: Buffer.from("{}"), deflate: true },
]);

await check(".mogrt thumbnail: identical archive bytes for every poster/thumbnail pairing", () => {
  const posters = [
    FIXTURES["8-bit RGBA premultiplied soft edges"],
    FIXTURES["16-bit RGBA premultiplied"],
    FIXTURES["8-bit RGB"],
    makePng({ w: 64, h: 18, sample: soft8(4) }),
  ];
  for (const zip of [MOGRT_RGBA, MOGRT_RGB]) {
    for (const poster of posters) {
      const a = old.mogrt.patchThumbnail(zip, poster);
      const b = neu.mogrt.patchThumbnail(zip, poster);
      assert.ok(b.buffer.equals(a.buffer), "patched archive bytes differ");
      assert.deepEqual({ ...b, buffer: null }, { ...a, buffer: null });
    }
  }
  let ea, eb;
  const noThumb = makeZip([{ name: "definition.json", data: Buffer.from("{}"), deflate: true }]);
  try { old.mogrt.patchThumbnail(noThumb, posters[0]); } catch (e) { ea = e.message; }
  try { neu.mogrt.patchThumbnail(noThumb, posters[0]); } catch (e) { eb = e.message; }
  assert.ok(ea);
  assert.equal(eb, ea);
});

// ---------------------------------------------------------------------------
// End to end: the real panel answering the public op, against the server's
// pipeline answering the raw op through the same panel.
// ---------------------------------------------------------------------------
const W = 40;
const H = 24;
const COMP = { id: 7, width: W * 4, height: H * 4 };
const LAYER = 12;

/**
 * What a render at `time` writes. A frame per time, so both sides see the
 * same bytes for the same request; the `plan` overrides model #45 and #29.
 */
const FRAMES = {
  0: makePng({ w: W, h: H, sample: opaque(1) }),
  0.5: makePng({ w: W, h: H, sample: soft8(2) }),
  1: makePng({ w: W, h: H, depth: 16, sample: soft16(3) }),
  1.5: makePng({ w: W, h: H, sample: (x, y, c) => (c === 3 ? 0 : 50) }),
  2: makePng({ w: W, h: H, sample: opaque(1) }), // the same pixels as 0: a static stretch
  2.5: makePng({ w: W, h: H, colorType: 3, sample: (x) => x % 2, extra: [chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255]))] }),
};
const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-parity-render-"));
let renderSeq = 0;
/** Per-time overrides consumed in order: "garbage" writes a corrupt file. */
const plan = { overrides: [] };
/** A real render differs at another downsample, so the fixture does too. */
const otherScale = new Map();
function frameFor(time, ds) {
  // From 8s on the comp holds still: every time renders the same pixels.
  if (time >= 8) return makePng({ w: W, h: H, sample: soft8(ds * 5) });
  if (ds === 4) return FRAMES[time];
  const key = `${time}|${ds}`;
  if (!otherScale.has(key)) {
    otherScale.set(key, time === 1
      ? makePng({ w: W, h: H, depth: 16, sample: soft16(ds * 100) })
      : makePng({ w: W, h: H, sample: soft8(ds * 13 + Math.round(time * 20)) }));
  }
  return otherScale.get(key);
}
function writeFrame(time, ds) {
  const file = path.join(renderDir, `frame-${renderSeq++}.png`);
  const o = plan.overrides.shift();
  fs.writeFileSync(file, o === "garbage" ? Buffer.from("not a png") : frameFor(time, ds));
  return file;
}

let mogrtSeq = 0;
function dispatchStub(op, args) {
  const base = op.replace(/^_/, "");
  if (base === "screenshot_frame") {
    const ds = args.downsample || 4;
    if (args.times && args.times.length) {
      return {
        contactSheet: true, downsample: ds, width: COMP.width, height: COMP.height, compId: COMP.id,
        times: args.times,
        tiles: args.times.map((t) => (t < 0 ? { time: t, downsample: ds, error: "time is before the comp" } : { time: t, downsample: ds, path: writeFrame(t, ds) })),
      };
    }
    const time = args.time === undefined ? 0 : args.time;
    return { path: writeFrame(time, ds), width: COMP.width, height: COMP.height, downsample: ds, time, compId: COMP.id };
  }
  if (base === "screenshot_layer") {
    const time = args.time === undefined ? 0 : args.time;
    const ds = args.downsample || 4;
    return { path: writeFrame(time, ds), width: COMP.width, height: COMP.height, downsample: ds, time, compId: COMP.id, layerId: LAYER };
  }
  if (base === "export_mogrt") {
    const out = path.join(renderDir, `t-${mogrtSeq++}.mogrt`);
    fs.writeFileSync(out, args.zip === "rgb" ? MOGRT_RGB : MOGRT_RGBA);
    const r = { ok: true, path: out, bytes: fs.statSync(out).size, compId: COMP.id, name: "T", controllerCount: 2, fonts: [] };
    if (args.posterTime !== undefined) {
      r.posterPngPath = writeFrame(args.posterTime, 1);
      r.posterTime = args.posterTime;
    }
    return r;
  }
  throw new Error(`Unknown op: ${op}`);
}

function parsePayload(script) {
  const open = script.indexOf("__AEMCP.call(") + "__AEMCP.call(".length;
  const close = script.lastIndexOf(") : '");
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
    textContent: "", className: "", childNodes: [],
    insertBefore(n) { this.childNodes.unshift(n); },
    removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
  });
  for (const id of ["status", "port", "ae", "jsx", "reqs", "log"]) nodes[id] = mk();
  return { nodes, document: { getElementById: (id) => nodes[id] ?? null, createElement: () => mk() } };
}
function bootPanel() {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-parity-panel-"));
  fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
  fs.mkdirSync(path.join(extDir, "jsx"), { recursive: true });
  for (const f of fs.readdirSync(clientDir)) fs.copyFileSync(path.join(clientDir, f), path.join(extDir, "client", f));
  fs.copyFileSync(path.join(panelSrc, "jsx", "bundle.jsx"), path.join(extDir, "jsx", "bundle.jsx"));
  fs.copyFileSync(path.join(panelSrc, "package.json"), path.join(extDir, "package.json"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-parity-home-"));
  const configDir = path.join(fakeHome, ".engineroom-ae-mcp");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ port: 0 }));
  const realOs = nodeRequire("node:os");
  const realHttp = nodeRequire("node:http");
  const servers = [];
  const dom = makeDom();
  const sandbox = {
    console, Promise, Date, Math, JSON, Error, Buffer, String, Number, Array, Object, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: extDir, __filename: path.join(extDir, "main.js"),
    document: dom.document,
    window: { __adobe_cep__: makeHost(extDir) },
    require: (id) => {
      if (id === "os") return { ...realOs, homedir: () => fakeHome };
      if (id === "http") {
        return { ...realHttp, createServer: (...a) => { const s = realHttp.createServer(...a); servers.push(s); return s; } };
      }
      if (["path", "fs", "crypto", "zlib", "net", "url", "stream", "events", "util", "buffer"].includes(id)) return nodeRequire(`node:${id}`);
      return nodeRequire(id);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extDir, "client", "csinterface.js"), "utf8"), sandbox, { filename: "csinterface.js" });
  vm.runInContext(fs.readFileSync(path.join(extDir, "client", "main.js"), "utf8"), sandbox, { filename: "main.js" });
  const close = () => {
    for (const s of servers) { try { s.close(); s.closeAllConnections?.(); } catch {} }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  };
  return { dom, close, configDir };
}

const panel = bootPanel();
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 8000;
  (function poll() {
    const s = panel.dom.nodes.status.textContent;
    if (s === "ready") return resolve();
    if (s === "failed" || s.indexOf("cannot start") === 0 || Date.now() > deadline) {
      return reject(new Error(`panel did not boot: ${s}`));
    }
    setTimeout(poll, 25);
  })();
});
const PORT = Number(panel.dom.nodes.port.textContent);
const TOKEN = fs.readFileSync(path.join(panel.configDir, `token-${PORT}`), "utf8").trim();

async function post(op, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/op`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ae-mcp-token": TOKEN },
    body: JSON.stringify({ op, args }),
  });
  return res.json();
}

await check("the panel lists server-images on /health", async () => {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  assert.ok(Array.isArray(h.capabilities) && h.capabilities.includes("server-images"));
});

await check("the panel passes the raw ops through untouched: a path, no image", async () => {
  const body = await post("_screenshot_frame", { compId: COMP.id, time: 0 });
  assert.ok(body.ok, body.error);
  assert.equal(typeof body.result.path, "string");
  assert.equal(body.result.base64, undefined);
  fs.rmSync(body.result.path, { force: true });
});

/** The legacy path: the panel does everything and answers the public op. */
async function viaPanel(op, args) {
  const body = await post(op, args);
  return body.ok ? { ok: true, result: body.result } : { ok: false, code: body.code, error: body.error };
}

const pipeline = createFramePipeline({ warn: () => {} });
/** The new path: the panel answers the raw op, the server finishes it. */
async function viaServer(op, args) {
  const send = async (raw, a) => {
    const body = await post(raw, a);
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  try {
    return { ok: true, result: await pipeline.run(op, args, send) };
  } catch (e) {
    return { ok: false, code: e.code, error: e.message };
  }
}

/** Comparable form: drop the volatile parts (temp paths, ages in seconds). */
function comparable(r, opts = {}) {
  const s = JSON.parse(JSON.stringify(r));
  if (s.result && s.result.path) s.result.path = "<mogrt>";
  if (s.error) s.error = s.error.replace(/\d+s ago/g, "Ns ago").replace(/\d+s earlier/g, "Ns earlier");
  if (s.result && Array.isArray(s.result.tiles)) {
    for (const t of s.result.tiles) if (t.note) t.note = t.note.replace(/\d+s earlier/g, "Ns earlier");
  }
  if (s.result && s.result.warning) s.result.warning = s.result.warning.replace(/\d+s earlier/g, "Ns earlier");
  if (opts.dropBytes && s.result) delete s.result.bytes;
  return s;
}

/**
 * Run one call down both paths, the panel first. Each path holds its own
 * stale-frame cache (the panel's, the server's), and both see the same
 * sequence of calls, so their verdicts must match too.
 */
async function both(op, args, overrides = []) {
  plan.overrides = [...overrides];
  const a = await viaPanel(op, args);
  assert.equal(plan.overrides.length, 0, "the panel path did not consume its planned renders");
  plan.overrides = [...overrides];
  const b = await viaServer(op, args);
  assert.equal(plan.overrides.length, 0, "the server path did not consume its planned renders");
  return { a, b };
}

// Each scene also states what the panel's answer is, so two paths failing
// the same wrong way cannot pass as parity.
const SCENES = [
  ["an opaque 8-bit frame", "screenshot_frame", { compId: COMP.id, time: 0 },
    (a) => assert.ok(a.ok && a.result.base64 && !a.result.converted)],
  ["premultiplied soft edges, un-premultiplied once (#130)", "screenshot_frame", { compId: COMP.id, time: 0.5 },
    (a) => assert.notEqual(a.result.base64, FRAMES[0.5].toString("base64"), "the frame was not re-encoded straight")],
  ["a 16-bit frame, converted to 8-bit", "screenshot_frame", { compId: COMP.id, time: 1 },
    (a) => assert.ok(a.result.converted && a.result.sourceBitDepth === 16)],
  ["an empty frame: reported, never shipped", "screenshot_frame", { compId: COMP.id, time: 1.5 },
    (a) => assert.ok(a.result.empty && a.result.base64 === undefined)],
  ["an indexed frame, passed through with a warning", "screenshot_frame", { compId: COMP.id, time: 2.5 },
    (a) => assert.match(a.result.warning, /not inspected/)],
  ["a solo'd layer", "screenshot_layer", { compId: COMP.id, layerId: LAYER, time: 0.5, downsample: 2 },
    (a) => assert.equal(a.result.layerId, LAYER)],
  ["the same request again is not stale", "screenshot_frame", { compId: COMP.id, time: 0 },
    (a) => assert.ok(a.ok)],
  ["a different request with identical pixels is refused as stale (#29)", "screenshot_frame", { compId: COMP.id, time: 2 },
    (a) => assert.equal(a.code, "STALE_FRAME")],
  ["a contact sheet: ok, 16-bit, empty, failed-in-AE, stale and a static pair", "screenshot_frame",
    { compId: COMP.id, times: [0.5, 1, 1.5, -1, 0, 2], downsample: 4 },
    (a) => assert.deepEqual(a.result.tiles.map((t) => t.status), ["ok", "ok", "empty", "failed", "ok", "stale"])],
  ["a contact sheet whose every tile is a block", "screenshot_frame", { compId: COMP.id, times: [1.5, -1], downsample: 4 },
    (a) => assert.equal(a.code, "CONTACT_SHEET_FAILED")],
  ["a static pair inside one sheet is flagged, not refused", "screenshot_frame", { compId: COMP.id, times: [8, 9], downsample: 7 },
    (a) => assert.match(a.result.tiles[1].note, /pixel-identical to the/)],
];

for (const [name, op, args, expect] of SCENES) {
  await check(`end to end: ${name}`, async () => {
    const { a, b } = await both(op, args);
    expect(a);
    assert.deepEqual(comparable(b), comparable(a));
  });
}

await check("end to end: a corrupt render is re-rendered once and the retry delivered, on both (#45)", async () => {
  const { a, b } = await both("screenshot_frame", { compId: COMP.id, time: 0.5, downsample: 3 }, ["garbage"]);
  assert.ok(a.ok, a.error);
  assert.deepEqual(comparable(b), comparable(a));
});

await check("end to end: two corrupt renders are FRAME_INCOMPLETE with the same message, and nothing is cached", async () => {
  const { a, b } = await both("screenshot_frame", { compId: COMP.id, time: 1, downsample: 5 }, ["garbage", "garbage"]);
  assert.equal(a.ok, false);
  assert.equal(a.code, "FRAME_INCOMPLETE");
  assert.deepEqual(comparable(b), comparable(a));
  // Nothing was remembered from the failure: the same request now succeeds.
  const again = await both("screenshot_frame", { compId: COMP.id, time: 1, downsample: 5 });
  assert.ok(again.a.ok && again.b.ok);
  assert.deepEqual(comparable(again.b), comparable(again.a));
});

await check("end to end: a corrupt contact-sheet tile is re-rendered on its own, on both", async () => {
  const { a, b } = await both("screenshot_frame", { compId: COMP.id, times: [0.5, 1], downsample: 2 }, [undefined, "garbage"]);
  assert.ok(a.ok, a.error);
  assert.deepEqual(comparable(b), comparable(a));
});

for (const [name, args] of [
  ["a poster over an RGBA thumbnail", { compId: COMP.id, posterTime: 0.5 }],
  ["a 16-bit poster over an RGB thumbnail", { compId: COMP.id, posterTime: 1, zip: "rgb" }],
  ["no poster: the export is returned as it is", { compId: COMP.id }],
]) {
  await check(`end to end: export_mogrt, ${name}`, async () => {
    plan.overrides = [];
    const before = mogrtSeq;
    const { a, b } = await both("export_mogrt", args);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(comparable(b), comparable(a));
    const fa = fs.readFileSync(path.join(renderDir, `t-${before}.mogrt`));
    const fb = fs.readFileSync(path.join(renderDir, `t-${before + 1}.mogrt`));
    assert.ok(fb.equals(fa), "the patched .mogrt files differ");
    assert.equal(a.result.posterPngPath, undefined);
    if (args.posterTime !== undefined) assert.equal(a.result.thumbnail.patched, true);
  });
}

await check("end to end: a poster that is not a PNG leaves AE's thumbnail, on both", async () => {
  const before = mogrtSeq;
  // The stall window would make this slow; garbage is refused at once.
  const { a, b } = await both("export_mogrt", { compId: COMP.id, posterTime: 0 }, ["garbage"]);
  assert.equal(a.result.thumbnail.patched, false);
  assert.deepEqual(comparable(b), comparable(a));
  const fa = fs.readFileSync(path.join(renderDir, `t-${before}.mogrt`));
  assert.ok(fa.equals(MOGRT_RGBA), "a failed patch must leave the template untouched");
});

await check("no temp frame is left behind on either path", () => {
  const left = fs.readdirSync(renderDir).filter((f) => f.endsWith(".png"));
  assert.deepEqual(left, []);
});

panel.close();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(renderDir, { recursive: true, force: true });
console.log(`image-parity: ${passed} checks passed`);
// A pause before exiting: an immediate exit after fetch has crashed
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
