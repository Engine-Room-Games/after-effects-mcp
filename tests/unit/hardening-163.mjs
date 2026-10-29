// Issue #163: a batch of small robustness fixes, each pinned here.
//
//   - the server exits when its stdin closes (an orphan otherwise lingers,
//     holding a WebSocket to the panel);
//   - a connection the panel accepted and then dropped (ECONNRESET) is its own
//     error, never "unreachable" — which runOp would re-send — and never a
//     timeout;
//   - a finished render settles promptly even when another write holds the
//     queue: the unticking gives up after a short wait and says so per item;
//   - the contact sheet's tile budget never runs past the sheet's deadline;
//   - the panel escapes U+2028/U+2029 before handing a payload to evalScript;
//   - /reload-jsx waits its turn on the evalScript chain.
//
// Nothing here asks port 7777: every bridge is a stub on an ephemeral port.
//
//   node tests/unit/hardening-163.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { BridgeAuthError, BridgeResetError, BridgeTimeoutError, BridgeUnreachableError, WriteQueueWaitError, isResetError, isUnsentError } =
  await import(dist("util", "errors.js"));
const { HttpClient } = await import(dist("bridge", "httpClient.js"));
const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));
const { markRendered } = await import(dist("render", "markDone.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`hardening-163 FAILED: ${name}`);
    throw e;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// stdin closing ends the server
// ---------------------------------------------------------------------------

await check("the server exits when its stdin closes", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "packages", "mcp-server", "dist", "index.js")], {
    env: { ...process.env, AE_MCP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  // Wait until it is serving, so this is not just a crash at boot.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`never started:\n${stderr}`)), 15000);
    child.stderr.on("data", () => {
      if (/MCP server running on stdio/.test(stderr)) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const { code, signal } = await exited;
  clearTimeout(timer);
  // Only that it ended on its own, quietly. The exit code is not asserted: it
  // ends by draining its event loop, and how a runtime reports that is not
  // what this pins.
  assert.equal(signal, null, `the server had to be killed — it outlived its stdin\n${stderr}`);
  void code;
  assert.equal(stdout, "", "nothing may be written to stdout on the way out");
  assert.match(stderr, /stdin closed/);
  assert.doesNotMatch(stderr, /holding the event loop open/, "it ended only through the last-resort exit, not by draining");
});

// ---------------------------------------------------------------------------
// A reset is not a refusal and not a timeout
// ---------------------------------------------------------------------------

// Accepts, reads the request, then destroys the socket without answering.
const resetter = http.createServer((req) => {
  req.on("data", () => {});
  req.on("end", () => req.socket.destroy());
});
await new Promise((r) => resetter.listen(0, "127.0.0.1", r));
const resetPort = resetter.address().port;
const seenElsewhere = [];
const elsewhere = http.createServer((req, res) => {
  seenElsewhere.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return void res.end(JSON.stringify({ ok: true, port: elsewhere.address().port, bundleLoaded: true }));
  res.end(JSON.stringify({ ok: true, result: {} }));
});
await new Promise((r) => elsewhere.listen(0, "127.0.0.1", r));

await check("a dropped connection is a BridgeResetError, and runOp does not re-send it anywhere", async () => {
  const client = new HttpClient(resetPort, { candidates: () => [elsewhere.address().port] });
  await assert.rejects(client.runOp("set_transform", {}), (e) => {
    assert.ok(e instanceof BridgeResetError, `expected BridgeResetError, got ${e?.constructor?.name}: ${e?.message}`);
    assert.ok(!(e instanceof BridgeUnreachableError));
    assert.match(e.message, /dropped the connection in the middle of `set_transform`/);
    assert.match(e.message, /Do not blindly re-send/);
    return true;
  });
  assert.deepEqual(seenElsewhere, [], "a call that may have run was looked for, or re-sent, elsewhere");
  assert.equal(client.port, resetPort);
});

await check("isResetError reads the code on the cause chain, never the text", () => {
  const wrapped = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  assert.equal(isResetError(wrapped), true);
  assert.equal(isResetError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(isResetError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })), false);
  assert.equal(isResetError(new Error("ECONNRESET in the text only")), false);
});

await check("a failed write (EPIPE) proves nothing ran, so it is unsent, not a reset", () => {
  const epipe = new TypeError("fetch failed", { cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) });
  assert.equal(isUnsentError(epipe), true);
  assert.equal(isResetError(epipe), false);
  const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  assert.equal(isUnsentError(reset), false, "a reset proves nothing about delivery");
});

