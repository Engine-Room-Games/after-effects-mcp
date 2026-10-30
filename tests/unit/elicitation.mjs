// Confirmations through MCP elicitation (issue #245).
//
// delete_comp, purge_unused_footage and revert_comp ask the person first — and
// only when the client advertised `elicitation`. Pinned here, through the real
// MCP server over an in-memory transport against a stub bridge:
//
// - a client WITHOUT the capability gets today's behaviour exactly: no prompt,
//   no pre-read, the op forwarded as it came;
// - with it, accept forwards the op (with any choice folded in), and decline /
//   cancel / the call being cancelled forward nothing and say nothing changed;
// - the prompt names what it is about (the comp's name, the purge's count);
// - nothing is asked when there is nothing to ask (a dry run, an empty purge),
//   but a purge is still re-checked under the lease;
// - a batch with any of the three among its steps asks once, up front;
// - this session's later writes wait behind a pending confirmation (order is
//   kept); reads do not; the prompt gives up before a queued write would;
// - a timeout is a refusal, and only a client answering "method not found"
//   falls back to today's behaviour — never on the client's message text.
//
//   node tests/unit/elicitation.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

// The front-desk check below elects a desk, which writes a file in the home
// folder; never the real one.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-elicit-"));
process.env.USERPROFILE = process.env.HOME;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));

// ---------------------------------------------------------------------------
// Stub bridge. Never port 7777 — a real panel may hold that on this machine.
// ---------------------------------------------------------------------------

