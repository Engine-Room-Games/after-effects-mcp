import { schemas } from "@engineroom/shared";
import { invalidArgsText } from "../util/errors.js";
import { MAX_BATCH_DEPTH } from "./policy.js";
import { resolveRunJsxSource, type RunJsxArgs } from "./runJsxSource.js";

/**
 * `run_batch` steps held to the same argument contract as the tools they name
 * (issue #157).
 *
 * `batch.jsx` looks each step's `op` up in the ExtendScript `OPS` table and
 * calls it with whatever `args` arrived. Until this, nothing on the server
 * read those args: zod defaults were never applied, a misspelt key passed, a
 * required field could be missing, and the handler did its best with what it
 * got. A step is a tool call by another route, so it is validated exactly as
 * that tool is — against `StrictOpSchemas`, defaults applied, unknown keys
 * refused — and the **parsed** args are what is forwarded, at every depth of
 * nesting.
 *
 * Some tools cannot be a step at all, because part of what they do happens
 * outside After Effects, after the ExtendScript half returns. As a step only
 * that half runs, and the call half-works — the exact failure this exists to
 * end. Those are refused with the reason, and the agent is told to make the
 * call on its own.
 */

/** Ops that are refused as a batch step, each with why. */
export const BATCH_STEP_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  snapshot_comp:
    "the fingerprint is kept by the server between calls, and a batch step never reaches the server — call it on its own, or pass `diff: true` on run_batch",
  diff_comp:
    "it compares against a fingerprint the server keeps, which a batch step never reaches — call it on its own, or pass `diff: true` on run_batch",
  screenshot_frame:
    "the server turns the rendered frame into an image after After Effects returns; as a step you would get a temporary file path and the PNG would be left behind — take the screenshot as its own call after the batch",
  screenshot_layer:
    "the server turns the rendered frame into an image after After Effects returns; as a step you would get a temporary file path and the PNG would be left behind — take the screenshot as its own call after the batch",
  export_mogrt:
    "the server finishes the export after After Effects returns (it writes the template's thumbnail); as a step that half would be skipped — call it on its own",
  render_queue:
    "the render runs in a separate aerender process that the server starts, which a batch step never reaches — call it on its own",
  analyze_motion:
    "the summary is computed by the server from keys the panel reads, and a batch step only reaches the panel, which has no analyze_motion of its own — call it on its own",
  get_house_style:
    "the server summarises the style guide after it is read; as a step `detail` would be ignored and the whole document returned — call it on its own",
});

export interface BatchStepProblem {
  /** Where the step sits, e.g. `ops[0].args.ops[2]`. */
  path: string;
  op: string;
  problem: string;
}

/** Why a step cannot run, or `undefined` for one that is not refused by name. */
export function batchStepRefusal(op: string): string | undefined {
  // Own keys only: `"constructor" in {}` is true, and an inherited name would
  // reach a prototype function as though it were a schema.
  if (!Object.hasOwn(schemas.StrictOpSchemas, op)) {
    return op.startsWith("_")
      ? "it is an internal step of another tool, not a tool, and cannot be called directly"
      : "there is no tool by that name";
  }
  if ((schemas.OpMutation as Record<string, string>)[op] === "server") {
    return "it runs in the MCP server, not in After Effects, and a batch step only reaches After Effects — call it on its own";
  }
  return Object.hasOwn(BATCH_STEP_REFUSALS, op) ? BATCH_STEP_REFUSALS[op] : undefined;
}

/**
 * Validate every step, at every depth, and return the steps as they should be
 * forwarded — parsed, defaults applied, `run_jsx` sources resolved — together
 * with every problem found. The caller forwards nothing unless `problems` is
 * empty: a batch whose first half ran before a bad step stopped it is the
 * half-built result this repo refuses elsewhere.
 *
 * `ops` is the outer list, already through `StrictOpSchemas.run_batch`, so its
 * steps are `{op: string, args?: unknown}` objects. A nested batch's list is
 * parsed by the same schema here before it is walked.
 */
export function prepareBatchSteps(
  ops: ReadonlyArray<{ op: string; args?: unknown }>
): { ops: { op: string; args: unknown }[]; problems: BatchStepProblem[] } {
  const problems: BatchStepProblem[] = [];
  const walk = (
    list: ReadonlyArray<{ op: string; args?: unknown }>,
    prefix: string,
    depth: number
  ): { op: string; args: unknown }[] =>
    list.map((step, i) => {
      const path = `${prefix}ops[${i}]`;
      const op = step.op;
      const refusal = batchStepRefusal(op);
      if (refusal !== undefined) {
        problems.push({ path, op, problem: refusal });
        return { op, args: step.args };
      }
      const schema = (schemas.StrictOpSchemas as Record<string, { safeParse(v: unknown): any }>)[op];
      const parsed = schema.safeParse(step.args ?? {});
      if (!parsed.success) {
        // The tool's own rejection text, minus its header — the path and op
        // already say which call it is.
        const lines = invalidArgsText(op, parsed.error).split("\n").slice(1).map((l) => l.trim().replace(/^- /, ""));
        problems.push({ path, op, problem: `invalid arguments: ${lines.join("; ")}` });
        return { op, args: step.args };
      }
      let args: unknown = parsed.data;
      if (op === "run_jsx") {
        try {
          args = resolveRunJsxSource(args as RunJsxArgs);
        } catch (e) {
          problems.push({ path, op, problem: (e as Error).message });
        }
      } else if (op === "run_batch") {
        if (depth + 1 > MAX_BATCH_DEPTH) {
          problems.push({ path, op, problem: `batches nested more than ${MAX_BATCH_DEPTH} deep are refused` });
        } else {
          const inner = args as { ops: { op: string; args?: unknown }[] };
          args = { ...inner, ops: walk(inner.ops, `${path}.args.`, depth + 1) };
        }
      }
      return { op, args };
    });
  const prepared = walk(ops, "", 1);
  return { ops: prepared, problems };
}

/** The refusal for a batch with any problem in it. Nothing in it ran. */
export function batchProblemsMessage(problems: ReadonlyArray<BatchStepProblem>): string {
  return (
    `run_batch refused, and nothing in the batch was run (${problems.length} ` +
    `${problems.length === 1 ? "step" : "steps"} would not have run as asked):\n` +
    problems.map((p) => `  - ${p.path} (${p.op}): ${p.problem}`).join("\n") +
    `\nA step is held to the same arguments as the tool it names. Fix ${problems.length === 1 ? "that step" : "those steps"} and send the whole batch again.`
  );
}
