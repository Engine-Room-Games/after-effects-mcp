#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function ok(msg) { return { ok: true, msg }; }
function fail(msg) { return { ok: false, msg }; }

check("Node >= 20", () => {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return major >= 20 ? ok(`v${process.versions.node}`) : fail(`v${process.versions.node} — upgrade to >= 20`);
});

check("CEP PlayerDebugMode (12)", () => {
  try {
    const v = execSync("defaults read com.adobe.CSXS.12 PlayerDebugMode 2>/dev/null", { encoding: "utf8" }).trim();
    return v === "1" ? ok("on (CSXS.12)") : fail(`value is "${v}" — run npm run enable:debug`);
  } catch {
    return fail("not set — run npm run enable:debug");
  }
});

check("Panel installed", () => {
  const p = path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions", "games.engine-room.ae-mcp");
  if (!fs.existsSync(p)) return fail(`missing at ${p} — run npm run install:panel`);
  const manifest = path.join(p, "CSXS", "manifest.xml");
  if (!fs.existsSync(manifest)) return fail(`manifest missing at ${manifest}`);
  return ok(p);
});

check("bundle.jsx built", () => {
  const p = path.resolve("packages/ae-panel/jsx/bundle.jsx");
  return fs.existsSync(p) ? ok(p) : fail(`missing at ${p} — run npm run build:jsx`);
});

check("MCP server built", () => {
  const p = path.resolve("packages/mcp-server/dist/index.js");
  return fs.existsSync(p) ? ok(p) : fail(`missing at ${p} — run npm run build`);
});

check("AE process running", () => {
  try {
    const out = execSync("pgrep -lf 'After Effects' || true", { encoding: "utf8" }).trim();
    return out ? ok(out.split("\n")[0]) : fail("After Effects is not running — launch AE 2026");
  } catch { return fail("could not check"); }
});

check("Bridge port reachable", async () => {
  const portFile = path.join(os.homedir(), ".engineroom-ae-mcp", "port");
  let port = 7777;
  if (fs.existsSync(portFile)) { try { port = parseInt(fs.readFileSync(portFile, "utf8"), 10); } catch {} }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return fail(`port ${port}: HTTP ${r.status}`);
    const body = await r.json();
    return ok(`port ${port}: ${JSON.stringify(body)}`);
  } catch (e) {
    return fail(`port ${port}: ${e.message} — start AE with panel installed`);
  }
});

(async () => {
  console.log("AE MCP doctor\n");
  let allOk = true;
  for (const c of checks) {
    const res = await c.fn();
    const tag = res.ok ? "OK " : "FAIL";
    console.log(`  [${tag}] ${c.name}: ${res.msg}`);
    if (!res.ok) allOk = false;
  }
  console.log("\n" + (allOk ? "All green." : "Some checks failed — fix the FAIL lines above."));
  process.exit(allOk ? 0 : 1);
})();
