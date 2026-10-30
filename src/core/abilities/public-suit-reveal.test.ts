import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { describeCards } from "../../presentation/cards";
import { buildObservation } from "../ai/observation";
import { createCard } from "../blackjack/card";
import type { PhysicalCard } from "../blackjack/types";
import { publicHandCardIds } from "../match/card-visibility";
import { abilityWorld, createMatch, gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { SeededRng } from "../rng/seeded";
import { INITIAL_PLAYER_SKILL_IDS } from "../skills/definitions";
import { applyEffects } from "./effects";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "./registry";
import { AbilityDefinitionSchema } from "./schema";
import type { AbilityDefinition, AbilityWorld, Effect, StatusDefinition } from "./types";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const id = "neutral-public-suit-window", statusId = "neutral-public-suit-rounds";
const reveals: Effect[] = (["owner", "rival"] as const).map(target => ({ type: "reveal-hand-cards-matching-public-suits", target, suitsFrom: "owner" }));
const definition: AbilityDefinition = AbilityDefinitionSchema.parse({ id, name: "Public suits", description: "Reveal matching hidden cards for three rounds", sourceKind: "player-skill", primaryDomain: "intelligence-officer", skillTags: ["intelligence-officer"], tags: ["public-suits"], drop: { enabled: false, baseWeight: 1 }, stackable: false,
  activation: { type: "action", windows: ["owner-turn"], consume: "card" },
  rules: [{ id: "activate", trigger: "on-ability-played", effects: [{ type: "set-status-stacks", target: "owner", statusDefinitionId: statusId, amount: 3 }, ...reveals] }] });
const status: StatusDefinition = { id: statusId, defaultDuration: "match", rules: [
  { id: "initial", trigger: "on-round-start", effects: reveals },
  { id: "changed", trigger: "after-hand-changed", effects: reveals },
  { id: "expire", trigger: "on-round-end", effects: [{ type: "remove-status", target: "owner", statusDefinitionId: statusId, amount: 1 }] }
] };
function fixture(): MatchState {
  installAbilityRegistry([...original.definitions, definition], [...original.statuses, status], original.catalogVersion);
  const base = createMatch("neutral-public-suits", { opponentId: "llama", skillDeckIds: [], unlockedPlayerSkillIds: [...INITIAL_PLAYER_SKILL_IDS, id] });
  const current = setHands(base, [createCard("spades", "3", "p-public"), createCard("clubs", "4", "p-hidden"), createCard("spades", "2", "p-match")],
    [createCard("hearts", "3", "o-public"), createCard("clubs", "4", "o-hidden"), createCard("spades", "2", "o-match")]);
  return gameReducer({ ...current, playerSkills: { ...current.playerSkills, drawCount: 1, drawOffer: { id: "neutral-offer", refreshesRemaining: 0, candidateDefinitionIds: [id] } } }, { type: "SELECT_SKILL_DRAW", definitionId: id });
}
function setHands(state: MatchState, playerCards: readonly PhysicalCard[], opponentCards: readonly PhysicalCard[]): MatchState {
  const player = { ...state.player, hand: { cards: playerCards }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...state.opponent, hand: { cards: opponentCards }, stood: false, busted: false, bustLimit: undefined };
  const used = [...playerCards, ...opponentCards];
  return { ...state, player, opponent, shoe: { cards: [...used, ...Array.from({ length: 40 }, (_, i) => createCard("spades", "2", `pile-${state.roundIndex}-${i}`))], cursor: used.length, shuffleIndex: 1 },
    playerSkills: { ...state.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED", roundIndex: state.roundIndex }, ...used.map((card, i) => ({ type: "CARD_DEALT" as const, card, actor: i < playerCards.length ? "player" as const : "opponent" as const, private: i !== 0 && i !== playerCards.length }))],
    round: { ...state.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}
function activate(state: MatchState): MatchState { return gameReducer(state, { type: "PLAY_ABILITY", instanceId: state.playerSkills.cards.find(card => card.definitionId === id)!.instanceId }); }
function nextRound(state: MatchState): MatchState { return gameReducer({ ...state, round: { ...state.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" }); }

describe("matching public suit reveal", () => {
  it("uses only the source's public suits, reveals both actors completely, and updates AI and face-up rendering", () => {
    const before = fixture(); const after = activate(before);
    expect(after.history.filter(event => event.type === "CARD_REVEALED")).toEqual([{ type: "CARD_REVEALED", target: "player", cardId: "p-match" }, { type: "CARD_REVEALED", target: "opponent", cardId: "o-match" }]);
    expect(publicHandCardIds(after).has("o-hidden")).toBe(false);
    expect(buildObservation(after, "player").opponent.cards.map(card => card?.id ?? null)).toEqual(["o-public", null, "o-match"]);
    expect(buildObservation(after, "opponent").player.cards.map(card => card?.id ?? null)).toEqual(["p-public", null, "p-match"]);
    const rendered = describeCards(after.opponent.hand.cards, { faceUpCardIds: publicHandCardIds(after) });
    expect(rendered[2]).toMatchObject({ surface: "front", rank: "2", suit: "spades" });
    expect(rendered[1]).toMatchObject({ surface: "back", rank: null, suit: null });
    expect(after.playerSkills.cards).toHaveLength(0); expect(after.abilities.statuses.find(s => s.statusDefinitionId === statusId)?.stacks).toBe(3);
    expect(before.history.some(event => event.type === "CARD_REVEALED")).toBe(false);
    const restored = validateRuntimeSave(createRuntimeSave(after)).activeMatch!;
    expect(buildObservation(restored, "player")).toEqual(buildObservation(after, "player"));
    expect(activate(fixture())).toEqual(after);
  });

  it("reacts to actual new Hit cards without duplicating previous reveal events", () => {
    const before = activate(fixture());
    const after = gameReducer(before, { type: "PLAYER_HIT" });
    const drawn = after.player.hand.cards.at(-1)!;
    expect(drawn.id).toBe("pile-0-0"); expect(publicHandCardIds(after).has(drawn.id)).toBe(true);
    expect(after.history.filter(event => event.type === "CARD_REVEALED" && event.cardId === "o-match")).toHaveLength(1);
    expect(after.history.filter(event => event.type === "CARD_REVEALED" && event.cardId === drawn.id)).toHaveLength(1);
  });

  it("counts the activation round, stays active for two later rounds, then stops revealing new cards", () => {
    let state = activate(fixture());
    for (const remaining of [2, 1]) {
      state = nextRound(state);
      expect(state.abilities.statuses.find(s => s.statusDefinitionId === statusId)?.stacks).toBe(remaining);
      const suits = new Set(state.player.hand.cards.filter(card => publicHandCardIds(state).has(card.id)).map(card => card.attributes.suit));
      for (const card of [...state.player.hand.cards, ...state.opponent.hand.cards].filter(card => suits.has(card.attributes.suit))) expect(publicHandCardIds(state).has(card.id)).toBe(true);
    }
    state = nextRound(state);
    expect(state.abilities.statuses.some(s => s.statusDefinitionId === statusId)).toBe(false);
    expect(state.abilities.instances.some(instance => instance.definitionId === id)).toBe(false);
    const after = gameReducer({ ...state, round: { ...state.round, currentActor: "player" } }, { type: "PLAYER_HIT" });
    expect(publicHandCardIds(after).has(after.player.hand.cards.at(-1)!.id)).toBe(false);
  });

  it("retains a revealed identity through same-round transfers and state expiry, but resets at the next round boundary", () => {
    const before = activate(fixture()); const card = before.opponent.hand.cards[2];
    const player = { ...before.player, hand: { cards: [...before.player.hand.cards, card] } }, opponent = { ...before.opponent, hand: { cards: before.opponent.hand.cards.slice(0, 2) } };
    const transferred = { ...before, player, opponent, round: { ...before.round, player, opponent }, abilities: { ...before.abilities, statuses: [] } };
    expect(buildObservation(transferred, "opponent").player.cards.at(-1)?.id).toBe(card.id);
    const fresh = { ...transferred, roundIndex: 1, round: { ...transferred.round, index: 1 }, history: [...transferred.history, { type: "ROUND_STARTED" as const, roundIndex: 1 }] };
    expect(buildObservation(fresh, "opponent").player.cards.at(-1)).toBeNull();
    const notYetLogged = { ...transferred, roundIndex: 1, round: { ...transferred.round, index: 1 } };
    expect(buildObservation(notYetLogged, "opponent").player.cards.at(-1)).toBeNull();
  });

  it("uses a newly face-up card's suit within the same effects transaction", () => {
    const before = fixture(); const world = abilityWorld(before);
    const registry = createStandaloneAbilityRegistry([definition], [status]);
    const ability = instantiateAbility({ definitionId: id, enabled: true, parameters: {} }, "player", "neutral", 1, registry);
    const result = applyEffects([
      { type: "acquire-card", target: "owner", reveal: true, choices: [{ source: "derived", candidate: { type: "resulting-hand-total-exactly", value: { type: "bust-limit", target: "owner" } }, evaluationLimit: { type: "bust-limit", target: "owner" }, pick: "uniform-ability-rng" }, { source: "derived", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "clubs" } }] },
      ...reveals
    ], { world, ability, rng: new SeededRng("new-public"), runtime: before.abilities, event: { trigger: "on-ability-played", sourceEventId: "neutral" }, bustLimitFor: () => 100 });
    const created = result.world.hands.player.cards.at(-1)!;
    expect(created.attributes.suit).toBe("clubs");
    expect(result.world.publicCardIds).toContain(created.id);
    expect(result.events).toContainEqual({ type: "CARD_REVEALED", target: "opponent", cardId: "o-hidden" });
  });

  it("recognizes face-up derived acquisitions and rejects invalid selectors", () => {
    const before = fixture(); const f = abilityWorld(before); const registry = createStandaloneAbilityRegistry([definition], [status]);
    const ability = instantiateAbility({ definitionId: id, enabled: true, parameters: {} }, "player", "neutral", 1, registry);
    const world: AbilityWorld = { ...f, publicCardIds: ["p-public", "o-public", "p-hidden"] };
    const result = applyEffects(reveals, { world, ability, rng: new SeededRng("neutral"), runtime: before.abilities, event: { trigger: "on-ability-played", sourceEventId: "neutral" } });
    expect(result.events).toContainEqual({ type: "CARD_REVEALED", target: "opponent", cardId: "o-hidden" });
    expect(() => applyEffects([{ type: "reveal-hand-cards-matching-public-suits", target: "owner", suitsFrom: "event-actor" }], { world, ability, rng: new SeededRng("neutral"), runtime: before.abilities, event: { trigger: "on-ability-played", sourceEventId: "neutral" } })).toThrow("Public suit source");
  });
});
