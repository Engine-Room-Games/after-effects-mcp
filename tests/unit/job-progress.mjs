// Where a long batch's progress goes, seen from a client that correlates it
// the way the spec says to (issue #82).
//
// A `notifications/progress` is only meaningful while the request whose
// progressToken it carries is still open: the SDK client registers its
// onprogress handler when the request goes out and deletes it the moment the
// response arrives. Until 0.5.0 every progress message for a chunked
// `run_batch` was sent AFTER that call's response — the messages were plainly
// on the wire, which is how the feature was verified, and no real client ever
// saw one. The call that blocks for the job is `await_job`, so that is the
// call that carries progress now.
//
// This drives the real MCP server over an in-memory transport against a stub
// bridge, with the real SDK client correlating progress by request. The wire
// is recorded on both sides so ordering can be asserted rather than inferred:
// every notification for a request must precede that request's response.
//
//   node tests/unit/job-progress.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash } = await import(dist("setup", "panelVersion.js"));
const { JobManager } = await import(dist("jobs", "manager.js"));

let passed = 0;

// ---------------------------------------------------------------------------
// The manager on its own: an emitter's lifetime is the caller's to end, and
// ending it has to work whether the job is still running or already gone.
// ---------------------------------------------------------------------------
{
  const jobs = new JobManager();
  jobs.register("j_m", 100);
  const seen = [];
  const unbind = jobs.bindProgressEmitter("j_m", (_id, progress) => seen.push(progress));
  assert.equal(typeof unbind, "function", "bindProgressEmitter must hand back the unbind");
  assert.equal(jobs.progressEmitterCount("j_m"), 1);
  jobs.reportProgress("j_m", 25, 100);
  unbind();
  assert.equal(jobs.progressEmitterCount("j_m"), 0);
  jobs.reportProgress("j_m", 50, 100);
  assert.deepEqual(seen, [25], "an unbound emitter must not hear the next event");
  assert.equal(jobs.get("j_m").progress, 50, "the state still records what the emitter no longer hears");
  // Two emitters, one job: unbinding one leaves the other.
  const a = jobs.bindProgressEmitter("j_m", () => {});
  jobs.bindProgressEmitter("j_m", () => {});
  a();
  assert.equal(jobs.progressEmitterCount("j_m"), 1);
  // Completion drops the rest, and unbinding after that is a no-op.
  jobs.complete("j_m", {});
  assert.equal(jobs.progressEmitterCount("j_m"), 0);
  assert.doesNotThrow(() => unbind());
  passed++;
}

// ---------------------------------------------------------------------------
// Stub bridge, never on 7777 — a real panel may hold that on this machine.
// `run_batch` always answers with an async envelope; the WS side is driven
// by hand from each check, standing in for the panel's driveJob loop.
// ---------------------------------------------------------------------------

/** op -> what the stub answers. */
const behaviour = new Map();

const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { op } = JSON.parse(body || "{}");
    const result = behaviour.get(op) ?? { ok: true, op };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

