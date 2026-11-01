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

// Events between the extensions of this bundle (issue #283): the bridge runs
// as a hidden extension and the visible status panel is a separate one, with
// its own page and no Node, so the two talk over CEP's application-scoped
// events. Each method is guarded: a host without the native call (and the
// unit tests' stub) must cost the caller nothing.
function CSEvent(type, scope, appId, extensionId) {
  this.type = type;
  this.scope = scope || "APPLICATION";
  this.appId = appId;
  this.extensionId = extensionId;
  this.data = "";
}

CSInterface.prototype.dispatchEvent = function (event) {
  if (!window.__adobe_cep__ || !window.__adobe_cep__.dispatchEvent) return false;
  if (typeof event.data === "object") event.data = JSON.stringify(event.data);
  window.__adobe_cep__.dispatchEvent(event);
  return true;
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
  if (!window.__adobe_cep__ || !window.__adobe_cep__.addEventListener) return false;
  window.__adobe_cep__.addEventListener(type, listener, obj);
  return true;
};

CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
  if (!window.__adobe_cep__ || !window.__adobe_cep__.requestOpenExtension) return false;
  window.__adobe_cep__.requestOpenExtension(extensionId, params === undefined ? "" : params);
  return true;
};
