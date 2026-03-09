import { describe, expect, it } from "vitest";
import { ConsolidationEngine } from "../src/consolidation/engine.js";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("ConsolidationEngine", () => {
  it("creates consolidated memories, archives originals, and queues embeddings", async () => {
    const context = await createTestContext();
    try {
      const first = await context.backend.memories.create({
        type: "fact",
        namespace: "agent-a",
        content: "Alice prefers green tea.",
        summary: "Alice tea preference",
        details: { entityName: "Alice", factType: "preference" },
      });
      const second = await context.backend.memories.create({
        type: "fact",
        namespace: "agent-a",
        content: "Alice drinks sencha every morning.",
        summary: "Alice sencha routine",
        details: { entityName: "Alice", factType: "routine" },
      });
      await context.backend.queue.enqueue({
        type: "consolidate",
        payload: { namespace: "agent-a", limit: 10 },
      });

      const engine = new ConsolidationEngine(context.backend);
      expect(await engine.processNext()).toBe(true);

      const archived = await context.backend.memories.search({
        namespace: "agent-a",
        includeArchived: true,
        status: ["archived"],
        limit: 10,
      });
      expect(archived.map((memory) => memory.id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(archived.every((memory) => memory.supersededBy)).toBe(true);

      const consolidated = await context.backend.memories.search({
        namespace: "agent-a",
        includeArchived: true,
        contentQuery: "Consolidated",
        limit: 10,
      });
      expect(consolidated).toHaveLength(1);
      expect(consolidated[0]?.summary).toContain("Consolidated fact for Alice");
      expect(consolidated[0]?.content).toContain("Alice tea preference");
      expect(consolidated[0]?.content).toContain("Alice sencha routine");

      const queuedEmbeds = context.backend.db
        .prepare("SELECT COUNT(*) AS count FROM job_queue WHERE type = 'embed' AND status = 'pending'")
        .get() as { count: number };
      expect(queuedEmbeds.count).toBe(1);
    } finally {
      await destroyTestContext(context);
    }
  });
});
