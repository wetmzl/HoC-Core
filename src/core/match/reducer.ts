import { publicHandCardIds } from "./card-visibility";
import { carryPlayerSkills, type PlayerSkillCarryover } from "../abilities/carryover";
import { configureIntrinsicAbility, reconcileIntrinsicAbilities, removeIntrinsicAbilities } from "../intrinsic-abilities";
import { addCard, createHand, handValue, handValueAtLimit, isBlackjack, isBust } from "../blackjack/hand";
import { dealInitialHands, drawCard, reshuffleIfLow, createShoe, shoeRemaining } from "../blackjack/shoe";
import type { Card } from "../blackjack/types";
import { deriveRng, SeededRng } from "../rng/seeded";
import { addBullets, createGun, deathProbability, pullTrigger } from "../roulette/roulette";
import { getPlayerSkillDefinition, INITIAL_PLAYER_SKILL_IDS } from "../skills/definitions";
import { SKILL_TAGS, type SkillTag } from "../skills/types";
import { canGenerateSkillDraw, collectSkillDrawWeightModifiers, generateSkillDrawOffer, PLAYER_SKILL_INVENTORY_CAPACITY } from "../skills/skills";
import { canAcquirePlayerSkill, recordPlayerSkillAcquisition } from "../skills/acquisition";
import { decideAiAction, sampleAiNoise } from "../ai/policy";
import { buildObservation } from "../ai/observation";
import { getRoundStarter } from "../blackjack/round";
import { advanceRoundAbilityTtls, createAbilityRuntime, addAbilityInstance, clearCounters, clearEventCounters, expireOwnerActionStatuses, expireStatuses, garbageCollectAbilityInstances, isAbilityInstanceExpired } from "../abilities/runtime";
import { getAbilityDefinition, instantiateAbility, supportsAbilitySourceKind, validateAbilityBinding } from "../abilities/registry";
import { canPlayAbility, isActionBlockedByStatus, playAbility, resolveAbilityEvent, AbilityResolutionError } from "../abilities/engine";
import type { AbilityBinding, AbilityEventContext, AbilityInstance, AbilityWorld, PendingAiThreshold, PendingBustCheck, PendingComparison, PendingDefeat, PendingDraw, PendingLoad, PendingTrigger, PendingTurn, SkillCardInstance } from "../abilities/types";
import type { Action, Actor, GameEvent, MatchOutcome, MatchState, ParticipantState, RoundOutcome, RoundPhase, RoundState } from "./types";
import { DEFAULT_AI_PROFILE, type AiProfile } from "../ai/types";

const MAX_BUST_RESCUE_PASSES = 16;

export interface CreateMatchOptions {
  readonly playerCarryover?: PlayerSkillCarryover;
  /** Declarative initialization, applied before the first deal and opening abilities. */
  readonly initialPlayerSkills?: readonly AbilityBinding[];
  readonly initialSkillDraws?: number;
  readonly openingSkillCards?: number;
  readonly grantOpeningSkills?: boolean;
  readonly comparisonBonuses?: MatchState["comparisonBonuses"];
  /** Supplied before any opening ability runs; defaults to an empty gun. */
  readonly playerGun?: import("../roulette/types").GunState;
  readonly opponentGun?: import("../roulette/types").GunState;
  readonly intrinsicAbilities?: readonly AbilityBinding[];
  readonly id?: string;
  readonly opponentId?: string;
  readonly aiProfile?: AiProfile;
  readonly autoSkipAfterStand?: boolean;
  readonly unlockedPlayerSkillIds?: readonly string[];
  readonly skillDeckIds?: readonly string[];
  readonly selectedSkillTags?: readonly SkillTag[];
  readonly talentIds?: readonly string[];
  readonly opponentAiSkills?: readonly AbilityBinding[];
  /** Engine fixture hook; production AI Skills are owned by the opponent. */
  readonly playerAiSkills?: readonly AbilityBinding[];
}

function normalizeUnlocked(ids: readonly string[] | undefined): string[] {
  const values = [...new Set(ids ?? INITIAL_PLAYER_SKILL_IDS)];
  if (values.some((id) => !getPlayerSkillDefinition(id))) throw new RangeError("Unlocked Player Skill list contains an unknown definition");
  return values;
}
function normalizeSelectedSkillTags(tags: readonly SkillTag[] | undefined): SkillTag[] {
  const input = [...(tags ?? [])];
  if (new Set(input).size !== input.length || input.length > 2 || input.some((tag) => !SKILL_TAGS.includes(tag))) throw new RangeError("Selected Skill Tags must contain at most two valid unique tags");
  const values = input;
  return values;
}
function playerSkillState(state: MatchState, patch: Partial<MatchState["playerSkills"]> = {}): MatchState["playerSkills"] { return { ...state.playerSkills, ...patch }; }
function participant(id: Actor, cards: readonly Card[]): ParticipantState { return { id, hand: createHand(cards), stood: false, busted: false }; }
function append(state: MatchState, ...events: readonly GameEvent[]): MatchState { return events.length === 0 ? state : { ...state, history: [...state.history, ...events] }; }
function makeRound(index: number, shoe: MatchState["shoe"], deckRng: SeededRng) {
  const deal = dealInitialHands(reshuffleIfLow(shoe, deckRng, 12));
  return { player: participant("player", deal.player), opponent: participant("opponent", deal.opponent), shoe: deal.shoe, starter: getRoundStarter(index), deckRng, events: [
    { type: "ROUND_STARTED", roundIndex: index }, { type: "CARD_DEALT", actor: "player", card: deal.player[0], private: false }, { type: "CARD_DEALT", actor: "opponent", card: deal.opponent[0], private: false }, { type: "CARD_DEALT", actor: "player", card: deal.player[1], private: true }, { type: "CARD_DEALT", actor: "opponent", card: deal.opponent[1], private: true }
  ] as const };
}
function withRound(state: MatchState, round: RoundState, extra: Partial<MatchState> = {}): MatchState { return { ...state, ...extra, player: round.player, opponent: round.opponent, round, roundIndex: round.index }; }
function expireLifecycle(state: MatchState, duration: "turn" | "round" | "match"): MatchState {
  const before = state.abilities.statuses;
  const runtime = garbageCollectAbilityInstances(expireStatuses(clearCounters(state.abilities, duration), duration), state.playerSkills.cards);
  const expired = before.filter((status) => !runtime.statuses.includes(status)).map((status) => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "expired" as const }));
  return append({ ...state, abilities: runtime }, ...expired);
}
function expireOwnerActionLifecycle(state: MatchState, owner: Actor): MatchState {
  const before = state.abilities.statuses;
  const runtime = garbageCollectAbilityInstances(expireOwnerActionStatuses(state.abilities, owner), state.playerSkills.cards);
  const expired = before.filter((status) => !runtime.statuses.includes(status)).map((status) => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "expired" as const }));
  return append({ ...state, abilities: runtime }, ...expired);
}
function expireAllStatuses(state: MatchState): MatchState {
  state = removeIntrinsicAbilities(state);
  const runtimeWithNoCounters = (["event", "turn", "round", "match"] as const)
    .reduce((runtime, scope) => clearCounters(runtime, scope), state.abilities);
  const runtime = garbageCollectAbilityInstances({ ...runtimeWithNoCounters, statuses: [] }, state.playerSkills.cards);
  const expired = state.abilities.statuses.map((status) => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "expired" as const }));
  return append({ ...state, abilities: runtime }, ...expired);
}
function setPhase(state: MatchState, phase: RoundPhase, currentActor: Actor | null): MatchState {
  const changedTurn = state.round.phase === "turns" && phase === "turns" && currentActor !== state.round.currentActor;
  const lifecycle = changedTurn ? expireLifecycle(state, "turn") : state;
  return withRound({ ...lifecycle, abilities: garbageCollectAbilityInstances(lifecycle.abilities, lifecycle.playerSkills.cards) }, { ...lifecycle.round, phase, currentActor });
}

export function abilityWorld(state: MatchState): AbilityWorld { return { skillAcquisitionCounts: state.playerSkills.acquisitionCounts, currentRoundPointAdvantages: state.round.outcome?.pointAdvantages, previousRoundPointAdvantages: state.previousRoundPointAdvantages, publicCardIds: [...publicHandCardIds(state)], hands: { player: state.player.hand, opponent: state.opponent.hand }, guns: state.roulette, shoe: state.shoe, cards: state.playerSkills.cards, skillDraws: state.playerSkills.drawCount, openingSkillCardCount: state.playerSkills.openingCardCount, skillDrawRefreshes: state.playerSkills.refreshesPerDraw, statuses: state.abilities.statuses, stood: { player: state.player.stood, opponent: state.opponent.stood } }; }
export function commitAbilityWorld(state: MatchState, world: AbilityWorld): MatchState {
  const player = { ...state.player, hand: world.hands.player, stood: world.stood?.player ?? state.player.stood };
  const opponent = { ...state.opponent, hand: world.hands.opponent, stood: world.stood?.opponent ?? state.opponent.stood };
  const events: GameEvent[] = [];
  if (!state.player.stood && player.stood) events.push({ type: "PLAYER_STOOD" });
  if (!state.opponent.stood && opponent.stood) events.push({ type: "OPPONENT_STOOD" });
  return append({ ...state, player, opponent, round: { ...state.round, player, opponent }, shoe: world.shoe, roulette: world.guns, playerSkills: playerSkillState(state, { cards: [...world.cards], ...(world.skillAcquisitionCounts ? { acquisitionCounts: world.skillAcquisitionCounts } : {}), drawCount: world.skillDraws, openingCardCount: world.openingSkillCardCount ?? state.playerSkills.openingCardCount, refreshesPerDraw: world.skillDrawRefreshes ?? state.playerSkills.refreshesPerDraw }), abilities: { ...state.abilities, statuses: [...world.statuses] } }, ...events);
}

