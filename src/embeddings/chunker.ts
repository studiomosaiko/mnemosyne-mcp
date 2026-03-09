export interface TextChunk {
  chunkIndex: number;
  text: string;
  tokenCount: number;
  startToken: number;
  endToken: number;
}

export interface ChunkingOptions {
  chunkSize?: number;
  overlap?: number;
}

function tokenize(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function chunkText(text: string, options: ChunkingOptions = {}): TextChunk[] {
  const chunkSize = options.chunkSize ?? 300;
  const overlap = options.overlap ?? 50;
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0");
  }
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error("overlap must be between 0 and chunkSize - 1");
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  const step = chunkSize - overlap;
  for (let startToken = 0; startToken < tokens.length; startToken += step) {
    const endToken = Math.min(tokens.length, startToken + chunkSize);
    const slice = tokens.slice(startToken, endToken);
    if (slice.length === 0) {
      continue;
    }
    chunks.push({
      chunkIndex: chunks.length,
      text: slice.join(" "),
      tokenCount: slice.length,
      startToken,
      endToken,
    });
    if (endToken >= tokens.length) {
      break;
    }
  }
  return chunks;
}
