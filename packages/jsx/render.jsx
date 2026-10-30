// render.jsx — the render queue: add, list, remove, and the prepare half of a
// render (issue #137).
//
// The render itself does NOT happen in here, and that is the design rather than
// an omission. `app.project.renderQueue.render()` is synchronous: it holds the
// ExtendScript thread, and After Effects' interface with it, for the whole
// render. Every other call on the panel's evalScript chain waits behind it, the
// server's op timeout fires on a render that is still going, and nothing can
// cancel it from a script — the Stop button is the user's, not ours. So the
// queue is built here, the project is saved, and the server renders the saved
// project with `aerender` in a separate process it can watch and kill. See
// "The render queue" in docs/fragile-areas-ae.md.
//
// Output modules are configured by TEMPLATE NAME and never by setSettings:
// After Effects rejects Format, Channels, Depth and Color as read-only from a
// script although getSettings(SPEC) lists them (issue #95). Whatever a template
// actually produced is read back with getSettings(STRING), because a template
// name is a promise and the read-back is the fact.

/** The names of RQItemStatus, so a status is reported as a word and not a number. */
var __RQ_STATUS_NAMES = [
  "QUEUED", "UNQUEUED", "NEEDS_OUTPUT", "RENDERING", "WILL_CONTINUE",
  "USER_STOPPED", "ERR_STOPPED", "DONE",
];

function __rqStatusName(status) {
  for (var i = 0; i < __RQ_STATUS_NAMES.length; i++) {
    var n = __RQ_STATUS_NAMES[i];
    try { if (RQItemStatus[n] === status) return n; } catch (e) {}
  }
  return String(status);
}

/** Frames this item will render, from its time span and the comp's frame rate. */
function __rqFrames(item) {
  var fps = 0;
  try { fps = item.comp.frameRate; } catch (e) { fps = 0; }
  var dur = 0;
  try { dur = item.timeSpanDuration; } catch (e2) { dur = 0; }
  if (!(fps > 0) || !(dur > 0)) return 0;
  return Math.max(1, Math.round(dur * fps));
}

