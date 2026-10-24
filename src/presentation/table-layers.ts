/** Local view state: selecting a layer never changes the match or dialogue RNG. */
export class TableLayers {
  private matchSeed: string | undefined;
  private foreground: "information" | "character" = "information";
  private dismissedDialogueKey: string | undefined;
  private stage: HTMLElement | null = null;

  reset(): void {
    this.matchSeed = undefined;
    this.foreground = "information";
    this.dismissedDialogueKey = undefined;
    this.stage = null;
  }

  bringForward(layer: "information" | "character"): void {
    this.foreground = layer;
    if (this.stage) this.stage.dataset.foreground = layer;
  }

  mount(root: HTMLElement, matchSeed: string, dialogueKey: string): void {
    if (this.matchSeed !== matchSeed) this.reset();
    this.matchSeed = matchSeed;
    this.stage = root.querySelector(".table-stage");
    this.bringForward(this.foreground);
    const dashboard = root.querySelector<HTMLElement>(".table-dashboard");
    dashboard?.addEventListener("click", () => this.bringForward("information"));
    dashboard?.addEventListener("focusin", () => this.bringForward("information"));
    dashboard?.addEventListener("keydown", event => {
      if (event.target === dashboard && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        this.bringForward("information");
      }
    });
    if (this.dismissedDialogueKey !== dialogueKey) this.dismissedDialogueKey = undefined;
    const bubble = root.querySelector<HTMLElement>(".dialogue");
    if (!bubble) return;
    bubble.hidden = this.dismissedDialogueKey === dialogueKey;
    const dismiss = () => {
      this.dismissedDialogueKey = dialogueKey;
      bubble.hidden = true;
      // Leave keyboard users on the character, without activating its tap event.
      if (bubble.contains(document.activeElement)) root.querySelector<HTMLElement>(".character-portrait")?.focus({ preventScroll: true });
    };
    let start: { x: number; y: number } | undefined;
    let dragged = false;
    bubble.addEventListener("pointerdown", event => {
      start = { x: event.clientX, y: event.clientY };
      dragged = false;
    });
    bubble.addEventListener("pointermove", event => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) dragged = true;
    });
    bubble.addEventListener("pointercancel", () => { dragged = true; start = undefined; });
    bubble.addEventListener("click", event => {
      event.stopPropagation();
      if (!dragged) dismiss();
      start = undefined;
    });
    bubble.addEventListener("keydown", event => {
      // Space/arrow keys on the inner region remain available for scrolling.
      if (event.key === "Enter" || (event.target === bubble && event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    });
  }

  /** Transparent image padding must not block a visible information control. */
  forwardTransparentClick(root: HTMLElement, event: MouseEvent): void {
    const dashboard = root.querySelector<HTMLElement>(".table-dashboard");
    const rect = dashboard?.getBoundingClientRect();
    if (!rect || event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return;
    this.bringForward("information");
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target instanceof HTMLElement && dashboard?.contains(target)) target.click();
  }
}