/** Every op the stub saw, with its args. */
const seen = [];
const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { op, args } = JSON.parse(body || "{}");
    seen.push({ op, args });
    if (op === "get_comp" && args.compId === 666) await new Promise((r) => setTimeout(r, 1000));
    if (op === "delete_comp" && args.compId === 777) await new Promise((r) => setTimeout(r, 1500));
    if (op === "set_comp" && args.compId === 99) await new Promise((r) => setTimeout(r, 1000));
    let result = { ok: true, op };
    if (op === "get_comp") result = { id: args.compId, name: "Hero Title" };
    if (op === "purge_unused_footage" && args.dryRun) {
      dryRuns++;
      result = stubPurgeEmpty || (purgeEmptyThenOne && dryRuns === 1)
        ? { solidsOnly: true, scanned: 2, inUse: 2, dryRun: true, wouldRemove: [], wouldRemoveCount: 0 }
        : {
            solidsOnly: true, scanned: 3, inUse: 1, dryRun: true,
            wouldRemove: [{ id: 7, name: "Black Solid 1", kind: "solid" }, { id: 8, name: "Red Solid 2", kind: "solid" }]
              .concat(dryRuns > 1 && purgeGrows ? [{ id: 9, name: "Blue Solid 3", kind: "solid" }] : []),
            wouldRemoveCount: dryRuns > 1 && purgeGrows ? 3 : 2,
          };
    }
    if (op === "list_checkpoints") {
      result = { checkpoints: [{ checkpointId: 50, compId: 10, compName: "Hero Title", label: "before easing", createdAt: "2026-10-30 10:00" }], count: 1 };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
});
let stubPurgeEmpty = false;
/** When set, the second dry run of a call finds one more unused solid than the first. */
let purgeGrows = false;
/** When set, the first dry run of a call finds nothing and the second finds two solids. */
let purgeEmptyThenOne = false;
let dryRuns = 0;
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { WriteQueue } = await import(dist("bridge", "writeQueue.js"));
const { confirmWithUser, notRunMessage, cannotElicit, confirmTimeoutMs, CONFIRMED_OPS } = await import(dist("tools", "confirm.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { ElicitRequestSchema, McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

/** A connected pair; `answer(params)` is the person, when the client can ask one. */
async function connect(capabilities, answer, opts = {}) {
  const server = createServer(opts);
  const client = new Client({ name: "elicitation-test", version: "0" }, { capabilities });
  if (answer) client.setRequestHandler(ElicitRequestSchema, (req) => answer(req.params));
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { server, client };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const text = (res) => res.content.map((c) => c.text).join("\n");
const ops = () => seen.map((s) => s.op);

// ---------------------------------------------------------------------------
// Without the capability: exactly today.
// ---------------------------------------------------------------------------

const plain = await connect({}, null);

await check("no capability: delete_comp is forwarded at once, with no pre-read", async () => {
  seen.length = 0;
  const res = await plain.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(ops(), ["delete_comp"]);
  assert.deepEqual(seen[0].args, { compId: 10 });
});

await check("no capability: a batch with a delete_comp step is forwarded at once", async () => {
  seen.length = 0;
  const res = await plain.client.callTool({ name: "run_batch", arguments: { ops: [{ op: "delete_comp", args: { compId: 10 } }] } });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(ops(), ["run_batch"]);
});

await check("no capability: purge_unused_footage and revert_comp likewise", async () => {
  seen.length = 0;
  await plain.client.callTool({ name: "purge_unused_footage", arguments: {} });
  await plain.client.callTool({ name: "revert_comp", arguments: { checkpointId: 50 } });
  assert.deepEqual(ops(), ["purge_unused_footage", "revert_comp"]);
  assert.equal(seen[0].args.dryRun, undefined, "no dry run was invented");
  assert.equal(seen[1].args.saveCurrent, undefined, "no choice was invented");
});

// ---------------------------------------------------------------------------
// With it.
// ---------------------------------------------------------------------------

let reply = { action: "accept", content: {} };
const prompts = [];
let hold = null; // when set, the person takes this long
const asked = await connect({ elicitation: {} }, async (params) => {
  prompts.push(params);
  if (hold) await hold;
  return typeof reply === "function" ? reply(params) : reply;
});

await check("accept: delete_comp asks, naming the comp, then runs", async () => {
  seen.length = 0;
  prompts.length = 0;
  reply = { action: "accept", content: {} };
  const res = await asked.client.callTool({ name: "delete_comp", arguments: { compId: 10, force: true } });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /"Hero Title"/);
  assert.match(prompts[0].message, /precomp layers/, "force is spelt out");
  assert.deepEqual(ops(), ["get_comp", "delete_comp"]);
  assert.deepEqual(seen[1].args, { compId: 10, force: true });
});

for (const action of ["decline", "cancel"]) {
  await check(`${action}: delete_comp is not run and says nothing changed`, async () => {
    seen.length = 0;
    reply = { action };
    const res = await asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
    assert.equal(res.isError, true, "a refusal must never read as a success");
    assert.match(text(res), /was not run/);
    assert.match(text(res), /Nothing in the After Effects project was changed/);
    assert.ok(!ops().includes("delete_comp"), `delete_comp reached the bridge: ${ops()}`);
  });
}

await check("purge: the prompt counts and names what would go; decline removes nothing", async () => {
  seen.length = 0;
  prompts.length = 0;
  reply = { action: "decline" };
  const res = await asked.client.callTool({ name: "purge_unused_footage", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(prompts[0].message, /Remove 2 unused solids/);
  assert.match(prompts[0].message, /"Black Solid 1"/);
  assert.deepEqual(seen.map((s) => [s.op, s.args.dryRun === true]), [["purge_unused_footage", true]], "only the dry run ran");
});

await check("purge: nothing to remove, or a dry run, asks nothing", async () => {
  seen.length = 0;
  prompts.length = 0;
  reply = { action: "decline" }; // would refuse if asked
  stubPurgeEmpty = true;
  const empty = await asked.client.callTool({ name: "purge_unused_footage", arguments: {} });
  stubPurgeEmpty = false;
  const dry = await asked.client.callTool({ name: "purge_unused_footage", arguments: { dryRun: true } });
  assert.equal(empty.isError, undefined, text(empty));
  assert.equal(dry.isError, undefined, text(dry));
  assert.equal(prompts.length, 0);
});

await check("revert: the saveCurrent choice is offered and folded into the call", async () => {
  seen.length = 0;
  prompts.length = 0;
  reply = { action: "accept", content: { saveCurrent: true } };
  const res = await asked.client.callTool({ name: "revert_comp", arguments: { checkpointId: 50 } });
  assert.equal(res.isError, undefined, text(res));
  assert.match(prompts[0].message, /"before easing"/);
  assert.equal(prompts[0].requestedSchema.properties.saveCurrent.type, "boolean");
  assert.equal(prompts[0].requestedSchema.properties.saveCurrent.default, false);
  const revert = seen.find((s) => s.op === "revert_comp");
  assert.equal(revert.args.saveCurrent, true);
});

await check("revert: a checkpoint the pre-read does not know is left to the tool's own refusal", async () => {
  seen.length = 0;
  prompts.length = 0;
  await asked.client.callTool({ name: "revert_comp", arguments: { checkpointId: 999 } });
  assert.equal(prompts.length, 0);
  assert.deepEqual(ops(), ["list_checkpoints", "revert_comp"]);
});

await check("other tools never ask", async () => {
  prompts.length = 0;
  await asked.client.callTool({ name: "delete_layer", arguments: { compId: 10, layerId: 1 } });
  assert.equal(prompts.length, 0);
  assert.deepEqual([...CONFIRMED_OPS].sort(), ["delete_comp", "purge_unused_footage", "revert_comp"]);
});

await check("a later write from the same session waits behind a pending confirmation", async () => {
  seen.length = 0;
  reply = { action: "accept", content: {} };
  let release;
  hold = new Promise((r) => (release = r));
  const pending = asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  while (!seen.some((s) => s.op === "get_comp")) await new Promise((r) => setTimeout(r, 5));
  let laterDone = false;
  const later = asked.client.callTool({ name: "set_comp", arguments: { compId: 11, name: "x" } }).then((r) => { laterDone = true; return r; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(laterDone, false, "a write issued after the confirmed call ran while the prompt was open");
  assert.ok(!ops().includes("set_comp"));
  release();
  hold = null;
  const [res, other] = await Promise.all([pending, later]);
  assert.equal(res.isError, undefined, text(res));
  assert.equal(other.isError, undefined, text(other));
  assert.deepEqual(ops(), ["get_comp", "delete_comp", "set_comp"], "the agent's order was not kept");
});

await check("reads are not held by a pending confirmation", async () => {
  seen.length = 0;
  let release;
  hold = new Promise((r) => (release = r));
  const pending = asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  while (!seen.some((s) => s.op === "get_comp")) await new Promise((r) => setTimeout(r, 5));
  const read = await Promise.race([
    asked.client.callTool({ name: "list_comps", arguments: {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("a read waited behind an open prompt")), 2000)),
  ]);
  assert.equal(read.isError, undefined, text(read));
  release();
  hold = null;
  await pending;
});

await check("purge: refused, nothing removed, when the unused set changed after the user approved it", async () => {
  seen.length = 0;
  dryRuns = 0;
  purgeGrows = true;
  reply = { action: "accept", content: {} };
  const res = await asked.client.callTool({ name: "purge_unused_footage", arguments: {} });
  purgeGrows = false;
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /changed after the user confirmed/);
  assert.match(text(res), /Nothing in the After Effects project was changed/);
  assert.ok(!seen.some((s) => s.op === "purge_unused_footage" && !s.args.dryRun), "the real purge was sent");
});

await check("purge: the same set at write time is purged", async () => {
  seen.length = 0;
  dryRuns = 0;
  reply = { action: "accept", content: {} };
  const res = await asked.client.callTool({ name: "purge_unused_footage", arguments: {} });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(seen.map((s) => [s.op, !!s.args.dryRun]), [
    ["purge_unused_footage", true], ["purge_unused_footage", true], ["purge_unused_footage", false],
  ]);
});

await check("an answer that fails the prompt's schema is a refusal, not a run without the choice", async () => {
  seen.length = 0;
  reply = { action: "accept", content: { saveCurrent: "yes" } };
  const res = await asked.client.callTool({ name: "revert_comp", arguments: { checkpointId: 50 } });
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /was not run/);
  assert.ok(!ops().includes("revert_comp"), `revert_comp reached the bridge: ${ops()}`);
});

await check("a pre-read that times out says no write was sent, not that one may still land", async () => {
  seen.length = 0;
  prompts.length = 0;
  process.env.AE_MCP_OP_TIMEOUT_MS = "200";
  const res = await asked.client.callTool({ name: "delete_comp", arguments: { compId: 666 } });
  delete process.env.AE_MCP_OP_TIMEOUT_MS;
  assert.equal(res.isError, true);
  assert.match(text(res), /delete_comp was not run/);
  assert.match(text(res), /Nothing that changes the project was sent/);
  assert.doesNotMatch(text(res), /may still/i);
  assert.doesNotMatch(text(res), /re-send/i);
  assert.equal(prompts.length, 0);
  await new Promise((r) => setTimeout(r, 1000)); // let the stub finish the slow read
});

const destructiveBatch = {
  ops: [
    { op: "create_comp", args: { name: "tmp" } },
    { op: "run_batch", args: { ops: [{ op: "delete_comp", args: { compId: 10, force: true } }] } },
    { op: "purge_unused_footage", args: {} },
  ],
};

await check("batch: a destructive step anywhere asks once, listing the steps; decline runs nothing", async () => {
  seen.length = 0;
  prompts.length = 0;
  reply = { action: "decline" };
  const res = await asked.client.callTool({ name: "run_batch", arguments: destructiveBatch });
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /run_batch was not run/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /batch of 3 steps/);
  assert.match(prompts[0].message, /ops\[1\]\.args\.ops\[0\]: delete comp 10/);
  assert.match(prompts[0].message, /ops\[2\]: remove whatever solids are unused/);
  assert.deepEqual(ops(), [], `something reached the bridge: ${ops()}`);
});

await check("batch: accept runs the batch as sent", async () => {
  seen.length = 0;
  reply = { action: "accept", content: {} };
  const res = await asked.client.callTool({ name: "run_batch", arguments: destructiveBatch });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(ops(), ["run_batch"]);
});

await check("batch: nothing destructive (or only a dry-run purge) asks nothing", async () => {
  prompts.length = 0;
  reply = { action: "decline" };
  const res = await asked.client.callTool({
    name: "run_batch",
    arguments: { ops: [{ op: "create_comp", args: { name: "a" } }, { op: "purge_unused_footage", args: { dryRun: true } }] },
  });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(prompts.length, 0);
});

await check("a timeout after a prompt does not count the person's answering time as earlier steps", async () => {
  seen.length = 0;
  reply = { action: "accept", content: {} };
  let release;
  hold = new Promise((r) => (release = r));
  setTimeout(() => release(), 900);
  process.env.AE_MCP_OP_TIMEOUT_MS = "300";
  const res = await asked.client.callTool({ name: "delete_comp", arguments: { compId: 777 } });
  delete process.env.AE_MCP_OP_TIMEOUT_MS;
  hold = null;
  assert.equal(res.isError, true);
  assert.match(text(res), /did not answer/);
  assert.doesNotMatch(text(res), /earlier steps/, text(res));
  await new Promise((r) => setTimeout(r, 1500)); // let the stub finish the slow delete
});

await check("purge: nothing unused when checked, something unused under the lease — refused, not purged unasked", async () => {
  seen.length = 0;
  prompts.length = 0;
  dryRuns = 0;
  purgeEmptyThenOne = true;
  const res = await asked.client.callTool({ name: "purge_unused_footage", arguments: {} });
  purgeEmptyThenOne = false;
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /never asked/);
  assert.equal(prompts.length, 0);
  assert.ok(!seen.some((s) => s.op === "purge_unused_footage" && !s.args.dryRun), "the real purge was sent");
});

for (const [label, thrown] of [
  ["an McpError", () => new McpError(ErrorCode.InternalError, "Client does not support form elicitation.")],
  ["a plain Error", () => new Error("Client does not support form elicitation.")],
]) {
  await check(`a client error (${label}) whose text says "does not support elicitation" is a refusal`, async () => {
    seen.length = 0;
    reply = () => { throw thrown(); };
    const res = await asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
    reply = { action: "accept", content: {} };
    assert.equal(res.isError, true, text(res));
    assert.ok(!ops().includes("delete_comp"), `delete_comp ran unasked: ${ops()}`);
    assert.ok((text(res).match(/MCP error -32603:/g) ?? []).length <= 1, `the error prefix repeats: ${text(res)}`);
  });
}

await check("a client answering method-not-found gets today's behaviour", async () => {
  seen.length = 0;
  reply = () => { throw new McpError(ErrorCode.MethodNotFound, "nope"); };
  const res = await asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  reply = { action: "accept", content: {} };
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(ops(), ["get_comp", "delete_comp"]);
});

await check("the prompt gives up before a write queued behind it would", async () => {
  process.env.AE_MCP_WRITE_QUEUE_WAIT_MS = "4000";
  const slow = await connect({ elicitation: {} }, () => new Promise(() => {})); // a person who never answers
  delete process.env.AE_MCP_WRITE_QUEUE_WAIT_MS;
  seen.length = 0;
  const pending = slow.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  while (!seen.some((s) => s.op === "get_comp")) await new Promise((r) => setTimeout(r, 5));
  const later = slow.client.callTool({ name: "set_comp", arguments: { compId: 11, name: "x" } });
  const res = await pending;
  assert.equal(res.isError, true);
  assert.match(text(res), /nobody answered the confirmation prompt within 4 seconds/);
  const other = await later;
  assert.equal(other.isError, undefined, `the queued write timed out first: ${text(other)}`);
  assert.deepEqual(ops(), ["get_comp", "set_comp"]);
  await slow.client.close();
});

await check("a write queued earlier than the confirmation does not time out while the prompt is open", async () => {
  process.env.AE_MCP_WRITE_QUEUE_WAIT_MS = "4000";
  const slow = await connect({ elicitation: {} }, () => new Promise(() => {}));
  delete process.env.AE_MCP_WRITE_QUEUE_WAIT_MS;
  seen.length = 0;
  // W0 holds the queue for 1s; the confirmation and S queue behind it at once,
  // so S's queue clock starts a second before the prompt does.
  const w0 = slow.client.callTool({ name: "set_comp", arguments: { compId: 99, name: "w0" } });
  await new Promise((r) => setTimeout(r, 20));
  const d = slow.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  await new Promise((r) => setTimeout(r, 20));
  const sCall = slow.client.callTool({ name: "set_comp", arguments: { compId: 11, name: "s" } });
  const [w0r, dr, sr] = await Promise.all([w0, d, sCall]);
  assert.equal(w0r.isError, undefined, text(w0r));
  assert.equal(dr.isError, true);
  assert.match(text(dr), /nobody answered/);
  assert.equal(sr.isError, undefined, `the write queued behind the prompt timed out: ${text(sr)}`);
  assert.match(text(sr), /waited for the user to answer a confirmation/);
  await slow.client.close();
});

await check("front desk: a pending prompt in one session does not hold another session's writes", async () => {
  const deskPort = await new Promise((r) => {
    const t = net.createServer().listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => r(p)); });
  });
  let release;
  const held = new Promise((r) => (release = r));
  const a = await connect({ elicitation: {} }, async () => { await held; return { action: "accept", content: {} }; }, { frontDesk: { port: deskPort } });
  const b = await connect({}, null, { frontDesk: { port: deskPort } });
  // Let both elect: one leads the desk, the other joins it.
  await b.client.callTool({ name: "list_comps", arguments: {} });
  await a.client.callTool({ name: "list_comps", arguments: {} });
  seen.length = 0;
  const pending = a.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  while (!seen.some((s) => s.op === "get_comp")) await new Promise((r) => setTimeout(r, 5));
  const other = await Promise.race([
    b.client.callTool({ name: "set_comp", arguments: { compId: 11, name: "b" } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("session B's write waited behind session A's prompt")), 3000)),
  ]);
  assert.equal(other.isError, undefined, text(other));
  release();
  const res = await pending;
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(ops(), ["get_comp", "set_comp", "delete_comp"]);
  await a.client.close();
  await b.client.close();
});

