import { describe, expect, it } from "vitest";
import { createCard } from "../core/blackjack/card";
import { createMatch } from "../core/match/reducer";
import type { Card, Rank, Suit } from "../core/blackjack/types";
import type { GameEvent, MatchState, RoundOutcome, RoundPhase } from "../core/match/types";
import { readCharacterFixture } from "../test/character-fixtures";
import { type CharacterDialogue } from "./types";
import { resolveDialogueLine, resolveDialogueState as resolve } from "./state";

const card = (rank: Rank, suit: Suit = "spades") => createCard(suit, rank);

function findMatch(predicate: (state: MatchState) => boolean): MatchState {
  for (let index = 0; index < 10_000; index += 1) {
    const state = createMatch(`dialogue-state-${index}`);
    if (predicate(state)) return state;
  }
  throw new Error("No dialogue fixture found");
}

function turnsMatch(): MatchState {
  return findMatch((state) => state.round.phase === "turns");
}

function withActions(...events: GameEvent[]): MatchState {
  const base = turnsMatch();
  return { ...base, round: { ...base.round, phase: "turns" }, history: [...base.history, ...events] };
}

function reveal(playerCards: Card[], opponentCards: Card[], outcome: RoundOutcome): MatchState {
  const base = turnsMatch();
  const history: GameEvent[] = [
    { type: "ROUND_STARTED", roundIndex: 0 },
    ...playerCards.map((entry): GameEvent => ({ type: "CARD_DEALT", actor: "player", card: entry, private: true })),
    ...opponentCards.map((entry): GameEvent => ({ type: "CARD_DEALT", actor: "opponent", card: entry, private: true })),
    { type: "ROUND_RESOLVED", outcome }
  ];
  return { ...base, round: { ...base.round, phase: "round-reveal", currentActor: null, outcome }, history };
}

function rouletteState(phase: "roulette-reaction" | "roulette-trigger"): MatchState {
  const base = turnsMatch();
  return {
    ...base,
    round: { ...base.round, phase, outcome: { winner: phase === "roulette-reaction" ? "opponent" : "player", reason: "comparison", penaltyTarget: phase === "roulette-reaction" ? "player" : "opponent", bulletsAdded: 1 } },
    history: [...base.history, { type: "ROUND_RESULT_ACKNOWLEDGED" }]
  };
}

function triggerState(actor: "player" | "opponent", result: "fired" | "empty-chamber" | "misfire"): MatchState {
  const base = turnsMatch();
  return {
    ...base,
    round: { ...base.round, phase: "roulette-result" },
    history: [...base.history, {
      type: "TRIGGER_PULLED", actor, probability: result === "fired" ? 1 : 0,
      baseProbability: result === "misfire" ? 0.5 : result === "fired" ? 1 : 0,
      misfireChance: result === "misfire" ? 0.5 : 0, result, fired: result === "fired"
    }]
  };
}

function protectedTrigger(actor: "player" | "opponent"): MatchState {
  const state = triggerState(actor, "fired");
  return { ...state, history: [...state.history, { type: "DEFEAT_PREVENTED", actor, sourceInstanceId: "fixture-protection" }] };
}

const comparison = (winner: "player" | "opponent"): RoundOutcome => ({
  winner,
  reason: "comparison",
  penaltyTarget: winner === "player" ? "opponent" : "player",
  bulletsAdded: 1
});
const source = readCharacterFixture("chatgpt").dialogue;
// This historical resolver suite covers normal game events; plugin taps have their own event tests.
const poolIds = Object.keys(source.pools).filter(id => !["CHARACTER_TAP", "CHARACTER_TAP_DEFEATED", "CHARACTER_TAP_ROULETTE"].includes(id));
const testDialogue: CharacterDialogue = { ...source, pools: Object.fromEntries(poolIds.map(id => [id, [`${id}-甲`, `${id}-乙`]])) };
const resolveDialogueState = (state: MatchState) => resolve(state, testDialogue);

