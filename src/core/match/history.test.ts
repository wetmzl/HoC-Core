import { describe, expect, it } from "vitest";
import { createMatch, gameReducer } from "./reducer";
import { summarizeMatch } from "./history";
import type { MatchState } from "./types";

describe("match history summaries", () => {
  it("summarizes the final guns and counts both actors' events", () => {
    const finished = gameReducer(createMatch("history-stats"), { type: "ESCAPE_MATCH" });
    const history: MatchState["history"] = [
      ...finished.history,
      { type: "BUST", actor: "player" },
      { type: "BUST", actor: "opponent" },
      { type: "BLACKJACK", actor: "opponent" },
      { type: "BLACKJACK", actor: "opponent" }
    ];
    const state: MatchState = {
      ...finished,
      roulette: {
        player: { capacity: 6, bullets: 2 },
        opponent: { capacity: 6, bullets: 5 }
      },
      history
    };

    expect(summarizeMatch(state, "2026-08-30T00:00:00.000Z")).toEqual({
      id: finished.id,
      timestamp: "2026-08-30T00:00:00.000Z",
      opponentId: finished.opponentId,
      winner: null,
      escaped: true,
      finalRoulette: {
        player: { capacity: 6, bullets: 2 },
        opponent: { capacity: 6, bullets: 5 }
      },
      busts: { player: 1, opponent: 1 },
      blackjacks: { player: 0, opponent: 2 }
    });
  });

  it("rejects an active state so a partial match cannot enter match history", () => {
    expect(() => summarizeMatch(createMatch("history-active"), "2026-08-30T00:00:00.000Z")).toThrow(/unfinished/);
  });
});