await check("a throw from the confirmation never leaks the reservation or the pause", async () => {
  const broken = await connect({ elicitation: {} }, () => ({ action: "accept", content: {} }), {
    confirmWithUser: async () => { throw new Error("boom"); },
  });
  seen.length = 0;
  const res = await broken.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /delete_comp was not run/);
  assert.match(text(res), /boom/);
  const next = await Promise.race([
    broken.client.callTool({ name: "set_comp", arguments: { compId: 11, name: "after" } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("the next write waited on a leaked reservation")), 2000)),
  ]);
  assert.equal(next.isError, undefined, text(next));
  assert.deepEqual(ops(), ["get_comp", "set_comp"]);
  await broken.client.close();
});

await check("the call cancelled while the prompt is open runs nothing", async () => {
  seen.length = 0;
  let release;
  hold = new Promise((r) => (release = r));
  const ac = new AbortController();
  const pending = asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } }, undefined, { signal: ac.signal });
  while (!seen.some((s) => s.op === "get_comp")) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await pending.then(() => {}, () => {});
  release();
  hold = null;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!ops().includes("delete_comp"), `delete_comp reached the bridge after a cancel: ${ops()}`);
});

// ---------------------------------------------------------------------------
// confirmWithUser on its own: the failure modes a stub client cannot easily produce.
// ---------------------------------------------------------------------------

