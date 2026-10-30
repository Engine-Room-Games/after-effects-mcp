// The panel's bootstrap: does main.js get as far as a listening bridge, from
// the layout setup_panel actually installs?
//
// Written because it did not. CEP anchors `__dirname` at the *extension root*,
// not at the folder holding main.js — which is why `require("ws")` resolves
// (node_modules is at the root) while a require of a file sitting right next to
// main.js does not. The panel's screenshot modules (since moved to the server)
// were loaded the second way,
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
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const panelSrc = path.join(root, "packages", "ae-panel");
const { panelClientHash } = await import(
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "setup", "panelHash.js")).href
);

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
  // Whatever the panel ships in client/, so a module added there is loaded here.
  for (const f of fs.readdirSync(path.join(panelSrc, "client"))) {
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
  const host = {
    evalCalls,
    // Set to true to play another script deleting __AEMCP: the next op answers
    // the panel's sentinel, as the guard in opScript() does in AE (issue #185).
    namespaceGone: false,
    answer: null,
    getSystemPath: (which) => (which === "extension" ? extDir : extDir),
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "26.3" }),
    evalScript: (script, cb) => {
      evalCalls.push(script);
      // loadJsxBundle asks ExtendScript to evaluate the bundle and answer "ok".
      if (script.indexOf("$.evalFile") >= 0) {
        host.namespaceGone = false;
        return void setTimeout(() => cb("ok"), 0);
      }
      if (host.namespaceGone) return void setTimeout(() => cb("__AEMCP_MISSING__"), 0);
      // `answer(op, args)` plays one op's ExtendScript reply; a thrown error is
      // reported the way dispatch() reports one.
      if (host.answer) {
        const open = script.indexOf("__AEMCP.call(") + "__AEMCP.call(".length;
        const p = JSON.parse(JSON.parse(script.slice(open, script.lastIndexOf(") : '"))));
        let body;
        try { body = { ok: true, result: host.answer(p.op, p.args) }; }
        catch (e) { body = { ok: false, error: e.message }; }
        return void setTimeout(() => cb(JSON.stringify(body)), 0);
      }
      setTimeout(() => cb(JSON.stringify({ ok: true, result: {} })), 0);
    },
  };
  return host;
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

// ---------------------------------------------------------------------------
// The panel's port numbers, private to this process (issue #260).
//
// The port-drift checks below are about what the panel decides when a port is
// taken, and they used to decide it in the machine's one shared port space.
// Under parallel load that is not ours alone: the moment a test frees a port,
// another process can bind it — another run's panel took a freshly unloaded
// one and answered /health, and something took a port in the gap before the
// waiting panel's retry, so it walked. And an ephemeral port can be 65535,
// which leaves no next port to walk to.
//
// So every socket the panel binds is a real socket on a real ephemeral port,
// but the number the panel asks for, reads back with address(), announces and
// probes is a number in this table — which only this process can hold. A
// port is free in it exactly when no server here holds it, and EADDRINUSE is
// raised exactly when one does, so the panel's code paths are the real ones.
// ---------------------------------------------------------------------------
const portTable = new Map(); // the panel's port number -> the http.Server holding it
const realAddress = new WeakMap(); // http.Server -> its unpatched address()
let nextEphemeral = 40000;

/** Give `server` the table semantics: listen/address/close speak table numbers. */
function tablePorts(server) {
  const listen = server.listen.bind(server);
  const address = server.address.bind(server);
  const close = server.close.bind(server);
  realAddress.set(server, address);
  let held = null;
  server.listen = (port, host, cb) => {
    if (typeof host === "function") { cb = host; host = "127.0.0.1"; }
    // Out of range is the real listen's to refuse, with its own error.
    if (!(port >= 0 && port <= 65535)) return listen(port, host, cb);
    let p = port;
    if (p === 0) { while (portTable.has(nextEphemeral)) nextEphemeral++; p = nextEphemeral++; }
    if (portTable.has(p)) {
      const e = Object.assign(new Error(`listen EADDRINUSE: address already in use ${host}:${p}`), {
        code: "EADDRINUSE", errno: -48, syscall: "listen", address: host, port: p,
      });
      process.nextTick(() => server.emit("error", e));
      return server;
    }
    portTable.set(p, server);
    held = p;
    return listen(0, host, cb);
  };
  server.address = () => {
    const a = address();
    return a && held !== null ? { ...a, port: held } : a;
  };
  server.close = (cb) => {
    if (held !== null && portTable.get(held) === server) portTable.delete(held);
    held = null;
    return close(cb);
  };
  return server;
}

