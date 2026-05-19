import { z } from "zod";

export const OpRequest = z.object({
  op: z.string(),
  args: z.unknown().optional(),
  requestId: z.string(),
  progressToken: z.union([z.string(), z.number()]).optional(),
});
export type OpRequest = z.infer<typeof OpRequest>;

export const OpSyncResponse = z.object({
  ok: z.literal(true),
  result: z.unknown(),
});

export const OpAsyncResponse = z.object({
  ok: z.literal(true),
  jobId: z.string(),
  async: z.literal(true),
});

export const OpErrorResponse = z.object({
  ok: z.literal(false),
  error: z.string(),
  stack: z.string().optional(),
  line: z.number().optional(),
});

export const OpResponse = z.union([OpSyncResponse, OpAsyncResponse, OpErrorResponse]);
export type OpResponse = z.infer<typeof OpResponse>;

export const WsEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    jobId: z.string(),
    progress: z.number(),
    total: z.number().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("complete"),
    jobId: z.string(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("error"),
    jobId: z.string(),
    error: z.string(),
    stack: z.string().optional(),
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type WsEvent = z.infer<typeof WsEvent>;
