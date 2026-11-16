import { describe, expect, it } from "vitest";
import { createDefaultSave } from "../../persistence/boot";
import { invitationProgram } from "../encounters";
import { encounterUnlockProgress, getEncounterFlows } from "../encounter-flows/catalog";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, getCharacterMetadata } from "./catalog";
import { loadCharacter } from "./loader";
import { characterInvitation } from "./invitations";
import { unlockedCharacterIdsForDefeats } from "./unlocks";

const branch = ["gemini", "glm", "grok", "qwen"];
const ordinary = ["llama", "deepseek", "chatgpt", ...branch];
const defeats = (...ids: string[]) => ids.map(opponentId => ({ opponentId, timestamp: new Date(0).toISOString() }));

describe("official attendee progression", () => {
  it("starts with Llama and opens the four parallel opponents only after ChatGPT", () => {
    expect(DEFAULT_CHARACTER_ID).toBe("llama");
    for (const [won, available] of [
      [[], ["llama"]],
      [["llama"], ["llama", "deepseek"]],
      [["llama", "deepseek"], ["llama", "deepseek", "chatgpt"]],
      [["llama", "deepseek", "chatgpt"], ordinary]
    ]) {
      expect(unlockedCharacterIdsForDefeats(defeats(...won)).filter(id => ordinary.includes(id)).sort()).toEqual([...available].sort());
    }
  });

  it("enforces prerequisites at invitation creation and preserves previously defeated rematches", async () => {
    for (const id of ordinary.slice(1)) {
      const character = await loadCharacter(id);
      const prerequisite = getCharacterMetadata(id)!.unlock!;
      expect(prerequisite.type).toBe("defeat-character");
      if (prerequisite.type !== "defeat-character") throw new Error("Missing prerequisite");
      const save = createDefaultSave();
      expect(characterInvitation(character, save).available).toBe(false);
      expect(() => invitationProgram(character, save)).toThrow("尚未解锁");
      save.defeats = defeats(prerequisite.characterId);
      expect(characterInvitation(character, save).available).toBe(true);
      expect(() => invitationProgram(character, save)).not.toThrow();
      save.defeats = defeats(id);
      expect(characterInvitation(character, save).available).toBe(true);
    }
  });

  it("requires all seven other official attendees for Claude, regardless of branch order", async () => {
    const entry = getEncounterFlows().find(entry => entry.ownerId === "claude")!;
    const character = await loadCharacter("claude");
    for (const missing of ordinary) {
      const save = createDefaultSave();
      const won = ordinary.filter(id => id !== missing);
      save.defeats = defeats(...won, won[0], "claude", "unknown");
      expect(encounterUnlockProgress(entry, save.defeats, CHARACTER_CATALOG)).toEqual({ current: 6, required: 7, unlocked: false });
    }
    const save = createDefaultSave();
    save.defeats = defeats(...[...ordinary].reverse());
    expect(encounterUnlockProgress(entry, save.defeats, CHARACTER_CATALOG)).toEqual({ current: 7, required: 7, unlocked: true });
    expect(characterInvitation(character, save).available).toBe(true);
    expect(() => invitationProgram(character, save)).not.toThrow();
  });
});
