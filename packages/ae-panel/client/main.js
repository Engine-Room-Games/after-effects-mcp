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
  var execFileSync = require("child_process").execFileSync;
  var WebSocket;
  try { WebSocket = require("ws"); }
  catch (e) {
    // ws is bundled in packages/ae-panel/node_modules; resolve manually if normal require fails.
    var alt = path.join(__dirname, "..", "node_modules", "ws");
    WebSocket = require(alt);
  }

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

  var cs = new CSInterface();
  var extDir = cs.getSystemPath(SystemPath.EXTENSION);
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
        throw err;
      }
      return parsed.result;
    });
  }

  // ---------- Load bundle.jsx ----------
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
        if (raw === "ok") { $jsx.textContent = "loaded"; $jsx.className = "ok"; resolve(); }
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
  // Shrink the PNG in place with `sips` (macOS built-in, no npm dependency).
  // saveFrameToPng always writes at full comp resolution, so this is the only
  // place `downsample` can be honoured. Returns the dimensions actually
  // produced — never claims a resize that did not happen.
  function shrinkPng(file, width, height, factor) {
    var outW = Math.max(1, Math.round(width / factor));
    var outH = Math.max(1, Math.round(height / factor));
    try {
      // sips takes height then width.
      execFileSync("sips", ["-z", String(outH), String(outW), file], { stdio: "ignore" });
      return { width: outW, height: outH, downsample: factor };
    } catch (e) {
      log("warn", "downsample " + factor + "x failed, returning full resolution: " + e.message);
      return {
        width: width,
        height: height,
        downsample: 1,
        warning: "downsample=" + factor + " was requested but `sips` failed (" + e.message +
          "); returning the full-resolution frame instead.",
      };
    }
  }

  function readPngAsBase64(file, downsample, width, height) {
    return waitForPngFile(file, 5000).then(function () {
      // Resize only after the file has finished being written.
      var dims = (downsample && downsample > 1)
        ? shrinkPng(file, width, height, downsample)
        : { width: width, height: height, downsample: 1 };
      var buf = fs.readFileSync(file);
      var b64 = buf.toString("base64");
      try { fs.unlinkSync(file); } catch (e) {}
      return {
        base64: b64,
        bytes: buf.length,
        width: dims.width,
        height: dims.height,
        downsample: dims.downsample,
        warning: dims.warning,
      };
    });
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

  // ---------- Op handler with vision/job specialization ----------
  function handleOp(op, args, progressToken) {
    // Vision ops: run JSX, then read PNG and base64-encode on Node side.
    if (op === "screenshot_frame" || op === "screenshot_layer") {
      var factor = (args && args.downsample) ? Math.round(args.downsample) : 1;
      return runOp(op, args).then(function (info) {
        return readPngAsBase64(info.path, factor, info.width, info.height).then(function (img) {
          var out = {
            width: img.width,
            height: img.height,
            fullWidth: info.width,
            fullHeight: info.height,
            downsample: img.downsample,
            time: info.time,
            compId: info.compId,
            layerId: info.layerId,
            mimeType: "image/png",
            base64: img.base64,
            bytes: img.bytes,
          };
          if (img.warning) out.warning = img.warning;
          return out;
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
          res.end(JSON.stringify({ ok: true, port: port, bundleLoaded: true, ts: Date.now() }));
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
                res.end(JSON.stringify({ ok: false, error: err.message, stack: err.aeStack, line: err.aeLine }));
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
