// pngCodec.ts — the server's PNG normaliser.
//
// This is the MCP server's copy of `packages/ae-panel/client/pngcodec.js`
// (issue #220 stage 4: the server now post-processes frames itself). The panel
// keeps its copy for legacy MCP servers that still ask it to, and the two must
// produce identical bytes — tests/unit/image-parity.mjs holds them together.
// Change both or neither.
//
// After Effects writes screenshot frames at the project's colour depth, so a
// 16-bit project produces 16-bit-per-channel PNGs. Plenty of decoders — the ones
// on the far side of an MCP image content block included — reject those outright
// with "Could not process image", so a perfectly good render arrives useless.
// This converts to 8 bits per channel before the server base64-encodes, and
// passes an 8-bit frame through byte-for-byte untouched unless it has partly
// transparent pixels to un-premultiply (below).
//
// It also does the three other things that need the pixels rather than the file:
//
//   * converts premultiplied colour to straight alpha. `saveFrameToPng` writes
//     colour already multiplied by alpha, but PNG is straight (unassociated)
//     alpha by definition, so every decoder composites those edge pixels as if
//     they were darker than they are: blurs, feathers, glows, shadows and
//     anti-aliased edges all grew a dark fringe that is not in the comp, and an
//     agent looking at it may "fix" artwork that is fine. Issue #130. Measured
//     on AE 2026 at both 8 and 16 bits, so it is After Effects' output and not
//     this conversion;
//
//   * reports a frame whose every pixel is fully transparent, because "this
//     frame is empty" is the useful reading of a ~5KB PNG that decoders choke
//     on, and it usually means the caller is looking at the wrong time or a
//     disabled layer;
//   * hands back the decoded samples so the caller can hash them. Two different
//     screenshot requests that produce byte-identical pixels are how a stale
//     render buffer shows itself (see frameCache.ts). The hash is taken from
//     the samples *as After Effects wrote them*, before un-premultiplying: the
//     stale bug is one render buffer served twice, so the buffer is the thing
//     to identify, and un-premultiplying is lossy enough at 16 bits to merge
//     two frames that differ only in a low-alpha edge.
//
// Cost, since it is paid on every screenshot and not only on 16-bit ones: an
// already-8-bit frame is still inflated and un-filtered, because that is the
// only way to know whether it is empty and the only hash that cannot be thrown
// off by an encoder writing the same picture two ways. That is one pass over
// width*height*channels bytes — negligible at the downsample the guides ask
// for, and small next to a render measured in seconds even at full 4K. If it
// ever stops being negligible, note that an empty frame compresses to a few KB,
// so a size threshold could skip the decode and fall back to the IDAT hash.
//
// Node builtins only, matching the panel copy, so the two stay comparable line
// for line.

import zlib from "node:zlib";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Deflate level: the output is a diagnostic image that has to fit in an agent's
// context, so size matters — but a 4K frame is 33MB of samples and level 9 costs
// seconds on top of a render that already took seconds. 6 is within a few
// percent of 9 here and several times faster.
const DEFLATE_LEVEL = 6;

function channelsFor(colorType: number): number {
  if (colorType === 0) return 1; // greyscale
  if (colorType === 2) return 3; // truecolour
  if (colorType === 3) return 1; // indexed
  if (colorType === 4) return 2; // greyscale + alpha
  if (colorType === 6) return 4; // truecolour + alpha
  return 0;
}

export function alphaIndexFor(colorType: number): number {
  if (colorType === 4) return 1;
  if (colorType === 6) return 3;
  return -1;
}

// ---------- CRC-32, as specified in the PNG spec ----------
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 as PNG specifies it. The zip format's CRC-32 is the same one, bit for
 * bit, which is why mogrtThumbnail.ts uses this rather than a second copy.
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- Structural completeness ----------

export interface PngStructure {
  complete: boolean;
  growable: boolean;
  bytes: number;
  lastChunk?: string;
  reason: string | null;
  trailingBytes?: number;
}

