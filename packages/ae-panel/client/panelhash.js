// panelhash.js — the hash that names the panel's own code (issue #243).
//
// `bundleHash` on /health names the ExtendScript the panel evaluated. It says
// nothing about the files beside it — this one, main.js, index.html, the
// manifest — and a panel with a current bundle and old client code used to
// pass the version gate. `clientHash` is the other half: every shipped file of
// the panel except bundle.jsx, which has its own hash because /reload-jsx can
// replace it without a restart.
//
// The server computes the same value over the panel it ships
// (packages/mcp-server/src/setup/panelHash.ts) and over the installed copy;
// tests/unit/panel-hash.mjs holds the two implementations to each other.
// Change both together.
//
// Left out, and why:
//   jsx/bundle.jsx          its own hash (bundleHash), which follows reloads
//   node_modules/ (any)     `ws` is copied in beside the panel separately
//   .DS_Store (any)         Finder litter
//   META-INF/, mimetype     what a self-signed install adds (issues #91, #182);
//                           a signed install is a current install
//   package.json (root)     a version stamp; nothing at runtime reads it
// and in CSXS/manifest.xml the two version attributes are blanked, so a
// release that changes nothing in the panel does not ask every user to
// reinstall it and restart After Effects.
//
// A pure function of the files: sorted paths, '/' separators, no timestamps.

"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var SKIP_ANY_DEPTH = { "node_modules": true, ".DS_Store": true };
var SKIP_AT_ROOT = { "META-INF": true, "mimetype": true, "package.json": true };
var SKIP_PATHS = { "jsx/bundle.jsx": true };
var MANIFEST = "CSXS/manifest.xml";

function listFiles(dir, prefix, out) {
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (SKIP_ANY_DEPTH[name]) continue;
    if (!prefix && SKIP_AT_ROOT[name]) continue;
    var rel = prefix ? prefix + "/" + name : name;
    if (SKIP_PATHS[rel]) continue;
    var full = path.join(dir, name);
    // stat, not lstat: a `--symlink` dev install links into the source tree.
    if (fs.statSync(full).isDirectory()) listFiles(full, rel, out);
    else out.push(rel);
  }
  return out;
}

function normalise(rel, bytes) {
  if (rel !== MANIFEST) return bytes;
  var text = bytes.toString("utf8")
    .replace(/(ExtensionBundleVersion=")[^"]*(")/g, "$1$2")
    .replace(/(<Extension\s+Id="[^"]*"\s+Version=")[^"]*(")/g, "$1$2");
  return Buffer.from(text, "utf8");
}

/** sha256 over every panel file but the ones above, or null when the folder cannot be read. */
function panelClientHash(dir) {
  try {
    var files = listFiles(dir, "", []).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    var h = crypto.createHash("sha256");
    for (var i = 0; i < files.length; i++) {
      var bytes = normalise(files[i], fs.readFileSync(path.join(dir, files[i])));
      h.update(files[i] + "\u0000" + crypto.createHash("sha256").update(bytes).digest("hex") + "\n");
    }
    return h.digest("hex");
  } catch (e) {
    return null;
  }
}

module.exports = { panelClientHash: panelClientHash };
