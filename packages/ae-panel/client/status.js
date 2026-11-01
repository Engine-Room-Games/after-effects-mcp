// status.js — the visible status panel (Window > Extensions > AE MCP Bridge).
//
// Issue #283. The bridge itself runs in a hidden extension of this bundle
// (games.engine-room.ae-mcp.panel, client/index.html + main.js) that starts
// with After Effects and is never shown. This page is a separate extension
// with no Node: it runs no server, binds no port, writes no file. It only
// shows what the bridge reports over a CEP event, so opening it — or opening
// it twice — can never start a second bridge.
//
// If the bridge does not answer, the one thing this page does is ask CEP to
// open the bridge extension, which CEP ignores for an extension already
// running. That is the recovery for a host that did not start the hidden
// extension on launch.

(function () {
  "use strict";

  var BRIDGE_ID = "games.engine-room.ae-mcp.panel";
  var STATUS_EVENT = "games.engine-room.ae-mcp.status";
  var STATUS_REQUEST = "games.engine-room.ae-mcp.status.request";
  var ASK_EVERY_MS = 2000;
  var SILENT_AFTER_MS = 6000;

  function $(id) { return document.getElementById(id); }
  function set(id, text, klass) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = klass || "";
  }

  var cs;
  try { cs = new CSInterface(); }
  catch (e) { set("status", "cannot ask the bridge — CSInterface is unavailable", "err"); return; }

  var lastHeard = 0;
  var openedBridge = false;
  var startedAt = new Date().getTime();

  function render(state) {
    set("status", state.status || "—", state.statusClass);
    set("port", state.port || "—", state.portClass);
    set("ae", state.ae || "—");
    set("jsx", state.jsx || "—", state.jsxClass);
    set("reqs", String(state.reqs || 0));
    var $log = $("log");
    if (!$log) return;
    while ($log.firstChild) $log.removeChild($log.firstChild);
    var lines = state.log || [];
    for (var i = 0; i < lines.length; i++) {
      var d = document.createElement("div");
      d.className = lines[i].level || "";
      d.textContent = lines[i].text;
      $log.appendChild(d);
    }
  }

  cs.addEventListener(STATUS_EVENT, function (event) {
    var data = event && event.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return; }
    }
    if (!data || typeof data !== "object") return;
    lastHeard = new Date().getTime();
    render(data);
  });

  function ask() {
    try {
      var ev = new CSEvent(STATUS_REQUEST, "APPLICATION");
      ev.data = "";
      cs.dispatchEvent(ev);
    } catch (e) {}
  }

  function tick() {
    var now = new Date().getTime();
    if (now - Math.max(lastHeard, startedAt) < SILENT_AFTER_MS) { ask(); return; }
    if (!openedBridge) {
      openedBridge = true;
      startedAt = now;
      set("status", "no answer from the bridge — asking After Effects to start it…", "warn");
      try { cs.requestOpenExtension(BRIDGE_ID, ""); } catch (e) {}
      ask();
      return;
    }
    set("status", "the bridge is not running", "err");
    set("port", "—");
    ask();
  }

  ask();
  setInterval(tick, ASK_EVERY_MS);
})();
