import type { AchievementListPresentation, VisibleAchievementPresentation } from "../core/achievements/presentation";
import { gameAchievements } from "../runtime/achievement-ui";
import { closeUiDialog, openUiDialog } from "./dialog-motion";
import { escapeHtml } from "./view-helpers";
import { mountAchievementToasts } from "./achievement-toast";
import "./achievement-ui.css";

type CompletedAchievement = Extract<VisibleAchievementPresentation, { status: "completed" }>;
export const achievementTrophy = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0V3Z"/><path d="M7 5H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-7-3h6v3H9Z"/></svg>';
const lock = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Z"/><path d="M12 14v3"/></svg>';
let openActiveOverview: (() => void) | undefined;

export function openAchievementOverview(): void { openActiveOverview?.(); }

function cover(row: VisibleAchievementPresentation): string {
  return `<span class="achievement-cover">${achievementTrophy}${row.cover.type === "image" ? `<img src="${escapeHtml(row.cover.url)}" alt="" decoding="async" loading="lazy" />` : ""}</span>`;
}

function unlockedAt(at: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
}

function achievementRow(row: VisibleAchievementPresentation): string {
  let detail: string;
  if (row.status === "completed") {
    detail = `<time datetime="${escapeHtml(row.completedAt)}">${escapeHtml(unlockedAt(row.completedAt))} 解锁</time>`;
  } else {
    const progress = row.progressDisplay;
    const value = progress?.value;
    detail = progress ? `<div class="achievement-progress"><span>${value == null ? "尚无进度" : `${escapeHtml(String(value))} / ${escapeHtml(String(progress.target))}`}</span><progress max="${progress.target}" value="${value == null ? 0 : Math.max(0, Math.min(value, progress.target))}" aria-label="${escapeHtml(row.name)}进度${value == null ? "，尚无记录" : ""}"></progress></div>` : '<span class="achievement-locked-label">尚未解锁</span>';
  }
  return `<li class="achievement-row ${row.status === "completed" ? "is-completed" : "is-locked"}" data-achievement-key="${escapeHtml(row.key)}">${cover(row)}<div class="achievement-copy"><div class="achievement-row-heading"><h4>${escapeHtml(row.name)}</h4>${row.status === "completed" ? '<span class="achievement-check" aria-label="已解锁">✓</span>' : ""}</div><p>${escapeHtml(row.description)}</p>${detail}</div></li>`;
}

function overviewContent(list: AchievementListPresentation): string {
  const completed = list.rows.filter((row): row is CompletedAchievement => row.status === "completed")
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || a.key.localeCompare(b.key));
  const locked = list.rows.filter(row => row.status === "locked");
  const total = list.rows.length + list.hiddenCount;
  return `<section class="achievement-summary" aria-label="成就完成进度"><div><span>成就进度</span><strong>${completed.length}<small> / ${total}</small></strong></div><progress max="${Math.max(1, total)}" value="${completed.length}" aria-label="已解锁 ${completed.length} 项，共 ${total} 项"></progress></section><div class="achievement-scroll" tabindex="0" role="region" aria-label="成就列表">${!total ? `<div class="achievement-empty">${achievementTrophy}<h3>旅程才刚刚开始</h3><p>当前内容中还没有成就。<br>启用包含成就的内容包后，可在这里查看。</p></div>` : `<section class="achievement-section"><header><h3>已解锁</h3><span>${completed.length}</span></header>${completed.length ? `<ul>${completed.map(achievementRow).join("")}</ul>` : '<p class="achievement-section-empty">第一枚成就，静候你的好手。</p>'}</section><section class="achievement-section achievement-locked-section"><header><h3>未解锁</h3><span>${locked.length + list.hiddenCount}</span></header>${locked.length ? `<ul>${locked.map(achievementRow).join("")}</ul>` : ""}${list.hiddenCount ? `<div class="achievement-hidden-summary">${lock}<div><strong>${list.hiddenCount} 项隐藏成就</strong><p>解锁后揭晓具体内容</p></div></div>` : ""}${!locked.length && !list.hiddenCount ? '<p class="achievement-section-empty">全部成就已解锁。</p>' : ""}</section>`}</div>`;
}

/** UI lifetime belongs to the mounted game, across individual screen redraws. */
export function mountAchievementUi(root: HTMLElement): () => void {
  const source = gameAchievements();
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const dialog = document.createElement("dialog");
  dialog.className = "modal achievement-overview";
  dialog.setAttribute("aria-labelledby", "achievement-overview-title");
  dialog.innerHTML = `<header class="achievement-header"><span class="achievement-header-icon">${achievementTrophy}</span><div><p>HOUSE OF CHANCES</p><h2 id="achievement-overview-title">成就</h2></div><button type="button" class="modal-close" aria-label="关闭成就" autofocus>×</button></header><div class="achievement-overview-content"></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector<HTMLElement>(".achievement-overview-content")!;
  const imageFallback = (event: Event) => {
    if (event.target instanceof HTMLImageElement && event.target.closest(".achievement-cover")) event.target.remove();
  };
  dialog.addEventListener("error", imageFallback, { capture: true, signal });
  dialog.querySelector("button")!.addEventListener("click", () => void closeUiDialog(dialog), { signal });
  let returnFocus: HTMLElement | undefined;
  dialog.addEventListener("close", () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }, { signal });
  const render = () => {
    if (!dialog.open) return;
    const scroll = content.querySelector(".achievement-scroll")?.scrollTop ?? 0;
    const snapshot = source.snapshot;
    content.innerHTML = snapshot.status === "ready" ? overviewContent(snapshot.list)
      : `<div class="achievement-empty" role="status">${achievementTrophy}<h3>${snapshot.status === "error" ? "成就暂时无法读取" : "正在整理成就……"}</h3><p>${snapshot.status === "error" ? "请重试读取，已保存的成就不会被覆盖。" : "稍候片刻"}</p>${snapshot.status === "error" ? '<button type="button" class="secondary-button" data-achievement-retry>重新读取</button>' : ""}</div>`;
    const scroller = content.querySelector(".achievement-scroll");
    if (scroller) scroller.scrollTop = scroll;
    content.querySelector("[data-achievement-retry]")?.addEventListener("click", () => { void source.ready().catch(() => {}); });
  };
  const open = () => {
    if (dialog.open) return;
    returnFocus = root.querySelector<HTMLElement>('[data-ui-action="achievements"]')
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    openUiDialog(dialog);
    render();
    void source.ready().catch(() => {});
  };
  openActiveOverview = open;
  const unsubscribe = source.subscribe(render);
  void source.ready().catch(() => {});

  const disposeToasts = mountAchievementToasts(root, source, cover);

  return () => {
    if (openActiveOverview === open) openActiveOverview = undefined;
    lifetime.abort(); unsubscribe(); disposeToasts();
    if (dialog.open) dialog.close();
    dialog.remove();
  };
}
