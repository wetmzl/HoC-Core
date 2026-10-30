import { characterPreviewStyle } from "./character-preview";
import type { CharacterDefinition } from "../content/characters";
import type { AbilityBinding } from "../core/abilities/types";
import { getAbilityDefinition } from "../core/abilities/registry";
import { escapeHtml } from "./view-helpers";
import { skillSheetMarkup } from "./skill-sheet";

export interface ProfileSkillChoice { readonly key: string; readonly full: AbilityBinding; readonly selected: AbilityBinding; readonly weakened: boolean; }

/** One profile body for the ordinary modal and full screen special-opponent dossier. */
export function characterProfileMarkup(character: CharacterDefinition, options: { abilities?: readonly AbilityBinding[]; showName?: boolean; skillChoices?: readonly ProfileSkillChoice[] } = {}): string {
  const entries = options.skillChoices
    ? options.skillChoices.map(choice => ({ binding: choice.selected, choice }))
    : (options.abilities ?? character.aiSkills).filter(binding => binding.enabled).map(binding => ({ binding, choice: undefined }));
  const rows = entries.map(({ binding, choice }) => {
    const definition = getAbilityDefinition(binding.definitionId, undefined, binding.level)
      ?? (choice && getAbilityDefinition(choice.full.definitionId, undefined, choice.full.level));
    if (!definition) return "";
    const copy = binding.enabled ? definition : { ...definition, description: "该技能已停用。", usage: undefined, profileLore: undefined };
    const sheet = skillSheetMarkup(copy);
    return choice ? `<div class="profile-skill-choice">${sheet}<label class="profile-skill-toggle"><input type="checkbox" data-weaken-skill="${escapeHtml(choice.key)}" aria-label="削弱${escapeHtml(definition.name)}" ${choice.weakened ? "checked" : ""}><span>削弱</span></label></div>` : sheet;
  }).join("");
  const skills = rows ? `<section class="profile-abilities" aria-label="角色技能"><h3>技能</h3>${options.skillChoices ? '<p class="profile-rematch-hint">可单独选择每项技能是否削弱，仅对本次挑战生效。</p>' : ""}${rows}</section>` : "";
  return `<img class="profile-portrait" style="${characterPreviewStyle(character)}" src="${escapeHtml(character.previewImage)}" alt="${escapeHtml(character.name)}" loading="lazy" decoding="async" /><p class="eyebrow">角色档案 // ${escapeHtml(character.tier)}级</p>${options.showName === false ? "" : `<h2>${escapeHtml(character.name)}</h2>`}${skills}<p class="profile-description">${escapeHtml(character.profile.description)}</p>`;
}
