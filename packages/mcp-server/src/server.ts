import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { diagnosticPortCandidates } from "./bridge/discovery.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { schemas } from "@engineroom/shared";
import { HttpClient } from "./bridge/httpClient.js";
import { WsClient } from "./bridge/wsClient.js";
import { createPanelGate } from "./bridge/panelGate.js";
import { WriteQueue, mergeWait, type QueueWait, type WriteLease } from "./bridge/writeQueue.js";
import { JobManager, isTerminal, unknownJobMessage } from "./jobs/manager.js";
import {
  RenderRunner,
  saveAndCheckFootage,
  logRenderStart,
  occupiedOutputs,
  resolveAerender,
  type RenderPlan,
} from "./render/aerender.js";
import { markRendered } from "./render/markDone.js";
import { aerenderCandidates, afterEffectsInstallRoots } from "./setup/platform.js";
import { SnapshotStore } from "./snapshots/store.js";
import type { CompFingerprint } from "./snapshots/store.js";
import { diffFingerprints } from "./snapshots/diff.js";
import { descriptions } from "./tools/descriptions.js";
import { AeError, BridgeResetError, BridgeTimeoutError, BridgeUnreachableError, aeErrorText, invalidArgsText } from "./util/errors.js";
import { resolveRunJsxSource, type RunJsxArgs } from "./tools/runJsxSource.js";
import { toolAnnotations } from "./tools/annotations.js";
import {
  disabledOps,
  disabledToolMessage,
  logPolicy,
  policyFromEnv,
  refusedBatchSteps,
  withPolicyNotice,
  type ToolPolicy,
} from "./tools/policy.js";
import { batchProblemsMessage, prepareBatchSteps } from "./tools/batchSteps.js";
import { findUnsafeArgKeys, unsafeArgsMessage } from "./util/argsSafety.js";
import { checkSetup } from "./setup/check.js";
import { installPanel } from "./setup/install.js";
import { ClientKind, detectClient, scaffold } from "./setup/scaffold.js";
import { unknownOpMessage } from "./setup/panelVersion.js";
import { packageVersion } from "./setup/paths.js";
import { renderWhatsNew } from "./tools/whatsNew.js";
import { GUIDES, PROMPTS, SERVER_INSTRUCTIONS, getGuide, getPrompt } from "./generated/content.js";
import { archiveIssue, listIssues, logIssue, markReported } from "./issues/journal.js";
import { JournalCache, annotateFailure } from "./issues/failures.js";
import { applyHouseStyleDetail } from "./style/summary.js";
import {
  checkFootageExists,
  checkRenderOutput,
  prepareMogrtDestination,
  type MogrtDestination,
} from "./files/destinations.js";
import { imageContent } from "./util/pngImage.js";
import { logger } from "./util/logger.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const { OpSchemas } = schemas;

// Ops whose handler returns metadata + base64 PNG and should be packaged as an MCP image content.
const VISION_OPS = new Set(["screenshot_frame", "screenshot_layer"]);
// Ops that may return an async jobId envelope from the panel.
const ASYNC_OPS = new Set(["run_batch"]);
// Jobs/await/etc. are handled in-server, not forwarded as-is. The setup ops
// especially must never touch the bridge — they exist precisely for the case
// where the panel is not installed yet, which is also when the issue journal is
// most likely to be written to.
export const SERVER_OPS = new Set([
  "await_job",
  "get_job",
  "cancel_job",
  "check_setup",
  "setup_panel",
  "init_project",
  "ae_guide",
  "log_issue",
  "list_known_issues",
  "mark_issue_reported",
  "archive_issue",
]);
// Half server-resident: only the panel can read After Effects, only the server
// can remember anything between calls. These forward an internal read op to
// gather a fingerprint and keep the result in `SnapshotStore` — they are not in
// SERVER_OPS, because unlike those they do touch the bridge.
const SNAPSHOT_OPS = new Set(["snapshot_comp", "diff_comp"]);

/**
 * True for an op that changes the After Effects session, from the one table
 * that is checked against `OpSchemas` at test time (`schemas.OpMutation`).
 *
 * A hand-kept list here would go stale the first time somebody added a tool,
 * and the failure would be silent — a new writing op classified by omission as
 * a read, interleaving with a batch. Anything this cannot classify is treated
 * as a write, which costs a little serialization and never costs correctness.
 */
export function isWriteOp(name: string): boolean {
  const effect = (schemas.OpMutation as Record<string, string | undefined>)[name];
  return effect === undefined ? true : effect === "write";
}

/**
 * `ae_guide` exists because the two better carriers are not universal. The
 * condensed core goes out in `instructions`, which some clients drop on the
 * floor; the full text is exposed as resources, which fewer clients support
 * still. Tools are the one thing every MCP client can reach, so the guidance has
 * to be available as one — otherwise a Cursor or Codex user gets 60-odd tools
 * and none of the knowledge that stops them being misused.
 */
const GUIDE_URI_PREFIX = "ae://guide/";

// Schema for await_job/get_job/cancel_job (defined inline in shared/schemas.ts).
const AwaitJobSchema = schemas.StrictOpSchemas.await_job;
const GetJobSchema = schemas.StrictOpSchemas.get_job;
const CancelJobSchema = schemas.StrictOpSchemas.cancel_job;

export interface CreateServerOptions {
  /**
   * The bridge client to use instead of one discovered from the environment.
   * A test hands in one pointed at a stale port with its own candidate list, so
   * the drift path can be exercised without asking anything real on the machine.
   */
  bridge?: HttpClient;
  /**
   * Which tools to offer, instead of the one read from `AE_MCP_READ_ONLY` and
   * `AE_MCP_DISABLE_RUN_JSX`. Lets a test build each mode in one process.
   */
  policy?: ToolPolicy;
  /**
   * How long `cancel_job` watches a batch, once the panel has accepted the
   * cancel, for the stop to be reported. A test shortens it.
   */
  cancelSettleMs?: number;
}

/**
 * The panel answers a cancel only after the chunk ahead of it has run (the two
 * share one evalScript chain), and the next `_continue_job` returns at once on
 * a cancelled job, so the stop normally lands within milliseconds of the
 * answer. This is the ceiling, not the expectation.
 */
const CANCEL_SETTLE_MS = 15_000;

