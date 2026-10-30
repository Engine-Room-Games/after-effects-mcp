// mogrtThumbnail.ts — replace the still thumbnail inside an exported .mogrt.
//
// Ported from the panel's `client/mogrt.js` when the server took over
// patching the thumbnail (issue #220 stage 4). The panel's copy was deleted in
// issue #243; this is the only one.
//
// A .mogrt is a zip holding project.aegraphic, definition.json, thumb.mp4 and
// thumb.png. After Effects has no scriptable poster time, and the export
// ignores comp.time, so thumb.png is whatever AE picked — in practice black
// (issue #23). The frame the user actually wants can be rendered by
// saveFrameToPng; getting it into the archive is what this file does.
//
// The zip work is deliberately narrow. Entries other than the one being
// replaced are copied across as their original compressed bytes — never
// re-compressed — so the only entry this code can possibly corrupt is the one
// it means to rewrite.

import zlib from "node:zlib";
import { alphaIndexFor, crc32, decodePng8, encodePng8, unpremultiply8 } from "./pngCodec.js";

const THUMB_ENTRY = "thumb.png";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const EOCD_MIN_SIZE = 22;
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipEntry {
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  modTime: number;
  modDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  internalAttrs: number;
  externalAttrs: number;
  name: string;
  localOffset: number;
  /** The entry's compressed bytes. */
  data: Buffer;
}

export interface ResampledImage {
  data: Buffer;
  drawWidth: number;
  drawHeight: number;
  offsetX: number;
  offsetY: number;
}

export interface PatchedThumbnail {
  buffer: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  letterboxed: boolean;
  bytes: number;
}

// ---------- zip reading ----------

function findEocd(buf: Buffer): number {
  // The EOCD is last, but a zip comment can follow it — scan back over the
  // largest comment the format allows plus the record itself.
  const minStart = Math.max(0, buf.length - (0xffff + EOCD_MIN_SIZE));
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minStart; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLength = buf.readUInt16LE(i + 20);
    if (i + EOCD_MIN_SIZE + commentLength === buf.length) return i;
  }
  throw new Error("not a zip: no end-of-central-directory record");
}

/**
 * Parse the central directory. It, not the local headers, is the authoritative
 * record of sizes — a local header is allowed to carry zeros and defer to a
 * data descriptor after the entry, which is exactly the case that silently
 * truncates a naive rewriter.
 */
export function readEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);

  // Zip64 changes the offsets these fields hold. A .mogrt is a handful of MB,
  // so rather than implement it we refuse: corrupting somebody's template is a
  // much worse outcome than declining to touch an archive this was not built for.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new Error("zip64 archives are not supported");
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_SENTINEL || cdSize === ZIP64_SENTINEL || count === 0xffff) {
    throw new Error("zip64 archives are not supported");
  }
  if (cdOffset + cdSize > buf.length) throw new Error("corrupt zip: central directory runs past the end of the file");

  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_SIG) throw new Error("corrupt zip: bad central directory signature at entry " + n);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    if (localOffset === ZIP64_SENTINEL) throw new Error("zip64 archives are not supported");

    // `data` is filled in below, once the local header has been read; the key
    // order matches the panel copy's, where it was added the same way.
    const entry = {
      versionMadeBy: buf.readUInt16LE(pos + 4),
      versionNeeded: buf.readUInt16LE(pos + 6),
      flags: buf.readUInt16LE(pos + 8),
      method: buf.readUInt16LE(pos + 10),
      modTime: buf.readUInt16LE(pos + 12),
      modDate: buf.readUInt16LE(pos + 14),
      crc32: buf.readUInt32LE(pos + 16),
      compressedSize: buf.readUInt32LE(pos + 20),
      uncompressedSize: buf.readUInt32LE(pos + 24),
      internalAttrs: buf.readUInt16LE(pos + 36),
      externalAttrs: buf.readUInt32LE(pos + 38),
      name: buf.toString("utf8", pos + 46, pos + 46 + nameLength),
      localOffset: localOffset,
    } as ZipEntry;
    if (entry.compressedSize === ZIP64_SENTINEL || entry.uncompressedSize === ZIP64_SENTINEL) {
      throw new Error("zip64 archives are not supported");
    }

    // The compressed bytes start after the *local* header, whose name and extra
    // lengths can differ from the central directory's.
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error("corrupt zip: bad local header for " + entry.name);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buf.length) throw new Error("corrupt zip: " + entry.name + " runs past the end of the file");
    entry.data = buf.subarray(dataStart, dataEnd);

    entries.push(entry);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function inflateEntry(entry: ZipEntry): Buffer {
  if (entry.method === 0) return Buffer.from(entry.data);
  if (entry.method === 8) return zlib.inflateRawSync(entry.data);
  throw new Error("unsupported zip compression method " + entry.method + " for " + entry.name);
}

