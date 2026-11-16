import { afterEach, describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import { abilityWorld, createMatch, gameReducer, getLegalActions, normalizeAbilityHands, previewComparisonScores } from "./reducer";
import type { Actor, MatchState } from "./types";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { CORE_DIALOGUE_PRIMITIVES } from "../../dialogue/facts";
import { extractDialogueEvent, restoreDialogueEvent } from "../../dialogue/events";
import { resolveDialogueState } from "../../dialogue/state";
import { readCharacterFixture } from "../../test/character-fixtures";
import { buildObservation } from "../ai/observation";
import { decideOptimalAction } from "../ai/policy";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));

function fixture(playerRanks: Rank[] = ["10", "9"], opponentRanks: Rank[] = ["10", "9"], remaining: Rank[] = ["5", "5", "2", "2"]): MatchState {
  const base = createMatch("bust-continues", { opponentId: "chatgpt", opponentAiSkills: [], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
  let sequence = 0;
  const cards = (ranks: Rank[]) => ranks.map(rank => createCard("spades", rank, `neutral-${++sequence}`));
  const player = { ...base.player, hand: { cards: cards(playerRanks) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards(opponentRanks) }, stood: false, busted: false, bustLimit: undefined };
  const used = [...player.hand.cards, ...opponent.hand.cards];
  return { ...base, player, opponent, shoe: { cards: [...used, ...cards(remaining)], cursor: used.length, shuffleIndex: 1 },
    playerSkills: { ...base.playerSkills, drawOffer: null },
    round: { ...base.round, phase: "turns", currentActor: "player", player, opponent, outcome: null },
    history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex },
      ...used.map((card, index) => ({ type: "CARD_DEALT" as const, actor: index < player.hand.cards.length ? "player" as const : "opponent" as const, card, private: true }))] };
}
function turn(state: MatchState, actor: Actor): MatchState { return { ...state, round: { ...state.round, currentActor: actor } }; }
function settle(state: MatchState): MatchState {
  for (let i = 0; i < 2 && state.round.phase === "turns"; i++) state = gameReducer(state, { type: state.round.currentActor === "player" ? "PLAYER_STAND" : "OPPONENT_STAND" });
  return state;
}
function install(definitions: readonly unknown[], statuses: readonly unknown[] = []) {
  installAbilityRegistry([...registry.definitions, ...definitions], [...registry.statuses, ...statuses], registry.catalogVersion);
}

describe("AI decisions with an empty hand", () => {
  it.each([
    { P: 0, action: "hit" },
    { P: -16, action: "hit" },
    { P: -17, action: "stand" }
  ])("compares zero points against the normal threshold with P=$P", ({ P, action }) => {
    const base = turn(fixture(["2", "3"], []), "opponent");
    const state = { ...base, aiProfile: { P, A: 0, B: 0, C: 0 } };
    const after = gameReducer(state, { type: "AI_TURN" });
    expect(after.lastAiDecision).toMatchObject({ handValue: 0, threshold: 16 + P, action });
    expect(after.opponent.hand.cards).toHaveLength(action === "hit" ? 1 : 0);
    expect(after.opponent.stood).toBe(action === "stand");
    expect(decideOptimalAction(buildObservation(state, "opponent"))).toBe("hit");
  });

  it.each([false, true])("preserves stood=%s after every opponent card is transferred", stood => {
    const transfer = { id: "example-empty-hand-transfer", name: "示例移牌", description: "转移对手两张实体牌", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"],
      activation: { type: "action", windows: ["owner-turn"], consume: "none" },
      rules: [{ id: "transfer", trigger: "on-ability-played", effects: [
        { type: "transfer-hand-card", from: "rival", target: "owner", card: "last-card" },
        { type: "transfer-hand-card", from: "rival", target: "owner", card: "last-card" }
      ] }] };
    install([transfer]);
    const abilities = createMatch("empty-hand-transfer", { playerAiSkills: [{ definitionId: transfer.id, enabled: true, parameters: {} }], opponentAiSkills: [] }).abilities;
    let state = { ...fixture(["2", "3"], ["2", "3"]), abilities };
    if (stood) state = gameReducer(turn(state, "opponent"), { type: "OPPONENT_STAND" });
    const instanceId = abilities.instances.find(instance => instance.definitionId === transfer.id)!.instanceId;
    state = gameReducer(state, { type: "PLAY_ABILITY", instanceId });
    expect(state.opponent.hand.cards).toHaveLength(0);
    expect(state.player.hand.cards).toHaveLength(4);
    expect(state.opponent.stood).toBe(stood);
    state = gameReducer(state, { type: "PLAYER_HIT" });
    if (stood) {
      expect(state.round.currentActor).toBe("player");
      expect(getLegalActions(state)).not.toContainEqual({ type: "AI_TURN" });
      for (const type of ["AI_TURN", "AI_HIT", "OPPONENT_HIT"] as const) expect(gameReducer(state, { type })).toBe(state);
      expect(state.opponent.stood).toBe(true);
      expect(state.opponent.hand.cards).toHaveLength(0);
    } else {
      expect(state.round.currentActor).toBe("opponent");
      const after = gameReducer(state, { type: "AI_TURN" });
      expect(after.lastAiDecision).toMatchObject({ handValue: 0, action: "hit" });
      expect(after.opponent.hand.cards).toHaveLength(1);
      expect(after.opponent.stood).toBe(false);
      expect(after.round.currentActor).toBe("player");
    }
  });

  it("still stands when the hand and draw pile are both empty", () => {
    const state = turn(fixture(["2", "3"], [], []), "opponent");
    const after = gameReducer(state, { type: "AI_TURN" });
    expect(after.lastAiDecision).toMatchObject({ handValue: 0, action: "stand" });
    expect(after.opponent.stood).toBe(true);
    expect(after.opponent.hand.cards).toHaveLength(0);
  });
});

