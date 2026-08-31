import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { schemas } from "@engineroom/shared";
import { HttpClient } from "./bridge/httpClient.js";
import { WsClient } from "./bridge/wsClient.js";
import { WriteQueue, mergeWait, type QueueWait, type WriteLease } from "./bridge/writeQueue.js";
import { JobManager } from "./jobs/manager.js";
import { descriptions } from "./tools/descriptions.js";
import { AeError, BridgeTimeoutError, BridgeUnreachableError, aeErrorText } from "./util/errors.js";
import { resolveRunJsxSource, type RunJsxArgs } from "./tools/runJsxSource.js";
import { checkSetup } from "./setup/check.js";
import { installPanel } from "./setup/install.js";
import { ClientKind, detectClient, scaffold } from "./setup/scaffold.js";
import { assessPanel, installedBundleHash, unknownOpMessage } from "./setup/panelVersion.js";
import { installedPanelDir, panelInstallDiff, panelSourceDir } from "./setup/paths.js";
import { GUIDES, PROMPTS, SERVER_INSTRUCTIONS, getGuide, getPrompt } from "./generated/content.js";
import { listIssues, logIssue, markReported } from "./issues/journal.js";
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
]);

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
const AwaitJobSchema = schemas.AwaitJob;
const GetJobSchema = schemas.GetJob;
const CancelJobSchema = schemas.CancelJob;

