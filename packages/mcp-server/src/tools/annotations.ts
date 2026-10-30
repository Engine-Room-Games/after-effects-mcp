import { schemas } from "@engineroom/shared";
import { z } from "zod";

/**
 * MCP tool annotations (issue #165): what a client needs to auto-approve a
 * read and warn before a delete. Derived, never hand-kept per tool — a list
 * written here would go stale the first time somebody added an op, and a write
 * mislabelled read-only is a client approving it without asking.
 *
 * - **readOnlyHint** — `OpMutation === "read"`, or a `"server"` op that
 *   `ServerOpEffect` classifies `"read"`. Not `READ_ONLY_SERVER_OPS`: that
 *   table drops `get_job`/`await_job` from read-only mode for having nothing to
 *   read, which is not the same as writing.
 * - **destructiveHint** — for a tool that is not read-only, true when it can
 *   lose something:
 *     - its name starts with a removing verb (`DESTRUCTIVE_VERBS`);
 *     - it runs arbitrary steps (`run_jsx`, and `run_batch`, which can carry
 *       any of the others);
 *     - it can replace a file on disk, which After Effects' undo cannot bring
 *       back: its arguments have an `overwrite` field, or `OpDiskWrite` says
 *       `"overwrites"`.
 *   Everything else — create, add, set, duplicate, import — is reported as
 *   non-destructive. Under the letter of the spec a `set_*` overwrites a value,
 *   but every such call is one undo step, and flagging every keyframe edit
 *   would train a user to click through the warning that matters.
 * - **idempotentHint** — true for read-only tools, and for writes whose verb is
 *   in `IDEMPOTENT_VERBS`. Every one of those assigns absolute state (a value,
 *   an index, a flag, an expression), never a delta, so a repeat with the same
 *   arguments lands on the same state. `add_*`, `create_*`, `duplicate_*`,
 *   `import_*` plainly are not; `delete_*`/`remove_*` are left false because a
 *   repeat addresses by id or index, and a removal can shift what an index
 *   names next time.
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

/** Verbs whose op sets absolute state — the same call twice changes nothing more. */
export const IDEMPOTENT_VERBS = ["set", "toggle", "clear", "parent", "reorder"] as const;

/** Ops that run caller-supplied steps, so can do anything a destructive op can. */
export const ARBITRARY_OPS: ReadonlySet<string> = new Set(["run_jsx", "run_batch"]);

const verbOf = (name: string) => name.split("_")[0]!;

export function isReadOnlyTool(name: string): boolean {
  const effect = (schemas.OpMutation as Record<string, string | undefined>)[name];
  if (effect === "read") return true;
  if (effect === "server") return (schemas.ServerOpEffect as Record<string, string>)[name] === "read";
  // "write", or unclassified — treated as a write, like isWriteOp.
  return false;
}

const overwriteFieldCache = new Map<string, boolean>();
/** True when the op's arguments carry an `overwrite` field — read off the schema. */
export function hasOverwriteField(name: string): boolean {
  let v = overwriteFieldCache.get(name);
  if (v === undefined) {
    const schema = (schemas.OpSchemas as Record<string, z.ZodType | undefined>)[name];
    const json = schema ? (z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as { properties?: object }) : {};
    v = !!json.properties && Object.hasOwn(json.properties, "overwrite");
    overwriteFieldCache.set(name, v);
  }
  return v;
}

/** True when the op can replace a file on disk, outside After Effects' undo. */
export function overwritesDisk(name: string): boolean {
  return hasOverwriteField(name) || (schemas.OpDiskWrite as Record<string, string>)[name] === "overwrites";
}

export function isDestructiveTool(name: string): boolean {
  if (isReadOnlyTool(name)) return false;
  if (ARBITRARY_OPS.has(name)) return true;
  if ((DESTRUCTIVE_VERBS as readonly string[]).includes(verbOf(name))) return true;
  return overwritesDisk(name);
}

export function isIdempotentTool(name: string): boolean {
  if (isReadOnlyTool(name)) return true;
  return (IDEMPOTENT_VERBS as readonly string[]).includes(verbOf(name));
}

const cache = new Map<string, ToolAnnotations>();
export function toolAnnotations(name: string): ToolAnnotations {
  let a = cache.get(name);
  if (!a) {
    a = {
      readOnlyHint: isReadOnlyTool(name),
      destructiveHint: isDestructiveTool(name),
      idempotentHint: isIdempotentTool(name),
      openWorldHint: false,
    };
    cache.set(name, a);
  }
  return { ...a };
}
