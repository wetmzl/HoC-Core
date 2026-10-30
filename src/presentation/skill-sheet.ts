import type { AbilityDefinition } from "../core/abilities/types";
import { escapeHtml } from "./view-helpers";
import "./skill-sheet.css";

type SkillCopy = Pick<AbilityDefinition, "name" | "description" | "profileLore" | "usage">;

/** Shared disclosure for skill descriptions across dossiers, decks and encounters. */
export function skillSheetMarkup(skill: SkillCopy, options: { showName?: boolean; titleId?: string; open?: boolean } = {}): string {
  const lore = skill.profileLore && skill.profileLore !== skill.description ? skill.profileLore : undefined;
  const rules = skill.usage && skill.usage !== skill.description ? skill.usage : undefined;
  const brief = `<span class="skill-sheet-brief">${options.showName === false ? "" : `<strong${options.titleId ? ` id="${escapeHtml(options.titleId)}"` : ""}>${escapeHtml(skill.name)}</strong><span>：</span>`}<span>${escapeHtml(skill.description)}</span></span>`;
  if (!rules && !lore) return `<article class="skill-sheet skill-sheet-static">${brief}</article>`;
  return `<details class="skill-sheet"${options.open ? " open" : ""}><summary>${brief}</summary><div class="skill-sheet-expanded">${lore ? `<p class="skill-sheet-lore"><em>${escapeHtml(lore)}</em></p>` : ""}${rules ? `<div class="skill-sheet-rules"><p>${escapeHtml(rules)}</p></div>` : ""}</div></details>`;
}
