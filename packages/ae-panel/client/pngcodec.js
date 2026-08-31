// pngcodec.js — the panel's PNG normaliser.
//
// After Effects writes screenshot frames at the project's colour depth, so a
// 16-bit project produces 16-bit-per-channel PNGs. Plenty of decoders — the ones
// on the far side of an MCP image content block included — reject those outright
// with "Could not process image", so a perfectly good render arrives useless.
// This converts to 8 bits per channel before the panel base64-encodes, and
// passes anything already 8-bit through byte-for-byte untouched.
//
// It also does the two other things that need the pixels rather than the file:
//
//   * reports a frame whose every pixel is fully transparent, because "this
//     frame is empty" is the useful reading of a ~5KB PNG that decoders choke
//     on, and it usually means the caller is looking at the wrong time or a
//     disabled layer;
//   * hands back the decoded samples so the caller can hash them. Two different
//     screenshot requests that produce byte-identical pixels are how a stale
//     render buffer shows itself (see framecache.js).
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
// A CommonJS module on purpose: `client/main.js` requires it inside CEP's mixed
// context, and `tests/unit/png-codec.mjs` requires the same file under plain
// Node. There is no After Effects on a CI runner and this is real image code, so
// it has to be exercisable without one. Node builtins only — adding a runtime
// dependency here would mean shipping another directory into the CEP extension,
// which is exactly the problem `ws` already causes.

"use strict";

var zlib = require("zlib");

var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Deflate level: the output is a diagnostic image that has to fit in an agent's
// context, so size matters — but a 4K frame is 33MB of samples and level 9 costs
// seconds on top of a render that already took seconds. 6 is within a few
// percent of 9 here and several times faster.
var DEFLATE_LEVEL = 6;

function channelsFor(colorType) {
  if (colorType === 0) return 1; // greyscale
  if (colorType === 2) return 3; // truecolour
  if (colorType === 3) return 1; // indexed
  if (colorType === 4) return 2; // greyscale + alpha
  if (colorType === 6) return 4; // truecolour + alpha
  return 0;
}

function alphaIndexFor(colorType) {
  if (colorType === 4) return 1;
  if (colorType === 6) return 3;
  return -1;
}

