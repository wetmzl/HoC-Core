import { addAbilityInstance } from "./abilities/runtime";
import { getAbilityDefinition, instantiateAbility, validateAbilityBinding } from "./abilities/registry";
import type { AbilityBinding, AbilityInstance } from "./abilities/types";
import type { MatchState } from "./match/types";

export function isIntrinsicAbility(instance: AbilityInstance): boolean {
  const definition = getAbilityDefinition(instance.definitionId, undefined, instance.level);
  return instance.intrinsic === true || !!(definition?.sourceKind === "player-skill" && definition.hidden && !definition.drop.enabled && definition.activation.type === "automatic");
}
export function removeIntrinsicAbilities(state: MatchState, ids?: readonly string[]): MatchState {
  const removed = state.abilities.instances.filter(instance => isIntrinsicAbility(instance) && (!ids || ids.includes(instance.definitionId)));
  if (!removed.length) return state;
  const instanceIds = new Set(removed.map(instance => instance.instanceId));
  const definitions = new Set(removed.map(instance => instance.definitionId));
  return { ...state, abilities: { ...state.abilities,
    instances: state.abilities.instances.filter(instance => !instanceIds.has(instance.instanceId)),
    statuses: state.abilities.statuses.filter(status => !instanceIds.has(status.sourceInstanceId)),
    displays: state.abilities.displays.filter(display => !definitions.has(display.definitionId))
  } };
}
export function configureIntrinsicAbility(state: MatchState, binding: AbilityBinding): MatchState {
  if (!binding.enabled) return removeIntrinsicAbilities(state, [binding.definitionId]);
  const definition = getAbilityDefinition(binding.definitionId, undefined, binding.level);
  if (!definition || definition.sourceKind !== "player-skill" || !definition.hidden || definition.drop.enabled || definition.activation.type !== "automatic") return state;
  const existing = state.abilities.instances.find(instance => instance.owner === "player" && instance.definitionId === binding.definitionId && isIntrinsicAbility(instance));
  try {
    const valid = validateAbilityBinding({ ...binding, parameters: { ...existing?.parameters, ...binding.parameters } });
    if (existing) {
      if (existing.intrinsic && (existing.level ?? 1) === (valid.level ?? 1) && JSON.stringify(existing.parameters) === JSON.stringify(valid.parameters)) return state;
      return { ...state, abilities: { ...state.abilities, instances: state.abilities.instances.map(instance => instance === existing ? { ...instance, intrinsic: true, level: valid.level ?? 1, parameters: valid.parameters } : instance) } };
    }
    const sequence = state.abilities.sequence + 1;
    const instance = { ...instantiateAbility(valid, "player", `intrinsic-${sequence}`, sequence), intrinsic: true };
    return { ...state, abilities: addAbilityInstance(state.abilities, instance) };
  } catch { return state; }
}
export function reconcileIntrinsicAbilities(state: MatchState, bindings: readonly AbilityBinding[]): MatchState {
  const selected = new Set(bindings.filter(binding => binding.enabled).map(binding => binding.definitionId));
  const obsolete = state.abilities.instances.filter(instance => isIntrinsicAbility(instance) && !selected.has(instance.definitionId)).map(instance => instance.definitionId);
  return bindings.reduce(configureIntrinsicAbility, removeIntrinsicAbilities(state, obsolete));
}
