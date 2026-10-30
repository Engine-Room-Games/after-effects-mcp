// The server's image code, pinned to the bytes the panel's copy produced
// (issues #220 stage 4, #243).
//
// Stage 4 moved the screenshot, contact-sheet and .mogrt-thumbnail work from
// the panel (`packages/ae-panel/client/*.js`) to the server
// (`packages/mcp-server/src/frames/*.ts`), and for a while both copies shipped
// and this file compared them fixture by fixture. Issue #243 deleted the
// panel's copy. What this file holds now is the result of that comparison:
// every output below is pinned by sha256 to what both copies agreed on, so a
// change to the server's image code that moves a single byte — PNG bytes,
// decoded samples, sheet and zip bytes, frame-error and stale-frame text —
// fails here and has to be re-pinned on purpose.
//
//   * module by module: the fixtures through the server's modules;
//   * end to end: the real `client/main.js`, booted against a stub CEP host,
//     passes the raw ops through untouched, and the server's pipeline finishes
//     each render — the image, the metadata, the refusals.
//
// Each scene also asserts what its answer means, so the pins are never the
// only thing standing between a wrong answer and a pass.
//
// The measured traps each get a fixture: a 16-bit frame, premultiplied soft
// edges (#130), an empty frame, partial writes and a corrupt file (#45), a
// re-served render buffer (#29), and a static comp inside one contact sheet.
//
//   node tests/unit/image-parity.mjs
//
// Re-pinning after a deliberate change: IMAGE_PARITY_RECORD=1 prints the new
// PINS table instead of checking it. IMAGE_PARITY_OLD_PANEL=<dir> additionally
// compares the module checks against a directory holding the deleted panel
// modules (`git show 6063cd6:packages/ae-panel/client/<file>`).

import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const neu = {
  png: await load("pngCodec.js"),
  reader: await load("frameReader.js"),
  cache: await load("frameCache.js"),
  sheet: await load("contactSheet.js"),
  mogrt: await load("mogrtThumbnail.js"),
};
const { createFramePipeline } = await load("pipeline.js");

const RECORD = process.env.IMAGE_PARITY_RECORD === "1";
const OLD_DIR = process.env.IMAGE_PARITY_OLD_PANEL;
const old = OLD_DIR
  ? {
      png: nodeRequire(path.join(OLD_DIR, "pngcodec.js")),
      reader: nodeRequire(path.join(OLD_DIR, "framereader.js")),
      cache: nodeRequire(path.join(OLD_DIR, "framecache.js")),
      sheet: nodeRequire(path.join(OLD_DIR, "contactsheet.js")),
      mogrt: nodeRequire(path.join(OLD_DIR, "mogrt.js")),
    }
  : null;

