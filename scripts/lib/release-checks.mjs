#!/usr/bin/env node
// The two checks a release makes on its own artifacts before anything is
// tagged (issues #162 and #168). Both used to be missing, and both failures
// look like success from inside release.sh:
//
//   notary   `notarytool submit --wait` returns once Apple has *finished*, not
//            once Apple has *approved*. It can exit 0 with `"status": "Invalid"`,
//            and the script carried on and uploaded a binary Gatekeeper refuses.
//            The verdict is read from the JSON and only "Accepted" passes.
//
//   smoke    The .mcpb and the binaries were uploaded without ever being run.
//            Each is now started over stdio, sent `initialize` and `tools/list`,
//            and must serve exactly the tools OpSchemas defines.
//
// The decisions are pure functions so tests/unit/release-checks.mjs can pin
// them without credentials, Apple or a release build. The CLI around them is
// what the shell scripts call:
//
//   node scripts/lib/release-checks.mjs notary <notarytool-json-file>
//       exit 0 and print the submission id when Accepted; exit 1 otherwise.
//   node scripts/lib/release-checks.mjs smoke-mcpb <file.mcpb>
//   node scripts/lib/release-checks.mjs smoke-binaries <dist-release-dir>
//       smoke-runs every artifact this host can execute, from the archive that
//       will actually be uploaded, not from the staging folder.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------- notary

/**
 * Reads notarytool's `--output-format json` output and decides whether the
 * submission was accepted. Tolerates progress text around the JSON (older
 * notarytool versions print it to stdout), and takes the *last* object that
 * carries a `status`, which is the final verdict under `--wait`.
 *
 * Only an exact `status: "Accepted"` passes. Anything else — `Invalid`,
 * `Rejected`, `In Progress` (a --wait that timed out), a missing status, no
 * JSON at all — is a failure, because the cost of a false pass is a release
 * Gatekeeper blocks on every user's machine.
 *
 * @returns {{accepted: boolean, status: string|null, id: string|null, message: string|null, reason: string}}
 */
export function parseNotaryResult(text) {
  const candidates = [];
  const src = String(text ?? "");
  // Every balanced {...} span at top level, in order. notarytool's JSON is a
  // single flat object, so this is enough without a streaming parser.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(src.slice(start, i + 1));
          if (obj && typeof obj === "object" && !Array.isArray(obj)) candidates.push(obj);
        } catch {
          /* not JSON; keep scanning */
        }
      }
    }
  }
  const verdict = candidates.filter((o) => typeof o.status === "string").pop();
  if (!verdict) {
    return {
      accepted: false,
      status: null,
      id: candidates.find((o) => typeof o.id === "string")?.id ?? null,
      message: null,
      reason: "notarytool printed no JSON status — the verdict is unknown, so it is treated as a failure",
    };
  }
  const id = typeof verdict.id === "string" ? verdict.id : null;
  const message = typeof verdict.message === "string" ? verdict.message : null;
  const accepted = verdict.status === "Accepted";
  return {
    accepted,
    status: verdict.status,
    id,
    message,
    reason: accepted ? "accepted" : `Apple's verdict was "${verdict.status}", not "Accepted"`,
  };
}

// ----------------------------------------------------------------- smoke

/**
 * Compares a `tools/list` result against the op names the server is built
 * from. Exactly the same set, the same rule CI applies to the dev build: a
 * tool missing from the artifact is the realistic regression, and a count
 * alone would hide one dropped plus one duplicated.
 *
 * @returns {{ok: boolean, served: number, expected: number, missing: string[], extra: string[], reason: string}}
 */
export function checkToolList(result, opNames) {
  const tools = result && Array.isArray(result.tools) ? result.tools : null;
  if (!tools) {
    return { ok: false, served: 0, expected: opNames.length, missing: [...opNames], extra: [], reason: "tools/list returned no tools array" };
  }
  const names = tools.map((t) => t && t.name);
  const served = new Set(names);
  const wanted = new Set(opNames);
  const missing = opNames.filter((n) => !served.has(n));
  const extra = [...served].filter((n) => !wanted.has(n));
  const dupes = names.length !== served.size;
  const ok = !missing.length && !extra.length && !dupes && names.length === opNames.length;
  let reason = "ok";
  if (missing.length) reason = `not served: ${missing.join(", ")}`;
  else if (extra.length) reason = `served but not in OpSchemas: ${extra.join(", ")}`;
  else if (!ok) reason = `served ${names.length} tools for ${opNames.length} ops`;
  return { ok, served: names.length, expected: opNames.length, missing, extra, reason };
}

