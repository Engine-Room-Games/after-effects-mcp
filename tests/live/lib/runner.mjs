// Runs fixtures through an MCP client. The client is anything with
// `callTool(name, args, {timeoutMs, progressToken})` and a `notifications`
// array — the real StdioMcpClient live, a stub in tests/unit/live-driver.mjs.
//
// The project helpers here are the ONLY code that closes, creates or saves an
// After Effects project, and each refuses to touch one that is not the
// driver's own.

import fs from "node:fs";
import path from "node:path";
import { checkCallResult, resolve } from "./fixtures.mjs";
import { assertScratchPath, checkToolUse, forbiddenInCall, isInside } from "./safety.mjs";

function readFileOrNull(f) {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return null;
  }
}

const jsxString = (s) => JSON.stringify(String(s));

/** ExtendScript that reports what is open, touching nothing. */
export const PROJECT_STATE_JSX =
  "var p = app.project;\n" +
  "return { file: (p && p.file) ? p.file.fsName : null, numItems: p ? p.numItems : 0, version: app.version };";

/**
 * ExtendScript that swaps the open project for a new, empty, untitled one —
 * but throws, closing nothing, if the open project is saved anywhere outside
 * the scratch roots. An untitled project is closed without saving: the
 * preflight established that the untitled project at the start was empty, and
 * from then on the only thing driving After Effects is this run.
 */
/**
 * Each root with exactly one trailing separator, in both spellings, so a
 * prefix test cannot match a sibling folder that merely starts the same way
 * (ae-mcp-live-abc vs ae-mcp-live-abc2), however the root was written.
 */
export function scratchPrefixes(scratchRoots) {
  const out = new Set();
  for (const r of scratchRoots) {
    const bare = String(r).replace(/[\\/]+$/, "");
    out.add(bare + "/");
    out.add(bare + "\\");
  }
  return [...out];
}

export function freshProjectJsx(scratchRoots) {
  return (
    `var roots = [${scratchPrefixes(scratchRoots).map(jsxString).join(", ")}];\n` +
    "var p = app.project;\n" +
    "var f = (p && p.file) ? p.file.fsName : null;\n" +
    "var ours = (f === null);\n" +
    "for (var i = 0; !ours && i < roots.length; i++) if (f.indexOf(roots[i]) === 0) ours = true;\n" +
    "if (!ours) throw new Error('live driver: the open project is not a scratch project (' + f + '); refusing to close it');\n" +
    "if (p) p.close(CloseOptions.DO_NOT_SAVE_CHANGES);\n" +
    "if (!app.project) app.newProject();\n" +
    "return { closed: f, numItems: app.project.numItems, file: app.project.file ? app.project.file.fsName : null };"
  );
}

export function saveProjectJsx(file) {
  return (
    `var f = new File(${jsxString(file)});\n` +
    "app.project.save(f);\n" +
    "return { file: app.project.file ? app.project.file.fsName : null };"
  );
}

/** The preflight's verdict on the project After Effects has open when the run starts. */
export function judgeStartingProject(state) {
  if (!state || typeof state !== "object") return `could not read the open project: ${JSON.stringify(state)}`;
  if (state.file) {
    return (
      `After Effects has a saved project open (${state.file}). The live driver will not close anyone's work: ` +
      "save and close it yourself (File > New > New Project), then run again."
    );
  }
  if (state.numItems > 0) {
    return (
      `After Effects has an untitled project with ${state.numItems} item(s) open. That may be someone's unsaved work, ` +
      "and the driver replaces the open project. Start from File > New > New Project, then run again."
    );
  }
  return null;
}

export class ProjectGuard {
  constructor({ client, scratchRoots }) {
    this.client = client;
    this.scratchRoots = scratchRoots;
  }

  async #jsx(code) {
    const r = await this.client.callTool("run_jsx", { code, undoGroup: false });
    if (r.isError) throw new Error(r.text);
    return r.json;
  }

  state() {
    return this.#jsx(PROJECT_STATE_JSX);
  }

  /** A saved project file inside a scratch root — never an unsaved one, whose folder is nowhere. */
  isOurs(file) {
    return typeof file === "string" && scratchPrefixes(this.scratchRoots).some((p) => file.startsWith(p));
  }

  async fresh() {
    const r = await this.#jsx(freshProjectJsx(this.scratchRoots));
    if (r?.file || r?.numItems !== 0) throw new Error(`a fresh project was not empty: ${JSON.stringify(r)}`);
    return r;
  }

  async save(file) {
    if (!this.scratchRoots.some((root) => { try { assertScratchPath(file, root); return true; } catch { return false; } }))
      throw new Error(`Refusing to save ${file}: outside the scratch folder.`);
    return this.#jsx(saveProjectJsx(file));
  }
}

let tokenCounter = 0;

