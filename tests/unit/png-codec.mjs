// The server's PNG normaliser (frames/pngCodec.ts; the panel's copy went in #243): 16-bit -> 8-bit conversion, premultiplied ->
// straight alpha (#130), empty-frame detection, and the content hash the
// stale-render check compares.
//
// This is real image code that was written without an After Effects to try it
// against, so it is exercised here instead. The fixtures and the verification
// use a second, independent PNG reader and writer defined in this file — if the
// codec and the checker shared an implementation, a bug in the shared half would
// pass silently, which is the whole failure mode being guarded against.
//
//   node tests/unit/png-codec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const frames = (f) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "frames", f)).href;
const { normalizePng } = await import(frames("pngCodec.js"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`png-codec FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// An independent PNG implementation, used only by this test.
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
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Apply a PNG row filter forwards, to build a fixture. */
function applyFilter(type, row, prev, bpp) {
  const out = Buffer.alloc(row.length);
  for (let x = 0; x < row.length; x++) {
    const a = x >= bpp ? row[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = x >= bpp && prev ? prev[x - bpp] : 0;
    let sub;
    if (type === 0) sub = 0;
    else if (type === 1) sub = a;
    else if (type === 2) sub = b;
    else if (type === 3) sub = (a + b) >> 1;
    else sub = paeth(a, b, c);
    out[x] = (row[x] - sub) & 0xff;
  }
  return out;
}

/**
 * Build a PNG. `samples` is the flat, unfiltered sample buffer (big-endian pairs
 * when bitDepth is 16). `filters` picks the row filter per scanline, cycling.
 */
function makePng({
  width,
  height,
  bitDepth = 8,
  colorType = 6,
  samples,
  filters = [0],
  interlace = 0,
  idatParts = 1,
  extra = [],
}) {
  const channels = CHANNELS[colorType];
  const rowBytes = Math.ceil((bitDepth * channels * width) / 8);
  const bpp = Math.ceil((bitDepth * channels) / 8);
  const raw = [];
  let prev = null;
  for (let y = 0; y < height; y++) {
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const f = filters[y % filters.length];
    raw.push(Buffer.from([f]), applyFilter(f, row, prev, bpp));
    prev = row;
  }
  const deflated = zlib.deflateSync(Buffer.concat(raw));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;

  const idats = [];
  const step = Math.ceil(deflated.length / idatParts);
  for (let i = 0; i < deflated.length; i += step) {
    idats.push(chunk("IDAT", deflated.subarray(i, i + step)));
  }
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    ...extra,
    ...idats,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Read a PNG back, verifying every chunk CRC on the way through. */
function readPng(buf) {
  assert.ok(buf.subarray(0, 8).equals(SIG), "output is not a PNG");
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const stored = buf.readUInt32BE(pos + 8 + len);
    assert.equal(
      crc32(buf.subarray(pos + 4, pos + 8 + len)),
      stored,
      `bad CRC on ${type} chunk`,
    );
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    }
    if (type === "IDAT") idat.push(data);
    pos += len + 12;
    if (type === "IEND") break;
  }
  assert.ok(header, "no IHDR");
  const channels = CHANNELS[header.colorType];
  const rowBytes = Math.ceil((header.bitDepth * channels * header.width) / 8);
  const bpp = Math.ceil((header.bitDepth * channels) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(rowBytes * header.height);
  let p = 0;
  for (let y = 0; y < header.height; y++) {
    const f = raw[p++];
    for (let x = 0; x < rowBytes; x++) {
      const o = y * rowBytes + x;
      const a = x >= bpp ? out[o - bpp] : 0;
      const b = y > 0 ? out[o - rowBytes] : 0;
      const c = x >= bpp && y > 0 ? out[o - rowBytes - bpp] : 0;
      let add;
      if (f === 0) add = 0;
      else if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) add = paeth(a, b, c);
      else throw new Error(`unknown filter ${f}`);
      out[o] = (raw[p + x] + add) & 0xff;
    }
    p += rowBytes;
  }
  return { header, samples: out };
}

// Deterministic pseudo-random content, so the row filters have real work to do.
function noise(length, seed = 1) {
  const out = Buffer.alloc(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

/**
 * Reference un-premultiply, written independently of the codec: colour divided
 * by alpha, clamped, with alpha 0 and full alpha left alone. `alphaAt` is the
 * index of the alpha sample within a pixel, or -1 for no alpha.
 */
function straight8(samples, channels, alphaAt) {
  const out = Buffer.from(samples);
  if (alphaAt < 0) return out;
  for (let p = 0; p < samples.length / channels; p++) {
    const a = samples[p * channels + alphaAt];
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < channels; c++) {
      if (c === alphaAt) continue;
      out[p * channels + c] = Math.min(255, Math.round((samples[p * channels + c] * 255) / a));
    }
  }
  return out;
}

/** The same at 16 bits, then narrowed by the high byte. */
function straight16to8(data16, channels, alphaAt) {
  const n = data16.length / 2;
  const out = Buffer.alloc(n);
  for (let p = 0; p < n / channels; p++) {
    const a = alphaAt < 0 ? 65535 : data16.readUInt16BE((p * channels + alphaAt) * 2);
    for (let c = 0; c < channels; c++) {
      const v = data16.readUInt16BE((p * channels + c) * 2);
      out[p * channels + c] = c === alphaAt || a === 0 || a === 65535
        ? v >> 8
        : Math.min(65535, Math.round((v * 65535) / a)) >> 8;
    }
  }
  return out;
}

const ALPHA_AT = { 0: -1, 2: -1, 4: 1, 6: 3 };

/** Force every alpha sample to 0 or 255, so nothing needs un-premultiplying. */
function binaryAlpha(samples, channels = 4) {
  for (let i = channels - 1; i < samples.length; i += channels) samples[i] = samples[i] & 0x80 ? 255 : 0;
  return samples;
}

/** The 8-bit samples a 16-bit buffer must narrow to: the high byte of each pair. */
function highBytes(data16) {
  const out = Buffer.alloc(data16.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data16[i * 2];
  return out;
}

const W = 7;
const H = 5;
const ALL_FILTERS = [0, 1, 2, 3, 4];

// ---------------------------------------------------------------------------
// 8-bit input is passed through untouched.
// ---------------------------------------------------------------------------
check("8-bit RGBA with no partial alpha passes through byte-for-byte", () => {
  const samples = binaryAlpha(noise(W * H * 4, 7));
  // Guarantee a non-zero alpha so the frame is not read as empty.
  samples[3] = 0xff;
  const png = makePng({ width: W, height: H, samples, filters: ALL_FILTERS });
  const r = normalizePng(png);
  assert.equal(r.converted, false, "an 8-bit frame must not be re-encoded");
  assert.ok(r.buffer.equals(png), "the bytes handed back are not the bytes given");
  assert.equal(r.decoded, true);
  assert.equal(r.bitDepth, 8);
  assert.equal(r.passthrough, null);
  assert.equal(r.hashBasis, "pixels");
  assert.ok(r.hashInput.equals(samples), "decoded samples do not match the source");
  assert.equal(r.unpremultiplied, false);
  assert.ok(r.pixels.equals(samples), "pixels of an opaque/clear frame must be the source");
  assert.equal(r.width, W);
  assert.equal(r.height, H);
});

check("8-bit RGB (no alpha) is never reported empty, even when all zero", () => {
  const samples = Buffer.alloc(W * H * 3, 0);
  const png = makePng({ width: W, height: H, colorType: 2, samples, filters: [4] });
  const r = normalizePng(png);
  assert.equal(r.empty, false, "a colour type with no alpha cannot be transparent");
  assert.equal(r.converted, false);
  assert.ok(r.buffer.equals(png));
});

// ---------------------------------------------------------------------------
// 16-bit input is converted, and the pixels survive.
// ---------------------------------------------------------------------------
for (const colorType of [0, 2, 4, 6]) {
  check(`16-bit colour type ${colorType} converts to 8-bit`, () => {
    const channels = CHANNELS[colorType];
    const samples = noise(W * H * channels * 2, 11 + colorType);
    if (colorType === 4 || colorType === 6) {
      // Force a visible pixel so this is a conversion test, not an empty-frame one.
      samples[(channels - 1) * 2] = 0xff;
    }
    const png = makePng({
      width: W,
      height: H,
      bitDepth: 16,
      colorType,
      samples,
      filters: ALL_FILTERS,
    });
    const r = normalizePng(png);
    assert.equal(r.converted, true, "a 16-bit frame must be re-encoded");
    assert.equal(r.bitDepth, 16, "bitDepth reports the source depth");
    assert.equal(r.decoded, true);
    assert.equal(r.empty, false);

    // The hash is of the samples as written; the image is straight alpha.
    assert.ok(r.hashInput.equals(highBytes(samples)), "narrowed samples are wrong");
    const expected = straight16to8(samples, channels, ALPHA_AT[colorType]);
    assert.ok(r.pixels.equals(expected), "pixels must be what the re-encoded file holds");

    const out = readPng(r.buffer);
    assert.equal(out.header.bitDepth, 8, "output is not 8 bits per channel");
    assert.equal(out.header.colorType, colorType, "colour type must not change");
    assert.equal(out.header.interlace, 0);
    assert.equal(out.header.compression, 0);
    assert.equal(out.header.filter, 0);
    assert.equal(out.header.width, W);
    assert.equal(out.header.height, H);
    assert.ok(out.samples.equals(expected), "re-encoded pixels do not match");
  });
}

check("a 16-bit value that came from 8 bits narrows back exactly", () => {
  // 8-bit -> 16-bit promotion multiplies by 257 (0x7f -> 0x7f7f); taking the
  // high byte has to invert that without drift, or every screenshot of an
  // 8-bit source rendered in a 16-bit project would shift tone.
  const eight = binaryAlpha(noise(W * H * 4, 23));
  eight[3] = 0xff;
  const sixteen = Buffer.alloc(eight.length * 2);
  for (let i = 0; i < eight.length; i++) {
    sixteen.writeUInt16BE(eight[i] * 257, i * 2);
  }
  const png = makePng({
    width: W,
    height: H,
    bitDepth: 16,
    samples: sixteen,
    filters: ALL_FILTERS,
  });
  const r = normalizePng(png);
  assert.ok(r.hashInput.equals(eight), "16-bit round trip of an 8-bit source drifted");
  assert.ok(readPng(r.buffer).samples.equals(eight));
});

check("a converted opaque frame re-normalises as an untouched 8-bit frame", () => {
  // Opaque only: with partial alpha the normaliser is deliberately *not*
  // idempotent — it un-premultiplies, and must run once, on AE's file.
  const samples = noise(W * H * 4 * 2, 31);
  for (let i = 0; i < W * H; i++) { samples[i * 8 + 6] = 0xff; samples[i * 8 + 7] = 0xff; }
  const first = normalizePng(
    makePng({ width: W, height: H, bitDepth: 16, samples, filters: ALL_FILTERS }),
  );
  const second = normalizePng(first.buffer);
  assert.equal(second.converted, false, "the encoder emitted something not already 8-bit");
  assert.equal(second.bitDepth, 8);
  assert.equal(second.passthrough, null);
  assert.ok(second.hashInput.equals(first.hashInput), "a round trip changed the pixels");
});

check("IDAT split across several chunks is reassembled", () => {
  const samples = noise(W * H * 4 * 2, 41);
  samples[7] = 0xff;
  const one = normalizePng(
    makePng({ width: W, height: H, bitDepth: 16, samples, filters: [4], idatParts: 1 }),
  );
  const many = normalizePng(
    makePng({ width: W, height: H, bitDepth: 16, samples, filters: [4], idatParts: 4 }),
  );
  assert.ok(many.hashInput.equals(one.hashInput), "split IDAT decoded differently");
});

// ---------------------------------------------------------------------------
// Empty frames.
// ---------------------------------------------------------------------------
check("a fully transparent 8-bit frame is reported empty and not encoded", () => {
  const samples = noise(W * H * 4, 3);
  for (let i = 0; i < W * H; i++) samples[i * 4 + 3] = 0; // alpha
  const r = normalizePng(makePng({ width: W, height: H, samples, filters: ALL_FILTERS }));
  assert.equal(r.empty, true, "every pixel is transparent but the frame was not flagged");
  assert.equal(r.buffer, null, "an empty frame must not hand back an image to send");
});

check("a fully transparent 16-bit frame is reported empty", () => {
  const samples = noise(W * H * 4 * 2, 5);
  for (let i = 0; i < W * H; i++) {
    samples[i * 8 + 6] = 0;
    samples[i * 8 + 7] = 0;
  }
  const r = normalizePng(
    makePng({ width: W, height: H, bitDepth: 16, samples, filters: ALL_FILTERS }),
  );
  assert.equal(r.empty, true);
  assert.equal(r.buffer, null);
});

check("one opaque pixel is enough to make a frame not empty", () => {
  const samples = Buffer.alloc(W * H * 4, 0);
  samples[(W * H - 1) * 4 + 3] = 1; // last pixel, alpha 1
  const r = normalizePng(makePng({ width: W, height: H, samples, filters: [0] }));
  assert.equal(r.empty, false, "a single non-zero alpha sample must defeat the check");
  assert.ok(r.buffer.length > 0);
});

check("greyscale+alpha uses the right alpha channel", () => {
  const opaque = Buffer.alloc(W * H * 2, 0);
  for (let i = 0; i < W * H; i++) opaque[i * 2 + 1] = 0xff;
  assert.equal(
    normalizePng(makePng({ width: W, height: H, colorType: 4, samples: opaque, filters: [1] })).empty,
    false,
  );
  const clear = Buffer.alloc(W * H * 2, 0);
  for (let i = 0; i < W * H; i++) clear[i * 2] = 0xff; // luminance only
  assert.equal(
    normalizePng(makePng({ width: W, height: H, colorType: 4, samples: clear, filters: [1] })).empty,
    true,
  );
});

// ---------------------------------------------------------------------------
// The content hash the stale-render check compares.
// ---------------------------------------------------------------------------
check("identical pixels hash identically however they were filtered", () => {
  // Binary alpha, so neither file is re-encoded and they stay different files.
  const samples = binaryAlpha(noise(W * H * 4, 13));
  samples[3] = 0xff;
  const a = normalizePng(makePng({ width: W, height: H, samples, filters: [0] }));
  const b = normalizePng(makePng({ width: W, height: H, samples, filters: [4, 3, 2, 1, 0] }));
  assert.ok(a.hashInput.equals(b.hashInput), "the same picture must hash the same");
  assert.ok(!a.buffer.equals(b.buffer), "fixtures were meant to differ as files");
});

check("one changed sample changes the hash input", () => {
  const samples = noise(W * H * 4, 17);
  samples[3] = 0xff;
  const a = normalizePng(makePng({ width: W, height: H, samples, filters: [2] }));
  const altered = Buffer.from(samples);
  altered[10] = altered[10] ^ 0x01;
  const b = normalizePng(makePng({ width: W, height: H, samples: altered, filters: [2] }));
  assert.ok(!a.hashInput.equals(b.hashInput), "a changed pixel must change the hash input");
});

// ---------------------------------------------------------------------------
// Shapes saveFrameToPng does not produce: pass through, do not guess.
// ---------------------------------------------------------------------------
check("indexed colour passes through with the reason recorded", () => {
  const samples = noise(W * H, 19);
  const plte = chunk("PLTE", noise(256 * 3, 21));
  const png = makePng({
    width: W,
    height: H,
    colorType: 3,
    samples,
    filters: [0],
    extra: [plte],
  });
  const r = normalizePng(png);
  assert.equal(r.passthrough, "indexed colour");
  assert.equal(r.decoded, false);
  assert.equal(r.converted, false);
  assert.equal(r.empty, false);
  assert.ok(r.buffer.equals(png));
  assert.equal(r.hashBasis, "idat", "an unread frame still needs something to hash");
  assert.ok(r.hashInput.length > 0);
});

check("interlaced passes through with the reason recorded", () => {
  const samples = noise(W * H * 4, 29);
  const png = makePng({ width: W, height: H, samples, filters: [0], interlace: 1 });
  const r = normalizePng(png);
  assert.equal(r.passthrough, "interlaced");
  assert.equal(r.decoded, false);
  assert.ok(r.buffer.equals(png));
});

check("sub-byte samples pass through with the reason recorded", () => {
  const rowBytes = Math.ceil((4 * 1 * W) / 8);
  const samples = noise(rowBytes * H, 37);
  const png = makePng({
    width: W,
    height: H,
    bitDepth: 4,
    colorType: 0,
    samples,
    filters: [0],
  });
  const r = normalizePng(png);
  assert.equal(r.passthrough, "4-bit samples");
  assert.equal(r.decoded, false);
  assert.ok(r.buffer.equals(png));
});

// ---------------------------------------------------------------------------
// Malformed input throws, so the caller can say the frame was not normalised
// rather than shipping something it silently invented.
// ---------------------------------------------------------------------------
function throwsWith(name, buf, pattern) {
  check(name, () => {
    assert.throws(() => normalizePng(buf), pattern);
  });
}

const good = makePng({
  width: W,
  height: H,
  samples: (() => {
    const s = noise(W * H * 4, 43);
    s[3] = 0xff;
    return s;
  })(),
  filters: [4],
});

throwsWith("a non-PNG buffer", Buffer.from("not an image at all, really"), /not a PNG/);
throwsWith("an empty buffer", Buffer.alloc(0), /not a PNG/);
throwsWith("a truncated file", good.subarray(0, good.length - 20), /truncated PNG/);
throwsWith(
  "a file with no IEND",
  Buffer.concat([good.subarray(0, good.length - 12), Buffer.alloc(0)]),
  /truncated PNG/,
);
throwsWith(
  "a header that is not IHDR",
  Buffer.concat([SIG, chunk("pHYs", Buffer.alloc(9)), good.subarray(8)]),
  /IHDR is not the first chunk/,
);
throwsWith(
  "a zero-sized image",
  makePngZero(),
  /malformed PNG: 0x0/,
);
function makePngZero() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(0, 0);
  ihdr.writeUInt32BE(0, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(0))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
throwsWith("something that is not a Buffer", "definitely not a buffer", /expects a Buffer/);

check("a file with no IDAT throws", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => normalizePng(png), /no IDAT chunk/);
});

check("pixel data shorter than the header claims throws", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(10))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.throws(() => normalizePng(png), /expected/);
});

check("an unknown row filter throws rather than inventing pixels", () => {
  const rowBytes = W * 4;
  const raw = [];
  for (let y = 0; y < H; y++) raw.push(Buffer.from([9]), Buffer.alloc(rowBytes));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.throws(() => normalizePng(png), /unknown PNG row filter 9/);
});

// ---------------------------------------------------------------------------
// A frame at a size worth calling realistic, to prove the conversion holds when
// the buffers are not seven pixels wide.
// ---------------------------------------------------------------------------
check("a 320x180 16-bit frame converts and halves in sample count", () => {
  const w = 320;
  const h = 180;
  const samples = noise(w * h * 4 * 2, 53);
  for (let i = 0; i < w * h; i++) { samples[i * 8 + 6] = 0xff; samples[i * 8 + 7] = 0xff; } // opaque
  const png = makePng({ width: w, height: h, bitDepth: 16, samples, filters: ALL_FILTERS });
  const r = normalizePng(png);
  assert.equal(r.converted, true);
  assert.equal(r.hashInput.length, w * h * 4);
  const out = readPng(r.buffer);
  assert.equal(out.header.bitDepth, 8);
  assert.ok(out.samples.equals(highBytes(samples)));
});

// ---------------------------------------------------------------------------
// Premultiplied -> straight alpha (#130). saveFrameToPng writes colour already
// multiplied by alpha into a format that is straight alpha by definition.
// ---------------------------------------------------------------------------
/** One row of pixels, each [r, g, b, a]. */
function rowOf(pixels) {
  return Buffer.from(pixels.flat());
}
const at = (buf, i) => [...buf.subarray(i * 4, i * 4 + 4)];

check("a premultiplied soft edge comes out straight (#130's own numbers)", () => {
  // The measured edge of a blurred yellow (242,191,25) solid, as AE wrote it.
  const samples = rowOf([
    [38, 30, 4, 40],
    [127, 100, 13, 133],
    [226, 178, 23, 238],
    [242, 191, 25, 255],
  ]);
  const r = normalizePng(makePng({ width: 4, height: 1, samples, filters: [1] }));
  assert.equal(r.unpremultiplied, true);
  assert.equal(r.converted, false, "converted still means bit depth only");
  const out = readPng(r.buffer).samples;
  assert.ok(out.equals(r.pixels), "`pixels` must be exactly what the file decodes to");
  // Every edge pixel is now the solid's colour to within the 8-bit rounding of
  // the premultiplied source — no olive fringe.
  for (let i = 0; i < 3; i++) {
    const [cr, cg, cb] = at(out, i);
    assert.ok(Math.abs(cr - 242) <= 4 && Math.abs(cg - 191) <= 4 && Math.abs(cb - 25) <= 4,
      `edge pixel ${i} is ${at(out, i)}, not the solid's colour`);
  }
  assert.deepEqual(at(out, 3), [242, 191, 25, 255]);
  assert.deepEqual([at(out, 0)[3], at(out, 1)[3], at(out, 2)[3]], [40, 133, 238], "alpha must not change");
});