// sha256 of each output, recorded with the old panel modules loaded and equal.
const PINS = {
  "normalizePng: 8-bit RGBA opaque": "3283f66686c2a61535b36762ca22f6cdfe1aa1555905662ed0c5b1f48fccde2a",
  "decodePng8: 8-bit RGBA opaque": "b38a318cf2f5a271006ba940a05f59e5c176918b34f2c9877398fc84da069ece",
  "normalizePng: 8-bit RGBA premultiplied soft edges": "7821fef3bcda3c685f224855948b1d7491fe8119f014ccd961e6c2971d984db7",
  "decodePng8: 8-bit RGBA premultiplied soft edges": "3ff65faf1752da2223fe06dca841996c5258faddfa122a7c1c1d1ea6e9f856cf",
  "normalizePng: 8-bit RGB": "24c5f3c68ee6d4838e474b24f0f66bb889d006ddeb67cfae385dae925e1c52c7",
  "decodePng8: 8-bit RGB": "01978decc7af76997adb7a49fc3b45a2da1b6021e7944cc3430cc88cd895173b",
  "normalizePng: 8-bit grey+alpha": "91bbca59f4a8d0caff2b19111ee0f9d6f4f067d31518b69b62522c09cc8f3153",
  "decodePng8: 8-bit grey+alpha": "40feacb31086a8b8cc1a534823f356e4527c036cc10cda755b93e8fbf1e64dd5",
  "normalizePng: 16-bit RGBA premultiplied": "878e5e38cdb99372cac89a65f911521ce76d0529a0182ef0c64ef4d4777f3961",
  "decodePng8: 16-bit RGBA premultiplied": "e9da960b3fe30437aed82cbb9a61453b112e0bfa6b43432fcbe06e4a0c8a193d",
  "normalizePng: 16-bit RGBA opaque": "7b2bda06ffdeb70684e6accc4026d7469500892d0b1a1ff6b7354eace9c9c77c",
  "decodePng8: 16-bit RGBA opaque": "d153402cf101012ab48086466b43c269fa284e5c97bde5fd9cb4834f0469cabe",
  "normalizePng: 16-bit RGB": "cbdbf0723a0414135f69ea99e8c614c7935bc9289efc0a8361dfabaa0e4ab7c5",
  "decodePng8: 16-bit RGB": "b68e6b1245ed7146cbc2fc94f306db5aae5d1aa6a842dff3ff61fcddb766b829",
  "normalizePng: empty (every pixel clear)": "ef31318e66af13008ab1ca48ee40c33643cb2cf951f2a525c61b6e4363a885a6",
  "decodePng8: empty (every pixel clear)": "5e268ad4799c6609a93b62ee94b73b67b1217cb5df6ae9d6f07a3a2349abadfc",
  "normalizePng: 16-bit empty": "e9e36c38948860be92a2eae8b4680fd29f8903dc912d9fdb6f24d31b40929eb3",
  "decodePng8: 16-bit empty": "f9e295ae71e28b20045da38264f0c3e983d67621f4628e65aaf010b13cc39864",
  "normalizePng: interlaced (passed through)": "3ee48f044b96d437fa16efe3deae329db3c69cf29d2f30d36238700014fca9c3",
  "decodePng8: interlaced (passed through)": "31ee743dd74cb8737ad47b550aa3440a1c5e0378685b9181393d074cc1e14d94",
  "normalizePng: indexed (passed through)": "fcea27bbb5bcb5675816c9f06011f596427ec01aacc6d9dc1add4080e962bbe3",
  "decodePng8: indexed (passed through)": "e717a5b101733603bcafebef1bb30f41b4aaa95bbb6138d64a3e0322b8e00138",
  "normalizePng: with ancillary chunk": "d890d3f368b115c68481e9ef25f596691c17e59afcadd24a6a9fe702c96cecc2",
  "decodePng8: with ancillary chunk": "8bb569799a475b5bfdc338cb1d6976325b2fc6ed9b0ce1ed4792ca17254250e6",
  "normalizePng: refusals": "480d4db69b7b197460ad546a1b4495309185d586157823df21b6d5a7505b19b3",
  "inspectPngStructure": "176a65c201ad5ac45cdec6fad30cc289ca95c4082f4acf48e3c239990368b11c",
  "encodePng8 + crc32": "fc63918f89cefc9aa224334cb9e4d85943c4df13d255b7c62a586ed4a7c1401c",
  "waitForCompletePng: stalled": "9e127faae75edd07ca4e51cb0cb6ae6ec74f60399a75491f05815ea6a7e2873d",
  "waitForCompletePng: not a PNG, and a timeout": "156f70de8b2121b09ca33e70d92665e142706aefdc82cbacc0996c6752c351e5",
  "dressFrameError": "4aa3031eb1c75c1cd33449e67750ba7ebec910c3fa75d81202f3ff2277743b2d",
  "frame cache sequence": "03b219fc85546aa54a1f5c9b0da309cf8431585b84200c21274641f837717509",
  "contact sheet: 1 tiles": "6964902fdd3ad955b8a5e56ccddb0022782c61e7c6df909e884094fd78d2f3ac",
  "contact sheet: 2 tiles": "2e59bd99695a85716df209ca51f61e0d4db04362581af192ae42b6261c4262e2",
  "contact sheet: 3 tiles": "2a3f4e4021f63c5e2af6bcb6a81058b806e5d5fa4429fbfc33f6b4658eb873a2",
  "contact sheet: 4 tiles": "61d3107fed268bf7e4a87afc717c874751c94686f277cd5af494c67823a4e2cb",
  "contact sheet: 5 tiles": "5b2ae5e2766e9fd3d53bafbb3daf30e9fc7b0957a1c3f09c4ed3a1bc4fd0a3ed",
  "contact sheet: 6 tiles": "2fe90b30aba479a05b7b0ef3bfed1df3b128660e33d917c6c5b2912cc2044e7a",
  "contact sheet: times, layouts, budgets": "148c3b6486c074f6e4e4540d6e7f004008c93a064536dfe633eb85935c4fb0ac",
  ".mogrt thumbnail patches": "fe2d42cbb6fbe49e9f2108d9510a6a403f578f476ca8ab9d59371c05fb8a7c2d",
  "end to end: an opaque 8-bit frame": "72872dfa18b9dcdb92bf67467b211adca10a41d82ae5cc8ab3e4b9ae3d76b265",
  "end to end: premultiplied soft edges, un-premultiplied once (#130)": "36f731cfbf708d0b6af7e756d6bf2bb6aea56c960fae765c7a59415fa1432e1a",
  "end to end: a 16-bit frame, converted to 8-bit": "0bb1c9391f2b37d2cff97c158c499527ee7ab84c2ed2efa1774c0a01b4598834",
  "end to end: an empty frame: reported, never shipped": "679f2f35db70e9226b25239394dbbba5a5783ef746e1fbd7e418da45977a837f",
  "end to end: an indexed frame, passed through with a warning": "e2bfa0d10d0a7690e0298163a8af377c9b380b0f56ba005c8d4fa78dc9711ef8",
  "end to end: a solo'd layer": "68442cdeb69b980444d72ade5c47412f2ed694fd490e60cebfae6f2b66f09101",
  "end to end: the same request again is not stale": "72872dfa18b9dcdb92bf67467b211adca10a41d82ae5cc8ab3e4b9ae3d76b265",
  "end to end: a different request with identical pixels is refused as stale (#29)": "687c5de8ed7f47e381e9b4b5ace4db1381ffcf72d0c6069a622ea21c4f9ab157",
  "end to end: a contact sheet: ok, 16-bit, empty, failed-in-AE, stale and a static pair": "7933187e1a9fe50d870a79aeac71c4735313c5aa1a01051c8511746cbe93adf0",
  "end to end: a contact sheet whose every tile is a block": "5b6e840a41446666c97bfd6e5aa753d90a65a3453be425c89dfdad851448106d",
  "end to end: a static pair inside one sheet is flagged, not refused": "3ec91047f751c3e0629cbda4591e740200c829fe66fd8d2f1dd051cb3c852a6d",
  "end to end: corrupt render retried": "7fa398b81f8f5c375afed4e9941b4e97e922f0ddc3bc41f0346653e9d7c48baa",
  "end to end: two corrupt renders": "c0504952735a024e00ed46494d1cac7f5c8f6276a1ea040f5f088baf60877c5d",
  "end to end: the same request after two corrupt renders": "faa78a141c73bab636b3f40c21193b1ac9a3d80a4ebf695501bb52d96ac94195",
  "end to end: corrupt contact-sheet tile": "72024c10ccef54a4db6c45a120562ce55fda535eba7038ee4cda95dd1a5c5c2a",
  "end to end: export_mogrt, a poster over an RGBA thumbnail": "5383a0e1e95d122e3c6452641fab453b2e40f28337045f84b5082edacf10cb18",
  "end to end: export_mogrt, a 16-bit poster over an RGB thumbnail": "79a95ac83d087c2eb69be57ee7f687ee89775788ecef03bc2d9d4585e12ab829",
  "end to end: export_mogrt, no poster: the export is returned as it is": "77e35e8070cc2e28a33a5bdb324f7d4a3516d6cd7aeed123475cad04d49a4d5e",
  "end to end: export_mogrt, a poster that is not a PNG": "21a3b27f5ce1b07ea552f98edf91f39e90e707d6b336cbb73f1833e3e51aeef1"
};