function changedHandActors(before: AbilityWorld, after: AbilityWorld): Actor[] {
  return (["player", "opponent"] as const).filter((actor) => before.hands[actor].cards !== after.hands[actor].cards);
}
/** Bust limits depend on both hand sizes, so any real hand mutation invalidates
 * both actors' cached checks. This is deliberately generic and ability-agnostic. */
function invalidateBustLimits(state: MatchState, actors: readonly Actor[]): MatchState {
  if (actors.length === 0) return state;
  const player = state.player.bustLimit === undefined ? state.player : { ...state.player, bustLimit: undefined };
  const opponent = state.opponent.bustLimit === undefined ? state.opponent : { ...state.opponent, bustLimit: undefined };
  return withRound({ ...state, player, opponent }, { ...state.round, player, opponent });
}
export function getRoundHitCounts(state: MatchState): Readonly<Record<Actor, number>> {
  let start = -1;
  state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED") start = index; });
  const events = start >= 0 ? state.history.slice(start + 1) : state.history;
  return { player: events.filter((event) => event.type === "PLAYER_HIT").length, opponent: events.filter((event) => event.type === "OPPONENT_HIT").length };
}

/** Hit and its dealt card are adjacent; later skill acquisitions never replace this identity. */
function lastHitCardIds(state: MatchState): Readonly<Partial<Record<Actor, string>>> {
  const ids: Partial<Record<Actor, string>> = {};
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const event = state.history[index];
    if (event.type === "ROUND_STARTED") break;
    const actor = event.type === "PLAYER_HIT" ? "player" : event.type === "OPPONENT_HIT" ? "opponent" : undefined;
    if (!actor || ids[actor]) continue;
    const dealt = state.history[index + 1];
    if (dealt?.type === "CARD_DEALT" && dealt.actor === actor) ids[actor] = dealt.card.id;
  }
  return ids;
}

export interface PendingTriggerPreview {
  readonly baseProbability: number;
  readonly probability: number;
  readonly actor: Actor;
  readonly misfireChance: number;
  readonly cancelled: boolean;
  readonly events: readonly GameEvent[];
}

/** Resolves the pending trigger against a discarded copy so the waiting UI can
 * present deterministic modifiers without consuming TTL, counters or RNG. */
export function previewPendingTrigger(state: MatchState): PendingTriggerPreview | null {
  if (state.round.phase !== "round-reveal" && state.round.phase !== "roulette-reaction" && state.round.phase !== "roulette-trigger") return null;
  const actor = state.round.outcome?.penaltyTarget;
  if (!actor) return null;
  const pending: PendingTrigger = { id: `trigger-preview:${state.roundIndex}:${state.history.length}`, actor };
  const historyLength = state.history.length;
  const prepared = runAbilityEvent(state, {
    trigger: "before-trigger-pull",
    sourceEventId: pending.id,
    eventActor: actor,
    roundHitCounts: getRoundHitCounts(state),
    roundOutcome: state.round.outcome ?? undefined
  }, { trigger: pending });
  const baseProbability = deathProbability(prepared.state.roulette[actor]);
  return {
    actor,
    baseProbability,
    probability: baseProbability * (1 - Math.max(0, Math.min(1, prepared.pendingTrigger?.misfireChance ?? 0))),
    misfireChance: prepared.pendingTrigger?.misfireChance ?? 0,
    cancelled: prepared.pendingTrigger?.cancelled ?? false,
    events: prepared.state.history.slice(historyLength)
  };
}

function broadcastHandChanges(state: MatchState, actors: readonly Actor[], sourceEventId: string): MatchState {
  return actors.reduce((next, actor) => {
    const before = abilityWorld(next);
    const resolved = runAbilityEvent(next, { trigger: "after-hand-changed", sourceEventId: `${sourceEventId}:${actor}`, eventActor: actor, roundHitCounts: getRoundHitCounts(next) }, {}).state;
    return invalidateBustLimits(resolved, changedHandActors(before, abilityWorld(resolved)));
  }, state);
}

function broadcastDrawPileChange(state: MatchState, before: AbilityWorld, sourceEventId: string, force = false): MatchState {
  const previous = before.shoe.cards[before.shoe.cursor]?.id;
  const current = state.shoe.cards[state.shoe.cursor]?.id;
  if (!force && previous === current) return state;
  return runAbilityEvent(state, { trigger: "after-draw-pile-changed", sourceEventId, roundHitCounts: getRoundHitCounts(state) }, {}).state;
}

function abilityServices(state: MatchState) {
  return {
    roundHitCounts: getRoundHitCounts(state),
    bustLimitFor: (owner: Actor, world: AbilityWorld) => getActiveBustLimit(commitAbilityWorld(state, world), owner),
    forecastHitBust: (owner: Actor, world: AbilityWorld) => {
      const card = world.shoe.cards[world.shoe.cursor];
      if (!card) throw new Error("Draw-pile top card is unavailable");
      const projected = commitAbilityWorld(state, world);
      const limit = getActiveBustLimit(projected, owner);
      return handValueAtLimit(addCard(world.hands[owner], card), limit) > limit;
    }
  };
}
function roundHadBust(state: MatchState): boolean {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    if (state.history[index].type === "ROUND_STARTED") return false;
    if (state.history[index].type === "BUST") return true;
  }
  return false;
}
function runAbilityEvent(state: MatchState, event: AbilityEventContext, pending: { turn?: PendingTurn; aiThreshold?: PendingAiThreshold; draw?: PendingDraw; load?: PendingLoad; bust?: PendingBustCheck; trigger?: PendingTrigger; defeat?: PendingDefeat; comparison?: PendingComparison; owners?: readonly Actor[] } = {}, directInstanceId?: string): { readonly state: MatchState; readonly pendingTurn?: PendingTurn; readonly pendingAiThreshold?: PendingAiThreshold; readonly pendingDraw?: PendingDraw; readonly pendingLoad?: PendingLoad; readonly pendingBust?: PendingBustCheck; readonly pendingTrigger?: PendingTrigger; readonly pendingDefeat?: PendingDefeat; readonly pendingComparison?: PendingComparison; readonly failed: boolean } {
  try {
    const result = resolveAbilityEvent({ world: abilityWorld(state), runtime: state.abilities, event: { ...event, lastHitCardIds: lastHitCardIds(state), roundHadBust: roundHadBust(state) }, pendingTurn: pending.turn, pendingAiThreshold: pending.aiThreshold, pendingDraw: pending.draw, pendingLoad: pending.load, pendingBust: pending.bust, pendingTrigger: pending.trigger, pendingDefeat: pending.defeat, pendingComparison: pending.comparison, owners: pending.owners, directInstanceId, ...abilityServices(state) });
    let next = commitAbilityWorld(state, result.world);
    // Effects that grant Player Skill cards create their runtime instance in
    // the same transaction. Only legacy/newly-created card projections that
    // are not already represented by the resolver need instantiation here.
    const cards = result.world.cards.filter((card) => !state.playerSkills.cards.some((old) => old.instanceId === card.instanceId)
      && !result.runtime.instances.some((instance) => instance.instanceId === card.instanceId));
    const firstSequence = Math.max(state.abilities.sequence, result.runtime.sequence);
    const instances: AbilityInstance[] = cards.map((card, index) => ({ ...card, createdAtSequence: firstSequence + index + 1, parameters: {} }));
    next = { ...next, abilities: { ...next.abilities, ...result.runtime, instances: [...result.runtime.instances, ...instances], sequence: Math.max(result.runtime.sequence, firstSequence + instances.length) } };
    next = { ...next, abilities: clearEventCounters(next.abilities, event.sourceEventId) };
    next = { ...next, abilities: garbageCollectAbilityInstances(next.abilities, next.playerSkills.cards) };
    next = invalidateBustLimits(next, changedHandActors(abilityWorld(state), result.world));
    return { state: append(next, ...result.events as GameEvent[], ...cards.map((card) => ({ type: "SKILL_GAINED" as const, skillId: card.definitionId }))), pendingTurn: result.pendingTurn, pendingAiThreshold: result.pendingAiThreshold, pendingDraw: result.pendingDraw, pendingLoad: result.pendingLoad, pendingBust: result.pendingBust, pendingTrigger: result.pendingTrigger, pendingDefeat: result.pendingDefeat, pendingComparison: result.pendingComparison, failed: false };
  } catch (error) {
    // A failed ability event is atomic. The caller may continue with the
    // unmodified pending event so the base game action remains safe.
    if (error instanceof AbilityResolutionError && error.instanceId && error.definitionId) return {
      state: append(state, { type: "ABILITY_RESOLUTION_FAILED", instanceId: error.instanceId, definitionId: error.definitionId, ruleId: error.ruleId ?? "ability-resolution", reason: error.message }),
      pendingTurn: pending.turn, pendingAiThreshold: pending.aiThreshold, pendingDraw: pending.draw, pendingLoad: pending.load, pendingBust: pending.bust,
      pendingTrigger: pending.trigger, pendingDefeat: pending.defeat, pendingComparison: pending.comparison, failed: true
    };
    throw error;
  }
}

