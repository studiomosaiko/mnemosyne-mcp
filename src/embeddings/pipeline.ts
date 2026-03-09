import type { MemoryStore, VectorStore } from "../interfaces/index.js";
import { nowIso } from "../sqlite/utils.js";
import { chunkText, type TextChunk } from "./chunker.js";
import type { EmbeddingProvider } from "./provider.js";

export interface EmbeddingJobQueue {
  dequeueByType(type: string): Promise<{ id: string; payload: Record<string, unknown> } | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

export interface EmbeddingPipelineOptions {
  provider: EmbeddingProvider;
  memories: MemoryStore;
  vectors: VectorStore;
  queue: EmbeddingJobQueue;
  chunkSize?: number;
  overlap?: number;
}

export class EmbeddingPipeline {
  private readonly chunkSize: number;
  private readonly overlap: number;

  constructor(private readonly options: EmbeddingPipelineOptions) {
    this.chunkSize = options.chunkSize ?? 300;
    this.overlap = options.overlap ?? 50;
  }

  async processNext(): Promise<boolean> {
    const job = await this.options.queue.dequeueByType("embed");
    if (!job) {
      return false;
    }

    try {
      const memoryId = String(job.payload.memory_id ?? "");
      if (!memoryId) {
        throw new Error("embed job missing memory_id");
      }
      const memory = await this.options.memories.get(memoryId);
      if (!memory) {
        throw new Error(`Memory ${memoryId} not found`);
      }

      const chunks = chunkText(memory.content, {
        chunkSize: this.chunkSize,
        overlap: this.overlap,
      });
      await this.options.vectors.delete(memory.id);
      for (const chunk of this.normalizeChunks(chunks, memory.content)) {
        const vector = await this.options.provider.embed(chunk.text);
        await this.options.vectors.store(memory.id, chunk.chunkIndex, {
          chunkText: chunk.text,
          vector,
          model: this.options.provider.model,
          dimensions: vector.length,
          version: this.options.provider.version,
          createdAt: nowIso(),
        });
      }
      await this.options.memories.update(memory.id, {
        embeddingModel: this.options.provider.model,
        embeddingVersion: this.options.provider.version,
        embeddedAt: nowIso(),
      });
      await this.options.queue.complete(job.id);
      return true;
    } catch (error) {
      await this.options.queue.fail(job.id, error instanceof Error ? error.message : String(error));
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

  private normalizeChunks(chunks: TextChunk[], fallbackText: string): TextChunk[] {
    if (chunks.length > 0) {
      return chunks;
    }
    return [
      {
        chunkIndex: 0,
        text: fallbackText.trim(),
        tokenCount: fallbackText.trim() ? 1 : 0,
        startToken: 0,
        endToken: fallbackText.trim() ? 1 : 0,
      },
    ].filter((chunk) => chunk.text.length > 0);
  }
}
