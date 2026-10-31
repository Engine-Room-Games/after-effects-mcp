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

  // The panel's own modules live in their own files so a Node test can require
  // them without a DOM. Same failure discipline as ws above — say what is
  // missing, name the fix.
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
  var panelHashModule;
  try {
    panelHashModule = requireSibling("panelhash.js");
  } catch (e) {
    setStatus("cannot start — one of the panel's modules is missing", "err");
    log("error", "loading the panel's modules from " + __dirname + " failed: " + e.message);
    log("error", "Quit After Effects, run the setup_panel tool, then reopen it.");
    return;
  }

  // ---------- Which panel code is this? (issue #243) ----------
  // Every file of this panel except bundle.jsx, hashed once, now: the files
  // CEP loaded at launch are the ones this process runs until After Effects
  // restarts, whatever setup_panel writes over them later. Reported on /health
  // beside bundleHash, and the server's version gate needs both to match the
  // panel it ships — bundleHash alone let a current bundle beside old client
  // code through. The algorithm is panelhash.js, ported to the server as
  // setup/panelHash.ts; the signature files a self-signed install adds are
  // left out of both, so a signed install is a current install.
  var loadedClientHash = panelHashModule.panelClientHash(extDir);
  if (!loadedClientHash) log("warn", "could not hash the panel's own files in " + extDir + "; the MCP server cannot confirm this panel is current and will ask for it to be reinstalled");

  var bundlePath = path.join(extDir, "jsx", "bundle.jsx");

  // ---------- ExtendScript evalScript: serialized via Promise chain ----------
  // `opts.gone`: asked when the call's turn comes, before anything is handed to
  // After Effects. A reason (string) means the MCP server has already given up
  // on the call — its deadline passed, or it closed the request — so the call
  // is dropped instead of run late and out of order behind whatever held After
  // Effects. A call already handed to evalScript is never touched. `opts.label`
  // is the op, reported on /health while it runs (`evalBusy`); absent for the
  // bundle load.
  var DEADLINE_GRACE_MS = 1000;
  // Milliseconds on a monotonic clock: no wall-clock change or sleep moves it.
  function monoNow() {
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") return performance.now();
    if (typeof process !== "undefined" && process.hrtime) { var t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }
    return Date.now();
  }
  var __evalChain = Promise.resolve();
  var __evalPending = 0;
  var __evalRunning = null;
  function evalScript(script, opts) {
    opts = opts || {};
    __evalPending += 1;
    var p = __evalChain.then(function () {
      // One turn of the event loop first, so Node reads the sockets that closed
      // while ExtendScript held this thread — a request read only once AE let
      // go may already have been abandoned — and `gone` sees it.
      return opts.gone ? new Promise(function (r) { setTimeout(r, 0); }) : null;
    }).then(function () {
      var why = opts.gone ? opts.gone() : null;
      if (why) {
        var gone = new Error("dropped before it ran: " + why);
        gone.code = "REQUEST_CLOSED";
        throw gone;
      }
      return new Promise(function (resolve, reject) {
        __evalRunning = { op: opts.label || "script", since: Date.now() };
        cs.evalScript(script, function (raw) {
          __evalRunning = null;
          if (raw === "EvalScript error.") {
            // The bundle load (no label) is a whole file, and there this
            // answer is what a parse or runtime error in it looks like.
            if (!opts.label) return reject(new Error("ExtendScript eval failed (syntax or runtime)"));
            // An op is one fixed line whose own failures come back as JSON, so
            // this bare answer is most often After Effects declining to run it
            // while the user has it held. The server words it per op.
            var refused = new Error("After Effects answered \"EvalScript error.\" for " + opts.label +
              " — most often it declined to run it while busy (a dialog, a menu, a text edit, a preview " +
              "or a render). Read back before re-sending.");
            refused.code = "EVAL_SCRIPT_ERROR";
            return reject(refused);
          }
          resolve(raw);
        });
      });
    });
    var settle = function () { __evalPending -= 1; };
    p.then(settle, settle);
    // Keep the chain alive even on rejection so subsequent calls aren't blocked.
    __evalChain = p.catch(function () { return null; });
    return p;
  }

  function evalBusyNow() {
    return __evalRunning ? { op: __evalRunning.op, ms: Date.now() - __evalRunning.since } : null;
  }

  // ---------- The bundle's one global (issue #185) ----------
  // After Effects runs every extension's evalScript, File > Scripts, ScriptUI
  // panels and osascript in one shared ExtendScript engine. The bundle keeps
  // everything in a closure and publishes only `__AEMCP` (scripts/bundle-jsx.mjs),
  // so another script can no longer replace `dispatch` or `OPS` under us. It can
  // still delete or overwrite `__AEMCP` itself, so every op checks it is ours
  // first and answers NS_MISSING — before running anything — when it is not.
  var NS_MISSING = "__AEMCP_MISSING__";
  var NS_READY = "(typeof __AEMCP === 'object' && __AEMCP !== null && " +
    "__AEMCP.id === 'games.engine-room.ae-mcp' && typeof __AEMCP.call === 'function')";

  // U+2028 and U+2029 are legal raw inside JSON but are line terminators in an
  // ES3 string literal, and JSON.stringify leaves them raw — so a text layer or
  // run_jsx script containing one became an unterminated literal and the whole
  // op died as "EvalScript error." (issue #163). Escaped in the JSON text, they
  // survive both the literal and ExtendScript's JSON.parse as the same
  // characters; the literal is escaped too, as a second line of defence.
  function escapeLineSeparators(json) {
    return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  function opScript(payload) {
    // JSON.stringify on the panel side, JSON.parse on the ExtendScript side.
    var literal = escapeLineSeparators(JSON.stringify(escapeLineSeparators(payload)));
    return NS_READY + " ? __AEMCP.call(" + literal + ") : '" + NS_MISSING + "'";
  }

  // One reload for however many ops found the namespace gone at once.
  var __healing = null;
  function healNamespace(op) {
    if (!__healing) {
      log("warn", "__AEMCP is missing or not ours (another script in After Effects' shared engine " +
        "replaced it) — reloading bundle.jsx before " + op);
      __healing = loadJsxBundle({ sameAsRunning: true }).then(
        function () { __healing = null; setStatus("ready", "ok"); },
        function (e) { __healing = null; throw e; }
      );
    }
    return __healing;
  }

  // Run an op through the dispatch table. Returns parsed JS object.
  // `gone` (optional): see evalScript — the op is dropped unrun once it answers a reason.
  function runOp(op, args, gone) {
    var payload = JSON.stringify({ op: op, args: args || {} });
    var evalOpts = { label: op, gone: gone };
    return evalScript(opScript(payload), evalOpts).then(function (raw) {
      if (raw !== NS_MISSING) return raw;
      // Nothing ran: NS_MISSING is answered instead of the op, so sending it
      // again after the reload cannot run it twice.
      return healNamespace(op).then(function () { return evalScript(opScript(payload), evalOpts); });
    }).then(function (raw) {
      if (raw === NS_MISSING) {
        throw new Error("The AE MCP bundle is not loaded in After Effects (__AEMCP missing even after reloading " +
          "bundle.jsx). Nothing ran. Restart After Effects.");
      }
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
            lineCount: parsed.lineCount,
            // `_run_jsx` (stage 6) leaves the mapping to the server and sends
            // these instead. Absent on every other failure, and JSON drops an
            // undefined, so they never reach the server unless they were set.
            wrapperLine: parsed.wrapperLine,
            libraryIndex: parsed.libraryIndex
          };
        }
        throw err;
      }
      return parsed.result;
    });
  }

  // ---------- What this panel supports ----------
  // Reported on /health as `capabilities` (issue #220). Since issue #243 the
  // server has no other path for any of these, and its version gate refuses a
  // panel that is not the one it ships; the list is what that gate falls back
  // on when it has no shipped panel to hash, so it must name everything the
  // server relies on:
  //   project-path — `_project_path` answers the .aep's path with no project
  //                  walk, so the server reads and writes house-style.md itself.
  //   server-images — `_screenshot_frame`, `_screenshot_layer` and
  //                  `_export_mogrt` reach the bundle untouched and answer with
  //                  file paths; the server reads the PNGs and patches the
  //                  .mogrt itself.
  //   server-run-jsx — `_run_jsx` runs a script the server assembled, and a
  //                  failure carries `wrapperLine`/`libraryIndex` (forwarded
  //                  above) for the server to map onto the caller's file.
  //   server-drives-jobs — a chunked run_batch is handed back with
  //                  `driver: "server"`, and the server sends each chunk.
  var PANEL_CAPABILITIES = ["project-path", "server-images", "server-run-jsx", "server-drives-jobs"];

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

  // `opts.sameAsRunning`: the automatic heal, which must re-load the code this
  // panel is already running and nothing newer. Between setup_panel and the
  // next After Effects launch the installed bundle.jsx is newer than this
  // main.js; loading it would mix the two and move `loadedBundleHash` onto the
  // new hash, so the version gate would call a stale panel current. The heal
  // refuses instead and the running hash keeps saying "restart needed".
  // `/reload-jsx` is the dev route and loads whatever is on disk.
  function loadJsxBundle(opts) {
    setStatus("Loading bundle.jsx…");
    if (!fs.existsSync(bundlePath)) {
      setStatus("bundle.jsx missing", "err");
      log("error", "bundle.jsx not found at " + bundlePath + " — run `npm run build:jsx`");
      return Promise.reject(new Error("bundle.jsx missing"));
    }
    var diskHash = hashFile(bundlePath);
    if (opts && opts.sameAsRunning && loadedBundleHash && diskHash !== loadedBundleHash) {
      setStatus("restart After Effects", "err");
      return Promise.reject(new Error(
        "The AE MCP bundle was removed from After Effects' shared script engine by another script, and the " +
        "installed bundle.jsx is a newer version than this running panel, so it cannot be reloaded in place. " +
        "Nothing ran. Restart After Effects."));
    }
    // Use $.evalFile from ExtendScript side so paths work cross-platform.
    // Through the evalScript mutex like every other call: the heal triggers
    // this while ops are queued, and a load must not interleave with one.
    var loadScript = "$.evalFile(" + JSON.stringify(bundlePath) + "); " + NS_READY + " ? 'ok' : 'no-namespace';";
    return evalScript(loadScript).then(function (raw) {
      if (raw === "ok") {
        loadedBundleHash = diskHash;
        $jsx.textContent = "loaded";
        $jsx.className = "ok";
        return;
      }
      $jsx.textContent = "fail: " + raw; $jsx.className = "err";
      throw new Error("__AEMCP not defined after loading bundle.jsx: " + raw);
    }, function (e) {
      $jsx.textContent = "fail: " + e.message; $jsx.className = "err";
      throw e;
    });
  }

  // ---------- Port file (so MCP server can discover) ----------
  // Written only once a port is actually bound, and only with that port. The
  // file is a hint for the server, never the authority — the socket is — and
  // the one way it lies is by describing a bind that did not happen or a panel
  // that has since gone (issue #92). So it is written after `listen` succeeds
  // and removed again on unload, and never with a port this panel merely tried.
  var portDir = path.join(os.homedir(), ".engineroom-ae-mcp");
  var portFile = path.join(portDir, "port");
  var configFile = path.join(portDir, "config.json");

  function writePortFile(port) {
    try { fs.mkdirSync(portDir, { recursive: true }); } catch (e) {}
    try { fs.writeFileSync(portFile, String(port), "utf8"); } catch (e) { log("warn", "could not write port file: " + e.message); }
  }

  // Only this panel's own entry. Another panel may have written the file since
  // — a second After Effects instance, say — and its port is not ours to erase.
  function removePortFile(port) {
    try {
      if (fs.readFileSync(portFile, "utf8").trim() === String(port)) fs.unlinkSync(portFile);
    } catch (e) {}
  }

  // ---------- Bridge token (issue #106) ----------
  // Why a token and not a CORS rule, and why per port: docs/fragile-areas-bridge.md.
  // One per panel session. 384 is 0600 for engines that predate 0o literals.
  var sessionToken = crypto.randomBytes(32).toString("hex");
  var TOKEN_MODE = 384;

  function tokenFile(port) { return path.join(portDir, "token-" + port); }

  function writeTokenFile(port) {
    try { fs.mkdirSync(portDir, { recursive: true }); } catch (e) {}
    try {
      fs.writeFileSync(tokenFile(port), sessionToken, { encoding: "utf8", mode: TOKEN_MODE });
      // writeFileSync applies `mode` only when it creates the file.
      try { fs.chmodSync(tokenFile(port), TOKEN_MODE); } catch (e) {}
    } catch (e) {
      log("error", "could not write the bridge token file " + tokenFile(port) + ": " + e.message +
        " — the MCP server will not be able to authenticate, and every tool call will be refused.");
    }
  }

  // Same rule as the port file: only this panel's own entry.
  function removeTokenFile(port) {
    try {
      if (fs.readFileSync(tokenFile(port), "utf8").trim() === sessionToken) fs.unlinkSync(tokenFile(port));
    } catch (e) {}
  }

  function sameToken(given) {
    if (typeof given !== "string" || given.length !== sessionToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(sessionToken, "utf8"));
    } catch (e) {
      return false;
    }
  }

  // The token is what holds. The Origin check is depth: browsers always send one,
  // Node's fetch and `ws` never do.
  function authFailure(req) {
    var h = (req && req.headers) || {};
    if (h.origin) return "it came from a web page (Origin: " + h.origin + ")";
    if (!sameToken(h["x-ae-mcp-token"])) return "the bridge token was missing or did not match";
    return null;
  }

  // Written for an MCP server older than this panel: it relays `error` verbatim,
  // so the remedy has to be in here.
  function denialMessage() {
    return "This After Effects bridge requires a token and this request did not carry a valid one. " +
      "Nothing was run in After Effects. The panel writes the token beside its port file, in " + portDir +
      ", each time it binds; a local process can read it and a web page cannot, which is the entire point " +
      "(issue #106). If you are the MCP server: you are older than the panel After Effects is running — " +
      "update after-effects-mcp to 0.5.1 or newer and reconnect it.";
  }

  // Rate-limited: a page firing in a loop must not fill the panel's log.
  var denied = 0;
  var deniedLoggedAt = 0;
  function noteDenial(what, why) {
    denied += 1;
    var now = Date.now();
    if (denied === 1 || now - deniedLoggedAt > 10000) {
      deniedLoggedAt = now;
      log("warn", "refused a request to " + what + ": " + why +
        (denied > 1 ? " (" + denied + " refused so far)" : "") +
        ". If this is the MCP server rather than a web page, it is older than this panel: update it and reconnect.");
    }
  }

  // ---------- Config ----------
  // A CEP panel cannot read an environment variable the user set: it runs in
  // After Effects' process, with Adobe's environment. So its two knobs live in
  // a JSON file beside the port file, ~/.engineroom-ae-mcp/config.json:
  //
  //   { "port": 7777, "allowPortWalk": false }
  //
  //   port          the port to bind. Default 7777. 0 binds an ephemeral port,
  //                 which is what the offline tests use.
  //   allowPortWalk when the port is held by another AE MCP panel, move to the
  //                 next free one instead of waiting for it. For people who run
  //                 two After Effects instances at once. Off by default: on one
  //                 machine the holder is a zombie, and walking around it is
  //                 what issue #92 was.
  //
  // Anything unreadable is logged and ignored; the defaults are what shipped.
  var DEFAULT_PORT = 7777;
  function readConfig() {
    var cfg = { port: DEFAULT_PORT, allowPortWalk: false, bindRetryMs: 2000, source: null };
    var raw;
    try { raw = fs.readFileSync(configFile, "utf8"); } catch (e) { return cfg; }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { log("warn", "ignoring " + configFile + " — not valid JSON (" + e.message + ")"); return cfg; }
    if (!parsed || typeof parsed !== "object") {
      log("warn", "ignoring " + configFile + " — expected a JSON object");
      return cfg;
    }
    cfg.source = configFile;
    if (parsed.port !== undefined) {
      if (typeof parsed.port === "number" && parsed.port >= 0 && parsed.port <= 65535 && parsed.port === Math.floor(parsed.port)) cfg.port = parsed.port;
      else log("warn", "ignoring \"port\" in " + configFile + " — expected a whole number 0-65535, got " + JSON.stringify(parsed.port));
    }
    if (parsed.allowPortWalk !== undefined) {
      if (typeof parsed.allowPortWalk === "boolean") cfg.allowPortWalk = parsed.allowPortWalk;
      else log("warn", "ignoring \"allowPortWalk\" in " + configFile + " — expected true or false");
    }
    // Undocumented on purpose: how often to retry a held port. Tests shorten it.
    if (typeof parsed.bindRetryMs === "number" && parsed.bindRetryMs >= 50) cfg.bindRetryMs = parsed.bindRetryMs;
    return cfg;
  }

  // ---------- Event socket ----------
  // /events is still served (see startServers): the MCP server reads its
  // reopening as a sign that After Effects restarted. No job events are sent
  // on it since issue #243 — the server drives every batch itself.
  var wsClients = new Set();

  // ---------- Batches in flight ----------
  // A chunked run_batch is handed back to the server (`driver: "server"`),
  // which sends each `_continue_job` itself, so progress, cancel and the
  // job's state are the server's. Each chunk opens and closes its own undo
  // group inside one evalScript (issue #69). Only what /reload-jsx needs is
  // kept here: the job table lives in the bundle's closure, so a reload would
  // drop each of these mid-run, and /reload-jsx reads this to refuse instead
  // (issue #163). Jobs are tracked as their chunks pass through, and one no
  // chunk has reached for SERVER_JOB_IDLE_MS is taken for a batch whose server
  // stopped (it died), so it no longer blocks a reload.
  var jobsInFlight = {};
  var SERVER_JOB_IDLE_MS = 10 * 60 * 1000;

  function trackServerJob(jobId, total) {
    jobsInFlight[jobId] = { attempted: 0, total: (typeof total === "number") ? total : null, seenAt: Date.now() };
  }

  function noteServerChunk(jobId, res) {
    var j = jobsInFlight[jobId];
    if (!j) return;
    if (!res || res.done) { delete jobsInFlight[jobId]; return; }
    if (typeof res.progress === "number") j.attempted = res.progress;
    if (typeof res.total === "number") j.total = res.total;
    j.seenAt = Date.now();
  }

  function jobsInFlightText() {
    var parts = [];
    var now = Date.now();
    for (var id in jobsInFlight) {
      if (!jobsInFlight.hasOwnProperty(id)) continue;
      var j = jobsInFlight[id];
      if (now - j.seenAt > SERVER_JOB_IDLE_MS) continue;
      parts.push(id + " (" + j.attempted + " of " + (j.total === null ? "?" : j.total) + " ops attempted" +
        ", driven by the MCP server)");
    }
    return parts.join(", ");
  }

  // ---------- Op handler ----------
  // Everything goes to the bundle as sent. Screenshots, the .mogrt thumbnail,
  // the house style's file I/O and run_jsx's assembly are the server's (issue
  // #220), and the copies of that work that used to live here are gone (issue
  // #243). What is left is bookkeeping for /reload-jsx.
  function handleOp(op, args, gone) {
    if (op === "run_batch") {
      // The driver flag is the server's word to this panel, never an op
      // argument: ExtendScript does not see it.
      if (args && args.__driver !== undefined) {
        var stripped = {};
        for (var ak in args) { if (args.hasOwnProperty(ak) && ak !== "__driver") stripped[ak] = args[ak]; }
        args = stripped;
      }
      return runOp(op, args, gone).then(function (res) {
        if (res && res.async && res.jobId) {
          trackServerJob(res.jobId, res.total);
          // The undo fields ride out with the envelope so the agent is told the
          // batch will be several steps *before* it goes and says otherwise.
          return {
            jobId: res.jobId,
            async: true,
            total: res.total,
            chunkSize: res.chunkSize,
            undoStepsEstimate: res.undoStepsEstimate,
            undoGroupName: res.undoGroupName,
            note: res.note,
            aeWarnings: res.aeWarnings,
            driver: "server",
          };
        }
        return res; // small batch: inline result already
      });
    }
    // One chunk of a batch: passed through untouched, watched only for
    // /reload-jsx.
    if (op === "_continue_job" && args && jobsInFlight[args.jobId]) {
      var cj = args.jobId;
      return runOp(op, args, gone).then(function (res) {
        noteServerChunk(cj, res);
        return res;
      }, function (e) {
        noteServerChunk(cj, null);
        throw e;
      });
    }
    return runOp(op, args, gone);
  }

  // ---------- HTTP server ----------
  function startHttp(port) {
    return new Promise(function (resolve, reject) {
      var server = http.createServer(function (req, res) {
        // When the request arrived, on a clock no wall-clock change moves.
        var receivedAt = monoNow();
        var url = req.url || "/";
        // Only /reload-jsx takes a query (`?force=1`); every other route is
        // still matched on the whole url, as before.
        var qAt = url.indexOf("?");
        var route = qAt < 0 ? url : url.slice(0, qAt);
        var query = qAt < 0 ? "" : url.slice(qAt + 1);

        // No CORS headers, deliberately: nothing that legitimately calls this
        // bridge is a web page (issue #106).

        if (url === "/health") {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          // bundleHash identifies the code this panel is *running*, which is what
          // the server needs to know before sending an op the panel may predate.
          // `ok` + `bundleHash` is also how another copy of this panel, and the
          // server's discovery, recognise this as an AE MCP panel — see
          // isOurHealth below and isPanelHealth in the server's discovery.ts.
          // The port is read off the socket, not the argument: port 0 binds an
          // ephemeral one and the argument would say 0.
          var addr = server.address();
          res.end(JSON.stringify({
            ok: true,
            port: addr && addr.port ? addr.port : port,
            bundleLoaded: true,
            bundleHash: loadedBundleHash,
            // Every other file of this panel, hashed at launch (issue #243). The
            // server's gate needs both hashes to match the panel it ships.
            clientHash: loadedClientHash,
            // The gate exists, never anything about the token. Absent on a
            // pre-#106 panel, which is how the server tells "needs a token"
            // from "too old to want one".
            auth: true,
            // What this panel can do (issue #220). The server's gate reads it
            // only when it has no shipped panel to compare the hashes with.
            capabilities: PANEL_CAPABILITIES,
            // The script handed to After Effects with no answer yet, or null.
            // The server's busy guard reads it after a timeout: answered here
            // with this set, After Effects is still on that script. (While
            // ExtendScript holds this thread, /health is not answered at all.)
            evalBusy: evalBusyNow(),
            evalQueued: Math.max(0, __evalPending - (__evalRunning ? 1 : 0)),
            ts: Date.now()
          }));
          return;
        }

        if (req.method !== "POST") {
          res.statusCode = 405; res.end("POST only");
          return;
        }

        // Every route below reaches After Effects. Checked before the body is
        // read, so an unidentified caller cannot make us buffer anything.
        var denial = authFailure(req);
        if (denial) {
          noteDenial(url, denial);
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: denialMessage(), code: "bridge_unauthorized" }));
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
            // Queued behind a stuck call, an op would otherwise still run once
            // After Effects frees up — late, out of order, after the agent was
            // told it timed out. So it is dropped at its turn once the server
            // has given up on it. The server sends its own timeout as
            // `timeoutMs` (relative), and the panel runs the same span from
            // the request's arrival on a monotonic clock — arrival is after
            // the server started its timer, so this deadline is never earlier
            // than the server's, and DEADLINE_GRACE_MS on top makes a dropped
            // call only ever one the server already reported as timed out.
            // It needs no socket event to reach this thread in time; the
            // request closing is a second signal. No `timeoutMs` (an older
            // server): only the close is checked.
            var replied = false;
            var closedEarly = false;
            res.on("close", function () { if (!replied) closedEarly = true; });
            var limitMs = typeof body.timeoutMs === "number" && isFinite(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : null;
            var gone = function () {
              var over = limitMs === null ? 0 : monoNow() - receivedAt - limitMs;
              if (limitMs !== null && over > DEADLINE_GRACE_MS) {
                return "the MCP server's deadline for it passed " + Math.round(over / 1000) +
                  "s ago while it was queued behind another call";
              }
              if (closedEarly || (req.socket && req.socket.destroyed)) {
                return "the MCP server closed its request (it gave up waiting) while it was queued behind another call";
              }
              return null;
            };
            handleOp(body.op, body.args, gone)
              .then(function (result) {
                replied = true;
                res.statusCode = 200; res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: result }));
              })
              .catch(function (err) {
                replied = true;
                if (err && err.code === "REQUEST_CLOSED") {
                  log("warn", body.op + " was not run, " + err.message.replace(/^dropped before it ran: /, "") +
                    " — dropped rather than run late.");
                  // No answer: the server has already reported this call as
                  // timed out, and nothing it could read here would be newer.
                  try { res.destroy(); } catch (e) {}
                  return;
                }
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

          if (route === "/reload-jsx") {
            // Dev-only: re-evalFile the bundle. Useful while editing .jsx without restarting AE.
            // A reload replaces the bundle's job table, so every batch in flight
            // stops mid-run with part of it applied (issue #163). Refused while
            // one runs; `?force=1` reloads anyway, and the batch then reports
            // exactly what had landed.
            var busy = jobsInFlightText();
            if (busy && !/(^|&)force=1(&|$)/.test(query)) {
              res.statusCode = 409;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({
                ok: false,
                code: "batch_in_flight",
                error: "Not reloaded: a run_batch is still running — " + busy + ". Reloading the bundle now " +
                  "would stop it mid-run with part of it applied. Wait for it to finish (await_job), or cancel " +
                  "it (cancel_job), then reload. POST /reload-jsx?force=1 reloads anyway.",
              }));
              return;
            }
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

  // ---------- Who holds the port? ----------
  // The same test the server's discovery makes (isPanelHealth in discovery.ts):
  // `ok` plus `bundleHash` — or `bundleLoaded`, on a panel from before the hash
  // existed — is what nothing else on a loopback port would answer with.
  function isOurHealth(body) {
    return !!body && typeof body === "object" && body.ok === true &&
      ("bundleHash" in body || "bundleLoaded" in body);
  }

  // Never rejects: every outcome is a classification the caller acts on.
  //   panel  — another AE MCP panel; its health body is attached
  //   other  — something answered, but not as the panel
  //   silent — accepted the connection and said nothing, or errored
  function identifyHolder(port) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(r) { if (!done) { done = true; resolve(r); } }
      var req = http.get({ host: "127.0.0.1", port: port, path: "/health", timeout: 1500 }, function (res) {
        var bufs = [];
        res.on("data", function (c) { bufs.push(c); });
        res.on("end", function () {
          var body = null;
          try { body = JSON.parse(Buffer.concat(bufs).toString("utf8")); } catch (e) {}
          if (res.statusCode === 200 && isOurHealth(body)) finish({ kind: "panel", health: body });
          else finish({ kind: "other", detail: "answered HTTP " + res.statusCode + (body ? " with an unfamiliar body" : " with no JSON") });
        });
        res.on("error", function (e) { finish({ kind: "silent", detail: e.message }); });
      });
      req.on("timeout", function () { req.destroy(); finish({ kind: "silent", detail: "accepted the connection but did not answer within 1.5s" }); });
      req.on("error", function (e) { finish({ kind: "silent", detail: e.message }); });
    });
  }

  // 7777 through 7799 was the old ceiling; kept as a distance so a configured
  // start port walks the same number of steps.
  var WALK_LIMIT = 22;
  var MAX_PORT = 65535;

  /**
   * Bind the configured port, and decide what to do when it is taken.
   *
   * It used to walk: EADDRINUSE, try the next port, up to 7799, then write
   * whatever it got to the port file. On one machine nothing else ever holds
   * 7777, so the thing being walked around was always a previous instance of
   * this same panel — a CEPHtmlEngine that lingered across an After Effects
   * relaunch, or a second panel window — and the walk routed round it in
   * silence, leaving the port file as a second source of truth that could
   * disagree with the socket. Four incidents in a week (issue #92).
   *
   * So the holder is identified first. If it is one of us, this panel does not
   * move: it says so in its status and log, and retries the bind on an interval
   * so it takes the port over the moment the other one exits, with no restart.
   * If it is something else, or answers nothing, the walk happens as before —
   * loudly, naming the holder and the port chosen, because that is the one
   * case where the port file legitimately says something other than 7777.
   * `allowPortWalk` in config.json opts back into walking past our own panel,
   * for people who really run two After Effects instances.
   */
  function startServers(cfg) {
    var startPort = cfg.port;
    var retryMs = cfg.bindRetryMs;
    var waits = 0;

    function bindWith(p) {
      return startHttp(p).then(function (server) {
        // Read back rather than assumed: port 0 binds an ephemeral one.
        var bound = server.address().port;
        // The socket is already accepting, so the token must be on disk before
        // this promise resolves — not later in the boot.
        writeTokenFile(bound);
        // Mount WS on the same HTTP server.
        var wss = new WebSocket.Server({
          server: server,
          path: "/events",
          // WebSockets ignore the same-origin policy entirely, so without this
          // any page could watch the user's event stream (issue #106).
          verifyClient: function (info, cb) {
            var why = authFailure(info.req);
            if (!why) return cb(true);
            noteDenial("/events", why);
            cb(false, 403, "Forbidden");
          },
        });
        wss.on("connection", function (ws) {
          wsClients.add(ws);
          ws.on("close", function () { wsClients.delete(ws); });
        });
        return { port: bound, server: server, wss: wss };
      });
    }

    function walk(p, tries, why) {
      var next = p + 1;
      // There is no port past 65535: asking for one made listen() throw a
      // RangeError that named no port the user had configured (issue #260).
      var offTheTop = next > MAX_PORT;
      if (tries >= WALK_LIMIT || offTheTop) {
        throw new Error("ports " + startPort + " through " + p + " are all in use — nothing free to bind" +
          (offTheTop ? " (" + MAX_PORT + " is the highest port there is; set a lower \"port\" in " + configFile + ")" : "") +
          ". Last holder: " + why);
      }
      log("warn", "port " + p + " is held by " + why + " — moving to port " + next + ". " +
        "The MCP server finds this port through the port file; if tool calls fail on " + p +
        " while check_setup passes, this is why, and the server re-checks the port on the next refused call.");
      return attempt(next, tries + 1);
    }

    function waitForHolder(p, holder) {
      var same = holder.health.bundleHash && holder.health.bundleHash === loadedBundleHash;
      var hash = holder.health.bundleHash
        ? String(holder.health.bundleHash).slice(0, 12)
        : "no bundleHash — a panel older than 0.3";
      setStatus("waiting — port " + p + " is held by another AE MCP panel", "warn");
      if (waits === 0) {
        log("warn", "port " + p + " is already held by another AE MCP panel (bundle " + hash + ", " +
          (same ? "the same version as this one" : "a DIFFERENT version from this one") + "). " +
          "Not moving to another port: that would leave the port file pointing at whichever panel bound last, " +
          "and the MCP server talking to the wrong one (issue #92).");
        log("warn", "Retrying the bind every " + (retryMs / 1000) + "s; this panel takes the port over the moment " +
          "the other one exits, with no restart. If After Effects was relaunched and this persists, the previous " +
          "panel process is still running: quit After Effects fully, check Activity Monitor / Task Manager for a " +
          "leftover CEPHtmlEngine, and reopen it. To run two After Effects at once instead, set " +
          "\"allowPortWalk\": true in " + configFile + ".");
      } else if (waits % 30 === 0) {
        log("info", "still waiting for port " + p + " (" + waits + " attempts)");
      }
      waits += 1;
      return new Promise(function (r) { setTimeout(r, retryMs); }).then(function () { return attempt(p, 0); });
    }

    function attempt(p, tries) {
      return bindWith(p).catch(function (e) {
        if (e.code !== "EADDRINUSE") throw e;
        return identifyHolder(p).then(function (holder) {
          if (holder.kind === "panel") {
            if (cfg.allowPortWalk) {
              return walk(p, tries, "another AE MCP panel, and allowPortWalk is on in " + configFile);
            }
            return waitForHolder(p, holder);
          }
          var why = holder.kind === "other"
            ? "something that is not an AE MCP panel (" + holder.detail + ")"
            : "something that did not identify itself (" + holder.detail + ")";
          return walk(p, tries, why);
        });
      });
    }
    return attempt(startPort, 0);
  }

  // ---------- Shutdown ----------
  // When the panel window closes or After Effects quits, give the port back and
  // take this panel's port-file entry with it. A panel that exits cleanly must
  // not leave a file naming a port nobody listens on — that is the other half
  // of how the port file came to disagree with the socket (issue #92). A
  // process that dies without unloading still leaves the file; the server's
  // discovery treats the file as a hint for exactly that reason.
  var running = null;
  function shutdown() {
    if (!running) return;
    var s = running;
    running = null;
    try { s.wss.close(); } catch (e) {}
    try { if (typeof s.server.closeAllConnections === "function") s.server.closeAllConnections(); } catch (e) {}
    try { s.server.close(); } catch (e) {}
    removePortFile(s.port);
    removeTokenFile(s.port);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", shutdown);
    window.addEventListener("unload", shutdown);
  }

  // ---------- Boot sequence ----------
  setStatus("Starting…");
  try {
    var host = cs.getHostEnvironment();
    $ae.textContent = (host && host.appName ? host.appName : "AE") + " " + (host && host.appVersion ? host.appVersion : "");
  } catch (e) {}

  var config = readConfig();
  if (config.source) {
    log("info", "read " + config.source + ": port " + config.port + (config.allowPortWalk ? ", allowPortWalk on" : ""));
  }

  loadJsxBundle()
    .then(function () { return startServers(config); })
    .then(function (s) {
      running = s;
      // The only write of the port file, and only with the port actually bound.
      writePortFile(s.port);
      $port.textContent = String(s.port);
      $port.className = "ok";
      setStatus("ready", "ok");
      log("info", "Bridge listening on http://127.0.0.1:" + s.port +
        (s.port !== config.port && config.port !== 0 ? " (configured port " + config.port + " was taken — see above)" : ""));
      log("info", "Calls are authenticated: the MCP server reads this session's token from " + tokenFile(s.port) + ".");
    })
    .catch(function (e) {
      setStatus("failed", "err");
      log("error", e.message);
    });
})();