/**
 * Is this byte range a whole PNG file yet?
 *
 * Answered by walking the chunk table alone — no inflate, no pixels — because
 * the caller is asking about a file After Effects may still be writing, and the
 * question has to be cheap enough to ask repeatedly.
 *
 * It exists because "the file stopped growing" was never the same statement as
 * "the file is finished". `saveFrameToPng` returns before the bytes are on disk,
 * and the panel used to accept a frame the moment two `stat` calls 30ms apart
 * reported the same size. A writer that pauses for 30ms — which on a heavy comp
 * it routinely does — was read mid-flight and shipped, and the agent got
 * `truncated PNG: chunk IDAT runs past the end of the file` for a render that
 * was merely still happening. Issue #45.
 *
 * `growable` matters as much as `complete`: it separates "not finished yet,
 * keep waiting" from "no number of further bytes can make this a PNG, stop
 * now". A truncated chunk is the first; a wrong signature or a missing IHDR is
 * the second, and waiting out a 120s render budget for one of those only turns
 * a precise diagnosis into a timeout.
 *
 * Returns { complete, growable, reason, bytes, lastChunk, trailingBytes }.
 */
export function inspectPngStructure(buf: Buffer): PngStructure {
  const n = buf.length;
  const prefix = n < SIGNATURE.length ? n : SIGNATURE.length;
  for (let i = 0; i < prefix; i++) {
    if (buf[i] !== SIGNATURE[i]) {
      return {
        complete: false,
        growable: false,
        bytes: n,
        reason: "not a PNG: signature mismatch at byte " + i,
      };
    }
  }
  if (n < SIGNATURE.length) {
    return {
      complete: false,
      growable: true,
      bytes: n,
      reason: "only " + n + " of the 8 signature bytes are on disk",
    };
  }

  let pos = SIGNATURE.length;
  let first = true;
  while (true) {
    if (pos + 8 > n) {
      return {
        complete: false,
        growable: true,
        bytes: n,
        reason: "the chunk header at byte " + pos + " is incomplete",
      };
    }
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return {
        complete: false,
        growable: false,
        bytes: n,
        reason: "the chunk type at byte " + pos + " is not four letters",
      };
    }
    // The format caps a chunk at 2^31-1. A larger figure is garbage, not a
    // chunk still arriving, and calling it growable would spend the whole
    // render budget waiting for a file that is already wrong.
    if (len > 0x7fffffff) {
      return {
        complete: false,
        growable: false,
        bytes: n,
        lastChunk: type,
        reason: "chunk " + type + " declares " + len + " bytes, past the format's limit",
      };
    }
    if (first && type !== "IHDR") {
      return {
        complete: false,
        growable: false,
        bytes: n,
        lastChunk: type,
        reason: "malformed PNG: the first chunk is " + type + ", not IHDR",
      };
    }
    first = false;
    const end = pos + 8 + len + 4;
    if (end > n) {
      return {
        complete: false,
        growable: true,
        bytes: n,
        lastChunk: type,
        reason: "chunk " + type + " declares " + len + " bytes and " +
          Math.max(0, n - pos - 8) + " of them are on disk",
      };
    }
    if (type === "IEND") {
      return {
        complete: true,
        growable: false,
        bytes: n,
        lastChunk: "IEND",
        reason: null,
        trailingBytes: n - end,
      };
    }
    pos = end;
  }
}

// ---------- Reading ----------

interface PngChunk {
  type: string;
  data: Buffer;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
}

function readChunks(buf: Buffer): PngChunk[] {
  if (buf.length < 8) throw new Error("not a PNG: only " + buf.length + " bytes");
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error("not a PNG: signature mismatch at byte " + i);
  }
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) {
      throw new Error("truncated PNG: chunk " + type + " runs past the end of the file");
    }
    chunks.push({ type: type, data: buf.subarray(dataStart, dataEnd) });
    pos = dataEnd + 4;
    if (type === "IEND") return chunks;
  }
  throw new Error("truncated PNG: no IEND chunk");
}

