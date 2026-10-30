import { resolveValue, selectedHandCard } from "./value-expressions";
import { rankPartitions } from "./card-zone-adapter";
import { hasRecordedRank, recordedRanks } from "./rank-record";
import { handValueAtLimit } from "../blackjack/hand";
import { type Hand } from "../blackjack/types";
import { cardHasTag, cardRank, cardSource, cardSuit, cardValue } from "../blackjack/card";
import { findCardCandidates, handCardCount, handTotal } from "./card-zone-adapter";
import { gunBullets, gunIsFull } from "./roulette-adapter";
import { resolveBinaryScalarOperation, resolveUnaryScalarOperation } from "./scalar-operations";
import { selectSkillCards } from "./skill-card-selection";
import type { AbilityRegistry } from "./registry";
import type { AbilityInstance, AbilityEventContext, AbilityWorld, ActorSelector, Compare, Condition, NumberValue, ScalarValue } from "./types";

export interface ConditionContext {
  readonly registry?: AbilityRegistry;
  /** Numeric results exist only during one sequential effect transaction. */
  readonly effectResults?: Readonly<Record<string, number>>;
  readonly world: AbilityWorld;
  readonly ability: AbilityInstance;
  readonly event: AbilityEventContext;
  /** Service supplied by the match layer so conditions can preview the live bust limit. */
  readonly bustLimitFor?: (owner: "player" | "opponent", world: AbilityWorld) => number;
  readonly forecastHitBust?: (owner: "player" | "opponent", world: AbilityWorld) => boolean;
}

export function resolveActor(selector: ActorSelector, context: ConditionContext): "player" | "opponent" | undefined {
  if (selector === "owner") return context.ability.owner;
  if (selector === "rival") return context.ability.owner === "player" ? "opponent" : "player";
  if (selector === "event-actor") return context.event.eventActor;
  if (selector === "status-owner") return context.event.statusOwner;
  return context.event.roundOutcome?.penaltyTarget ?? undefined;
}

