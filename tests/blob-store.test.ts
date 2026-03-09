import { describe, expect, it } from "vitest";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("FilesystemBlobStore", () => {
  it("stores, gets, lists, and deletes blobs", async () => {
    const context = await createTestContext();
    try {
      const id = await context.backend.blobs.store(Buffer.from("hello blob", "utf8"), {
        namespace: "docs",
        filename: "note.txt",
        source: "unit-test",
      });

      const content = await context.backend.blobs.get(id);
      expect(content.toString("utf8")).toBe("hello blob");

      const listed = await context.backend.blobs.list({ namespace: "docs" });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id,
        namespace: "docs",
        filename: "note.txt",
      });
      expect(listed[0]?.size).toBe(10);

      await context.backend.blobs.delete(id);
      await expect(context.backend.blobs.get(id)).rejects.toThrow(`Blob ${id} not found`);
      expect(await context.backend.blobs.list({ namespace: "docs" })).toHaveLength(0);
    } finally {
      await destroyTestContext(context);
    }
  });
});