/** The real port behind a table number, or null when nothing here holds it. */
function realPortOf(port) {
  const s = portTable.get(Number(port));
  return s ? realAddress.get(s)().port : null;
}

/** A URL on the panel's port, as the MCP server would reach it. */
function panelUrl(port, route) {
  const real = realPortOf(port);
  if (real === null) throw new Error(`nothing in this test holds port ${port}`);
  return `http://127.0.0.1:${real}${route}`;
}

/** A plain HTTP server — not a panel — holding `port` in the table (0: any). */
async function stranger(port = 0) {
  const s = tablePorts(http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ hello: true }));
  }));
  await new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", resolve);
  });
  return s;
}

/**
 * Run main.js the way CEP does, and resolve once it stops changing status.
 *
 * `dirnameAt` is the whole point of the harness: CEP sets __dirname to the
 * extension root, so that is the default, and the client-dir case is checked
 * too because a host build that does it the other way must still boot.
 *
 * `config` is written to the fake home as the panel's config.json before it
 * boots. The default is `{ port: 0 }` — an ephemeral port — because the real
 * default is 7777, and on the machine this is developed on a real panel holds
 * 7777: with the #92 fix a test panel started there would recognise it as one
 * of us and wait for it for ever.
 */
function bootPanel(extDir, { dirnameAt = extDir, config = { port: 0 } } = {}) {
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
  const configDir = path.join(fakeHome, ".engineroom-ae-mcp");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));

  // The unload hook is how the panel gives its port back; a test fires it.
  const listeners = {};
  const fire = (type) => { for (const fn of listeners[type] ?? []) fn(); };

  const sandbox = {
    console,
    Promise, Date, Math, JSON, Error, Buffer, String, Number, Array, Object, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: dirnameAt,
    __filename: path.join(dirnameAt, "main.js"),
    document: dom.document,
    window: {
      __adobe_cep__: host,
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    },
    require: (id) => {
      if (id === "os") return { ...realOs, homedir: () => fakeHome };
      if (id === "http") {
        return {
          ...realHttp,
          createServer: (...a) => {
            const s = tablePorts(realHttp.createServer(...a));
            servers.push(s);
            return s;
          },
          // The holder probe: a table number, reached on its real socket.
          get: (opts, cb) => realHttp.get({ ...opts, port: realPortOf(opts.port) ?? opts.port }, cb),
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
    for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  };
  return { sandbox, dom, host, close, fire, servers, portFile: path.join(configDir, "port") };
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

/** Resolve once the status matches, or reject at the deadline with what it said instead. */
function statusMatches(dom, re, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const status = dom.nodes.status.textContent;
      if (re.test(status)) return resolve(status);
      if (Date.now() > deadline) return reject(new Error(`status never matched ${re}; stuck at "${status}"\n${logText(dom)}`));
      setTimeout(poll, 25);
    })();
  });
}

