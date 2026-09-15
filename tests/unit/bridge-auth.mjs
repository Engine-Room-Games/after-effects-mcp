// The bridge refuses anyone who is not the MCP server.
//
// Issue #106, reported by a designer who read the panel before installing it.
// The bridge is a plain HTTP server on 127.0.0.1, `/op` reaches `run_jsx`, and
// `run_jsx` is an unrestricted `eval` inside After Effects — with no token, any
// web page the user had open could drive their project, and ExtendScript's
// `File`/`Folder` and `system.callSystem` mean "their project" understates it.
//
// The thing that makes this reachable rather than theoretical is worth writing
// down, because it is what the first fix everyone proposes gets wrong. Dropping
// `Access-Control-Allow-Origin: *` is NOT sufficient: a POST with
// `content-type: text/plain` is a CORS *simple request*, so no preflight is
// sent, the browser delivers it, and the panel — which never looked at
// content-type — parses the body as JSON and runs the op. The page cannot read
// the reply, and does not need to. Only a secret the page cannot obtain closes
// it, and a file is exactly that: script in a browser cannot read one.
//
// So this pins both halves:
//   - the token gate itself, on every route that reaches After Effects;
//   - the text/plain no-preflight shape specifically, because that is the
//     attack, and a future refactor that gates on content-type instead would
//     pass every other test in this file.
//
//   node tests/unit/bridge-auth.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const panelSrc = path.join(root, "packages", "ae-panel");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { BridgeAuthError, BridgeTimeoutError, BridgeUnreachableError, WriteQueueWaitError } = await import(dist("util", "errors.js"));
const { authHeaders, panelToken, tokenFilePath } = await import(dist("bridge", "discovery.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { buildNextSteps } = await import(dist("setup", "check.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`bridge-auth FAILED: ${name}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The same stub CEP host the other panel tests use.
// ---------------------------------------------------------------------------
function makeHost(extDir) {
  return {
    getSystemPath: () => extDir,
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "26.3" }),
    evalScript: (script, cb) => {
      if (script.indexOf("$.evalFile") >= 0) return void setTimeout(() => cb("ok"), 0);
      setTimeout(() => cb(JSON.stringify({ ok: true, result: { stub: true } })), 0);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-auth-panel-"));
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jsx"), { recursive: true });
  for (const f of fs.readdirSync(path.join(panelSrc, "client"))) {
    fs.copyFileSync(path.join(panelSrc, "client", f), path.join(dir, "client", f));
  }
  fs.copyFileSync(path.join(panelSrc, "jsx", "bundle.jsx"), path.join(dir, "jsx", "bundle.jsx"));
  fs.copyFileSync(path.join(panelSrc, "package.json"), path.join(dir, "package.json"));
  return dir;
}

/**
 * Boot the real main.js against a fake home and an ephemeral port.
 *
 * Never 7777: on the machine this is developed on a real panel holds it, and
 * since #92 a panel finding one of its own there waits rather than walking —
 * a test panel would wait for ever. Same arrangement as panel-boot.mjs.
 */
function bootPanel(extDir) {
  const source = fs.readFileSync(path.join(extDir, "client", "main.js"), "utf8");
  const csSource = fs.readFileSync(path.join(extDir, "client", "csinterface.js"), "utf8");
  const dom = makeDom();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-auth-home-"));
  const configDir = path.join(fakeHome, ".engineroom-ae-mcp");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ port: 0 }));
  const realOs = nodeRequire("node:os");
  const realHttp = nodeRequire("node:http");
  const servers = [];
  const listeners = {};
  const sandbox = {
    console,
    Promise, Date, Math, JSON, Error, Buffer, String, Number, Array, Object, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: extDir,
    __filename: path.join(extDir, "main.js"),
    document: dom.document,
    window: {
      __adobe_cep__: makeHost(extDir),
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    },
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
  const fire = (type) => { for (const fn of listeners[type] ?? []) fn(); };
  return { dom, close, fire, fakeHome, configDir };
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

const logText = (dom) => dom.nodes.log.childNodes.map((n) => n.textContent).join("\n");

// ---------------------------------------------------------------------------
// Boot one panel; everything below talks to it.
// ---------------------------------------------------------------------------
const dir = installLayout();
const panel = bootPanel(dir);
const status = await settled(panel.dom);
assert.equal(status, "ready", `panel did not boot: ${status}\n${logText(panel.dom)}`);
const PORT = Number(panel.dom.nodes.port.textContent);
assert.ok(PORT > 0, "no port announced");
const TOKEN_FILE = path.join(panel.configDir, `token-${PORT}`);

const post = (body, headers = {}) =>
  fetch(`http://127.0.0.1:${PORT}/op`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// The token file
// ---------------------------------------------------------------------------

await check("the panel writes its token beside the port file, named for the bound port", () => {
  assert.ok(fs.existsSync(TOKEN_FILE), `no token file at ${TOKEN_FILE}\n${logText(panel.dom)}`);
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  // 32 random bytes as hex. Short enough to read in a log, far past guessing.
  assert.match(token, /^[0-9a-f]{64}$/, `token is not 32 hex-encoded random bytes: ${token}`);
});

await check("the token file is private to the user", function () {
  if (process.platform === "win32") return; // POSIX modes mean nothing here.
  const mode = fs.statSync(TOKEN_FILE).mode & 0o777;
  assert.equal(mode, 0o600, `token file is mode ${mode.toString(8)}, not 600 — a home directory is not private on a shared machine`);
});

await check("the server looks for the token where the panel writes it", () => {
  // The one assertion that keeps two files in step: the panel builds the path
  // from `portDir`, the server from `tokenFilePath`, and nothing else would
  // notice if they drifted apart. HOME is faked to match the panel's.
  const realHome = process.env.HOME;
  try {
    process.env.HOME = panel.fakeHome;
    assert.equal(tokenFilePath(PORT), TOKEN_FILE);
    assert.equal(panelToken(PORT), fs.readFileSync(TOKEN_FILE, "utf8").trim());
    assert.deepEqual(authHeaders(PORT), { "x-ae-mcp-token": panelToken(PORT) });
  } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  }
});

await check("no token file for a port means no header, rather than an invented one", () => {
  assert.equal(panelToken(PORT + 1), null);
  assert.deepEqual(authHeaders(PORT + 1), {});
});

const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
const auth = { "x-ae-mcp-token": TOKEN };

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

await check("/op with the token runs the op", async () => {
  const res = await post({ op: "list_comps", args: {} }, auth);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

await check("/op with no token is refused, and says what to do about it", async () => {
  const res = await post({ op: "list_comps", args: {} });
  assert.equal(res.status, 403, "an unauthenticated op must be refused");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "bridge_unauthorized");
  // This text is read by an MCP server too OLD to know what a bridge token is:
  // it relays `error` to its agent verbatim, so the remedy has to be in here.
  assert.match(body.error, /Nothing was run in After Effects/);
  assert.match(body.error, /update after-effects-mcp/i);
  assert.match(body.error, /issue #106/);
});

await check("/op with a wrong token of the right length is refused", async () => {
  const res = await post({ op: "list_comps", args: {} }, { "x-ae-mcp-token": "f".repeat(TOKEN.length) });
  assert.equal(res.status, 403);
});

await check("THE ATTACK: a text/plain POST — no preflight, no CORS permission — is refused", async () => {
  // The whole reason a token was needed rather than just dropping the CORS
  // header. `content-type: text/plain` makes this a simple request: the browser
  // sends it with no preflight to fail, and the page never needs to read the
  // reply for the JSX to have run. The panel does not look at content-type, by
  // design — it must be the token that stops this, and nothing else.
  const res = await fetch(`http://127.0.0.1:${PORT}/op`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ op: "run_jsx", args: { code: "1+1" } }),
  });
  assert.equal(res.status, 403, "a no-preflight simple request reached After Effects");
});

