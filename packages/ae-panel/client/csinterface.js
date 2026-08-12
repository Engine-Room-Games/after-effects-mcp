// Minimal CSInterface — only the methods our panel needs.
// CEP injects window.__adobe_cep__ which provides the real implementation.

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (callback === null || callback === undefined) callback = function () {};
  window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getSystemPath = function (pathType) {
  var path = window.__adobe_cep__.getSystemPath(pathType);
  if (path && path.indexOf("file://") === 0) path = decodeURIComponent(path.substring(7));
  // CEP hands back a file URL, so on Windows the drive letter arrives still
  // carrying the URL's leading slash: /C:/Users/... Node reads that as
  // root-relative — path.join turns it into \C:\...\jsx\bundle.jsx, which no
  // fs call can open, and the panel reports the bundle missing when it is
  // sitting right there. Strip it here rather than at each call site: this is
  // the one place a URL becomes a native path.
  if (path) path = path.replace(/^\/([A-Za-z]:)/, "$1");
  return path;
};

CSInterface.prototype.getHostEnvironment = function () {
  try { return JSON.parse(window.__adobe_cep__.getHostEnvironment()); } catch (e) { return {}; }
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (window.__adobe_cep__.openURLInDefaultBrowser) window.__adobe_cep__.openURLInDefaultBrowser(url);
};

var SystemPath = {
  USER_DATA: "userData",
  COMMON_FILES: "commonFiles",
  MY_DOCUMENTS: "myDocuments",
  APPLICATION: "application",
  EXTENSION: "extension",
  HOST_APPLICATION: "hostApplication",
};
