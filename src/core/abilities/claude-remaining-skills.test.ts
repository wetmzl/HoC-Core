import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import type { Card, Rank } from "../blackjack/types";
import { addAbilityInstance } from "./runtime";
import { instantiateAbility } from "./registry";
import { createMatch, gameReducer, getActiveBustLimit, getRoundHitCounts, previewPendingTrigger } from "../match/reducer";
import type { MatchState } from "../match/types";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { abilityTriggerNotice } from "../../presentation/ability-notices";

function fixture(level = 2, skill = "claude-ss-reasoning", playerRanks: Rank[] = ["3", "4"], opponentRanks: Rank[] = ["5", "6"], top: Rank = "2"): MatchState {
  const base = createMatch("claude-remaining", { opponentId: "claude", skillDeckIds: [], opponentAiSkills: [{ definitionId: skill, level, enabled: true, parameters: {} }] });
  const cards = [...playerRanks, ...opponentRanks, top, ...Array<Rank>(40).fill("2")].map((rank, index) => createCard("spades", rank, `card-${index}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, playerRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(playerRanks.length, playerRanks.length + opponentRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: playerRanks.length + opponentRanks.length, shuffleIndex: 1 },
    history: [{ type: "ROUND_STARTED", roundIndex: 0 }], playerSkills: { ...base.playerSkills, drawOffer: null },
    round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}
function opponentHit(state: MatchState): MatchState {
  return gameReducer({ ...state, round: { ...state.round, currentActor: "opponent" } }, { type: "OPPONENT_HIT" });
}
function restored(state: MatchState): MatchState {
  return validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
}
function pushNextRound(state: MatchState): MatchState {
  return gameReducer({ ...state, round: { ...state.round, phase: "round-reveal", outcome: { reason: "push", winner: null, penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
}
function withPlayerHand(state: MatchState, cards: readonly Card[]): MatchState {
  const player = { ...state.player, hand: { cards } };
  return { ...state, player, round: { ...state.round, player } };
}

describe("禁止蒸馏", () => {
  it.each([1, 2])("moves the exact Hit card without drawing, copying or emitting another Hit at level %s", level => {
    const before = gameReducer(fixture(level), { type: "PLAYER_HIT" });
    const card = before.player.hand.cards.at(-1)!;
    const after = opponentHit(before);
    expect(after.player.hand.cards.map(c => c.id)).not.toContain(card.id);
    expect(after.opponent.hand.cards.at(-1)).toEqual(card);
    expect(after.shoe).toEqual(before.shoe);
    expect(after.rng).toEqual(before.rng);
    expect(after.abilities.rng).toEqual(before.abilities.rng);
    expect(getRoundHitCounts(after)).toEqual({ player: 1, opponent: 0 });
    expect(after.round.currentActor).toBe("player");
    expect(after.opponent.stood).toBe(false);
    expect(after.history.some(e => e.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(abilityTriggerNotice(after.history.slice(before.history.length), "Claude", after)[0].text).toBe("Claude · 禁止蒸馏：将对手最后一次 Hit 的牌移入自己的手牌，代替本次 Hit");
    const allCards = [...after.player.hand.cards, ...after.opponent.hand.cards];
    expect(new Set(allCards.map(c => c.id)).size).toBe(allCards.length);
    // Taking again without a fresh player Hit must use the shoe, not an older hand card.
    const again = opponentHit(after);
    expect(again.shoe.cursor).toBe(after.shoe.cursor + 1);
    expect(again.player.hand).toEqual(after.player.hand);
  });

  it.each([1, 2])("uses a once-per-round budget only at level 1, including after save restoration: %s", level => {
    let state = opponentHit(gameReducer(fixture(level), { type: "PLAYER_HIT" }));
    state = restored(gameReducer(state, { type: "PLAYER_HIT" }));
    const card = state.player.hand.cards.at(-1)!;
    const after = opponentHit(state);
    expect(after.player.hand.cards.some(c => c.id === card.id)).toBe(level === 1);
    expect(after.shoe.cursor - state.shoe.cursor).toBe(level === 1 ? 1 : 0);
    expect(getRoundHitCounts(after).opponent).toBe(level === 1 ? 1 : 0);
  });

  it("resets both the successful-use budget and the last-Hit identity next round", () => {
    const spent = opponentHit(gameReducer(fixture(1), { type: "PLAYER_HIT" }));
    let fresh = pushNextRound(restored(spent));
    const noHit = opponentHit(fresh);
    expect(noHit.shoe.cursor).toBe(fresh.shoe.cursor + 1);
    fresh = { ...fresh, round: { ...fresh.round, currentActor: "player" } };
    fresh = gameReducer(fresh, { type: "PLAYER_HIT" });
    // Use low synthetic hands while retaining this round's actual Hit identity.
    const opponent = { ...fresh.opponent, hand: { cards: [createCard("clubs", "2", "fresh-low")] }, busted: false, bustLimit: undefined };
    fresh = { ...fresh, opponent, round: { ...fresh.round, opponent } };
    expect(opponentHit(fresh).shoe.cursor).toBe(fresh.shoe.cursor);
  });

  it("does not take initial cards or skill-added cards without a player Hit", () => {
    const before = fixture();
    const added = withPlayerHand(before, [...before.player.hand.cards, createDerivedCard("hearts", "2", "extra")]);
    const after = opponentHit(added);
    expect(after.player.hand).toEqual(added.player.hand);
    expect(after.shoe.cursor).toBe(added.shoe.cursor + 1);
  });

  it("rechecks both hands and clears the player's bust after the offending Hit is taken", () => {
    const before = gameReducer(fixture(2, "claude-ss-reasoning", ["10", "10"], ["2", "3"], "2"), { type: "PLAYER_HIT" });
    expect(before.player.busted).toBe(true);
    const after = opponentHit(before);
    expect(after.player.busted).toBe(false);
    expect(after.opponent.busted).toBe(false);
    expect(after.player.hand.cards).toHaveLength(2);
    expect(after.round.phase).toBe("turns");
  });

  it("finds the last actual Hit even when a skill appends another card afterwards", () => {
    const hit = gameReducer(fixture(), { type: "PLAYER_HIT" });
    const card = hit.player.hand.cards.at(-1)!;
    const extra = createDerivedCard("hearts", "A", "extra");
    const after = opponentHit(withPlayerHand(hit, [...hit.player.hand.cards, extra]));
    expect(after.opponent.hand.cards.at(-1)?.id).toBe(card.id);
    expect(after.player.hand.cards.at(-1)).toEqual(extra);
  });

  it("does not fall back to an older Hit if the latest Hit card has been removed", () => {
    let state = gameReducer(fixture(), { type: "PLAYER_HIT" });
    state = gameReducer({ ...state, round: { ...state.round, currentActor: "player" } }, { type: "PLAYER_HIT" });
    state = withPlayerHand(state, state.player.hand.cards.slice(0, -1));
    expect(opponentHit(state).player.hand).toEqual(state.player.hand);
  });

  it("does not spend the Lv1 budget on an unsafe card, and checks A at the effective limit", () => {
    let state = gameReducer(fixture(1, "claude-ss-reasoning", ["2", "3"], ["10", "8"], "4"), { type: "PLAYER_HIT" });
    const failed = opponentHit(state);
    expect(failed.player.hand).toEqual(state.player.hand);
    expect(failed.shoe.cursor).toBe(state.shoe.cursor + 1);
    expect(failed.history.some(e => e.type === "ABILITY_TRIGGERED" && e.definitionId === "claude-ss-reasoning")).toBe(false);
    const shoeCards = [...failed.shoe.cards];
    shoeCards[failed.shoe.cursor] = createCard("hearts", "A", "safe-ace");
    state = gameReducer({ ...failed, shoe: { ...failed.shoe, cards: shoeCards } }, { type: "PLAYER_HIT" });
    const after = opponentHit(state);
    expect(after.opponent.hand.cards.at(-1)?.id).toBe("safe-ace");
    expect(after.opponent.busted).toBe(false);
    expect(after.shoe.cursor).toBe(state.shoe.cursor);
  });

  it("uses the raised common limit but does not trigger 克劳德时刻 on transfer", () => {
    let state = fixture(2, "claude-ss-reasoning", ["2", "3"], ["10", "9"], "3");
    const moment = instantiateAbility({ definitionId: "claude-ss-moment", level: 2, enabled: true, parameters: {} }, "opponent", "moment", state.abilities.sequence + 1, undefined, "ai-skill");
    state = { ...state, abilities: addAbilityInstance(state.abilities, moment) };
    state = opponentHit(state); // A real Hit raises the shared limit to 22.
    expect(getActiveBustLimit(state, "opponent")).toBe(22);
    const opponent = { ...state.opponent, hand: { cards: state.opponent.hand.cards.slice(0, 2) }, bustLimit: undefined };
    const cards = [...state.shoe.cards];
    cards[state.shoe.cursor] = createCard("clubs", "3", "limit-three");
    state = gameReducer({ ...state, opponent, shoe: { ...state.shoe, cards }, round: { ...state.round, opponent } }, { type: "PLAYER_HIT" });
    const after = opponentHit(state); // 19 + 3 is safe only at the raised limit of 22.
    expect(after.shoe.cursor).toBe(state.shoe.cursor);
    expect(getActiveBustLimit(after, "opponent")).toBe(22);
    expect(getRoundHitCounts(after).opponent).toBe(1);
  });

  it("never activates when Claude chooses Stand", () => {
    const hit = gameReducer(fixture(), { type: "PLAYER_HIT" });
    const after = gameReducer(hit, { type: "OPPONENT_STAND" });
    expect(after.player.hand).toEqual(hit.player.hand);
    expect(after.opponent.hand).toEqual(hit.opponent.hand);
  });
});

function triggerFixture(level: number, bullets: number, actor: "player" | "opponent" = "opponent"): MatchState {
  const base = fixture(level, "claude-ss-verdict");
  return { ...base, roulette: { player: { capacity: 8, bullets }, opponent: { capacity: 8, bullets } },
    round: { ...base.round, phase: "round-reveal", currentActor: null, outcome: { reason: "comparison", winner: actor === "player" ? "opponent" : "player", penaltyTarget: actor, bulletsAdded: 1 } } };
}

describe("高岭之花", () => {
  it.each([1, 2].flatMap(level => [0, 1, 4, 5, 8].map(bullets => ({ level, bullets }))))("protects only at the authored threshold: $level / $bullets", ({ level, bullets }) => {
    const before = triggerFixture(level, bullets);
    const protectedNow = bullets <= (level === 2 ? 4 : 0);
    const preview = previewPendingTrigger(before)!;
    expect(preview.cancelled).toBe(protectedNow);
    expect(before.roundIndex).toBe(0); // Preview is discarded.
    const acknowledged = gameReducer(before, { type: "ACK_ROUND_RESULT" });
    const after = protectedNow ? acknowledged : gameReducer(acknowledged, { type: "TRIGGER_ROULETTE" });
    expect(after.roundIndex).toBe(protectedNow ? 1 : 0);
    expect(after.history.some(e => e.type === "TRIGGER_PULLED")).toBe(!protectedNow);
    if (protectedNow) {
      expect(after.rng.roulette).toEqual(before.rng.roulette);
      expect(after.roulette.opponent.bullets).toBe(bullets);
    }
  });

  it.each([1, 2])("never protects the player at level %s", level => {
    const before = triggerFixture(level, 0, "player");
    expect(previewPendingTrigger(before)?.cancelled).toBe(false);
    expect(gameReducer(before, { type: "ACK_ROUND_RESULT" }).round.phase).toBe("roulette-reaction");
  });

  it("checks after ordinary settlement loads the fifth bullet, including after restore", () => {
    let state = fixture(2, "claude-ss-verdict", ["10", "10"], ["2", "3"]);
    state = { ...state, roulette: { ...state.roulette, opponent: { capacity: 8, bullets: 4 } } };
    state = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_STAND" });
    expect(state.round.phase).toBe("round-reveal");
    expect(state.roulette.opponent.bullets).toBe(5);
    expect(previewPendingTrigger(restored(state))?.cancelled).toBe(false);
  });
});
