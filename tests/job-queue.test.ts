import { describe, expect, it, vi } from "vitest";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("SqliteJobQueue", () => {
  it("enqueues, dequeues by priority, completes, fails, retries, and reports stats", async () => {
    const context = await createTestContext();
    const now = new Date("2026-03-09T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const lowId = await context.backend.queue.enqueue({ type: "embed", payload: { memory_id: "low" }, priority: 1 });
      const highId = await context.backend.queue.enqueue({ type: "embed", payload: { memory_id: "high" }, priority: 10 });

      const first = await context.backend.queue.dequeue();
      expect(first?.id).toBe(highId);
      expect(first?.status).toBe("processing");

      await context.backend.queue.complete(highId);

      const second = await context.backend.queue.dequeue();
      expect(second?.id).toBe(lowId);

      await context.backend.queue.fail(lowId, "temporary");
      expect(await context.backend.queue.dequeue()).toBeNull();

      vi.advanceTimersByTime(60_000);
      await context.backend.queue.retry(lowId);

      const retried = await context.backend.queue.dequeue();
      expect(retried?.id).toBe(lowId);
      await context.backend.queue.complete(lowId);

      expect(await context.backend.queue.stats()).toEqual({
        pending: 0,
        processing: 0,
        completed: 2,
        failed: 0,
      });

      const failedRow = context.backend.db.prepare("SELECT attempts FROM job_queue WHERE id = ?").get(lowId) as { attempts: number };
      expect(failedRow.attempts).toBe(1);
    } finally {
      vi.useRealTimers();
      await destroyTestContext(context);
    }
  });
});
