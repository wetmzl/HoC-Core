import { openUiDialog, closeUiDialog } from "./presentation/dialog-motion";
import { importPasswordCandidates, PasswordBook } from "./content/storage/password-book";
import { managePasswordBook, requestImportPassword } from "./import-password-dialog";
import { Capacitor } from "@capacitor/core";
import { CoreUpdater, supportsCoreUpdates, type AutoDownload, type UpdateChannel } from "./platform/core-update";
import { launcherSaveMarkup, mountLauncherSaveControls } from "./presentation/launcher-save-controls";
import { telemetrySettingsMarkup, mountTelemetryControls } from "./telemetry";
import { mountEmbeddedOfflineControls } from "./resources/embedded-offline";
import { mountPluginOrderDrag } from "./presentation/plugin-order-drag";
import type { ContentImportFile, ContentInstallProgress, ContentOperationProgress } from "./content/storage/contracts";
import { loadingIndicatorMarkup, loadingScreenMarkup, updateLoadingIndicator, type LoadingIndicatorState } from "./presentation/loading-indicator";
import type { ApplicationController } from "./application-controller";
import { releasePackagePresentation, type ManagedContentPackage, type ManagedContentResourceCounts } from "./content/packages";
import { compareHocpkgVersions } from "./content/packages/package-state";
import type { ImportSession } from "./content/transfer/hocpkg";
import { chooseGameDialog, confirmGameDialog } from "./game-dialog";
import { getContentStartupFailure } from "./content/packages/startup-error";
import { showStartupErrorDialog } from "./startup-error-dialog";
import { playlistDocument, type PlaylistDocument, type PlaylistMode, type SavedPlaylist } from "./content/playlists/store";
import { PlaylistArchiveError, playlistJson } from "./content/playlists/transfer";
import { EMBEDDED_DEFAULT_PLAYLIST_ID } from "./content/playlists/embedded-default";
import { version, releaseName } from "../package.json";

const PACKAGE_COVER_FALLBACK = "/assets/package-cover-fallback.png";
const LAUNCHER_DIALOGS = ["[data-launcher-settings]", "[data-package-drawer]", "[data-playlist-manager]", "[data-playlist-import]", "[data-playlist-text-dialog]", "[data-import-dialog]", "[data-offline-dialog]"] as const;
interface DialogRestoration { readonly scrollTop: number; readonly scrollLeft: number; readonly focus?: string; }
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
  if (counts.factions > 0) labels.push(`阵营 ×${counts.factions}`);
  return labels.length > 0 ? labels : ["内容"];
}

