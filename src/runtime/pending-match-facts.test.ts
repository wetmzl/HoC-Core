import { expect, it } from "vitest";
import { createCard } from "../core/blackjack/card";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { Action, MatchState } from "../core/match/types";
import { PendingMatchFacts } from "./pending-match-facts";

it("retains action snapshots across a failed checkpoint and a round transition, then releases committed actions", () => {
  const base = createMatch("pending-cross-round", { opponentId: "llama", openingSkillCards: 0 });
  const cards = [createCard("spades", "4", "p4"), createCard("spades", "6", "p6"),
    createCard("hearts", "4", "o4"), createCard("hearts", "6", "o6")];
  const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false };
  const initial: MatchState = { ...base, player, opponent, shoe: { ...base.shoe, cards: [...cards, ...base.shoe.cards], cursor: 4 },
    round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null },
    history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
  const pending = new PendingMatchFacts(), original: MatchFactBatch[] = [];
  let state = initial;
  for (const action of [{ type: "PLAYER_STAND" }, { type: "OPPONENT_STAND" }, { type: "ACK_ROUND_RESULT" }] as const satisfies readonly Action[]) {
    const next = gameReducer(state, action), batch = createMatchFactBatch(state, next);
    expect(next).not.toBe(state);
    pending.retain(batch); original.push(batch); state = next;
  }
  expect(state.roundIndex).toBe(1);
  const checkpoint = createMatchFactBatch(initial, state);
  const retry = pending.forCheckpoint(checkpoint);
  expect(retry).toHaveLength(3);
  retry.forEach((batch, index) => expect(batch).toBe(original[index]));
  expect(retry.map(batch => batch.after.roundIndex)).toEqual([0, 0, 1]);
  expect(retry[1].after.player.hand.cards.map(card => card.id)).toEqual(["p4", "p6"]);
  expect(retry[2].after.player.hand.cards.map(card => card.id)).not.toEqual(["p4", "p6"]);
  pending.committed(checkpoint);
  expect(pending.forCheckpoint(checkpoint)).toHaveLength(1);
});

it("keeps later accepted actions while an earlier write completes", () => {
  const initial = createMatch("pending-two-actions", { opponentId: "llama", openingSkillCards: 0 });
  const first = gameReducer(initial, { type: "PLAYER_STAND" }), second = gameReducer(first, { type: "OPPONENT_STAND" });
  const firstBatch = createMatchFactBatch(initial, first), secondBatch = createMatchFactBatch(first, second);
  const pending = new PendingMatchFacts();
  pending.retain(firstBatch); pending.retain(secondBatch);
  expect(pending.forCheckpoint(firstBatch)).toEqual([firstBatch]);
  pending.committed(firstBatch);
  expect(pending.forCheckpoint(secondBatch)[0]).toBe(secondBatch);
  pending.committed(secondBatch);
  expect(pending.forCheckpoint(secondBatch)[0]).not.toBe(secondBatch);
});