/** What the panel broadcasts on /events. */
function emit(evt) {
  for (const ws of wss.clients) ws.send(JSON.stringify(evt));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Imported only after AE_MCP_PORT is set: HttpClient resolves the port in its
// constructor, which runs inside createServer().
const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "job-progress-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

// Wait for the server's WS client to reach the stub, or the first emit() goes
// to nobody.
for (let i = 0; i < 100 && wss.clients.size === 0; i++) await sleep(10);
assert.equal(wss.clients.size, 1, "the server never connected to the stub's /events");

// ---------------------------------------------------------------------------
// The wire. `InMemoryTransport.send` hands the message to the other side
// synchronously, so the order recorded here is the order sent.
// ---------------------------------------------------------------------------

/** Every message the client received, in order. */
const wire = [];
/** Every request the server received: id, tool name, arguments. */
const requests = [];
{
  const toClient = clientSide.onmessage;
  clientSide.onmessage = (msg, extra) => {
    wire.push(msg);
    toClient(msg, extra);
  };
  const toServer = serverSide.onmessage;
  serverSide.onmessage = (msg, extra) => {
    if (msg.method === "tools/call") {
      requests.push({ id: msg.id, name: msg.params.name, args: msg.params.arguments ?? {} });
    }
    toServer(msg, extra);
  };
}

// The SDK client reports a progress notification for a token it is no longer
// tracking through onerror. That is the exact symptom in #82, so it is counted
// for the whole run and asserted at the end as well as per check.
const clientErrors = [];
client.onerror = (e) => clientErrors.push(String(e?.message ?? e));

/** The request id of an await_job / get_job call, which name their job. */
const requestId = (name, jobId) => {
  const r = requests.find((q) => q.name === name && q.args.jobId === jobId);
  assert.ok(r, `no ${name} request for ${jobId} reached the server`);
  return r.id;
};
/** The request id of the latest call of a tool — a run_batch names no job. */
const lastRequestId = (name) => {
  const r = requests.filter((q) => q.name === name).at(-1);
  assert.ok(r, `no ${name} request reached the server`);
  return r.id;
};
const responseIndex = (id) => {
  const i = wire.findIndex((m) => m.id === id && ("result" in m || "error" in m));
  assert.ok(i >= 0, `no response for request ${id} on the wire`);
  return i;
};
/** Wire indices of every notifications/progress carrying this token. */
const progressIndices = (token) =>
  wire
    .map((m, i) => (m.method === "notifications/progress" && m.params.progressToken === token ? i : -1))
    .filter((i) => i >= 0);
const allProgress = () => wire.filter((m) => m.method === "notifications/progress");
const payload = (res, i = 0) => JSON.parse(res.content[i].text);

/** A tool call with progress correlated the way the spec says to. */
function callWithProgress(name, args) {
  const received = [];
  const done = client.callTool({ name, arguments: args }, undefined, {
    onprogress: (p) => received.push(p),
  });
  return { done, received };
}

const batchEnvelope = (jobId) => ({
  jobId,
  async: true,
  total: 600,
  chunkSize: 25,
  undoStepsEstimate: 24,
  undoGroupName: "AE MCP Batch",
  note: "about 24 undo steps, NOT one",
});
const batchArgs = { ops: [{ op: "create_null_layer", args: { compId: 1 } }] };

async function check(name, fn) {
  const errorsBefore = clientErrors.length;
  await fn();
  assert.equal(
    clientErrors.length,
    errorsBefore,
    `${name}: the client reported ${clientErrors.slice(errorsBefore).join(" | ")}`
  );
  passed++;
}

// ---------------------------------------------------------------------------

await check("run_batch sends no progress on its own token after its response", async () => {
  // The bug as reported: a client that passes a progressToken on run_batch and
  // stops correlating it when the envelope comes back. Before the fix the
  // server bound an emitter to that token and every WS progress event for the
  // job went out on it — after the response, to a client no longer listening.
  behaviour.set("run_batch", batchEnvelope("j_p1"));
  const { done, received } = callWithProgress("run_batch", batchArgs);
  const res = await done;
  assert.equal(res.isError, undefined, res.content[0]?.text);
  const env = payload(res);
  assert.equal(env.jobId, "j_p1");
  assert.equal(env.undoStepsEstimate, 24, "the undo fields must survive the envelope");

  const id = lastRequestId("run_batch");
  const responseAt = responseIndex(id);

  // The panel drives the job and reports progress — after the envelope, as it
  // always will, because the envelope is returned before the first chunk runs.
  for (let i = 1; i <= 4; i++) emit({ type: "progress", jobId: "j_p1", progress: 25 * i, total: 600, message: "running" });
  await sleep(80);

  // The guard. Against the 0.4.0 server this is the line that fails: four
  // notifications on this token, all after the response, none correlated.
  assert.deepEqual(progressIndices(id), [], "progress went out on run_batch's token after its response");
  assert.equal(received.length, 0, "the client's onprogress for run_batch fired");
  assert.equal(wire.length - 1, responseAt, "nothing at all should have reached the client after the envelope");

  // The envelope says where progress goes instead, in the field the agent reads.
  assert.ok(env.note.startsWith("about 24 undo steps, NOT one "), "the panel's own note must be kept, in front");
  assert.match(env.note, /await_job\(\{jobId: "j_p1"\}\)/, "the note must name the await_job call");
  assert.match(env.note, /progressToken/, "the note must name the token");
  assert.match(env.note, /get_job\(\{jobId: "j_p1"\}\)/, "and the poll without one");

  emit({ type: "complete", jobId: "j_p1", result: { results: [], undoSteps: 24 } });
  await sleep(20);
});

await check("await_job with a progressToken receives every progress event, all before its response", async () => {
  behaviour.set("run_batch", batchEnvelope("j_p2"));
  const batch = await client.callTool({ name: "run_batch", arguments: batchArgs });
  assert.equal(payload(batch).jobId, "j_p2");
  const batchId = lastRequestId("run_batch");

  const { done, received } = callWithProgress("await_job", { jobId: "j_p2", timeoutMs: 5000 });
  // Let the request reach the handler and bind before the panel reports.
  await sleep(30);
  const awaitId = requestId("await_job", "j_p2");

  const expected = [];
  for (let i = 1; i <= 5; i++) {
    emit({ type: "progress", jobId: "j_p2", progress: 25 * i, total: 600, message: "running" });
    expected.push({ progress: 25 * i, total: 600, message: "running" });
  }
  emit({ type: "complete", jobId: "j_p2", result: { results: [], errors: [], total: 600, undoSteps: 24 } });

  const res = await done;
  assert.equal(res.isError, undefined, res.content[0]?.text);
  const state = payload(res);
  assert.equal(state.status, "completed");
  assert.equal(state.result.undoSteps, 24, "await_job returns the job's own result");

  // Correlated by the client: all five, in order, with their values intact.
  assert.deepEqual(received, expected);

  // And on the wire: five notifications on await_job's token, every one of
  // them ahead of await_job's response, and none on run_batch's.
  const responseAt = responseIndex(awaitId);
  const notified = progressIndices(awaitId);
  assert.equal(notified.length, 5);
  for (const i of notified) assert.ok(i < responseAt, `a progress notification (wire #${i}) followed the response (wire #${responseAt})`);
  assert.deepEqual(progressIndices(batchId), [], "progress leaked onto run_batch's token");
});

await check("await_job without a progressToken sends none, and neither does get_job", async () => {
  behaviour.set("run_batch", batchEnvelope("j_p3"));
  await client.callTool({ name: "run_batch", arguments: batchArgs });

  const before = allProgress().length;
  const done = client.callTool({ name: "await_job", arguments: { jobId: "j_p3", timeoutMs: 5000 } });
  await sleep(30);
  for (let i = 1; i <= 3; i++) emit({ type: "progress", jobId: "j_p3", progress: 25 * i, total: 600, message: "running" });
  await sleep(30);

  // get_job is the poll: it reads the state the progress events wrote and
  // never turns into a notification, even when it is sent with a token.
  const poll = callWithProgress("get_job", { jobId: "j_p3" });
  const polled = payload(await poll.done);
  assert.equal(polled.status, "running");
  assert.equal(polled.progress, 75, "get_job must read the progress the WS events reported");
  assert.equal(poll.received.length, 0, "get_job sent progress");

  emit({ type: "complete", jobId: "j_p3", result: { results: [], undoSteps: 24 } });
  const res = await done;
  assert.equal(payload(res).status, "completed");
  assert.equal(allProgress().length, before, "a call with no token produced a progress notification");
});

await check("an await_job that times out unbinds: nothing follows its error response", async () => {
  // The other lifetime edge. The emitter is bound for the span of the call,
  // and a timeout ends the call with the job still running — so the finally
  // has to unbind, or every later chunk goes out on a token nobody holds.
  behaviour.set("run_batch", batchEnvelope("j_p4"));
  await client.callTool({ name: "run_batch", arguments: batchArgs });

  const { done, received } = callWithProgress("await_job", { jobId: "j_p4", timeoutMs: 120 });
  await sleep(30);
  const awaitId = requestId("await_job", "j_p4");
  emit({ type: "progress", jobId: "j_p4", progress: 25, total: 600, message: "running" });

  const res = await done;
  assert.equal(res.isError, true, "the call should have timed out");
  assert.match(res.content[0].text, /timed out after 120ms/);
  assert.equal(received.length, 1, "the one event before the timeout should have been delivered");

  const responseAt = responseIndex(awaitId);
  const wireBefore = wire.length;
  // The job carries on after the caller gave up on it.
  emit({ type: "progress", jobId: "j_p4", progress: 50, total: 600, message: "running" });
  emit({ type: "progress", jobId: "j_p4", progress: 75, total: 600, message: "running" });
  await sleep(60);

  assert.equal(received.length, 1, "onprogress fired after the call had already failed");
  assert.deepEqual(
    progressIndices(awaitId).filter((i) => i > responseAt),
    [],
    "progress went out on a timed-out await_job's token after its error response"
  );
  assert.equal(wire.length, wireBefore, "nothing should reach the client for a call that has ended");

  emit({ type: "complete", jobId: "j_p4", result: { results: [], undoSteps: 24 } });
  await sleep(20);
});

await check("two waiters on one job each get the events on their own token, each before their own response", async () => {
  behaviour.set("run_batch", batchEnvelope("j_p5"));
  await client.callTool({ name: "run_batch", arguments: batchArgs });

  const a = callWithProgress("await_job", { jobId: "j_p5", timeoutMs: 5000 });
  const b = callWithProgress("await_job", { jobId: "j_p5", timeoutMs: 5000 });
  await sleep(30);
  const ids = requests.filter((q) => q.name === "await_job" && q.args.jobId === "j_p5").map((q) => q.id);
  assert.equal(ids.length, 2);

  for (let i = 1; i <= 3; i++) emit({ type: "progress", jobId: "j_p5", progress: 25 * i, total: 600, message: "running" });
  emit({ type: "complete", jobId: "j_p5", result: { results: [], undoSteps: 24 } });
  await Promise.all([a.done, b.done]);

  assert.equal(a.received.length, 3);
  assert.equal(b.received.length, 3);
  for (const id of ids) {
    const responseAt = responseIndex(id);
    const notified = progressIndices(id);
    assert.equal(notified.length, 3, `request ${id} should have three notifications on its token`);
    for (const i of notified) assert.ok(i < responseAt, `request ${id}: notification #${i} followed response #${responseAt}`);
  }
});

await check("await_job on a job that has already finished answers at once with no progress", async () => {
  const before = allProgress().length;
  const { done, received } = callWithProgress("await_job", { jobId: "j_p5", timeoutMs: 5000 });
  const res = await done;
  assert.equal(payload(res).status, "completed");
  assert.equal(received.length, 0);
  assert.equal(allProgress().length, before);
});

assert.deepEqual(clientErrors, [], "the client reported a notification it was not tracking");
console.log(`job-progress: ${passed} checks passed`);
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645; the note in
// issue-journal.mjs). The server's WS client reconnects on a timer it owns, so
// the process cannot simply be left to drain.
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
