#!/usr/bin/env node
// Same diagnosis the check_setup tool performs, printed for a human.

import fs from "node:fs";
import path from "node:path";
import { loadSetup } from "./lib/setup.mjs";

const { checkSetup } = await loadSetup();
const report = await checkSetup();

console.log("AE MCP doctor\n");

const major = parseInt(process.versions.node.split(".")[0], 10);
line(major >= 20, "Node >= 20", `v${process.versions.node}`, "Upgrade to Node 20 or newer.");

for (const c of report.checks) {
  line(c.ok, c.name, c.detail, c.fix);
}

// Build artefacts are a developer concern, so they live here rather than in the
// shared check used by the MCP tool.
const bundle = path.resolve("packages/ae-panel/jsx/bundle.jsx");
line(fs.existsSync(bundle), "bundle.jsx built", bundle, "Run `npm run build:jsx`.");
const dist = path.resolve("packages/mcp-server/dist/index.js");
line(fs.existsSync(dist), "MCP server built", dist, "Run `npm run build`.");

if (report.nextSteps.length > 0) {
  console.log("\nNext steps:");
  for (const s of report.nextSteps) console.log(`  - ${s}`);
}

const allOk = report.ready && fs.existsSync(bundle) && fs.existsSync(dist) && major >= 20;
console.log("\n" + (allOk ? "All green." : "Some checks failed."));
process.exit(allOk ? 0 : 1);

function line(ok, name, detail, fix) {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${name}: ${detail}`);
  if (!ok && fix) console.log(`         ${fix}`);
}
