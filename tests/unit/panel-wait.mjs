// The panel reports a wait on its own evalScript mutex (issue #175).
//
// Every MCP server pointed at one panel shares that mutex, while each server's
// write queue knows only its own process. Measured on AE 26.5: a second
// client's write waited six seconds behind the first client's run_jsx and its
// result said nothing. The panel now answers `/op` with `panelWait` beside the
// result when the call queued behind another; the server half is pinned in
// write-queue-server.mjs.
//
// This boots the real main.js against a stub CEP host whose evalScript is slow
// for one op, and posts two ops at once — as two servers would.
//
//   node tests/unit/panel-wait.mjs

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
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`panel-wait FAILED: ${name}`);
    throw e;
  }
}

/** op name -> how long the stub ExtendScript takes to answer it. */
const slow = new Map();
/** op name -> what the stub ExtendScript answers it with, when not `{stub: true}`. */
const answers = new Map();

// The same stub CEP host the other panel tests use, with a per-op delay.
function makeHost(extDir) {
  return {
    getSystemPath: () => extDir,
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "26.5" }),
    evalScript: (script, cb) => {
      if (script.indexOf("$.evalFile") >= 0) return void setTimeout(() => cb("ok"), 0);
      const has = (op) => script.indexOf(`\\"op\\":\\"${op}\\"`) >= 0;
      let ms = 0;
      for (const [op, delay] of slow) if (has(op)) ms = delay;
      let result = { stub: true };
      for (const [op, r] of answers) if (has(op)) result = r;
      setTimeout(() => cb(JSON.stringify({ ok: true, result })), ms);
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
  return { nodes, document: { getElementById: (id) => nodes[id] ?? null, createElement: () => mk() } };
}

function installLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-wait-panel-"));
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jsx"), { recursive: true });
  for (const f of fs.readdirSync(path.join(panelSrc, "client"))) {
    fs.copyFileSync(path.join(panelSrc, "client", f), path.join(dir, "client", f));
  }
  fs.copyFileSync(path.join(panelSrc, "jsx", "bundle.jsx"), path.join(dir, "jsx", "bundle.jsx"));
  fs.copyFileSync(path.join(panelSrc, "package.json"), path.join(dir, "package.json"));
  return dir;
}

/** Boot the real main.js against a fake home and an ephemeral port — never 7777 (see panel-boot.mjs). */
function bootPanel(extDir) {
  const source = fs.readFileSync(path.join(extDir, "client", "main.js"), "utf8");
  const csSource = fs.readFileSync(path.join(extDir, "client", "csinterface.js"), "utf8");
  const dom = makeDom();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-wait-home-"));
  const configDir = path.join(fakeHome, ".engineroom-ae-mcp");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ port: 0 }));
  const realOs = nodeRequire("node:os");
  const realHttp = nodeRequire("node:http");
  const servers = [];
  const sandbox = {
    console,
    Promise, Date, Math, JSON, Error, Buffer, String, Number, Array, Object, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: extDir,
    __filename: path.join(extDir, "main.js"),
    document: dom.document,
    window: { __adobe_cep__: makeHost(extDir), addEventListener: () => {} },
    require: (id) => {
      if (id === "os") return { ...realOs, homedir: () => fakeHome };
      if (id === "http") {
        return {
          ...realHttp,
          createServer: (...a) => { const s = realHttp.createServer(...a); servers.push(s); return s; },
        };
      }
      if (["path", "fs", "crypto", "zlib", "net", "url", "stream", "events", "util", "buffer"].includes(id)) {
        return nodeRequire(`node:${id}`);
      }
      return nodeRequire(id);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(csSource, sandbox, { filename: "csinterface.js" });
  vm.runInContext(source, sandbox, { filename: "main.js" });
  const close = () => {
    for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  };
  return { dom, close, configDir };
}

function settled(dom, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const s = dom.nodes.status.textContent;
      if (s === "ready" || s === "failed" || s.indexOf("cannot start") === 0) return resolve(s);
      if (Date.now() > deadline) return reject(new Error(`panel never settled; stuck at "${s}"`));
      setTimeout(poll, 25);
    })();
  });
}

const dir = installLayout();
const panel = bootPanel(dir);
assert.equal(await settled(panel.dom), "ready", "panel did not boot");
const PORT = Number(panel.dom.nodes.port.textContent);
assert.ok(PORT > 0 && PORT !== 7777, `bad port ${PORT}`);
const TOKEN = fs.readFileSync(path.join(panel.configDir, `token-${PORT}`), "utf8").trim();

const post = async (op) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/op`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ae-mcp-token": TOKEN },
    body: JSON.stringify({ op, args: {} }),
  });
  return r.json();
};

await check("an uncontended op carries no panelWait", async () => {
  const res = await post("set_layer");
  assert.equal(res.ok, true);
  assert.equal("panelWait" in res, false, JSON.stringify(res));
});

await check("an op queued behind another names it and how long it waited", async () => {
  slow.set("run_jsx", 300);
  // Client X's slow write, then client Y's, a moment later — two servers, one panel.
  const first = post("run_jsx");
  await new Promise((r) => setTimeout(r, 30));
  const second = post("set_layer");
  const [a, b] = await Promise.all([first, second]);
  assert.equal("panelWait" in a, false, "the op that went first did not wait");
  assert.equal(b.ok, true);
  assert.deepEqual(Object.keys(b.result), ["stub"], "the wait must sit beside the result, never inside it");
  assert.equal(b.panelWait.behind, "run_jsx");
  assert.ok(b.panelWait.waitedMs >= 200 && b.panelWait.waitedMs < 1000, `waitedMs was ${b.panelWait.waitedMs}`);
  slow.clear();
});

await check("the mutex forgets a finished op: the next call is uncontended again", async () => {
  const res = await post("set_layer");
  assert.equal("panelWait" in res, false, JSON.stringify(res));
});

await check("a wait behind a batch chunk names run_batch, not _continue_job", async () => {
  // The panel drives a chunked batch itself, one `_continue_job` per chunk —
  // a name no agent ever called. Another client's write waiting behind one has
  // to name the tool that caused it.
  answers.set("run_batch", { jobId: "j_wait", async: true, total: 600, chunkSize: 25 });
  answers.set("_continue_job", { done: true, results: [] });
  slow.set("_continue_job", 300);
  const batch = await post("run_batch");
  assert.equal(batch.result.jobId, "j_wait");
  // The chunk is already on the chain by the time the envelope came back.
  const res = await post("set_layer");
  assert.equal(res.panelWait?.behind, "run_batch", JSON.stringify(res));
  assert.ok(res.panelWait.waitedMs >= 150, `waitedMs was ${res.panelWait.waitedMs}`);
  slow.clear();
  answers.clear();
});

await check("a wait behind any other internal step never leaks an underscore name", async () => {
  // /cancel runs `_cancel_job` on the same chain; it maps to its tool.
  slow.set("_cancel_job", 300);
  const cancel = fetch(`http://127.0.0.1:${PORT}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ae-mcp-token": TOKEN },
    body: JSON.stringify({ jobId: "j_none" }),
  });
  await new Promise((r) => setTimeout(r, 30));
  const res = await post("set_layer");
  await cancel;
  assert.equal(res.panelWait?.behind, "cancel_job", JSON.stringify(res));
  slow.clear();
});

panel.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`panel-wait: ${passed} checks passed`);
