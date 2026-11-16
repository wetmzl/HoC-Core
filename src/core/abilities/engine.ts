import { abilityRuleWindows, withAbilityRuleWindows, type AbilityRuleWindow } from "../events/rule-windows";
import { SeededRng } from "../rng/seeded";
import { captureAbilityFactOrigin, captureMatchFactEffects, captureAbilityPlayFact, withoutMatchFactEvidence } from "../events/production";
import { allConditionsPass, resolveActor } from "./conditions";
import { applyEffects, type EffectContext, type EffectPending } from "./effects";
import { ABILITY_CATALOG_VERSION, getAbilityDefinition, getStatusDefinition, supportsAbilitySourceKind, type AbilityRegistry } from "./registry";
import { addAbilityInstance, canConsumeRule, consumeAbilityTriggerTtl, consumeRule, garbageCollectAbilityInstances, isAbilityInstanceExpired } from "./runtime";
import { selectSkillCards } from "./skill-card-selection";
import type { AbilityActor, AbilityDefinition, AbilityDomainEvent, AbilityEventContext, AbilityEffectResult, AbilityInstance, AbilityRuntimeState, AbilityWorld, DecisionAction, PendingAiThreshold, PendingBustCheck, PendingComparison, PendingDefeat, PendingDraw, PendingLoad, PendingTrigger, PendingTurn } from "./types";

const MAX_ABILITY_DEPTH = 16;
export class AbilityResolutionError extends Error {
  readonly chain: readonly string[];
  readonly instanceId?: string;
  readonly definitionId?: string;
  readonly ruleId?: string;
  constructor(message: string, chain: readonly string[] = [], detail: { instanceId?: string; definitionId?: string; ruleId?: string } = {}) { super(message); this.name = "AbilityResolutionError"; this.chain = chain; this.instanceId = detail.instanceId; this.definitionId = detail.definitionId; this.ruleId = detail.ruleId; }
}

interface CollectedRule { readonly instance: AbilityInstance; readonly rule: import("./types").AbilityRule; readonly index: number; readonly status?: import("./types").AbilityStatus; }
function collect(runtime: AbilityRuntimeState, trigger: AbilityEventContext["trigger"], directInstanceId?: string, registry?: AbilityRegistry): CollectedRule[] {
  const rules: CollectedRule[] = [];
  for (const instance of runtime.instances) {
    if (isAbilityInstanceExpired(instance)) continue;
    if ((trigger === "on-ability-played" || trigger === "on-ability-gained") && instance.instanceId !== directInstanceId) continue;
    const definition = getAbilityDefinition(instance.definitionId, registry, instance.level);
    if (!definition) throw new AbilityResolutionError(`Unknown ability definition: ${instance.definitionId}`, [], { instanceId: instance.instanceId, definitionId: instance.definitionId, ruleId: "definition-missing" });
    if (!supportsAbilitySourceKind(definition, instance.kind)) throw new AbilityResolutionError(`Ability instance kind ${instance.kind} is not supported by ${instance.definitionId}`, [], { instanceId: instance.instanceId, definitionId: instance.definitionId, ruleId: "source-kind-mismatch" });
    definition.rules.forEach((rule, index) => { if (rule.trigger === trigger) rules.push({ instance, rule, index }); });
  }
  for (const status of runtime.statuses) {
    const definition = getStatusDefinition(status.statusDefinitionId, registry);
    if (!definition) throw new AbilityResolutionError(`Unknown status definition: ${status.statusDefinitionId}`, [], { instanceId: status.sourceInstanceId, definitionId: status.statusDefinitionId, ruleId: "status-definition-missing" });
    const source = runtime.instances.find((instance) => instance.instanceId === status.sourceInstanceId);
    if (!source) throw new AbilityResolutionError(`Status source instance is missing: ${status.sourceInstanceId}`, [], { instanceId: status.sourceInstanceId, definitionId: status.statusDefinitionId, ruleId: "status-source-missing" });
    const sourceDefinition = getAbilityDefinition(source.definitionId, registry, source.level);
    if (!sourceDefinition || !supportsAbilitySourceKind(sourceDefinition, source.kind)) throw new AbilityResolutionError(`Status source instance kind ${source.kind} is not supported by ${source.definitionId}`, [], { instanceId: source.instanceId, definitionId: source.definitionId, ruleId: "source-kind-mismatch" });
    definition.rules.forEach((rule, index) => { if (rule.trigger === trigger) rules.push({ instance: source, rule, index, status }); });
  }
  return rules.sort((left, right) => (left.rule.priority ?? 0) - (right.rule.priority ?? 0) || left.instance.createdAtSequence - right.instance.createdAtSequence || left.index - right.index);
}

