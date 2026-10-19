import { describe, expect, it } from "vitest";
import { priorityScore } from "./priority";

describe("priorityScore importance", () => {
  it("is neutral for a page nobody links to, and doubles at 63+ inbound links", () => {
    expect(priorityScore("high", 1, 1).importanceFactor).toBe(1);
    expect(priorityScore("high", 1, 1, 63).importanceFactor).toBe(2);
    expect(priorityScore("high", 1, 1, 100_000).importanceFactor).toBe(2);
  });

  it("ranks the same problem higher on a page many pages link to", () => {
    const quiet = priorityScore("medium", 1, 1, 0).score;
    const busy = priorityScore("medium", 1, 1, 20).score;
    expect(busy).toBeGreaterThan(quiet);
    expect(busy).toBeLessThan(quiet * 2);
    expect(quiet).toBe(30);
  });

  it("ignores nonsense input", () => {
    expect(priorityScore("low", 1, 1, -5).importanceFactor).toBe(1);
  });
});
