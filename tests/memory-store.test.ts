import { describe, expect, it } from "vitest";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("SqliteMemoryStore", () => {
  it("creates and gets typed memories", async () => {
    const context = await createTestContext();
    try {
      const episode = await context.backend.memories.create({
        type: "episode",
        namespace: "agent-a",
        content: "Met Alice in Paris.\n\nDiscussed launch plans.",
        summary: "Met Alice",
        tags: ["meeting", "launch"],
        category: "work",
        importance: 0.9,
        details: {
          eventType: "meeting",
          participants: ["Alice"],
          location: "Paris",
        },
      });

      const loaded = await context.backend.memories.get(episode.id);
      expect(loaded).toMatchObject({
        id: episode.id,
        type: "episode",
        namespace: "agent-a",
        content: "Met Alice in Paris. Discussed launch plans.",
        tags: ["meeting", "launch"],
        category: "work",
        importance: 0.9,
      });
    } finally {
      await destroyTestContext(context);
    }
  });

  it("updates memories and supports structured plus text search", async () => {
    const context = await createTestContext();
    try {
      const first = await context.backend.memories.create({
        type: "fact",
        namespace: "agent-a",
        content: "Alice prefers tea over coffee.",
        tags: ["preference", "alice"],
        category: "profile",
        importance: 0.7,
        details: {
          entityName: "Alice",
          factType: "preference",
        },
      });
      await context.backend.memories.create({
        type: "episode",
        namespace: "agent-a",
        content: "Team retrospective covered deployment issues.",
        tags: ["work", "retro"],
        category: "meeting",
        importance: 0.4,
      });

      await context.backend.memories.update(first.id, {
        summary: "Alice likes tea",
        status: "archived",
        tags: ["preference", "archived"],
      });

      expect(await context.backend.memories.search({ namespace: "agent-a" })).toHaveLength(1);

      const archived = await context.backend.memories.search({
        namespace: "agent-a",
        includeArchived: true,
        status: ["archived"],
        tags: ["archived"],
        category: "profile",
      });
      expect(archived).toHaveLength(1);
      expect(archived[0]?.summary).toBe("Alice likes tea");

      const text = await context.backend.memories.textSearch("deployment issues", {
        namespace: "agent-a",
        limit: 5,
      });
      expect(text).toHaveLength(1);
      expect(text[0]?.content).toContain("deployment issues");
      expect(text[0]?.score).toBeGreaterThan(0);
    } finally {
      await destroyTestContext(context);
    }
  });

  it("versions procedures by name and purges records", async () => {
    const context = await createTestContext();
    try {
      const first = await context.backend.memories.create({
        type: "procedure",
        namespace: "ops",
        content: "Step 1: open dashboard",
        details: {
          name: "Deploy service",
          steps: ["open dashboard"],
        },
      });
      const second = await context.backend.memories.create({
        type: "procedure",
        namespace: "ops",
        content: "Step 1: open dashboard\nStep 2: click deploy",
        details: {
          name: "Deploy service",
          steps: ["open dashboard", "click deploy"],
        },
      });

      expect(second.id).toBe(first.id);
      const procedureRow = context.backend.db
        .prepare("SELECT version, steps FROM procedures WHERE memory_id = ?")
        .get(first.id) as { version: number; steps: string };
      expect(procedureRow.version).toBe(2);
      expect(JSON.parse(procedureRow.steps)).toEqual(["open dashboard", "click deploy"]);

      await context.backend.memories.purge(first.id);
      expect(await context.backend.memories.get(first.id)).toBeNull();
      const procedureCount = context.backend.db.prepare("SELECT COUNT(*) AS count FROM procedures").get() as { count: number };
      expect(procedureCount.count).toBe(0);
    } finally {
      await destroyTestContext(context);
    }
  });

  it("throws when updating a missing memory", async () => {
    const context = await createTestContext();
    try {
      await expect(context.backend.memories.update("missing", { content: "nope" })).rejects.toThrow("Memory missing not found");
    } finally {
      await destroyTestContext(context);
    }
  });
});
