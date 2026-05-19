import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { schemas } from "@engineroom/shared";
import { HttpClient } from "./bridge/httpClient.js";
import { WsClient } from "./bridge/wsClient.js";
import { JobManager } from "./jobs/manager.js";
import { descriptions } from "./tools/descriptions.js";
import { AeError, BridgeUnreachableError } from "./util/errors.js";
import { imageContent } from "./util/pngImage.js";
import { logger } from "./util/logger.js";
import { z } from "zod";

const { OpSchemas } = schemas;

// Ops whose handler returns metadata + base64 PNG and should be packaged as an MCP image content.
const VISION_OPS = new Set(["screenshot_frame", "screenshot_layer"]);
// Ops that may return an async jobId envelope from the panel.
const ASYNC_OPS = new Set(["run_batch"]);
// Jobs/await/etc. are handled in-server, not forwarded as-is.
const SERVER_OPS = new Set(["await_job", "get_job", "cancel_job"]);

// Schema for await_job/get_job/cancel_job (defined inline in shared/schemas.ts).
const AwaitJobSchema = schemas.AwaitJob;
const GetJobSchema = schemas.GetJob;
const CancelJobSchema = schemas.CancelJob;

export function createServer() {
  const server = new Server(
    { name: "engine-room-ae-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } }
  );

  const bridge = new HttpClient();
  const jobs = new JobManager();
  const ws = new WsClient(bridge.port, jobs);
  ws.start();

  // Best-effort health probe; non-fatal.
  bridge.health().then(
    (h) => logger.info(`Bridge healthy on port ${h.port}`),
    (e) => logger.warn(`Bridge not reachable yet: ${(e as Error).message}`)
  );

  // ---------- tools/list ----------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Object.keys(OpSchemas).map((name) => {
      const schema = OpSchemas[name as keyof typeof OpSchemas];
      const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
      return {
        name,
        description: descriptions[name] ?? `AE op: ${name}`,
        inputSchema: jsonSchema as any,
      };
    });
    return { tools };
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
        return textResult({ jobId: env.jobId, async: true, total: env.total });
      }

      // Vision: package as MCP image content
      if (VISION_OPS.has(name) && isVisionResult(result)) {
        const v = result as { width: number; height: number; time: number; compId: number; layerId?: number; base64: string; bytes: number };
        return imageContent(
          { width: v.width, height: v.height, time: v.time, compId: v.compId, layerId: v.layerId, bytes: v.bytes },
          v.base64
        );
      }

      return textResult(result);
    } catch (e) {
      if (e instanceof BridgeUnreachableError) return errorResult(e.message);
      if (e instanceof AeError) return errorResult(`AE: ${e.message}${e.line ? ` (line ${e.line})` : ""}`);
      return errorResult((e as Error).message);
    }
  });

  return server;
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

function isAsyncEnvelope(v: unknown): boolean {
  return !!(v && typeof v === "object" && "async" in v && (v as any).async === true && "jobId" in v);
}
function isVisionResult(v: unknown): boolean {
  return !!(v && typeof v === "object" && "base64" in v && "width" in v);
}
