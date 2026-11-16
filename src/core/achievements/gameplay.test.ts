import { describe, expect, it } from "vitest";
import builtinCatalog from "../../../public/characters/official-built-in-achievements/resources/achievements.json";
import { AchievementCatalogSchema } from "./schema";
import { advanceAchievements, createAchievementLedger } from "./engine";
import { validateAchievementInputs } from "./validation";
import { createGameplayAchievementState, GAMEPLAY_ACHIEVEMENT_CONTRACT, GAMEPLAY_ACHIEVEMENT_TOPIC, GameplayAchievementStateSchema, observeGameplayAchievements } from "./gameplay";
import { createMatchFactBatch } from "../events/batch";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { AiSkillAbilityDefinition } from "../abilities/types";
import { createMatch, gameReducer } from "../match/reducer";
import { createCard, createDerivedCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import type { Action, MatchState } from "../match/types";
import type { AchievementLedger, AchievementScalarValue } from "./types";

const catalog = AchievementCatalogSchema.parse(builtinCatalog);
const entries = catalog.achievements.map(definition => ({ key: `hoc-core/official-built-in-achievements#achievements/${definition.id}`, definition }));
const keyFor = (id: string) => `hoc-core/official-built-in-achievements#achievements/${id}`;
function observationsUnlock(id: string, values: Record<string, AchievementScalarValue>, debugUsed = false, bound: string[] = []) {
  let ledger = createAchievementLedger("neutral-profile");
  const feed = (values: Record<string, AchievementScalarValue>, boundary?: { scope: "match"; phase: "begin" }) => {
    ledger = advanceAchievements(entries, ledger, { apiVersion: 1, topic: GAMEPLAY_ACHIEVEMENT_TOPIC, streamId: ledger.streamId, sequence: ledger.nextSequence,
      at: "2026-11-11T00:00:00.000Z", scopes: { match: "neutral-match", round: "neutral-match:round:0" }, ...(boundary ? { boundary } : {}), debugUsed, values, skillCards: {} }, [GAMEPLAY_ACHIEVEMENT_CONTRACT]).ledger;
  };
  feed({ event: "match-begin" }, { scope: "match", phase: "begin" });
  for (const definitionId of bound) feed({ event: "ability-bound", actor: "opponent", definitionId, level: 2 });
  feed(values);
  return !!ledger.records[keyFor(id)]?.completed;
}
const strong = ["claude-ss-moment", "claude-ss-constitution", "claude-ss-reasoning"];
const conditions: [string, Record<string, AchievementScalarValue>, Record<string, AchievementScalarValue>][] = [
  ["first-victory", { event: "match-settled", winner: "player" }, { winner: "opponent" }],
  ["fair-play", { event: "round-settled", winner: "player", roundActiveCount: 0, wholeRoundObserved: true }, { roundActiveCount: 1 }],
  ["safe-hit", { event: "forecast-hit", sourceDefinition: "critical-judgment", safe: true }, { safe: false }],
  ["same-round-ammunition", { event: "extra-load", sourceDefinition: "live-ammunition-bet", sourceDrawnThisRound: true, sourceActivatedThisRound: true, actualExtraLoad: 1 }, { actualExtraLoad: 0 }],
  ["borrowed-apple", { event: "hand-transfer", sourceDefinition: "sleight-of-hand", sourceOwner: "player", actor: "player", from: "opponent", cardSource: "shoe", safe: true }, { cardSource: "derived" }],
  ["physical-twenty-one", { event: "round-settled", winner: "player", playerPhysicalCount: 3, playerDerivedCount: 0, playerBaseTotal: 21 }, { playerDerivedCount: 1 }],
  ["crafted-blackjack", { event: "round-settled", winner: "player", reason: "blackjack", playerBlackjack: true, playerDerivedCount: 1 }, { playerDerivedCount: 0 }],
  ["double-bust", { event: "round-settled", winner: "draw", playerBusted: true, opponentBusted: true }, { opponentBusted: false }],
  ["one-point-comeback", { event: "round-settled", winner: "player", reason: "comparison", playerBusted: false, opponentBusted: false, playerBlackjack: false, opponentBlackjack: false, playerBaseTotal: 17, opponentBaseTotal: 18, playerFinalScore: 19, opponentFinalScore: 18, playerPointAdvantage: 2, opponentPointAdvantage: 0, playerSkillComparisonAdvantage: 2 }, { playerSkillComparisonAdvantage: 0 }],
  ["clock-recovery", { event: "hand-replaced", sourceDefinition: "counterclockwise-clock", actor: "player", recoveredFromBust: true, lastHitReplaced: true }, { lastHitReplaced: false }],
  ["five-card-victory", { event: "round-settled", winner: "player", reason: "comparison", playerCardCount: 5 }, { reason: "bust" }],
  ["double-blackjack", { event: "round-settled", winner: "draw", playerBlackjack: true, opponentBlackjack: true }, { opponentBlackjack: false }],
  ["stand-then-edit", { event: "round-settled", winner: "player", changedAfterStand: true }, { changedAfterStand: false }],
  ["gifted-bust", { event: "returned-card-bust", sourceDefinition: "switcheroo", sourceOwner: "player", cardValue: 8 }, { cardValue: 7 }],
  ["triple-assessment", { event: "ability-played", definitionId: "situation-assessment", cardRoundUses: 3 }, { cardRoundUses: 2 }],
  ["eight-skill-deck", { event: "match-settled", winner: "player", deckSize: 8, matchDistinctSkills: 4, wholeMatchObserved: true }, { deckSize: 9 }],
  ["exhaust-copy-replay", { event: "ability-played", sameDefinitionAfterExhaustion: true, previousDefinition: "mimic-eggplant" }, { sameDefinitionAfterExhaustion: false }],
  ["four-domains", { event: "ability-played", roundDomainCount: 4 }, { roundDomainCount: 3 }],
  ["overflow-return", { event: "status-increased", sourceDefinition: "sissas-table", statusDefinition: "player-point-advantage", statusStackDelta: 6 }, { statusStackDelta: 0 }],
  ["hands-off-match", { event: "match-settled", winner: "player", rounds: 3, matchActiveCount: 0, wholeMatchObserved: true }, { rounds: 2 }],
  ["full-cylinder-misfire", { event: "trigger-result", actor: "player", reason: "misfire", beforeEmptySlots: 0, misfireChance: 0.5 }, { reason: "fired" }],
  ["last-slot-premium", { event: "ability-played", definitionId: "prepaid-premium", beforeEmptySlots: 1 }, { beforeEmptySlots: 2 }],
  ["narrow-escape", { event: "match-settled", winner: "player", playerEmptySlots: 1, opponentEmptySlots: 0 }, { opponentEmptySlots: 2 }],
  ["direct-boss", { event: "match-settled", winner: "player", flowId: "intelligent-core-trial", nodeId: "boss", completedNodeCount: 0 }, { completedNodeCount: 1 }],
  ["selective-guard", { event: "match-settled", winner: "player", flowId: "intelligent-core-trial", nodeId: "boss", completedNodeCount: 1, completedNodeId: "guard:deepseek" }, { completedNodeId: "guard:llama" }]
];

describe("built-in gameplay achievement catalog", () => {
  it("contains precisely the 25 Core goals, stable covers and declared semantic inputs", () => {
    expect(catalog.achievements).toHaveLength(25);
    expect(catalog.achievements.map(item => item.id).sort()).toEqual(conditions.map(([id]) => id).sort());
    for (const definition of catalog.achievements) {
      expect(definition.cover).toBe(definition.id === "first-victory" ? "cover.png" : `covers/${definition.id}.png`);
      expect(validateAchievementInputs(definition, [GAMEPLAY_ACHIEVEMENT_CONTRACT])).toEqual([]);
    }
    expect(catalog.achievements.filter(item => item.hidden).map(item => item.id)).toEqual(["double-bust", "double-blackjack", "full-cylinder-misfire"]);
  });
  it.each(conditions)("%s requires its complete gameplay condition and excludes debug", (id, positive, negative) => {
    expect(observationsUnlock(id, positive, false, id === "selective-guard" ? strong : [])).toBe(true);
    expect(observationsUnlock(id, { ...positive, ...negative }, false, id === "selective-guard" ? strong : [])).toBe(false);
    expect(observationsUnlock(id, positive, true, id === "selective-guard" ? strong : [])).toBe(false);
  });
  it("requires all three remaining strengthened skills on the selective guard route", () => {
    const values = conditions.find(([id]) => id === "selective-guard")![1];
    expect(observationsUnlock("selective-guard", values, false, strong.slice(0, 2))).toBe(false);
  });
});

let serial = 0;
function fixture(skills: string[] = [], playerRanks: Rank[] = ["10", "7"], opponentRanks: Rank[] = ["10", "8"], remainingRanks: Rank[] = ["2", "3", "4", "5"], aiSkills: { player?: string[]; opponent?: string[] } = {}): MatchState {
  const base = createMatch(`achievement-neutral-${++serial}`, { opponentId: "neutral-opponent", grantOpeningSkills: false, openingSkillCards: 0, playerAiSkills: aiSkills.player?.map(definitionId => ({ definitionId, enabled: true, parameters: {} })), opponentAiSkills: aiSkills.opponent?.map(definitionId => ({ definitionId, enabled: true, parameters: {} })), initialPlayerSkills: skills.map(definitionId => ({ definitionId, enabled: true, parameters: {} })) });
  let nextId = 0;
  const cards = (ranks: Rank[]) => ranks.map(rank => createCard("spades", rank, `neutral-card-${serial}-${++nextId}`));
  const player = { ...base.player, hand: { cards: cards(playerRanks) }, stood: false, busted: false, bustLimit: 21 };
  const opponent = { ...base.opponent, hand: { cards: cards(opponentRanks) }, stood: false, busted: false, bustLimit: 21 };
  const used = [...player.hand.cards, ...opponent.hand.cards];
  return { ...base, player, opponent, shoe: { cards: [...used, ...cards(remainingRanks)], cursor: used.length, shuffleIndex: 1 },
    round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}
function harness(initial: MatchState, restored = false) {
  let match = initial, provider = restored ? createGameplayAchievementState(initial) : createGameplayAchievementState(), ledger: AchievementLedger = createAchievementLedger("neutral-gameplay");
  const seen: ReturnType<typeof observeGameplayAchievements>["observations"][number][] = [];
  function accept(before: MatchState | undefined, after: MatchState) {
    const result = observeGameplayAchievements(provider, createMatchFactBatch(before, after)); provider = result.state; match = after;
    for (const observation of result.observations) {
      seen.push(observation); ledger = advanceAchievements(entries, ledger, { ...observation, debugUsed: false, streamId: ledger.streamId, sequence: ledger.nextSequence, at: "2026-11-11T01:00:00.000Z" }, [GAMEPLAY_ACHIEVEMENT_CONTRACT]).ledger;
    }
  }
  if (!restored) accept(undefined, initial);
  return { get match() { return match; }, get state() { return provider; }, seen,
    act(action: Action) { accept(match, gameReducer(match, action)); },
    accept(after: MatchState) { accept(match, after); },
    play(id: string) { const card = match.playerSkills.cards.find(card => card.definitionId === id)!; expect(card).toBeDefined(); accept(match, gameReducer(match, { type: "PLAY_ABILITY", instanceId: card.instanceId })); },
    unlocked(id: string) { return !!ledger.records[keyFor(id)]?.completed; },
    settle() { for (let i = 0; i < 3 && match.round.phase === "turns"; i++) accept(match, gameReducer(match, { type: match.round.currentActor === "player" ? "PLAYER_STAND" : "OPPONENT_STAND" })); }
  };
}
function playerTurn(state: MatchState): MatchState { return { ...state, round: { ...state.round, currentActor: "player" } }; }

function withNeutralAi(definitions: readonly AiSkillAbilityDefinition[], run: () => void): void {
  const previous = ABILITY_REGISTRY;
  try { installAbilityRegistry([...previous.definitions, ...definitions], previous.statuses, previous.catalogVersion); run(); }
  finally { installAbilityRegistry(previous.definitions, previous.statuses, previous.catalogVersion); }
}
const neutralGiftRescue: AiSkillAbilityDefinition = {
  id: "neutral-gift-rescue", name: "Neutral rescue", description: "Neutral successful Hit rescue fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
  rules: [{ id: "move-hit", trigger: "before-bust-resolution", conditions: [{ type: "actor-is", actor: "owner" }], limit: { perRound: 1 },
    effects: [{ type: "transfer-hand-card", from: "owner", target: "rival", card: "last-hit-card" }] }]
};
const neutralExtraCard: AiSkillAbilityDefinition = {
  id: "neutral-extra-card", name: "Neutral acquisition", description: "Neutral complete Hit effect-chain fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
  rules: [{ id: "append-after-hit", trigger: "after-card-acquired", conditions: [{ type: "actor-is", actor: "owner" }, { type: "acquired-card-source-is", source: "shoe" }, { type: "hand-card-count", target: "owner", operator: "gte", value: 3 }], limit: { perRound: 1 },
    effects: [{ type: "acquire-card", target: "owner", choices: [{ source: "derived", rank: { type: "static", rank: "A" }, suit: { type: "static", suit: "hearts" } }] }] }]
};

describe("accepted gameplay achievement producer", () => {
  it("awards safe forecast only for an unchanged, immediate safe Hit", () => {
    const game = harness(fixture(["critical-judgment"], ["5", "5"], ["10", "8"], ["2", "3"]));
    game.play("critical-judgment"); game.act({ type: "PLAYER_HIT" });
    expect(game.unlocked("safe-hit")).toBe(true);
    const changed = harness(fixture(["critical-judgment", "switcheroo"], ["5", "5"], ["10", "8"], ["2", "3"]));
    changed.play("critical-judgment"); changed.play("switcheroo"); changed.act({ type: "PLAYER_HIT" });
    expect(changed.unlocked("safe-hit")).toBe(false);
  });
  it("counts three uses of one assessment card, preserving its stable instance", () => {
    const game = harness(fixture(["situation-assessment"]));
    const id = game.match.playerSkills.cards[0].instanceId;
    game.play("situation-assessment"); game.play("situation-assessment");
    expect(game.unlocked("triple-assessment")).toBe(false);
    game.play("situation-assessment");
    expect(game.unlocked("triple-assessment")).toBe(true);
    expect(game.seen.filter(item => item.values.event === "ability-played").map(item => [item.values.instanceId, item.values.cardRoundUses])).toEqual([[id, 1], [id, 2], [id, 3]]);
  });
  it("keeps the exhausted-card, immediate mimic and copied-use chain distinct", () => {
    const game = harness(fixture(["critical-judgment", "mimic-eggplant"], ["5", "5"]));
    game.play("critical-judgment"); game.play("critical-judgment"); game.play("critical-judgment"); game.play("mimic-eggplant");
    expect(game.unlocked("exhaust-copy-replay")).toBe(false);
    game.play("critical-judgment"); expect(game.unlocked("exhaust-copy-replay")).toBe(true);
    const interrupted = harness(fixture(["critical-judgment", "mimic-eggplant"], ["5", "5"]));
    interrupted.play("critical-judgment"); interrupted.play("critical-judgment"); interrupted.play("critical-judgment"); interrupted.act({ type: "PLAYER_HIT" }); interrupted.accept(playerTurn(interrupted.match));
    interrupted.play("mimic-eggplant"); interrupted.play("critical-judgment"); expect(interrupted.unlocked("exhaust-copy-replay")).toBe(false);
  });
  it("replaces the actual just-Hit bust card and does not confuse an opening card", () => {
    const game = harness(fixture(["counterclockwise-clock"], ["10", "9"], ["10", "8"], ["10", "2"]));
    game.act({ type: "PLAYER_HIT" }); game.accept(playerTurn(game.match)); game.play("counterclockwise-clock");
    expect(game.unlocked("clock-recovery")).toBe(true);
    const opening = fixture(["counterclockwise-clock"], ["10", "9", "10"]);
    const changed = harness({ ...opening, player: { ...opening.player, busted: true }, round: { ...opening.round, player: { ...opening.player, busted: true } } });
    changed.play("counterclockwise-clock"); expect(changed.unlocked("clock-recovery")).toBe(false);
  });
  it("follows the exact high physical card into the opponent Hit that causes bust", () => {
    const game = harness(fixture(["switcheroo"], ["2", "8"], ["10", "8"], ["3", "2"]));
    const outgoing = game.match.player.hand.cards.at(-1)!.id;
    game.play("switcheroo"); game.act({ type: "PLAYER_STAND" }); game.act({ type: "OPPONENT_HIT" });
    expect(game.match.opponent.hand.cards.at(-1)?.id).toBe(outgoing);
    expect(game.unlocked("gifted-bust")).toBe(true);
    const safe = harness(fixture(["switcheroo"], ["2", "8"], ["2", "2"], ["3", "K"]));
    safe.play("switcheroo"); safe.act({ type: "PLAYER_STAND" }); safe.act({ type: "OPPONENT_HIT" }); safe.act({ type: "OPPONENT_HIT" });
    expect(safe.unlocked("gifted-bust")).toBe(false);
    const ace = harness(fixture(["switcheroo"], ["10", "10", "A"], ["10", "9", "2"], ["2", "3"]));
    ace.play("switcheroo"); ace.act({ type: "PLAYER_STAND" }); ace.act({ type: "OPPONENT_HIT" });
    expect(ace.unlocked("gifted-bust")).toBe(false);
  });
  it("waits for the gifted Hit's actual BUST and excludes a successful transfer rescue", () => {
    withNeutralAi([neutralGiftRescue], () => {
      const game = harness(fixture(["switcheroo"], ["2", "8"], ["8", "9"], ["3", "2"], { opponent: [neutralGiftRescue.id] }));
      const giftId = game.match.player.hand.cards.at(-1)!.id;
      game.play("switcheroo"); game.act({ type: "PLAYER_STAND" });
      const beforeHit = game.match;
      game.act({ type: "OPPONENT_HIT" });
      const batch = createMatchFactBatch(beforeHit, game.match);
      const hit = batch.facts.find(fact => fact.type === "OPPONENT_HIT")!;
      expect(hit.snapshot!.world.hands.opponent.cards.at(-1)!.id).toBe(giftId);
      expect(hit.snapshot!.world.hands.opponent.cards.reduce((total, card) => total + Number(card.attributes.rank), 0)).toBe(25);
      expect(game.match.player.hand.cards.at(-1)?.id).toBe(giftId);
      expect(game.match.opponent.busted).toBe(false);
      expect(batch.facts.some(fact => fact.type === "BUST" && fact.event.actor === "opponent")).toBe(false);
      expect(game.unlocked("gifted-bust")).toBe(false);
    });
  });
  it("does not attribute a later unrelated BUST to a rescued gift across a retry batch", () => {
    const rescue: AiSkillAbilityDefinition = { ...neutralGiftRescue, id: "neutral-retained-gift-rescue", rules: [{ ...neutralGiftRescue.rules[0],
      effects: [{ type: "discard-hand-card", target: "owner", card: "first-public-card" }] }] };
    withNeutralAi([rescue], () => {
      const game = harness(fixture(["switcheroo"], ["2", "8"], ["10", "8"], ["3", "10", "2"], { opponent: [rescue.id] }));
      const giftId = game.match.player.hand.cards.at(-1)!.id;
      game.play("switcheroo"); game.act({ type: "PLAYER_STAND" });
      const saved = game.match;
      const rescued = gameReducer(saved, { type: "OPPONENT_HIT" });
      expect(rescued.opponent.busted).toBe(false);
      expect(rescued.opponent.hand.cards.some(card => card.id === giftId)).toBe(true);
      const unrelated = gameReducer(rescued, { type: "OPPONENT_HIT" });
      expect(unrelated.opponent.busted).toBe(true);
      expect(unrelated.opponent.hand.cards.at(-1)?.id).not.toBe(giftId);
      expect(unrelated.history.slice(saved.history.length).filter(event => event.type === "BUST" && event.actor === "opponent")).toHaveLength(1);
      // A failed save can deliver both accepted actions together on retry.
      game.accept(unrelated);
      expect(game.unlocked("gifted-bust")).toBe(false);
    });
  });
  it("does not credit a returned card drawn into an already busted hand", () => {
    const game = harness(fixture(["switcheroo"], ["2", "8"], ["10", "10", "2"], ["3", "2"]));
    game.play("switcheroo"); game.act({ type: "PLAYER_STAND" });
    expect(game.match.opponent.busted).toBe(true);
    game.act({ type: "OPPONENT_HIT" });
    expect(game.unlocked("gifted-bust")).toBe(false);
  });
  it("waits for all Hit effects before awarding a safe forecast", () => {
    withNeutralAi([neutralExtraCard], () => {
      const game = harness(fixture(["critical-judgment"], ["6", "7"], ["10", "8"], ["8", "2"], { player: [neutralExtraCard.id] }));
      game.play("critical-judgment"); const beforeHit = game.match;
      game.act({ type: "PLAYER_HIT" });
      const batch = createMatchFactBatch(beforeHit, game.match);
      expect(batch.facts.find(fact => fact.type === "PLAYER_HIT")!.snapshot!.world.hands.player.cards).toHaveLength(3);
      expect(game.match.player.hand.cards).toHaveLength(4);
      expect(game.match.player.busted).toBe(true);
      expect(batch.facts.some(fact => fact.type === "BUST" && fact.event.actor === "player")).toBe(true);
      expect(game.unlocked("safe-hit")).toBe(false);
    });
  });
  it("keeps a failed-save Hit's complete result when a later action recovers the hand", () => {
    const recovery: AiSkillAbilityDefinition = { id: "neutral-later-recovery", name: "Neutral later recovery", description: "A separate accepted action", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"],
      activation: { type: "action", windows: ["owner-turn"], consume: "none" }, rules: [{ id: "discard-later", trigger: "on-ability-played", effects: [{ type: "discard-hand-card", target: "owner", card: "last-card" }] }] };
    withNeutralAi([neutralExtraCard, recovery], () => {
      const game = harness(fixture(["critical-judgment"], ["6", "7"], ["10", "8"], ["8", "2"], { player: [neutralExtraCard.id, recovery.id] }));
      game.play("critical-judgment");
      const busted = gameReducer(game.match, { type: "PLAYER_HIT" });
      expect(busted.player.busted).toBe(true);
      const stood = gameReducer(busted, { type: "OPPONENT_STAND" });
      const instance = stood.abilities.instances.find(instance => instance.definitionId === recovery.id)!;
      const recovered = gameReducer(stood, { type: "PLAY_ABILITY", instanceId: instance.instanceId });
      expect(recovered.player.busted).toBe(false);
      game.accept(recovered);
      expect(game.unlocked("safe-hit")).toBe(false);
    });
  });
  it("records active Stand before skill hand mutation and rejects forced standing", () => {
    const game = harness({ ...fixture(["switcheroo"], ["10", "5"], ["10", "8"], ["10", "2"]), autoSkipAfterStand: false });
    game.act({ type: "PLAYER_STAND" }); game.act({ type: "OPPONENT_HIT" }); game.accept(playerTurn(game.match)); game.play("switcheroo"); game.settle();
    expect(game.unlocked("stand-then-edit")).toBe(true);
    const forced = fixture(["switcheroo"], ["10", "5"], ["10", "8"], ["10", "2"]);
    const noDecision = harness({ ...forced, player: { ...forced.player, stood: true }, round: { ...forced.round, player: { ...forced.player, stood: true } }, autoSkipAfterStand: false });
    noDecision.play("switcheroo"); noDecision.settle(); expect(noDecision.unlocked("stand-then-edit")).toBe(false);
  });
  it("distinguishes comparison, physical 21, derived natural and double bust settlement", () => {
    const physical = harness(fixture([], ["7", "7", "7"], ["10", "8"])); physical.settle(); expect(physical.unlocked("physical-twenty-one")).toBe(true);
    const base = fixture([], ["A", "K"], ["10", "8"]), generated = createDerivedCard("hearts", "K", "neutral-derived", "neutral-skill");
    const player = { ...base.player, hand: { cards: [base.player.hand.cards[0], generated] } };
    const derived = harness({ ...base, player, round: { ...base.round, player } }); derived.settle(); expect(derived.unlocked("crafted-blackjack")).toBe(true);
    const bust = fixture([], ["K", "K", "2"], ["K", "K", "3"]);
    const bustedPlayer = { ...bust.player, busted: true }, bustedOpponent = { ...bust.opponent, busted: true };
    const tie = harness({ ...bust, player: bustedPlayer, opponent: bustedOpponent, round: { ...bust.round, player: bustedPlayer, opponent: bustedOpponent } }); tie.settle(); expect(tie.unlocked("double-bust")).toBe(true);
  });
  it("captures overflow stacks, the last empty premium slot and all four skill domains", () => {
    const overflow = harness(fixture(["sissas-table"], ["2", "2", "2", "2", "2", "2"])); overflow.play("sissas-table"); expect(overflow.unlocked("overflow-return")).toBe(true);
    const initial = fixture(["prepaid-premium", "critical-judgment", "switcheroo", "sissas-table"], ["2", "2"]);
    const game = harness({ ...initial, roulette: { ...initial.roulette, player: { capacity: 6, bullets: 5 } } });
    game.play("prepaid-premium"); expect(game.unlocked("last-slot-premium")).toBe(true);
    game.play("critical-judgment"); game.play("switcheroo"); game.play("sissas-table"); expect(game.unlocked("four-domains")).toBe(true);
  });
  it("requires a paid same-round draw and real extra loading below cylinder capacity", () => {
    function prepare(opponentBullets: number) {
      const base = fixture([], ["10", "9"], ["10", "8"]);
      return { ...base, roulette: { ...base.roulette, opponent: { capacity: 6, bullets: opponentBullets } }, playerSkills: { ...base.playerSkills,
        drawCount: 1, drawOffer: { id: "neutral-paid-offer", candidateDefinitionIds: ["live-ammunition-bet"], refreshesRemaining: 0 } } };
    }
    const game = harness(prepare(0)); game.act({ type: "SELECT_SKILL_DRAW", definitionId: "live-ammunition-bet" }); game.play("live-ammunition-bet"); game.settle();
    expect(game.unlocked("same-round-ammunition")).toBe(true);
    const capped = harness(prepare(6)); capped.act({ type: "SELECT_SKILL_DRAW", definitionId: "live-ammunition-bet" }); capped.play("live-ammunition-bet"); capped.settle();
    expect(capped.unlocked("same-round-ammunition")).toBe(false);
    const opening = harness(fixture(["live-ammunition-bet"], ["10", "9"], ["10", "8"])); opening.play("live-ammunition-bet"); opening.settle();
    expect(opening.unlocked("same-round-ammunition")).toBe(false);
  });
  it("requires a full match baseline for three-round hands-off and an eight-skill loadout", () => {
    const game = harness(fixture([], ["10", "9"], ["10", "8"]));
    for (let index = 0; index < 3; index++) {
      if (index) {
        const prepared = fixture([], ["10", "9"], ["10", "8"]);
        const after = { ...game.match, player: prepared.player, opponent: prepared.opponent, roundIndex: index,
          round: { ...prepared.round, index }, history: [...game.match.history, { type: "ROUND_STARTED" as const, roundIndex: index }] };
        game.accept(after);
      }
      game.settle();
    }
    game.accept({ ...game.match, status: "finished", outcome: { winner: "player", reason: "opponent-killed" }, history: [...game.match.history, { type: "MATCH_FINISHED", reason: "opponent-killed" }] });
    expect(game.unlocked("hands-off-match")).toBe(true); expect(game.unlocked("first-victory")).toBe(true);
    const deck = ["prepaid-premium", "critical-judgment", "switcheroo", "sissas-table", "situation-assessment", "sleight-of-hand", "mimic-eggplant", "a-single-coin"];
    const prepared = fixture(deck.slice(0, 4), ["2", "2"]);
    const build = harness({ ...prepared, playerSkills: { ...prepared.playerSkills, deckDefinitionIds: deck } });
    for (const id of deck.slice(0, 4)) build.play(id);
    build.accept({ ...build.match, status: "finished", outcome: { winner: "player", reason: "opponent-killed" }, history: [...build.match.history, { type: "MATCH_FINISHED", reason: "opponent-killed" }] });
    expect(build.unlocked("eight-skill-deck")).toBe(true); expect(build.unlocked("hands-off-match")).toBe(false);
  });
  it("does not create a continuous no-skill attempt from an existing match", () => {
    const game = harness(fixture([], ["10", "9"], ["10", "8"]), true); game.settle();
    expect(game.unlocked("fair-play")).toBe(false);
    expect(game.state.known).toBe(false);
    expect(GameplayAchievementStateSchema.parse(JSON.parse(JSON.stringify(game.state)))).toEqual(game.state);
  });
  it("neither replays a batch nor reopens closed identities on result acknowledgement", () => {
    const initial = fixture();
    const provider = observeGameplayAchievements(createGameplayAchievementState(), createMatchFactBatch(undefined, initial));
    expect(observeGameplayAchievements(provider.state, createMatchFactBatch(undefined, initial)).observations).toEqual([]);
    const finished: MatchState = { ...initial, status: "finished", view: "match-summary", outcome: { winner: "player", reason: "opponent-killed" }, history: [...initial.history, { type: "MATCH_FINISHED", reason: "opponent-killed" }] };
    const closed = observeGameplayAchievements(provider.state, createMatchFactBatch(initial, finished));
    const acknowledged = gameReducer(finished, { type: "ACK_MATCH_RESULT" });
    const next = observeGameplayAchievements(closed.state, createMatchFactBatch(finished, acknowledged));
    expect(next.observations).toEqual([]); expect(next.state.cursor).toBe(acknowledged.history.length);
  });
});