const recorded = {};
const seen = new Set();
// Compressed bytes are not pinned as bytes. Node's zlib picks its match-finding
// hash by CPU, so the same deflate can come out differently on an x64 Windows
// runner and an arm64 Mac while inflating to the same thing. A PNG is pinned
// by its chunks with IDAT inflated, a zip by its entries inflated, and byte
// counts (file sizes, sizes quoted in messages) are left out.
const PNG_SIG = "89504e470d0a1a0a";
function canonPng(buf) {
  const chunks = [];
  const idat = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IDAT") idat.push(data);
    else chunks.push([type, data.toString("hex")]);
    at += 12 + len;
  }
  let pixels;
  try { pixels = zlib.inflateSync(Buffer.concat(idat)).toString("hex"); } catch (e) { pixels = "uninflatable"; }
  return { png: chunks, pixels, trailing: buf.length - at };
}
function canonZip(buf) {
  const entries = [];
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const csize = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 30, at + 30 + nameLen);
    const body = buf.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    entries.push({ name, method, crc: buf.readUInt32LE(at + 14), data: canonBytes(data) });
    at += 30 + nameLen + extraLen + csize;
  }
  return { zip: entries };
}
function canonBytes(buf) {
  const hex = buf.toString("hex", 0, 8);
  if (hex === PNG_SIG) return canonPng(buf);
  if (hex.startsWith("504b0304")) return canonZip(buf);
  return buf.toString("hex");
}
function canon(x) {
  if (typeof x === "string") {
    if (x.startsWith(PNG_SIG) || x.startsWith("504b0304")) return canonBytes(Buffer.from(x, "hex"));
    if (x.startsWith("iVBORw0KGgo")) return canonBytes(Buffer.from(x, "base64"));
    return x.replace(/\d+ bytes/g, "N bytes");
  }
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    const o = {};
    for (const [k, v] of Object.entries(x)) if (k !== "bytes") o[k] = canon(v);
    return o;
  }
  return x;
}
function digest(v) {
  return crypto.createHash("sha256").update(JSON.stringify(canon(JSON.parse(JSON.stringify(v, (k, x) =>
    x && x.type === "Buffer" && Array.isArray(x.data) ? Buffer.from(x.data).toString("hex") : x))))).digest("hex");
}
/**
 * Pin `value` under `label`. With the old panel modules loaded, `oldValue()`
 * must equal it first — that is how the pins were made.
 */