function canReceiveTurn(state: MatchState, actor: Actor): boolean {
  return !state[actor].stood || (actor === "player" && state.autoSkipAfterStand === false);
}

/** Active abilities share the same skip preflight as turn-start rules. */
function activePendingTurn(state: MatchState): PendingTurn | undefined {
  const actor = state.round.currentActor;
  if (state.round.phase !== "turns" || !actor) return undefined;
  return { id: `active-turn:${state.roundIndex}:${state.history.length}:${actor}`, actor,
    canSkip: canReceiveTurn(state, actor === "player" ? "opponent" : "player") };
}

/** Opens the data-driven turn-start window and follows a successful skip
 * without marking either participant as stood. Each actor can be skipped at
 * most once in one handoff chain, preventing reciprocal rules from looping. */
function beginTurn(state: MatchState, actor: Actor, skippedInChain: readonly Actor[] = []): MatchState {
  const entered = setPhase(state, "turns", actor);
  if (skippedInChain.includes(actor)) return entered;
  const alternate: Actor = actor === "player" ? "opponent" : "player";
  const pending: PendingTurn = {
    id: `turn:${state.roundIndex}:${state.history.length}:${actor}`,
    actor,
    canSkip: canReceiveTurn(entered, alternate)
  };
  const prepared = runAbilityEvent(entered, {
    trigger: "before-turn", sourceEventId: pending.id, eventActor: actor, roundHitCounts: getRoundHitCounts(entered), pendingTurn: pending
  }, { turn: pending });
  const normalized = normalizeAbilityHands(prepared.state);
  if ((normalized.player.stood && normalized.opponent.stood)
    || !canReceiveTurn(normalized, actor)
    || (!entered[actor].stood && normalized[actor].stood)) return continueTurns(normalized, alternate);
  const resolved = prepared.pendingTurn ?? pending;
  if (!resolved.skipped) return normalized;
  if (!resolved.skipSourceInstanceId) throw new Error("Skipped turn is missing its source ability instance");
  const skipped = append(normalized, { type: "TURN_SKIPPED", actor, sourceInstanceId: resolved.skipSourceInstanceId });
  return beginTurn(skipped, alternate, [...skippedInChain, actor]);
}

export interface ComparisonScorePreview {
  readonly baseScores: Readonly<Record<Actor, number>>;
  readonly scores: Readonly<Record<Actor, number>>;
}

function comparisonBaseScores(state: MatchState): Readonly<Record<Actor, number>> {
  return {
    player: handValueAtLimit(state.player.hand, state.player.bustLimit ?? getActiveBustLimit(state, "player")),
    opponent: handValueAtLimit(state.opponent.hand, state.opponent.bustLimit ?? getActiveBustLimit(state, "opponent"))
  };
}

function comparisonScores(state: MatchState) {
  const base = comparisonBaseScores(state);
  return { player: base.player + (state.comparisonBonuses?.player ?? 0), opponent: base.opponent + (state.comparisonBonuses?.opponent ?? 0) };
}

/** Dry-runs the normal comparison window so the table can project score
 * modifiers during play without consuming ability state or randomness. */
export function previewComparisonScores(state: MatchState): ComparisonScorePreview {
  const baseScores = comparisonBaseScores(state);
  const finalScores = state.round.outcome?.comparisonScores;
  if (finalScores) return { baseScores, scores: finalScores };
  if (state.round.phase !== "turns" || state.round.outcome) return { baseScores, scores: baseScores };
  const comparison: PendingComparison = { id: `comparison-preview:${state.roundIndex}:${state.history.length}`, scores: comparisonScores(state), baseScores };
  const provisionalOutcome = comparisonOutcome(comparison.scores);
  const prepared = runAbilityEvent(state, {
    trigger: "before-round-resolution",
    sourceEventId: `round-resolution:${state.roundIndex}:${state.history.length}`,
    eventActor: provisionalOutcome.winner ?? undefined,
    roundOutcome: { reason: "comparison", penaltyTarget: provisionalOutcome.penaltyTarget }
  }, { comparison });
  return { baseScores, scores: prepared.pendingComparison?.scores ?? comparison.scores };
}

function resolveComparison(state: MatchState): MatchState {
  const comparison: PendingComparison = {
    id: `comparison:${state.roundIndex}:${state.history.length}`,
    scores: comparisonScores(state), baseScores: comparisonBaseScores(state)
  };
  return resolveRound(state, comparisonOutcome(comparison.scores), comparison);
}

function naturalBlackjackOutcome(state: MatchState): RoundOutcome | null {
  const playerBlackjack = isBlackjack(state.player.hand);
  const opponentBlackjack = isBlackjack(state.opponent.hand);
  if (!playerBlackjack && !opponentBlackjack) return null;
  const winner = playerBlackjack === opponentBlackjack ? null : playerBlackjack ? "player" : "opponent";
  return { winner, reason: winner === null ? "push" : "blackjack", penaltyTarget: winner === null ? null : winner === "player" ? "opponent" : "player", bulletsAdded: winner === null ? 0 : 2 };
}

function comparisonOutcome(scores: Readonly<Record<Actor, number>>): RoundOutcome {
  const winner: Actor | null = scores.player === scores.opponent
    ? null
    : scores.player > scores.opponent ? "player" : "opponent";
  return { winner, reason: winner === null ? "push" : "comparison", penaltyTarget: winner === null ? null : winner === "player" ? "opponent" : "player", bulletsAdded: winner === null ? 0 : 1, comparisonScores: scores };
}

function awardRoundSkillDraws(state: MatchState, outcome: RoundOutcome): MatchState {
  const blackjackWin = outcome.winner === "player" && outcome.reason === "blackjack";
  const amount = blackjackWin ? 2 : 1;
  const reason = blackjackWin ? "blackjack" as const
    : outcome.winner === null ? "push" as const
      : outcome.winner === "player" ? "win" as const : "loss" as const;
  return append({
    ...state,
    playerSkills: playerSkillState(state, { drawCount: state.playerSkills.drawCount + amount })
  }, { type: "SKILL_DRAWS_ADDED", reason, amount });
}

export function resolveRound(state: MatchState, outcome: RoundOutcome, pointComparison?: PendingComparison): MatchState {
  const comparison = pointComparison ?? (outcome.reason === "comparison"
    ? { id: `comparison:${state.roundIndex}:${state.history.length}`, scores: comparisonScores(state), baseScores: comparisonBaseScores(state) }
    : undefined);
  // Entering point comparison is distinct from its provisional result: equal
  // base totals are still modifiable before they become a final push.
  const abilityOutcome = pointComparison
    ? { reason: "comparison" as const, penaltyTarget: outcome.penaltyTarget }
    : outcome;
  const prepared = runAbilityEvent(state, { trigger: "before-round-resolution", sourceEventId: `round-resolution:${state.roundIndex}:${state.history.length}`, eventActor: outcome.winner ?? undefined, roundOutcome: abilityOutcome }, { comparison });
  const comparisonChanged = Boolean(prepared.pendingComparison && comparison && (prepared.pendingComparison.scores.player !== comparison.scores.player || prepared.pendingComparison.scores.opponent !== comparison.scores.opponent));
  const shouldResolveComparisonScores = Boolean(pointComparison || comparisonChanged || (comparison && (state.comparisonBonuses?.player || state.comparisonBonuses?.opponent)));
  const resolvedOutcome = shouldResolveComparisonScores
    ? comparisonOutcome((prepared.pendingComparison ?? comparison)!.scores)
    : undefined;
  const resolved = resolvedOutcome ?? outcome;
  const bases = comparison?.baseScores ?? comparisonBaseScores(state);
  const finalOutcome: RoundOutcome = resolved.comparisonScores ? { ...resolved, pointAdvantages:
    { player: resolved.comparisonScores.player - bases.player, opponent: resolved.comparisonScores.opponent - bases.opponent }
  } : resolved;
  const blackjacks = (["player", "opponent"] as const)
    .filter((actor) => isBlackjack(prepared.state[actor].hand))
    .map((actor) => ({ type: "BLACKJACK" as const, actor }));
  let next = awardRoundSkillDraws(append(prepared.state, ...blackjacks), finalOutcome);
  if (!finalOutcome.penaltyTarget) {
    next = append(withRound(next, { ...next.round, phase: "round-reveal", currentActor: null, outcome: finalOutcome }), { type: "ROUND_RESOLVED", outcome: finalOutcome });
    return next;
  }
  const pendingLoad: PendingLoad = { id: `load:${state.roundIndex}:${state.history.length}`, actor: finalOutcome.penaltyTarget, amount: finalOutcome.bulletsAdded, reason: finalOutcome.reason };
  const loaded = runAbilityEvent(next, { trigger: "before-bullet-load", sourceEventId: pendingLoad.id, eventActor: finalOutcome.penaltyTarget, roundOutcome: finalOutcome }, { load: pendingLoad });
  const finalPending = loaded.pendingLoad ?? pendingLoad;
  const gun = addBullets(loaded.state.roulette[finalPending.actor], finalPending.amount);
  next = commitAbilityWorld(loaded.state, { ...abilityWorld(loaded.state), guns: { ...loaded.state.roulette, [finalPending.actor]: gun } });
  next = append(next, { type: "ROUND_RESOLVED", outcome: { ...finalOutcome, bulletsAdded: finalPending.amount } }, { type: "BULLET_ADDED", actor: finalPending.actor, amount: finalPending.amount, actualAmount: gun.bullets - loaded.state.roulette[finalPending.actor].bullets });
  const afterLoad = runAbilityEvent(next, { trigger: "after-bullet-load", sourceEventId: `after:${finalPending.id}`, eventActor: finalPending.actor, roundOutcome: finalOutcome }, {}).state;
  return withRound(afterLoad, { ...afterLoad.round, phase: "round-reveal", currentActor: null, outcome: { ...finalOutcome, bulletsAdded: finalPending.amount } });
}