// ---------- CRC-32, as specified in the PNG spec ----------
var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  var c = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- Structural completeness ----------
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
function inspectPngStructure(buf) {
  var n = buf.length;
  var prefix = n < SIGNATURE.length ? n : SIGNATURE.length;
  for (var i = 0; i < prefix; i++) {
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

  var pos = SIGNATURE.length;
  var first = true;
  while (true) {
    if (pos + 8 > n) {
      return {
        complete: false,
        growable: true,
        bytes: n,
        reason: "the chunk header at byte " + pos + " is incomplete",
      };
    }
    var len = buf.readUInt32BE(pos);
    var type = buf.toString("ascii", pos + 4, pos + 8);
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
    var end = pos + 8 + len + 4;
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
function readChunks(buf) {
  if (buf.length < 8) throw new Error("not a PNG: only " + buf.length + " bytes");
  for (var i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error("not a PNG: signature mismatch at byte " + i);
  }
  var chunks = [];
  var pos = 8;
  while (pos + 8 <= buf.length) {
    var len = buf.readUInt32BE(pos);
    var type = buf.toString("ascii", pos + 4, pos + 8);
    var dataStart = pos + 8;
    var dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) {
      throw new Error("truncated PNG: chunk " + type + " runs past the end of the file");
    }
    chunks.push({ type: type, data: buf.subarray(dataStart, dataEnd) });
    pos = dataEnd + 4;
    if (type === "IEND") return chunks;
  }
  throw new Error("truncated PNG: no IEND chunk");
}

function parseHeader(chunks) {
  if (!chunks.length || chunks[0].type !== "IHDR") {
    throw new Error("malformed PNG: IHDR is not the first chunk");
  }
  var d = chunks[0].data;
  if (d.length !== 13) throw new Error("malformed PNG: IHDR is " + d.length + " bytes, expected 13");
  var h = {
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
function paeth(a, b, c) {
  var p = a + b - c;
  var pa = p > a ? p - a : a - p;
  var pb = p > b ? p - b : b - p;
  var pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverse the per-scanline filters into a flat sample buffer. `raw` is the
// inflated IDAT stream: one filter-type byte followed by rowBytes of data, per
// row. Every filter reads back from bytes already reconstructed, so this has to
// run in order and read out of `out` rather than out of `raw`.
function unfilter(raw, width, height, bitDepth, channels) {
  var bpp = Math.ceil((bitDepth * channels) / 8);
  var rowBytes = Math.ceil((bitDepth * channels * width) / 8);
  var expected = (rowBytes + 1) * height;
  if (raw.length < expected) {
    throw new Error("PNG pixel data is " + raw.length + " bytes, expected " + expected);
  }
  var out = Buffer.alloc(rowBytes * height);
  var pos = 0;
  for (var y = 0; y < height; y++) {
    var filter = raw[pos];
    pos += 1;
    var o = y * rowBytes;
    var up = o - rowBytes;
    for (var x = 0; x < rowBytes; x++) {
      var cur = raw[pos + x];
      var a = x >= bpp ? out[o + x - bpp] : 0;
      var b = y > 0 ? out[up + x] : 0;
      var c = (x >= bpp && y > 0) ? out[up + x - bpp] : 0;
      var v;
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
function filterRowsPaeth(data, height, rowBytes, bpp) {
  var out = Buffer.alloc((rowBytes + 1) * height);
  var pos = 0;
  for (var y = 0; y < height; y++) {
    out[pos] = 4;
    pos += 1;
    var o = y * rowBytes;
    var up = o - rowBytes;
    for (var x = 0; x < rowBytes; x++) {
      var a = x >= bpp ? data[o + x - bpp] : 0;
      var b = y > 0 ? data[up + x] : 0;
      var c = (x >= bpp && y > 0) ? data[up + x - bpp] : 0;
      out[pos + x] = (data[o + x] - paeth(a, b, c)) & 0xff;
    }
    pos += rowBytes;
  }
  return out;
}

// ---------- Writing ----------
function chunk(type, data) {
  var out = Buffer.alloc(data.length + 12);
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
function encodePng8(width, height, colorType, data8) {
  var channels = channelsFor(colorType);
  if (channels === 0) throw new Error("cannot encode PNG colour type " + colorType);
  var rowBytes = width * channels;
  if (data8.length < rowBytes * height) {
    throw new Error("sample buffer is " + data8.length + " bytes, expected " + rowBytes * height);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  var idat = zlib.deflateSync(filterRowsPaeth(data8, height, rowBytes, channels), {
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
function narrow16to8(data16, sampleCount) {
  var out = Buffer.alloc(sampleCount);
  for (var i = 0; i < sampleCount; i++) out[i] = data16[i * 2];
  return out;
}

function everyPixelTransparent(data8, channels, alphaIndex, pixelCount) {
  for (var i = 0; i < pixelCount; i++) {
    if (data8[i * channels + alphaIndex] !== 0) return false;
  }
  return true;
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
 *   channels      samples per pixel, for a caller that composites hashInput
 *   decoded       true when the pixels were actually interpreted
 *   empty         true when every pixel is fully transparent
 *   hashInput     bytes to hash for the stale-render check
 *   hashBasis     "pixels" when hashInput is decoded samples, "idat" when it is
 *                 the compressed stream (metadata-free either way, so an
 *                 embedded timestamp can never make two identical frames differ)
 *   passthrough   why the pixels were not inspected, or null
 *
 * Throws on anything that is not a readable PNG. The caller is expected to treat
 * that as "could not normalise", not as "the screenshot failed" — the render did
 * happen, and shipping it unconverted with a warning beats discarding it.
 */
function normalizePng(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("normalizePng expects a Buffer");
  var chunks = readChunks(buf);
  var h = parseHeader(chunks);

  var idatParts = [];
  for (var i = 0; i < chunks.length; i++) {
    if (chunks[i].type === "IDAT") idatParts.push(chunks[i].data);
  }
  if (!idatParts.length) throw new Error("malformed PNG: no IDAT chunk");
  var idat = Buffer.concat(idatParts);

  var channels = channelsFor(h.colorType);
  var result = {
    buffer: buf,
    width: h.width,
    height: h.height,
    bitDepth: h.bitDepth,
    colorType: h.colorType,
    // Samples per pixel, so a caller compositing `hashInput` into a contact
    // sheet does not have to re-derive it from the colour type.
    channels: channels,
    converted: false,
    decoded: false,
    empty: false,
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

  var un = unfilter(zlib.inflateSync(idat), h.width, h.height, h.bitDepth, channels);
  var pixels = h.bitDepth === 16
    ? narrow16to8(un.data, h.width * h.height * channels)
    : un.data;

  result.decoded = true;
  result.hashInput = pixels;
  result.hashBasis = "pixels";

  var alphaIndex = alphaIndexFor(h.colorType);
  if (alphaIndex >= 0 && everyPixelTransparent(pixels, channels, alphaIndex, h.width * h.height)) {
    // Nothing to send, so nothing is encoded — and `buffer: null` makes it
    // impossible for a caller to ship the frame by forgetting to check `empty`.
    result.empty = true;
    result.buffer = null;
    return result;
  }

  if (h.bitDepth === 16) {
    result.buffer = encodePng8(h.width, h.height, h.colorType, pixels);
    result.converted = true;
  }
  return result;
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
 */
function decodePng8(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("decodePng8 expects a Buffer");
  var chunks = readChunks(buf);
  var h = parseHeader(chunks);
  var channels = channelsFor(h.colorType);

  if (h.compression !== 0 || h.filter !== 0) {
    throw new Error("unsupported PNG: compression " + h.compression + ", filter method " + h.filter);
  }
  if (channels === 0) throw new Error("unsupported PNG colour type " + h.colorType);
  if (h.interlace !== 0) throw new Error("unsupported PNG: interlaced");
  if (h.colorType === 3) throw new Error("unsupported PNG: indexed colour");
  if (h.bitDepth !== 8 && h.bitDepth !== 16) throw new Error("unsupported PNG: " + h.bitDepth + "-bit samples");

  var idatParts = [];
  for (var i = 0; i < chunks.length; i++) {
    if (chunks[i].type === "IDAT") idatParts.push(chunks[i].data);
  }
  if (!idatParts.length) throw new Error("malformed PNG: no IDAT chunk");

  var un = unfilter(zlib.inflateSync(Buffer.concat(idatParts)), h.width, h.height, h.bitDepth, channels);
  var pixels = h.bitDepth === 16 ? narrow16to8(un.data, h.width * h.height * channels) : un.data;

  return {
    width: h.width,
    height: h.height,
    colorType: h.colorType,
    channels: channels,
    bitDepth: h.bitDepth,
    pixels: pixels,
  };
}

module.exports = {
  normalizePng: normalizePng,
  // For main.js, which has to know whether the file After Effects is writing is
  // finished before it reads it. It lives here because the chunk walk and the
  // signature it walks from are already defined once, above.
  inspectPngStructure: inspectPngStructure,
  // For mogrt.js, which resamples a rendered frame into a template's thumbnail
  // and needs the same decoder, encoder and CRC rather than a second copy of
  // each. The zip format's CRC-32 is the one PNG uses, bit for bit.
  decodePng8: decodePng8,
  encodePng8: encodePng8,
  crc32: crc32,
};