export function createServer(opts: CreateServerOptions = {}) {
  // Decided once, here: a tool list that changed mid-session would need a
  // list_changed notification, and nothing about these switches is dynamic.
  const policy = opts.policy ?? policyFromEnv();
  const disabled = disabledOps(policy);
  logPolicy(policy);

  const server = new Server(
    { name: "after-effects-mcp", version: "0.5.2" },
    {
      capabilities: { tools: {}, logging: {}, prompts: {}, resources: {} },
      // Clients that honour this fold it into the system prompt, which is the
      // only way non-Claude clients get the cross-cutting guidance at all —
      // skills and slash commands do not exist outside Claude's own clients.
      // With a switch on, prefixed by the sentence naming what is absent —
      // the generated text names every tool and cannot know which were
      // registered. Byte-identical to before when both switches are off.
      instructions: withPolicyNotice(policy, SERVER_INSTRUCTIONS),
    }
  );

  const bridge = opts.bridge ?? new HttpClient();
  const jobs = new JobManager();
  // One writer at a time. See bridge/writeQueue.ts for why the panel's own
  // evalScript mutex is not enough.
  const writes = new WriteQueue();
  // render_queue's jobs run in an aerender process this server owns; see
  // render/aerender.ts. When a job ends, its verified items are unticked in the
  // live queue so they do not render twice — once, as one named undo step, and
  // a write to the project, so it queues behind any other write like one.
  const renders = new RenderRunner(jobs, {
    // Bounded wait (#163): the job settles after this answers, so an
    // unbounded queue wait held await_job hostage to an unrelated edit.
    onRendered: (items) => markRendered(writes, (op, a) => bridge.runOp(op, a), items),
  });
  const snapshots = new SnapshotStore();
  // Follows the bridge's port rather than copying it: see wsClient.ts.
  const ws = new WsClient(bridge, jobs);
  const panelGate = createPanelGate(bridge);
  // Restarting After Effects rebinds the same port, so no port change fires;
  // the event socket dropping and reopening is the signal that a (possibly
  // new) panel is answering, and the verdict about the old one is void (#156).
  ws.onReopen(() => panelGate.invalidate());
  ws.start();
  // The event socket and its reconnect timer are what kept an orphaned server
  // alive after its client went (#163). Closing the server releases them, so
  // the process can end by draining its event loop — never by process.exit,
  // which crashes Node 24 on Windows after a fetch.
  const priorOnClose = server.onclose;
  server.onclose = () => {
    ws.stop();
    priorOnClose?.();
  };

  // The issue journal, pushed rather than pulled: every failed tool call is
  // answered with the journal entries that match its tool and error text, so
  // the pointer arrives at the moment it is needed and nothing else in the
  // session pays for the journal's size (issue #102). `annotateFailure` never
  // throws and never touches the message when nothing matches — see
  // issues/failures.ts. The cache is per process, like `SnapshotStore`.
  const journalCache = new JournalCache();
  const fail = (tool: string, message: string) => errorResult(annotateFailure(journalCache, tool, message));

  /**
   * `cancel_job` for a chunked run_batch (issue #158). `ok:true` is said only
   * once the batch is seen to have stopped; the stop's own report — the ops
   * that ran before it — is what the job settles with, so await_job and
   * get_job return the partial result rather than nothing.
   */
  const cancelBatchJob = async (jobId: string) => {
    const name = "cancel_job";
    const st = jobs.get(jobId);
    if (!st) return fail(name, unknownJobMessage(jobId, "Nothing was cancelled."));
    if (isTerminal(st.status)) {
      return fail(
        name,
        `Job ${jobId} is already over — it had ${st.status === "completed" ? "completed" : st.status === "failed" ? "failed" : "been cancelled"} ` +
          "before this cancel_job, so nothing is running under this id and nothing was cancelled now. " +
          `await_job({jobId: "${jobId}"}) returns its result.`
      );
    }
    let answer: { known: boolean; error?: string };
    try {
      answer = await bridge.cancel(jobId);
    } catch (e) {
      return fail(
        name,
        `The cancel was NOT confirmed by the panel, so batch ${jobId} may still be running — do not report it as ` +
          `stopped. get_job({jobId: "${jobId}"}) shows whether it is still progressing.\n\n${(e as Error).message}`
      );
    }
    if (!answer.known) {
      // The panel holds JOBS in ExtendScript memory, and it holds none for this
      // id: After Effects or the panel restarted since the batch started. The
      // batch is not running, and no completion event will ever arrive, so the
      // job is settled here rather than left for await_job to wait out.
      const lost =
        `The panel has no record of batch ${jobId} (${answer.error ?? "unknown job"}): After Effects or the ` +
        "panel restarted after the batch started, so it is no longer running and its result is lost. Nothing was " +
        "cancelled. Ops that ran before the restart may be applied — read the comp back rather than re-sending the batch.";
      jobs.fail(jobId, lost);
      return fail(name, lost);
    }
    jobs.markCancelling(jobId);
    const after = await jobs.settle(jobId, opts.cancelSettleMs ?? CANCEL_SETTLE_MS);
    const status = after?.status ?? "cancelling";
    if (status === "cancelled") {
      const r = (after?.result ?? {}) as { results?: unknown[]; errors?: unknown[]; total?: number; undoSteps?: number; note?: string };
      return textResult({
        ok: true,
        jobId,
        status,
        stopped: true,
        // A non-transactional batch records a failed op in `errors` and not in
        // `results`, so the ops that ran are the two together.
        opsRun:
          Array.isArray(r.results) || Array.isArray(r.errors)
            ? (r.results?.length ?? 0) + (r.errors?.length ?? 0)
            : undefined,
        opsSucceeded: Array.isArray(r.results) ? r.results.length : undefined,
        opsFailed: Array.isArray(r.errors) ? r.errors.length : undefined,
        total: r.total ?? after?.total,
        undoSteps: r.undoSteps,
        note:
          "The batch stopped at a chunk boundary. The ops that ran before it are applied and stay applied" +
          (r.note ? ` (${r.note})` : "") +
          `. await_job({jobId: "${jobId}"}) returns the partial result.`,
      });
    }
    if (status === "completed") {
      return textResult({
        ok: false,
        jobId,
        status,
        stopped: false,
        note: "The batch had already run to the end before the cancel took effect: every op in it was applied. " +
          `await_job({jobId: "${jobId}"}) returns its result.`,
      });
    }
    if (status === "failed") {
      return textResult({
        ok: false,
        jobId,
        status,
        stopped: false,
        error: after?.error,
        note: "The batch failed before the cancel took effect; `error` says how. Ops before the failure stay applied.",
      });
    }
    return textResult({
      ok: false,
      jobId,
      status: "cancelling",
      stopped: false,
      progress: after?.progress,
      total: after?.total,
      note:
        "The panel accepted the cancel, but the batch has not yet reported stopping. Do not tell the user it has " +
        `stopped yet: call await_job({jobId: "${jobId}"}), which returns once it does, with the ops that ran before it.`,
    });
  };

    // Best-effort health probe; non-fatal. A refusal here is the cheapest moment
  // to notice the port file was stale (issue #92): the search costs a couple
  // of seconds now, against a failed first op later.
  bridge.health().then(
    (h) => logger.info(`Bridge healthy on port ${h.port}`),
    async (e) => {
      logger.warn(`Bridge not reachable yet: ${(e as Error).message}`);
      if (!(e instanceof BridgeUnreachableError)) return;
      const located = await bridge.rediscover().catch(() => null);
      if (located?.found && located.found.port !== bridge.port) {
        await bridge.switchPort(located.found.port);
        logger.info(`Bridge healthy on port ${bridge.port}`);
      }
    }
  );

  // ---------- tools/list ----------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A switched-off tool is not listed at all, rather than listed and
    // refusing: a tool the model never sees is one it never plans around.
    const tools = Object.keys(OpSchemas).filter((name) => !disabled.has(name)).map((name) => ({
      name,
      description: descriptions[name] ?? `AE op: ${name}`,
      inputSchema: toolInputSchema(name) as any,
      // Derived from OpMutation and the read-only policy table, never hand-kept:
      // see tools/annotations.ts for the rule (issue #165).
      annotations: toolAnnotations(name),
    }));
    return { tools };
  });

  // ---------- prompts ----------
  // The portable form of a slash command. Claude Code gets the same three as
  // plugin commands; everywhere else this is the only way a user can invoke a
  // named flow, so the bodies live in one place and are generated into both.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.argumentHint
        ? [{ name: "arguments", description: p.argumentHint, required: false }]
        : [],
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = getPrompt(req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    const given = (req.params.arguments?.arguments as string | undefined) ?? "";
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: withPolicyNotice(policy, prompt.body.replaceAll("$ARGUMENTS", given)),
          },
        },
      ],
    };
  });

  // ---------- resources ----------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: GUIDES.map((g) => ({
      uri: `${GUIDE_URI_PREFIX}${g.name}`,
      name: g.name,
      description: g.description,
      mimeType: "text/markdown",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const guide = uri.startsWith(GUIDE_URI_PREFIX)
      ? getGuide(uri.slice(GUIDE_URI_PREFIX.length))
      : undefined;
    if (!guide) throw new Error(`Unknown resource: ${uri}`);
    return { contents: [{ uri, mimeType: "text/markdown", text: withPolicyNotice(policy, guide.body) }] };
  });

  // ---------- tools/call ----------
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const rawArgs = req.params.arguments ?? {};
    const progressToken = (req.params as any)?._meta?.progressToken as string | number | undefined;

    if (!Object.hasOwn(OpSchemas, name) && !SERVER_OPS.has(name)) {
      return errorResult(`Unknown tool: ${name}`);
    }
    // Not annotated from the journal, like `Unknown tool`: this is the user's
    // configuration answering, and no entry about a past failure applies.
    const off = disabled.get(name);
    if (off !== undefined) return errorResult(disabledToolMessage(name, off));
    // Before anything else reads them, for every op: a `__proto__` key can
    // become a prototype on the ExtendScript side and hide a value from every
    // check made here. See util/argsSafety.ts for why the scope is all ops.
    const unsafe = findUnsafeArgKeys(rawArgs);
    if (unsafe.length > 0) return errorResult(unsafeArgsMessage(name, unsafe));

    // Server-resident ops
    if (SERVER_OPS.has(name)) {
      try {
        if (name === "await_job") {
          const a = AwaitJobSchema.parse(rawArgs);
          // This is the one call that blocks for the job, so it is the one
          // call whose progress a client is still correlating while the job
          // runs — see forwardJobProgress for why run_batch cannot be.
          const forward = progressToken !== undefined ? forwardJobProgress(jobs, a.jobId, progressToken, extra) : null;
          try {
            // The request's own signal, so a client that cancels this call
            // releases the wait rather than leaving it parked (issue #159).
            const st = await jobs.waitFor(a.jobId, a.timeoutMs ?? 600_000, extra?.signal);
            return textResult(st);
          } catch (e) {
            // The job failed (or the wait timed out). Answered here rather
            // than by the catch below, which would label it "Invalid
            // arguments for await_job" — a schema error, which it is not.
            return fail(name, (e as Error).message);
          } finally {
            // Unbind, then wait for every notification already started to
            // reach the transport. The response is written after this handler
            // returns, so nothing on this token can land behind it — on the
            // timeout path as much as on the success path.
            await forward?.settle();
          }
        }
        if (name === "get_job") {
          const a = GetJobSchema.parse(rawArgs);
          const st = jobs.get(a.jobId);
          // A bare `null` read as "no news yet" and invited polling for ever;
          // say what await_job and cancel_job say about the same id (#163).
          if (!st) return fail(name, unknownJobMessage(a.jobId, "There is no progress to report."));
          return textResult(st);
        }
        if (name === "cancel_job") {
          const a = CancelJobSchema.parse(rawArgs);
          // A render job lives in this server, not in ExtendScript: stopping it
          // means killing the aerender process and watching it exit. Reported
          // as stopped only once it has.
          const report = await renders.cancel(a.jobId);
          if (report) {
            if (report.wasRunning && !report.stopped) return fail(name, report.note);
            return textResult({ ok: report.stopped, ...report });
          }
          return await cancelBatchJob(a.jobId);
        }
        // check_setup is told which port ops are going to, so it can say when
        // that disagrees with the port that answers — the state issue #92
        // lived in for a week with every check green.
        // check_setup asks the ports ops would ask, and then the ones a pin
        // keeps ops away from: a wrong AE_MCP_PORT must not hide the panel
        // answering on 7777, or the report sends the user to restart After
        // Effects for a panel that is fine (recipe 43). probeBridge dedups.
        const setupOpts = () => ({ opPort: bridge.port, candidates: [...bridge.candidates(), ...diagnosticPortCandidates()] });
        if (name === "check_setup") {
          return textResult(await checkSetup(setupOpts()));
        }
        if (name === "setup_panel") {
          const a = schemas.StrictOpSchemas.setup_panel.parse(rawArgs);
          const installed = await installPanel({ enableDebugMode: a.enableDebugMode, force: a.force });
          // The panel on disk just changed; whatever was cached about the
          // running one is now the wrong half of the comparison.
          panelGate.invalidate();
          // Re-run the diagnostic so the agent sees the resulting state rather
          // than having to guess whether the install was sufficient.
          return textResult({ ...installed, setup: await checkSetup(setupOpts()) });
        }
        if (name === "init_project") {
          const a = schemas.StrictOpSchemas.init_project.parse(rawArgs);
          const client: ClientKind =
            !a.client || a.client === "auto"
              ? detectClient(server.getClientVersion()?.name)
              : (a.client as ClientKind);
          return textResult(
            scaffold({
              dir: a.dir,
              name: a.name,
              client,
              withMcpConfig: a.withMcpConfig ?? false,
              roots: a.dir ? undefined : await clientRoots(server),
            })
          );
        }
        if (name === "ae_guide") {
          const a = schemas.StrictOpSchemas.ae_guide.parse(rawArgs);
          const guide = getGuide(a.topic);
          if (!guide) return errorResult(`Unknown guide topic: ${a.topic}`);
          // Markdown, not JSON: this is prose to be read, and JSON-escaping it
          // would hand the model a wall of \n.
          if (a.topic === "whats-new") {
            // The one topic with a shape a machine can filter — see
            // tools/whatsNew.ts. The version on the first line is the server's
            // own, read from package.json, because the guide cannot know it.
            const rendered = renderWhatsNew(guide.body, { since: a.since, serverVersion: packageVersion() });
            return { content: [{ type: "text" as const, text: withPolicyNotice(policy, rendered.text) }] };
          }
          if (a.since !== undefined) {
            // Refused rather than ignored: a filter that silently did not apply
            // is the swallowed error this server refuses everywhere else.
            return errorResult(
              `\`since\` filters the whats-new topic only; the ${a.topic} topic has no release sections to filter. ` +
                `Call ae_guide({topic: "${a.topic}"}) without \`since\`, or ae_guide({topic: "whats-new", since: "${a.since}"}) for what changed.`
            );
          }
          return { content: [{ type: "text" as const, text: withPolicyNotice(policy, guide.body) }] };
        }
        if (name === "log_issue") {
          const a = schemas.StrictOpSchemas.log_issue.parse(rawArgs);
          // The project journal stays the default: an entry is about this
          // project's work unless the agent says it is about the tools.
          return textResult(logIssue({ ...a, scope: a.scope ?? "project" }));
        }
        if (name === "list_known_issues") {
          const a = schemas.StrictOpSchemas.list_known_issues.parse(rawArgs);
          return textResult(
            listIssues({
              status: a.status ?? "all",
              tool: a.tool,
              query: a.query,
              id: a.id,
              // Compact unless asked otherwise: the full corpus is thousands of
              // tokens that stay in the transcript for the rest of the session.
              detail: a.detail ?? "index",
              // Both journals by default — the whole point of the user one is
              // that a fresh project folder does not start ignorant.
              scope: a.scope ?? "all",
              limit: a.limit,
              // Hidden unless asked: an archived entry is one that stopped
              // biting, was superseded by a release, or was retired on purpose.
              includeArchived: a.includeArchived ?? false,
            })
          );
        }
        if (name === "mark_issue_reported") {
          const a = schemas.StrictOpSchemas.mark_issue_reported.parse(rawArgs);
          const entry = markReported(a.id, a.url);
          // The scope goes back too: a bare id can name an entry in either
          // journal, and the caller has to be able to say which one moved.
          return textResult({ ok: true, id: entry.id, scope: entry.scope, reported: true, issueUrl: entry.issueUrl });
        }
        if (name === "archive_issue") {
          const a = schemas.StrictOpSchemas.archive_issue.parse(rawArgs);
          const entry = archiveIssue(a.id, a.reason);
          return textResult({
            ok: true,
            id: entry.id,
            scope: entry.scope,
            archived: true,
            reason: entry.archivedReason,
            archivedAt: entry.archivedAt,
            note: "The file is kept and can be reopened by a later log_issue with the same title or the same tool and error text.",
          });
        }
      } catch (e) {
        // A zod rejection here is the same class of thing as one below, and gets
        // the same prose treatment; `invalidArgsText` passes anything else
        // through unchanged.
        return fail(name, invalidArgsText(name, e));
      }
    }

    // Validate input against the op's schema, closed at every depth
    // (`StrictOpSchemas`, issue #147). The emitted schema has always told the
    // model an unknown key is refused; the plain schema stripped it, so a
    // misspelt field reached no handler and the tool answered "done".
    let args: unknown;
    try {
      args = (schemas.StrictOpSchemas[name as keyof typeof OpSchemas] as z.ZodType).parse(rawArgs);
    } catch (e) {
      return fail(name, invalidArgsText(name, e));
    }

    // A batch step goes straight to the ExtendScript OPS table, so a step
    // naming a switched-off op is that op by another route — `run_jsx` inside
    // `run_batch` runs the script exactly as `run_jsx` would, and so does one
    // inside a `run_batch` nested in it, at any depth. Refused whole, before
    // anything reaches After Effects, and every offending step named.
    if (name === "run_batch" && disabled.size > 0) {
      const refused = refusedBatchSteps((args as { ops: unknown[] }).ops, policy);
      if (refused.length > 0) {
        return errorResult(
          `run_batch refused, and nothing in the batch was run: ` +
            refused.map((r) => `${r.path} (${r.op}) — ${r.reason}`).join("; ") +
            `. Remove ${refused.length === 1 ? "that step" : "those steps"}, or tell the user the tool is switched off; ` +
            `do not try to do the same thing through another tool.`
        );
      }
    }

    // Every step is held to the arguments of the tool it names, at every
    // depth, and the parsed args — defaults applied — are what is forwarded
    // (issue #157). Before, steps went to ExtendScript raw: no defaults, typos
    // passed, and a tool whose second half runs outside After Effects
    // half-worked. Refused whole, like the policy check above.
    if (name === "run_batch") {
      const batch = args as { ops: { op: string; args?: unknown }[] };
      const { ops, problems } = prepareBatchSteps(batch.ops);
      if (problems.length > 0) return fail(name, batchProblemsMessage(problems));
      args = { ...batch, ops };
    }

    // run_jsx can take its script, and its helper libraries, from files rather
    // than from the conversation. The server reads them — see runJsxSource.ts;
    // the short version is that Claude Desktop's agent has no filesystem tools
    // and is exactly the client this saves the most context for.
    if (name === "run_jsx") {
      try {
        args = resolveRunJsxSource(args as RunJsxArgs);
      } catch (e) {
        return fail(name, (e as Error).message);
      }
    }

    // Refuse to forward to a panel that predates this server. Without this the
    // agent gets `Unknown op: …` for anything added since the panel was
    // installed and has no way to know an update is the fix.
    // Timed from here so a timeout can say what the whole call cost (#175): the
    // gate's /health probe waits on a busy After Effects too, and was measured
    // turning a 3s op limit into a 5.0s wait the message never mentioned.
    const calledAt = Date.now();
    const staleness = await panelGate.check();
    const gateMs = Date.now() - calledAt;
    if (staleness) return errorResult(staleness);

    // Serialize writes. Acquiring *before* runOp is what keeps the op timeout
    // honest: `AbortSignal.timeout` is created inside `runOp`, so the clock
    // starts when the call executes and not when it entered the queue. A queued
    // call that timed out having never run would report a bridge failure for a
    // bridge that was working, which is the one way this feature could make
    // things worse than they were.
    let lease: WriteLease | null = null;
    if (isWriteOp(name)) {
      try {
        lease = await writes.acquire(name, extra?.signal);
      } catch (e) {
        // Full, timed out in the queue, or cancelled — all three mean the call
        // never reached After Effects, and all three say so.
        return fail(name, (e as Error).message);
      }
    }
    const wait: QueueWait | null = lease?.wait ?? null;

    // Forward to panel.
    try {
      // Inside this try so the panel's own error mapping — timeouts, AeError,
      // the Unknown-op backstop — applies to the internal ops these forward.
      if (SNAPSHOT_OPS.has(name)) return await runSnapshotOp(name, args, bridge, snapshots);
      // The render runs outside After Effects; only the prepare and the save
      // cross the bridge. The lease is released when this returns, on purpose
      // — see runRender.
      if (name === "render_queue") return textResult(await runRender(args as RenderQueueArgs, bridge, renders), wait);

      // Filesystem checks the server makes itself (issue #220, stage 2), so a
      // refusal costs After Effects nothing. The jsx copies stay in the bundle
      // and run again after these: older servers and `run_batch` steps rely on
      // them. See "Filesystem checks on the server" in docs/subsystems.md.
      let destination: MogrtDestination | null = null;
      try {
        if (name === "add_to_render_queue") checkRenderOutput(args as { outputPath: string; overwrite?: boolean });
        if (name === "import_footage") checkFootageExists(args as { path: string });
        if (name === "export_mogrt") {
          destination = prepareMogrtDestination(args as { compId: number; destDir?: string; name?: string; overwrite?: boolean });
        }
      } catch (e) {
        // The jsx looks the comp up before any of these checks, so a missing
        // comp is what it refused first. Asked only on this refusal path, so
        // a call that passes costs no extra round trip.
        if (name === "add_to_render_queue" || name === "export_mogrt") await refuseMissingComp(bridge, args);
        throw e;
      }

      // The request's progressToken is deliberately not forwarded. The panel
      // does nothing with it — its WS `progress` events carry a jobId and no
      // token — and progress is delivered on `await_job`, never here; see
      // forwardJobProgress.
      let result: unknown;
      try {
        result = await bridge.runOp(name, args);
      } catch (e) {
        // A folder made above for an export After Effects then refused goes
        // again, empty: the jsx refused before making one (#71's check runs first).
        destination?.rollback();
        throw e;
      }
      // The folder existed by the time the jsx looked, because it was made here.
      if (destination && destination.created.length > 0 && result && typeof result === "object") {
        (result as { createdDir?: boolean }).createdDir = true;
      }

      // Async envelope handling for run_batch
      if (ASYNC_OPS.has(name) && isAsyncEnvelope(result)) {
        const env = result as {
          jobId: string; async: true; total: number;
          chunkSize?: number; undoStepsEstimate?: number;
          undoGroupName?: string; note?: string;
        };
        jobs.register(env.jobId, env.total);
        // No progress emitter is bound to this request, and that absence is
        // the fix for issue #82. This handler returns the envelope a few lines
        // down, and a `notifications/progress` sent on this request's token
        // after that response is one a spec-compliant client has already
        // stopped correlating — every message was on the wire and every real
        // client saw nothing. The call that can carry progress is the one
        // that blocks for the job, `await_job`; the note says so.
        //
        // This is the gap the panel's own mutex leaves, and the reason this
        // queue exists at all. `run_batch` handed back a jobId and the panel now
        // drives `_continue_job` chunk by chunk; each chunk is its own turn on
        // the panel's evalScript chain, so releasing the lock here would let the
        // next write land *between* two chunks. That is still wrong even now
        // that each chunk carries its own undo group (issue #69 removed the
        // group that used to span them): the batch is one thing the caller
        // asked for, and another write interleaved into the middle of it runs
        // out of the order it was issued in. Hold the lock until the job
        // reports done.
        //
        // `await_job` is server-resident and never takes this lock, so an agent
        // waiting on the job it queued behind cannot deadlock against it.
        //
        // `waitFor`'s own timeout has to sit at the queue's hold ceiling, not
        // below it — a shorter one here would release the lock mid-batch while
        // a writer that queued at the same moment was still waiting.
        lease?.extendUntil(jobs.waitFor(env.jobId, writes.holdCeilingMs));
        // The undo fields travel with the envelope because this is the only
        // message the agent sees before it starts describing the work to the
        // user; the measured count arrives much later, with the job's result.
        return textResult(
          {
            jobId: env.jobId,
            async: true,
            total: env.total,
            chunkSize: env.chunkSize,
            undoStepsEstimate: env.undoStepsEstimate,
            undoGroupName: env.undoGroupName,
            note: withProgressNote(env.note, env.jobId),
          },
          wait
        );
      }

      // An empty frame is reported, never shipped. The panel found every pixel
      // fully transparent, and the PNG that encodes that is the one decoders
      // reject with "could not process image" — so the useful answer is the
      // sentence, not the picture.
      if (VISION_OPS.has(name) && isEmptyFrameResult(result)) return textResult(result);

      // Vision: package as MCP image content
      if (VISION_OPS.has(name) && isVisionResult(result)) {
        const v = result as {
          width: number; height: number; fullWidth?: number; fullHeight?: number;
          downsample?: number; time: number; compId: number; layerId?: number;
          base64: string; bytes: number; warning?: string;
          converted?: boolean; sourceBitDepth?: number;
          // A contact sheet is the same image content block with a map of what
          // is in it. The per-tile record is the only thing that tells the agent
          // which cell is which time, and which cells are marked blocks rather
          // than frames.
          contactSheet?: boolean; cols?: number; rows?: number;
          cellWidth?: number; cellHeight?: number;
          tiles?: unknown[];
        };
        return imageContent(
          {
            width: v.width,
            height: v.height,
            fullWidth: v.fullWidth,
            fullHeight: v.fullHeight,
            downsample: v.downsample,
            time: v.time,
            compId: v.compId,
            layerId: v.layerId,
            bytes: v.bytes,
            // Present only when the project renders deeper than 8 bits per
            // channel and the panel re-encoded the frame so it would decode.
            converted: v.converted,
            sourceBitDepth: v.sourceBitDepth,
            // Surfaced when a requested downsample could not be applied, so the
            // agent knows it is looking at a full-resolution frame.
            warning: v.warning,
            // Present only for a `times` call. `tiles` is what makes the sheet
            // readable as data as well as a picture — cell rectangle, time and
            // status per tile, in the order they were asked for.
            contactSheet: v.contactSheet,
            cols: v.cols,
            rows: v.rows,
            cellWidth: v.cellWidth,
            cellHeight: v.cellHeight,
            tiles: v.tiles,
          },
          v.base64
        );
      }

      // The style guide is read over the bridge and summarised here: the panel
      // does not update itself, so a summariser shipped in the .jsx bundle would
      // answer `detail: "summary"` with the whole document until the user
      // reinstalled the panel and relaunched AE. See style/summary.ts.
      if (name === "get_house_style") {
        const detail = (args as { detail?: "summary" | "full" }).detail ?? "summary";
        return textResult(applyHouseStyleDetail(result, detail), wait);
      }

      return textResult(result, wait);
    } catch (e) {
      // Checked before BridgeUnreachableError because the remedies are
      // opposites: one says restart After Effects, the other says do not.
      // Every branch below goes through `fail`, so a failure the journal already
      // knows about arrives with its pointer attached — that is the push half of
      // the journal, and the error path is the only place it can live.
      if (e instanceof BridgeTimeoutError) {
        e.withTiming({ totalMs: Date.now() - calledAt, gateMs, queueMs: wait?.waitedMs ?? 0 });
        return fail(name, e.message);
      }
      if (e instanceof BridgeUnreachableError) return fail(name, e.message);
      if (e instanceof BridgeResetError) return fail(name, e.message);
      if (e instanceof AeError) {
        // A failure the panel diagnosed itself — a stale render buffer, so far.
        // Those messages are already a complete instruction to the agent, and
        // "AE:" in front of one would read as After Effects having raised it.
        if (e.code) return fail(name, e.message);
        // The gate above should have caught this, but it depends on /health
        // reporting a hash. On a panel too old to do that, this is the backstop
        // — and it is unambiguous, since unknown tool names never get this far.
        if (/^Unknown op: /.test(e.message)) {
          panelGate.invalidate();
          return errorResult(unknownOpMessage(name));
        }
        // The line number on its own counts from something the caller cannot
        // see, so this prints the failing line's text where the handler could
        // map it, and says so plainly where it could not (issue #46).
        return fail(name, aeErrorText(e));
      }
      return fail(name, (e as Error).message);
    } finally {
      // No-op unless a lease was taken, and deferred by `extendUntil` when a
      // long batch is still running behind the envelope we just returned.
      lease?.release();
    }
  });

  return server;
}

