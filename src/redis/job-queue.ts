import { randomUUID } from "node:crypto";
import { Job, Queue, Worker } from "bullmq";
import type { Job as MnemosyneJob, JobQueue, QueueStats } from "../interfaces/index.js";
import { nowIso } from "../sqlite/utils.js";

interface QueuePayload {
  payload: Record<string, unknown>;
}

interface ClaimedJob {
  job: Job<QueuePayload, unknown, string>;
  token: string;
}

export class RedisJobQueue implements JobQueue {
  private readonly connection: { url: string };
  private readonly queue: Queue<QueuePayload>;
  private readonly worker: Worker<QueuePayload>;
  private readonly claims = new Map<string, ClaimedJob>();

  constructor(redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379", private readonly queueName = "mnemosyne") {
    this.connection = { url: redisUrl };
    this.queue = new Queue<QueuePayload>(queueName, {
      connection: this.connection,
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    });
    this.worker = new Worker<QueuePayload>(
      queueName,
      async () => undefined,
      {
        connection: this.connection,
        autorun: false,
        concurrency: 1,
      },
    );
  }

  async enqueue(job: MnemosyneJob): Promise<string> {
    const queued = await this.queue.add(
      job.type,
      { payload: job.payload },
      {
        jobId: job.id,
        priority: Math.max(0, 2_097_152 - (job.priority ?? 0)),
        attempts: job.maxAttempts ?? 3,
        timestamp: job.createdAt ? Date.parse(job.createdAt) : Date.now(),
        delay: job.nextRetryAt ? Math.max(0, Date.parse(job.nextRetryAt) - Date.now()) : 0,
      },
    );
    return queued.id as string;
  }

  async dequeue(): Promise<MnemosyneJob | null> {
    return this.dequeueByType();
  }

  async dequeueByType(type?: string): Promise<MnemosyneJob | null> {
    const token = randomUUID();
    const job = await this.worker.getNextJob(token, { block: false });
    if (!job) {
      return null;
    }
    if (type && job.name !== type) {
      await job.moveToWait(token);
      return null;
    }
    this.claims.set(job.id as string, { job, token });
    return {
      id: job.id as string,
      type: job.name,
      payload: job.data.payload,
      status: "processing",
      priority: 2_097_152 - (job.priority ?? 2_097_152),
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 3,
      error: job.failedReason || null,
      createdAt: new Date(job.timestamp).toISOString(),
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : nowIso(),
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      nextRetryAt: job.delay ? new Date(job.timestamp + job.delay).toISOString() : null,
    };
  }

  async complete(id: string): Promise<void> {
    const claimed = this.requireClaim(id);
    await claimed.job.moveToCompleted("ok", claimed.token, false);
    this.claims.delete(id);
  }

  async fail(id: string, error: string): Promise<void> {
    const claimed = this.requireClaim(id);
    await claimed.job.moveToFailed(new Error(error), claimed.token, false);
    this.claims.delete(id);
  }

  async retry(id: string): Promise<void> {
    const existing = await Job.fromId(this.queue, id);
    if (!existing) {
      throw new Error(`Job ${id} not found`);
    }
    await existing.retry("failed");
  }

  async stats(): Promise<QueueStats> {
    const counts = await this.queue.getJobCounts("wait", "active", "completed", "failed", "delayed");
    return {
      pending: (counts.wait ?? 0) + (counts.delayed ?? 0),
      processing: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }

  private requireClaim(id: string): ClaimedJob {
    const claimed = this.claims.get(id);
    if (!claimed) {
      throw new Error(`Job ${id} is not currently claimed`);
    }
    return claimed;
  }
}