export function resolveScalar(value: ScalarValue, context: ConditionContext): number {
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Scalar value is not finite"); return value; }
  const numeric = value as NumberValue;
  if (numeric.type === "effect-result") {
    const result = context.effectResults?.[numeric.key];
    if (!Number.isFinite(result)) throw new Error(`Effect result is unavailable: ${numeric.key}`);
    return result!;
  }
  if (numeric.type === "acquired-card-value") {
    const cards = context.event.acquiredCards;
    if (context.event.trigger !== "after-card-acquired" || cards?.length !== 1) throw new Error("Acquired card value requires one acquired card event");
    const card = cards[0]!;
    if (cardRank(card) !== "A") return cardValue(cardRank(card));
    if (numeric.aceValue === "one") return 1;
    if (numeric.aceValue === "eleven") return 11;
    const actor = context.event.eventActor;
    if (!actor) throw new Error("Acquired Ace value requires its acquiring actor");
    const limit = context.bustLimitFor?.(actor, context.world) ?? 21;
    const other = { cards: context.world.hands[actor].cards.filter(entry => entry.id !== card.id) };
    return handValueAtLimit(other, limit) + 11 <= limit ? 11 : 1;
  }
  if (numeric.type === "divide" || numeric.type === "modulo") return resolveBinaryScalarOperation(numeric.type, resolveScalar(numeric.left, context), resolveScalar(numeric.right, context));
  if (numeric.type === "floor" || numeric.type === "ceil" || numeric.type === "round" || numeric.type === "abs") return resolveUnaryScalarOperation(numeric.type, resolveScalar(numeric.value, context));
  if (numeric.type === "constant") { if (!Number.isFinite(numeric.value)) throw new Error("Scalar value is not finite"); return numeric.value; }
  if (numeric.type === "parameter") {
    const parameter = context.ability.parameters[numeric.key];
    if (typeof parameter !== "number") throw new Error(`Ability parameter is not numeric: ${numeric.key}`);
    if (!Number.isFinite(parameter)) throw new Error("Scalar value is not finite");
    return parameter;
  }
  if (numeric.type === "add" || numeric.type === "subtract" || numeric.type === "multiply" || numeric.type === "power" || numeric.type === "min" || numeric.type === "max") {
    const left = resolveScalar(numeric.left, context);
    const right = resolveScalar(numeric.right, context);
    const result = numeric.type === "add" ? left + right
      : numeric.type === "subtract" ? left - right
        : numeric.type === "multiply" ? left * right
          : numeric.type === "power" ? left ** right
            : numeric.type === "min" ? Math.min(left, right)
              : Math.max(left, right);
    if (!Number.isFinite(result)) throw new Error("Scalar expression result is not finite");
    return result;
  }
  if (!("target" in numeric)) throw new Error("Invalid scalar expression");
  const actor = resolveActor(numeric.target, context);
  if (!actor) return 0;
  if (numeric.type === "bust-limit") return context.bustLimitFor?.(actor, context.world) ?? 21;
  if (numeric.type === "hand-card-match-count") {
    const value = resolveValue(numeric.equals, context);
    return context.world.hands[actor].cards.filter(card => (numeric.attribute === "rank" ? cardRank(card) : numeric.attribute === "suit" ? cardSuit(card) : numeric.attribute === "source" ? cardSource(card) : card.id) === value).length;
  }
  if (numeric.type === "skill-card-count") return selectSkillCards(context.world, actor, numeric.filter, context.registry).length;
  if (numeric.type === "public-hand-card-suit-count") {
    const publicIds = new Set(context.world.publicCardIds ?? []);
    const first = context.world.hands[actor].cards[0];
    if (first) publicIds.add(first.id);
    return context.world.hands[actor].cards.filter(card => publicIds.has(card.id) && cardSuit(card) === numeric.suit).length;
  }
  if (numeric.type === "round-point-advantage") {
    let value: number;
    if (numeric.round === "previous") value = context.world.previousRoundPointAdvantages?.[actor] ?? 0;
    else if (context.event.pendingComparison) {
      const comparison = context.event.pendingComparison;
      const base = comparison.baseScores?.[actor] ?? handValueAtLimit(context.world.hands[actor], context.bustLimitFor?.(actor, context.world) ?? 21);
      value = comparison.scores[actor] - base;
    } else value = context.event.roundOutcome?.pointAdvantages?.[actor] ?? context.world.currentRoundPointAdvantages?.[actor] ?? 0;
    if (!Number.isFinite(value)) throw new Error("Round point advantage is not finite");
    return value;
  }
  if (numeric.type === "hand-card-value") {
    const hand = context.world.hands[actor];
    const card = numeric.card === "last-card" ? hand.cards.at(-1) : hand.cards[numeric.card === "first-public-card" ? 0 : 1];
    if (!card) throw new Error("Card value source is unavailable");
    if (cardRank(card) !== "A") return cardValue(cardRank(card));
    if (numeric.aceValue === "one") return 1;
    if (numeric.aceValue === "eleven") return 11;
    const limit = context.bustLimitFor?.(actor, context.world) ?? 21;
    const other = { cards: hand.cards.filter(entry => entry.id !== card.id) };
    return handValueAtLimit(other, limit) + 11 <= limit ? 11 : 1;
  }
  if (numeric.type === "gun-bullets") return gunBullets(context.world.guns[actor]);
  if (numeric.type === "hand-total") return handTotal(context.world.hands[actor]);
  if (numeric.type === "round-final-score") return context.event.roundOutcome?.comparisonScores?.[actor] ?? handTotal(context.world.hands[actor]);
  if (numeric.type === "hand-card-count") return handCardCount(context.world.hands[actor]);
  if (numeric.type === "hand-card-color-count") return context.world.hands[actor].cards.filter((card) => (cardSuit(card) === "hearts" || cardSuit(card) === "diamonds") === (numeric.color === "red")).length;
  if (numeric.type === "hand-card-suit-count") return context.world.hands[actor].cards.filter((card) => cardSuit(card) === numeric.suit).length;

  if (numeric.type === "event-hand-card-count") return context.event.initialHandCardCounts?.[actor] ?? handCardCount(context.world.hands[actor]);
  if (numeric.type === "status-number") {
    const value = context.world.statuses.find((status) => status.owner === actor && status.statusDefinitionId === numeric.statusDefinitionId)?.parameters[numeric.key];
    return typeof value === "number" ? value : 0;
  }
  if (numeric.type === "rank-record-count") return recordedRanks(context.world.statuses.find((status) => status.owner === actor && status.statusDefinitionId === numeric.statusDefinitionId)?.parameters).length;
  if (numeric.type === "hand-rank-record-count") {
    const statusActor = resolveActor(numeric.statusTarget, context);
    const parameters = context.world.statuses.find((status) => status.owner === statusActor && status.statusDefinitionId === numeric.statusDefinitionId)?.parameters;
    return context.world.hands[actor].cards.filter((card) => hasRecordedRank(parameters, cardRank(card)) === numeric.matched).length;
  }
  if (numeric.type === "status-stacks") return context.world.statuses.find((status) => status.owner === actor && status.statusDefinitionId === numeric.statusDefinitionId)?.stacks ?? 0;
  return context.event.roundHitCounts?.[actor] ?? 0;
}