/** An image-sequence output names its frame number as [###] in the file name. */
function __rqIsSequencePath(p) {
  return /\[#+\]/.test(String(p));
}

/** ExtendScript has no path module; absolute is all this needs to know. */
function __rqIsAbsolutePath(p) {
  var s = String(p);
  if (s.charAt(0) === "/" || s.charAt(0) === "~") return true;
  if (/^[A-Za-z]:[\\\/]/.test(s)) return true;
  if (s.substring(0, 2) === "\\\\") return true;
  return false;
}

/** Search a getSettings(STRING) tree, which nests by section, for one key. */
function __rqFindSetting(tree, key, depth) {
  if (!tree || typeof tree !== "object" || depth > 4) return null;
  if (tree.hasOwnProperty(key)) {
    var v = tree[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  }
  for (var k in tree) {
    if (!tree.hasOwnProperty(k)) continue;
    var sub = tree[k];
    if (sub && typeof sub === "object") {
      var found = __rqFindSetting(sub, key, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * What an output module will actually write, read back from After Effects.
 * Null where this AE will not say — an unanswered read is not a fact.
 */
function __rqOmSettings(om) {
  var s = null;
  try { s = om.getSettings(GetSettingsFormat.STRING); } catch (e) { return null; }
  if (!s) return null;
  return {
    format: __rqFindSetting(s, "Format", 0),
    channels: __rqFindSetting(s, "Channels", 0),
    depth: __rqFindSetting(s, "Depth", 0),
    color: __rqFindSetting(s, "Color", 0),
  };
}

function __rqOmPath(om) {
  try { return om.file ? om.file.fsName : null; } catch (e) { return null; }
}

function __rqOmTemplateName(om) {
  try { return om.name ? String(om.name) : null; } catch (e) { return null; }
}

function __rqHasName(list, name) {
  if (!list) return false;
  for (var i = 0; i < list.length; i++) { if (String(list[i]) === String(name)) return true; }
  return false;
}

function __rqNames(list) {
  var out = [];
  if (!list) return out;
  for (var i = 0; i < list.length; i++) out.push(String(list[i]));
  return out;
}

function __rqItemSummary(rq, index, withSettings) {
  var item = rq.item(index);
  var outputs = [];
  var n = 0;
  try { n = item.numOutputModules; } catch (e) { n = 0; }
  for (var o = 1; o <= n; o++) {
    var om = item.outputModule(o);
    var out = { index: o, path: __rqOmPath(om), template: __rqOmTemplateName(om) };
    if (withSettings) out.settings = __rqOmSettings(om);
    outputs.push(out);
  }
  var compId = null;
  var compName = null;
  try { compId = item.comp.id; compName = item.comp.name; } catch (e2) {}
  return {
    index: index,
    compId: compId,
    compName: compName,
    status: __rqStatusName(item.status),
    render: item.render === true,
    timeSpanStart: item.timeSpanStart,
    timeSpanDuration: item.timeSpanDuration,
    frames: __rqFrames(item),
    outputs: outputs,
  };
}

// ---------------------------------------------------------------------------
// One output path, one item (issue #228).
//
// aerender refuses a render queue item whose output another queued item
// already uses ("output module name already in use") — at render time, after
// the save and the snapshot, when the agent has long moved on. So the clash is
// refused when it is made, here, where the queue is: the server could only
// check it with a second round trip to read the queue first.
//
// Two spellings of one file must compare equal, so a path is reduced to a key:
// links resolved, Unicode composed (NFC — Finder and macOS file names hand out
// NFD), slashes one way, and case folded. Case is folded on both platforms:
// the default volumes on macOS and Windows are case-insensitive, and on the
// rare case-sensitive volume the cost is a refusal that names both paths, never
// a broken render. ExtendScript has no realpath and no String.normalize, so
// both are done by hand. The server repeats the check before render_queue with
// Node's realpath and normalize (`duplicateOutputs` in render/aerender.ts),
// which also covers items queued by hand.
// ---------------------------------------------------------------------------

/**
 * Canonical compositions, three UTF-16 units each: a base character, one
 * combining mark, and the precomposed character they make. Generated from
 * Node's String.prototype.normalize over Latin, Greek, Cyrillic, Latin
 * Extended Additional, Greek Extended and kana; tests/unit/render-queue.mjs
 * checks every entry against it. Hangul is composed arithmetically below.
 */
var __RQ_NFC_PAIRS =
  "\u0041\u0300\u00C0\u0041\u0301\u00C1\u0041\u0302\u00C2\u0041\u0303\u00C3\u0041\u0308\u00C4\u0041\u030A\u00C5" +
  "\u0043\u0327\u00C7\u0045\u0300\u00C8\u0045\u0301\u00C9\u0045\u0302\u00CA\u0045\u0308\u00CB\u0049\u0300\u00CC" +
  "\u0049\u0301\u00CD\u0049\u0302\u00CE\u0049\u0308\u00CF\u004E\u0303\u00D1\u004F\u0300\u00D2\u004F\u0301\u00D3" +
  "\u004F\u0302\u00D4\u004F\u0303\u00D5\u004F\u0308\u00D6\u0055\u0300\u00D9\u0055\u0301\u00DA\u0055\u0302\u00DB" +
  "\u0055\u0308\u00DC\u0059\u0301\u00DD\u0061\u0300\u00E0\u0061\u0301\u00E1\u0061\u0302\u00E2\u0061\u0303\u00E3" +
  "\u0061\u0308\u00E4\u0061\u030A\u00E5\u0063\u0327\u00E7\u0065\u0300\u00E8\u0065\u0301\u00E9\u0065\u0302\u00EA" +
  "\u0065\u0308\u00EB\u0069\u0300\u00EC\u0069\u0301\u00ED\u0069\u0302\u00EE\u0069\u0308\u00EF\u006E\u0303\u00F1" +
  "\u006F\u0300\u00F2\u006F\u0301\u00F3\u006F\u0302\u00F4\u006F\u0303\u00F5\u006F\u0308\u00F6\u0075\u0300\u00F9" +
  "\u0075\u0301\u00FA\u0075\u0302\u00FB\u0075\u0308\u00FC\u0079\u0301\u00FD\u0079\u0308\u00FF\u0041\u0304\u0100" +
  "\u0061\u0304\u0101\u0041\u0306\u0102\u0061\u0306\u0103\u0041\u0328\u0104\u0061\u0328\u0105\u0043\u0301\u0106" +
  "\u0063\u0301\u0107\u0043\u0302\u0108\u0063\u0302\u0109\u0043\u0307\u010A\u0063\u0307\u010B\u0043\u030C\u010C" +
  "\u0063\u030C\u010D\u0044\u030C\u010E\u0064\u030C\u010F\u0045\u0304\u0112\u0065\u0304\u0113\u0045\u0306\u0114" +
  "\u0065\u0306\u0115\u0045\u0307\u0116\u0065\u0307\u0117\u0045\u0328\u0118\u0065\u0328\u0119\u0045\u030C\u011A" +
  "\u0065\u030C\u011B\u0047\u0302\u011C\u0067\u0302\u011D\u0047\u0306\u011E\u0067\u0306\u011F\u0047\u0307\u0120" +
  "\u0067\u0307\u0121\u0047\u0327\u0122\u0067\u0327\u0123\u0048\u0302\u0124\u0068\u0302\u0125\u0049\u0303\u0128" +
  "\u0069\u0303\u0129\u0049\u0304\u012A\u0069\u0304\u012B\u0049\u0306\u012C\u0069\u0306\u012D\u0049\u0328\u012E" +
  "\u0069\u0328\u012F\u0049\u0307\u0130\u004A\u0302\u0134\u006A\u0302\u0135\u004B\u0327\u0136\u006B\u0327\u0137" +
  "\u004C\u0301\u0139\u006C\u0301\u013A\u004C\u0327\u013B\u006C\u0327\u013C\u004C\u030C\u013D\u006C\u030C\u013E" +
  "\u004E\u0301\u0143\u006E\u0301\u0144\u004E\u0327\u0145\u006E\u0327\u0146\u004E\u030C\u0147\u006E\u030C\u0148" +
  "\u004F\u0304\u014C\u006F\u0304\u014D\u004F\u0306\u014E\u006F\u0306\u014F\u004F\u030B\u0150\u006F\u030B\u0151" +
  "\u0052\u0301\u0154\u0072\u0301\u0155\u0052\u0327\u0156\u0072\u0327\u0157\u0052\u030C\u0158\u0072\u030C\u0159" +
  "\u0053\u0301\u015A\u0073\u0301\u015B\u0053\u0302\u015C\u0073\u0302\u015D\u0053\u0327\u015E\u0073\u0327\u015F" +
  "\u0053\u030C\u0160\u0073\u030C\u0161\u0054\u0327\u0162\u0074\u0327\u0163\u0054\u030C\u0164\u0074\u030C\u0165" +
  "\u0055\u0303\u0168\u0075\u0303\u0169\u0055\u0304\u016A\u0075\u0304\u016B\u0055\u0306\u016C\u0075\u0306\u016D" +
  "\u0055\u030A\u016E\u0075\u030A\u016F\u0055\u030B\u0170\u0075\u030B\u0171\u0055\u0328\u0172\u0075\u0328\u0173" +
  "\u0057\u0302\u0174\u0077\u0302\u0175\u0059\u0302\u0176\u0079\u0302\u0177\u0059\u0308\u0178\u005A\u0301\u0179" +
  "\u007A\u0301\u017A\u005A\u0307\u017B\u007A\u0307\u017C\u005A\u030C\u017D\u007A\u030C\u017E\u004F\u031B\u01A0" +
  "\u006F\u031B\u01A1\u0055\u031B\u01AF\u0075\u031B\u01B0\u0041\u030C\u01CD\u0061\u030C\u01CE\u0049\u030C\u01CF" +
  "\u0069\u030C\u01D0\u004F\u030C\u01D1\u006F\u030C\u01D2\u0055\u030C\u01D3\u0075\u030C\u01D4\u00DC\u0304\u01D5" +
  "\u00FC\u0304\u01D6\u00DC\u0301\u01D7\u00FC\u0301\u01D8\u00DC\u030C\u01D9\u00FC\u030C\u01DA\u00DC\u0300\u01DB" +
  "\u00FC\u0300\u01DC\u00C4\u0304\u01DE\u00E4\u0304\u01DF\u0226\u0304\u01E0\u0227\u0304\u01E1\u00C6\u0304\u01E2" +
  "\u00E6\u0304\u01E3\u0047\u030C\u01E6\u0067\u030C\u01E7\u004B\u030C\u01E8\u006B\u030C\u01E9\u004F\u0328\u01EA" +
  "\u006F\u0328\u01EB\u01EA\u0304\u01EC\u01EB\u0304\u01ED\u01B7\u030C\u01EE\u0292\u030C\u01EF\u006A\u030C\u01F0" +
  "\u0047\u0301\u01F4\u0067\u0301\u01F5\u004E\u0300\u01F8\u006E\u0300\u01F9\u00C5\u0301\u01FA\u00E5\u0301\u01FB" +
  "\u00C6\u0301\u01FC\u00E6\u0301\u01FD\u00D8\u0301\u01FE\u00F8\u0301\u01FF\u0041\u030F\u0200\u0061\u030F\u0201" +
  "\u0041\u0311\u0202\u0061\u0311\u0203\u0045\u030F\u0204\u0065\u030F\u0205\u0045\u0311\u0206\u0065\u0311\u0207" +
  "\u0049\u030F\u0208\u0069\u030F\u0209\u0049\u0311\u020A\u0069\u0311\u020B\u004F\u030F\u020C\u006F\u030F\u020D" +
  "\u004F\u0311\u020E\u006F\u0311\u020F\u0052\u030F\u0210\u0072\u030F\u0211\u0052\u0311\u0212\u0072\u0311\u0213" +
  "\u0055\u030F\u0214\u0075\u030F\u0215\u0055\u0311\u0216\u0075\u0311\u0217\u0053\u0326\u0218\u0073\u0326\u0219" +
  "\u0054\u0326\u021A\u0074\u0326\u021B\u0048\u030C\u021E\u0068\u030C\u021F\u0041\u0307\u0226\u0061\u0307\u0227" +
  "\u0045\u0327\u0228\u0065\u0327\u0229\u00D6\u0304\u022A\u00F6\u0304\u022B\u00D5\u0304\u022C\u00F5\u0304\u022D" +
  "\u004F\u0307\u022E\u006F\u0307\u022F\u022E\u0304\u0230\u022F\u0304\u0231\u0059\u0304\u0232\u0079\u0304\u0233" +
  "\u00A8\u0301\u0385\u0391\u0301\u0386\u0395\u0301\u0388\u0397\u0301\u0389\u0399\u0301\u038A\u039F\u0301\u038C" +
  "\u03A5\u0301\u038E\u03A9\u0301\u038F\u03CA\u0301\u0390\u0399\u0308\u03AA\u03A5\u0308\u03AB\u03B1\u0301\u03AC" +
  "\u03B5\u0301\u03AD\u03B7\u0301\u03AE\u03B9\u0301\u03AF\u03CB\u0301\u03B0\u03B9\u0308\u03CA\u03C5\u0308\u03CB" +
  "\u03BF\u0301\u03CC\u03C5\u0301\u03CD\u03C9\u0301\u03CE\u03D2\u0301\u03D3\u03D2\u0308\u03D4\u0415\u0300\u0400" +
  "\u0415\u0308\u0401\u0413\u0301\u0403\u0406\u0308\u0407\u041A\u0301\u040C\u0418\u0300\u040D\u0423\u0306\u040E" +
  "\u0418\u0306\u0419\u0438\u0306\u0439\u0435\u0300\u0450\u0435\u0308\u0451\u0433\u0301\u0453\u0456\u0308\u0457" +
  "\u043A\u0301\u045C\u0438\u0300\u045D\u0443\u0306\u045E\u0474\u030F\u0476\u0475\u030F\u0477\u0416\u0306\u04C1" +
  "\u0436\u0306\u04C2\u0410\u0306\u04D0\u0430\u0306\u04D1\u0410\u0308\u04D2\u0430\u0308\u04D3\u0415\u0306\u04D6" +
  "\u0435\u0306\u04D7\u04D8\u0308\u04DA\u04D9\u0308\u04DB\u0416\u0308\u04DC\u0436\u0308\u04DD\u0417\u0308\u04DE" +
  "\u0437\u0308\u04DF\u0418\u0304\u04E2\u0438\u0304\u04E3\u0418\u0308\u04E4\u0438\u0308\u04E5\u041E\u0308\u04E6" +
  "\u043E\u0308\u04E7\u04E8\u0308\u04EA\u04E9\u0308\u04EB\u042D\u0308\u04EC\u044D\u0308\u04ED\u0423\u0304\u04EE" +
  "\u0443\u0304\u04EF\u0423\u0308\u04F0\u0443\u0308\u04F1\u0423\u030B\u04F2\u0443\u030B\u04F3\u0427\u0308\u04F4" +
  "\u0447\u0308\u04F5\u042B\u0308\u04F8\u044B\u0308\u04F9\u0041\u0325\u1E00\u0061\u0325\u1E01\u0042\u0307\u1E02" +
  "\u0062\u0307\u1E03\u0042\u0323\u1E04\u0062\u0323\u1E05\u0042\u0331\u1E06\u0062\u0331\u1E07\u00C7\u0301\u1E08" +
  "\u00E7\u0301\u1E09\u0044\u0307\u1E0A\u0064\u0307\u1E0B\u0044\u0323\u1E0C\u0064\u0323\u1E0D\u0044\u0331\u1E0E" +
  "\u0064\u0331\u1E0F\u0044\u0327\u1E10\u0064\u0327\u1E11\u0044\u032D\u1E12\u0064\u032D\u1E13\u0112\u0300\u1E14" +
  "\u0113\u0300\u1E15\u0112\u0301\u1E16\u0113\u0301\u1E17\u0045\u032D\u1E18\u0065\u032D\u1E19\u0045\u0330\u1E1A" +
  "\u0065\u0330\u1E1B\u0228\u0306\u1E1C\u0229\u0306\u1E1D\u0046\u0307\u1E1E\u0066\u0307\u1E1F\u0047\u0304\u1E20" +
  "\u0067\u0304\u1E21\u0048\u0307\u1E22\u0068\u0307\u1E23\u0048\u0323\u1E24\u0068\u0323\u1E25\u0048\u0308\u1E26" +
  "\u0068\u0308\u1E27\u0048\u0327\u1E28\u0068\u0327\u1E29\u0048\u032E\u1E2A\u0068\u032E\u1E2B\u0049\u0330\u1E2C" +
  "\u0069\u0330\u1E2D\u00CF\u0301\u1E2E\u00EF\u0301\u1E2F\u004B\u0301\u1E30\u006B\u0301\u1E31\u004B\u0323\u1E32" +
  "\u006B\u0323\u1E33\u004B\u0331\u1E34\u006B\u0331\u1E35\u004C\u0323\u1E36\u006C\u0323\u1E37\u1E36\u0304\u1E38" +
  "\u1E37\u0304\u1E39\u004C\u0331\u1E3A\u006C\u0331\u1E3B\u004C\u032D\u1E3C\u006C\u032D\u1E3D\u004D\u0301\u1E3E" +
  "\u006D\u0301\u1E3F\u004D\u0307\u1E40\u006D\u0307\u1E41\u004D\u0323\u1E42\u006D\u0323\u1E43\u004E\u0307\u1E44" +
  "\u006E\u0307\u1E45\u004E\u0323\u1E46\u006E\u0323\u1E47\u004E\u0331\u1E48\u006E\u0331\u1E49\u004E\u032D\u1E4A" +
  "\u006E\u032D\u1E4B\u00D5\u0301\u1E4C\u00F5\u0301\u1E4D\u00D5\u0308\u1E4E\u00F5\u0308\u1E4F\u014C\u0300\u1E50" +
  "\u014D\u0300\u1E51\u014C\u0301\u1E52\u014D\u0301\u1E53\u0050\u0301\u1E54\u0070\u0301\u1E55\u0050\u0307\u1E56" +
  "\u0070\u0307\u1E57\u0052\u0307\u1E58\u0072\u0307\u1E59\u0052\u0323\u1E5A\u0072\u0323\u1E5B\u1E5A\u0304\u1E5C" +
  "\u1E5B\u0304\u1E5D\u0052\u0331\u1E5E\u0072\u0331\u1E5F\u0053\u0307\u1E60\u0073\u0307\u1E61\u0053\u0323\u1E62" +
  "\u0073\u0323\u1E63\u015A\u0307\u1E64\u015B\u0307\u1E65\u0160\u0307\u1E66\u0161\u0307\u1E67\u1E62\u0307\u1E68" +
  "\u1E63\u0307\u1E69\u0054\u0307\u1E6A\u0074\u0307\u1E6B\u0054\u0323\u1E6C\u0074\u0323\u1E6D\u0054\u0331\u1E6E" +
  "\u0074\u0331\u1E6F\u0054\u032D\u1E70\u0074\u032D\u1E71\u0055\u0324\u1E72\u0075\u0324\u1E73\u0055\u0330\u1E74" +
  "\u0075\u0330\u1E75\u0055\u032D\u1E76\u0075\u032D\u1E77\u0168\u0301\u1E78\u0169\u0301\u1E79\u016A\u0308\u1E7A" +
  "\u016B\u0308\u1E7B\u0056\u0303\u1E7C\u0076\u0303\u1E7D\u0056\u0323\u1E7E\u0076\u0323\u1E7F\u0057\u0300\u1E80" +
  "\u0077\u0300\u1E81\u0057\u0301\u1E82\u0077\u0301\u1E83\u0057\u0308\u1E84\u0077\u0308\u1E85\u0057\u0307\u1E86" +
  "\u0077\u0307\u1E87\u0057\u0323\u1E88\u0077\u0323\u1E89\u0058\u0307\u1E8A\u0078\u0307\u1E8B\u0058\u0308\u1E8C" +
  "\u0078\u0308\u1E8D\u0059\u0307\u1E8E\u0079\u0307\u1E8F\u005A\u0302\u1E90\u007A\u0302\u1E91\u005A\u0323\u1E92" +
  "\u007A\u0323\u1E93\u005A\u0331\u1E94\u007A\u0331\u1E95\u0068\u0331\u1E96\u0074\u0308\u1E97\u0077\u030A\u1E98" +
  "\u0079\u030A\u1E99\u017F\u0307\u1E9B\u0041\u0323\u1EA0\u0061\u0323\u1EA1\u0041\u0309\u1EA2\u0061\u0309\u1EA3" +
  "\u00C2\u0301\u1EA4\u00E2\u0301\u1EA5\u00C2\u0300\u1EA6\u00E2\u0300\u1EA7\u00C2\u0309\u1EA8\u00E2\u0309\u1EA9" +
  "\u00C2\u0303\u1EAA\u00E2\u0303\u1EAB\u1EA0\u0302\u1EAC\u1EA1\u0302\u1EAD\u0102\u0301\u1EAE\u0103\u0301\u1EAF" +
  "\u0102\u0300\u1EB0\u0103\u0300\u1EB1\u0102\u0309\u1EB2\u0103\u0309\u1EB3\u0102\u0303\u1EB4\u0103\u0303\u1EB5" +
  "\u1EA0\u0306\u1EB6\u1EA1\u0306\u1EB7\u0045\u0323\u1EB8\u0065\u0323\u1EB9\u0045\u0309\u1EBA\u0065\u0309\u1EBB" +
  "\u0045\u0303\u1EBC\u0065\u0303\u1EBD\u00CA\u0301\u1EBE\u00EA\u0301\u1EBF\u00CA\u0300\u1EC0\u00EA\u0300\u1EC1" +
  "\u00CA\u0309\u1EC2\u00EA\u0309\u1EC3\u00CA\u0303\u1EC4\u00EA\u0303\u1EC5\u1EB8\u0302\u1EC6\u1EB9\u0302\u1EC7" +
  "\u0049\u0309\u1EC8\u0069\u0309\u1EC9\u0049\u0323\u1ECA\u0069\u0323\u1ECB\u004F\u0323\u1ECC\u006F\u0323\u1ECD" +
  "\u004F\u0309\u1ECE\u006F\u0309\u1ECF\u00D4\u0301\u1ED0\u00F4\u0301\u1ED1\u00D4\u0300\u1ED2\u00F4\u0300\u1ED3" +
  "\u00D4\u0309\u1ED4\u00F4\u0309\u1ED5\u00D4\u0303\u1ED6\u00F4\u0303\u1ED7\u1ECC\u0302\u1ED8\u1ECD\u0302\u1ED9" +
  "\u01A0\u0301\u1EDA\u01A1\u0301\u1EDB\u01A0\u0300\u1EDC\u01A1\u0300\u1EDD\u01A0\u0309\u1EDE\u01A1\u0309\u1EDF" +
  "\u01A0\u0303\u1EE0\u01A1\u0303\u1EE1\u01A0\u0323\u1EE2\u01A1\u0323\u1EE3\u0055\u0323\u1EE4\u0075\u0323\u1EE5" +
  "\u0055\u0309\u1EE6\u0075\u0309\u1EE7\u01AF\u0301\u1EE8\u01B0\u0301\u1EE9\u01AF\u0300\u1EEA\u01B0\u0300\u1EEB" +
  "\u01AF\u0309\u1EEC\u01B0\u0309\u1EED\u01AF\u0303\u1EEE\u01B0\u0303\u1EEF\u01AF\u0323\u1EF0\u01B0\u0323\u1EF1" +
  "\u0059\u0300\u1EF2\u0079\u0300\u1EF3\u0059\u0323\u1EF4\u0079\u0323\u1EF5\u0059\u0309\u1EF6\u0079\u0309\u1EF7" +
  "\u0059\u0303\u1EF8\u0079\u0303\u1EF9\u03B1\u0313\u1F00\u03B1\u0314\u1F01\u1F00\u0300\u1F02\u1F01\u0300\u1F03" +
  "\u1F00\u0301\u1F04\u1F01\u0301\u1F05\u1F00\u0342\u1F06\u1F01\u0342\u1F07\u0391\u0313\u1F08\u0391\u0314\u1F09" +
  "\u1F08\u0300\u1F0A\u1F09\u0300\u1F0B\u1F08\u0301\u1F0C\u1F09\u0301\u1F0D\u1F08\u0342\u1F0E\u1F09\u0342\u1F0F" +
  "\u03B5\u0313\u1F10\u03B5\u0314\u1F11\u1F10\u0300\u1F12\u1F11\u0300\u1F13\u1F10\u0301\u1F14\u1F11\u0301\u1F15" +
  "\u0395\u0313\u1F18\u0395\u0314\u1F19\u1F18\u0300\u1F1A\u1F19\u0300\u1F1B\u1F18\u0301\u1F1C\u1F19\u0301\u1F1D" +
  "\u03B7\u0313\u1F20\u03B7\u0314\u1F21\u1F20\u0300\u1F22\u1F21\u0300\u1F23\u1F20\u0301\u1F24\u1F21\u0301\u1F25" +
  "\u1F20\u0342\u1F26\u1F21\u0342\u1F27\u0397\u0313\u1F28\u0397\u0314\u1F29\u1F28\u0300\u1F2A\u1F29\u0300\u1F2B" +
  "\u1F28\u0301\u1F2C\u1F29\u0301\u1F2D\u1F28\u0342\u1F2E\u1F29\u0342\u1F2F\u03B9\u0313\u1F30\u03B9\u0314\u1F31" +
  "\u1F30\u0300\u1F32\u1F31\u0300\u1F33\u1F30\u0301\u1F34\u1F31\u0301\u1F35\u1F30\u0342\u1F36\u1F31\u0342\u1F37" +
  "\u0399\u0313\u1F38\u0399\u0314\u1F39\u1F38\u0300\u1F3A\u1F39\u0300\u1F3B\u1F38\u0301\u1F3C\u1F39\u0301\u1F3D" +
  "\u1F38\u0342\u1F3E\u1F39\u0342\u1F3F\u03BF\u0313\u1F40\u03BF\u0314\u1F41\u1F40\u0300\u1F42\u1F41\u0300\u1F43" +
  "\u1F40\u0301\u1F44\u1F41\u0301\u1F45\u039F\u0313\u1F48\u039F\u0314\u1F49\u1F48\u0300\u1F4A\u1F49\u0300\u1F4B" +
  "\u1F48\u0301\u1F4C\u1F49\u0301\u1F4D\u03C5\u0313\u1F50\u03C5\u0314\u1F51\u1F50\u0300\u1F52\u1F51\u0300\u1F53" +
  "\u1F50\u0301\u1F54\u1F51\u0301\u1F55\u1F50\u0342\u1F56\u1F51\u0342\u1F57\u03A5\u0314\u1F59\u1F59\u0300\u1F5B" +
  "\u1F59\u0301\u1F5D\u1F59\u0342\u1F5F\u03C9\u0313\u1F60\u03C9\u0314\u1F61\u1F60\u0300\u1F62\u1F61\u0300\u1F63" +
  "\u1F60\u0301\u1F64\u1F61\u0301\u1F65\u1F60\u0342\u1F66\u1F61\u0342\u1F67\u03A9\u0313\u1F68\u03A9\u0314\u1F69" +
  "\u1F68\u0300\u1F6A\u1F69\u0300\u1F6B\u1F68\u0301\u1F6C\u1F69\u0301\u1F6D\u1F68\u0342\u1F6E\u1F69\u0342\u1F6F" +
  "\u03B1\u0300\u1F70\u03B5\u0300\u1F72\u03B7\u0300\u1F74\u03B9\u0300\u1F76\u03BF\u0300\u1F78\u03C5\u0300\u1F7A" +
  "\u03C9\u0300\u1F7C\u1F00\u0345\u1F80\u1F01\u0345\u1F81\u1F02\u0345\u1F82\u1F03\u0345\u1F83\u1F04\u0345\u1F84" +
  "\u1F05\u0345\u1F85\u1F06\u0345\u1F86\u1F07\u0345\u1F87\u1F08\u0345\u1F88\u1F09\u0345\u1F89\u1F0A\u0345\u1F8A" +
  "\u1F0B\u0345\u1F8B\u1F0C\u0345\u1F8C\u1F0D\u0345\u1F8D\u1F0E\u0345\u1F8E\u1F0F\u0345\u1F8F\u1F20\u0345\u1F90" +
  "\u1F21\u0345\u1F91\u1F22\u0345\u1F92\u1F23\u0345\u1F93\u1F24\u0345\u1F94\u1F25\u0345\u1F95\u1F26\u0345\u1F96" +
  "\u1F27\u0345\u1F97\u1F28\u0345\u1F98\u1F29\u0345\u1F99\u1F2A\u0345\u1F9A\u1F2B\u0345\u1F9B\u1F2C\u0345\u1F9C" +
  "\u1F2D\u0345\u1F9D\u1F2E\u0345\u1F9E\u1F2F\u0345\u1F9F\u1F60\u0345\u1FA0\u1F61\u0345\u1FA1\u1F62\u0345\u1FA2" +
  "\u1F63\u0345\u1FA3\u1F64\u0345\u1FA4\u1F65\u0345\u1FA5\u1F66\u0345\u1FA6\u1F67\u0345\u1FA7\u1F68\u0345\u1FA8" +
  "\u1F69\u0345\u1FA9\u1F6A\u0345\u1FAA\u1F6B\u0345\u1FAB\u1F6C\u0345\u1FAC\u1F6D\u0345\u1FAD\u1F6E\u0345\u1FAE" +
  "\u1F6F\u0345\u1FAF\u03B1\u0306\u1FB0\u03B1\u0304\u1FB1\u1F70\u0345\u1FB2\u03B1\u0345\u1FB3\u03AC\u0345\u1FB4" +
  "\u03B1\u0342\u1FB6\u1FB6\u0345\u1FB7\u0391\u0306\u1FB8\u0391\u0304\u1FB9\u0391\u0300\u1FBA\u0391\u0345\u1FBC" +
  "\u00A8\u0342\u1FC1\u1F74\u0345\u1FC2\u03B7\u0345\u1FC3\u03AE\u0345\u1FC4\u03B7\u0342\u1FC6\u1FC6\u0345\u1FC7" +
  "\u0395\u0300\u1FC8\u0397\u0300\u1FCA\u0397\u0345\u1FCC\u1FBF\u0300\u1FCD\u1FBF\u0301\u1FCE\u1FBF\u0342\u1FCF" +
  "\u03B9\u0306\u1FD0\u03B9\u0304\u1FD1\u03CA\u0300\u1FD2\u03B9\u0342\u1FD6\u03CA\u0342\u1FD7\u0399\u0306\u1FD8" +
  "\u0399\u0304\u1FD9\u0399\u0300\u1FDA\u1FFE\u0300\u1FDD\u1FFE\u0301\u1FDE\u1FFE\u0342\u1FDF\u03C5\u0306\u1FE0" +
  "\u03C5\u0304\u1FE1\u03CB\u0300\u1FE2\u03C1\u0313\u1FE4\u03C1\u0314\u1FE5\u03C5\u0342\u1FE6\u03CB\u0342\u1FE7" +
  "\u03A5\u0306\u1FE8\u03A5\u0304\u1FE9\u03A5\u0300\u1FEA\u03A1\u0314\u1FEC\u00A8\u0300\u1FED\u1F7C\u0345\u1FF2" +
  "\u03C9\u0345\u1FF3\u03CE\u0345\u1FF4\u03C9\u0342\u1FF6\u1FF6\u0345\u1FF7\u039F\u0300\u1FF8\u03A9\u0300\u1FFA" +
  "\u03A9\u0345\u1FFC\u304B\u3099\u304C\u304D\u3099\u304E\u304F\u3099\u3050\u3051\u3099\u3052\u3053\u3099\u3054" +
  "\u3055\u3099\u3056\u3057\u3099\u3058\u3059\u3099\u305A\u305B\u3099\u305C\u305D\u3099\u305E\u305F\u3099\u3060" +
  "\u3061\u3099\u3062\u3064\u3099\u3065\u3066\u3099\u3067\u3068\u3099\u3069\u306F\u3099\u3070\u306F\u309A\u3071" +
  "\u3072\u3099\u3073\u3072\u309A\u3074\u3075\u3099\u3076\u3075\u309A\u3077\u3078\u3099\u3079\u3078\u309A\u307A" +
  "\u307B\u3099\u307C\u307B\u309A\u307D\u3046\u3099\u3094\u309D\u3099\u309E\u30AB\u3099\u30AC\u30AD\u3099\u30AE" +
  "\u30AF\u3099\u30B0\u30B1\u3099\u30B2\u30B3\u3099\u30B4\u30B5\u3099\u30B6\u30B7\u3099\u30B8\u30B9\u3099\u30BA" +
  "\u30BB\u3099\u30BC\u30BD\u3099\u30BE\u30BF\u3099\u30C0\u30C1\u3099\u30C2\u30C4\u3099\u30C5\u30C6\u3099\u30C7" +
  "\u30C8\u3099\u30C9\u30CF\u3099\u30D0\u30CF\u309A\u30D1\u30D2\u3099\u30D3\u30D2\u309A\u30D4\u30D5\u3099\u30D6" +
  "\u30D5\u309A\u30D7\u30D8\u3099\u30D9\u30D8\u309A\u30DA\u30DB\u3099\u30DC\u30DB\u309A\u30DD\u30A6\u3099\u30F4" +
  "\u30EF\u3099\u30F7\u30F0\u3099\u30F8\u30F1\u3099\u30F9\u30F2\u3099\u30FA\u30FD\u3099\u30FE";

var __RQ_NFC = null;

/** NFC for the scripts above: compose each base + combining mark pair, repeatedly. */
function __rqNfc(s) {
  if (!__RQ_NFC) {
    __RQ_NFC = {};
    for (var t = 0; t + 2 < __RQ_NFC_PAIRS.length; t += 3) {
      __RQ_NFC[__RQ_NFC_PAIRS.substring(t, t + 2)] = __RQ_NFC_PAIRS.charAt(t + 2);
    }
  }
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (out.length) {
      var last = out.charAt(out.length - 1);
      var lc = last.charCodeAt(0);
      var cc = c.charCodeAt(0);
      // Hangul: leading consonant + vowel, then syllable + trailing consonant.
      if (lc >= 0x1100 && lc <= 0x1112 && cc >= 0x1161 && cc <= 0x1175) {
        out = out.substring(0, out.length - 1) + String.fromCharCode(0xAC00 + ((lc - 0x1100) * 21 + (cc - 0x1161)) * 28);
        continue;
      }
      if (lc >= 0xAC00 && lc <= 0xD7A3 && (lc - 0xAC00) % 28 === 0 && cc >= 0x11A8 && cc <= 0x11C2) {
        out = out.substring(0, out.length - 1) + String.fromCharCode(lc + cc - 0x11A7);
        continue;
      }
      var pair = last + c;
      if (__RQ_NFC.hasOwnProperty(pair)) {
        out = out.substring(0, out.length - 1) + __RQ_NFC[pair];
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * A folder path with every link along it followed: a symlink or a Finder alias
 * at any level (/tmp -> /private/tmp, a linked volume). The last component is
 * the file, which may not exist yet, and is kept as written.
 */
function __rqResolveFolders(p) {
  var s = String(p).replace(/\\/g, "/");
  // A UNC path keeps its leading double slash: //server/share/… is not /server/share/….
  var lead = s.substring(0, 2) === "//" ? "//" : "";
  var body = s.substring(lead.length);
  var cut = body.lastIndexOf("/");
  if (cut < 0) return s;
  var parts = body.substring(0, cut).split("/");
  var name = body.substring(cut + 1);
  var cur = lead;
  // No depth cap: every folder stays in the key, however deep.
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    if (cur === "//") cur = "//" + parts[i];
    else if (cur === "" && i === 0) cur = parts[i]; // a drive letter, C:
    else cur = cur + "/" + parts[i];
    try {
      var f = new Folder(cur);
      if (f.alias) cur = __rqLinkTarget(f, cur);
    } catch (e) {}
  }
  return cur + "/" + name;
}

/**
 * Where a linked folder leads. Measured on 26.5 (macOS): Folder("/tmp").resolve()
 * answers /Volumes/private/tmp — ExtendScript resolves the link's RELATIVE
 * target (private/tmp) against /Volumes rather than the link's own folder. So
 * an answer that does not exist is re-read relative to the link's parent, then
 * to the root; one that still names nothing is not used and the path is kept
 * as written (render_queue's check, with Node's realpath, still catches it).
 */
function __rqLinkTarget(folder, cur) {
  var r = null;
  try { r = folder.resolve(); } catch (e) { r = null; }
  if (!r || !r.fsName) return cur;
  var rp = String(r.fsName).replace(/\\/g, "/").replace(/\/+$/, "");
  try { if (new Folder(rp).exists) return rp; } catch (e2) {}
  var m = /^\/Volumes\/(.+)$/.exec(rp);
  if (m) {
    var tries = [cur.substring(0, cur.lastIndexOf("/")) + "/" + m[1], "/" + m[1]];
    for (var t = 0; t < tries.length; t++) {
      try { if (new Folder(tries[t]).exists) return tries[t]; } catch (e3) {}
    }
  }
  return cur;
}

/** What two output paths are compared by: the same file gives the same key. */
function __rqPathKey(p) {
  if (p === null || p === undefined) return null;
  var s = String(p);
  try { s = new File(s).fsName; } catch (e) {}
  return __rqNfc(__rqResolveFolders(s)).toLowerCase().replace(/\/+$/, "");
}

/**
 * The first item other than `skipIndex`, DONE ones aside, with an output module
 * writing to the file `key` names. Measured on 26.5 (#235 live check): aerender
 * refuses to render an item when ANY other item in the project has the same
 * output path, UNQUEUED included, exits 0 and writes nothing; only DONE items
 * are ignored. render_queue unticks what it rendered (UNQUEUED), so queueing a
 * comp to its last render's file again needs the old item removed first — the
 * message says so.
 *
 * Image sequences count: aerender refuses two items sharing a [####] pattern
 * even when their frame ranges do not overlap (measured, same check).
 */
function __rqOutputClash(rq, key, skipIndex) {
  if (!key) return null;
  for (var i = 1; i <= rq.numItems; i++) {
    if (i === skipIndex) continue;
    var item = rq.item(i);
    var status = null;
    try { status = __rqStatusName(item.status); } catch (e) {}
    if (status === "DONE") continue;
    var n = 0;
    try { n = item.numOutputModules; } catch (e2) { n = 0; }
    for (var o = 1; o <= n; o++) {
      var omPath = __rqOmPath(item.outputModule(o));
      if (omPath && __rqPathKey(omPath) === key) {
        var compName = null;
        try { compName = item.comp.name; } catch (e3) {}
        return { index: i, compName: compName, output: o, path: omPath, status: status };
      }
    }
  }
  return null;
}

function __rqClashMessage(clash, path) {
  var unticked = clash.status !== "QUEUED";
  return "Render queue item " + clash.index + " (\"" + clash.compName + "\")" +
    (unticked ? ", " + clash.status + (clash.status === "UNQUEUED" ? " (already rendered, or switched off)," : ",") : "") +
    " already has the output " + clash.path +
    (clash.output > 1 ? " (its output module " + clash.output + ")" : "") +
    (clash.path !== path ? ", the same file as " + path : "") +
    ". aerender will not render an item whose output another item in the queue also has" +
    (unticked ? ", even an unticked one" : "") + " (\"output module name already in use\"), and it fails silently, " +
    "writing nothing. Remove item " + clash.index + " first with remove_render_item" +
    (unticked ? " (a file it rendered stays on disk)" : "") + ", or choose another outputPath. Nothing was queued.";
}

OPS.add_to_render_queue = function (args) {
  var comp = getCompById(args.compId);
  var outputPath = String(args.outputPath || "");

  // Every check that can run before the queue is touched runs here, so a
  // refusal leaves nothing behind in the user's Render Queue panel.
  if (!__rqIsAbsolutePath(outputPath)) {
    throw new Error(
      "outputPath must be absolute (got \"" + outputPath + "\"). A relative path would be resolved " +
      "against After Effects' own working folder, not the project's."
    );
  }
  var outFile = new File(outputPath);
  var parent = outFile.parent;
  if (!parent || !parent.exists) {
    throw new Error(
      "The folder for outputPath does not exist: " + (parent ? parent.fsName : outputPath) + ". " +
      "Create it first — a render into a missing folder fails only when it runs."
    );
  }
  if (!__rqIsSequencePath(outputPath) && outFile.exists && args.overwrite !== true) {
    throw new Error(
      "A file already exists at " + outFile.fsName + ". Pass overwrite:true to replace it when the " +
      "render runs, or choose another outputPath."
    );
  }
  if (args.duration !== undefined && !(args.duration > 0)) {
    throw new Error("duration must be greater than 0 seconds.");
  }

  var rq = app.project.renderQueue;
  // Another item with the same output, unless it is DONE (issue #228).
  // overwrite:true does not lift this: it is about a file on disk, and this is
  // aerender refusing the item outright.
  var clash = __rqOutputClash(rq, __rqPathKey(outFile.fsName), 0);
  if (clash) throw new Error(__rqClashMessage(clash, outFile.fsName));

  var item = rq.items.add(comp);
  var index = rq.numItems;
  try {
    if (args.renderSettingsTemplate !== undefined) {
      var rsTemplates = item.templates;
      if (!__rqHasName(rsTemplates, args.renderSettingsTemplate)) {
        throw new Error(
          "No render settings template named \"" + args.renderSettingsTemplate + "\". Available: " +
          __rqNames(rsTemplates).join(", ") + "."
        );
      }
      item.applyTemplate(args.renderSettingsTemplate);
    }
    var om = item.outputModule(1);
    if (args.outputModuleTemplate !== undefined) {
      var omTemplates = om.templates;
      if (!__rqHasName(omTemplates, args.outputModuleTemplate)) {
        throw new Error(
          "No output module template named \"" + args.outputModuleTemplate + "\". Available: " +
          __rqNames(omTemplates).join(", ") + ". A codec, bit depth or alpha setting that none of " +
          "these gives has to be saved as a template by hand once (Edit > Templates > Output Module) — " +
          "a script cannot set Format, Channels, Depth or Color directly (issue #95)."
        );
      }
      om.applyTemplate(args.outputModuleTemplate);
    }
    // The file is set after the template, because applying a template can
    // replace the output path with the template's own default.
    om.file = new File(outputPath);
    if (args.startTime !== undefined) item.timeSpanStart = args.startTime;
    if (args.duration !== undefined) item.timeSpanDuration = args.duration;

    // A template's format can change the extension, so the path AE settled on
    // is checked too — it may be another item's although the asked one was not.
    var settled = __rqOmPath(om);
    if (settled && settled !== outFile.fsName) {
      var late = __rqOutputClash(rq, __rqPathKey(settled), index);
      if (late) throw new Error(__rqClashMessage(late, settled));
    }

    var status = __rqStatusName(item.status);
    if (status !== "QUEUED") {
      throw new Error(
        "After Effects left the new render queue item in status " + status + " rather than QUEUED, " +
        "so it would not render."
      );
    }
  } catch (e) {
    // Never leave a half-configured item in the user's queue (issue #95's
    // workaround notes the same leak for scripts that throw mid-setup).
    try { item.remove(); } catch (eR) {}
    throw e;
  }

  var summary = __rqItemSummary(rq, index, true);
  var actual = summary.outputs.length ? summary.outputs[0].path : null;
  if (actual && actual !== outFile.fsName) {
    summary.note = "After Effects changed the output path to " + actual + " (the template's format " +
      "decides the extension). That is the file the render will write.";
  }
  return summary;
};
OPS.add_to_render_queue.__meta = { undoName: "AE MCP: add to render queue" };

OPS.list_render_queue = noUndo(function (args) {
  var rq = app.project.renderQueue;
  var items = [];
  for (var i = 1; i <= rq.numItems; i++) items.push(__rqItemSummary(rq, i, args.includeSettings === true));
  var out = { items: items, count: items.length };
  if (args.includeTemplates === true) {
    if (rq.numItems > 0) {
      var first = rq.item(1);
      out.renderSettingsTemplates = __rqNames(first.templates);
      out.outputModuleTemplates = __rqNames(first.outputModule(1).templates);
    } else {
      // A template list is only readable from an existing item, and inventing
      // one here would turn a read into a write.
      out.templatesNote = "The render queue is empty, and After Effects only lists templates through " +
        "an existing item. Add one with add_to_render_queue (an unknown template name is refused " +
        "with the full list), then list again.";
    }
  }
  return out;
});

OPS.remove_render_item = function (args) {
  var rq = app.project.renderQueue;
  var index = args.index;
  if (!(index >= 1 && index <= rq.numItems)) {
    throw new Error("No render queue item at index " + index + " (the queue has " + rq.numItems + ").");
  }
  var item = rq.item(index);
  // Render queue items have no stable id, so the index is checked against the
  // comp the caller believes is there — an index shifts every time an earlier
  // item is removed.
  var compId = null;
  try { compId = item.comp.id; } catch (e) {}
  if (compId !== args.compId) {
    throw new Error(
      "Render queue item " + index + " renders comp " + compId + ", not " + args.compId + ". Indices " +
      "shift when earlier items are removed — call list_render_queue and use the index it reports now."
    );
  }
  var status = __rqStatusName(item.status);
  if (status === "RENDERING") {
    throw new Error("Render queue item " + index + " is rendering in After Effects right now and cannot be removed.");
  }
  var removed = __rqItemSummary(rq, index, false);
  item.remove();
  return { removed: removed, remaining: rq.numItems };
};
OPS.remove_render_item.__meta = { undoName: "AE MCP: remove render item" };

/**
 * The read-only half of render_queue: which items will render, to which files,
 * how many frames, and where After Effects is installed. Changes nothing — the
 * server uses this to find aerender and refuse early before anything is saved.
 */
OPS._render_prepare = noUndo(function (args) {
  if (!app.project.file) {
    throw new Error(
      "This project has never been saved. render_queue renders the saved project file in a separate " +
      "process, so it needs one — and saving an untitled project raises a modal dialog that would " +
      "freeze this connection. Ask the user to save the project once, then call render_queue again."
    );
  }
  var rq = app.project.renderQueue;
  var picked = [];
  var problems = [];
  var i;
  if (args.indices && args.indices.length) {
    for (i = 0; i < args.indices.length; i++) {
      var idx = args.indices[i];
      if (!(idx >= 1 && idx <= rq.numItems)) {
        problems.push("index " + idx + " does not exist (the queue has " + rq.numItems + ")");
        continue;
      }
      // indices:[2,2] renders item 2 once, and never clashes with itself.
      var seen = false;
      for (var d = 0; d < picked.length; d++) { if (picked[d] === idx) seen = true; }
      if (!seen) picked.push(idx);
    }
  } else if (args.all === true) {
    for (i = 1; i <= rq.numItems; i++) {
      if (__rqStatusName(rq.item(i).status) === "QUEUED") picked.push(i);
    }
    if (!picked.length) {
      throw new Error(
        "Nothing in the render queue is QUEUED (" + rq.numItems + " item(s) in total). Add one with " +
        "add_to_render_queue — an item render_queue already rendered is switched off (UNQUEUED) so it " +
        "does not render twice."
      );
    }
  } else {
    // The server's schema makes this unreachable; a direct /op call must not
    // fall back to rendering items nobody named.
    throw new Error("render_queue needs `indices`, or `all:true` to render every QUEUED item.");
  }

  var items = [];
  for (i = 0; i < picked.length; i++) {
    var s = __rqItemSummary(rq, picked[i], false);
    if (s.status !== "QUEUED") {
      problems.push("item " + s.index + " (" + s.compName + ") is " + s.status + ", not QUEUED" +
        (s.status === "DONE" ? " — a finished item cannot be re-queued; add a fresh one" : ""));
      continue;
    }
    var missing = false;
    for (var o = 0; o < s.outputs.length; o++) { if (!s.outputs[o].path) missing = true; }
    if (missing || !s.outputs.length) {
      problems.push("item " + s.index + " (" + s.compName + ") has an output module with no file");
      continue;
    }
    var use = __rqFootageUse(rq.item(s.index));
    if (use.missing.length) {
      problems.push("item " + s.index + " (" + s.compName + ") renders footage After Effects cannot find: " +
        use.missing.join(", ") + " — relink it (File > Dependencies > Find Missing Footage), or the render would " +
        "carry the missing-footage placeholder");
      continue;
    }
    // Every file the render reads, so the server can check each is still on
    // disk and recorded in the saved project at that path (issue #145).
    s.footage = use.files;
    if (use.warnings.length) s.footageWarnings = use.warnings;
    if (use.skipped.length) s.footageSkipped = use.skipped;
    items.push(s);
  }
  if (problems.length) {
    throw new Error("render_queue refused before saving or rendering anything: " + problems.join("; ") + ".");
  }
  // Every item this render leaves alone, DONE ones aside, by output path: aerender
  // refuses an item whose path any of them shares, UNQUEUED included (#228).
  var otherQueued = [];
  for (i = 1; i <= rq.numItems; i++) {
    var isPicked = false;
    for (var pk = 0; pk < picked.length; pk++) { if (picked[pk] === i) isPicked = true; }
    if (isPicked || __rqStatusName(rq.item(i).status) === "DONE") continue;
    var other = __rqItemSummary(rq, i, false);
    otherQueued.push({ index: other.index, compName: other.compName, status: other.status, outputs: other.outputs });
  }


  var appPackage = null;
  try { appPackage = Folder.appPackage.fsName; } catch (e) {}
  return {
    projectPath: app.project.file.fsName,
    dirty: app.project.dirty === true,
    readOnly: __rqProjectReadOnly(),
    appPackage: appPackage,
    version: app.version,
    items: items,
    otherQueued: otherQueued,
  };
});

/**
 * What footage a render queue item actually reads, decided before anything
 * renders and asked of the project itself, so it holds in any language —
 * aerender's own wording is only the second layer (the 26.5 live run: aerender
 * exits 0 with footage missing, and its warning once never reached the server).
 *
 * Returns
 *   missing  — names of missing footage the render WILL read. Any one refuses.
 *   warnings — missing footage the render probably does not read, but might:
 *              reported in the result, never refused (issue #144).
 *   skipped  — missing footage it provably does not read, with why.
 *   files    — {name, path} of every file-backed footage item it reads, for
 *              the server's on-disk and saved-path checks (issue #145).
 *
 * The walk follows nested comps with the time span mapped into each one. A
 * layer's footage is READ when the layer is switched on (video, or audio with
 * audio to give) and its in/out overlaps the span, padded by a frame for motion
 * blur and frame blending. It is read regardless of both when the layer is a
 * track matte, or when another layer in its comp points at it through a
 * layer-valued property (Displacement Map, Set Matte, Compound Blur, a Layer
 * Control, a light's source — anything whose value is a layer): those pull
 * pixels from layers that are switched off, which is how they are normally
 * used. A parent is NOT a read: parenting takes the parent's transform, never
 * its pixels, and a missing file keeps its dimensions.
 *
 * What cannot be proved either way is a warning, not a refusal and not a skip:
 * an expression calling sampleImage() can read any layer's pixels by name, and
 * names in code are not something to guess at — so when one exists anywhere in
 * the walked comps, every "provably unread" verdict is demoted to a warning.
 * A layer-valued property whose value AE will not give, or one driven by an
 * expression, makes every layer in that comp count as read. A nested comp is
 * given the whole of its own time (no span limit) when the layer holding it
 * has time remapping, any effect (Echo, Time Displacement, Posterize Time…
 * read other times), or a stretch AE will not report.
 *
 * Any property AE will not describe counts as read: the only cost of reading
 * too much is the refusal #144 is about, while reading too little renders the
 * missing-footage placeholder and calls it done.
 */
function __rqFootageUse(item) {
  var NAMES_CAP = 20;
  var missing = [];
  var warnings = [];
  var skipped = [];
  var files = [];
  var usedIds = {};       // footage id -> true once read
  var skipWhy = {};       // footage id -> reason, for missing footage not (yet) read
  var skipOrder = [];     // footage ids in the order first skipped
  var skipFiles = {};     // footage id -> {name, path}, file-backed and not missing
  var compState = {};
  var refsMemo = {};
  var visited = [];

  function idOf(x) { try { return x.id; } catch (e) { return null; } }
  function nameOf(x) { try { return String(x.name); } catch (e) { return "?"; } }
  function fileOf(src) {
    try { return src.file ? src.file.fsName : null; } catch (e) { return null; }
  }
  function isMissing(src) {
    try { return src.footageMissing === true; } catch (e) { return false; }
  }
  function fps(c) {
    var f = 0;
    try { f = c.frameRate; } catch (e) { f = 0; }
    return f > 0 ? f : 0;
  }

  // Switched on: the video switch, or the audio switch on a layer with audio.
  function layerOn(L) {
    var v = true;
    try { v = L.enabled !== false; } catch (e) { v = true; }
    if (v) return true;
    try { return L.audioEnabled === true && L.hasAudio !== false; } catch (e2) { return true; }
  }
  function layerSpan(L) {
    try {
      var a = L.inPoint, b = L.outPoint;
      if (typeof a !== "number" || typeof b !== "number") return null;
      return { a: Math.min(a, b), b: Math.max(a, b) };
    } catch (e) { return null; }
  }
  function overlaps(L, iv, c) {
    if (!iv) return true;
    var s = layerSpan(L);
    if (!s) return true;
    var f = fps(c);
    var pad = f ? 1 / f : 0;
    return s.a - pad < iv.b && s.b + pad > iv.a;
  }
  function isMatte(L) {
    try { return L.isTrackMatte === true; } catch (e) { return true; }
  }

  // Layers in comp c that some layer reaches through a track matte or a
  // layer-valued property. {idx: {index: true}, all: bool}.
  function scanLayerProps(group, out, depth) {
    if (!group || depth > 6) return;
    var n = 0;
    try { n = group.numProperties || 0; } catch (e) { out.all = true; return; }
    for (var j = 1; j <= n; j++) {
      var p = null;
      try { p = group.property(j); } catch (e1) { out.all = true; continue; }
      if (!p) continue;
      var kind = null;
      try { kind = p.propertyType; } catch (e2) { out.all = true; continue; }
      if (kind === PropertyType.PROPERTY) {
        var vt = null;
        try { vt = p.propertyValueType; } catch (e3) { out.all = true; continue; }
        if (vt !== PropertyValueType.LAYER_INDEX) continue;
        try {
          if (p.expressionEnabled === true) { out.all = true; continue; }
          var v = p.value;
          if (typeof v === "number" && v > 0) out.idx[v] = true;
          else if (v && typeof v === "object" && typeof v.index === "number") out.idx[v.index] = true;
        } catch (e4) { out.all = true; }
      } else {
        scanLayerProps(p, out, depth + 1);
      }
    }
  }
  function refsOf(c) {
    var key = String(idOf(c));
    if (refsMemo[key]) return refsMemo[key];
    var out = { idx: {}, all: false };
    if (typeof PropertyType === "undefined" || typeof PropertyValueType === "undefined") out.all = true;
    var n = 0;
    try { n = c.numLayers || 0; } catch (e) { n = 0; out.all = true; }
    for (var i = 1; i <= n && !out.all; i++) {
      var X = null;
      try { X = c.layer(i); } catch (e1) { out.all = true; break; }
      // The matte a layer names (AE 23+), and the layer above it (the older
      // rule, where the matte is always the layer directly above).
      try { var m = X.trackMatteLayer; if (m) out.idx[m.index] = true; } catch (e2) {}
      try {
        if (typeof TrackMatteType !== "undefined" && X.trackMatteType !== undefined &&
            X.trackMatteType !== TrackMatteType.NO_TRACK_MATTE && X.index > 1) out.idx[X.index - 1] = true;
      } catch (e3) {}
      var groups = ["ADBE Effect Parade", "ADBE Light Options Group"];
      for (var g = 0; g < groups.length && !out.all; g++) {
        var grp = null;
        try { grp = X.property ? X.property(groups[g]) : null; } catch (e4) { grp = null; }
        if (grp) scanLayerProps(grp, out, 0);
      }
    }
    refsMemo[key] = out;
    return out;
  }

  // The span a nested comp is read over, in its own time; null = all of it.
  function childSpan(L, iv, child) {
    if (!iv) return null;
    try {
      if (L.timeRemapEnabled === true) return null;
      var fx = L.property ? L.property("ADBE Effect Parade") : null;
      if (fx && fx.numProperties > 0) return null;
      var st = L.startTime;
      var str = L.stretch;
      if (typeof st !== "number" || typeof str !== "number" || !str) return null;
      var s = layerSpan(L);
      var a = iv.a, b = iv.b;
      if (s) { a = Math.max(a, s.a); b = Math.min(b, s.b); }
      var x1 = (a - st) * 100 / str;
      var x2 = (b - st) * 100 / str;
      var f = fps(child);
      var pad = f ? 1 / f : 0;
      return { a: Math.min(x1, x2) - pad, b: Math.max(x1, x2) + pad };
    } catch (e) { return null; }
  }

  // Effects that read a layer's input at OTHER times — Echo, Posterize Time,
  // Timewarp and their kin. On an adjustment layer they read the composite of
  // every layer below at earlier frames, so a layer that ends before the span
  // still reaches the render. A comp where any switched-on layer carries one
  // is read over all of its time. Matched loosely on match name and display
  // name on purpose: a false match costs only a skip.
  //
  // A name list cannot know third-party effects (Twixtor, RSMB, …), and on an
  // adjustment layer an unknown one is exactly the risk. So on an ADJUSTMENT
  // layer the rule is inverted: every effect counts as reading other times
  // unless its match name is on NON_TIME_EFFECTS, a short list of stock
  // effects that work on the current frame alone. The cost of the inversion
  // is an occasional refusal (out-of-span missing footage in a comp with an
  // unlisted adjustment effect), never a placeholder. On any other layer an
  // effect reads only that layer's own source, whose in/out the walk already
  // judges, so the name list is enough there.
  var NON_TIME_EFFECTS = {
    "ADBE Lumetri": 1, "ADBE CurvesCustom": 1, "ADBE Easy Levels2": 1, "ADBE Pro Levels2": 1,
    "ADBE HUE SATURATION": 1, "ADBE Brightness & Contrast 2": 1, "ADBE Exposure2": 1, "ADBE Tint": 1,
    "ADBE Tritone": 1, "ADBE Color Balance 2": 1, "ADBE Black&White": 1, "ADBE Vibrance": 1,
    "ADBE Gaussian Blur 2": 1, "ADBE Fast Blur": 1, "ADBE Box Blur2": 1, "ADBE Sharpen": 1,
    "ADBE Unsharp Mask2": 1, "ADBE Noise2": 1, "ADBE Glo2": 1, "ADBE Invert": 1, "ADBE Fill": 1,
    "ADBE Ramp": 1, "ADBE Photo Filter": 1, "ADBE Change Color": 1
  };
  var TIME_EFFECT = /echo|posterize\s*time|time\s*warp|time\s*displacement|time\s*difference|time\s*blend|wide\s*time|motion\s*blur|frame\s*blend|pixel\s*motion|time\s*remap|freeze|optical\s*flow|\btime\b/i;
  var timeFxMemo = {};
  function readsOtherTimes(c) {
    var key = String(idOf(c));
    if (timeFxMemo.hasOwnProperty(key)) return timeFxMemo[key];
    var found = false;
    var n = 0;
    try { n = c.numLayers || 0; } catch (e) { found = true; }
    for (var i = 1; i <= n && !found; i++) {
      try {
        var L = c.layer(i);
        if (L.enabled === false) continue;
        var adjust = L.adjustmentLayer === true;
        var fx = L.property ? L.property("ADBE Effect Parade") : null;
        var m = fx ? (fx.numProperties || 0) : 0;
        for (var j = 1; j <= m && !found; j++) {
          var ef = fx.property(j);
          var mn = String(ef.matchName);
          if (TIME_EFFECT.test(mn) || TIME_EFFECT.test(String(ef.name))) found = true;
          else if (adjust && NON_TIME_EFFECTS[mn] !== 1) found = true;
        }
      } catch (e2) { found = true; }
    }
    timeFxMemo[key] = found;
    return found;
  }

  function walk(c, iv, live, why, depth) {
    if (!c || depth > 32) return;
    if (live && iv && readsOtherTimes(c)) iv = null;
    var key = String(idOf(c));
    var st = compState[key];
    if (!st) { st = compState[key] = { live: false, all: false, hull: null, skip: false }; visited.push(c); }
    if (live) {
      // A comp reached twice is walked again only for time it has not covered.
      if (st.live && (st.all || (iv && st.hull && iv.a >= st.hull.a && iv.b <= st.hull.b))) return;
      if (!iv) st.all = true;
      else st.hull = st.hull ? { a: Math.min(st.hull.a, iv.a), b: Math.max(st.hull.b, iv.b) } : { a: iv.a, b: iv.b };
      st.live = true;
      iv = st.all ? null : st.hull;
    } else {
      if (st.skip) return;
      st.skip = true;
    }
    var n = 0;
    try { n = c.numLayers || 0; } catch (e1) { n = 0; }
    for (var i = 1; i <= n; i++) {
      var L = null, src = null;
      try { L = c.layer(i); src = L.source; } catch (e2) { src = null; }
      if (!src) continue;
      var isComp = src instanceof CompItem;
      var isFootage = !isComp && src instanceof FootageItem;
      if (!isComp && !isFootage) continue;

      var read = false, reason = why;
      var drawn = false;
      if (live) {
        var on = layerOn(L);
        drawn = on && overlaps(L, iv, c);
        read = drawn || isMatte(L);
        if (!read) {
          var refs = refsOf(c);
          read = refs.all || refs.idx[i] === true;
        }
        if (!read) {
          reason = "its layer \"" + nameOf(L) + "\" in \"" + nameOf(c) + "\" is " +
            (on ? "outside the rendered time span" : "switched off");
        }
      }
      if (isComp) {
        if (read) walk(src, drawn ? childSpan(L, iv, src) : null, true, null, depth + 1);
        else walk(src, null, false, reason, depth + 1);
        continue;
      }
      var fid = String(idOf(src));
      var gone = isMissing(src);
      if (read) {
        if (usedIds[fid]) continue;
        usedIds[fid] = true;
        if (gone) {
          if (missing.length < NAMES_CAP) missing.push("\"" + nameOf(src) + "\"");
        } else {
          var p = fileOf(src);
          if (p) files.push({ name: nameOf(src), path: p });
        }
      } else if (gone) {
        if (!skipWhy[fid]) { skipWhy[fid] = { name: nameOf(src), why: reason }; skipOrder.push(fid); }
      } else {
        var sp = fileOf(src);
        if (sp && !skipFiles[fid]) skipFiles[fid] = { name: nameOf(src), path: sp };
      }
    }
  }

  // An expression in the render that samples pixels can read any layer.
  function hasSampleImage(group, depth) {
    if (depth > 12) return true;
    var n = 0;
    try { n = group.numProperties || 0; } catch (e) { return true; }
    for (var j = 1; j <= n; j++) {
      var p = null;
      try { p = group.property(j); } catch (e1) { return true; }
      if (!p) continue;
      try {
        if (p.propertyType === PropertyType.PROPERTY) {
          if (p.canSetExpression === true && p.expressionEnabled === true && /sampleImage/.test(String(p.expression))) return true;
        } else if (hasSampleImage(p, depth + 1)) {
          return true;
        }
      } catch (e2) { return true; }
    }
    return false;
  }
  function anySampleImage() {
    if (typeof PropertyType === "undefined") return true;
    for (var k = 0; k < visited.length; k++) {
      var n = 0;
      try { n = visited[k].numLayers || 0; } catch (e) { return true; }
      for (var i = 1; i <= n; i++) {
        var L = null;
        try { L = visited[k].layer(i); } catch (e1) { return true; }
        if (hasSampleImage(L, 0)) return true;
      }
    }
    return false;
  }

  var span = null;
  try {
    var t0 = item.timeSpanStart, d = item.timeSpanDuration;
    if (typeof t0 === "number" && typeof d === "number" && d > 0) span = { a: t0, b: t0 + d };
  } catch (e) { span = null; }
  var comp = null;
  try { comp = item.comp; } catch (e3) { comp = null; }
  walk(comp, span, true, null, 0);

  // Missing footage read anywhere is read; a skip elsewhere does not undo it.
  var pending = [];
  for (var s = 0; s < skipOrder.length; s++) {
    if (!usedIds[skipOrder[s]]) pending.push(skipWhy[skipOrder[s]]);
  }
  var unreadFiles = [];
  for (var fk in skipFiles) {
    if (skipFiles.hasOwnProperty(fk) && !usedIds[fk]) unreadFiles.push(skipFiles[fk]);
  }
  // Whenever anything was left unread, missing or not: a skipped layer with
  // its footage present must still be checked on disk (#145) when an
  // expression may sample it. When nothing was skipped the scan could change
  // nothing, so that is the one case it is not run.
  var sampled = (pending.length || unreadFiles.length) ? anySampleImage() : false;
  for (var q = 0; q < pending.length && q < NAMES_CAP; q++) {
    var line = "\"" + pending[q].name + "\": " + pending[q].why;
    if (sampled) {
      warnings.push(line + ", so it should not be rendered — but an expression in this render calls sampleImage(), " +
        "which can read a switched-off layer's pixels. If it reads this one, those frames show the missing-footage " +
        "placeholder. Relink it to be sure.");
    } else {
      skipped.push(line);
    }
  }
  // Present footage that is probably unread still has to be findable when an
  // expression may sample it.
  if (sampled) for (var u = 0; u < unreadFiles.length; u++) files.push(unreadFiles[u]);
  return { missing: missing, warnings: warnings, skipped: skipped, files: files };
}

/** True when the .aep on disk cannot be written. Null when the host will not say. */
function __rqProjectReadOnly() {
  try { return app.project.file.readonly === true; } catch (e) { return null; }
}

/**
 * Save the project so the separate render process sees what the user sees.
 *
 * Only ever called when the caller passed saveProject:true, and the project
 * has unsaved changes or (with `force`) records footage paths that went stale. Dialogs are suppressed for the save, as export_mogrt does:
 * a read-only file, a project converted from an older version (which AE will
 * only Save As) or a locked one would otherwise raise a modal that freezes this
 * connection while the write lease is held. Under suppression such a save just
 * does not happen, so it is checked afterwards rather than trusted.
 *
 * The check is AE's own dirty flag, NOT the file's modified time. File.modified
 * has one-second resolution, and the live run (AE 26.5) refused a save that
 * had happened, because it landed in the same second as the one before: the
 * mtime read identical while `dirty` had gone false. A save that did not
 * happen leaves the project dirty; that is the signal.
 */
OPS._render_save = noUndo(function (args) {
  if (!app.project.file) {
    throw new Error("This project has never been saved. Ask the user to save it once, then call render_queue again.");
  }
  if (__rqProjectReadOnly() === true) {
    throw new Error(
      "The project file " + app.project.file.fsName + " is read-only, so it cannot be saved for the render. " +
      "Nothing was rendered. Ask the user to make it writable or Save As somewhere else, then call render_queue again."
    );
  }
  // `force` saves a clean project too: the server asks for that when the saved
  // file records footage at paths that no longer hold it (issue #145) — a save
  // makes After Effects write the paths it resolves now. A clean project's
  // dirty flag cannot show whether that save happened, so the server re-reads
  // the saved file afterwards instead.
  if (app.project.dirty !== true && args.force !== true) {
    return { projectPath: app.project.file.fsName, saved: false, reason: "no unsaved changes" };
  }
  var file = app.project.file;
  var threw = null;
  // dispatch() normally holds dialogs suppressed already (core.jsx, "Dialog
  // guard"); suppression is begun here only when it does not, never twice.
  var own = !(typeof __dialogsSuppressed === "function" && __dialogsSuppressed());
  if (own) app.beginSuppressDialogs();
  try {
    app.project.save();
  } catch (e) {
    threw = e;
  } finally {
    if (own) app.endSuppressDialogs(false);
  }
  var stillDirty = app.project.dirty === true;
  if (threw || stillDirty) {
    throw new Error(
      "After Effects did not save the project (" + file.fsName + ")" +
      (threw ? ": " + threw.message : "") + ". Nothing was rendered. The usual causes are a file that is " +
      "locked or read-only, or a project converted from an older version of After Effects, which only " +
      "File > Save As will write. Ask the user to save it by hand, then call render_queue again."
    );
  }
  return { projectPath: file.fsName, saved: true };
});

/**
 * When a render job ends, take its verified items out of the queue's QUEUED
 * set so a later render_queue does not render them again (aerender rendered a
 * copy of the file, so the live queue never learned they were done).
 *
 * It changes the project, so it is ONE named undo step — "AE MCP: mark
 * rendered" — opened and closed by dispatch() in this one call, never an
 * unlabeled entry. All the job's items go in that one step, once, at the end:
 * a step per item would land in the user's undo history every few minutes
 * while they work, between their own edits. Matched by comp AND output path,
 * because indices shift: an item that no longer matches is left alone and
 * reported, never guessed at.
 */
OPS._render_mark_done = undoNamed("AE MCP: mark rendered", function (args) {
  var rq = app.project.renderQueue;
  var list = args.items || [];
  var results = [];
  for (var k = 0; k < list.length; k++) {
    var want = list[k];
    var idx = want.index;
    if (!(idx >= 1 && idx <= rq.numItems)) {
      results.push({ index: idx, marked: false, reason: "item " + idx + " no longer exists" });
      continue;
    }
    var s = __rqItemSummary(rq, idx, false);
    var firstPath = s.outputs.length ? s.outputs[0].path : null;
    if (s.compId !== want.compId || firstPath !== want.outputPath) {
      results.push({ index: idx, marked: false, reason: "item " + idx + " now renders something else (the queue changed during the render)" });
      continue;
    }
    rq.item(idx).render = false;
    results.push({ index: idx, marked: true, status: __rqStatusName(rq.item(idx).status) });
  }
  return { results: results };
});
