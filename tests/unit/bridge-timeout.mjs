// Timed-out vs unreachable: the two halves of a bridge failure.
//
// Worth a test of its own because the only difference a user ever sees is which
// sentence they get, and the two sentences prescribe opposite actions — one says
// restart After Effects, the other says specifically do not. Getting the
// discrimination wrong is silent: both paths still "return an error".
//
//   node tests/unit/bridge-timeout.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { BridgeTimeoutError, BridgeUnreachableError, isTimeoutError } = await import(
  dist("util", "errors.js")
);
const { opTimeoutMs } = await import(dist("bridge", "httpClient.js"));
const { buildNextSteps } = await import(dist("setup", "check.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

// ---------- isTimeoutError ----------

// What Node's fetch actually rejects with for AbortSignal.timeout.
class Named extends Error {
  constructor(name, message, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = name;
  }
}

check("TimeoutError is a timeout", () =>
  assert.equal(isTimeoutError(new Named("TimeoutError", "The operation was aborted due to timeout")), true)
);
check("AbortError is a timeout", () =>
  assert.equal(isTimeoutError(new Named("AbortError", "aborted")), true)
);
// undici wraps the real reason on `cause` behind a bare `TypeError: fetch failed`.
check("wrapped TimeoutError is a timeout", () =>
  assert.equal(
    isTimeoutError(new Named("TypeError", "fetch failed", new Named("TimeoutError", "timed out"))),
    true
  )
);
check("ECONNREFUSED is not a timeout", () => {
  const cause = new Named("Error", "connect ECONNREFUSED 127.0.0.1:7777");
  cause.code = "ECONNREFUSED";
  assert.equal(isTimeoutError(new Named("TypeError", "fetch failed", cause)), false);
});
check("plain error is not a timeout", () =>
  assert.equal(isTimeoutError(new Error("health HTTP 500")), false)
);
check("non-errors are not timeouts", () => {
  assert.equal(isTimeoutError(undefined), false);
  assert.equal(isTimeoutError(null), false);
  assert.equal(isTimeoutError("TimeoutError"), false);
});
check("a self-referential cause terminates", () => {
  const e = new Named("TypeError", "fetch failed");
  e.cause = e;
  assert.equal(isTimeoutError(e), false);
});

// ---------- the two messages ----------

const timeout = new BridgeTimeoutError(7777, 120_000, { op: "run_jsx" });
const unreachable = new BridgeUnreachableError(7777, new Error("connect ECONNREFUSED"));

check("timeout names the op and the limit", () => {
  assert.match(timeout.message, /run_jsx/);
  assert.match(timeout.message, /120s/);
});
check("timeout says it is not a lost connection", () =>
  assert.match(timeout.message, /not a lost connection/i)
);
check("timeout forbids the remedies that waste the user's time", () => {
  assert.match(timeout.message, /Do not restart After Effects/i);
  assert.match(timeout.message, /setup_panel/);
  assert.match(timeout.message, /check_setup/);
});
check("timeout covers the two reported causes", () => {
  assert.match(timeout.message, /dialog/i, "modal dialogs block the bridge the same way (#23)");
  assert.match(timeout.message, /Space/, "the macOS desktop-switch report (#25)");
});
check("timeout says how to raise the limit", () =>
  assert.match(timeout.message, /AE_MCP_OP_TIMEOUT_MS/)
);
// The 2s health probe has its own budget; telling the reader to raise the op
// timeout would not change it, so that line has to be suppressed there.
check("the health probe does not advertise an override it does not use", () => {
  const health = new BridgeTimeoutError(7777, 2000, { op: "health", adjustable: false });
  assert.doesNotMatch(health.message, /AE_MCP_OP_TIMEOUT_MS/);
  assert.match(health.message, /2s/);
});
check("the two diagnoses share no remedy", () => {
  assert.match(unreachable.message, /Cannot reach/i);
  assert.doesNotMatch(unreachable.message, /did not answer within/i);
  assert.doesNotMatch(timeout.message, /Cannot reach the After Effects panel at/i);
});

// Issue #175: a write that timed out landed afterwards, and the agent was told
// "within 3s" after 5.0s — the panel-version probe ran first and also waited.
check("timeout always says the call may still land", () =>
  assert.match(timeout.message, /may still run and land after this message/)
);
check("a timeout restated with its timing names the whole span and where it went", () => {
  const e = new BridgeTimeoutError(7777, 3000, { op: "create_null_layer" });
  e.withTiming({ totalMs: 5012, gateMs: 2004, queueMs: 0 });
  assert.match(e.message, /gave up 5\.0s after it was made/);
  assert.match(e.message, /limit is 3s/);
  assert.match(e.message, /other 2\.0s went on earlier steps of this call/);
  assert.match(e.message, /Of that, 2\.0s checking the panel's version/);
  assert.doesNotMatch(e.message, /did not answer within/);
  assert.doesNotMatch(e.message, /behind this session's own earlier write/, "no queue wait happened");
});
check("time nobody itemised is not pinned on a step that did not take it", () => {
  // render_queue's save timing out after its prepare round trip, or a re-send
  // after a refusal and a port search: the earlier time is real but neither
  // the gate's nor the queue's.
  const e = new BridgeTimeoutError(7777, 3000, { op: "_render_save" });
  e.withTiming({ totalMs: 15_000, gateMs: 3, queueMs: 0 });
  assert.match(e.message, /gave up 15s after it was made/);
  assert.match(e.message, /other 12s went on earlier steps of this call\.$/m);
  assert.doesNotMatch(e.message, /panel's version|own earlier write|before the request was sent/);
});
check("a render_queue save timeout says only the save can land, under the tool's name", () => {
  const e = new BridgeTimeoutError(7777, 3000, { op: "_render_save" }).asRenderStep("save");
  assert.match(e.message, /`render_queue`/);
  assert.doesNotMatch(e.message, /_render_save/);
  assert.match(e.message, /No render was started/);
  assert.match(e.message, /Only the project save may still complete/);
  assert.match(e.message, /call render_queue again/);
  assert.doesNotMatch(e.message, /may still run and land|Do not re-send/);
  // Timing restated afterwards keeps the render wording.
  e.withTiming({ totalMs: 15_000, gateMs: 3, queueMs: 0 });
  assert.match(e.message, /did not answer `render_queue` in time/);
  assert.match(e.message, /No render was started/);
});
check("a render_queue prepare timeout says nothing was saved or started", () => {
  const e = new BridgeTimeoutError(7777, 3000, { op: "_render_prepare" }).asRenderStep("prepare");
  assert.match(e.message, /Nothing was saved and no render was started/);
  assert.doesNotMatch(e.message, /_render_prepare|may still run and land|Do not re-send/);
});
check("a timeout that kept to its limit keeps the plain sentence", () => {
  const e = new BridgeTimeoutError(7777, 3000, { op: "set_layer" });
  e.withTiming({ totalMs: 3040, gateMs: 2, queueMs: 0 });
  assert.match(e.message, /did not answer within 3s for `set_layer`/);
});

// ---------- opTimeoutMs ----------

const ENV = "AE_MCP_OP_TIMEOUT_MS";
delete process.env[ENV];

check("default op timeout", () => assert.equal(opTimeoutMs("get_comp"), 120_000));
check("no op named still gets the default", () => assert.equal(opTimeoutMs(), 120_000));
// The panel waits up to 120s for saveFrameToPng's file to land, so the server
// must not give up at the same instant.
check("expectedly slow ops get longer", () => {
  for (const op of ["run_batch", "run_jsx", "screenshot_frame", "screenshot_layer", "purge_unused_footage"]) {
    assert.equal(opTimeoutMs(op), 300_000, `${op} should get the slow-op budget`);
  }
});
check("screenshot budget exceeds the panel's own 120s PNG wait", () =>
  assert.ok(opTimeoutMs("screenshot_frame") > 120_000)
);

check("the env override applies to every op, slow ones included", () => {
  process.env[ENV] = "45000";
  assert.equal(opTimeoutMs("get_comp"), 45_000);
  assert.equal(opTimeoutMs("run_batch"), 45_000);
});
check("a nonsense override falls back rather than disabling the timeout", () => {
  for (const bad of ["", "   ", "soon", "0", "-1"]) {
    process.env[ENV] = bad;
    assert.equal(opTimeoutMs("get_comp"), 120_000, `AE_MCP_OP_TIMEOUT_MS=${JSON.stringify(bad)}`);
  }
});
delete process.env[ENV];

// ---------- check_setup's nextSteps ----------
//
// nextSteps is what the agent reads aloud, so the busy case has to *lead* with
// "wait" and must never contain the word restart as an instruction.

const ok = (name) => ({ name, ok: true, detail: "" });
const bad = (name) => ({ name, ok: false, detail: "", fix: "…" });

const healthyExceptBridge = [
  ok("platform"),
  ok("panelAssetsPresent"),
  ok("cepDebugMode"),
  ok("panelInstalled"),
  ok("panelUpToDate"),
  ok("panelDependencies"),
  ok("afterEffectsRunning"),
  bad("bridgeReachable"),
];

check("a busy bridge is told to wait, not to restart", () => {
  const steps = buildNextSteps(healthyExceptBridge, false, true);
  assert.match(steps[0], /^Wait/, "the first thing said must be to wait");
  assert.match(steps.join("\n"), /check_setup/);
  assert.match(steps.join("\n"), /dialog/i);
  assert.match(steps.join("\n"), /desktop/i);
  assert.match(steps[0], /do not restart/i, "restarting must be named only to forbid it");
  assert.doesNotMatch(steps.join("\n"), /setup_panel/, "reinstalling cannot help a busy panel");
});

check("a silent bridge still gets the restart advice", () => {
  const steps = buildNextSteps(healthyExceptBridge, false, false);
  assert.match(steps.join("\n"), /reopen After Effects/i);
  assert.doesNotMatch(steps.join("\n"), /^Wait/m);
});

// A timeout is not evidence that the install is sound, so a genuinely broken
// one must keep its own remediation rather than being told to sit and wait.
check("a broken install outranks the busy case", () => {
  const steps = buildNextSteps(
    healthyExceptBridge.map((c) => (c.name === "panelDependencies" ? bad(c.name) : c)),
    false,
    true
  );
  assert.match(steps.join("\n"), /setup_panel/);
  assert.doesNotMatch(steps[0], /^Wait/);
});

check("ready short-circuits regardless of the flag", () =>
  assert.match(buildNextSteps([], true, true)[0], /Everything is connected/)
);

console.log(`bridge-timeout: ${passed} checks passed`);
