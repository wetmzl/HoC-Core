import { displayActor, displayKey } from "./displays";
import type { RngSnapshot } from "../rng/seeded";
import { ABILITY_CATALOG_VERSION } from "./registry";
import type { AbilityActor, AbilityInstance, AbilityRuntimeState, AbilityStatus, RuleLimit, SkillCardInstance, StatusDuration } from "./types";
import type { AbilityRegistry } from "./registry";
import { getAbilityDefinition } from "./registry";

export function createAbilityRuntime(rng: RngSnapshot, catalogVersion: string = ABILITY_CATALOG_VERSION): AbilityRuntimeState {
  return { displays: [], instances: [], statuses: [], counters: {}, sequence: 0, catalogVersion, rng, lastPlayedPlayerSkillDefinitionId: null };
}

export function addAbilityInstance(runtime: AbilityRuntimeState, instance: AbilityInstance, registry?: AbilityRegistry): AbilityRuntimeState {
  if (runtime.instances.some((entry) => entry.instanceId === instance.instanceId)) return runtime;
  const definition = registry?.definitionsById[instance.definitionId] ?? getAbilityDefinition(instance.definitionId);
  const existing = new Set(runtime.displays.map(displayKey));
  const displays = (definition?.displays ?? []).map((display) => ({
    definitionId: instance.definitionId, displayId: display.id, owner: instance.owner,
    target: displayActor(display.target, instance.owner), parameters: { ...instance.parameters }, registeredAtSequence: instance.createdAtSequence
  })).filter((display) => !existing.has(displayKey(display)));
  return { ...runtime, displays: [...runtime.displays, ...displays], instances: [...runtime.instances, instance], sequence: Math.max(runtime.sequence, instance.createdAtSequence) };
}

export function isAbilityInstanceExpired(instance: AbilityInstance): boolean {
  return instance.ttl?.remaining === 0;
}

interface TtlAdvanceResult {
  readonly runtime: AbilityRuntimeState;
  readonly cards: readonly SkillCardInstance[];
  readonly expired: readonly AbilityInstance[];
  readonly expiredStatuses: readonly AbilityStatus[];
}

function decrementAbilityTtl(
  runtime: AbilityRuntimeState,
  cards: readonly SkillCardInstance[],
  instanceId: string,
  type: "rounds" | "triggers",
  registry?: AbilityRegistry
): TtlAdvanceResult {
  const instance = runtime.instances.find((candidate) => candidate.instanceId === instanceId);
  if (!instance) return { runtime, cards, expired: [], expiredStatuses: [] };
  const definition = registry?.definitionsById[instance.definitionId] ?? getAbilityDefinition(instance.definitionId);
  if (!definition?.ttl || definition.ttl.type !== type) return { runtime, cards, expired: [], expiredStatuses: [] };
  const current = instance.ttl ?? { type: definition.ttl.type, remaining: definition.ttl.amount };
  if (current.type !== definition.ttl.type) throw new Error(`Ability TTL kind mismatch: ${instance.definitionId}`);
  if (current.remaining <= 0) return { runtime, cards, expired: [], expiredStatuses: [] };
  const ttl = { ...current, remaining: current.remaining - 1 };
  const updated = { ...instance, ttl };
  const expiredStatuses = ttl.remaining === 0 ? runtime.statuses.filter((status) => status.sourceInstanceId === instanceId) : [];
  return {
    runtime: {
      ...runtime,
      instances: runtime.instances.map((candidate) => candidate.instanceId === instanceId ? updated : candidate),
      statuses: expiredStatuses.length > 0 ? runtime.statuses.filter((status) => status.sourceInstanceId !== instanceId) : runtime.statuses
    },
    cards: ttl.remaining === 0 ? cards.filter((card) => card.instanceId !== instanceId) : cards,
    expired: ttl.remaining === 0 ? [updated] : [],
    expiredStatuses
  };
}

export function consumeAbilityTriggerTtl(runtime: AbilityRuntimeState, cards: readonly SkillCardInstance[], instanceId: string, registry?: AbilityRegistry): TtlAdvanceResult {
  return decrementAbilityTtl(runtime, cards, instanceId, "triggers", registry);
}

/** Decrements round TTL after on-round-end has resolved, so the current round counts as one full active round. */
export function advanceRoundAbilityTtls(runtime: AbilityRuntimeState, cards: readonly SkillCardInstance[], registry?: AbilityRegistry): TtlAdvanceResult {
  let nextRuntime = runtime;
  let nextCards = cards;
  const expired: AbilityInstance[] = [];
  const expiredStatuses: AbilityStatus[] = [];
  for (const instance of runtime.instances) {
    const result = decrementAbilityTtl(nextRuntime, nextCards, instance.instanceId, "rounds", registry);
    nextRuntime = result.runtime;
    nextCards = result.cards;
    expired.push(...result.expired);
    expiredStatuses.push(...result.expiredStatuses);
  }
  return { runtime: nextRuntime, cards: nextCards, expired, expiredStatuses };
}

