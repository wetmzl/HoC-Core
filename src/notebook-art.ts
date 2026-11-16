/** Transparent margins are removed only from the notebook viewport; source files stay intact. */
export interface NotebookArtBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface NotebookArtLayout { readonly width: number; readonly height: number; readonly left: number; readonly top: number; readonly frameHeight: number; readonly scale: number }
const boundsCache = new Map<string, NotebookArtBounds | null>();
const maxCachedBounds = 128;
const maxReadablePixels = 4_194_304;

/** Include every nontransparent pixel, including faint edges, plus a small safety margin. */
export function notebookAlphaBounds(rgba: ArrayLike<number>, width: number, height: number, padding = 2): NotebookArtBounds | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || rgba.length < width * height * 4) return null;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgba[(y * width + x) * 4 + 3] <= 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  left = Math.max(0, left - padding); top = Math.max(0, top - padding);
  right = Math.min(width - 1, right + padding); bottom = Math.min(height - 1, bottom + padding);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Fit the full visible silhouette within a responsive frame, without distorting it. */
export function notebookArtLayout(sourceWidth: number, sourceHeight: number, bounds: NotebookArtBounds, frameWidth: number, maxHeight: number, padding = 8): NotebookArtLayout {
  const inset = Math.min(padding, Math.max(0, (Math.min(frameWidth, maxHeight) - 1) / 2));
  const frameHeight = Math.min(maxHeight, (frameWidth - 2 * inset) * bounds.height / bounds.width + 2 * inset);
  const scale = Math.min((frameWidth - 2 * inset) / bounds.width, (frameHeight - 2 * inset) / bounds.height);
  return { width: sourceWidth * scale, height: sourceHeight * scale,
    left: (frameWidth - bounds.width * scale) / 2 - bounds.x * scale,
    top: (frameHeight - bounds.height * scale) / 2 - bounds.y * scale,
    frameHeight, scale };
}

function imageBounds(image: HTMLImageElement): NotebookArtBounds | null {
  const source = image.currentSrc || image.src;
  if (boundsCache.has(source)) return boundsCache.get(source)!;
  let bounds: NotebookArtBounds | null = null;
  try {
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width * height > maxReadablePixels) throw new Error("Portrait exceeds the notebook analysis budget");
    const canvas = image.ownerDocument.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) { context.drawImage(image, 0, 0); bounds = notebookAlphaBounds(context.getImageData(0, 0, width, height).data, width, height); }
    canvas.width = 0; canvas.height = 0;
  } catch { /* Cross-origin, unsupported or unusually large images keep whole-image contain. */ }
  boundsCache.set(source, bounds);
  if (boundsCache.size > maxCachedBounds) boundsCache.delete(boundsCache.keys().next().value!);
  return bounds;
}

/** One observer and abortable load listeners belong to the current notebook rendering. */
export function mountNotebookArt(root: HTMLElement, signal: AbortSignal): () => void {
  const lifetime = new AbortController();
  let disposed = false, scheduled = 0;
  const frames = [...root.querySelectorAll<HTMLElement>("[data-notebook-art-frame]")];
  const fit = (frame: HTMLElement) => {
    if (disposed || signal.aborted || !frame.isConnected) return;
    const image = frame.querySelector<HTMLImageElement>("img");
    const width = frame.clientWidth;
    if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0 || width <= 0 || frame.getClientRects().length === 0) return;
    const bounds = imageBounds(image), effective = bounds ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
    const dialog = frame.dataset.notebookArtFrame === "dialog";
    const maxHeight = Math.max(160, Math.min(dialog ? 850 : 720, window.innerHeight - (dialog ? 90 : 120)));
    const layout = notebookArtLayout(image.naturalWidth, image.naturalHeight, effective, width, maxHeight, dialog ? 4 : 8);
    frame.style.height = `${layout.frameHeight}px`;
    image.style.width = `${layout.width}px`; image.style.height = `${layout.height}px`;
    image.style.left = `${layout.left}px`; image.style.top = `${layout.top}px`;
    frame.dataset.notebookArtReady = bounds ? "trimmed" : "full";
    frame.dataset.notebookArtBounds = JSON.stringify(effective);
  };
  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = requestAnimationFrame(() => { scheduled = 0; frames.forEach(fit); });
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  for (const frame of frames) {
    observer?.observe(frame);
    const image = frame.querySelector<HTMLImageElement>("img");
    image?.addEventListener("load", () => fit(frame), { signal: lifetime.signal });
    image?.addEventListener("error", () => { frame.dataset.notebookArtReady = "full"; }, { signal: lifetime.signal });
    fit(frame);
  }
  window.addEventListener("resize", schedule, { signal: lifetime.signal });
  const cleanup = () => {
    if (disposed) return;
    disposed = true; observer?.disconnect(); lifetime.abort();
    if (scheduled) cancelAnimationFrame(scheduled);
    signal.removeEventListener("abort", cleanup);
  };
  signal.addEventListener("abort", cleanup, { once: true });
  if (signal.aborted) cleanup();
  return cleanup;
}
