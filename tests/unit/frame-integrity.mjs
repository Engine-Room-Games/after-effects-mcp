// When is a frame After Effects is writing actually finished?
//
// Getting that wrong is issue #45. The old answer was "when two `stat` calls
// 30ms apart agree", and `saveFrameToPng` returns before the bytes are on disk —
// so a writer that paused for 30ms handed the agent a half-written file, which
// came back as `truncated PNG: chunk IDAT runs past the end of the file` for a
// render that was still happening. The new answer is structural: the file is
// finished when it parses end-to-end as a PNG and not before.
//
// That is testable without After Effects, so it is tested here: real temp files,
// grown by hand, through the real poll loop. The fixtures use a PNG writer
// defined in this file rather than the panel's own — a bug shared between the
// writer and the checker would pass silently, which is the whole failure mode
// being guarded against.
//
//   node tests/unit/frame-integrity.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const client = path.join(root, "packages", "ae-panel", "client");
const { inspectPngStructure } = require(path.join(client, "pngcodec.js"));
const { waitForCompletePng, dressFrameError } = require(path.join(client, "framereader.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`frame-integrity FAILED: ${name}`);
    throw e;
  }
  passed++;
}

// ---------------------------------------------------------------------------
// An independent PNG writer, used only by this test.
// ---------------------------------------------------------------------------
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A real RGBA PNG, big enough that a truncation lands inside IDAT. */
function makePng(width = 64, height = 64, fill = 120) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) {
      row[x * 4] = (fill + x) & 0xff;
      row[x * 4 + 1] = (fill + y) & 0xff;
      row[x * 4 + 2] = fill;
      row[x * 4 + 3] = 255;
    }
    rows.push(Buffer.from([0]), row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-frame-integrity-"));
let seq = 0;
const tmpPath = () => path.join(tmp, `frame-${seq++}.png`);

// ---------------------------------------------------------------------------
// The structural check
// ---------------------------------------------------------------------------
const PNG = makePng();

await check("a whole PNG is complete, and says so with no bytes left over", () => {
  const st = inspectPngStructure(PNG);
  assert.equal(st.complete, true);
  assert.equal(st.lastChunk, "IEND");
  assert.equal(st.trailingBytes, 0);
  assert.equal(st.reason, null);
});

await check("the exact failure from issue #45 is rejected as incomplete, not delivered", () => {
  // Cut inside IDAT — which is where a half-written frame stops, and what the
  // panel's own parser called "truncated PNG: chunk IDAT runs past the end of
  // the file" *after* it had already been shipped.
  const st = inspectPngStructure(PNG.subarray(0, PNG.length - 200));
  assert.equal(st.complete, false);
  assert.equal(st.growable, true, "more bytes would fix it, so the reader should keep waiting");
  assert.equal(st.lastChunk, "IDAT");
  assert.match(st.reason, /IDAT declares \d+ bytes/);
});

await check("a header with no IEND yet is incomplete but still growable", () => {
  const st = inspectPngStructure(PNG.subarray(0, 8 + 25));
  assert.equal(st.complete, false);
  assert.equal(st.growable, true);
});

await check("half a signature is growable; a wrong one never is", () => {
  const half = inspectPngStructure(PNG.subarray(0, 4));
  assert.equal(half.growable, true, "four correct signature bytes are a file that has begun");
  assert.match(half.reason, /4 of the 8 signature bytes/);

  const wrong = inspectPngStructure(Buffer.from("this is not a png at all"));
  assert.equal(wrong.complete, false);
  assert.equal(
    wrong.growable,
    false,
    "no number of appended bytes makes this a PNG, so waiting out the budget is wrong",
  );
  assert.match(wrong.reason, /signature mismatch at byte 0/);
});

await check("a first chunk that is not IHDR is a dead end, not a slow write", () => {
  const bad = Buffer.concat([SIG, chunk("IDAT", Buffer.alloc(4)), chunk("IEND", Buffer.alloc(0))]);
  const st = inspectPngStructure(bad);
  assert.equal(st.growable, false);
  assert.match(st.reason, /first chunk is IDAT, not IHDR/);
});

await check("a chunk type that is not four letters is a dead end", () => {
  const bad = Buffer.concat([SIG, Buffer.from([0, 0, 0, 0]), Buffer.from("IH1R", "ascii"), Buffer.alloc(4)]);
  const st = inspectPngStructure(bad);
  assert.equal(st.growable, false);
  assert.match(st.reason, /not four letters/);
});

await check("an impossible chunk length is a dead end, not a two-minute wait", () => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0xfffffff0, 0);
  head.write("IHDR", 4, 4, "ascii");
  const st = inspectPngStructure(Buffer.concat([SIG, head]));
  assert.equal(st.growable, false);
  assert.match(st.reason, /past the format's limit/);
});

await check("bytes after IEND are counted, not treated as a broken file", () => {
  const st = inspectPngStructure(Buffer.concat([PNG, Buffer.alloc(16, 7)]));
  assert.equal(st.complete, true);
  assert.equal(st.trailingBytes, 16);
});

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------
const FAST = { budgetMs: 4000, stallMs: 250, pollMs: 15 };

await check("a complete file resolves with exactly its bytes, and is cleaned up", async () => {
  const file = tmpPath();
  fs.writeFileSync(file, PNG);
  const buf = await waitForCompletePng(file, FAST);
  assert.deepEqual(buf, PNG, "the bytes handed on must be the bytes on disk");
  assert.equal(fs.existsSync(file), false, "the temp file must not survive a successful read");
});

