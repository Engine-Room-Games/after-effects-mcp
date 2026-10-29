// The rules that keep a live run from damaging the maintainer's After Effects.
// Every rule here was learned the hard way (see .claude/skills/orchestrate
// §3 and the Open Recent trap of 2026-10-29), so each is enforced, not advised.
//
// Everything takes its paths and probes as arguments so it is testable with no
// After Effects and no real home directory: tests/unit/live-driver.mjs.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPT_IN_ENV = "AE_MCP_LIVE";
export const OPT_IN_FLAG = "--live";
/** Every scratch directory the driver makes starts with this, under the OS temp dir. */
export const SCRATCH_PREFIX = "ae-mcp-live-";

// ---------------------------------------------------------------------------
// Opt-in
// ---------------------------------------------------------------------------

/**
 * A live run drives the real After Effects on this machine. Nothing reaches it
 * unless the caller said so in so many words: `--live` or AE_MCP_LIVE=1.
 * Anything else — unset, "0", "true", "yes" — is a refusal, so a stray variable
 * from another tool cannot opt anyone in.
 */
export function liveOptIn(argv, env) {
  if (argv.includes(OPT_IN_FLAG)) return { ok: true, via: OPT_IN_FLAG };
  if (env[OPT_IN_ENV] === "1") return { ok: true, via: `${OPT_IN_ENV}=1` };
  return {
    ok: false,
    message:
      "Refusing to touch After Effects: a live run drives the real After Effects on this machine.\n" +
      `Opt in explicitly with ${OPT_IN_FLAG} or ${OPT_IN_ENV}=1, and only when nobody else is using After Effects ` +
      "(one agent at a time — see .claude/skills/orchestrate/SKILL.md §3).",
  };
}

// ---------------------------------------------------------------------------
// Scratch paths
// ---------------------------------------------------------------------------

/** Makes the run's scratch root: a fresh, empty directory under the OS temp dir. */
export function makeScratchRoot(tmp = os.tmpdir()) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmp, SCRATCH_PREFIX)));
}

function norm(p) {
  return path.resolve(p).normalize("NFC");
}

/**
 * The path with symlinks resolved as far as it exists: the longest existing
 * prefix goes through realpath and the not-yet-created rest is appended. A
 * file about to be written does not exist yet, but the folder it lands in
 * does — and a symlink there (scratch/out -> ~/Desktop) must not pass for
 * "inside scratch".
 */
