import type { Actor, MatchState } from "../core/match/types";

interface HandPosition {
  readonly cardIds: readonly string[];
  left: number;
  atEnd: boolean;
}

/** Keeps table redraws independent from each hand's native scrolling. */
export class HandScrollController {
  private roundKey = "";
  private positions: Partial<Record<Actor, HandPosition>> = {};
  private elements: Partial<Record<Actor, HTMLElement>> = {};
  private controller?: AbortController;

  capture(): void {
    for (const actor of ["player", "opponent"] as const) {
      const element = this.elements[actor], position = this.positions[actor];
      if (!element || !position) continue;
      position.left = element.scrollLeft;
      position.atEnd = element.scrollWidth - element.clientWidth - element.scrollLeft <= 4;
    }
    this.controller?.abort();
    this.elements = {};
  }

  mount(root: HTMLElement, state: MatchState): void {
    const key = `${state.id}:${state.roundIndex}`;
    if (key !== this.roundKey) this.positions = {};
    this.roundKey = key;
    this.controller = new AbortController();
    const { signal } = this.controller;
    for (const actor of ["player", "opponent"] as const) {
      const element = root.querySelector<HTMLElement>(`[data-hand-scroll="${actor}"]`);
      if (!element) continue;
      const previous = this.positions[actor];
      const cardIds = state[actor].hand.cards.map(card => card.id);
      const appended = previous && cardIds.length > previous.cardIds.length
        && previous.cardIds.every((id, index) => cardIds[index] === id);
      const max = Math.max(0, element.scrollWidth - element.clientWidth);
      // Immediate restoration also avoids motion and interruption on redraw.
      element.scrollLeft = previous ? appended && previous.atEnd ? max : Math.min(previous.left, max) : 0;
      this.positions[actor] = { cardIds, left: element.scrollLeft, atEnd: max - element.scrollLeft <= 4 };
      this.elements[actor] = element;

      let drag: { pointerId: number; start: number; left: number; active: boolean } | undefined;
      const finish = () => {
        if (drag && element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
        drag = undefined;
        element.classList.remove("is-dragging");
      };
      signal.addEventListener("abort", finish, { once: true });
      element.addEventListener("pointerdown", event => {
        if (event.pointerType !== "mouse" || event.button !== 0 || element.scrollWidth <= element.clientWidth) return;
        drag = { pointerId: event.pointerId, start: event.clientX, left: element.scrollLeft, active: false };
        element.setPointerCapture(event.pointerId);
      }, { signal });
      element.addEventListener("pointermove", event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const delta = event.clientX - drag.start;
        if (!drag.active && Math.abs(delta) <= 6) return;
        drag.active = true;
        element.classList.add("is-dragging");
        event.preventDefault();
        element.scrollLeft = drag.left - delta;
      }, { signal });
      element.addEventListener("pointerup", finish, { signal });
      element.addEventListener("pointercancel", finish, { signal });
      element.addEventListener("lostpointercapture", finish, { signal });
      element.addEventListener("keydown", event => {
        const step = 52;
        if (event.key === "ArrowLeft") element.scrollLeft -= step;
        else if (event.key === "ArrowRight") element.scrollLeft += step;
        else if (event.key === "Home") element.scrollLeft = 0;
        else if (event.key === "End") element.scrollLeft = element.scrollWidth;
        else return;
        event.preventDefault();
      }, { signal });
    }
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.elements = {};
    this.positions = {};
    this.roundKey = "";
  }
}
