import type { CharacterMetadata } from "../content/characters";
import type { SkinPreviews } from "../content/packages/skin-previews";
import { escapeHtml, uiError } from "./view-helpers";
import { skinUnlockConditionLabel } from "../content/characters/skin-unlock";

/** Native modal: selection is tentative until Confirm; page/card DOM stays mounted. */
export function openSkinPicker(options: {
  root: HTMLElement; character: CharacterMetadata; signal: AbortSignal;
  load(key: string, signal: AbortSignal): Promise<SkinPreviews>;
  select(characterId: string, skinId: string, signal: AbortSignal): Promise<void>;
  isUnlocked(skinId: string): boolean;
}): void {
  const appearance = options.character.appearance;
  if (!appearance || appearance.skins.length < 2 || options.signal.aborted) return;
  options.root.querySelector<HTMLDialogElement>(".skin-picker")?.close();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, options.signal]);
  const dialog = document.createElement("dialog");
  dialog.className = "modal skin-picker";
  dialog.setAttribute("aria-labelledby", "skin-picker-title");
  dialog.innerHTML = `<button type="button" class="modal-close" data-skin-cancel aria-label="关闭换装">×</button><p class="eyebrow">${escapeHtml(options.character.name)}</p><h2 id="skin-picker-title">选择服装</h2><div class="skin-options" role="radiogroup" aria-label="服装"></div><p class="skin-status" role="status">正在准备服装……</p><div class="skin-picker-actions"><button type="button" class="secondary-button" data-skin-cancel>取消</button><button type="button" class="primary-button" data-skin-confirm disabled>确认</button></div>`;
  options.root.append(dialog);
  const scroll = { x: window.scrollX, y: window.scrollY };
  const parentScroll = [options.root, ...options.root.querySelectorAll<HTMLElement>(".lobby-character-shell, .character-list")].map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
  const status = dialog.querySelector<HTMLElement>(".skin-status")!;
  const confirm = dialog.querySelector<HTMLButtonElement>("[data-skin-confirm]")!;
  let selected = appearance.skinId, saving = false, previews: SkinPreviews | undefined;
  const refreshUnlocks = () => {
    dialog.querySelectorAll<HTMLButtonElement>("[data-skin-id]").forEach(button => {
      const locked = !options.isUnlocked(button.dataset.skinId!);
      button.toggleAttribute("data-skin-locked", locked);
      button.disabled = saving || locked || button.hasAttribute("data-skin-unavailable");
      const label = button.querySelector<HTMLElement>("[data-skin-lock-label]")!;
      const rule = appearance.skins.find(skin => skin.id === button.dataset.skinId)?.unlock;
      label.textContent = rule ? skinUnlockConditionLabel(rule) : "未解锁";
      label.hidden = !locked;
    });
    confirm.disabled = saving || !options.isUnlocked(selected) || !previews?.items.some(item => item.id === selected && item.image)
      || !!dialog.querySelector(`[data-skin-id="${CSS.escape(selected)}"][data-skin-unavailable]`);
  };
  options.root.addEventListener("character-skin-unlocks-changed", refreshUnlocks, { signal });
  const close = () => { if (!saving) dialog.close(); };
  const cleanup = () => {
    lifetime.abort(); previews?.release(); dialog.remove();
    if (options.signal.aborted) return;
    const button = [...options.root.querySelectorAll<HTMLButtonElement>("[data-change-skin]")].find(button => button.dataset.changeSkin === options.character.id);
    button?.focus({ preventScroll: true });
    for (const { element, top, left } of parentScroll) { element.scrollTop = top; element.scrollLeft = left; }
    window.scrollTo({ left: scroll.x, top: scroll.y, behavior: "instant" });
  };
  dialog.addEventListener("close", cleanup, { once: true });
  options.signal.addEventListener("abort", () => { saving = false; dialog.close(); }, { once: true, signal: lifetime.signal });
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  dialog.querySelectorAll<HTMLButtonElement>("[data-skin-cancel]").forEach(button => button.addEventListener("click", close));
  const choose = (button: HTMLButtonElement) => {
    if (saving || button.disabled) return;
    selected = button.dataset.skinId!;
    dialog.querySelectorAll<HTMLButtonElement>("[data-skin-id]").forEach(choice => {
      const checked = choice === button;
      choice.setAttribute("aria-checked", String(checked)); choice.tabIndex = checked ? 0 : -1;
    });
    confirm.disabled = false;
  };
  dialog.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-skin-id]");
    if (button) choose(button);
  });
  dialog.addEventListener("keydown", event => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !(event.target as Element).closest("[data-skin-id]")) return;
    event.preventDefault();
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("[data-skin-id]:not(:disabled)")];
    const current = buttons.findIndex(button => button.dataset.skinId === selected);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    const button = buttons[index];
    if (button) { choose(button); button.focus({ preventScroll: true }); button.scrollIntoView({ block: "nearest" }); }
  });
  confirm.addEventListener("click", () => {
    if (saving || confirm.disabled) return;
    saving = true;
    dialog.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    status.textContent = "正在换装……";
    void options.select(options.character.id, selected, signal).then(() => {
      if (!signal.aborted) { saving = false; dialog.close(); }
    }).catch(error => {
      if (signal.aborted) return;
      saving = false;
      dialog.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = button.hasAttribute("data-skin-unavailable"); });
      refreshUnlocks();
      status.textContent = uiError(error, "换装失败，请重试。");
    });
  });
  dialog.showModal();
  void options.load(appearance.key, signal).then(value => {
    if (signal.aborted) { value.release(); return; }
    previews = value;
    dialog.querySelector(".skin-options")!.innerHTML = value.items.map(item => `<button type="button" class="skin-option" role="radio" aria-checked="${item.id === selected}" tabindex="${item.id === selected ? 0 : -1}" data-skin-id="${escapeHtml(item.id)}" ${item.image ? "" : "disabled data-skin-unavailable"}><span class="skin-preview ${item.cover ? "skin-preview-cover" : ""}">${item.image ? `<img src="${escapeHtml(item.cover ?? item.image)}" ${item.cover ? "data-skin-cover" : ""} alt="${escapeHtml(item.name)}" decoding="async" />` : `<span>${escapeHtml(item.error ?? "立绘暂时不可用")}</span>`}</span><span class="skin-name">${escapeHtml(item.name)}${item.id === appearance.skinId ? '<small>（当前选择）</small>' : ''}<small data-skin-lock-label hidden>未解锁</small></span></button>`).join("");
    refreshUnlocks();
    status.textContent = "";
    // An undecodable image cannot be confirmed even if fetching its bytes succeeded.
    dialog.querySelectorAll<HTMLImageElement>(".skin-preview img").forEach(image => image.addEventListener("error", () => {
      const button = image.closest<HTMLButtonElement>("[data-skin-id]")!;
      const portrait = value.items.find(item => item.id === button.dataset.skinId)?.image;
      if (image.hasAttribute("data-skin-cover") && portrait) {
        image.removeAttribute("data-skin-cover");
        image.parentElement?.classList.remove("skin-preview-cover");
        image.src = portrait;
        return;
      }
      button.disabled = true; button.dataset.skinUnavailable = "";
      if (button.dataset.skinId === selected) confirm.disabled = true;
      image.replaceWith(document.createTextNode("立绘暂时不可用"));
    }, { signal }));
  }).catch(error => { if (!signal.aborted) status.textContent = uiError(error, "服装加载失败，请关闭后重试。"); });
}
