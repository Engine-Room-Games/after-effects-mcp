// status.js — the visible status panel (Window > Extensions > AE MCP Bridge).
//
// Issue #283. The bridge itself runs in a hidden extension of this bundle
// (games.engine-room.ae-mcp.bridge, client/index.html + main.js) that starts
// with After Effects and is never shown. This page is a separate extension
// with no Node: it runs no server, binds no port, writes no file. It only
// shows what the bridge reports over a CEP event, so opening it — or opening
// it twice — can never start a second bridge.
//
// It keeps the id the old visible bridge had (games.engine-room.ae-mcp.panel),
// so a workspace saved with that panel docked restores this window into the
// same frame rather than pointing a Panel slot at a hidden extension.
//
// Silence is not death. While After Effects runs a long script the bridge's
// answers can stop for as long as the script runs, so a quiet bridge is shown
// as "no answer for Ns (After Effects may be busy)" and the window goes back
// to the bridge's own status the moment an answer arrives. The one active
// thing this page does is for a bridge it has never heard from: ask CEP, once,
// to open the bridge extension — a no-op for an extension already running,
// and the recovery for a host that did not start it at launch.

(function () {
  "use strict";

  var BRIDGE_ID = "games.engine-room.ae-mcp.bridge";
  // Event types are their own namespace, never an extension id.
  var STATUS_EVENT = "games.engine-room.ae-mcp.event.status";
  var STATUS_REQUEST = "games.engine-room.ae-mcp.event.status-request";
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
    var since = lastHeard || startedAt;
    ask();
    if (now - since < SILENT_AFTER_MS) return;
    if (!lastHeard && !openedBridge) {
      openedBridge = true;
      try { cs.requestOpenExtension(BRIDGE_ID, ""); } catch (e) {}
    }
    // The port and the log stay as last reported: they are still true of a
    // bridge that is busy, and the next answer replaces all of it.
    set("status", "no answer for " + Math.round((now - since) / 1000) + "s (After Effects may be busy)", "warn");
  }

  ask();
  setInterval(tick, ASK_EVERY_MS);
})();