/** The only action-completion boundary: busts never end a turn or a round. */
function continueTurns(state: MatchState, preferredActor: Actor): MatchState {
  const next = normalizeAbilityHands(state);
  if (next.round.phase !== "turns") return next;
  if (next.player.stood && next.opponent.stood) {
    const blackjack = naturalBlackjackOutcome(next);
    if (blackjack) return resolveRound(next, blackjack);
    if (next.player.busted && next.opponent.busted) return resolveRound(next, { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 });
    const loser = next.player.busted ? "player" : next.opponent.busted ? "opponent" : null;
    if (loser) return resolveRound(next, { winner: loser === "player" ? "opponent" : "player", reason: "bust", penaltyTarget: loser, bulletsAdded: 1 });
    return resolveComparison(next);
  }
  const actor = canReceiveTurn(next, preferredActor) ? preferredActor : preferredActor === "player" ? "opponent" : "player";
  return beginTurn(next, actor);
}

function canTakeAction(state: MatchState, actor: Actor, action: "hit" | "stand"): boolean {
  const available = state.status === "active" && state.scene === "match" && !state.playerSkills.drawOffer
    && state.round.phase === "turns" && state.round.currentActor === actor && canReceiveTurn(state, actor)
    && (action !== "hit" || (!state[actor].stood && shoeRemaining(state.shoe) > 0))
    && !isActionBlockedByStatus(abilityWorld(state), actor, action);
  if (!available) return false;
  if (action === "hit" && actor === "player") {
    const limit = getActiveBustLimit(state, actor);
    return handValueAtLimit(state.player.hand, limit) <= 3 * limit;
  }
  return true;
}

function drawFor(state: MatchState, actor: Actor): MatchState {
  if (!canTakeAction(state, actor, "hit")) return state;
  const beforeDraw = abilityWorld(state);
  const base = drawCard(state.shoe);
  const pending: PendingDraw = { id: `draw:${state.roundIndex}:${state.history.length}`, actor, card: base.card };
  const prepared = runAbilityEvent(state, { trigger: "before-card-draw", sourceEventId: pending.id, eventActor: actor }, { draw: pending });
  if (prepared.pendingDraw?.cancelled) {
    const actors = changedHandActors(beforeDraw, abilityWorld(prepared.state));
    const changed = normalizeAbilityHands(broadcastHandChanges(broadcastDrawPileChange(prepared.state, beforeDraw, `cancelled-pile:${pending.id}`), actors, `cancelled-hand:${pending.id}`));
    return continueTurns(expireOwnerActionLifecycle(changed, actor), actor === "player" ? "opponent" : "player");
  }
  const replacement = prepared.pendingDraw?.replacement;
  const card = replacement ?? base.card;
  const shoe = replacement ? prepared.state.shoe : base.shoe;
  let next = commitAbilityWorld(prepared.state, { ...abilityWorld(prepared.state), shoe });
  const current = next[actor];
  const updated = { ...current, hand: addCard(current.hand, card), bustLimit: undefined };
  next = withRound(next, { ...next.round, [actor]: updated } as RoundState);
  next = invalidateBustLimits(next, [actor]);
  next = append(next, { type: actor === "player" ? "PLAYER_HIT" : "OPPONENT_HIT", value: handValue(updated.hand) }, { type: "CARD_DEALT", actor, card, private: true });
  const beforeAfterDraw = abilityWorld(next);
  const acquired = runAbilityEvent(next, { trigger: "after-card-acquired", sourceEventId: `acquired:${pending.id}`, eventActor: actor, acquiredCards: [card] }, {}).state;
  const afterDraw = runAbilityEvent(acquired, { trigger: "after-card-draw", sourceEventId: `after:${pending.id}`, eventActor: actor }, {}).state;
  const changedActors = [...new Set<Actor>([actor, ...changedHandActors(beforeAfterDraw, abilityWorld(afterDraw))])];
  const withDrawPileNotice = broadcastDrawPileChange(afterDraw, beforeDraw, `draw-pile:${pending.id}`);
  let changed = expireOwnerActionLifecycle(normalizeAbilityHands(broadcastHandChanges(withDrawPileNotice, changedActors, `hand:${pending.id}`)), actor);
  if (changed.round.phase !== "turns") return changed;
  if (changed[actor].stood) return continueTurns(changed, actor === "player" ? "opponent" : "player");
  const other = actor === "player" ? "opponent" : "player";
  // This completion window historically ran only for a non-busting Hit.
  // Preserve that contract while allowing busted hands to take later turns.
  if (changed[actor].busted) return continueTurns(changed, other);
  const beforeResolvedHit = abilityWorld(changed);
  const resolvedHit = runAbilityEvent(changed, { trigger: "after-hit-resolved", sourceEventId: `resolved:${pending.id}`, eventActor: actor }, { draw: { ...pending, card } });
  changed = resolvedHit.state;
  const postHitChanges = changedHandActors(beforeResolvedHit, abilityWorld(changed));
  changed = normalizeAbilityHands(broadcastHandChanges(broadcastDrawPileChange(changed, beforeResolvedHit, `resolved-pile:${pending.id}`), postHitChanges, `resolved-hand:${pending.id}`));
  if (changed.round.phase !== "turns") return changed;
  if (resolvedHit.pendingDraw?.standAfterDraw) {
    changed = append(withRound(changed, { ...changed.round, [actor]: { ...changed[actor], stood: true } } as RoundState), { type: actor === "player" ? "PLAYER_STOOD" : "OPPONENT_STOOD" });
  }
  return continueTurns(changed, other);
}

function standFor(state: MatchState, actor: Actor): MatchState {
  if (!canTakeAction(state, actor, "stand")) return state;
  state = normalizeAbilityHands(state);
  if (state[actor].stood) return continueTurns(expireOwnerActionLifecycle(state, actor), actor === "player" ? "opponent" : "player");
  let next = append(withRound(state, { ...state.round, [actor]: { ...state[actor], stood: true } } as RoundState), { type: actor === "player" ? "PLAYER_STOOD" : "OPPONENT_STOOD" });
  next = runAbilityEvent(next, { trigger: "after-stand", sourceEventId: `stand:${state.roundIndex}:${state.history.length}`, eventActor: actor, roundHitCounts: getRoundHitCounts(next) }, {}).state;
  next = expireOwnerActionLifecycle(next, actor);
  const other = actor === "player" ? "opponent" : "player";
  return continueTurns(next, other);
}

function activeSkillDrawDefinitions(state: MatchState) {
  return state.abilities.instances
    .filter((instance) => !isAbilityInstanceExpired(instance))
    .map((instance) => getAbilityDefinition(instance.definitionId, undefined, instance.level))
    .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition));
}

function canOpenSkillDraw(state: MatchState): boolean {
  if (state.playerSkills.drawOffer || state.playerSkills.drawCount <= 0 || state.playerSkills.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY) return false;
  const modifiers = collectSkillDrawWeightModifiers(activeSkillDrawDefinitions(state));
  return canGenerateSkillDraw(
    state.playerSkills.deckDefinitionIds ?? state.playerSkills.unlockedDefinitionIds,
    state.playerSkills.cards.map((card) => card.definitionId),
    modifiers,
    state.playerSkills.selectedSkillTags,
    state.playerSkills.acquisitionCounts
  );
}