export function createServer() {
  const server = new Server(
    { name: "after-effects-mcp", version: "0.3.1" },
    {
      capabilities: { tools: {}, logging: {}, prompts: {}, resources: {} },
      // Clients that honour this fold it into the system prompt, which is the
      // only way non-Claude clients get the cross-cutting guidance at all —
      // skills and slash commands do not exist outside Claude's own clients.
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const bridge = new HttpClient();
  const jobs = new JobManager();
  // One writer at a time. See bridge/writeQueue.ts for why the panel's own
  // evalScript mutex is not enough.
  const writes = new WriteQueue();
  const ws = new WsClient(bridge.port, jobs);
  ws.start();
  const panelGate = createPanelGate(bridge);

  // Best-effort health probe; non-fatal.
  bridge.health().then(
    (h) => logger.info(`Bridge healthy on port ${h.port}`),
    (e) => logger.warn(`Bridge not reachable yet: ${(e as Error).message}`)
  );

  // ---------- tools/list ----------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Object.keys(OpSchemas).map((name) => {
      const schema = OpSchemas[name as keyof typeof OpSchemas];
      const jsonSchema = zodToJsonSchema(schema, {
        target: "jsonSchema7",
        $refStrategy: "none",
      });
      return {
        name,
        description: descriptions[name] ?? `AE op: ${name}`,
        inputSchema: toDraft2020(jsonSchema) as any,
      };
    });
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
          content: { type: "text" as const, text: prompt.body.replaceAll("$ARGUMENTS", given) },
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
    return { contents: [{ uri, mimeType: "text/markdown", text: guide.body }] };
  });

  // ---------- tools/call ----------
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const rawArgs = req.params.arguments ?? {};
    const progressToken = (req.params as any)?._meta?.progressToken as string | number | undefined;

    if (!(name in OpSchemas) && !SERVER_OPS.has(name)) {
      return errorResult(`Unknown tool: ${name}`);
    }

    // Server-resident ops
    if (SERVER_OPS.has(name)) {
      try {
        if (name === "await_job") {
          const a = AwaitJobSchema.parse(rawArgs);
          const st = await jobs.waitFor(a.jobId, a.timeoutMs ?? 600_000);
          return textResult(st);
        }
        if (name === "get_job") {
          const a = GetJobSchema.parse(rawArgs);
          const st = jobs.get(a.jobId);
          return textResult(st ?? null);
        }
        if (name === "cancel_job") {
          const a = CancelJobSchema.parse(rawArgs);
          await bridge.cancel(a.jobId);
          jobs.cancel(a.jobId);
          return textResult({ ok: true });
        }
        if (name === "check_setup") {
          return textResult(await checkSetup());
        }
        if (name === "setup_panel") {
          const a = schemas.SetupPanel.parse(rawArgs);
          const installed = await installPanel({ enableDebugMode: a.enableDebugMode, force: a.force });
          // The panel on disk just changed; whatever was cached about the
          // running one is now the wrong half of the comparison.
          panelGate.invalidate();
          // Re-run the diagnostic so the agent sees the resulting state rather
          // than having to guess whether the install was sufficient.
          return textResult({ ...installed, setup: await checkSetup() });
        }
        if (name === "init_project") {
          const a = schemas.InitProject.parse(rawArgs);
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
          const a = schemas.AeGuide.parse(rawArgs);
          const guide = getGuide(a.topic);
          if (!guide) return errorResult(`Unknown guide topic: ${a.topic}`);
          // Markdown, not JSON: this is prose to be read, and JSON-escaping it
          // would hand the model a wall of \n.
          return { content: [{ type: "text" as const, text: guide.body }] };
        }
        if (name === "log_issue") {
          const a = schemas.LogIssue.parse(rawArgs);
          return textResult(logIssue(a));
        }
        if (name === "list_known_issues") {
          const a = schemas.ListKnownIssues.parse(rawArgs);
          return textResult(
            listIssues({
              status: a.status ?? "all",
              tool: a.tool,
              query: a.query,
              id: a.id,
              // Compact unless asked otherwise: the full corpus is thousands of
              // tokens that stay in the transcript for the rest of the session.
              detail: a.detail ?? "index",
            })
          );
        }
        if (name === "mark_issue_reported") {
          const a = schemas.MarkIssueReported.parse(rawArgs);
          const entry = markReported(a.id, a.url);
          return textResult({ ok: true, id: entry.id, reported: true, issueUrl: entry.issueUrl });
        }
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }

    // Validate input against zod schema.
    let args: unknown;
    try {
      args = (OpSchemas[name as keyof typeof OpSchemas] as z.ZodTypeAny).parse(rawArgs);
    } catch (e) {
      return errorResult(`Invalid arguments for ${name}: ${(e as Error).message}`);
    }

    // run_jsx can take its script, and its helper libraries, from files rather
    // than from the conversation. The server reads them — see runJsxSource.ts;
    // the short version is that Claude Desktop's agent has no filesystem tools
    // and is exactly the client this saves the most context for.
    if (name === "run_jsx") {
      try {
        args = resolveRunJsxSource(args as RunJsxArgs);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }

    // Refuse to forward to a panel that predates this server. Without this the
    // agent gets `Unknown op: …` for anything added since the panel was
    // installed and has no way to know an update is the fix.
    const staleness = await panelGate.check();
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
        return errorResult((e as Error).message);
      }
    }
    const wait: QueueWait | null = lease?.wait ?? null;

    // Forward to panel.
    try {
      const result = await bridge.runOp(name, args, progressToken);

      // Async envelope handling for run_batch
      if (ASYNC_OPS.has(name) && isAsyncEnvelope(result)) {
        const env = result as { jobId: string; async: true; total: number };
        jobs.register(env.jobId, env.total);
        if (progressToken !== undefined) {
          jobs.bindProgressEmitter(env.jobId, (jid, progress, total, message) => {
            void server.notification({
              method: "notifications/progress",
              params: { progressToken, progress, total, message },
            });
          });
        }
        // This is the gap the panel's own mutex leaves, and the reason this
        // queue exists at all. `run_batch` opened `app.beginUndoGroup` and
        // handed back a jobId; the panel now drives `_continue_job` chunk by
        // chunk with that group still OPEN. Each chunk is its own turn on the
        // panel's evalScript chain, so releasing the lock here lets the next
        // write land between two chunks — inside the batch's undo group, whose
        // `endUndoGroup()` then closes it early. Hold the lock until the job
        // reports done.
        //
        // `await_job` is server-resident and never takes this lock, so an agent
        // waiting on the job it queued behind cannot deadlock against it.
        //
        // `waitFor`'s own timeout has to sit at the queue's hold ceiling, not
        // below it — a shorter one here would release the lock mid-batch while
        // a writer that queued at the same moment was still waiting.
        lease?.extendUntil(jobs.waitFor(env.jobId, writes.holdCeilingMs));
        return textResult({ jobId: env.jobId, async: true, total: env.total }, wait);
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
          },
          v.base64
        );
      }

      return textResult(result, wait);
    } catch (e) {
      // Checked before BridgeUnreachableError because the remedies are
      // opposites: one says restart After Effects, the other says do not.
      if (e instanceof BridgeTimeoutError) return errorResult(e.message);
      if (e instanceof BridgeUnreachableError) return errorResult(e.message);
      if (e instanceof AeError) {
        // A failure the panel diagnosed itself — a stale render buffer, so far.
        // Those messages are already a complete instruction to the agent, and
        // "AE:" in front of one would read as After Effects having raised it.
        if (e.code) return errorResult(e.message);
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
        return errorResult(aeErrorText(e));
      }
      return errorResult((e as Error).message);
    } finally {
      // No-op unless a lease was taken, and deferred by `extendUntil` when a
      // long batch is still running behind the envelope we just returned.
      lease?.release();
    }
  });

  return server;
}