const prompt = { message: "Delete?", requestedSchema: { type: "object", properties: {} } };

await check("no answer in time is a refusal, never a yes", async () => {
  const waitForAbort = (_p, sig) => new Promise((_, rej) => sig.addEventListener("abort", () => rej(new Error("aborted"))));
  const out = await confirmWithUser("delete_comp", { compId: 1 }, prompt, waitForAbort, undefined, undefined, 50);
  assert.equal(out.proceed, false);
  assert.match(out.message, /nobody answered the confirmation prompt within 1 second/);
  assert.match(out.message, /Nothing in the After Effects project was changed/);
});

await check("a client answering -32001 is a failed prompt, not 'nobody answered'", async () => {
  const out = await confirmWithUser("delete_comp", { compId: 1 }, prompt, async () => {
    throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
  });
  assert.equal(out.proceed, false);
  assert.match(out.message, /confirmation prompt failed/);
  assert.doesNotMatch(out.message, /nobody answered/);
});

await check("the queue clock behind a confirmation stops, and the timeout says what it waited for", async () => {
  const q = new WriteQueue({ maxWaitMs: 300, maxDepth: 8 });
  const a = await q.acquire("delete_comp");
  const resume = a.pauseWaiters();
  let settled = null;
  const b = q.acquire("set_comp").then(() => (settled = "granted"), (e) => (settled = e));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(settled, null, "a waiter timed out while the holder waited on a person");
  resume();
  await b;
  assert.ok(settled instanceof Error, "the waiter should time out once the clock runs again");
  assert.match(settled.message, /waited for the user to answer a confirmation prompt/);
  a.release();
});

