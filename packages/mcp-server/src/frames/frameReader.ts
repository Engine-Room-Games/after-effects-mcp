// frameReader.ts — wait for After Effects to finish writing a frame.
//
// This is the MCP server's copy of `packages/ae-panel/client/framereader.js`
// (issue #220 stage 4: the server now reads rendered frames itself). The panel
// keeps its copy for legacy MCP servers that still ask it to, and the two must
// behave identically — tests/unit/image-parity.mjs holds them together. Change
// both or neither.
//
// `saveFrameToPng` is asynchronous: it returns before the bytes are on disk, so
// whoever reads the frame has to decide for itself when the file is finished.
// Getting that decision wrong is issue #45.
//
// What it used to be: two `stat` calls 30ms apart reporting the same size. That
// is not completion, it is a pause — and on a heavy comp (~88 layers, nested
// precomps) the writer pauses routinely. The half-written file was read, shipped
// and reported as a successful screenshot, and the agent got `truncated PNG:
// chunk IDAT runs past the end of the file` for a render that was still
// happening. Worse, the old passthrough path hashed those truncated bytes into
// the stale-frame cache, so the next truncation at the same byte count came back
// as "stale frame" — the wrong diagnosis, with the wrong remedy, for a bug that
// was never about staleness.
//
// What it is now: a PNG is finished when it *is* a PNG — ends in a zero-length
// IEND chunk with every chunk length from the signature adding up to exactly
// that. A partial write cannot satisfy that test, so it can no longer be
// delivered; it can only time out or be reported as corrupt.
//
// The two failures are kept apart on purpose, exactly as `BridgeTimeoutError`
// and `BridgeUnreachableError` are kept apart: "the render did not finish in
// time" and "the file After Effects wrote is not a whole PNG" have opposite
// remedies, and one sentence covering both would send half the readers the
// wrong way.

import fs from "node:fs";
import { inspectPngStructure } from "./pngCodec.js";

// How long a frame that has not arrived is still allowed to be on its way. A
// cold render of a heavy 4K comp was measured taking well over 15s; the original
// 5s silently failed screenshots that were merely still rendering.
export const FRAME_RENDER_BUDGET_MS = 120000;

// How long a file may sit at exactly the same size, still not a whole PNG,
// before the write is called abandoned rather than slow.
//
// Deliberately far short of the budget above. A corrupt frame has to fail fast
// enough that one automatic re-render still fits inside the server's 300s
// ceiling for this op — and a PNG write that has begun is a few hundred KB of
// deflate output, not something that legitimately stalls for seconds.
export const FRAME_STALL_MS = 6000;

const FRAME_POLL_MS = 40;

export interface FrameError extends Error {
  code?: string;
  detail?: string;
}

export interface WaitForCompletePngOptions {
  budgetMs?: number;
  stallMs?: number;
  pollMs?: number;
}

export function frameError(code: string, detail: string): FrameError {
  const e: FrameError = new Error(detail);
  e.code = code;
  e.detail = detail;
  return e;
}

export function unlinkQuietly(file: string): void {
  try { fs.unlinkSync(file); } catch (e) {}
}

/** True when the last 12 bytes are a zero-length IEND — the file ends where a PNG ends. */
function endsWithIend(file: string, size: number): boolean {
  if (size < 12) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const tail = Buffer.alloc(12);
    fs.readSync(fd, tail, 0, 12, size - 12);
    return tail.readUInt32BE(0) === 0 && tail.toString("ascii", 4, 8) === "IEND";
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
  }
}

function readHead(file: string, n: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(n);
    const got = fs.readSync(fd, head, 0, n, 0);
    return head.subarray(0, got);
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
  }
}

/**
 * Resolve with the bytes of a complete PNG, or reject saying which failure it
 * was. The temp file is removed on every path — a file left behind is one a
 * later read could find, which is how a corrupt frame would start coming back
 * for free.
 *
 * The tail probe in front of the full read is what keeps this cheap enough to
 * run every 40ms on a multi-megabyte file: IEND is the last chunk in the
 * format, so a file whose final twelve bytes are not one is definitively
 * unfinished and does not need reading at all. The whole chunk walk still runs
 * before any bytes are returned.
 *
 * Rejections:
 *   FRAME_INCOMPLETE  the file exists, stopped changing, and is not a PNG.
 *                     Re-rendering can fix it, and this fails within stallMs.
 *   RENDER_TIMEOUT    it never got there inside the budget. Re-rendering
 *                     immediately would only spend the budget a second time.
 */
