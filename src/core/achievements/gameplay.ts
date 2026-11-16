import { z } from "zod";
import { cardPointValue, isCardCountedInPointTotal } from "../blackjack/card";
import { handValueAtLimit, isBlackjack } from "../blackjack/hand";
import { getAbilityDefinition } from "../abilities/registry";
import type { AbilityWorld } from "../abilities/types";
import { matchHitResolution } from "../events/production";
import type { MatchFactBatch, MatchEffectFact, MatchFactSource } from "../events/types";
import type { Actor, MatchState } from "../match/types";
import type { AchievementObservation, AchievementObservationContract, AchievementScalarValue } from "./types";

export const GAMEPLAY_ACHIEVEMENT_TOPIC = { type: "core/gameplay", apiVersion: 1 } as const;
export type GameplayAchievementObservation = Omit<AchievementObservation, "streamId" | "sequence" | "at" | "debugUsed">;
export interface GameplayAchievementContext {
  readonly profileDefeats?: number;
  readonly flowId?: string;
  readonly nodeId?: string;
  readonly completedNodeIds?: readonly string[];
}
const sourceSchema = z.object({ definitionId: z.string(), instanceId: z.string(), owner: z.enum(["player", "opponent"]) }).strict();
const contributionSchema = z.object({ statusId: z.string(), actor: z.enum(["player", "opponent"]), source: sourceSchema, delta: z.number(), playerHits: z.number().int().nonnegative(), opponentHits: z.number().int().nonnegative() }).strict();
const modifierSchema = z.object({ source: sourceSchema, playerDelta: z.number().finite(), opponentDelta: z.number().finite(), playerHits: z.number().int().nonnegative(), opponentHits: z.number().int().nonnegative() }).strict();
const recordCounts = z.record(z.string(), z.number().int().nonnegative());
const source = (value: Pick<MatchFactSource, "definitionId" | "instanceId" | "owner">) => ({ definitionId: value.definitionId, instanceId: value.instanceId, owner: value.owner });
const roundSchema = z.object({
  index: z.number().int().nonnegative(), known: z.boolean(), open: z.boolean(), activeCount: z.number().int().nonnegative(),
  definitions: z.array(z.string()), domains: z.array(z.string()), instances: z.array(z.string()), uses: recordCounts,
  stood: z.boolean(), changedAfterStand: z.boolean(), playerHits: z.number().int().nonnegative(), opponentHits: z.number().int().nonnegative(),
  lastDealtPlayer: z.string().nullable(), lastDealtOpponent: z.string().nullable(), lastHitPlayer: z.string().nullable(),
  drawn: z.array(z.string()), activations: z.record(z.string(), z.object({ playerHits: z.number().int().nonnegative(), opponentHits: z.number().int().nonnegative() }).strict()),
  forecast: z.object({ source: sourceSchema, hand: z.string(), shoe: z.string() }).strict().nullable(),
  returned: z.array(z.object({ source: sourceSchema, cardId: z.string(), value: z.number() }).strict()),
  giftedHit: z.object({ source: sourceSchema, cardId: z.string(), value: z.number() }).strict().nullable(),
  exhausted: z.object({ definitionId: z.string(), instanceId: z.string() }).strict().nullable(),
  copied: z.record(z.string(), sourceSchema),
  contributions: z.array(contributionSchema), modifiers: z.array(modifierSchema), loads: z.array(z.object({ source: sourceSchema, actor: z.enum(["player", "opponent"]), delta: z.number(), slots: z.number() }).strict())
}).strict();
export const GameplayAchievementStateSchema = z.object({
  version: z.literal(1), matchId: z.string().nullable(), cursor: z.number().int().nonnegative(), open: z.boolean(), known: z.boolean(),
  deckSize: z.number().int().nonnegative(), activeCount: z.number().int().nonnegative(), definitions: z.array(z.string()), rounds: z.number().int().nonnegative(),
  profileDefeats: z.number().int().nonnegative(), flowId: z.string(), nodeId: z.string(), completedNodeIds: z.array(z.string()), round: roundSchema
}).strict();
export type GameplayAchievementState = z.infer<typeof GameplayAchievementStateSchema>;
function newRound(index: number, known: boolean): GameplayAchievementState["round"] {
  return { index, known, open: false, activeCount: 0, definitions: [], domains: [], instances: [], uses: {}, stood: false, changedAfterStand: false,
    playerHits: 0, opponentHits: 0, lastDealtPlayer: null, lastDealtOpponent: null, lastHitPlayer: null, drawn: [], activations: {}, forecast: null, returned: [], giftedHit: null, exhausted: null, copied: {}, contributions: [], modifiers: [], loads: [] };
}
/** An existing match establishes a cursor, never a replay or evidence of earlier actions. */
export function createGameplayAchievementState(match?: MatchState): GameplayAchievementState {
  return { version: 1, matchId: match?.id ?? null, cursor: match?.history.length ?? 0, open: false, known: false,
    deckSize: new Set(match?.playerSkills.deckDefinitionIds ?? []).size, activeCount: 0, definitions: [], rounds: 0,
    profileDefeats: 0, flowId: "", nodeId: "", completedNodeIds: [], round: newRound(match?.roundIndex ?? 0, false) };
}
const stringKeys = ["event", "opponentId", "actor", "from", "sourceDefinition", "sourceOwner", "sourceInstance", "definitionId", "instanceId", "cardId", "cardSource", "winner", "reason", "flowId", "nodeId", "completedNodeId", "copiedDefinition", "previousDefinition", "statusDefinition"];
const numberKeys = ["removedCount", "handTotalAfter", "bustLimit", "cardValue", "cardRoundUses", "roundActiveCount", "roundDomainCount", "matchActiveCount", "matchDistinctSkills", "deckSize", "rounds", "playerCardCount", "playerPhysicalCount", "playerDerivedCount", "playerBaseTotal", "opponentBaseTotal", "playerFinalScore", "opponentFinalScore", "playerPointAdvantage", "opponentPointAdvantage", "playerEmptySlots", "opponentEmptySlots", "playerRoundHits", "opponentRoundHits", "profileDefeats", "completedNodeCount", "actualExtraLoad", "beforeEmptySlots", "extraComparisonPoints", "level", "statusStackDelta", "playerSkillComparisonAdvantage", "misfireChance"];
const booleanKeys = ["sourceDrawnThisRound", "sourceActivatedThisRound", "safe", "recoveredFromBust", "lastHitReplaced", "playerBlackjack", "opponentBlackjack", "playerBusted", "opponentBusted", "changedAfterStand", "wholeRoundObserved", "wholeMatchObserved", "pivotalForPlayerVictory", "sameDefinitionAfterExhaustion", "copiedAfterExhaustion"];
export const GAMEPLAY_ACHIEVEMENT_CONTRACT: AchievementObservationContract = {
  topic: GAMEPLAY_ACHIEVEMENT_TOPIC,
  values: Object.fromEntries([...stringKeys.map(key => [key, "string"]), ...numberKeys.map(key => [key, "number"]), ...booleanKeys.map(key => [key, "boolean"])]) as AchievementObservationContract["values"], skillCollections: []
};
const handFingerprint = (world: AbilityWorld) => JSON.stringify(world.hands.player.cards);
const shoeFingerprint = (world: AbilityWorld) => JSON.stringify([world.shoe.shuffleIndex, world.shoe.cursor, world.shoe.cards.slice(world.shoe.cursor)]);
const matchFingerprint = (match: MatchState) => ({ hand: JSON.stringify(match.player.hand.cards), shoe: JSON.stringify([match.shoe.shuffleIndex, match.shoe.cursor, match.shoe.cards.slice(match.shoe.cursor)]) });
const addUnique = (items: string[], value: string) => { if (!items.includes(value)) items.push(value); };
const valuesForSource = (value: Pick<MatchFactSource, "definitionId" | "instanceId" | "owner">) => ({ sourceDefinition: value.definitionId, sourceInstance: value.instanceId, sourceOwner: value.owner });

