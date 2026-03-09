import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importMemoryMarkdown, parseMemoryMarkdown } from "../src/importers/memory-md.js";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("MEMORY.md importer", () => {
  it("parses level 2 and 3 sections into paragraph and bullet facts", () => {
    const sections = parseMemoryMarkdown(`# Memory

## Sirius
Enjoys astronomy.
- Prefers green tea

### Tools
- Uses Redis daily
`);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      heading: "Sirius",
      paragraphs: ["Enjoys astronomy."],
      bullets: ["Prefers green tea"],
    });
    expect(sections[1]).toMatchObject({
      heading: "Tools",
      bullets: ["Uses Redis daily"],
    });
  });

  it("imports sections as fact memories and graph records", async () => {
    const context = await createTestContext();
    try {
      const filePath = path.join(context.rootDir, "MEMORY.md");
      await writeFile(
        filePath,
        `# Personal Memory

## Sirius
- Sirius works with Alice on onboarding
- Prefers green tea

### Infrastructure
Redis is used for queues.
- Qdrant stores vectors
`,
      );

      const result = await importMemoryMarkdown(context.backend, {
        filePath,
        namespace: "sirius",
      });

      expect(result.sections).toBe(2);
      expect(result.memories).toBe(4);
      expect(result.entities).toBeGreaterThanOrEqual(5);

      const memories = await context.backend.memories.search({
        namespace: "sirius",
        types: ["fact"],
        includeArchived: true,
        limit: 10,
      });
      expect(memories).toHaveLength(4);
      expect(memories.some((memory) => memory.content.includes("Alice"))).toBe(true);

      const sirius = await context.backend.graph.searchEntities({ namespace: "sirius", name: "Sirius", limit: 5 });
      expect(sirius[0]?.name).toBe("Sirius");

      const relations = await context.backend.graph.searchRelations({
        namespace: "sirius",
        relationType: "mentions",
        limit: 20,
      });
      expect(relations.length).toBeGreaterThanOrEqual(2);
    } finally {
      await destroyTestContext(context);
    }
  });
});