function pin(label, value, oldValue) {
  if (old && oldValue) assert.deepEqual(value, oldValue(), `${label}: server and the panel's old copy differ`);
  seen.add(label);
  const d = digest(value);
  if (RECORD) {
    assert.equal(recorded[label], undefined, `duplicate pin label ${label}`);
    recorded[label] = d;
    return;
  }
  assert.ok(PINS[label], `no pin for "${label}" — re-record with IMAGE_PARITY_RECORD=1`);
  assert.equal(d, PINS[label], `${label}: the server's output moved from the pinned bytes`);
}

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
  // Stored blocks (level 0): the same fixture bytes on every CPU, see canon() above.
  const z = zlib.deflateSync(Buffer.concat(rows), { level: 0 });
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
// Modules
// ---------------------------------------------------------------------------
const attempt = (fn) => {
  try { return { r: fn() }; } catch (e) { return { e: e.message }; }
};

for (const [name, buf] of Object.entries(FIXTURES)) {
  await check(`normalizePng: ${name}`, () => {
    pin(`normalizePng: ${name}`, plainNorm(neu.png.normalizePng(buf)), () => plainNorm(old.png.normalizePng(buf)));
  });
  await check(`decodePng8: ${name}`, () => {
    pin(`decodePng8: ${name}`, attempt(() => plainNorm(neu.png.decodePng8(buf))), () => attempt(() => plainNorm(old.png.decodePng8(buf))));
  });
}

await check("normalizePng: the 16-bit and soft-edge fixtures really are converted (the pins are not vacuous)", () => {
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
  const run = (m) => bad.map((b) => attempt(() => m.normalizePng(b)));
  const got = run(neu.png);
  for (const g of got) assert.ok(g.e, "a broken file was accepted");
  pin("normalizePng: refusals", got, () => run(old.png));
});

await check("inspectPngStructure: every prefix of a frame, and garbage, read the same (#45)", () => {
  const whole = FIXTURES["16-bit RGBA premultiplied"];
  const run = (m) => {
    const out = [];
    for (let n = 0; n <= whole.length; n++) out.push(m.inspectPngStructure(whole.subarray(0, n)));
    for (const g of [Buffer.from("After Effects wrote this"), Buffer.concat([SIG, chunk("IDAT", Buffer.alloc(3))])]) {
      out.push(m.inspectPngStructure(g));
    }
    return JSON.parse(JSON.stringify(out));
  };
  pin("inspectPngStructure", run(neu.png), () => run(old.png));
});