/**
 * Throw the jsx's own "no such comp" refusal if `args.compId` is not a comp.
 *
 * `get_comp` resolves the id through the same `getCompById` as
 * `add_to_render_queue` and `export_mogrt`, so its refusal is the one those
 * ops gave before the server's filesystem checks ran ahead of them, word for
 * word. Returns quietly when the comp exists, and the caller's own refusal
 * stands. Any other failure (a busy or absent bridge) is not this check's to
 * report, and the caller's refusal stands then too.
 */
async function refuseMissingComp(bridge: HttpClient, args: unknown): Promise<void> {
  try {
    await bridge.runOp("get_comp", { compId: (args as { compId: number }).compId });
  } catch (e) {
    if (e instanceof AeError && !e.code && !/^Unknown op: /.test(e.message)) throw e;
  }
}

/**
 * Forward a job's progress to the request that is waiting on it, as
 * `notifications/progress` on that request's own token.
 *
 * Bound by `await_job` and by nothing else. `run_batch` has answered with its
 * `{jobId}` envelope before the first chunk runs, and a notification sent on a
 * request's token after that request's response is one a spec-compliant client
 * has already stopped listening for — the SDK client drops its progress
 * handler the moment the response arrives. Until 0.5.0 every progress message
 * for a long batch went out that way: plainly visible on the raw wire, and
 * seen by no real client at all (issue #82).
 *
 * `extra.sendNotification` is the SDK's request-scoped sender, and it is used
 * on purpose over `server.notification`: it tags each message with the request
 * id, so a Streamable HTTP transport delivers it on that request's own stream,
 * and it silently drops anything sent after the request has been cancelled.
 *
 * `settle()` unbinds first and then waits for every send already started. The
 * SDK writes the response after the handler returns, so awaiting this before
 * returning is what puts every notification ahead of the response on the wire
 * — on the timeout path, where the emitter would otherwise outlive the call,
 * as much as on the success path.
 */
