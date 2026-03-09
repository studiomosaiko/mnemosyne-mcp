import { describe, expect, it } from "vitest";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("SqliteGraphStore", () => {
  it("creates entities, relations, observations, traverses, and searches", async () => {
    const context = await createTestContext();
    try {
      const alice = await context.backend.graph.createEntity({
        name: "Alice",
        entityType: "person",
        namespace: "team",
        observations: [{ content: "Alice leads platform engineering." }],
      });
      const bob = await context.backend.graph.createEntity({
        name: "Bob",
        entityType: "person",
        namespace: "team",
      });
      const acme = await context.backend.graph.createEntity({
        name: "Acme",
        entityType: "company",
        namespace: "team",
      });

      const relation = await context.backend.graph.createRelation({
        fromEntity: alice.id,
        toEntity: bob.id,
        relationType: "works_with",
        namespace: "team",
        weight: 0.6,
      });
      await context.backend.graph.createRelation({
        fromEntity: bob.id,
        toEntity: acme.id,
        relationType: "employed_by",
        namespace: "team",
      });
      const observation = await context.backend.graph.addObservation({
        entityId: bob.id,
        namespace: "team",
        content: "Bob handles incident response.",
        confidence: 0.95,
      });

      expect(relation.weight).toBe(0.6);
      expect(observation.content).toBe("Bob handles incident response.");

      const traverse = await context.backend.graph.traverse(alice.id, { namespace: "team", depth: 2, limit: 10 });
      expect(traverse.nodes.map((node) => node.entity.name)).toEqual(expect.arrayContaining(["Alice", "Bob", "Acme"]));
      expect(traverse.edges).toHaveLength(2);

      const people = await context.backend.graph.searchEntities({ namespace: "team", entityType: "person", limit: 10 });
      expect(people.map((entity) => entity.name)).toEqual(expect.arrayContaining(["Alice", "Bob"]));

      const relations = await context.backend.graph.searchRelations({ namespace: "team", entityId: bob.id, limit: 10 });
      expect(relations).toHaveLength(2);
    } finally {
      await destroyTestContext(context);
    }
  });

  it("purges entities with cascading graph cleanup", async () => {
    const context = await createTestContext();
    try {
      const one = await context.backend.graph.createEntity({ name: "One", entityType: "node", namespace: "graph" });
      const two = await context.backend.graph.createEntity({ name: "Two", entityType: "node", namespace: "graph" });
      await context.backend.graph.createRelation({
        fromEntity: one.id,
        toEntity: two.id,
        relationType: "linked_to",
        namespace: "graph",
      });
      await context.backend.graph.addObservation({
        entityId: one.id,
        namespace: "graph",
        content: "Observed in graph namespace.",
      });

      await context.backend.graph.purgeEntity(one.id);

      expect(await context.backend.graph.searchEntities({ namespace: "graph", limit: 10 })).toHaveLength(1);
      expect(await context.backend.graph.searchRelations({ namespace: "graph", limit: 10 })).toHaveLength(0);
      const observations = context.backend.db.prepare("SELECT COUNT(*) AS count FROM observations").get() as { count: number };
      expect(observations.count).toBe(0);
    } finally {
      await destroyTestContext(context);
    }
  });

  it("enforces namespace triggers for relations and observations", async () => {
    const context = await createTestContext();
    try {
      const left = await context.backend.graph.createEntity({ name: "Left", entityType: "node", namespace: "a" });
      const right = await context.backend.graph.createEntity({ name: "Right", entityType: "node", namespace: "b" });

      await expect(
        context.backend.graph.createRelation({
          fromEntity: left.id,
          toEntity: right.id,
          relationType: "invalid",
          namespace: "a",
        }),
      ).rejects.toThrow("relation namespace must match both entity namespaces");

      await expect(
        context.backend.graph.addObservation({
          entityId: left.id,
          namespace: "b",
          content: "Wrong namespace",
        }),
      ).rejects.toThrow("observation namespace must match entity namespace");

      const shared = await context.backend.graph.createRelation({
        fromEntity: left.id,
        toEntity: right.id,
        relationType: "shared_link",
        namespace: "_shared",
      });
      expect(shared.namespace).toBe("_shared");
    } finally {
      await destroyTestContext(context);
    }
  });
});