check("alpha 0 and alpha 255 are left exactly alone", () => {
  const samples = rowOf([
    [9, 8, 7, 0], // invisible: colour undefined, not divided
    [200, 100, 50, 255],
    [10, 20, 30, 128], // the one that changes
  ]);
  const r = normalizePng(makePng({ width: 3, height: 1, samples, filters: [0] }));
  const out = readPng(r.buffer).samples;
  assert.deepEqual(at(out, 0), [9, 8, 7, 0]);
  assert.deepEqual(at(out, 1), [200, 100, 50, 255]);
  assert.deepEqual(at(out, 2), [20, 40, 60, 128]);
});

check("colour above its alpha clamps to 255 instead of wrapping", () => {
  const samples = rowOf([[200, 255, 3, 100], [255, 255, 255, 1]]);
  const r = normalizePng(makePng({ width: 2, height: 1, samples, filters: [0] }));
  const out = readPng(r.buffer).samples;
  assert.deepEqual(at(out, 0), [255, 255, 8, 100]);
  assert.deepEqual(at(out, 1), [255, 255, 255, 1]);
});

check("8-bit noise matches the reference un-premultiply sample for sample", () => {
  for (const colorType of [4, 6]) {
    const ch = CHANNELS[colorType];
    const samples = noise(W * H * ch, 61 + colorType);
    samples[ch - 1] = 0x80;
    const r = normalizePng(makePng({ width: W, height: H, colorType, samples, filters: ALL_FILTERS }));
    const expected = straight8(samples, ch, ALPHA_AT[colorType]);
    assert.ok(r.pixels.equals(expected), `colour type ${colorType}: pixels differ from the reference`);
    assert.ok(readPng(r.buffer).samples.equals(expected), `colour type ${colorType}: file differs`);
    assert.ok(r.hashInput.equals(samples), "the hash input must be the samples as written");
  }
});