function forwardJobProgress(
  jobs: JobManager,
  jobId: string,
  progressToken: string | number,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) {
  const inFlight = new Set<Promise<void>>();
  const unbind = jobs.bindProgressEmitter(jobId, (_jid, progress, total, message) => {
    const p = extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })
      .catch((e) => logger.warn(`progress notification for job ${jobId} was not sent: ${(e as Error).message}`));
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  });
  return {
    async settle(): Promise<void> {
      unbind();
      await Promise.all(inFlight);
    },
  };
}

/**
 * `render_queue`: check, find aerender, save if asked, snapshot, then start the
 * render in the background and answer with a job envelope.
 *
 * The order is the point. Everything that can refuse — a project never saved,
 * nothing queued, an item in the wrong state, an output that already exists,
 * unsaved changes without saveProject:true, a read-only file, no aerender on
 * this machine — refuses before the save, so a refusal costs the user nothing.
 * The save is never a surprise: a clean project is not saved at all, and a
 * dirty one only with the caller's explicit saveProject:true. The snapshot
 * (`snapshotProject`) is taken inside the lease, so nothing that saves the
 * .aep later can change what this job renders.
 *
 * The write lease covers the prepare and the save and is released when this
 * returns, unlike `run_batch`'s, which is held until its job ends. A batch's
 * chunks run inside the live session, so a write between two of them lands in
 * the middle of the batch. A render reads a file that was finished before it
 * started: a write made while it runs cannot reach it, and holding the lock for
 * a twenty-minute render would freeze every edit for twenty minutes to protect
 * nothing.
 */
