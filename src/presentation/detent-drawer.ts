/** DOM-only drawer interaction. Stops are measured by the caller in CSS pixels. */
export interface DetentDrawerOptions {
  handle: HTMLElement;
  axis: "x" | "y";
  direction: 1 | -1;
  stops: () => readonly number[];
  render: (position: number, settled: boolean) => void;
  initial?: number | "end";
  canDrag?: () => boolean;
  beforeOpen?: () => boolean;
  onSettle?: (position: number) => void;
  observe?: readonly Element[];
  signal?: AbortSignal;
  reducedMotion?: () => boolean;
}

export function drawerStops(values: readonly number[]): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.filter((value, index) => !index || value - sorted[index - 1] > .5);
}

export function nearestDrawerStop(position: number, stops: readonly number[]): number {
  return stops.reduce((best, stop) => Math.abs(stop - position) < Math.abs(best - position) ? stop : best, stops[0] ?? 0);
}

export function dampedDrawerPosition(position: number, minimum: number, maximum: number): number {
  const bound = Math.max(minimum, Math.min(maximum, position));
  const excess = position - bound;
  return bound + excess * .32 / (1 + Math.abs(excess) / 80);
}

export function createDetentDrawer(options: DetentDrawerOptions) {
  const { handle } = options;
  const controller = new AbortController();
  const { signal } = controller;
  let stops = drawerStops(options.stops());
  if (!stops.length) stops = [0];
  let position = options.initial === "end" ? stops.at(-1)! : nearestDrawerStop(options.initial ?? stops[0], stops);
  let target = position;
  let frame = 0;
  let refreshFrame = 0;
  let pull: { id: number; coordinate: number; position: number; moved: boolean } | undefined;
  let suppressClick = false;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const paint = (settled: boolean): void => {
    handle.dataset.drawerPosition = String(Math.round(position * 100) / 100);
    handle.dataset.drawerTarget = String(target);
    handle.dataset.drawerStops = stops.join(",");
    handle.dataset.drawerState = pull ? "dragging" : settled ? "settled" : "settling";
    if (handle.getAttribute("role") === "slider") {
      handle.setAttribute("aria-valuemin", String(stops[0]));
      handle.setAttribute("aria-valuemax", String(stops.at(-1)));
      handle.setAttribute("aria-valuenow", String(Math.round(Math.max(stops[0], Math.min(stops.at(-1)!, position)))));
      handle.setAttribute("aria-valuetext", `第 ${stops.indexOf(nearestDrawerStop(position, stops)) + 1} 档，共 ${stops.length} 档`);
    }
    options.render(position, settled);
  };
  const stopAnimation = (): void => { cancelAnimationFrame(frame); frame = 0; };
  const settle = (value: number, animate = true): void => {
    if (signal.aborted) return;
    const next = nearestDrawerStop(value, stops);
    if (next > stops[0] && options.beforeOpen?.() === false) return;
    stopAnimation();
    target = next;
    if (!animate || reducedMotion.matches || options.reducedMotion?.() || Math.abs(position - target) < .1) {
      position = target; paint(true); options.onSettle?.(target); return;
    }
    let previous = performance.now();
    let velocity = 0;
    const tick = (now: number): void => {
      const dt = Math.min((now - previous) / 1000, .032);
      previous = now;
      // Small integration steps keep the spring stable on slower devices.
      const steps = Math.max(1, Math.ceil(dt / .008));
      for (let index = 0; index < steps; index++) {
        const step = dt / steps;
        velocity += ((target - position) * 380 - velocity * 30) * step;
        position += velocity * step;
      }
      if (Math.abs(position - target) < .15 && Math.abs(velocity) < 2) {
        frame = 0; position = target; paint(true); options.onSettle?.(target);
      } else { paint(false); frame = requestAnimationFrame(tick); }
    };
    paint(false); frame = requestAnimationFrame(tick);
  };
  const refresh = (): void => {
    if (signal.aborted || pull) return;
    // A hidden dialog initially measures as a single zero stop, not an open drawer.
    const atEnd = stops.length > 1 && Math.abs(target - stops.at(-1)!) < .5;
    stops = drawerStops(options.stops());
    if (!stops.length) stops = [0];
    settle(atEnd ? stops.at(-1)! : target, false);
  };
  const coordinate = (event: PointerEvent) => options.axis === "x" ? event.clientX : event.clientY;
  const finish = (): void => {
    if (!pull) return;
    const current = pull; pull = undefined;
    suppressClick = current.moved;
    if (handle.hasPointerCapture(current.id)) handle.releasePointerCapture(current.id);
    settle(position);
  };
  handle.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || pull || options.canDrag?.() === false) return;
    if (options.beforeOpen?.() === false) return;
    if (!frame) refresh();
    stopAnimation(); suppressClick = false;
    pull = { id: event.pointerId, coordinate: coordinate(event), position, moved: false };
    handle.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }, { signal });
  handle.addEventListener("pointermove", event => {
    if (pull?.id !== event.pointerId) return;
    const distance = coordinate(event) - pull.coordinate;
    if (!pull.moved && Math.abs(distance) < 5) return;
    pull.moved = true; event.preventDefault(); event.stopPropagation();
    position = dampedDrawerPosition(pull.position + distance * options.direction * .82, stops[0], stops.at(-1)!);
    paint(false);
  }, { signal, passive: false });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) handle.addEventListener(type, event => {
    if (pull?.id === event.pointerId) finish();
  }, { signal });
  handle.addEventListener("click", event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); return; }
    settle(Math.abs(target - stops[0]) < .5 ? stops.at(-1)! : stops[0]);
  }, { signal, capture: true });
  handle.addEventListener("keydown", event => {
    const opening = options.axis === "x" ? options.direction === -1 ? "ArrowLeft" : "ArrowRight" : options.direction === -1 ? "ArrowUp" : "ArrowDown";
    const closing = options.axis === "x" ? options.direction === -1 ? "ArrowRight" : "ArrowLeft" : options.direction === -1 ? "ArrowDown" : "ArrowUp";
    if (![opening, closing, "Home", "End"].includes(event.key)) return;
    suppressClick = false;
    event.preventDefault(); event.stopPropagation();
    const index = stops.indexOf(nearestDrawerStop(target, stops));
    settle(event.key === "Home" ? stops[0] : event.key === "End" ? stops.at(-1)! : stops[Math.max(0, Math.min(stops.length - 1, index + (event.key === opening ? 1 : -1)))]);
  }, { signal });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && pull) { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
  }, { signal, capture: true });
  window.addEventListener("blur", finish, { signal });
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(refreshFrame); refreshFrame = requestAnimationFrame(refresh);
  });
  options.observe?.forEach(element => observer.observe(element));
  window.addEventListener("resize", () => { finish(); refresh(); }, { signal });
  signal.addEventListener("abort", () => {
    stopAnimation(); cancelAnimationFrame(refreshFrame); observer.disconnect();
    if (pull && handle.hasPointerCapture(pull.id)) handle.releasePointerCapture(pull.id);
    pull = undefined;
  }, { once: true });
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true, signal });
  if (options.signal?.aborted) controller.abort();
  else paint(true);
  return { get position() { return target; }, refresh, set: settle, dispose: () => controller.abort() };
}