export interface AbilityResolutionInput { readonly owners?: readonly AbilityActor[]; readonly world: AbilityWorld; readonly runtime: AbilityRuntimeState; readonly event: AbilityEventContext; readonly pendingTurn?: PendingTurn; readonly pendingAiThreshold?: PendingAiThreshold; readonly pendingDraw?: PendingDraw; readonly pendingLoad?: PendingLoad; readonly pendingBust?: PendingBustCheck; readonly pendingTrigger?: PendingTrigger; readonly pendingComparison?: PendingComparison; readonly pendingDefeat?: PendingDefeat; readonly directInstanceId?: string; readonly chanceMode?: "roll" | "assume-success"; readonly depth?: number; readonly chain?: readonly string[]; readonly registry?: AbilityRegistry; readonly bustLimitFor?: EffectContext["bustLimitFor"]; readonly forecastHitBust?: EffectContext["forecastHitBust"]; readonly previewComparison?: EffectContext["previewComparison"]; readonly actionWindowFor?: (owner: AbilityActor, world: AbilityWorld) => import("./types").ActionWindow | undefined; }
export interface AbilityResolution extends AbilityEffectResult { readonly triggered: readonly string[]; }

export interface PlayAbilityInput extends Omit<AbilityResolutionInput, "event" | "directInstanceId"> {
  readonly roundHitCounts?: AbilityEventContext["roundHitCounts"];
  readonly instanceId: string;
  readonly owner: "player" | "opponent";
  readonly window: "owner-turn" | "owner-roulette-reaction";
}

function catalogMatches(runtime: AbilityRuntimeState, registry?: AbilityRegistry): boolean {
  return runtime.catalogVersion === (registry?.catalogVersion ?? ABILITY_CATALOG_VERSION);
}

function cardAndInstanceAgree(card: AbilityWorld["cards"][number] | undefined, instance: AbilityInstance | undefined): boolean {
  return !card || !instance || (card.definitionId === instance.definitionId && card.owner === instance.owner && card.kind === instance.kind && (card.level ?? 1) === (instance.level ?? 1));
}

function remainingActionUses(definition: AbilityDefinition, instance: AbilityInstance | undefined): number {
  return instance?.remainingUses ?? (definition.activation.type === "action" ? definition.activation.uses ?? 1 : 1);
}

export function isAbilityBlockedByStatus(world: AbilityWorld, owner: "player" | "opponent", definition: AbilityDefinition, registry?: AbilityRegistry): boolean {
  return world.statuses.some((status) => status.owner === owner && status.stacks > 0 && (getStatusDefinition(status.statusDefinitionId, registry)?.blocksAbilityTags ?? []).some((tag) => definition.tags.includes(tag)));
}

/** Hit/Stand restrictions belong to the affected actor, independently of ability-tag blocking. */
export function isActionBlockedByStatus(world: AbilityWorld, owner: AbilityActor, action: DecisionAction, registry?: AbilityRegistry): boolean {
  return world.statuses.some((status) => status.owner === owner && status.stacks > 0
    && getStatusDefinition(status.statusDefinitionId, registry)?.blocksActions?.includes(action));
}

