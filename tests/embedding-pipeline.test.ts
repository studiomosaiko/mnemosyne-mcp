import { describe, expect, it } from "vitest";
import { EmbeddingPipeline } from "../src/embeddings/pipeline.js";
import { StubEmbeddingProvider } from "../src/embeddings/stub-provider.js";
import { dequeueTypedJob } from "../src/sqlite/backend.js";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("EmbeddingPipeline", () => {
  it("chunks memories, stores embeddings, and marks memories as embedded", async () => {
    const context = await createTestContext();
    try {
      const memory = await context.backend.memories.create({
        type: "episode",
        namespace: "agent-a",
        content: Array.from({ length: 620 }, (_, index) => `token-${index}`).join(" "),
      });
      await context.backend.queue.enqueue({ type: "embed", payload: { memory_id: memory.id } });

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

      expect(await pipeline.processNext()).toBe(true);

      const rows = context.backend.db
        .prepare("SELECT chunk_index, model, dimensions FROM embeddings WHERE memory_id = ? ORDER BY chunk_index ASC")
        .all(memory.id) as Array<{ chunk_index: number; model: string; dimensions: number }>;
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.chunk_index)).toEqual([0, 1, 2]);
      expect(rows[0]?.model).toBe("stub-local");
      expect(rows[0]?.dimensions).toBe(16);

      const updated = await context.backend.memories.get(memory.id);
      expect(updated?.embeddingModel).toBe("stub-local");
      expect(updated?.embeddingVersion).toBe(1);
      expect(updated?.embeddedAt).toBeTruthy();
    } finally {
      await destroyTestContext(context);
    }
  });
});