function parseHeader(chunks: PngChunk[]): PngHeader {
  if (!chunks.length || chunks[0].type !== "IHDR") {
    throw new Error("malformed PNG: IHDR is not the first chunk");
  }
  const d = chunks[0].data;
  if (d.length !== 13) throw new Error("malformed PNG: IHDR is " + d.length + " bytes, expected 13");
  const h: PngHeader = {
    width: d.readUInt32BE(0),
    height: d.readUInt32BE(4),
    bitDepth: d[8],
    colorType: d[9],
    compression: d[10],
    filter: d[11],
    interlace: d[12],
  };
  if (h.width === 0 || h.height === 0) {
    throw new Error("malformed PNG: " + h.width + "x" + h.height);
  }
  return h;
}

// ---------- Filtering ----------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverse the per-scanline filters into a flat sample buffer. `raw` is the
// inflated IDAT stream: one filter-type byte followed by rowBytes of data, per
// row. Every filter reads back from bytes already reconstructed, so this has to
// run in order and read out of `out` rather than out of `raw`.
function unfilter(
  raw: Buffer,
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
): { data: Buffer; rowBytes: number; bpp: number } {
  const bpp = Math.ceil((bitDepth * channels) / 8);
  const rowBytes = Math.ceil((bitDepth * channels * width) / 8);
  const expected = (rowBytes + 1) * height;
  if (raw.length < expected) {
    throw new Error("PNG pixel data is " + raw.length + " bytes, expected " + expected);
  }
  const out = Buffer.alloc(rowBytes * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos];
    pos += 1;
    const o = y * rowBytes;
    const up = o - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const cur = raw[pos + x];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = (x >= bpp && y > 0) ? out[up + x - bpp] : 0;
      let v: number;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else if (filter === 4) v = cur + paeth(a, b, c);
      else throw new Error("unknown PNG row filter " + filter + " on row " + y);
      out[o + x] = v & 0xff;
    }
    pos += rowBytes;
  }
  return { data: out, rowBytes: rowBytes, bpp: bpp };
}

// Re-apply a filter on the way out. Paeth on every row rather than picking the
// cheapest of the five per row: one pass instead of five, and on rendered frames
// it is within a few percent of the best choice.
function filterRowsPaeth(data: Buffer, height: number, rowBytes: number, bpp: number): Buffer {
  const out = Buffer.alloc((rowBytes + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    out[pos] = 4;
    pos += 1;
    const o = y * rowBytes;
    const up = o - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? data[o + x - bpp] : 0;
      const b = y > 0 ? data[up + x] : 0;
      const c = (x >= bpp && y > 0) ? data[up + x - bpp] : 0;
      out[pos + x] = (data[o + x] - paeth(a, b, c)) & 0xff;
    }
    pos += rowBytes;
  }
  return out;
}

// ---------- Writing ----------
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Emit an 8-bit PNG from flat samples. Ancillary chunks from the source are
 * deliberately not carried over: the ones that would matter (tRNS, sBIT, bKGD)
 * hold bit-depth-dependent values that would be wrong at 8 bits, and the rest
 * describe colour intent that no decoder of a diagnostic screenshot acts on.
 */