export function realpathLoose(p) {
  let head = norm(p);
  const tail = [];
  for (;;) {
    try {
      return norm(path.join(fs.realpathSync(head), ...tail));
    } catch {
      const up = path.dirname(head);
      if (up === head) return norm(p);
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

/**
 * True only for a path strictly inside `root`, after resolving symlinks on
 * both sides. The root is also compared as given, because macOS hands out
 * /var/... while After Effects reports /private/var/... for the same folder;
 * the target only ever through realpath, so a link cannot smuggle it out.
 */
export function isInside(p, root) {
  if (typeof p !== "string" || !p) return false;
  const candidates = [...new Set([norm(root), realpathLoose(root)])];
  const target = realpathLoose(p);
  return candidates.some((r) => target !== r && target.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

/** Throws unless `p` is inside the scratch root: nothing is ever saved anywhere else. */
export function assertScratchPath(p, root) {
  if (!isInside(p, root)) {
    throw new Error(`Refusing to write ${p}: the live driver only writes inside its scratch folder ${root}.`);
  }
  return p;
}

/**
 * Removes a scratch root — and refuses anything that is not plainly one of
 * ours: a direct child of the temp dir whose name carries the prefix.
 */
export function removeScratchRoot(given, tmp = os.tmpdir()) {
  const root = path.resolve(given); // with or without a trailing separator
  const tmps = [norm(tmp)];
  try {
    tmps.push(norm(fs.realpathSync(tmp)));
  } catch {}
  const parent = norm(path.dirname(root));
  if (!tmps.includes(parent) || !path.basename(root).startsWith(SCRATCH_PREFIX)) {
    throw new Error(`Refusing to delete ${root}: it is not a live-driver scratch folder.`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/** Whether a path (as AE or the prefs file spells it) is one a live run made. */
export function isScratchLike(p) {
  return typeof p === "string" && /[\\/]ae-mcp-live-[^\\/]+[\\/]/.test(p);
}

// ---------------------------------------------------------------------------
// After Effects preferences: Open Recent and workspaces
// ---------------------------------------------------------------------------

/** The folder holding a given AE version's prefs, or the parent of all of them when `version` is omitted. */
export function aePrefsRoot({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") return path.posix.join(home, "Library", "Preferences", "Adobe", "After Effects");
  if (platform === "win32") {
    const appData = env.APPDATA || path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "Adobe", "After Effects");
  }
  return null; // After Effects has never shipped for anything else.
}

/** The newest `<major>.<minor>` prefs folder, which is the running AE's in every case seen so far. */
export function detectAeVersion(prefsRoot) {
  let names;
  try {
    names = fs.readdirSync(prefsRoot);
  } catch {
    return null;
  }
  const versions = names
    .filter((n) => /^\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const [am, an] = a.split(".").map(Number);
      const [bm, bn] = b.split(".").map(Number);
      return am - bm || an - bn;
    });
  return versions.length ? versions[versions.length - 1] : null;
}

/** What gets backed up: the prefs file holding Open Recent, and the workspaces folder. */
export function prefsTargets(prefsRoot, version) {
  const dir = path.join(prefsRoot, version);
  return {
    dir,
    prefsFile: path.join(dir, `Adobe After Effects ${version} Prefs.txt`),
    workspacesDir: path.join(dir, "ModifiedWorkspaces"),
  };
}

/**
 * The Open Recent entries in a prefs file's text. Tolerant on purpose: the
 * format is Adobe's and unversioned. A section whose header mentions "Most
 * Recently Used" is read until the next header; each `"key" = "value"` entry's
 * value is every quoted run on its line and on the continuation lines after it
 * (AE wraps long strings). Returns null when no such section exists at all —
 * which callers must treat as "cannot tell", never as "empty".
 */
export function parseMruEntries(text) {
  const lines = text.split(/\r\n|\n|\r/);
  let inMru = false;
  let found = false;
  const entries = [];
  let current = null;
  const flush = () => {
    if (current !== null && current.trim()) entries.push(current);
    current = null;
  };
  const quoted = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  for (const line of lines) {
    const header = /^\s*\[\s*"(.*)"\s*\]\s*$/.exec(line);
    if (header) {
      flush();
      inMru = /most recently used/i.test(header[1]);
      if (inMru) found = true;
      continue;
    }
    if (!inMru) continue;
    const eq = line.indexOf("=");
    if (eq >= 0 && /^\s*"/.test(line)) {
      flush();
      current = quoted(line.slice(eq + 1));
    } else if (current !== null && /^\s*"/.test(line)) {
      current += quoted(line);
    }
  }
  flush();
  return found ? entries.filter((e) => /[\\/]/.test(e)) : null;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function hashTree(dir) {
  const out = {};
  for (const rel of listFiles(dir)) out[rel.split(path.sep).join("/")] = sha256(path.join(dir, rel));
  return out;
}

/** Where backups live: outside the repo and outside the scratch folder, so neither cleanup can take them. */
export function defaultBackupRoot(home = os.homedir()) {
  return path.join(home, ".engineroom-ae-mcp", "live-prefs-backup");
}

/**
 * Backs up Open Recent and workspaces. After Effects writes its prefs when it
 * quits, so this only makes sense while it is quit — and is refused otherwise.
 * An existing backup is never overwritten without `force`: it may be the only
 * good copy left from a run that did not get to restore.
 */
export async function backupPrefs({ prefsRoot, version, backupRoot, isAeRunning, force = false, now = new Date() }) {
  assertAeVersion(version); // before anything under backupRoot/<version> can be deleted
  if (await isAeRunning()) {
    throw new Error(
      "After Effects is running. Back up its preferences only while it is quit — it rewrites them on quit, " +
        "so a backup taken now records nothing it will not overwrite. Ask before quitting it."
    );
  }
  const t = prefsTargets(prefsRoot, version);
  if (!fs.existsSync(t.prefsFile)) throw new Error(`No prefs file at ${t.prefsFile}; nothing to back up.`);
  const dest = path.join(backupRoot, version);
  if (fs.existsSync(path.join(dest, "manifest.json")) && !force) {
    throw new Error(
      `A backup already exists at ${dest}. It may be the only good copy from an earlier run — restore it ` +
        "(prefs restore) or pass --force to replace it."
    );
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(t.prefsFile, path.join(dest, "prefs.txt"));
  const hadWorkspaces = fs.existsSync(t.workspacesDir);
  if (hadWorkspaces) fs.cpSync(t.workspacesDir, path.join(dest, "ModifiedWorkspaces"), { recursive: true });
  const manifest = {
    version,
    takenAt: now.toISOString(),
    prefsFile: t.prefsFile,
    prefsSha256: sha256(t.prefsFile),
    workspacesDir: t.workspacesDir,
    hadWorkspaces,
    workspaces: hadWorkspaces ? hashTree(t.workspacesDir) : {},
    mru: parseMruEntries(fs.readFileSync(t.prefsFile, "utf8")),
  };
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dest, manifest };
}

export function readBackup(backupRoot, version) {
  assertAeVersion(version);
  const file = path.join(backupRoot, version, "manifest.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Open Recent entries that exist now, were not there at backup time, and were
 * not made by a live run. A non-empty answer means someone used After Effects
 * for real in between — and a byte-identical restore would wipe their changes.
 */
export function foreignMruEntries(backupMru, currentMru) {
  const before = new Set(backupMru ?? []);
  return (currentMru ?? []).filter((e) => !before.has(e) && !isScratchLike(e));
}

/**
 * Restores the backup byte-identical, with After Effects quit, then verifies
 * every hash. Refuses — unless `force` — when the current Open Recent holds
 * entries no live run made, or when it cannot be read to tell.
 */
export async function restorePrefs({ backupRoot, version, isAeRunning, force = false, now = new Date() }) {
  assertAeVersion(version);
  if (await isAeRunning()) {
    throw new Error(
      "After Effects is running. Restore only after it has quit: it rewrites its prefs on quit and would " +
        "overwrite the restore. Ask before quitting it."
    );
  }
  const src = path.join(backupRoot, version);
  const manifest = readBackup(backupRoot, version);
  if (!manifest) throw new Error(`No backup at ${src}. Nothing to restore.`);
  const prefsFile = manifest.prefsFile;
  const currentText = fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile, "utf8") : null;
  const unchanged = currentText !== null && sha256(prefsFile) === manifest.prefsSha256;
  if (!unchanged && !force) {
    const currentMru = currentText === null ? [] : parseMruEntries(currentText);
    if (currentText !== null && currentMru === null) {
      throw new Error(
        `Cannot read the Open Recent list in ${prefsFile}, so cannot tell whether someone used After Effects ` +
          "since the backup. Check by hand, then pass --force to restore anyway."
      );
    }
    const foreign = foreignMruEntries(manifest.mru, currentMru);
    if (foreign.length) {
      throw new Error(
        "Open Recent holds projects no live run made, so After Effects was used for real since the backup:\n" +
          foreign.map((f) => `  ${f}`).join("\n") +
          "\nA byte-identical restore would wipe those. Not restoring — tell the maintainer, or pass --force."
      );
    }
  }
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  fs.copyFileSync(path.join(src, "prefs.txt"), prefsFile);
  fs.rmSync(manifest.workspacesDir, { recursive: true, force: true });
  if (manifest.hadWorkspaces) {
    fs.cpSync(path.join(src, "ModifiedWorkspaces"), manifest.workspacesDir, { recursive: true });
  }
  // Verify, then retire the backup so the next run must take a fresh one.
  const problems = [];
  if (sha256(prefsFile) !== manifest.prefsSha256) problems.push(prefsFile);
  const tree = manifest.hadWorkspaces ? hashTree(manifest.workspacesDir) : {};
  const want = manifest.workspaces;
  for (const k of new Set([...Object.keys(tree), ...Object.keys(want)])) {
    if (tree[k] !== want[k]) problems.push(path.join(manifest.workspacesDir, k));
  }
  if (problems.length) {
    throw new Error(`Restore did not verify; the backup is left in place at ${src}. Differs:\n  ${problems.join("\n  ")}`);
  }
  const retired = `${src}.restored-${now.toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(src, retired);
  return { restored: prefsFile, workspaces: manifest.hadWorkspaces ? manifest.workspacesDir : null, retired };
}

// ---------------------------------------------------------------------------
// Fixture code that must never run
// ---------------------------------------------------------------------------

/**
 * ExtendScript a fixture may not carry. Quitting AE, closing/opening/saving
 * projects and creating new ones are the driver's alone, done only through its
 * guarded helpers — a fixture that did them itself could close or overwrite the
 * maintainer's work.
 *
 * THIS IS NOT A SANDBOX. ExtendScript can reach the same thing a hundred ways
 * (a computed property name, `eval`, a string built at run time) and a regex
 * list will never close them all. It is a guard against a fixture author's
 * *mistake* — the obvious spelling of a dangerous call — and fixtures are
 * reviewed code like any other in this repo. Review them as such.
 */
export const FORBIDDEN_JSX = [
  /\.\s*open\s*\(\s*["']\s*[wae]/i, // a File opened "w", "a" or "e" (write, append, edit); "r" is fine
  /\brenderQueue\s*\.\s*render\s*\(/, // renders write files wherever the queue points
  /\.\s*write(?:ln)?\s*\(/, // File writes (no AE object has a write method)
  /\bapp\s*\.\s*quit\b/,
  /\bapp\s*\.\s*newProject\b/,
  /\bapp\s*\.\s*open\b/,
  /\.\s*close\s*\(/,
  /\.\s*save(?:WithDialog)?\s*\(/,
  /\bexecuteCommand\b/,
  /\bsystem\s*\.\s*callSystem\b/,
  /\bapp\s*\.\s*scheduleTask\b/, // code that runs after the call, outside any check
  /\bapp\s*\.\s*(?:preferences|settings)\s*\.\s*save/, // AE's own prefs: the very thing the backup protects
  /\bapp\s*\.\s*exitAfterLaunchAndEval\b/,
  /\$\s*\.\s*evalFile\b/, // runs a file nobody checked
  // File/Folder renames, runs, copies and folder creation. The scratch files a
  // fixture needs are written by the driver's own writeFile step.
  /\.\s*(?:rename|execute|copy|create)\s*\(/,
];

/**
 * `.remove()` is both how a layer, mask, effect or key is deleted — ordinary
 * work inside the scratch project — and how File and Folder delete from disk.
 * It is allowed only in code that never mentions a file or folder at all
 * (`File`, `Folder`, `app.project.file`, `item.file`, `mainSource.file` …).
 */
const REMOVE = /\.\s*remove\s*\(/;
const TOUCHES_DISK = /\b(?:file|folder)\b/i;

export function forbiddenJsx(code) {
  if (typeof code !== "string") return [];
  const bad = FORBIDDEN_JSX.filter((re) => re.test(code)).map((re) => re.source);
  if (REMOVE.test(code) && TOUCHES_DISK.test(code)) bad.push(`${REMOVE.source} in code that touches a File or Folder`);
  return bad;
}

/**
 * Every piece of ExtendScript a call would run: run_jsx's `code`, the files
 * its `scriptPath` and `libraries` name (read the way the server will read
 * them), and the same for each run_jsx step inside a run_batch. `readFile`
 * returns null for a file it cannot read; that is reported as a problem, since
 * code nobody could check is code that must not run.
 */
export function jsxSourcesOf(tool, args, readFile) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  if (tool === "run_jsx") {
    if (typeof args.code === "string") out.push({ where: "code", code: args.code });
    const files = [args.scriptPath, ...(Array.isArray(args.libraries) ? args.libraries : [])].filter((f) => typeof f === "string");
    for (const f of files) out.push({ where: f, code: readFile(f) });
  }
  if (tool === "run_batch" && Array.isArray(args.ops)) {
    args.ops.forEach((o, i) => {
      if (o && typeof o.op === "string") {
        for (const s of jsxSourcesOf(o.op, o.args, readFile)) out.push({ where: `ops[${i}] ${s.where}`, code: s.code });
      }
    });
  }
  return out;
}

/** Problems with every source a call would run; empty when all of it is allowed. */
export function forbiddenInCall(tool, args, readFile) {
  const problems = [];
  for (const s of jsxSourcesOf(tool, args, readFile)) {
    if (typeof s.code !== "string") problems.push(`${s.where}: cannot be read, so cannot be checked`);
    else {
      const bad = forbiddenJsx(s.code);
      if (bad.length) problems.push(`${s.where}: ${bad.join(", ")}`);
    }
  }
  return problems;
}

/** A prefs version as AE names its folders. Anything else — "../x", "" — could point a delete anywhere. */
export function assertAeVersion(v) {
  if (typeof v !== "string" || !/^\d+\.\d+$/.test(v)) {
    throw new Error(`"${v}" is not an After Effects version as its prefs folders are named (major.minor, e.g. 26.5).`);
  }
  return v;
}

/** major.minor of `app.version` ("26.5x87", "26.5.1x3"). */
export function aeMajorMinor(appVersion) {
  const m = /^(\d+)\.(\d+)/.exec(String(appVersion ?? ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Which tools a fixture may call
// ---------------------------------------------------------------------------

/** Never from a fixture: they install into, or write project folders on, the real machine. */
export const REFUSED_TOOLS = {
  setup_panel: "replaces the installed After Effects panel — shared by every session on this machine",
  init_project: "writes a project folder wherever it is pointed",
};

/**
 * Tools that write files. Allowed only when every path-like argument resolves
 * inside the run's scratch folder; `requiredPaths` must be passed (their
 * default destination is outside it — export_mogrt's is the user's Essential
 * Graphics folder); `projectMustBeOurs` tools write beside, or save, the open
 * project, so the open project must be a scratch one at the moment of the call.
 */
export const FILE_WRITING_TOOLS = {
  export_mogrt: { requiredPaths: ["destDir"] },
  add_to_render_queue: { requiredPaths: ["outputPath"] },
  // Renders write wherever the queue's output modules point, and run_jsx can
  // repoint them after add_to_render_queue checked them: the runner reads the
  // queue back and checks every output path right before the call.
  render_queue: { projectMustBeOurs: true, rendersQueue: true },
  set_house_style: { projectMustBeOurs: true },
};

/**
 * Everything else a fixture may call, by name — an allowlist, so a tool added
 * to the server later is refused here until someone decides which list it
 * belongs on (tests/unit/live-driver.mjs fails until then). These touch only
 * the open project, the server's memory, or files they read. The issue-journal
 * tools write, but the driver points AE_MCP_HOME at its scratch folder.
 */
export const ALLOWED_TOOLS = new Set([
  "list_comps", "get_comp", "get_comp_tree", "create_comp", "set_comp", "delete_comp", "set_active_comp",
  "duplicate_comp", "checkpoint_comp", "list_checkpoints", "revert_comp", "delete_checkpoints",
  "snapshot_comp", "diff_comp", "list_layers", "get_layer_full", "create_text_layer", "create_shape_layer",
  "create_solid_layer", "create_null_layer", "create_adjustment_layer", "create_precomp_layer",
  "create_camera_layer", "create_light_layer", "duplicate_layer", "delete_layer", "set_layer", "parent_layer",
  "reorder_layer", "set_transform", "add_keyframe", "remove_keyframe", "get_keyframes", "set_interpolation",
  "set_temporal_ease", "set_spatial_tangents", "get_expression", "set_expression", "toggle_expression",
  "clear_expression", "list_effects", "add_effect", "remove_effect", "set_effect_param", "set_effect_enabled",
  "list_available_effects", "set_text", "add_text_animator", "set_shape_path", "add_shape_content",
  "set_shape_property", "add_mask", "set_mask", "remove_mask", "add_marker", "remove_marker",
  "screenshot_frame", "screenshot_layer", "run_batch", "get_project_summary", "find_layers",
  "import_footage", "create_footage_layer", "purge_unused_footage", "place_audio_cues",
  "list_render_queue", "remove_render_item", "run_jsx", "get_house_style", "await_job", "get_job",
  "cancel_job", "check_setup", "ae_guide", "log_issue", "list_known_issues", "mark_issue_reported",
  "archive_issue",
]);

const PATH_KEY = /(?:path|dir|file|folder|output)s?$/i;
const LOOKS_ABSOLUTE = /^(?:\/|~|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Every string argument that could name a place on disk, at any depth: a key
 * that says so (outputPath, destDir, scriptPath, libraries…) or a value that
 * is an absolute path. Generic on purpose — a tool's new path argument is
 * caught without anyone listing it.
 */
export function pathLikeArgs(args) {
  const out = [];
  const visit = (v, key, where) => {
    if (typeof v === "string") {
      if (PATH_KEY.test(key) || LOOKS_ABSOLUTE.test(v)) out.push({ where, value: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, key, `${where}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k, where ? `${where}.${k}` : k);
  };
  visit(args, "", "");
  return out;
}

/**
 * Problems with calling `tool` with `args` from a fixture. `inside(path)` says
 * whether a path is in the scratch folder. run_batch steps are checked as the
 * tools they name. A `projectMustBeOurs` tool is reported in `needsOurProject`
 * for the caller to check against the project actually open.
 */
export function checkToolUse(tool, args, inside, where = tool) {
  const problems = [];
  const needsOurProject = [];
  const rendersQueue = [];
  if (tool in REFUSED_TOOLS) problems.push(`${where}: ${tool} is refused in a live run — it ${REFUSED_TOOLS[tool]}`);
  else if (tool in FILE_WRITING_TOOLS) {
    const rule = FILE_WRITING_TOOLS[tool];
    for (const k of rule.requiredPaths ?? []) {
      if (typeof args?.[k] !== "string") problems.push(`${where}: ${tool} writes files, so ${k} must be passed, inside the scratch folder`);
    }
    for (const p of pathLikeArgs(args)) {
      if (!inside(p.value)) problems.push(`${where}: ${tool} writes files, and ${p.where} = ${JSON.stringify(p.value)} is outside the scratch folder`);
    }
    if (rule.projectMustBeOurs) needsOurProject.push(where);
    if (rule.rendersQueue) rendersQueue.push(where);
  } else if (!ALLOWED_TOOLS.has(tool)) {
    problems.push(`${where}: ${tool} is on no list in tests/live/lib/safety.mjs — decide whether it writes files before a fixture calls it`);
  }
  if (tool === "run_batch" && Array.isArray(args?.ops)) {
    args.ops.forEach((o, i) => {
      if (o && typeof o.op === "string") {
        const r = checkToolUse(o.op, o.args, inside, `${where} ops[${i}] (${o.op})`);
        problems.push(...r.problems);
        needsOurProject.push(...r.needsOurProject);
        rendersQueue.push(...r.rendersQueue);
      }
    });
  }
  return { problems, needsOurProject, rendersQueue };
}

/**
 * Problems with a list_render_queue result: every output of every item must
 * write inside the scratch folder. An output with no file is refused too —
 * "cannot tell where" is not "inside".
 */
export function renderOutputsOutside(queue, inside) {
  const problems = [];
  const items = Array.isArray(queue?.items) ? queue.items : null;
  if (!items) return [`could not read the render queue: ${JSON.stringify(queue)?.slice(0, 200)}`];
  for (const it of items) {
    for (const o of Array.isArray(it?.outputs) ? it.outputs : []) {
      if (typeof o?.path !== "string" || !inside(o.path)) {
        problems.push(`render queue item ${it.index ?? "?"} output ${o?.index ?? "?"} writes to ${JSON.stringify(o?.path ?? null)}, outside the scratch folder`);
      }
    }
  }
  return problems;
}
