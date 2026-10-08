import type { ContentImportFile, ContentOperationProgress } from "./content/storage/contracts";
import type { ApplicationController } from "./application-controller";
import { releasePackagePresentation, type ManagedContentPackage, type ManagedContentResourceCounts } from "./content/packages";
import { compareHocpkgVersions } from "./content/packages/package-state";
import type { ImportSession } from "./content/transfer/hocpkg";
import { chooseGameDialog, confirmGameDialog } from "./game-dialog";
import { type PlaylistDocument, type SavedPlaylist } from "./content/playlists/store";
import { playlistJson } from "./content/playlists/transfer";

const PACKAGE_COVER_FALLBACK = "/assets/package-cover-fallback.png";
const PLAYLIST_ICONS = {
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h13l3 3v13H4zM7 4v6h9V4M7 20v-7h10v7"/></svg>',
  import: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>',
  export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6"/></svg>'
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

function manifestOf(entry: ManagedContentPackage) {
  return entry.manifest ?? entry.embeddedManifest;
}

function contentTags(entry: ManagedContentPackage): readonly string[] {
  const { resourceCounts: counts, characterName } = entry.presentation;
  const labels: string[] = [];
  if (counts.characters > 0) labels.push(characterName ? `角色 · ${characterName}` : "角色");
  if (counts.playerSkills > 0) labels.push(`玩家技能 ×${counts.playerSkills}`);
  if (counts.talents > 0) labels.push(`天赋 ×${counts.talents}`);
  return labels.length > 0 ? labels : ["内容"];
}

function resourceSummary(counts: ManagedContentResourceCounts): string {
  const labels: [number, string][] = [
    [counts.characters, "角色"],
    [counts.playerSkills, "玩家技能"],
    [counts.talents, "天赋"],
    [counts.aiSkills, "AI 技能"],
    [counts.statuses, "状态"],
    [counts.other, "其他"]
  ];
  return labels.filter(([count]) => count > 0).map(([count, label]) => `${label} ×${count}`).join("、") || "无可展示资源";
}

function stateLabel(entry: ManagedContentPackage): string {
  if (entry.state === "enabled") return "已启用";
  if (entry.state === "disabled") return "已禁用";
  if (entry.state === "not-installed") return "未安装";
  return "包已损坏";
}

export class LauncherView {
  private packages: readonly ManagedContentPackage[] = [];
  private importSessions: readonly ImportSession[] = [];
  private transferMessage = "";
  private activeImportId: string | null = null;
  private importStep: "select" | "playlist" | "progress" | "error" = "select";
  private readonly selectedImportIds = new Set<string>();
  private readonly importPreviews = new Map<string, { url: string; description: string; isPlugin: boolean; release?: () => void }>();
  private importError = "";
  private importAbort?: AbortController;
  private importCommitting = false;
  private importLastProgress = 0;
  private importLastRender = 0;
  private importWatchdog?: ReturnType<typeof setInterval>;
  private importProgress = { value: 0, max: 1, label: "" };
  private importPlaylistChoice = "";
  private importActivate = false;
  private importedPackageIds = new Set<string>();
  private savedImportPlaylists: readonly SavedPlaylist[] = [];
  private drawerOpen = false;
  private busy = false;
  private listScrollTop = 0;
  private readonly collapsedGroups = new Set<string>();
  private readonly expandedPackages = new Set<string>();
  private playlists: readonly SavedPlaylist[] = [];
  private selectedPlaylistId: string | null = null;
  private playlistMenuOpen = false;
  private managerOpen = false;
  private importOpen = false;
  private textExportId: string | null = null;
  private playlistMessage = "";

  constructor(private readonly root: HTMLDivElement, private readonly controller: ApplicationController) {}

  async mount(): Promise<void> {
    this.releasePackages();
    this.packages = [];
    this.importSessions = [];
    this.transferMessage = "";
    this.releaseImportPreviews();
    this.activeImportId = null;
    this.selectedImportIds.clear();
    this.importedPackageIds.clear();
    this.savedImportPlaylists = [];
    this.drawerOpen = false;
    this.busy = false;
    this.listScrollTop = 0;
    this.collapsedGroups.clear();
    this.expandedPackages.clear();
    this.playlists = [];
    this.selectedPlaylistId = null;
    this.playlistMenuOpen = false;
    this.managerOpen = false;
    this.importOpen = false;
    this.textExportId = null;
    this.playlistMessage = "";
    this.root.innerHTML = `<main class="launcher-shell"><span class="mark">✦</span><p data-launcher-status>正在打开内容仓库……</p><progress max="1" value="0" data-launcher-progress aria-label="内容处理进度"></progress></main>`;
    await this.refresh();
  }

  reportProgress(progress: { readonly phase: "seeding" | "verifying"; readonly packageId: string; readonly completedBytes: number; readonly totalBytes: number }): void {
    const now = Date.now();
    if (now - this.importLastRender < 100) return;
    this.importLastRender = now;
    const status = this.root.querySelector<HTMLElement>("[data-launcher-status]");
    const bar = this.root.querySelector<HTMLProgressElement>("[data-launcher-progress]");
    if (status) status.textContent = `${progress.phase === "seeding" ? "正在写入" : "正在校验"} ${progress.packageId} · ${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}`;
    if (bar) {
      bar.max = Math.max(1, progress.totalBytes);
      bar.value = progress.completedBytes;
    }
  }

  private async refresh(error?: unknown): Promise<void> {
    try {
      const packages = await this.controller.listPackages();
      const importSessions = await this.controller.listImportSessions();
      const playlists = await this.controller.listPlaylists();
      this.releasePackages();
      this.packages = packages;
      this.importSessions = importSessions;
      this.playlists = playlists;
      this.selectedPlaylistId = await this.controller.currentPlaylistId();
      document.documentElement.dataset.contentSource = this.controller.contentSource;
      this.render(error);
    } catch (loadError) {
      this.releasePackages();
      this.packages = [];
      this.importSessions = [];
      this.render(loadError);
    }
  }

  private releasePackages(): void {
    for (const entry of this.packages) releasePackagePresentation(entry.presentation);
  }

  private captureDrawerState(): void {
    const list = this.root.querySelector<HTMLElement>(".package-list");
    if (!list) return;
    this.listScrollTop = list.scrollTop;
    this.expandedPackages.clear();
    list.querySelectorAll<HTMLElement>(".package-card").forEach((card) => {
      if (card.querySelector("[data-toggle-package-details][aria-expanded='true']")) this.expandedPackages.add(card.dataset.packageId ?? "");
    });
  }

  private render(error?: unknown): void {
    this.captureDrawerState();
    const enabled = this.packages.filter((entry) => entry.state === "enabled");
    const startable = enabled.some((entry) => manifestOf(entry)?.resources.some((resource) => resource.type === "game.character-match"));
    const message = error instanceof Error ? error.message : error ? String(error) : startable ? `${enabled.length} 个内容包已经就位。` : "至少需要一个已启用的角色包。";
    const warnings = this.controller.warnings.map((warning) => `<p class="launcher-warning" role="alert">⚠ ${escapeHtml(warning)}</p>`).join("");
    const plugins = this.packages.filter((entry) => manifestOf(entry)?.resources.some((resource) => resource.type === "plugin.module"))
      .sort((left, right) => (left.pluginPriority ?? Number.MAX_SAFE_INTEGER) - (right.pluginPriority ?? Number.MAX_SAFE_INTEGER));
    const resources = this.packages.filter((entry) => !plugins.includes(entry));
    const installedPlugins = plugins.filter((entry) => entry.currentRevision !== undefined);
    const cardFor = (entry: ManagedContentPackage) => {
      const manifest = manifestOf(entry);
      const title = manifest?.metadata.title ?? entry.packageId;
      const license = manifest?.metadata.license?.trim() || "未知";
      const creators = manifest?.metadata.creators.map((creator) => creator.displayName).join("、") ?? "未知作者";
      const version = entry.manifest?.identity.version ?? entry.embeddedManifest?.identity.version ?? "未知版本";
      const coverUrl = entry.presentation.coverAsset?.url ?? PACKAGE_COVER_FALLBACK;
      const tags = contentTags(entry).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
      const metadataTags = manifest?.metadata.tags.length ? manifest.metadata.tags.join("、") : "无";
      const detailsId = `package-details-${this.packages.indexOf(entry)}`;
      const readOnly = entry.currentRevision === undefined && entry.state !== "not-installed";
      const isPlugin = plugins.includes(entry);
      const pluginIndex = installedPlugins.indexOf(entry);
      const detailsOpen = this.expandedPackages.has(entry.packageId);
      const orderControls = isPlugin && pluginIndex >= 0 && !readOnly
        ? `<div class="plugin-order-controls"><button type="button" data-plugin-move="up" data-package-id="${escapeHtml(entry.packageId)}" aria-label="上移${escapeHtml(title)}" ${pluginIndex === 0 || this.busy ? "disabled" : ""}>↑</button><button type="button" data-plugin-move="down" data-package-id="${escapeHtml(entry.packageId)}" aria-label="下移${escapeHtml(title)}" ${pluginIndex === installedPlugins.length - 1 || this.busy ? "disabled" : ""}>↓</button><span class="plugin-drag-handle" data-plugin-drag="${escapeHtml(entry.packageId)}" role="img" aria-label="拖动${escapeHtml(title)}调整顺序">☰</span></div>` : "";
      let actions = `<span class="package-readonly">${readOnly ? "只读" : ""}</span>`;
      if (entry.state === "enabled" && !readOnly) actions = `<button type="button" class="secondary-button" data-package-action="disable" data-package-id="${escapeHtml(entry.packageId)}">禁用</button><button type="button" class="danger-button" data-package-action="remove" data-package-id="${escapeHtml(entry.packageId)}">删除</button>`;
      else if (entry.state === "disabled") actions = `<button type="button" class="primary-button" data-package-action="enable" data-package-id="${escapeHtml(entry.packageId)}">启用</button><button type="button" class="danger-button" data-package-action="remove" data-package-id="${escapeHtml(entry.packageId)}">删除</button>`;
      else if (entry.state === "not-installed") actions = `<button type="button" class="primary-button" data-package-action="restore" data-package-id="${escapeHtml(entry.packageId)}">恢复</button>`;
      else if (entry.state === "broken") actions = `${entry.enabled ? `<button type="button" class="secondary-button" data-package-action="disable" data-package-id="${escapeHtml(entry.packageId)}">禁用</button>` : ""}<button type="button" class="danger-button" data-package-action="remove" data-package-id="${escapeHtml(entry.packageId)}">删除</button>`;
      if (entry.currentRevision && this.controller.contentSource === "repository") actions += `<button type="button" class="secondary-button" data-export-package data-package-id="${escapeHtml(entry.packageId)}" ${this.busy ? "disabled" : ""}>导出</button>`;
      return `<article class="package-card" data-package-id="${escapeHtml(entry.packageId)}" data-package-state="${entry.state}">${orderControls}<div class="package-card-summary"><figure class="package-cover"><img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" decoding="async" data-package-cover data-fallback-src="${PACKAGE_COVER_FALLBACK}"></figure><div class="package-card-body"><header><div class="package-content-tags">${tags}</div><span class="package-state">${escapeHtml(stateLabel(entry))}</span></header><div class="package-identity"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(creators)} · v${escapeHtml(version)}</p></div>${entry.error ? `<p class="package-error">${escapeHtml(entry.error)}</p>` : ""}<footer><button type="button" class="package-details-toggle" aria-expanded="${detailsOpen}" aria-controls="${detailsId}" data-toggle-package-details>${detailsOpen ? "收起" : "详情"}</button><div class="package-actions">${actions}</div></footer></div></div><section class="package-details" id="${detailsId}" ${detailsOpen ? "" : "hidden"}><p>${escapeHtml(manifest?.metadata.description ?? "暂无包说明。")}</p><dl><div><dt>许可证</dt><dd>${escapeHtml(license)}</dd></div><div><dt>Package ID</dt><dd>${escapeHtml(entry.packageId)}</dd></div><div><dt>大小</dt><dd>${formatBytes(entry.bytes)}</dd></div><div><dt>Tags</dt><dd>${escapeHtml(metadataTags)}</dd></div><div><dt>资源</dt><dd>${escapeHtml(resourceSummary(entry.presentation.resourceCounts))}</dd></div></dl></section></article>`;
    };
    const group = (id: "plugins" | "resources", title: string, entries: readonly ManagedContentPackage[]) => {
      const collapsed = this.collapsedGroups.has(id);
      return `<section class="package-group" data-package-group="${id}"><button type="button" class="package-group-toggle" data-toggle-package-group="${id}" aria-expanded="${!collapsed}"><strong>${title}</strong><span>${entries.length} 个 · ${collapsed ? "展开" : "收起"}</span></button><div class="package-group-items" ${collapsed ? "hidden" : ""}>${entries.map((entry) => cardFor(entry)).join("")}</div></section>`;
    };
    const packageCards = group("plugins", "插件", plugins) + group("resources", "资源", resources);
    const knownPackages = new Map(this.packages.map((entry) => [entry.packageId, entry]));
    const playlistItems = this.playlists.map((entry) => {
      const selected = entry.document.packages.map((item) => knownPackages.get(item.packageId)).filter((item): item is ManagedContentPackage => item !== undefined);
      const pluginCount = selected.filter((item) => manifestOf(item)?.resources.some((resource) => resource.type === "plugin.module")).length;
      const characterCount = selected.filter((item) => manifestOf(item)?.resources.some((resource) => resource.type === "game.character-match")).length;
      return `<button type="button" data-load-playlist="${entry.id}"><span>${escapeHtml(entry.document.name)}</span><small>${pluginCount} 个插件 · ${characterCount} 个角色包</small></button>`;
    }).join("");
    const managerRows = this.playlists.map((entry) => `<div class="playlist-manager-row" data-manage-playlist="${entry.id}"><input type="text" data-playlist-rename-input="${entry.id}" aria-label="播放集名称：${escapeHtml(entry.document.name)}" maxlength="80" value="${escapeHtml(entry.document.name)}"><div class="playlist-manager-actions"><button type="button" data-copy-playlist="${entry.id}" aria-label="复制${escapeHtml(entry.document.name)}" title="复制">${PLAYLIST_ICONS.copy}</button><button type="button" data-export-playlist="${entry.id}" aria-label="导出${escapeHtml(entry.document.name)}" title="导出">${PLAYLIST_ICONS.export}</button><button type="button" class="playlist-delete" data-delete-playlist="${entry.id}" aria-label="删除${escapeHtml(entry.document.name)}" title="删除">${PLAYLIST_ICONS.delete}</button></div><p class="playlist-row-error" role="status"></p></div>`).join("");
    const textDocument = this.playlists.find((entry) => entry.id === this.textExportId)?.document;
    const playlistTools = this.controller.contentSource === "repository" ? `<section class="playlist-tools"><div class="playlist-toolbar"><div class="playlist-name-field"><button type="button" class="playlist-name-arrow" data-toggle-playlist-menu aria-label="展开播放集列表" aria-expanded="${this.playlistMenuOpen}"><span aria-hidden="true">${this.playlistMenuOpen ? "▾" : "▸"}</span></button><span class="playlist-current-name">${escapeHtml(this.playlists.find((item) => item.id === this.selectedPlaylistId)?.document.name ?? "默认播放集")}</span></div><button type="button" class="playlist-icon" data-open-playlist-manager aria-label="管理播放集" title="管理">⚙</button><button type="button" class="playlist-icon" data-open-playlist-import aria-label="导入播放集" title="导入">${PLAYLIST_ICONS.import}</button></div><div class="playlist-menu" ${this.playlistMenuOpen ? "" : "hidden"}>${playlistItems || `<p>还没有保存的播放集。</p>`}</div><p class="playlist-status" role="status">${escapeHtml(this.playlistMessage)}</p></section>` : "";
    const playlistDialogs = this.controller.contentSource === "repository" ? `<dialog class="modal playlist-manager-dialog" data-playlist-manager aria-label="管理播放集"><button type="button" class="modal-close" data-close-playlist-manager aria-label="关闭管理">×</button><h2>管理播放集</h2><div class="playlist-manager-list">${managerRows || `<p>还没有保存的播放集。</p>`}</div></dialog><dialog class="modal playlist-import-dialog" data-playlist-import aria-label="导入播放集"><button type="button" class="modal-close" data-close-playlist-import aria-label="关闭导入">×</button><h2>导入播放集</h2><label class="secondary-button playlist-file-label">选择 JSON、hocpkg 或 PNG<input type="file" data-playlist-file accept=".json,.hocpkg,.png,application/json,application/zip,image/png" hidden></label><label class="playlist-paste-label">粘贴播放集 JSON<textarea data-playlist-paste rows="7" spellcheck="false"></textarea></label><button type="button" class="primary-button" data-import-playlist-text>导入文本</button><p data-playlist-import-status role="status"></p></dialog><dialog class="modal playlist-text-dialog" data-playlist-text-dialog aria-label="播放集纯文本"><button type="button" class="modal-close" data-close-playlist-text aria-label="关闭纯文本">×</button><h2>纯文本播放集</h2><textarea readonly rows="10" data-playlist-export-text>${textDocument ? escapeHtml(playlistJson(textDocument)) : ""}</textarea><div class="playlist-text-actions"><button type="button" class="secondary-button" data-copy-playlist-text>复制 JSON</button><button type="button" class="primary-button" data-download-playlist-text>下载 JSON</button></div></dialog>` : "";

    this.root.innerHTML = `<main class="launcher-shell"><section class="launcher-hero"><p class="eyebrow">House of Chances</p><span class="launcher-mark">✦</span><h1>内容管理器</h1><p class="launcher-description">知者不言，言者不知。<br>玩腻了？HoC是一个开放的社区项目，随意导入角色包或插件以定义你自己的HoC游戏体验！</p></section><section class="launcher-actions"><button type="button" class="primary-button launcher-start" data-start-game ${!startable || this.busy ? "disabled" : ""}>开始游戏</button><button type="button" class="secondary-button" data-open-packages ${this.busy ? "disabled" : ""}>资源管理</button>${warnings}<p class="launcher-status ${error ? "is-error" : ""}" data-launcher-status role="status">${escapeHtml(message)}</p><progress max="1" value="0" data-launcher-progress aria-label="内容处理进度" hidden></progress></section><dialog class="package-drawer" data-package-drawer aria-labelledby="package-drawer-title"><header><div><p class="eyebrow">Content Vault</p><h2 id="package-drawer-title">资源管理</h2></div><button type="button" class="modal-close" data-close-packages aria-label="关闭资源管理">×</button></header>${playlistTools}${this.controller.contentSource === "repository" ? `<div class="package-import-tools"><div class="package-transfer-actions"><label class="secondary-button">导入资源/资源包<input type="file" data-import-file accept=".hocpkg,.zip,.png,application/zip,image/png" hidden ${this.busy ? "disabled" : ""}></label><button type="button" class="secondary-button" disabled>社区工坊</button></div><p class="package-import-result" role="status">${escapeHtml(this.transferMessage)}</p></div>` : ""}<section class="package-list">${packageCards || `<p class="empty-package-list">内容仓库暂时不可用。</p>`}</section><button type="button" class="secondary-button package-retry" data-retry-packages>重新检查</button></dialog>${playlistDialogs}${this.renderImportDialog()}</main>`;
    this.wire();
    if (this.drawerOpen) this.root.querySelector<HTMLDialogElement>("[data-package-drawer]")?.showModal();
    if (this.managerOpen) this.root.querySelector<HTMLDialogElement>("[data-playlist-manager]")?.showModal();
    if (this.importOpen) this.root.querySelector<HTMLDialogElement>("[data-playlist-import]")?.showModal();
    if (this.textExportId) this.root.querySelector<HTMLDialogElement>("[data-playlist-text-dialog]")?.showModal();
    if (this.activeImportId || (this.busy && this.importStep === "progress")) this.root.querySelector<HTMLDialogElement>("[data-import-dialog]")?.showModal();
    const list = this.root.querySelector<HTMLElement>(".package-list");
    if (list) list.scrollTop = this.listScrollTop;
  }

  private wire(): void {
    this.root.querySelector<HTMLButtonElement>("[data-start-game]")?.addEventListener("click", () => void this.startGame());
    this.root.querySelector<HTMLButtonElement>("[data-open-packages]")?.addEventListener("click", () => {
      this.drawerOpen = true;
      this.root.querySelector<HTMLDialogElement>("[data-package-drawer]")?.showModal();
    });
    this.root.querySelector<HTMLButtonElement>("[data-close-packages]")?.addEventListener("click", () => {
      this.drawerOpen = false;
      this.root.querySelector<HTMLDialogElement>("[data-package-drawer]")?.close();
    });
    this.root.querySelector<HTMLButtonElement>("[data-retry-packages]")?.addEventListener("click", () => void this.refresh());
    this.root.querySelectorAll<HTMLImageElement>("[data-package-cover]").forEach((cover) => cover.addEventListener("error", () => {
      const fallback = cover.dataset.fallbackSrc;
      if (fallback && !cover.src.endsWith(fallback)) cover.src = fallback;
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-toggle-package-details]").forEach((button) => button.addEventListener("click", () => {
      const detailsId = button.getAttribute("aria-controls");
      const details = detailsId ? this.root.querySelector<HTMLElement>(`#${detailsId}`) : null;
      if (!details) return;
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.textContent = expanded ? "详情" : "收起";
      details.hidden = expanded;
      const packageId = button.closest<HTMLElement>(".package-card")?.dataset.packageId;
      if (packageId) expanded ? this.expandedPackages.delete(packageId) : this.expandedPackages.add(packageId);
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-toggle-package-group]").forEach((button) => button.addEventListener("click", () => {
      const group = button.dataset.togglePackageGroup;
      if (!group) return;
      this.collapsedGroups.has(group) ? this.collapsedGroups.delete(group) : this.collapsedGroups.add(group);
      this.render();
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-plugin-move]").forEach((button) => button.addEventListener("click", () => void this.movePlugin(button)));
    this.root.querySelectorAll<HTMLElement>("[data-plugin-drag]").forEach((handle) => handle.addEventListener("pointerdown", (event) => this.startPluginDrag(event, handle)));
    this.root.querySelectorAll<HTMLButtonElement>("[data-package-action]").forEach((button) => button.addEventListener("click", () => void this.mutatePackage(button)));
    this.root.querySelector<HTMLInputElement>("[data-import-file]")?.addEventListener("click", (event) => {
      if (!this.controller.hasImportPicker) return;
      event.preventDefault();
      void this.stageImportFile();
    });
    this.root.querySelector<HTMLInputElement>("[data-import-file]")?.addEventListener("change", (event) => void this.stageImport(event.currentTarget as HTMLInputElement));
    this.root.querySelector<HTMLButtonElement>("[data-import-next]")?.addEventListener("click", () => void this.advanceImport());
    this.root.querySelector<HTMLButtonElement>("[data-import-activate]")?.addEventListener("click", () => void this.commitImport(true));
    this.root.querySelector<HTMLButtonElement>("[data-import-skip-playlist]")?.addEventListener("click", () => void this.commitImport(false));
    this.root.querySelectorAll<HTMLButtonElement>("[data-import-cancel], [data-import-close]").forEach((button) => button.addEventListener("click", () => void this.cancelImport()));
    this.root.querySelector<HTMLButtonElement>("[data-import-retry]")?.addEventListener("click", () => void this.commitImport(this.importActivate));
    this.root.querySelector<HTMLSelectElement>("[data-import-playlist-choice]")?.addEventListener("change", (event) => { this.importPlaylistChoice = (event.currentTarget as HTMLSelectElement).value; });
    this.root.querySelector<HTMLDialogElement>("[data-import-dialog]")?.addEventListener("cancel", (event) => { event.preventDefault(); if (this.importStep !== "progress") void this.cancelImport(); });
    this.root.querySelectorAll<HTMLInputElement>("[data-import-candidate]").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) {
        const packageId = input.dataset.packageId;
        if (packageId) for (const peer of this.root.querySelectorAll<HTMLInputElement>("[data-import-candidate]")) if (peer !== input && peer.dataset.packageId === packageId) { peer.checked = false; this.selectedImportIds.delete(peer.value); }
        this.selectedImportIds.add(input.value);
      } else this.selectedImportIds.delete(input.value);
      const button = this.root.querySelector<HTMLButtonElement>("[data-import-next]");
      if (button) { button.textContent = `安装所选包（${this.selectedImportIds.size}）`; button.disabled = this.selectedImportIds.size === 0; }
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-export-package]").forEach((button) => button.addEventListener("click", () => void this.exportPackage(button)));
    this.root.querySelector<HTMLButtonElement>("[data-toggle-playlist-menu]")?.addEventListener("click", () => {
      this.playlistMenuOpen = !this.playlistMenuOpen;
      this.render();
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-load-playlist]").forEach((button) => button.addEventListener("click", () => void this.loadPlaylist(button.dataset.loadPlaylist ?? "")));
    this.root.querySelector<HTMLButtonElement>("[data-open-playlist-manager]")?.addEventListener("click", () => {
      this.managerOpen = true;
      this.root.querySelector<HTMLDialogElement>("[data-playlist-manager]")?.showModal();
    });
    this.root.querySelector<HTMLButtonElement>("[data-close-playlist-manager]")?.addEventListener("click", () => this.closePlaylistDialog("manager"));
    this.root.querySelector<HTMLButtonElement>("[data-open-playlist-import]")?.addEventListener("click", () => {
      this.importOpen = true;
      this.root.querySelector<HTMLDialogElement>("[data-playlist-import]")?.showModal();
    });
    this.root.querySelector<HTMLButtonElement>("[data-close-playlist-import]")?.addEventListener("click", () => this.closePlaylistDialog("import"));
    this.root.querySelector<HTMLButtonElement>("[data-close-playlist-text]")?.addEventListener("click", () => this.closePlaylistDialog("text"));
    this.root.querySelector<HTMLButtonElement>("[data-import-playlist-text]")?.addEventListener("click", () => void this.importPlaylistText());
    this.root.querySelector<HTMLInputElement>("[data-playlist-file]")?.addEventListener("change", (event) => void this.importPlaylistFile(event.currentTarget as HTMLInputElement));
    this.root.querySelectorAll<HTMLInputElement>("[data-playlist-rename-input]").forEach((input) => {
      input.addEventListener("change", () => void this.renamePlaylistInline(input));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          input.value = this.playlists.find((entry) => entry.id === input.dataset.playlistRenameInput)?.document.name ?? input.value;
          input.blur();
        }
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-copy-playlist]").forEach((button) => button.addEventListener("click", () => void this.copyPlaylist(button.dataset.copyPlaylist ?? "")));
    this.root.querySelectorAll<HTMLButtonElement>("[data-delete-playlist]").forEach((button) => button.addEventListener("click", () => void this.deletePlaylist(button.dataset.deletePlaylist ?? "")));
    this.root.querySelectorAll<HTMLButtonElement>("[data-export-playlist]").forEach((button) => button.addEventListener("click", () => void this.exportPlaylist(button.dataset.exportPlaylist ?? "")));
    this.root.querySelector<HTMLButtonElement>("[data-copy-playlist-text]")?.addEventListener("click", () => void this.copyPlaylistText());
    this.root.querySelector<HTMLButtonElement>("[data-download-playlist-text]")?.addEventListener("click", () => void this.downloadPlaylistText());
    for (const [selector, kind] of [["[data-playlist-manager]", "manager"], ["[data-playlist-import]", "import"], ["[data-playlist-text-dialog]", "text"]] as const) {
      this.root.querySelector<HTMLDialogElement>(selector)?.addEventListener("close", () => {
        if (kind === "manager") this.managerOpen = false;
        else if (kind === "import") this.importOpen = false;
        else this.textExportId = null;
      });
    }

  }

  private releaseImportPreviews(): void {
    for (const preview of this.importPreviews.values()) preview.release?.();
    this.importPreviews.clear();
  }

  private renderImportDialog(): string {
    const session = this.importSessions.find((entry) => entry.id === this.activeImportId);
    if (!session && !(this.busy && this.importStep === "progress")) return "";
    const candidates = session?.candidates ?? [];
    const valid = candidates.filter((item) => !item.error);
    const groups = [
      { title: "播放集", items: valid.filter((item) => item.kind === "playlist") },
      { title: "插件", items: valid.filter((item) => item.kind === "package" && this.importPreviews.get(item.id)?.isPlugin) },
      { title: "其他资源", items: valid.filter((item) => item.kind === "package" && !this.importPreviews.get(item.id)?.isPlugin) }
    ];
    const cards = groups.filter((group) => group.items.length).map((group) => `<section class="import-candidate-group"><h3>${group.title} · ${group.items.length}</h3>${group.items.map((candidate) => {
      const preview = this.importPreviews.get(candidate.id);
      const installed = this.packages.find((item) => item.packageId === candidate.packageId && item.currentRevision);
      const currentVersion = installed ? manifestOf(installed)?.identity.version : undefined;
      const comparison = currentVersion && candidate.version ? compareHocpkgVersions(candidate.version, currentVersion) : undefined;
      const relation = !installed ? "新内容" : installed.currentRevision === candidate.digest ? "已安装" : comparison === -1 ? "降级" : comparison === 1 ? "升级" : "同版本替换";
      const version = currentVersion ? `v${currentVersion} → v${candidate.version ?? "?"}` : candidate.version ? `v${candidate.version}` : "播放集";
      const title = candidate.title ?? candidate.packageId ?? candidate.source;
      return `<article class="import-candidate-item"><label class="import-candidate-card"><input type="checkbox" data-import-candidate data-package-id="${escapeHtml(candidate.packageId ?? "")}" value="${candidate.id}" ${this.selectedImportIds.has(candidate.id) ? "checked" : ""}><img src="${escapeHtml(preview?.url ?? PACKAGE_COVER_FALLBACK)}" alt="" loading="lazy"><span class="import-candidate-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(preview?.description ?? candidate.source)}</small><span>${escapeHtml(version)} · ${relation}</span><small>${escapeHtml(candidate.packageId ?? candidate.source)}</small></span></label><details class="import-candidate-details"><summary>详情</summary><p>${escapeHtml(title)} · ${escapeHtml(candidate.source)}</p><p>${escapeHtml(preview?.description ?? "暂无包说明。")}</p><p>${escapeHtml(candidate.packageId ?? "播放集")} · ${escapeHtml(version)}</p></details></article>`;
    }).join("")}</section>`).join("");
    const damaged = candidates.filter((item) => item.error).map((item) => `<p class="package-error">${escapeHtml(item.source)}：${escapeHtml(item.error ?? "")}</p>`).join("");
    const playlists = valid.filter((item) => item.kind === "playlist" && this.selectedImportIds.has(item.id));
    const body = this.importStep === "select" ? `${cards}${damaged}` : this.importStep === "playlist" ? `<p>是否启用包中附带的播放集？所选播放集都会保存。</p><select data-import-playlist-choice aria-label="选择导入的播放集">${playlists.map((item) => `<option value="${item.id}" ${item.id === this.importPlaylistChoice ? "selected" : ""}>${escapeHtml(item.title ?? item.source)}</option>`).join("")}</select>` : `<p>${escapeHtml(this.importStep === "error" ? this.importError : this.importProgress.label)}</p><progress max="${this.importProgress.max}" value="${this.importProgress.value}" aria-label="导入进度"></progress>`;
    const actions = this.importStep === "select" ? `<button type="button" class="secondary-button" data-import-cancel>放弃</button><button type="button" class="primary-button" data-import-next ${this.selectedImportIds.size ? "" : "disabled"}>安装所选包（${this.selectedImportIds.size}）</button>`
      : this.importStep === "playlist" ? `<button type="button" class="secondary-button" data-import-skip-playlist>放弃</button><button type="button" class="primary-button" data-import-activate>启用</button>`
        : this.importStep === "error" ? `<button type="button" class="secondary-button" data-import-close>关闭</button><button type="button" class="primary-button" data-import-retry>重试</button>` : `<button type="button" class="secondary-button" data-import-cancel ${this.importCommitting ? "disabled" : ""}>${this.importCommitting ? "正在提交……" : "取消"}</button>`;
    return `<dialog class="import-review-dialog" data-import-dialog aria-label="导入内容包"><header><h2>导入内容包</h2><button type="button" class="modal-close" data-import-close aria-label="关闭导入窗口" ${this.importStep === "progress" ? "disabled" : ""}>×</button></header><div class="import-review-body" data-import-body>${body}</div><footer>${actions}</footer></dialog>`;
  }

  private beginImportOperation(label: string): void {
    this.busy = true;
    this.importStep = "progress";
    this.importCommitting = false;
    this.importAbort = new AbortController();
    this.importLastProgress = Date.now();
    this.importProgress = { value: 0, max: 1, label };
    this.importWatchdog = setInterval(() => {
      if (Date.now() - this.importLastProgress < 30000) return;
      const label = this.root.querySelector<HTMLElement>(".import-review-body p");
      if (label) label.textContent = "处理暂时没有新进度，请等待或取消。";
    }, 5000);
    this.render();
  }

  private endImportOperation(): void {
    clearInterval(this.importWatchdog);
    this.importAbort = undefined;
    this.importCommitting = false;
    this.busy = false;
    if (!this.activeImportId) this.importStep = "select";
    this.render();
  }

  private updateImportProgress = (progress: ContentOperationProgress): void => {
    this.importLastProgress = Date.now();
    if (this.importLastProgress - this.importLastRender < 100) return;
    this.importLastRender = this.importLastProgress;
    const phase = { extracting: "正在提取", verifying: "正在校验", copying: "正在复制", committing: "正在提交" }[progress.phase];
    this.importProgress = { value: progress.completedBytes, max: Math.max(1, progress.totalBytes, progress.completedBytes), label: `${phase} ${progress.path.split("/").at(-1)}` };
    const bar = this.root.querySelector<HTMLProgressElement>(".import-review-dialog progress");
    if (bar) { bar.max = this.importProgress.max; bar.value = this.importProgress.value; }
    const label = this.root.querySelector<HTMLElement>(".import-review-body p");
    if (label) label.textContent = this.importProgress.label;
  };

  private async stageImport(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (file) await this.stageImportFile(file);
  }

  private async stageImportFile(input?: File | ContentImportFile): Promise<void> {
    if (this.busy) return;
    this.beginImportOperation("正在读取导入文件……");
    try {
      const options = { signal: this.importAbort!.signal, onProgress: this.updateImportProgress };
      const file = input ?? await this.controller.pickPackageFile(options);
      if (!file) { this.importStep = "select"; return; }
      const session = await this.controller.stagePackageFile(file, options);
      this.activeImportId = session.id;
      this.selectedImportIds.clear();
      this.releaseImportPreviews();
      const byPackage = new Map<string, typeof session.candidates[number]>();
      for (const candidate of session.candidates) {
        options.signal.throwIfAborted();
        if (candidate.error) continue;
        if (candidate.kind === "playlist") { this.selectedImportIds.add(candidate.id); continue; }
        if (!candidate.packageId) continue;
        const previous = byPackage.get(candidate.packageId);
        if (!previous || compareHocpkgVersions(candidate.version!, previous.version!) > 0) byPackage.set(candidate.packageId, candidate);
        try {
          const preview = await this.controller.previewImportCandidate(session.id, candidate.id);
          const bytes = preview.cover;
          const url = preview.asset?.url ?? (bytes ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: preview.mediaType })) : PACKAGE_COVER_FALLBACK);
          this.importPreviews.set(candidate.id, { url,
            release: preview.asset ? () => preview.asset?.release?.() : bytes ? () => URL.revokeObjectURL(url) : undefined,
            description: preview.manifest.metadata.description, isPlugin: preview.manifest.resources.some((item) => item.type === "plugin.module") });
        } catch { /* Preview is optional. */ }
      }
      for (const candidate of byPackage.values()) {
        const installed = this.packages.find((item) => item.packageId === candidate.packageId && item.currentRevision);
        if (!installed || compareHocpkgVersions(candidate.version!, manifestOf(installed)!.identity.version) >= 0) this.selectedImportIds.add(candidate.id);
      }
      options.signal.throwIfAborted();
      this.importStep = "select";
      await this.refresh();
      options.signal.throwIfAborted();
    } catch (error) {
      if (this.importAbort?.signal.aborted && this.activeImportId) {
        await this.controller.removeImportSession(this.activeImportId);
        this.activeImportId = null;
        this.releaseImportPreviews();
      }
      this.transferMessage = this.importAbort?.signal.aborted ? "导入已取消。" : error instanceof Error ? error.message : String(error); this.importStep = "select"; await this.refresh(); }
    finally { this.endImportOperation(); }
  }

  private advanceImport(): void {
    const session = this.importSessions.find((item) => item.id === this.activeImportId);
    if (!session || !this.selectedImportIds.size) return;
    const first = session.candidates.find((item) => item.kind === "playlist" && this.selectedImportIds.has(item.id));
    if (first) { this.importPlaylistChoice = first.id; this.importStep = "playlist"; this.render(); }
    else void this.commitImport(false);
  }

  private async commitImport(activate: boolean): Promise<void> {
    const session = this.importSessions.find((item) => item.id === this.activeImportId);
    if (!session || this.busy) return;
    this.importActivate = activate;
    this.importError = "";
    this.beginImportOperation("正在安装所选资源……");
    try {
      const packages = session.candidates.filter((item) => item.kind === "package" && this.selectedImportIds.has(item.id) && !this.importedPackageIds.has(item.id));
      if (packages.length) {
        await this.controller.installStagedPackages(session.id, packages.map((item) => item.id), (progress) => {
          this.updateImportProgress({ phase: "copying", path: progress.path, completedBytes: progress.completedBytes, totalBytes: progress.totalBytes });
        }, { signal: this.importAbort!.signal, onIoProgress: this.updateImportProgress, onCommit: () => {
          this.importCommitting = true;
          this.importProgress.label = "正在提交内容……";
          this.render();
        } });
        packages.forEach((item) => this.importedPackageIds.add(item.id));
      }
      this.importAbort?.signal.throwIfAborted();
      this.importCommitting = true;
      const selectedPlaylists = session.candidates.filter((item) => item.kind === "playlist" && this.selectedImportIds.has(item.id));
      if (selectedPlaylists.length && !this.savedImportPlaylists.length) {
        this.importProgress.label = "正在保存播放集……"; this.render();
        const documents: PlaylistDocument[] = [];
        for (const item of selectedPlaylists) documents.push(await this.controller.readStagedPlaylist(session.id, item.id));
        this.savedImportPlaylists = await this.controller.importStagedPlaylists(documents);
      }
      if (activate && selectedPlaylists.length) {
        this.importProgress.label = "正在切换播放集……"; this.render();
        const index = selectedPlaylists.findIndex((item) => item.id === this.importPlaylistChoice);
        await this.controller.selectPlaylist(this.savedImportPlaylists[Math.max(0, index)]!.id);
      }
      await this.controller.removeImportSession(session.id);
      this.releaseImportPreviews();
      this.activeImportId = null;
      this.selectedImportIds.clear();
      this.importedPackageIds.clear();
      this.savedImportPlaylists = [];
      this.transferMessage = "";
      await this.refresh();
    } catch (error) {
      this.importError = `导入未完成：${error instanceof Error ? error.message : String(error)}。已完成部分已保留，可重试。`;
      this.importStep = "error";
    } finally { this.endImportOperation(); }
  }

  private async cancelImport(): Promise<void> {
    if (this.busy) {
      if (!this.importCommitting) {
        this.importAbort?.abort(new DOMException("操作已取消。", "AbortError"));
        const label = this.root.querySelector<HTMLElement>(".import-review-body p");
        if (label) label.textContent = "正在停止并清理……";
      }
      return;
    }
    if (!this.activeImportId) return;
    const id = this.activeImportId;
    await this.controller.removeImportSession(id).catch((error) => { this.transferMessage = error instanceof Error ? error.message : String(error); });
    this.releaseImportPreviews();
    this.activeImportId = null;
    this.selectedImportIds.clear();
    this.importedPackageIds.clear();
    this.savedImportPlaylists = [];
    await this.refresh();
  }

  private async exportPackage(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    const packageId = button.dataset.packageId ?? "";
    const entry = this.packages.find((candidate) => candidate.packageId === packageId);
    if (!entry?.currentRevision) return;
    const format = await chooseGameDialog("导出内容包", `${manifestOf(entry)?.metadata.title ?? packageId} · ${packageId}`, [
      { value: "hocpkg", label: "导出 hocpkg 包", style: "primary" },
      ...(manifestOf(entry)?.resources.some((resource) => resource.type === "game.character-match")
        ? [{ value: "png" as const, label: "导出封面 PNG", style: "secondary" as const }] : [])
    ]);
    if (!format) return;
    this.busy = true;
    this.render();
    try { await this.controller.exportPackage(packageId, format); this.transferMessage = "内容包已导出。"; }
    catch (error) { this.transferMessage = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.render(); }
  }

  private closePlaylistDialog(kind: "manager" | "import" | "text"): void {
    const selector = kind === "manager" ? "[data-playlist-manager]" : kind === "import" ? "[data-playlist-import]" : "[data-playlist-text-dialog]";
    if (kind === "manager") this.managerOpen = false;
    else if (kind === "import") this.importOpen = false;
    else this.textExportId = null;
    this.root.querySelector<HTMLDialogElement>(selector)?.close();
  }

  private playlistOutcome(missing: readonly string[], versionMismatch: readonly string[]): string {
    const notes = [missing.length ? `缺失：${missing.join("、")}` : "", versionMismatch.length ? `版本不同：${versionMismatch.join("、")}` : ""].filter(Boolean);
    return notes.length ? `已加载。${notes.join("；")}。` : "播放集已加载。";
  }

  private async loadPlaylist(id: string): Promise<void> {
    if (this.busy) return;
    const saved = this.playlists.find((entry) => entry.id === id);
    if (!saved) return;
    this.busy = true;
    this.playlistMenuOpen = false;
    try {
      const result = await this.controller.selectPlaylist(id);
      this.selectedPlaylistId = id;
      this.playlistMessage = this.playlistOutcome(result.missing, result.versionMismatch);
      await this.refresh();
    } catch (error) { this.playlistMessage = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.render(); }
  }

  private async importPlaylistText(): Promise<void> {
    const value = this.root.querySelector<HTMLTextAreaElement>("[data-playlist-paste]")?.value ?? "";
    await this.importPlaylist(() => this.controller.importPlaylistText(value));
  }

  private async importPlaylistFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (file) await this.importPlaylist(() => this.controller.importPlaylistFile(file));
  }

  private async importPlaylist(load: () => Promise<{ document: PlaylistDocument; missing: readonly string[]; versionMismatch: readonly string[] }>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await load();
      this.selectedPlaylistId = await this.controller.currentPlaylistId();
      this.importOpen = false;
      this.playlistMessage = this.playlistOutcome(result.missing, result.versionMismatch);
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = this.root.querySelector<HTMLElement>("[data-playlist-import-status]");
      if (status) status.textContent = message;
      return;
    } finally { this.busy = false; }
    this.render();
  }

  private async renamePlaylistInline(input: HTMLInputElement): Promise<void> {
    const id = input.dataset.playlistRenameInput ?? "";
    const saved = this.playlists.find((entry) => entry.id === id);
    if (!saved || input.value.trim() === saved.document.name) return;
    input.disabled = true;
    try {
      await this.controller.renamePlaylist(id, input.value);
      await this.refresh();
    } catch (error) {
      input.disabled = false;
      const status = input.closest<HTMLElement>("[data-manage-playlist]")?.querySelector<HTMLElement>(".playlist-row-error");
      if (status) status.textContent = error instanceof Error ? error.message : String(error);
      input.focus();
    }
  }

  private async copyPlaylist(id: string): Promise<void> {
    try { const saved = await this.controller.copyPlaylist(id); this.playlistMessage = `已复制：${saved.document.name}`; await this.refresh(); }
    catch (error) { this.playlistMessage = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async deletePlaylist(id: string): Promise<void> {
    const saved = this.playlists.find((entry) => entry.id === id);
    if (!saved || !await confirmGameDialog("删除播放集", `删除「${saved.document.name}」？`, "删除")) return;
    try {
      await this.controller.removePlaylist(id);
      this.playlistMessage = "";
      await this.refresh();
    } catch (error) { this.playlistMessage = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async exportPlaylist(id: string): Promise<void> {
    const saved = this.playlists.find((entry) => entry.id === id);
    if (!saved) return;
    const format = await chooseGameDialog("导出播放集", saved.document.name, [
      { value: "hocpkg", label: "导出 hocpkg", style: "primary" },
      { value: "png", label: "导出 PNG" },
      { value: "text", label: "纯文本 JSON" }
    ]);
    if (!format) return;
    if (format === "text") { this.textExportId = id; this.render(); return; }
    try { await this.controller.exportPlaylist(saved, format); this.playlistMessage = "播放集已导出。"; this.render(); }
    catch (error) { this.playlistMessage = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async copyPlaylistText(): Promise<void> {
    const saved = this.playlists.find((entry) => entry.id === this.textExportId);
    if (!saved) return;
    try { await navigator.clipboard.writeText(playlistJson(saved.document)); this.playlistMessage = "JSON 已复制。"; }
    catch { this.playlistMessage = "复制失败，可选中上方文本手动复制。"; }
    const status = this.root.querySelector<HTMLElement>(".playlist-status");
    if (status) status.textContent = this.playlistMessage;
  }

  private async downloadPlaylistText(): Promise<void> {
    const saved = this.playlists.find((entry) => entry.id === this.textExportId);
    if (!saved) return;
    try { await this.controller.exportPlaylist(saved, "json"); this.playlistMessage = "JSON 已导出。"; }
    catch (error) { this.playlistMessage = error instanceof Error ? error.message : String(error); }
    const status = this.root.querySelector<HTMLElement>(".playlist-status");
    if (status) status.textContent = this.playlistMessage;
  }

  private orderedInstalledPlugins(): string[] {
    return this.packages.filter((entry) => entry.pluginPriority !== undefined && entry.currentRevision !== undefined)
      .sort((left, right) => left.pluginPriority! - right.pluginPriority!).map((entry) => entry.packageId);
  }

  private async savePluginOrder(order: readonly string[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await this.controller.setPluginOrder(order);
      this.busy = false;
      await this.refresh();
    } catch (error) {
      this.busy = false;
      await this.refresh(error);
    }
  }

  private async movePlugin(button: HTMLButtonElement): Promise<void> {
    const order = this.orderedInstalledPlugins();
    const index = order.indexOf(button.dataset.packageId ?? "");
    const target = index + (button.dataset.pluginMove === "up" ? -1 : 1);
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    await this.savePluginOrder(order);
  }

  private startPluginDrag(event: PointerEvent, handle: HTMLElement): void {
    if (this.busy || event.button !== 0) return;
    const sourceId = handle.dataset.pluginDrag;
    if (!sourceId || !this.orderedInstalledPlugins().includes(sourceId)) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.closest<HTMLElement>(".package-card")?.classList.add("is-dragging");
    const finish = (up: PointerEvent) => {
      handle.releasePointerCapture(up.pointerId);
      handle.closest<HTMLElement>(".package-card")?.classList.remove("is-dragging");
      handle.removeEventListener("pointerup", finish);
      const targetId = document.elementFromPoint(up.clientX, up.clientY)?.closest<HTMLElement>(".package-card")?.dataset.packageId;
      const order = this.orderedInstalledPlugins();
      const sourceIndex = order.indexOf(sourceId);
      const targetIndex = order.indexOf(targetId ?? "");
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
      order.splice(sourceIndex, 1);
      order.splice(targetIndex, 0, sourceId);
      void this.savePluginOrder(order);
    };
    handle.addEventListener("pointerup", finish, { once: true });
  }

  private async startGame(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const status = this.root.querySelector<HTMLElement>("[data-launcher-status]");
    const progress = this.root.querySelector<HTMLProgressElement>("[data-launcher-progress]");
    if (status) status.textContent = "正在校验启用的内容包……";
    if (progress) progress.hidden = false;
    try {
      if (!await this.controller.startGame(this.root)) {
        this.busy = false;
        this.drawerOpen = true;
        await this.refresh();
        return;
      }
      this.releasePackages();
      this.packages = [];
    } catch (error) {
      this.busy = false;
      await this.refresh(error);
    }
  }

  private async mutatePackage(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    const packageId = button.dataset.packageId;
    const action = button.dataset.packageAction;
    if (!packageId || !action) return;
    if (action === "remove" && !await confirmGameDialog("删除内容包", `删除内容包 ${packageId}？长期战绩会保留，但相关图片与详情将不可用。`, "删除")) return;
    this.busy = true;
    this.render();
    try {
      if (action === "enable") await this.controller.enablePackage(packageId);
      else if (action === "disable") await this.controller.disablePackage(packageId);
      else if (action === "remove") await this.controller.removePackage(packageId);
      else if (action === "restore") await this.controller.restoreEmbeddedPackage(packageId);
      this.busy = false;
      await this.refresh();
    } catch (error) {
      this.busy = false;
      await this.refresh(error);
    }
  }
}
