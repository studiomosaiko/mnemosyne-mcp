import { describe, expect, it, vi } from "vitest";
import { EmbeddingPipeline } from "../src/embeddings/pipeline.js";
import { StubEmbeddingProvider } from "../src/embeddings/stub-provider.js";
import { callTool } from "../src/server/tools.js";
import { dequeueTypedJob, importanceDecay } from "../src/sqlite/backend.js";
import { createTestContext, destroyTestContext, parseToolText } from "./helpers.js";

describe("hybrid search", () => {
  it("fuses semantic, text, graph, recency, and decayed importance scores", async () => {
    const context = await createTestContext();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T00:00:00.000Z"));
    try {
      const alpha = await context.backend.memories.create({
        type: "fact",
        namespace: "agent-a",
        content: "Alice prefers green tea every morning.",
        summary: "Alice tea preference",
        importance: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        details: { entityName: "Alice", factType: "preference" },
      });
      const beta = await context.backend.memories.create({
        type: "fact",
        namespace: "agent-a",
        content: "Alice enjoys coffee tastings on weekends.",
        summary: "Alice coffee preference",
        importance: 1,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        details: { entityName: "Alice", factType: "preference" },
      });

      await context.backend.queue.enqueue({ type: "embed", payload: { memory_id: alpha.id } });
      await context.backend.queue.enqueue({ type: "embed", payload: { memory_id: beta.id } });

      const pipeline = new EmbeddingPipeline({
        provider: new StubEmbeddingProvider(),
        memories: context.backend.memories,
        vectors: context.backend.vectors,
        queue: {
          dequeueByType: async (type) => (await dequeueTypedJob(context.backend, type)) as { id: string; payload: Record<string, unknown> } | null,
          complete: async (id) => context.backend.queue.complete(id),
          fail: async (id, error) => context.backend.queue.fail(id, error),
        },
      });
      await pipeline.drain();

      const recall = parseToolText(
        await callTool(context.backend, "memory_recall", {
          namespace: "agent-a",
          query: "Alice green tea",
          search_mode: "hybrid",
          limit: 5,
        }),
      ) as {
        results: Array<{ id: string; score: number; score_breakdown: { semantic: number; text: number; graph: number; recency: number; importance: number } }>;
      };

      expect(recall.results[0]?.id).toBe(alpha.id);
      expect(recall.results[0]?.score_breakdown.semantic).toBeGreaterThan(0);
      expect(recall.results[0]?.score_breakdown.text).toBeGreaterThan(0);
      expect(recall.results[0]?.score_breakdown.graph).toBeGreaterThan(0);
      expect(recall.results[0]?.score_breakdown.importance).toBe(importanceDecay(1, "2026-03-08T00:00:00.000Z", "2026-03-08T00:00:00.000Z"));

      const exact = parseToolText(
        await callTool(context.backend, "memory_recall", {
          namespace: "agent-a",
          query: "green tea",
          search_mode: "exact",
          limit: 5,
        }),
      ) as { results: Array<{ id: string; score_breakdown: { semantic: number; text: number } }> };
      expect(exact.results[0]?.id).toBe(alpha.id);
      expect(exact.results[0]?.score_breakdown.semantic).toBe(0);
      expect(exact.results[0]?.score_breakdown.text).toBeGreaterThan(0);

      const semanticFact = parseToolText(
        await callTool(context.backend, "fact_query", {
          namespace: "agent-a",
          entity_name: "Alice tea",
          limit: 5,
        }),
      ) as { results: Array<{ id: string }> };
      expect(semanticFact.results.map((result) => result.id)).toContain(alpha.id);
    } finally {
      vi.useRealTimers();
      await destroyTestContext(context);
    }
  });
});
