import { describe, expect, it } from "vitest";
import { availableDeckSkills, moveDeckSkill, resolveSkillDeck, skillDeckRequirement } from "./deck";
import { PLAYER_SKILL_DEFINITIONS } from "./definitions";
import { createMatch, gameReducer } from "../match/reducer";
import { createDefaultSave, createRuntimeSave } from "../../persistence/boot";
import { validateLongTermSave, validateRuntimeSave } from "../../persistence/schema";

const ids = PLAYER_SKILL_DEFINITIONS.filter((skill) => skill.drop.enabled && skill.drop.baseWeight > 0).map((skill) => skill.id);

describe("durable skill decks", () => {
  it("initializes all available skills but keeps later unlocks in reserve and unavailable choices intact", () => {
    expect(resolveSkillDeck(undefined, ["a", "b"])).toEqual({ carried: ["a", "b"], reserve: [] });
    const saved = { carried: ["a", "temporarily-uninstalled"], reserve: ["b"] };
    expect(resolveSkillDeck(saved, ["a", "b", "new"])).toEqual({ ...saved, reserve: ["b", "new"] });
    expect(skillDeckRequirement(saved, ["a", "b"])).toEqual({ count: 1, minimum: 2, missing: 1 });
  });
  it("requires eight effective skills, or all available skills for a smaller collection", () => {
    expect(skillDeckRequirement({ carried: ids.slice(0, 7), reserve: [] }, ids).missing).toBe(1);
    expect(skillDeckRequirement({ carried: ids.slice(0, 8), reserve: [] }, ids).missing).toBe(0);
    expect(skillDeckRequirement({ carried: [ids[0]], reserve: [] }, ids.slice(0, 3))).toEqual({ count: 1, minimum: 3, missing: 2 });
    expect(availableDeckSkills(PLAYER_SKILL_DEFINITIONS, [ids[0], "unavailable"]).map((skill) => skill.id)).toEqual([ids[0]]);
  });
  it("moves across zones exactly once and preserves hidden cards' relative ordering", () => {
    const deck = { carried: ["x"], reserve: ["a", "hidden-1", "b", "hidden-2", "c"] };
    const moved = moveDeckSkill(deck, "c", "reserve", "b");
    expect(moved.reserve).toEqual(["a", "hidden-1", "c", "b", "hidden-2"]);
    expect(moveDeckSkill(moved, "b", "carried", "x")).toEqual({ carried: ["b", "x"], reserve: ["a", "hidden-1", "c", "hidden-2"] });
    expect(deck.reserve).toHaveLength(5);
  });
  it("accepts old saves and unavailable durable IDs, but rejects duplicate membership", () => {
    const old = createDefaultSave();
    expect(validateLongTermSave(old).profile.skillDeck).toBeUndefined();
    expect(validateLongTermSave({ ...old, profile: { ...old.profile, skillDeck: { carried: ["missing-package-skill"], reserve: [] } } }).profile.skillDeck?.carried).toEqual(["missing-package-skill"]);
    expect(() => validateLongTermSave({ ...old, profile: { ...old.profile, skillDeck: { carried: ["same"], reserve: ["same"] } } })).toThrow(/duplicate deck skill/);
  });
  it("snapshots an isolated candidate pool and disables only new-match legacy preferences", () => {
    const selected = ids.slice(0, 8);
    const base = createMatch("deck-isolation", { opponentId: "llama", unlockedPlayerSkillIds: ids, skillDeckIds: selected, selectedSkillTags: ["gunslinger"] });
    expect(base.playerSkills.selectedSkillTags).toEqual([]);
    selected.reverse();
    expect(base.playerSkills.deckDefinitionIds).toEqual(ids.slice(0, 8));
    const state = { ...base, playerSkills: { ...base.playerSkills, drawCount: 1 }, round: { ...base.round, phase: "turns" as const, currentActor: "player" as const } };
    const drawn = gameReducer(state, { type: "OPEN_SKILL_DRAW" });
    expect(drawn.playerSkills.drawOffer?.candidateDefinitionIds).toHaveLength(3);
    expect(drawn.playerSkills.drawOffer?.candidateDefinitionIds.every((id) => ids.slice(0, 8).includes(id))).toBe(true);
    const reversed = createMatch("deck-isolation", { opponentId: "llama", unlockedPlayerSkillIds: ids, skillDeckIds: ids.slice(0, 8).reverse() });
    const other = gameReducer({ ...reversed, playerSkills: { ...reversed.playerSkills, drawCount: 1 }, round: { ...reversed.round, phase: "turns", currentActor: "player" } }, { type: "OPEN_SKILL_DRAW" });
    expect(other.playerSkills.drawOffer).toEqual(drawn.playerSkills.drawOffer);
    const legacy = createMatch("deck-legacy", { opponentId: "llama", selectedSkillTags: ["gunslinger"] });
    expect(validateRuntimeSave(createRuntimeSave(legacy)).activeMatch!.playerSkills.selectedSkillTags).toEqual(["gunslinger"]);
    expect(legacy.playerSkills.deckDefinitionIds).toBeUndefined();
    expect(validateRuntimeSave(createRuntimeSave(base)).activeMatch!.playerSkills.deckDefinitionIds).toEqual(ids.slice(0, 8));
  });
  it("rejects locked, unknown and duplicate new-match deck entries", () => {
    expect(() => createMatch("bad", { skillDeckIds: ["missing"] })).toThrow(/Skill deck/);
    expect(() => createMatch("bad", { skillDeckIds: [ids[0], ids[0]] })).toThrow(/Skill deck/);
    expect(() => createMatch("bad", { unlockedPlayerSkillIds: [ids[0]], skillDeckIds: [ids[1]] })).toThrow(/Skill deck/);
  });
});