function resourceSummary(counts: ManagedContentResourceCounts): string {
  const labels: [number, string][] = [
    [counts.characters, "角色"],
    [counts.playerSkills, "玩家技能"],
    [counts.talents, "天赋"],
    [counts.aiSkills, "AI 技能"],
    [counts.statuses, "状态"],
    [counts.factions, "阵营"],
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
  private readonly coreUpdater = new CoreUpdater();
  private settingsOpen = false;
  private disposeOffline?: () => void;
  private disposeSettings?: () => void;
  private archives: Awaited<ReturnType<ApplicationController["listArchivedPackages"]>> = [];
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
  private importProgress: LoadingIndicatorState = { label: "" };
  private readonly launcherVerifiedBytes = new Map<string, number>();
  private importPlaylistChoice = "";
  private importActivate = false;
  private importedPackageIds = new Set<string>();
  private savedImportPlaylists: readonly SavedPlaylist[] = [];
  private packageManagerOpen = false;
  private busy = false;
  private listScrollTop = 0;
  private readonly collapsedGroups = new Set<string>();
  private readonly expandedPackages = new Set<string>();
  private playlists: readonly SavedPlaylist[] = [];
  private selectedPlaylistId: string | null = null;
  private playlistMenuOpen = false;
  private managerOpen = false;
  private importOpen = false;
  private textExport: SavedPlaylist | null = null;
  private playlistMessage = "";
  private playlistImportMessage = "";
  private disposePluginDrag?: () => void;
  private dialogRestorations?: ReadonlyMap<string, DialogRestoration>;

  constructor(private readonly root: HTMLDivElement, private readonly controller: ApplicationController) {
    // Also retry after returning from a game or reconnecting Wi-Fi, without interrupting play.
    if (supportsCoreUpdates()) setInterval(() => { void this.coreUpdater.check(false, () => !document.hidden && !this.busy && Boolean(this.root.querySelector(".launcher-shell")) && !document.querySelector("dialog[open]")); }, 60_000);
  }

  async mount(): Promise<void> {
    this.disposePluginDrag?.();
    this.releasePackages();
    this.packages = [];
    this.importSessions = [];
    this.transferMessage = "";
    this.releaseImportPreviews();
    this.activeImportId = null;
    this.selectedImportIds.clear();
    this.importedPackageIds.clear();
    this.savedImportPlaylists = [];
    this.packageManagerOpen = false;
    this.settingsOpen = false;
    this.busy = false;
    this.listScrollTop = 0;
    this.collapsedGroups.clear();
    this.expandedPackages.clear();
    this.playlists = [];
    this.selectedPlaylistId = null;
    this.playlistMenuOpen = false;
    this.managerOpen = false;
    this.importOpen = false;
    this.textExport = null;
    this.playlistMessage = "";
    this.showLauncherLoading("准备资源");
    await this.refresh();
  }

  reportProgress(progress: { readonly phase: "seeding" | "verifying"; readonly packageId: string; readonly completedBytes: number; readonly totalBytes: number }): void {
    const indicator = this.root.querySelector<HTMLElement>("[data-launcher-loading]");
    if (!indicator) return;
    const packages = this.packages.filter(entry => entry.state === "enabled" && !entry.embedded);
    const target = packages.find(entry => entry.packageId === progress.packageId);
    if (progress.phase === "verifying" && target && Number.isFinite(progress.completedBytes)) {
      this.launcherVerifiedBytes.set(progress.packageId, Math.max(this.launcherVerifiedBytes.get(progress.packageId) ?? 0, Math.min(target.bytes, progress.completedBytes)));
    }
    const now = Date.now();
    if (now - this.importLastRender < 100 && progress.completedBytes < progress.totalBytes) return;
    this.importLastRender = now;
    // Verification reports one package at a time; only show a percent with the full known set.
    updateLoadingIndicator(indicator, {
      label: progress.phase === "seeding" ? "写入资源" : "校验资源",
      ...(progress.phase === "verifying" && target ? {
        completed: packages.reduce((sum, entry) => sum + (this.launcherVerifiedBytes.get(entry.packageId) ?? 0), 0),
        total: packages.reduce((sum, entry) => sum + entry.bytes, 0)
      } : {})
    });
  }

  private showLauncherLoading(label: string): void {
    this.launcherVerifiedBytes.clear();
    this.importLastRender = 0;
    this.root.innerHTML = loadingScreenMarkup(label);
    this.root.querySelector("[data-loading-indicator]")?.setAttribute("data-launcher-loading", "");
  }

  private async refresh(error?: unknown): Promise<void> {
    try {
      const packages = await this.controller.listPackages();
      const importSessions = await this.controller.listImportSessions();
      this.archives = await this.controller.listArchivedPackages();
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

  private capturePackageListState(): void {
    const list = this.root.querySelector<HTMLElement>(".package-list");
    if (!list) return;
    this.listScrollTop = list.scrollTop;
    this.expandedPackages.clear();
    list.querySelectorAll<HTMLElement>(".package-card").forEach((card) => {
      if (card.querySelector("[data-toggle-package-details][aria-expanded='true']")) this.expandedPackages.add(card.dataset.packageId ?? "");
    });
  }

  private captureOpenDialogs(): ReadonlyMap<string, DialogRestoration> {
    const active = this.root.ownerDocument.activeElement;
    const snapshots = new Map<string, DialogRestoration>();
    for (const selector of LAUNCHER_DIALOGS) {
      const dialog = this.root.querySelector<HTMLDialogElement>(selector);
      if (!dialog?.open || dialog.classList.contains("ui-dialog-closing")) continue;
      const focused = active instanceof HTMLElement && dialog.contains(active) ? active : undefined;
      const attributes = [...focused?.attributes ?? []].filter(attribute => attribute.name.startsWith("data-") && attribute.name !== "data-ui-pressed");
      const focus = focused?.id ? `#${CSS.escape(focused.id)}` : focused && attributes.length
        ? `${focused.localName}${attributes.map(attribute => `[${CSS.escape(attribute.name)}="${CSS.escape(attribute.value)}"]`).join("")}` : undefined;
      snapshots.set(selector, { scrollTop: dialog.scrollTop, scrollLeft: dialog.scrollLeft, ...(focus ? { focus } : {}) });
    }
    return snapshots;
  }

  private openLauncherDialog(selector: string): void {
    const dialog = this.root.querySelector<HTMLDialogElement>(selector);
    const restoration = this.dialogRestorations?.get(selector);
    openUiDialog(dialog, { restore: Boolean(restoration) });
    if (!dialog || !restoration) return;
    dialog.scrollTop = restoration.scrollTop;
    dialog.scrollLeft = restoration.scrollLeft;
    if (!restoration.focus) return;
    const previous = dialog.querySelector<HTMLElement>(restoration.focus);
    const focus = previous && !previous.matches(":disabled") && !previous.closest("[hidden]") && previous.getClientRects().length
      ? previous : dialog.querySelector<HTMLElement>("[data-toggle-playlist-menu]");
    focus?.focus({ preventScroll: true });
  }

  private render(error?: unknown): void {
    const continuedDialogs = this.captureOpenDialogs();
    this.disposePluginDrag?.();
    this.disposePluginDrag = undefined;
    this.capturePackageListState();
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
      if (entry.embedded) actions = entry.state === "disabled" ? `<button type="button" class="primary-button" data-package-action="enable" data-package-id="${escapeHtml(entry.packageId)}">启用</button>` : `<button type="button" class="secondary-button" data-package-action="disable" data-package-id="${escapeHtml(entry.packageId)}">禁用</button>`;
      if (entry.currentRevision && this.controller.contentSource === "repository") actions += `<button type="button" class="secondary-button" data-export-package data-package-id="${escapeHtml(entry.packageId)}" ${this.busy ? "disabled" : ""}>导出</button>`;
      return `<article class="package-card" data-package-id="${escapeHtml(entry.packageId)}" data-package-state="${entry.state}">${orderControls}<div class="package-card-summary"><figure class="package-cover"><img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" decoding="async" data-package-cover data-fallback-src="${PACKAGE_COVER_FALLBACK}"></figure><div class="package-card-body"><header><div class="package-content-tags">${entry.embedded ? `<span class="embedded-badge">内嵌</span>` : ""}${tags}</div><span class="package-state">${escapeHtml(stateLabel(entry))}</span></header><div class="package-identity"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(creators)} · v${escapeHtml(version)}</p></div>${entry.error ? `<p class="package-error">${escapeHtml(entry.error)}</p>` : ""}<footer><button type="button" class="package-details-toggle" aria-expanded="${detailsOpen}" aria-controls="${detailsId}" data-toggle-package-details>${detailsOpen ? "收起" : "详情"}</button><div class="package-actions">${actions}</div></footer></div></div><section class="package-details" id="${detailsId}" ${detailsOpen ? "" : "hidden"}><p>${escapeHtml(manifest?.metadata.description ?? "暂无包说明。")}</p><dl><div><dt>许可证</dt><dd>${escapeHtml(license)}</dd></div><div><dt>Package ID</dt><dd>${escapeHtml(entry.packageId)}</dd></div><div><dt>大小</dt><dd>${formatBytes(entry.bytes)}</dd></div><div><dt>Tags</dt><dd>${escapeHtml(metadataTags)}</dd></div><div><dt>资源</dt><dd>${escapeHtml(resourceSummary(entry.presentation.resourceCounts))}</dd></div></dl></section></article>`;
    };
    const group = (id: "plugins" | "resources", title: string, entries: readonly ManagedContentPackage[]) => {
      const collapsed = this.collapsedGroups.has(id);
      return `<section class="package-group" data-package-group="${id}"><button type="button" class="package-group-toggle" data-toggle-package-group="${id}" aria-expanded="${!collapsed}"><strong>${title}</strong><span>${entries.length} 个 · ${collapsed ? "展开" : "收起"}</span></button><div class="package-group-items" ${collapsed ? "hidden" : ""}>${entries.map((entry) => cardFor(entry)).join("")}</div></section>`;
    };
    const archiveCards = this.archives.length ? `<section class="package-archives"><h3>历史内嵌归档（${this.archives.length}）</h3><p>归档已禁用，不参与游戏。可导出或删除。</p>${this.archives.map(entry => `<article class="archive-card" data-archive-id="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.packageId)} · v${escapeHtml(entry.version)}</small><span class="package-state">归档 · 已禁用</span><div class="package-actions"><button type="button" class="secondary-button" data-export-archive="${escapeHtml(entry.id)}">导出</button><button type="button" class="danger-button" data-remove-archive="${escapeHtml(entry.id)}">删除归档</button></div></article>`).join("")}</section>` : "";
    const packageCards = group("plugins", "插件", plugins) + group("resources", "资源", resources) + archiveCards;
    const currentPlaylist = this.playlists.find(entry => entry.id === this.selectedPlaylistId);
    const isEmbeddedDefault = (entry: SavedPlaylist | undefined) => entry?.id === EMBEDDED_DEFAULT_PLAYLIST_ID;
    const currentPlaylistName = `${escapeHtml(currentPlaylist?.document.name ?? "默认播放集")}${currentPlaylist?.document.mode === "incremental" ? "（增量）" : ""}`;
    const currentPlaylistLabel = isEmbeddedDefault(currentPlaylist) ? `<span>官方播放器（只读）</span><small>随游戏更新</small>` : currentPlaylistName;
    const knownPackages = new Map(this.packages.map((entry) => [entry.packageId, entry]));
    const playlistItems = this.playlists.map((entry) => {
      const selected = entry.document.packages.map((item) => knownPackages.get(item.packageId)).filter((item): item is ManagedContentPackage => item !== undefined);
      const pluginCount = selected.filter((item) => manifestOf(item)?.resources.some((resource) => resource.type === "plugin.module")).length;
      const characterCount = selected.filter((item) => manifestOf(item)?.resources.some((resource) => resource.type === "game.character-match")).length;
      return `<button type="button" data-load-playlist="${entry.id}"><span class="playlist-menu-copy"><span>${isEmbeddedDefault(entry) ? "官方播放器（只读）" : `${escapeHtml(entry.document.name)}${entry.document.mode === "incremental" ? "（增量）" : ""}`}</span><small>${pluginCount} 个插件 · ${characterCount} 个角色包${isEmbeddedDefault(entry) ? " · 随游戏更新" : ""}</small></span></button>`;
    }).join("");
    const managerRows = this.playlists.map((entry) => `<div class="playlist-manager-row" data-manage-playlist="${entry.id}"><input type="text" data-playlist-rename-input="${entry.id}" aria-label="播放集名称：${escapeHtml(entry.document.name)}" maxlength="80" value="${escapeHtml(entry.document.name)}"><div class="playlist-manager-actions"><button type="button" data-copy-playlist="${entry.id}" aria-label="复制${escapeHtml(entry.document.name)}" title="复制">${PLAYLIST_ICONS.copy}</button><button type="button" data-export-playlist="${entry.id}" aria-label="导出${escapeHtml(entry.document.name)}" title="导出">${PLAYLIST_ICONS.export}</button><button type="button" class="playlist-delete" data-delete-playlist="${entry.id}" aria-label="删除${escapeHtml(entry.document.name)}" ${isEmbeddedDefault(entry) ? 'disabled title="官方播放集随游戏更新，不能删除"' : 'title="删除"'}>${PLAYLIST_ICONS.delete}</button></div><p class="playlist-row-error" role="status"></p></div>`).join("");
    const textDocument = this.textExport?.document;
    const playlistTools = this.controller.contentSource === "repository" ? `<section class="playlist-tools"><div class="playlist-toolbar"><div class="playlist-name-field"><button type="button" class="playlist-name-arrow" data-toggle-playlist-menu aria-label="展开播放集列表" aria-expanded="${this.playlistMenuOpen}"><span aria-hidden="true">${this.playlistMenuOpen ? "▾" : "▸"}</span></button><span class="playlist-current-name" ${isEmbeddedDefault(currentPlaylist) ? "data-embedded-default-playlist" : ""}>${currentPlaylistLabel}</span></div><button type="button" class="playlist-icon" data-open-playlist-manager aria-label="管理播放集" title="管理">⚙</button><button type="button" class="playlist-icon" data-open-playlist-import aria-label="导入播放集" title="导入">${PLAYLIST_ICONS.import}</button></div><div class="playlist-menu" ${this.playlistMenuOpen ? "" : "hidden"}>${playlistItems || `<p>还没有保存的播放集。</p>`}</div><p class="playlist-status" role="status">${escapeHtml(this.playlistMessage)}</p></section>` : "";
    const playlistDialogs = this.controller.contentSource === "repository" ? `<dialog class="modal playlist-manager-dialog" data-playlist-manager aria-label="管理播放集"><button type="button" class="modal-close" data-close-playlist-manager aria-label="关闭管理">×</button><h2>管理播放集</h2><p class="playlist-default-help">官方播放集只读，随游戏更新。修改时会先创建副本；旧播放集保留原有选择。</p><div class="playlist-manager-list">${managerRows || `<p>还没有保存的播放集。</p>`}</div></dialog><dialog class="modal playlist-import-dialog" data-playlist-import aria-label="导入播放集"><button type="button" class="modal-close" data-close-playlist-import aria-label="关闭导入">×</button><h2>导入播放集</h2><label class="secondary-button playlist-file-label">选择 JSON、hocpkg、PNG 或 ZIP<input type="file" data-playlist-file  hidden></label><label class="playlist-paste-label">粘贴播放集 JSON<textarea data-playlist-paste rows="7" spellcheck="false"></textarea></label><button type="button" class="primary-button" data-import-playlist-text>导入文本</button><p data-playlist-import-status role="status">${escapeHtml(this.playlistImportMessage)}</p></dialog><dialog class="modal playlist-text-dialog" data-playlist-text-dialog aria-label="播放集纯文本"><button type="button" class="modal-close" data-close-playlist-text aria-label="关闭纯文本">×</button><h2>纯文本播放集</h2><textarea readonly rows="10" data-playlist-export-text>${textDocument ? escapeHtml(playlistJson(textDocument)) : ""}</textarea><div class="playlist-text-actions"><button type="button" class="secondary-button" data-copy-playlist-text>复制 JSON</button><button type="button" class="primary-button" data-download-playlist-text>下载 JSON</button></div></dialog>` : "";

    const hasWebCache = !Capacitor.isNativePlatform() && !supportsCoreUpdates();
    const offlineButton = `<button type="button" class="secondary-button" data-open-offline>缓存管理</button>`;
    const offlineDialog = `<dialog class="modal launcher-settings" data-offline-dialog aria-label="缓存管理"><button type="button" class="modal-close" data-close-offline aria-label="关闭缓存管理">×</button><h2>缓存管理</h2>${hasWebCache ? `<div data-embedded-offline></div>` : `<p role="status">暂无可清理的下载缓存。</p>`}</dialog>`;

    this.root.innerHTML = `<main class="launcher-shell"><nav class="launcher-tools" aria-label="启动器工具"><button type="button" class="icon-button launcher-tool" data-open-launcher-settings aria-label="设置" title="设置" ${this.busy ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 3-.6 2.2-1.8 1-2.2-.5-2.5 4.3 1.6 1.6v2L2.4 15l2.5 4.3 2.2-.5 1.8 1 .6 2.2h5l.6-2.2 1.8-1 2.2.5 2.5-4.3-1.6-1.4v-2l1.6-1.6-2.5-4.3-2.2.5-1.8-1L14.5 3z"/><circle cx="12" cy="12.5" r="3.2"/></svg></button><button type="button" class="icon-button launcher-tool" data-check-core-update aria-label="应用更新" title="应用更新" ${this.busy ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1a8 8 0 0 1 13.2 3.4M4.7 14.5a8 8 0 0 0 13.2 3.4"/></svg></button></nav><section class="launcher-hero"><p class="eyebrow">House of Chances</p><h1>内容管理器</h1><p class="launcher-description">知者不言，言者不知。<br>玩腻了？HoC是一个开放的社区项目，随意导入角色包或插件以定义你自己的HoC游戏体验！</p><p class="launcher-release" data-core-release aria-label="Core 版本与版本批注"><span>Core v${escapeHtml(version)}</span><strong>${escapeHtml(releaseName)}</strong></p></section><section class="launcher-actions"><button type="button" class="primary-button launcher-start" data-start-game ${!startable || this.busy ? "disabled" : ""}>开始游戏</button><button type="button" class="secondary-button" data-open-packages ${this.busy ? "disabled" : ""}>资源管理</button>${warnings}<p class="launcher-status ${error ? "is-error" : ""}" data-launcher-status role="status">${escapeHtml(message)}</p></section><dialog class="package-drawer" data-package-drawer aria-labelledby="package-drawer-title"><header><div><p class="eyebrow">Content Vault</p><h2 id="package-drawer-title">资源管理</h2></div><button type="button" class="modal-close" data-close-packages aria-label="关闭资源管理">×</button></header>${playlistTools}${this.controller.contentSource === "repository" ? `<div class="package-import-tools"><div class="package-transfer-actions"><label class="secondary-button">导入资源/资源包<input type="file" data-import-file  hidden ${this.busy ? "disabled" : ""}></label><button type="button" class="secondary-button" disabled>社区工坊</button><button type="button" class="secondary-button" data-password-book ${this.busy ? "disabled" : ""}>密码本</button></div><p class="package-import-result" role="status">${escapeHtml(this.transferMessage)}</p></div>` : ""}<section class="package-list">${packageCards || `<p class="empty-package-list">内容仓库暂时不可用。</p>`}</section><button type="button" class="secondary-button package-retry" data-retry-packages>重新检查</button></dialog>${playlistDialogs}${this.renderSettings(offlineButton)}${offlineDialog}${this.renderImportDialog()}</main>`;
    this.dialogRestorations = continuedDialogs;
    try {
      this.wire();
      void this.coreUpdater.check(false, () => !this.busy && Boolean(this.root.querySelector(".launcher-shell")) && !document.querySelector("dialog[open]"));
      if (this.settingsOpen) this.root.querySelector<HTMLButtonElement>("[data-open-launcher-settings]")?.click();
      if (this.packageManagerOpen) this.openPackageManager();
      if (this.managerOpen) this.openLauncherDialog("[data-playlist-manager]");
      if (this.importOpen) this.openLauncherDialog("[data-playlist-import]");
      if (this.textExport) this.openLauncherDialog("[data-playlist-text-dialog]");
      if (this.activeImportId || (this.busy && this.importStep === "progress")) this.openLauncherDialog("[data-import-dialog]");
      if (continuedDialogs.has("[data-offline-dialog]")) this.root.querySelector<HTMLButtonElement>("[data-open-offline]")?.click();
      const list = this.root.querySelector<HTMLElement>(".package-list");
      if (list) list.scrollTop = this.listScrollTop;
    } finally { this.dialogRestorations = undefined; }
  }

  private async archiveAction(id: string, remove: boolean): Promise<void> {
    if (this.busy) return;
    if (remove && !await confirmGameDialog("删除归档", "永久删除这份历史归档？当前内嵌内容、存档和播放集会保留。", "删除归档")) return;
    this.busy = true;
    try { if (remove) await this.controller.removeArchivedPackage(id); else await this.controller.exportArchivedPackage(id); await this.refresh(); }
    catch (error) { this.transferMessage = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.render(); }
  }

  private openPackageManager(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>("[data-package-drawer]");
    if (!dialog) return;
    this.packageManagerOpen = true;
    this.openLauncherDialog("[data-package-drawer]");
  }

  private renderSettings(offlineButton: string): string {
    const channel = this.coreUpdater.getChannel();
    const policy = this.coreUpdater.getAutoDownload();
    return `<dialog class="modal launcher-settings" data-launcher-settings aria-labelledby="launcher-settings-title"><button type="button" class="modal-close" data-close-launcher-settings aria-label="关闭启动器设置">×</button><h2 id="launcher-settings-title">启动器设置</h2><section class="launcher-settings-section" aria-labelledby="launcher-update-title"><h3 id="launcher-update-title">应用更新</h3><label for="core-update-channel">更新通道</label><select id="core-update-channel" data-core-update-channel><option value="stable" ${channel === "stable" ? "selected" : ""}>稳定版（默认）</option><option value="latest" ${channel === "latest" ? "selected" : ""}>最新版（含预发布版）</option></select><label for="core-auto-download">自动下载新版本</label><select id="core-auto-download" data-core-auto-download><option value="always" ${policy === "always" ? "selected" : ""}>始终</option><option value="wifi" ${policy === "wifi" ? "selected" : ""}>仅 WIFI（默认）</option><option value="never" ${policy === "never" ? "selected" : ""}>从不</option></select><div class="game-dialog-actions"><button type="button" class="secondary-button" data-update-action="check">手动检查更新</button><button type="button" class="secondary-button" data-update-action="download">手动下载更新</button><button type="button" class="primary-button" data-update-action="install">手动更新</button></div><p class="status-line" data-launcher-settings-status role="status" aria-live="polite"></p></section><section class="launcher-settings-section" aria-labelledby="launcher-privacy-title"><h3 id="launcher-privacy-title">隐私与资源</h3>${telemetrySettingsMarkup()}${offlineButton}</section>${launcherSaveMarkup()}</dialog>`;
  }

  private wire(): void {
    this.disposeOffline?.();
    this.disposeSettings?.();
    this.root.querySelector("[data-open-launcher-settings]")?.addEventListener("click", () => {
      this.settingsOpen = true;
      const dialog = this.root.querySelector<HTMLDialogElement>("[data-launcher-settings]");
      if (dialog) {
        this.disposeSettings?.();
        const disposeTelemetry = mountTelemetryControls(dialog);
        const disposeSaves = mountLauncherSaveControls(dialog);
        this.disposeSettings = () => { disposeTelemetry(); disposeSaves(); };
        this.openLauncherDialog("[data-launcher-settings]");
      }
    });
    this.root.querySelector("[data-close-launcher-settings]")?.addEventListener("click", () => void closeUiDialog(this.root.querySelector<HTMLDialogElement>("[data-launcher-settings]")));
    this.root.querySelector<HTMLDialogElement>("[data-launcher-settings]")?.addEventListener("close", () => { this.settingsOpen = false; this.disposeSettings?.(); this.disposeSettings = undefined; });
    this.root.querySelector<HTMLSelectElement>("[data-core-update-channel]")?.addEventListener("change", event => {
      const channel = (event.currentTarget as HTMLSelectElement).value as UpdateChannel;
      const saved = this.coreUpdater.setChannel(channel);
      const status = this.root.querySelector<HTMLElement>("[data-launcher-settings-status]");
      if (status) status.textContent = saved ? "更新通道已保存，下次检查生效。" : "更新通道已切换，但本机存储不可用，仅本次启动有效。";
    });
    this.root.querySelector<HTMLSelectElement>("[data-core-auto-download]")?.addEventListener("change", event => {
      const saved = this.coreUpdater.setAutoDownload((event.target as HTMLSelectElement).value as AutoDownload);
      const status = this.root.querySelector<HTMLElement>("[data-launcher-settings-status]");
      if (status) status.textContent = saved ? "自动下载设置已保存。" : "设置已切换，本机存储不可用，仅本次启动有效。";
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-check-core-update], [data-update-action]").forEach(button => button.addEventListener("click", async () => {
      const buttons = this.root.querySelectorAll<HTMLButtonElement>("[data-check-core-update], [data-update-action]");
      buttons.forEach(item => { item.disabled = true; item.setAttribute("aria-busy", "true"); });
      const status = this.root.querySelector<HTMLElement>("[data-launcher-settings-status]");
      if (status) status.textContent = "正在处理更新，请稍候……";
      try {
        if (supportsCoreUpdates()) {
          if (button.dataset.updateAction === "download") await this.coreUpdater.download();
          else if (button.dataset.updateAction === "install") await this.coreUpdater.install();
          else await this.coreUpdater.check(true);
        } else await chooseGameDialog("应用更新", "网页版本随网站更新。", [{ value: "ok", label: "知道了", style: "primary" }]);
      } finally {
        buttons.forEach(item => { item.disabled = false; item.removeAttribute("aria-busy"); });
        if (status) status.textContent = "";
      }
    }));
    this.root.querySelector('[data-open-offline]')?.addEventListener('click', () => {
      this.disposeOffline?.();
      this.disposeOffline = mountEmbeddedOfflineControls(this.root.querySelector('[data-embedded-offline]'));
      this.openLauncherDialog('[data-offline-dialog]');
    });
    this.root.querySelector('[data-close-offline]')?.addEventListener('click', () => void closeUiDialog(this.root.querySelector<HTMLDialogElement>('[data-offline-dialog]')));
    this.root.querySelectorAll<HTMLElement>('[data-export-archive]').forEach(button => button.addEventListener('click', () => void this.archiveAction(button.dataset.exportArchive!, false)));
    this.root.querySelectorAll<HTMLElement>('[data-remove-archive]').forEach(button => button.addEventListener('click', () => void this.archiveAction(button.dataset.removeArchive!, true)));
    this.root.querySelector<HTMLDialogElement>("[data-package-drawer]")?.addEventListener("close", () => {
      this.packageManagerOpen = false;
    });
    this.root.querySelector<HTMLButtonElement>("[data-start-game]")?.addEventListener("click", () => void this.startGame());
    this.root.querySelector<HTMLButtonElement>("[data-open-packages]")?.addEventListener("click", () => {
      this.openPackageManager();
    });
    this.root.querySelector<HTMLButtonElement>("[data-close-packages]")?.addEventListener("click", () => {
      this.packageManagerOpen = false;
      void closeUiDialog(this.root.querySelector<HTMLDialogElement>("[data-package-drawer]"));
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
    const packageDialog = this.root.querySelector<HTMLDialogElement>("[data-package-drawer]");
    if (packageDialog && !this.busy) this.disposePluginDrag = mountPluginOrderDrag(packageDialog, this.orderedInstalledPlugins(), order => void this.savePluginOrder(order));
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
      this.openLauncherDialog("[data-playlist-manager]");
    });
    this.root.querySelector<HTMLButtonElement>("[data-close-playlist-manager]")?.addEventListener("click", () => this.closePlaylistDialog("manager"));
    this.root.querySelector<HTMLButtonElement>("[data-open-playlist-import]")?.addEventListener("click", () => {
      this.importOpen = true;
      this.openLauncherDialog("[data-playlist-import]");
    });
    this.root.querySelector<HTMLButtonElement>("[data-close-playlist-import]")?.addEventListener("click", () => this.closePlaylistDialog("import"));
    this.root.querySelector<HTMLButtonElement>("[data-close-playlist-text]")?.addEventListener("click", () => this.closePlaylistDialog("text"));
    this.root.querySelector<HTMLButtonElement>("[data-password-book]")?.addEventListener("click", () => managePasswordBook(new PasswordBook(localStorage)));
    this.root.querySelector<HTMLButtonElement>("[data-import-playlist-text]")?.addEventListener("click", () => void this.importPlaylistText());
    this.root.querySelector<HTMLInputElement>("[data-playlist-file]")?.addEventListener("click", (event) => {
      if (!this.controller.hasImportPicker) return;
      event.preventDefault();
      void this.importPlaylistFile();
    });
    this.root.querySelector<HTMLInputElement>("[data-playlist-file]")?.addEventListener("change", (event) => void this.importPlaylistFile(event.currentTarget as HTMLInputElement));
    this.root.querySelectorAll<HTMLInputElement>("[data-playlist-rename-input]").forEach((input) => {
      input.addEventListener("change", () => void this.renamePlaylistInline(input));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          input.blur();
        }
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
        else this.textExport = null;
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
    const body = this.importStep === "select" ? `${cards}${damaged}` : this.importStep === "playlist" ? `<p>是否启用包中附带的播放集？所选播放集都会保存。</p><select data-import-playlist-choice aria-label="选择导入的播放集">${playlists.map((item) => `<option value="${item.id}" ${item.id === this.importPlaylistChoice ? "selected" : ""}>${escapeHtml(item.title ?? item.source)}</option>`).join("")}</select>` : this.importStep === "error" ? `<p>${escapeHtml(this.importError)}</p>` : loadingIndicatorMarkup(this.currentImportProgress());
    const actions = this.importStep === "select" ? `<button type="button" class="secondary-button" data-import-cancel>放弃</button><button type="button" class="primary-button" data-import-next ${this.selectedImportIds.size ? "" : "disabled"}>安装所选包（${this.selectedImportIds.size}）</button>`
      : this.importStep === "playlist" ? `<button type="button" class="secondary-button" data-import-skip-playlist>放弃</button><button type="button" class="primary-button" data-import-activate>启用</button>`
        : this.importStep === "error" ? `<button type="button" class="secondary-button" data-import-close>关闭</button><button type="button" class="primary-button" data-import-retry>重试</button>` : `<button type="button" class="hoc-loading-action" data-import-cancel ${this.importCommitting || this.importAbort?.signal.aborted ? "disabled" : ""}>取消</button>`;
    return `<dialog class="import-review-dialog${this.importStep === "progress" ? " is-loading" : ""}" data-import-dialog aria-label="导入内容包"><header><h2>导入内容包</h2><button type="button" class="modal-close" data-import-close aria-label="关闭导入窗口" ${this.importStep === "progress" ? "disabled" : ""}>×</button></header><div class="import-review-body" data-import-body>${body}</div><footer>${actions}</footer></dialog>`;
  }

  private beginImportOperation(label: string): void {
    this.busy = true;
    this.transferMessage = "";
    this.importStep = "progress";
    this.importCommitting = false;
    this.importAbort = new AbortController();
    this.importLastProgress = Date.now();
    this.importLastRender = 0;
    this.importProgress = { label };
    clearInterval(this.importWatchdog);
    this.importWatchdog = setInterval(() => {
      this.paintImportProgress();
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
    if (this.importAbort?.signal.aborted || this.importCommitting) return;
    const label = { extracting: "读取资源包", verifying: "校验资源", copying: "写入资源", committing: "保存中", unlocking: "解锁资源包" }[progress.phase];
    // Low-level IO totals describe a file (or are unknown), not the whole import.
    this.reportImportProgress(label === "写入资源" && this.importProgress.label === label
      ? this.importProgress : { label });
  };

  private updateInstallProgress = (progress: ContentInstallProgress): void => {
    if (this.importAbort?.signal.aborted || this.importCommitting) return;
    this.reportImportProgress({ label: "写入资源", completed: progress.completedBytes, total: progress.totalBytes });
  };

  private reportImportProgress(state: LoadingIndicatorState): void {
    const previousLabel = this.importProgress.label;
    const wasStalled = this.currentImportProgress().stalled;
    this.importProgress = state;
    this.importLastProgress = Date.now();
    const complete = state.total !== undefined && state.total > 0 && state.completed === state.total;
    if (!wasStalled && previousLabel === state.label && this.importLastProgress - this.importLastRender < 100 && !complete) return;
    this.importLastRender = this.importLastProgress;
    this.paintImportProgress();
  }

  private currentImportProgress(): LoadingIndicatorState {
    return { ...this.importProgress, stalled: !this.importAbort?.signal.aborted && Date.now() - this.importLastProgress >= 30000 };
  }

  private paintImportProgress(): void {
    const body = this.root.querySelector<HTMLElement>("[data-import-body]");
    if (body && this.importStep === "progress") updateLoadingIndicator(body, this.currentImportProgress());
  }

  private beginImportCommit(label = "保存中"): void {
    this.importCommitting = true;
    this.reportImportProgress({ label });
    const cancel = this.root.querySelector<HTMLButtonElement>("[data-import-dialog] [data-import-cancel]");
    if (cancel) cancel.disabled = true;
  }

  private async stageImport(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = "";
    if (file) await this.stageImportFile(file);
  }

  private async stageImportFile(input?: File | ContentImportFile): Promise<void> {
    if (this.busy) return;
    this.beginImportOperation("读取资源包");
    let file: File | ContentImportFile | null = null;
    try {
      const options = { signal: this.importAbort!.signal, onProgress: this.updateImportProgress };
      file = input ?? await this.controller.pickPackageFile(options);
      if (!file) { this.importStep = "select"; return; }
      const book = new PasswordBook(localStorage);
      let passwords: string[] = [];
      try { passwords = book.list(); } catch { /* An unreadable book does not block manual unlock. */ }
      const session = await this.controller.stagePackageFile(file, { ...options, passwords: importPasswordCandidates(passwords),
        requestPassword: async request => {
          try { return await requestImportPassword(request, options.signal); }
          catch (error) { if (error instanceof DOMException && error.name === "AbortError") this.importAbort?.abort(); throw error; }
        },
        rememberPassword: password => {
          try { book.add(password); }
          catch { this.playlistMessage = "本次解锁成功，但密码本保存失败，请在密码本中重试。"; }
        }
      });
      this.activeImportId = session.id;
      this.selectedImportIds.clear();
      this.releaseImportPreviews();
      const byPackage = new Map<string, typeof session.candidates[number]>();
      for (const candidate of session.candidates) {
        options.signal.throwIfAborted();
        if (candidate.error) continue;
        if (candidate.kind === "playlist") this.selectedImportIds.add(candidate.id);
        else {
          if (!candidate.packageId) continue;
          const previous = byPackage.get(candidate.packageId);
          if (!previous || compareHocpkgVersions(candidate.version!, previous.version!) > 0) byPackage.set(candidate.packageId, candidate);
        }
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
    finally {
      if (file) await this.controller.releaseImportFile(file).catch(() => undefined);
      this.endImportOperation();
    }
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
    this.beginImportOperation("写入资源");
    try {
      const packages = session.candidates.filter((item) => item.kind === "package" && this.selectedImportIds.has(item.id) && !this.importedPackageIds.has(item.id));
      if (packages.length) {
        await this.controller.installStagedPackages(session.id, packages.map((item) => item.id), this.updateInstallProgress,
          { signal: this.importAbort!.signal, onIoProgress: this.updateImportProgress, onCommit: () => this.beginImportCommit() });
        packages.forEach((item) => this.importedPackageIds.add(item.id));
      }
      this.importAbort?.signal.throwIfAborted();
      this.beginImportCommit();
      const selectedPlaylists = session.candidates.filter((item) => item.kind === "playlist" && this.selectedImportIds.has(item.id));
      if (selectedPlaylists.length && !this.savedImportPlaylists.length) {
        this.beginImportCommit("保存播放集");
        const documents: PlaylistDocument[] = [];
        for (const item of selectedPlaylists) documents.push(await this.controller.readStagedPlaylist(session.id, item.id));
        this.savedImportPlaylists = await this.controller.importStagedPlaylists(documents);
      }
      if (activate && selectedPlaylists.length) {
        this.beginImportCommit("载入播放集");
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
        this.importProgress = { label: "正在取消" };
        this.paintImportProgress();
        const cancel = this.root.querySelector<HTMLButtonElement>("[data-import-dialog] [data-import-cancel]");
        if (cancel) cancel.disabled = true;
      }
      return;
    }
    if (!this.activeImportId) return;
    const id = this.activeImportId;
    await closeUiDialog(this.root.querySelector<HTMLDialogElement>("[data-import-dialog]"));
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
    else this.textExport = null;
    void closeUiDialog(this.root.querySelector<HTMLDialogElement>(selector));
  }

  private playlistOutcome(missing: readonly string[], versionMismatch: readonly string[]): string {
    const notes = [missing.length ? `缺失：${missing.join("、")}` : "", versionMismatch.length ? `版本不同：${versionMismatch.join("、")}` : ""].filter(Boolean);
    return notes.length ? `已加载。${notes.join("；")}。` : "播放集已加载。";
  }

  private confirmOfficialPlaylistEdit(id = this.selectedPlaylistId): Promise<boolean> {
    if (id !== EMBEDDED_DEFAULT_PLAYLIST_ID) return Promise.resolve(true);
    return confirmGameDialog("创建播放集副本", "官方播放集为只读。将创建并切换到副本，再应用修改；官方播放集会继续随游戏更新。", "创建副本并修改");
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

  private async importPlaylistFile(input?: HTMLInputElement): Promise<void> {
    if (this.busy) return;
    const selected = input?.files?.[0];
    if (input) input.value = "";
    this.playlistImportMessage = "";
    this.beginImportOperation("读取播放集");
    let file: File | ContentImportFile | null = null;
    let importBundle = false;
    try {
      const options = { signal: this.importAbort!.signal, onProgress: this.updateImportProgress };
      file = selected ?? await this.controller.pickPackageFile(options);
      if (!file) return;
      try {
        const result = await this.controller.importPlaylistFile(file, { ...options, onCommit: () => this.beginImportCommit("保存播放集") });
        this.selectedPlaylistId = await this.controller.currentPlaylistId();
        this.importOpen = false;
        this.playlistMessage = this.playlistOutcome(result.missing, result.versionMismatch);
        await this.refresh();
      } catch (error) {
        options.signal.throwIfAborted();
        if (!(error instanceof PlaylistArchiveError)) throw error;
        const choice = await chooseGameDialog("导入整合包", "检测到您导入的内容不是播放集，但可能是一个整合包。是否要导入整合包", [
          { value: "yes", label: "是", style: "primary" },
          { value: "no", label: "否" }
        ]);
        options.signal.throwIfAborted();
        if (choice === "yes") { this.importOpen = false; importBundle = true; }
      }
    } catch (error) {
      this.playlistImportMessage = this.importAbort?.signal.aborted ? "导入已取消。" : error instanceof Error ? error.message : String(error);
    } finally {
      if (!importBundle && file) await this.controller.releaseImportFile(file).catch(() => undefined);
      this.endImportOperation();
    }
    // The same picker-owned input remains alive until the archive importer has finished.
    if (importBundle && file) await this.stageImportFile(file);
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
      this.playlistImportMessage = error instanceof Error ? error.message : String(error);
    } finally { this.busy = false; this.render(); }
  }

  private async renamePlaylistInline(input: HTMLInputElement): Promise<void> {
    if (this.busy) return;
    const id = input.dataset.playlistRenameInput ?? "";
    const saved = this.playlists.find((entry) => entry.id === id);
    if (!saved || input.value.trim() === saved.document.name) return;
    const value = input.value, previousSelection = this.selectedPlaylistId;
    let failure: string | undefined;
    this.busy = true;
    input.disabled = true;
    try {
      if (!await this.confirmOfficialPlaylistEdit(id)) return;
      await this.controller.renamePlaylist(id, value);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      await this.refresh();
      if (failure) {
        const targetId = id === EMBEDDED_DEFAULT_PLAYLIST_ID && this.selectedPlaylistId !== previousSelection ? this.selectedPlaylistId : id;
        const row = this.root.querySelector<HTMLElement>(`[data-manage-playlist="${targetId}"]`);
        const status = row?.querySelector<HTMLElement>(".playlist-row-error");
        if (status) status.textContent = failure;
        const retry = row?.querySelector<HTMLInputElement>("[data-playlist-rename-input]");
        if (retry) { retry.value = value; retry.focus(); }
      }
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
    let mode: PlaylistMode = saved.document.mode ?? "replace";
    const format = await chooseGameDialog("导出播放集", saved.document.name, [
      { value: "hocpkg", label: "导出 hocpkg", style: "primary" },
      { value: "png", label: "导出 PNG" },
      { value: "text", label: "纯文本 JSON" }
    ], { checkbox: {
      label: "作为增量集导出（保留其他包的开关状态）",
      checked: mode === "incremental",
      onChange: checked => { mode = checked ? "incremental" : "replace"; }
    } });
    if (!format) return;
    const exported = { ...saved, document: playlistDocument(saved.document.name, saved.document.packages, saved.document.pluginOrder, mode, saved.document.coverImage) };
    if (format === "text") { this.textExport = exported; this.render(); return; }
    try { await this.controller.exportPlaylist(exported, format); this.playlistMessage = "播放集已导出。"; this.render(); }
    catch (error) { this.playlistMessage = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async copyPlaylistText(): Promise<void> {
    const saved = this.textExport;
    if (!saved) return;
    try { await navigator.clipboard.writeText(playlistJson(saved.document)); this.playlistMessage = "JSON 已复制。"; }
    catch { this.playlistMessage = "复制失败，可选中上方文本手动复制。"; }
    const status = this.root.querySelector<HTMLElement>(".playlist-status");
    if (status) status.textContent = this.playlistMessage;
  }

  private async downloadPlaylistText(): Promise<void> {
    const saved = this.textExport;
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
      if (!await this.confirmOfficialPlaylistEdit()) { this.busy = false; this.render(); return; }
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

  private async startGame(): Promise<void> {
    if (this.busy) return;
    for (;;) {
      this.disposePluginDrag?.();
      this.disposePluginDrag = undefined;
      this.busy = true;
      this.disposeSettings?.(); this.disposeSettings = undefined;
      this.disposeOffline?.(); this.disposeOffline = undefined;
      this.showLauncherLoading("校验资源");
      try {
        if (!await this.controller.startGame(this.root)) {
          this.busy = false;
          this.packageManagerOpen = true;
          await this.refresh();
          return;
        }
        this.releasePackages();
        this.packages = [];
        return;
      } catch (error) {
        this.busy = false;
        await this.refresh();
        const failure = getContentStartupFailure(error);
        const canDisable = this.controller.contentSource === "repository" && failure
          && this.packages.some(entry => entry.packageId === failure.packageId && entry.enabled);
        const action = await showStartupErrorDialog(error, {
          onDisableAndRetry: canDisable ? async () => {
            if (!await this.confirmOfficialPlaylistEdit()) return false;
            await this.controller.disableStartupFailure(error);
          } : undefined
        });
        if (action === "retry") continue;
        if (action === "manage") {
          this.packageManagerOpen = true;
          this.render();
        } else this.root.querySelector<HTMLButtonElement>("[data-start-game]")?.focus();
        return;
      }
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
      if (!await this.confirmOfficialPlaylistEdit()) { this.busy = false; this.render(); return; }
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
