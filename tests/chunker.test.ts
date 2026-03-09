import { describe, expect, it } from "vitest";
import { chunkText } from "../src/embeddings/chunker.js";

describe("chunkText", () => {
  it("splits text into overlapping chunks", () => {
    const text = Array.from({ length: 620 }, (_, index) => `token-${index}`).join(" ");
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.tokenCount).toBe(300);
    expect(chunks[1]?.tokenCount).toBe(300);
    expect(chunks[2]?.tokenCount).toBe(120);
    expect(chunks[1]?.startToken).toBe(250);
    expect(chunks[2]?.startToken).toBe(500);
    expect(chunks[0]?.text.split(" ").slice(-50)).toEqual(chunks[1]?.text.split(" ").slice(0, 50));
  });

  it("returns no chunks for empty text", () => {
    expect(chunkText(" \n\t ")).toEqual([]);
  });
});
