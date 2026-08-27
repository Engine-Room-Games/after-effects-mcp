// The panel's bootstrap: does main.js get as far as a listening bridge, from
// the layout setup_panel actually installs?
//
// Written because it did not. CEP anchors `__dirname` at the *extension root*,
// not at the folder holding main.js — which is why `require("ws")` resolves
// (node_modules is at the root) while a require of a file sitting right next to
// main.js does not. The panel's screenshot modules were loaded the second way,
// so on a real install the panel refused to start with "cannot start —
// pngcodec.js … is missing", naming a path with the `client/` segment missing.
// Nothing caught it: there is no After Effects on a CI runner, the unit tests
// require the sibling modules directly by absolute path, and the panel that was
// installed on the one machine this had ever run on predated those modules.
//
// So this runs the real main.js against a stub CEP host, in a temp copy of the
// real installed layout, with `__dirname` set to the extension root the way CEP
// sets it. It asserts the panel reaches "ready" and serves /health.
//
//   node tests/unit/panel-boot.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const panelSrc = path.join(root, "packages", "ae-panel");

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((e) => {
      console.error(`panel-boot FAILED: ${name}`);
      throw e;
    });
}

// ---------------------------------------------------------------------------
// Build the layout setup_panel installs: client/ beside jsx/, node_modules and
// the manifest at the extension root.
// ---------------------------------------------------------------------------
function installLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-panel-boot-"));
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jsx"), { recursive: true });
  for (const f of ["main.js", "csinterface.js", "pngcodec.js", "framecache.js", "mogrt.js", "index.html"]) {
    fs.copyFileSync(path.join(panelSrc, "client", f), path.join(dir, "client", f));
  }
  fs.copyFileSync(path.join(panelSrc, "jsx", "bundle.jsx"), path.join(dir, "jsx", "bundle.jsx"));
  fs.copyFileSync(path.join(panelSrc, "package.json"), path.join(dir, "package.json"));
  return dir;
}

// ---------------------------------------------------------------------------
// A stub CEP host. evalScript answers the two calls the boot sequence makes.
// ---------------------------------------------------------------------------
function makeHost(extDir) {
  const evalCalls = [];
  return {
    evalCalls,
    getSystemPath: (which) => (which === "extension" ? extDir : extDir),
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "26.3" }),
    evalScript: (script, cb) => {
      evalCalls.push(script);
      // loadJsxBundle asks ExtendScript to evaluate the bundle and answer "ok".
      if (script.indexOf("$.evalFile") >= 0) return void setTimeout(() => cb("ok"), 0);
      setTimeout(() => cb(JSON.stringify({ ok: true, result: {} })), 0);
    },
  };
}

function makeDom() {
  const nodes = {};
  const mk = () => ({
    textContent: "",
    className: "",
    childNodes: [],
    insertBefore(n) { this.childNodes.unshift(n); },
    removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
  });
  for (const id of ["status", "port", "ae", "jsx", "reqs", "log"]) nodes[id] = mk();
  return {
    nodes,
    document: {
      getElementById: (id) => nodes[id] ?? null,
      createElement: () => mk(),
    },
  };
}

/**
 * Run main.js the way CEP does, and resolve once it stops changing status.
 *
 * `dirnameAt` is the whole point of the harness: CEP sets __dirname to the
 * extension root, so that is the default, and the client-dir case is checked
 * too because a host build that does it the other way must still boot.
 */
