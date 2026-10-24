import { describe, expect, it } from "vitest";
import { addFirstCharacterDefeat } from "./defeats";

describe("character defeat progression", () => {
  it("keeps the first acquisition timestamp across rematches", () => {
    const first = addFirstCharacterDefeat([], "example-character", "2026-01-01T00:00:00.000Z");
    const repeated = addFirstCharacterDefeat(first, "example-character", "2026-02-01T00:00:00.000Z");
    expect(repeated).toBe(first);
    expect(repeated).toEqual([{ opponentId: "example-character", timestamp: "2026-01-01T00:00:00.000Z" }]);
  });
});