await check("a stale resume ends only its own pause", async () => {
  const q = new WriteQueue({ maxWaitMs: 300, maxDepth: 8 });
  const a = await q.acquire("delete_comp");
  const resumeA = a.pauseWaiters();
  const bP = q.acquire("revert_comp");
  a.release(); // A's pause ends with it; B takes the queue
  const b = await bP;
  b.pauseWaiters();
  let settled = null;
  const c = q.acquire("set_comp").then(() => (settled = "granted"), (e) => (settled = e));
  resumeA(); // stale: must not restart C's clock under B's pause
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(settled, null, "A's stale resume ended B's pause");
  b.release();
  await c;
});

await check("a full queue behind a pending confirmation says so", async () => {
  const q = new WriteQueue({ maxWaitMs: 10_000, maxDepth: 1 });
  const a = await q.acquire("delete_comp");
  a.pauseWaiters();
  const first = q.acquire("set_comp");
  await assert.rejects(q.acquire("set_layer"), /waits for the user to answer a confirmation prompt/);
  a.release();
  (await first).release();
});

await check("any other prompt failure refuses", async () => {
  for (const err of [
    Object.assign(new Error("Elicitation response content does not match requested schema"), { code: -32602 }),
    Object.assign(new Error("User dismissed"), { code: -1 }),
    new Error("transport closed"),
  ]) {
    const out = await confirmWithUser("delete_comp", { compId: 1 }, prompt, async () => { throw err; });
    assert.equal(out.proceed, false, err.message);
    assert.match(out.message, /was not run/);
  }
  assert.equal(cannotElicit(new Error("Client does not support form elicitation.")), true);
});