interface RenderQueueArgs {
  indices?: number[];
  all?: true;
  overwrite?: boolean;
  saveProject?: boolean;
}

async function runRender(
  args: RenderQueueArgs,
  bridge: HttpClient,
  renders: RenderRunner
): Promise<Record<string, unknown>> {
  const busy = renders.activeJobId;
  if (busy) {
    throw new Error(
      `A render is already running (job ${busy}); nothing was saved or started. Wait for it with ` +
        `await_job({jobId: "${busy}"}) or stop it with cancel_job, then call render_queue again — ` +
        `each render is a whole background copy of After Effects, so they are run one at a time.`
    );
  }
  // A timeout in either bridge step escapes before any render starts, so it is
  // restated as render_queue's, saying what can and cannot still land.
  const renderStep = async <T>(step: "prepare" | "save", p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof BridgeTimeoutError) e.asRenderStep(step);
      throw e;
    }
  };
  const plan = (await renderStep("prepare", bridge.runOp("_render_prepare", { indices: args.indices, all: args.all }))) as RenderPlan & {
    readOnly?: boolean | null;
  };
  // Items the user queued by hand never passed add_to_render_queue's guard.
  if (!args.overwrite) {
    const occupied = occupiedOutputs(plan);
    if (occupied.length) {
      throw new Error(
        `Nothing was saved or rendered: these outputs already exist and the render would replace them: ` +
          `${occupied.join(", ")}. Pass overwrite:true if that is intended, or point the items elsewhere.`
      );
    }
  }
  // Every file the items read must be on disk, and recorded in the saved
  // project at a path that leads to it — the render reads a copy in the temp
  // folder, which cannot follow a path relative to the project (issue #145).
  // Checked in Node, so it holds in any language; on a dirty project only
  // after the save, since the old file does not hold footage imported since.
  let aerender = "";
  const { saved, savedForFootage, pathsWarning } = await saveAndCheckFootage({
    plan,
    saveProject: args.saveProject === true,
    readOnly: plan.readOnly,
    beforeSave: () => {
      aerender = resolveAerender(aerenderCandidates(plan.appPackage, { installRoots: afterEffectsInstallRoots() }));
    },
    save: async (force) => (await renderStep("save", bridge.runOp("_render_save", { force }))) as { saved: boolean },
  });
  const save = { saved };
  const footageWarnings = plan.items.flatMap((i) => (i.footageWarnings ?? []).map((w) => `item ${i.index}: ${w}`));
  const footageSkipped = plan.items.flatMap((i) => (i.footageSkipped ?? []).map((w) => `item ${i.index}: ${w}`));
  let started: { jobId: string; totalFrames: number };
  try {
    started = renders.start(plan, aerender);
  } catch (e) {
    throw new Error((save.saved ? "The project WAS saved, but the render did not start. " : "") + (e as Error).message);
  }
  const { jobId, totalFrames } = started;
  logRenderStart(jobId, aerender, plan);
  return {
    jobId,
    async: true,
    total: totalFrames,
    items: plan.items.map((i) => ({
      index: i.index,
      compName: i.compName,
      frames: i.frames,
      outputs: i.outputs.map((o) => o.path),
    })),
    projectPath: plan.projectPath,
    projectSaved: save.saved,
    ...(savedForFootage
      ? {
          projectSavedBecause:
            "the saved project recorded footage at paths it had moved from; the save made After Effects record where it is now",
        }
      : {}),
    ...(footageWarnings.length
      ? {
          footageWarnings,
          footageWarningsNote:
            "Missing footage this render should not read, but might — tell the user, and check those frames in the file.",
        }
      : {}),
    ...(pathsWarning ? { footagePathsUnchecked: pathsWarning } : {}),
    ...(footageSkipped.length
      ? {
          missingFootageNotRendered: footageSkipped,
          missingFootageNote:
            "This footage is missing, but only on layers the render does not draw, so it was not a reason to refuse. Mention it to the user.",
        }
      : {}),
    aerender,
    note:
      "Rendering in the background in a separate aerender process, from a private copy of the project as saved now — " +
      "After Effects stays usable, and edits made from now on are NOT in this render. " +
      `Follow it with await_job({jobId: "${jobId}"}), which blocks until the render ends and lists every file ` +
      "it checked on disk; send it with a progressToken for per-frame progress. Pass a timeoutMs above the " +
      "default 10 minutes for a long render. cancel_job stops it by ending the process. " +
      "aerender takes a while to launch, so progress stays at 0 for the first few seconds.",
  };
}