function compare(left: number, operator: Compare, right: number): boolean {
  if (operator === "eq") return left === right;
  if (operator === "neq") return left !== right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  if (operator === "gt") return left > right;
  return left >= right;
}

function handFor(selector: ActorSelector, context: ConditionContext): Hand | undefined {
  const actor = resolveActor(selector, context);
  return actor ? context.world.hands[actor] : undefined;
}

function candidateExists(hand: Hand, context: ConditionContext, candidate: Extract<Condition, { type: "card-candidate-exists" }>["candidate"]): boolean {
  const expected = resolveScalar(candidate.value, context);
  const mode = candidate.type === "resulting-hand-total-at-most" ? "at-most" : "exactly";
  return findCardCandidates(context.world.shoe, hand, mode, expected).length > 0;
}

/** Project the exact last Hit card, including any later hand-size-dependent limits. */
export function safeLastHitTransfer(from: ActorSelector, target: ActorSelector, context: ConditionContext): AbilityWorld | undefined {
  const source = resolveActor(from, context);
  const actor = resolveActor(target, context);
  const pending = context.event.pendingDraw;
  if (!source || !actor || source === actor || pending?.actor !== actor || pending.cancelled) return undefined;
  const cardId = context.event.lastHitCardIds?.[source];
  const card = context.world.hands[source].cards.find(entry => entry.id === cardId);
  if (!card || context.world.hands[actor].cards.some(entry => entry.id === card.id)) return undefined;
  const world = { ...context.world, hands: { ...context.world.hands,
    [source]: { cards: context.world.hands[source].cards.filter(entry => entry.id !== card.id) },
    [actor]: { cards: [...context.world.hands[actor].cards, card] }
  } };
  if (!context.bustLimitFor) throw new Error("No bust limit service configured for card transfer");
  const limit = context.bustLimitFor(actor, world);
  return handValueAtLimit(world.hands[actor], limit) <= limit ? world : undefined;
}

