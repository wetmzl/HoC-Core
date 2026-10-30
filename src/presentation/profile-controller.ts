import { loadCharacter, type CharacterDefinition } from "../content/characters";
import type { AbilityBinding } from "../core/abilities/types";
import type { RematchSkill } from "../content/characters/rematches";
import { characterProfileMarkup } from "./character-profile";
import { escapeHtml } from "./view-helpers";

export interface ProfileInvitation {
  readonly abilities?: readonly AbilityBinding[];
  readonly skills?: readonly RematchSkill[];
  readonly hint?: string;
  readonly available: boolean;
  start(weakenedSkills: readonly string[]): Promise<unknown>;
}
export const profileDialogMarkup = () => '<dialog id="profile" class="modal profile-modal" aria-label="个人档案"><button class="modal-close" data-close aria-label="关闭个人档案">×</button><div id="profile-content"></div></dialog>';

/** Every invitation uses this dialog, including encounters inside a longer flow. */
export class ProfileController {
  private request = 0;
  constructor(private readonly deps: { root: HTMLDivElement; invitation(character: CharacterDefinition): ProfileInvitation; selected(id: string): void; report(error: unknown): void }) {}
  invalidate(): void { this.request++; }
  open = async (id: string, invitation?: (character: CharacterDefinition) => ProfileInvitation, isCurrent = () => true): Promise<void> => {
    const request = ++this.request;
    const dialog = this.deps.root.querySelector<HTMLDialogElement>("#profile");
    if (!dialog) return;
    try {
      const character = await loadCharacter(id);
      if (request !== this.request || !dialog.isConnected || !isCurrent()) return;
      this.deps.selected(id);
      const entry = (invitation ?? this.deps.invitation)(character);
      const content = dialog.querySelector<HTMLElement>("#profile-content")!;
      const weakened = new Set<string>();
      const render = () => {
        const expanded = [...content.querySelectorAll<HTMLDetailsElement>(".skill-sheet")].map(sheet => sheet.open);
        const scroll = dialog.scrollTop;
        content.innerHTML = characterProfileMarkup(character, { abilities: entry.abilities,
          ...(entry.skills?.length ? { skillChoices: entry.skills.map(skill => ({ key: skill.key, full: skill.full,
            selected: weakened.has(skill.key) ? skill.weakened : skill.full, weakened: weakened.has(skill.key) })) } : {})
        }) + `${entry.hint ? `<p class="status-line">${escapeHtml(entry.hint)}</p>` : ""}<p role="status" data-encounter-status></p>${entry.available ? `<button class="primary-button profile-start" data-profile-start="${escapeHtml(id)}">开始对局 <span>→</span></button>` : ""}`;
        content.querySelectorAll<HTMLDetailsElement>(".skill-sheet").forEach((sheet, index) => { sheet.open = expanded[index] ?? false; });
        dialog.scrollTop = scroll;
        content.querySelectorAll<HTMLInputElement>("[data-weaken-skill]").forEach(input => input.onchange = () => {
          const key = input.dataset.weakenSkill!;
          if (input.checked) weakened.add(key); else weakened.delete(key);
          render();
          [...content.querySelectorAll<HTMLInputElement>("[data-weaken-skill]")].find(toggle => toggle.dataset.weakenSkill === key)?.focus({ preventScroll: true });
        });
        const start = content.querySelector<HTMLButtonElement>("[data-profile-start]");
        if (start) start.onclick = () => {
          if (request !== this.request || !isCurrent()) return;
          start.disabled = true;
          void entry.start([...weakened]).then(() => { if (dialog.isConnected) dialog.close(); }).catch(error => {
            if (dialog.isConnected) content.querySelector<HTMLElement>("[data-encounter-status]")!.textContent = error instanceof Error ? error.message : "开始失败，请重试";
          }).finally(() => { if (start.isConnected) start.disabled = false; });
        };
      };
      render();
      dialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => { this.invalidate(); dialog.close(); };
      dialog.oncancel = () => this.invalidate();
      dialog.showModal();
      dialog.scrollTop = 0;
    } catch (error) { if (request === this.request && isCurrent()) this.deps.report(error); }
  };
}
