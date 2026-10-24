import { imageContentBox } from "./character-interaction";
import { tablePortraitPlacement, type TablePortrait } from "../content/characters/table-portrait";

export interface TablePortraitPlacement { readonly anchorY: number }

/** Measure the original image without transient transforms such as dialogue shake. */
export function tablePortraitGeometry(image: { width: number; height: number; naturalWidth: number; naturalHeight: number; fit: string; position: string; scale: number }, placement: TablePortraitPlacement) {
  const box = imageContentBox({ left: 0, top: 0, width: image.width, height: image.height }, image.naturalWidth, image.naturalHeight, image.fit, image.position);
  if (!box) return;
  const offsetY = (image.height - box.top - placement.anchorY * box.height) * image.scale;
  return { offsetY };
}

/** Keep the scene's tabletop fixed while the current portrait enters it at its body line. */
export function mountTableSurface(root: HTMLElement, presentation?: TablePortrait): { dispose(): void } {
  const shell = root.querySelector<HTMLElement>(".table-playing");
  const bottom = root.querySelector<HTMLElement>(".table-bottom");
  const strip = root.querySelector<HTMLElement>(".character-strip");
  const portrait = root.querySelector<HTMLImageElement>(".character-portrait");
  const hand = root.querySelector<HTMLElement>(".player-zone .hand-row");
  if (!shell || !bottom || !strip || !portrait || !hand) return { dispose() {} };
  const align = () => {
    // The reference belongs to the scene, independent of the current image or its scale.
    const style = getComputedStyle(portrait);
    const referenceBottom = parseFloat(style.getPropertyValue("--table-art-rest-bottom")) || 18;
    const top = strip.getBoundingClientRect().bottom - referenceBottom;
    // currentSrc follows the image actually displayed while a replacement is loading.
    // Re-read it on load as thinking poses may change src without rebuilding the table.
    const placement = tablePortraitPlacement(presentation, portrait.currentSrc || portrait.src, portrait.ownerDocument.baseURI);
    const geometry = tablePortraitGeometry({ width: portrait.clientWidth, height: portrait.clientHeight, naturalWidth: portrait.naturalWidth, naturalHeight: portrait.naturalHeight,
      fit: style.objectFit, position: style.objectPosition, scale: parseFloat(style.getPropertyValue("--character-art-scale")) || 1 }, placement);
    strip.style.setProperty("--table-art-anchor-offset", `${geometry?.offsetY ?? 0}px`);
    const bounds = bottom.getBoundingClientRect();
    const frame = shell.getBoundingClientRect();
    bottom.style.setProperty("--table-surface-left", `${frame.left - bounds.left}px`);
    bottom.style.setProperty("--table-surface-width", `${frame.width}px`);
    bottom.style.setProperty("--table-surface-top", `${top - bounds.top}px`);
    bottom.style.setProperty("--table-surface-height", `${Math.max(0, hand.getBoundingClientRect().bottom - top)}px`);
  };
  const observer = new ResizeObserver(align);
  for (const element of [shell, bottom, strip, hand, portrait]) observer.observe(element);
  portrait.addEventListener("load", align);
  align();
  return { dispose() {
    observer.disconnect();
    portrait.removeEventListener("load", align);
    strip.style.removeProperty("--table-art-anchor-offset");
  } };
}