describe("declarative character dialogue resolver", () => {
  it("keeps Blackjack pools distinct from generic round-win pools", () => {
    const playerBlackjack = reveal([card("A"), card("K")], [card("10", "hearts"), card("9", "hearts")], { winner: "player", reason: "blackjack", penaltyTarget: "opponent", bulletsAdded: 2 });
    const opponentBlackjack = reveal([card("10"), card("9")], [card("A", "hearts"), card("K", "hearts")], { winner: "opponent", reason: "blackjack", penaltyTarget: "player", bulletsAdded: 2 });
    expect(resolveDialogueState(playerBlackjack).poolId).toBe("PLAYER_BLACKJACK");
    expect(resolveDialogueState(opponentBlackjack).poolId).toBe("OPPONENT_BLACKJACK");
    const naturalBeatsOrdinaryTwentyOne = reveal(
      [card("A"), card("K")],
      [card("7", "hearts"), card("7", "diamonds"), card("7", "clubs")],
      { winner: "player", reason: "blackjack", penaltyTarget: "opponent", bulletsAdded: 2 }
    );
    expect(resolveDialogueState(naturalBeatsOrdinaryTwentyOne).poolId).toBe("PLAYER_BLACKJACK");
  });

  it("selects one result pool when special-hand predicates also overlap", () => {
    const bothTwentyOne = reveal(
      [card("2"), card("4"), card("5"), card("10")],
      [card("A", "hearts"), card("K", "hearts")],
      { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0}
    );
    const smallTwentyOneVersusTwenty = reveal(
      [card("2"), card("4"), card("5"), card("10")],
      [card("10", "hearts"), card("Q", "hearts")],
      comparison("player")
    );
    expect(resolveDialogueState(bothTwentyOne).poolId).toBe("SPECIAL_TWENTY_ONE_PUSH");
    expect(resolveDialogueState(smallTwentyOneVersusTwenty).poolId).toBe("PLAYER_WIN_ROUND");
  });

  it("uses reason-specific bust and ordinary comparison pools", () => {
    const playerBust = reveal(
      [card("10"), card("9"), card("5")],
      [card("10", "hearts"), card("8", "hearts")],
      { winner: "opponent", reason: "bust", penaltyTarget: "player", bulletsAdded: 1}
    );
    const ordinaryWin = reveal([card("10"), card("8")], [card("10", "hearts"), card("7", "hearts")], comparison("player"));
    expect(resolveDialogueState(playerBust).poolId).toBe("PLAYER_BUST");
    expect(resolveDialogueState(ordinaryWin).poolId).toBe("PLAYER_WIN_ROUND");
  });

  it("distinguishes the three requested AI action contexts", () => {
    const firstHit = withActions({ type: "OPPONENT_HIT", value: 14 });
    const firstStand = withActions({ type: "OPPONENT_STOOD" });
    const repeatedHit = withActions(
      { type: "PLAYER_STOOD" },
      { type: "OPPONENT_HIT", value: 12 },
      { type: "OPPONENT_HIT", value: 16 }
    );
    expect(resolveDialogueState(firstHit).poolId).toBe("OPPONENT_FIRST_HIT");
    expect(resolveDialogueState(firstStand).poolId).toBe("OPPONENT_FIRST_STAND");
    expect(resolveDialogueState(repeatedHit).poolId).toBe("OPPONENT_REPEAT_HIT_AFTER_PLAYER_STAND");
  });

  it("keeps the opening or latest player-action dialogue unchanged across a skipped turn", () => {
    const opening = withActions();
    const openingSkipped = {
      ...opening,
      history: [...opening.history, { type: "TURN_SKIPPED", actor: "opponent", sourceInstanceId: "skip-opening" } as const]
    };
    expect(resolveDialogueState(openingSkipped)).toEqual(resolveDialogueState(opening));
    expect(resolveDialogueLine(openingSkipped, testDialogue)).toBe(resolveDialogueLine(opening, testDialogue));

    const hit = withActions({ type: "PLAYER_HIT", value: 15 });
    const hitThenSkipped = {
      ...hit,
      history: [...hit.history, { type: "TURN_SKIPPED", actor: "opponent", sourceInstanceId: "skip-after-hit" } as const]
    };
    expect(resolveDialogueState(hitThenSkipped)).toEqual(resolveDialogueState(hit));
    expect(resolveDialogueState(hitThenSkipped).poolId).toBe("PLAYER_HIT");
    expect(resolveDialogueLine(hitThenSkipped, testDialogue)).toBe(resolveDialogueLine(hit, testDialogue));
  });

  it("returns exactly one registered pool for every match phase", () => {
    const phases: RoundPhase[] = [
      "dealing", "initial-blackjack-check", "turns", "settlement", "round-reveal",
      "roulette-reaction", "roulette-trigger", "roulette-result", "round-end"
    ];
    const base = turnsMatch();
    for (const phase of phases) {
      const state = { ...base, round: { ...base.round, phase } };
      const selected = resolveDialogueState(state);
      expect(poolIds).toContain(selected.poolId);
      expect(typeof selected.poolId).toBe("string");
    }
  });

  it("has a reachable, non-overlapping state for every active dialogue pool", () => {
    const playerBlackjack = reveal([card("A"), card("K")], [card("10", "hearts"), card("9", "hearts")], { winner: "player", reason: "blackjack", penaltyTarget: "opponent", bulletsAdded: 2 });
    const opponentBlackjack = reveal([card("10"), card("9")], [card("A", "hearts"), card("K", "hearts")], { winner: "opponent", reason: "blackjack", penaltyTarget: "player", bulletsAdded: 2 });
    const push: RoundOutcome = { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0};
    const states: MatchState[] = [
      turnsMatch(),
      withActions({ type: "PLAYER_HIT", value: 14 }),
      withActions({ type: "PLAYER_STOOD" }),
      withActions({ type: "OPPONENT_HIT", value: 14 }),
      withActions({ type: "OPPONENT_STOOD" }),
      withActions({ type: "PLAYER_STOOD" }, { type: "OPPONENT_HIT", value: 12 }, { type: "OPPONENT_HIT", value: 16 }),
      playerBlackjack,
      opponentBlackjack,
      reveal([card("10"), card("9"), card("5")], [card("10", "hearts"), card("8", "hearts")], { winner: "opponent", reason: "bust", penaltyTarget: "player", bulletsAdded: 1}),
      reveal([card("10"), card("8")], [card("10", "hearts"), card("9", "hearts"), card("5", "clubs")], { winner: "player", reason: "bust", penaltyTarget: "opponent", bulletsAdded: 1}),
      triggerState("player", "empty-chamber"),
      triggerState("opponent", "empty-chamber"),
      reveal([card("10"), card("7")], [card("10", "hearts"), card("8", "hearts")], comparison("opponent")),
      reveal([card("10"), card("7")], [card("9", "hearts"), card("8", "hearts")], push),
      rouletteState("roulette-reaction"),
      rouletteState("roulette-trigger"),
      triggerState("player", "fired"),
      triggerState("opponent", "fired"),
      protectedTrigger("player"),
      protectedTrigger("opponent"),
      reveal([card("A"), card("K")], [card("A", "hearts"), card("Q", "hearts")], push),
      reveal([card("10"), card("Q")], [card("10", "hearts"), card("9", "hearts")], comparison("player")),
      reveal([card("10"), card("3")], [card("8", "hearts"), card("5", "hearts")], push)
    ];
    const selected = states.map((state) => resolveDialogueState(state).poolId);
    expect(new Set(selected)).toEqual(new Set(poolIds));
    expect(selected).toHaveLength(poolIds.length);
  });

  it("reuses the ordinary non-firing dialogue pools for ability misfires", () => {
    expect(resolveDialogueState(triggerState("player", "misfire")).poolId).toBe("PLAYER_SURVIVED_TRIGGER");
    expect(resolveDialogueState(triggerState("opponent", "misfire")).poolId).toBe("OPPONENT_SURVIVED_TRIGGER");
  });
});