/** Pure accepted-fact adapter. No content ID, character ID or rule ID receives special treatment. */
export function observeGameplayAchievements(previous: GameplayAchievementState, batch: MatchFactBatch, context: GameplayAchievementContext = {}): { readonly state: GameplayAchievementState; readonly observations: readonly GameplayAchievementObservation[] } {
  let state = GameplayAchievementStateSchema.parse(previous);
  const observations: GameplayAchievementObservation[] = [];
  if (batch.restored) return { state: state.matchId === batch.after.id ? { ...state, cursor: batch.toIndex } : createGameplayAchievementState(batch.after), observations };
  if (state.matchId === batch.after.id && batch.toIndex <= state.cursor) return { state, observations };
  if (state.matchId === batch.after.id && !state.open && batch.after.status === "finished" && !batch.facts.some(fact => fact.index >= state.cursor && fact.type === "MATCH_FINISHED")) {
    state.cursor = batch.toIndex; return { state, observations };
  }
  if (state.matchId !== batch.after.id) {
    state = createGameplayAchievementState(); state.matchId = batch.after.id; state.known = batch.before === undefined;
    state.deckSize = new Set(batch.after.playerSkills.deckDefinitionIds ?? []).size;
    state.profileDefeats = context.profileDefeats ?? 0; state.flowId = context.flowId ?? ""; state.nodeId = context.nodeId ?? ""; state.completedNodeIds = [...context.completedNodeIds ?? []];
    state.round = newRound(batch.before?.roundIndex ?? 0, batch.before === undefined);
    state.cursor = batch.fromIndex;
  }
  if (batch.fromIndex > state.cursor) {
    // A disabled/unsupported interval cannot establish a continuous attempt.
    state.known = false; state.round.known = false; state.round.forecast = null;
  }
  if (!state.open && !state.known) {
    state.profileDefeats = context.profileDefeats ?? state.profileDefeats;
    state.flowId = context.flowId ?? state.flowId; state.nodeId = context.nodeId ?? state.nodeId;
    state.completedNodeIds = [...context.completedNodeIds ?? state.completedNodeIds];
  }
  const match = batch.after;
  const emit = (event: string, values: Record<string, AchievementScalarValue> = {}, boundary?: AchievementObservation["boundary"]) => {
    observations.push({ apiVersion: 1, topic: GAMEPLAY_ACHIEVEMENT_TOPIC, scopes: { match: match.id, round: `${match.id}:round:${state.round.index}` },
      ...(boundary ? { boundary } : {}), values: { event, opponentId: match.opponentId, profileDefeats: state.profileDefeats, ...values }, skillCards: {} });
  };
  if (!state.open) {
    emit("match-begin", {}, { scope: "match", phase: "begin" }); state.open = true;
    for (const instance of match.abilities.instances) emit("ability-bound", { actor: instance.owner, definitionId: instance.definitionId, instanceId: instance.instanceId, level: instance.level ?? 1 });
  }
  const openRound = () => { if (!state.round.open) { emit("round-begin", {}, { scope: "round", phase: "begin" }); state.round.open = true; } };
  const closeRound = (reason: "completed" | "abandoned") => { if (state.round.open) { emit("round-end", {}, { scope: "round", phase: "end", reason }); state.round.open = false; } };
  openRound();
  const fingerprintBefore = batch.before ? matchFingerprint(batch.before) : undefined;
  if (state.round.forecast && (!fingerprintBefore || state.round.forecast.hand !== fingerprintBefore.hand || state.round.forecast.shoe !== fingerprintBefore.shoe)) state.round.forecast = null;

  const effectObserved = (effect: MatchEffectFact, origin: MatchFactSource, trigger: string | undefined) => {
    const round = state.round, actor = effect.actor, beforeHand = effect.before.hands[actor], afterHand = effect.after.hands[actor];
    const beforeLimit = effect.bustLimitsBefore[actor], limit = effect.bustLimitsAfter[actor];
    const beforeTotal = handValueAtLimit(beforeHand, beforeLimit), afterTotal = handValueAtLimit(afterHand, limit);
    const base = { ...valuesForSource(origin), actor, handTotalAfter: afterTotal, bustLimit: limit, safe: afterTotal <= limit,
      sourceDrawnThisRound: round.drawn.includes(origin.instanceId), sourceActivatedThisRound: round.instances.includes(origin.instanceId) };
    if (round.stood && trigger === "on-ability-played" && JSON.stringify(effect.before.hands.player.cards) !== JSON.stringify(effect.after.hands.player.cards) && origin.owner === "player") round.changedAfterStand = true;
    if (round.forecast && (handFingerprint(effect.after) !== round.forecast.hand || shoeFingerprint(effect.after) !== round.forecast.shoe)) round.forecast = null;
    if (effect.type === "publish-hit-bust-forecast") {
      const forecast = effect.events.find(event => event.type === "ABILITY_RESULT" && event.result.type === "hit-bust-forecast");
      if (actor === "player" && forecast?.type === "ABILITY_RESULT" && forecast.result.type === "hit-bust-forecast" && !forecast.result.wouldBust)
        round.forecast = { source: source(origin), hand: handFingerprint(effect.after), shoe: shoeFingerprint(effect.after) };
    }
    const rival: Actor = actor === "player" ? "opponent" : "player";
    for (const card of afterHand.cards.filter(card => !beforeHand.cards.some(old => old.id === card.id))) {
      if (effect.before.hands[rival].cards.some(old => old.id === card.id)) emit("hand-transfer", { ...base, from: rival, cardId: card.id, cardSource: card.attributes.source, cardValue: cardPointValue(card) });
    }
    if (["replace-hand-card", "swap-last-hand-card-with-draw-pile-top", "replace-hand-card-with-derived"].includes(effect.type)) {
      const old = beforeHand.cards.at(-1), replacement = afterHand.cards.at(-1);
      emit("hand-replaced", { ...base, recoveredFromBust: beforeTotal > beforeLimit && afterTotal <= limit,
        lastHitReplaced: actor === "player" && old?.id === round.lastHitPlayer && old?.id !== replacement?.id });
    }
    for (const card of beforeHand.cards.filter(card => card.attributes.source === "shoe" && !afterHand.cards.some(next => next.id === card.id))) {
      if (effect.after.shoe.cards[effect.after.shoe.cursor]?.id === card.id) round.returned.push({ source: source(origin), cardId: card.id, value: !isCardCountedInPointTotal(card) ? 0 : card.attributes.rank === "A" ? (handValueAtLimit({ cards: beforeHand.cards.filter(other => other.id !== card.id) }, beforeLimit) + 11 <= beforeLimit ? 11 : 1) : cardPointValue(card) });
    }
    const grant = effect.after.cards.find(card => !effect.before.cards.some(old => old.instanceId === card.instanceId));
    if (grant && effect.type === "grant-skill-card") {
      const copiedAfterExhaustion = round.exhausted?.definitionId === grant.definitionId && origin.owner === "player";
      if (copiedAfterExhaustion) round.copied[grant.instanceId] = source(origin);
      emit("skill-granted", { ...base, definitionId: grant.definitionId, instanceId: grant.instanceId, copiedDefinition: grant.definitionId, copiedAfterExhaustion });
      round.exhausted = null;
    }
    if (effect.comparisonBefore && effect.comparisonAfter) {
      const playerDelta = effect.comparisonAfter.scores.player - effect.comparisonBefore.scores.player;
      const opponentDelta = effect.comparisonAfter.scores.opponent - effect.comparisonBefore.scores.opponent;
      if (playerDelta || opponentDelta) {
        // Linear status-stack modifiers retain each contributing activation's identity.
        const amount = effect.effect.type === "add-to-pending-comparison-score" ? effect.effect.amount : undefined;
        const linear = (node: unknown): { statusId: string; target: string; factor: number } | undefined => {
          if (!node || typeof node !== "object") return;
          const value = node as Record<string, unknown>;
          if (value.type === "status-stacks" && typeof value.statusDefinitionId === "string" && typeof value.target === "string") return { statusId: value.statusDefinitionId, target: value.target, factor: 1 };
          if (value.type === "multiply") {
            const coefficient = typeof value.left === "number" ? value.left : typeof value.right === "number" ? value.right : undefined;
            const child = linear(typeof value.left === "number" ? value.right : value.left);
            if (coefficient !== undefined && child) return { ...child, factor: child.factor * coefficient };
          }
        };
        const stack = linear(amount);
        const stackActor = stack?.target === "owner" ? origin.owner : stack?.target === "rival" ? (origin.owner === "player" ? "opponent" : "player") : undefined;
        const parts = stack ? round.contributions.filter(part => part.statusId === stack.statusId && part.actor === stackActor) : [];
        const totalStacks = stack ? effect.before.statuses.find(status => status.statusDefinitionId === stack.statusId && status.owner === stackActor)?.stacks : undefined;
        if (stack && parts.length && parts.reduce((total, part) => total + part.delta, 0) === totalStacks) {
          for (const part of parts) round.modifiers.push({ source: part.source, playerDelta: actor === "player" ? part.delta * stack.factor : 0,
            opponentDelta: actor === "opponent" ? part.delta * stack.factor : 0, playerHits: part.playerHits, opponentHits: part.opponentHits });
        } else {
          const activation = round.activations[origin.instanceId];
          round.modifiers.push({ source: source(origin), playerDelta, opponentDelta,
            playerHits: activation?.playerHits ?? effect.roundHitCounts?.player ?? round.playerHits, opponentHits: activation?.opponentHits ?? effect.roundHitCounts?.opponent ?? round.opponentHits });
        }
      }
    }
    if (effect.loadBefore && effect.loadAfter && effect.loadAfter.amount > effect.loadBefore.amount) round.loads.push({ source: source(origin), actor: effect.loadAfter.actor,
      delta: effect.loadAfter.amount - effect.loadBefore.amount, slots: effect.before.guns[effect.loadAfter.actor].capacity - effect.before.guns[effect.loadAfter.actor].bullets });
    for (const status of effect.after.statuses) {
      const old = effect.before.statuses.find(old => old.statusDefinitionId === status.statusDefinitionId && old.owner === status.owner);
      const delta = status.stacks - (old?.stacks ?? 0);
      if (delta > 0) {
        const activation = round.activations[origin.instanceId];
        round.contributions.push({ statusId: status.statusDefinitionId, actor: status.owner, source: source(origin), delta,
          playerHits: activation?.playerHits ?? round.playerHits, opponentHits: activation?.opponentHits ?? round.opponentHits });
        emit("status-increased", { ...base, statusDefinition: status.statusDefinitionId, statusStackDelta: delta });
      } else if (delta < 0) round.contributions = round.contributions.filter(part => part.statusId !== status.statusDefinitionId || part.actor !== status.owner);
    }

  };

  for (const fact of batch.facts.filter(fact => fact.index >= state.cursor)) {
    const event = fact.event;
    if (event.type === "ROUND_STARTED") {
      if (event.roundIndex !== state.round.index || !state.round.known) { closeRound("completed"); state.round = newRound(event.roundIndex, true); openRound(); }
    }
    const round = state.round;
    if (event.type === "CARD_DEALT") {
      if (event.actor === "player") round.lastDealtPlayer = event.card.id; else round.lastDealtOpponent = event.card.id;
    }
    if (event.type === "PLAYER_HIT") {
      round.playerHits++; round.returned = round.returned.filter(item => item.cardId !== fact.snapshot?.world.hands.player.cards.at(-1)?.id); round.lastHitPlayer = fact.snapshot?.world.hands.player.cards.at(-1)?.id ?? round.lastDealtPlayer;
      const resolved = matchHitResolution(batch.events[fact.index - batch.fromIndex]);
      if (round.forecast && resolved) emit("forecast-hit", { ...valuesForSource(round.forecast.source), safe: !resolved.snapshot.busted.player && !resolved.bustActors.includes("player")
        && handValueAtLimit(resolved.snapshot.world.hands.player, resolved.snapshot.bustLimits.player) <= resolved.snapshot.bustLimits.player });
      round.forecast = null; round.exhausted = null;
    }
    if (event.type === "OPPONENT_HIT") {
      round.opponentHits++; round.exhausted = null;
      const cardId = fact.snapshot?.world.hands.opponent.cards.at(-1)?.id;
      const gift = round.returned.find(item => item.cardId === cardId);
      const resolved = matchHitResolution(batch.events[fact.index - batch.fromIndex]);
      if (gift && fact.snapshot && resolved && !fact.snapshot.busted.opponent && resolved.bustActors.includes("opponent") && resolved.snapshot.busted.opponent
        && handValueAtLimit({ cards: fact.snapshot.world.hands.opponent.cards.filter(card => card.id !== cardId) }, fact.snapshot.bustLimits.opponent) <= fact.snapshot.bustLimits.opponent
        && handValueAtLimit(fact.snapshot.world.hands.opponent, fact.snapshot.bustLimits.opponent) > fact.snapshot.bustLimits.opponent
        && resolved.snapshot.world.hands.opponent.cards.some(card => card.id === gift.cardId)) {
        emit("returned-card-bust", { ...valuesForSource(gift.source), cardId: gift.cardId, cardValue: gift.value }); round.giftedHit = null;
      }
      round.returned = round.returned.filter(item => item.cardId !== cardId); round.forecast = null;
    }
    if (event.type === "PLAYER_STOOD") { if (fact.voluntaryStand) round.stood = true; round.forecast = null; round.exhausted = null; }
    if (event.type === "OPPONENT_STOOD") round.exhausted = null;

    if (event.type === "SKILL_DRAW_OPENED" || event.type === "SKILL_DRAW_REFRESHED") { round.exhausted = null; round.forecast = null; }
    if (event.type === "SKILL_DRAW_RESOLVED") {
      const drawn = fact.snapshot?.world.cards.filter(card => card.definitionId === event.selectedDefinitionId).at(-1);
      if (drawn) addUnique(round.drawn, drawn.instanceId);
      round.exhausted = null; round.forecast = null;
    }
    if (event.type === "ABILITY_PLAYED") {
      const definition = getAbilityDefinition(event.definitionId, undefined, event.level);
      if (event.owner === "player") {
        round.activeCount++; state.activeCount++; addUnique(round.definitions, event.definitionId); addUnique(state.definitions, event.definitionId); addUnique(round.instances, event.instanceId);
        if (fact.play?.primaryDomain ?? definition?.primaryDomain) addUnique(round.domains, fact.play?.primaryDomain ?? definition!.primaryDomain);
        round.uses[event.instanceId] = (round.uses[event.instanceId] ?? 0) + 1;
        round.activations[event.instanceId] = { playerHits: fact.play?.roundHitCounts?.player ?? round.playerHits, opponentHits: fact.play?.roundHitCounts?.opponent ?? round.opponentHits };
        const copied = round.copied[event.instanceId];
        emit("ability-played", { ...valuesForSource({ ...event, definitionId: event.definitionId }), definitionId: event.definitionId, instanceId: event.instanceId,
          cardRoundUses: round.uses[event.instanceId], roundDomainCount: round.domains.length, beforeEmptySlots: fact.play ? fact.play.before.guns.player.capacity - fact.play.before.guns.player.bullets : batch.before ? batch.before.roulette.player.capacity - batch.before.roulette.player.bullets : match.roulette.player.capacity - match.roulette.player.bullets,
          sameDefinitionAfterExhaustion: !!copied, ...(copied ? { previousDefinition: copied.definitionId } : {}) });
        const old = batch.before?.abilities.instances.find(instance => instance.instanceId === event.instanceId);
        const consumed = fact.play ? fact.play.consumesCard && fact.play.usesBefore === 1 : definition?.activation.type === "action" && definition.activation.consume === "card" && (old?.remainingUses ?? definition.activation.uses ?? 1) === 1;
        // The next successful ability may grant a copy; ordinary actions clear this claim.
        if (!round.exhausted || !definition?.rules.some(rule => rule.effects.some(effect => effect.type === "grant-skill-card"))) round.exhausted = null;
        if (consumed) round.exhausted ??= { definitionId: event.definitionId, instanceId: event.instanceId };
        round.forecast = null;
      }
    }
    if (event.type === "SKILL_CARDS_REMOVED") emit("skills-removed", { ...(fact.source ? valuesForSource(fact.source) : {}), actor: event.actor, removedCount: event.cards.length });
    if (fact.source) for (const effect of fact.effects ?? []) effectObserved(effect, fact.source, fact.cause?.trigger);
    if (event.type === "ROUND_RESOLVED") {
      state.rounds++;
      const hands = fact.snapshot?.world.hands ?? { player: match.player.hand, opponent: match.opponent.hand };
      const busted = fact.snapshot?.busted ?? { player: match.player.busted, opponent: match.opponent.busted };
      const playerLimit = fact.snapshot?.bustLimits.player ?? match.player.bustLimit ?? 21, opponentLimit = fact.snapshot?.bustLimits.opponent ?? match.opponent.bustLimit ?? 21;
      const playerBase = handValueAtLimit(hands.player, playerLimit), opponentBase = handValueAtLimit(hands.opponent, opponentLimit);
      emit("round-settled", { winner: event.outcome.winner ?? "draw", reason: event.outcome.reason, roundActiveCount: round.activeCount, roundDomainCount: round.domains.length,
        playerCardCount: hands.player.cards.length, playerPhysicalCount: hands.player.cards.filter(card => card.attributes.source === "shoe").length,
        playerDerivedCount: hands.player.cards.filter(card => card.attributes.source === "derived").length,
        playerBaseTotal: playerBase, opponentBaseTotal: opponentBase, playerFinalScore: event.outcome.comparisonScores?.player ?? playerBase, opponentFinalScore: event.outcome.comparisonScores?.opponent ?? opponentBase,
        playerPointAdvantage: event.outcome.pointAdvantages?.player ?? 0, opponentPointAdvantage: event.outcome.pointAdvantages?.opponent ?? 0,
        playerBlackjack: isBlackjack(hands.player), opponentBlackjack: isBlackjack(hands.opponent), playerBusted: busted.player, opponentBusted: busted.opponent,
        changedAfterStand: round.changedAfterStand, wholeRoundObserved: round.known,
        playerSkillComparisonAdvantage: round.modifiers.reduce((total, modifier) => total + (modifier.source.owner === "player" && getAbilityDefinition(modifier.source.definitionId)?.sourceKind !== "talent" ? modifier.playerDelta - modifier.opponentDelta : 0), 0) });
      for (const modifier of round.modifiers) {
        const scores = event.outcome.comparisonScores;
        const pivotal = !!scores && event.outcome.winner === "player" && event.outcome.reason === "comparison" && scores.player - modifier.playerDelta <= scores.opponent - modifier.opponentDelta;
        emit("comparison-effect-settled", { ...valuesForSource(modifier.source), playerRoundHits: modifier.playerHits, opponentRoundHits: modifier.opponentHits,
          sourceActivatedThisRound: round.instances.includes(modifier.source.instanceId), pivotalForPlayerVictory: pivotal, winner: event.outcome.winner ?? "draw", reason: event.outcome.reason,
          extraComparisonPoints: modifier.playerDelta - modifier.opponentDelta });
      }
    }
    if (event.type === "BULLET_ADDED") for (const load of round.loads.filter(load => load.actor === event.actor)) {
      const actualExtraLoad = Math.max(0, (event.actualAmount ?? Math.min(event.amount, load.slots)) - Math.min(Math.max(0, event.amount - load.delta), load.slots));
      emit("extra-load", { ...valuesForSource(load.source), actualExtraLoad, sourceDrawnThisRound: round.drawn.includes(load.source.instanceId), sourceActivatedThisRound: round.instances.includes(load.source.instanceId) });
    }
    if (event.type === "BULLET_ADDED") round.loads = [];
    if (event.type === "TRIGGER_PULLED") emit("trigger-result", { actor: event.actor, reason: event.result, misfireChance: event.misfireChance,
      beforeEmptySlots: event.capacityBefore !== undefined && event.bulletsBefore !== undefined ? event.capacityBefore - event.bulletsBefore : -1 });
    if (event.type === "MATCH_FINISHED") {
      const guns = fact.snapshot?.world.guns ?? match.roulette;
      emit("match-settled", { winner: fact.snapshot?.outcome?.winner ?? match.outcome?.winner ?? "draw", reason: event.reason, matchActiveCount: state.activeCount, matchDistinctSkills: state.definitions.length, deckSize: state.deckSize,
        rounds: state.rounds, playerEmptySlots: guns.player.capacity - guns.player.bullets, opponentEmptySlots: guns.opponent.capacity - guns.opponent.bullets,
        wholeMatchObserved: state.known, flowId: state.flowId, nodeId: state.nodeId, completedNodeCount: state.completedNodeIds.length,
        ...(state.completedNodeIds.length === 1 ? { completedNodeId: state.completedNodeIds[0] } : {}) });
      closeRound(event.reason === "escaped" ? "abandoned" : "completed");
      emit("match-end", {}, { scope: "match", phase: "end", reason: event.reason === "escaped" ? "abandoned" : "completed" }); state.open = false;
    }
  }
  state.cursor = batch.toIndex;
  return { state: GameplayAchievementStateSchema.parse(state), observations };
}