await check("cannotElicit trusts the wire's code, never its text", async () => {
  assert.equal(cannotElicit(new McpError(ErrorCode.InternalError, "Client does not support form elicitation.")), false);
  assert.equal(cannotElicit(new McpError(ErrorCode.MethodNotFound, "x")), true);
  assert.equal(cannotElicit(new Error("Client does not support form elicitation.")), true);
});

await check("a cancelled call is a refusal even when the error would otherwise fall back", async () => {
  const ac = new AbortController();
  ac.abort();
  const out = await confirmWithUser("delete_comp", { compId: 1 }, prompt, async () => {
    throw new McpError(ErrorCode.MethodNotFound, "x");
  }, ac.signal);
  assert.equal(out.proceed, false);
  assert.match(out.message, /cancelled while the confirmation prompt was open/);
});

await check("the prompt limit sits under the queue wait, counted from the reservation", async () => {
  assert.equal(confirmTimeoutMs(0, 600_000), 300_000);
  assert.equal(confirmTimeoutMs(10_000, 60_000), 44_000);
  assert.ok(confirmTimeoutMs(0, 4000) < 4000);
});

await check("a client that advertised elicitation but cannot show it gets today's behaviour", async () => {
  const logged = [];
  const out = await confirmWithUser(
    "delete_comp", { compId: 1 }, prompt,
    async () => { throw new McpError(ErrorCode.MethodNotFound, "Method not found"); },
    undefined, (m) => logged.push(m)
  );
  assert.equal(out.proceed, true);
  assert.deepEqual(out.args, { compId: 1 });
  assert.equal(logged.length, 1, "the fallback is logged");
});

await check("the refusal sentence names the tool and forbids a silent retry", async () => {
  const m = notRunMessage("revert_comp", "the user declined it");
  assert.match(m, /^revert_comp was not run/);
  assert.match(m, /Do not call it again unless the user asks/);
});

await plain.client.close();
await asked.client.close();
wss.close();
bridge.close();
console.log(`elicitation: ${passed} checks passed`);
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows (nodejs/node#56645; docs/fragile-areas-server.md).
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