check("16-bit input is un-premultiplied at full precision, before narrowing", () => {
  // A dim edge: 16-bit alpha 300 (8-bit 1), green 300 (8-bit 1), red 150 (8-bit
  // 0). Divided at 16 bits red is half intensity; narrowed first it would be
  // 0 / 1 -> black, and green 1 / 1 -> full.
  const px = Buffer.alloc(8 * 2);
  const set = (p, rgba) => rgba.forEach((v, c) => px.writeUInt16BE(v, (p * 4 + c) * 2));
  set(0, [150, 300, 0, 300]);
  set(1, [0x4000, 0x8000, 0x0100, 0x8000]); // half alpha, premultiplied
  const r = normalizePng(makePng({ width: 2, height: 1, bitDepth: 16, samples: px, filters: [0] }));
  assert.equal(r.converted, true);
  assert.equal(r.unpremultiplied, true);
  const out = readPng(r.buffer).samples;
  assert.deepEqual(at(out, 0), [128, 255, 0, 1]);
  assert.deepEqual(at(out, 1), [128, 255, 2, 128]);
  assert.ok(out.equals(straight16to8(px, 4, 3)));
  // The hash is of what AE wrote, narrowed — not of the straightened image.
  assert.ok(r.hashInput.equals(highBytes(px)));
});

