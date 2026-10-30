import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCharacterDraft, createCharacterPackageDraft } from "../../authoring-api";
import { createDefaultSave } from "../../persistence/boot";
import { standaloneFlowDefinition } from "../encounters";
import { unlockConditionLabel } from "../../presentation/view-helpers";
import { CharacterMatchResourceSchema, createCharacterMatchResourceHandler } from "../packages/resources";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, installCharacterCatalog } from "./catalog";
import { characterInvitation } from "./invitations";
import { loadCharacter } from "./loader";
import { CharacterCatalogSchema } from "./schema";
import type { CharacterMetadata } from "./types";
import { isCharacterUnlocked, newlyUnlockedCharacterIds, unlockedCharacterIdsForDefeats } from "./unlocks";

const originalCatalog = CHARACTER_CATALOG, originalDefault = DEFAULT_CHARACTER_ID;
const originalCharacter = await loadCharacter(originalDefault);
const faction = "example/factions#guild";
const unlock = { type: "defeat-faction-count" as const, faction, count: 2 };
const metadata = (id: string, affiliation = faction): CharacterMetadata => ({
  id, name: id, subtitle: "Neutral attendee", tier: "A", tags: [], faction: affiliation,
  previewImage: "cover.png", portraitScales: { selection: 1, table: 1 }
});
const target = { ...metadata("target"), unlock };
const entries = [metadata("first"), metadata("second"), { ...metadata("third"), tier: "SS" as const },
  metadata("other", "other/factions#guild"), { ...metadata("unaffiliated"), faction: undefined }, target];
const defeats = (...ids: string[]) => ids.map(opponentId => ({ opponentId, timestamp: "2026-01-01T00:00:00.000Z" }));

beforeEach(() => installCharacterCatalog(entries, "first"));
afterEach(() => installCharacterCatalog(originalCatalog, originalDefault));

describe("ordinary faction-count unlocks", () => {
  it("requires distinct victories from the qualified faction and excludes self and unknown records", () => {
    for (const ids of [[], ["first"], ["first", "first"], ["first", "other", "unaffiliated", "unknown", "target"]]) {
      expect(isCharacterUnlocked(target, defeats(...ids))).toBe(false);
    }
    expect(isCharacterUnlocked(target, defeats("first", "second"))).toBe(true);
    expect(isCharacterUnlocked(target, defeats("first", "third"))).toBe(true);
    expect(unlockedCharacterIdsForDefeats([])).not.toContain("target");
    expect(newlyUnlockedCharacterIds(defeats("first"), defeats("first", "second"))).toEqual(["target"]);
  });

  it("keeps the count fixed as content is enabled, disabled, and restored without changing records", () => {
    const records = defeats("first", "second");
    installCharacterCatalog([...entries, metadata("fourth"), metadata("fifth")], "first");
    expect(isCharacterUnlocked(target, records)).toBe(true);
    installCharacterCatalog(entries.filter(character => character.id !== "second"), "first");
    expect(isCharacterUnlocked(target, records)).toBe(false);
    installCharacterCatalog(entries, "first");
    expect(isCharacterUnlocked(target, records)).toBe(true);
    expect(records).toEqual(defeats("first", "second"));
  });

  it("shares eligibility with invitations and preserves invitations for previously defeated attendees", () => {
    const character = { ...originalCharacter, ...target };
    const save = createDefaultSave();
    expect(characterInvitation(character, save).available).toBe(false);
    expect(() => standaloneFlowDefinition(character, save)).toThrow("尚未解锁");
    save.defeats = defeats("first", "second");
    expect(characterInvitation(character, save).available).toBe(true);
    expect(standaloneFlowDefinition(character, save).nodes[0].opponentId).toBe("target");
    save.defeats = defeats("target");
    expect(characterInvitation(character, save).available).toBe(true);
  });

  it("validates qualified references and positive safe integer thresholds in both schemas", () => {
    const draft = createCharacterDraft("target", "Target");
    for (const condition of [unlock, { ...unlock, faction: "example/absent#guild" }]) {
      expect(CharacterMatchResourceSchema.safeParse({ ...draft.match, metadata: { ...draft.match.metadata, unlock: condition } }).success).toBe(true);
      expect(CharacterCatalogSchema.safeParse({ defaultCharacterId: "first", characters: [metadata("first"), { ...target, unlock: condition }] }).success).toBe(true);
    }
    for (const condition of [{ ...unlock, faction: "guild" }, { ...unlock, count: 0 }, { ...unlock, count: -1 }, { ...unlock, count: 1.5 }, { ...unlock, count: Infinity }, { ...unlock, count: Number.MAX_SAFE_INTEGER + 1 }, { ...unlock, extra: true }]) {
      expect(CharacterMatchResourceSchema.safeParse({ ...draft.match, metadata: { ...draft.match.metadata, unlock: condition } }).success).toBe(false);
      expect(CharacterCatalogSchema.safeParse({ defaultCharacterId: "first", characters: [metadata("first"), { ...target, unlock: condition }] }).success).toBe(false);
    }
  });

  it("requires API 15 and accepts a standalone ordinary character without skin or faction dependencies", async () => {
    const draft = createCharacterDraft("target", "Target");
    const match = { ...draft.match, metadata: { ...draft.match.metadata, unlock } };
    const descriptor = { id: "match", type: "game.character-match", apiVersion: 15, entry: "match.json", requires: ["dialogue"] };
    const context = { descriptor, manifest: { ...createCharacterPackageDraft("target", "Target").manifest, resources: [descriptor, { id: "dialogue", type: "game.character-dialogue", apiVersion: 3, entry: "dialogue.json", requires: [] }] },
      packageBaseUrl: "/", dependencies: new Map([["dialogue", {}]]), resolvePath: (path: string) => path };
    for (const apiVersion of [12, 13, 14]) {
      await expect(createCharacterMatchResourceHandler().parse(match, { ...context, descriptor: { ...descriptor, apiVersion } })).rejects.toThrow("API 15");
    }
    await expect(createCharacterMatchResourceHandler().parse(match, context)).resolves.toMatchObject({ metadata: { unlock } });
  });

  it("labels the faction by its resolved name and falls back to its qualified identity", () => {
    expect(unlockConditionLabel(unlock)).toContain(faction);
    installCharacterCatalog(entries.map(character => character.id === "first" ? { ...character, badge: { image: "badge.png", label: "星辰公会" } } : character), "first");
    expect(unlockConditionLabel(unlock)).toBe("击败「星辰公会」阵营的 2 名不同角色");
  });
});
