import type { PlayerSkillDefinition } from "../core/skills/types";

export function skillMetadata(skill: PlayerSkillDefinition): string {
  const labels = [skill.category === "active" ? "主动" : "被动"];
  if (skill.ttl) labels.push(skill.ttl.type === "rounds" ? `${skill.ttl.amount}轮` : `成功${skill.ttl.amount}次`);
  else if (skill.category === "active") labels.push(`${skill.uses}次`);
  labels.push(...(skill.metadataLabels ?? []));
  return labels.join(" · ");
}
