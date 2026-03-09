import { describe, expect, it } from "vitest";
import { exportMemories, memoriesToCsv } from "../src/cli/export.js";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("export CLI helpers", () => {
  it("exports filtered memories as JSON and CSV", async () => {
    const context = await createTestContext();
    try {
      await context.backend.memories.create({
        type: "fact",
        namespace: "sirius",
        content: "Sirius prefers green tea",
        tags: ["profile", "tea"],
        category: "preference",
      });
      await context.backend.memories.create({
        type: "episode",
        namespace: "sirius",
        content: "Sirius deployed the release",
        tags: ["ops"],
        category: "deployment",
      });
      await context.backend.memories.create({
        type: "fact",
        namespace: "orion",
        content: "Orion uses coffee",
        tags: ["profile"],
        category: "preference",
      });

      const json = await exportMemories(context.backend, {
        format: "json",
        namespace: "sirius",
        types: ["fact"],
        tags: ["tea"],
      });
      const parsed = JSON.parse(json) as Array<{ namespace: string; type: string; content: string }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        namespace: "sirius",
        type: "fact",
      });

      const csv = await exportMemories(context.backend, {
        format: "csv",
        namespace: "sirius",
      });
      expect(csv).toContain("id,type,namespace,content");
      expect(csv).toContain("Sirius prefers green tea");
      expect(csv).toContain("Sirius deployed the release");
      expect(csv).not.toContain("Orion uses coffee");
    } finally {
      await destroyTestContext(context);
    }
  });

  it("escapes CSV values correctly", () => {
    const csv = memoriesToCsv([
      {
        id: "1",
        type: "fact",
        namespace: "sirius",
        content: 'Line with "quotes", commas, and\nnewlines',
        summary: null,
        contentHash: null,
        category: null,
        tags: ["tea", "profile"],
        importance: 0.5,
        source: null,
        agentId: null,
        sessionId: null,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
        status: "active",
        supersededBy: null,
        expiresAt: null,
        embeddingModel: null,
        embeddingVersion: 0,
        embeddedAt: null,
      },
    ]);

    expect(csv).toContain('"Line with ""quotes"", commas, and');
    expect(csv).toContain('"[""tea"",""profile""]"');
  });
});
