import type { CharacterMetadata } from "./types";
import { ORDINARY_ENCOUNTER_POLICY } from "./encounter-policy";

/** Gameplay consumes an explicit policy; display tiers do not grant capabilities. */
export function characterEncounterCapabilities(character: Pick<CharacterMetadata, "tier"> & Partial<Pick<CharacterMetadata, "encounter">>) {
  const policy = character.encounter ?? ORDINARY_ENCOUNTER_POLICY;
  return { ...policy, playerGun: { ...policy.playerGun }, ...(policy.opponentGun ? { opponentGun: { ...policy.opponentGun } } : {}) };
}