await check("encodePng8 and crc32: pinned bytes", () => {
  const px = Buffer.alloc(7 * 5 * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 31) & 0xff;
  const run = (m) => ({ png: m.encodePng8(7, 5, 6, px).toString("hex"), crc: m.crc32(px) });
  pin("encodePng8 + crc32", run(neu.png), () => run(old.png));
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
  for (let i = 0; i < pieces; i++) {
    setTimeout(() => {
      fs.appendFileSync(file, bytes.subarray(at, at + step));
      at += step;
    }, gapMs * (i + 1));
  }
  return file;
}

async function outcome(p) {
  try {
    const buf = await p;
    return { ok: true, hex: buf.toString("hex") };
  } catch (e) {
    // The stall length is measured, so it may differ by a rounding step.
    return { ok: false, code: e.code, detail: e.detail.replace(/f-\d+\.png/g, "f-N.png").replace(/\d+s/g, "Ns") };
  }
}

await check("waitForCompletePng: a frame written in pauses longer than the poll arrives whole", async () => {
  const bytes = FIXTURES["8-bit RGBA premultiplied soft edges"];
  const a = await outcome(neu.reader.waitForCompletePng(writeInPieces(bytes, 4, 60), { stallMs: 2000, pollMs: 10 }));
  assert.equal(a.ok, true);
  assert.equal(a.hex, bytes.toString("hex"));
});

await check("waitForCompletePng: a write that stalls short of IEND is FRAME_INCOMPLETE, and the file is removed", async () => {
  const cut = FIXTURES["8-bit RGBA opaque"].subarray(0, FIXTURES["8-bit RGBA opaque"].length - 30);
  const run = async (m) => {
    const f = tmpFile();
    fs.writeFileSync(f, cut);
    const r = await outcome(m.waitForCompletePng(f, { stallMs: 150, pollMs: 10 }));
    assert.ok(!fs.existsSync(f), "a failed read must remove the temp file");
    return r;
  };
  const a = await run(neu.reader);
  assert.equal(a.code, "FRAME_INCOMPLETE");
  const b = old ? await run(old.reader) : null;
  pin("waitForCompletePng: stalled", a, b && (() => b));
});

await check("waitForCompletePng: not a PNG is refused at once, and nothing arriving is RENDER_TIMEOUT", async () => {
  const run = async (m) => {
    const f = tmpFile();
    fs.writeFileSync(f, "not a png at all");
    const notPng = await outcome(m.waitForCompletePng(f, { pollMs: 10 }));
    const timeout = await outcome(m.waitForCompletePng(tmpFile(), { budgetMs: 120, pollMs: 10 }));
    return { notPng, timeout };
  };
  const a = await run(neu.reader);
  assert.equal(a.notPng.code, "FRAME_INCOMPLETE");
  assert.equal(a.timeout.code, "RENDER_TIMEOUT");
  const b = old ? await run(old.reader) : null;
  pin("waitForCompletePng: not a PNG, and a timeout", a, b && (() => b));
});

await check("dressFrameError: pinned messages for both failures and both attempt counts", () => {
  const run = (m) => {
    const out = [];
    for (const code of ["FRAME_INCOMPLETE", "RENDER_TIMEOUT"]) {
      for (const n of [1, 2]) {
        const e = m.dressFrameError(m.frameError(code, "a detail"), n);
        out.push({ message: e.message, code: e.code });
      }
    }
    return { out, budget: m.FRAME_RENDER_BUDGET_MS, stall: m.FRAME_STALL_MS };
  };
  const a = run(neu.reader);
  for (const e of a.out) assert.doesNotMatch(e.message, /restart After Effects|setup_panel/);
  const other = new Error("ExtendScript said no");
  assert.equal(neu.reader.dressFrameError(other, 1), other);
  pin("dressFrameError", a, () => run(old.reader));
});

await check("frame cache: pinned answers over a fixed sequence (#29)", () => {
  const run = (m) => {
    let t = 0;
    const c = m.createFrameCache({ limit: 3, ttlMs: 1000, now: () => t });
    const steps = [
      ["remember", "k1", "h1"], ["match", "k2", "h1"], ["match", "k1", "h1"], ["remember", "k2", "h2"],
      ["remember", "k3", "h3"], ["remember", "k4", "h4"], ["match", "k9", "h1"], ["match", "k9", "h2"],
      ["tick", 2000], ["match", "k9", "h4"], ["remember", "k1", "h1"], ["remember", "k1", "h5"], ["match", "k2", "h1"],
    ];
    const out = [];
    for (const s of steps) {
      if (s[0] === "tick") { t += s[1]; continue; }
      t += 10;
      if (s[0] === "remember") c.remember(s[1], s[2], { label: s[1], bytes: 5 });
      else out.push(c.match(s[1], s[2]) ?? null);
      out.push(c.size());
    }
    return JSON.parse(JSON.stringify(out));
  };
  const a = run(neu.cache);
  assert.ok(a.some((x) => x && typeof x === "object"), "no step matched: the sequence no longer exercises a stale verdict");
  pin("frame cache sequence", a, () => run(old.cache));
});

await check("contact sheet: pinned sheet bytes and tile map for ok, empty, stale and failed cells", () => {
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
    const run = (m) => {
      const s = m.composeContactSheet(specs, opts);
      return JSON.parse(JSON.stringify({ ...s, buffer: s.buffer.toString("hex") }));
    };
    pin(`contact sheet: ${count} tiles`, run(neu.sheet), () => run(old.sheet));
  }
  const misc = (m) => ({
    times: [0, 0.04, 1, 59.999, 61.5, 3600.25].map((t) => m.formatTime(t)),
    layouts: [1, 2, 3, 4, 5, 6, 7, 9].map((n) => m.layoutFor(n)),
    budget: m.CONTACT_SHEET_BUDGET_MS,
    retryMin: m.RETRY_MIN_MS,
    tileBudgets: [0, 500, 1500, 60000, 500000].map((left) => m.tileBudgetMs(left, 0, 120000)),
  });
  pin("contact sheet: times, layouts, budgets", misc(neu.sheet), () => misc(old.sheet));
});

