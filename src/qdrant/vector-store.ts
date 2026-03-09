import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import type { MemoryStore, ReindexFilter, ScoredMemory, VectorSearchOptions, VectorStore, EmbeddingData } from "../interfaces/index.js";

function toUuid(memoryId: string, chunkIndex: number): string {
  const hash = createHash("sha256").update(`${memoryId}:${chunkIndex}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export interface QdrantVectorStoreOptions {
  client?: QdrantClient;
  url?: string;
  apiKey?: string;
  collectionName?: string;
  dimensions?: number;
  memories: MemoryStore;
}

export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly dimensions: number;
  private initialized = false;

  constructor(private readonly options: QdrantVectorStoreOptions) {
    this.client =
      options.client ??
      new QdrantClient({
        url: options.url ?? process.env.QDRANT_URL,
        apiKey: options.apiKey ?? process.env.QDRANT_API_KEY,
        checkCompatibility: false,
      });
    this.collectionName = options.collectionName ?? process.env.QDRANT_COLLECTION ?? "mnemosyne_memories";
    this.dimensions = options.dimensions ?? Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? "512", 10);
  }

  async store(memoryId: string, chunkIndex: number, embedding: EmbeddingData): Promise<void> {
    await this.ensureCollection(embedding.dimensions);
    const memory = await this.options.memories.get(memoryId);
    if (!memory) {
      throw new Error(`Memory ${memoryId} not found`);
    }
    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [
        {
          id: toUuid(memoryId, chunkIndex),
          vector: embedding.vector,
          payload: {
            memory_id: memoryId,
            chunk_index: chunkIndex,
            namespace: memory.namespace,
            type: memory.type,
            status: memory.status,
            model: embedding.model,
            version: embedding.version ?? 1,
          },
        },
      ],
    });
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<ScoredMemory[]> {
    await this.ensureCollection(embedding.length);
    const filterMust: Array<Record<string, unknown>> = [];
    if (options.namespace) {
      filterMust.push({ key: "namespace", match: { value: options.namespace } });
    }
    if (!options.includeArchived) {
      filterMust.push({ key: "status", match: { value: "active" } });
    }
    if (options.types?.length) {
      filterMust.push({
        key: "type",
        match: { any: options.types },
      });
    }
    const response = await this.client.query(this.collectionName, {
      query: embedding,
      limit: (options.limit ?? 10) * 5,
      with_payload: true,
      filter: filterMust.length > 0 ? { must: filterMust } : undefined,
    });
    const hits = response.points;
    const memoryIds = [...new Set(hits.map((hit) => String((hit.payload?.memory_id as string | undefined) ?? ""))).values()].filter(Boolean);
    if (memoryIds.length === 0) {
      return [];
    }
    const memories = await this.options.memories.search({
      ids: memoryIds,
      namespace: options.namespace,
      includeArchived: options.includeArchived,
      types: options.types,
      limit: memoryIds.length,
    });
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const bestByMemory = new Map<string, ScoredMemory>();
    for (const hit of hits) {
      const memoryId = String((hit.payload?.memory_id as string | undefined) ?? "");
      const memory = memoryById.get(memoryId);
      if (!memory) {
        continue;
      }
      const score = Number(Number(hit.score ?? 0).toFixed(6));
      const current = bestByMemory.get(memoryId);
      if (!current || score > current.score) {
        bestByMemory.set(memoryId, { ...memory, score });
      }
    }
    return [...bestByMemory.values()].sort((left, right) => right.score - left.score).slice(0, options.limit ?? 10);
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureCollection();
    await this.client.delete(this.collectionName, {
      wait: true,
      filter: {
        must: [{ key: "memory_id", match: { value: memoryId } }],
      },
    });
  }

  async reindex(filter: ReindexFilter): Promise<number> {
    const dimensions = Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? `${this.dimensions}`, 10);
    await this.client.recreateCollection(this.collectionName, {
      vectors: { size: dimensions, distance: "Cosine" },
    });
    this.initialized = true;
    const memories = await this.options.memories.search({
      namespace: filter.namespace,
      ids: filter.memoryIds,
      includeArchived: true,
      limit: filter.memoryIds?.length ?? 10_000,
    });
    return memories.length;
  }

  async hasEmbeddings(namespace?: string): Promise<boolean> {
    await this.ensureCollection();
    const page = await this.client.scroll(this.collectionName, {
      limit: 1,
      with_payload: ["namespace"],
      with_vector: false,
      filter: namespace ? { must: [{ key: "namespace", match: { value: namespace } }] } : undefined,
    });
    return page.points.length > 0;
  }

  private async ensureCollection(dimensions = this.dimensions): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      const exists = await this.client.collectionExists(this.collectionName);
      if (!exists.exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: { size: dimensions, distance: "Cosine" },
        });
      }
    } catch {
      try {
        await this.client.createCollection(this.collectionName, {
          vectors: { size: dimensions, distance: "Cosine" },
        });
      } catch {
        // Collection may already exist
      }
    }
    // Create payload indexes for filtering
    const indexes = ["namespace", "memory_id", "type", "status"];
    for (const field of indexes) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: "keyword",
          wait: true,
        });
      } catch {
        // Index may already exist
      }
    }
    this.initialized = true;
  }
}