// ---------- zip writing ----------

/**
 * Rebuild an archive from parsed entries. Extra fields and comments are
 * dropped: in a .mogrt they hold timestamps, and carrying them would mean
 * keeping the local and central copies consistent for no gain. Data descriptors
 * are folded away — every size is known here, so the flag bit that says
 * "look after the entry for them" is cleared.
 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nameBuf = Buffer.from(e.name, "utf8");
    const flags = e.flags & ~0x0008; // no data descriptor

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(e.versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(e.modTime, 10);
    local.writeUInt16LE(e.modDate, 12);
    local.writeUInt32LE(e.crc32, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(e.versionMadeBy, 4);
    cd.writeUInt16LE(e.versionNeeded, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(e.modTime, 12);
    cd.writeUInt16LE(e.modDate, 14);
    cd.writeUInt32LE(e.crc32, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(e.internalAttrs, 36);
    cd.writeUInt32LE(e.externalAttrs, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + e.data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(EOCD_MIN_SIZE);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(parts.concat([cdBuf, eocd]));
}

// ---------- resampling ----------

/**
 * Box-filter downscale, then centre the result inside `outW`x`outH` without
 * changing its aspect ratio. Padding is fully transparent where the image has
 * an alpha channel and black where it does not.
 *
 * A box filter rather than bilinear because this is always a reduction, often
 * by 3x or more, and averaging every source pixel that lands in a destination
 * pixel is both the correct answer for that and cheaper than sampling.
 */
export function resampleFit(
  src: Uint8Array, srcW: number, srcH: number, channels: number, outW: number, outH: number,
): ResampledImage {
  const scale = Math.min(outW / srcW, outH / srcH);
  const drawW = Math.max(1, Math.min(outW, Math.round(srcW * scale)));
  const drawH = Math.max(1, Math.min(outH, Math.round(srcH * scale)));
  const offsetX = Math.floor((outW - drawW) / 2);
  const offsetY = Math.floor((outH - drawH) / 2);

  const out = Buffer.alloc(outW * outH * channels, 0);
  const acc = new Float64Array(channels);

  for (let dy = 0; dy < drawH; dy++) {
    const sy0 = Math.floor((dy * srcH) / drawH);
    let sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * srcH) / drawH));
    if (sy1 > srcH) sy1 = srcH;
    for (let dx = 0; dx < drawW; dx++) {
      const sx0 = Math.floor((dx * srcW) / drawW);
      let sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * srcW) / drawW));
      if (sx1 > srcW) sx1 = srcW;

      for (let c = 0; c < channels; c++) acc[c] = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const rowBase = sy * srcW * channels;
        for (let sx = sx0; sx < sx1; sx++) {
          const base = rowBase + sx * channels;
          for (let ci = 0; ci < channels; ci++) acc[ci] += src[base + ci];
          n++;
        }
      }
      const dst = ((dy + offsetY) * outW + (dx + offsetX)) * channels;
      for (let co = 0; co < channels; co++) out[dst + co] = Math.round(acc[co] / n);
    }
  }
  return { data: out, drawWidth: drawW, drawHeight: drawH, offsetX: offsetX, offsetY: offsetY };
}

// ---------- the operation ----------

/**
 * Replace thumb.png inside a .mogrt with `posterPng`, resized to the exact
 * dimensions of the thumbnail AE already wrote.
 *
 * Matching AE's dimensions rather than hardcoding 640x360 is the point: that is
 * what a 16:9 comp produced here, but nothing documents the rule for other
 * shapes, and reading it costs one IHDR.
 *
 * Returns a description of what changed. Throws if the archive has no
 * thumb.png, or is not a zip this code is prepared to rewrite — the caller
 * treats that as "the export succeeded, the thumbnail did not", never as a
 * failed export.
 */
