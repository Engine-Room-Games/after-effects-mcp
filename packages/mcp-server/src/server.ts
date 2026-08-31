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
import { JobManager } from "./jobs/manager.js";
import { SnapshotStore } from "./snapshots/store.js";
import type { CompFingerprint } from "./snapshots/store.js";
import { descriptions } from "./tools/descriptions.js";
import { AeError, BridgeTimeoutError, BridgeUnreachableError } from "./util/errors.js";
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
const SERVER_OPS = new Set([
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
// Half server-resident: only the panel can read After Effects, only the server
// can remember anything between calls. These forward an internal read op to
// gather a fingerprint and keep the result in `SnapshotStore` — they are not in
// SERVER_OPS, because unlike those they do touch the bridge.
const SNAPSHOT_OPS = new Set(["snapshot_comp", "diff_comp"]);

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
  const snapshots = new SnapshotStore();
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

    // Refuse to forward to a panel that predates this server. Without this the
    // agent gets `Unknown op: …` for anything added since the panel was
    // installed and has no way to know an update is the fix.
    const staleness = await panelGate.check();
    if (staleness) return errorResult(staleness);

    // Forward to panel.
    try {
      // Inside this try so the panel's own error mapping — timeouts, AeError,
      // the Unknown-op backstop — applies to the internal ops these forward.
      if (SNAPSHOT_OPS.has(name)) return await runSnapshotOp(name, args, bridge, snapshots);

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
        return textResult({ jobId: env.jobId, async: true, total: env.total });
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

      return textResult(result);
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
        return errorResult(`AE: ${e.message}${e.line ? ` (line ${e.line})` : ""}`);
      }
      return errorResult((e as Error).message);
    }
  });

  return server;
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
  const res = (await bridge.runOp("_comp_diff", {
    compId: previous.compId,
    since: previous.fingerprint,
  })) as { diff: Record<string, unknown>; fingerprint: CompFingerprint };
  // The fresh fingerprint becomes a snapshot of its own, so a verify-as-you-go
  // loop can keep diffing forward without a second call per step.
  const next = snapshots.store(res.fingerprint);
  return textResult({
    ...res.diff,
    since: d.since,
    snapshotId: next.id,
    fingerprint: d.includeFingerprint ? res.fingerprint : undefined,
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

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
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
