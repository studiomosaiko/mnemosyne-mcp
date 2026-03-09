import { describe, expect, it } from "vitest";
import { createTestContext, destroyTestContext } from "./helpers.js";

describe("SqliteEventLog", () => {
  it("appends events and queries by target or action", async () => {
    const context = await createTestContext();
    try {
      await context.backend.events.append({
        id: "evt-1",
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "create",
        targetType: "memory",
        targetId: "m-1",
        data: { seq: 1 },
      });
      await context.backend.events.append({
        id: "evt-2",
        timestamp: "2024-01-01T00:00:01.000Z",
        action: "update",
        targetType: "memory",
        targetId: "m-1",
        data: { seq: 2 },
      });
      await context.backend.events.append({
        id: "evt-3",
        timestamp: "2024-01-01T00:00:02.000Z",
        action: "create",
        targetType: "entity",
        targetId: "e-1",
      });

      const targetResults = await context.backend.events.query({ targetId: "m-1", limit: 10 });
      expect(targetResults.map((event) => event.id)).toEqual(["evt-2", "evt-1"]);

      const creates = await context.backend.events.query({ action: "create", limit: 10 });
      expect(creates).toHaveLength(2);
      expect(creates[0]?.prevHash).toBeTruthy();
    } finally {
      await destroyTestContext(context);
    }
  });

  it("verifies the hash chain and detects tampering", async () => {
    const context = await createTestContext();
    try {
      await context.backend.events.append({
        id: "evt-1",
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "create",
        targetType: "memory",
        targetId: "m-1",
      });
      await context.backend.events.append({
        id: "evt-2",
        timestamp: "2024-01-01T00:00:01.000Z",
        action: "update",
        targetType: "memory",
        targetId: "m-1",
      });

      expect(await context.backend.events.verify()).toEqual({ valid: true });

      context.backend.db
        .prepare(
          "INSERT INTO event_log (id, timestamp, agent_id, action, target_type, target_id, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("evt-bad", "2024-01-01T00:00:02.000Z", null, "archive", "memory", "m-1", null, "wrong-prev-hash", "wrong-hash");

      expect(await context.backend.events.verify()).toEqual({ valid: false, brokenAt: "evt-bad" });
    } finally {
      await destroyTestContext(context);
    }
  });
});
