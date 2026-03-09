import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ServerMnemosyneBackend } from "../src/server-backend.js";

const hasServerEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.QDRANT_URL && process.env.QDRANT_API_KEY,
);

describe.skipIf(!hasServerEnv)("ServerMnemosyneBackend", () => {
  test("runs memory CRUD, graph, vector search, and queue flows", { timeout: 30_000 }, async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-server-test-"));
    const backend = new ServerMnemosyneBackend({
      databaseUrl: process.env.DATABASE_URL,
      redisUrl: process.env.REDIS_URL,
      qdrantUrl: process.env.QDRANT_URL,
      qdrantApiKey: process.env.QDRANT_API_KEY,
      blobsPath: path.join(rootDir, "blobs"),
      qdrantCollection: `mnemosyne_test_${Date.now()}`,
      defaultNamespace: "_test",
    });

    try {
      await backend.initialize();
      const namespace = `ns-${Date.now()}`;

      const memory = await backend.memories.create({
        type: "fact",
        namespace,
        content: "Alice prefers green tea over coffee.",
        summary: "Alice tea preference",
        tags: ["alice", "tea"],
        details: {
          entityName: "Alice",
          factType: "preference",
        },
      });

      expect(await backend.memories.get(memory.id)).toMatchObject({
        id: memory.id,
        namespace,
        type: "fact",
      });

      await backend.memories.update(memory.id, { summary: "Alice likes green tea", status: "archived" });
      const archived = await backend.memories.search({ namespace, includeArchived: true, status: ["archived"] });
      expect(archived.map((item) => item.id)).toContain(memory.id);

      const alice = await backend.graph.createEntity({ name: `Alice-${namespace}`, entityType: "person", namespace });
      const tea = await backend.graph.createEntity({ name: `Tea-${namespace}`, entityType: "thing", namespace });
      await backend.graph.createRelation({
        fromEntity: alice.id,
        toEntity: tea.id,
        relationType: "likes",
        namespace,
      });

      const traversed = await backend.graph.traverse(alice.id, { namespace, depth: 1, limit: 10 });
      expect(traversed.nodes.map((node) => node.entity.id)).toEqual(expect.arrayContaining([alice.id, tea.id]));

      await backend.vectors.store(memory.id, 0, {
        chunkText: memory.content,
        vector: new Array<number>(512).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        model: "test-model",
        dimensions: 512,
      });
      const vectorResults = await backend.vectors.search(new Array<number>(512).fill(0).map((_, index) => (index === 0 ? 1 : 0)), {
        namespace,
        includeArchived: true,
        limit: 5,
      });
      expect(vectorResults[0]?.id).toBe(memory.id);

      const jobId = await backend.queue.enqueue({
        type: "embed",
        payload: { memory_id: memory.id },
        priority: 10,
      });
      const claimed = await backend.dequeueByType("embed");
      expect(claimed?.id).toBe(jobId);
      await backend.queue.complete(jobId);
      const stats = await backend.queue.stats();
      expect(stats.completed).toBeGreaterThanOrEqual(1);
    } finally {
      try {
        await backend.lifecycle.close();
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    }
  });
});
