import "./notebook-screen.css";
import { mountNotebookArt } from "./notebook-art";
import { getCharacterMetadata } from "./content/characters/catalog";
import { loadCharacter } from "./content/characters/loader";
import type { CharacterDefinition } from "./content/characters/types";
import { registerBackHandler } from "./platform/back-navigation";
import { closeUiDialog, openUiDialog } from "./presentation/dialog-motion";
import { escapeHtml } from "./presentation/view-helpers";
import type { RuntimeScreenModule } from "./runtime/contracts";
import { notebookDialogueLines, notebookEndings, notebookPortraits, type NotebookEndingId } from "./notebook-content";
export type { NotebookEndingId } from "./notebook-content";

export interface NotebookStoryEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly cover?: string;
  readonly available: boolean;
  readonly status?: string;
}
export interface NotebookScreenOptions {
  getStories(): readonly NotebookStoryEntry[];
  getRecordedCharacterIds(): readonly string[];
  getUnlockedEndings?(characterId: string): readonly NotebookEndingId[];
  /** Resolves after playback ends, so the archive remains the return destination. */
  replayStory(id: string, signal?: AbortSignal): Promise<void>;
}

type NotebookPage = "home" | "stories" | "records" | "character";
type CharacterTab = "dialogue" | "portraits" | "endings";
const bookIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5"/></svg>';
const imageMarkup = (image: string, label: string, className = "") => `<img class="${className}" src="${escapeHtml(image)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async" />`;

const artMarkup = (image: string, label: string, mode: "gallery" | "ending" | "dialog") => `<span class="notebook-art-viewport" data-notebook-art-frame="${mode}">${imageMarkup(image, label)}</span>`;

