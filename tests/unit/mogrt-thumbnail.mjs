// The panel's .mogrt thumbnail surgery: reading a zip, resampling a rendered
// frame into the thumbnail's exact dimensions, and writing the archive back.
//
// This rewrites a real user artefact in place, and there is no After Effects on
// a CI runner to produce one, so the archives here are built and verified by a
// second, independent zip implementation defined in this file. Sharing a reader
// with the code under test would let a bug in the shared half pass silently —
// the same discipline png-codec.mjs uses.
//
//   node tests/unit/mogrt-thumbnail.mjs

import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const clientDir = path.join(root, "packages", "ae-panel", "client");
const mogrt = require(path.join(clientDir, "mogrt.js"));
const { decodePng8, encodePng8 } = require(path.join(clientDir, "pngcodec.js"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`mogrt-thumbnail FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// An independent zip implementation, used only by this test.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip. `store` writes the entry uncompressed and `descriptor` defers
 * its sizes to a data descriptor — both are legal, and both are shapes a naive
 * rewriter gets wrong, so the code under test has to survive them.
 */
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = f.data;
    const compressed = f.store ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const sum = crc32(raw);
    const flags = f.descriptor ? 0x0008 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(f.store ? 0 : 8, 8);
    lh.writeUInt16LE(0x8000, 10); // mod time
    lh.writeUInt16LE(0x5000, 12); // mod date
    lh.writeUInt32LE(f.descriptor ? 0 : sum, 14);
    lh.writeUInt32LE(f.descriptor ? 0 : compressed.length, 18);
    lh.writeUInt32LE(f.descriptor ? 0 : raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    // An extra field on the local header only — its length legitimately differs
    // from the central directory's, which is how a rewriter that reads the data
    // offset from the wrong header lands mid-stream.
    const extra = f.localExtra ? Buffer.from([0x55, 0x54, 0x01, 0x00, 0x07]) : Buffer.alloc(0);
    lh.writeUInt16LE(extra.length, 28);

    locals.push(lh, name, extra, compressed);
    let entryLength = 30 + name.length + extra.length + compressed.length;
    if (f.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(sum, 4);
      dd.writeUInt32LE(compressed.length, 8);
      dd.writeUInt32LE(raw.length, 12);
      locals.push(dd);
      entryLength += dd.length;
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(f.store ? 0 : 8, 10);
    cd.writeUInt16LE(0x8000, 12);
    cd.writeUInt16LE(0x5000, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += entryLength;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** Read a zip back, checking every CRC against the bytes actually stored. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "no EOCD in the rewritten archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(eocd + 12), buf.length - 22 - cdOffset, "EOCD central-directory size disagrees with the file");

  const out = new Map();
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, `central signature at entry ${n}`);
    const method = buf.readUInt16LE(pos + 10);
    const flags = buf.readUInt16LE(pos + 8);
    const storedCrc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);

    assert.equal(buf.readUInt32LE(local), 0x04034b50, `local signature for ${name}`);
    // The local header must agree with the central directory, or unzip tools
    // that trust the local copy read a different file from the ones that don't.
    assert.equal(buf.readUInt32LE(local + 14), storedCrc, `${name}: local CRC disagrees with the central directory`);
    assert.equal(buf.readUInt32LE(local + 18), compSize, `${name}: local compressed size disagrees`);
    assert.equal(buf.readUInt32LE(local + 22), uncompSize, `${name}: local uncompressed size disagrees`);
    assert.equal(flags & 0x0008, 0, `${name}: data-descriptor flag survived the rewrite`);

    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    const raw = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    assert.equal(raw.length, uncompSize, `${name}: inflated to the wrong length`);
    assert.equal(crc32(raw), storedCrc, `${name}: CRC does not match the stored bytes`);
    out.set(name, raw);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(pos, cdOffset + buf.readUInt32LE(eocd + 12), "central directory has trailing bytes");
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A solid-colour RGBA PNG. */
function solidPng(w, h, [r, g, b, a], colorType = 6) {
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const px = Buffer.alloc(w * h * ch);
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    if (ch >= 3) { px[o] = r; px[o + 1] = g; px[o + 2] = b; if (ch === 4) px[o + 3] = a; }
    else { px[o] = r; if (ch === 2) px[o + 1] = a; }
  }
  return encodePng8(w, h, colorType, px);
}

/** Left half red, right half blue — so a resample can be checked for orientation. */
function halvesPng(w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const left = x < w / 2;
      px[o] = left ? 255 : 0;
      px[o + 1] = 0;
      px[o + 2] = left ? 0 : 255;
      px[o + 3] = 255;
    }
  }
  return encodePng8(w, h, 6, px);
}

const AEGRAPHIC = Buffer.from("a fake project.aegraphic payload, deflated".repeat(40), "utf8");
const DEFINITION = Buffer.from(JSON.stringify({ capsuleName: "Probe", clientControls: [] }), "utf8");
const THUMB_MP4 = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

function fixtureMogrt(thumb, opts = {}) {
  return buildZip([
    { name: "project.aegraphic", data: AEGRAPHIC, localExtra: true },
    { name: "thumb.mp4", data: THUMB_MP4, store: opts.storeMp4 === true },
    { name: "definition.json", data: DEFINITION, descriptor: opts.descriptor === true },
    { name: "thumb.png", data: thumb },
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

check("replaces thumb.png and leaves every other entry byte-identical", () => {
  const archive = fixtureMogrt(solidPng(640, 360, [0, 0, 0, 255]));
  const poster = solidPng(1920, 1080, [10, 200, 40, 255]);

  const res = mogrt.patchThumbnail(archive, poster);
  const back = readZip(res.buffer);

  assert.deepEqual([...back.keys()], ["project.aegraphic", "thumb.mp4", "definition.json", "thumb.png"], "entry order changed");
  assert.ok(back.get("project.aegraphic").equals(AEGRAPHIC), "project.aegraphic changed");
  assert.ok(back.get("thumb.mp4").equals(THUMB_MP4), "thumb.mp4 changed");
  assert.ok(back.get("definition.json").equals(DEFINITION), "definition.json changed");

  const thumb = decodePng8(back.get("thumb.png"));
  assert.equal(thumb.width, 640);
  assert.equal(thumb.height, 360);
  // The poster was a flat colour, so every pixel of the thumbnail must be it —
  // this is what proves the frame actually replaced the black one.
  assert.deepEqual([thumb.pixels[0], thumb.pixels[1], thumb.pixels[2]], [10, 200, 40]);
  const mid = ((180 * 640) + 320) * thumb.channels;
  assert.deepEqual([thumb.pixels[mid], thumb.pixels[mid + 1], thumb.pixels[mid + 2]], [10, 200, 40]);
  assert.equal(res.letterboxed, false, "a 16:9 poster into a 16:9 thumbnail should not letterbox");
});

check("matches the thumbnail's own dimensions rather than assuming 640x360", () => {
  const archive = fixtureMogrt(solidPng(320, 320, [0, 0, 0, 255]));
  const res = mogrt.patchThumbnail(archive, solidPng(1000, 1000, [1, 2, 3, 255]));
  assert.equal(res.width, 320);
  assert.equal(res.height, 320);
  const thumb = decodePng8(readZip(res.buffer).get("thumb.png"));
  assert.equal(thumb.width, 320);
  assert.equal(thumb.height, 320);
});

check("letterboxes a mismatched aspect instead of stretching it, and says so", () => {
  const archive = fixtureMogrt(solidPng(640, 360, [0, 0, 0, 255]));
  // A square poster into a 16:9 thumbnail: 360x360 centred, bars either side.
  const res = mogrt.patchThumbnail(archive, solidPng(1080, 1080, [255, 255, 255, 255]));
  assert.equal(res.letterboxed, true);

  const thumb = decodePng8(readZip(res.buffer).get("thumb.png"));
  const at = (x, y) => {
    const o = (y * thumb.width + x) * thumb.channels;
    return [thumb.pixels[o], thumb.pixels[o + 1], thumb.pixels[o + 2], thumb.pixels[o + 3]];
  };
  assert.deepEqual(at(320, 180), [255, 255, 255, 255], "centre should be the poster");
  assert.deepEqual(at(2, 180), [0, 0, 0, 0], "the bar should be transparent padding, not stretched image");
  assert.deepEqual(at(637, 180), [0, 0, 0, 0], "the far bar too");
});

check("downsamples without mirroring or transposing the image", () => {
  const archive = fixtureMogrt(solidPng(64, 36, [0, 0, 0, 255]));
  const res = mogrt.patchThumbnail(archive, halvesPng(640, 360));
  const thumb = decodePng8(readZip(res.buffer).get("thumb.png"));
  const at = (x, y) => {
    const o = (y * thumb.width + x) * thumb.channels;
    return [thumb.pixels[o], thumb.pixels[o + 1], thumb.pixels[o + 2]];
  };
  assert.deepEqual(at(4, 18), [255, 0, 0], "left half should still be red");
  assert.deepEqual(at(59, 18), [0, 0, 255], "right half should still be blue");
});

check("averages rather than point-samples, so detail is not aliased away", () => {
  // A 2x1 checkerboard scaled to 1x1 must be the mean, not one of the two.
  const px = Buffer.alloc(2 * 1 * 4);
  px.set([0, 0, 0, 255], 0);
  px.set([200, 200, 200, 255], 4);
  const out = mogrt.resampleFit(px, 2, 1, 4, 1, 1);
  assert.equal(out.data[0], 100);
});

check("keeps the thumbnail's colour type when the poster's differs", () => {
  // An RGB (no alpha) thumbnail must not silently gain an alpha channel.
  const archive = fixtureMogrt(solidPng(64, 36, [0, 0, 0], 2));
  const res = mogrt.patchThumbnail(archive, solidPng(640, 360, [20, 40, 60, 255], 6));
  const thumb = decodePng8(readZip(res.buffer).get("thumb.png"));
  assert.equal(thumb.colorType, 2);
  assert.equal(thumb.channels, 3);
  assert.deepEqual([thumb.pixels[0], thumb.pixels[1], thumb.pixels[2]], [20, 40, 60]);
});

check("survives stored entries and data descriptors", () => {
  const archive = fixtureMogrt(solidPng(640, 360, [0, 0, 0, 255]), { storeMp4: true, descriptor: true });
  const res = mogrt.patchThumbnail(archive, solidPng(1920, 1080, [7, 8, 9, 255]));
  const back = readZip(res.buffer);
  assert.ok(back.get("thumb.mp4").equals(THUMB_MP4), "a stored entry was mangled");
  assert.ok(back.get("definition.json").equals(DEFINITION), "a data-descriptor entry was mangled");
  const thumb = decodePng8(back.get("thumb.png"));
  assert.deepEqual([thumb.pixels[0], thumb.pixels[1], thumb.pixels[2]], [7, 8, 9]);
});

check("is idempotent — patching a patched archive works", () => {
  const archive = fixtureMogrt(solidPng(640, 360, [0, 0, 0, 255]));
  const once = mogrt.patchThumbnail(archive, solidPng(1920, 1080, [11, 22, 33, 255]));
  const twice = mogrt.patchThumbnail(once.buffer, solidPng(1920, 1080, [44, 55, 66, 255]));
  const thumb = decodePng8(readZip(twice.buffer).get("thumb.png"));
  assert.deepEqual([thumb.pixels[0], thumb.pixels[1], thumb.pixels[2]], [44, 55, 66]);
});

check("refuses an archive with no thumb.png, naming what it did find", () => {
  const archive = buildZip([{ name: "definition.json", data: DEFINITION }]);
  assert.throws(
    () => mogrt.patchThumbnail(archive, solidPng(640, 360, [0, 0, 0, 255])),
    /no thumb\.png in the template \(entries: definition\.json\)/,
  );
});

check("refuses something that is not a zip at all", () => {
  assert.throws(() => mogrt.patchThumbnail(Buffer.from("not a zip, just text"), solidPng(8, 8, [0, 0, 0, 255])), /not a zip/);
});

check("refuses zip64 rather than writing a corrupt archive", () => {
  const archive = fixtureMogrt(solidPng(64, 36, [0, 0, 0, 255]));
  // Plant a zip64 EOCD locator immediately before the EOCD.
  const eocd = archive.subarray(archive.length - 22);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  const faked = Buffer.concat([archive.subarray(0, archive.length - 22), locator, eocd]);
  assert.throws(() => mogrt.patchThumbnail(faked, solidPng(8, 8, [0, 0, 0, 255])), /zip64/);
});

check("a zip comment after the EOCD does not hide it", () => {
  const archive = fixtureMogrt(solidPng(64, 36, [0, 0, 0, 255]));
  const comment = Buffer.from("exported by After Effects", "utf8");
  const withComment = Buffer.concat([archive, comment]);
  withComment.writeUInt16LE(comment.length, withComment.length - comment.length - 2);
  const res = mogrt.patchThumbnail(withComment, solidPng(640, 360, [3, 3, 3, 255]));
  const thumb = decodePng8(readZip(res.buffer).get("thumb.png"));
  assert.deepEqual([thumb.pixels[0], thumb.pixels[1], thumb.pixels[2]], [3, 3, 3]);
});

console.log(`mogrt-thumbnail: ${passed} checks passed`);
