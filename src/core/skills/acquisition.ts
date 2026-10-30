/** Definition-wide lifetime acquisitions; consumption and expiry do not refund them. */
export type SkillAcquisitionCounts = Readonly<Record<string, number>>;
type LimitedSkill = { readonly id: string; readonly acquisitionLimit?: { readonly perMatch: number } };

export function skillAcquisitionCount(id: string, counts: SkillAcquisitionCounts = {}, heldDefinitionIds: readonly string[] = []): number {
  const recorded = Object.prototype.hasOwnProperty.call(counts, id) ? counts[id]! : 0;
  if (!Number.isSafeInteger(recorded) || recorded < 0) throw new Error("Invalid Player Skill acquisition count");
  return Math.max(recorded, heldDefinitionIds.filter(held => held === id).length);
}

export function canAcquirePlayerSkill(skill: LimitedSkill, counts: SkillAcquisitionCounts = {}, heldDefinitionIds: readonly string[] = []): boolean {
  return skill.acquisitionLimit === undefined || skillAcquisitionCount(skill.id, counts, heldDefinitionIds) < skill.acquisitionLimit.perMatch;
}

export function recordPlayerSkillAcquisition(skill: LimitedSkill, counts: SkillAcquisitionCounts = {}, heldDefinitionIds: readonly string[] = []): SkillAcquisitionCounts {
  if (!canAcquirePlayerSkill(skill, counts, heldDefinitionIds)) throw new Error(`Player Skill acquisition limit reached: ${skill.id}`);
  const next = skillAcquisitionCount(skill.id, counts, heldDefinitionIds) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Player Skill acquisition count overflow");
  return { ...counts, [skill.id]: next };
}
