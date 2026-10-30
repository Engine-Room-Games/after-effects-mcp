// A batch an old panel drives itself, followed over /events (issue #243).
//
// The server follows such a batch so await_job can say when it ends. It must
// never wait for ever: once the end can no longer arrive, the job ends as
// lost — how far it was last seen, not to re-send it, and that the panel can
// now be updated. Pinned here, against the real JobManager:
//   - the socket closing and not coming back within the grace loses the job;
//     coming back in time, to the same panel, does not;
//   - coming back to a different panel instance (AE restarted) loses it;
//   - silence past the limit loses it, and every progress event resets that;
//   - a job that ends normally is simply dropped.
//
//   node tests/unit/followed-jobs.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;
const { FollowedJobs } = await import(dist("jobs", "followedJobs.js"));
const { JobManager } = await import(dist("jobs", "manager.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`followed-jobs FAILED: ${name}`);
    throw e;
  }
}

function setup(opts = {}) {
  const jobs = new JobManager();
  let instance = "panel-1";
  const f = new FollowedJobs(jobs, { graceMs: 80, silenceMs: 400, instance: () => instance, ...opts });
  return { jobs, f, setInstance: (i) => (instance = i) };
}

function assertLost(st, why) {
  assert.equal(st.status, "failed");
  assert.match(st.error, /Lost track of batch j1/);
  assert.match(st.error, why);
  assert.match(st.error, /last progress the panel reported was 50 of 300/);
  assert.match(st.error, /may have been applied/);
  assert.match(st.error, /Do NOT send the batch again/);
  assert.match(st.error, /setup_panel/);
  // Issue #262: quit first — setup_panel refuses while After Effects is open.
  assert.match(st.error, /quit After Effects completely, then run setup_panel, then ask them to reopen After Effects\./);
}

await check("a closed socket that does not come back loses the job", async () => {
  const { jobs, f } = setup();
  jobs.register("j1", 300);
  f.follow("j1");
  jobs.reportProgress("j1", 50, 300);
  f.socketClosed();
  await sleep(150);
  assertLost(jobs.get("j1"), /event socket closed/);
  await sleep(300);
  assert.equal(f.size, 0);
});

await check("a socket back in time, to the same panel, keeps following; the end then drops it", async () => {
  const { jobs, f } = setup();
  jobs.register("j1", 300);
  f.follow("j1");
  f.socketClosed();
  await sleep(30);
  f.socketReopened();
  await sleep(120);
  assert.equal(jobs.get("j1").status, "running");
  jobs.complete("j1", { results: [], errors: [] });
  await sleep(300);
  assert.equal(jobs.get("j1").status, "completed");
  assert.equal(f.size, 0);
});

await check("a different panel after a reconnect means After Effects restarted: lost", async () => {
  const { jobs, f, setInstance } = setup();
  jobs.register("j1", 300);
  f.follow("j1");
  jobs.reportProgress("j1", 50, 300);
  f.socketClosed();
  setInstance("panel-2");
  f.socketReopened();
  assertLost(jobs.get("j1"), /After Effects restarted/);
});

await check("silence past the limit loses the job; each progress event resets it", async () => {
  const { jobs, f } = setup();
  jobs.register("j1", 300);
  f.follow("j1");
  for (let i = 1; i <= 4; i++) {
    await sleep(200);
    jobs.reportProgress("j1", i === 4 ? 50 : i * 10, 300);
  }
  assert.equal(jobs.get("j1").status, "running", "progress kept it alive past one silence window");
  await sleep(500);
  assertLost(jobs.get("j1"), /reported nothing about it/);
});

await check("a cancelled job is dropped, never reported lost", async () => {
  const { jobs, f } = setup();
  jobs.register("j1", 300);
  f.follow("j1");
  jobs.cancel("j1");
  await sleep(300);
  assert.equal(f.size, 0);
  f.socketClosed();
  await sleep(150);
  assert.equal(jobs.get("j1").status, "cancelled");
});

console.log(`followed-jobs: ${passed} checks passed`);