/** A port nothing listens on, so the smoke run can never reach a live panel. */
async function unusedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Starts `command args…` as an MCP server over stdio, runs initialize and
 * tools/list, and checks the list. Never throws; the caller decides.
 *
 * The environment is the caller's minus the two tool switches (a release
 * machine with AE_MCP_READ_ONLY set would otherwise fail every artifact), and
 * AE_MCP_PORT is pinned to a dead port: tools/list does not need After
 * Effects, and a smoke run must not talk to a panel another session is using.
 */
export async function smokeServer({ command, args = [], cwd, opNames, timeoutMs = 30000 }) {
  const env = { ...process.env, AE_MCP_PORT: String(await unusedPort()) };
  delete env.AE_MCP_READ_ONLY;
  delete env.AE_MCP_DISABLE_RUN_JSX;

  return new Promise((resolve) => {
    let settled = false;
    let stdinTimer = null;
    let stderr = "";
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdinTimer) clearTimeout(stdinTimer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ...res, stderr: stderr.slice(-2000) });
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `no tools/list answer within ${timeoutMs / 1000}s` }),
      timeoutMs
    );

    child.on("error", (err) => finish({ ok: false, reason: `could not start: ${err.message}` }));
    child.on("exit", (code, signal) =>
      finish({ ok: false, reason: `exited before answering tools/list (code ${code}, signal ${signal})` })
    );
    child.stderr.on("data", (d) => (stderr += d));
    // A child that exits (or closes its stdin) before reading what we send
    // turns our next write into an asynchronous EPIPE on `child.stdin`. With no
    // listener that error is thrown and takes the whole release script down,
    // racing the "exit" handler above. The exit is the real reason, so let it
    // report; the fallback only covers a child that closed stdin and lives on.
    child.stdin.on("error", (err) => {
      if (settled || stdinTimer) return;
      stdinTimer = setTimeout(
        () => finish({ ok: false, reason: `stdin closed before answering tools/list (${err.code || err.message})` }),
        2000
      );
      stdinTimer.unref?.();
    });

    let buf = "";
    const pending = new Map();
    let nextId = 0;
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // stdout is sacred: anything that is not JSON-RPC there is itself a
          // broken artifact, because it corrupts the client's stream.
          finish({ ok: false, reason: `non-JSON on stdout: ${line.slice(0, 200)}` });
          return;
        }
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    const send = (method, params) =>
      new Promise((r) => {
        const id = ++nextId;
        pending.set(id, r);
        // Once the child is gone, or its stdin is, the answer can only come
        // from "exit", the stdin fallback or the timeout — never write.
        if (settled || !child.stdin.writable) return;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    (async () => {
      const init = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "release-smoke", version: "1" },
      });
      if (!init.result) return finish({ ok: false, reason: `initialize failed: ${JSON.stringify(init.error)}` });
      if (!settled && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      }
      const list = await send("tools/list", {});
      if (!list.result) return finish({ ok: false, reason: `tools/list failed: ${JSON.stringify(list.error)}` });
      finish(checkToolList(list.result, opNames));
    })().catch((err) => finish({ ok: false, reason: err.message }));
  });
}

/**
 * Which binary targets this host can actually execute. A Windows build cannot
 * run on the Mac that cuts the release; an x64 macOS build runs on Apple
 * silicon only under Rosetta. What is skipped is reported, never hidden.
 */
export function runnableTargets(targets, { platform = process.platform, arch = process.arch, rosetta = false } = {}) {
  const run = [];
  const skip = [];
  for (const t of targets) {
    const name = t.name || "";
    let ok = false;
    if (platform === "darwin" && name.startsWith("macos-")) {
      const tArch = name.slice("macos-".length);
      ok = tArch === arch || (tArch === "x64" && arch === "arm64" && rosetta);
    } else if (platform === "win32" && name.startsWith("windows-")) {
      ok = name.slice("windows-".length) === arch;
    }
    (ok ? run : skip).push(t);
  }
  return { run, skip };
}

/**
 * Why `node_modules/ws` inside an unpacked artifact is unusable, or null when
 * it is fine. `setup_panel` copies that folder into the CEP extension, so it
 * must be a real directory (never a symlink, never inlined) and must be `ws`
 * by its contents — `isWsModuleDir` is the server's own test, passed in so the
 * two cannot drift. Validated by contents, never by `existsSync`.
 */
export function wsProblem(artifactDir, isWsModuleDir) {
  const ws = path.join(artifactDir, "node_modules", "ws");
  let stat;
  try {
    stat = fs.lstatSync(ws);
  } catch {
    return "node_modules/ws is missing";
  }
  if (stat.isSymbolicLink()) return "node_modules/ws is a symlink, not a real directory";
  if (!stat.isDirectory()) return "node_modules/ws is not a directory";
  if (!isWsModuleDir(ws)) return "node_modules/ws is not a complete copy of ws (package.json, index.js, lib/websocket.js)";
  return null;
}

