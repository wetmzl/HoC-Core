import type { CharacterDefinition } from "../content/characters";
import { getAbilityDefinition } from "../core/abilities/registry";
import { escapeHtml } from "./view-helpers";
import { skillSheetMarkup } from "./skill-sheet";

export function characterIntelMarkup(character: CharacterDefinition): string {
  const abilities = character.aiSkills.filter(binding => binding.enabled)
    .map(binding => getAbilityDefinition(binding.definitionId, undefined, binding.level))
    .filter((ability): ability is NonNullable<typeof ability> => Boolean(ability));
  const entries = abilities.map((ability, index) => `<article class="character-intel-skill"><span class="character-intel-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>${skillSheetMarkup(ability)}</article>`).join("");
  return `<details class="character-intel"><summary class="character-intel-tab" aria-label="角色情报，${abilities.length} 个 AI 技能"><svg class="character-intel-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></svg><strong>角色情报</strong><svg class="character-intel-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><section class="character-intel-sheet" aria-label="${escapeHtml(character.name)}的 AI 技能"><div class="character-intel-scroll" tabindex="0" role="region" aria-label="AI 技能描述，可上下滑动">${entries || '<p class="character-intel-empty">这位与会者没有携带 AI 技能。</p>'}</div></section></details>`;
}

/** Presentation state only; no match actions are dispatched by this sheet. */
export function mountCharacterIntel(root: HTMLElement, matchSeed: string, previous?: { seed?: string; open: boolean; scroll: number; expandedSkills?: boolean[] }): void {
  const sheet = root.querySelector<HTMLDetailsElement>(".character-intel");
  if (!sheet) return;
  sheet.dataset.matchSeed = matchSeed;
  if (previous?.seed === matchSeed) {
    sheet.open = previous.open;
    sheet.querySelectorAll<HTMLDetailsElement>("details.skill-sheet").forEach((skill, index) => {
      skill.open = previous.expandedSkills?.[index] ?? false;
    });
    const scroller = sheet.querySelector<HTMLElement>(".character-intel-scroll");
    if (scroller) scroller.scrollTop = previous.scroll;
  }
  const main = root.querySelector("main");
  main?.addEventListener("click", event => {
    if (event.target instanceof Node && !sheet.contains(event.target)) sheet.open = false;
  }, { capture: true });
  main?.addEventListener("keydown", event => {
    if (event.key === "Escape" && sheet.open) {
      event.stopPropagation();
      sheet.open = false;
      sheet.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
  });
}
