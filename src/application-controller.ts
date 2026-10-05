import {
  ContentPackageManager,
  EmbeddedContentSeeder,
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
import { CONTENT_PERSISTENCE_REFUSED_WARNING, resolveContentHost, type ContentHostProvider, type ContentInstallProgress } from "./content/storage/contracts";
import { loadPluginModules, type LoadedPluginModules } from "./content/packages/plugin-modules";
import { migrateBuiltinPackageAuthors } from "./content/storage/builtin-author-migration";
import { CORE_PACKAGE_AUTHOR_ID } from "./content/packages/builtin-authors";
import { mergeSkillArchetypeArt } from "./resources/skill-archetype-art";
import { HocpkgTransfer, type ImportOutcome, type ImportSession } from "./content/transfer/hocpkg";
import { PlaylistStore, playlistDocument, type PlaylistDocument, type SavedPlaylist } from "./content/playlists/store";
import { decodePlaylistBytes, decodePlaylistFile, encodePlaylistHocpkg, encodePlaylistPng, playlistJson } from "./content/playlists/transfer";
import { createSaveFileWriter } from "./persistence/file-exchange";
import type { GameRuntimeHandle, MountGameRuntimeOptions } from "./app";
import { createPersistenceService } from "./persistence/factory";
import { ensureLongTermSaveReady } from "./persistence/long-term-recovery";

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
}

export class ApplicationController {
  private currentState: ApplicationControllerState = "idle";
  private readonly embedded: EmbeddedContentSource;
  private repository?: FileContentRepository;
  private manager?: ContentPackageManager;
  private transfer?: HocpkgTransfer;
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
    const repository = new FileContentRepository(host);
    await repository.open();
    if (await repository.isEmpty()) {
      const index = await this.embedded.loadIndex();
      const requiredBytes = index.packages.reduce((total, entry) => total + entry.bytes, 0);
      const availableBytes = await host.capabilities.estimateAvailableBytes?.();
      if (availableBytes !== undefined && availableBytes !== null && availableBytes < requiredBytes) {
        throw new Error(`内容目录空间不足：需要 ${requiredBytes} 字节，可用 ${availableBytes} 字节。`);
      }
      const persistent = await host.capabilities.requestPersistence?.();
      if (persistent === false) this.startupWarnings.add(CONTENT_PERSISTENCE_REFUSED_WARNING);
      await new EmbeddedContentSeeder(repository, this.embedded).seed({
        onProgress: (progress) => this.options.onProgress?.({ phase: "seeding", ...progress })
      });
    }
    try { await migrateBuiltinPackageAuthors(repository); }
    catch (error) {
      // Keep resource management available so a collision or damaged legacy package can be removed.
      this.startupWarnings.add(`内嵌包作者迁移未完成：${error instanceof Error ? error.message : "请在资源管理中检查旧包。"}`);
    }
    this.repository = repository;
    this.manager = new ContentPackageManager(repository, this.embedded);
    this.transfer = new HocpkgTransfer(host.fileSystem, repository);
    this.playlists = new PlaylistStore(host.fileSystem, await this.installedPluginOrder());
    const current = await repository.listPackages();
    const entries = await Promise.all(current.filter((entry) => entry.enabled).map(async (entry) => ({ packageId: entry.packageId, version: (await repository.readManifest(entry.packageId).catch(() => undefined))?.identity.version })));
    await this.playlists.initialize(entries, await this.installedPluginOrder());
    await this.syncCurrentPlaylist();
    for (const session of await this.transfer.listSessions()) await this.transfer.removeSession(session.id);
    this.contentInitialized = true;
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

  async stagePackageFile(file: File): Promise<ImportSession> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.transfer) throw new Error("只读模式不能导入内容包。");
      return await this.transfer.stage(file);
    } finally { this.idleOperationRunning = false; }
  }

  async installStagedPackages(sessionId: string, candidateIds: readonly string[], onProgress?: (progress: import("./content/storage/contracts").ContentInstallProgress) => void): Promise<readonly ImportOutcome[]> {
    this.beginIdleOperation();
    try {
      await this.ensureInitialized();
      if (!this.transfer) throw new Error("只读模式不能安装内容包。");
      return await this.transfer.installSelected(sessionId, candidateIds, onProgress);
    } finally { this.idleOperationRunning = false; }
  }

  async previewImportCandidate(sessionId: string, candidateId: string) {
    this.beginIdleOperation();
    try { await this.ensureInitialized(); if (!this.transfer) throw new Error("只读模式不能预览内容包。"); return await this.transfer.preview(sessionId, candidateId); }
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

  async importPlaylistFile(file: File): Promise<{ readonly document: PlaylistDocument; readonly missing: readonly string[]; readonly versionMismatch: readonly string[] }> {
    await this.ensureInitialized();
    const document = await decodePlaylistFile(file, await this.installedPluginOrder());
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
      plugins = await loadPluginModules(activeSource);
      content = await loadContent(
        activeSource,
        index,
        { handlers: plugins.handlers }
      );
      const prepared = prepareContentRuntime(content);
      const savedOrder = this.embeddedOnly ? [] : await this.repository!.listPluginOrder();
      const contributions = plugins.registrations.map(({ packageId, registration }) => ({ packageId, contribution: registration.createRuntime(prepared.extensions) }));
      const artOrder = [...contributions].sort((left, right) => {
        const leftRank = savedOrder.indexOf(left.packageId);
        const rightRank = savedOrder.indexOf(right.packageId);
        return (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank) - (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank);
      });
      const skillArchetypeArt = mergeSkillArchetypeArt(artOrder.map(({ contribution }) => contribution.skillArchetypeArt ?? {}));
      activateContentRuntime(prepared);
      const mountRuntime = this.options.mountRuntime ?? (async (mountOptions) => {
        const module = await import("./app");
        return module.mountGameRuntime(mountOptions);
      });
      this.runtime = await mountRuntime({
        root,
        contributions: [...contributions.map(({ contribution }) => contribution), { skillArchetypeArt }],
        onExitRequest: async () => {
          await this.stopGame();
          await this.options.onRuntimeStopped?.();
        }
      });
      this.loadedContent = content;
      this.loadedPlugins = plugins;
      this.currentState = "running";
      return true;
    } catch (error) {
      content?.release();
      plugins?.release();
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
