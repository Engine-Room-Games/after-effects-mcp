// contactSheet.ts — tile several rendered frames into one labelled sheet.
//
// Ported from the panel's `client/contactsheet.js` when the server took over
// composing contact sheets (issue #220 stage 4). The panel's copy was deleted
// in issue #243; this is the only one.
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
// character. The server already decodes and re-encodes frames for the 16-bit
// conversion (pngCodec.ts), so the sheet is a few hundred lines on top of
// machinery that exists.
//
// Two rules the layout has to keep:
//
//   * Every requested time gets a cell, in order, whether or not it rendered.
//     A sheet that silently drops the tile that failed no longer maps onto the
//     times that were asked for, and an agent counting tiles left to right
//     would read the wrong frame as the right one.
//   * The time is burned into the picture. Metadata beside an image is not
//     what a model looks at when it is comparing three frames.

import { encodePng8 } from "./pngCodec.js";

type Rgba = [number, number, number, number];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

// Columns per tile count. Not a formula, because the two things a formula gets
// wrong are the ones that matter: three frames of an animation read as a strip
// and should stay on one row, and five should not leave a hole in the middle of
// a 2-wide grid. Two to six is the whole domain — the schema caps `times` there
// — so the table is complete rather than a heuristic.
const COLUMNS_FOR: Record<number, number> = { 2: 2, 3: 3, 4: 2, 5: 3, 6: 3 };

export function layoutFor(count: number): { cols: number; rows: number } {
  let cols = COLUMNS_FOR[count];
  if (!cols) cols = Math.ceil(Math.sqrt(count));
  return { cols: cols, rows: Math.ceil(count / cols) };
}

// The gutter is opaque on purpose. A transparent one would be invisible behind
// a transparent overlay comp — which is exactly the kind of comp somebody
// screenshots three times — and the tiles would run together.
export const GUTTER = 4;
const BACKGROUND: Rgba = [38, 38, 38, 255];
const TILE_BORDER: Rgba = [150, 150, 150, 255];

// Flat blocks for the cells that have no picture. Each carries its status word
// in the label chip as well; the colour alone is a hint, never the statement.
const STATUS_FILL: Record<string, Rgba> = {
  empty: [22, 22, 28, 255],
  stale: [74, 30, 30, 255],
  failed: [74, 50, 20, 255],
};

// ---------------------------------------------------------------------------
// A 5x7 bitmap font, five column bytes per glyph, bit 0 = top row.
//
// Burning text into a frame needs a font, and a font file would be a second
// thing to ship and keep in sync with the panel's copy. Fifty glyphs of pixels
// weigh nothing and render identically on both platforms, which a system font
// would not.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
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
const GLYPH_W = 5;
export const GLYPH_H = 7;
const ADVANCE = GLYPH_W + 1;

function glyphFor(ch: string): number[] {
  if (FONT[ch]) return FONT[ch];
  const up = ch.toUpperCase();
  if (FONT[up]) return FONT[up];
  return FONT[" "];
}

/** Width in pixels of `text` at `scale`, with no trailing inter-glyph gap. */
export function textWidth(text: string, scale: number): number {
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
export function formatTime(t: unknown): string {
  if (typeof t !== "number" || !isFinite(t)) return "?s";
  let s = t.toFixed(3);
  // Trim the zeros the fixed form adds, but never the digit before the point.
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s + "s";
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function setPixel(sheet: Buffer, sheetW: number, sheetH: number, x: number, y: number, rgba: Rgba): void {
  if (x < 0 || y < 0 || x >= sheetW || y >= sheetH) return;
  const o = (y * sheetW + x) * 4;
  sheet[o] = rgba[0];
  sheet[o + 1] = rgba[1];
  sheet[o + 2] = rgba[2];
  sheet[o + 3] = rgba[3];
}

function fillRect(
  sheet: Buffer, sheetW: number, sheetH: number,
  x: number, y: number, w: number, h: number, rgba: Rgba,
): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) setPixel(sheet, sheetW, sheetH, x + i, y + j, rgba);
  }
}

function strokeRect(
  sheet: Buffer, sheetW: number, sheetH: number,
  x: number, y: number, w: number, h: number, rgba: Rgba,
): void {
  for (let i = 0; i < w; i++) {
    setPixel(sheet, sheetW, sheetH, x + i, y, rgba);
    setPixel(sheet, sheetW, sheetH, x + i, y + h - 1, rgba);
  }
  for (let j = 0; j < h; j++) {
    setPixel(sheet, sheetW, sheetH, x, y + j, rgba);
    setPixel(sheet, sheetW, sheetH, x + w - 1, y + j, rgba);
  }
}

export interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
function drawLabel(
  sheet: Buffer, sheetW: number, sheetH: number,
  x: number, y: number, text: string, scale: number, ink: Rgba, chip: Rgba,
): LabelRect {
  const pad = 2 * scale;
  const w = textWidth(text, scale) + pad * 2;
  const h = GLYPH_H * scale + pad * 2;
  fillRect(sheet, sheetW, sheetH, x, y, w, h, chip);
  let penX = x + pad;
  for (let c = 0; c < text.length; c++) {
    const glyph = glyphFor(text.charAt(c));
    for (let col = 0; col < GLYPH_W; col++) {
      const bits = glyph[col];
      for (let row = 0; row < GLYPH_H; row++) {
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
 * One entry per *requested* time, in order. `status` is "ok" for a frame that
 * rendered and anything in STATUS_FILL ("empty", "stale", "failed") for one
 * that did not.
 */
export interface ContactSheetTile {
  time: number;
  status: string;
  pixels?: Uint8Array | null;
  width?: number;
  height?: number;
  channels?: number;
  note?: string;
}

export interface ContactSheetOptions {
  cellWidth?: number;
  cellHeight?: number;
  gutter?: number;
  labelScale?: number;
}

export interface ContactSheetCell {
  time: number;
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  labelRect: LabelRect;
  note: string | undefined;
}

export interface ContactSheet {
  buffer: Buffer;
  width: number;
  height: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  tiles: ContactSheetCell[];
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
function blitTile(
  sheet: Buffer, sheetW: number, sheetH: number,
  dstX: number, dstY: number, cellW: number, cellH: number, tile: ContactSheetTile,
): void {
  const ch = tile.channels as number;
  const tileW = tile.width as number;
  const px = tile.pixels as Uint8Array;
  const w = Math.min(tileW, cellW);
  const h = Math.min(tile.height as number, cellH);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * tileW + x) * ch;
      let r: number, g: number, b: number, a: number;
      if (ch === 1) { r = g = b = px[si]; a = 255; }
      else if (ch === 2) { r = g = b = px[si]; a = px[si + 1]; }
      else if (ch === 3) { r = px[si]; g = px[si + 1]; b = px[si + 2]; a = 255; }
      else { r = px[si]; g = px[si + 1]; b = px[si + 2]; a = px[si + 3]; }
      const o = ((dstY + y) * sheetW + (dstX + x)) * 4;
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
export function composeContactSheet(tiles: ContactSheetTile[], opts?: ContactSheetOptions): ContactSheet {
  if (!tiles || !tiles.length) throw new Error("composeContactSheet needs at least one tile");
  const o = opts || {};
  let cellW = o.cellWidth as number;
  let cellH = o.cellHeight as number;
  for (let t = 0; t < tiles.length; t++) {
    const tw = tiles[t].width;
    const th = tiles[t].height;
    if (tiles[t].status === "ok" && tw && th) {
      // A rendered frame is the authority on its own size; the expectation is
      // only a fallback for the cells that have no picture.
      if (tw > cellW) cellW = tw;
      if (th > cellH) cellH = th;
    }
  }
  if (!(cellW > 0) || !(cellH > 0)) throw new Error("composeContactSheet needs a positive cell size");

  const lay = layoutFor(tiles.length);
  const cols = lay.cols;
  const rows = lay.rows;
  const gutter = o.gutter === undefined ? GUTTER : o.gutter;
  const sheetW = cols * cellW + (cols + 1) * gutter;
  const sheetH = rows * cellH + (rows + 1) * gutter;

  const sheet = Buffer.alloc(sheetW * sheetH * 4);
  fillRect(sheet, sheetW, sheetH, 0, 0, sheetW, sheetH, BACKGROUND);

  // One label size for the whole sheet, from the cell width, so every tile is
  // annotated identically and a 4K sheet does not get a 6px caption.
  let scale = o.labelScale as number;
  if (!scale) scale = Math.max(1, Math.min(4, Math.round(cellW / 300)));

  const out: ContactSheetCell[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gutter + col * (cellW + gutter);
    const y = gutter + row * (cellH + gutter);

    if (tile.status === "ok" && tile.pixels) {
      blitTile(sheet, sheetW, sheetH, x, y, cellW, cellH, tile);
    } else {
      const fill = STATUS_FILL[tile.status] || STATUS_FILL.failed;
      fillRect(sheet, sheetW, sheetH, x, y, cellW, cellH, fill);
    }
    strokeRect(sheet, sheetW, sheetH, x, y, cellW, cellH, TILE_BORDER);

    let text = formatTime(tile.time);
    if (tile.status !== "ok") text += " " + String(tile.status).toUpperCase();
    const chip = drawLabel(
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
    buffer: encodePng8(sheetW, sheetH, 6, sheet),
    width: sheetW,
    height: sheetH,
    cols: cols,
    rows: rows,
    cellWidth: cellW,
    cellHeight: cellH,
    tiles: out,
  };
}

// ---------------------------------------------------------------------------
// The sheet's overall deadline (issue #163)
// ---------------------------------------------------------------------------

// Every tile is read with the single-frame budget (120s) and may be re-rendered
// once, one after another, so six slow tiles could wait far past the server's
// 300s ceiling for screenshot_frame. The server would then report a bridge
// timeout — "do not re-send, After Effects is busy" — for a sheet that was
// still being assembled, and the tiles that had rendered were thrown away with
// it. One deadline for the whole sheet, comfortably under that ceiling, turns
// that into a sheet whose late tiles are marked blocks that say why.
export const CONTACT_SHEET_BUDGET_MS = 240000;

// Below this, a tile is not worth starting: the read could not finish and the
// re-render could not even begin.
const MIN_TILE_BUDGET_MS = 1000;

// The least time a FRAME_INCOMPLETE tile must have left to be re-rendered at
// all: a render plus a read inside it, not a render that starts and is cut off.
export const RETRY_MIN_MS = 15000;

// How long the next tile read may wait: what is left of the sheet's deadline,
// capped at the per-frame budget. 0 means do not start it.
export function tileBudgetMs(deadline: number, now: number, perFrameMs: number): number {
  const left = deadline - now;
  if (left < MIN_TILE_BUDGET_MS) return 0;
  return Math.min(left, perFrameMs);
}