export function waitForCompletePng(file: string, opts?: WaitForCompletePngOptions): Promise<Buffer> {
  const o = opts || {};
  const budgetMs = o.budgetMs || FRAME_RENDER_BUDGET_MS;
  const stallMs = o.stallMs || FRAME_STALL_MS;
  const pollMs = o.pollMs || FRAME_POLL_MS;
  const deadline = Date.now() + budgetMs;
  return new Promise<Buffer>(function (resolve, reject) {
    let lastSize = -1;
    let lastGrewAt = Date.now();
    let headChecked = false;
    let reason = "After Effects has not written the file yet";

    function fail(code: string, detail: string): void {
      unlinkQuietly(file);
      reject(frameError(code, detail));
    }

    (function poll(): void {
      let size = -1;
      try {
        if (fs.existsSync(file)) size = fs.statSync(file).size;
      } catch (e) { size = -1; }

      if (size >= 0) {
        if (size !== lastSize) {
          lastSize = size;
          lastGrewAt = Date.now();
        }
        // Something that is not a PNG at all will not become one by gaining
        // bytes. Say so now rather than at the end of a two-minute budget.
        if (!headChecked && size >= 8) {
          headChecked = true;
          const head = readHead(file, 8);
          if (head) {
            const early = inspectPngStructure(head);
            if (!early.complete && !early.growable) return fail("FRAME_INCOMPLETE", early.reason as string);
          }
        }
        if (endsWithIend(file, size)) {
          let buf: Buffer | null = null;
          try { buf = fs.readFileSync(file); } catch (e) { buf = null; }
          if (buf) {
            const st = inspectPngStructure(buf);
            if (st.complete) {
              unlinkQuietly(file);
              return resolve(buf);
            }
            if (!st.growable) return fail("FRAME_INCOMPLETE", st.reason as string);
            reason = st.reason as string;
          }
        } else if (size > 0) {
          reason = "the file reached " + size + " bytes with no IEND chunk";
        }
        if (size > 0 && Date.now() - lastGrewAt > stallMs) {
          return fail(
            "FRAME_INCOMPLETE",
            "After Effects wrote " + size + " bytes, stopped for " +
              Math.round((Date.now() - lastGrewAt) / 1000) + "s, and " + reason
          );
        }
      }

      if (Date.now() > deadline) {
        return fail(
          "RENDER_TIMEOUT",
          "nothing complete arrived within " + Math.round(budgetMs / 1000) + "s (" + reason + ")"
        );
      }
      setTimeout(poll, pollMs);
    })();
  });
}

/**
 * Turn a one-sentence reader failure into the message an agent acts on.
 *
 * `attempts` is how many renders were spent, so the advice does not tell
 * somebody to retry something that has already been retried for them.
 *
 * Anything without one of the two codes is returned untouched: an ExtendScript
 * error travelling through here is not this module's to rewrite.
 */
export function dressFrameError<T>(err: T, attempts: number): T | FrameError {
  const fe = err as unknown as FrameError | null | undefined;
  if (!fe || (fe.code !== "FRAME_INCOMPLETE" && fe.code !== "RENDER_TIMEOUT")) return err;
  const tried = attempts > 1 ? " Both the first attempt and one automatic re-render failed the same way." : "";
  let lines: string[];
  if (fe.code === "FRAME_INCOMPLETE") {
    lines = [
      "Corrupt frame: " + fe.detail + ", so the file is not a whole PNG and nothing was sent." + tried,
      "",
      "This is NOT a timeout. The render stopped writing and what it left behind is",
      "incomplete — a truncated PNG decodes to a wrong picture or to none at all, and",
      "neither is a screenshot. It correlates with how heavy the comp is (issue #45).",
      "",
      "What to do next:",
      "1. Retry at a higher `downsample` (6 or 8). A smaller frame is a smaller write,",
      "   and completes where a large one did not.",
      "2. On a heavy assembled comp, screenshot the shot precomps one at a time rather",
      "   than the assembly.",
      "3. If it repeats, verify the animation by reading keyframes (get_keyframes /",
      "   get_layer_full) instead. That is exact; a picture is not.",
      "",
      "Do NOT disable layers to make the render succeed: this is a limit of the render",
      "path, not a problem with the project.",
    ];
  } else {
    lines = [
      "Render timed out: " + fe.detail + "." + tried,
      "",
      "This is NOT a corrupt file and NOT a lost bridge. After Effects was still working",
      "on the frame when the panel gave up waiting, so the render is most likely still",
      "running and nothing has gone wrong with the project.",
      "",
      "What to do next:",
      "1. Wait a few seconds before doing anything else — a re-render started now would",
      "   queue behind the one still going.",
      "2. Then retry at a higher `downsample` (6 or 8). Fewer pixels is less render.",
      "3. On a heavy assembled comp, screenshot the shot precomps one at a time.",
      "4. If it repeats, read keyframes (get_keyframes / get_layer_full) instead of",
      "   looking at it. That is exact and costs nothing to render.",
    ];
  }
  const out: FrameError = new Error(lines.join("\n"));
  out.code = fe.code;
  out.detail = fe.detail;
  return out;
}
