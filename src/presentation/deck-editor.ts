import { skillMetadata } from "./skill-copy";
import { skillSheetMarkup } from "./skill-sheet";
import "./skill-card.css";
import "./deck-editor.css";
import { moveDeckSkill, skillDeckRequirement, type DeckZone } from "../core/skills/deck";
import { SKILL_TAG_METADATA, SKILL_TAGS, type PlayerSkillDefinition } from "../core/skills/types";
import type { DeckSaveQueue } from "./deck-save-queue";
import { haptics } from "./haptic-service";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export interface DeckEditorOptions {
  readonly skills: readonly PlayerSkillDefinition[];
  readonly queue: DeckSaveQueue;
  readonly reducedMotion: () => boolean;
  readonly message?: string;
}

/** Touch keeps native scrolling until the stationary long press is recognized. */
export function mountDeckEditor(host: HTMLElement, options: DeckEditorOptions): () => void {
  const { skills, queue } = options;
  const definitions = new Map(skills.map((skill) => [skill.id, skill]));
  const available = skills.map((skill) => skill.id);
  const controller = new AbortController();
  const { signal } = controller;
  const scroll = host.closest<HTMLElement>("#skill-content") ?? host;
  let query = "";
  let tag = "";
  let category = "";
  let detailId: string | undefined;
  let lastTick = -Infinity;
  let suppressClick = false;
  let disposed = false;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const ghosts = new Set<HTMLElement>();
  let pending: { id: string; x: number; y: number; touch: boolean } | undefined;
  let drag: { id: string; x: number; y: number; zone: DeckZone; before?: string; valid: boolean; ghost: HTMLElement; source: HTMLElement } | undefined;
  const feedback = (duration: number) => {
    if (!options.reducedMotion() && !matchMedia("(prefers-reduced-motion: reduce)").matches) void haptics.play([duration], { signal });
  };
  const animated = () => !options.reducedMotion() && !matchMedia("(prefers-reduced-motion: reduce)").matches;

  host.innerHTML = `<div class="deck-editor"><details class="deck-filter"><summary><span>筛选</span><small data-filter-summary>全部备选技能</small></summary><div class="deck-filter-fields"><label>名称<input type="search" data-deck-query placeholder="搜索技能" autocomplete="off"></label><div><label>流派<select data-deck-tag><option value="">全部流派</option>${SKILL_TAGS.map((value) => `<option value="${value}">${SKILL_TAG_METADATA[value].label}</option>`).join("")}</select></label><label>类型<select data-deck-category><option value="">主动与被动</option><option value="active">主动</option><option value="passive">被动</option></select></label></div><button type="button" class="quiet-button" data-deck-clear>清除筛选</button></div></details><section class="deck-zone" data-deck-zone="carried" aria-label="携带卡组"><header><h3>携带卡组</h3><output data-deck-count></output></header><p class="deck-caption" data-deck-requirement></p><div class="deck-scroll" data-deck-scroll="carried" role="region" aria-label="携带卡组卡牌列表" tabindex="0"><div class="deck-grid" data-deck-grid="carried"></div></div></section><section class="deck-zone" data-deck-zone="reserve" aria-label="备选技能"><header><h3>备选技能</h3><output data-reserve-count></output></header><p class="deck-caption">长按拖动，加入或移出卡组；点击查看详情</p><div class="deck-scroll" data-deck-scroll="reserve" role="region" aria-label="备选技能卡牌列表" tabindex="0"><div class="deck-grid" data-deck-grid="reserve"></div></div></section><p class="deck-status" role="status" aria-live="polite" data-deck-status>${escape(options.message ?? "卡组只影响下一局的技能抽取")}</p></div><dialog class="modal deck-detail" aria-labelledby="deck-detail-title"><button type="button" class="modal-close" data-deck-detail-close aria-label="关闭技能详情">×</button><div data-deck-detail-body></div></dialog>`;
  const detail = host.querySelector<HTMLDialogElement>(".deck-detail")!;
  const status = host.querySelector<HTMLElement>("[data-deck-status]")!;
  const cardMarkup = (skill: PlayerSkillDefinition) => `<button type="button" class="deck-tile" data-deck-id="${escape(skill.id)}" data-own-haptic aria-label="查看${escape(skill.name)}，${skill.category === "passive" ? "被动" : "主动"}，${SKILL_TAG_METADATA[skill.primaryDomain].label}"><span class="skill-card ${skill.category === "passive" ? "passive-card" : ""}"><b>${escape(skill.name)}</b><small>${skill.category === "passive" ? "被动" : "主动"}<span class="deck-card-tag" aria-label="${SKILL_TAG_METADATA[skill.primaryDomain].label}">${SKILL_TAG_METADATA[skill.primaryDomain].symbol}</span></small></span></button>`;
  function visible(id: string, zone: DeckZone): boolean {
    const skill = definitions.get(id);
    return Boolean(skill && (zone === "carried" || ((!query || skill.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!tag || skill.skillTags.some((value) => value === tag)) && (!category || skill.category === category))));
  }
  function renderGrids(withAnimation = false): void {
    const previous = new Map<string, DOMRect>();
    if (withAnimation && animated()) host.querySelectorAll<HTMLElement>(".deck-grid [data-deck-id]").forEach((card) => previous.set(card.dataset.deckId!, card.getBoundingClientRect()));
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.deckId : undefined;
    const deck = drag?.valid ? moveDeckSkill(queue.get(), drag.id, drag.zone, drag.before) : queue.get();
    for (const zone of ["carried", "reserve"] as const) {
      const grid = host.querySelector<HTMLElement>(`[data-deck-grid="${zone}"]`)!;
      const viewport = host.querySelector<HTMLElement>(`[data-deck-scroll="${zone}"]`)!;
      const offset = viewport.scrollTop;
      const ids = deck[zone].filter((id) => visible(id, zone));
      grid.innerHTML = ids.map((id) => drag?.id === id ? `<span class="deck-placeholder" aria-label="卡牌插入位置"></span>` : cardMarkup(definitions.get(id)!)).join("") || `<span class="deck-empty">${zone === "carried" ? "将技能拖到这里" : query || tag || category ? "没有符合筛选的技能" : "所有可用技能都已携带"}</span>`;
      viewport.scrollTop = offset;
      host.querySelector(`[data-deck-zone="${zone}"]`)?.classList.toggle("is-drop-target", Boolean(drag?.valid && drag.zone === zone));
    }
    const requirement = skillDeckRequirement(deck, available);
    host.querySelector("[data-deck-count]")!.textContent = `${requirement.count} 种 · 最低 ${requirement.minimum} 种`;
    const warning = host.querySelector<HTMLElement>("[data-deck-requirement]")!;
    warning.textContent = requirement.missing ? `还需加入 ${requirement.missing} 种技能才能开始新对局` : "局内候选来自携带卡组 · 不设上限";
    warning.classList.toggle("is-short", Boolean(requirement.missing));
    host.querySelector("[data-reserve-count]")!.textContent = `${deck.reserve.filter((id) => visible(id, "reserve")).length} 种`;
    host.querySelector("[data-filter-summary]")!.textContent = [query ? `“${query}”` : "", tag ? SKILL_TAG_METADATA[tag as keyof typeof SKILL_TAG_METADATA].label : "", category ? category === "active" ? "主动" : "被动" : ""].filter(Boolean).join(" · ") || "全部备选技能";
    if (previous.size) host.querySelectorAll<HTMLElement>(".deck-grid [data-deck-id]").forEach((card) => {
      const before = previous.get(card.dataset.deckId!);
      if (!before) return;
      const after = card.getBoundingClientRect();
      const x = before.left - after.left, y = before.top - after.top;
      if (x || y) card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], { duration: 190, easing: "cubic-bezier(.2,.8,.3,1)" });
    });
    if (focused) Array.from(host.querySelectorAll<HTMLElement>(".deck-grid [data-deck-id]")).find((card) => card.dataset.deckId === focused)?.focus({ preventScroll: true });
  }
  function renderDetail(): void {
    const skill = detailId ? definitions.get(detailId) : undefined;
    if (!skill) return;
    const deck = queue.get();
    const zone: DeckZone = deck.carried.includes(skill.id) ? "carried" : "reserve";
    const visibleIds = deck[zone].filter((id) => visible(id, zone));
    const index = visibleIds.indexOf(skill.id);
    host.querySelector("[data-deck-detail-body]")!.innerHTML = `<p class="eyebrow">${zone === "carried" ? "携带卡组" : "备选技能"} · ${escape(skillMetadata(skill))} · ${SKILL_TAG_METADATA[skill.primaryDomain].label}</p>${skillSheetMarkup(skill, { titleId: "deck-detail-title" })}<div class="deck-detail-actions"><button type="button" class="primary-button" data-deck-transfer data-own-haptic>${zone === "carried" ? "移出卡组" : "加入卡组"}</button><div><button type="button" class="secondary-button" data-deck-step="-1" data-own-haptic ${index <= 0 ? "disabled" : ""}>前移</button><button type="button" class="secondary-button" data-deck-step="1" data-own-haptic ${index < 0 || index >= visibleIds.length - 1 ? "disabled" : ""}>后移</button></div></div>`;
  }
  const unsubscribe = queue.subscribe((_deck, state) => {
    if (disposed) return;
    status.textContent = state === "saving" ? "正在保存…" : state === "saved" ? "卡组已保存" : "保存失败，已恢复最后成功保存的卡组，请重试";
    status.classList.toggle("is-short", state === "failed");
    if (state === "failed") cancelDrag();
    if (!drag) renderGrids(state === "saving");
    if (detail.open) renderDetail();
  });
  host.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-deck-query]")) query = target.value.trim();
    else if (target.matches("[data-deck-tag]")) tag = target.value;
    else if (target.matches("[data-deck-category]")) category = target.value;
    else return;
    cancelDrag();
    host.querySelector<HTMLElement>('[data-deck-scroll="reserve"]')!.scrollTop = 0;
    renderGrids();
  }, { signal });
  host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); return; }
    const card = target.closest<HTMLElement>("[data-deck-id]");
    if (card) {
      detailId = card.dataset.deckId;
      renderDetail();
      detail.showModal();
      feedback(8);
    } else if (target.closest("[data-deck-detail-close]")) detail.close();
    else if (target.closest("[data-deck-clear]")) {
      query = tag = category = "";
      host.querySelector<HTMLInputElement>("[data-deck-query]")!.value = "";
      host.querySelector<HTMLSelectElement>("[data-deck-tag]")!.value = "";
      host.querySelector<HTMLSelectElement>("[data-deck-category]")!.value = "";
      renderGrids();
    } else if (detailId && target.closest("[data-deck-transfer], [data-deck-step]")) {
      const deck = queue.get();
      const zone: DeckZone = deck.carried.includes(detailId) ? "carried" : "reserve";
      const transfer = Boolean(target.closest("[data-deck-transfer]"));
      const ids = deck[zone].filter((id) => visible(id, zone));
      const index = ids.indexOf(detailId);
      const step = Number(target.closest<HTMLElement>("[data-deck-step]")?.dataset.deckStep);
      const next = moveDeckSkill(deck, detailId, transfer ? zone === "carried" ? "reserve" : "carried" : zone, transfer ? undefined : step < 0 ? ids[index - 1] : ids[index + 2]);
      void queue.update(next);
      feedback(18);
      const action = transfer ? "transfer" : `step=\"${step}\"`;
      detail.querySelector<HTMLElement>(transfer ? "[data-deck-transfer]" : `[data-deck-${action}]`)?.focus({ preventScroll: true });
    }
  }, { signal });

  function clearPending(): void { clearTimeout(hold); hold = undefined; pending = undefined; }
  function removeGhost(ghost: HTMLElement): void { ghost.remove(); ghosts.delete(ghost); }
  function cancelDrag(): void {
    clearPending();
    cancelAnimationFrame(frame);
    ghosts.forEach(removeGhost);
    if (!drag) return;
    removeGhost(drag.ghost);
    drag.source.remove();
    drag = undefined;
    renderGrids();
    host.classList.remove("is-dragging");
    setTimeout(() => { suppressClick = false; }, 350);
  }
  function placeGhost(): void {
    if (!drag) return;
    drag.ghost.style.left = `${drag.x - 26}px`;
    drag.ghost.style.top = `${drag.y - 84}px`;
  }
  function pickUp(): void {
    if (!pending || disposed || !host.isConnected || detail.open) return;
    const { id, x, y } = pending;
    const original = Array.from(host.querySelectorAll<HTMLElement>(".deck-grid [data-deck-id]")).find((card) => card.dataset.deckId === id);
    if (!original) return;
    const ghost = document.createElement("div");
    ghost.className = "deck-drag-ghost";
    ghosts.add(ghost);
    ghost.innerHTML = cardMarkup(definitions.get(id)!);
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("popover", "manual");
    (host.closest("dialog") ?? document.body).append(ghost);
    if (typeof ghost.showPopover === "function") ghost.showPopover();
    const zone: DeckZone = queue.get().carried.includes(id) ? "carried" : "reserve";
    const ids = queue.get()[zone];
    // Keep the original touch target connected throughout the gesture. Replacing
    // its grid would otherwise detach it and stop touchmove bubbling on mobile.
    original.classList.add("deck-touch-anchor");
    original.setAttribute("aria-hidden", "true");
    host.append(original);
    drag = { id, x, y, zone, before: ids[ids.indexOf(id) + 1], valid: true, ghost, source: original };
    suppressClick = true;
    clearTimeout(hold);
    host.classList.add("is-dragging");
    placeGhost();
    renderGrids();
    feedback(12);
    frame = requestAnimationFrame(autoScroll);
  }
  function locateTarget(): void {
    if (!drag) return;
    const point = document.elementFromPoint(drag.x, drag.y);
    const target = point?.closest<HTMLElement>("[data-deck-zone]");
    if (!target || !host.contains(target)) {
      if (drag.valid) { drag.valid = false; renderGrids(true); }
      return;
    }
    const zone = target.dataset.deckZone as DeckZone;
    const cards = Array.from(target.querySelectorAll<HTMLElement>("[data-deck-id]"));
    let before: string | undefined;
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      if (drag.y < box.top || (drag.y <= box.bottom && drag.x < box.left + box.width / 2)) { before = card.dataset.deckId; break; }
    }
    if (!drag.valid || zone !== drag.zone || before !== drag.before) {
      const crossed = zone !== drag.zone;
      drag.zone = zone; drag.before = before; drag.valid = true;
      renderGrids(true);
      const now = performance.now();
      if (crossed) { feedback(8); lastTick = now; }
      else if (now - lastTick >= 80) { feedback(4); lastTick = now; }
    }
  }
  let previousFrame = 0;
  function scrollAtEdge(viewport: HTMLElement, elapsed: number): boolean {
    if (!drag) return false;
    const box = viewport.getBoundingClientRect();
    const outer = scroll.getBoundingClientRect();
    const top = Math.max(box.top, outer.top), bottom = Math.min(box.bottom, outer.bottom);
    const left = Math.max(box.left, outer.left), right = Math.min(box.right, outer.right);
    if (bottom <= top || drag.x < left || drag.x > right || drag.y < top - 20 || drag.y > bottom + 20) return false;
    const edge = Math.min(44, (bottom - top) / 3);
    const distance = drag.y < top + edge ? drag.y - top - edge : drag.y > bottom - edge ? drag.y - bottom + edge : 0;
    if (!distance) return false;
    const before = viewport.scrollTop;
    viewport.scrollTop += Math.max(-12, Math.min(12, distance / 4)) * elapsed / 16;
    return viewport.scrollTop !== before;
  }
  function autoScroll(time: number): void {
    if (!drag) return;
    const elapsed = Math.min(32, previousFrame ? time - previousFrame : 16);
    previousFrame = time;
    const point = document.elementFromPoint(drag.x, drag.y);
    const candidate = point?.closest<HTMLElement>("[data-deck-scroll]");
    const inner = candidate && host.contains(candidate) ? candidate : null;
    // Only one scroll owner at a time. Reaching a list's end must not move the
    // outer page and pull the drop target out from under a stationary finger.
    if (scrollAtEdge(inner ?? scroll, elapsed)) locateTarget();
    frame = requestAnimationFrame(autoScroll);
  }
  function begin(target: EventTarget | null, x: number, y: number, touch: boolean): void {
    if (disposed || drag || detail.open) return;
    const card = target instanceof Element ? target.closest<HTMLElement>("[data-deck-id]") : null;
    if (!card || !host.contains(card)) return;
    clearPending();
    suppressClick = false;
    pending = { id: card.dataset.deckId!, x, y, touch };
    if (touch) hold = setTimeout(pickUp, 240);
  }
  function move(x: number, y: number): void {
    if (pending && !drag) {
      const distance = Math.hypot(x - pending.x, y - pending.y);
      if (pending.touch && distance > 8) clearPending();
      else if (!pending.touch && distance > 4) pickUp();
    }
    if (drag) { drag.x = x; drag.y = y; placeGhost(); locateTarget(); }
  }
  function finish(): void {
    clearPending();
    cancelAnimationFrame(frame);
    previousFrame = 0;
    if (!drag) return;
    const finished = drag;
    finished.source.remove();
    drag = undefined;
    host.classList.remove("is-dragging");
    if (finished.valid) {
      void queue.update(moveDeckSkill(queue.get(), finished.id, finished.zone, finished.before));
      feedback(18);
    } else renderGrids(true);
    const destination = finished.valid
      ? Array.from(host.querySelectorAll<HTMLElement>(".deck-grid [data-deck-id]")).find((card) => card.dataset.deckId === finished.id)?.getBoundingClientRect()
      : undefined;
    if (destination && animated()) {
      const dx = destination.left - (finished.x - 26), dy = destination.top - (finished.y - 84);
      const animation = finished.ghost.animate([{ transform: "translate(0,0) scale(1.08)" }, { transform: `translate(${dx}px,${dy}px) scale(.98)`, offset: .8 }, { transform: `translate(${dx}px,${dy}px) scale(1)` }], { duration: 220, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" });
      void animation.finished.then(() => removeGhost(finished.ghost), () => removeGhost(finished.ghost));
    } else removeGhost(finished.ghost);
    setTimeout(() => { suppressClick = false; }, 350);
  }
  host.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" && event.button === 0) begin(event.target, event.clientX, event.clientY, false);
  }, { signal });
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch" && (pending || drag)) { move(event.clientX, event.clientY); if (drag) event.preventDefault(); }
  }, { signal });
  document.addEventListener("pointerup", (event) => { if (event.pointerType !== "touch") finish(); }, { signal });
  document.addEventListener("pointercancel", (event) => { if (event.pointerType !== "touch") cancelDrag(); }, { signal });
  host.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) { cancelDrag(); return; }
    const touch = event.touches[0];
    begin(event.target, touch.clientX, touch.clientY, true);
  }, { passive: true, signal });
  document.addEventListener("touchmove", (event) => {
    if (!pending && !drag) return;
    if (event.touches.length !== 1) { cancelDrag(); return; }
    const touch = event.touches[0];
    move(touch.clientX, touch.clientY);
    if (drag && event.cancelable) event.preventDefault();
  }, { passive: false, signal });
  document.addEventListener("touchend", () => finish(), { signal });
  document.addEventListener("touchcancel", cancelDrag, { signal });
  host.addEventListener("contextmenu", (event) => { if ((event.target as Element).closest("[data-deck-id]")) event.preventDefault(); }, { signal });
  scroll.addEventListener("scroll", () => { if (drag) locateTarget(); else clearPending(); }, { capture: true, signal });
  host.closest("dialog")?.addEventListener("close", cancelDrag, { signal });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (drag) event.preventDefault(); cancelDrag(); } }, { signal });
  window.addEventListener("blur", cancelDrag, { signal });
  window.addEventListener("resize", cancelDrag, { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelDrag(); }, { signal });
  renderGrids();
  return () => {
    disposed = true;
    cancelDrag();
    detail.close();
    unsubscribe();
    controller.abort();
    host.querySelectorAll(".deck-drag-ghost").forEach((ghost) => ghost.remove());
  };
}
