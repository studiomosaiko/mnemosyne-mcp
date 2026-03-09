import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SqliteMnemosyneBackend } from "../src/sqlite/backend.js";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("SqliteMnemosyneBackend", () => {
  it("creates a backend with all sub-stores and initializes migrations", async () => {
    const context = await createTestContext();
    try {
      expect(context.backend.memories).toBeDefined();
      expect(context.backend.graph).toBeDefined();
      expect(context.backend.vectors).toBeDefined();
      expect(context.backend.queue).toBeDefined();
      expect(context.backend.blobs).toBeDefined();
      expect(context.backend.events).toBeDefined();

      const applied = await context.backend.lifecycle.migrate();
      expect(applied).toEqual({ applied: 0, versions: [] });

      const tables = context.backend.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String((row as { name: string }).name));
      expect(tables).toContain("memories");
      expect(tables).toContain("event_log");
      expect(tables).toContain("schema_migrations");
    } finally {
      await destroyTestContext(context);
    }
  });

  it("backs up and restores database contents through lifecycle", async () => {
    const context = await createTestContext();
    try {
      const memory = await context.backend.memories.create({
        type: "episode",
        content: "Original content",
      });

      const backupId = await context.backend.lifecycle.backup("before-change");
      await access(`${context.rootDir}/backups/${backupId}`);

      await context.backend.memories.update(memory.id, { content: "Changed content" });
      expect((await context.backend.memories.get(memory.id))?.content).toBe("Changed content");

      await context.backend.lifecycle.restore(backupId);

      const reopened = new SqliteMnemosyneBackend(context.backend.options);
      await reopened.lifecycle.initialize();
      expect((await reopened.memories.get(memory.id))?.content).toBe("Original content");
      await reopened.lifecycle.close();
    } finally {
      await destroyTestContext(context);
    }
  });

  it("persists migrations checksums and closes cleanly", async () => {
    const context = await createTestContext();
    try {
      const migrations = context.backend.db
        .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; checksum: string }>;
      expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3]);
      expect(migrations.every((migration) => migration.checksum)).toBe(true);

      await context.backend.lifecycle.close();
      await writeFile(`${context.rootDir}/closed-sentinel`, "ok", "utf8");
      expect(await readFile(`${context.rootDir}/closed-sentinel`, "utf8")).toBe("ok");
    } finally {
      await destroyTestContext(context);
    }
  });
});
