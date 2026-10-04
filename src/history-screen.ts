import "./history-screen.css";
import { getCharacterMetadata } from "./content/characters";
import type { MatchHistoryRecord } from "./core/match/history";
import { clearMatchHistory } from "./persistence/boot";
import type { LongTermSave } from "./persistence/schema";
import type { PluginRuntimeContext, PluginRuntimeContribution } from "./content/packages/plugin-contracts";
import type { MountedScreen } from "./runtime/contracts";
import { confirmGameDialog } from "./game-dialog";

const CLEAR_HISTORY_CONFIRM_MESSAGE = "清理全部对局记录？首次击败进度、角色与技能解锁不会受到影响。";

export interface HistoryScreenContext extends PluginRuntimeContext {
  replaceSave(save: LongTermSave): void;
  saveLongTerm(save: LongTermSave): Promise<void>;
  navigateToLobby(): Promise<void>;
  readonly contributions: readonly PluginRuntimeContribution[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}

function historyDate(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function resultLabel(record: MatchHistoryRecord): string {
  return record.escaped ? "策展人离席" : record.winner === "player" ? "策展人胜利" : "策展人落败";
}

function cardMarkup(record: MatchHistoryRecord): string {
  const character = getCharacterMetadata(record.opponentId);
  const characterName = character?.name ?? `资源不可用 · ${record.opponentId}`;
  const won = record.winner === "player" && !record.escaped;
  return `<button class="history-card ${won && character ? "is-victory" : "is-empty"}" data-history-id="${escapeHtml(record.id)}"><span class="history-card-visual" data-history-art></span><span class="history-card-meta"><small>${resultLabel(record)}</small><strong>策展人 VS ${escapeHtml(characterName)}</strong><time datetime="${escapeHtml(record.timestamp)}">${historyDate(record.timestamp)}</time></span></button>`;
}

function render(context: HistoryScreenContext): void {
  const records = [...context.getSave().history].reverse();
  const cards = records.map(cardMarkup).join("");
  context.root.innerHTML = `<main class="history-shell"><header class="history-topbar"><button class="icon-button" data-history-back aria-label="返回大厅">←</button><span class="eyebrow">对局记录</span><span data-history-feature-slot><span class="history-count">${records.length}</span></span></header><section class="history-heading"><p class="kicker">你的对局记录</p><h1>历史<br><em>记录</em></h1><p>这里保留每一局的结果与统计，可随时单独清理。</p><button type="button" class="danger-button history-clear-button" data-clear-history ${records.length === 0 ? "disabled" : ""}>清理对局记录</button></section><section class="history-list">${cards || `<div class="history-empty"><span>◇</span><h2>还没有对局记录</h2><p>完成一场牌局后，统计会出现在这里。</p></div>`}</section><dialog id="history-detail" class="modal history-modal"><button class="modal-close" data-history-close aria-label="关闭">×</button><div id="history-detail-content"></div></dialog></main>`;
}

function openDetail(context: HistoryScreenContext, id: string, signal: AbortSignal): void {
  const record = context.getSave().history.find((entry) => entry.id === id);
  const dialog = context.root.querySelector<HTMLDialogElement>("#history-detail");
  const content = context.root.querySelector<HTMLDivElement>("#history-detail-content");
  if (!record || !dialog || !content) return;
  const metadata = getCharacterMetadata(record.opponentId);
  const name = metadata?.name ?? `资源不可用 · ${record.opponentId}`;
  content.innerHTML = `<p class="eyebrow">${historyDate(record.timestamp)}</p><h2>${resultLabel(record)}</h2><p class="history-opponent">策展人 VS ${escapeHtml(name)}</p><dl class="history-stats"><dt>策展人最终左轮</dt><dd>${record.finalRoulette.player.bullets} / ${record.finalRoulette.player.capacity}</dd><dt>${escapeHtml(name)}最终左轮</dt><dd>${record.finalRoulette.opponent.bullets} / ${record.finalRoulette.opponent.capacity}</dd><dt>策展人爆牌</dt><dd>${record.busts.player} 次</dd><dt>${escapeHtml(name)}爆牌</dt><dd>${record.busts.opponent} 次</dd><dt>策展人黑杰克</dt><dd>${record.blackjacks.player} 次</dd><dt>${escapeHtml(name)}黑杰克</dt><dd>${record.blackjacks.opponent} 次</dd></dl>`;
  dialog.showModal();
  for (const contribution of context.contributions) {
    if (!contribution.mountHistoryDetail) continue;
    const container = document.createElement("div");
    container.className = "history-detail-extension";
    content.insertBefore(container, content.querySelector(".history-stats"));
    const lifetime = new AbortController();
    let dispose: (() => void) | undefined;
    const cleanup = () => {
      lifetime.abort();
      dispose?.();
      dispose = undefined;
      container.remove();
    };
    signal.addEventListener("abort", cleanup, { once: true });
    void Promise.resolve().then(() => {
      if (!lifetime.signal.aborted) return contribution.mountHistoryDetail!(context, container, record, lifetime.signal);
    }).then((release) => {
      if (lifetime.signal.aborted) release?.();
      else dispose = release ?? undefined;
    }).catch(() => {
      if (!lifetime.signal.aborted) container.textContent = "扩展内容暂时不可用。";
    });
  }
}

export async function mountHistoryScreen(context: HistoryScreenContext, signal: AbortSignal): Promise<MountedScreen> {
  render(context);
  const disposers: Array<() => void> = [];
  let detailLifetime: AbortController | undefined;
  const closeDetail = () => { detailLifetime?.abort(); detailLifetime = undefined; };
  disposers.push(closeDetail);
  signal.addEventListener("abort", closeDetail, { once: true });
  context.root.querySelector<HTMLDialogElement>("#history-detail")?.addEventListener("close", (event) => { if (!(event.target as HTMLDialogElement).open) closeDetail(); }, { signal });
  context.root.querySelector<HTMLButtonElement>("[data-history-back]")?.addEventListener("click", () => { void context.navigateToLobby(); }, { signal });
  context.root.querySelector<HTMLButtonElement>("[data-history-close]")?.addEventListener("click", () => context.root.querySelector<HTMLDialogElement>("#history-detail")?.close(), { signal });
  context.root.querySelectorAll<HTMLButtonElement>("[data-history-id]").forEach((button) => button.addEventListener("click", () => {
    closeDetail();
    detailLifetime = new AbortController();
    openDetail(context, button.dataset.historyId ?? "", detailLifetime.signal);
  }, { signal }));
  context.root.querySelector<HTMLButtonElement>("[data-clear-history]")?.addEventListener("click", async () => {
    const save = context.getSave();
    if (save.history.length === 0 || !await confirmGameDialog("清理对局记录", CLEAR_HISTORY_CONFIRM_MESSAGE, "清理")) return;
    if (signal.aborted) return;
    const next = clearMatchHistory(save);
    await context.saveLongTerm(next);
    if (signal.aborted) return;
    context.replaceSave(next);
    await context.navigateToHistory();
  }, { signal });
  for (const contribution of context.contributions) {
    const dispose = contribution.enhanceHistory?.(context, signal);
    if (dispose) disposers.push(dispose);
  }
  return { dispose() { disposers.forEach((dispose) => dispose()); context.root.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close()); } };
}
