import type { JobState } from "@engineroom/shared";

type ProgressEmitter = (jobId: string, progress: number, total?: number, message?: string) => void;

interface PendingResolver {
  resolve: (state: JobState) => void;
  reject: (err: Error) => void;
}

export class JobManager {
  private jobs = new Map<string, JobState>();
  private waiters = new Map<string, PendingResolver[]>();
  private progressEmitters = new Map<string, ProgressEmitter[]>();

  register(jobId: string, total?: number): JobState {
    const s: JobState = {
      jobId,
      status: "running",
      progress: 0,
      total,
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, s);
    return s;
  }

  bindProgressEmitter(jobId: string, fn: ProgressEmitter): void {
    const arr = this.progressEmitters.get(jobId) ?? [];
    arr.push(fn);
    this.progressEmitters.set(jobId, arr);
  }

  reportProgress(jobId: string, progress: number, total?: number, message?: string): void {
    const s = this.jobs.get(jobId);
    if (s) {
      s.progress = progress;
      if (total !== undefined) s.total = total;
      if (message !== undefined) s.message = message;
    }
    const emitters = this.progressEmitters.get(jobId) ?? [];
    for (const e of emitters) {
      try { e(jobId, progress, total, message); } catch {}
    }
  }

  complete(jobId: string, result: unknown): void {
    const s = this.jobs.get(jobId);
    if (!s) return;
    s.status = "completed";
    s.result = result;
    s.finishedAt = Date.now();
    this.flush(jobId);
  }

  fail(jobId: string, error: string): void {
    const s = this.jobs.get(jobId);
    if (!s) return;
    s.status = "failed";
    s.error = error;
    s.finishedAt = Date.now();
    this.flush(jobId);
  }

  cancel(jobId: string): void {
    const s = this.jobs.get(jobId);
    if (!s) return;
    s.status = "cancelled";
    s.finishedAt = Date.now();
    this.flush(jobId);
  }

  get(jobId: string): JobState | undefined { return this.jobs.get(jobId); }

  async waitFor(jobId: string, timeoutMs = 600_000): Promise<JobState> {
    const cur = this.jobs.get(jobId);
    if (cur && (cur.status === "completed" || cur.status === "failed" || cur.status === "cancelled")) {
      if (cur.status === "failed") throw new Error(cur.error || "job failed");
      return cur;
    }
    return new Promise<JobState>((resolve, reject) => {
      const arr = this.waiters.get(jobId) ?? [];
      arr.push({ resolve, reject });
      this.waiters.set(jobId, arr);
      const t = setTimeout(() => reject(new Error(`await_job(${jobId}) timed out after ${timeoutMs}ms`)), timeoutMs);
      // Clear timeout when settled
      const orig = arr[arr.length - 1];
      arr[arr.length - 1] = {
        resolve: (s) => { clearTimeout(t); orig.resolve(s); },
        reject: (e) => { clearTimeout(t); orig.reject(e); },
      };
    });
  }

  private flush(jobId: string): void {
    const s = this.jobs.get(jobId);
    if (!s) return;
    const waiters = this.waiters.get(jobId) ?? [];
    this.waiters.delete(jobId);
    for (const w of waiters) {
      if (s.status === "failed") w.reject(new Error(s.error || "job failed"));
      else w.resolve(s);
    }
    this.progressEmitters.delete(jobId);
  }
}