function openSkillDraw(state: MatchState): MatchState {
  if (state.round.phase !== "turns" || state.round.currentActor !== "player" || !canReceiveTurn(state, "player") || !canOpenSkillDraw(state)) return state;
  const modifiers = collectSkillDrawWeightModifiers(activeSkillDrawDefinitions(state));
  const rng = SeededRng.fromSnapshot(state.rng.loot);
  const result = generateSkillDrawOffer(
    rng, state.playerSkills.deckDefinitionIds ?? state.playerSkills.unlockedDefinitionIds,
    state.playerSkills.cards.map((card) => card.definitionId), modifiers,
    `skill-draw-${state.roundIndex}-${state.history.length}`,
    state.playerSkills.selectedSkillTags, undefined, state.playerSkills.acquisitionCounts
  );
  if (result.offer.candidateDefinitionIds.length === 0) return state;
  return append({
    ...state,
    playerSkills: playerSkillState(state, { drawOffer: { ...result.offer, refreshesRemaining: state.playerSkills.refreshesPerDraw } }),
    rng: { ...state.rng, loot: result.rng }
  }, { type: "SKILL_DRAW_OPENED", offerId: result.offer.id, candidateDefinitionIds: result.offer.candidateDefinitionIds });
}

function canRefreshSkillDraw(state: MatchState): boolean {
  return state.status === "active" && state.scene === "match" && state.round.phase === "turns"
    && state.round.currentActor === "player" && canReceiveTurn(state, "player")
    && Boolean(state.playerSkills.drawOffer && state.playerSkills.drawOffer.refreshesRemaining > 0)
    && state.playerSkills.drawCount > 0 && state.playerSkills.cards.length < PLAYER_SKILL_INVENTORY_CAPACITY
    && canGenerateSkillDraw(state.playerSkills.deckDefinitionIds ?? state.playerSkills.unlockedDefinitionIds,
      state.playerSkills.cards.map(card => card.definitionId), collectSkillDrawWeightModifiers(activeSkillDrawDefinitions(state)),
      state.playerSkills.selectedSkillTags, state.playerSkills.acquisitionCounts);
}

function refreshSkillDraw(state: MatchState): MatchState {
  if (!canRefreshSkillDraw(state)) return state;
  const offer = state.playerSkills.drawOffer!;
  const result = generateSkillDrawOffer(SeededRng.fromSnapshot(state.rng.loot),
    state.playerSkills.deckDefinitionIds ?? state.playerSkills.unlockedDefinitionIds,
    state.playerSkills.cards.map(card => card.definitionId), collectSkillDrawWeightModifiers(activeSkillDrawDefinitions(state)),
    offer.id, state.playerSkills.selectedSkillTags, undefined, state.playerSkills.acquisitionCounts);
  if (!result.offer.candidateDefinitionIds.length) return state;
  const refreshed = { ...result.offer, refreshesRemaining: offer.refreshesRemaining - 1 };
  return append({ ...state, playerSkills: playerSkillState(state, { drawOffer: refreshed }), rng: { ...state.rng, loot: result.rng } },
    { type: "SKILL_DRAW_REFRESHED", offerId: offer.id, candidateDefinitionIds: refreshed.candidateDefinitionIds, refreshesRemaining: refreshed.refreshesRemaining });
}

function startNextRound(state: MatchState): MatchState {
  const previousOutcome = state.round.outcome;
  let next = runAbilityEvent(state, { trigger: "on-round-end", sourceEventId: `round-end:${state.roundIndex}`, roundOutcome: previousOutcome ?? undefined }, {}).state;
  const ttl = advanceRoundAbilityTtls(next.abilities, next.playerSkills.cards);
  next = append({ ...next, abilities: ttl.runtime, playerSkills: playerSkillState(next, { cards: ttl.cards }) },
    ...ttl.expiredStatuses.map((status) => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "expired" as const })),
    ...ttl.expired.map((instance) => ({ type: "ABILITY_EXPIRED" as const, ...((instance.level ?? 1) > 1 ? { level: instance.level } : {}), instanceId: instance.instanceId, definitionId: instance.definitionId, owner: instance.owner, reason: "rounds" as const })));
  const runtime = garbageCollectAbilityInstances(expireStatuses(expireStatuses(clearCounters(next.abilities, "round"), "round"), "until-owner-action"), next.playerSkills.cards);
  const expired = next.abilities.statuses.filter((status) => !runtime.statuses.includes(status)).map((status) => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "expired" as const }));
  const index = state.roundIndex + 1;
  const player = participant("player", []);
  const opponent = participant("opponent", []);
  const round: RoundState = { index, phase: "dealing", starter: getRoundStarter(index), currentActor: null, player, opponent, outcome: null };
  const ai = SeededRng.fromSnapshot(next.rng.ai);
  const playNoise = sampleAiNoise(ai);
  next = withRound({
    ...next, previousRoundPointAdvantages: previousOutcome?.pointAdvantages ?? { player: 0, opponent: 0 }, abilities: runtime, playerSkills: playerSkillState(next, { drawOffer: null }),
    rng: { ...next.rng, ai: ai.snapshot() }, aiNoise: { ...next.aiNoise, play: playNoise }
  }, round);
  return dealCurrentRound(append(next, ...expired));
}

function dealCurrentRound(state: MatchState, grantOpening = true, runPlayerOpening = grantOpening): MatchState {
  state = runAbilityEvent(state, { trigger: "before-round-deal", sourceEventId: `before-round-deal:${state.roundIndex}` }, {}).state;
  const beforeDeal = abilityWorld(state);
  const deck = SeededRng.fromSnapshot(state.rng.deck);
  const dealt = makeRound(state.roundIndex, state.shoe, deck);
  const round: RoundState = {
    index: state.roundIndex, phase: "initial-blackjack-check", starter: dealt.starter, currentActor: null,
    player: dealt.player, opponent: dealt.opponent, outcome: null
  };
  let next = withRound({ ...state, shoe: dealt.shoe, rng: { ...state.rng, deck: dealt.deckRng.snapshot() } }, round);
  if (state.roundIndex === 0) {
    next = runAbilityEvent(next, { trigger: "on-match-created", sourceEventId: `match-created:${state.id}` }, runPlayerOpening ? {} : { owners: ["opponent"] }).state;
    if (grantOpening) next = grantOpeningSkillCards(next);
  }
  for (const actor of ["player", "opponent"] as const) {
    for (const card of dealt[actor].hand.cards) {
      next = runAbilityEvent(next, { trigger: "after-card-acquired", sourceEventId: `initial-acquired:${state.roundIndex}:${actor}:${card.id}`, eventActor: actor, acquiredCards: [card] }, {}).state;
    }
  }
  next = append(next, ...dealt.events);
  next = runAbilityEvent(next, { trigger: "on-round-start", sourceEventId: `round-start:${state.roundIndex}` }, {}).state;
  next = broadcastDrawPileChange(next, beforeDeal, `draw-pile:deal:${state.roundIndex}`, true);
  return beginInitialTurn(broadcastHandChanges(next, ["player", "opponent"], `initial-hand:${state.roundIndex}`));
}
function beginInitialTurn(state: MatchState): MatchState {
  // Opening Blackjack and bust hands both remain playable until Stand.
  return continueTurns(setPhase(state, "turns", state.round.starter), state.round.starter);
}

function triggerFor(state: MatchState, actor: Actor): MatchState {
  const pending: PendingTrigger = { id: `trigger:${state.roundIndex}:${state.history.length}`, actor };
  const prepared = runAbilityEvent(state, { trigger: "before-trigger-pull", sourceEventId: pending.id, eventActor: actor, roundHitCounts: getRoundHitCounts(state), roundOutcome: state.round.outcome ?? undefined }, { trigger: pending });
  if (prepared.pendingTrigger?.cancelled) return startNextRound(prepared.state);
  const trigger = pullTrigger(prepared.state.roulette[actor], SeededRng.fromSnapshot(prepared.state.rng.roulette), prepared.pendingTrigger?.misfireChance ?? 0);
  let next = append(withRound({ ...prepared.state, rng: { ...prepared.state.rng, roulette: trigger.rng } }, { ...prepared.state.round, phase: "roulette-result", currentActor: null }), {
    type: "TRIGGER_PULLED", actor, probability: trigger.result.probability, baseProbability: trigger.result.baseProbability,
    misfireChance: trigger.result.misfireChance, result: trigger.result.result, fired: trigger.result.fired
  });
  const resultContext = { eventActor: actor, roundHitCounts: getRoundHitCounts(state), triggerResult: { actor, result: trigger.result.result, fired: trigger.result.fired }, roundOutcome: state.round.outcome ?? undefined };
  next = runAbilityEvent(next, { trigger: "after-trigger-result", sourceEventId: `after:${pending.id}`, ...resultContext }).state;
  if (!trigger.result.fired) return append(next, { type: "TRIGGER_SURVIVED", actor });
  const defeat: PendingDefeat = { id: `defeat:${pending.id}`, actor };
  const resolved = runAbilityEvent(next, { trigger: "before-defeat", sourceEventId: defeat.id, ...resultContext }, { defeat });
  next = resolved.state;
  if (resolved.pendingDefeat?.prevented) {
    next = append(next, { type: "DEFEAT_PREVENTED", actor, sourceInstanceId: resolved.pendingDefeat.preventSourceInstanceId! });
    return runAbilityEvent(next, { trigger: "after-defeat-prevented", sourceEventId: `after:${defeat.id}`, ...resultContext }, { defeat: resolved.pendingDefeat }).state;
  }
  const winner: Actor = actor === "player" ? "opponent" : "player"; const reason = actor === "player" ? "player-killed" : "opponent-killed"; const outcome: MatchOutcome = { winner, reason };
  next = runAbilityEvent(next, { trigger: "on-round-end", sourceEventId: `round-end:${state.roundIndex}:match-finished`, roundOutcome: state.round.outcome ?? undefined }, {}).state;
  next = expireAllStatuses(next);
  return append({ ...next, status: "finished", abilities: { ...next.abilities, displays: [] }, view: "table", scene: "match", outcome }, { type: "PARTICIPANT_KILLED", actor }, { type: "MATCH_FINISHED", reason });
}