await check("the reset message shares no line with the other four bridge failures", () => {
  const msg = BridgeResetError.message(7777, "set_layer", new Error("read ECONNRESET"));
  for (const [name, other] of [
    ["timeout", BridgeTimeoutError.message(7777, 120_000, { op: "set_layer" })],
    ["unreachable", BridgeUnreachableError.message(7777, new Error("connect ECONNREFUSED"))],
    ["auth", BridgeAuthError.message(7777, true)],
    ["write-queue wait", WriteQueueWaitError.message("set_layer", 30_000, "run_batch")],
  ]) {
    const shared = msg.split("\n").filter((l) => l.trim().length > 25 && other.includes(l));
    assert.deepEqual(shared, [], `reset and ${name} share lines: ${shared.join(" / ")}`);
  }
  // Neither "not running" (a refusal's story) nor "still running" (a timeout's).
  assert.doesNotMatch(msg, /setup_panel|did not answer within|write queue/i);
});

resetter.close();
elsewhere.close();

// ---------------------------------------------------------------------------
// Render completion does not wait on the write queue
// ---------------------------------------------------------------------------

const item = { index: 3, compId: 9, compName: "Main", status: "", frames: 4, outputs: [{ path: "/tmp/x.mov" }] };

await check("with the queue free, the items are unticked in one call", async () => {
  const writes = new WriteQueue({ maxWaitMs: 60_000 });
  const calls = [];
  const answers = await markRendered(writes, async (op, a) => {
    calls.push([op, a]);
    return { results: [{ index: 3, marked: true }] };
  }, [item], 200);
  assert.deepEqual(answers, [{ index: 3, marked: true }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "_render_mark_done");
  assert.equal(writes.held, null, "the lease was released");
});

await check("with another write holding the queue, it answers within its own short wait and says why", async () => {
  const writes = new WriteQueue({ maxWaitMs: 60_000 });
  const lease = await writes.acquire("run_batch");
  let called = false;
  const t0 = Date.now();
  const answers = await markRendered(writes, async () => { called = true; return { results: [] }; }, [item], 150);
  const took = Date.now() - t0;
  lease.release();
  assert.ok(took < 2000, `waited ${took}ms — the queue's own ceiling, not the short one`);
  assert.equal(called, false, "nothing may reach After Effects without the lease");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].marked, false);
  assert.match(answers[0].reason, /`run_batch` was writing to the project/);
  assert.match(answers[0].reason, /renders again/);
  assert.equal(writes.held, null);
  assert.equal(writes.depth, 0, "the abandoned wait left nothing queued");
});

// ---------------------------------------------------------------------------
// The contact sheet's deadline
// ---------------------------------------------------------------------------

await check("a contact-sheet tile never waits past the sheet's deadline", () => {
  const cs = nodeRequire(path.join(root, "packages", "ae-panel", "client", "contactsheet.js"));
  const fr = nodeRequire(path.join(root, "packages", "ae-panel", "client", "framereader.js"));
  assert.ok(cs.CONTACT_SHEET_BUDGET_MS < 300_000, "the sheet's limit must sit under the server's 300s for screenshot_frame");
  const per = fr.FRAME_RENDER_BUDGET_MS;
  const now = 1_000_000;
  assert.equal(cs.tileBudgetMs(now + cs.CONTACT_SHEET_BUDGET_MS, now, per), per, "early on, a tile gets the full per-frame budget");
  assert.equal(cs.tileBudgetMs(now + 30_000, now, per), 30_000, "late on, only what is left");
  assert.equal(cs.tileBudgetMs(now + 500, now, per), 0, "too little left: do not start it");
  assert.equal(cs.tileBudgetMs(now - 1, now, per), 0);
  // Six worst-case tiles, each read and re-read with what is left, end inside the limit.
  let clock = now;
  const deadline = now + cs.CONTACT_SHEET_BUDGET_MS;
  for (let i = 0; i < 12; i++) clock += cs.tileBudgetMs(deadline, clock, per);
  assert.ok(clock <= deadline);
});

// ---------------------------------------------------------------------------
// The panel: U+2028/U+2029, and /reload-jsx on the chain
// ---------------------------------------------------------------------------

const panelSrc = path.join(root, "packages", "ae-panel");

function installLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-163-panel-"));
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jsx"), { recursive: true });
  for (const f of fs.readdirSync(path.join(panelSrc, "client"))) {
    fs.copyFileSync(path.join(panelSrc, "client", f), path.join(dir, "client", f));
  }
  fs.copyFileSync(path.join(panelSrc, "jsx", "bundle.jsx"), path.join(dir, "jsx", "bundle.jsx"));
  fs.copyFileSync(path.join(panelSrc, "package.json"), path.join(dir, "package.json"));
  return dir;
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

