// contactsheet.js — tile several rendered frames into one labelled sheet.
//
// Judging motion is one visual question — "does it move the way I think it
// does" — and answering it used to cost three `screenshot_frame` calls. Three
// calls is three image blocks resident in the context for the rest of the
// session, three chances for After Effects to re-serve a stale buffer, and no
// guarantee the agent lines the frames up in the right order. One sheet is one
// image, one op, and the order is in the picture. Issue #56.
//
// The compositing happens here rather than in ExtendScript for the obvious
// reason: `packages/jsx` has no pixels, no PNG encoder and no way to draw a
// character. The panel already decodes and re-encodes frames for the 16-bit
// conversion, so the sheet is a few hundred lines on top of machinery that
// exists.
//
// Two rules the layout has to keep:
//
//   * Every requested time gets a cell, in order, whether or not it rendered.
//     A sheet that silently drops the tile that failed no longer maps onto the
//     times that were asked for, and an agent counting tiles left to right
//     would read the wrong frame as the right one.
//   * The time is burned into the picture. Metadata beside an image is not
//     what a model looks at when it is comparing three frames.
//
// Node builtins only, and a CommonJS module, for the same reasons as
// pngcodec.js: `client/main.js` requires it inside CEP's mixed context and
// `tests/unit/contact-sheet.mjs` requires the same file under plain Node.

"use strict";

var pngCodec = require("./pngcodec.js");

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

// Columns per tile count. Not a formula, because the two things a formula gets
// wrong are the ones that matter: three frames of an animation read as a strip
// and should stay on one row, and five should not leave a hole in the middle of
// a 2-wide grid. Two to six is the whole domain — the schema caps `times` there
// — so the table is complete rather than a heuristic.
var COLUMNS_FOR = { 2: 2, 3: 3, 4: 2, 5: 3, 6: 3 };

function layoutFor(count) {
  var cols = COLUMNS_FOR[count];
  if (!cols) cols = Math.ceil(Math.sqrt(count));
  return { cols: cols, rows: Math.ceil(count / cols) };
}

// The gutter is opaque on purpose. A transparent one would be invisible behind
// a transparent overlay comp — which is exactly the kind of comp somebody
// screenshots three times — and the tiles would run together.
var GUTTER = 4;
var BACKGROUND = [38, 38, 38, 255];
var TILE_BORDER = [150, 150, 150, 255];

// Flat blocks for the cells that have no picture. Each carries its status word
// in the label chip as well; the colour alone is a hint, never the statement.
var STATUS_FILL = {
  empty: [22, 22, 28, 255],
  stale: [74, 30, 30, 255],
  failed: [74, 50, 20, 255],
};

// ---------------------------------------------------------------------------
// A 5x7 bitmap font, five column bytes per glyph, bit 0 = top row.
//
// Burning text into a frame needs a font, and a font file would be a second
// thing to ship into the CEP extension and keep in sync — the problem `ws`
// already causes once. Fifty glyphs of pixels weigh nothing and render
// identically on both platforms, which a system font would not.
// ---------------------------------------------------------------------------
var FONT = {
  "0": [0x3e, 0x51, 0x49, 0x45, 0x3e],
  "1": [0x00, 0x42, 0x7f, 0x40, 0x00],
  "2": [0x42, 0x61, 0x51, 0x49, 0x46],
  "3": [0x21, 0x41, 0x45, 0x4b, 0x31],
  "4": [0x18, 0x14, 0x12, 0x7f, 0x10],
  "5": [0x27, 0x45, 0x45, 0x45, 0x39],
  "6": [0x3c, 0x4a, 0x49, 0x49, 0x30],
  "7": [0x01, 0x71, 0x09, 0x05, 0x03],
  "8": [0x36, 0x49, 0x49, 0x49, 0x36],
  "9": [0x06, 0x49, 0x49, 0x29, 0x1e],
  ".": [0x00, 0x60, 0x60, 0x00, 0x00],
  "-": [0x08, 0x08, 0x08, 0x08, 0x08],
  ":": [0x00, 0x36, 0x36, 0x00, 0x00],
  " ": [0x00, 0x00, 0x00, 0x00, 0x00],
  s: [0x48, 0x54, 0x54, 0x54, 0x20],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43],
};
var GLYPH_W = 5;
var GLYPH_H = 7;
var ADVANCE = GLYPH_W + 1;