await check("an Origin header is refused even when the token is right", async () => {
  // Depth, not the main lock. Browsers attach Origin to every cross-origin
  // request and cannot be talked out of it; Node's fetch and `ws` send none. So
  // a request carrying one is from a web page by definition, and no web page
  // has business here however it came by a token.
  const res = await post({ op: "list_comps", args: {} }, { ...auth, origin: "https://evil.example" });
  assert.equal(res.status, 403, "a browser-originated call was accepted");
});

await check("/cancel and /reload-jsx are gated too — every route that reaches AE is", async () => {
  for (const route of ["/cancel", "/reload-jsx"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "x" }),
    });
    assert.equal(res.status, 403, `${route} is not authenticated`);
  }
});

await check("no response carries CORS headers — not /health, not even the refusal", async () => {
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  const refused = await post({ op: "list_comps", args: {} });
  const ok = await post({ op: "list_comps", args: {} }, auth);
  for (const [what, res] of [["/health", health], ["a refusal", refused], ["a success", ok]]) {
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      `${what} still grants a web page permission to read it`,
    );
  }
});

await check("/health stays open, and says it authenticates", async () => {
  // Unauthenticated on purpose: discovery asks it before it knows which panel
  // is there, and a second panel asks it to find out who holds its port (#92).
  // It says nothing a page could use — and `auth: true` is what lets
  // check_setup tell "needs a token" from "too old to want one".
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.auth, true, "/health must advertise the token gate");
  assert.equal(Object.keys(body).some((k) => /token/i.test(k)), false, "/health must never carry the token itself");
});

// ---------------------------------------------------------------------------
// The WebSocket, which the same-origin policy does not protect at all
// ---------------------------------------------------------------------------

