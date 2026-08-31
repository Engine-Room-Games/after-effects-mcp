// framereader.js — wait for After Effects to finish writing a frame.
//
// `saveFrameToPng` is asynchronous: it returns before the bytes are on disk, so
// the panel has to decide for itself when the file is finished. Getting that
// decision wrong is issue #45.
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
// and `BridgeUnreachableError` are kept apart on the server: "the render did not
// finish in time" and "the file After Effects wrote is not a whole PNG" have
// opposite remedies, and one sentence covering both would send half the readers
// the wrong way.
//
// Node builtins only, and a CommonJS module, so `client/main.js` can require it
// inside CEP's mixed context and `tests/unit/frame-integrity.mjs` can require
// the same file under plain Node. There is no After Effects on a CI runner and
// this is the code the bug lived in, so it must be exercisable without one.

"use strict";

var fs = require("fs");
var pngCodec = require("./pngcodec.js");

// How long a frame that has not arrived is still allowed to be on its way. A
// cold render of a heavy 4K comp was measured taking well over 15s; the original
// 5s silently failed screenshots that were merely still rendering.
var FRAME_RENDER_BUDGET_MS = 120000;

// How long a file may sit at exactly the same size, still not a whole PNG,
// before the write is called abandoned rather than slow.
//
// Deliberately far short of the budget above. A corrupt frame has to fail fast
// enough that one automatic re-render still fits inside the server's 300s
// ceiling for this op — and a PNG write that has begun is a few hundred KB of
// deflate output, not something that legitimately stalls for seconds.
var FRAME_STALL_MS = 6000;

var FRAME_POLL_MS = 40;

function frameError(code, detail) {
  var e = new Error(detail);
  e.code = code;
  e.detail = detail;
  return e;
}

function unlinkQuietly(file) {
  try { fs.unlinkSync(file); } catch (e) {}
}

/** True when the last 12 bytes are a zero-length IEND — the file ends where a PNG ends. */
function endsWithIend(file, size) {
  if (size < 12) return false;
  var fd = null;
  try {
    fd = fs.openSync(file, "r");
    var tail = Buffer.alloc(12);
    fs.readSync(fd, tail, 0, 12, size - 12);
    return tail.readUInt32BE(0) === 0 && tail.toString("ascii", 4, 8) === "IEND";
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
  }
}

function readHead(file, n) {
  var fd = null;
  try {
    fd = fs.openSync(file, "r");
    var head = Buffer.alloc(n);
    var got = fs.readSync(fd, head, 0, n, 0);
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
function waitForCompletePng(file, opts) {
  var o = opts || {};
  var budgetMs = o.budgetMs || FRAME_RENDER_BUDGET_MS;
  var stallMs = o.stallMs || FRAME_STALL_MS;
  var pollMs = o.pollMs || FRAME_POLL_MS;
  var deadline = Date.now() + budgetMs;
  return new Promise(function (resolve, reject) {
    var lastSize = -1;
    var lastGrewAt = Date.now();
    var headChecked = false;
    var reason = "After Effects has not written the file yet";

    function fail(code, detail) {
      unlinkQuietly(file);
      reject(frameError(code, detail));
    }

    (function poll() {
      var size = -1;
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
          var head = readHead(file, 8);
          if (head) {
            var early = pngCodec.inspectPngStructure(head);
            if (!early.complete && !early.growable) return fail("FRAME_INCOMPLETE", early.reason);
          }
        }
        if (endsWithIend(file, size)) {
          var buf = null;
          try { buf = fs.readFileSync(file); } catch (e) { buf = null; }
          if (buf) {
            var st = pngCodec.inspectPngStructure(buf);
            if (st.complete) {
              unlinkQuietly(file);
              return resolve(buf);
            }
            if (!st.growable) return fail("FRAME_INCOMPLETE", st.reason);
            reason = st.reason;
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
function dressFrameError(err, attempts) {
  if (!err || (err.code !== "FRAME_INCOMPLETE" && err.code !== "RENDER_TIMEOUT")) return err;
  var tried = attempts > 1 ? " Both the first attempt and one automatic re-render failed the same way." : "";
  var lines;
  if (err.code === "FRAME_INCOMPLETE") {
    lines = [
      "Corrupt frame: " + err.detail + ", so the file is not a whole PNG and nothing was sent." + tried,
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
      "Render timed out: " + err.detail + "." + tried,
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
  var out = new Error(lines.join("\n"));
  out.code = err.code;
  out.detail = err.detail;
  return out;
}

module.exports = {
  waitForCompletePng: waitForCompletePng,
  dressFrameError: dressFrameError,
  frameError: frameError,
  unlinkQuietly: unlinkQuietly,
  FRAME_RENDER_BUDGET_MS: FRAME_RENDER_BUDGET_MS,
  FRAME_STALL_MS: FRAME_STALL_MS,
};
