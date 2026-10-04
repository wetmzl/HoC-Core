import { AbilityDefinitionSchema, StatusDefinitionSchema, validateBinding } from "./schema";
import type { AbilityBinding, AbilityDefinition, AbilityInstance, AbilitySourceKind, AiSkillAbilityDefinition, PlayerSkillAbilityDefinition, StatusDefinition, TalentAbilityDefinition } from "./types";

export const ABILITY_CATALOG_VERSION = "abilities-v35" as const;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateRuleReferences(definition: AbilityDefinition | StatusDefinition, abilityIds: ReadonlySet<string>, statusIds: ReadonlySet<string>): void {
  const rules = definition.rules;
  const ids = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (ids.has(rule.id)) throw new Error(`Duplicate rule id ${rule.id} in ${definition.id} at index ${index}`);
    ids.add(rule.id);
    const visit = (value: unknown, path: string): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.type === "parameter" && typeof record.key === "string" && !(definition as AbilityDefinition).parameters?.[record.key]) throw new Error(`Unknown parameter ${record.key} in ${definition.id}.${rule.id}`);
      if (record.type === "owner-has-card" && typeof record.abilityId === "string" && !abilityIds.has(record.abilityId)) throw new Error(`Unknown ability ${record.abilityId} in ${definition.id}.${rule.id}`);
      if ((record.type === "add-status" || record.type === "set-status-suit-to-hand-majority" || record.type === "set-status-stacks" || record.type === "remove-status" || record.type === "status-present" || record.type === "status-stacks" || record.type === "hand-card-status-suit-count") && typeof record.statusDefinitionId === "string" && !statusIds.has(record.statusDefinitionId)) throw new Error(`Unknown status ${record.statusDefinitionId} in ${definition.id}.${rule.id}`);
      for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`);
    };
    visit(rule, rule.id);
  }
  if ("activation" in definition) {
    const visitDisplay = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "parameter" && typeof record.key === "string" && !definition.parameters?.[record.key]) throw new Error(`Unknown display parameter ${record.key} in ${definition.id}`);
      if (typeof record.statusDefinitionId === "string" && !statusIds.has(record.statusDefinitionId)) throw new Error(`Unknown display status ${record.statusDefinitionId} in ${definition.id}`);
      Object.values(record).forEach(visitDisplay);
    };
    visitDisplay(definition.displays);
    const visitActivation = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.type === "parameter" && typeof record.key === "string" && !definition.parameters?.[record.key]) throw new Error(`Unknown parameter ${record.key} in ${definition.id}.activation`);
      if (record.type === "owner-has-card" && typeof record.abilityId === "string" && !abilityIds.has(record.abilityId)) throw new Error(`Unknown ability ${record.abilityId} in ${definition.id}.activation`);
      if ((record.type === "status-present" || record.type === "status-stacks") && typeof record.statusDefinitionId === "string" && !statusIds.has(record.statusDefinitionId)) throw new Error(`Unknown status ${record.statusDefinitionId} in ${definition.id}.activation`);
      for (const child of Object.values(record)) visitActivation(child);
    };
    visitActivation(definition.activation);
  }
}
export interface AbilityRegistry {
  readonly catalogVersion: string;
  readonly definitions: readonly AbilityDefinition[];
  readonly statuses: readonly StatusDefinition[];
  readonly definitionsById: Readonly<Record<string, AbilityDefinition>>;
  readonly statusesById: Readonly<Record<string, StatusDefinition>>;
}

function registryFrom(definitionValues: readonly unknown[], statusValues: readonly unknown[], catalogVersion: string): AbilityRegistry {
  const parsedDefinitions = definitionValues.map((value) => deepFreeze(AbilityDefinitionSchema.parse(value) as AbilityDefinition));
  const parsedStatuses = statusValues.map((value) => deepFreeze(StatusDefinitionSchema.parse(value) as StatusDefinition));
  if (new Set(parsedDefinitions.map((definition) => definition.id)).size !== parsedDefinitions.length) throw new Error("Duplicate ability definition id");
  if (new Set(parsedStatuses.map((definition) => definition.id)).size !== parsedStatuses.length) throw new Error("Duplicate status definition id");
  const abilityIds = new Set(parsedDefinitions.map((definition) => definition.id));
  const statusIds = new Set(parsedStatuses.map((status) => status.id));
  for (const definition of [...parsedDefinitions, ...parsedStatuses]) validateRuleReferences(definition, abilityIds, statusIds);
  return Object.freeze({
    catalogVersion,
    definitions: Object.freeze(parsedDefinitions),
    statuses: Object.freeze(parsedStatuses),
    definitionsById: Object.freeze(Object.fromEntries(parsedDefinitions.map((definition) => [definition.id, definition]))),
    statusesById: Object.freeze(Object.fromEntries(parsedStatuses.map((definition) => [definition.id, definition])))
  });
}

const emptyRegistry = registryFrom([], [], ABILITY_CATALOG_VERSION);
export let ABILITY_REGISTRY: AbilityRegistry = emptyRegistry;
export let ABILITY_DEFINITIONS: readonly AbilityDefinition[] = emptyRegistry.definitions;
export let PLAYER_SKILL_ABILITY_DEFINITIONS: readonly PlayerSkillAbilityDefinition[] = Object.freeze(ABILITY_DEFINITIONS.filter((definition): definition is PlayerSkillAbilityDefinition => definition.sourceKind === "player-skill"));
export let AI_SKILL_ABILITY_DEFINITIONS: readonly AiSkillAbilityDefinition[] = Object.freeze(ABILITY_DEFINITIONS.filter((definition): definition is AiSkillAbilityDefinition => definition.sourceKind === "ai-skill"));
export let TALENT_ABILITY_DEFINITIONS: readonly TalentAbilityDefinition[] = Object.freeze(ABILITY_DEFINITIONS.filter((definition): definition is TalentAbilityDefinition => definition.sourceKind === "talent"));
export let STATUS_DEFINITIONS: readonly StatusDefinition[] = emptyRegistry.statuses;
export let ABILITY_DEFINITIONS_BY_ID: Readonly<Record<string, AbilityDefinition>> = emptyRegistry.definitionsById;
export let STATUS_DEFINITIONS_BY_ID: Readonly<Record<string, StatusDefinition>> = emptyRegistry.statusesById;
const registryListeners = new Set<(registry: AbilityRegistry) => void>();

export function subscribeAbilityRegistry(listener: (registry: AbilityRegistry) => void): () => void {
  registryListeners.add(listener);
  listener(ABILITY_REGISTRY);
  return () => registryListeners.delete(listener);
}

export function installAbilityRegistry(definitionValues: readonly unknown[], statusValues: readonly unknown[], catalogVersion: string): AbilityRegistry {
  if (catalogVersion !== ABILITY_CATALOG_VERSION) throw new Error(`Unsupported ability catalog version: ${catalogVersion}`);
  const registry = registryFrom(definitionValues, statusValues, catalogVersion);
  ABILITY_REGISTRY = registry;
  ABILITY_DEFINITIONS = registry.definitions;
  PLAYER_SKILL_ABILITY_DEFINITIONS = Object.freeze(registry.definitions.filter((definition): definition is PlayerSkillAbilityDefinition => definition.sourceKind === "player-skill"));
  AI_SKILL_ABILITY_DEFINITIONS = Object.freeze(registry.definitions.filter((definition): definition is AiSkillAbilityDefinition => definition.sourceKind === "ai-skill"));
  TALENT_ABILITY_DEFINITIONS = Object.freeze(registry.definitions.filter((definition): definition is TalentAbilityDefinition => definition.sourceKind === "talent"));
  STATUS_DEFINITIONS = registry.statuses;
  ABILITY_DEFINITIONS_BY_ID = registry.definitionsById;
  STATUS_DEFINITIONS_BY_ID = registry.statusesById;
  for (const listener of registryListeners) listener(registry);
  return registry;
}

/** Build an isolated registry for tests or an expansion pack without touching the global catalog. */
export function createAbilityRegistry(extraDefinitions: readonly unknown[] = [], extraStatuses: readonly unknown[] = [], catalogVersion: string = ABILITY_CATALOG_VERSION): AbilityRegistry {
  return registryFrom([...ABILITY_DEFINITIONS, ...extraDefinitions], [...STATUS_DEFINITIONS, ...extraStatuses], catalogVersion);
}

/** Validates a complete candidate catalog without reading or mutating the installed globals. */
export function createStandaloneAbilityRegistry(definitions: readonly unknown[], statuses: readonly unknown[], catalogVersion: string = ABILITY_CATALOG_VERSION): AbilityRegistry {
  return registryFrom(definitions, statuses, catalogVersion);
}

export function getAbilityDefinition(id: string): AbilityDefinition | undefined { return ABILITY_DEFINITIONS_BY_ID[id]; }
export function getStatusDefinition(id: string): StatusDefinition | undefined { return STATUS_DEFINITIONS_BY_ID[id]; }

export function supportsAbilitySourceKind(definition: AbilityDefinition, kind: AbilitySourceKind): boolean {
  return definition.sourceKind === kind;
}

export function validateAbilityBinding(binding: unknown, registry?: AbilityRegistry): AbilityBinding {
  const candidate = binding as { definitionId?: unknown };
  if (typeof candidate.definitionId !== "string") throw new Error("Ability binding requires definitionId");
  const definition = registry?.definitionsById[candidate.definitionId] ?? getAbilityDefinition(candidate.definitionId);
  if (!definition) throw new Error(`Unknown ability definition: ${candidate.definitionId}`);
  return validateBinding(binding, definition) as AbilityBinding;
}

export function instantiateAbility(binding: AbilityBinding, owner: "player" | "opponent", instanceId: string, createdAtSequence: number, registry?: AbilityRegistry, sourceKind: AbilitySourceKind = "player-skill"): AbilityInstance {
  const valid = validateAbilityBinding(binding, registry);
  const definition = registry?.definitionsById[valid.definitionId] ?? getAbilityDefinition(valid.definitionId);
  if (!definition) throw new Error(`Unknown ability definition: ${valid.definitionId}`);
  if (!supportsAbilitySourceKind(definition, sourceKind)) throw new Error(`Ability definition ${definition.id} does not support ${sourceKind}`);
  const ttl = definition.ttl ? Object.freeze({ type: definition.ttl.type, remaining: definition.ttl.amount }) : undefined;
  const remainingUses = definition.activation.type === "action" && definition.activation.consume === "card" && (definition.activation.uses ?? 1) > 1
    ? definition.activation.uses
    : undefined;
  return Object.freeze({ kind: sourceKind, definitionId: valid.definitionId, owner, instanceId, createdAtSequence, parameters: Object.freeze({ ...valid.parameters }), ...(ttl ? { ttl } : {}), ...(remainingUses ? { remainingUses } : {}) });
}

export function assertCatalogVersion(version: string): void {
  if (version !== ABILITY_CATALOG_VERSION) throw new Error(`Unsupported ability catalog version: ${version}`);
}
