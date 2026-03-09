import { describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  hmacSha256,
  sanitizeText,
  sha256,
} from "../src/sqlite/utils.js";
import { fuseScores, recencyScore } from "../src/sqlite/backend.js";

describe("sqlite utils", () => {
  it("hashes content deterministically", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hmacSha256("abc", Buffer.from("salt"))).toBe("5031dfb5b067c1d64e70ad09acb9c5421c194ebb0ecff635f6eea656d1fc8e2c");
  });

  it("sanitizes text and computes cosine similarity", () => {
    expect(sanitizeText(" Hello\u0000\nworld \t\t test ")).toBe("Hello world test");
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });

  it("scores recency and fuses weighted scores", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T00:00:00.000Z"));
    try {
      expect(recencyScore("2026-03-09T00:00:00.000Z")).toBe(1);
      expect(recencyScore("2026-02-27T00:00:00.000Z")).toBeCloseTo(0.909091, 6);
      expect(
        fuseScores({
          semantic: 0.9,
          text: 0.8,
          graph: 0.4,
          recency: 1,
          importance: 0.5,
        }),
      ).toBe(0.76);
    } finally {
      vi.useRealTimers();
    }
  });
});