/** Resolve with the whole log once a line matches, or reject at the deadline. */
async function logLine(dom, re, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!re.test(logText(dom))) {
    if (Date.now() > deadline) throw new Error(`log never matched ${re}\n${logText(dom)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return logText(dom);
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
  const res = await fetch(panelUrl(port, "/health"));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.bundleLoaded, true);
  assert.ok(body.bundleHash, "health did not report a bundle hash");
  // Read off the server's address(), not the configured number: the config said 0.
  assert.equal(body.port, port, "health must report the port actually bound");
  // Issue #220, stage 3: the one word on which panel code is answering. The
  // server uses `_project_path` only when this lists `project-path`.
  assert.ok(Array.isArray(body.capabilities), "health must list the panel's capabilities");
  assert.ok(body.capabilities.includes("project-path"), "the panel must report project-path");
  // Issue #243: the other half of the version gate — every panel file but the
  // bundle, hashed at launch. It must be exactly what the server computes over
  // the same folder, or no panel would ever be "current".
  assert.match(String(body.clientHash), /^[0-9a-f]{64}$/, "health must report a clientHash");
  assert.equal(body.clientHash, panelClientHash(dir), "the panel's clientHash must equal the server's over the same folder");
});

await check("wrote the port file the MCP server discovers it by", () => {
  const written = fs.readFileSync(booted.portFile, "utf8").trim();
  assert.equal(written, booted.dom.nodes.port.textContent, "port file disagrees with the announced port");
});

await check("sends every op through __AEMCP, and reloads the bundle once when another script removed it", async () => {
  const port = Number(booted.dom.nodes.port.textContent);
  const token = fs.readFileSync(path.join(path.dirname(booted.portFile), `token-${port}`), "utf8").trim();
  const post = () => fetch(panelUrl(port, "/op"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-ae-mcp-token": token },
    body: JSON.stringify({ op: "list_comps", args: {} }),
  }).then((r) => r.json());

  const loadsBefore = booted.host.evalCalls.filter((s) => s.indexOf("$.evalFile") >= 0).length;
  booted.host.namespaceGone = true;
  const body = await post();
  assert.equal(body.ok, true, `op failed after the namespace went missing: ${body.error}\n${logText(booted.dom)}`);
  const calls = booted.host.evalCalls;
  const loadsAfter = calls.filter((s) => s.indexOf("$.evalFile") >= 0).length;
  assert.equal(loadsAfter, loadsBefore + 1, "the panel must re-evaluate bundle.jsx exactly once");
  const ops = calls.filter((s) => s.indexOf("list_comps") >= 0);
  assert.equal(ops.length, 2, "the op is sent once, answered with the sentinel, and sent again after the reload");
  for (const s of ops) {
    assert.match(s, /__AEMCP\.call\(/);
    assert.doesNotMatch(s, /(^|[^.\w])dispatch\(/, "an op must not reach a bare global dispatch()");
  }
  assert.match(logText(booted.dom), /__AEMCP is missing/);
});

// Issue #220, stage 5, and #243: the server drives every batch. The panel
// answers the envelope, sends no chunk of its own, keeps the flag away from
// ExtendScript, and still refuses a reload while the batch runs.
await check("a run_batch the server asked to drive: no panel loop, no flag in ExtendScript, a reload still refused", async () => {
  const port = Number(booted.dom.nodes.port.textContent);
  const token = fs.readFileSync(path.join(path.dirname(booted.portFile), `token-${port}`), "utf8").trim();
  const health = await (await fetch(panelUrl(port, "/health"))).json();
  assert.ok(health.capabilities.includes("server-drives-jobs"), "the panel must report server-drives-jobs");
  const seenArgs = [];
  let continued = 0;
  booted.host.answer = (op, args) => {
    if (op === "run_batch") {
      seenArgs.push(args);
      return { async: true, jobId: "j_5_1", total: 50, chunkSize: 25, undoStepsEstimate: 2, undoGroupName: "B", note: "n" };
    }
    if (op === "_continue_job") {
      continued += 1;
      return continued === 1
        ? { done: false, jobId: "j_5_1", progress: 25, total: 50, undoSteps: 1 }
        : { done: true, jobId: "j_5_1", results: [], errors: [], total: 50, undoSteps: 2 };
    }
    return {};
  };
  const post = (route, body) => fetch(panelUrl(port, route), {
    method: "POST",
    headers: { "content-type": "application/json", "x-ae-mcp-token": token },
    body: JSON.stringify(body),
  });
  try {
    const env = await (await post("/op", { op: "run_batch", args: { ops: [], __driver: "server" } })).json();
    assert.equal(env.ok, true, env.error);
    assert.equal(env.result.driver, "server", "the envelope says the server drives");
    assert.equal(env.result.chunkSize, 25);
    assert.equal(seenArgs[0].__driver, undefined, "the flag never reaches ExtendScript");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(continued, 0, "the panel sent no chunk of its own");

    const refused = await post("/reload-jsx", {});
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /j_5_1 \(0 of 50 ops attempted, driven by the MCP server\)/);

    const c1 = await (await post("/op", { op: "_continue_job", args: { jobId: "j_5_1", chunkSize: 25 } })).json();
    assert.equal(c1.result.progress, 25);
    assert.match((await (await post("/reload-jsx", {})).json()).error, /25 of 50 ops attempted/);
    await post("/op", { op: "_continue_job", args: { jobId: "j_5_1", chunkSize: 25 } });
    const ok = await post("/reload-jsx", {});
    assert.equal(ok.status, 200, "a finished batch no longer blocks a reload");

    // Without the flag too: the panel no longer has a loop of its own (#243).
    continued = 0;
    const bare = await (await post("/op", { op: "run_batch", args: { ops: [] } })).json();
    assert.equal(bare.result.driver, "server", "every chunked batch is handed back to the server");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(continued, 0, "the panel never drives a batch itself");
    // Let the second job finish so it does not block the reloads below.
    await post("/op", { op: "_continue_job", args: { jobId: "j_5_1", chunkSize: 25 } });
    await post("/op", { op: "_continue_job", args: { jobId: "j_5_1", chunkSize: 25 } });
  } finally { booted.host.answer = null; }
});

await check("the heal will not load a newer installed bundle into a running panel: the gate keeps saying restart", async () => {
  const port = Number(booted.dom.nodes.port.textContent);
  const token = fs.readFileSync(path.join(path.dirname(booted.portFile), `token-${port}`), "utf8").trim();
  const health = () => fetch(panelUrl(port, "/health")).then((r) => r.json());
  const runningHash = (await health()).bundleHash;
  const bundleFile = path.join(dir, "jsx", "bundle.jsx");
  const original = fs.readFileSync(bundleFile);
  fs.writeFileSync(bundleFile, Buffer.concat([original, Buffer.from("\n// a newer setup_panel install\n")]));
  try {
    const loadsBefore = booted.host.evalCalls.filter((s) => s.indexOf("$.evalFile") >= 0).length;
    booted.host.namespaceGone = true;
    const body = await fetch(panelUrl(port, "/op"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-ae-mcp-token": token },
      body: JSON.stringify({ op: "list_comps", args: {} }),
    }).then((r) => r.json());
    assert.equal(body.ok, false);
    assert.match(body.error, /newer version than this running panel[\s\S]*Nothing ran\. Restart After Effects/);
    const loadsAfter = booted.host.evalCalls.filter((s) => s.indexOf("$.evalFile") >= 0).length;
    assert.equal(loadsAfter, loadsBefore, "a newer bundle must not be evaluated by the heal");
    assert.equal((await health()).bundleHash, runningHash, "the running hash must not move to the installed one");
  } finally {
    fs.writeFileSync(bundleFile, original);
    booted.host.namespaceGone = false;
  }
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
  fs.unlinkSync(path.join(broken, "client", "panelhash.js"));
  const b = bootPanel(broken, { dirnameAt: broken });
  try {
    const status = await settled(b.dom);
    assert.match(status, /^cannot start/, `expected a refusal, got "${status}"`);
    const log = logText(b.dom);
    // The failure that shipped named one path and left the reader guessing
    // which layout was wrong. Every candidate has to be in the log.
    assert.match(log, /panelhash\.js/);
    assert.match(log, /client/, "the log should show the client-dir candidate that was tried");
    assert.match(log, /Quit After Effects/, "should name the fix");
  } finally { b.close(); }
  fs.rmSync(broken, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Port drift (issue #92): who holds the port, and what to do about it.
// ---------------------------------------------------------------------------

await check("does not walk past another AE MCP panel: waits, names the holder, then takes the port over", async () => {
  const held = Number(booted.dom.nodes.port.textContent);
  const second = bootPanel(dir, { config: { port: held, bindRetryMs: 150 } });
  try {
    const status = await statusMatches(second.dom, /^waiting/);
    assert.match(status, new RegExp(`port ${held} is held by another AE MCP panel`));
    const log = logText(second.dom);
    assert.match(log, /already held by another AE MCP panel/);
    assert.match(log, /the same version as this one/, "the holder's bundle must be compared with this one's");
    assert.match(log, /issue #92/);
    assert.match(log, /allowPortWalk/, "the opt-in must be named for people who really run two instances");
    assert.match(log, /CEPHtmlEngine/, "the zombie has to be named so the user can find it");

    // Several retries later it is still waiting: no walk, no port announced,
    // and no port file — the file may only ever name a port actually bound.
    await new Promise((r) => setTimeout(r, 500));
    assert.match(second.dom.nodes.status.textContent, /^waiting/);
    assert.equal(second.dom.nodes.port.textContent, "");
    assert.equal(fs.existsSync(second.portFile), false, "the port file was written for a port that was never bound");

    // The holder exits. Nothing is restarted.
    booted.close();
    const after = await settled(second.dom);
    assert.equal(after, "ready", `status: ${after}\n--- panel log ---\n${logText(second.dom)}`);
    assert.equal(Number(second.dom.nodes.port.textContent), held, "should have taken over the same port, not walked");
    assert.equal(fs.readFileSync(second.portFile, "utf8").trim(), String(held));
    const res = await fetch(panelUrl(held, "/health"));
    assert.equal((await res.json()).ok, true);
    booted = second;
  } catch (e) {
    second.close();
    throw e;
  }
});

await check("walks past a holder that is not an AE MCP panel, and says which port it chose and why", async () => {
  const other = await stranger();
  const q = other.address().port;
  const p = bootPanel(dir, { config: { port: q } });
  try {
    const status = await settled(p.dom);
    assert.equal(status, "ready", `status: ${status}\n${logText(p.dom)}`);
    const got = Number(p.dom.nodes.port.textContent);
    assert.notEqual(got, q);
    const log = logText(p.dom);
    assert.match(log, new RegExp(`port ${q} is held by something that is not an AE MCP panel`));
    assert.match(log, new RegExp(`moving to port ${q + 1}`));
    assert.match(log, /if tool calls fail on/, "the walk has to say what it will look like from the server side");
    assert.match(log, new RegExp(`configured port ${q} was taken`));
    assert.equal(fs.readFileSync(p.portFile, "utf8").trim(), String(got), "the port file names the port actually bound");
  } finally {
    p.close();
    other.closeAllConnections?.();
    other.close();
  }
});

await check("walking off the top of the port range refuses, naming the range, instead of asking for port 65536", async () => {
  // Only reachable when the configured port is 65535 — or, in this test
  // before #260, when the ephemeral port the first panel drew was.
  const top = await stranger(65535);
  const p = bootPanel(dir, { config: { port: 65535 } });
  try {
    const status = await settled(p.dom);
    assert.equal(status, "failed", `status: ${status}\n${logText(p.dom)}`);
    const log = logText(p.dom);
    assert.match(log, /ports 65535 through 65535 are all in use/);
    assert.match(log, /Last holder: something that is not an AE MCP panel/);
    assert.match(log, /65535 is the highest port there is/, `the refusal must say why there is nowhere to walk\n${log}`);
    assert.doesNotMatch(log, /65536/, "no port past the range may be named, or tried");
    assert.equal(fs.existsSync(p.portFile), false, "no port file for a panel that bound nothing");
  } finally {
    p.close();
    top.close();
  }
});

let walker = null;
await check("allowPortWalk opts back into walking past our own panel", async () => {
  const held = Number(booted.dom.nodes.port.textContent);
  const p = bootPanel(dir, { config: { port: held, allowPortWalk: true } });
  try {
    const status = await settled(p.dom);
    assert.equal(status, "ready", `status: ${status}\n${logText(p.dom)}`);
    assert.notEqual(Number(p.dom.nodes.port.textContent), held);
    assert.match(logText(p.dom), /allowPortWalk is on/);
    assert.match(logText(p.dom), /another AE MCP panel/);
    walker = p;
  } catch (e) {
    p.close();
    throw e;
  }
});

/**
 * After unload, the panel gives its port back: nothing in this test holds the
 * port number any more, the panel's socket has stopped listening, and the real
 * socket answers nobody with this panel's token. That last probe used to be a
 * bare /health — and under parallel load another process bound the freed real
 * port and answered it (#260). Any process may take a free port; what must
 * never answer is THIS panel, and only it knows this token.
 */
async function assertGaveBack(panel, port, real, token) {
  assert.equal(portTable.has(port), false, `port ${port} should have been given back`);
  for (const s of panel.servers) assert.equal(s.listening, false, "the panel's socket is still listening");
  const status = await fetch(`http://127.0.0.1:${real}/op`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ae-mcp-token": token },
    body: JSON.stringify({ op: "list_comps", args: {} }),
    signal: AbortSignal.timeout(2000),
  }).then((r) => r.status, () => "no answer");
  assert.notEqual(status, 200, "the panel still answers its own token after unloading");
}

