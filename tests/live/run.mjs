#!/usr/bin/env node
// The live After Effects driver: starts a fresh MCP server from THIS checkout
// over stdio and runs the scripted verification recipes against the After
// Effects open on this machine. A live pass is one command.
//
//   node tests/live/run.mjs list                    fixtures, no After Effects
//   node tests/live/run.mjs validate                check fixtures against the schemas, no After Effects
//   node tests/live/run.mjs prefs backup --live     with AE QUIT: back up Open Recent + workspaces
//   node tests/live/run.mjs run [ids|recipe#…] --live
//   node tests/live/run.mjs prefs restore --live    with AE QUIT again: put them back
//
// Safety, enforced rather than advised (.claude/skills/orchestrate/SKILL.md §3):
//   - nothing touches After Effects without --live or AE_MCP_LIVE=1;
//   - `run` refuses without a prefs backup taken while AE was quit
//     (--no-prefs-backup to waive it knowingly);
//   - it starts only on an empty untitled project, never closes a saved one,
//     and saves only inside its own temp scratch folder;
//   - it deletes only that folder, and kills only the server it spawned;
//   - it never quits After Effects, and fixtures cannot either.
//
// Drive this, never the session's own `after-effects` MCP tools: those run the
// main checkout's dist/, not this one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioMcpClient } from "./lib/client.mjs";
import { loadFixtures, recipeNumbersInDocs, selectFixtures, validateFixture } from "./lib/fixtures.mjs";
import { judgeStartingProject, ProjectGuard, runFixture } from "./lib/runner.mjs";
import {
  aeMajorMinor,
  aePrefsRoot,
  assertAeVersion,
  backupPrefs,
  defaultBackupRoot,
  detectAeVersion,
  liveOptIn,
  makeScratchRoot,
  readBackup,
  removeScratchRoot,
  restorePrefs,
} from "./lib/safety.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const serverEntry = path.join(root, "packages", "mcp-server", "dist", "index.js");
const recipesDir = path.join(here, "recipes");

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ae-version") values.aeVersion = argv[++i];
    else if (a.startsWith("--")) flags.add(a);
    else rest.push(a);
  }
  return { flags, values, rest };
}

async function loadOpSchemas() {
  const file = path.join(root, "packages", "shared", "dist", "schemas.js");
  if (!fs.existsSync(file)) throw new Error("packages/shared/dist is missing — run `npm run build` first.");
  return (await import(pathToFileURL(file).href)).OpSchemas;
}

async function aeRunningProbe() {
  const file = path.join(root, "packages", "mcp-server", "dist", "setup", "platform.js");
  if (!fs.existsSync(file)) throw new Error("packages/mcp-server/dist is missing — run `npm run build` first.");
  return (await import(pathToFileURL(file).href)).isAfterEffectsRunning;
}

async function validatedFixtures() {
  const opSchemas = await loadOpSchemas();
  const recipeNumbers = recipeNumbersInDocs(fs.readFileSync(path.join(root, "docs", "verification-recipes.md"), "utf8"));
  const all = loadFixtures(recipesDir);
  const problems = all.flatMap((fx) => validateFixture(fx, { opSchemas, recipeNumbers }));
  return { all, problems };
}

function prefsVersion(values) {
  const prefsRoot = aePrefsRoot();
  if (!prefsRoot) throw new Error(`After Effects does not run on ${process.platform}.`);
  // An explicit version is checked before anything else uses it: it becomes a
  // folder name that a --force backup deletes.
  const version = values.aeVersion !== undefined ? assertAeVersion(values.aeVersion) : detectAeVersion(prefsRoot);
  if (!version) throw new Error(`No After Effects prefs folder under ${prefsRoot}; pass --ae-version <major.minor>.`);
  return { prefsRoot, version };
}

function requireOptIn() {
  const opt = liveOptIn(process.argv, process.env);
  if (!opt.ok) {
    process.stderr.write(opt.message + "\n");
    process.exit(2);
  }
}

async function cmdList() {
  const { all } = await validatedFixtures();
  for (const fx of all) process.stdout.write(`${fx.id.padEnd(34)} recipe ${String(fx.recipe).padStart(2)}  ${fx.title}\n`);
  process.stdout.write(`${all.length} scripted fixtures.\n`);
}

