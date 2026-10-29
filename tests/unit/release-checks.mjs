// The release's checks on its own artifacts (issues #162 and #168).
//
// A release that uploads a binary Apple rejected, or a bundle that does not
// start, looks exactly like a good release from inside release.sh. These pin
// the two decisions — "was notarization accepted?" and "does this artifact
// serve every tool?" — without credentials, Apple, or a release build, and
// assert that release.sh makes both before it tags anything.
//
// Needs `npm run build` (the smoke run starts the built server).
//
//   node tests/unit/release-checks.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const { parseNotaryResult, checkToolList, runnableTargets, smokeServer, wsProblem } = await import(
  pathToFileURL(path.join(root, "scripts", "lib", "release-checks.mjs")).href
);
const { OpSchemas } = await import(pathToFileURL(path.join(root, "packages", "shared", "dist", "schemas.js")).href);
const opNames = Object.keys(OpSchemas);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`release-checks: ${name}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. The notarization verdict (#162).
// ---------------------------------------------------------------------------

const ID = "2efe2717-52ef-43a5-96dc-0797e4ca1041";

await check("Accepted passes and yields the submission id", () => {
  const r = parseNotaryResult(JSON.stringify({ id: ID, status: "Accepted", message: "Processing complete" }));
  assert.equal(r.accepted, true);
  assert.equal(r.id, ID);
});

await check("Invalid fails even though notarytool finished (the bug)", () => {
  const r = parseNotaryResult(JSON.stringify({ id: ID, status: "Invalid", message: "Processing complete" }));
  assert.equal(r.accepted, false);
  assert.equal(r.status, "Invalid");
  assert.equal(r.id, ID, "the id is still returned so the log can be fetched");
});

await check("every other status fails", () => {
  for (const status of ["Rejected", "In Progress", "accepted", "Accepted ", ""]) {
    assert.equal(parseNotaryResult(JSON.stringify({ id: ID, status })).accepted, false, status);
  }
});

await check("no JSON, empty output, or no status is a failure, never a pass", () => {
  for (const text of ["", "Error: HTTP status code: 401", "{}", '{"id":"x"}', "{not json", null, undefined]) {
    assert.equal(parseNotaryResult(text).accepted, false, String(text));
  }
});

await check("Accepted in the message does not pass an Invalid status", () => {
  const r = parseNotaryResult(JSON.stringify({ id: ID, status: "Invalid", message: "Not Accepted" }));
  assert.equal(r.accepted, false);
});

await check("progress text around the JSON is tolerated; the last verdict wins", () => {
  const text = [
    "Conducting pre-submission checks for x.zip and initiating connection to the Apple notary service...",
    JSON.stringify({ id: ID, status: "In Progress" }),
    "Current status: Accepted....",
    JSON.stringify({ id: ID, status: "Accepted", message: "Processing complete" }),
  ].join("\n");
  assert.equal(parseNotaryResult(text).accepted, true);
  const flipped = [JSON.stringify({ id: ID, status: "Accepted" }), JSON.stringify({ id: ID, status: "Invalid" })].join("\n");
  assert.equal(parseNotaryResult(flipped).accepted, false);
});

await check("braces inside strings do not break the scan", () => {
  const r = parseNotaryResult(JSON.stringify({ id: ID, status: "Accepted", message: "a } b { c \" }" }));
  assert.equal(r.accepted, true);
});

// ---------------------------------------------------------------------------
// 2. The tool-list comparison (#168).
// ---------------------------------------------------------------------------

const list = (names) => ({ tools: names.map((name) => ({ name })) });

await check("exactly the defined tools passes", () => {
  assert.equal(checkToolList(list(opNames), opNames).ok, true);
});

await check("one tool missing fails and names it", () => {
  const r = checkToolList(list(opNames.slice(1)), opNames);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [opNames[0]]);
});

await check("an extra tool fails", () => {
  assert.equal(checkToolList(list([...opNames, "surprise"]), opNames).ok, false);
});

await check("one dropped and one duplicated fails although the count matches", () => {
  const names = [...opNames.slice(1), opNames[1]];
  assert.equal(names.length, opNames.length);
  assert.equal(checkToolList(list(names), opNames).ok, false);
});

await check("a malformed result fails", () => {
  for (const r of [null, {}, { tools: "x" }]) assert.equal(checkToolList(r, opNames).ok, false);
});

await check("only host-runnable targets are smoke-run; the rest are reported", () => {
  const targets = [{ name: "macos-arm64" }, { name: "macos-x64" }, { name: "windows-x64" }];
  const names = (r) => r.map((t) => t.name);
  let r = runnableTargets(targets, { platform: "darwin", arch: "arm64", rosetta: false });
  assert.deepEqual(names(r.run), ["macos-arm64"]);
  assert.deepEqual(names(r.skip), ["macos-x64", "windows-x64"]);
  r = runnableTargets(targets, { platform: "darwin", arch: "arm64", rosetta: true });
  assert.deepEqual(names(r.run), ["macos-arm64", "macos-x64"]);
  r = runnableTargets(targets, { platform: "darwin", arch: "x64" });
  assert.deepEqual(names(r.run), ["macos-x64"]);
  r = runnableTargets(targets, { platform: "win32", arch: "x64" });
  assert.deepEqual(names(r.run), ["windows-x64"]);
});

// ---------------------------------------------------------------------------
// 3. The smoke run, end to end, against the real server and against stubs.
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-release-checks-"));
const stub = (name, body) => {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, body);
  return p;
};
// A minimal MCP server over stdio that serves whatever tool names it is given.
const stubServer = (names, extraStdout = "") =>
  stub(
    `stub-${Math.random().toString(36).slice(2)}.mjs`,
    `${extraStdout ? `process.stdout.write(${JSON.stringify(extraStdout)});` : ""}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id == null) continue;
    const result = m.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "0" } }
      : { tools: ${JSON.stringify(names)}.map((name) => ({ name, inputSchema: { type: "object" } })) };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});`
  );

try {
  await check("the built server passes the smoke run", async () => {
    const r = await smokeServer({
      command: process.execPath,
      args: [path.join(root, "packages", "mcp-server", "dist", "index.js")],
      cwd: root,
      opNames,
    });
    assert.equal(r.ok, true, `${r.reason}\n${r.stderr}`);
    assert.equal(r.served, opNames.length);
  });

  await check("a server missing a tool fails the smoke run", async () => {
    const r = await smokeServer({ command: process.execPath, args: [stubServer(opNames.slice(1))], opNames });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, [opNames[0]]);
  });

  await check("a server that writes non-JSON to stdout fails", async () => {
    const r = await smokeServer({ command: process.execPath, args: [stubServer(opNames, "hello\n")], opNames });
    assert.equal(r.ok, false);
    assert.match(r.reason, /non-JSON on stdout/);
  });

  await check("a server that exits at start fails", async () => {
    const r = await smokeServer({ command: process.execPath, args: [stub("die.mjs", "process.exit(3)")], opNames });
    assert.equal(r.ok, false);
    assert.match(r.reason, /exited/);
  });

  await check("a command that cannot start fails", async () => {
    const r = await smokeServer({ command: path.join(scratch, "no-such-binary"), opNames });
    assert.equal(r.ok, false);
  });

  await check("a server that never answers times out rather than hanging", async () => {
    const r = await smokeServer({
      command: process.execPath,
      args: [stub("silent.mjs", "setInterval(() => {}, 1000)")],
      opNames,
      timeoutMs: 500,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /within/);
  });

  await check("the tool switches in the caller's environment do not leak into the smoke run", async () => {
    process.env.AE_MCP_READ_ONLY = "1";
    try {
      const r = await smokeServer({
        command: process.execPath,
        args: [path.join(root, "packages", "mcp-server", "dist", "index.js")],
        cwd: root,
        opNames,
      });
      assert.equal(r.ok, true, r.reason);
    } finally {
      delete process.env.AE_MCP_READ_ONLY;
    }
  });
  // -------------------------------------------------------------------------
  // ws inside each artifact: a real directory, and ws by its contents.
  // -------------------------------------------------------------------------
  const { isWsModuleDir } = await import(
    pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "setup", "paths.js")).href
  );
  const realWs = path.join(root, "node_modules", "ws");
  const artifact = (label, make) => {
    const dir = path.join(scratch, `artifact-${label}`);
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    if (make) make(path.join(dir, "node_modules", "ws"));
    return dir;
  };

  await check("a complete copy of ws passes", () => {
    const dir = artifact("good", (ws) => fs.cpSync(realWs, ws, { recursive: true }));
    assert.equal(wsProblem(dir, isWsModuleDir), null);
  });

  await check("missing, empty, truncated, a file, or a symlink fails", () => {
    assert.match(wsProblem(artifact("missing"), isWsModuleDir), /missing/);
    assert.match(wsProblem(artifact("empty", (ws) => fs.mkdirSync(ws)), isWsModuleDir), /complete copy/);
    const truncated = artifact("truncated", (ws) => {
      fs.mkdirSync(ws);
      fs.copyFileSync(path.join(realWs, "package.json"), path.join(ws, "package.json"));
    });
    assert.match(wsProblem(truncated, isWsModuleDir), /complete copy/);
    assert.match(wsProblem(artifact("file", (ws) => fs.writeFileSync(ws, "")), isWsModuleDir), /not a directory/);
    let linked = null;
    try {
      linked = artifact("symlink", (ws) => fs.symlinkSync(realWs, ws, "junction"));
    } catch {
      /* no symlink permission on this Windows runner */
    }
    if (linked) assert.match(wsProblem(linked, isWsModuleDir), /symlink/);
  });

  await check("both smoke commands check ws before starting anything", () => {
    const src = read("scripts", "lib", "release-checks.mjs");
    const body = (cmd) => src.slice(src.indexOf(`cmd === "${cmd}"`)).split(/\n  if \(cmd ===/)[0];
    for (const cmd of ["smoke-mcpb", "smoke-binaries"]) {
      const b = body(cmd);
      assert.ok(b.includes("wsProblem("), `${cmd} does not check node_modules/ws`);
      assert.ok(b.indexOf("wsProblem(") < b.indexOf("smokeServer("), `${cmd} checks ws after starting`);
    }
  });

  if (process.platform === "darwin") {
    // A fake release dir: a host-runnable macOS "binary" (a shell script that
    // starts the built server, so its launch passes) beside a Windows zip,
    // which this host can never launch but must still check.
    const server = path.join(root, "packages", "mcp-server", "dist", "index.js");
    const fakeDist = (label, { macWs = true, winWs = true } = {}) => {
      const dist = path.join(scratch, `dist-${label}`);
      const targets = [
        { name: `macos-${process.arch}`, exe: "after-effects-mcp", sign: false, ws: macWs,
          body: `#!/bin/sh\nexec "${process.execPath}" "${server}"\n` },
        { name: "windows-x64", exe: "after-effects-mcp.exe", sign: false, ws: winWs, body: "MZ" },
      ];
      for (const t of targets) {
        t.stageName = `after-effects-mcp-0.0.0-${t.name}`;
        const stage = path.join(dist, t.stageName);
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, t.exe), t.body, { mode: 0o755 });
        if (t.ws) fs.cpSync(realWs, path.join(stage, "node_modules", "ws"), { recursive: true });
        execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", stage, path.join(dist, `${t.stageName}.zip`)]);
      }
      fs.writeFileSync(
        path.join(dist, "binaries.json"),
        JSON.stringify({ version: "0.0.0", targets: targets.map(({ name, exe, sign, stageName }) => ({ name, exe, sign, stageName })) })
      );
      return dist;
    };
    const smokeBinaries = (dist) =>
      spawnSync(process.execPath, [path.join(root, "scripts", "lib", "release-checks.mjs"), "smoke-binaries", dist], {
        encoding: "utf8",
      });

    await check("smoke-binaries passes good zips, checking a non-runnable one without launching it", () => {
      const r = smokeBinaries(fakeDist("good"));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /windows-x64: contents checked; not runnable/);
    });

    await check("smoke-binaries fails a macOS zip that lacks ws", () => {
      const r = smokeBinaries(fakeDist("mac-no-ws", { macWs: false }));
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /macos-\S+: FAILED — node_modules\/ws is missing/);
    });

    await check("smoke-binaries fails a Windows zip that lacks ws, though it cannot launch it", () => {
      const r = smokeBinaries(fakeDist("win-no-ws", { winWs: false }));
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /windows-x64: FAILED — node_modules\/ws is missing/);
    });
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. The scripts use the checks, and in the right place.
// ---------------------------------------------------------------------------

