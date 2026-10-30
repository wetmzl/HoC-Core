import { expect, it } from "vitest";
import trial from "../../core/challenge/fixtures/legacy-challenge.json";
import currentCharacter from "../../../public/characters/claude/resources/character-match.json";
import appearance from "../../../public/characters/claude/resources/appearance.json";
import { resolvePresentation, type CharacterPresentation } from "./character-presentation";
import { createHocpkgResourceHandlers } from "./resources";
const character = resolvePresentation(currentCharacter, appearance as CharacterPresentation) as typeof currentCharacter;
Reflect.deleteProperty(character.metadata, "encounter");
Reflect.deleteProperty(character, "presentationResourceId");

it("gates authored profile backgrounds and two-stage skills behind supported resource versions", async () => {
  const handlers = createHocpkgResourceHandlers();
  const boss = handlers.find(handler => handler.type === "game.boss-challenge")!;
  const context = (apiVersion: number) => ({ descriptor: { apiVersion } }) as Parameters<typeof boss.parse>[1];
  const legacyUnlock = { type: "defeat-count", count: 1 };
  const noRewards = { ...trial, unlock: legacyUnlock, guards: trial.guards.map(({ victoryRewards: _rewards, ...guard }) => guard) };
  const legacy = { ...noRewards, bossAbilities: trial.bossAbilities.map(ability => ({ ...ability,
    binding: { ...ability.binding, level: 1 }, weakenedBinding: { ...ability.weakenedBinding, level: 1 }
  })) };
  expect(() => boss.parse(legacy, context(1))).toThrow("API 2");
  expect(boss.parse(legacy, context(2))).toEqual(legacy);
  expect(() => boss.parse(noRewards, context(2))).toThrow("API 3");
  expect(boss.parse(noRewards, context(3))).toEqual(noRewards);
  const drawsOnly = { ...trial, unlock: legacyUnlock, guards: trial.guards.map(guard => ({ ...guard, victoryRewards: { skillDraws: 3 } })) };
  expect(() => boss.parse(drawsOnly, context(3))).toThrow("API 4");
  expect(boss.parse(drawsOnly, context(4))).toEqual(drawsOnly);
  const rewards = { ...trial, unlock: legacyUnlock };
  expect(() => boss.parse(rewards, context(4))).toThrow("API 5");
  expect(boss.parse(rewards, context(5))).toEqual(rewards);
  expect(() => boss.parse(trial, context(5))).toThrow("API 6");
  expect(boss.parse(trial, context(6))).toEqual(trial);
  const match = handlers.find(handler => handler.type === "game.character-match")!;
  const legacyCharacter = { ...character, aiSkills: character.aiSkills.map(binding => ({ ...binding, level: 1 })) };
  await expect(match.parse(legacyCharacter, context(8))).rejects.toThrow("API 9");
  await expect(match.parse(character, context(9))).rejects.toThrow("API 10");
});
