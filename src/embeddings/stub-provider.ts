import type { EmbeddingProvider } from "./provider.js";

export interface StubEmbeddingProviderOptions {
  dimensions?: number;
  model?: string;
  version?: number;
}

export class StubEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string;
  public readonly version: number;

  constructor(private readonly dimensions: number = 16, options: StubEmbeddingProviderOptions = {}) {
    this.model = options.model ?? "stub-local";
    this.version = options.version ?? 1;
    this.dimensions = options.dimensions ?? dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const bucket = index % this.dimensions;
      vector[bucket] += (code * ((index % 7) + 1)) / 997;
    }
    return vector.map((value) => Number((value / Math.max(text.length, 1)).toFixed(6)));
  }
}
