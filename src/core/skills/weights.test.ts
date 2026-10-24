import { describe, expect, it } from "vitest";
import { getAbilityDefinition, PLAYER_SKILL_ABILITY_DEFINITIONS, TALENT_ABILITY_DEFINITIONS } from "../abilities/registry";
import { AbilityDefinitionSchema } from "../abilities/schema";
import type { AiSkillAbilityDefinition } from "../abilities/types";
import { createRng } from "../rng/seeded";
import { getPlayerSkillDefinition, INITIAL_PLAYER_SKILL_IDS } from "./definitions";
import { calculatePlayerSkillWeight, collectSkillDrawWeightModifiers, generateSkillDrawOffer } from "./skills";

describe("player-owned skill draw weights", () => {
  const ai = getAbilityDefinition("action-advice-mechanic")! as AiSkillAbilityDefinition;
  const skill = getPlayerSkillDefinition("hunter-instinct")!;

  it.each([{ modifiers: [] }, { modifiers: [{ tag: "intelligence-officer", factor: 1 }] }, { modifiers: [{ tag: "intelligence-officer", factor: 0 }] }, { modifiers: [{ tag: "intelligence-officer", factor: 100 }] }])("rejects every AI weight declaration, including neutral and empty values: %j", ({ modifiers }) => {
    const rejected = AbilityDefinitionSchema.safeParse({ ...ai, skillDrawWeightModifiers: modifiers });
    expect(rejected.success).toBe(false);
  });

  it("ignores AI weights even if a legacy or unvalidated object bypasses parsing", () => {
    const injected = { ...ai, skillDrawWeightModifiers: [{ tag: "intelligence-officer" as const, factor: 0 }] };
    expect(collectSkillDrawWeightModifiers([injected])).toEqual([]);
    const plain = generateSkillDrawOffer(createRng("ai-neutral"), INITIAL_PLAYER_SKILL_IDS, []);
    const withAi = generateSkillDrawOffer(createRng("ai-neutral"), INITIAL_PLAYER_SKILL_IDS, [], collectSkillDrawWeightModifiers([injected]));
    expect(withAi).toEqual(plain);
  });

  it("preserves player skills and talents as weight sources", () => {
    const player = { ...PLAYER_SKILL_ABILITY_DEFINITIONS[0], skillDrawWeightModifiers: [{ tag: "intelligence-officer" as const, factor: 2 }] };
    const talent = { ...TALENT_ABILITY_DEFINITIONS[0], skillDrawWeightModifiers: [{ tag: "intelligence-officer" as const, factor: 0.5 }] };
    expect(AbilityDefinitionSchema.safeParse(player).success).toBe(true);
    expect(AbilityDefinitionSchema.safeParse(talent).success).toBe(true);
    expect(calculatePlayerSkillWeight(skill, collectSkillDrawWeightModifiers([player, ai, talent]))).toBe(1);
  });

  it("keeps the current content uniform without hardcoding future base weights", () => {
    const modifiers = collectSkillDrawWeightModifiers([...PLAYER_SKILL_ABILITY_DEFINITIONS, ...TALENT_ABILITY_DEFINITIONS]);
    expect(INITIAL_PLAYER_SKILL_IDS.every((id) => calculatePlayerSkillWeight(getPlayerSkillDefinition(id)!, modifiers) === 1)).toBe(true);
    expect(calculatePlayerSkillWeight({ ...skill, drop: { ...skill.drop, baseWeight: 7 } }, [])).toBe(7);
  });
});