/**
 * Caches the panel-version verdict so it costs one /health per session rather
 * than one per tool call.
 *
 * Only a *stale* verdict is remembered indefinitely — that state cannot resolve
 * itself without a restart of After Effects, which drops the bridge and clears
 * the cache anyway. A healthy verdict is re-checked periodically so a panel that
 * gets replaced mid-session is noticed. An unreachable bridge caches nothing:
 * that is `runOp`'s error to report, with a much better message than this.
 */
function createPanelGate(bridge: HttpClient) {
  const RECHECK_MS = 60_000;
  let verdict: string | null = null;
  let checkedAt = 0;

  return {
    /** The message to return instead of forwarding, or null to proceed. */
    async check(): Promise<string | null> {
      if (verdict !== null) return verdict;
      if (Date.now() - checkedAt < RECHECK_MS) return null;
      try {
        const health = await bridge.health();
        // The gate is what every failed call quotes, so it has to know whether
        // the files on disk are internally consistent. Without this it tells the
        // user to restart After Effects for a half-updated install, which no
        // number of restarts can resolve.
        const installed = installedPanelDir();
        const source = panelSourceDir();
        const assessment = assessPanel(health.bundleHash, installedBundleHash(installed), {
          installComplete: source ? panelInstallDiff(source, installed).length === 0 : undefined,
        });
        checkedAt = Date.now();
        verdict = assessment.state === "current" || assessment.state === "unknown" ? null : assessment.message;
        // "unknown" covers a panel too old to report a hash. Its message is a
        // warning rather than a certainty, so it is logged, not enforced — the
        // Unknown-op backstop catches it the moment it actually matters.
        if (assessment.state === "unknown" && assessment.message) logger.warn(assessment.message);
        return verdict;
      } catch {
        return null;
      }
    },
    invalidate() {
      verdict = null;
      checkedAt = 0;
    },
  };
}

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
  const json = (v: unknown) => ({ type: "text" as const, text: JSON.stringify(v, null, 2) });
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

// Rewrite a JSON Schema (draft-07 output from zod-to-json-schema) into draft 2020-12.
// The Anthropic API validates tool input_schema against draft 2020-12, which rejects
// the draft-07 tuple form `{ type: "array", items: [<schemas>] }` — that shape is
// only valid in 2020-12 as `prefixItems`, with `items` (singular) covering trailing
// positions. We also drop the legacy `additionalItems` keyword (renamed to `items`).
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
  return out;
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