export function normalizeAbilityHands(state: MatchState): MatchState {
  if (state.round.phase !== "turns") return state;
  let next = state;
  // Bound rescue/broadcast chains independently of content. Bust flags describe
  // the current hand; settling and choosing the next actor belong to continueTurns.
  const failedRescues = new Set<Actor>();
  for (let pass = 0; pass <= MAX_BUST_RESCUE_PASSES; pass += 1) {
    const busts: Actor[] = [];
    let restart = false;
    for (const actor of ["player", "opponent"] as const) {
      const activeLimit = getActiveBustLimit(next, actor);
      // Status-only abilities can change the limit without changing a hand.
      if (next[actor].bustLimit !== undefined && next[actor].bustLimit !== activeLimit) {
        next = withRound(next, { ...next.round, [actor]: { ...next[actor], bustLimit: undefined } } as RoundState);
      }
      const needsCheck = next[actor].bustLimit === undefined;
      if (!isBust(next[actor].hand) && handValueAtLimit(next[actor].hand, activeLimit) <= activeLimit && !next[actor].busted && next[actor].bustLimit === undefined) continue;
      if (next[actor].bustLimit === undefined) {
        const pendingBust: PendingBustCheck = { id: `bust:${next.roundIndex}:${next.history.length}:${actor}`, actor, limit: 21 };
        const checked = runAbilityEvent(next, { trigger: "before-bust-check", sourceEventId: pendingBust.id, eventActor: actor, roundHitCounts: getRoundHitCounts(next) }, { bust: pendingBust });
        next = checked.state;
        const limit = checked.pendingBust?.limit ?? 21;
        const stood = !next[actor].stood && handValueAtLimit(next[actor].hand, limit) <= limit && Boolean(checked.pendingBust?.standAfterReplacement);
        next = withRound(next, { ...next.round, [actor]: { ...next[actor], bustLimit: limit, ...(stood ? { stood: true } : {}) } } as RoundState);
        if (stood) next = append(next, { type: actor === "player" ? "PLAYER_STOOD" : "OPPONENT_STOOD" });
      }
      const limit = next[actor].bustLimit ?? 21;
      if (handValueAtLimit(next[actor].hand, limit) <= limit) continue;
      if (pass < MAX_BUST_RESCUE_PASSES && (needsCheck || !next[actor].busted) && !failedRescues.has(actor)) {
        const before = abilityWorld(next);
        const pendingBust: PendingBustCheck = { id: `bust-resolution:${next.roundIndex}:${next.history.length}:${actor}`, actor, limit };
        const rescued = runAbilityEvent(next, { trigger: "before-bust-resolution", sourceEventId: pendingBust.id, eventActor: actor, roundHitCounts: getRoundHitCounts(next) }, { bust: pendingBust });
        next = rescued.state;
        if (rescued.failed) failedRescues.add(actor);
        const changed = changedHandActors(before, abilityWorld(next));
        if (changed.length > 0) {
          next = invalidateBustLimits(next, changed);
          next = broadcastHandChanges(broadcastDrawPileChange(next, before, `draw-pile:${pendingBust.id}`), changed, `hand:${pendingBust.id}`);
          restart = true;
          break;
        }
        const rescuedLimit = rescued.pendingBust?.limit ?? limit;
        next = withRound(next, { ...next.round, [actor]: { ...next[actor], bustLimit: rescuedLimit } } as RoundState);
        if (handValueAtLimit(next[actor].hand, rescuedLimit) <= rescuedLimit) continue;
      }
      busts.push(actor);
    }
    if (restart) continue;
    for (const actor of ["player", "opponent"] as const) {
      const busted = busts.includes(actor);
      if (next[actor].busted === busted) continue;
      next = withRound(next, { ...next.round, [actor]: { ...next[actor], busted } } as RoundState);
      if (busted) next = append(next, { type: "BUST", actor });
    }
    return next;
  }
  return next;
}

/** Resolves the limit that would apply to an actor's next bust check without
 * committing ability events, counters, TTL or RNG changes to match state. */
export function getActiveBustLimit(state: MatchState, actor: Actor): number {
  const pendingBust: PendingBustCheck = { id: `bust-preview:${state.roundIndex}:${actor}`, actor, limit: 21 };
  const preview = runAbilityEvent(state, {
    trigger: "before-bust-check",
    sourceEventId: pendingBust.id,
    eventActor: actor,
    roundHitCounts: getRoundHitCounts(state)
  }, { bust: pendingBust });
  return preview.pendingBust?.limit ?? 21;
}

function play(state: MatchState, instanceId: string): MatchState {
  if (state.playerSkills.drawOffer) return state;
  const instance = state.abilities.instances.find((candidate) => candidate.instanceId === instanceId); if (!instance) return state;
  if (state.round.phase === "roulette-reaction" && state.round.outcome?.penaltyTarget !== instance.owner) return state;
  const window = state.round.phase === "roulette-reaction" ? "owner-roulette-reaction" : state.round.phase === "turns" && state.round.currentActor === instance.owner && canReceiveTurn(state, instance.owner) ? "owner-turn" : null;
  if (!window) return state;
  const input: Parameters<typeof canPlayAbility>[0] = { world: abilityWorld(state), runtime: state.abilities, instanceId, owner: instance.owner, window, pendingTurn: activePendingTurn(state), ...abilityServices(state) };
  if (!canPlayAbility(input)) return state;
  try {
    const result = playAbility(input);
    if (result.triggered.length === 0) return { ...state, abilities: result.runtime };
    const handChanges = changedHandActors(input.world, result.world);
    let next = commitAbilityWorld(state, result.world);
    next = invalidateBustLimits(next, handChanges);
    next = { ...next, abilities: clearEventCounters({ ...result.runtime, statuses: result.world.statuses }, `ability:${instanceId}`) };
    next = { ...next, abilities: garbageCollectAbilityInstances(next.abilities, next.playerSkills.cards) };
    next = append(next, ...result.events as GameEvent[]);
    // Broadcast only after the direct ability has successfully resolved so
    // observers (for example Copper Seal) cannot block the first card.
    next = runAbilityEvent(next, { trigger: "after-ability-played", sourceEventId: `after-ability:${instanceId}:${state.history.length}`, eventActor: instance.owner, playedAbilityKind: instance.kind }, {}).state;
    next = broadcastDrawPileChange(next, input.world, `draw-pile:ability:${instanceId}:${state.history.length}`);
    if (handChanges.length > 0) next = broadcastHandChanges(next, handChanges, `ability-hand:${instanceId}:${state.history.length}`);
    if (next.round.phase === "turns") {
      next = normalizeAbilityHands(next);
      if (next.round.phase !== "turns") return next;
      if (result.pendingTurn?.skipped && result.pendingTurn.skipSourceInstanceId) {
        next = append(next, { type: "TURN_SKIPPED", actor: instance.owner, sourceInstanceId: result.pendingTurn.skipSourceInstanceId });
        return beginTurn(next, instance.owner === "player" ? "opponent" : "player", [instance.owner]);
      }
      if ((next.player.stood && next.opponent.stood)
        || (next[instance.owner].stood && (!state[instance.owner].stood || !canReceiveTurn(next, instance.owner)))) return continueTurns(next, instance.owner === "player" ? "opponent" : "player");
    }
    return next;
  } catch { return state; }
}

function grantSkillCards(state: MatchState, definitionIds: readonly string[]): MatchState {
  if (definitionIds.length === 0) return state;
  if (new Set(definitionIds).size !== definitionIds.length) return state;
  if (state.playerSkills.cards.length + definitionIds.length > PLAYER_SKILL_INVENTORY_CAPACITY) return state;
  let runtime = state.abilities;
  const cards: SkillCardInstance[] = [];
  let acquisitionCounts = state.playerSkills.acquisitionCounts;
  for (const definitionId of definitionIds) {
    const definition = getPlayerSkillDefinition(definitionId);
    if (!definition) return state;
    const heldIds = [...state.playerSkills.cards, ...cards].map(card => card.definitionId);
    if (!canAcquirePlayerSkill(definition, acquisitionCounts, heldIds)) return state;
    if (definition.category === "passive" && !definition.stackable && [...state.playerSkills.cards, ...cards].some((card) => card.definitionId === definitionId)) return state;
    acquisitionCounts = recordPlayerSkillAcquisition(definition, acquisitionCounts, heldIds);
    const sequence = runtime.sequence + 1;
    const instanceId = `ability-player-card-${sequence}`;
    const instance = instantiateAbility(
      validateAbilityBinding({ definitionId, enabled: true, parameters: {} }),
      "player", instanceId, sequence, undefined, "player-skill"
    );
    runtime = addAbilityInstance(runtime, instance);
    cards.push({ kind: "player-skill", definitionId, level: instance.level ?? 1, owner: "player", instanceId });
  }
  return append({
    ...state,
    playerSkills: playerSkillState(state, { cards: [...state.playerSkills.cards, ...cards], acquisitionCounts }),
    abilities: runtime
  }, ...cards.map((card) => ({ type: "SKILL_GAINED" as const, skillId: card.definitionId })));
}

