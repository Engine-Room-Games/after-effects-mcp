// The contact sheet: several rendered frames tiled into one labelled image.
//
// Issue #56. Judging motion is one visual question, and answering it used to
// cost one screenshot call per frame — three image blocks resident for the rest
// of the session, and three chances for the stale-frame check to bite.
//
// Three things have to hold, and none of them needs After Effects to check:
//
//   * every requested time gets a cell, in order, whether or not it rendered —
//     a dropped tile silently renumbers the rest, and an agent counting frames
//     left to right then reads the wrong one as the right one;
//   * the time is burned into the picture, in that tile, not only in the
//     metadata beside it;
//   * the whole sheet stays inside roughly the pixel budget of one of today's
//     single frames.
//
// The sheet is decoded with a PNG reader defined in this file rather than the
// panel's own, so a bug shared between the writer and the checker cannot pass.
//
//   node tests/unit/contact-sheet.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const client = path.join(root, "packages", "ae-panel", "client");
const sheetModule = require(path.join(client, "contactsheet.js"));
const { composeContactSheet, layoutFor, formatTime, GUTTER } = sheetModule;

let passed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`contact-sheet FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// An independent PNG reader, used only by this test.
// ---------------------------------------------------------------------------
function readPng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) assert.equal(buf[i], sig[i], "sheet is not a PNG");
  let pos = 8;
  let hdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      hdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
    }
    if (type === "IDAT") idat.push(data);
    pos += len + 12;
    if (type === "IEND") break;
  }
  assert.ok(hdr, "no IHDR");
  assert.equal(hdr.bitDepth, 8);
  assert.equal(hdr.colorType, 6, "a sheet is always RGBA");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = hdr.width * 4;
  const out = Buffer.alloc(rowBytes * hdr.height);
  let p = 0;
  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a);
    const pb = Math.abs(pp - b);
    const pc = Math.abs(pp - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  for (let y = 0; y < hdr.height; y++) {
    const f = raw[p++];
    const o = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= 4 ? out[o + x - 4] : 0;
      const b = y > 0 ? out[o - rowBytes + x] : 0;
      const c = x >= 4 && y > 0 ? out[o - rowBytes + x - 4] : 0;
      const cur = raw[p + x];
      let v;
      if (f === 0) v = cur;
      else if (f === 1) v = cur + a;
      else if (f === 2) v = cur + b;
      else if (f === 3) v = cur + ((a + b) >> 1);
      else if (f === 4) v = cur + paeth(a, b, c);
      else throw new Error(`unknown filter ${f}`);
      out[o + x] = v & 0xff;
    }
    p += rowBytes;
  }
  return {
    ...hdr,
    at(x, y) {
      const o = (y * hdr.width + x) * 4;
      return [out[o], out[o + 1], out[o + 2], out[o + 3]];
    },
  };
}

/** A flat RGBA frame of one colour, so a tile is identifiable by a single pixel. */
function frame(w, h, rgb, channels = 4) {
  const px = Buffer.alloc(w * h * channels);
  for (let i = 0; i < w * h; i++) {
    px[i * channels] = rgb[0];
    px[i * channels + 1] = rgb[1];
    px[i * channels + 2] = rgb[2];
    if (channels === 4) px[i * channels + 3] = 255;
  }
  return px;
}
function okTile(time, w, h, rgb, channels = 4) {
  return { time, status: "ok", pixels: frame(w, h, rgb, channels), width: w, height: h, channels };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
check("two to six tiles get the layout a reader expects, not ceil(sqrt(n))", () => {
  // Three frames of an animation read as a strip and stay on one row; five must
  // not leave a hole in the middle of a two-wide grid.
  assert.deepEqual(layoutFor(2), { cols: 2, rows: 1 });
  assert.deepEqual(layoutFor(3), { cols: 3, rows: 1 });
  assert.deepEqual(layoutFor(4), { cols: 2, rows: 2 });
  assert.deepEqual(layoutFor(5), { cols: 3, rows: 2 });
  assert.deepEqual(layoutFor(6), { cols: 3, rows: 2 });
});

check("the sheet is exactly cells plus gutters, in both directions", () => {
  const w = 120;
  const h = 68;
  for (const n of [2, 3, 4, 5, 6]) {
    const tiles = [];
    for (let i = 0; i < n; i++) tiles.push(okTile(i, w, h, [10 + i * 20, 40, 60]));
    const sheet = composeContactSheet(tiles, { cellWidth: w, cellHeight: h });
    const { cols, rows } = layoutFor(n);
    assert.equal(sheet.width, cols * w + (cols + 1) * GUTTER, `${n} tiles: sheet width`);
    assert.equal(sheet.height, rows * h + (rows + 1) * GUTTER, `${n} tiles: sheet height`);
    assert.equal(sheet.tiles.length, n, `${n} tiles: one cell per requested time`);
    const png = readPng(sheet.buffer);
    assert.equal(png.width, sheet.width, "the IHDR must agree with the reported size");
    assert.equal(png.height, sheet.height);
  }
});

check("each requested time keeps its place, in order, with its own rectangle", () => {
  const tiles = [okTile(0, 60, 40, [200, 0, 0]), okTile(1.5, 60, 40, [0, 200, 0]), okTile(3, 60, 40, [0, 0, 200])];
  const sheet = composeContactSheet(tiles, { cellWidth: 60, cellHeight: 40 });
  assert.deepEqual(sheet.tiles.map((t) => t.time), [0, 1.5, 3]);
  assert.deepEqual(sheet.tiles.map((t) => t.status), ["ok", "ok", "ok"]);
  assert.deepEqual(sheet.tiles.map((t) => t.x), [GUTTER, GUTTER * 2 + 60, GUTTER * 3 + 120]);
  for (const t of sheet.tiles) {
    assert.equal(t.y, GUTTER, "a single row sits one gutter down");
    assert.equal(t.width, 60);
    assert.equal(t.height, 40);
  }
});

check("the pixels of each frame land in that frame's cell", () => {
  const colours = [[200, 30, 30], [30, 200, 30], [30, 30, 200]];
  const tiles = colours.map((c, i) => okTile(i, 60, 40, c));
  const sheet = composeContactSheet(tiles, { cellWidth: 60, cellHeight: 40 });
  const png = readPng(sheet.buffer);
  sheet.tiles.forEach((t, i) => {
    // Sample away from the border and clear of the label chip in the top-left.
    const [r, g, b, a] = png.at(t.x + t.width - 6, t.y + t.height - 6);
    assert.deepEqual([r, g, b, a], [...colours[i], 255], `tile ${i} shows the wrong frame`);
  });
});

check("a three-channel frame composites with full alpha rather than a transparent tile", () => {
  const sheet = composeContactSheet(
    [okTile(0, 40, 30, [10, 120, 240], 3), okTile(1, 40, 30, [10, 120, 240], 3)],
    { cellWidth: 40, cellHeight: 30 },
  );
  const png = readPng(sheet.buffer);
  const t = sheet.tiles[1];
  assert.deepEqual(png.at(t.x + 30, t.y + 24), [10, 120, 240, 255]);
});

// ---------------------------------------------------------------------------
// Bad tiles
// ---------------------------------------------------------------------------
check("a tile that failed is a marked block in its own cell, never a dropped cell", () => {
  const tiles = [
    okTile(0, 60, 40, [200, 30, 30]),
    { time: 1, status: "failed", note: "wrote 73877 bytes and stopped" },
    okTile(2, 60, 40, [30, 30, 200]),
  ];
  const sheet = composeContactSheet(tiles, { cellWidth: 60, cellHeight: 40 });
  assert.equal(sheet.tiles.length, 3, "the layout must still map onto the times that were asked for");
  assert.deepEqual(sheet.tiles.map((t) => t.time), [0, 1, 2]);
  assert.equal(sheet.tiles[1].status, "failed");
  assert.equal(sheet.tiles[1].note, "wrote 73877 bytes and stopped");
  assert.match(sheet.tiles[1].label, /FAILED/, "the status is in the picture, not only in the metadata");

  // The block is flat, and it is not the colour of either neighbour.
  const png = readPng(sheet.buffer);
  const t = sheet.tiles[1];
  const a = png.at(t.x + 50, t.y + 34);
  const b = png.at(t.x + 30, t.y + 30);
  assert.deepEqual(a, b, "a marked block is flat");
  assert.notDeepEqual(a, [200, 30, 30, 255]);
  assert.notDeepEqual(a, [30, 30, 200, 255]);
});

check("empty and stale tiles are marked differently from each other and from failed", () => {
  const tiles = [
    { time: 0, status: "empty" },
    { time: 1, status: "stale", note: "identical to comp 7 @ 0.000s downsample 4" },
    { time: 2, status: "failed" },
  ];
  const sheet = composeContactSheet(tiles, { cellWidth: 60, cellHeight: 40 });
  const png = readPng(sheet.buffer);
  const seen = sheet.tiles.map((t) => png.at(t.x + 50, t.y + 34).join(","));
  assert.equal(new Set(seen).size, 3, "three different verdicts must not look identical");
  assert.match(sheet.tiles[0].label, /EMPTY/);
  assert.match(sheet.tiles[1].label, /STALE/);
  assert.match(sheet.tiles[2].label, /FAILED/);
});

check("a cell size is still known when the first tile is the one that failed", () => {
  // The expected size is passed in rather than read off tiles[0] for exactly
  // this case: the tile with no picture has no dimensions to read.
  const sheet = composeContactSheet(
    [{ time: 0, status: "failed" }, okTile(1, 60, 40, [0, 0, 200])],
    { cellWidth: 60, cellHeight: 40 },
  );
  assert.equal(sheet.cellWidth, 60);
  assert.equal(sheet.cellHeight, 40);
  assert.equal(sheet.width, 2 * 60 + 3 * GUTTER);
});

check("composing nothing is refused rather than producing an empty picture", () => {
  assert.throws(() => composeContactSheet([], { cellWidth: 10, cellHeight: 10 }));
  assert.throws(() => composeContactSheet([{ time: 0, status: "failed" }], { cellWidth: 0, cellHeight: 0 }));
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
check("a time is formatted short, but never so short two frames read alike", () => {
  assert.equal(formatTime(0), "0s");
  assert.equal(formatTime(1.5), "1.5s");
  assert.equal(formatTime(2.25), "2.25s");
  assert.equal(formatTime(3), "3s");
  // Adjacent frames at 30fps are 0.033s apart. Two decimals would print these
  // two identically, which is the one case where the label actively misleads.
  assert.notEqual(formatTime(1 / 30), formatTime(2 / 30));
  assert.equal(formatTime(1 / 30), "0.033s");
});

/** Count the light pixels inside a rectangle — the ink of a drawn label. */
function inkIn(png, rect) {
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (png.at(x, y)[0] > 200) n++;
    }
  }
  return n;
}

check("every label is drawn inside its own tile, and nowhere else", () => {
  const tiles = [okTile(0, 200, 120, [80, 80, 80]), okTile(1.5, 200, 120, [80, 80, 80]), okTile(2.75, 200, 120, [80, 80, 80])];
  const sheet = composeContactSheet(tiles, { cellWidth: 200, cellHeight: 120, labelScale: 2 });
  const png = readPng(sheet.buffer);
  sheet.tiles.forEach((t, i) => {
    const r = t.labelRect;
    assert.ok(r.x >= t.x && r.y >= t.y, `tile ${i}: the label starts outside its cell`);
    assert.ok(
      r.x + r.width <= t.x + t.width && r.y + r.height <= t.y + t.height,
      `tile ${i}: the label runs out of its cell`,
    );
    assert.ok(inkIn(png, r) > 0, `tile ${i}: the label chip has no ink in it`);
    // The frame itself is a flat mid grey, so ink outside the chip would mean a
    // label bleeding into a neighbour.
    assert.equal(
      inkIn(png, { x: t.x, y: r.y + r.height + 2, width: t.width, height: 20 }),
      0,
      `tile ${i}: something was drawn below the label chip`,
    );
  });
});

check("different times draw different labels, so the tiles are told apart by the picture", () => {
  const tiles = [okTile(0, 200, 120, [80, 80, 80]), okTile(8, 200, 120, [80, 80, 80])];
  const sheet = composeContactSheet(tiles, { cellWidth: 200, cellHeight: 120, labelScale: 2 });
  const png = readPng(sheet.buffer);
  const [a, b] = sheet.tiles;
  assert.equal(a.label, "0s");
  assert.equal(b.label, "8s");
  assert.notEqual(
    inkIn(png, a.labelRect),
    inkIn(png, b.labelRect),
    "0s and 8s must not render as the same glyph",
  );
});

check("a label is legible against the frame because the chip is opaque", () => {
  // Drawn over a white frame: if the chip were blended, the dark ground behind
  // white text would come out light and the label would vanish.
  const sheet = composeContactSheet(
    [okTile(0, 120, 80, [255, 255, 255]), okTile(1, 120, 80, [255, 255, 255])],
    { cellWidth: 120, cellHeight: 80, labelScale: 1 },
  );
  const png = readPng(sheet.buffer);
  const r = sheet.tiles[0].labelRect;
  let dark = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) if (png.at(x, y)[0] < 40) dark++;
  }
  assert.ok(dark > r.width, "the chip must stay dark over a white frame");
});

// ---------------------------------------------------------------------------
// The pixel budget
// ---------------------------------------------------------------------------
check("the per-tile downsample is derived from the single-frame one, not restated", () => {
  // The derivation itself runs in ExtendScript, which has no offline runtime —
  // so what is checked here is that it cannot drift: __tileDownsample has to be
  // expressed in terms of __autoDownsample rather than in terms of its own
  // target. See tests/unit/jsx-ternary.mjs for the same kind of source check.
  const src = fs.readFileSync(path.join(root, "packages", "jsx", "vision.jsx"), "utf8");
  const body = src.slice(src.indexOf("function __tileDownsample"));
  const fn = body.slice(0, body.indexOf("\n}"));
  assert.match(fn, /__autoDownsample\(comp\)/, "the tile factor must come from the single-frame factor");
  assert.match(fn, /Math\.sqrt\(count\)/, "N tiles means 1/sqrt(N) of the long edge");
  assert.doesNotMatch(fn, /__SCREENSHOT_TARGET_PX/, "a second target here is exactly the drift to avoid");
});

check("a sheet costs no more pixels than the single frame it replaces", () => {
  // Mirrors the rule stated in vision.jsx: tile factor = ceil(single * sqrt(N)),
  // capped at 8. Run over the comp sizes people actually screenshot.
  const auto = (long) => Math.min(8, Math.max(1, Math.ceil(long / 1280)));
  const tile = (long, n) => Math.min(8, Math.max(1, Math.ceil(auto(long) * Math.sqrt(n))));
  for (const [w, h] of [[3840, 2160], [1920, 1080], [1280, 720], [1080, 1920]]) {
    const long = Math.max(w, h);
    const single = Math.floor(w / auto(long)) * Math.floor(h / auto(long));
    for (const n of [2, 3, 4, 5, 6]) {
      const f = tile(long, n);
      const sheetPixels = n * Math.floor(w / f) * Math.floor(h / f);
      assert.ok(
        sheetPixels <= single,
        `${w}x${h} with ${n} tiles: ${sheetPixels}px against a single frame's ${single}px`,
      );
      // The floor is 0.5, and it is quantisation rather than slack: the factor
      // is an integer, so the smallest step available above 1 already quarters
      // the area. Two tiles of a 720p comp is that case exactly.
      assert.ok(
        sheetPixels >= single * 0.49,
        `${w}x${h} with ${n} tiles: ${sheetPixels}px against a single frame's ${single}px is more waste than the integer factor forces`,
      );
    }
  }
});

console.log(`contact-sheet: ${passed} checks passed`);
