import { describe, expect, it } from "vitest";
import { createMatch } from "../core/match/reducer";
import { AI_TURN_MAX_DELAY_MS, AI_TURN_MIN_DELAY_MS, getAiTurnDelayMs } from "./ai-timing";

describe("AI turn presentation timing", () => {
  it("is deterministic and always waits between two and four seconds", () => {
    const states = Array.from({ length: 32 }, (_, index) => createMatch(`ai-wait-${index}`));
    const delays = states.map(getAiTurnDelayMs);
    expect(delays).toEqual(states.map(getAiTurnDelayMs));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(AI_TURN_MIN_DELAY_MS);
    expect(Math.max(...delays)).toBeLessThanOrEqual(AI_TURN_MAX_DELAY_MS);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });
});
