import { bindHapticLifecycle, haptics } from "./haptic-service";
import { presentInteractionHaptic } from "./haptics";
import { motionNumber, reducedUiMotion } from "./ui-motion";

export function applyFeedbackPreference(reducedMotion: boolean): void {
  document.body.classList.toggle("reduced-motion", reducedMotion);
  haptics.configure(!reducedMotion);
}

const controls = 'button, summary, input[type="checkbox"], input[type="radio"], label:has(input[type="file"])';
const ownMotion = '[data-ui-feedback="none"], [role="slider"], [data-drawer-state], .plugin-drag-handle, [data-deck-id]';
function control(event: Event): HTMLElement | undefined {
  return event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement && node.matches(controls));
}
function enabled(element: HTMLElement): boolean {
  return !element.closest('[inert], [aria-disabled="true"], [data-ui-feedback="none"]')
    && !element.matches(":disabled")
    && !(element instanceof HTMLLabelElement && element.control?.matches(":disabled"));
}

/** One delegated owner for launcher and runtime, including newly rendered controls. */
export function installUiFeedback(): () => Promise<void> {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const animations = new Map<HTMLElement, Animation>();
  let press: { element: HTMLElement; pointer?: number; key?: string; bounds?: DOMRect; x: number; y: number } | undefined;
  let pointerStart: { event: PointerEvent; element: HTMLElement; accepted: boolean } | undefined;
  let cancelled: HTMLElement | undefined;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stop = (element: HTMLElement) => {
    animations.get(element)?.cancel();
    animations.delete(element);
    delete element.dataset.uiPressed;
  };
  const animate = (element: HTMLElement, down: boolean) => {
    const current = Number.parseFloat(getComputedStyle(element).scale) || 1;
    stop(element);
    if (!element.isConnected || element.matches(ownMotion)) return;
    if (down) element.dataset.uiPressed = "";
    if (reducedUiMotion() || !element.animate) return;
    const pressed = motionNumber(element, "--ui-press-scale", .975);
    const rebound = motionNumber(element, "--ui-release-scale", 1.008);
    const animation = element.animate(down
      ? [{ scale: current }, { scale: pressed }]
      : [{ scale: current }, { scale: rebound, offset: .58 }, { scale: 1 }], {
      duration: motionNumber(element, down ? "--ui-press-ms" : "--ui-release-ms", down ? 70 : 220),
      easing: "cubic-bezier(.2,.7,.3,1)", fill: down ? "forwards" : "none"
    });
    animations.set(element, animation);
    if (!down) void animation.finished.then(() => { if (animations.get(element) === animation) stop(element); }, () => {});
  };
  const cancel = () => {
    if (press) {
      cancelled = press.element; stop(press.element);
      if (press.pointer !== undefined && press.element.hasPointerCapture(press.pointer)) press.element.releasePointerCapture(press.pointer);
    }
    press = undefined;
  };
  const inside = (event: PointerEvent) => {
    const bounds = press?.bounds;
    return bounds && event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  };
  const reset = () => { cancel(); for (const element of animations.keys()) stop(element); };
  document.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    const element = control(event);
    pointerStart = element ? { event, element, accepted: false } : undefined;
  }, { capture: true, passive: true, signal });
  document.addEventListener("pointerdown", event => {
    cancel();
    cancelled = undefined;
    const element = control(event);
    if (event.defaultPrevented || !event.isPrimary || event.button !== 0 || !element || !element.isConnected || !enabled(element) || element.matches(ownMotion)) return;
    if (pointerStart?.event === event) pointerStart.accepted = true;
    press = { element, pointer: event.pointerId, bounds: element.getBoundingClientRect(), x: event.clientX, y: event.clientY };
    // Scaling the visual must not lose a release at the original button edge.
    element.setPointerCapture(event.pointerId);
    animate(element, true);
    // Custom gestures run first and may prevent or stop this event.
    // Visual feedback must not take pointer ownership away from those controls.
  }, { signal });
  document.addEventListener("pointermove", event => {
    if (!press || press.pointer !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8 || !inside(event)) cancel();
  }, { capture: true, passive: true, signal });
  document.addEventListener("pointerup", event => {
    if (!press || press.pointer !== event.pointerId) return;
    const element = press.element;
    const valid = inside(event) && enabled(element);
    press = undefined;
    if (valid) animate(element, false);
    else { cancelled = element; stop(element); }
  }, { capture: true, signal });
  document.addEventListener("pointercancel", cancel, { capture: true, signal });
  document.addEventListener("lostpointercapture", event => { if (press?.pointer === event.pointerId) cancel(); }, { capture: true, signal });
  document.addEventListener("scroll", cancel, { capture: true, passive: true, signal });
  document.addEventListener("keydown", event => {
    if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
    const element = control(event);
    if (!element || !enabled(element) || element.matches(ownMotion)) return;
    cancel(); cancelled = undefined; press = { element, key: event.key, x: 0, y: 0 }; animate(element, true);
  }, { capture: true, signal });
  document.addEventListener("keyup", event => {
    if (press?.key !== event.key) return;
    const element = press.element; press = undefined;
    if (enabled(element)) animate(element, false); else stop(element);
  }, { capture: true, signal });
  document.addEventListener("focusout", event => { if (press?.element === event.target) cancel(); }, { capture: true, signal });
  document.addEventListener("click", event => {
    const element = control(event);
    // A file label's forwarded input click must not produce a second pulse.
    if (!event.isTrusted || !element) return;
    // Keep the widget's native click intact without adding global feedback to its gesture.
    if (event.detail > 0 && pointerStart?.element === element && !pointerStart.accepted) return;
    if (element === cancelled && event.detail > 0) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!enabled(element) || event.target instanceof HTMLInputElement) return;
    if (!animations.has(element) && !press && !element.matches(ownMotion)) animate(element, false);
    if (!element.hasAttribute("data-own-haptic") && !element.matches(ownMotion)) presentInteractionHaptic(!reducedUiMotion());
  }, { capture: true, signal });
  window.addEventListener("blur", reset, { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); }, { signal });
  const preferences = () => { haptics.setForeground("system-motion", !media.matches); if (reducedUiMotion()) reset(); };
  media.addEventListener("change", preferences, { signal });
  const observer = new MutationObserver(() => {
    if (reducedUiMotion()) reset();
    else for (const element of animations.keys()) if (!element.isConnected || !enabled(element)) stop(element);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "disabled", "inert"] });
  preferences();
  const native = bindHapticLifecycle().catch(() => undefined);
  return async () => {
    lifetime.abort(); observer.disconnect(); reset();
    pointerStart = undefined;
    await (await native)?.();
  };
}
