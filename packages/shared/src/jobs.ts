export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface JobState {
  jobId: string;
  status: JobStatus;
  progress: number;
  total?: number;
  message?: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}