function grantAndResolveSkillCard(state: MatchState, definitionId: string): MatchState {
  let next = grantSkillCards(state, [definitionId]);
  if (next === state) return state;
  const gained = next.playerSkills.cards.find(card => !state.playerSkills.cards.some(old => old.instanceId === card.instanceId));
  if (gained) next = runAbilityEvent(next, { trigger: "on-ability-gained", sourceEventId: `ability-gained:${gained.instanceId}:${state.history.length}`, eventActor: gained.owner }, {}, gained.instanceId).state;
  return next;
}

function grantOpeningSkillCards(state: MatchState): MatchState {
  let next = state;
  const count = state.playerSkills.openingCardCount;
  for (let index = 0; index < count && next.playerSkills.cards.length < PLAYER_SKILL_INVENTORY_CAPACITY; index += 1) {
    const result = generateSkillDrawOffer(SeededRng.fromSnapshot(next.rng.loot),
      next.playerSkills.deckDefinitionIds ?? next.playerSkills.unlockedDefinitionIds,
      next.playerSkills.cards.map(card => card.definitionId), collectSkillDrawWeightModifiers(activeSkillDrawDefinitions(next)),
      `opening-${index}`, next.playerSkills.selectedSkillTags, 1, next.playerSkills.acquisitionCounts);
    const id = result.offer.candidateDefinitionIds[0];
    if (!id) break;
    const granted = grantAndResolveSkillCard(next, id);
    if (granted === next) break;
    next = { ...granted, rng: { ...granted.rng, loot: result.rng } };
  }
  return next;
}

function selectSkillDraw(state: MatchState, definitionId: string): MatchState {
  const offer = state.playerSkills.drawOffer;
  if (!offer || !offer.candidateDefinitionIds.includes(definitionId)) return state;
  if (state.playerSkills.drawCount <= 0 || state.playerSkills.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY) return state;
  const next = grantAndResolveSkillCard(state, definitionId);
  if (next === state) return state;
  return append({
    ...next,
    playerSkills: playerSkillState(next, { drawCount: next.playerSkills.drawCount - 1, drawOffer: null })
  }, { type: "SKILL_DRAW_RESOLVED", offerId: offer.id, selectedDefinitionId: definitionId });
}

function initializePlayerSkillCards(state: MatchState, bindings: readonly AbilityBinding[]): MatchState {
  let next = state;
  for (const binding of bindings) {
    const valid = validateAbilityBinding(binding);
    if (!valid.enabled) continue;
    const definition = getPlayerSkillDefinition(valid.definitionId, valid.level);
    const heldIds = next.playerSkills.cards.map(card => card.definitionId);
    if (!definition || next.playerSkills.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY
      || !canAcquirePlayerSkill(definition, next.playerSkills.acquisitionCounts, heldIds)
      || (!definition.stackable && heldIds.includes(definition.id))) throw new RangeError(`Invalid initial Player Skill: ${valid.definitionId}`);
    const sequence = next.abilities.sequence + 1;
    const instanceId = `ability-player-card-${sequence}`;
    const instance = instantiateAbility(valid, "player", instanceId, sequence, undefined, "player-skill");
    const card: SkillCardInstance = { kind: "player-skill", owner: "player", definitionId: valid.definitionId, level: valid.level ?? 1, instanceId };
    next = append({ ...next, abilities: addAbilityInstance(next.abilities, instance), playerSkills: {
      ...next.playerSkills, cards: [...next.playerSkills.cards, card],
      acquisitionCounts: recordPlayerSkillAcquisition(definition, next.playerSkills.acquisitionCounts, heldIds)
    } }, { type: "SKILL_GAINED", skillId: valid.definitionId });
  }
  return next;
}

export function createMatch(seed: string, options: CreateMatchOptions = {}): MatchState {
  for (const value of [options.initialSkillDraws, options.openingSkillCards])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("Invalid initial skill resource count");
  if (options.playerCarryover && options.initialPlayerSkills) throw new RangeError("Cannot replace and inherit Player Skills together");
  if (options.comparisonBonuses && Object.values(options.comparisonBonuses).some(value => !Number.isSafeInteger(value))) throw new RangeError("Comparison bonuses must be safe integers");
  for (const gun of [options.playerGun, options.opponentGun])
    if (gun && (!Number.isSafeInteger(gun.capacity) || gun.capacity <= 0 || !Number.isSafeInteger(gun.bullets) || gun.bullets < 0 || gun.bullets > gun.capacity)) throw new RangeError("Invalid encounter gun");
  const root = deriveRng(seed, "root"); const deck = root.derive("deck"); const roulette = root.derive("roulette"); const ai = root.derive("ai"); const loot = root.derive("loot"); const dialogue = root.derive("dialogue"); const ability = root.derive("ability"); const shoe = createShoe(deck); const unlocked = normalizeUnlocked(options.unlockedPlayerSkillIds); const aiNoise = { match: sampleAiNoise(ai), play: sampleAiNoise(ai) };
  let runtime = createAbilityRuntime(ability.snapshot());
  let instanceSerial = 0;
  const talentIds = [...new Set(options.talentIds ?? [])];
  const deckDefinitionIds = options.skillDeckIds === undefined ? undefined : [...options.skillDeckIds];
  if (deckDefinitionIds && (new Set(deckDefinitionIds).size !== deckDefinitionIds.length || deckDefinitionIds.some((id) => !unlocked.includes(id) || !getPlayerSkillDefinition(id)?.drop.enabled || !(getPlayerSkillDefinition(id)!.drop.baseWeight > 0)))) throw new RangeError("Skill deck must contain unique unlocked droppable skills");
  const selectedSkillTags = deckDefinitionIds === undefined ? normalizeSelectedSkillTags(options.selectedSkillTags) : [];
  for (const id of talentIds) {
    const definition = getAbilityDefinition(id);
    if (!definition || !supportsAbilitySourceKind(definition, "talent")) throw new RangeError(`Unknown Talent definition: ${id}`);
    runtime = addAbilityInstance(runtime, instantiateAbility(validateAbilityBinding({ definitionId: id, enabled: true, parameters: {} }), "player", `ability-talent-${id}`, ++instanceSerial, undefined, "talent"));
  }
  for (const [owner, bindings] of [["player", options.playerAiSkills ?? []], ["opponent", options.opponentAiSkills ?? []]] as const) {
    for (const binding of bindings) {
      const valid = validateAbilityBinding(binding);
      const definition = getAbilityDefinition(valid.definitionId, undefined, valid.level);
      if (!definition || !supportsAbilitySourceKind(definition, "ai-skill")) throw new RangeError(`AI Skill binding must reference an AI Skill definition: ${valid.definitionId}`);
      if (valid.enabled) runtime = addAbilityInstance(runtime, instantiateAbility(valid, owner, `ability-${owner}-${valid.definitionId}-${++instanceSerial}`, instanceSerial, undefined, "ai-skill"));
    }
  }
  const player = participant("player", []);
  const opponent = participant("opponent", []);
  const base: MatchState = { ...(options.comparisonBonuses ? { comparisonBonuses: { ...options.comparisonBonuses } } : {}), id: options.id ?? `match-${seed}`, seed, opponentId: options.opponentId ?? "opponent", autoSkipAfterStand: options.autoSkipAfterStand ?? true, status: "active", scene: "match", view: "table", roundIndex: 0, player, opponent, shoe, roulette: { player: options.playerGun ? { ...options.playerGun } : createGun(), opponent: options.opponentGun ? { ...options.opponentGun } : createGun() }, playerSkills: { unlockedDefinitionIds: unlocked, ...(deckDefinitionIds === undefined ? {} : { deckDefinitionIds }), selectedSkillTags, cards: [], drawCount: 0, openingCardCount: 3, refreshesPerDraw: 0, drawOffer: null }, talentIds, abilities: runtime, round: { index: 0, phase: "dealing", starter: getRoundStarter(0), currentActor: null, player, opponent, outcome: null }, history: [], rng: { deck: deck.snapshot(), roulette: roulette.snapshot(), ai: ai.snapshot(), loot: loot.snapshot(), dialogue: dialogue.snapshot() }, aiProfile: options.aiProfile ?? DEFAULT_AI_PROFILE, aiNoise, lastAiDecision: null };
  let prepared = options.playerCarryover ? carryPlayerSkills(base, options.playerCarryover) : base;
  prepared = { ...prepared, playerSkills: { ...prepared.playerSkills,
    ...(options.initialSkillDraws === undefined ? {} : { drawCount: options.initialSkillDraws }),
    ...(options.openingSkillCards === undefined ? {} : { openingCardCount: options.openingSkillCards }) } };
  if (options.initialPlayerSkills) prepared = initializePlayerSkillCards(prepared, options.initialPlayerSkills);
  return dealCurrentRound(reconcileIntrinsicAbilities(prepared, options.intrinsicAbilities ?? []), options.grantOpeningSkills ?? !options.playerCarryover, !options.playerCarryover);
}

