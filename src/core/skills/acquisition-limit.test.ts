import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "../abilities/registry";
import { createAbilityRuntime, addAbilityInstance } from "../abilities/runtime";
import { applyEffects } from "../abilities/effects";
import { capturePlayerSkills } from "../abilities/carryover";
import { abilityWorld, createMatch, gameReducer, getLegalActions } from "../match/reducer";
import type { MatchState } from "../match/types";
import type { PlayerSkillAbilityDefinition } from "../abilities/types";
import { SeededRng } from "../rng/seeded";
import { canGenerateSkillDraw, generateSkillDrawOffer } from "./skills";
import { canAcquirePlayerSkill, recordPlayerSkillAcquisition } from "./acquisition";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
function definition(perMatch = 1): PlayerSkillAbilityDefinition {
  return {
    id: "example-limited-acquisition", name: "有限获取", description: "中性获取次数夹具", sourceKind: "player-skill", primaryDomain: "gambler",
    tags: ["neutral"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
    acquisitionLimit: { perMatch }, activation: { type: "action", windows: ["owner-turn"], consume: "card" },
    rules: [{ id: "draw", trigger: "on-ability-played", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }],
    levels: [{ level: 2, description: "高阶中性获取次数夹具" }]
  };
}
function install(perMatch = 1) {
  const skill = definition(perMatch);
  installAbilityRegistry([...original.definitions, skill], original.statuses, original.catalogVersion);
  return skill;
}
function ready(state: MatchState): MatchState {
  return { ...state, playerSkills: { ...state.playerSkills, drawCount: 2 }, round: { ...state.round, phase: "turns", currentActor: "player", outcome: null } };
}

describe("definition-wide Player Skill acquisition limits", () => {
  it.each([1, 2])("caps opening acquisitions at %i and preserves deterministic offers", limit => {
    const skill = install(limit);
    const options = { opponentId: "llama", skillDeckIds: [skill.id] };
    const state = createMatch("limited-opening", options);
    expect(state.playerSkills.cards).toHaveLength(limit);
    expect(state.playerSkills.acquisitionCounts?.[skill.id]).toBe(limit);
    expect(state.history.filter(event => event.type === "SKILL_GAINED")).toHaveLength(limit);
    expect(createMatch("limited-opening", options)).toEqual(state);
    const rng = new SeededRng("exhausted-offer");
    expect(canGenerateSkillDraw([skill.id], [], [], [], { [skill.id]: limit })).toBe(false);
    const exhausted = generateSkillDrawOffer(rng, [skill.id], [], [], "offer", [], 3, { [skill.id]: limit });
    expect(exhausted.offer.candidateDefinitionIds).toEqual([]);
    expect(exhausted.rng).toEqual(rng.snapshot());
  });

  it("retains the spent acquisition after consuming a card, saving, and crossing challenge tables", () => {
    const skill = install();
    const state = ready(createMatch("limited-use", { opponentId: "llama", skillDeckIds: [skill.id] }));
    const spent = gameReducer(state, { type: "PLAY_ABILITY", instanceId: state.playerSkills.cards[0].instanceId });
    expect(spent.playerSkills.cards).toHaveLength(0);
    expect(spent.playerSkills.acquisitionCounts?.[skill.id]).toBe(1);
    expect(gameReducer(spent, { type: "OPEN_SKILL_DRAW" })).toBe(spent);
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(spent)))).activeMatch!;
    expect(restored).toEqual(spent);
    const carried = ready(createMatch("limited-next-table", { opponentId: "llama", playerCarryover: capturePlayerSkills(restored) }));
    expect(carried.playerSkills.acquisitionCounts?.[skill.id]).toBe(1);
    expect(gameReducer(carried, { type: "OPEN_SKILL_DRAW" })).toBe(carried);
    expect(createMatch("independent-new-match", { skillDeckIds: [skill.id] }).playerSkills.cards).toHaveLength(1);
  });

  it("revalidates stale selections without spending draws, cards, counters, or RNG", () => {
    const skill = install();
    const base = ready(createMatch("stale-limited", { opponentId: "llama", skillDeckIds: [skill.id] }));
    const state = { ...base, playerSkills: { ...base.playerSkills, drawOffer: { id: "stale-offer", candidateDefinitionIds: [skill.id], refreshesRemaining: 0 } } };
    expect(gameReducer(state, { type: "SELECT_SKILL_DRAW", definitionId: skill.id })).toBe(state);
    expect(getLegalActions(state)).not.toContainEqual({ type: "SELECT_SKILL_DRAW", definitionId: skill.id });
  });

  it("counts only acquisitions, shares the budget across levels, and rejects invalid saved counts", () => {
    const skill = install(2);
    const state = createMatch("saved-limited-count", { opponentId: "llama", skillDeckIds: [skill.id] });
    for (const count of [-1, 1.5, 3, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createRuntimeSave({ ...state, playerSkills: { ...state.playerSkills, acquisitionCounts: { [skill.id]: count } } })).toThrow();
    }
    expect(() => createRuntimeSave({ ...state, playerSkills: { ...state.playerSkills, acquisitionCounts: {} } })).toThrow();
    const higherLevel = { ...skill, level: 2 };
    expect(canAcquirePlayerSkill(higherLevel, { [skill.id]: 2 })).toBe(false);
    const unknownLedger = { ...state, playerSkills: { ...state.playerSkills, acquisitionCounts: { ...state.playerSkills.acquisitionCounts, "unavailable-neutral-definition": 4 } } };
    expect(validateRuntimeSave(createRuntimeSave(unknownLedger)).activeMatch?.playerSkills.acquisitionCounts?.["unavailable-neutral-definition"]).toBe(4);
  });

  it("enforces the same budget for copied effect grants and rolls back later failures", () => {
    const skill = definition();
    const registry = createStandaloneAbilityRegistry([skill], []);
    const ability = instantiateAbility({ definitionId: skill.id, level: 2, enabled: true, parameters: {} }, "player", "source", 1, registry);
    const runtime = { ...addAbilityInstance(createAbilityRuntime(new SeededRng("grant-limit").snapshot()), ability, registry), lastPlayedPlayerSkillDefinitionId: skill.id, lastPlayedPlayerSkillLevel: 2 };
    const match = createMatch("grant-limit-world", { skillDeckIds: [] });
    const world = { ...abilityWorld(match), skillAcquisitionCounts: {} };
    const context = { world, runtime, ability, registry, rng: new SeededRng("grant-limit"), event: { trigger: "on-ability-played" as const, sourceEventId: "grant" } };
    const grant = { type: "grant-skill-card", target: "owner", initialize: false, choices: [{ type: "last-successful-player-skill" }, { type: "self" }] } as const;
    const before = JSON.stringify(context);
    const first = applyEffects([grant], context);
    expect(first.world.cards[0].level).toBe(2);
    expect(first.world.skillAcquisitionCounts?.[skill.id]).toBe(1);
    expect(() => applyEffects([grant], { ...context, runtime: first.runtime, world: { ...first.world, cards: [] } })).toThrow("acquisition limit");
    expect(() => applyEffects([grant, { type: "remove-gun-bullets", target: "owner", amount: { type: "divide", left: 1, right: 0 } }], context)).toThrow();
    expect(JSON.stringify(context)).toBe(before);
    expect(recordPlayerSkillAcquisition(skill, {}, [])).toEqual({ [skill.id]: 1 });
  });

  it("treats definition IDs as own ledger keys and rejects malformed or overflowing counts", () => {
    const skill = { id: "constructor", acquisitionLimit: { perMatch: 1 } };
    expect(canAcquirePlayerSkill(skill)).toBe(true);
    expect(recordPlayerSkillAcquisition(skill)).toEqual({ constructor: 1 });
    expect(canAcquirePlayerSkill(skill, { constructor: 1 })).toBe(false);
    for (const count of [-1, 0.5, NaN]) expect(() => recordPlayerSkillAcquisition(skill, { constructor: count })).toThrow("Invalid");
    expect(() => recordPlayerSkillAcquisition({ id: "overflow" }, { overflow: Number.MAX_SAFE_INTEGER })).toThrow("overflow");
  });
});
