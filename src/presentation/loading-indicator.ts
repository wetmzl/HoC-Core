import "./loading-indicator.css";

export interface LoadingIndicatorState {
  readonly label: string;
  readonly completed?: number;
  readonly total?: number;
  readonly stalled?: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function progressPercent({ completed, total }: LoadingIndicatorState): number | undefined {
  if (completed === undefined || total === undefined || !Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return undefined;
  return Math.floor(Math.min(1, Math.max(0, completed / total)) * 100);
}

const SPADE = '<path d="M12 2C9 6 3 9 3 14a5 5 0 0 0 8 4c0 2-1 3-2 4h6c-1-1-2-2-2-4a5 5 0 0 0 8-4c0-5-6-8-9-12Z"/>';
const DIAMOND = '<path d="m12 1 9 11-9 11L3 12Z"/>';

function cardMarkup(front = false): string {
  return `<svg viewBox="0 0 100 152" aria-hidden="true" focusable="false"><rect x=".5" y=".5" width="99" height="151" rx="8" fill="${front ? "#223345" : "#192737"}" stroke="#c4a36c" stroke-opacity=".65"/><rect x="6" y="6" width="88" height="140" rx="4" fill="none" stroke="#d9b778" stroke-opacity=".35" stroke-width=".7"/><path d="M10 29V10h19M71 10h19v19M10 123v19h19M71 142h19v-19" fill="none" stroke="#d9b778" stroke-width=".8"/><path d="M22 76 50 36 78 76 50 116ZM29 76 50 46 71 76 50 106Z" fill="none" stroke="#d9b778" stroke-opacity=".3" stroke-width=".7"/><circle cx="50" cy="76" r="17" fill="#192737" stroke="#d9b778" stroke-width=".8"/><svg x="40" y="65" width="20" height="22" viewBox="0 0 24 24" fill="#d9b778">${front ? SPADE : DIAMOND}</svg><path d="m50 14 3 4-3 4-3-4Zm0 116 3 4-3 4-3-4Z" fill="#d9b778"/></svg>`;
}

export function loadingIndicatorMarkup(state: LoadingIndicatorState): string {
  const percent = progressPercent(state);
  const label = escapeHtml(state.label);
  return `<div class="hoc-loading" data-loading-indicator><div class="hoc-loading-art" aria-hidden="true"><div class="hoc-loading-card hoc-loading-card-left">${cardMarkup()}</div><div class="hoc-loading-card hoc-loading-card-right">${cardMarkup()}</div><div class="hoc-loading-card hoc-loading-card-center">${cardMarkup(true)}</div></div><div class="hoc-loading-phase"><p class="hoc-loading-label" data-loading-label role="status">${label}</p><span class="hoc-loading-value" data-loading-value aria-hidden="true">${percent === undefined ? "" : `${percent}%`}</span></div><div class="hoc-loading-track${percent === undefined ? " hoc-loading-unknown" : ""}" data-loading-track role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100"${percent === undefined ? "" : ` aria-valuenow="${percent}"`}><div class="hoc-loading-fill" data-loading-fill style="transform:scaleX(${(percent ?? 0) / 100})"></div><div class="hoc-loading-scan"></div></div><p class="hoc-loading-notice" data-loading-notice role="status"${state.stalled ? "" : " hidden"}>暂未收到新进度</p></div>`;
}

/** Update progress without replacing the animated cards or restarting their motion. */
export function updateLoadingIndicator(root: ParentNode, state: LoadingIndicatorState): void {
  const indicator = (root as Element).matches?.("[data-loading-indicator]")
    ? root as HTMLElement
    : root.querySelector<HTMLElement>("[data-loading-indicator]");
  if (!indicator) return;
  const percent = progressPercent(state);
  const label = indicator.querySelector<HTMLElement>("[data-loading-label]");
  const value = indicator.querySelector<HTMLElement>("[data-loading-value]");
  const track = indicator.querySelector<HTMLElement>("[data-loading-track]");
  const fill = indicator.querySelector<HTMLElement>("[data-loading-fill]");
  const notice = indicator.querySelector<HTMLElement>("[data-loading-notice]");
  if (label && label.textContent !== state.label) label.textContent = state.label;
  if (value) value.textContent = percent === undefined ? "" : `${percent}%`;
  if (track) {
    track.classList.toggle("hoc-loading-unknown", percent === undefined);
    track.setAttribute("aria-label", state.label);
    if (percent === undefined) track.removeAttribute("aria-valuenow");
    else track.setAttribute("aria-valuenow", String(percent));
  }
  if (fill) fill.style.transform = `scaleX(${(percent ?? 0) / 100})`;
  if (notice) notice.hidden = !state.stalled;
}

export function loadingScreenMarkup(label: string): string {
  return `<main class="loading-shell hoc-loading-screen">${loadingIndicatorMarkup({ label })}</main>`;
}
