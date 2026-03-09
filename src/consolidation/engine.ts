import type { Memory, MemoryType } from "../interfaces/index.js";
import { detectEntities, dequeueTypedJob, type SqliteMnemosyneBackend } from "../sqlite/backend.js";

interface ConsolidationGroup {
  key: string;
  namespace: string;
  type: MemoryType;
  timeframe: string;
  entity: string;
  memories: Memory[];
}

interface ConsolidationRow {
  memory_id: string;
  entity_name: string | null;
}

export class ConsolidationEngine {
  constructor(private readonly backend: SqliteMnemosyneBackend) {}

  async processNext(): Promise<boolean> {
    const job = await dequeueTypedJob(this.backend, "consolidate");
    if (!job) {
      return false;
    }

    try {
      const namespace = typeof job.payload.namespace === "string" ? job.payload.namespace : undefined;
      const limit = typeof job.payload.limit === "number" ? job.payload.limit : 50;
      const groups = await this.loadGroups(namespace, limit);

      for (const group of groups.filter((candidate) => candidate.memories.length > 1)) {
        const consolidated = await this.backend.memories.create({
          type: group.type,
          namespace: group.namespace,
          content: this.summarizeGroup(group),
          summary: `Consolidated ${group.type} for ${group.entity} (${group.timeframe})`,
          tags: ["consolidated", group.entity.toLowerCase()],
          importance: Math.max(...group.memories.map((memory) => memory.importance)),
        });
        for (const memory of group.memories) {
          await this.backend.memories.update(memory.id, {
            status: "archived",
            supersededBy: consolidated.id,
          });
        }
        await this.backend.queue.enqueue({
          type: "embed",
          payload: { memory_id: consolidated.id },
          priority: 1,
        });
      }

      await this.backend.queue.complete(job.id as string);
      return true;
    } catch (error) {
      await this.backend.queue.fail(job.id as string, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async drain(limit = 100): Promise<number> {
    let processed = 0;
    while (processed < limit && (await this.processNext())) {
      processed += 1;
    }
    return processed;
  }

  private async loadGroups(namespace: string | undefined, limit: number): Promise<ConsolidationGroup[]> {
    const memories = await this.backend.memories.search({
      namespace,
      includeArchived: false,
      limit,
    });
    const factRows = this.backend.db
      .prepare("SELECT memory_id, entity_name FROM facts WHERE memory_id IN (SELECT id FROM memories)")
      .all() as ConsolidationRow[];
    const factLookup = new Map(factRows.map((row) => [row.memory_id, row.entity_name]));
    const groups = new Map<string, ConsolidationGroup>();

    for (const memory of memories) {
      const entity = this.resolveEntity(memory, factLookup.get(memory.id) ?? null);
      const timeframe = memory.createdAt.slice(0, 7);
      const key = `${memory.namespace}:${entity}:${timeframe}:${memory.type}`;
      const existing = groups.get(key);
      if (existing) {
        existing.memories.push(memory);
        continue;
      }
      groups.set(key, {
        key,
        namespace: memory.namespace,
        type: memory.type,
        timeframe,
        entity,
        memories: [memory],
      });
    }

    return [...groups.values()];
  }

  private resolveEntity(memory: Memory, factEntity: string | null): string {
    if (factEntity) {
      return factEntity;
    }
    const detected = detectEntities(`${memory.summary ?? ""} ${memory.content}`);
    return detected[0] ?? "general";
  }

  private summarizeGroup(group: ConsolidationGroup): string {
    return group.memories
      .map((memory, index) => {
        const heading = `Memory ${index + 1} (${memory.createdAt})`;
        const body = memory.summary ?? memory.content;
        return `${heading}: ${body}`;
      })
      .join("\n");
  }
}
