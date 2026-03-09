import { describe, expect, it } from "vitest";
import { callTool, listToolDefinitions } from "../src/server/tools.js";
import { createTestContext, destroyTestContext, parseToolText } from "./helpers.js";

describe("MCP tools", () => {
  it("lists the expected tool definitions", () => {
    const names = listToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "memory_add",
        "memory_search",
        "memory_recall",
        "entity_upsert",
        "memory_purge",
        "memory_stats",
      ]),
    );
  });

  it("handles memory, graph, stats, and purge tools", async () => {
    const context = await createTestContext();
    try {
      const add = parseToolText(
        await callTool(context.backend, "memory_add", {
          content: "Alice prefers green tea and keeps a morning checklist.",
          type: "auto",
          entity_name: "Alice",
          fact_type: "preference",
          importance: 0.8,
          namespace: "agent-a",
          tags: ["alice", "tea"],
        }),
      ) as { id: string; type: string; queued_for_embedding: boolean };
      expect(add.type).toBe("fact");
      expect(add.queued_for_embedding).toBe(true);

      const search = parseToolText(
        await callTool(context.backend, "memory_search", {
          namespace: "agent-a",
          query: "green tea",
          include_archived: true,
        }),
      ) as { results: Array<{ id: string }> };
      expect(search.results.map((item) => item.id)).toContain(add.id);

      const recall = parseToolText(
        await callTool(context.backend, "memory_recall", {
          namespace: "agent-a",
          query: "Alice tea",
          limit: 5,
        }),
      ) as { results: Array<{ id: string; score: number }> };
      expect(recall.results[0]?.id).toBe(add.id);
      expect(recall.results[0]?.score).toBeGreaterThan(0);

      const entity = parseToolText(
        await callTool(context.backend, "entity_upsert", {
          name: "Alice",
          entity_type: "person",
          namespace: "agent-a",
          observations: [{ content: "Alice is active in the team." }],
        }),
      ) as { id: string; name: string };
      expect(entity.name).toBe("Alice");

      const relationTarget = parseToolText(
        await callTool(context.backend, "entity_upsert", {
          name: "Tea Club",
          entity_type: "group",
          namespace: "agent-a",
        }),
      ) as { id: string };

      const relation = parseToolText(
        await callTool(context.backend, "relation_upsert", {
          from_entity: "Alice",
          to_entity: "Tea Club",
          relation_type: "member_of",
          namespace: "agent-a",
        }),
      ) as { id: string; relationType: string };
      expect(relation.relationType).toBe("member_of");

      const graphTraverse = parseToolText(
        await callTool(context.backend, "graph_traverse", {
          start: entity.id,
          namespace: "agent-a",
          depth: 1,
        }),
      ) as { nodes: Array<{ entity: { id: string } }>; edges: Array<{ relation: { id: string } }> };
      expect(graphTraverse.nodes.map((node) => node.entity.id)).toContain(entity.id);
      expect(graphTraverse.edges.map((edge) => edge.relation.id)).toContain(relation.id);

      const graphSearch = parseToolText(
        await callTool(context.backend, "graph_search", {
          namespace: "agent-a",
          entity_name: "Alice",
          entity_id: entity.id,
        }),
      ) as { entities: Array<{ id: string }>; relations: Array<{ id: string }> };
      expect(graphSearch.entities.map((item) => item.id)).toContain(entity.id);
      expect(graphSearch.relations.map((item) => item.id)).toContain(relation.id);

      const procedure = parseToolText(
        await callTool(context.backend, "procedure_save", {
          name: "Morning checklist",
          namespace: "agent-a",
          steps: ["Wake up", "Make tea"],
          tags: ["routine"],
        }),
      ) as { id: string };
      const procedureV2 = parseToolText(
        await callTool(context.backend, "procedure_save", {
          name: "Morning checklist",
          namespace: "agent-a",
          steps: ["Wake up", "Hydrate", "Make tea"],
          tags: ["routine"],
        }),
      ) as { id: string };
      expect(procedureV2.id).not.toBe(procedure.id);
      expect((await context.backend.memories.get(procedure.id))?.status).toBe("archived");
      expect((await context.backend.memories.get(procedure.id))?.supersededBy).toBe(procedureV2.id);
      const procedureGet = parseToolText(
        await callTool(context.backend, "procedure_get", {
          namespace: "agent-a",
          name: "Morning checklist",
        }),
      ) as { results: Array<{ id: string }> };
      expect(procedureGet.results.map((item) => item.id)).toContain(procedureV2.id);

      const blob = parseToolText(
        await callTool(context.backend, "blob_store", {
          namespace: "agent-a",
          filename: "greeting.txt",
          data_base64: Buffer.from("hello", "utf8").toString("base64"),
        }),
      ) as { id: string };
      expect(await context.backend.blobs.get(blob.id)).toEqual(Buffer.from("hello", "utf8"));

      const factQuery = parseToolText(
        await callTool(context.backend, "fact_query", {
          namespace: "agent-a",
          entity_name: "Alice",
        }),
      ) as { results: Array<{ id: string }> };
      expect(factQuery.results.map((item) => item.id)).toContain(add.id);

      const timeline = parseToolText(
        await callTool(context.backend, "timeline", {
          namespace: "agent-a",
          limit: 20,
        }),
      ) as { results: Array<{ id: string }> };
      expect(timeline.results.length).toBeGreaterThanOrEqual(2);

      const consolidate = parseToolText(
        await callTool(context.backend, "memory_consolidate", {
          namespace: "agent-a",
          limit: 5,
        }),
      ) as { queued: boolean; job_id: string };
      expect(consolidate.queued).toBe(true);
      expect(consolidate.job_id).toBeTruthy();

      const statsBeforePurge = parseToolText(
        await callTool(context.backend, "memory_stats", { namespace: "agent-a" }),
      ) as { total_memories: number; by_type: Record<string, number>; queue: { pending: number }; event_log: { valid: boolean } };
      expect(statsBeforePurge.total_memories).toBeGreaterThanOrEqual(3);
      expect(statsBeforePurge.by_type.fact).toBeGreaterThanOrEqual(1);
      expect(statsBeforePurge.queue.pending).toBeGreaterThanOrEqual(1);
      expect(statsBeforePurge.event_log.valid).toBe(true);

      const purged = parseToolText(
        await callTool(context.backend, "memory_purge", {
          target_id: add.id,
          reason: "user request",
          cascade: true,
        }),
      ) as { purged: number; audit_id: string };
      expect(purged.purged).toBe(1);
      expect(purged.audit_id).toBeTruthy();
      expect(await context.backend.memories.get(add.id)).toBeNull();
    } finally {
      await destroyTestContext(context);
    }
  });
});