/**
 * The sentence on a long batch's envelope that says where its progress goes.
 *
 * Appended here rather than written in `batch.jsx`, because it describes this
 * server and not After Effects: the panel does not update itself, and a note
 * authored there would go on describing whatever the server did when that
 * panel was installed.
 */
function withProgressNote(note: string | undefined, jobId: string): string {
  const progress =
    `Follow it with await_job({jobId: "${jobId}"}), which blocks until the batch finishes and returns its result. ` +
    `Progress is delivered on THAT call: send it with a progressToken and notifications/progress arrive while it ` +
    `waits, every one before its response. None can ride on this run_batch call — its response is already back ` +
    `before the first chunk runs. get_job({jobId: "${jobId}"}) reads the same state without a token.`;
  return note ? `${note} ${progress}` : progress;
}

/**
 * `snapshot_comp` and `diff_comp`.
 *
 * The split is the point: the panel gathers a fingerprint because only it can
 * read After Effects, and the server keeps it because a snapshot must not be
 * written into the user's project (see snapshots/store.ts). Neither tool sends
 * the fingerprint back unless asked — returning it by default would reintroduce
 * exactly the context cost the snapshot exists to avoid, since a tool result is
 * re-sent on every later request for the rest of the session.
 */
async function runSnapshotOp(
  name: string,
  args: unknown,
  bridge: HttpClient,
  snapshots: SnapshotStore
) {
  if (name === "snapshot_comp") {
    const a = args as { compId: number; includeFingerprint?: boolean };
    const fingerprint = (await bridge.runOp("_comp_fingerprint", { compId: a.compId })) as CompFingerprint;
    const snap = snapshots.store(fingerprint);
    return textResult({
      snapshotId: snap.id,
      compId: snap.compId,
      compName: snap.compName,
      layers: snap.layerCount,
      takenAt: new Date(snap.takenAt).toISOString(),
      next: `Do the work, then diff_comp({ since: "${snap.id}" }).`,
      lifetime:
        "Held in this MCP server's memory for the length of the session, not written into the After Effects project.",
      covers: SNAPSHOT_COVERS,
      fingerprint: a.includeFingerprint ? fingerprint : undefined,
    });
  }

  const d = args as { since: string; compId?: number; includeFingerprint?: boolean };
  const previous = snapshots.get(d.since);
  if (!previous) return errorResult(snapshots.missingMessage(d.since));
  if (d.compId !== undefined && d.compId !== previous.compId) {
    return errorResult(
      `Snapshot ${d.since} is of comp ${previous.compId} ("${previous.compName}"), not comp ${d.compId}. ` +
        `A diff only means anything against a snapshot of the same comp — omit compId, or snapshot_comp(${d.compId}) first.`
    );
  }
  // Only the gathering needs After Effects. The comparison runs here (issue
  // #220): `_comp_fingerprint` is in every panel ever shipped, so this works
  // against old bundles too, and the diff no longer costs AE main-thread time.
  const fingerprint = (await bridge.runOp("_comp_fingerprint", {
    compId: previous.compId,
  })) as CompFingerprint;
  const diff = diffFingerprints(previous.fingerprint, fingerprint);
  // The fresh fingerprint becomes a snapshot of its own, so a verify-as-you-go
  // loop can keep diffing forward without a second call per step.
  const next = snapshots.store(fingerprint);
  return textResult({
    ...diff,
    since: d.since,
    snapshotId: next.id,
    fingerprint: d.includeFingerprint ? fingerprint : undefined,
  });
}

