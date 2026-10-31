// A call made while After Effects is still on one that timed out.
//
// When the user holds After Effects — an open menu, a modal dialog, a text
// layer being typed into, a RAM preview, their own render — or a long script
// does, every call sent meanwhile used to wait its own full limit (120 s by
// default) behind the stuck one, and then still ran once After Effects freed
// up: late, out of order, after the agent had been told it timed out. Now the
// first call after a timeout re-checks /health once, quickly, and is refused
// unsent if After Effects is still busy.
//
// Pinned here, against a real HTTP server standing in for the panel:
//   - the refusal comes in well under the op limit and sends nothing;
//   - it is the not-sent kind (a WriteQueueWaitError), never a timeout or an
//     unreachable (runOp re-sends those), and survives the front desk's wire;
//   - an idle /health, or a script that started after the stuck call gave up,
//     lets the next call through and drops the record;
//   - with nothing timed out, no probe is made at all;
//   - its words are its own (the five bridge failures share no sentence).
//
//   node tests/unit/busy-guard.mjs

import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The client reads the bridge token from ~/.engineroom-ae-mcp; keep it off the real one.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ae-busy-guard-home-"));
process.env.USERPROFILE = process.env.HOME;
process.env.AE_MCP_OP_TIMEOUT_MS = "300";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const {
  AeBusyError, AeError, BridgeAuthError, BridgeResetError, BridgeTimeoutError, BridgeUnreachableError,
  WriteQueueWaitError, EVAL_REFUSED_CODE,
} = await import(dist("util", "errors.js"));
const { HttpClient, BUSY_PROBE_MS } = await import(dist("bridge", "httpClient.js"));
const { toWire, fromWire } = await import(dist("frontdesk", "protocol.js"));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`busy-guard FAILED: ${name}`);
    throw e;
  }
}

