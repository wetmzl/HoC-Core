import { getAbilityDefinition } from "../core/abilities/registry";
import type { PlayerSkillDefinition } from "../core/skills/types";
import { escapeHtml } from "./view-helpers";

export function skillMetadata(skill: PlayerSkillDefinition): string {
  const labels = [skill.category === "active" ? "主动" : "被动"];
  if (skill.ttl) labels.push(skill.ttl.type === "rounds" ? `${skill.ttl.amount}轮` : `成功${skill.ttl.amount}次`);
  else if (skill.category === "active") labels.push(`${skill.uses}次`);
  const definition = getAbilityDefinition(skill.id);
  if (definition?.activation.type === "action" && definition.activation.availability?.some(condition =>
    condition.type === "gun-is-full" && condition.target === "owner" && condition.expected === false)) labels.push("满弹不可用");
  return labels.join(" · ");
}

export function skillRulesMarkup(description: string, usage?: string): string {
  return usage && usage !== description
    ? `<details class="skill-rules"><summary>详细规则</summary><p>${escapeHtml(usage)}</p></details>` : "";
}
