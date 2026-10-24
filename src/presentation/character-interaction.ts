/** Stable package-relative image identities survive blob URL replacement. */
export interface CharacterImageIdentity { readonly packageId: string; readonly path: string }
const absolute = (url: string) => { try { return new URL(url, globalThis.document?.baseURI).href; } catch { return url; } };
const identities = new Map<string, CharacterImageIdentity>();
export function registerCharacterImage(url: string, identity: CharacterImageIdentity) { identities.set(absolute(url), Object.freeze(identity)); }
export function characterImageIdentity(url: string) { return identities.get(absolute(url)); }
export function clearCharacterImages() { identities.clear(); alphaMasks.clear(); }

interface ImageAlphaMask { width: number; height: number; alpha: Uint8Array }
const alphaMasks = new Map<string, ImageAlphaMask | null>();
const alphaThreshold = 16;
// Keep only one byte per source pixel and bound memory across character/pose changes.
const maxAlphaMasks = 16;
export function prepareCharacterImageHitTest(image: HTMLImageElement): void {
  const source = absolute(image.currentSrc || image.src);
  if (alphaMasks.has(source) || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
  let mask: ImageAlphaMask | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建立绘透明度读取画布");
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    mask = { width: canvas.width, height: canvas.height, alpha };
  } catch (error) {
    // Unsupported/tainted images keep the previous rectangular behavior, with a diagnostic.
    console.warn("无法读取立绘透明度，已降级为图片内容范围判定", source, error);
  }
  alphaMasks.set(source, mask);
  if (alphaMasks.size > maxAlphaMasks) alphaMasks.delete(alphaMasks.keys().next().value!);
}

export interface ImageBox { left: number; top: number; width: number; height: number }
/** Client-space original image content box, including contain/cover, position and transforms. */
export function imageContentBox(rect: ImageBox, naturalWidth: number, naturalHeight: number, fit: string, position: string, layoutWidth = rect.width, layoutHeight = rect.height): ImageBox | undefined {
  if (naturalWidth <= 0 || naturalHeight <= 0 || layoutWidth <= 0 || layoutHeight <= 0) return;
  let width = layoutWidth, height = layoutHeight;
  if (fit !== "fill") {
    const contain = Math.min(layoutWidth / naturalWidth, layoutHeight / naturalHeight);
    const scale = fit === "cover" ? Math.max(layoutWidth / naturalWidth, layoutHeight / naturalHeight) : fit === "none" ? 1 : fit === "scale-down" ? Math.min(1, contain) : contain;
    width = naturalWidth * scale; height = naturalHeight * scale;
  }
  const parts = position.trim().split(/\s+/); if (parts.length === 1) parts.push("50%");
  if (["top", "bottom"].includes(parts[0]) || ["left", "right"].includes(parts[1])) parts.reverse();
  const offset = (part: string, space: number) => part === "left" || part === "top" ? 0 : part === "right" || part === "bottom" ? space : part === "center" ? space / 2 : part.endsWith("%") ? space * parseFloat(part) / 100 : parseFloat(part) || 0;
  const sx = rect.width / layoutWidth, sy = rect.height / layoutHeight;
  return { left: rect.left + offset(parts[0], layoutWidth - width) * sx, top: rect.top + offset(parts[1], layoutHeight - height) * sy, width: width * sx, height: height * sy };
}
export function normalizedImagePoint(image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | undefined {
  const rect = image.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
  const style = getComputedStyle(image);
  const box = imageContentBox(rect, image.naturalWidth, image.naturalHeight, style.objectFit, style.objectPosition, image.clientWidth, image.clientHeight);
  if (!box) return;
  const x = (clientX - box.left) / box.width, y = (clientY - box.top) / box.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  return { x, y };
}

/** Pointer interactions exclude transparent pixels of the currently displayed source. */
export function visibleCharacterImagePoint(image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | undefined {
  const point = normalizedImagePoint(image, clientX, clientY);
  if (!point) return;
  prepareCharacterImageHitTest(image);
  const mask = alphaMasks.get(absolute(image.currentSrc || image.src));
  if (mask === null) return point;
  if (!mask) return;
  const x = Math.min(mask.width - 1, Math.floor(point.x * mask.width));
  const y = Math.min(mask.height - 1, Math.floor(point.y * mask.height));
  return mask.alpha[y * mask.width + x] >= alphaThreshold ? point : undefined;
}