/** A stand-in panel: `/op` for "hold" never answers; /health does what `health` says. */
function fakePanel() {
  const state = {
    ops: [],
    healthHits: 0,
    // "hang" | "idle" | { op, ms } (evalBusy)
    health: "idle",
    answer: (op) => ({ ok: true, result: { op } }),
  };
  const held = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      state.healthHits++;
      if (state.health === "hang") { held.push(res); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true, port: 0, bundleLoaded: true, bundleHash: "x",
        evalBusy: state.health === "idle" ? null : state.health,
      }));
      return;
    }
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(bufs).toString("utf8"));
      state.ops.push(body.op);
      if (body.op === "hold") { held.push(res); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.answer(body.op)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        port: server.address().port,
        close: () => {
          for (const r of held) { try { r.destroy(); } catch {} }
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

async function timedOut(client) {
  await assert.rejects(client.runOp("hold", {}), (e) => e instanceof BridgeTimeoutError);
  assert.ok(client.stuckCall(), "a timed-out call is kept on record");
}

const panel = await fakePanel();
const client = () => new HttpClient(panel.port, { candidates: () => [panel.port] });

try {
  await check("with nothing timed out, a call is sent without any probe", async () => {
    const c = client();
    const before = panel.state.healthHits;
    assert.deepEqual(await c.runOp("list_comps", {}), { op: "list_comps" });
    assert.equal(panel.state.healthHits, before, "no /health asked");
  });

  await check("behind a stuck call that /health cannot answer, the next call is refused fast and unsent", async () => {
    const c = client();
    await timedOut(c);
    panel.state.health = "hang";
    const sent = panel.state.ops.length;
    const t0 = Date.now();
    let err;
    try { await c.runOp("create_null_layer", { compId: 1 }); } catch (e) { err = e; }
    const took = Date.now() - t0;
    assert.ok(err instanceof AeBusyError, `expected AeBusyError, got ${err?.name}: ${err?.message}`);
    assert.ok(err instanceof WriteQueueWaitError, "the not-sent kind: re-sending is safe");
    assert.ok(!(err instanceof BridgeUnreachableError), "never unreachable: runOp re-sends those");
    assert.ok(!(err instanceof BridgeTimeoutError));
    assert.ok(took < BUSY_PROBE_MS + 1000, `refused after ${took}ms — it waited as if sent`);
    assert.equal(panel.state.ops.length, sent, "nothing reached the panel");
    assert.equal(err.evidence.kind, "silent");
    assert.match(err.message, /^`create_null_layer` was not sent: After Effects is still busy/);
    assert.match(err.message, /This server's `hold` call/);
    assert.match(err.message, /sending it again is\s+safe/);
    assert.match(err.message, /open\s+menu/);
    assert.match(err.message, /RAM preview/);
    assert.match(err.message, /finish or close/);

    // A second call right after needs no second probe: the silence is recent.
    const hits = panel.state.healthHits;
    const t1 = Date.now();
    await assert.rejects(c.runOp("set_layer", {}), (e) => e instanceof AeBusyError);
    assert.ok(Date.now() - t1 < 300, "answered from the probe just made");
    assert.equal(panel.state.healthHits, hits);
    assert.equal(panel.state.ops.length, sent);
  });

  await check("a panel that answers /health but is still on the script is busy too", async () => {
    const c = client();
    await timedOut(c);
    panel.state.health = { op: "hold", ms: 60_000 };
    const sent = panel.state.ops.length;
    await assert.rejects(c.runOp("set_layer", {}), (e) => {
      assert.ok(e instanceof AeBusyError, e.message);
      assert.equal(e.evidence.kind, "running");
      assert.match(e.message, /has still not finished the script it is on \(`hold`/);
      return true;
    });
    assert.equal(panel.state.ops.length, sent);
  });

  await check("a script that started after the stuck call gave up is ordinary work: the call goes out", async () => {
    const c = client();
    await timedOut(c);
    await new Promise((r) => setTimeout(r, 400));
    panel.state.health = { op: "run_jsx", ms: 10 };
    assert.deepEqual(await c.runOp("list_layers", {}), { op: "list_layers" });
    assert.equal(c.stuckCall(), null);
  });

  await check("once /health answers idle, the record is dropped and the call is sent", async () => {
    const c = client();
    await timedOut(c);
    panel.state.health = "idle";
    assert.deepEqual(await c.runOp("list_comps", {}), { op: "list_comps" });
    assert.equal(c.stuckCall(), null);
    const hits = panel.state.healthHits;
    await c.runOp("list_comps", {});
    assert.equal(panel.state.healthHits, hits, "no probe once the record is gone");
  });

  await check("the gate's own /health answering idle clears the record too", async () => {
    const c = client();
    await timedOut(c);
    panel.state.health = "idle";
    await c.health();
    assert.equal(c.stuckCall(), null);
  });

  await check("the refusal crosses the front desk as the same class with the same words", () => {
    const e = new AeBusyError("set_layer", { op: "run_jsx", sentAgoMs: 130_000, timedOutAgoMs: 10_000, limitMs: 120_000 }, { kind: "silent", probeMs: 1500 });
    const back = fromWire(JSON.parse(JSON.stringify(toWire(e))));
    assert.ok(back instanceof AeBusyError);
    assert.ok(back instanceof WriteQueueWaitError);
    assert.equal(back.message, e.message);
  });

  await check("its sentences are its own: none shared with the timeout, unreachable, auth or reset", () => {
    const busy = new AeBusyError("set_layer", { op: "run_jsx", sentAgoMs: 130_000, timedOutAgoMs: 10_000, limitMs: 120_000 }, { kind: "silent", probeMs: 1500 }).message;
    assert.doesNotMatch(busy, /Do not re-send/i);
    assert.doesNotMatch(busy, /Cannot reach the After Effects panel at/);
    assert.doesNotMatch(busy, /did not answer within/);
    assert.doesNotMatch(busy, /setup_panel/);
    for (const [name, other] of [
      ["timeout", BridgeTimeoutError.message(7777, 120_000, { op: "run_jsx" })],
      ["unreachable", BridgeUnreachableError.message(7777)],
      ["auth", BridgeAuthError.message(7777, true)],
      ["reset", BridgeResetError.message(7777, "run_jsx")],
      ["write-queue wait", WriteQueueWaitError.message("set_layer", 30_000, "run_batch")],
    ]) {
      const shared = busy.split("\n").filter((l) => l.trim().length > 25 && other.includes(l.trim()));
      assert.deepEqual(shared, [], `busy and ${name} share lines: ${shared.join(" / ")}`);
    }
  });

  await check("\"EvalScript error.\" is reported as After Effects refusing, not as a script fault", async () => {
    const c = client();
    panel.state.health = "idle";
    panel.state.answer = () => ({ ok: false, error: "panel text", code: EVAL_REFUSED_CODE });
    try {
      await assert.rejects(c.runOp("set_text", {}), (e) => {
        assert.ok(e instanceof AeError);
        assert.equal(e.code, EVAL_REFUSED_CODE, "keeps its code, so it is presented without an AE: prefix");
        assert.match(e.message, /After Effects refused to run `set_text`/);
        assert.match(e.message, /not an error in the script/);
        assert.match(e.message, /very probably did not run/);
        assert.match(e.message, /read back/);
        assert.doesNotMatch(e.message, /syntax or runtime/);
        return true;
      });
    } finally {
      panel.state.answer = (op) => ({ ok: true, result: { op } });
    }
  });
} finally {
  panel.close();
  fs.rmSync(process.env.HOME, { recursive: true, force: true });
}

console.log(`busy-guard: ${passed} checks passed`);