export function addAbilityStatus(runtime: AbilityRuntimeState, status: AbilityStatus): AbilityRuntimeState {
  return { ...runtime, statuses: [...runtime.statuses, status], sequence: Math.max(runtime.sequence, status.createdAtSequence) };
}

export function counterKey(instanceId: string, ruleId: string, scope: "event" | "turn" | "round" | "match", eventId?: string): string { return `${instanceId}:${ruleId}:${scope}${scope === "event" && eventId ? `:${eventId}` : ""}`; }
export function getCounter(runtime: AbilityRuntimeState, key: string): number { return runtime.counters[key] ?? 0; }
export function incrementCounter(runtime: AbilityRuntimeState, key: string): AbilityRuntimeState { return { ...runtime, counters: { ...runtime.counters, [key]: getCounter(runtime, key) + 1 } }; }
export function canConsumeRule(runtime: AbilityRuntimeState, instanceId: string, ruleId: string, limit: RuleLimit | undefined, eventId?: string): boolean {
  if (!limit) return true;
  return (["perEvent", "perTurn", "perRound", "perMatch"] as const).every((name) => {
    const max = limit[name];
    return max === undefined || getCounter(runtime, counterKey(instanceId, ruleId, name.slice(3).toLowerCase() as "event" | "turn" | "round" | "match", eventId)) < max;
  });
}
export function consumeRule(runtime: AbilityRuntimeState, instanceId: string, ruleId: string, limit: RuleLimit | undefined, eventId?: string): AbilityRuntimeState {
  if (!limit) return runtime;
  let next = runtime;
  for (const [name, max] of Object.entries(limit)) {
    if (max === undefined) continue;
    const scope = name.slice(3).toLowerCase() as "event" | "turn" | "round" | "match";
    next = incrementCounter(next, counterKey(instanceId, ruleId, scope, eventId));
  }
  return next;
}
export function clearCounters(runtime: AbilityRuntimeState, scope: "event" | "turn" | "round" | "match"): AbilityRuntimeState {
  const marker = `:${scope}`;
  return { ...runtime, counters: Object.fromEntries(Object.entries(runtime.counters).filter(([key]) => !(key.includes(`${marker}:`) || key.endsWith(marker)))) };
}
/** Event limits are transaction-local; discard their keys once the event is committed. */
export function clearEventCounters(runtime: AbilityRuntimeState, sourceEventId: string): AbilityRuntimeState {
  const suffix = `:event:${sourceEventId}`;
  return { ...runtime, counters: Object.fromEntries(Object.entries(runtime.counters).filter(([key]) => !key.endsWith(suffix))) };
}
export function expireStatuses(runtime: AbilityRuntimeState, duration: StatusDuration): AbilityRuntimeState {
  return { ...runtime, statuses: runtime.statuses.filter((status) => status.duration !== duration) };
}

/** Expire statuses scoped to the affected actor's next completed Hit or Stand. */
export function expireOwnerActionStatuses(runtime: AbilityRuntimeState, owner: AbilityActor): AbilityRuntimeState {
  return { ...runtime, statuses: runtime.statuses.filter((status) => status.duration !== "until-owner-action" || status.owner !== owner) };
}

/** Remove consumed action instances while retaining cards, status sources and passive mechanics. */
export function garbageCollectAbilityInstances(runtime: AbilityRuntimeState, cards: readonly SkillCardInstance[], registry?: AbilityRegistry): AbilityRuntimeState {
  const cardIds = new Set(cards.map((card) => card.instanceId));
  const statusSources = new Set(runtime.statuses.map((status) => status.sourceInstanceId));
  const instances = runtime.instances.filter((instance) => {
    if (isAbilityInstanceExpired(instance)) return statusSources.has(instance.instanceId);
    if (cardIds.has(instance.instanceId) || statusSources.has(instance.instanceId)) return true;
    const definition = registry?.definitionsById[instance.definitionId] ?? getAbilityDefinition(instance.definitionId);
    if (!definition) return true;
    return definition.activation.type !== "action" || definition.activation.consume === "none";
  });
  if (instances.length === runtime.instances.length) return runtime;
  const retainedIds = new Set(instances.map((instance) => instance.instanceId));
  const knownIds = runtime.instances.map((instance) => instance.instanceId).sort((left, right) => right.length - left.length);
  const counters = Object.fromEntries(Object.entries(runtime.counters).filter(([key]) => {
    const ownerId = knownIds.find((instanceId) => key.startsWith(`${instanceId}:`));
    return ownerId === undefined || retainedIds.has(ownerId);
  }));
  return { ...runtime, instances, counters };
}
