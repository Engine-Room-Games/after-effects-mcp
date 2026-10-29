import { schemas } from "@engineroom/shared";
import { READ_ONLY_SERVER_OPS } from "./policy.js";

/**
 * MCP tool annotations (issue #165): what a client needs to auto-approve a
 * read and warn before a delete. Derived, never hand-kept per tool — a list
 * written here would go stale the first time somebody added an op, and a write
 * mislabelled read-only is a client approving it without asking.
 *
 * - **readOnlyHint** — `OpMutation === "read"`, or a `"server"` op that
 *   read-only mode keeps (`READ_ONLY_SERVER_OPS[op] === "keep"`). That table is
 *   already the per-op answer to "does this server op change anything", and the
 *   compiler refuses a new server op until it has one.
 * - **destructiveHint** — for a tool that is not read-only, true when it can
 *   take something away from the project: its name starts with a removing verb
 *   (`DESTRUCTIVE_VERBS`), or it runs arbitrary steps (`run_jsx`, and
 *   `run_batch`, which can carry any of the others). Everything else — create,
 *   add, set, duplicate, import, export — is reported as non-destructive. Under
 *   the letter of the spec a `set_*` overwrites a value, but every call here is
 *   one undo step, and flagging every keyframe edit as destructive would train
 *   a user to click through the warning that matters on `delete_comp`.
 * - **idempotentHint** — true for read-only tools only. No write is claimed to
 *   be idempotent: several (`add_*`, `create_*`, `duplicate_*`) plainly are not,
 *   and a hint that is wrong is worse than none.
 * - **openWorldHint** — false everywhere: every tool acts on the local After
 *   Effects session or local files, never an external service.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Verbs whose op removes or replaces project content wholesale. */
export const DESTRUCTIVE_VERBS = ["delete", "remove", "purge", "revert", "clear"] as const;

/** Ops that run caller-supplied steps, so can do anything a destructive op can. */
export const ARBITRARY_OPS: ReadonlySet<string> = new Set(["run_jsx", "run_batch"]);

export function isReadOnlyTool(name: string): boolean {
  const effect = (schemas.OpMutation as Record<string, string | undefined>)[name];
  if (effect === "read") return true;
  if (effect === "server") return (READ_ONLY_SERVER_OPS as Record<string, string>)[name] === "keep";
  // "write", or unclassified — treated as a write, like isWriteOp.
  return false;
}

export function isDestructiveTool(name: string): boolean {
  if (isReadOnlyTool(name)) return false;
  if (ARBITRARY_OPS.has(name)) return true;
  const verb = name.split("_")[0];
  return (DESTRUCTIVE_VERBS as readonly string[]).includes(verb);
}

export function toolAnnotations(name: string): ToolAnnotations {
  const readOnly = isReadOnlyTool(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: isDestructiveTool(name),
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}