export function createNotebookScreen(options: NotebookScreenOptions): RuntimeScreenModule {
  return {
    async mount(context, signal) {
      let page: NotebookPage = "home", tab: CharacterTab = "dialogue", character: CharacterDefinition | undefined;
      let loadingId: string | undefined, loadingError = "", playingId: string | undefined, playbackError = "";
      let revision = 0, disposed = false;
      let releaseArtwork: () => void = () => {};
      const refreshArtwork = () => { releaseArtwork(); releaseArtwork = mountNotebookArt(context.root, signal); };
      const alive = () => !disposed && !signal.aborted;
      const ids = () => [...new Set(options.getRecordedCharacterIds())];
      const unlocked = (id: string) => options.getUnlockedEndings?.(id) ?? [];
      const closeImage = () => closeUiDialog(context.root.querySelector<HTMLDialogElement>("[data-notebook-image-dialog]"));
      const back = async () => {
        if (!alive() || playingId) return;
        if (context.root.querySelector<HTMLDialogElement>("[data-notebook-image-dialog]")?.open) { await closeImage(); return; }
        revision++;
        if (page === "home") { await context.navigate({ id: "lobby" }); return; }
        if (page === "character") { page = "records"; character = undefined; loadingId = undefined; }
        else page = "home";
        render();
      };
      const unregisterBack = registerBackHandler({ signal, priority: 10, enabled: alive, handle: back });
      const heading = () => page === "home" ? "笔记本" : page === "stories" ? "剧情档案馆" : page === "records" ? "个人记录" : character?.name ?? "人物档案";
      const empty = (title: string, text: string) => `<div class="notebook-empty">${bookIcon}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div>`;
      const home = () => `<section class="notebook-intro"><p class="kicker">策展人的记录</p><h1>笔记本</h1><p>把经历过的故事，以及牌桌对面的身影，留在这里。</p></section><nav class="notebook-sections" aria-label="笔记本目录"><button class="notebook-section-card" data-notebook-section="stories">${bookIcon}<strong>剧情档案馆</strong><span>重新翻阅已经开启的故事</span><small>${options.getStories().length} 段剧情 →</small></button><button class="notebook-section-card" data-notebook-section="records"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg><strong>个人记录</strong><span>对白、立绘与留下的结局</span><small>${ids().length} 位与会者 →</small></button></nav>`;
      const stories = () => {
        const entries = options.getStories();
        return `<section class="notebook-heading"><h1>剧情档案馆</h1></section><p class="notebook-status" role="status">${escapeHtml(playbackError)}</p><section class="notebook-story-list">${entries.length ? entries.map(entry => `<article class="notebook-story-card">${entry.cover ? imageMarkup(entry.cover, entry.title, "notebook-story-cover") : `<div class="notebook-story-cover notebook-cover-empty">${bookIcon}</div>`}<div class="notebook-story-copy"><h2>${escapeHtml(entry.title)}</h2><p>${escapeHtml(entry.description)}</p>${entry.status ? `<small>${escapeHtml(entry.status)}</small>` : ""}<button class="primary-button" data-notebook-play="${escapeHtml(entry.id)}" ${!entry.available || playingId ? "disabled" : ""}>${playingId === entry.id ? "正在播放…" : entry.available ? "播放剧情" : "暂不可播放"}</button></div></article>`).join("") : empty("还没有剧情记录", "在游戏中触发剧情或达成相应进度后，它会收录到这里。")}</section>`;
      };
      const records = () => `<section class="notebook-heading"><h1>个人记录</h1><p>不论胜负，交手过的与会者都会留下记录。结局会在实际经历后收录。</p></section><section class="notebook-record-list">${ids().length ? ids().map(id => {
        const metadata = getCharacterMetadata(id);
        return metadata ? `<button class="notebook-character-card" data-notebook-character="${escapeHtml(id)}">${imageMarkup(metadata.previewImage, metadata.name)}<span><strong>${escapeHtml(metadata.name)}</strong><small>${unlocked(id).length} / 3 种结局</small></span><span aria-hidden="true">→</span></button>` : `<article class="notebook-character-card is-unavailable"><div class="notebook-missing-art">${bookIcon}</div><span><strong>资源不可用</strong><small>${escapeHtml(id)}</small><small>重新启用人物内容后可查看资料，已有记录仍然保留。</small></span></article>`;
      }).join("") : empty("还没有人物记录", "完成一场对局后，对手的资料就会留在这里；失败也会记录。")}</section>`;
      const characterBody = () => {
        if (!character) return `<section class="notebook-heading"><h1>人物档案</h1><p role="status">${escapeHtml(loadingError || "正在翻开人物记录…")}</p>${loadingError && loadingId ? `<button class="secondary-button" data-notebook-retry>重试</button>` : ""}</section>`;
        const lines = notebookDialogueLines(character), portraits = notebookPortraits(character), endings = notebookEndings(character, unlocked(character.id));
        const body = tab === "dialogue" ? `<section aria-label="人物对白"><p class="notebook-count">${lines.length} 句对白</p><ol class="notebook-dialogue-list">${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ol>${lines.length ? "" : empty("暂无对白", "当前人物内容没有提供可查看的对白。")}</section>`
          : tab === "portraits" ? `<section aria-label="牌桌立绘"><p class="notebook-count">${portraits.length} 张立绘 · 点击放大</p><div class="notebook-portrait-grid">${portraits.map((portrait, index) => `<button class="notebook-portrait-card" data-notebook-art="${index}">${artMarkup(portrait.image, `${character!.name} · ${portrait.label}`, "gallery")}<span>${escapeHtml(portrait.label)}</span></button>`).join("")}</div></section>`
          : `<section class="notebook-ending-list" aria-label="三种结局">${endings.map(ending => `<article class="notebook-ending-card ${ending.unlocked ? "" : "is-locked"}" data-notebook-ending="${ending.id}"><h2>${ending.label}</h2>${ending.unlocked ? `${artMarkup(ending.image!, `${character!.name} · ${ending.label}`, "ending")}<p>${escapeHtml(ending.text!)}</p>` : '<p class="notebook-lock">尚未收录</p><p>实际经历这一结局后解锁。</p>'}</article>`).join("")}</section>`;
        return `<header class="notebook-character-heading"><h1>${escapeHtml(character.name)}</h1><p>${escapeHtml(character.subtitle)}</p></header><nav class="notebook-tabs" aria-label="人物资料分类">${([['dialogue', '人物对白'], ['portraits', '牌桌立绘'], ['endings', '三种结局']] as const).map(([id, label]) => `<button data-notebook-tab="${id}" ${tab === id ? 'aria-current="page"' : ''}>${label}</button>`).join("")}</nav>${body}`;
      };
      const openCharacter = async (id: string) => {
        if (!ids().includes(id) || !alive()) return;
        page = "character"; character = undefined; tab = "dialogue"; loadingId = id; loadingError = "";
        const request = ++revision; render();
        try {
          const loaded = await loadCharacter(id);
          if (!alive() || request !== revision) return;
          character = loaded; render();
        } catch {
          if (!alive() || request !== revision) return;
          loadingError = "人物资料暂时无法读取，请重试。"; render();
        }
      };
      const openArt = (index: number) => {
        if (!character || !alive()) return;
        const portrait = notebookPortraits(character)[index], dialog = context.root.querySelector<HTMLDialogElement>("[data-notebook-image-dialog]");
        if (!portrait || !dialog) return;
        const content = dialog.querySelector<HTMLElement>("[data-notebook-image-content]")!;
        content.innerHTML = `<h2 id="notebook-image-title">${escapeHtml(character.name)} · ${escapeHtml(portrait.label)}</h2>${artMarkup(portrait.image, `${character.name} · ${portrait.label}`, "dialog")}`;
        openUiDialog(dialog); refreshArtwork();
      };
      function render() {
        if (!alive()) return;
        releaseArtwork();
        context.root.querySelector<HTMLDialogElement>("[data-notebook-image-dialog][open]")?.close();
        context.root.innerHTML = `<main class="notebook-shell" data-notebook-page="${page}"><header class="notebook-topbar"><button class="icon-button" data-notebook-back aria-label="${page === "home" ? "返回大厅" : page === "character" ? "返回个人记录" : "返回笔记本"}" ${playingId ? "disabled" : ""}>←</button><span>${bookIcon}${escapeHtml(heading())}</span></header>${page === "home" ? home() : page === "stories" ? stories() : page === "records" ? records() : characterBody()}<dialog class="modal notebook-image-dialog" aria-labelledby="notebook-image-title" data-notebook-image-dialog><button class="modal-close" aria-label="关闭立绘" data-notebook-image-close>×</button><div data-notebook-image-content></div></dialog></main>`;
        context.root.querySelector<HTMLButtonElement>("[data-notebook-back]")?.addEventListener("click", () => { void back(); }, { signal });
        context.root.querySelectorAll<HTMLButtonElement>("[data-notebook-section]").forEach(button => button.addEventListener("click", () => { page = button.dataset.notebookSection === "stories" ? "stories" : "records"; revision++; render(); }, { signal }));
        context.root.querySelectorAll<HTMLButtonElement>("[data-notebook-character]").forEach(button => button.addEventListener("click", () => { void openCharacter(button.dataset.notebookCharacter!); }, { signal }));
        context.root.querySelector<HTMLButtonElement>("[data-notebook-retry]")?.addEventListener("click", () => { if (loadingId) void openCharacter(loadingId); }, { signal });
        context.root.querySelectorAll<HTMLButtonElement>("[data-notebook-tab]").forEach(button => button.addEventListener("click", () => { tab = button.dataset.notebookTab as CharacterTab; render(); context.root.querySelector<HTMLButtonElement>(`[data-notebook-tab="${tab}"]`)?.focus({ preventScroll: true }); }, { signal }));
        context.root.querySelectorAll<HTMLButtonElement>("[data-notebook-art]").forEach(button => button.addEventListener("click", () => openArt(Number(button.dataset.notebookArt)), { signal }));
        context.root.querySelector<HTMLButtonElement>("[data-notebook-image-close]")?.addEventListener("click", () => { void closeImage(); }, { signal });
        context.root.querySelectorAll<HTMLButtonElement>("[data-notebook-play]").forEach(button => button.addEventListener("click", async () => {
          if (playingId || !alive()) return;
          const entry = options.getStories().find(item => item.id === button.dataset.notebookPlay);
          if (!entry?.available) return;
          playingId = entry.id; playbackError = ""; const request = revision; render();
          try { await options.replayStory(entry.id, signal); }
          catch (error) { playbackError = error instanceof Error ? error.message : "剧情暂时无法播放，请重试。"; }
          finally { playingId = undefined; if (alive() && request === revision) render(); }
        }, { signal }));
        refreshArtwork();
      }
      render();
      return { dispose() { disposed = true; revision++; unregisterBack(); releaseArtwork(); context.root.querySelector<HTMLDialogElement>("[data-notebook-image-dialog][open]")?.close(); } };
    }
  };
}