await check("sign-and-notarize reads notarytool's verdict instead of trusting --wait", () => {
  const sh = read("scripts", "sign-and-notarize.sh");
  const submit = sh.split("\n").find((l) => l.includes("notarytool submit"));
  assert.ok(submit, "notarytool submit is gone");
  assert.match(submit, /--output-format json/);
  assert.match(submit, /--timeout \S+/, "a stalled scan must fail rather than hang the release");
  assert.match(sh, /release-checks\.mjs notary/);
  assert.match(sh, /notarytool log/, "a rejection should print Apple's log");
});

await check("release.sh smoke-runs every artifact after signing and before tagging", () => {
  const sh = read("scripts", "release.sh");
  const at = (needle) => {
    const i = sh.indexOf(needle);
    assert.ok(i >= 0, `release.sh no longer contains ${needle}`);
    return i;
  };
  const sign = at("./scripts/sign-and-notarize.sh");
  const mcpb = at("release-checks.mjs smoke-mcpb");
  const bins = at("release-checks.mjs smoke-binaries");
  const tag = at("git tag -a");
  const push = at("git push");
  const upload = at("gh release create");
  for (const smoke of [mcpb, bins]) {
    assert.ok(smoke > sign, "the binaries must be smoke-run as signed");
    assert.ok(smoke < tag && smoke < push && smoke < upload, "smoke runs must happen before anything is published");
  }
});

console.log(`release-checks: ${passed} checks passed`);
// Settle before exiting: Node 24 on Windows can assert at exit straight after
// child-process and socket activity (see docs/fragile-areas-server.md).
setTimeout(() => process.exit(0), 200);
