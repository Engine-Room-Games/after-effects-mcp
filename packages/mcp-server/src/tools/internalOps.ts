import { schemas } from "@engineroom/shared";

/**
 * The one way the server sends an internal op (`_render_save`,
 * `_project_path`, …) to the panel.
 *
 * Internal ops are never tools, so they never pass the tool path's
 * classification and write lease. This is where both are held instead:
 *   - the name is typed over `InternalOpMutation`, so an unclassified op does
 *     not compile;
 *   - a `"write"` is refused unless a write lease is held at the moment it is
 *     sent. Every internal write runs inside the call or job that took one
 *     (`render_queue`'s save, `markRendered`'s untick); sending one without
 *     would let it land between two chunks of another session's batch.
 *     A refusal is a bug in the caller, and it says so rather than sending.
 */
export type InternalOp = keyof typeof schemas.InternalOpMutation;
export type SendInternal = (op: InternalOp, args: unknown) => Promise<unknown>;

export class UnleasedInternalWriteError extends Error {
  constructor(op: string) {
    super(
      `Internal error: ${op} changes the project and was about to be sent without the write lock. ` +
        `Nothing was sent. This is a bug in the AE MCP server — please report it with log_issue.`
    );
    this.name = "UnleasedInternalWriteError";
  }
}

export function internalSender(
  runOp: (op: string, args: unknown, write: boolean) => Promise<unknown>,
  writes: { readonly held: string | null }
): SendInternal {
  return async (op, args) => {
    const effect = (schemas.InternalOpMutation as Record<string, string | undefined>)[op];
    if (effect === undefined) throw new Error(`Internal error: ${op} is not a classified internal op; nothing was sent.`);
    if (effect === "write" && writes.held === null) throw new UnleasedInternalWriteError(op);
    return runOp(op, args, effect === "write");
  };
}
