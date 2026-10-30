/**
 * Screenshots, contact sheets and `.mogrt` thumbnails, finished on the server
 * (issue #220, stage 4).
 *
 * After Effects renders; everything after the render is file work, and it used
 * to happen in the panel (`packages/ae-panel/client/main.js`). A panel that
 * reports the `server-images` capability answers `_screenshot_frame`,
 * `_screenshot_layer` and `_export_mogrt` with the temp paths ExtendScript
 * wrote and nothing else, and this module does what the panel did with them:
 * waits for each PNG to be finished, normalises it, refuses a re-served render
 * buffer, tiles a contact sheet, and folds a poster frame into a template.
 * Images no longer cross the bridge as base64.
 *
 * Every result has the shape the panel produced, field for field and byte for
 * byte, so `server.ts` packages it the same way whichever side did the work —
 * `tests/unit/image-parity.mjs` runs both on the same renders. The panel keeps
 * its copy for MCP servers that predate this one.
 *
 * Two things changed shape with the move, both documented in
 * docs/fragile-areas-bridge.md: the stale-frame window is a file shared by
 * every server on the same panel port (sharedFrameCache.ts) rather than the
 * panel's memory, and a frame retry is a second `/op` read rather than a
 * second `evalScript` inside one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { AeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { normalizePng, decodePng8, unpremultiply8, alphaIndexFor } from "./pngCodec.js";
import {
  waitForCompletePng,
  dressFrameError,
  frameError,
  unlinkQuietly,
  FRAME_RENDER_BUDGET_MS,
  type FrameError,
} from "./frameReader.js";
import { createFrameCache, type FrameCacheMatch, type FrameCacheMeta } from "./frameCache.js";
import {
  composeContactSheet,
  tileBudgetMs,
  formatTime,
  CONTACT_SHEET_BUDGET_MS,
  RETRY_MIN_MS,
} from "./contactSheet.js";
import { patchThumbnail } from "./mogrtThumbnail.js";

/** The ops a `server-images` panel answers with paths, keyed by the tool they stand in for. */
export const RAW_IMAGE_OPS = {
  screenshot_frame: "_screenshot_frame",
  screenshot_layer: "_screenshot_layer",
  export_mogrt: "_export_mogrt",
} as const;
export type ImageTool = keyof typeof RAW_IMAGE_OPS;
export type RawImageOp = (typeof RAW_IMAGE_OPS)[ImageTool];

/** Sends one raw op to the panel (through the typed internal sender). */
export type SendRaw = (op: RawImageOp, args: unknown) => Promise<unknown>;

export interface FramePipelineOptions {
  /** Where warnings go. Defaults to the server's stderr logger. */
  warn?: (message: string) => void;
  /** Overrides for the frame reader's timing; tests only. */
  frameRead?: { stallMs?: number; pollMs?: number; budgetMs?: number };
  /** Overrides the contact sheet's overall budget; tests only. */
  sheetBudgetMs?: number;
  /**
   * The stale-frame window. The server passes the one shared by every server
   * on the same panel port (sharedFrameCache.ts); the default, a window of
   * this pipeline's own, is for tests.
   */
  frameCache?: {
    match(key: string, hash: string): FrameCacheMatch | null;
    remember(key: string, hash: string, meta?: FrameCacheMeta | null): void;
  };
}

interface FrameInfo {
  path: string;
  width: number;
  height: number;
  downsample: number;
  time: number;
  compId: number;
  layerId?: number;
}

interface SheetInfo {
  contactSheet: true;
  tiles?: { time: number; downsample?: number; path?: string; error?: string }[];
  downsample: number;
  width: number;
  height: number;
  compId: number;
  times?: number[];
}

interface ReadFrame {
  buffer?: Buffer;
  width: number | null;
  height: number | null;
  empty: boolean;
  converted?: boolean;
  sourceBitDepth?: number;
  pixels?: Buffer | null;
  channels?: number;
  hash?: string;
  warning?: string;
}

