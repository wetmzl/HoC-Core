import { cardRank, cardSource, cardSuit } from "../blackjack/card";
import { SUITS, type Card } from "../blackjack/types";
import { resolveActor, resolveScalar, type ConditionContext } from "./conditions";
import type { CardSelector, ValueExpression } from "./types";

export function selectedHandCard(target: import("./types").ActorSelector, selector: CardSelector, context: ConditionContext): Card | undefined {
  const actor = resolveActor(target, context);
  const cards = actor && context.world.hands[actor].cards;
  return cards ? selector === "last-card" ? cards.at(-1) : cards[selector === "first-public-card" ? 0 : 1] : undefined;
}
/** Typed values are observations; evaluating them never consumes random state. */
export function resolveValue(expression: ValueExpression, context: ConditionContext): string | number | boolean {
  if (expression.type === "literal") {
    if (typeof expression.value === "number" && !Number.isFinite(expression.value)) throw new Error("Value must be finite");
    return expression.value;
  }
  if (expression.type === "numeric") return resolveScalar(expression.value, context);
  const actor = resolveActor(expression.target, context);
  if (!actor) throw new Error("Value target is unavailable");
  if (expression.type === "status-value") {
    const value = context.world.statuses.find(status => status.owner === actor && status.statusDefinitionId === expression.statusDefinitionId && status.stacks > 0)?.parameters[expression.key];
    if (value === undefined || !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`Status value is unavailable: ${expression.key}`);
    return value;
  }
  if (expression.type === "card-attribute") {
    const card = selectedHandCard(expression.target, expression.card, context);
    if (!card) throw new Error("Value card is unavailable");
    return expression.attribute === "rank" ? cardRank(card) : expression.attribute === "suit" ? cardSuit(card) : expression.attribute === "source" ? cardSource(card) : card.id;
  }
  const cards = context.world.hands[actor].cards;
  if (!cards.length) throw new Error("Cannot query a suit from an empty hand");
  const counts = new Map(SUITS.map(suit => [suit, cards.filter(card => cardSuit(card) === suit).length]));
  return expression.tieBreak.reduce((best, suit) => counts.get(suit)! > counts.get(best)! ? suit : best);
}
