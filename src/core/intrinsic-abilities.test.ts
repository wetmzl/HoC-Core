import { afterEach, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "./abilities/registry";
import { configureIntrinsicAbility, reconcileIntrinsicAbilities } from "./intrinsic-abilities";
import { createMatch, gameReducer, reconcileMatchAbilities, getActiveBustLimit } from "./match/reducer";
import { createRuntimeSave } from "../persistence/boot";
import { validateRuntimeSave } from "../persistence/schema";
const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));
const binding = { definitionId: "builtin-debug-control", enabled: true, parameters: {} };
it("validates generic intrinsic parameters and rejects ordinary inventory abilities", () => {
  const state = createMatch("intrinsic-guards");
  expect(configureIntrinsicAbility(state, { ...binding, definitionId: "hunter-instinct" })).toBe(state);
  expect(configureIntrinsicAbility(state, { ...binding, parameters: { unknown: 1 } })).toBe(state);
  const enabled = configureIntrinsicAbility(state, binding);
  expect(enabled.abilities.instances.at(-1)?.intrinsic).toBe(true);
  expect(reconcileIntrinsicAbilities(enabled, [binding])).toBe(enabled);
  expect(gameReducer(state, { type: "INVOKE_INTRINSIC_ABILITY", definitionId: binding.definitionId, parameters: {} })).toBe(state);
  expect(gameReducer(enabled, { type: "INVOKE_INTRINSIC_ABILITY", definitionId: binding.definitionId, parameters: { unknown: 1 } })).toBe(enabled);
});
it("restores an optional package placeholder and removes it before resuming, while rejecting unknown normal abilities", () => {
  const state = createMatch("intrinsic-disabled", { opponentId: "chatgpt", skillDeckIds: [], intrinsicAbilities: [binding] });
  const saved = createRuntimeSave(state);
  installAbilityRegistry(registry.definitions.filter(definition => definition.id !== binding.definitionId), registry.statuses, registry.catalogVersion);
  const restored = validateRuntimeSave(saved).activeMatch;
  const reconciled = reconcileMatchAbilities(restored, []);
  expect(reconciled.abilities.instances).toHaveLength(0);
  expect(reconciled.roulette).toEqual(state.roulette);
  expect(validateRuntimeSave(createRuntimeSave(reconciled)).activeMatch.abilities.instances).toHaveLength(0);
  const normal = { ...saved, activeMatch: { ...state, abilities: { ...state.abilities, instances: state.abilities.instances.map(instance => ({ ...instance, intrinsic: false })) } } };
  expect(() => validateRuntimeSave(normal)).toThrow();
});
it("refreshes cached bust limits when an optional ability is removed from a resumed match", () => {
  const state = createMatch("intrinsic-cache", { opponentId: "chatgpt", skillDeckIds: [], intrinsicAbilities: [binding] });
  const edited = gameReducer(state, { type: "CONFIGURE_INTRINSIC_ABILITY", binding: { ...binding, parameters: { bustBonus: 10 } } });
  expect(getActiveBustLimit(edited, "player")).toBe(31);
  const resumed = reconcileMatchAbilities(edited, []);
  expect(getActiveBustLimit(resumed, "player")).toBe(21);
  expect(resumed.abilities.instances).toHaveLength(0);
});