describe("settlement priority: natural Blackjack, bust, then point comparison", () => {
  for (const actor of ["player", "opponent"] as const) {
    const rival = actor === "player" ? "opponent" : "player";
    it.each<Rank[]>([["10", "9"], ["7", "7", "7"], ["10", "10", "2"]])(
      `settles ${actor}'s natural Blackjack before the rival hand %j`, (...ranks) => {
        const before = actor === "player" ? fixture(["A", "K"], ranks) : fixture(ranks, ["A", "K"]);
        const firstStand = gameReducer(before, { type: "PLAYER_STAND" });
        expect(firstStand.round.outcome).toBeNull();
        const result = gameReducer(firstStand, { type: "OPPONENT_STAND" });
        expect(result.round.outcome).toEqual({ winner: actor, reason: "blackjack", penaltyTarget: rival, bulletsAdded: 2 });
        expect(result.roulette[rival].bullets).toBe(before.roulette[rival].bullets + 2);
        expect(result.playerSkills.drawCount - before.playerSkills.drawCount).toBe(actor === "player" ? 2 : 1);
        expect(result.history.filter(e => e.type === "BLACKJACK")).toEqual([{ type: "BLACKJACK", actor }]);
        expect(result.history.filter(e => e.type === "ROUND_RESOLVED")).toHaveLength(1);
        expect(validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(result)))).activeMatch!).toEqual(result);
      }
    );

    it(`does not apply comparison advantages against ${actor}'s natural Blackjack`, () => {
      install([{ id: "example-blackjack-advantage", name: "示例优势", description: "中性比较加成", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
        rules: [{ id: "points", trigger: "before-round-resolution", conditions: [{ type: "round-reason-is", value: "comparison" }], effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 30 }] }] }]);
      const binding = { definitionId: "example-blackjack-advantage", enabled: true, parameters: {} };
      const runtime = createMatch("blackjack-advantage", { playerAiSkills: rival === "player" ? [binding] : [], opponentAiSkills: rival === "opponent" ? [binding] : [] }).abilities;
      const before = actor === "player" ? fixture(["A", "K"]) : fixture(undefined, ["A", "K"]);
      const result = settle({ ...before, abilities: runtime });
      expect(result.round.outcome).toEqual({ winner: actor, reason: "blackjack", penaltyTarget: rival, bulletsAdded: 2 });
      expect(result.history).not.toContainEqual(expect.objectContaining({ type: "ABILITY_TRIGGERED", definitionId: binding.definitionId }));
    });
  }

  it("pushes two natural Blackjacks without applying an asymmetric score modifier", () => {
    install([{ id: "example-natural-push", name: "示例优势", description: "中性比较加成", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
      rules: [{ id: "points", trigger: "before-round-resolution", conditions: [{ type: "round-reason-is", value: "comparison" }], effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 3 }] }] }]);
    const runtime = createMatch("natural-push", { playerAiSkills: [{ definitionId: "example-natural-push", enabled: true, parameters: {} }] }).abilities;
    const before = { ...fixture(["A", "K"], ["A", "Q"]), abilities: runtime };
    const result = settle(before);
    expect(result.round.outcome).toEqual({ winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 });
    expect(result.roulette).toEqual(before.roulette);
    expect(result.playerSkills.drawCount - before.playerSkills.drawCount).toBe(1);
    expect(result.history.filter(e => e.type === "BLACKJACK")).toEqual([{ type: "BLACKJACK", actor: "player" }, { type: "BLACKJACK", actor: "opponent" }]);
    expect(result.history).not.toContainEqual(expect.objectContaining({ type: "ABILITY_TRIGGERED", definitionId: "example-natural-push" }));
  });

  it("recognizes the final two-card natural Blackjack after a derived hand change", () => {
    const before = fixture(["10", "9", "2"], ["7", "7", "7"]);
    const player = { ...before.player, hand: { cards: [before.player.hand.cards[0]!, createDerivedCard("hearts", "A", "natural-derived-ace")] } };
    const state = normalizeAbilityHands({ ...before, player, round: { ...before.round, player } });
    expect(settle(state).round.outcome).toEqual({ winner: "player", reason: "blackjack", penaltyTarget: "opponent", bulletsAdded: 2 });
  });
});