export function canPlayAbility(input: PlayAbilityInput): boolean {
  try {
    if (!catalogMatches(input.runtime, input.registry)) return false;
    const card = input.world.cards.find((entry) => entry.instanceId === input.instanceId);
    const instance = input.runtime.instances.find((entry) => entry.instanceId === input.instanceId);
    if (!cardAndInstanceAgree(card, instance)) return false;
    const source = card ?? instance;
    if (!source || source.owner !== input.owner) return false;
    const definition = getAbilityDefinition(source.definitionId, input.registry, source.level);
    if (!definition || !supportsAbilitySourceKind(definition, source.kind) || definition.activation.type !== "action" || !definition.activation.windows.includes(input.window)) return false;
    if (definition.activation.consume === "card" && !card) return false;
    const uses = remainingActionUses(definition, instance);
    if (uses <= 0) return false;
    if (isAbilityBlockedByStatus(input.world, input.owner, definition, input.registry)) return false;
    const ability: AbilityInstance = instance ?? { ...card!, createdAtSequence: input.runtime.sequence + 1, parameters: {}, ...((definition.activation.uses ?? 1) > 1 ? { remainingUses: definition.activation.uses } : {}) };
    const event = { trigger: "on-ability-played" as const, sourceEventId: `ability:${input.instanceId}`, eventActor: input.owner, roundHitCounts: input.roundHitCounts, pendingTurn: input.pendingTurn };
    if (!allConditionsPass(definition.activation.availability, { world: input.world, runtime: input.runtime, ability, event, registry: input.registry, forecastHitBust: input.forecastHitBust, bustLimitFor: input.bustLimitFor, previewComparison: input.previewComparison })) return false;
    // Mirror the real pre-resolution state with a cloned RNG snapshot. This
    // validates effect context, callbacks and targets before exposing an
    // action; the returned state is deliberately discarded.
    const runtime = addAbilityInstance(input.runtime, ability, input.registry);
    const world = definition.activation.consume === "card" && uses === 1
      ? { ...input.world, cards: input.world.cards.filter((entry) => entry.instanceId !== input.instanceId) }
      : input.world;
    const dryRun = resolveAbilityEvent({ ...input, world, runtime, event, directInstanceId: ability.instanceId, chanceMode: "assume-success" });
    return dryRun.triggered.length > 0;
  } catch { return false; }
}

