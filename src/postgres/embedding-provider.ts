import type { EmbeddingProvider } from "../embeddings/provider.js";

export interface PostgresEmbeddingProviderOptions {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  version?: number;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

export class PostgresEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string;
  public readonly version: number;
  private readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly dimensions: number | null;

  constructor(options: PostgresEmbeddingProviderOptions = {}) {
    this.apiUrl = options.apiUrl ?? process.env.EMBEDDING_API_URL ?? "http://localhost:11434/v1/embeddings";
    this.apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY ?? null;
    this.model = options.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    this.dimensions = options.dimensions ?? (Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? "", 10) || null);
    this.version = options.version ?? 1;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as EmbeddingsResponse;
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
      throw new Error("Embedding response did not include a numeric vector");
    }
    if (this.dimensions && vector.length !== this.dimensions) {
      throw new Error(`Embedding dimensions mismatch: expected ${this.dimensions}, received ${vector.length}`);
    }
    return vector;
  }
}
