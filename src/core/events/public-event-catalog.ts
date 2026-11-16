import { z } from "zod";
import { createGameEventSchema } from "../match/event-schema";
import type { GameEvent } from "../match/types";
import { ABILITY_BROADCAST_TRIGGER_TYPES } from "./trigger-catalog";
import type { PublicEventScopeName } from "./public-events";

export interface PublicEventDeclaration {
  readonly type: string;
  readonly apiVersion: 1;
  readonly scopes: readonly PublicEventScopeName[];
  readonly stages: readonly ("resolved" | "committed")[];
  /** Rule data is captured at its window. Match queries read final batch state. */
  readonly dataBasis: "occurrence" | "rule-window";
}

const discovery = createGameEventSchema({ card: z.unknown(), abilityCard: z.object({ instanceId: z.string(), owner: z.string() }), roundOutcome: z.unknown(), aiDecision: z.unknown() });
/** Derived from the actual saved-event schema, never an independently maintained event list. */
export const MATCH_EVENT_TYPES: readonly GameEvent["type"][] = Object.freeze(discovery.options.flatMap(option => {
  const type = option.shape.type;
  return type instanceof z.ZodEnum ? type.options : [...type.values];
}) as GameEvent["type"][]);
const runtimeTypes = ["core.game-started", "core.game-stopped", "core.screen-entered", "core.screen-left", "core.duel-requested", "core.game-suspended", "core.game-resumed"] as const;
const programTypes = ["program.started", "program.restored", "program.node-entered", "program.node-left", "program.choice-selected", "program.reward-claimed", "program.completed", "program.abandoned"] as const;
function declaration(type: string, scopes: readonly PublicEventScopeName[], stages: readonly ("resolved" | "committed")[], dataBasis: PublicEventDeclaration["dataBasis"] = "occurrence"): PublicEventDeclaration {
  return Object.freeze({ type, apiVersion: 1, scopes: Object.freeze([...scopes]), stages: Object.freeze([...stages]), dataBasis });
}
export const PUBLIC_EVENT_CATALOG: readonly PublicEventDeclaration[] = Object.freeze([
  ...runtimeTypes.map(type => declaration(type, ["game"], ["resolved"])),
  ...programTypes.map(type => declaration(type, ["program"], ["resolved", "committed"])),
  ...["match.created", "match.restored"].map(type => declaration(type, ["match"], ["resolved", "committed"])),
  ...MATCH_EVENT_TYPES.map(type => declaration(`match.${type}`, ["match", "round"], ["resolved", "committed"])),
  ...ABILITY_BROADCAST_TRIGGER_TYPES.map(type => declaration(`rule.${type}`, ["match", "round", "rule-window"], ["resolved", "committed"], "rule-window"))
]);
export function getPublicEventDeclaration(type: string): PublicEventDeclaration | undefined {
  return PUBLIC_EVENT_CATALOG.find(declaration => declaration.type === type);
}