/** Validate and atomically consume a card before resolving its direct rules. */
export function playAbility(input: PlayAbilityInput): AbilityResolution {
  if (!catalogMatches(input.runtime, input.registry)) throw new AbilityResolutionError(`Ability catalog mismatch: runtime=${input.runtime.catalogVersion}, registry=${input.registry?.catalogVersion ?? ABILITY_CATALOG_VERSION}`);
  const card = input.world.cards.find((entry) => entry.instanceId === input.instanceId);
  const instance = input.runtime.instances.find((entry) => entry.instanceId === input.instanceId);
  if (!cardAndInstanceAgree(card, instance)) throw new AbilityResolutionError("Ability card and runtime instance disagree");
  const source = card ?? instance;
  if (!source || source.owner !== input.owner) throw new AbilityResolutionError("Ability card is not owned or is unavailable");
  const definition = getAbilityDefinition(source.definitionId, input.registry, source.level);
  if (!definition || !supportsAbilitySourceKind(definition, source.kind) || definition.activation.type !== "action" || !definition.activation.windows.includes(input.window)) throw new AbilityResolutionError("Ability is not available in this action window");
  if (definition.activation.consume === "card" && !card) throw new AbilityResolutionError("Ability card is not owned or is unavailable");
  const uses = remainingActionUses(definition, instance);
  if (uses <= 0) throw new AbilityResolutionError("Ability card has no remaining uses");
  if (isAbilityBlockedByStatus(input.world, input.owner, definition, input.registry)) throw new AbilityResolutionError("A status blocks this ability tag");
  const ability: AbilityInstance = instance ?? { ...card!, createdAtSequence: input.runtime.sequence + 1, parameters: {}, ...((definition.activation.uses ?? 1) > 1 ? { remainingUses: definition.activation.uses } : {}) };
  const event = { trigger: "on-ability-played" as const, sourceEventId: `ability:${input.instanceId}`, eventActor: input.owner, roundHitCounts: input.roundHitCounts, pendingTurn: input.pendingTurn };
  const availabilityContext = { world: input.world, runtime: input.runtime, ability, event, registry: input.registry };
  if (!allConditionsPass(definition.activation.availability, { ...availabilityContext, forecastHitBust: input.forecastHitBust, bustLimitFor: input.bustLimitFor, previewComparison: input.previewComparison })) throw new AbilityResolutionError("Ability availability conditions are not satisfied");
  const runtime = addAbilityInstance(input.runtime, ability, input.registry);
  const world = definition.activation.consume === "card" && uses === 1 ? { ...input.world, cards: input.world.cards.filter((entry) => entry.instanceId !== input.instanceId) } : input.world;
  const result = resolveAbilityEvent({ ...input, world, runtime, directInstanceId: ability.instanceId, event });
  if (result.triggered.length === 0) {
    if (result.runtime.rng.state !== input.runtime.rng.state) {
      // An eligible probabilistic action can miss without spending the card or a successful-use budget.
      return withAbilityRuleWindows({ ...result, world: input.world, runtime: { ...input.runtime, rng: result.runtime.rng } }, abilityRuleWindows(result));
    }
    throw new AbilityResolutionError("Ability has no triggered direct rules");
  }
  const runtimeAfterUse = definition.activation.consume === "card" && (definition.activation.uses ?? 1) > 1
    ? { ...result.runtime, instances: result.runtime.instances.map((candidate) => candidate.instanceId === ability.instanceId ? { ...candidate, remainingUses: uses - 1 } : candidate) }
    : result.runtime;
  const updatedRuntime = ability.kind === "player-skill" && ability.owner === "player"
    ? { ...runtimeAfterUse, lastPlayedPlayerSkillDefinitionId: ability.definitionId, lastPlayedPlayerSkillLevel: ability.level ?? 1 }
    : runtimeAfterUse;
  const played: AbilityDomainEvent = { type: "ABILITY_PLAYED", ...((ability.level ?? 1) > 1 ? { level: ability.level } : {}), instanceId: ability.instanceId, definitionId: ability.definitionId, owner: ability.owner };
  captureAbilityFactOrigin([played], ability, event);
  captureAbilityPlayFact(played, { before: input.world, after: result.world, usesBefore: uses, roundHitCounts: input.roundHitCounts, consumesCard: definition.activation.consume === "card", primaryDomain: definition.primaryDomain });
  return withAbilityRuleWindows({ ...result, runtime: updatedRuntime, events: [played, ...result.events] },
    abilityRuleWindows(result).map((window, index) => index === 0 ? window : { ...window, eventOffset: window.eventOffset + 1 }));
}

