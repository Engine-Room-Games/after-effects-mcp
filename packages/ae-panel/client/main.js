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
  var pngCodec, frameCacheModule, mogrtModule;
  try {
    pngCodec = requireSibling("pngcodec.js");
    frameCacheModule = requireSibling("framecache.js");
    mogrtModule = requireSibling("mogrt.js");
  } catch (e) {
    setStatus("cannot start — pngcodec.js, framecache.js or mogrt.js is missing", "err");
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
  function waitForPngFile(file, maxMs) {
    var deadline = Date.now() + (maxMs || 3000);
    return new Promise(function (resolve, reject) {
      (function poll() {
        try {
          if (fs.existsSync(file)) {
            var stat = fs.statSync(file);
            // Reasonable size + ensure not currently being written (re-check)
            if (stat.size > 64) {
              setTimeout(function () {
                try {
                  var stat2 = fs.statSync(file);
                  if (stat2.size === stat.size) return resolve(stat2.size);
                } catch (e) {}
                if (Date.now() > deadline) return reject(new Error("PNG file write timed out"));
                poll();
              }, 30);
              return;
            }
          }
        } catch (e) {}
        if (Date.now() > deadline) return reject(new Error("PNG file did not appear: " + file));
        setTimeout(poll, 40);
      })();
    });
  }
  // Read the true pixel dimensions out of the PNG's IHDR chunk rather than
  // computing them, so what we report is always what the client received.
  function pngDimensions(buf) {
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

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
    // A cold render of a heavy 4K comp can take well over 15s — measured on a
    // real project. Five seconds silently failed screenshots that were simply
    // still rendering.
    return waitForPngFile(file, 120000).then(function () {
      var buf = fs.readFileSync(file);
      try { fs.unlinkSync(file); } catch (e) {}
      var norm;
      try {
        norm = pngCodec.normalizePng(buf);
      } catch (e) {
        // A PNG this parser cannot read is still a PNG the client might. Ship
        // it unchanged rather than throwing away a render that did happen — but
        // say so, and fall back to hashing the file so the stale check survives.
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
  function driveJob(jobId, progressToken) {
    var totalGuess = null;
    function step() {
      return runOp("_continue_job", { jobId: jobId, chunkSize: 25 }).then(function (res) {
        if (res.total) totalGuess = res.total;
        if (!res.done) {
          broadcast({ type: "progress", jobId: jobId, progress: res.progress, total: res.total, message: "running" });
          // Yield to UI so AE stays responsive.
          return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        }
        if (res.failed) {
          broadcast({ type: "error", jobId: jobId, error: res.error || "batch failed" });
          return { done: true, failed: true, jobId: jobId, error: res.error, results: res.results, errors: res.errors, atIndex: res.atIndex };
        }
        broadcast({ type: "complete", jobId: jobId, result: { results: res.results, errors: res.errors, total: res.total || totalGuess, cancelled: !!res.cancelled } });
        return { done: true, jobId: jobId, results: res.results, errors: res.errors, total: res.total || totalGuess, cancelled: !!res.cancelled };
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
    return waitForPngFile(info.posterPngPath, 120000).then(function () {
      var poster = fs.readFileSync(info.posterPngPath);
      try { fs.unlinkSync(info.posterPngPath); } catch (e) {}
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
      try { fs.unlinkSync(info.posterPngPath); } catch (e2) {}
      log("warn", "could not patch the .mogrt thumbnail: " + e.message);
      return {
        patched: false,
        posterTime: info.posterTime,
        reason: "The template exported correctly, but its thumbnail could not be replaced (" +
          e.message + "). It still shows the one After Effects wrote.",
      };
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
      return runOp(op, args).then(function (info) {
        return readPngFrame(info.path).then(function (img) {
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
      });
    }
    // Long batches: returns {jobId, async, total}. We kick off background drive
    // and return the jobId immediately.
    if (op === "run_batch") {
      return runOp(op, args).then(function (res) {
        if (res && res.async && res.jobId) {
          driveJob(res.jobId, progressToken).catch(function (e) {
            broadcast({ type: "error", jobId: res.jobId, error: e.message });
          });
          return { jobId: res.jobId, async: true, total: res.total };
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
