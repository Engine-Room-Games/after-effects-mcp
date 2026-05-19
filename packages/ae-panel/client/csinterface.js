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
