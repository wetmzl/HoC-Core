import { resolveScalar } from "./conditions";
import type { AbilityActor, AbilityDefinition, AbilityRuntimeState, AbilityWorld } from "./types";
import type { AbilityRegistry } from "./registry";
import type { AbilityDisplay, DisplayActor, DisplayInstance, DisplayValue } from "./display-types";
import { RANKS, SUITS, type Rank, type Suit } from "../blackjack/types";
import { cardSuit } from "../blackjack/card";

export function displayActor(selector: DisplayActor, owner: AbilityActor): AbilityActor {
  return selector === "owner" ? owner : owner === "player" ? "opponent" : "player";
}
export function displayKey(instance: Pick<DisplayInstance, "owner" | "definitionId" | "displayId">): string {
  return `${instance.owner}:${instance.definitionId}:${instance.displayId}`;
}
export type ResolvedDisplayNode =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "number"; readonly value: number | null; readonly format: "number" | "percent" }
  | { readonly type: "suit"; readonly value: Suit | null }
  | { readonly type: "card"; readonly rank: Rank | null; readonly suit: Suit | null; readonly format: "inline" | "compact" };
export interface ResolvedDisplay {
  readonly key: string;
  readonly target: AbilityActor;
  readonly name: string;
  readonly description: string;
  readonly content: readonly ResolvedDisplayNode[];
  readonly markers: readonly { readonly targets: readonly AbilityActor[]; readonly suit: Suit; readonly type: string; readonly label: string }[];
}
export interface DisplayContext {
  readonly world: AbilityWorld;
  readonly instance: DisplayInstance;
  readonly roundHitCounts?: Readonly<Record<AbilityActor, number>>;
  readonly roundOutcome?: import("./types").AbilityEventContext["roundOutcome"];
}
/** Missing data stays missing; no query mutates state, consumes RNG, or fabricates a card. */
export function resolveDisplayValue(value: DisplayValue, context: DisplayContext): string | number | boolean | null {
  if (typeof value === "number") return value;
  if (value.type === "constant") return value.value;
  if (value.type === "parameter") return context.instance.parameters[value.key] ?? null;
  if (value.type === "status-parameter") {
    return context.world.statuses.find((status) => status.owner === displayActor(value.target, context.instance.owner) && status.statusDefinitionId === value.statusDefinitionId && status.stacks > 0)?.parameters[value.key] ?? null;
  }
  if (value.type === "hand-card-attribute") {
    const hand = context.world.hands[displayActor(value.target, context.instance.owner)];
    const card = value.card === "last-card" ? hand.cards.at(-1) : hand.cards[1];
    return card?.attributes[value.attribute] ?? null;
  }
  try { return resolveScalar(value, {
    world: context.world,
    ability: { kind: "player-skill", definitionId: context.instance.definitionId, owner: context.instance.owner, instanceId: displayKey(context.instance), parameters: context.instance.parameters, createdAtSequence: context.instance.registeredAtSequence },
    event: { trigger: "before-turn", sourceEventId: "display-projection", roundHitCounts: context.roundHitCounts, roundOutcome: context.roundOutcome }
  }); } catch { return null; }
}
function suitValue(value: unknown): Suit | null { return typeof value === "string" && SUITS.includes(value as Suit) ? value as Suit : null; }
function rankValue(value: unknown): Rank | null { return typeof value === "string" && RANKS.includes(value as Rank) ? value as Rank : null; }
export function resolveDisplay(definition: AbilityDefinition, declaration: AbilityDisplay, context: DisplayContext): ResolvedDisplay {
  const content: ResolvedDisplayNode[] = declaration.content.map((node) => {
    if (node.type === "text") return node;
    if (node.type === "card") return { type: "card", rank: rankValue(resolveDisplayValue(node.rank, context)), suit: suitValue(resolveDisplayValue(node.suit, context)), format: node.format ?? "inline" };
    const value = resolveDisplayValue(node.value, context);
    if (node.type === "suit") return { type: "suit", value: suitValue(value) };
    return { type: "number", value: typeof value === "number" && Number.isFinite(value) ? value : null, format: node.format ?? "number" };
  });
  return {
    key: displayKey(context.instance), target: context.instance.target, name: definition.name, description: declaration.description, content,
    markers: (declaration.cardMarkers ?? []).flatMap((marker) => {
      const suit = suitValue(resolveDisplayValue(marker.suit, context));
      return suit ? [{ ...marker, suit, targets: marker.targets.map((target) => displayActor(target, context.instance.owner)) }] : [];
    })
  };
}
export function resolveDisplays(runtime: AbilityRuntimeState, world: AbilityWorld, registry: AbilityRegistry, context: Omit<DisplayContext, "world" | "instance"> = {}): readonly ResolvedDisplay[] {
  return [...runtime.displays].sort((a, b) => a.registeredAtSequence - b.registeredAtSequence).map((instance) => {
    const definition = registry.definitionsById[instance.definitionId];
    const declaration = definition?.displays?.find((display) => display.id === instance.displayId);
    if (!definition || !declaration) throw new Error(`Unknown display: ${displayKey(instance)}`);
    return resolveDisplay(definition, declaration, { ...context, world, instance });
  });
}
export function displayCardMarkers(displays: readonly ResolvedDisplay[], world: AbilityWorld): Readonly<Record<string, readonly { readonly type: string; readonly label: string }[]>> {
  const result: Record<string, { type: string; label: string }[]> = {};
  for (const display of displays) for (const marker of display.markers) for (const target of marker.targets) {
    for (const card of world.hands[target].cards) {
      if (cardSuit(card) !== marker.suit) continue;
      const markers = result[card.id] ??= [];
      if (!markers.some((entry) => entry.type === marker.type && entry.label === marker.label)) markers.push({ type: marker.type, label: marker.label });
    }
  }
  return result;
}