/**
 * What a snapshot is and is not, quoted back on every one taken. A diff can
 * only report a field it records, so "no differences" has to be readable as
 * "none of these moved" and never as "identical" — the same rule that makes
 * every other scoped read here name what it left out.
 */
const SNAPSHOT_COVERS =
  "Records layer id/name/index/type, in/out/start, parent, enabled, keyframe counts, expression count and " +
  "effect count, plus comp size/duration/frame rate/work area/markers. Property values, expression text, " +
  "effect parameters and shape contents are not recorded.";

/**
 * Folders the client says it is working in, best first.
 *
 * Only some clients declare the `roots` capability, and asking one that has not
 * declared it is a protocol error rather than an empty answer — so check first,
 * and treat any failure as "no roots" instead of failing the scaffold. The
 * caller has a further fallback after this one.
 */
async function clientRoots(server: Server): Promise<string[] | undefined> {
  if (!server.getClientCapabilities()?.roots) return undefined;
  try {
    const { roots } = await server.listRoots();
    return roots
      .map((r) => r.uri)
      .filter((uri) => uri.startsWith("file://"))
      .map((uri) => fileURLToPath(uri));
  } catch (e) {
    logger.warn(`Client advertised roots but listing them failed: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * `wait` is present only when the call actually sat in the write queue, so the
 * ordinary result is byte-identical to what it has always been.
 *
 * It is folded into the result object where there is one — which is every
 * writing op but `run_jsx`, whose result is whatever the caller's script
 * returned. Arrays and bare numbers get a second text block instead: rewrapping
 * them would change what every existing caller reads, and #43 is the standing
 * reminder that changing what a `run_jsx` answer looks like is expensive.
 * Vision results never come through here with a wait — screenshots are reads
 * and are never queued — so the image envelope cannot be touched by this.
 */
function textResult(value: unknown, wait?: QueueWait | null) {
  // Compact, not pretty-printed (issue #166). The model reads JSON without the
  // indentation, and every result is re-sent on every later turn of the
  // session, so the whitespace was paid for many times over: 20–40% of a
  // nested read like get_layer_full. Content is unchanged — only whitespace.
  const json = (v: unknown) => ({ type: "text" as const, text: JSON.stringify(v) });
  if (!wait) return { content: [json(value)] };
  const merged = mergeWait(value, wait);
  if (merged) return { content: [json(merged)] };
  return { content: [json(value), json(wait)] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** The dialect these schemas are, and the one the Anthropic API reads them as. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

// Rewrite a JSON Schema into draft 2020-12. Under zod 3 the input was zod-to-json-schema's
// draft-07; `z.toJSONSchema` already emits 2020-12, so this is now a defensive pass.
//
// The Anthropic API validates tool input_schema against draft 2020-12, which rejects
// the draft-07 tuple form `{ type: "array", items: [<schemas>] }` — that shape is
// only valid in 2020-12 as `prefixItems`, with `items` (singular) covering trailing
// positions. We also drop the legacy `additionalItems` keyword (renamed to `items`).
//
// The `$schema` rewrite is part of the same correction and not cosmetic.
// zod-to-json-schema stamped the draft-07 URI, which after this pass is a false
// claim: `prefixItems` does not exist in draft-07, and `items: false` means
// something else entirely there ("no array items at all"). A consumer that
// honoured the declared dialect would reject every tuple in these schemas —
// every colour, every 2D point. It works today only because the API reads tool
// schemas as 2020-12 whatever they say about themselves. Saying so makes the
// document self-describing and lets a validator check what actually ships.
function toDraft2020(node: any): any {
  if (Array.isArray(node)) return node.map(toDraft2020);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const k of Object.keys(node)) out[k] = toDraft2020(node[k]);
  if (out.type === "array" && Array.isArray(out.items)) {
    out.prefixItems = out.items;
    if ("additionalItems" in out) {
      out.items = out.additionalItems;
      delete out.additionalItems;
    } else {
      out.items = false;
    }
  }
  if (typeof out.$schema === "string") out.$schema = JSON_SCHEMA_DIALECT;
  return out;
}

/**
 * Put a schema's cross-field rules — "exactly one of these three" — into the
 * JSON Schema the model is shown.
 *
 * The JSON Schema converter drops refinements, so without this pass the rule exists
 * only on the server and the only way to learn it is to break it. See the
 * cross-field section of `schemas.ts` for the vocabulary; the shapes injected
 * are `oneOf` / `anyOf` / `not` over `required`, which is plain composition and
 * valid in every draft.
 *
 * **Nothing is injected silently, and nothing here throws.** The enforcement
 * point for a rule that cannot be surfaced is `tests/unit/schema-constraints.mjs`,
 * which fails the build. At runtime this logs and carries on, for the same
 * reason `isWriteOp()` falls back to `"write"` rather than raising: `tools/list`
 * is the one call every session begins with, so a throw here would replace one
 * under-specified tool with *no tools at all*. Fail the build loudly; fail the
 * session towards the behaviour that shipped before.
 */
function withCrossFieldConstraints(zodSchema: unknown, jsonSchema: any, opName: string): any {
  for (const { path, rule } of schemas.crossFieldRulesIn(zodSchema)) {
    const where = path.join(".") || "(root)";
    if (!rule) {
      logger.warn(
        `${opName} carries a refinement at ${where} that is not a declared cross-field rule. ` +
          `It is enforced on every call and absent from the schema the model is shown, so an agent ` +
          `can only learn it by having a call rejected. Declare it with crossField() in ` +
          `packages/shared/src/schemas.ts.`
      );
      continue;
    }
    let node = jsonSchema;
    for (const step of path) {
      node = step === schemas.ARRAY_ELEMENT ? node?.items : node?.properties?.[step];
      if (!node || typeof node !== "object") break;
    }
    if (!node || typeof node !== "object") {
      logger.warn(
        `${opName}: the cross-field rule at ${where} has no matching node in the emitted JSON ` +
          `Schema, so it ships enforced but invisible.`
      );
      continue;
    }
    const fragment = schemas.crossFieldJsonSchema(rule);
    // Merge only where nothing is being overwritten; anything else goes under
    // `allOf`, which composes without either rule losing.
    const collides = Object.keys(fragment).some((k) => k in node);
    if (collides) (node.allOf ??= []).push(fragment);
    else Object.assign(node, fragment);
  }
  return jsonSchema;
}

/**
 * The `inputSchema` one tool ships with. Exported so
 * `tests/unit/schema-constraints.mjs` validates the exact document the client
 * receives rather than a reconstruction of it.
 */
export function toolInputSchema(opName: string): Record<string, unknown> {
  const schema = OpSchemas[opName as keyof typeof OpSchemas] as z.ZodType;
  // `io: "input"` is what a caller fills in: a field with a `.default()` is
  // optional to pass. `reused: "inline"` keeps every schema self-contained, no
  // `$defs`/`$ref` — the shape the emission and injection passes walk.
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    reused: "inline",
    override: ({ zodSchema, jsonSchema: node }) => {
      const def = (zodSchema as unknown as { _zod: { def: { type: string } } })._zod.def;
      // Every object is closed to the model, as it was under zod-to-json-schema.
      // Input mode leaves a non-`.strict()` object open, and zod would then strip
      // whatever extra key the model was invited to send — a silent drop.
      if (def.type === "object" && node.additionalProperties === undefined) node.additionalProperties = false;
      // `.int()` carries the safe-integer range in zod 4. True, and of no use to
      // a model choosing a layer id; it is paid for in every tools/list.
      if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
      if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
    },
  });
  return withCrossFieldConstraints(schema, toDraft2020(jsonSchema), opName);
}

function isAsyncEnvelope(v: unknown): boolean {
  return !!(v && typeof v === "object" && "async" in v && (v as any).async === true && "jobId" in v);
}
function isVisionResult(v: unknown): boolean {
  return !!(v && typeof v === "object" && "base64" in v && "width" in v);
}
function isEmptyFrameResult(v: unknown): boolean {
  return !!(v && typeof v === "object" && (v as { empty?: unknown }).empty === true && !("base64" in v));
}
