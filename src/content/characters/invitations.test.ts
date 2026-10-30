import { beforeEach, afterEach, describe, expect, it } from "vitest";
import trial from "../../../tests/fixtures/boss-trial.json";
import { loadCharacter } from "./index";
import { characterInvitation, pendingCharacterChallenges } from "./invitations";
import { createDefaultSave } from "../../persistence/boot";
import { EncounterFlowResourceSchema, getEncounterFlows, installEncounterFlows } from "../encounter-flows/catalog";
import { invitationFlow, pendingInvitationEntries } from "../encounters";

const installedFlows = getEncounterFlows();
const originalChallenges = [EncounterFlowResourceSchema.parse(trial)];
beforeEach(() => installEncounterFlows(originalChallenges));
afterEach(() => installEncounterFlows(installedFlows));

describe("invitation capabilities", () => {
  it("offers the authored flow through the same profile after the faction requirement is met", async () => {
    const character = await loadCharacter("claude"), save = createDefaultSave();
    expect(characterInvitation(character, save).available).toBe(false);
    save.defeats = ["chatgpt", "llama", "gemini", "deepseek"].map(opponentId => ({ opponentId, timestamp: save.createdAt }));
    const invitation = characterInvitation(character, save);
    expect(invitation.available).toBe(true); expect(invitation.challenge?.ownerId).toBe(character.id);
    expect(invitation.skills).toEqual([]); expect(invitation.abilities).toHaveLength(4);
    const withTemporaryBackground = { ...character, profile: { ...character.profile, backgrounds: [{ label: "牌室", image: "blob:temporary-profile-background" }] } };
    const definition = invitationFlow(withTemporaryBackground, save).definition;
    expect(definition.presentation?.backgroundCharacterId).toBe(character.id);
    expect(JSON.stringify(definition)).not.toContain("blob:");
  });
  it("supports legacy defeat records without requiring a separately stored completion flag", async () => {
    const character = await loadCharacter("claude"), save = createDefaultSave();
    save.defeats = [{ opponentId: character.id, timestamp: save.createdAt }];
    const invitation = characterInvitation(character, save);
    expect(invitation.available).toBe(true); expect(invitation.challenge).toBeUndefined();
    expect(invitation.skills).toHaveLength(4);
  });
  it("selects each challenge by identity and keeps another flow for the same opponent available", async () => {
    const character = await loadCharacter("claude"), save = createDefaultSave();
    const first = originalChallenges.find(definition => definition.ownerId === character.id)!;
    const second = { ...first, id: `${first.id}-second`, definition: { ...first.definition, id: `${first.id}-second`, completionId: `${first.id}-second` }, name: "Second trial", unlock: { type: "defeat-character" as const, characterId: "llama" } };
    installEncounterFlows([first, second]);
    save.defeats = [character.id, "llama"].map(opponentId => ({ opponentId, timestamp: save.createdAt }));
    expect(pendingCharacterChallenges(save).map(definition => definition.id)).toEqual([first.id, second.id]);
    expect(characterInvitation(character, save, first.id)).toMatchObject({ available: false, challenge: { id: first.id } });
    expect(characterInvitation(character, save, second.id)).toMatchObject({ available: true, challenge: { id: second.id } });
    expect(() => invitationFlow(character, save, [], first.id)).toThrow("尚未解锁");
    expect(invitationFlow(character, save, [], second.id).definition).toMatchObject({ completionId: second.id, presentation: { title: second.name } });
    expect(pendingInvitationEntries(save).map(entry => [entry.id, entry.label, entry.progress.unlocked])).toEqual([[first.id, first.name, false], [second.id, second.name, true]]);
    save.completedChallenges = [first.id];
    expect(pendingCharacterChallenges(save, character.id).map(definition => definition.id)).toEqual([second.id]);
    expect(characterInvitation(character, save).challenge).toBeUndefined();
    expect(() => characterInvitation(character, save, first.id)).toThrow("已结束");
    expect(() => characterInvitation(character, save, "unknown")).toThrow("不属于");
  });
});
