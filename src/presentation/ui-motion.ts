/** Shared preferences for host controls. Gameplay effects keep their own cues. */
export function reducedUiMotion(): boolean {
  return document.body.classList.contains("reduced-motion")
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function motionNumber(element: Element, token: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(token));
  return Number.isFinite(value) ? value : fallback;
}