async function runCall(step, scope, ctx, label) {
  const args = resolve(step.args ?? {}, scope);
  // Checked here, on the resolved arguments and the files as they are on disk
  // now, as well as by the validator: scriptPath/libraries contents and
  // run_batch steps only exist in their final form at run time.
  const bad = forbiddenInCall(step.call, args, readFileOrNull);
  if (bad.length) throw new Error(`fixture code does what only the driver may — ${bad.join("; ")}`);
  // The tool allowlist, on the real paths this time.
  const use = checkToolUse(step.call, args, (p) => isInside(p, ctx.scratchDir));
  if (use.problems.length) throw new Error(`refused: ${use.problems.join("; ")}`);
  if (use.needsOurProject.length) {
    if (!ctx.guard) throw new Error(`refused: ${use.needsOurProject.join(", ")} writes beside the open project, and there is no project guard to check it`);
    const open = await ctx.guard.state();
    if (!ctx.guard.isOurs(open?.file)) {
      throw new Error(`refused: ${use.needsOurProject.join(", ")} writes beside the open project, and ${open?.file ?? "an unsaved project"} is not a scratch project`);
    }
  }
  const token = step.progress ? `live-${process.pid}-${++tokenCounter}` : undefined;
  const t0 = Date.now();
  const result = await ctx.client.callTool(step.call, args, { timeoutMs: step.timeoutMs, progressToken: token });
  const ms = Date.now() - t0;
  if (token !== undefined) {
    const mine = () => ctx.client.notifications.filter((n) => n.params?.progressToken === token);
    result.progress = mine().length;
    ctx.lateProgress.push({ token, seen: result.progress, label, mine });
  }
  result.images?.forEach((img, k) => {
    if (!ctx.artifactsDir) return;
    const file = path.join(ctx.artifactsDir, `${ctx.fixtureId}-${label.replace(/[^\w.-]+/g, "_")}-${k}.png`);
    fs.writeFileSync(file, Buffer.from(img.data, "base64"));
    ctx.images.push(file);
  });
  // Expected values may name what an earlier step saved ("id": "${first.id}").
  const failures = checkCallResult({ ...step, expect: resolve(step.expect ?? [], scope) }, result);
  if (step.save && !result.isError) scope[step.save] = result.json !== undefined ? result.json : result.text;
  return { label, call: step.call, ms, failures, note: step.note };
}

/**
 * Runs one fixture. Stops at the first failing step: later steps use what
 * earlier ones saved, and running them against a half-built comp produces
 * noise, not findings.
 */
export async function runFixture(fx, ctx) {
  const scope = { scratch: ctx.scratchDir };
  const steps = [];
  const run = {
    client: ctx.client,
    guard: ctx.guard,
    scratchDir: ctx.scratchDir,
    artifactsDir: ctx.artifactsDir,
    fixtureId: fx.id,
    images: [],
    lateProgress: [],
  };
  let status = "pass";
  let error;
  try {
    if (ctx.guard) await ctx.guard.fresh();
    for (let i = 0; i < fx.steps.length; i++) {
      const step = fx.steps[i];
      const label = `${i + 1}`;
      let outcome;
      if ("call" in step) {
        outcome = [await runCall(step, scope, run, `${label}-${step.label ?? step.call}`)];
      } else if ("parallel" in step) {
        outcome = await Promise.all(step.parallel.map((s, j) => runCall(s, scope, run, `${label}.${j + 1}-${s.label ?? s.call}`)));
      } else if ("writeFile" in step) {
        const file = assertScratchPath(path.join(ctx.scratchDir, step.writeFile), ctx.scratchDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, resolve(step.content, scope));
        scope[step.save ?? "file"] = file;
        outcome = [{ label: `${label}-writeFile`, failures: [] }];
      } else if ("saveProject" in step) {
        const file = assertScratchPath(path.join(ctx.scratchDir, step.saveProject), ctx.scratchDir);
        if (!ctx.guard) throw new Error("saveProject needs the project guard");
        scope.project = await ctx.guard.save(file);
        outcome = [{ label: `${label}-saveProject`, failures: [] }];
      }
      steps.push(...outcome);
      if (outcome.some((o) => o.failures.length)) {
        status = "fail";
        break;
      }
    }
    // A progress notification after its call's response is the bug of #82.
    if (run.lateProgress.length) await new Promise((r) => setTimeout(r, ctx.settleMs ?? 500));
    for (const p of run.lateProgress) {
      const late = p.mine().length - p.seen;
      if (late > 0) {
        steps.push({ label: `${p.label}-progress-order`, failures: [`${late} progress notification(s) arrived after the response`] });
        status = "fail";
      }
    }
  } catch (e) {
    status = "error";
    error = e.message;
  }
  return { id: fx.id, recipe: fx.recipe, title: fx.title, status, error, steps, manual: fx.manual, images: run.images };
}
