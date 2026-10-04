import { SUITS, type Hand, type Suit } from "../blackjack/types";
import { cardHasTag, cardRank, cardSource, cardSuit } from "../blackjack/card";
import { canSplitLastCard, findCardCandidates, handCardCount, handTotal } from "./card-zone-adapter";
import { gunBullets, gunIsFull } from "./roulette-adapter";
import type { AbilityInstance, AbilityEventContext, AbilityWorld, ActorSelector, Compare, Condition, NumberValue, ScalarValue } from "./types";

export interface ConditionContext {
  readonly world: AbilityWorld;
  readonly ability: AbilityInstance;
  readonly event: AbilityEventContext;
  /** Service supplied by the match layer so conditions can preview the live bust limit. */
  readonly forecastHitBust?: (owner: "player" | "opponent", world: AbilityWorld) => boolean;
}

export function resolveActor(selector: ActorSelector, context: ConditionContext): "player" | "opponent" | undefined {
  if (selector === "owner") return context.ability.owner;
  if (selector === "rival") return context.ability.owner === "player" ? "opponent" : "player";
  if (selector === "event-actor") return context.event.eventActor;
  return context.event.roundOutcome?.penaltyTarget ?? undefined;
}

export function resolveScalar(value: ScalarValue, context: ConditionContext): number {
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Scalar value is not finite"); return value; }
  const numeric = value as NumberValue;
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
  if (numeric.type === "gun-bullets") return gunBullets(context.world.guns[actor]);
  if (numeric.type === "hand-total") return handTotal(context.world.hands[actor]);
  if (numeric.type === "round-final-score") return context.event.roundOutcome?.comparisonScores?.[actor] ?? handTotal(context.world.hands[actor]);
  if (numeric.type === "hand-card-count") return handCardCount(context.world.hands[actor]);
  if (numeric.type === "hand-card-color-count") return context.world.hands[actor].cards.filter((card) => (cardSuit(card) === "hearts" || cardSuit(card) === "diamonds") === (numeric.color === "red")).length;
  if (numeric.type === "hand-card-suit-count") return context.world.hands[actor].cards.filter((card) => cardSuit(card) === numeric.suit).length;
  if (numeric.type === "hand-card-status-suit-count") {
    const statusActor = resolveActor(numeric.statusTarget, context);
    const suit = statusActor
      ? context.world.statuses.find((status) => status.owner === statusActor && status.statusDefinitionId === numeric.statusDefinitionId && status.stacks > 0)?.parameters.suit
      : undefined;
    return typeof suit === "string" && SUITS.includes(suit as Suit)
      ? context.world.hands[actor].cards.filter((card) => cardSuit(card) === suit).length
      : 0;
  }
  if (numeric.type === "event-hand-card-count") return context.event.initialHandCardCounts?.[actor] ?? handCardCount(context.world.hands[actor]);
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

export function evaluateCondition(condition: Condition, context: ConditionContext): boolean {
  switch (condition.type) {
    case "actor-is": return context.event.eventActor === resolveActor(condition.actor, context);
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
      const card = condition.card === "last-card" ? hand?.cards.at(-1) : hand?.cards[1];
      return Boolean(card && cardHasTag(card, condition.tag));
    }
    case "card-candidate-exists": { const hand = handFor(condition.target, context); return Boolean(hand && hand.cards.length > 0 && candidateExists(hand, context, condition.candidate)); }
    case "draw-pile-card-exists": return context.world.shoe.cursor < context.world.shoe.cards.length;
    case "hand-last-card-splittable": { const hand = handFor(condition.target, context); return Boolean(hand && canSplitLastCard(hand)); }
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
    case "pending-bust-would-bust": {
      const hand = handFor(condition.target, context);
      const actor = resolveActor(condition.target, context);
      const pending = context.event.pendingBust;
      return Boolean(hand && actor && pending?.actor === actor && handTotal(hand) > pending.limit);
    }
    case "status-card-rank-is": {
      const actor = resolveActor(condition.target, context);
      const status = actor ? context.world.statuses.find((entry) => entry.owner === actor && entry.statusDefinitionId === condition.statusDefinitionId && entry.stacks > 0) : undefined;
      return status?.parameters.rank === condition.rank;
    }
    case "gun-bullets": { const actor = resolveActor(condition.target, context); return Boolean(actor && compare(gunBullets(context.world.guns[actor]), condition.operator, resolveScalar(condition.value, context))); }
    case "gun-is-full": { const actor = resolveActor(condition.target, context); return Boolean(actor && gunIsFull(context.world.guns[actor]) === condition.expected); }
    case "round-reason-is": return context.event.roundOutcome?.reason === condition.value;
    case "round-penalty-target-is": return context.event.roundOutcome?.penaltyTarget === resolveActor(condition.target, context);
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