function glyphFor(ch) {
  if (FONT[ch]) return FONT[ch];
  var up = ch.toUpperCase();
  if (FONT[up]) return FONT[up];
  return FONT[" "];
}

/** Width in pixels of `text` at `scale`, with no trailing inter-glyph gap. */
function textWidth(text, scale) {
  if (!text.length) return 0;
  return (text.length * ADVANCE - 1) * scale;
}

/**
 * Format a time for the label: shortest form that is still unambiguous.
 * 0 -> "0s", 1.5 -> "1.5s", 2.25 -> "2.25s", 0.041666 -> "0.042s".
 *
 * Three decimals because a 30fps frame is 0.033s apart from its neighbour and
 * two would print two adjacent frames identically — the one case where the
 * label would actively mislead.
 */
function formatTime(t) {
  if (typeof t !== "number" || !isFinite(t)) return "?s";
  var s = t.toFixed(3);
  // Trim the zeros the fixed form adds, but never the digit before the point.
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s + "s";
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function setPixel(sheet, sheetW, sheetH, x, y, rgba) {
  if (x < 0 || y < 0 || x >= sheetW || y >= sheetH) return;
  var o = (y * sheetW + x) * 4;
  sheet[o] = rgba[0];
  sheet[o + 1] = rgba[1];
  sheet[o + 2] = rgba[2];
  sheet[o + 3] = rgba[3];
}

function fillRect(sheet, sheetW, sheetH, x, y, w, h, rgba) {
  for (var j = 0; j < h; j++) {
    for (var i = 0; i < w; i++) setPixel(sheet, sheetW, sheetH, x + i, y + j, rgba);
  }
}

function strokeRect(sheet, sheetW, sheetH, x, y, w, h, rgba) {
  for (var i = 0; i < w; i++) {
    setPixel(sheet, sheetW, sheetH, x + i, y, rgba);
    setPixel(sheet, sheetW, sheetH, x + i, y + h - 1, rgba);
  }
  for (var j = 0; j < h; j++) {
    setPixel(sheet, sheetW, sheetH, x, y + j, rgba);
    setPixel(sheet, sheetW, sheetH, x + w - 1, y + j, rgba);
  }
}

/**
 * Draw `text` in an opaque chip whose top-left corner is (x, y).
 *
 * Opaque rather than blended: the chip sits on top of whatever the frame
 * happens to be, and a translucent one over a busy frame is the one case where
 * the label becomes unreadable — which defeats the whole point of burning it in.
 *
 * Returns the chip's { x, y, width, height } so a caller can assert where it
 * landed.
 */
function drawLabel(sheet, sheetW, sheetH, x, y, text, scale, ink, chip) {
  var pad = 2 * scale;
  var w = textWidth(text, scale) + pad * 2;
  var h = GLYPH_H * scale + pad * 2;
  fillRect(sheet, sheetW, sheetH, x, y, w, h, chip);
  var penX = x + pad;
  for (var c = 0; c < text.length; c++) {
    var glyph = glyphFor(text.charAt(c));
    for (var col = 0; col < GLYPH_W; col++) {
      var bits = glyph[col];
      for (var row = 0; row < GLYPH_H; row++) {
        if (!(bits & (1 << row))) continue;
        fillRect(
          sheet, sheetW, sheetH,
          penX + col * scale, y + pad + row * scale,
          scale, scale, ink
        );
      }
    }
    penX += ADVANCE * scale;
  }
  return { x: x, y: y, width: w, height: h };
}

/**
 * Copy one decoded frame into a cell, converting whatever channel count it
 * arrived with to the sheet's RGBA.
 *
 * Frames larger than the cell are cropped rather than resampled. They should
 * never be — every tile in a sheet is rendered at the same downsample from the
 * same comp — but a crop keeps a surprise visible in the picture, where a
 * silent resample would make a wrong frame look like a right one.
 */
function blitTile(sheet, sheetW, sheetH, dstX, dstY, cellW, cellH, tile) {
  var ch = tile.channels;
  var w = Math.min(tile.width, cellW);
  var h = Math.min(tile.height, cellH);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var si = (y * tile.width + x) * ch;
      var r, g, b, a;
      if (ch === 1) { r = g = b = tile.pixels[si]; a = 255; }
      else if (ch === 2) { r = g = b = tile.pixels[si]; a = tile.pixels[si + 1]; }
      else if (ch === 3) { r = tile.pixels[si]; g = tile.pixels[si + 1]; b = tile.pixels[si + 2]; a = 255; }
      else { r = tile.pixels[si]; g = tile.pixels[si + 1]; b = tile.pixels[si + 2]; a = tile.pixels[si + 3]; }
      var o = ((dstY + y) * sheetW + (dstX + x)) * 4;
      sheet[o] = r;
      sheet[o + 1] = g;
      sheet[o + 2] = b;
      sheet[o + 3] = a;
    }
  }
}