async function cmdValidate() {
  const { all, problems } = await validatedFixtures();
  if (problems.length) {
    process.stderr.write(problems.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(`${all.length} fixtures valid.\n`);
}

async function cmdPrefs(action, { flags, values }) {
  requireOptIn();
  const { prefsRoot, version } = prefsVersion(values);
  const isAeRunning = await aeRunningProbe();
  const backupRoot = defaultBackupRoot();
  if (action === "backup") {
    const { dest, manifest } = await backupPrefs({ prefsRoot, version, backupRoot, isAeRunning, force: flags.has("--force") });
    process.stdout.write(
      `Backed up After Effects ${version} prefs to ${dest}` +
        ` (${manifest.mru === null ? "Open Recent not found in the file" : `${manifest.mru.length} Open Recent entries`},` +
        ` ${Object.keys(manifest.workspaces).length} workspace files).\nLaunch After Effects, then run the recipes.\n`
    );
  } else if (action === "restore") {
    const r = await restorePrefs({ backupRoot, version, isAeRunning, force: flags.has("--force") });
    process.stdout.write(`Restored ${r.restored}${r.workspaces ? ` and ${r.workspaces}` : ""}; backup retired to ${r.retired}.\n`);
  } else {
    throw new Error("prefs needs `backup` or `restore`.");
  }
}

function sanitizedEnv(scratchRoot) {
  const env = { ...process.env, AE_MCP_HOME: path.join(scratchRoot, "journal") };
  // The run is of the full tool set. A policy switch inherited from the shell
  // would hide tools and make every fixture that needs them fail confusingly.
  delete env.AE_MCP_READ_ONLY;
  delete env.AE_MCP_DISABLE_RUN_JSX;
  return env;
}

async function cmdRun({ flags, values, rest }) {
  requireOptIn();
  if (!fs.existsSync(serverEntry)) throw new Error(`${serverEntry} is missing — run \`npm run build\` in this checkout first.`);
  const { all, problems } = await validatedFixtures();
  if (problems.length) throw new Error(`Fixtures do not validate:\n${problems.join("\n")}`);
  const chosen = selectFixtures(all, rest);
  if (!chosen.length) throw new Error(`No fixture matches ${rest.join(" ")}. \`list\` shows them.`);

  const isAeRunning = await aeRunningProbe();
  if (!(await isAeRunning())) throw new Error("After Effects is not running. Launch it on an empty project first (after `prefs backup`).");
  let backupVersion = null;
  if (!flags.has("--no-prefs-backup")) {
    const { version } = prefsVersion(values);
    backupVersion = version;
    if (!readBackup(defaultBackupRoot(), version)) {
      throw new Error(
        `No prefs backup for After Effects ${version}. Scratch projects push real entries off Open Recent.\n` +
          "Quit After Effects (ask first), run `prefs backup --live`, relaunch, then run again — or pass --no-prefs-backup to waive it."
      );
    }
  }

  const scratchRoot = makeScratchRoot();
  const artifactsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-live-report-")));
  const client = new StdioMcpClient({
    command: process.execPath,
    args: [serverEntry],
    cwd: scratchRoot,
    env: sanitizedEnv(scratchRoot),
  }).start();
  // Both spellings: macOS's temp dir is /var/... to Node and /private/var/... to
  // After Effects, and the guard compares the path AE reports.
  const scratchRoots = [...new Set([scratchRoot, path.join(os.tmpdir(), path.basename(scratchRoot))])];
  const guard = new ProjectGuard({ client, scratchRoots });
  let preflightPassed = false;
  const results = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (preflightPassed) {
      // Through the server, BEFORE it is stopped: close the scratch project
      // without saving and leave AE on an empty untitled one, as it was found.
      // Done first because the scratch folder is deleted next — a project
      // left open on deleted files is a dialog waiting for the maintainer.
      try {
        if (client.child.exitCode !== null || client.child.signalCode !== null) throw new Error("the MCP server has already exited");
        await guard.fresh();
      } catch (e) {
        process.stderr.write(
          `\nCould not close the scratch project (${e.message}).\n` +
            "After Effects may still have a scratch project open, saved in a folder this run is about to delete.\n" +
            "Close it WITHOUT saving: File > Close Project, and answer Don't Save.\n"
        );
      }
    }
    await client.close();
    try {
      if (flags.has("--keep-scratch")) process.stdout.write(`Scratch kept at ${scratchRoot}\n`);
      else removeScratchRoot(scratchRoot);
    } catch (e) {
      process.stderr.write(`Could not remove the scratch folder: ${e.message}\n`);
    }
  };
  // Printed on every way out — pass, fail, error, Ctrl-C: the backup is only
  // worth something if it is restored.
  const restoreReminder = () =>
    process.stdout.write(
      "\nAfter Effects is still running — the driver never quits it.\n" +
        (backupVersion
          ? `When done: quit it (ask first), then \`node tests/live/run.mjs prefs restore --live\` to put back the ${backupVersion} prefs backed up before this run.\n`
          : "No prefs backup was taken (--no-prefs-backup): check File > Open Recent by hand after quitting.\n")
    );
  // Ctrl-C, a kill, a closed terminal: all the same — reset the scratch
  // project, kill the server, delete the scratch folder, say what to restore.
  // (Should cleanup itself hang, the client's own exit hook still kills the
  // server when this process goes.)
  let stopping = false;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`\n${sig} — cleaning up what this run created.\n`);
      cleanup().finally(() => {
        restoreReminder();
        process.exit(code);
      });
    });
  }

  try {
    await client.initialize();
    const tools = new Set((await client.listTools()).map((t) => t.name));
    if (!tools.has("run_jsx")) throw new Error("The server offers no run_jsx; the driver needs it to manage its scratch project.");
    const ping = await client.callTool("list_comps", { include: [] });
    if (ping.isError) throw new Error(`The server cannot drive After Effects yet:\n${ping.text}`);
    const state = await guard.state();
    const problem = judgeStartingProject(state);
    if (problem) throw new Error(problem);
    // The backup must be of the prefs THIS After Effects writes on quit. The
    // newest prefs folder is only a guess at that; app.version is the answer.
    if (backupVersion) {
      const running = aeMajorMinor(state.version);
      if (running !== backupVersion) {
        throw new Error(
          `After Effects ${state.version} is running, but the prefs backup is of ${backupVersion}. ` +
            `Its Open Recent would go unprotected. Quit it, run \`prefs backup --live --ae-version ${running ?? "<major.minor>"}\`, relaunch, and run again.`
        );
      }
    }
    preflightPassed = true;

    for (const fx of chosen) {
      const scratchDir = path.join(scratchRoot, fx.id);
      fs.mkdirSync(scratchDir, { recursive: true });
      const r = await runFixture(fx, { client, guard, scratchDir, artifactsDir });
      results.push(r);
      const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "ERROR";
      process.stdout.write(`${mark.padEnd(5)} ${fx.id}  (recipe ${fx.recipe})\n`);
      for (const s of r.steps) for (const f of s.failures) process.stdout.write(`        step ${s.label}: ${f}\n`);
      if (r.error) process.stdout.write(`        ${r.error}\n`);
    }
  } finally {
    await cleanup();
    if (client.noise.length) {
      process.stdout.write(`\nThe server wrote ${client.noise.length} non-JSON-RPC line(s) to stdout — a bug (stdout is sacred):\n`);
      for (const l of client.noise.slice(0, 5)) process.stdout.write(`  ${l.slice(0, 200)}\n`);
    }
    if (results.length) {
      const failed = results.filter((r) => r.status !== "pass");
      fs.writeFileSync(path.join(artifactsDir, "report.json"), JSON.stringify({ at: new Date().toISOString(), checkout: root, results }, null, 2));
      process.stdout.write(`\n${results.length - failed.length}/${results.length} passed. Report and screenshots: ${artifactsDir}\n`);
      const manual = results.filter((r) => r.manual);
      if (manual.length) {
        process.stdout.write("\nStill for a person to check in After Effects (the JSON cannot answer these):\n");
        for (const r of manual) process.stdout.write(`  recipe ${r.recipe} (${r.id}): ${r.manual}\n`);
      }
      if (failed.length) process.exitCode = 1;
    }
    restoreReminder();
  }
}

const USAGE = `Usage: node tests/live/run.mjs <list|validate|run [ids…]|prefs backup|prefs restore> [--live] [--force] [--ae-version X.Y] [--no-prefs-backup] [--keep-scratch]\n`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = parsed.rest;
  if (cmd === "list") return cmdList();
  if (cmd === "validate") return cmdValidate();
  if (cmd === "prefs") return cmdPrefs(rest[0], parsed);
  if (cmd === "run") return cmdRun({ ...parsed, rest });
  process.stderr.write(USAGE);
  process.exit(cmd ? 2 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
