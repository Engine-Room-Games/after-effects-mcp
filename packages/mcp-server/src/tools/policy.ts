import { schemas } from "@engineroom/shared";
import { logger } from "../util/logger.js";

/**
 * Which tools this server offers, decided once at startup from the environment
 * (issue #135). Two switches:
 *
 * - **`AE_MCP_READ_ONLY`** — offer only the tools that look. Every op the
 *   `OpMutation` table classifies `"write"` is gone, and so is every
 *   `"server"` op that writes a file or starts something (`READ_ONLY_SERVER_OPS`
 *   is that decision, made per op).
 * - **`AE_MCP_DISABLE_RUN_JSX`** — offer everything but `run_jsx`, the one tool
 *   that runs code the model wrote.
 *
 * A tool that is switched off is **not registered**, rather than registered
 * and refusing: the model never sees it, so it never plans around it. The call
 * handler refuses it as well, for a client that cached an older list, and
 * `run_batch` refuses a step that names one — a batch step is an op call by
 * another route, and `run_jsx` inside a batch is exactly as capable as
 * `run_jsx` on its own. See "Tool switches" in docs/architecture.md.
 */
export interface ToolPolicy {
  readOnly: boolean;
  runJsx: boolean;
}

export const DEFAULT_POLICY: ToolPolicy = Object.freeze({ readOnly: false, runJsx: true });

export const READ_ONLY_ENV = "AE_MCP_READ_ONLY";
export const DISABLE_RUN_JSX_ENV = "AE_MCP_DISABLE_RUN_JSX";

type Mutation = typeof schemas.OpMutation;
type ServerOp = { [K in keyof Mutation]: Mutation[K] extends "server" ? K : never }[keyof Mutation];

/**
 * Read-only mode's decision for every op that never reaches the bridge.
 *
 * `"keep"`, or the reason it goes. The `OpMutation` classification answers
 * "does this queue behind a write", which is not the question here: `"server"`
 * covers a guide lookup and a panel installer alike. So each one is decided by
 * name, and the mapped type makes the compiler refuse a new server op that has
 * not been — the same "no default" rule `OpMutation` itself follows, for the
 * same reason. An op left out would be decided by silence.
 */
export const READ_ONLY_SERVER_OPS: Record<ServerOp, "keep" | string> = {
  ae_guide: "keep",
  check_setup: "keep",
  list_known_issues: "keep",
  setup_panel: "it installs the After Effects panel and can change Adobe's debug preference",
  init_project: "it writes a project folder to disk",
  log_issue: "it writes to the issue journal on disk",
  mark_issue_reported: "it rewrites an issue journal entry on disk",
  archive_issue: "it rewrites an issue journal entry on disk",
  // Only `run_batch` starts a job, and it is a write. With nothing able to
  // start one, these are three tools that can only ever answer "no such job".
  await_job: "only run_batch starts a job, and run_batch is not available",
  get_job: "only run_batch starts a job, and run_batch is not available",
  cancel_job: "only run_batch starts a job, and run_batch is not available",
};

/**
 * Read one on/off switch from the environment.
 *
 * Unset, empty, `0`, `false`, `no` and `off` are off; `1`, `true`, `yes` and
 * `on` are on. Anything else is **on**, with a warning: these are safety
 * switches, and someone who wrote `AE_MCP_READ_ONLY=enabled` meant it.
 *
 * The one exception is an unexpanded `${…}` placeholder, which is **off**.
 * The `.mcpb` manifest maps each switch to `${user_config.…}`; were that ever
 * passed through unexpanded, failing closed would put every Claude Desktop
 * install into read-only mode without anyone having asked for it. A literal
 * placeholder is not a value anybody chose.
 */
export function parseSwitch(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (/^\$\{.*\}$/.test(v)) {
    logger.warn(`${name} is the unexpanded placeholder ${raw}; treating it as off.`);
    return false;
  }
  logger.warn(`${name}=${raw} is not one of 1/0, true/false, yes/no, on/off; treating it as on.`);
  return true;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  return {
    readOnly: parseSwitch(READ_ONLY_ENV, env[READ_ONLY_ENV]),
    runJsx: !parseSwitch(DISABLE_RUN_JSX_ENV, env[DISABLE_RUN_JSX_ENV]),
  };
}

export function isDefaultPolicy(p: ToolPolicy): boolean {
  return !p.readOnly && p.runJsx;
}

/**
 * Every op this policy switches off, each with the sentence that says why.
 * Empty for the default policy.
 */