/** Reconcile optional automatic abilities before resuming a saved match. */
export function reconcileMatchAbilities(state: MatchState, bindings: readonly AbilityBinding[]): MatchState {
  const next = reconcileIntrinsicAbilities(state, state.status === "active" ? bindings : []);
  return next !== state && next.status === "active" && next.round.phase === "turns"
    ? normalizeAbilityHands(next) : next;
}

export function getLegalActions(state: MatchState): Action[] {
  if (state.scene !== "match") return []; if (state.status === "finished") return state.view === "table" && state.round.phase === "roulette-result" ? [{ type: "ACK_TRIGGER_RESULT" }] : state.view === "match-summary" ? [{ type: "ACK_MATCH_RESULT" }] : [];
  const actions: Action[] = [{ type: "ESCAPE_MATCH" }];
  if (state.playerSkills.drawOffer) {
    if (canRefreshSkillDraw(state)) actions.push({ type: "REFRESH_SKILL_DRAW" });
    for (const definitionId of state.playerSkills.drawOffer.candidateDefinitionIds) {
      const definition = getPlayerSkillDefinition(definitionId);
      if (definition && canAcquirePlayerSkill(definition, state.playerSkills.acquisitionCounts, state.playerSkills.cards.map(card => card.definitionId))) actions.push({ type: "SELECT_SKILL_DRAW", definitionId });
    }
    return actions;
  }
  if (state.round.phase === "turns" && state.round.currentActor === "player" && canReceiveTurn(state, "player")) {
    if (canTakeAction(state, "player", "hit")) actions.push({ type: "PLAYER_HIT" });
    if (canTakeAction(state, "player", "stand")) actions.push({ type: "PLAYER_STAND" });
    if (canOpenSkillDraw(state)) actions.push({ type: "OPEN_SKILL_DRAW" });
  }
  if (canTakeAction(state, "opponent", "hit") || canTakeAction(state, "opponent", "stand")) actions.push({ type: "AI_TURN" }); if (state.round.phase === "round-reveal") actions.push({ type: "ACK_ROUND_RESULT" }); if (state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger") actions.push({ type: "TRIGGER_ROULETTE" }); if (state.round.phase === "roulette-result") actions.push({ type: "ACK_TRIGGER_RESULT" });
  const window: "owner-turn" | "owner-roulette-reaction" | null = state.round.phase === "roulette-reaction" ? "owner-roulette-reaction" : state.round.phase === "turns" && state.round.currentActor !== null && canReceiveTurn(state, state.round.currentActor) ? "owner-turn" : null;
  if (window) for (const instance of state.abilities.instances) { const definition = getAbilityDefinition(instance.definitionId, undefined, instance.level); const expectedOwner = window === "owner-roulette-reaction" ? state.round.outcome?.penaltyTarget : state.round.currentActor; if (definition?.activation.type === "action" && instance.owner === expectedOwner && (definition.activation.consume === "none" || state.playerSkills.cards.some((card) => card.instanceId === instance.instanceId)) && canPlayAbility({ world: abilityWorld(state), runtime: state.abilities, instanceId: instance.instanceId, owner: instance.owner, window, pendingTurn: activePendingTurn(state), ...abilityServices(state) })) actions.push({ type: "PLAY_ABILITY", instanceId: instance.instanceId }); }
  return actions;
}

export function gameReducer(state: MatchState, action: Action): MatchState {
  if (action.type === "CONFIGURE_INTRINSIC_ABILITY" || action.type === "INVOKE_INTRINSIC_ABILITY") {
    if (state.status !== "active" || state.scene !== "match" || state.view !== "table") return state;
    let next: MatchState;
    if (action.type === "CONFIGURE_INTRINSIC_ABILITY") next = configureIntrinsicAbility(state, action.binding);
    else {
      const instance = state.abilities.instances.find(entry => entry.intrinsic && entry.definitionId === action.definitionId && entry.owner === "player");
      if (!instance) return state;
      try { validateAbilityBinding({ definitionId: action.definitionId, level: instance.level, enabled: true, parameters: { ...instance.parameters, ...action.parameters } }); } catch { return state; }
      const prepared = configureIntrinsicAbility(state, { definitionId: action.definitionId, level: instance.level, enabled: true, parameters: action.parameters });
      const result = runAbilityEvent(prepared, { trigger: "on-ability-played", sourceEventId: `intrinsic:${state.history.length}:${instance.instanceId}`, eventActor: "player" }, {}, instance.instanceId);
      if (result.failed) return state;
      next = { ...result.state, abilities: { ...result.state.abilities, instances: result.state.abilities.instances.map(entry => entry.instanceId === instance.instanceId ? { ...entry, parameters: instance.parameters } : entry) } };
    }
    if (next === state) return state;
    return next.round.phase === "turns" ? normalizeAbilityHands(next) : next;
  }
  if (action.type === "ESCAPE_MATCH") return state.status === "active" ? append({ ...expireAllStatuses(state), abilities: { ...expireAllStatuses(state).abilities, displays: [] }, status: "finished", view: "match-summary", outcome: { winner: null, reason: "escaped" } }, { type: "MATCH_ESCAPED" }, { type: "MATCH_FINISHED", reason: "escaped" }) : state;
  if (action.type === "ACK_MATCH_RESULT") return state.status === "finished" && state.view === "match-summary" ? append({ ...state, scene: "lobby" }, { type: "MATCH_RESULT_ACKNOWLEDGED" }) : state;
  if (action.type === "ACK_ROUND_RESULT") { if (state.status !== "active" || state.round.phase !== "round-reveal") return state; const next = append(state, { type: "ROUND_RESULT_ACKNOWLEDGED" }); if (previewPendingTrigger(next)?.cancelled) return triggerFor(next, next.round.outcome!.penaltyTarget!); return next.round.outcome?.penaltyTarget ? setPhase(next, next.round.outcome.penaltyTarget === "opponent" ? "roulette-trigger" : "roulette-reaction", null) : startNextRound(next); }
  if (action.type === "ACK_TRIGGER_RESULT") { if (state.round.phase !== "roulette-result") return state; const next = append(state, { type: "TRIGGER_RESULT_ACKNOWLEDGED" }); return state.status === "finished" ? { ...next, view: "match-summary" } : startNextRound(next); }
  if (state.status !== "active" || state.scene !== "match") return state;
  switch (action.type) {
    case "REFRESH_SKILL_DRAW": return refreshSkillDraw(state);
    case "OPEN_SKILL_DRAW": return openSkillDraw(state);
    case "SELECT_SKILL_DRAW": return selectSkillDraw(state, action.definitionId);
    case "PLAYER_HIT": return drawFor(state, "player");
    case "PLAYER_STAND": return standFor(state, "player");
    case "AI_HIT": case "OPPONENT_HIT": return drawFor(state, "opponent");
    case "AI_STAND": case "OPPONENT_STAND": return standFor(state, "opponent");
    case "AI_TURN": {
      if (!canTakeAction(state, "opponent", "hit") && !canTakeAction(state, "opponent", "stand")) return state;
      // No decision/forecast ability may try to inspect an exhausted draw pile.
      if (shoeRemaining(state.shoe) === 0) {
        const decision = { ...decideAiAction(buildObservation(state, "opponent"), state.aiProfile, state.aiNoise), action: "stand" as const };
        return standFor(append({ ...state, lastAiDecision: decision }, { type: "AI_DECISION", decision }), "opponent");
      }
      const pending: PendingAiThreshold = { id: `ai-threshold:${state.roundIndex}:${state.history.length}`, actor: "opponent", bySkill: 0 };
      const prepared = runAbilityEvent(state, { trigger: "before-ai-decision", sourceEventId: pending.id, eventActor: "opponent", roundHitCounts: getRoundHitCounts(state), pendingAiThreshold: pending }, { aiThreshold: pending });
      const bySkill = prepared.pendingAiThreshold?.bySkill ?? 0;
      const baseline = decideAiAction(buildObservation(prepared.state, "opponent"), prepared.state.aiProfile, prepared.state.aiNoise, bySkill);
      const actionOverride = prepared.pendingAiThreshold?.actionOverride;
      let decision = actionOverride ? { ...baseline, action: actionOverride.action, actionOverride } : baseline;
      if (!canTakeAction(prepared.state, "opponent", decision.action)) {
        const alternate = decision.action === "hit" ? "stand" : "hit";
        if (!canTakeAction(prepared.state, "opponent", alternate)) return prepared.state;
        decision = { ...decision, action: alternate };
      }
      const next = append({ ...prepared.state, lastAiDecision: decision }, { type: "AI_DECISION", decision });
      return decision.action === "hit" ? drawFor(next, "opponent") : standFor(next, "opponent");
    }
    case "PLAY_ABILITY": return play(state, action.instanceId);
    case "TRIGGER_ROULETTE": return state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger" ? triggerFor(state, state.round.outcome?.penaltyTarget ?? "player") : state;
    case "CONTINUE_ROUND": return state.round.phase === "round-end" ? startNextRound(state) : state;
    default: return state;
  }
}
