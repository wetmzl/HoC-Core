import { CHARACTER_CATALOG } from "../../content/characters";
import { afterEach, describe, expect, it } from "vitest";
import trial from "./fixtures/legacy-challenge.json";
import { createMatch, gameReducer } from "../match/reducer";
import { capturePlayerSkills } from "../abilities/carryover";
import { ABILITY_REGISTRY, instantiateAbility, installAbilityRegistry } from "../abilities/registry";
import { createChallenge, startEncounter, finishEncounter } from "./reducer";
import { validateRuntimeSave, MatchStateSchema } from "../../persistence/schema";
import { createRuntimeSave } from "../../persistence/boot";
import { ChallengeDefinitionSchema } from "./schema";

const definition = ChallengeDefinitionSchema.parse(trial);
const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const fresh = () => createChallenge("continuity", definition, definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-25T00:00:00Z" })), CHARACTER_CATALOG);
describe("challenge inventory continuity", () => {
  it("preserves only remaining skill cards, their levels/uses and draws, including an empty inventory", () => {
    const initial = createMatch("initial", { opponentId: "llama" });
    const instance = { ...instantiateAbility({ definitionId: "situation-assessment", level: 1, enabled: true, parameters: {} }, "player", "carried-card", 99, undefined, "player-skill"), remainingUses: 1 };
    const source = { ...initial, playerSkills: { ...initial.playerSkills, cards: [{ kind: "player-skill" as const, owner: "player" as const, level: 1, definitionId: instance.definitionId, instanceId: instance.instanceId }], drawCount: 2 }, abilities: { ...initial.abilities, instances: [instance], sequence: 99 } };
    const inventory = capturePlayerSkills(source);
    expect(inventory).not.toHaveProperty("shoe"); expect(inventory).not.toHaveProperty("history");
    const next = createMatch("next", { opponentId: "chatgpt", playerCarryover: inventory });
    expect(next.playerSkills.cards).toEqual(source.playerSkills.cards);
    expect(next.playerSkills.drawCount).toBe(2);
    expect(next.abilities.instances.find(item => item.instanceId === "carried-card")?.remainingUses).toBe(1);
    expect(MatchStateSchema.safeParse(next).success).toBe(true);
    const spent = capturePlayerSkills({ ...source, playerSkills: { ...source.playerSkills, cards: [], drawCount: 0 }, abilities: { ...source.abilities, instances: [] } });
    const empty = createMatch("empty", { opponentId: "claude", playerCarryover: spent, talentIds: ["early-preparation"] });
    expect(empty.playerSkills.cards).toEqual([]); expect(empty.playerSkills.drawCount).toBe(0);
  });
  it("grants player opening cards and talent draws only once while initializing every fresh opponent", () => {
    const opponent = { id: "example-opponent-opening", name: "Opening", description: "Fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["test"], activation: { type: "automatic" }, rules: [{ id: "load", trigger: "on-match-created", effects: [{ type: "add-gun-bullets", target: "owner", amount: 1 }] }] };
    installAbilityRegistry([...original.definitions, opponent], original.statuses, original.catalogVersion);
    const options = { opponentId: "llama", talentIds: ["early-preparation", "well-prepared", "second-chance"], opponentAiSkills: [{ definitionId: opponent.id, enabled: true, parameters: {} }] };
    let match = createMatch("first", options);
    expect(match.playerSkills.cards.length).toBeGreaterThan(0);
    expect(match.playerSkills.drawCount).toBe(1);
    expect(match.playerSkills.openingCardCount).toBe(4); expect(match.playerSkills.refreshesPerDraw).toBe(1);
    const first = capturePlayerSkills(match);
    for (let index = 0; index < 4; index++) {
      match = createMatch(`retry-${index}`, { ...options, playerCarryover: capturePlayerSkills(match) });
      expect(match.playerSkills.cards).toEqual(first.inventory.cards);
      expect(match.playerSkills.drawCount).toBe(1);
      expect(match.playerSkills.openingCardCount).toBe(4); expect(match.playerSkills.refreshesPerDraw).toBe(1);
      expect(match.roulette.opponent.bullets).toBe(1);
      expect(match.history).not.toContainEqual(expect.objectContaining({ type: "ABILITY_TRIGGERED", definitionId: "early-preparation" }));
    }
  });
  it("escapes a guard without suppression and re-enters a newly dealt table with compact persisted inventory", () => {
    const run = startEncounter(fresh(), "chatgpt");
    const match = createMatch("guard", { id: run.encounter!.matchId, opponentId: "chatgpt", playerGun: { capacity: 8, bullets: 4 } });
    const escaped = gameReducer(gameReducer(match, { type: "ESCAPE_MATCH" }), { type: "ACK_MATCH_RESULT" });
    const selection = finishEncounter(run, escaped);
    expect(selection.phase).toBe("selection"); expect(selection.playerGun.bullets).toBe(4);
    expect(selection.defeatedGuards).toEqual([]);
    const envelope = { ...createRuntimeSave(match), activeMatch: null, activeChallenge: selection, challengeMemory: { player: capturePlayerSkills(match) } };
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(envelope)));
    expect(Object.keys(saved.challengeMemory!)).toEqual(["player"]);
    expect(JSON.stringify(saved)).not.toContain('"shoe"'); expect(JSON.stringify(saved)).not.toContain('"history"');
    const next = startEncounter(selection, "chatgpt");
    const retry = createMatch("retry", { id: next.encounter!.matchId, opponentId: "chatgpt", playerGun: selection.playerGun, playerCarryover: saved.challengeMemory!.player! });
    expect(retry.id).not.toBe(match.id); expect(retry.seed).not.toBe(match.seed); expect(retry.roundIndex).toBe(0);
    expect(retry.roulette.player).toEqual(match.roulette.player); expect(retry.roulette.opponent.bullets).toBe(0);
    expect(retry.playerSkills.cards).toEqual(match.playerSkills.cards);
    expect(() => validateRuntimeSave({ ...envelope, challengeMemory: { player: { ...capturePlayerSkills(match), instances: [] } } })).toThrow();
  });
});
