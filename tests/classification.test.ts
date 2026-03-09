import { describe, expect, it } from "vitest";
import { classifyMemory } from "../src/sqlite/backend.js";

describe("classifyMemory", () => {
  it("respects explicit non-auto types", () => {
    expect(classifyMemory({ content: "x", type: "fact" })).toBe("fact");
    expect(classifyMemory({ content: "x", type: "procedure" })).toBe("procedure");
  });

  it("classifies procedures from steps or workflow phrasing", () => {
    expect(classifyMemory({ content: "First, open the app. Then deploy.", steps: ["open app"] })).toBe("procedure");
    expect(classifyMemory({ content: "Use this runbook to recover the system.", name: "Recovery workflow" })).toBe("procedure");
  });

  it("classifies facts from metadata or preference heuristics", () => {
    expect(classifyMemory({ content: "Alice prefers tea.", entityName: "Alice", factType: "preference" })).toBe("fact");
    expect(classifyMemory({ content: "Joao gosta de cafe." })).toBe("fact");
    expect(classifyMemory({ content: "Confidence-specified note", confidence: 0.6 })).toBe("fact");
  });

  it("classifies episodes as the default", () => {
    expect(classifyMemory({ content: "We met yesterday to discuss launch.", participants: ["Alice"] })).toBe("episode");
    expect(classifyMemory({ content: "A general conversation happened." })).toBe("episode");
  });
});