/** Select a usable held active card, then use the normal action transaction. */
function invokeRandomActiveSkill(effect: Extract<import("./types").Effect, { type: "invoke-random-active-skill" }>, context: EffectContext, pending: EffectPending, input: AbilityResolutionInput): AbilityEffectResult {
  const owner = resolveActor(effect.target, context);
  const window = owner && input.actionWindowFor?.(owner, context.world);
  const unchanged = (): AbilityEffectResult => ({ world: context.world, runtime: { ...context.runtime, rng: context.rng.snapshot() }, events: [], pendingTurn: pending.turn, pendingAiThreshold: pending.aiThreshold, pendingDraw: pending.draw, pendingLoad: pending.load, pendingBust: pending.bust, pendingTrigger: pending.trigger, pendingComparison: pending.comparison, pendingDefeat: pending.defeat });
  if (!owner || !window) return unchanged();
  const excluded = new Set([...(input.chain ?? []), context.ability.instanceId]);
  const candidates: PlayAbilityInput[] = [];
  for (const card of selectSkillCards(context.world, owner, effect.filter, input.registry)) {
    const definition = getAbilityDefinition(card.definitionId, input.registry, card.level);
    if (!definition || definition.activation.type !== "action" || excluded.has(card.instanceId)) continue;
    const candidate: PlayAbilityInput = { ...input, owners: undefined, world: context.world, runtime: { ...context.runtime, rng: context.rng.snapshot() }, instanceId: card.instanceId, owner, window, roundHitCounts: context.event.roundHitCounts,
      pendingTurn: pending.turn, pendingAiThreshold: pending.aiThreshold, pendingDraw: pending.draw, pendingLoad: pending.load, pendingBust: pending.bust, pendingTrigger: pending.trigger, pendingComparison: pending.comparison, pendingDefeat: pending.defeat,
      depth: (input.depth ?? 0) + 1, chain: [...(input.chain ?? []), card.instanceId] };
    if (withoutMatchFactEvidence(() => canPlayAbility(candidate))) candidates.push(candidate);
  }
  if (candidates.length === 0) return unchanged();
  const selected = candidates[context.rng.nextInt(candidates.length)]!;
  const played = playAbility({ ...selected, runtime: { ...selected.runtime, rng: context.rng.snapshot() } });
  const after = played.events.some(event => event.type === "ABILITY_PLAYED")
    ? resolveAbilityEvent({ ...selected, world: played.world, runtime: played.runtime, directInstanceId: undefined,
      pendingTurn: played.pendingTurn, pendingAiThreshold: played.pendingAiThreshold, pendingDraw: played.pendingDraw, pendingLoad: played.pendingLoad, pendingBust: played.pendingBust, pendingTrigger: played.pendingTrigger, pendingComparison: played.pendingComparison, pendingDefeat: played.pendingDefeat,
      event: { trigger: "after-ability-played", sourceEventId: `${context.event.sourceEventId}:after-ability:${selected.instanceId}`, eventActor: owner, playedAbilityKind: "player-skill", roundHitCounts: context.event.roundHitCounts } })
    : { ...played, events: [] };
  const world = after.world;
  const runtime = garbageCollectAbilityInstances(after.runtime, world.cards, input.registry);
  return withAbilityRuleWindows({ ...after, world, runtime, gainedAbilities: undefined, acquiredCards: undefined, events: [...played.events, ...after.events] },
    [...abilityRuleWindows(played), ...abilityRuleWindows(after).map(occurrence => ({ ...occurrence, eventOffset: played.events.length + occurrence.eventOffset }))]);
}

