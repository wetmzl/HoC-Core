import { gameAudio } from "../audio/game-audio";
import type { AchievementUiRuntime, CompletedAchievementPresentation } from "../runtime/achievement-ui";
import { escapeHtml } from "./view-helpers";
import { isTutorialContextVisible } from "./tutorial-context";

const LIFETIME_MS = 3000;

/** At most three independent cards; the third aggregates further unlocks as name +N. */
export function mountAchievementToasts(root: HTMLElement, source: AchievementUiRuntime,
  coverMarkup: (row: CompletedAchievementPresentation) => string): () => void {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const region = document.createElement("div");
  region.className = "achievement-toast-region";
  region.hidden = true;
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  const nativePopover = typeof region.showPopover === "function";
  if (nativePopover) region.setAttribute("popover", "manual");
  region.addEventListener("error", event => {
    if (event.target instanceof HTMLImageElement) event.target.remove();
  }, { capture: true, signal });
  interface Card {
    keys: string[]; remaining: number; deadline: number; running: boolean;
    element: HTMLElement; markup: string; sounded: boolean;
  }
  const cards: Card[] = [];
  const incoming: string[] = [];
  let returnFocus: HTMLElement | undefined;
  let frame = 0, lifeFrame = 0, raise = false;
  const popoverOpen = () => nativePopover && region.matches(":popover-open");
  const hidePopover = () => { if (popoverOpen()) region.hidePopover(); };
  const hide = () => {
    const now = performance.now();
    for (const card of cards) {
      if (card.running) card.remaining = Math.max(0, card.deadline - now);
      card.running = false;
    }
    cancelAnimationFrame(lifeFrame); lifeFrame = 0;
    gameAudio.stopAchievementUnlock(); hidePopover();
    if (!region.hidden) region.hidden = true;
  };
  const remove = (card: Card) => {
    const focused = card.element.contains(document.activeElement);
    cards.splice(cards.indexOf(card), 1); card.element.remove();
    if (focused && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    if (!cards.length) hide();
  };
  const updateProgress = (card: Card) => {
    const progress = card.element.querySelector<HTMLElement>(".achievement-toast-progress");
    if (progress) progress.style.transform = `scaleX(${Math.min(1, Math.max(0, 1 - card.remaining / LIFETIME_MS))})`;
  };
  const tick = () => {
    lifeFrame = 0;
    if (signal.aborted) return;
    if (document.hidden) { hide(); return; }
    const now = performance.now();
    for (const card of [...cards]) {
      if (!card.running) continue;
      card.remaining = Math.max(0, card.deadline - now); updateProgress(card);
      if (!card.remaining) remove(card);
    }
    if (cards.length) lifeFrame = requestAnimationFrame(tick);
  };
  const host = (): Element => {
    // A body sibling of a modal is inert, even when its popover is drawn on top.
    // Use the actual interactive modal, not DOM order, for both status accessibility and stacking.
    const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")]
      .filter(dialog => isTutorialContextVisible(dialog));
    return dialogs.find(dialog => !dialogs.some(other => other !== dialog && dialog.contains(other)))
      ?? document.fullscreenElement ?? document.body;
  };
  const place = () => {
    frame = 0;
    if (signal.aborted) return;
    const completed = new Map(source.snapshot.list.rows.filter((row): row is CompletedAchievementPresentation => row.status === "completed")
      .map(row => [row.key, row]));
    // Keep stable card nodes and current content-owned media across content reloads.
    for (const card of [...cards]) {
      card.keys = card.keys.filter(key => completed.has(key));
      if (!card.keys.length) remove(card);
    }
    for (const key of incoming.splice(0)) {
      if (!completed.has(key)) continue;
      if (cards.length === 3) { cards[2].keys.push(key); continue; }
      if (document.activeElement instanceof HTMLElement && !region.contains(document.activeElement)) returnFocus = document.activeElement;
      const element = document.createElement("div");
      element.className = "achievement-toast-item";
      cards.push({ keys: [key], remaining: LIFETIME_MS, deadline: 0, running: false, sounded: false, element, markup: "" });
      region.append(element);
    }
    if (document.hidden || !root.isConnected || !cards.length) { hide(); return; }
    for (const card of cards) {
      const row = completed.get(card.keys[0])!;
      const more = card.keys.length - 1;
      const markup = `<div class="achievement-toast">${coverMarkup(row)}<div class="achievement-toast-copy"><span class="achievement-toast-heading">成就已解锁</span><strong><span class="achievement-toast-name">${escapeHtml(row.name)}</span>${more ? `<small class="achievement-toast-more"> +${more}</small>` : ""}</strong></div><button type="button" class="achievement-toast-close" aria-label="关闭当前成就提示" title="关闭当前成就提示">×</button><span class="achievement-toast-progress" aria-hidden="true"></span></div>`;
      if (card.markup !== markup) {
        const focused = card.element.contains(document.activeElement);
        card.markup = markup; card.element.innerHTML = markup;
        if (focused) card.element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      }
    }
    const parent = host();
    if (region.parentElement !== parent) { hidePopover(); parent.append(region); raise = true; }
    if (region.hidden) region.hidden = false;
    if (nativePopover) {
      if (raise) hidePopover();
      if (!popoverOpen()) region.showPopover();
    }
    raise = false;
    let play = false;
    for (const card of cards) {
      if (!card.running) {
        card.deadline = performance.now() + card.remaining; card.running = true;
        if (!card.sounded) { card.sounded = true; play = true; }
      } else card.remaining = Math.max(0, card.deadline - performance.now());
      updateProgress(card);
    }
    if (play) gameAudio.playAchievementUnlock();
    if (!lifeFrame) lifeFrame = requestAnimationFrame(tick);
  };
  const schedule = () => { if (!frame && !signal.aborted) frame = requestAnimationFrame(place); };
  region.addEventListener("click", event => {
    const button = (event.target as Element).closest(".achievement-toast-close");
    if (!button) return;
    const card = cards.find(card => card.element.contains(button));
    if (card) { event.stopPropagation(); remove(card); schedule(); }
  }, { signal });
  const unsubscribeUnlocked = source.subscribeUnlocked(row => { incoming.push(row.key); schedule(); });
  const unsubscribeCatalog = source.subscribe(schedule);
  const observer = new MutationObserver(mutations => {
    // Closing and reopening the same native dialog in one task still changes top-layer order.
    if (mutations.some(mutation => mutation.type === "attributes" && mutation.attributeName === "open"
      && mutation.target instanceof HTMLDialogElement)) raise = true;
    schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "class"] });
  document.addEventListener("visibilitychange", () => { if (document.hidden) hide(); else schedule(); }, { signal });
  document.addEventListener("fullscreenchange", () => { raise = true; schedule(); }, { signal });
  window.addEventListener("resize", schedule, { signal });

  return () => {
    lifetime.abort(); unsubscribeUnlocked(); unsubscribeCatalog(); observer.disconnect();
    cancelAnimationFrame(frame); hide(); region.remove(); cards.length = 0; incoming.length = 0;
  };
}