await check("a truncated file is refused as incomplete rather than delivered", async () => {
  const file = tmpPath();
  // Exactly what the old rule accepted: the size is stable from the first poll
  // onwards, so two `stat` calls 30ms apart agreed and the panel shipped it.
  fs.writeFileSync(file, PNG.subarray(0, PNG.length - 200));
  const started = Date.now();
  await assert.rejects(
    () => waitForCompletePng(file, FAST),
    (e) => {
      assert.equal(e.code, "FRAME_INCOMPLETE", `expected a corrupt-file verdict, got ${e.code}`);
      assert.match(e.detail, /no IEND chunk/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= FAST.stallMs, "it must give the write a chance to continue before condemning it");
  assert.ok(elapsed < FAST.budgetMs, "a stalled write must not cost the whole render budget");
  assert.equal(fs.existsSync(file), false, "a corrupt temp file must be removed, never left to be read again");
});

await check("a file written in stages is accepted only once it parses end to end", async () => {
  const file = tmpPath();
  // Four stages, the third landing mid-IDAT — the shape of the real bug. Each
  // gap is shorter than stallMs, so a growing write is never mistaken for an
  // abandoned one.
  const cuts = [8, 8 + 25, PNG.length - 200, PNG.length];
  let lastWriteAt = 0;
  let stage = 0;
  const timer = setInterval(() => {
    if (stage >= cuts.length) return void clearInterval(timer);
    fs.writeFileSync(file, PNG.subarray(0, cuts[stage]));
    lastWriteAt = Date.now();
    stage++;
  }, 80);

  const buf = await waitForCompletePng(file, FAST);
  clearInterval(timer);
  const resolvedAt = Date.now();
  assert.equal(stage, cuts.length, "it resolved before the final stage was written");
  assert.deepEqual(buf, PNG);
  assert.ok(
    resolvedAt >= lastWriteAt,
    "resolution must come from the last write, not from an earlier stable size",
  );
});

await check("something that is not a PNG fails immediately, without waiting", async () => {
  const file = tmpPath();
  fs.writeFileSync(file, Buffer.from("<html>After Effects wrote nonsense</html>"));
  const started = Date.now();
  await assert.rejects(
    () => waitForCompletePng(file, FAST),
    (e) => {
      assert.equal(e.code, "FRAME_INCOMPLETE");
      assert.match(e.detail, /signature mismatch/);
      return true;
    },
  );
  assert.ok(
    Date.now() - started < FAST.stallMs,
    "a file that can never become a PNG must not be waited on",
  );
});

await check("a frame that never arrives is a timeout, not a corrupt file", async () => {
  const started = Date.now();
  await assert.rejects(
    () => waitForCompletePng(tmpPath(), { budgetMs: 300, stallMs: 250, pollMs: 15 }),
    (e) => {
      assert.equal(e.code, "RENDER_TIMEOUT", "no file at all is the render still running, not a bad write");
      assert.match(e.detail, /has not written the file yet/);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 300, "it must actually wait out the budget first");
});

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------
const corrupt = dressFrameError({ code: "FRAME_INCOMPLETE", detail: "wrote 73877 bytes and stopped" }, 1);
const timeout = dressFrameError({ code: "RENDER_TIMEOUT", detail: "nothing complete arrived within 120s" }, 1);

await check("corrupt and timed-out never share a sentence", () => {
  // Same rule as BridgeTimeoutError vs BridgeUnreachableError: two failures with
  // opposite remedies must not collapse into one message.
  assert.match(corrupt.message, /^Corrupt frame:/);
  assert.match(corrupt.message, /NOT a timeout/);
  assert.doesNotMatch(corrupt.message, /Render timed out/);

  assert.match(timeout.message, /^Render timed out:/);
  assert.match(timeout.message, /NOT a corrupt file/);
  assert.doesNotMatch(timeout.message, /^Corrupt frame/m);
});

await check("each message carries its own next step, and neither says restart After Effects", () => {
  assert.match(corrupt.message, /downsample/);
  assert.match(corrupt.message, /get_keyframes/);
  assert.match(corrupt.message, /Do NOT disable layers/);
  assert.match(timeout.message, /Wait a few seconds/);
  for (const e of [corrupt, timeout]) {
    assert.doesNotMatch(e.message, /restart After Effects/i, "neither failure is fixed by a restart");
    assert.doesNotMatch(e.message, /setup_panel/, "neither failure is fixed by reinstalling the panel");
  }
});

await check("a second attempt says so, so nobody is told to retry what was retried", () => {
  const once = dressFrameError({ code: "FRAME_INCOMPLETE", detail: "d" }, 1);
  const twice = dressFrameError({ code: "FRAME_INCOMPLETE", detail: "d" }, 2);
  assert.doesNotMatch(once.message, /automatic re-render/);
  assert.match(twice.message, /Both the first attempt and one automatic re-render/);
});

await check("an error that is not one of these two is passed through untouched", () => {
  const other = new Error("Unknown op: something_else");
  assert.equal(dressFrameError(other, 1), other, "an ExtendScript error is not this module's to rewrite");
});

await check("the codes survive dressing, because the server branches on them", () => {
  assert.equal(corrupt.code, "FRAME_INCOMPLETE");
  assert.equal(timeout.code, "RENDER_TIMEOUT");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`frame-integrity: ${passed} checks passed`);