await check("unloading frees the port, and removes only this panel's own port-file entry", async () => {
  const port = Number(walker.dom.nodes.port.textContent);
  const real = realPortOf(port);
  const token = fs.readFileSync(path.join(path.dirname(walker.portFile), `token-${port}`), "utf8").trim();
  // Another panel has written the file since; that entry is not ours to erase.
  fs.writeFileSync(walker.portFile, "1");
  walker.fire("unload");
  assert.equal(fs.readFileSync(walker.portFile, "utf8"), "1", "another panel's port-file entry was removed");
  await assertGaveBack(walker, port, real, token);
  walker.close();

  // And the survivor: its own entry goes with it.
  const own = Number(booted.dom.nodes.port.textContent);
  const ownReal = realPortOf(own);
  const ownToken = fs.readFileSync(path.join(path.dirname(booted.portFile), `token-${own}`), "utf8").trim();
  assert.equal(fs.readFileSync(booted.portFile, "utf8").trim(), String(own));
  booted.fire("unload");
  assert.equal(fs.existsSync(booted.portFile), false, "the port file must go with the panel that wrote it");
  await assertGaveBack(booted, own, ownReal, ownToken);
});

await check("a config with a bad key is tolerated: the bad key is named, the good one honoured", async () => {
  const p = bootPanel(dir, { config: { port: 0, allowPortWalk: "yes" } });
  try {
    const status = await settled(p.dom);
    assert.equal(status, "ready", `status: ${status}\n${logText(p.dom)}`);
    assert.match(logText(p.dom), /ignoring "allowPortWalk"/);
    assert.match(logText(p.dom), /read .*config\.json: port 0/);
  } finally { p.close(); }
});

console.log(`panel-boot: ${passed} checks passed`);
booted?.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
