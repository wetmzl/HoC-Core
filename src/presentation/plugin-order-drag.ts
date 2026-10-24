/** Live reorder preview; only a completed drop writes the package order. */
export function mountPluginOrderDrag(
  dialog: HTMLDialogElement,
  order: readonly string[],
  commit: (order: readonly string[]) => void
): () => void {
  const list = dialog.querySelector<HTMLElement>(".package-list")!;
  const group = list.querySelector<HTMLElement>('[data-package-group="plugins"] .package-group-items')!;
  const controller = new AbortController();
  const { signal } = controller;
  const cards = Array.from(group.children).filter((card): card is HTMLElement => card instanceof HTMLElement && order.includes(card.dataset.packageId ?? ""));
  const animations = new Map<HTMLElement, Animation>();
  let pending: { handle: HTMLElement; source: HTMLElement; pointerId: number; x: number; y: number } | undefined;
  let drag: { source: HTMLElement; ghost: HTMLElement; slot: HTMLElement; next: ChildNode | null; offsetX: number; offsetY: number; x: number; y: number; valid: boolean; settling: boolean } | undefined;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let previousFrame = 0;
  let suppressClick = false;
  const animated = () => !document.body.classList.contains("reduced-motion") && !matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clearPending(): void {
    clearTimeout(hold);
    if (pending?.handle.hasPointerCapture(pending.pointerId)) pending.handle.releasePointerCapture(pending.pointerId);
    pending = undefined;
  }

  function cleanup(restore: boolean): void {
    const finished = drag;
    drag = undefined;
    clearPending();
    cancelAnimationFrame(frame);
    previousFrame = 0;
    animations.forEach(animation => animation.cancel());
    animations.clear();
    if (finished) {
      if (restore) group.insertBefore(finished.source, finished.next);
      else finished.slot.replaceWith(finished.source);
      finished.source.classList.remove("plugin-drag-source");
      finished.source.removeAttribute("aria-hidden");
      finished.slot.remove();
      finished.ghost.remove();
    }
    list.classList.remove("is-plugin-sorting");
  }

  function placeGhost(): void {
    if (!drag) return;
    // Plugin cards nearly fill a phone screen; keep them visible when a finger
    // moves from the right-hand grip toward the middle of the list.
    const left = Math.max(8, Math.min(innerWidth - drag.ghost.offsetWidth - 8, drag.x - drag.offsetX));
    const top = Math.max(8, Math.min(innerHeight - drag.ghost.offsetHeight - 8, drag.y - drag.offsetY - (animated() ? 8 : 0)));
    drag.ghost.style.left = `${left}px`;
    drag.ghost.style.top = `${top}px`;
  }

  function pickUp(): void {
    if (!pending || !dialog.open || !pending.source.isConnected) return;
    const { source, x, y } = pending;
    const box = source.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "plugin-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("popover", "manual");
    ghost.style.width = `${box.width}px`;
    ghost.style.transformOrigin = `${x - box.left}px ${y - box.top}px`;
    const copy = source.cloneNode(true) as HTMLElement;
    // A visual copy must not duplicate IDs, controls or package selectors.
    for (const node of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
      for (const attribute of Array.from(node.attributes)) {
        if (attribute.name === "id" || attribute.name.startsWith("data-") || attribute.name.startsWith("aria-")) node.removeAttribute(attribute.name);
      }
    }
    ghost.append(copy);
    dialog.append(ghost);
    if (typeof ghost.showPopover === "function") ghost.showPopover();
    const slot = document.createElement("div");
    slot.className = "plugin-drag-placeholder";
    slot.style.height = `${box.height}px`;
    slot.setAttribute("role", "img");
    slot.setAttribute("aria-label", "插件插入位置");
    list.classList.add("is-plugin-sorting");
    const next = source.nextSibling;
    group.insertBefore(slot, source);
    source.classList.add("plugin-drag-source");
    source.setAttribute("aria-hidden", "true");
    drag = { source, ghost, slot, next, offsetX: x - box.left, offsetY: y - box.top, x, y, valid: true, settling: false };
    clearTimeout(hold);
    suppressClick = true;
    placeGhost();
    frame = requestAnimationFrame(autoScroll);
  }

  function locateTarget(): void {
    if (!drag || drag.settling) return;
    const hit = document.elementFromPoint(drag.x, drag.y);
    drag.valid = Boolean(hit && group.contains(hit) && list.contains(hit));
    drag.slot.classList.toggle("is-invalid", !drag.valid);
    if (!drag.valid) return;
    const remaining = cards.filter(card => card !== drag!.source);
    // offsetTop is the layout position, unaffected by an ongoing slide animation.
    const groupTop = group.getBoundingClientRect().top - group.offsetTop;
    const before = remaining.find(card => drag!.y < groupTop + card.offsetTop + card.offsetHeight / 2);
    const anchor = before ?? remaining.at(-1)?.nextSibling ?? null;
    if (anchor === drag.slot || (before && drag.slot.nextElementSibling === before)) return;
    const positions = new Map(remaining.map(card => [card, card.getBoundingClientRect().top]));
    animations.forEach(animation => animation.cancel());
    animations.clear();
    group.insertBefore(drag.slot, anchor);
    if (animated()) for (const card of remaining) {
      const delta = positions.get(card)! - card.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      const animation = card.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 160, easing: "cubic-bezier(.2,.8,.3,1)" });
      animations.set(card, animation);
    }
  }

  function autoScroll(time: number): void {
    if (!drag || drag.settling) return;
    const elapsed = Math.min(32, previousFrame ? time - previousFrame : 16);
    previousFrame = time;
    const box = list.getBoundingClientRect();
    if (drag.x >= box.left && drag.x <= box.right && drag.y >= box.top && drag.y <= box.bottom) {
      const edge = Math.min(44, box.height / 3);
      const distance = drag.y < box.top + edge ? drag.y - box.top - edge : drag.y > box.bottom - edge ? drag.y - box.bottom + edge : 0;
      if (distance) {
        const previous = list.scrollTop;
        const delta = Math.max(-12, Math.min(12, distance / 4)) * elapsed / 16;
        const groupBox = group.getBoundingClientRect();
        // Stop at the plugin group boundary. Continuing into the resource group
        // would invalidate an already previewed drop while the finger is still.
        const bounded = delta > 0
          ? Math.min(delta, Math.max(0, groupBox.bottom - drag.y - 1))
          : Math.max(delta, Math.min(0, groupBox.top - drag.y + 1));
        list.scrollTop += bounded;
        if (previous !== list.scrollTop) locateTarget();
      }
    }
    frame = requestAnimationFrame(autoScroll);
  }

  async function finish(): Promise<void> {
    if (!drag) { clearPending(); return; }
    locateTarget();
    if (!drag.valid) { cleanup(true); return; }
    const finished = drag;
    finished.settling = true;
    clearPending();
    cancelAnimationFrame(frame);
    const nextOrder = Array.from(group.children).flatMap(card => card === finished.slot ? [finished.source.dataset.packageId!] : card instanceof HTMLElement && card !== finished.source && order.includes(card.dataset.packageId ?? "") ? [card.dataset.packageId!] : []);
    if (animated()) {
      const destination = finished.slot.getBoundingClientRect();
      const dx = destination.left - parseFloat(finished.ghost.style.left);
      const dy = destination.top - parseFloat(finished.ghost.style.top);
      const animation = finished.ghost.animate([
        { transform: "translate(0,0) scale(1.02)" },
        { transform: `translate(${dx}px,${dy}px) scale(.99)`, offset: .8 },
        { transform: `translate(${dx}px,${dy}px) scale(1)` }
      ], { duration: 220, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" });
      try { await animation.finished; } catch { /* Closing the panel cancels the drop. */ }
    }
    if (drag !== finished || signal.aborted) return;
    cleanup(false);
    if (nextOrder.some((id, index) => id !== order[index])) commit(nextOrder);
  }

  dialog.addEventListener("pointerdown", event => {
    if (pending || drag) { if (pending && event.pointerId !== pending.pointerId) cleanup(true); return; }
    if (event.button !== 0) return;
    const handle = (event.target as Element).closest<HTMLElement>("[data-plugin-drag]");
    const source = handle?.closest<HTMLElement>(".package-card");
    if (!handle || !source || !cards.includes(source)) return;
    event.preventDefault();
    suppressClick = false;
    pending = { handle, source, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    handle.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch") hold = setTimeout(pickUp, 240);
  }, { signal });
  dialog.addEventListener("pointermove", event => {
    if (!pending || pending.pointerId !== event.pointerId || drag?.settling) return;
    if (!drag && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 4) pickUp();
    if (drag) {
      event.preventDefault();
      drag.x = event.clientX; drag.y = event.clientY;
      placeGhost(); locateTarget();
    }
  }, { signal });
  dialog.addEventListener("pointerup", event => {
    if (pending?.pointerId !== event.pointerId) return;
    if (drag) { drag.x = event.clientX; drag.y = event.clientY; }
    void finish();
  }, { signal });
  dialog.addEventListener("pointercancel", () => cleanup(true), { signal });
  dialog.addEventListener("lostpointercapture", () => { if (pending && !drag?.settling) cleanup(true); }, { signal });
  dialog.addEventListener("click", event => {
    if (drag || (suppressClick && (event.target as Element).closest("[data-plugin-drag]"))) {
      if ((event.target as Element).closest("[data-close-packages]")) { cleanup(true); return; }
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { capture: true, signal });
  dialog.addEventListener("contextmenu", event => { if ((event.target as Element).closest("[data-plugin-drag]")) event.preventDefault(); }, { signal });
  list.addEventListener("scroll", locateTarget, { signal });
  dialog.addEventListener("close", () => cleanup(true), { signal });
  dialog.addEventListener("cancel", event => { if (pending || drag) { event.preventDefault(); cleanup(true); } }, { signal });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && (pending || drag)) { event.preventDefault(); cleanup(true); } }, { signal });
  window.addEventListener("blur", () => cleanup(true), { signal });
  window.addEventListener("resize", () => cleanup(true), { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cleanup(true); }, { signal });
  return () => { cleanup(true); controller.abort(); };
}
