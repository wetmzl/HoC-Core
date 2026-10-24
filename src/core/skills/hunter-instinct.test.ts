import { expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { createHand } from "../blackjack/hand";
import { createMatch, gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { abilityTriggerNotice } from "../../presentation/ability-notices";

it("keeps Hunter Instinct's top-card reveal on gain and draw silent without removing the passive", () => {
  const base = createMatch("silent-hunter", { opponentId: "chatgpt", opponentAiSkills: [], skillDeckIds: [] });
  const player = { ...base.player, hand: createHand([createCard("spades", "2"), createCard("spades", "3")]), stood: false, busted: false };
  const opponent = { ...base.opponent, hand: createHand([createCard("diamonds", "10"), createCard("diamonds", "7")]), stood: true, busted: false };
  const first = createCard("hearts", "2"), second = createCard("clubs", "3");
  const offered: MatchState = {
    ...base, player, opponent,
    round: { ...base.round, phase: "turns", currentActor: "player", player, opponent, outcome: null },
    shoe: { cards: [first, second], cursor: 0, shuffleIndex: 1 },
    playerSkills: { ...base.playerSkills, drawCount: 1, drawOffer: { id: "hunter-offer", candidateDefinitionIds: ["hunter-instinct"], refreshesRemaining: 0 } }
  };
  const gained = gameReducer(offered, { type: "SELECT_SKILL_DRAW", definitionId: "hunter-instinct" });
  const gainedEvents = gained.history.slice(offered.history.length);
  expect(gainedEvents).toContainEqual({ type: "DRAW_PILE_CARD_SUIT_REVEALED", viewer: "player", cardId: first.id, suit: "hearts" });
  expect(abilityTriggerNotice(gainedEvents, "对手", gained)).toEqual([]);
  expect(gained.abilities.instances.find(instance => instance.definitionId === "hunter-instinct")?.ttl).toEqual({ type: "rounds", remaining: 2 });

  const hit = gameReducer(gained, { type: "PLAYER_HIT" });
  const hitEvents = hit.history.slice(gained.history.length);
  expect(hit.player.hand.cards).toContainEqual(first);
  expect(hitEvents).toContainEqual({ type: "DRAW_PILE_CARD_SUIT_REVEALED", viewer: "player", cardId: second.id, suit: "clubs" });
  expect(abilityTriggerNotice(hitEvents, "对手", hit)).toEqual([]);
  expect(hit.playerSkills.cards).toContainEqual(expect.objectContaining({ definitionId: "hunter-instinct" }));
});
