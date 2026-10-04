import { describe, expect, it } from "vitest";
import type { MatchState, RoundOutcome } from "../core/match/types";
import { roundResultText, triggerResultText } from "./round-notice";

function withOutcome(outcome: RoundOutcome): MatchState {
  return { round: { outcome } } as MatchState;
}

describe("round result notice", () => {
  it("summarizes bust penalties without redundant scores", () => {
    const state = withOutcome({ winner: "player", reason: "bust", penaltyTarget: "opponent", bulletsAdded: 2 });
    expect(roundResultText(state, "示例对手")).toBe("示例对手爆牌，装填2发子弹，接受左轮惩罚。");
  });

  it("names the winner and penalty target for comparison and Blackjack", () => {
    const comparison = withOutcome({ winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 });
    const blackjack = withOutcome({ winner: "opponent", reason: "blackjack", penaltyTarget: "player", bulletsAdded: 2 });
    expect(roundResultText(comparison, "示例对手")).toBe("策展人点数比较胜利，示例对手装填1发子弹，接受左轮惩罚。");
    expect(roundResultText(blackjack, "示例对手")).toBe("示例对手黑杰克，策展人装填2发子弹，接受左轮惩罚。");
  });

  it("describes pushes and cancelled penalties", () => {
    const push = withOutcome({ winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 });
    const cancelled = withOutcome({ winner: "opponent", reason: "comparison", penaltyTarget: "player", bulletsAdded: 1 });
    expect(roundResultText(push, "示例对手")).toBe("平局，即将进入下一轮。");
    expect(roundResultText(cancelled, "示例对手", true)).toBe("示例对手点数比较胜利，策展人装填1发子弹，免于左轮惩罚。");
  });
});

describe("roulette result notice", () => {
  it.each([
    ["empty-chamber", "咔哒……空膛"],
    ["misfire", "咔哒……哑火！"],
    ["fired", "砰！"]
  ] as const)("formats %s without secondary survival messages", (result, expected) => {
    const event = {
      type: "TRIGGER_PULLED" as const,
      actor: "player" as const,
      probability: result === "fired" ? 1 : 0,
      baseProbability: result === "misfire" ? 0.5 : result === "fired" ? 1 : 0,
      misfireChance: result === "misfire" ? 0.5 : 0,
      result,
      fired: result === "fired"
    };
    expect(triggerResultText(event)).toBe(expected);
  });
});