export function evaluateCondition(condition: Condition, context: ConditionContext): boolean {
  switch (condition.type) {
    case "value-compare": {
      try { const equal = resolveValue(condition.left, context) === resolveValue(condition.right, context); return condition.operator === "eq" ? equal : !equal; }
      catch { return false; }
    }
    case "hand-card-transformable": return Boolean(selectedHandCard(condition.target, condition.card, context)) && rankPartitions(resolveScalar(condition.output.total, context), condition.output.count).length > 0;
    case "pending-defeat-can-prevent": {
      const actor = resolveActor(condition.target, context);
      const pending = context.event.pendingDefeat;
      return Boolean(actor && context.event.trigger === "before-defeat" && pending?.actor === actor && !pending.prevented);
    }
    case "trigger-result-is": return context.event.triggerResult?.result === condition.value;
    case "acquired-card-source-is": return Boolean(context.event.acquiredCards?.length && context.event.acquiredCards.every(card => cardSource(card) === condition.source));
    case "round-had-bust": return context.event.roundHadBust === true;
    case "actor-is": { const actor = resolveActor(condition.actor, context); return actor !== undefined && context.event.eventActor === actor; }
    case "owner-has-card": return context.world.cards.some((card) => card.owner === context.ability.owner && card.definitionId === condition.abilityId);
    case "hand-card-count": { const hand = handFor(condition.target, context); return Boolean(hand && compare(handCardCount(hand), condition.operator, resolveScalar(condition.value, context))); }
    case "event-hand-card-count": { const actor = resolveActor(condition.target, context); return Boolean(actor && compare(context.event.initialHandCardCounts?.[actor] ?? handCardCount(context.world.hands[actor]), condition.operator, resolveScalar(condition.value, context))); }
    case "hand-total": { const hand = handFor(condition.target, context); return Boolean(hand && compare(handTotal(hand), condition.operator, resolveScalar(condition.value, context))); }
    case "round-hit-count": { const actor = resolveActor(condition.target, context); return Boolean(actor && compare(context.event.roundHitCounts?.[actor] ?? 0, condition.operator, resolveScalar(condition.value, context))); }
    case "hand-all-same-suit": { const hand = handFor(condition.target, context); return Boolean(hand && hand.cards.length > 0 && new Set(hand.cards.map(cardSuit)).size === 1); }
    case "hand-all-color": { const hand = handFor(condition.target, context); return Boolean(hand && hand.cards.length > 0 && hand.cards.every((card) => (cardSuit(card) === "hearts" || cardSuit(card) === "diamonds") === (condition.color === "red"))); }
    case "hand-rank-has-suit-partner": { const hand = handFor(condition.target, context); return Boolean(hand && hand.cards.some((card, index) => cardRank(card) === condition.rank && hand.cards.some((partner, partnerIndex) => partnerIndex !== index && cardSuit(partner) === cardSuit(card)))); }
    case "hand-card-source-is": { const hand = handFor(condition.target, context); return hand?.cards.at(-1) ? cardSource(hand.cards.at(-1)!) === condition.source : false; }
    case "hand-card-has-tag": {
      const hand = handFor(condition.target, context);
      const card = condition.card === "last-card" ? hand?.cards.at(-1) : hand?.cards[condition.card === "first-public-card" ? 0 : 1];
      return Boolean(card && cardHasTag(card, condition.tag));
    }
    case "card-candidate-exists": { const hand = handFor(condition.target, context); return Boolean(hand && hand.cards.length > 0 && candidateExists(hand, context, condition.candidate)); }
    case "draw-pile-card-exists": return context.world.shoe.cursor < context.world.shoe.cards.length;
    case "hand-is-twenty-one": { const hand = handFor(condition.target, context); return Boolean(hand && handTotal(hand) === 21); }
    case "pending-turn-can-skip": {
      const actor = resolveActor(condition.target, context);
      const pending = context.event.pendingTurn;
      return Boolean(actor && pending?.actor === actor && pending.canSkip && !pending.skipped);
    }
    case "next-hit-would-bust": {
      const actor = resolveActor(condition.target, context);
      if (!actor) return false;
      if (!context.forecastHitBust) throw new Error("No Hit bust forecaster configured");
      return context.forecastHitBust(actor, context.world);
    }
    case "last-hit-card-transfer-is-safe": return Boolean(safeLastHitTransfer(condition.from, condition.target, context));
    case "pending-bust-would-bust": {
      const hand = handFor(condition.target, context);
      const actor = resolveActor(condition.target, context);
      const pending = context.event.pendingBust;
      return Boolean(hand && actor && pending?.actor === actor && handTotal(hand) > pending.limit);
    }
    case "gun-bullets": { const actor = resolveActor(condition.target, context); return Boolean(actor && compare(gunBullets(context.world.guns[actor]), condition.operator, resolveScalar(condition.value, context))); }
    case "gun-is-full": { const actor = resolveActor(condition.target, context); return Boolean(actor && gunIsFull(context.world.guns[actor]) === condition.expected); }
    case "round-reason-is": return context.event.roundOutcome?.reason === condition.value;
    case "round-penalty-target-is": { const actor = resolveActor(condition.target, context); return actor !== undefined && context.event.roundOutcome?.penaltyTarget === actor; }
    case "event-ability-kind-is": return context.event.playedAbilityKind === condition.kind;
    case "status-present": { const actor = resolveActor(condition.target, context); return Boolean(actor && context.world.statuses.some((status) => status.owner === actor && status.statusDefinitionId === condition.statusDefinitionId && status.stacks > 0)); }
    case "scalar-compare": return compare(resolveScalar(condition.left, context), condition.operator, resolveScalar(condition.right, context));
    case "any": return condition.conditions.some((entry) => evaluateCondition(entry, context));
    case "not": return !evaluateCondition(condition.condition, context);
  }
}

export function allConditionsPass(conditions: readonly Condition[] | undefined, context: ConditionContext): boolean {
  return !conditions || conditions.every((condition) => evaluateCondition(condition, context));
}
