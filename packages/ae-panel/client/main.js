// main.js — the bridge.
// Boots inside the CEP panel. Loads bundle.jsx into ExtendScript, then runs
// a local HTTP+WS server that the Node MCP server connects to.

(function () {
  "use strict";

  // CEP exposes Node via mixed-context.
  var path = require("path");
  var fs = require("fs");
  var os = require("os");
  var http = require("http");
  var crypto = require("crypto");

  // The DOM handles and the logger come first so that everything below is able
  // to report its own failure. `require("ws")` used to run before this point,
  // so when it threw the exception escaped this whole function before a single
  // line could be written — the panel sat on "starting…" indefinitely with the
  // reason nowhere to be seen.
  var $status = document.getElementById("status");
  var $port = document.getElementById("port");
  var $ae = document.getElementById("ae");
  var $jsx = document.getElementById("jsx");
  var $reqs = document.getElementById("reqs");
  var $log = document.getElementById("log");
  function setStatus(text, klass) {
    $status.textContent = text;
    $status.className = klass || "";
  }
  var __reqCount = 0;
  function bumpReq() { __reqCount += 1; $reqs.textContent = String(__reqCount); }
  function log(level, msg) {
    var d = document.createElement("div");
    d.className = (level === "error" ? "err" : level === "warn" ? "warn" : "");
    var ts = new Date().toISOString().substring(11, 19);
    d.textContent = "[" + ts + "] " + msg;
    $log.insertBefore(d, $log.firstChild);
    // Trim
    while ($log.childNodes.length > 80) $log.removeChild($log.lastChild);
  }

  // CSInterface comes from the plain <script> tag before this one, so it needs
  // no require and is available here — which matters, because the extension
  // path it reports is the only trustworthy anchor for everything below.
  //
  // __dirname is NOT that anchor. CEP anchors it at the *extension root* (where
  // the manifest and node_modules live), not at the folder holding this file.
  // That is why require("ws") resolves and a require of a file sitting right
  // next to main.js does not.
  var cs, extDir, clientDir;
  try {
    cs = new CSInterface();
    extDir = cs.getSystemPath(SystemPath.EXTENSION);
    clientDir = path.join(extDir, "client");
  } catch (e) {
    setStatus("cannot start — CSInterface is unavailable", "err");
    log("error", "new CSInterface() failed: " + e.message);
    return;
  }

  var WebSocket;
  try { WebSocket = require("ws"); }
  catch (primary) {
    // ws is bundled at the extension root; resolve manually if normal require fails.
    var alt = path.join(extDir, "node_modules", "ws");
    try { WebSocket = require(alt); }
    catch (fallback) {
      // Nothing below can be built without ws, so this stops here — but it
      // stops saying why, and naming the fix, rather than looking like a panel
      // that is still starting up.
      setStatus("cannot start — the ws module is missing", "err");
      log("error", "require('ws') failed: " + primary.message);
      log("error", "and " + alt + ": " + fallback.message);
      log("error", "Quit After Effects, run the setup_panel tool, then reopen it.");
      return;
    }
  }

  // The screenshot checks live in their own files so a Node test can require
  // them without a DOM: there is no After Effects on a CI runner, and neither
  // real image code nor stale-buffer bookkeeping should be written blind.
  // Same failure discipline as ws above — say what is missing, name the fix.
  //
  // The list is ordered by how much it is trusted, not by convenience.
  // clientDir comes from CSInterface and is what the shipped layout actually
  // is; the __dirname forms are kept behind it because a host build that
  // anchors __dirname somewhere else again should degrade to a warning in the
  // log rather than a panel that will not start.
  function requireSibling(name) {
    var candidates = [
      path.join(clientDir, name),
      path.join(__dirname, name),
      path.join(__dirname, "client", name),
      "./" + name,
    ];
    var failures = [];
    for (var i = 0; i < candidates.length; i++) {
      try { return require(candidates[i]); }
      catch (e) { failures.push(candidates[i] + " (" + e.message.split("\n")[0] + ")"); }
    }
    throw new Error("could not load " + name + " from any of: " + failures.join("; "));
  }
  var pngCodec, frameCacheModule, mogrtModule, contactSheetModule, frameReaderModule;
  try {
    pngCodec = requireSibling("pngcodec.js");
    frameCacheModule = requireSibling("framecache.js");
    mogrtModule = requireSibling("mogrt.js");
    contactSheetModule = requireSibling("contactsheet.js");
    frameReaderModule = requireSibling("framereader.js");
  } catch (e) {
    setStatus("cannot start — one of the panel's file-processing modules is missing", "err");
    log("error", "loading the panel's file-processing modules from " + __dirname + " failed: " + e.message);
    log("error", "Quit After Effects, run the setup_panel tool, then reopen it.");
    return;
  }
  var frameCache = frameCacheModule.createFrameCache();

  var bundlePath = path.join(extDir, "jsx", "bundle.jsx");

  // ---------- ExtendScript evalScript: serialized via Promise chain ----------
  var __evalChain = Promise.resolve();
  function evalScript(script) {
    var p = __evalChain.then(function () {
      return new Promise(function (resolve, reject) {
        cs.evalScript(script, function (raw) {
          if (raw === "EvalScript error.") return reject(new Error("ExtendScript eval failed (syntax or runtime)"));
          resolve(raw);
        });
      });
    });
    // Keep the chain alive even on rejection so subsequent calls aren't blocked.
    __evalChain = p.catch(function () { return null; });
    return p;
  }

  // Run an op through the dispatch table. Returns parsed JS object.
  function runOp(op, args) {
    var payload = JSON.stringify({ op: op, args: args || {} });
    // Use \uXXXX-safe JSON pass: JSON.stringify on the panel side, JSON.parse on ExtendScript side.
    var script = "JSON.stringify(dispatch(" + JSON.stringify(payload) + "))";
    return evalScript(script).then(function (raw) {
      if (raw === "undefined" || raw === undefined || raw === null) {
        throw new Error("ExtendScript returned undefined for op " + op);
      }
      var parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { throw new Error("Bad JSON from ExtendScript for op " + op + ": " + String(raw).slice(0, 200)); }
      if (!parsed.ok) {
        var msg = parsed.error || "ExtendScript op failed";
        var err = new Error(msg);
        err.aeStack = parsed.stack;
        err.aeLine = parsed.line;
        // Where the failure sits in the caller's *own* source, when the handler
        // could work it out — run_jsx maps AE's line number back onto the
        // script that was submitted (issue #46). Forwarded field by field on
        // purpose: the server prints these, and relaying a free-form bag would
        // let the two drift apart with nothing to notice.
        if (parsed.sourceLine !== undefined || parsed.rawLine !== undefined) {
          err.aeSource = {
            sourceLine: parsed.sourceLine,
            sourceText: parsed.sourceText,
            sourceName: parsed.sourceName,
            rawLine: parsed.rawLine,
            lineCount: parsed.lineCount
          };
        }
        throw err;
      }
      return parsed.result;
    });
  }

  // ---------- Load bundle.jsx ----------
  // Hash of the bundle *actually evaluated into ExtendScript*, reported on
  // /health. The server compares it against the bundle it ships to decide
  // whether the running panel understands the ops it is about to send.
  //
  // It has to be captured here rather than read off disk on demand: after
  // setup_panel refreshes the extension folder, the file on disk is new while
  // this process is still running the old code, and that gap — between
  // installing an update and restarting AE — is exactly when calls fail.
  var loadedBundleHash = null;

  function hashFile(file) {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch (e) {
      return null;
    }
  }

  function loadJsxBundle() {
    setStatus("Loading bundle.jsx…");
    if (!fs.existsSync(bundlePath)) {
      setStatus("bundle.jsx missing", "err");
      log("error", "bundle.jsx not found at " + bundlePath + " — run `npm run build:jsx`");
      throw new Error("bundle.jsx missing");
    }
    // Use $.evalFile from ExtendScript side so paths work cross-platform.
    var loadScript = "$.evalFile(" + JSON.stringify(bundlePath) + "); typeof dispatch === 'function' ? 'ok' : 'no-dispatch';";
    return new Promise(function (resolve, reject) {
      cs.evalScript(loadScript, function (raw) {
        if (raw === "ok") {
          loadedBundleHash = hashFile(bundlePath);
          $jsx.textContent = "loaded";
          $jsx.className = "ok";
          resolve();
        }
        else { $jsx.textContent = "fail: " + raw; $jsx.className = "err"; reject(new Error("dispatch not defined after loading bundle.jsx: " + raw)); }
      });
    });
  }

  // ---------- Port file (so MCP server can discover) ----------
  function writePortFile(port) {
    var dir = path.join(os.homedir(), ".engineroom-ae-mcp");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try { fs.writeFileSync(path.join(dir, "port"), String(port), "utf8"); } catch (e) { log("warn", "could not write port file: " + e.message); }
  }

  // ---------- WS broadcast ----------
  var wsClients = new Set();
  function broadcast(eventObj) {
    var str = JSON.stringify(eventObj);
    wsClients.forEach(function (c) {
      try { if (c.readyState === 1) c.send(str); } catch (e) {}
    });
  }

  // ---------- Vision: read PNG and base64-encode (for screenshot_* ops) ----------
  // Deciding when After Effects has finished writing a frame is issue #45, and
  // it lives in framereader.js so a unit test can drive it with a file it grows
  // by hand. What matters here: `waitForCompletePng` resolves only with bytes
  // that parse end-to-end as a PNG, deletes the temp file on every path, and
  // rejects with FRAME_INCOMPLETE or RENDER_TIMEOUT — never with one message
  // covering both.
  var waitForCompletePng = frameReaderModule.waitForCompletePng;
  var dressFrameError = frameReaderModule.dressFrameError;
  var frameError = frameReaderModule.frameError;
  var unlinkQuietly = frameReaderModule.unlinkQuietly;

  function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
  }

  // Downsampling happens in ExtendScript via the comp's resolutionFactor, so
  // the file on disk is already the right size by the time we get here.
  //
  // What is *not* already right is the bit depth: a 16-bit project renders
  // 16-bit-per-channel PNGs, which many decoders refuse outright. pngcodec
  // converts those to 8-bit, tells us when the frame is entirely transparent,
  // and hands back the decoded samples so a frame can be recognised if After
  // Effects serves the same buffer again for a different request.
  function readPngFrame(file) {
    // waitForCompletePng owns the temp file and removes it on every path,
    // success or failure. A file left behind is one a later read could find,
    // which is how a corrupt frame would start coming back for free.
    return waitForCompletePng(file).then(function (buf) {
      var norm;
      try {
        norm = pngCodec.normalizePng(buf);
      } catch (e) {
        // The completeness gate above guarantees this file ends in a well-formed
        // IEND, so a truncation error here would mean the gate is broken. Refuse
        // rather than ship: "never report success for work that didn't happen"
        // outranks the fallback below.
        if (/truncated PNG/.test(e.message)) {
          throw frameError("FRAME_INCOMPLETE", "the file passed the completeness check and then failed to parse (" + e.message + ")");
        }
        // A complete PNG this parser cannot read is still a PNG the client
        // might. Ship it unchanged rather than throwing away a render that did
        // happen — but say so, and fall back to hashing the file so the stale
        // check survives.
        log("warn", "could not normalise the frame (" + e.message + "); sending it unconverted");
        var dims = pngDimensions(buf);
        return {
          buffer: buf,
          width: dims ? dims.width : null,
          height: dims ? dims.height : null,
          empty: false,
          hash: sha256(buf),
          warning: "This frame could not be normalised to 8-bit (" + e.message +
            ") and was sent exactly as After Effects wrote it. If it fails to decode, " +
            "that is why.",
        };
      }
      if (norm.empty) {
        return { empty: true, width: norm.width, height: norm.height };
      }
      if (norm.converted) {
        log("info", "converted a " + norm.bitDepth + "-bit frame to 8-bit (" +
          buf.length + " -> " + norm.buffer.length + " bytes)");
      }
      return {
        buffer: norm.buffer,
        width: norm.width,
        height: norm.height,
        empty: false,
        converted: norm.converted,
        sourceBitDepth: norm.bitDepth,
        // Decoded samples, kept only so the contact sheet can composite them
        // without decoding the same PNG a second time. Null on the passthrough
        // path, where the pixels were never interpreted.
        pixels: norm.decoded ? norm.hashInput : null,
        channels: norm.channels,
        hash: sha256(norm.hashInput),
        // The pixels could not be read, so "empty" was never evaluated and the
        // hash is of the compressed stream. Both are still better than nothing;
        // saying which is what stops a later reader trusting the wrong one.
        warning: norm.passthrough
          ? "This frame's pixels were not inspected (" + norm.passthrough +
            "), so it was sent exactly as After Effects wrote it."
          : undefined,
      };
    });
  }

  // Read the true pixel dimensions out of the PNG's IHDR chunk rather than
  // computing them, so what we report is always what the client received.
  function pngDimensions(buf) {
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // ---------- Rendering one frame, with one bounded retry ----------
  function renderFrameOnce(op, args) {
    return runOp(op, args).then(function (info) {
      return readPngFrame(info.path).then(function (img) {
        return { info: info, img: img };
      });
    });
  }

  /**
   * Render a frame, and re-render exactly once if what came back was corrupt.
   *
   * Safe to repeat, which is the only reason this is here. Both screenshot ops
   * are read-only: `screenshot_frame` renders to a temp file, `screenshot_layer`
   * additionally solos a layer and restores every solo state in a `finally`.
   * Neither leaves anything in the project, so a second run is
   * indistinguishable from one run — this is not `run_jsx`, where re-running a
   * script that already had its side effects duplicates them (issue #43).
   *
   * Only on FRAME_INCOMPLETE, never on RENDER_TIMEOUT. A timeout has already
   * spent the 120s budget; a second one would take the op past the server's
   * 300s ceiling and turn a precise "the render did not finish" into a bridge
   * timeout, whose remedy ("do not restart anything, wait") is a different
   * remedy for a different problem. A corrupt read, by contrast, fails within
   * FRAME_STALL_MS, and the evidence in #45 is that a retry sometimes succeeds
   * — a light comp returned one truncated frame and then rendered.
   *
   * The temp file of a failed attempt is deleted before the retry (in
   * `waitForCompletePng`), and ExtendScript names a fresh one per call, so a
   * retry can never be handed the previous attempt's bytes.
   */
  function renderFrameWithRetry(op, args) {
    return renderFrameOnce(op, args).catch(function (first) {
      if (first.code !== "FRAME_INCOMPLETE") throw dressFrameError(first, 1);
      log("warn", op + ": " + first.detail + " — re-rendering once");
      return renderFrameOnce(op, args).catch(function (second) {
        throw dressFrameError(second, 2);
      });
    });
  }

  // ---------- Stale render detection ----------
  // The request identity a render is expected to be unique to. Built from what
  // ExtendScript resolved, not from the arguments, so a defaulted time or
  // downsample is compared as the value actually rendered.
  function frameKey(op, info) {
    var layer = (info.layerId === undefined || info.layerId === null) ? "-" : info.layerId;
    return [op, info.compId, layer, Number(info.time).toFixed(6), info.downsample].join("|");
  }
  function frameLabel(op, info) {
    return "comp " + info.compId +
      ((info.layerId === undefined || info.layerId === null) ? "" : " layer " + info.layerId) +
      " @ " + Number(info.time).toFixed(3) + "s downsample " + info.downsample;
  }
  // An error rather than a warning attached to the image, because an agent that
  // can see the picture will believe the picture. It carries the whole
  // workaround: there is nothing this panel can do to make the render happen.
  function staleFrameError(label, match, bytes) {
    var ago = Math.max(1, Math.round(match.ageMs / 1000));
    var err = new Error(
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
      "number of pixels and confirm it."
    );
    err.code = "STALE_FRAME";
    return err;
  }

  // ---------- Long job continuation loop ----------
  // Each turn of this loop is one evalScript, and each one now opens and closes
  // its own undo group inside itself — a group cannot span two calls, because
  // After Effects discards one that does (issue #69). So the chunk size is not
  // only a pacing knob any more: it decides how many undo steps a long batch
  // costs the user. It comes off the job envelope so the JSX side owns the
  // number and the two cannot drift.
  function driveJob(jobId, progressToken, chunkSize) {
    var totalGuess = null;
    var size = chunkSize || 25;
    function step() {
      return runOp("_continue_job", { jobId: jobId, chunkSize: size }).then(function (res) {
        if (res.total) totalGuess = res.total;
        if (!res.done) {
          broadcast({ type: "progress", jobId: jobId, progress: res.progress, total: res.total, message: "running" });
          // Yield to UI so AE stays responsive.
          return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        }
        if (res.failed) {
          // A failed job reaches the server as an error string and nothing else,
          // so what the batch cost has to travel inside it or it is lost: the
          // ops before the failure are applied and stay applied.
          var failedMsg = (res.error || "batch failed") + (res.note ? " || " + res.note : "");
          broadcast({ type: "error", jobId: jobId, error: failedMsg });
          return { done: true, failed: true, jobId: jobId, error: res.error, results: res.results, errors: res.errors, atIndex: res.atIndex, undoSteps: res.undoSteps, note: res.note };
        }
        // `undoSteps` is the measured number of undo groups the batch opened,
        // and `diff` is the batch's own before/after — both are only ever seen
        // by the agent if they are carried on this event.
        broadcast({
          type: "complete",
          jobId: jobId,
          result: {
            results: res.results,
            errors: res.errors,
            total: res.total || totalGuess,
            cancelled: !!res.cancelled,
            undoSteps: res.undoSteps,
            undoGroupName: res.undoGroupName,
            note: res.note,
            diff: res.diff,
          },
        });
        return {
          done: true, jobId: jobId,
          results: res.results, errors: res.errors,
          total: res.total || totalGuess, cancelled: !!res.cancelled,
          undoSteps: res.undoSteps, undoGroupName: res.undoGroupName,
          note: res.note, diff: res.diff,
        };
      });
    }
    return step();
  }

  // ---------- Motion Graphics template thumbnail ----------
  // ExtendScript can render the poster frame but cannot rewrite a zip, so the
  // JSX side hands back a PNG path and the archive surgery happens here.
  //
  // A failed patch is reported on an otherwise successful result, never thrown:
  // the .mogrt is already written and valid at this point, and throwing away a
  // successful export because its thumbnail could not be improved would be the
  // worse trade. The result says plainly that the thumbnail is still AE's.
  function patchMogrtThumbnail(info) {
    // The same completeness gate the screenshot path uses. The poster frame is
    // written by the same asynchronous `saveFrameToPng`, so a half-written one
    // is just as possible here — and it would be resampled into the template's
    // thumbnail rather than merely displayed.
    // It takes the poster file with it, on success and on failure alike.
    return waitForCompletePng(info.posterPngPath).then(function (poster) {
      var patched = mogrtModule.patchThumbnail(fs.readFileSync(info.path), poster);
      // Write via a sibling temp file and rename, so an interrupted write
      // cannot leave a half-rewritten template where a valid one used to be.
      var tmp = info.path + ".tmp-thumb";
      fs.writeFileSync(tmp, patched.buffer);
      fs.renameSync(tmp, info.path);
      return {
        patched: true,
        posterTime: info.posterTime,
        width: patched.width,
        height: patched.height,
        sourceWidth: patched.sourceWidth,
        sourceHeight: patched.sourceHeight,
        letterboxed: patched.letterboxed || undefined,
      };
    }).catch(function (e) {
      unlinkQuietly(info.posterPngPath);
      log("warn", "could not patch the .mogrt thumbnail: " + e.message);
      return {
        patched: false,
        posterTime: info.posterTime,
        reason: "The template exported correctly, but its thumbnail could not be replaced (" +
          e.message + "). It still shows the one After Effects wrote.",
      };
    });
  }

  // ---------- Contact sheet ----------
  //
  // ExtendScript renders every requested time and hands back one temp path per
  // tile; everything from here on is pixels, which `packages/jsx` has no way to
  // touch. One tile that fails is drawn as a marked block rather than dropped —
  // the sheet has to keep mapping onto the times that were asked for, or an
  // agent counting frames left to right reads the wrong one as the right one.

  /** One line, for a note inside a tile rather than a whole error message. */
  function shortReason(err) {
    var s = err && err.detail ? err.detail : (err && err.message ? err.message : String(err));
    return String(s).split("\n")[0];
  }

  function readSheetTile(info, tile) {
    if (tile.error) {
      return Promise.resolve({ time: tile.time, status: "failed", note: tile.error });
    }
    return readPngFrame(tile.path).then(function (img) {
      return { time: tile.time, status: "ok", img: img };
    }, function (err) {
      if (err.code !== "FRAME_INCOMPLETE") {
        return { time: tile.time, status: "failed", note: shortReason(err) };
      }
      // The same bounded retry the single-frame path gets, and safe for the same
      // reason — but re-rendering only this one time. The already-derived
      // downsample is passed explicitly so the per-tile factor cannot drift from
      // the rest of the sheet.
      log("warn", "contact sheet tile at " + tile.time + "s: " + shortReason(err) + " — re-rendering once");
      return runOp("screenshot_frame", {
        compId: info.compId,
        time: tile.time,
        downsample: info.downsample,
      }).then(function (retry) {
        return readPngFrame(retry.path).then(function (img) {
          return { time: tile.time, status: "ok", img: img };
        });
      }).catch(function (again) {
        return { time: tile.time, status: "failed", note: shortReason(again) };
      });
    });
  }

  function finishContactSheet(info, read) {
    var i;
    var ds = info.downsample;
    // Pass one: classify. Every `match` is computed before any `remember`, so a
    // sheet's own tiles cannot collide with each other through the cache.
    var seen = {};
    for (i = 0; i < read.length; i++) {
      var t = read[i];
      if (t.status !== "ok") continue;
      if (t.img.empty) { t.status = "empty"; t.img = null; continue; }
      var ident = { compId: info.compId, layerId: null, time: t.time, downsample: ds };
      t.key = frameKey("screenshot_frame", ident);
      var match = frameCache.match(t.key, t.img.hash);
      if (match) {
        // Pixels identical to an *earlier, different* request are the #29 stale
        // buffer, and a tile of them is not a picture of this time. Mark the
        // block rather than showing it: an agent that can see a frame believes
        // the frame.
        t.status = "stale";
        t.note = "identical to " + match.label + ", rendered " +
          Math.max(1, Math.round(match.ageMs / 1000)) + "s earlier";
        t.img = null;
        continue;
      }
      // Two tiles of one sheet matching each other is what a static comp looks
      // like — the caller asked for several times on purpose, and refusing the
      // second would be a false alarm on a correct answer. Flagged, not refused.
      if (seen[t.img.hash] !== undefined) {
        t.note = "pixel-identical to the " + contactSheetModule.formatTime(seen[t.img.hash]) +
          " tile — nothing changed between them";
      } else {
        seen[t.img.hash] = t.time;
      }
    }

    var specs = [];
    var ok = 0;
    for (i = 0; i < read.length; i++) {
      var r = read[i];
      var spec = { time: r.time, status: r.status, note: r.note };
      if (r.status === "ok") {
        var px = r.img.pixels;
        var channels = r.img.channels;
        if (!px) {
          // The passthrough path never interpreted the pixels. A sheet needs
          // them, so decode strictly here; a frame that cannot be decoded
          // becomes a marked block rather than a wrong one.
          try {
            var dec = pngCodec.decodePng8(r.img.buffer);
            px = dec.pixels;
            channels = dec.channels;
          } catch (e) {
            // Both records move together: `spec` is what gets drawn, `r` is what
            // the cache loop below reads, and a frame that is not delivered must
            // not be remembered as if it were.
            spec.status = "failed";
            r.status = "failed";
            spec.note = "the frame could not be decoded for tiling (" + e.message + ")";
          }
        }
        if (spec.status === "ok") {
          spec.pixels = px;
          spec.channels = channels;
          spec.width = r.img.width;
          spec.height = r.img.height;
          ok++;
        }
      }
      specs.push(spec);
    }

    if (!ok) {
      var why = [];
      for (i = 0; i < specs.length; i++) {
        why.push(contactSheetModule.formatTime(specs[i].time) + ": " + specs[i].status +
          (specs[i].note ? " (" + specs[i].note + ")" : ""));
      }
      var dead = new Error(
        "No tile of the contact sheet rendered, so there is no sheet to send. Per time:\n" +
        why.join("\n") + "\n\n" +
        "A sheet of coloured blocks is not a screenshot. Retry at a higher `downsample`, " +
        "or screenshot the shot precomps one at a time; if it repeats, read keyframes " +
        "(get_keyframes / get_layer_full) instead."
      );
      dead.code = "CONTACT_SHEET_FAILED";
      throw dead;
    }

    // The expected cell size, used only for the cells with no picture. A tile
    // that rendered is the authority on its own dimensions.
    var sheet = contactSheetModule.composeContactSheet(specs, {
      cellWidth: Math.round(info.width / ds),
      cellHeight: Math.round(info.height / ds),
    });

    // Only what is actually being delivered goes into the cache.
    for (i = 0; i < read.length; i++) {
      if (read[i].status === "ok" && read[i].key) {
        frameCache.remember(read[i].key, read[i].img.hash, {
          label: frameLabel("screenshot_frame", { compId: info.compId, time: read[i].time, downsample: ds }),
          bytes: read[i].img.buffer.length,
        });
      }
    }

    var bad = [];
    for (i = 0; i < sheet.tiles.length; i++) {
      if (sheet.tiles[i].status !== "ok") {
        bad.push(sheet.tiles[i].label + (sheet.tiles[i].note ? " — " + sheet.tiles[i].note : ""));
      }
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
      // Named and counted, because a sheet that looks complete and is not is the
      // same class of lie as a swallowed error.
      warning: bad.length
        ? bad.length + " of " + sheet.tiles.length + " tiles are marked blocks, not frames: " + bad.join("; ")
        : undefined,
    };
  }

  function renderContactSheet(args) {
    return runOp("screenshot_frame", args).then(function (info) {
      var jsxTiles = info.tiles || [];
      // Sequentially: `evalScript` is a mutex anyway, a per-tile retry re-enters
      // ExtendScript, and reading them in order keeps the panel log legible.
      var read = [];
      var chain = Promise.resolve();
      for (var i = 0; i < jsxTiles.length; i++) {
        chain = chain.then(function (tile) {
          return function () {
            return readSheetTile(info, tile).then(function (res) { read.push(res); });
          };
        }(jsxTiles[i]));
      }
      return chain.then(function () { return finishContactSheet(info, read); });
    });
  }

  // ---------- Op handler with vision/job specialization ----------
  function handleOp(op, args, progressToken) {
    // Export writes the .mogrt; the thumbnail it wants is a second file that
    // has to be folded into it afterwards.
    if (op === "export_mogrt") {
      return runOp(op, args).then(function (info) {
        if (!info || !info.posterPngPath) return info;
        return patchMogrtThumbnail(info).then(function (thumbnail) {
          var out = {};
          for (var k in info) { if (info.hasOwnProperty(k) && k !== "posterPngPath") out[k] = info[k]; }
          out.thumbnail = thumbnail;
          // The file changed size when the thumbnail was replaced, and the
          // reported number has to be the one on disk.
          try { out.bytes = fs.statSync(info.path).size; } catch (e) {}
          return out;
        });
      });
    }
    // Vision ops: run JSX, then read PNG and base64-encode on Node side.
    if (op === "screenshot_frame" || op === "screenshot_layer") {
      if (op === "screenshot_frame" && args && args.times && args.times.length) {
        return renderContactSheet(args);
      }
      return renderFrameWithRetry(op, args).then(function (r) {
        var info = r.info;
        var img = r.img;
        // A frame with nothing in it is a fact about the composition, not a
        // failure — and the ~5KB PNG that encodes it is the one decoders
        // reject. Report it, cheaply, instead of shipping an image nobody can
        // read and calling that a successful screenshot.
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
            reason: "Every pixel of this frame is fully transparent — the frame is empty. " +
              "No image was sent because there is nothing in it to see. Usually this means " +
              "the time is outside the layers' in/out points, the layers are disabled or " +
              "have zero opacity, or the wrong comp was addressed.",
          };
        }
        // Only a frame that read cleanly ever reaches the cache. A corrupt read
        // is rejected above and never remembered — before the completeness gate
        // existed, a truncated file was hashed and recorded here, so the next
        // truncation at the same byte count was reported as a stale buffer and
        // the real fault was hidden behind the wrong diagnosis.
        var key = frameKey(op, info);
        var match = frameCache.match(key, img.hash);
        if (match) throw staleFrameError(frameLabel(op, info), match, img.buffer.length);
        frameCache.remember(key, img.hash, { label: frameLabel(op, info), bytes: img.buffer.length });
        return {
          // Dimensions come from the PNG itself, not from arithmetic on the
          // comp size, so they cannot disagree with the image sent.
          width: img.width,
          height: img.height,
          fullWidth: info.width,
          fullHeight: info.height,
          downsample: info.downsample,
          time: info.time,
          compId: info.compId,
          layerId: info.layerId,
          mimeType: "image/png",
          base64: img.buffer.toString("base64"),
          bytes: img.buffer.length,
          // Only present when the frame was not 8-bit as rendered, so the
          // metadata stays quiet on the ordinary path.
          converted: img.converted ? true : undefined,
          sourceBitDepth: img.converted ? img.sourceBitDepth : undefined,
          warning: img.warning,
        };
      });
    }
    // Long batches: returns {jobId, async, total}. We kick off background drive
    // and return the jobId immediately.
    if (op === "run_batch") {
      return runOp(op, args).then(function (res) {
        if (res && res.async && res.jobId) {
          driveJob(res.jobId, progressToken, res.chunkSize).catch(function (e) {
            broadcast({ type: "error", jobId: res.jobId, error: e.message });
          });
          // The undo fields ride out with the envelope so the agent is told the
          // batch will be several steps *before* it goes and says otherwise —
          // the final count arrives much later, on the completion event.
          return {
            jobId: res.jobId,
            async: true,
            total: res.total,
            chunkSize: res.chunkSize,
            undoStepsEstimate: res.undoStepsEstimate,
            undoGroupName: res.undoGroupName,
            note: res.note,
          };
        }
        return res; // small batch: inline result already
      });
    }
    return runOp(op, args);
  }

  // ---------- HTTP server ----------
  function startHttp(port) {
    return new Promise(function (resolve, reject) {
      var server = http.createServer(function (req, res) {
        var url = req.url || "/";
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type");

        if (url === "/health") {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          // bundleHash identifies the code this panel is *running*, which is what
          // the server needs to know before sending an op the panel may predate.
          res.end(JSON.stringify({
            ok: true,
            port: port,
            bundleLoaded: true,
            bundleHash: loadedBundleHash,
            ts: Date.now()
          }));
          return;
        }

        if (req.method !== "POST") {
          res.statusCode = 405; res.end("POST only");
          return;
        }

        var bufs = [];
        req.on("data", function (c) { bufs.push(c); });
        req.on("end", function () {
          var body;
          try { body = JSON.parse(Buffer.concat(bufs).toString("utf8") || "{}"); }
          catch (e) {
            res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "Bad JSON: " + e.message }));
            return;
          }

          if (url === "/op") {
            bumpReq();
            handleOp(body.op, body.args, body.progressToken)
              .then(function (result) {
                res.statusCode = 200; res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: result }));
              })
              .catch(function (err) {
                log("error", body.op + ": " + err.message);
                res.statusCode = 500; res.setHeader("content-type", "application/json");
                // `code` marks a failure the panel diagnosed itself rather than
                // one ExtendScript raised, so the server can present it as what
                // it is instead of prefixing it as an After Effects error.
                res.end(JSON.stringify({ ok: false, error: err.message, code: err.code, stack: err.aeStack, line: err.aeLine, source: err.aeSource }));
              });
            return;
          }

          if (url === "/cancel") {
            runOp("_cancel_job", { jobId: body.jobId })
              .then(function (r) {
                res.statusCode = 200; res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: r }));
              })
              .catch(function (e) {
                res.statusCode = 500; res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: false, error: e.message }));
              });
            return;
          }

          if (url === "/reload-jsx") {
            // Dev-only: re-evalFile the bundle. Useful while editing .jsx without restarting AE.
            loadJsxBundle()
              .then(function () { res.statusCode = 200; res.end(JSON.stringify({ ok: true })); })
              .catch(function (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); });
            return;
          }

          res.statusCode = 404; res.end("not found");
        });
      });

      server.on("error", function (e) { reject(e); });
      server.listen(port, "127.0.0.1", function () { resolve(server); });
    });
  }

  function startServers(startPort) {
    var tries = 0;
    function attempt(p) {
      tries++;
      return startHttp(p).then(function (server) {
        // Mount WS on the same HTTP server.
        var wss = new WebSocket.Server({ server: server, path: "/events" });
        wss.on("connection", function (ws) {
          wsClients.add(ws);
          ws.on("close", function () { wsClients.delete(ws); });
        });
        return { port: p, server: server, wss: wss };
      }).catch(function (e) {
        if (e.code === "EADDRINUSE" && tries < 23 && p < 7799) {
          return attempt(p + 1);
        }
        throw e;
      });
    }
    return attempt(startPort);
  }

  // ---------- Boot sequence ----------
  setStatus("Starting…");
  try {
    var host = cs.getHostEnvironment();
    $ae.textContent = (host && host.appName ? host.appName : "AE") + " " + (host && host.appVersion ? host.appVersion : "");
  } catch (e) {}

  loadJsxBundle()
    .then(function () { return startServers(7777); })
    .then(function (s) {
      writePortFile(s.port);
      $port.textContent = String(s.port);
      $port.className = "ok";
      setStatus("ready", "ok");
      log("info", "Bridge listening on http://127.0.0.1:" + s.port);
    })
    .catch(function (e) {
      setStatus("failed", "err");
      log("error", e.message);
    });
})();
