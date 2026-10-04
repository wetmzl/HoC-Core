import { describe, expect, it } from "vitest";
import { createCard } from "../core/blackjack/card";
import { createMatch } from "../core/match/reducer";
import type { Card, Rank, Suit } from "../core/blackjack/types";
import type { GameEvent, MatchState, RoundOutcome } from "../core/match/types";
import { roundOverrideDialogueEvent } from "./round-context";

const card = (rank: Rank, suit: Suit = "spades") => createCard(suit, rank);

function contextualState(playerCards: Card[], opponentCards: Card[], outcome: RoundOutcome): MatchState {
  const base = createMatch(`dialogue-${playerCards.map((entry) => entry.attributes.rank).join("")}-${opponentCards.map((entry) => entry.attributes.rank).join("")}`);
  const history: GameEvent[] = [
    { type: "ROUND_STARTED", roundIndex: 0 },
    ...playerCards.map((entry): GameEvent => ({ type: "CARD_DEALT", actor: "player", card: entry, private: true })),
    ...opponentCards.map((entry): GameEvent => ({ type: "CARD_DEALT", actor: "opponent", card: entry, private: true })),
    { type: "ROUND_RESOLVED", outcome }
  ];
  return {
    ...base,
    history,
    roundIndex: 0,
    round: { ...base.round, index: 0, phase: "round-reveal", outcome }
  };
}

const comparison = (winner: "player" | "opponent"): RoundOutcome => ({
  winner,
  reason: "comparison",
  penaltyTarget: winner === "player" ? "opponent" : "player",
  bulletsAdded: 1
});
const push: RoundOutcome = { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0};

describe("special round dialogue", () => {
  it("recognizes 21 vs 21 on the confirmation screen", () => {
    expect(roundOverrideDialogueEvent(contextualState([card("A"), card("K")], [card("A", "hearts"), card("Q")], push)))
      .toBe("SPECIAL_TWENTY_ONE_PUSH");
  });

  it("falls back to the ordinary winner pool for one-point finishes near 21", () => {
    expect(roundOverrideDialogueEvent(contextualState([card("7"), card("7", "hearts"), card("7", "clubs")], [card("10"), card("Q")], comparison("player"))))
      .toBeNull();
  });

  it("falls back to the ordinary winner pool for a four-card 21", () => {
    expect(roundOverrideDialogueEvent(contextualState([card("2"), card("4"), card("5"), card("10")], [card("10"), card("8")], comparison("player"))))
      .toBeNull();
  });

  it("recognizes low-value pushes only on the confirmation screen", () => {
    const state = contextualState([card("10"), card("3")], [card("8"), card("5")], push);
    expect(roundOverrideDialogueEvent(state)).toBe("SPECIAL_LOW_PUSH");
    expect(roundOverrideDialogueEvent({ ...state, round: { ...state.round, phase: "turns" } })).toBeNull();
  });
});

it("forgets the redealt actor's old cards when recognizing a low push", () => {
  const state = contextualState([card("10"), card("3")], [card("8"), card("5")], push);
  const old = [card("K", "clubs"), card("Q", "clubs"), card("5", "hearts")];
  const history = [...state.history];
  history.splice(1, 0, ...old.map((entry): GameEvent => ({ type: "CARD_DEALT", actor: "opponent", card: entry, private: true })), { type: "HAND_REDEALT", actor: "opponent", discardedCardIds: old.map(c => c.id) });
  expect(roundOverrideDialogueEvent({ ...state, history })).toBe("SPECIAL_LOW_PUSH");
});