check("16-bit alpha 0 and 65535 narrow exactly as before", () => {
  const px = Buffer.alloc(8 * 2);
  const set = (p, rgba) => rgba.forEach((v, c) => px.writeUInt16BE(v, (p * 4 + c) * 2));
  set(0, [0x1234, 0x5678, 0x9abc, 0]);
  set(1, [0x1234, 0x5678, 0x9abc, 0xffff]);
  const r = normalizePng(makePng({ width: 2, height: 1, bitDepth: 16, samples: px, filters: [0] }));
  assert.equal(r.unpremultiplied, false, "nothing was partly transparent");
  assert.ok(readPng(r.buffer).samples.equals(highBytes(px)));
});

check("16-bit colour above its alpha clamps instead of overflowing", () => {
  const px = Buffer.alloc(8);
  [0xffff, 0x9000, 0x0001, 0x8000].forEach((v, c) => px.writeUInt16BE(v, c * 2));
  const r = normalizePng(makePng({ width: 1, height: 1, bitDepth: 16, samples: px, filters: [0] }));
  assert.deepEqual(at(readPng(r.buffer).samples, 0), [255, 255, 0, 128]);
});

check("the hash is of the source samples, so stale detection still holds", () => {
  const samples = noise(W * H * 4, 71);
  samples[3] = 0x40;
  const a = normalizePng(makePng({ width: W, height: H, samples, filters: [0] }));
  const b = normalizePng(makePng({ width: W, height: H, samples, filters: [3, 1] }));
  assert.ok(a.hashInput.equals(samples), "hash input is the source samples");
  assert.ok(a.hashInput.equals(b.hashInput), "the same AE buffer must hash the same");
  assert.ok(!a.pixels.equals(a.hashInput), "fixture was meant to need converting");
  // A change confined to one low-alpha pixel must still change the hash.
  const altered = Buffer.from(samples);
  altered[0] = altered[0] ^ 0x01;
  const c = normalizePng(makePng({ width: W, height: H, samples: altered, filters: [0] }));
  assert.ok(!c.hashInput.equals(a.hashInput));
});

check("empty detection is unaffected: partial alpha anywhere is not empty", () => {
  const samples = Buffer.alloc(W * H * 4, 0);
  samples[5 * 4] = 1;
  samples[5 * 4 + 3] = 2;
  const r = normalizePng(makePng({ width: W, height: H, samples, filters: [0] }));
  assert.equal(r.empty, false);
  assert.equal(r.unpremultiplied, true);
  assert.deepEqual(at(r.pixels, 5), [128, 0, 0, 2]);
});

console.log(`png-codec: ${passed} checks passed`);
