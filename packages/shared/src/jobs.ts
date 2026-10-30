/**
 * `cancelling` is not terminal: the panel has accepted a cancel and the job
 * stops at its next chunk boundary, at which point it settles as `cancelled`
 * with whatever it had done (issue #158). `completed`, `failed` and
 * `cancelled` are terminal and sticky — nothing that arrives later changes one.
 */
export type JobStatus = "pending" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface JobState {
  jobId: string;
  status: JobStatus;
  progress: number;
  total?: number;
  message?: string;
  result?: unknown;
  error?: string;
  /**
   * What the result cannot show and the agent must know — so far only that a
   * batch lost the cross-session write lock mid-run (issue #223). Sticky.
   */
  warning?: string;
  startedAt: number;
  finishedAt?: number;
}