export function encodePng8(width: number, height: number, colorType: number, data8: Buffer): Buffer {
  const channels = channelsFor(colorType);
  if (channels === 0) throw new Error("cannot encode PNG colour type " + colorType);
  const rowBytes = width * channels;
  if (data8.length < rowBytes * height) {
    throw new Error("sample buffer is " + data8.length + " bytes, expected " + rowBytes * height);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const idat = zlib.deflateSync(filterRowsPaeth(data8, height, rowBytes, channels), {
    level: DEFLATE_LEVEL,
  });
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 16-bit samples are big-endian pairs, and the high byte *is* the 8-bit value:
// promoting 8-bit to 16-bit multiplies by 257 (0x7f -> 0x7f7f), so taking the
// high byte is exact for anything that started life at 8 bits and off by at most
// 1/255 for anything that did not. Rounding through /257 would cost a divide per
// sample and change nothing anybody looking at a screenshot could see.
function narrow16to8(data16: Buffer, sampleCount: number): Buffer {
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) out[i] = data16[i * 2];
  return out;
}

// ---------- Premultiplied -> straight alpha ----------
//
// The colour channels of a premultiplied pixel are c = straight * a, so the
// inverse is straight = c / a — at 8 bits, round(c * 255 / a). Three cases are
// left exactly as they are:
//
//   * a = 0: the colour of an invisible pixel is undefined after division, and
//     every decoder ignores it anyway;
//   * a = max: dividing by one changes nothing, and skipping it keeps an opaque
//     frame byte-identical to the file After Effects wrote;
//   * a colour type with no alpha channel at all.
//
// A colour above its alpha is not valid premultiplied data, but a filter can
// produce one and the division must not overflow the sample, so it clamps.

/**
 * Un-premultiply 8-bit samples. Returns `data` itself when no pixel needed it
 * (opaque or fully clear everywhere), and a new buffer otherwise, so the caller
 * can keep the source samples for hashing and can tell whether to re-encode.
 *
 * Exported for mogrtThumbnail.ts and the contact-sheet fallback, both of which
 * hold premultiplied samples from decodePng8 and must convert them exactly once.
 */
export function unpremultiply8(data: Buffer, channels: number, alphaIndex: number, pixelCount: number): Buffer {
  if (alphaIndex < 0) return data;
  let out: Buffer | null = null;
  for (let p = 0; p < pixelCount; p++) {
    const base = p * channels;
    const a = data[base + alphaIndex];
    if (a === 0 || a === 255) continue;
    if (out === null) out = Buffer.from(data);
    for (let c = 0; c < channels; c++) {
      if (c === alphaIndex) continue;
      const v = Math.round((data[base + c] * 255) / a);
      out[base + c] = v > 255 ? 255 : v;
    }
  }
  return out === null ? data : out;
}

/**
 * Un-premultiply 16-bit samples at full precision, then narrow to 8 bits by the
 * same high-byte rule as `narrow16to8`. Dividing before narrowing is the point:
 * a pixel at 16-bit alpha 300 has a colour of one or two 8-bit steps, and
 * dividing that by alpha 1 would turn it into noise, where the 16-bit sample
 * still holds the real colour.
 */
function unpremultiplyNarrow16(data16: Buffer, channels: number, alphaIndex: number, pixelCount: number): Buffer {
  const out = Buffer.alloc(pixelCount * channels);
  for (let p = 0; p < pixelCount; p++) {
    const base = p * channels;
    const a = alphaIndex < 0 ? 65535 : data16.readUInt16BE((base + alphaIndex) * 2);
    const straight = a !== 0 && a !== 65535;
    for (let c = 0; c < channels; c++) {
      const i = (base + c) * 2;
      if (!straight || c === alphaIndex) {
        out[base + c] = data16[i];
        continue;
      }
      const v = Math.round((data16.readUInt16BE(i) * 65535) / a);
      out[base + c] = (v > 65535 ? 65535 : v) >> 8;
    }
  }
  return out;
}

function everyPixelTransparent(data8: Buffer, channels: number, alphaIndex: number, pixelCount: number): boolean {
  for (let i = 0; i < pixelCount; i++) {
    if (data8[i * channels + alphaIndex] !== 0) return false;
  }
  return true;
}

export interface NormalizedPng {
  /** The PNG to send, or null when `empty`. */
  buffer: Buffer | null;
  width: number;
  height: number;
  /** Of the *source*, before any conversion. */
  bitDepth: number;
  colorType: number;
  /** Samples per pixel. */
  channels: number;
  converted: boolean;
  unpremultiplied: boolean;
  decoded: boolean;
  empty: boolean;
  /** 8-bit straight-alpha samples, or null when the pixels were not decoded. */
  pixels: Buffer | null;
  hashInput: Buffer;
  hashBasis: "pixels" | "idat";
  passthrough: string | null;
}

/**
 * Normalise one PNG for delivery to an agent.
 *
 * Returns:
 *   buffer        the PNG to send, or null when `empty` — an empty frame is
 *                 reported, never shipped, so there is nothing to hand out
 *   width/height  from IHDR, so they can never disagree with the pixels
 *   bitDepth      of the *source*, before any conversion
 *   converted     true when the bytes were re-encoded from 16-bit
 *   unpremultiplied
 *                 true when at least one pixel was partly transparent, so its
 *                 colour was divided out of premultiplied form and the 8-bit
 *                 file had to be re-encoded too
 *   channels      samples per pixel, for a caller that composites `pixels`
 *   decoded       true when the pixels were actually interpreted
 *   empty         true when every pixel is fully transparent
 *   pixels        8-bit straight-alpha samples — exactly what `buffer` decodes
 *                 to, so a caller tiling them must not un-premultiply again.
 *                 Null when the pixels were not decoded.
 *   hashInput     bytes to hash for the stale-render check: the 8-bit samples
 *                 as After Effects wrote them, *before* un-premultiplying
 *   hashBasis     "pixels" when hashInput is decoded samples, "idat" when it is
 *                 the compressed stream (metadata-free either way, so an
 *                 embedded timestamp can never make two identical frames differ)
 *   passthrough   why the pixels were not inspected, or null
 *
 * Throws on anything that is not a readable PNG. The caller is expected to treat
 * that as "could not normalise", not as "the screenshot failed" — the render did
 * happen, and shipping it unconverted with a warning beats discarding it.
 */
export function normalizePng(buf: Buffer): NormalizedPng {
  if (!Buffer.isBuffer(buf)) throw new Error("normalizePng expects a Buffer");
  const chunks = readChunks(buf);
  const h = parseHeader(chunks);

  const idatParts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].type === "IDAT") idatParts.push(chunks[i].data);
  }
  if (!idatParts.length) throw new Error("malformed PNG: no IDAT chunk");
  const idat = Buffer.concat(idatParts);

  const channels = channelsFor(h.colorType);
  const result: NormalizedPng = {
    buffer: buf,
    width: h.width,
    height: h.height,
    bitDepth: h.bitDepth,
    colorType: h.colorType,
    // Samples per pixel, so a caller compositing `hashInput` into a contact
    // sheet does not have to re-derive it from the colour type.
    channels: channels,
    converted: false,
    unpremultiplied: false,
    decoded: false,
    empty: false,
    pixels: null,
    hashInput: idat,
    hashBasis: "idat",
    passthrough: null,
  };

  if (h.compression !== 0 || h.filter !== 0) {
    throw new Error("unsupported PNG: compression " + h.compression + ", filter method " + h.filter);
  }
  if (channels === 0) throw new Error("unsupported PNG colour type " + h.colorType);

  // Adam7 interlacing, palettes and sub-byte samples all need machinery that
  // would be written blind for a case saveFrameToPng does not produce. Pass the
  // file through untouched and record why the pixels were not read, rather than
  // guessing at them — the stale check still works off the IDAT bytes.
  if (h.interlace !== 0) {
    result.passthrough = "interlaced";
    return result;
  }
  if (h.colorType === 3) {
    result.passthrough = "indexed colour";
    return result;
  }
  if (h.bitDepth !== 8 && h.bitDepth !== 16) {
    result.passthrough = h.bitDepth + "-bit samples";
    return result;
  }

  const pixelCount = h.width * h.height;
  const un = unfilter(zlib.inflateSync(idat), h.width, h.height, h.bitDepth, channels);
  const source8 = h.bitDepth === 16
    ? narrow16to8(un.data, pixelCount * channels)
    : un.data;

  result.decoded = true;
  result.hashInput = source8;
  result.hashBasis = "pixels";

  const alphaIndex = alphaIndexFor(h.colorType);
  // Alpha is never touched by un-premultiplying, so this reads the same either
  // side of it — and running it first skips the division for an empty frame.
  if (alphaIndex >= 0 && everyPixelTransparent(source8, channels, alphaIndex, pixelCount)) {
    // Nothing to send, so nothing is encoded — and `buffer: null` makes it
    // impossible for a caller to ship the frame by forgetting to check `empty`.
    result.empty = true;
    result.buffer = null;
    return result;
  }

  let straight: Buffer;
  if (h.bitDepth === 16) {
    straight = alphaIndex >= 0
      ? unpremultiplyNarrow16(un.data, channels, alphaIndex, pixelCount)
      : source8;
    result.unpremultiplied = alphaIndex >= 0 && !straight.equals(source8);
  } else {
    straight = unpremultiply8(source8, channels, alphaIndex, pixelCount);
    result.unpremultiplied = straight !== source8;
  }
  result.pixels = straight;

  if (h.bitDepth === 16) {
    result.buffer = encodePng8(h.width, h.height, h.colorType, straight);
    result.converted = true;
  } else if (result.unpremultiplied) {
    result.buffer = encodePng8(h.width, h.height, h.colorType, straight);
  }
  return result;
}