describe("busts remain playable until both participants Stand", () => {
  it.each<{ ranks: Rank[]; allowed: boolean }>([
    { ranks: ["10", "10", "10", "10", "10", "10", "A", "A"], allowed: true },
    { ranks: ["10", "10", "10", "10", "10", "10", "3"], allowed: true },
    { ranks: ["10", "10", "10", "10", "10", "10", "4"], allowed: false }
  ])("limits player Hit only above three times the active bust limit: $ranks", ({ ranks, allowed }) => {
    const state = normalizeAbilityHands(fixture(ranks));
    const snapshot = structuredClone(state);
    expect(getLegalActions(state).some(action => action.type === "PLAYER_HIT")).toBe(allowed);
    expect(getLegalActions(state)).toContainEqual({ type: "PLAYER_STAND" });
    const after = gameReducer(state, { type: "PLAYER_HIT" });
    if (allowed) expect(after.player.hand.cards).toHaveLength(ranks.length + 1);
    else expect(after).toBe(state);
    expect(state).toEqual(snapshot);
  });

  it("rechecks a changed bust limit and keeps skills usable while Hit is blocked", () => {
    install([{ id: "example-hit-limit", name: "示例上限", description: "提高当前上限", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"],
      activation: { type: "action", windows: ["owner-turn"], consume: "none" },
      rules: [{ id: "raise", trigger: "on-ability-played", effects: [{ type: "add-status", target: "owner", statusDefinitionId: "example-hit-limit-raised" }] }] }],
    [{ id: "example-hit-limit-raised", defaultDuration: "round", rules: [{ id: "limit", trigger: "before-bust-check", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 10 }] }] }]);
    const runtime = createMatch("hit-limit-runtime", { playerAiSkills: [{ definitionId: "example-hit-limit", enabled: true, parameters: {} }] }).abilities;
    const state = normalizeAbilityHands({ ...fixture(["10", "10", "10", "10", "10", "10", "4"]), abilities: runtime });
    const instanceId = runtime.instances.find(i => i.definitionId === "example-hit-limit")!.instanceId;
    expect(getLegalActions(state)).not.toContainEqual({ type: "PLAYER_HIT" });
    expect(getLegalActions(state)).toContainEqual({ type: "PLAY_ABILITY", instanceId });
    const raised = gameReducer(state, { type: "PLAY_ABILITY", instanceId });
    expect(getLegalActions(raised)).toContainEqual({ type: "PLAYER_HIT" });
    expect(gameReducer(raised, { type: "PLAYER_HIT" }).player.hand.cards).toHaveLength(8);
    const lowered = { ...raised, abilities: { ...raised.abilities, statuses: [] } };
    expect(getLegalActions(lowered)).not.toContainEqual({ type: "PLAYER_HIT" });
    expect(gameReducer(lowered, { type: "PLAYER_HIT" })).toBe(lowered);
  });

  it("re-enables Hit after the hand shrinks and ignores comparison advantages", () => {
    const blocked = normalizeAbilityHands(fixture(["10", "10", "10", "10", "10", "10", "4"]));
    const player = { ...blocked.player, hand: { cards: blocked.player.hand.cards.slice(0, 6) }, bustLimit: undefined };
    const recovered = normalizeAbilityHands({ ...blocked, player, round: { ...blocked.round, player }, comparisonBonuses: { player: 100, opponent: 0 } });
    expect(getLegalActions(recovered)).toContainEqual({ type: "PLAYER_HIT" });
    expect(gameReducer(recovered, { type: "PLAYER_HIT" }).player.hand.cards).toHaveLength(7);
  });

  it.each<{ last: Rank; allowed: boolean }>([
    { last: "2", allowed: true }, { last: "3", allowed: true }, { last: "4", allowed: false }
  ])("limits all opponent Hit entry points at 60 + $last points", ({ last, allowed }) => {
    const base = turn(normalizeAbilityHands(fixture(undefined, ["10", "10", "10", "10", "10", "10", last])), "opponent");
    const state = { ...base, aiProfile: { P: 100, A: 0, B: 0, C: 0 } };
    for (const type of ["OPPONENT_HIT", "AI_HIT"] as const) {
      const after = gameReducer(state, { type });
      if (allowed) expect(after.opponent.hand.cards).toHaveLength(8);
      else expect(after).toBe(state);
    }
    expect(getLegalActions(state)).toContainEqual({ type: "AI_TURN" });
    const after = gameReducer(state, { type: "AI_TURN" });
    expect(after.lastAiDecision?.action).toBe(allowed ? "hit" : "stand");
    expect(after.opponent.stood).toBe(!allowed);
    expect(after.shoe.cursor).toBe(state.shoe.cursor + (allowed ? 1 : 0));
  });

  it.each<{ last: Rank; allowed: boolean }>([
    { last: "3", allowed: true }, { last: "4", allowed: false }
  ])("applies the live opponent bust limit before a skill-forced Hit at 90 + $last", ({ last, allowed }) => {
    const id = "example-forced-hit-limit";
    install([{ id, name: "示例要牌", description: "提高上限并要求要牌", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" },
      rules: [
        { id: "limit", trigger: "before-bust-check", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 10 }] },
        { id: "hit", trigger: "before-ai-decision", effects: [{ type: "set-pending-ai-action", target: "owner", action: "hit" }] }
      ] }]);
    const abilities = createMatch("opponent-live-hit-limit", { opponentAiSkills: [{ definitionId: id, enabled: true, parameters: {} }] }).abilities;
    const state = turn({ ...fixture(undefined, [...Array<Rank>(9).fill("10"), last]), abilities, comparisonBonuses: { player: 0, opponent: 100 } }, "opponent");
    for (const type of ["OPPONENT_HIT", "AI_HIT"] as const) {
      const after = gameReducer(state, { type });
      if (allowed) expect(after.opponent.hand.cards).toHaveLength(11);
      else expect(after).toBe(state);
    }
    const after = gameReducer(state, { type: "AI_TURN" });
    expect(after.lastAiDecision?.action).toBe(allowed ? "hit" : "stand");
    expect(after.shoe.cursor).toBe(state.shoe.cursor + (allowed ? 1 : 0));
    expect(after.opponent.stood).toBe(!allowed);
  });

  it("keeps both bust hands active and supports repeated Hits without extra bust events", () => {
    let state = fixture();
    for (const type of ["PLAYER_HIT", "OPPONENT_HIT", "PLAYER_HIT", "OPPONENT_HIT"] as const) state = gameReducer(state, { type });
    expect(state.round).toMatchObject({ phase: "turns", outcome: null, currentActor: "player" });
    expect(state.player).toMatchObject({ busted: true, stood: false });
    expect(state.opponent).toMatchObject({ busted: true, stood: false });
    expect(state.history.filter(e => e.type === "BUST")).toHaveLength(2);
    expect(normalizeAbilityHands(state).history).toEqual(state.history);
    const afterOneStand = gameReducer(state, { type: "PLAYER_STAND" });
    expect(afterOneStand.round.phase).toBe("turns");
    const result = gameReducer(afterOneStand, { type: "OPPONENT_STAND" });
    expect(result.round.outcome).toEqual({ winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 });
    expect(result.roulette).toEqual(state.roulette);
    expect(result.history.filter(e => e.type === "ROUND_RESOLVED")).toHaveLength(1);
    expect(gameReducer(result, { type: "OPPONENT_STAND" })).toBe(result);
  });

  it.each(["player", "opponent"] as const)("settles a single %s bust only after both Stand", actor => {
    const before = turn(fixture(), actor);
    const busted = gameReducer(before, { type: actor === "player" ? "PLAYER_HIT" : "OPPONENT_HIT" });
    expect(busted.round.outcome).toBeNull();
    const result = settle(busted);
    expect(result.round.outcome).toMatchObject({ reason: "bust", penaltyTarget: actor, bulletsAdded: 1 });
    expect(result.roulette[actor].bullets).toBe(before.roulette[actor].bullets + 1);
  });

  it("lets the remaining actor keep hitting after the other stands", () => {
    let state = gameReducer(fixture(), { type: "PLAYER_STAND" });
    state = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(state.round.currentActor).toBe("opponent");
    expect(state.opponent).toMatchObject({ busted: true, stood: false });
    state = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(state.round.phase).toBe("turns");
    expect(gameReducer(state, { type: "OPPONENT_STAND" }).round.outcome?.reason).toBe("bust");
  });

  it("offers legal actions to a busted player and roundtrips an unfinished bust save", () => {
    const state = turn(gameReducer(fixture(), { type: "PLAYER_HIT" }), "player");
    expect(getLegalActions(state)).toEqual(expect.arrayContaining([{ type: "PLAYER_HIT" }, { type: "PLAYER_STAND" }]));
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(restored).toEqual(state);
    expect(gameReducer(restored, { type: "PLAYER_HIT" }).player.hand.cards).toHaveLength(4);
  });

  it("clears a bust after a hand change and records a fresh later bust", () => {
    const before = gameReducer(fixture(), { type: "PLAYER_HIT" });
    const player = { ...before.player, hand: { cards: before.player.hand.cards.slice(0, 2) }, bustLimit: undefined };
    const recovered = normalizeAbilityHands({ ...before, player, round: { ...before.round, player } });
    expect(recovered.player).toMatchObject({ busted: false, stood: false });
    const rebusted = gameReducer(turn(recovered, "player"), { type: "PLAYER_HIT" });
    expect(rebusted.history.filter(e => e.type === "BUST" && e.actor === "player")).toHaveLength(2);
  });

  it("allows a status-only skill to raise the limit and recover a busted hand", () => {
    install([{ id: "example-limit", name: "示例上限", description: "中性上限能力", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"],
      activation: { type: "action", windows: ["owner-turn"], consume: "none" },
      rules: [{ id: "raise", trigger: "on-ability-played", effects: [{ type: "add-status", target: "owner", statusDefinitionId: "example-raised" }] }] }],
    [{ id: "example-raised", defaultDuration: "round", rules: [{ id: "limit", trigger: "before-bust-check", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 10 }] }] }]);
    const runtime = createMatch("limit-runtime", { playerAiSkills: [{ definitionId: "example-limit", enabled: true, parameters: {} }] }).abilities;
    let state = fixture(["10", "9", "5"]);
    state = normalizeAbilityHands({ ...state, abilities: runtime });
    expect(state.player.busted).toBe(true);
    const instanceId = runtime.instances.find(i => i.definitionId === "example-limit")!.instanceId;
    expect(getLegalActions(state)).toContainEqual({ type: "PLAY_ABILITY", instanceId });
    const after = gameReducer(state, { type: "PLAY_ABILITY", instanceId });
    expect(after.player).toMatchObject({ busted: false, stood: false, bustLimit: 31 });
    expect(settle(after).round.outcome?.reason).toBe("comparison");
    expect(abilityWorld(after).hands.player).toEqual(state.player.hand);
  });

  it("applies a stored comparison bonus across rounds without changing bust limits or natural priority", () => {
    let state: MatchState = { ...fixture(["10", "10"], ["10", "9"]), comparisonBonuses: { player: 1, opponent: 0 } };
    const original = JSON.stringify(state);
    expect(previewComparisonScores(state)).toMatchObject({ baseScores: { player: 20, opponent: 19 }, scores: { player: 21, opponent: 19 } });
    expect(JSON.stringify(state)).toBe(original);
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(settle(saved).round.outcome).toMatchObject({ winner: "player", comparisonScores: { player: 21, opponent: 19 } });
    const next = gameReducer({ ...settle(saved), round: { ...settle(saved).round, outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
    expect(next.comparisonBonuses).toEqual({ player: 1, opponent: 0 });
    state = { ...fixture(["10", "10"], ["A", "K"]), comparisonBonuses: { player: 9, opponent: 0 } };
    expect(settle(state).round.outcome).toMatchObject({ winner: "opponent", reason: "blackjack" });
    state = normalizeAbilityHands({ ...fixture(["10", "10", "2"], ["10", "9"]), comparisonBonuses: { player: 9, opponent: 0 } });
    expect(state.player.busted).toBe(true); expect(settle(state).round.outcome).toMatchObject({ reason: "bust", penaltyTarget: "player" });
    expect(() => createMatch("invalid", { comparisonBonuses: { player: NaN, opponent: 0 } })).toThrow();
  });

  it("keeps point advantages outside the bust check", () => {
    install([{ id: "example-advantage", name: "示例优势", description: "中性比较加成", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
      rules: [{ id: "points", trigger: "before-round-resolution", conditions: [{ type: "round-reason-is", value: "comparison" }], effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 3 }] }] }]);
    const runtime = createMatch("advantage-runtime", { playerAiSkills: [{ definitionId: "example-advantage", enabled: true, parameters: {} }] }).abilities;
    const base = fixture(["10", "10"]);
    const state = normalizeAbilityHands({ ...base, abilities: runtime });
    expect(previewComparisonScores(state).scores.player).toBe(23);
    expect(state.player.busted).toBe(false);
    expect(settle(state).round.outcome).toMatchObject({ winner: "player", comparisonScores: { player: 23, opponent: 19 } });
    const bust = gameReducer(state, { type: "PLAYER_HIT" });
    expect(settle(bust).round.outcome).toMatchObject({ reason: "bust", penaltyTarget: "player" });
  });

  it("does not skip a busted actor as an unavailable alternate", () => {
    install([{ id: "example-skip", name: "示例跳过", description: "中性轮转能力", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
      rules: [{ id: "skip", trigger: "before-turn", conditions: [{ type: "actor-is", actor: "rival" }], effects: [{ type: "skip-turn", target: "rival" }] }] }]);
    const runtime = createMatch("skip-runtime", { playerAiSkills: [{ definitionId: "example-skip", enabled: true, parameters: {} }] }).abilities;
    const state = gameReducer({ ...fixture(), abilities: runtime }, { type: "PLAYER_HIT" });
    expect(state.round.currentActor).toBe("player");
    expect(state.player.busted).toBe(true);
    expect(state.history.at(-1)).toMatchObject({ type: "TURN_SKIPPED", actor: "opponent" });
  });

  it("rejects empty-shoe Hits through every alias and lets AI Stand", () => {
    const state = fixture(undefined, undefined, []);
    expect(getLegalActions(state)).not.toContainEqual({ type: "PLAYER_HIT" });
    expect(gameReducer(state, { type: "PLAYER_HIT" })).toBe(state);
    const ai = turn(state, "opponent");
    for (const type of ["AI_HIT", "OPPONENT_HIT"] as const) expect(gameReducer(ai, { type })).toBe(ai);
    const after = gameReducer(ai, { type: "AI_TURN" });
    expect(after.lastAiDecision?.action).toBe("stand");
    expect(after.round.phase).toBe("turns");
    expect(gameReducer(after, { type: "PLAYER_STAND" }).round.phase).toBe("round-reveal");
  });

  it("preserves action dialogue until settlement and restores the same event", () => {
    const before = fixture();
    const after = gameReducer(before, { type: "PLAYER_HIT" });
    expect(extractDialogueEvent(before, after)).toMatchObject({ type: "core.action", data: { actor: "player", action: "hit" } });
    expect(restoreDialogueEvent(after)).toEqual(extractDialogueEvent(before, after));
    const bustedFact = CORE_DIALOGUE_PRIMITIVES.find(p => p.id === "core.busted")!;
    expect(bustedFact.read({ state: after, characterId: "example" }, { actor: "player" })).toBe(true);
    const program = readCharacterFixture("chatgpt").dialogue;
    expect(resolveDialogueState(after, program).poolId).toBe("PLAYER_HIT");
    const settled = settle(after);
    expect(resolveDialogueState(settled, program).poolId).toBe("PLAYER_BUST");
    const both = gameReducer(after, { type: "OPPONENT_HIT" });
    expect(resolveDialogueState(settle(both), program).poolId).toBe("PUSH_ROUND");
  });
});
