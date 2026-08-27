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
//   1. The gap between WebSocket progress events during a long `run_batch`.
//      This is the discriminator. The panel drives chunks on `setTimeout(0)`,
//      and a backgrounded Chromium renderer clamps that to about one tick a
//      second — which would turn a 600-op batch into a ten-minute one and show
//      up here as seconds-long gaps.
//   2. A `/health` poll every second, timed. Note what this does *not* prove:
//      a slow /health while the batch is running is expected, because each
//      evalScript chunk blocks the CEP renderer and the panel cannot answer
//      until it returns. Only a stall while nothing is running counts.
//   3. Whether After Effects is frontmost, sampled each second, so the log
//      says exactly when you left and came back without you timing anything.
//
// Run it, switch Spaces when it tells you to, come back when it tells you to,
// and compare against a `--baseline` run. One run alone proves nothing: the
// question is whether being away changes the numbers, not what they are.
//
// Measured once already, on 2026-08-27, with AE backgrounded on another Space
// for the whole run: 600 ops finished in 47.9s with no progress gap over 6s.
// That is the reported condition, and it did not reproduce.
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
    let completedAt = null;
    let biggestGap = 0;
    const waiters = [];
    ws.addEventListener("open", () => {
      record("ws", "connected");
      resolve({
        close: () => ws.close(),
        stats: () => ({ progressCount, lastProgressAt, completedAt, biggestGap }),
        // The panel announces completion over the WebSocket. That is the only
        // signal available here: get_job is server-resident and the panel has
        // never heard of it, so polling /op for it can only ever time out.
        whenComplete: (ms) => new Promise((resolve) => {
          if (completedAt !== null) return resolve(completedAt);
          const timer = setTimeout(() => resolve(null), ms);
          waiters.push(() => { clearTimeout(timer); resolve(completedAt); });
        }),
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "progress") {
        progressCount++;
        const now = (Date.now() - t0) / 1000;
        // The gap between chunks is the number that matters: a throttled panel
        // shows up as one long silence, not as a lower total.
        if (lastProgressAt !== null) biggestGap = Math.max(biggestGap, now - lastProgressAt);
        lastProgressAt = now;
        // Every chunk would be noise; a heartbeat is enough to see a gap.
        if (progressCount % 5 === 1) record("ws-progress", `${msg.progress}/${msg.total}`);
      } else {
        if (msg.type === "complete" || msg.type === "error") {
          completedAt = (Date.now() - t0) / 1000;
          while (waiters.length) waiters.pop()();
        }
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

  // The batch is async past the inline cutoff: the HTTP reply is only a jobId
  // and the work continues, so the reply time says nothing about when it
  // finished. The panel broadcasts completion on the WebSocket — wait for that.
  let workFinishedAt = null;
  if (batchResult?.result?.jobId && !batchResult.result.done) {
    record("batch", `async job ${batchResult.result.jobId}; waiting for the completion event`);
    workFinishedAt = await ws?.whenComplete(600000);
    record("batch", workFinishedAt === null ? "no completion event within 600s" : `work finished at ${workFinishedAt.toFixed(1)}s`);
  } else {
    workFinishedAt = (Date.now() - t0) / 1000;
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
  console.log(`work finished           ${workFinishedAt === null ? "never" : workFinishedAt.toFixed(1) + "s"} for ${OPS} ops`);
  console.log(`  (HTTP reply came back at ${(batchMs / 1000).toFixed(1)}s — that is just the jobId)`);
  console.log(`HTTP /health polls      ${health.length}, ${stalls.length} stalled, slowest ${slowest.ms}ms`);
  console.log(`WS progress events      ${wsStats.progressCount}, largest gap ${wsStats.biggestGap.toFixed(1)}s, last at ${wsStats.lastProgressAt ?? "never"}s`);
  console.log(`frontmost changes       ${events.filter((e) => e.kind === "frontmost").map((e) => `${e.t.toFixed(0)}s:${e.detail}`).join("  ")}`);
  console.log("");
  console.log("Reading it — compare the away run against the --baseline run, never one alone:");
  console.log("  * A slow /health *during the batch* is expected and is not this issue: each");
  console.log("    evalScript chunk blocks the CEP renderer, so the panel cannot answer while");
  console.log("    ExtendScript is running. Only a stall while nothing is running counts.");
  console.log("  * The number that decides it is the largest gap between WS progress events.");
  console.log("    The panel drives chunks on setTimeout(0); a backgrounded Chromium renderer");
  console.log("    clamps that to ~1/sec, which would show up here as seconds-long gaps and a");
  console.log("    work-finished time several times the baseline.");
  console.log("  * Same finish time and same gaps away as at home -> not reproduced.");
  console.log("");
  console.log("Run again with --baseline (staying put) to get the control, then paste both into issue #25.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
