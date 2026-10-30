import { z } from "zod";

const gun = z.object({ capacity: z.number().int().positive().safe(), bullets: z.number().int().nonnegative().safe() }).strict()
  .refine(value => value.bullets <= value.capacity, "Invalid encounter gun");
export const CharacterEncounterPolicySchema = z.object({
  requiresDefeat: z.boolean(), rematchSkillChoices: z.boolean(), invitationLabel: z.string().min(1),
  playerGun: gun, opponentGun: gun.optional()
}).strict();
export type CharacterEncounterPolicy = z.infer<typeof CharacterEncounterPolicySchema>;
export const ORDINARY_ENCOUNTER_POLICY: CharacterEncounterPolicy = Object.freeze({
  requiresDefeat: false, rematchSkillChoices: false, invitationLabel: "邀请", playerGun: Object.freeze({ capacity: 6, bullets: 0 })
});
/** Resource APIs through 11 implied equipment and invitation rules from a display tier. */
export function legacyCharacterEncounterPolicy(tier: string): CharacterEncounterPolicy {
  return tier === "SS" ? { requiresDefeat: true, rematchSkillChoices: true, invitationLabel: "单独挑战", playerGun: { capacity: 8, bullets: 0 }, opponentGun: { capacity: 8, bullets: 0 } }
    : ORDINARY_ENCOUNTER_POLICY;
}
