import { describe, expect, it } from "vitest";
import { CHARACTER_CATALOG, loadCharacter, isCharacterUnlocked, unlockedCharacterIdsForDefeats } from "./index";
import { rematchAbilities, specialOpponentRematchSkills } from "./rematches";
import legacyTrial from "../../core/challenge/fixtures/legacy-challenge.json";
import { ChallengeDefinitionSchema as LegacyChallengeSchema } from "../../core/challenge/schema";
const getChallenges = () => [LegacyChallengeSchema.parse(legacyTrial)];
import { createChallenge, challengeBossAbilities } from "../../core/challenge/reducer";
import { characterProfileMarkup } from "../../presentation/character-profile";
import { characterEncounterCapabilities } from "./encounter-capabilities";
import { standaloneFlowDefinition } from "../../runtime/standalone-encounter";
import { createDefaultSave } from "../../persistence/boot";
const defeat = (opponentId: string) => ({ opponentId, timestamp: "2026-10-25T00:00:00.000Z" });
describe("SS invitation and rematch policy", () => {
  it("requires an actual defeat for SS even when normal unlock conditions are absent or satisfied", async () => {
    const boss = await loadCharacter("claude");
    expect(isCharacterUnlocked({ ...boss, unlock: undefined }, [])).toBe(false);
    expect(isCharacterUnlocked({ ...boss, unlock: { type: "defeat-any" } }, [defeat("llama")])).toBe(false);
    expect(unlockedCharacterIdsForDefeats([defeat("llama")])).not.toContain(boss.id);
    expect(isCharacterUnlocked(boss, [defeat(boss.id)])).toBe(true);
    expect(isCharacterUnlocked(await loadCharacter("chatgpt"), [])).toBe(true);
  });
  it("selects each skill independently and leaves authored/boss challenge bindings unchanged", async () => {
    const boss = await loadCharacter("claude"), skills = specialOpponentRematchSkills(boss);
    expect(skills).toHaveLength(4);
    expect(rematchAbilities(boss).map(binding => binding.level)).toEqual([2, 2, 2, 2]);
    expect(rematchAbilities(boss, { weakenedSkills: [skills[0].key, skills[2].key] }).map(binding => binding.level)).toEqual([1, 2, 1, 2]);
    expect(rematchAbilities(boss, { weakenedSkills: skills.map(skill => skill.key) }).map(binding => binding.level)).toEqual([1, 1, 1, 1]);
    expect(rematchAbilities(boss, { weakenedSkills: [] }).map(binding => binding.level)).toEqual([2, 2, 2, 2]);
    const run = createChallenge("independent", getChallenges()[0], getChallenges()[0].guards.map(guard => defeat(guard.characterId)), CHARACTER_CATALOG);
    expect(challengeBossAbilities(run).map(binding => binding.level)).toEqual([2, 2, 2, 2]);
    expect(boss.aiSkills.map(binding => binding.level)).toEqual([2, 2, 2, 2]);
    expect(() => rematchAbilities(boss, { weakenedSkills: ["unknown"] })).toThrow("未知");
    expect(() => rematchAbilities(boss, { weakenedSkills: [skills[0].key, skills[0].key] })).toThrow("重复");
  });
  it("uses Lv1 or a disabled skill for independent SS definitions and keeps every toggle visible", async () => {
    const base = await loadCharacter("claude");
    const standalone = { ...base, id: "example-special", aiSkills: [base.aiSkills[0], { ...base.aiSkills[1], level: 1 }] };
    const skills = specialOpponentRematchSkills(standalone);
    expect(skills[0].weakened.level).toBe(1);
    expect(skills[1].weakened.enabled).toBe(false);
    const markup = characterProfileMarkup(standalone, { skillChoices: skills.map(skill => ({ key: skill.key, full: skill.full, selected: skill.weakened, weakened: true })) });
    expect(markup.match(/data-weaken-skill=/g)).toHaveLength(2);
    expect(markup).toContain("该技能已停用。");
  });
  it("compiles independent invitations with the legacy loadout and selected skills before runtime starts", async () => {
    const ordinary = await loadCharacter("chatgpt"), special = await loadCharacter("claude");
    const save = createDefaultSave();
    expect(characterEncounterCapabilities(ordinary)).toMatchObject({ requiresDefeat: false, rematchSkillChoices: false, playerGun: { capacity: 6 } });
    expect(standaloneFlowDefinition(ordinary, save).playerGun.capacity).toBe(6);
    expect(() => standaloneFlowDefinition(special, save)).toThrow("尚未解锁");
    save.defeats = [defeat(special.id)];
    const definition = standaloneFlowDefinition(special, save, { weakenedSkills: [specialOpponentRematchSkills(special)[0].key] });
    expect(definition.playerGun.capacity).toBe(8);
    expect(definition.nodes[0].opponentGun?.capacity).toBe(8);
    expect(definition.nodes[0].abilities?.map(slot => slot.binding.level)).toEqual([1, 2, 2, 2]);
  });
});