function tryWs(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`, { headers });
    const done = (r) => { try { ws.close(); } catch {} resolve(r); };
    ws.on("open", () => done("open"));
    ws.on("error", (e) => done(`error: ${e.message}`));
    setTimeout(() => done("timeout"), 4000);
  });
}

await check("/events refuses a socket with no token", async () => {
  const r = await tryWs({});
  assert.match(r, /^error/, `an unauthenticated /events socket was accepted (${r})`);
  assert.match(r, /403/, `refusal should be a 403 (${r})`);
});

await check("/events refuses a socket from a web page", async () => {
  const r = await tryWs({ ...auth, origin: "https://evil.example" });
  assert.match(r, /^error/, `a browser-originated /events socket was accepted (${r})`);
});

await check("/events accepts the MCP server", async () => {
  assert.equal(await tryWs(auth), "open");
});

// ---------------------------------------------------------------------------
// The server's half: a refusal is its own diagnosis
// ---------------------------------------------------------------------------

await check("HttpClient sends the token and the op succeeds", async () => {
  const realHome = process.env.HOME;
  try {
    process.env.HOME = panel.fakeHome;
    const client = new HttpClient(PORT, { candidates: () => [PORT] });
    assert.deepEqual(await client.runOp("list_comps", {}), { stub: true });
  } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  }
});

await check("a refusal raises BridgeAuthError, never an After Effects error", async () => {
  // HOME left alone, so no token file is found for this port: the shape of an
  // MCP server that cannot see what the panel wrote.
  const client = new HttpClient(PORT, { candidates: () => [PORT] });
  await assert.rejects(
    () => client.runOp("list_comps", {}),
    (e) => {
      assert.ok(e instanceof BridgeAuthError, `expected BridgeAuthError, got ${e.name}`);
      assert.equal(e.sentToken, false, "should record that it had no token to send");
      return true;
    },
  );
});

await check("the refusal is not retried as a port drift", async () => {
  // `runOp` re-discovers on a *refused connection*, which is a different thing
  // from a connection that answered with a refusal. Re-sending this would only
  // be refused again — and the message would then blame the wrong port.
  const client = new HttpClient(PORT, {
    candidates: () => { throw new Error("rediscovery must not run for an auth refusal"); },
  });
  await assert.rejects(() => client.runOp("list_comps", {}), (e) => e instanceof BridgeAuthError);
});

await check("the two auth remedies point in opposite directions", () => {
  const noToken = BridgeAuthError.message(PORT, false);
  const badToken = BridgeAuthError.message(PORT, true);
  // Nothing sent: the server cannot see the file — look at where it is written.
  assert.match(noToken, /found no token file/);
  assert.match(noToken, /different user|sandboxed/);
  assert.doesNotMatch(noToken, /Quit After Effects completely and reopen it/);
  // Sent and rejected: the file belongs to a panel that has gone — restart AE.
  assert.match(badToken, /Quit After Effects completely and reopen it/);
  assert.match(badToken, /CEPHtmlEngine/);
});

await check("the fourth bridge failure does not borrow the other three's remedies", () => {
  // The rule in CLAUDE.md: timeout forbids re-sending, unreachable sends the
  // reader to check_setup, write-queue-wait asks for a re-send. This one is
  // none of those, and must not be mistakable for them.
  const msg = BridgeAuthError.message(PORT, false);
  assert.match(msg, /not a lost connection and not a busy bridge/);
  assert.match(msg, /nothing in the project changed/);
  assert.match(msg, /Do NOT re-send this call until the cause is fixed/);
  assert.match(msg, /setup_panel does not help/);
  // And it is genuinely distinct text, not a near-copy of a neighbour's.
  for (const [name, other] of [
    ["timeout", BridgeTimeoutError.message(PORT, 120_000, { op: "list_comps" })],
    ["unreachable", BridgeUnreachableError.message(PORT)],
    ["write-queue wait", WriteQueueWaitError.message("set_layer", 30_000, "run_batch")],
  ]) {
    const shared = msg.split("\n").filter((l) => l.trim().length > 25 && other.includes(l));
    assert.deepEqual(shared, [], `auth and ${name} share lines: ${shared.join(" / ")}`);
  }
});

await check("check_setup names a missing token as the reason, and forbids the usual remedies", () => {
  const checks = [
    { name: "bridgeReachable", ok: true, detail: `responding on port ${PORT}` },
    {
      name: "bridgeToken",
      ok: false,
      detail: `the panel on port ${PORT} requires a token and none is readable at ${TOKEN_FILE}`,
      fix: "Every tool call will be refused until this is resolved, and the panel itself is fine.",
    },
  ];
  const steps = buildNextSteps(checks, false).join("\n");
  assert.match(steps, /Do not restart After Effects/);
  assert.match(steps, /do not run setup_panel/i);
  assert.match(steps, new RegExp(`token-${PORT}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(steps, /nothing in the user's project is being changed/);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

await check("a second panel session mints a different token", async () => {
  const other = bootPanel(dir);
  try {
    assert.equal(await settled(other.dom), "ready", logText(other.dom));
    const otherPort = Number(other.dom.nodes.port.textContent);
    const otherToken = fs.readFileSync(path.join(other.configDir, `token-${otherPort}`), "utf8").trim();
    assert.notEqual(otherToken, TOKEN, "two panel sessions share a token — one is not random");
  } finally {
    other.close();
  }
});

await check("the panel takes its token with it when it unloads", () => {
  // Same rule as the port file: a file left behind names a secret for a socket
  // that no longer exists, and the next panel on that port mints its own.
  panel.fire("unload");
  assert.equal(fs.existsSync(TOKEN_FILE), false, "the token file outlived the panel that issued it");
});

panel.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`bridge-auth: ${passed} checks passed`);
