import { z } from "zod";
import type { Action, Actor, MatchState } from "../match/types";
import { PLAYER_SKILL_INVENTORY_CAPACITY } from "../skills/constants";
import { PUBLIC_EVENT_SCOPE_NAMES, type PublicEvent, type PublicEventBatch, type PublicPresentationContext, type PublicScalar } from "./public-events";
import type { PublicMatchReadModel } from "./public-match-read-model";

const actions = {
  CONFIGURE_INTRINSIC_ABILITY: true, INVOKE_INTRINSIC_ABILITY: true, PLAYER_HIT: true, PLAYER_STAND: true, AI_TURN: true,
  AI_HIT: true, OPPONENT_HIT: true, AI_STAND: true, OPPONENT_STAND: true, PLAY_ABILITY: true, REFRESH_SKILL_DRAW: true,
  OPEN_SKILL_DRAW: true, SELECT_SKILL_DRAW: true, TRIGGER_ROULETTE: true, ACK_ROUND_RESULT: true, ACK_TRIGGER_RESULT: true,
  CONTINUE_ROUND: true, ESCAPE_MATCH: true, ACK_MATCH_RESULT: true
} as const satisfies Record<Action["type"], true>;
const actor = z.enum(["player", "opponent"]);
const simpleQueries = [
  "event.type", "event.id", "match.active-table", "match.player-turn", "match.playable-skill", "match.skill-draw-count",
  "match.inventory-capacity", "match.round-loaded", "match.comparison-modified", "match.passive-skill-present",
  "match.inspected-skill-lifetime", "match.phase", "match.current-actor", "match.status", "match.round-index",
  "presentation.skill-drawer-open", "match.skill-draw-open", "match.penalty-target", "game.id",
  "program.id", "program.definition-id", "program.node-id", "program.visit-index", "program.status"
] as const;
/** Closed semantic queries, rather than arbitrary object paths into runtime state. */
export const PublicQuerySchema = z.union([
  z.object({ id: z.enum(simpleQueries) }).strict(),
  z.object({ id: z.literal("event.data"), key: z.string().min(1).max(160) }).strict(),
  z.object({ id: z.literal("context.value"), key: z.string().min(1).max(160) }).strict(),
  z.object({ id: z.literal("scope.id"), scope: z.enum(PUBLIC_EVENT_SCOPE_NAMES) }).strict(),
  z.object({ id: z.literal("match.action-available"), action: z.enum(Object.keys(actions) as [Action["type"], ...Action["type"][]]) }).strict(),
  z.object({ id: z.literal("match.skill-card-count"), actor: actor.optional() }).strict(),
  z.object({ id: z.enum(["match.busted", "match.stood", "match.bust-limit", "match.gun-bullets", "match.hand-card-count"]), actor }).strict()
]);
export type PublicQuery = z.infer<typeof PublicQuerySchema>;
export interface PublicQueryContext {
  readonly event?: PublicEvent;
  readonly batch?: PublicEventBatch;
  readonly match?: MatchState;
  readonly matchQueries?: PublicMatchReadModel;
  readonly presentation?: PublicPresentationContext;
}
const contextCaches = new WeakMap<PublicQueryContext, Map<string, unknown>>();
/** One immutable evaluation context owns its cache; no state/registry-global memoization. */
export function createPublicQueryContext(input: PublicQueryContext): PublicQueryContext {
  if (contextCaches.has(input)) return input;
  const context = Object.freeze({ ...input });
  contextCaches.set(context, new Map());
  return context;
}
function matchQueries(context: PublicQueryContext): PublicMatchReadModel | undefined {
  // A public batch is authoritative, even when its older producer omitted the semantic model.
  if (context.batch) return context.batch.context?.matchQueries;
  return context.matchQueries;
}
function scalar(value: unknown): PublicScalar | undefined {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function ownScalar(values: Readonly<Record<string, unknown>> | undefined, key: string): PublicScalar | undefined {
  return values && Object.hasOwn(values, key) ? scalar(values[key]) : undefined;
}
function roundLoaded(state: MatchState): boolean {
  const target = state.round.outcome?.penaltyTarget;
  if (!target) return false;
  for (let index = state.history.length - 1; index >= 0; index--) {
    const event = state.history[index];
    if (event.type === "ROUND_STARTED") break;
    if (event.type === "BULLET_ADDED" && event.actor === target && (event.actualAmount ?? event.amount) > 0) return true;
  }
  return false;
}
/** Returns undefined when a query has no applicable context; null remains a real value. */
export function readPublicQuery(query: PublicQuery, context: PublicQueryContext): PublicScalar | undefined {
  // Content and plugin callers share the same runtime validation as authoring tools.
  const parsed = PublicQuerySchema.safeParse(query);
  if (!parsed.success) return undefined;
  const input = parsed.data;
  const cache = contextCaches.get(context), key = JSON.stringify(input);
  if (cache?.has(key)) return cache.get(key) as PublicScalar | undefined;
  const result = read(input, context);
  cache?.set(key, result);
  return result;
}
function read(input: PublicQuery, context: PublicQueryContext): PublicScalar | undefined {
  if (input.id === "event.type") return context.event?.type;
  if (input.id === "event.id") return context.event?.id;
  if (input.id === "event.data") return ownScalar(context.event?.data, input.key);
  if (input.id === "context.value") return ownScalar(context.batch?.context?.values, input.key);
  if (input.id === "scope.id") return context.event?.scopes[input.scope];
  if (input.id === "game.id") return context.event?.scopes.game;
  const program = context.batch?.context?.program;
  if (input.id === "program.id") return program?.id;
  if (input.id === "program.definition-id") return program?.definitionId;
  if (input.id === "program.node-id") return program?.nodeId;
  if (input.id === "program.visit-index") return program?.visitIndex;
  if (input.id === "program.status") return program?.status;
  const presentation = context.presentation ?? context.batch?.context?.presentation;
  if (input.id === "presentation.skill-drawer-open") return presentation?.skillDrawerOpen;
  if (input.id === "match.inventory-capacity") return PLAYER_SKILL_INVENTORY_CAPACITY;
  const state = context.match ?? context.batch?.context?.match;
  if (!state) return undefined;
  switch (input.id) {
    case "match.active-table": return state.scene === "match" && state.view === "table" && state.status === "active";
    case "match.player-turn": return state.round.phase === "turns" && state.round.currentActor === "player" && !state.playerSkills.drawOffer;
    case "match.action-available": return matchQueries(context)?.legalActionTypes.includes(input.action);
    case "match.playable-skill": return matchQueries(context)?.playablePlayerSkill;
    case "match.skill-card-count": return state.playerSkills.cards.filter(card => card.owner === (input.actor ?? "player")).length;
    case "match.busted": return state[input.actor].busted;
    case "match.stood": return state[input.actor].stood;
    case "match.bust-limit": return matchQueries(context)?.activeBustLimits[input.actor];
    case "match.gun-bullets": return state.roulette[input.actor].bullets;
    case "match.hand-card-count": return state[input.actor].hand.cards.length;
    case "match.skill-draw-count": return state.playerSkills.drawCount;
    case "match.skill-draw-open": return Boolean(state.playerSkills.drawOffer);
    case "match.penalty-target": return state.round.outcome?.penaltyTarget ?? null;
    case "match.round-loaded": return roundLoaded(state);
    case "match.comparison-modified": return matchQueries(context)?.comparisonModified;
    case "match.passive-skill-present": return matchQueries(context)?.passiveSkillPresent;
    case "match.inspected-skill-lifetime": {
      if (!presentation) return undefined;
      const inspected = presentation.inspectedSkill;
      if (!inspected) return false;
      const model = matchQueries(context);
      if (!model) return undefined;
      const card = inspected.instanceId ? model.skillLifetimes.find(candidate => candidate.instanceId === inspected.instanceId
        && candidate.definitionId === inspected.definitionId) : undefined;
      return Boolean((card ?? model.skillLifetimes.find(candidate => !candidate.instanceId && candidate.definitionId === inspected.definitionId))?.hasLifetime);
    }
    case "match.phase": return state.round.phase;
    case "match.current-actor": return state.round.currentActor;
    case "match.status": return state.status;
    case "match.round-index": return state.roundIndex;
  }
}

export type PublicQueryActor = Actor;
