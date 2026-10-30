import { describe, expect, it } from "vitest";
import type { MatchState, RoundOutcome } from "../core/match/types";
import { roundResultText, triggerResultText } from "./round-notice";

function withOutcome(outcome: RoundOutcome): MatchState {
  return { round: { outcome } } as MatchState;
}

describe("round result notice", () => {
  it("summarizes bust penalties without redundant scores", () => {
    const state = withOutcome({ winner: "player", reason: "bust", penaltyTarget: "opponent", bulletsAdded: 2 });
    expect(roundResultText(state)).toBe("对手爆牌·装2发·受罚");
  });

  it("names the winner and penalty target for comparison and Blackjack", () => {
    const comparison = withOutcome({ winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 });
    const blackjack = withOutcome({ winner: "opponent", reason: "blackjack", penaltyTarget: "player", bulletsAdded: 2 });
    expect(roundResultText(comparison)).toBe("你胜利·对手装1发·受罚");
    expect(roundResultText(blackjack)).toBe("对手黑杰克·你装2发·受罚");
  });

  it("describes pushes and cancelled penalties", () => {
    const push = withOutcome({ winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 });
    const cancelled = withOutcome({ winner: "opponent", reason: "comparison", penaltyTarget: "player", bulletsAdded: 1 });
    expect(roundResultText(push)).toBe("平局·无惩罚");
    expect(roundResultText(cancelled, true)).toBe("对手胜利·你装1发·免罚");
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

it("describes a surviving real gunshot without calling it an empty chamber", () => {
  const event = { type: "TRIGGER_PULLED" as const, actor: "player" as const, probability: 1, baseProbability: 1, misfireChance: 0, result: "fired" as const, fired: true };
  expect(triggerResultText(event, true)).toBe("砰！你抵御了致命一击，对局继续。");
});
