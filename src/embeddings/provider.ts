export interface EmbeddingProvider {
  readonly model: string;
  readonly version: number;
  embed(text: string): Promise<number[]>;
}