export function disabledOps(policy: ToolPolicy): Map<string, string> {
  const off = new Map<string, string>();
  const mutation = schemas.OpMutation as Record<string, "write" | "read" | "server">;
  if (policy.readOnly) {
    for (const [op, effect] of Object.entries(mutation)) {
      if (effect === "write") {
        off.set(op, `the server is in read-only mode (${READ_ONLY_ENV}) and ${op} changes the After Effects project`);
      } else if (effect === "server") {
        const decision = (READ_ONLY_SERVER_OPS as Record<string, string | undefined>)[op];
        // Undecided is off. The mapped type should make this unreachable; if
        // it is reached, read-only mode loses a tool rather than gains a write.
        if (decision !== "keep") {
          off.set(op, `the server is in read-only mode (${READ_ONLY_ENV}) and ${decision ?? "it has not been reviewed for read-only mode"}`);
        }
      }
    }
  }
  if (!policy.runJsx && !off.has("run_jsx")) {
    off.set("run_jsx", `running scripts is turned off in this server's configuration (${DISABLE_RUN_JSX_ENV})`);
  }
  return off;
}

/** The op names this policy registers, in `OpSchemas` order. */
export function enabledOps(policy: ToolPolicy): string[] {
  const off = disabledOps(policy);
  return Object.keys(schemas.OpSchemas).filter((n) => !off.has(n));
}

/**
 * The refusal for a call to a switched-off tool. Reached only by a client
 * holding a tool list from before the switch, or by a model that guessed a
 * name it saw in the guides — so it says that nothing ran, that the user is the
 * one who can change it, and that routing around it is not the answer.
 */
export function disabledToolMessage(name: string, reason: string): string {
  return (
    `${name} is not available: ${reason}. Nothing was run in After Effects. ` +
    `This is the user's configuration, not a failure — tell them ${name} is switched off, ` +
    `and do not try to do the same thing through another tool.`
  );
}

export interface RefusedStep {
  index: number;
  op: string;
  reason: string;
}

/**
 * Batch steps that name a switched-off op. `run_batch` forwards each step's
 * `op` straight to the ExtendScript `OPS` table, so a step is a tool call by
 * another route and is held to the same list.
 */
export function refusedBatchSteps(ops: ReadonlyArray<{ op: string }>, policy: ToolPolicy): RefusedStep[] {
  const off = disabledOps(policy);
  const refused: RefusedStep[] = [];
  ops.forEach((s, i) => {
    const reason = off.get(s.op);
    if (reason !== undefined) refused.push({ index: i, op: s.op, reason });
  });
  return refused;
}

/**
 * The sentence prepended to every carrier of guidance at runtime —
 * `instructions`, `ae_guide`, the guide resources and the prompts — when a
 * switch is on. The guides are generated once and name every tool; they cannot
 * know what this process registered, so this tells the model which of the
 * tools they mention are absent and what to do about it. `null` for the
 * default policy, so a default server's guidance is byte-identical to before.
 */
export function policyNotice(policy: ToolPolicy): string | null {
  if (isDefaultPolicy(policy)) return null;
  if (policy.readOnly) {
    return (
      "**This server is in read-only mode.** The user configured it to offer only the tools that look " +
      "at the project: nothing you call here can change the After Effects project or write a file. " +
      "The guidance below also describes tools that change things (creating and editing layers, keyframes, " +
      "`run_batch`, `run_jsx`, `set_house_style`, `setup_panel`, `log_issue`, …); they are not in your tool " +
      "list. When a task needs one, say so and tell the user that read-only mode is on — do not look for a " +
      "way around it. If `check_setup` names a step that needs `setup_panel`, relay it as something the user " +
      "does with read-only mode off."
    );
  }
  return (
    "**`run_jsx` is switched off on this server.** The user configured it not to run scripts, so the " +
    "guidance below that describes `run_jsx` (and the `extendscript-gotchas` topic) does not apply, and " +
    "`run_batch` refuses a step that names it. Build with the other tools; when a task truly needs a script, " +
    "say so and tell the user that `run_jsx` is off — do not look for a way around it."
  );
}

/** `text` with the policy notice in front of it, or `text` unchanged. */
export function withPolicyNotice(policy: ToolPolicy, text: string): string {
  const notice = policyNotice(policy);
  return notice ? `${notice}\n\n${text}` : text;
}

/** One stderr line at startup naming a non-default policy, so a log says why a tool is missing. */
export function logPolicy(policy: ToolPolicy): void {
  if (isDefaultPolicy(policy)) return;
  const off = disabledOps(policy);
  logger.info(
    `${policy.readOnly ? "Read-only mode" : "run_jsx disabled"}: ${enabledOps(policy).length} tools offered, ` +
      `${off.size} switched off (${[...off.keys()].join(", ")}).`
  );
}
