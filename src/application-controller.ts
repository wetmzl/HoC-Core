import {
  ContentPackageManager,
  EmbeddedContentSource,
  RepositoryContentSource,
  activateContentRuntime,
  deactivateContentRuntime,
  loadContent,
  loadPackagePresentation,
  prepareContentRuntime,
  releasePackagePresentation,
  type EmbeddedContentSourceOptions,
  type LoadedContent,
  type ManagedContentPackage
} from "./content/packages";
import { createDefaultContentHostProviders } from "./content/storage/host-factory";
import { FileContentRepository } from "./content/storage/repository";
import { CONTENT_PERSISTENCE_REFUSED_WARNING, resolveContentHost, type ContentHostProvider, type ContentInstallProgress, type ContentInstallOptions, type ContentImportFile, type ContentOperationOptions, type ContentFileSystem, type ContentAssetResolver } from "./content/storage/contracts";
import { installDialogueEvents, clearDialogueEvents } from "./dialogue/events";
import { installDialogueRegistry, clearDialogueRegistry } from "./dialogue/registry";
import { loadPluginModules, type LoadedPluginModules } from "./content/packages/plugin-modules";
import { CORE_PACKAGE_AUTHOR_ID } from "./content/packages/builtin-authors";
import { mergeSkillArchetypeArt } from "./resources/skill-archetype-art";
import { HocpkgTransfer, type ImportOutcome, type ImportSession } from "./content/transfer/hocpkg";
import { PlaylistStore, playlistDocument, type PlaylistDocument, type SavedPlaylist } from "./content/playlists/store";
import { decodePlaylistBytes, decodePlaylistFile, encodePlaylistHocpkg, encodePlaylistPng, playlistJson } from "./content/playlists/transfer";
import { createSaveFileWriter } from "./persistence/file-exchange";
import type { GameRuntimeHandle, MountGameRuntimeOptions } from "./app";
import { createPersistenceService } from "./persistence/factory";
import { PluginSettingsSession } from "./content/packages/plugin-settings";
import { collectPluginCredits } from "./content/packages/plugin-credits";
import { ensureLongTermSaveReady } from "./persistence/long-term-recovery";
import { releaseImportFile, type ImportFile } from "./content/storage/import-file";
import { checkCancelled } from "./content/storage/file-operations";
import { canonicalBuiltinPackageId } from "./content/packages/builtin-authors";
import { EMBEDDED_MEDIA_CACHE, preserveEmbeddedCache } from "./resources/embedded-offline";
import { Capacitor } from "@capacitor/core";

export type ApplicationControllerState = "idle" | "starting" | "running" | "stopping";

export class ApplicationControllerBusyError extends Error {
  constructor(readonly state: ApplicationControllerState) {
    super(`应用当前处于 ${state} 状态，不能修改内容包。`);
    this.name = "ApplicationControllerBusyError";
  }
}

export interface ApplicationControllerOptions {
  readonly providers?: readonly ContentHostProvider[];
  readonly embedded?: EmbeddedContentSourceOptions;
  readonly mountRuntime?: (options: MountGameRuntimeOptions) => Promise<GameRuntimeHandle>;
  readonly onProgress?: (progress: { readonly phase: "seeding" | "verifying" } & ContentInstallProgress) => void;
  readonly acknowledgeThirdPartyContent?: (root: HTMLDivElement) => Promise<boolean>;
  readonly onRuntimeStopped?: () => void | Promise<void>;
  /** Explicit test harness mode; production never enables this storage bypass. */
  readonly readOnlyEmbedded?: boolean;
  readonly resolveEmbeddedConflicts?: (packageIds: readonly string[]) => Promise<boolean>;
}

export class ApplicationController {
  private currentState: ApplicationControllerState = "idle";
  private readonly embedded: EmbeddedContentSource;
  private repository?: FileContentRepository;
  private manager?: ContentPackageManager;
  private transfer?: HocpkgTransfer;
  private fileSystem?: ContentFileSystem;
  private assetResolver?: ContentAssetResolver;
  private playlists?: PlaylistStore;
  private contentInitialized = false;
  private runtime?: GameRuntimeHandle;
  private loadedContent?: LoadedContent;
  private loadedPlugins?: LoadedPluginModules;
  private idleOperationRunning = false;
  private embeddedOnly = false;
  private readonly startupWarnings = new Set<string>();