export interface DecodedPng8 {
  width: number;
  height: number;
  colorType: number;
  channels: number;
  /** The source's, before narrowing. */
  bitDepth: number;
  /** width*height*channels bytes, as stored — no alpha interpretation. */
  pixels: Buffer;
}

/**
 * Decode a PNG to flat 8-bit samples.
 *
 * `normalizePng` deliberately passes the awkward encodings through untouched,
 * because a screenshot it cannot read is still a screenshot the client might.
 * A caller that is going to *resample* the pixels has no such fallback — half a
 * decode is not a smaller picture, it is a wrong one — so this throws on
 * anything it cannot interpret exactly.
 *
 * Returns { width, height, colorType, channels, bitDepth, pixels }, where
 * `pixels` is width*height*channels bytes and `bitDepth` is the source's.
 *
 * The samples are returned as stored: no alpha interpretation at all. A frame
 * straight from `saveFrameToPng` therefore comes back *premultiplied* — which
 * is what a resampler wants, since averaging premultiplied samples is the
 * alpha-weighted average — and it is the caller's job to `unpremultiply8`
 * exactly once before encoding. See mogrtThumbnail.ts.
 */
export function decodePng8(buf: Buffer): DecodedPng8 {
  if (!Buffer.isBuffer(buf)) throw new Error("decodePng8 expects a Buffer");
  const chunks = readChunks(buf);
  const h = parseHeader(chunks);
  const channels = channelsFor(h.colorType);

  if (h.compression !== 0 || h.filter !== 0) {
    throw new Error("unsupported PNG: compression " + h.compression + ", filter method " + h.filter);
  }
  if (channels === 0) throw new Error("unsupported PNG colour type " + h.colorType);
  if (h.interlace !== 0) throw new Error("unsupported PNG: interlaced");
  if (h.colorType === 3) throw new Error("unsupported PNG: indexed colour");
  if (h.bitDepth !== 8 && h.bitDepth !== 16) throw new Error("unsupported PNG: " + h.bitDepth + "-bit samples");

  const idatParts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].type === "IDAT") idatParts.push(chunks[i].data);
  }
  if (!idatParts.length) throw new Error("malformed PNG: no IDAT chunk");

  const un = unfilter(zlib.inflateSync(Buffer.concat(idatParts)), h.width, h.height, h.bitDepth, channels);
  const pixels = h.bitDepth === 16 ? narrow16to8(un.data, h.width * h.height * channels) : un.data;

  return {
    width: h.width,
    height: h.height,
    colorType: h.colorType,
    channels: channels,
    bitDepth: h.bitDepth,
    pixels: pixels,
  };
}