function bootPanel(extDir, { dirnameAt = extDir } = {}) {
  const source = fs.readFileSync(path.join(extDir, "client", "main.js"), "utf8");
  const csSource = fs.readFileSync(path.join(extDir, "client", "csinterface.js"), "utf8");
  const host = makeHost(extDir);
  const dom = makeDom();

  // The panel writes a port file into the user's home and binds a real socket.
  // Neither may escape this test: a stray write would point a live MCP server
  // at a port that stops existing when the test does, and a server left
  // listening would hold 7777 away from the real After Effects panel.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-panel-home-"));
  const realOs = nodeRequire("node:os");
  const realHttp = nodeRequire("node:http");
  const servers = [];

  const sandbox = {
    console,
    Promise, Date, Math, JSON, Error, Buffer, String, Number, Array, Object, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: dirnameAt,
    __filename: path.join(dirnameAt, "main.js"),
    document: dom.document,
    window: { __adobe_cep__: host },
    require: (id) => {
      if (id === "os") return { ...realOs, homedir: () => fakeHome };
      if (id === "http") {
        return {
          ...realHttp,
          createServer: (...a) => {
            const s = realHttp.createServer(...a);
            servers.push(s);
            return s;
          },
        };
      }
      if (["path", "fs", "crypto", "zlib", "net", "url", "stream", "events", "util", "buffer"].includes(id)) {
        return nodeRequire(`node:${id}`);
      }
      // `ws` and anything else go through the real resolver — resolving them is
      // part of what this test is checking.
      return nodeRequire(id);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(csSource, sandbox, { filename: "csinterface.js" });
  vm.runInContext(source, sandbox, { filename: "main.js" });

  const close = () => {
    for (const s of servers) { try { s.close(); s.closeAllConnections?.(); } catch {} }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  };
  return { sandbox, dom, host, close, portFile: path.join(fakeHome, ".engineroom-ae-mcp", "port") };
}

function settled(dom, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const status = dom.nodes.status.textContent;
      if (status === "ready" || status === "failed" || status.indexOf("cannot start") === 0) return resolve(status);
      if (Date.now() > deadline) return reject(new Error(`panel never settled; status stuck at "${status}"`));
      setTimeout(poll, 25);
    })();
  });
}

function logText(dom) {
  return dom.nodes.log.childNodes.map((n) => n.textContent).join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const dir = installLayout();
let booted = null;

await check("boots with __dirname at the extension root, the way CEP sets it", async () => {
  booted = bootPanel(dir, { dirnameAt: dir });
  const status = await settled(booted.dom);
  assert.equal(
    status,
    "ready",
    `panel did not reach "ready" (status: ${status})\n--- panel log ---\n${logText(booted.dom)}`,
  );
});

await check("loaded the bundle and reported the host", () => {
  assert.ok(booted.host.evalCalls.some((s) => s.indexOf("$.evalFile") >= 0), "never evaluated bundle.jsx");
  assert.match(booted.dom.nodes.ae.textContent, /AEFT 26\.3/);
});

await check("serves /health on the port it announced", async () => {
  const port = Number(booted.dom.nodes.port.textContent);
  assert.ok(port > 0, `no port announced (got "${booted.dom.nodes.port.textContent}")`);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.bundleLoaded, true);
  assert.ok(body.bundleHash, "health did not report a bundle hash");
});

await check("wrote the port file the MCP server discovers it by", () => {
  const written = fs.readFileSync(booted.portFile, "utf8").trim();
  assert.equal(written, booted.dom.nodes.port.textContent, "port file disagrees with the announced port");
});

await check("also boots if a host build anchors __dirname at the client folder", async () => {
  const other = bootPanel(dir, { dirnameAt: path.join(dir, "client") });
  try {
    const status = await settled(other.dom);
    assert.equal(status, "ready", `status: ${status}\n--- panel log ---\n${logText(other.dom)}`);
  } finally { other.close(); }
});

await check("says which paths it tried when a sibling module really is missing", async () => {
  const broken = installLayout();
  fs.unlinkSync(path.join(broken, "client", "pngcodec.js"));
  const b = bootPanel(broken, { dirnameAt: broken });
  try {
    const status = await settled(b.dom);
    assert.match(status, /^cannot start/, `expected a refusal, got "${status}"`);
    const log = logText(b.dom);
    // The failure that shipped named one path and left the reader guessing
    // which layout was wrong. Every candidate has to be in the log.
    assert.match(log, /pngcodec\.js/);
    assert.match(log, /client/, "the log should show the client-dir candidate that was tried");
    assert.match(log, /Quit After Effects/, "should name the fix");
  } finally { b.close(); }
  fs.rmSync(broken, { recursive: true, force: true });
});

console.log(`panel-boot: ${passed} checks passed`);
booted?.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
