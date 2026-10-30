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
// - nothing is asked when there is nothing to ask (a dry run, an empty purge);
// - no write lease is held while the person decides — another write from the
//   same session goes through while the prompt is open;
// - a timeout is a refusal, and a client that advertised elicitation but cannot
//   show the prompt falls back to today's behaviour.
//
//   node tests/unit/elicitation.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

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
  req.on("end", () => {
    const { op, args } = JSON.parse(body || "{}");
    seen.push({ op, args });
    let result = { ok: true, op };
    if (op === "get_comp") result = { id: args.compId, name: "Hero Title" };
    if (op === "purge_unused_footage" && args.dryRun) {
      result = stubPurgeEmpty
        ? { solidsOnly: true, scanned: 2, inUse: 2, dryRun: true, wouldRemove: [], wouldRemoveCount: 0 }
        : {
            solidsOnly: true, scanned: 3, inUse: 1, dryRun: true,
            wouldRemove: [{ id: 7, name: "Black Solid 1", kind: "solid" }, { id: 8, name: "Red Solid 2", kind: "solid" }],
            wouldRemoveCount: 2,
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
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

const { createServer } = await import(dist("server.js"));
const { confirmWithUser, notRunMessage, CONFIRMED_OPS } = await import(dist("tools", "confirm.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

/** A connected pair; `answer(params)` is the person, when the client can ask one. */
async function connect(capabilities, answer) {
  const server = createServer();
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

await check("no write lease is held while the person decides", async () => {
  seen.length = 0;
  reply = { action: "accept", content: {} };
  let release;
  hold = new Promise((r) => (release = r));
  const pending = asked.client.callTool({ name: "delete_comp", arguments: { compId: 10 } });
  // Wait until the prompt is open.
  while (!seen.some((s) => s.op === "get_comp")) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  const other = await Promise.race([
    asked.client.callTool({ name: "set_comp", arguments: { compId: 11, name: "x" } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("set_comp waited behind an open prompt")), 2000)),
  ]);
  assert.equal(other.isError, undefined, text(other));
  release();
  hold = null;
  const res = await pending;
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(ops(), ["get_comp", "set_comp", "delete_comp"]);
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
  const timeout = Object.assign(new Error("Request timed out"), { code: -32001 });
  const out = await confirmWithUser("delete_comp", { compId: 1 }, prompt, async () => { throw timeout; });
  assert.equal(out.proceed, false);
  assert.match(out.message, /nobody answered/);
  assert.match(out.message, /Nothing in the After Effects project was changed/);
});

await check("a client that advertised elicitation but cannot show it gets today's behaviour", async () => {
  const logged = [];
  const out = await confirmWithUser(
    "delete_comp", { compId: 1 }, prompt,
    async () => { throw Object.assign(new Error("Method not found"), { code: -32601 }); },
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