// --- .mogrt: a zip with a thumbnail, built here ---
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data, { level: 0 }) : data;
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

await check(".mogrt thumbnail: pinned archive bytes for every poster/thumbnail pairing", () => {
  const posters = [
    FIXTURES["8-bit RGBA premultiplied soft edges"],
    FIXTURES["16-bit RGBA premultiplied"],
    FIXTURES["8-bit RGB"],
    makePng({ w: 64, h: 18, sample: soft8(4) }),
  ];
  const run = (m) => {
    const out = [];
    for (const zip of [MOGRT_RGBA, MOGRT_RGB]) {
      for (const poster of posters) {
        const r = m.patchThumbnail(zip, poster);
        out.push(JSON.parse(JSON.stringify({ ...r, buffer: r.buffer.toString("hex") })));
      }
    }
    const noThumb = makeZip([{ name: "definition.json", data: Buffer.from("{}"), deflate: true }]);
    out.push(attempt(() => m.patchThumbnail(noThumb, posters[0])));
    return out;
  };
  const a = run(neu.mogrt);
  assert.ok(a[a.length - 1].e, "an archive with no thumbnail was patched");
  pin(".mogrt thumbnail patches", a, () => run(old.mogrt));
});

// ---------------------------------------------------------------------------
// End to end: the real panel passing the raw op through, and the server's
// pipeline finishing it.
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


const pipeline = createFramePipeline({ warn: () => {} });
/** The panel answers the raw op, the server finishes it. */
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
function comparable(r) {
  const s = JSON.parse(JSON.stringify(r));
  if (s.result && s.result.path) s.result.path = "<mogrt>";
  if (s.error) s.error = s.error.replace(/\d+s ago/g, "Ns ago").replace(/\d+s earlier/g, "Ns earlier");
  if (s.result && Array.isArray(s.result.tiles)) {
    for (const t of s.result.tiles) if (t.note) t.note = t.note.replace(/\d+s earlier/g, "Ns earlier");
  }
  if (s.result && s.result.warning) s.result.warning = s.result.warning.replace(/\d+s earlier/g, "Ns earlier");
  return s;
}

