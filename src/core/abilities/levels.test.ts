import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, getAbilityDefinition, installAbilityRegistry, instantiateAbility, validateAbilityBinding } from "./registry";
import { AbilityDefinitionSchema } from "./schema";
import { addAbilityInstance, advanceRoundAbilityTtls, createAbilityRuntime } from "./runtime";
import { canPlayAbility, playAbility, resolveAbilityEvent } from "./engine";
import { resolveDisplays } from "./displays";
import { carryPlayerSkills, capturePlayerSkills } from "./carryover";
import { SeededRng } from "../rng/seeded";
import { createMatch } from "../match/reducer";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import type { AbilityWorld } from "./types";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const rule = (amount: number, trigger = "on-ability-played") => ({ id: "apply", trigger, effects: [{ type: "add-skill-draws", target: "owner", amount }] });
const action = {
  id: "example-level-action", name: "中性技能", description: "基础描述", sourceKind: "player-skill", primaryDomain: "gambler",
  tags: ["neutral"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
  activation: { type: "action", windows: ["owner-turn"], consume: "card" }, rules: [rule(1)],
  levels: [{ level: 2, description: "高阶描述", usage: "高阶规则", activation: { type: "action", windows: ["owner-turn"], consume: "card", uses: 3 }, rules: [rule(2)] }]
};
function fixture(level?: number) {
  const registry = createStandaloneAbilityRegistry([action], []);
  const instance = instantiateAbility({ definitionId: action.id, enabled: true, parameters: {}, ...(level === undefined ? {} : { level }) }, "player", "card", 1, registry);
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("levels").snapshot()), instance, registry);
  const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [{ kind: "player-skill", definitionId: action.id, level: instance.level, owner: "player", instanceId: "card" }], skillDraws: 0, statuses: [] };
  return { registry, runtime, world, instanceId: "card", owner: "player" as const, window: "owner-turn" as const };
}
describe("ability levels", () => {
  it("defaults legacy bindings to Lv1 and resolves effect/copy/use overrides for Lv2", () => {
    const low = fixture(), high = fixture(2);
    expect(low.runtime.instances[0].level).toBe(1);
    expect(getAbilityDefinition(action.id, high.registry, 2)?.usage).toBe("高阶规则");
    expect(playAbility(low).world.skillDraws).toBe(1);
    const result = playAbility(high);
    expect(result.world.skillDraws).toBe(2);
    expect(result.world.cards).toHaveLength(1);
    expect(result.runtime.instances[0].remainingUses).toBe(2);
    expect(result.runtime.lastPlayedPlayerSkillLevel).toBe(2);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "ABILITY_TRIGGERED", level: 2 }));
    expect(canPlayAbility({ ...high, world: { ...high.world, cards: high.world.cards.map(card => ({ ...card, level: 1 })) } })).toBe(false);
    expect(high.registry.definitionsById[action.id].description).toBe("基础描述");
  });
  it("copies the last played skill at its original level", () => {
    const copy = { ...action, id: "example-level-copy", levels: undefined, rules: [{ id: "copy", trigger: "on-ability-played", effects: [{ type: "grant-skill-card", target: "owner", initialize: false, choices: [{ type: "last-successful-player-skill" }, { type: "self" }] }] }] };
    const registry = createStandaloneAbilityRegistry([action, copy], []);
    const first = playAbility({ ...fixture(2), registry });
    const instance = instantiateAbility({ definitionId: copy.id, enabled: true, parameters: {} }, "player", "copy", 2, registry);
    const runtime = addAbilityInstance(first.runtime, instance, registry);
    const world = { ...first.world, cards: [...first.world.cards, { kind: "player-skill" as const, definitionId: copy.id, owner: "player" as const, instanceId: "copy", level: 1 }] };
    const result = playAbility({ ...fixture(), registry, runtime, world, instanceId: "copy" });
    const granted = result.world.cards.at(-1)!;
    expect(granted.definitionId).toBe(action.id);
    expect(granted.level).toBe(2);
    expect(result.runtime.instances.find(entry => entry.instanceId === granted.instanceId)?.remainingUses).toBe(3);
  });
  it("rejects invalid, unsupported and duplicate levels, including higher-level rule references", () => {
    const { registry } = fixture();
    for (const level of [0, -1, 1.5, 3]) expect(() => validateAbilityBinding({ definitionId: action.id, enabled: true, parameters: {}, level }, registry)).toThrow();
    expect(AbilityDefinitionSchema.safeParse({ ...action, levels: [action.levels[0], action.levels[0]] }).success).toBe(false);
    expect(AbilityDefinitionSchema.safeParse({ ...action, levels: [{ level: 2, activation: { type: "passive" } }] }).success).toBe(false);
    expect(() => createStandaloneAbilityRegistry([{ ...action, levels: [{ level: 2, rules: [{ ...rule(2), conditions: [{ type: "owner-has-card", abilityId: "missing" }] }] }] }], [])).toThrow("Unknown ability");
  });
  it.each(["ai-skill", "talent"] as const)("resolves higher-level rules for %s too", sourceKind => {
    const definition = { id: "example-level-auto", name: "Auto", description: "Base", sourceKind, primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" }, rules: [rule(1, "on-match-created")], ...(sourceKind === "talent" ? { unlock: { type: "defeat-count", count: 1, label: "Test" } } : {}), levels: [{ level: 2, rules: [rule(3, "on-match-created")] }] };
    const registry = createStandaloneAbilityRegistry([definition], []);
    const ability = instantiateAbility({ definitionId: definition.id, level: 2, enabled: true, parameters: {} }, "player", "auto", 1, registry, sourceKind);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("auto").snapshot()), ability, registry);
    expect(resolveAbilityEvent({ ...fixture(), registry, runtime, event: { trigger: "on-match-created", sourceEventId: "start" } }).world.skillDraws).toBe(3);
  });
  it("snapshots higher-level TTL and display declarations independently of the live instance", () => {
    const definition = { id: "example-level-passive", name: "Passive", description: "Base", sourceKind: "player-skill", primaryDomain: "gambler", tags: ["neutral"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false, activation: { type: "passive" }, ttl: { type: "rounds", amount: 1 }, rules: [], levels: [{ level: 2, description: "High", ttl: { type: "rounds", amount: 3 }, displays: [{ id: "label", target: "owner", description: "High", content: [{ type: "text", text: "Higher level" }] }] }] };
    const registry = createStandaloneAbilityRegistry([definition], []);
    const ability = instantiateAbility({ definitionId: definition.id, level: 2, enabled: true, parameters: {} }, "player", "passive", 1, registry);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("passive").snapshot()), ability, registry);
    expect(advanceRoundAbilityTtls(runtime, [], registry).runtime.instances[0].ttl?.remaining).toBe(2);
    expect(runtime.displays[0].level).toBe(2);
    expect(resolveDisplays({ ...runtime, instances: [] }, fixture().world, registry)[0].description).toBe("High");
  });
  it("roundtrips Lv2 cards, retains levels across tables and loads old level-less saves as Lv1", () => {
    installAbilityRegistry([...original.definitions, action], original.statuses, original.catalogVersion);
    const high = fixture(2);
    const base = createMatch("level-save", { opponentId: "llama" });
    const state = { ...base, abilities: { ...base.abilities, sequence: Math.max(base.abilities.sequence, 1), instances: [...base.abilities.instances, high.runtime.instances[0]] }, playerSkills: { ...base.playerSkills, cards: [...base.playerSkills.cards, high.world.cards[0]] } };
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(restored.playerSkills.cards.at(-1)?.level).toBe(2);
    expect(carryPlayerSkills(createMatch("next-table", { opponentId: "llama" }), capturePlayerSkills(restored)).abilities.instances.find(instance => instance.instanceId === "card")?.remainingUses).toBe(3);
    const invalid = { ...restored, playerSkills: { ...restored.playerSkills, cards: restored.playerSkills.cards.map(card => card.instanceId === "card" ? { ...card, level: 1 } : card) } };
    expect(() => createRuntimeSave(invalid)).toThrow("playerSkills.cards");
    const old = JSON.parse(JSON.stringify(createRuntimeSave(base)));
    delete old.activeMatch.abilities.lastPlayedPlayerSkillLevel;
    for (const instance of old.activeMatch.abilities.instances) delete instance.level;
    for (const card of old.activeMatch.playerSkills.cards) delete card.level;
    expect(validateRuntimeSave(old).activeMatch?.abilities.instances.every(instance => instance.level === 1)).toBe(true);
  });
});
