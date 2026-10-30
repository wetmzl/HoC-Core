import { describe, expect, it } from "vitest";
import trial from "../../../tests/fixtures/boss-trial.json";
import legacy from "../../core/challenge/fixtures/legacy-challenge.json";
import { ChallengeDefinitionSchema } from "../../core/challenge/schema";
import { challengeFlow } from "../../core/challenge/flow";
import { ABILITY_REGISTRY } from "../../core/abilities/registry";
import { CHARACTER_CATALOG } from "../characters";
import { characterEncounterCapabilities } from "../characters/encounter-capabilities";
import { ORDINARY_ENCOUNTER_POLICY } from "../characters/encounter-policy";
import { EncounterFlowResourceSchema, validateEncounterFlow, encounterUnlockProgress } from "./catalog";

const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
describe("authored encounter resources", () => {
  it("preserves the existing authored challenge's complete node projection and skill weakening", () => {
    const old = ChallengeDefinitionSchema.parse(legacy);
    const entry = EncounterFlowResourceSchema.parse(trial);
    expect(clean(entry.definition)).toEqual(clean(challengeFlow(old)));
    expect(entry.rematchSkills).toEqual(old.bossAbilities);
  });
  it.each([1, 3, 6])("accepts %i arbitrary nodes and configured gun capacities", count => {
    const entry = EncounterFlowResourceSchema.parse({ id: "neutral-flow", ownerId: "claude", name: "Neutral", description: "Neutral flow", unlock: { type: "always" },
      definition: { id: "neutral-flow", playerGun: { capacity: 3, bullets: 1 }, nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, opponentId: "claude", opponentGun: { capacity: 11, bullets: 2 },
        routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } })) }
    });
    expect(() => validateEncounterFlow(entry, CHARACTER_CATALOG, ABILITY_REGISTRY)).not.toThrow();
    expect(entry.definition.nodes).toHaveLength(count); expect(entry.definition.playerGun.capacity).toBe(3);
    expect(encounterUnlockProgress(entry, [], CHARACTER_CATALOG).unlocked).toBe(true);
  });
  it("keeps display tier independent from equipment and invitation policies", () => {
    expect(characterEncounterCapabilities({ tier: "SS", encounter: ORDINARY_ENCOUNTER_POLICY }).playerGun.capacity).toBe(6);
    expect(characterEncounterCapabilities({ tier: "D", encounter: { ...ORDINARY_ENCOUNTER_POLICY, requiresDefeat: true, rematchSkillChoices: true, playerGun: { capacity: 9, bullets: 2 } } })).toMatchObject({ requiresDefeat: true, rematchSkillChoices: true, playerGun: { capacity: 9, bullets: 2 } });
  });
});