/**
 * A host that records every script, evaluates op scripts against a stub
 * `__AEMCP` in a fresh context (so a literal broken by U+2028 really fails to
 * parse), and holds any op named `slow` for `holdMs`.
 */
function makeHost(extDir, events) {
  return {
    getSystemPath: () => extDir,
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "26.3" }),
    evalScript: (script, cb) => {
      if (script.indexOf("$.evalFile") >= 0) {
        events.push("reload:start");
        return void setTimeout(() => { events.push("reload:end"); cb("ok"); }, 0);
      }
      // V8 accepts a raw U+2028 inside a string literal (ES2019); ExtendScript,
      // being ES3, does not. So the script itself is checked, not just parsed.
      if (/[\u2028\u2029]/.test(script)) events.push("raw-separator");
      let out;
      let op = null;
      try {
        // The bundle's one global, as #192 shaped it: the panel checks its id
        // and calls `call` with the JSON payload, which answers JSON text.
        const ctx = vm.createContext({
          JSON,
          __AEMCP: {
            id: "games.engine-room.ae-mcp",
            call: (payload) => {
              const req = JSON.parse(payload);
              op = req.op;
              return JSON.stringify({ ok: true, result: { echoed: req.args } });
            },
          },
        });
        out = vm.runInContext(script, ctx);
      } catch (e) {
        events.push(`syntax:${e.name}`);
        return void setTimeout(() => cb("EvalScript error."), 0);
      }
      events.push(`op:${op}:start`);
      const hold = op === "slow" ? 300 : 0;
      setTimeout(() => { events.push(`op:${op}:end`); cb(out); }, hold);
    },
  };
}

function bootPanel(extDir, events) {
  const source = fs.readFileSync(path.join(extDir, "client", "main.js"), "utf8");
  const csSource = fs.readFileSync(path.join(extDir, "client", "csinterface.js"), "utf8");
  const dom = makeDom();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ae-163-home-"));
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
    window: { __adobe_cep__: makeHost(extDir, events), addEventListener: () => {} },
    require: (id) => {
      if (id === "os") return { ...realOs, homedir: () => fakeHome };
      if (id === "http") {
        return { ...realHttp, createServer: (...a) => { const s = realHttp.createServer(...a); servers.push(s); return s; } };
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

async function settled(dom, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = dom.nodes.status.textContent;
    if (s === "ready" || s === "failed" || s.indexOf("cannot start") === 0) return s;
    if (Date.now() > deadline) throw new Error(`panel never settled; stuck at "${s}"`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const events = [];
const dir = installLayout();
const panel = bootPanel(dir, events);
try {
  assert.equal(await settled(panel.dom), "ready");
  const PORT = Number(panel.dom.nodes.port.textContent);
  const token = fs.readFileSync(path.join(panel.configDir, `token-${PORT}`), "utf8").trim();
  const post = (url, body) =>
    fetch(`http://127.0.0.1:${PORT}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ae-mcp-token": token },
      body: JSON.stringify(body ?? {}),
    });

  await check("a payload containing U+2028 and U+2029 reaches __AEMCP.call intact", async () => {
    const text = "line one line two end";
    const r = await post("/op", { op: "set_text", args: { text } });
    const body = await r.json();
    assert.equal(body.ok, true, `the op failed: ${JSON.stringify(body)} — events ${events.join(", ")}`);
    assert.equal(body.result.echoed.text, text, "the characters did not survive the trip");
    assert.ok(!events.some((e) => e.startsWith("syntax:")), `a script failed to parse: ${events.join(", ")}`);
    assert.ok(!events.includes("raw-separator"), "a raw line separator reached the ES3 string literal");
  });

  await check("/reload-jsx waits for the op already on the evalScript chain", async () => {
    events.length = 0;
    const slow = post("/op", { op: "slow", args: {} });
    // Let the slow op reach the host before the reload is asked for.
    for (let i = 0; i < 100 && !events.includes("op:slow:start"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(events.includes("op:slow:start"));
    const reload = post("/reload-jsx");
    const [a, b] = await Promise.all([slow, reload]);
    assert.equal((await a.json()).ok, true);
    assert.equal((await b.json()).ok, true);
    assert.ok(
      events.indexOf("reload:start") > events.indexOf("op:slow:end"),
      `the reload ran inside the op: ${events.join(", ")}`
    );
  });
} finally {
  panel.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`hardening-163: ${passed} checks passed`);