async function loadIsWsModuleDir() {
  const p = path.join(root, "packages", "mcp-server", "dist", "setup", "paths.js");
  if (!fs.existsSync(p)) throw new Error("packages/mcp-server is not built — run `npm run build` first");
  return (await import(pathToFileURL(p).href)).isWsModuleDir;
}

// ------------------------------------------------------------------- CLI

async function loadOpNames() {
  const p = path.join(root, "packages", "shared", "dist", "schemas.js");
  if (!fs.existsSync(p)) throw new Error("packages/shared is not built — run `npm run build` first");
  const { OpSchemas } = await import(pathToFileURL(p).href);
  return Object.keys(OpSchemas);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ae-mcp-${label}-`));
}

function report(label, res) {
  if (res.ok) {
    console.log(`    ${label}: started, served all ${res.served} tools`);
    return true;
  }
  console.error(`    ${label}: FAILED — ${res.reason}`);
  if (res.stderr) console.error(res.stderr.replace(/^/gm, "      | "));
  return false;
}

async function cli(argv) {
  const [cmd, target] = argv;
  if (cmd === "notary") {
    const r = parseNotaryResult(fs.readFileSync(target, "utf8"));
    if (r.accepted) {
      console.log(r.id ?? "");
      return 0;
    }
    console.error(`notarization not accepted: ${r.reason}${r.message ? ` (${r.message})` : ""}`);
    if (r.id) console.log(r.id);
    return 1;
  }

  if (cmd === "smoke-mcpb") {
    const opNames = await loadOpNames();
    const isWs = await loadIsWsModuleDir();
    const dir = tempDir("mcpb");
    try {
      execFileSync("unzip", ["-q", target, "-d", dir], { stdio: "inherit" });
      const problem = wsProblem(dir, isWs);
      if (problem) {
        console.error(`    ${path.basename(target)}: FAILED — ${problem}`);
        return 1;
      }
      // Claude Desktop runs the bundle on its own Node; the release machine's
      // is the closest stand-in available.
      const res = await smokeServer({
        command: process.execPath,
        args: [path.join(dir, "server", "index.js")],
        cwd: dir,
        opNames,
      });
      return report(path.basename(target), res) ? 0 : 1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (cmd === "smoke-binaries") {
    const opNames = await loadOpNames();
    const isWs = await loadIsWsModuleDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "binaries.json"), "utf8"));
    let rosetta = false;
    if (process.platform === "darwin" && process.arch === "arm64") {
      try {
        execFileSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
        rosetta = true;
      } catch {
        /* no Rosetta */
      }
    }
    const { run } = runnableTargets(manifest.targets, { rosetta });
    const runnable = new Set(run.map((t) => t.name));
    if (!run.length) console.error("    no binary target is runnable on this host, so none can be launched");
    let failed = run.length ? 0 : 1;
    // Every target's zip is unpacked and checked — the executable, the ws
    // copy, the signature — whether or not this host can launch it. Only the
    // launch itself is skipped for a target the host cannot execute.
    for (const t of manifest.targets) {
      // Run what ships: the zip, unpacked fresh. The staging folder is an input
      // to the zip, and a signature or file the archiver dropped only shows here.
      const zip = path.join(target, `${t.stageName}.zip`);
      if (!fs.existsSync(zip)) {
        console.error(`    ${t.name}: FAILED — ${zip} was not produced`);
        failed++;
        continue;
      }
      const dir = tempDir(t.name);
      try {
        if (process.platform === "darwin") execFileSync("/usr/bin/ditto", ["-x", "-k", zip, dir], { stdio: "inherit" });
        else execFileSync("unzip", ["-q", zip, "-d", dir], { stdio: "inherit" });
        const folder = path.join(dir, t.stageName);
        const exe = path.join(folder, t.exe);
        if (!fs.existsSync(exe)) {
          console.error(`    ${t.name}: FAILED — ${t.exe} is not in the zip`);
          failed++;
          continue;
        }
        const problem = wsProblem(folder, isWs);
        if (problem) {
          console.error(`    ${t.name}: FAILED — ${problem}`);
          failed++;
          continue;
        }
        if (t.sign && process.platform === "darwin") {
          try {
            execFileSync("codesign", ["--verify", "--strict", exe], { stdio: "pipe" });
          } catch (err) {
            console.error(`    ${t.name}: FAILED — the binary inside the zip does not verify: ${String(err.stderr || err.message).trim()}`);
            failed++;
            continue;
          }
        }
        if (!runnable.has(t.name)) {
          console.log(`    ${t.name}: contents checked; not runnable on this host — uploaded without a launch`);
          continue;
        }
        const res = await smokeServer({ command: exe, cwd: folder, opNames });
        if (!report(t.name, res)) failed++;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return failed ? 1 : 0;
  }

  console.error("usage: release-checks.mjs notary <json-file> | smoke-mcpb <file.mcpb> | smoke-binaries <dist-dir>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}
