import { afterEach, expect, it } from "vitest";
import { SkinUnlockConditionSchema, skinUnlockConditionMet, type SkinUnlockCondition } from "../content/characters/skin-unlock";
import { clearCharacterCatalog, installCharacterCatalog, type CharacterMetadata } from "../content/characters";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { acknowledgeMatchResult, clearMatchHistory, createDefaultSave } from "./boot";
import { characterDefeatCount, recordCharacterDefeat } from "./character-defeats";
import { changeCharacterSkinUnlocks, grantDeclaredSkinUnlocks, isCharacterSkinUnlocked } from "./skin-unlocks";
import { exportSaveJson, importSave } from "./json";
import { recoverLongTermSave } from "./recover-save";
import { validateLongTermSave } from "./schema";
import { skinCharacterFixture } from "../test/skin-character-fixtures";
import { validateCharacterPackage } from "../authoring-api";

const key = "neutral/example#match";
const metadata: CharacterMetadata = {
  id: "llama", name: "中性角色", subtitle: "条件测试", tier: "D", tags: [], previewImage: "original.png", portraitScales: { selection: 1, table: 1 },
  appearance: { key, skinId: "initial", skins: [
    { id: "initial", name: "初始" }, { id: "blue", name: "蓝色", unlock: { type: "defeat-character", count: 2 } },
    { id: "green", name: "绿色", unlock: { type: "any", conditions: [{ type: "completed-challenge", challengeId: "trial" }, { type: "defeat-character", characterId: "other", count: 1 }] } }
  ] }
};
afterEach(clearCharacterCatalog);

function victory(id: string): MatchState {
  let match = createMatch(id, { id, opponentId: "llama", opponentAiSkills: [] });
  match = { ...match, roulette: { ...match.roulette, opponent: { ...match.roulette.opponent, bullets: match.roulette.opponent.capacity } },
    round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } };
  match = gameReducer(gameReducer(match, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  return gameReducer(match, { type: "ACK_MATCH_RESULT" });
}

it("earns the Nth victory skin once, retaining receipts and earned access after history cleanup and import", async () => {
  installCharacterCatalog([metadata], "llama");
  let save = acknowledgeMatchResult(createDefaultSave(), victory("one"));
  expect(characterDefeatCount(save, "llama")).toBe(1);
  expect(isCharacterSkinUnlocked(save, metadata.appearance!, "blue")).toBe(false);
  save = await importSave(exportSaveJson(clearMatchHistory(save)));
  expect(save.history).toEqual([]);
  expect(acknowledgeMatchResult(save, victory("one"))).toBe(save);
  save = acknowledgeMatchResult(save, victory("two"));
  expect(characterDefeatCount(save, "llama")).toBe(2);
  expect(save.characterSkinUnlocks?.[key].blue).toBe(true);
  expect(acknowledgeMatchResult(save, victory("two"))).toBe(save);
  const cleared = clearMatchHistory(save);
  expect(characterDefeatCount(cleared, "llama")).toBe(2);
  expect((await importSave(exportSaveJson(cleared))).characterSkinUnlocks?.[key].blue).toBe(true);
});

it("backfills provable legacy victories, latches grants, and respects explicit plugin locks", () => {
  let save = createDefaultSave();
  save.defeats = [{ opponentId: "llama", timestamp: save.createdAt }];
  const once = { ...metadata, appearance: { ...metadata.appearance!, skins: [metadata.appearance!.skins[0], { ...metadata.appearance!.skins[1], unlock: { type: "defeat-character", count: 1 } as const }] } };
  expect(characterDefeatCount(save, "llama")).toBe(1);
  expect(grantDeclaredSkinUnlocks(save, [metadata])).toBe(save);
  save = grantDeclaredSkinUnlocks(save, [once]);
  expect(save.characterSkinUnlocks?.[key].blue).toBe(true);
  expect(grantDeclaredSkinUnlocks({ ...save, defeats: [] }, [once]).characterSkinUnlocks?.[key].blue).toBe(true);
  const locked = changeCharacterSkinUnlocks(save, once.appearance, { blue: false });
  expect(grantDeclaredSkinUnlocks(locked, [once])).toBe(locked);
  expect(grantDeclaredSkinUnlocks(changeCharacterSkinUnlocks(locked, once.appearance, null), [once]).characterSkinUnlocks?.[key].blue).toBe(true);
});

it("supports cross-character, challenge, all/any conditions and rejects malformed or excessive declarations", () => {
  const save = createDefaultSave(); save.completedChallenges = ["trial"];
  save.defeats = [{ opponentId: "other", timestamp: save.createdAt }];
  const rule: SkinUnlockCondition = { type: "all", conditions: [metadata.appearance!.skins[2].unlock!, { type: "always" }] };
  expect(skinUnlockConditionMet(save, "llama", SkinUnlockConditionSchema.parse(rule))).toBe(true);
  expect(grantDeclaredSkinUnlocks(save, [metadata]).characterSkinUnlocks?.[key]).toEqual({ green: true });
  for (const bad of [{ type: "defeat-character", count: 0 }, { type: "defeat-character", count: 1.1 }, { type: "all", conditions: [] }, { type: "unknown" }, { type: "always", extra: true }]) expect(SkinUnlockConditionSchema.safeParse(bad).success).toBe(false);
  let nested: SkinUnlockCondition = { type: "always" };
  for (let i = 0; i < 7; i++) nested = { type: "all", conditions: [nested] };
  expect(SkinUnlockConditionSchema.safeParse(nested).success).toBe(false);
});

it("ignores losses, escapes, unfinished tables and duplicate winning receipts", () => {
  const save = createDefaultSave(), win = victory("one");
  for (const match of [{ ...win, status: "active" }, { ...win, scene: "table" }, { ...win, outcome: { winner: "opponent", reason: "player-killed" } }, { ...win, outcome: { winner: "player", reason: "escaped" } }]) expect(recordCharacterDefeat(save, match as MatchState)).toBe(save);
  const recorded = recordCharacterDefeat(save, win);
  expect(recordCharacterDefeat(recorded, win)).toBe(recorded);
});

it("isolates damaged counts and receipts and preserves unavailable character progress", () => {
  const raw = { ...createDefaultSave(), characterDefeatProgress: { counts: { absent: 3, broken: -1 }, matchIds: ["receipt", "receipt", 3] } };
  expect(() => validateLongTermSave(raw)).toThrow();
  const recovered = recoverLongTermSave(raw);
  expect(recovered.characterDefeatProgress).toEqual({ counts: { absent: 3 }, matchIds: ["receipt"] });
  expect(recovered.recovery?.originals).toEqual([raw]);
});

it("requires presentation API 2 for declared skin unlocks while retaining API 1 packages", async () => {
  const fixture = await skinCharacterFixture();
  fixture.presentation.skins[1].unlock = { type: "defeat-character", count: 1 };
  let manifest = await fixture.rebuild();
  await expect(validateCharacterPackage({ manifest, readFile: async path => fixture.files[path] })).rejects.toThrow("API 2");
  manifest = { ...manifest, resources: manifest.resources.map(resource => resource.type === "presentation.character" ? { ...resource, apiVersion: 2 } : resource) };
  await expect(validateCharacterPackage({ manifest, readFile: async path => fixture.files[path] })).resolves.toBeUndefined();
});