interface SheetRead {
  time: number;
  status: string;
  note?: string;
  img?: ReadFrame | null;
  key?: string;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Pixel dimensions from IHDR, so what is reported is always what was sent. */
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A failure this module diagnosed, in the shape the panel's own failures reach `server.ts`. */
function asAeError(err: unknown): unknown {
  const e = err as FrameError | undefined;
  if (e && !(e instanceof AeError) && (e.code === "FRAME_INCOMPLETE" || e.code === "RENDER_TIMEOUT")) {
    return new AeError(e.message, undefined, undefined, e.code);
  }
  return err;
}

/** The request identity a render is expected to be unique to — from what ExtendScript resolved. */
function frameKey(op: string, info: { compId: number; layerId?: number | null; time: number; downsample: number }): string {
  const layer = info.layerId === undefined || info.layerId === null ? "-" : info.layerId;
  return [op, info.compId, layer, Number(info.time).toFixed(6), info.downsample].join("|");
}
function frameLabel(info: { compId: number; layerId?: number | null; time: number; downsample: number }): string {
  return (
    "comp " + info.compId +
    (info.layerId === undefined || info.layerId === null ? "" : " layer " + info.layerId) +
    " @ " + Number(info.time).toFixed(3) + "s downsample " + info.downsample
  );
}

// An error rather than a warning attached to the image, because an agent that
// can see the picture will believe the picture. Same text the panel sends.
function staleFrameError(label: string, match: { label: string; bytes: number; ageMs: number }, bytes: number): AeError {
  const ago = Math.max(1, Math.round(match.ageMs / 1000));
  return new AeError(
    "Stale frame: After Effects returned pixels identical to an earlier, different " +
      "request (" + match.label + ", " + match.bytes + " bytes, " + ago + "s ago), so this " +
      "image is not a picture of " + label + " (" + bytes + " bytes) and has not been sent.\n" +
      "\n" +
      "What to do next:\n" +
      "1. Wait a few seconds — back-to-back screenshots trigger this far more often.\n" +
      "2. Retry with a higher `downsample` (6 has worked where 3-4 stayed stale).\n" +
      "3. If it repeats, verify the animation by reading keyframes (get_keyframes / " +
      "get_layer_full) instead. That is exact; a picture is not.\n" +
      "\n" +
      "Do NOT start disabling layers to make the render succeed: this is a limit of the " +
      "panel's render path, not a problem with the project. If those two frames really " +
      "are identical — a static comp — a different `downsample` will render a different " +
      "number of pixels and confirm it.",
    undefined,
    undefined,
    "STALE_FRAME"
  );
}

/** One line, for a note inside a tile rather than a whole error message. */
function shortReason(err: unknown): string {
  const e = err as FrameError | undefined;
  const s = e && e.detail ? e.detail : e && e.message ? e.message : String(err);
  return String(s).split("\n")[0];
}

/**
 * One per server. The stale-frame window comes in through `opts.frameCache`.
 */
export function createFramePipeline(opts: FramePipelineOptions = {}) {
  const warn = opts.warn ?? ((m: string) => logger.warn(m));
  const readOpts = opts.frameRead ?? {};
  const sheetBudget = opts.sheetBudgetMs ?? CONTACT_SHEET_BUDGET_MS;
  const frameCache = opts.frameCache ?? createFrameCache();

  /**
   * Wait for the PNG, normalise it, and hand back what the result needs. The
   * reader owns the temp file and removes it on every path.
   */
  async function readPngFrame(file: string, o: { budgetMs?: number } = {}): Promise<ReadFrame> {
    const buf = await waitForCompletePng(file, { ...readOpts, ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}) });
    let norm: ReturnType<typeof normalizePng>;
    try {
      norm = normalizePng(buf);
    } catch (e) {
      const msg = (e as Error).message;
      // The completeness gate guarantees a well-formed IEND, so a truncation
      // here means the gate is broken: refuse rather than ship.
      if (/truncated PNG/.test(msg)) {
        throw frameError("FRAME_INCOMPLETE", "the file passed the completeness check and then failed to parse (" + msg + ")");
      }
      // A complete PNG this parser cannot read is still a PNG the client might.
      warn("could not normalise the frame (" + msg + "); sending it unconverted");
      const dims = pngDimensions(buf);
      return {
        buffer: buf,
        width: dims ? dims.width : null,
        height: dims ? dims.height : null,
        empty: false,
        hash: sha256(buf),
        warning:
          "This frame could not be normalised to 8-bit (" + msg +
          ") and was sent exactly as After Effects wrote it. If it fails to decode, " +
          "that is why.",
      };
    }
    if (norm.empty) return { empty: true, width: norm.width, height: norm.height };
    return {
      buffer: norm.buffer as Buffer,
      width: norm.width,
      height: norm.height,
      empty: false,
      converted: norm.converted,
      sourceBitDepth: norm.bitDepth,
      // Already straight alpha (#130): the sheet must not convert them again.
      pixels: norm.pixels,
      channels: norm.channels,
      // Of the samples as After Effects wrote them, before un-premultiplying.
      hash: sha256(norm.hashInput),
      warning: norm.passthrough
        ? "This frame's pixels were not inspected (" + norm.passthrough +
          "), so it was sent exactly as After Effects wrote it."
        : undefined,
    };
  }

  async function renderFrameOnce(send: SendRaw, raw: RawImageOp, args: unknown) {
    const info = (await send(raw, args)) as FrameInfo;
    if (!info || typeof info.path !== "string") {
      throw new Error(`${raw} answered without a frame path; nothing was rendered to read.`);
    }
    const img = await readPngFrame(info.path);
    return { info, img };
  }

  /**
   * Render, and re-render exactly once if what came back was corrupt — never on
   * a timeout (see "Screenshots and frame integrity", fragile-areas-bridge.md).
   * Both screenshot ops are read-only, so a second run is indistinguishable from
   * one. The retry is a second `/op`, and ExtendScript names a fresh temp file.
   */
  async function renderFrameWithRetry(send: SendRaw, raw: RawImageOp, op: string, args: unknown) {
    try {
      return await renderFrameOnce(send, raw, args);
    } catch (first) {
      if ((first as FrameError).code !== "FRAME_INCOMPLETE") throw dressFrameError(first as FrameError, 1);
      warn(op + ": " + (first as FrameError).detail + " — re-rendering once");
      try {
        return await renderFrameOnce(send, raw, args);
      } catch (second) {
        throw dressFrameError(second as FrameError, 2);
      }
    }
  }

  async function singleFrame(send: SendRaw, op: "screenshot_frame" | "screenshot_layer", args: unknown) {
    const { info, img } = await renderFrameWithRetry(send, RAW_IMAGE_OPS[op], op, args);
    if (img.empty) {
      return {
        empty: true,
        width: img.width,
        height: img.height,
        fullWidth: info.width,
        fullHeight: info.height,
        downsample: info.downsample,
        time: info.time,
        compId: info.compId,
        layerId: info.layerId,
        reason:
          "Every pixel of this frame is fully transparent — the frame is empty. " +
          "No image was sent because there is nothing in it to see. Usually this means " +
          "the time is outside the layers' in/out points, the layers are disabled or " +
          "have zero opacity, or the wrong comp was addressed.",
      };
    }
    const buffer = img.buffer as Buffer;
    // Only a frame that read cleanly ever reaches the cache (#45).
    const key = frameKey(op, info);
    const match = frameCache.match(key, img.hash as string);
    if (match) throw staleFrameError(frameLabel(info), match, buffer.length);
    frameCache.remember(key, img.hash as string, { label: frameLabel(info), bytes: buffer.length });
    return {
      width: img.width,
      height: img.height,
      fullWidth: info.width,
      fullHeight: info.height,
      downsample: info.downsample,
      time: info.time,
      compId: info.compId,
      layerId: info.layerId,
      mimeType: "image/png",
      base64: buffer.toString("base64"),
      bytes: buffer.length,
      converted: img.converted ? true : undefined,
      sourceBitDepth: img.converted ? img.sourceBitDepth : undefined,
      warning: img.warning,
    };
  }

  // ---------- Contact sheet ----------

  function sheetOutOfTime(tile: { time: number }): SheetRead {
    return {
      time: tile.time,
      status: "failed",
      note:
        "not read: the contact sheet's overall time limit (" +
        Math.round(sheetBudget / 1000) + "s) ran out before this tile",
    };
  }

  async function readSheetTile(
    send: SendRaw,
    info: SheetInfo,
    tile: { time: number; path?: string; error?: string },
    deadline: number
  ): Promise<SheetRead> {
    if (tile.error) return { time: tile.time, status: "failed", note: tile.error };
    const budget = tileBudgetMs(deadline, Date.now(), FRAME_RENDER_BUDGET_MS);
    if (!budget) {
      unlinkQuietly(tile.path as string);
      return sheetOutOfTime(tile);
    }
    let err: unknown;
    try {
      return { time: tile.time, status: "ok", img: await readPngFrame(tile.path as string, { budgetMs: budget }) };
    } catch (e) {
      err = e;
    }
    if ((err as FrameError).code !== "FRAME_INCOMPLETE") {
      return { time: tile.time, status: "failed", note: shortReason(err) };
    }
    if (deadline - Date.now() < RETRY_MIN_MS) {
      return {
        time: tile.time,
        status: "failed",
        note: shortReason(err) + "; too little of the sheet's time limit left to re-render it",
      };
    }
    // The same bounded retry the single-frame path gets, for this one time, at
    // the sheet's already-derived downsample.
    warn("contact sheet tile at " + tile.time + "s: " + shortReason(err) + " — re-rendering once");
    let outOfTime = false;
    const rerender = send(RAW_IMAGE_OPS.screenshot_frame, {
      compId: info.compId,
      time: tile.time,
      downsample: info.downsample,
    }) as Promise<FrameInfo>;
    // A render that answers after the deadline has its file removed.
    rerender.then(
      (late) => {
        if (outOfTime && late && late.path) unlinkQuietly(late.path);
      },
      () => {}
    );
    let timer: NodeJS.Timeout | undefined;
    const expire = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        outOfTime = true;
        resolve(null);
      }, Math.max(0, deadline - Date.now()));
    });
    try {
      const retry = await Promise.race([rerender, expire]);
      clearTimeout(timer);
      if (!retry) return sheetOutOfTime(tile);
      const left = tileBudgetMs(deadline, Date.now(), FRAME_RENDER_BUDGET_MS);
      if (!left) {
        unlinkQuietly(retry.path);
        return sheetOutOfTime(tile);
      }
      return { time: tile.time, status: "ok", img: await readPngFrame(retry.path, { budgetMs: left }) };
    } catch (again) {
      clearTimeout(timer);
      return { time: tile.time, status: "failed", note: shortReason(again) };
    }
  }

  function finishContactSheet(info: SheetInfo, read: SheetRead[]) {
    const ds = info.downsample;
    // Pass one: classify. Every `match` before any `remember`, so a sheet's own
    // tiles cannot collide with each other through the cache.
    const seen: Record<string, number> = {};
    for (const t of read) {
      if (t.status !== "ok" || !t.img) continue;
      if (t.img.empty) {
        t.status = "empty";
        t.img = null;
        continue;
      }
      t.key = frameKey("screenshot_frame", { compId: info.compId, layerId: null, time: t.time, downsample: ds });
      const hash = t.img.hash as string;
      const match = frameCache.match(t.key, hash);
      if (match) {
        t.status = "stale";
        t.note =
          "identical to " + match.label + ", rendered " + Math.max(1, Math.round(match.ageMs / 1000)) + "s earlier";
        t.img = null;
        continue;
      }
      // Two tiles of one sheet matching each other is a static comp: flagged, not refused.
      if (seen[hash] !== undefined) {
        t.note = "pixel-identical to the " + formatTime(seen[hash]) + " tile — nothing changed between them";
      } else {
        seen[hash] = t.time;
      }
    }

    const specs: {
      time: number; status: string; note?: string;
      pixels?: Buffer; channels?: number; width?: number | null; height?: number | null;
    }[] = [];
    let ok = 0;
    for (const r of read) {
      const spec: (typeof specs)[number] = { time: r.time, status: r.status, note: r.note };
      if (r.status === "ok" && r.img) {
        let px = r.img.pixels;
        let channels = r.img.channels;
        if (!px) {
          // The passthrough path never interpreted the pixels; decode strictly
          // here and convert from premultiplied exactly once.
          try {
            const dec = decodePng8(r.img.buffer as Buffer);
            px = unpremultiply8(dec.pixels, dec.channels, alphaIndexFor(dec.colorType), dec.width * dec.height);
            channels = dec.channels;
          } catch (e) {
            spec.status = "failed";
            r.status = "failed";
            spec.note = "the frame could not be decoded for tiling (" + (e as Error).message + ")";
          }
        }
        if (spec.status === "ok") {
          spec.pixels = px as Buffer;
          spec.channels = channels;
          spec.width = r.img.width;
          spec.height = r.img.height;
          ok++;
        }
      }
      specs.push(spec);
    }

    if (!ok) {
      const why = specs.map((s) => formatTime(s.time) + ": " + s.status + (s.note ? " (" + s.note + ")" : ""));
      throw new AeError(
        "No tile of the contact sheet rendered, so there is no sheet to send. Per time:\n" +
          why.join("\n") + "\n\n" +
          "A sheet of coloured blocks is not a screenshot. Retry at a higher `downsample`, " +
          "or screenshot the shot precomps one at a time; if it repeats, read keyframes " +
          "(get_keyframes / get_layer_full) instead.",
        undefined,
        undefined,
        "CONTACT_SHEET_FAILED"
      );
    }

    const sheet = composeContactSheet(specs as Parameters<typeof composeContactSheet>[0], {
      cellWidth: Math.round(info.width / ds),
      cellHeight: Math.round(info.height / ds),
    });

    // Only what is actually being delivered goes into the cache.
    for (const r of read) {
      if (r.status === "ok" && r.key && r.img) {
        frameCache.remember(r.key, r.img.hash as string, {
          label: frameLabel({ compId: info.compId, time: r.time, downsample: ds }),
          bytes: (r.img.buffer as Buffer).length,
        });
      }
    }

    const bad: string[] = [];
    for (const t of sheet.tiles) {
      if (t.status !== "ok") bad.push(t.label + (t.note ? " — " + t.note : ""));
    }

    return {
      contactSheet: true,
      width: sheet.width,
      height: sheet.height,
      cols: sheet.cols,
      rows: sheet.rows,
      cellWidth: sheet.cellWidth,
      cellHeight: sheet.cellHeight,
      fullWidth: info.width,
      fullHeight: info.height,
      downsample: ds,
      compId: info.compId,
      tiles: sheet.tiles,
      mimeType: "image/png",
      base64: sheet.buffer.toString("base64"),
      bytes: sheet.buffer.length,
      warning: bad.length
        ? bad.length + " of " + sheet.tiles.length + " tiles are marked blocks, not frames: " + bad.join("; ")
        : undefined,
    };
  }

  async function contactSheet(send: SendRaw, args: unknown) {
    // Started before the render, as the panel's was.
    const deadline = Date.now() + sheetBudget;
    const info = (await send(RAW_IMAGE_OPS.screenshot_frame, args)) as SheetInfo;
    const read: SheetRead[] = [];
    // In order: a per-tile retry re-enters After Effects, and the panel's
    // evalScript chain would serialise them anyway.
    for (const tile of info.tiles ?? []) read.push(await readSheetTile(send, info, tile, deadline));
    return finishContactSheet(info, read);
  }

  // ---------- Motion Graphics template thumbnail ----------

  /**
   * Fold the rendered poster frame into the exported `.mogrt`. A failed patch
   * is reported on the successful result, never thrown: the template is
   * already written and valid. Runs inside export_mogrt's call, so its write
   * lease covers the rewrite.
   */
  async function patchMogrt(info: { path: string; posterPngPath: string; posterTime?: number }) {
    try {
      // The same completeness gate as a screenshot; it takes the poster file with it.
      const poster = await waitForCompletePng(info.posterPngPath, readOpts);
      const patched = patchThumbnail(fs.readFileSync(info.path), poster);
      // Sibling temp file and rename: an interrupted write cannot leave a
      // half-rewritten template where a valid one was.
      const tmp = info.path + ".tmp-thumb";
      try {
        fs.writeFileSync(tmp, patched.buffer);
        fs.renameSync(tmp, info.path);
      } catch (e) {
        unlinkQuietly(tmp);
        throw e;
      }
      return {
        patched: true,
        posterTime: info.posterTime,
        width: patched.width,
        height: patched.height,
        sourceWidth: patched.sourceWidth,
        sourceHeight: patched.sourceHeight,
        letterboxed: patched.letterboxed || undefined,
      };
    } catch (e) {
      unlinkQuietly(info.posterPngPath);
      warn("could not patch the .mogrt thumbnail: " + (e as Error).message);
      return {
        patched: false,
        posterTime: info.posterTime,
        reason:
          "The template exported correctly, but its thumbnail could not be replaced (" +
          (e as Error).message + "). It still shows the one After Effects wrote.",
      };
    }
  }

  async function exportMogrt(send: SendRaw, args: unknown) {
    const info = (await send(RAW_IMAGE_OPS.export_mogrt, args)) as Record<string, unknown> | null;
    if (!info || typeof info.posterPngPath !== "string") return info;
    const thumbnail = await patchMogrt(info as unknown as { path: string; posterPngPath: string; posterTime?: number });
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(info)) if (k !== "posterPngPath") out[k] = info[k];
    out.thumbnail = thumbnail;
    // The size changed with the thumbnail; report the one on disk.
    try {
      out.bytes = fs.statSync(info.path as string).size;
    } catch {
      /* keep After Effects' figure */
    }
    return out;
  }

  return {
    /**
     * Run one image tool through the raw op and finish it here. Resolves with
     * the panel's result shape; rejects with an AeError carrying `code` for a
     * failure diagnosed here, exactly as the panel's would arrive.
     */
    async run(tool: ImageTool, args: unknown, send: SendRaw): Promise<unknown> {
      try {
        if (tool === "export_mogrt") return await exportMogrt(send, args);
        const a = args as { times?: unknown[] } | undefined;
        if (tool === "screenshot_frame" && a && Array.isArray(a.times) && a.times.length) {
          return await contactSheet(send, args);
        }
        return await singleFrame(send, tool, args);
      } catch (e) {
        throw asAeError(e);
      }
    },
  };
}

export type FramePipeline = ReturnType<typeof createFramePipeline>;