export function resolveAbilityEvent(input: AbilityResolutionInput): AbilityResolution {
  const depth = input.depth ?? 0;
  if (depth > MAX_ABILITY_DEPTH) throw new AbilityResolutionError("Ability event nesting depth exceeded 16", input.chain ?? []);
  if (!catalogMatches(input.runtime, input.registry)) throw new AbilityResolutionError(`Ability catalog mismatch: runtime=${input.runtime.catalogVersion}, registry=${input.registry?.catalogVersion ?? ABILITY_CATALOG_VERSION}`, input.chain ?? []);
  let world = input.world;
  // Event-scoped limits are keyed by sourceEventId; reducers clear old event
  // keys opportunistically while turn/round scopes clear at their boundaries.
  let runtime = input.runtime;
  world = { ...world, statuses: runtime.statuses };
  let pendingTurn = input.pendingTurn;
  let pendingAiThreshold = input.pendingAiThreshold;
  let pendingDraw = input.pendingDraw;
  let pendingLoad = input.pendingLoad;
  let pendingBust = input.pendingBust;
  let pendingTrigger = input.pendingTrigger;
  let pendingComparison = input.pendingComparison;
  let pendingDefeat = input.pendingDefeat;
  const event = input.event.initialHandCardCounts ? input.event : {
    ...input.event,
    initialHandCardCounts: { player: input.world.hands.player.cards.length, opponent: input.world.hands.opponent.cards.length }
  };
  let events: readonly AbilityDomainEvent[] = [];
  const windows: AbilityRuleWindow[] = [{ event: { ...event, pendingTurn, pendingAiThreshold,
    pendingDraw, pendingLoad, pendingBust, pendingTrigger, pendingComparison, pendingDefeat }, eventOffset: 0 }];
  const triggered: string[] = [];
  for (const entry of collect(runtime, event.trigger, input.directInstanceId, input.registry)) {
    if (input.owners && !input.owners.includes(entry.instance.owner)) continue;
    const liveInstance = runtime.instances.find((instance) => instance.instanceId === entry.instance.instanceId);
    if (!liveInstance || isAbilityInstanceExpired(liveInstance)) continue;
    // Collected status rules are a snapshot. Removed or replaced status instances
    // must not execute later in this event, even if their source ability survives.
    if (entry.status && !runtime.statuses.some(status => status.stacks > 0
      && status.statusDefinitionId === entry.status!.statusDefinitionId && status.owner === entry.status!.owner
      && status.sourceInstanceId === entry.status!.sourceInstanceId && status.createdAtSequence === entry.status!.createdAtSequence)) continue;
    const counterRuleId = entry.status
      ? `status[${encodeURIComponent(entry.status.statusDefinitionId)},${entry.status.owner},${entry.status.createdAtSequence}]:${entry.rule.id}`
      : entry.rule.id;
    const context = { world, runtime, ability: liveInstance, registry: input.registry, event: { ...event, statusOwner: entry.status?.owner, pendingTurn, pendingAiThreshold, pendingDraw, pendingBust, pendingDefeat, pendingComparison }, forecastHitBust: input.forecastHitBust, bustLimitFor: input.bustLimitFor, previewComparison: input.previewComparison };
    try {
      // A rescue is a single claim on this defeat. Skip the whole competing
      // transaction before costs, chance RNG, TTL or counters can be consumed.
      if (event.trigger === "before-defeat" && pendingDefeat && entry.rule.effects.some(effect => effect.type === "prevent-pending-defeat"
        && (pendingDefeat!.prevented || resolveActor(effect.target, context) !== pendingDefeat!.actor))) continue;
      if (!allConditionsPass(entry.rule.conditions, context)) continue;
      if (!canConsumeRule(runtime, entry.instance.instanceId, counterRuleId, entry.rule.limit, event.sourceEventId)) continue;
      const abilityRng = SeededRng.fromSnapshot(runtime.rng);
      if (input.chanceMode !== "assume-success" && entry.rule.chance !== undefined && abilityRng.next() >= entry.rule.chance) {
        runtime = { ...runtime, rng: abilityRng.snapshot() };
        continue;
      }
      const result = applyEffects(entry.rule.effects, { ...context, rng: abilityRng, runtime, registry: input.registry, ruleId: entry.rule.id,
        invokeRandomActiveSkill: (effect, invocationContext, invocationPending) => invokeRandomActiveSkill(effect, invocationContext, invocationPending, input) }, { turn: pendingTurn, aiThreshold: pendingAiThreshold, draw: pendingDraw, load: pendingLoad, bust: pendingBust, trigger: pendingTrigger, comparison: pendingComparison, defeat: pendingDefeat });
      windows.push(...abilityRuleWindows(result).map(occurrence => ({ ...occurrence, eventOffset: events.length + occurrence.eventOffset })));
      world = result.world;
      pendingTurn = result.pendingTurn;
      pendingAiThreshold = result.pendingAiThreshold;
      pendingDraw = result.pendingDraw;
      pendingLoad = result.pendingLoad;
      pendingBust = result.pendingBust;
      pendingTrigger = result.pendingTrigger;
      pendingComparison = result.pendingComparison;
      pendingDefeat = result.pendingDefeat;
      runtime = entry.rule.effects.some(effect => effect.type === "invoke-random-active-skill") ? result.runtime : { ...result.runtime, rng: abilityRng.snapshot() };
      // An empty or blocked invocation pool does not spend trigger limits or
      // announce a successful cast. Probability misses retain their RNG advance.
      if (entry.rule.effects.every(effect => effect.type === "invoke-random-active-skill") && !result.events.some(effectEvent => effectEvent.type === "ABILITY_PLAYED")) continue;
      if (runtime.instances.some(instance => instance.instanceId === entry.instance.instanceId)) runtime = consumeRule(runtime, entry.instance.instanceId, counterRuleId, entry.rule.limit, event.sourceEventId);
      const ttl = consumeAbilityTriggerTtl(runtime, world.cards, entry.instance.instanceId, input.registry);
      runtime = ttl.runtime;
      world = { ...world, cards: ttl.cards, statuses: ttl.runtime.statuses };
      const completed: AbilityDomainEvent[] = [
        { type: "ABILITY_TRIGGERED", ...((entry.instance.level ?? 1) > 1 ? { level: entry.instance.level } : {}), instanceId: entry.instance.instanceId, definitionId: entry.instance.definitionId, ruleId: entry.rule.id, owner: entry.instance.owner },
        ...ttl.expiredStatuses.map((status) => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "expired" as const })),
        ...ttl.expired.map((instance) => ({ type: "ABILITY_EXPIRED" as const, ...((instance.level ?? 1) > 1 ? { level: instance.level } : {}), instanceId: instance.instanceId, definitionId: instance.definitionId, owner: instance.owner, reason: "triggers" as const }))
      ];
      captureAbilityFactOrigin(completed, entry.instance, event, entry.rule.id);
      captureMatchFactEffects(completed[0], result);
      events = [...events, ...result.events, ...completed];
      triggered.push(`${entry.instance.instanceId}:${entry.rule.id}`);
      for (const instance of result.gainedAbilities ?? []) {
        const gained = resolveAbilityEvent({ ...input, world, runtime, directInstanceId: instance.instanceId, depth: depth + 1,
          event: { ...event, trigger: "on-ability-gained", sourceEventId: `${event.sourceEventId}:gained:${instance.instanceId}`, eventActor: instance.owner },
          pendingTurn, pendingAiThreshold, pendingDraw, pendingLoad, pendingBust, pendingTrigger, pendingComparison, pendingDefeat });
        windows.push(...abilityRuleWindows(gained).map(window => ({ ...window, eventOffset: events.length + window.eventOffset })));
        world = gained.world; runtime = gained.runtime;
        pendingTurn = gained.pendingTurn; pendingAiThreshold = gained.pendingAiThreshold; pendingDraw = gained.pendingDraw;
        pendingLoad = gained.pendingLoad; pendingBust = gained.pendingBust; pendingTrigger = gained.pendingTrigger; pendingComparison = gained.pendingComparison; pendingDefeat = gained.pendingDefeat;
        events = [...events, ...gained.events]; triggered.push(...gained.triggered);
      }
      for (const { actor, card } of result.acquiredCards ?? []) {
        const acquiredCards = [card];
        const acquired = resolveAbilityEvent({ ...input, world, runtime, directInstanceId: undefined, depth: depth + 1,
          event: { ...event, trigger: "after-card-acquired", sourceEventId: `${event.sourceEventId}:${entry.instance.instanceId}:${entry.rule.id}:acquired:${actor}:${card.id}`, eventActor: actor, acquiredCards },
          pendingTurn, pendingAiThreshold, pendingDraw, pendingLoad, pendingBust, pendingTrigger, pendingComparison, pendingDefeat });
        windows.push(...abilityRuleWindows(acquired).map(window => ({ ...window, eventOffset: events.length + window.eventOffset })));
        world = acquired.world; runtime = acquired.runtime;
        pendingTurn = acquired.pendingTurn; pendingAiThreshold = acquired.pendingAiThreshold; pendingDraw = acquired.pendingDraw;
        pendingLoad = acquired.pendingLoad; pendingBust = acquired.pendingBust; pendingTrigger = acquired.pendingTrigger; pendingComparison = acquired.pendingComparison; pendingDefeat = acquired.pendingDefeat;
        events = [...events, ...acquired.events]; triggered.push(...acquired.triggered);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AbilityResolutionError(`${entry.instance.instanceId}/${entry.rule.id}: ${reason}`, [...triggered, `${entry.instance.instanceId}:${entry.rule.id}`], { instanceId: entry.instance.instanceId, definitionId: entry.instance.definitionId, ruleId: entry.rule.id });
    }
  }
  return withAbilityRuleWindows({ world, pendingTurn, pendingAiThreshold, pendingDraw, pendingLoad, pendingBust, pendingTrigger, pendingComparison, pendingDefeat, runtime, events, triggered }, windows);
}

export { MAX_ABILITY_DEPTH };