  constructor(private readonly options: ApplicationControllerOptions = {}) {
    this.embedded = new EmbeddedContentSource(options.embedded);
  }

  get state(): ApplicationControllerState { return this.currentState; }
  get contentSource(): "repository" | "embedded" { return this.embeddedOnly ? "embedded" : "repository"; }
  get warnings(): readonly string[] { return [...this.startupWarnings]; }

  async initialize(): Promise<void> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); }
    finally { this.idleOperationRunning = false; }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.options.readOnlyEmbedded) {
      this.embeddedOnly = true;
      return;
    }
    if (this.contentInitialized) return;
    const host = await resolveContentHost(this.options.providers ?? createDefaultContentHostProviders());
    if (!host) throw new Error("当前宿主没有可用的持久化内容目录。");
    this.embedded.assetSource = host.fileSystem.assetSource?.bind(host.fileSystem);
    const repository = new FileContentRepository(host);
    await repository.open();
    this.embedded.assetFallback = async (packageId, file, url) => {
      if (Capacitor.isNativePlatform()) return undefined;
      try { if (typeof caches !== "undefined" && await caches.match(url, { cacheName: EMBEDDED_MEDIA_CACHE })) return undefined; } catch { /* Reuse archived bytes if the browser cache is unavailable. */ }
      return repository.resolveArchivedAsset(packageId, file);
    };
    const persistent = await host.capabilities.requestPersistence?.();
    if (persistent === false) this.startupWarnings.add(CONTENT_PERSISTENCE_REFUSED_WARNING);
    const priorPlaylists = new PlaylistStore(host.fileSystem, await repository.listPluginOrder());
    const selectedId = await priorPlaylists.currentId();
    const selected = (await priorPlaylists.list()).find(entry => entry.id === selectedId);
    const index = await this.embedded.loadIndex();
    await repository.configureEmbedded(await this.embedded.packages(), selected ? new Set(selected.document.packages.map(entry => entry.packageId)) : undefined, index.defaultEnabled ? new Set(index.defaultEnabled) : undefined);
    this.repository = repository;
    await this.resolveStoredConflicts();
    this.manager = new ContentPackageManager(repository, this.embedded);
    this.fileSystem = host.fileSystem;
    this.assetResolver = host.assetResolver;
    await host.fileSystem.remove("content/v1/import-inputs");
    this.transfer = new HocpkgTransfer(host.fileSystem, repository);
    this.playlists = new PlaylistStore(host.fileSystem, await this.installedPluginOrder());
    const current = await repository.listPackages();
    const entries = await Promise.all(current.filter((entry) => entry.enabled).map(async (entry) => ({ packageId: entry.packageId, version: (await repository.readManifest(entry.packageId).catch(() => undefined))?.identity.version })));
    await this.playlists.initialize(entries, await this.installedPluginOrder());
    // Existing playlists (including missing references and version hints) are preserved verbatim.
    await host.fileSystem.remove("content/v1/imports");
    this.contentInitialized = true;
  }

  private async resolveStoredConflicts(): Promise<void> {
    if (!this.repository) return;
    const conflicts = await this.repository!.listStoredConflicts();
    if (!conflicts.length) return;
    const ids = conflicts.map(entry => entry.packageId);
    const clean = this.options.resolveEmbeddedConflicts ? await this.options.resolveEmbeddedConflicts(ids) : await (async () => {
      const { chooseGameDialog } = await import("./game-dialog");
      return await chooseGameDialog("过时内嵌包", `在用户仓库检测到过时内嵌包，是否清理？\n${ids.join("\n")}\n选择否或关闭弹窗会归档并禁用旧副本；使用当前内嵌内容。`, [
        { value: "clean", label: "是，清理", style: "danger" }, { value: "archive", label: "否，归档禁用", style: "secondary" }
      ]) === "clean";
    })();
    const targets = new Map((await this.embedded.packages()).map(entry => [entry.packageId, entry]));
    for (const conflict of conflicts) {
      try {
        const old = await this.repository!.storedSource(conflict.packageId);
        await preserveEmbeddedCache(old, targets.get(canonicalBuiltinPackageId(conflict.packageId))!);
      } catch (error) {
        if (clean) throw new Error("无法保留已有离线资源；旧副本未清理。请腾出空间重试，或选择归档禁用。", { cause: error });
        this.startupWarnings.add("部分离线缓存未能保存，已保留历史归档中的资源。");
      }
    }
    await this.repository!.resolveEmbeddedConflicts(clean);
  }

  async listArchivedPackages() {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      return await Promise.all((await this.repository?.listArchives() ?? []).map(async entry => {
        try { const source = await this.repository!.archiveSource(entry.id); return { ...entry, title: source.manifest.metadata.title, version: source.manifest.identity.version }; }
        catch { return { ...entry, title: entry.packageId, version: "未知" }; }
      }));
    }
    finally { this.idleOperationRunning = false; }
  }

  async exportArchivedPackage(id: string): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      const source = await this.repository!.archiveSource(id), { zip } = await import("fflate");
      const files: Record<string, Uint8Array> = { "hocpkg-info.json": new TextEncoder().encode(JSON.stringify(source.manifest)) };
      const { sha256 } = await import("./content/storage/encoding");
      for await (const file of source.files()) {
        if (!file.bytes) throw new Error("归档文件不可读。");
        const expected = source.manifest.files.find(entry => entry.path === file.path);
        if (!expected || file.bytes.length !== expected.bytes || await sha256(file.bytes) !== expected.sha256) throw new Error("归档文件校验失败。");
        files[file.path] = file.bytes;
      }
      const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(files, (error, data) => error ? reject(error) : resolve(data)));
      await createSaveFileWriter().write(new Blob([Uint8Array.from(bytes).buffer], { type: "application/zip" }), `${source.packageId.replace("/", "-")}-archived.hocpkg`, "归档内容", { "application/zip": [".hocpkg"] });
    } finally { this.idleOperationRunning = false; }
  }

  async removeArchivedPackage(id: string): Promise<void> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); await this.repository!.removeArchive(id); }
    finally { this.idleOperationRunning = false; }
  }

  async listPackages(): Promise<readonly ManagedContentPackage[]> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (this.embeddedOnly) {
        return Promise.all((await this.embedded.packages()).map(async (entry) => ({
          packageId: entry.packageId,
          state: "enabled" as const,
          manifest: entry.manifest,
          embeddedManifest: entry.manifest,
          bytes: entry.manifest.files.reduce((total, file) => total + file.bytes, 0),
          source: "embedded" as const,
          presentation: await loadPackagePresentation(entry)
        })));
      }
      return await this.manager!.listPackages();
    } finally { this.idleOperationRunning = false; }
  }

  async enablePackage(packageId: string): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (this.embeddedOnly) throw new Error("只读内嵌模式不能修改内容包。");
      await this.manager!.enablePackage(packageId);
      await this.syncCurrentPlaylist();
    } finally { this.idleOperationRunning = false; }
  }

  async setPluginOrder(order: readonly string[]): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (this.embeddedOnly) throw new Error("只读内嵌模式不能修改插件顺序。");
      await this.manager!.setPluginOrder(order);
      await this.syncCurrentPlaylist();
    } finally { this.idleOperationRunning = false; }
  }

  async disablePackage(packageId: string): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (this.embeddedOnly) throw new Error("只读内嵌模式不能修改内容包。");
      await this.manager!.disablePackage(packageId);
      await this.syncCurrentPlaylist();
    } finally { this.idleOperationRunning = false; }
  }

  async removePackage(packageId: string): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (this.embeddedOnly) throw new Error("只读内嵌模式不能修改内容包。");
      await this.manager!.removePackage(packageId);
      await this.syncCurrentPlaylist();
    } finally { this.idleOperationRunning = false; }
  }

  async restoreEmbeddedPackage(packageId: string): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (this.embeddedOnly) throw new Error("只读内嵌模式不能修改内容包。");
      await this.manager!.restoreEmbeddedPackage(packageId, {
        onProgress: (progress) => this.options.onProgress?.({ phase: "seeding", ...progress })
      });
      await this.syncCurrentPlaylist();
    } finally { this.idleOperationRunning = false; }
  }

  async listImportSessions(): Promise<readonly ImportSession[]> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); return this.transfer ? this.transfer.listSessions() : []; }
    finally { this.idleOperationRunning = false; }
  }

  get hasImportPicker(): boolean { return Boolean(this.fileSystem?.pickFile); }

  async pickPackageFile(options?: ContentOperationOptions): Promise<ContentImportFile | null> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); return await this.fileSystem?.pickFile?.(options) ?? null; }
    finally { this.idleOperationRunning = false; }
  }

  async releaseImportFile(file: ImportFile): Promise<void> {
    await releaseImportFile(this.fileSystem, file);
  }

  async stagePackageFile(file: File | ContentImportFile, options?: ContentOperationOptions): Promise<ImportSession> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.transfer) throw new Error("只读模式不能导入内容包。");
      return await this.transfer.stage(file, options);
    } finally { this.idleOperationRunning = false; }
  }

  async installStagedPackages(sessionId: string, candidateIds: readonly string[], onProgress?: (progress: import("./content/storage/contracts").ContentInstallProgress) => void, options?: ContentInstallOptions): Promise<readonly ImportOutcome[]> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.transfer) throw new Error("只读模式不能安装内容包。");
      return await this.transfer.installSelected(sessionId, candidateIds, onProgress, options, () => this.resolveStoredConflicts());
    } finally { this.idleOperationRunning = false; }
  }

  async previewImportCandidate(sessionId: string, candidateId: string) {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.transfer) throw new Error("只读模式不能预览内容包。"); return await this.transfer.preview(sessionId, candidateId, this.assetResolver); }
    finally { this.idleOperationRunning = false; }
  }

  async removeImportSession(sessionId: string): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.transfer) throw new Error("只读模式不能清除暂存包。");
      await this.transfer.removeSession(sessionId);
    } finally { this.idleOperationRunning = false; }
  }

  async readStagedPlaylist(sessionId: string, candidateId: string): Promise<PlaylistDocument> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.transfer) throw new Error("只读模式不能导入播放集。"); return await this.transfer.readPlaylist(sessionId, candidateId); }
    finally { this.idleOperationRunning = false; }
  }

  async consumeStagedPlaylists(sessionId: string, candidateIds: readonly string[]): Promise<void> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.transfer) throw new Error("只读模式不能清除播放集暂存。"); await this.transfer.consumeCandidates(sessionId, candidateIds); }
    finally { this.idleOperationRunning = false; }
  }

  async discardInvalidStagedCandidates(sessionId: string, candidateIds: readonly string[]): Promise<void> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.transfer) throw new Error("只读模式不能清除暂存候选。"); await this.transfer.consumeCandidates(sessionId, candidateIds, "invalid"); }
    finally { this.idleOperationRunning = false; }
  }

  async exportPackage(packageId: string, format: "hocpkg" | "png"): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.transfer) throw new Error("只读模式不能导出内容包。");
      const bytes = format === "png" ? await this.transfer.exportPackagePng(packageId) : await this.transfer.exportPackage(packageId);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const extension = format === "png" ? "png" : "hocpkg";
      await createSaveFileWriter().write(new Blob([buffer], { type: format === "png" ? "image/png" : "application/zip" }),
        `${packageId.replace("/", "-")}.${extension}`, "内容包", { [format === "png" ? "image/png" : "application/zip"]: [`.${extension}`] });
    } finally { this.idleOperationRunning = false; }
  }

  async listPlaylists(): Promise<readonly SavedPlaylist[]> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); return this.playlists?.list() ?? []; }
    finally { this.idleOperationRunning = false; }
  }

  async currentPlaylistId(): Promise<string | null> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); return await this.playlists?.currentId() ?? null; }
    finally { this.idleOperationRunning = false; }
  }

  private async installedPluginOrder(): Promise<string[]> {
    if (!this.manager) return [];
    const packages = await this.manager.listPackages();
    try {
      return packages.filter((entry) => entry.pluginPriority !== undefined && entry.currentRevision)
        .sort((a, b) => a.pluginPriority! - b.pluginPriority!).map((entry) => entry.packageId);
    } finally { for (const entry of packages) releasePackagePresentation(entry.presentation); }
  }

  private async syncCurrentPlaylist(): Promise<void> {
    if (!this.playlists || !this.repository) return;
    const id = await this.playlists.currentId();
    const current = (await this.playlists.list()).find((entry) => entry.id === id);
    if (!current) return;
    const installed = await this.repository.listPackages();
    const ids = new Set(installed.map((entry) => entry.packageId));
    const missing = current.document.packages.filter((entry) => !ids.has(entry.packageId));
    const enabled = await Promise.all(installed.filter((entry) => entry.enabled).map(async (entry) => ({ packageId: entry.packageId, version: (await this.repository!.readManifest(entry.packageId).catch(() => undefined))?.identity.version })));
    await this.playlists.updateCurrent(playlistDocument(current.document.name, [...missing, ...enabled], await this.installedPluginOrder()));
  }

  async selectPlaylist(id: string): Promise<{ readonly missing: readonly string[]; readonly versionMismatch: readonly string[] }> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.manager || !this.playlists) throw new Error("只读模式不能切换播放集。");
      const selected = (await this.playlists.list()).find((entry) => entry.id === id);
      if (!selected) throw new Error("播放集不存在。");
      const result = await this.manager.applyPlaylist(selected.document);
      const ordered = await this.installedPluginOrder();
      await this.manager.setPluginOrder([...selected.document.pluginOrder.filter((item) => ordered.includes(item)), ...ordered.filter((item) => !selected.document.pluginOrder.includes(item))]);
      await this.playlists.select(id);
      return result;
    } finally { this.idleOperationRunning = false; }
  }

  async importPlaylistFile(file: ImportFile, options?: ContentOperationOptions & Pick<ContentInstallOptions, "onCommit">): Promise<{ readonly document: PlaylistDocument; readonly missing: readonly string[]; readonly versionMismatch: readonly string[] }> {
    this.beginIdleOperation();
    let document: PlaylistDocument;
    try {
      await this.ensureInitialized();
      document = await decodePlaylistFile(file, await this.installedPluginOrder(), this.fileSystem, options);
    } finally { this.idleOperationRunning = false; }
    checkCancelled(options);
    options?.onCommit?.();
    const [saved] = await this.importStagedPlaylists([document]);
    return { document: saved!.document, ...await this.selectPlaylist(saved!.id) };
  }

  async importPlaylistText(value: string): Promise<{ readonly document: PlaylistDocument; readonly missing: readonly string[]; readonly versionMismatch: readonly string[] }> {
    await this.ensureInitialized();
    const document = await decodePlaylistBytes(new TextEncoder().encode(value), await this.installedPluginOrder());
    const [saved] = await this.importStagedPlaylists([document]);
    return { document: saved!.document, ...await this.selectPlaylist(saved!.id) };
  }

  async savePlaylist(input: PlaylistDocument): Promise<SavedPlaylist> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.playlists) throw new Error("只读模式不能保存播放集。"); return await this.playlists.save(input); }
    finally { this.idleOperationRunning = false; }
  }

  async importStagedPlaylists(documents: readonly PlaylistDocument[]): Promise<readonly SavedPlaylist[]> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.playlists) throw new Error("只读模式不能保存播放集。"); return await this.playlists.importBatch(documents); }
    finally { this.idleOperationRunning = false; }
  }

  async renamePlaylist(id: string, name: string): Promise<SavedPlaylist> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.playlists) throw new Error("只读模式不能管理播放集。"); return await this.playlists.rename(id, name); }
    finally { this.idleOperationRunning = false; }
  }

  async copyPlaylist(id: string): Promise<SavedPlaylist> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.playlists) throw new Error("只读模式不能管理播放集。"); return await this.playlists.copy(id); }
    finally { this.idleOperationRunning = false; }
  }

  async removePlaylist(id: string): Promise<void> {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.playlists) throw new Error("只读模式不能管理播放集。"); await this.playlists.remove(id); }
    finally { this.idleOperationRunning = false; }
  }

  async exportPlaylist(saved: SavedPlaylist, format: "hocpkg" | "png" | "json"): Promise<void> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      const body = format === "json" ? new TextEncoder().encode(playlistJson(saved.document))
        : format === "hocpkg" ? await encodePlaylistHocpkg(saved.document, saved.id)
          : await encodePlaylistPng(saved.document, saved.id, new Uint8Array(await (await fetch("/assets/playlist-cover.png")).arrayBuffer()));
      const extension = format === "json" ? "json" : format === "png" ? "png" : "hocpkg";
      const mediaType = format === "json" ? "application/json" : format === "png" ? "image/png" : "application/zip";
      const buffer = new ArrayBuffer(body.byteLength);
      new Uint8Array(buffer).set(body);
      await createSaveFileWriter().write(new Blob([buffer], { type: mediaType }), `playlist-${saved.id}.${extension}`, "播放集", { [mediaType]: [`.${extension}`] });
    } finally { this.idleOperationRunning = false; }
  }

  async startGame(root: HTMLDivElement): Promise<boolean> {
    this.assertIdle();
    this.currentState = "starting";
    let content: LoadedContent | undefined;
    let plugins: LoadedPluginModules | undefined;
    try {
      await this.ensureInitialized();
      await this.resolveStoredConflicts();
      if (!this.embeddedOnly) {
        const installed = (await this.repository!.listPackages()).filter((entry) => entry.enabled);
        if (installed.length === 0) throw new Error("没有启用的内容包。");
        for (const entry of installed) {
          await this.repository!.verifyPackage(entry.packageId, (progress) => this.options.onProgress?.({ phase: "verifying", ...progress }));
        }
      }
      const index = await this.embedded.loadIndex();
      const source = this.embeddedOnly ? this.embedded : new RepositoryContentSource(this.repository!);
      const packages = await source.packages();
      // Keep one manifest snapshot for the warning decision and the subsequent plugin/content loads.
      const activeSource = { packages: async () => packages };
      root.innerHTML = `<main class="loading-shell"><span class="mark">✦</span><p>正在洗牌……</p></main>`;
      const persistence = createPersistenceService();
      if (!await ensureLongTermSaveReady(root, persistence)) {
        this.currentState = "idle";
        return false;
      }
      if (packages.some((entry) => entry.manifest.identity.authorId !== CORE_PACKAGE_AUTHOR_ID)) {
        const acknowledge = this.options.acknowledgeThirdPartyContent ?? (async (warningRoot: HTMLDivElement) => {
          const warning = await import("./third-party-content-warning");
          return warning.requireThirdPartyContentAcknowledgement(warningRoot, persistence);
        });
        if (!await acknowledge(root)) {
          this.currentState = "idle";
          return false;
        }
      }
      const longTerm = await persistence.loadLongTerm();
      const pluginSettings = new PluginSettingsSession(longTerm?.settings.pluginSettings ?? {});
      plugins = await loadPluginModules(activeSource, pluginSettings);
      content = await loadContent(
        activeSource,
        index,
        { handlers: plugins.handlers, dialogueRegistry: plugins.dialogueRegistry, characterSkins: longTerm?.settings.characterSkins, characterSkinUnlocks: longTerm?.characterSkinUnlocks }
      );
      let activeContent = content;
      const loadedPlugins = plugins;
      const savedOrder = this.embeddedOnly ? [] : await this.repository!.listPluginOrder();
      const createPresentation = (loaded: LoadedContent) => {
        const prepared = prepareContentRuntime(loaded);
        const contributions = loadedPlugins.registrations.map(({ packageId, registration }) => ({ packageId, contribution: registration.createRuntime(prepared.extensions) }));
        const artOrder = [...contributions].sort((left, right) => {
          const leftRank = savedOrder.indexOf(left.packageId), rightRank = savedOrder.indexOf(right.packageId);
          return (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank) - (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank);
        });
        const skillArchetypeArt = mergeSkillArchetypeArt(artOrder.map(({ contribution }) => contribution.skillArchetypeArt ?? {}));
        return { prepared, contributions: [...contributions.map(({ contribution }) => contribution), { skillArchetypeArt }] };
      };
      let activePresentation = createPresentation(content);
      const preparePresentation: NonNullable<import("./runtime-host").MountGameRuntimeOptions["preparePresentation"]> = async (preferences, unlocks) => {
        const candidate = await loadContent(activeSource, index, { handlers: loadedPlugins.handlers, dialogueRegistry: loadedPlugins.dialogueRegistry, characterSkins: preferences, characterSkinUnlocks: unlocks });
        try {
          const next = createPresentation(candidate), previous = activeContent, previousPresentation = activePresentation;
          let activated = false, disposed = false;
          return {
            characters: next.prepared.characters, contributions: next.contributions,
            activate: () => {
              activateContentRuntime(next.prepared);
              activeContent = candidate; activePresentation = next; this.loadedContent = candidate; activated = true;
            },
            rollback: () => {
              if (!activated) return;
              activateContentRuntime(previousPresentation.prepared);
              activeContent = previous; activePresentation = previousPresentation; this.loadedContent = previous; activated = false;
            },
            retirePrevious: () => { if (activated) previous.release(); },
            dispose: () => { if (!activated && !disposed) { disposed = true; candidate.release(); } }
          };
        } catch (error) { candidate.release(); throw error; }
      };
      const { loadSkinPreviews } = await import("./content/packages/skin-previews");
      installDialogueRegistry(plugins.dialogueRegistry);
      installDialogueEvents(plugins.eventRegistry);
      activateContentRuntime(activePresentation.prepared);
      const mountRuntime = this.options.mountRuntime ?? (async (mountOptions) => {
        const module = await import("./app");
        return module.mountGameRuntime(mountOptions);
      });
      this.runtime = await mountRuntime({
        root,
        telemetryPackages: Object.fromEntries(content.packages.flatMap(pkg => pkg.resources.flatMap(resource => {
          if (resource.descriptor.type !== "game.character-match" || resource.state !== "active") return [];
          const character = resource.value as import("./content/packages/resources").CharacterMatchResource;
          return [[character.metadata.id, { package_id: `${pkg.manifest.identity.authorId}/${pkg.manifest.identity.packageName}`, package_version: pkg.manifest.identity.version, package_name: pkg.manifest.metadata.title }]];
        }))),
        contributions: activePresentation.contributions,
        preparePresentation,
        loadSkinPreviews: (key, signal) => loadSkinPreviews(activeSource, key, signal),
        characterSkins: longTerm?.settings.characterSkins,
        characterSkinUnlocks: longTerm?.characterSkinUnlocks,
        pluginSettings,
        pluginCredits: collectPluginCredits(plugins.registrations, savedOrder),
        onExitRequest: async () => {
          await this.stopGame();
          await this.options.onRuntimeStopped?.();
        }
      });
      this.loadedContent = activeContent;
      this.loadedPlugins = plugins;
      this.currentState = "running";
      return true;
    } catch (error) {
      content?.release();
      plugins?.release();
      clearDialogueRegistry();
      clearDialogueEvents();
      deactivateContentRuntime();
      this.currentState = "idle";
      throw error;
    }
  }

  async stopGame(): Promise<void> {
    if (this.currentState !== "running" || !this.runtime) throw new ApplicationControllerBusyError(this.currentState);
    this.currentState = "stopping";
    try {
      await this.runtime.dispose();
      this.loadedContent?.release();
      this.loadedPlugins?.release();
      clearDialogueRegistry();
      clearDialogueEvents();
      deactivateContentRuntime();
      this.runtime = undefined;
      this.loadedContent = undefined;
      this.loadedPlugins = undefined;
      this.currentState = "idle";
    } catch (error) {
      this.currentState = "running";
      throw error;
    }
  }

  private assertIdle(): void {
    if (this.currentState !== "idle" || this.idleOperationRunning) throw new ApplicationControllerBusyError(this.currentState);
  }

  private beginIdleOperation(): void {
    this.assertIdle();
    this.idleOperationRunning = true;
  }
}
