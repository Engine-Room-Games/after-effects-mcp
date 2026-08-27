#!/usr/bin/env node
// diagnose-spaces.mjs — the experiment issue #25 is waiting on.
//
// The report: a long call to After Effects sits past the client timeout while
// the user is on another macOS Space, and completes the moment they switch
// back. Filed as suspected and uninvestigated, because App Nap, Chromium's
// throttling of a backgrounded CEP renderer, and a socket loop that depends on
// window state are three different mechanisms with three different remedies —
// and #35 already fixed the half that could be fixed blind, which is that the
// symptom used to be reported as "cannot reach the panel".
//
// What this measures, and why each part is the discriminator:
//
//   1. A `/health` poll every second, timed. This is a bare HTTP round trip
//      that never enters ExtendScript. If these stall, nothing in After
//      Effects is to blame — the panel's own event loop is being throttled.
//   2. A long `run_batch`, which the panel drives in chunks and reports over
//      the WebSocket. If WS progress keeps arriving while the HTTP reply does
//      not, the problem is not ExtendScript starvation at all. If both stop
//      together, it is.
//   3. Whether After Effects is frontmost, sampled each second, so the log
//      says exactly when you left and came back without you timing anything.
//
// Run it, switch Spaces when it tells you to, come back when it tells you to,
// and paste the summary into the issue.
//
//   node scripts/diagnose-spaces.mjs                 # default: 45s away
//   node scripts/diagnose-spaces.mjs --ops 400 --away 60
//   node scripts/diagnose-spaces.mjs --baseline      # never leave; control run

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.AE_MCP_PORT || 7777);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OPS = Number(flag("ops", 600));
const AWAY_SECONDS = Number(flag("away", 45));
const BASELINE = argv.includes("--baseline");

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const events = [];
function record(kind, detail) {
  const line = { t: (Date.now() - t0) / 1000, kind, detail };
  events.push(line);
  console.log(`[${at()}s] ${kind.padEnd(14)} ${detail}`);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
async function frontmostApp() {
  if (process.platform !== "darwin") return "n/a";
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to return name of first process whose frontmost is true',
    ]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function appNapDisabled() {
  if (process.platform !== "darwin") return "n/a";
  try {
    const { stdout } = await execFileAsync("defaults", ["read", "com.adobe.AfterEffects", "NSAppSleepDisabled"]);
    return stdout.trim() === "1" ? "yes" : `no (${stdout.trim()})`;
  } catch {
    return "no (unset)";
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------
const health = [];
let polling = true;

async function pollHealth() {
  while (polling) {
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    let outcome;
    try {
      const res = await fetch(`${BASE}/health`, { signal: ctl.signal });
      await res.json();
      outcome = "ok";
    } catch (e) {
      outcome = e.name === "AbortError" ? "timeout" : `error:${e.message}`;
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    health.push({ t: (Date.now() - t0) / 1000, ms, outcome });
    // Only speak up when it is interesting — a healthy poll every second would
    // bury the events that matter.
    if (outcome !== "ok" || ms > 250) record("health", `${outcome} in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let lastFront = null;
async function pollFrontmost() {
  while (polling) {
    const front = await frontmostApp();
    if (front !== lastFront) {
      record("frontmost", front);
      lastFront = front;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function openEvents() {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
    } catch (e) {
      record("ws", `could not open: ${e.message}`);
      return resolve(null);
    }
    let progressCount = 0;
    let lastProgressAt = null;
    ws.addEventListener("open", () => {
      record("ws", "connected");
      resolve({
        close: () => ws.close(),
        stats: () => ({ progressCount, lastProgressAt }),
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "progress") {
        progressCount++;
        lastProgressAt = (Date.now() - t0) / 1000;
        // Every chunk would be noise; a heartbeat is enough to see a gap.
        if (progressCount % 5 === 1) record("ws-progress", `${msg.progress}/${msg.total}`);
      } else {
        record("ws-" + msg.type, JSON.stringify(msg).slice(0, 120));
      }
    });
    ws.addEventListener("error", () => record("ws", "error"));
    ws.addEventListener("close", () => record("ws", "closed"));
    setTimeout(() => resolve(null), 4000);
  });
}

// A batch of cheap, individually-fast ops: the wall-clock comes from the number
// of round trips through the panel's chunk driver, not from any one op being
// slow. That is the shape the report describes.
function batchPayload(n) {
  const ops = [];
  for (let i = 0; i < n; i++) {
    ops.push({ op: "create_null_layer", args: { compId: COMP_ID, name: `spaces-probe-${i}` } });
  }
  return { op: "run_batch", args: { ops, transactional: false }, requestId: "spaces-probe" };
}

let COMP_ID = null;

async function postOp(body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/op`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main() {
  console.log("After Effects Spaces / App Nap probe — issue #25");
  console.log(`  host        ${os.platform()} ${os.release()}`);
  console.log(`  bridge      ${BASE}`);
  console.log(`  App Nap disabled for AE: ${await appNapDisabled()}`);
  console.log(`  ops         ${OPS}${BASELINE ? "   (baseline run — stay where you are)" : ""}`);
  console.log("");

  try {
    const h = await postOp({ op: "list_comps", args: {}, requestId: "probe-init" }, 10000);
    if (!h.ok) throw new Error(h.error || "list_comps failed");
    const comps = h.result || [];
    if (!comps.length) {
      console.error("No comps in the project. Make one first — this probe adds and removes null layers in it.");
      process.exit(1);
    }
    COMP_ID = comps[0].id;
    console.log(`  using comp  ${comps[0].name} (#${COMP_ID})\n`);
  } catch (e) {
    console.error(`Cannot reach the panel at ${BASE}: ${e.message}`);
    console.error("Open After Effects with the panel loaded, then try again.");
    process.exit(1);
  }

  const ws = await openEvents();
  pollHealth();
  pollFrontmost();

  record("batch", `posting ${OPS} ops`);
  const batchStarted = Date.now();

  if (!BASELINE) {
    console.log("");
    console.log(`  >>> SWITCH TO ANOTHER SPACE NOW, and come back in ${AWAY_SECONDS}s. <<<`);
    console.log("");
  }

  let batchResult = null;
  let batchError = null;
  const batchPromise = postOp(batchPayload(OPS), 600000)
    .then((r) => { batchResult = r; })
    .catch((e) => { batchError = e; });

  if (!BASELINE) {
    await new Promise((r) => setTimeout(r, AWAY_SECONDS * 1000));
    console.log("");
    console.log("  >>> COME BACK TO THE SPACE AFTER EFFECTS IS ON NOW. <<<");
    console.log("");
    record("prompt", "asked the user to return");
  }

  await batchPromise;
  const batchMs = Date.now() - batchStarted;
  record("batch", batchError ? `FAILED after ${batchMs}ms: ${batchError.message}` : `replied in ${batchMs}ms`);

  // The batch is async past the inline cutoff: the HTTP reply is a jobId and
  // the work continues. Wait for the completion event before drawing any
  // conclusion about when it finished.
  if (batchResult?.result?.jobId && !batchResult.result.done) {
    record("batch", `async job ${batchResult.result.jobId}; waiting for completion`);
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const j = await postOp({ op: "get_job", args: { jobId: batchResult.result.jobId }, requestId: "probe-job" }, 10000)
        .catch(() => null);
      if (j?.result?.done || j?.result?.status === "complete") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    record("batch", "job finished");
  }

  polling = false;
  ws?.close();
  await new Promise((r) => setTimeout(r, 300));

  // ---------------------------------------------------------------------------
  // Cleanup: the probe made hundreds of layers, and leaving them is rude.
  // ---------------------------------------------------------------------------
  try {
    await postOp({
      op: "run_jsx",
      args: {
        undoGroup: false,
        code: `var c = app.project.itemByID(${COMP_ID}); var n = 0;
               for (var i = c.numLayers; i >= 1; i--) {
                 if (c.layer(i).name.indexOf("spaces-probe-") === 0) { c.layer(i).remove(); n++; }
               }
               return n;`,
      },
      requestId: "probe-cleanup",
    }, 120000).then((r) => record("cleanup", `removed ${r?.result ?? "?"} probe layers`));
  } catch (e) {
    record("cleanup", `failed: ${e.message} — remove the spaces-probe-* layers by hand`);
  }

  // ---------------------------------------------------------------------------
  // Summary — the four numbers the issue needs
  // ---------------------------------------------------------------------------
  const stalls = health.filter((h) => h.outcome !== "ok");
  const slowest = health.reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0 });
  const wsStats = ws?.stats?.() ?? { progressCount: 0, lastProgressAt: null };

  console.log("\n──────── summary ────────");
  console.log(`batch wall clock        ${(batchMs / 1000).toFixed(1)}s for ${OPS} ops`);
  console.log(`HTTP /health polls      ${health.length}, ${stalls.length} stalled, slowest ${slowest.ms}ms`);
  console.log(`WS progress events      ${wsStats.progressCount}, last at ${wsStats.lastProgressAt ?? "never"}s`);
  console.log(`frontmost changes       ${events.filter((e) => e.kind === "frontmost").map((e) => `${e.t.toFixed(0)}s:${e.detail}`).join("  ")}`);
  console.log("");
  console.log("Reading it:");
  console.log("  * /health stalled while you were away  -> the panel's own event loop is throttled;");
  console.log("    nothing in ExtendScript is involved, so the fix is App Nap / renderer throttling.");
  console.log("  * /health fine but WS progress stopped -> ExtendScript is being starved.");
  console.log("  * both fine, only the batch slowed     -> AE is just slow; not this issue.");
  console.log("  * nothing stalled at all               -> not reproduced on this run.");
  console.log("");
  console.log("Run again with --baseline (staying put) to get the control, then paste both into issue #25.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