/** One call, with `overrides` as the planned renders it must consume. */
async function serve(op, args, overrides = []) {
  plan.overrides = [...overrides];
  const r = await viaServer(op, args);
  assert.equal(plan.overrides.length, 0, "the call did not consume its planned renders");
  return r;
}

// Each scene also states what its answer means, so a pin re-recorded over a
// wrong answer still fails.
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
    const a = await serve(op, args);
    expect(a);
    pin(`end to end: ${name}`, comparable(a));
  });
}

await check("end to end: a corrupt render is re-rendered once and the retry delivered (#45)", async () => {
  const a = await serve("screenshot_frame", { compId: COMP.id, time: 0.5, downsample: 3 }, ["garbage"]);
  assert.ok(a.ok, a.error);
  pin("end to end: corrupt render retried", comparable(a));
});

await check("end to end: two corrupt renders are FRAME_INCOMPLETE, and nothing is cached", async () => {
  const a = await serve("screenshot_frame", { compId: COMP.id, time: 1, downsample: 5 }, ["garbage", "garbage"]);
  assert.equal(a.ok, false);
  assert.equal(a.code, "FRAME_INCOMPLETE");
  pin("end to end: two corrupt renders", comparable(a));
  // Nothing was remembered from the failure: the same request now succeeds.
  const again = await serve("screenshot_frame", { compId: COMP.id, time: 1, downsample: 5 });
  assert.ok(again.ok, again.error);
  pin("end to end: the same request after two corrupt renders", comparable(again));
});

await check("end to end: a corrupt contact-sheet tile is re-rendered on its own", async () => {
  const a = await serve("screenshot_frame", { compId: COMP.id, times: [0.5, 1], downsample: 2 }, [undefined, "garbage"]);
  assert.ok(a.ok, a.error);
  pin("end to end: corrupt contact-sheet tile", comparable(a));
});

for (const [name, args] of [
  ["a poster over an RGBA thumbnail", { compId: COMP.id, posterTime: 0.5 }],
  ["a 16-bit poster over an RGB thumbnail", { compId: COMP.id, posterTime: 1, zip: "rgb" }],
  ["no poster: the export is returned as it is", { compId: COMP.id }],
]) {
  await check(`end to end: export_mogrt, ${name}`, async () => {
    const before = mogrtSeq;
    const a = await serve("export_mogrt", args);
    assert.ok(a.ok, a.error);
    assert.equal(a.result.posterPngPath, undefined);
    if (args.posterTime !== undefined) assert.equal(a.result.thumbnail.patched, true);
    const file = fs.readFileSync(path.join(renderDir, `t-${before}.mogrt`));
    pin(`end to end: export_mogrt, ${name}`, { result: comparable(a), file: file.toString("hex") });
  });
}

await check("end to end: a poster that is not a PNG leaves AE's thumbnail", async () => {
  const before = mogrtSeq;
  // The stall window would make this slow; garbage is refused at once.
  const a = await serve("export_mogrt", { compId: COMP.id, posterTime: 0 }, ["garbage"]);
  assert.equal(a.result.thumbnail.patched, false);
  pin("end to end: export_mogrt, a poster that is not a PNG", comparable(a));
  const fa = fs.readFileSync(path.join(renderDir, `t-${before}.mogrt`));
  assert.ok(fa.equals(MOGRT_RGBA), "a failed patch must leave the template untouched");
});

await check("no temp frame is left behind", () => {
  const left = fs.readdirSync(renderDir).filter((f) => f.endsWith(".png"));
  assert.deepEqual(left, []);
});

panel.close();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(renderDir, { recursive: true, force: true });
if (RECORD) {
  console.log("const PINS = " + JSON.stringify(recorded, null, 2) + ";");
} else {
  const unused = Object.keys(PINS).filter((k) => !seen.has(k));
  assert.deepEqual(unused, [], "pins nothing checked any more — remove them or re-record");
}
console.log(`image-parity: ${passed} checks passed`);
// A pause before exiting: an immediate exit after fetch has crashed
// Node 24 on Windows with a libuv assertion (nodejs/node#56645).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