export function patchThumbnail(mogrtBuf: Buffer, posterPng: Buffer): PatchedThumbnail {
  const entries = readEntries(mogrtBuf);

  let target: ZipEntry | null = null;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].name === THUMB_ENTRY) { target = entries[i]; break; }
  }
  if (!target) {
    const names: string[] = [];
    for (let j = 0; j < entries.length; j++) names.push(entries[j].name);
    throw new Error("no " + THUMB_ENTRY + " in the template (entries: " + names.join(", ") + ")");
  }

  const existing = decodePng8(inflateEntry(target));
  // The poster is raw `saveFrameToPng` output, never through normalizePng, so
  // its colour is premultiplied by alpha (issue #130). Two consequences, and the
  // order below follows from them:
  //
  //   * Resample *before* un-premultiplying. A box filter over premultiplied
  //     samples is the alpha-weighted average, so a transparent pixel's colour
  //     cannot bleed into its neighbours; averaging straight colour would pull
  //     every soft edge toward whatever undefined colour the clear pixels hold,
  //     which is the halo this is meant to remove. The transparent padding
  //     resampleFit adds is zeros, which is the same in both forms.
  //   * Un-premultiply only when the thumbnail keeps an alpha channel. Dropping
  //     alpha from premultiplied colour is exactly compositing over black, which
  //     is the right picture for an opaque thumbnail; dropping it from straight
  //     colour would leave every soft edge at full strength.
  const poster = decodePng8(posterPng);
  // Encode at the thumbnail's own colour type so an archive whose thumbnail has
  // no alpha does not gain one, and vice versa.
  const channels = existing.channels;
  const srcAlpha = alphaIndexFor(poster.colorType);
  let source = poster.pixels;
  let srcChannels = poster.channels;
  if (srcAlpha < 0 && srcChannels !== channels) {
    // A poster with no alpha has nothing premultiplied, so convert it first:
    // resampling in its own channel count would make the letterbox padding
    // opaque black when the thumbnail has alpha, instead of transparent.
    source = convertChannels(source, srcChannels, channels, poster.width * poster.height);
    srcChannels = channels;
  }
  const fitted = resampleFit(source, poster.width, poster.height, srcChannels, existing.width, existing.height);
  let data = fitted.data;
  const outCount = existing.width * existing.height;
  if (srcAlpha >= 0 && alphaIndexFor(existing.colorType) >= 0) {
    data = unpremultiply8(data, srcChannels, srcAlpha, outCount);
  }

  if (srcChannels !== channels) data = convertChannels(data, srcChannels, channels, outCount);
  const encoded = encodePng8(existing.width, existing.height, existing.colorType, data);

  target.data = zlib.deflateRawSync(encoded, { level: 6 });
  target.method = 8;
  target.crc32 = crc32(encoded);
  target.uncompressedSize = encoded.length;

  return {
    buffer: writeZip(entries),
    width: existing.width,
    height: existing.height,
    sourceWidth: poster.width,
    sourceHeight: poster.height,
    // Present when the poster's aspect ratio did not match the thumbnail's, so
    // a caller can say why there are bars rather than leaving them a surprise.
    letterboxed: fitted.drawWidth !== existing.width || fitted.drawHeight !== existing.height,
    bytes: encoded.length,
  };
}

/** Grow or shrink a pixel buffer between grey/greyA/RGB/RGBA. */
function convertChannels(src: Buffer, from: number, to: number, pixelCount: number): Buffer {
  const out = Buffer.alloc(pixelCount * to);
  for (let p = 0; p < pixelCount; p++) {
    const s = p * from;
    const d = p * to;
    let r: number, g: number, b: number, a: number;
    if (from === 1) { r = g = b = src[s]; a = 255; }
    else if (from === 2) { r = g = b = src[s]; a = src[s + 1]; }
    else if (from === 3) { r = src[s]; g = src[s + 1]; b = src[s + 2]; a = 255; }
    else { r = src[s]; g = src[s + 1]; b = src[s + 2]; a = src[s + 3]; }

    if (to === 1) { out[d] = Math.round((r * 299 + g * 587 + b * 114) / 1000); }
    else if (to === 2) { out[d] = Math.round((r * 299 + g * 587 + b * 114) / 1000); out[d + 1] = a; }
    else if (to === 3) { out[d] = r; out[d + 1] = g; out[d + 2] = b; }
    else { out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a; }
  }
  return out;
}