/**
 * Compose the sheet.
 *
 * `tiles` is one entry per *requested* time, in order:
 *   { time, status, pixels?, width?, height?, channels?, note? }
 * where status is "ok" for a frame that rendered and anything in STATUS_FILL
 * ("empty", "stale", "failed") for one that did not.
 *
 * `opts.cellWidth`/`cellHeight` are what a tile is expected to measure — passed
 * in rather than taken from the first tile, because the first tile is exactly
 * the one that may have failed and have no dimensions at all.
 *
 * Returns { buffer, width, height, cols, rows, cellWidth, cellHeight, tiles },
 * where each entry of `tiles` carries the cell rectangle it was drawn into.
 */
function composeContactSheet(tiles, opts) {
  if (!tiles || !tiles.length) throw new Error("composeContactSheet needs at least one tile");
  var o = opts || {};
  var cellW = o.cellWidth;
  var cellH = o.cellHeight;
  for (var t = 0; t < tiles.length; t++) {
    if (tiles[t].status === "ok" && tiles[t].width && tiles[t].height) {
      // A rendered frame is the authority on its own size; the expectation is
      // only a fallback for the cells that have no picture.
      if (tiles[t].width > cellW) cellW = tiles[t].width;
      if (tiles[t].height > cellH) cellH = tiles[t].height;
    }
  }
  if (!(cellW > 0) || !(cellH > 0)) throw new Error("composeContactSheet needs a positive cell size");

  var lay = layoutFor(tiles.length);
  var cols = lay.cols;
  var rows = lay.rows;
  var gutter = o.gutter === undefined ? GUTTER : o.gutter;
  var sheetW = cols * cellW + (cols + 1) * gutter;
  var sheetH = rows * cellH + (rows + 1) * gutter;

  var sheet = Buffer.alloc(sheetW * sheetH * 4);
  fillRect(sheet, sheetW, sheetH, 0, 0, sheetW, sheetH, BACKGROUND);

  // One label size for the whole sheet, from the cell width, so every tile is
  // annotated identically and a 4K sheet does not get a 6px caption.
  var scale = o.labelScale;
  if (!scale) scale = Math.max(1, Math.min(4, Math.round(cellW / 300)));

  var out = [];
  for (var i = 0; i < tiles.length; i++) {
    var tile = tiles[i];
    var col = i % cols;
    var row = Math.floor(i / cols);
    var x = gutter + col * (cellW + gutter);
    var y = gutter + row * (cellH + gutter);

    if (tile.status === "ok" && tile.pixels) {
      blitTile(sheet, sheetW, sheetH, x, y, cellW, cellH, tile);
    } else {
      var fill = STATUS_FILL[tile.status] || STATUS_FILL.failed;
      fillRect(sheet, sheetW, sheetH, x, y, cellW, cellH, fill);
    }
    strokeRect(sheet, sheetW, sheetH, x, y, cellW, cellH, TILE_BORDER);

    var text = formatTime(tile.time);
    if (tile.status !== "ok") text += " " + String(tile.status).toUpperCase();
    var chip = drawLabel(
      sheet, sheetW, sheetH,
      x + gutter, y + gutter,
      text, scale,
      [255, 255, 255, 255], [0, 0, 0, 255]
    );

    out.push({
      time: tile.time,
      status: tile.status,
      x: x,
      y: y,
      width: cellW,
      height: cellH,
      label: text,
      labelRect: chip,
      note: tile.note,
    });
  }

  return {
    buffer: pngCodec.encodePng8(sheetW, sheetH, 6, sheet),
    width: sheetW,
    height: sheetH,
    cols: cols,
    rows: rows,
    cellWidth: cellW,
    cellHeight: cellH,
    tiles: out,
  };
}

module.exports = {
  composeContactSheet: composeContactSheet,
  // Exported for the tests, which have to be able to state the expected sheet
  // size without re-deriving the layout from the code under test.
  layoutFor: layoutFor,
  formatTime: formatTime,
  textWidth: textWidth,
  GLYPH_H: GLYPH_H,
  GUTTER: GUTTER,
};
