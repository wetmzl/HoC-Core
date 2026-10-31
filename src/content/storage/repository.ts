import { checkCancelled, copyFile, inspectFiles } from "./file-operations";
import {
  HocpkgManifestSchema,
  HocpkgPortablePathSchema,
  compareHocpkgPackages,
  getHocpkgPackageId,
  type HocpkgManifest
} from "../packages";
import { commitCatalog, CONTENT_ROOT, emptyContentCatalog, readCurrentCatalog, type ContentCatalog } from "./catalog";
import type {
  ContentFileEntry,
  ContentFileSource,
  ContentHost,
  ContentInstallOptions,
  ContentInstallResult,
  ContentPackageMutationResult,
  ContentPackageSource,
  ContentRepository,
  InstalledContentPackage,
  ResolvedContentAsset
} from "./contracts";
import { decodeText, encodeText, sha256, sha256Json, stableJson } from "./encoding";
import type { ContentPackageAccess } from "../packages/content-source";
import { canonicalBuiltinPackageId } from "../packages/builtin-authors";

const MANIFEST_FILE = "hocpkg-info.json";
const PENDING_FILE = ".pending";
const RECEIPT_FILE = ".receipt.json";

interface PreparedPackage {
  readonly packageId: string;
  readonly revision: string;
  readonly manifest: HocpkgManifest;
  readonly root: string;
  readonly previousRevision?: string;
}

export class ContentPackageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentPackageIntegrityError";
  }
}

export class ContentPackageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentPackageConflictError";
  }
}

function revisionRoot(packageId: string, revision: string): string {
  return `${CONTENT_ROOT}/revisions/${packageId}/${revision}`;
}

function canonicalManifest(manifest: HocpkgManifest): HocpkgManifest {
  return {
    ...manifest,
    files: [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))
  };
}

export async function getContentRevision(manifest: HocpkgManifest): Promise<string> {
  return sha256Json(canonicalManifest(manifest));
}

function packageList(catalog: ContentCatalog): readonly InstalledContentPackage[] {
  return Object.entries(catalog.packages)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageId, state]) => ({ packageId, ...state }));
}

function parsePackageId(packageId: string): readonly [string, string] {
  const parts = packageId.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9][a-z0-9_-]*$/.test(part ?? ""))) {
    throw new Error(`非法 packageId：${packageId}`);
  }
  return [parts[0]!, parts[1]!];
}

export class FileContentRepository implements ContentRepository {
  private catalog: ContentCatalog = emptyContentCatalog();
  private opened = false;
  private hadCatalog = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly embedded = new Map<string, ContentPackageAccess & { revision: string }>();
  private archivedFiles?: Promise<Map<string, { source: ContentPackageAccess; path: string }>>;

  /** Register directory sources without installing their bodies in userdata. */
  configureEmbedded(sources: readonly ContentPackageAccess[], selected?: ReadonlySet<string>, defaults?: ReadonlySet<string>): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
    await this.open();
    this.embedded.clear();
    for (const source of sources) this.embedded.set(source.packageId, { ...source, revision: await getContentRevision(source.manifest) });
    const first = this.catalog.embedded === undefined;
    const fresh = first && !this.hadCatalog && selected === undefined && !Object.keys(this.catalog.packages).length;
    const states = { ...this.catalog.embedded };
    for (const source of sources) if (!states[source.packageId]) states[source.packageId] = {
      enabled: this.catalog.packages[source.packageId]?.enabled ?? Object.entries(this.catalog.packages).find(([id]) => canonicalBuiltinPackageId(id) === source.packageId)?.[1].enabled ?? (fresh ? defaults?.has(source.packageId) ?? true : false)
    };
    const next = { ...this.catalog, embedded: states };
    if (stableJson(next) !== stableJson(this.catalog)) { await commitCatalog(this.host.fileSystem, next, this.now); this.catalog = next; }
    }); this.queue = operation; return operation;
  }

  async listStoredConflicts(): Promise<readonly InstalledContentPackage[]> {
    await this.ready();
    return packageList(this.catalog).filter(entry => this.embedded.has(canonicalBuiltinPackageId(entry.packageId)));
  }

  /** Snapshot a stored source before the same identity is handed to the embedded directory. */
  async storedSource(packageId: string): Promise<ContentPackageAccess> {
    await this.ready();
    const state = this.catalog.packages[packageId];
    if (!state) throw new Error("用户仓库副本不存在。");
    return this.storedAccess(packageId, state.currentRevision);
  }

  private async storedAccess(packageId: string, revision: string): Promise<ContentPackageAccess> {
    const fs = this.host.fileSystem, root = revisionRoot(packageId, revision);
    const manifest = HocpkgManifestSchema.parse(JSON.parse(decodeText((await fs.read(`${root}/${MANIFEST_FILE}`))!)));
    if (getHocpkgPackageId(manifest.identity) !== packageId || await getContentRevision(manifest) !== revision) throw new ContentPackageIntegrityError("历史副本描述与目录不一致。");
    const readFile = async (path: string) => {
      const file = manifest.files.find(file => file.path === path);
      if (!file) throw new Error("未声明归档文件。");
      const bytes = await fs.read(`${root}/${path}`);
      if (!bytes) throw new Error("归档文件缺失。");
      return bytes;
    };
    return { packageId, manifest, readFile, readJson: async path => JSON.parse(decodeText(await readFile(path))),
      resolveAsset: async path => { const file = manifest.files.find(file => file.path === path); if (!file) throw new Error("未声明归档文件。"); return this.host.assetResolver.resolve(`${root}/${path}`, file.mediaType); },
      async *files() { for (const file of manifest.files) yield { path: file.path, bytes: await readFile(file.path) }; }
    };
  }

  async resolveEmbeddedConflicts(clean: boolean): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      const packages = { ...this.catalog.packages }, archives = { ...this.catalog.archives };
      for (const [id, state] of Object.entries(packages)) if (this.embedded.has(canonicalBuiltinPackageId(id))) {
        if (!clean) archives[`${id}/${state.currentRevision}`] = { packageId: id, currentRevision: state.currentRevision, archivedAt: this.now() };
        delete packages[id];
      }
      const next = { ...this.catalog, packages, archives };
      const committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      this.archivedFiles = undefined;
      if (committed.mirrored) await this.cleanupUnreferencedRevisions().catch(() => undefined);
    });
    this.queue = operation; return operation;
  }

  async listArchives() { await this.ready(); return Object.entries(this.catalog.archives ?? {}).map(([id, entry]) => ({ id, ...entry })); }

  async resolveArchivedAsset(packageId: string, expected: HocpkgManifest["files"][number]): Promise<ResolvedContentAsset | undefined> {
    await this.ready();
    const files = await (this.archivedFiles ??= (async () => {
      const index = new Map<string, { source: ContentPackageAccess; path: string }>();
      for (const entry of Object.values(this.catalog.archives ?? {})) {
        try {
          const source = await this.storedAccess(entry.packageId, entry.currentRevision);
          for (const file of source.manifest.files) index.set(`${canonicalBuiltinPackageId(entry.packageId)}#${file.sha256}`, { source, path: file.path });
        } catch { /* A broken optional archive is still removable in resource management. */ }
      }
      return index;
    })());
    const previous = files.get(`${packageId}#${expected.sha256}`); if (!previous) return undefined;
    try {
      const bytes = await previous.source.readFile!(previous.path);
      if (bytes.length !== expected.bytes || await sha256(bytes) !== expected.sha256) return undefined;
      return await previous.source.resolveAsset(previous.path);
    } catch { return undefined; }
  }

  async archiveSource(id: string): Promise<ContentPackageAccess> {
    await this.ready();
    const entry = this.catalog.archives?.[id];
    if (!entry) throw new Error("归档不存在。");
    return this.storedAccess(entry.packageId, entry.currentRevision);
  }

  async removeArchive(id: string): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open(); if (!this.catalog.archives?.[id]) throw new Error("归档不存在。");
      const archives = { ...this.catalog.archives }; delete archives[id];
      const next = { ...this.catalog, archives }, committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      this.archivedFiles = undefined;
      if (committed.mirrored) await this.cleanupUnreferencedRevisions().catch(() => undefined);
    }); this.queue = operation; return operation;
  }

  constructor(
    private readonly host: ContentHost,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async open(): Promise<void> {
    if (this.opened) return;
    const loaded = await readCurrentCatalog(this.host.fileSystem);
    this.hadCatalog = loaded !== null;
    this.catalog = loaded?.envelope.catalog ?? emptyContentCatalog();
    if (loaded?.requiresMigration) await commitCatalog(this.host.fileSystem, this.catalog, this.now);
    await this.cleanupUnreferencedRevisions();
    this.opened = true;
  }

  private async ready(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.open();
  }

  async isEmpty(): Promise<boolean> {
    await this.ready();
    return Object.keys(this.catalog.packages).length === 0 && this.embedded.size === 0;
  }

  async listPackages(): Promise<readonly InstalledContentPackage[]> {
    await this.ready();
    return [...packageList(this.catalog).filter(entry => !this.embedded.has(canonicalBuiltinPackageId(entry.packageId))),
      ...[...this.embedded].map(([packageId, source]) => ({ packageId, currentRevision: source.revision, enabled: this.catalog.embedded?.[packageId]?.enabled ?? false, embedded: true }))];
  }

  async listPluginOrder(): Promise<readonly string[]> {
    await this.ready();
    return [...new Set(this.catalog.pluginOrder.map(id => this.embedded.has(canonicalBuiltinPackageId(id)) ? canonicalBuiltinPackageId(id) : id))];
  }

  async setPluginOrder(order: readonly string[]): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      if (new Set(order).size !== order.length || order.some((id) => !this.catalog.packages[id] && !this.embedded.has(id))) throw new Error("插件排序包含未安装或重复的内容包。");
      const next: ContentCatalog = { ...this.catalog, pluginOrder: [...order] };
      await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
    });
    this.queue = operation;
    return operation;
  }

  private currentRevision(packageId: string): string {
    parsePackageId(packageId);
    const state = this.catalog.packages[packageId];
    if (!state) throw new Error(`内容包尚未安装：${packageId}`);
    return state.currentRevision;
  }

  async readManifest(packageId: string): Promise<HocpkgManifest> {
    await this.ready();
    return this.readManifestNow(packageId);
  }

  private async readManifestNow(packageId: string): Promise<HocpkgManifest> {
    if (this.embedded.has(packageId)) return this.embedded.get(packageId)!.manifest;
    return this.readStoredManifestNow(packageId);
  }

  private async readStoredManifestNow(packageId: string): Promise<HocpkgManifest> {
    const root = revisionRoot(packageId, this.currentRevision(packageId));
    const bytes = await this.host.fileSystem.read(`${root}/${MANIFEST_FILE}`);
    if (!bytes) throw new Error(`内容包 Manifest 缺失：${packageId}`);
    return HocpkgManifestSchema.parse(JSON.parse(decodeText(bytes)));
  }

  async readFile(packageId: string, path: string): Promise<Uint8Array> {
    await this.ready();
    if (this.embedded.has(packageId)) return this.embedded.get(packageId)!.readFile!(path);
    const safePath = HocpkgPortablePathSchema.parse(path);
    const manifest = await this.readManifestNow(packageId);
    if (!manifest.files.some((file) => file.path === safePath)) throw new Error(`文件未在 Manifest 中声明：${packageId}#${safePath}`);
    const root = revisionRoot(packageId, this.currentRevision(packageId));
    const bytes = await this.host.fileSystem.read(`${root}/${safePath}`);
    if (!bytes) throw new Error(`内容文件缺失：${packageId}#${safePath}`);
    return bytes;
  }

  async resolveAsset(packageId: string, path: string): Promise<ResolvedContentAsset> {
    await this.ready();
    if (this.embedded.has(packageId)) return this.embedded.get(packageId)!.resolveAsset(path);
    const manifest = await this.readManifestNow(packageId);
    const safePath = HocpkgPortablePathSchema.parse(path);
    const file = manifest.files.find((candidate) => candidate.path === safePath);
    if (!file) throw new Error(`文件未在 Manifest 中声明：${packageId}#${safePath}`);
    const root = revisionRoot(packageId, this.currentRevision(packageId));
    return this.host.assetResolver.resolve(`${root}/${safePath}`, file.mediaType);
  }

  async verifyPackage(packageId: string, onProgress?: (progress: import("./contracts").ContentInstallProgress) => void): Promise<void> {
    await this.ready();
    if (this.embedded.has(packageId)) return;
    const currentRevision = this.currentRevision(packageId);
    const manifest = await this.readManifestNow(packageId);
    if (getHocpkgPackageId(manifest.identity) !== packageId || await getContentRevision(manifest) !== currentRevision) {
      throw new ContentPackageIntegrityError(`内容包 Manifest 与 catalog 不一致：${packageId}`);
    }
    const root = revisionRoot(packageId, currentRevision);
    const totalBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    let completedBytes = 0;
    let offset = 0, reported = 0;
    const offsets = new Map<string, { path: string; offset: number }>(manifest.files.map(file => {
      const value = { path: file.path, offset };
      offset += file.bytes;
      return [`${root}/${file.path}`, value] as const;
    }));
    const digests = await inspectFiles(this.host.fileSystem, manifest.files.map(file => `${root}/${file.path}`), onProgress ? {
      onProgress: progress => {
        const file = offsets.get(progress.path);
        if (!file) return;
        reported = Math.max(reported, Math.min(totalBytes, file.offset + progress.completedBytes));
        onProgress({ packageId, path: file.path, completedBytes: reported, totalBytes });
      }
    } : undefined);
    for (const [index, file] of manifest.files.entries()) {
      const digest = digests[index]!;
      if (digest.bytes !== file.bytes) throw new ContentPackageIntegrityError(`文件大小不符：${packageId}#${file.path}`);
      if (digest.sha256 !== file.sha256) throw new ContentPackageIntegrityError(`文件摘要不符：${packageId}#${file.path}`);
      completedBytes += digest.bytes;
      if (completedBytes > reported) {
        reported = completedBytes;
        onProgress?.({ packageId, path: file.path, completedBytes: reported, totalBytes });
      }
    }
  }

  disablePackage(packageId: string): Promise<ContentPackageMutationResult> {
    if (this.embedded.has(packageId)) return this.setEmbeddedEnabled(packageId, false);
    let result!: ContentPackageMutationResult;
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      parsePackageId(packageId);
      const current = this.catalog.packages[packageId];
      if (!current) throw new Error(`内容包尚未安装：${packageId}`);
      if (!current.enabled) {
        result = { packages: packageList(this.catalog), changed: false, cleanup: "complete" };
        return;
      }
      const next: ContentCatalog = {
        ...this.catalog,
        packages: { ...this.catalog.packages, [packageId]: { ...current, enabled: false } }
      };
      const committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      result = { packages: packageList(next), changed: true, cleanup: committed.mirrored ? "complete" : "deferred" };
    });
    this.queue = operation;
    return operation.then(() => result);
  }

  enablePackage(packageId: string): Promise<ContentPackageMutationResult> {
    if (this.embedded.has(packageId)) return this.setEmbeddedEnabled(packageId, true);
    let result!: ContentPackageMutationResult;
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      parsePackageId(packageId);
      const current = this.catalog.packages[packageId];
      if (!current) throw new Error(`内容包尚未安装：${packageId}`);
      if (current.enabled) {
        result = { packages: packageList(this.catalog), changed: false, cleanup: "complete" };
        return;
      }
      const next: ContentCatalog = {
        ...this.catalog,
        packages: { ...this.catalog.packages, [packageId]: { ...current, enabled: true } }
      };
      const committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      result = { packages: packageList(next), changed: true, cleanup: committed.mirrored ? "complete" : "deferred" };
    });
    this.queue = operation;
    return operation.then(() => result);
  }

  setEnabledPackages(packageIds: readonly string[]): Promise<ContentPackageMutationResult> {
    let result!: ContentPackageMutationResult;
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      if (new Set(packageIds).size !== packageIds.length || packageIds.some((id) => !this.catalog.packages[id] && !this.embedded.has(id))) {
        throw new Error("播放集包含重复或尚未安装的内容包。");
      }
      const enabled = new Set(packageIds);
      const packages = Object.fromEntries(Object.entries(this.catalog.packages).map(([id, entry]) => [id, { ...entry, enabled: enabled.has(id) }]));
      const embedded = { ...this.catalog.embedded };
      for (const id of this.embedded.keys()) embedded[id] = { enabled: enabled.has(id) };
      const changed = Object.keys(packages).some((id) => this.catalog.packages[id]!.enabled !== packages[id]!.enabled) || stableJson(embedded) !== stableJson(this.catalog.embedded ?? {});
      if (!changed) { result = { packages: packageList(this.catalog), changed: false, cleanup: "complete" }; return; }
      const next: ContentCatalog = { ...this.catalog, packages, ...(this.catalog.embedded ? { embedded } : {}) };
      const committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      result = { packages: packageList(next), changed: true, cleanup: committed.mirrored ? "complete" : "deferred" };
    });
    this.queue = operation;
    return operation.then(() => result);
  }

  removePackage(packageId: string): Promise<ContentPackageMutationResult> {
    if (this.embedded.has(canonicalBuiltinPackageId(packageId))) return Promise.reject(new ContentPackageConflictError("内嵌内容不能删除；可以禁用或清除离线缓存。"));
    let result!: ContentPackageMutationResult;
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      parsePackageId(packageId);
      const current = this.catalog.packages[packageId];
      if (!current) {
        result = { packages: packageList(this.catalog), changed: false, cleanup: "complete" };
        return;
      }
      const packages = { ...this.catalog.packages };
      delete packages[packageId];
      const next: ContentCatalog = { ...this.catalog, packages, pluginOrder: this.catalog.pluginOrder.filter((id) => id !== packageId) };
      const committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      let cleanup: "complete" | "deferred" = committed.mirrored ? "complete" : "deferred";
      if (committed.mirrored) {
        try {
          await this.host.fileSystem.remove(revisionRoot(packageId, current.currentRevision));
        } catch {
          cleanup = "deferred";
        }
      }
      result = { packages: packageList(next), changed: true, cleanup };
    });
    this.queue = operation;
    return operation.then(() => result);
  }

  private setEmbeddedEnabled(packageId: string, enabled: boolean): Promise<ContentPackageMutationResult> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      const next = { ...this.catalog, embedded: { ...this.catalog.embedded, [packageId]: { enabled } } };
      const changed = this.catalog.embedded?.[packageId]?.enabled !== enabled;
      const result = changed ? await commitCatalog(this.host.fileSystem, next, this.now) : { mirrored: true };
      this.catalog = next;
      return { packages: packageList(next), changed, cleanup: result.mirrored ? "complete" as const : "deferred" as const };
    }); this.queue = operation.then(() => undefined); return operation;
  }

  /** Atomically move an existing package to a new identity without replacing its resources. */
  reidentifyPackage(packageId: string, input: HocpkgManifest): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      const manifest = HocpkgManifestSchema.parse(input);
      const targetId = getHocpkgPackageId(manifest.identity);
      const current = this.catalog.packages[packageId];
      if (!current) return;
      if (targetId === packageId) throw new ContentPackageConflictError("迁移目标必须使用新的包身份。");
      if (this.catalog.packages[targetId]) throw new ContentPackageConflictError(`旧包 ${packageId} 与新包 ${targetId} 同时存在，请先在资源管理中移除重复包。`);
      const oldManifest = await this.readManifestNow(packageId);
      if (stableJson(oldManifest.files) !== stableJson(manifest.files) || stableJson(oldManifest.resources) !== stableJson(manifest.resources)) {
        throw new ContentPackageConflictError("包身份迁移不能改变资源或文件清单。");
      }
      if (getHocpkgPackageId(oldManifest.identity) !== packageId || await getContentRevision(oldManifest) !== current.currentRevision) {
        throw new ContentPackageIntegrityError(`内容包 Manifest 与 catalog 不一致：${packageId}`);
      }
      const oldRoot = revisionRoot(packageId, current.currentRevision);
      const source: ContentPackageSource = {
        manifest,
        receipt: { source: "identity-migration", previousPackageId: packageId },
        async *files() {
          for (const file of manifest.files) {
            yield { path: file.path, source: { kind: "stored" as const, path: `${oldRoot}/${file.path}` } };
          }
        }
      };
      const prepared = await this.prepare(source, manifest, {}, { completedBytes: 0, totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
      if (!prepared) throw new ContentPackageConflictError("包身份迁移未生成候选 revision。");
      const packages = { ...this.catalog.packages, [targetId]: { currentRevision: prepared.revision, enabled: current.enabled } };
      delete packages[packageId];
      const next: ContentCatalog = { ...this.catalog, packages, pluginOrder: this.catalog.pluginOrder.map((id) => id === packageId ? targetId : id) };
      const committed = await commitCatalog(this.host.fileSystem, next, this.now);
      this.catalog = next;
      if (committed.mirrored) await this.host.fileSystem.remove(oldRoot).catch(() => undefined);
    });
    this.queue = operation;
    return operation;
  }

  install(source: ContentPackageSource, options: ContentInstallOptions = {}): Promise<ContentInstallResult> {
    return this.installBatch([source], options);
  }

  installBatch(sources: readonly ContentPackageSource[], options: ContentInstallOptions = {}): Promise<ContentInstallResult> {
    let result!: ContentInstallResult;
    const operation = this.queue.catch(() => undefined).then(async () => {
      await this.open();
      result = await this.installBatchNow(sources, options);
    });
    this.queue = operation;
    return operation.then(() => result);
  }

  private async installBatchNow(
    sources: readonly ContentPackageSource[],
    options: ContentInstallOptions
  ): Promise<ContentInstallResult> {
    const manifests = sources.map((source) => HocpkgManifestSchema.parse(source.manifest));
    const ids = manifests.map((manifest) => getHocpkgPackageId(manifest.identity));
    if (new Set(ids).size !== ids.length) throw new ContentPackageConflictError("同一批安装包含重复 packageId");

    const prepared: PreparedPackage[] = [];
    const progress = {
      completedBytes: 0,
      totalBytes: manifests.flatMap((manifest) => manifest.files).reduce((total, file) => total + file.bytes, 0)
    };
    try {
      for (let index = 0; index < sources.length; index += 1) {
        const candidate = await this.prepare(sources[index]!, manifests[index]!, options, progress);
        if (candidate) prepared.push(candidate);
      }
      checkCancelled({ signal: options.signal });
      options.onCommit?.();
    } catch (error) {
      await Promise.all(prepared.filter(entry => !this.catalog.archives?.[`${entry.packageId}/${entry.revision}`]).map((entry) => this.host.fileSystem.remove(entry.root).catch(() => undefined)));
      throw error;
    }

    if (prepared.length === 0) return { packages: packageList(this.catalog), changed: false, cleanup: "complete" };
    const next: ContentCatalog = {
      ...this.catalog,
      packages: {
        ...this.catalog.packages,
        ...Object.fromEntries(prepared.map((entry) => [entry.packageId, {
          currentRevision: entry.revision,
          enabled: this.catalog.packages[entry.packageId]?.enabled ?? options.newPackagesEnabled ?? true
        }]))
      }
    };
    const committed = await commitCatalog(this.host.fileSystem, next, this.now);
    this.catalog = next;
    let cleanup: "complete" | "deferred" = committed.mirrored ? "complete" : "deferred";
    if (committed.mirrored) {
      for (const entry of prepared) {
        if (!entry.previousRevision || entry.previousRevision === entry.revision) continue;
        if (this.catalog.archives?.[`${entry.packageId}/${entry.previousRevision}`]) continue;
        try {
          await this.host.fileSystem.remove(revisionRoot(entry.packageId, entry.previousRevision));
        } catch {
          cleanup = "deferred";
        }
      }
    }
    return { packages: packageList(next), changed: true, cleanup };
  }

  private async prepare(
    source: ContentPackageSource,
    manifest: HocpkgManifest,
    options: ContentInstallOptions,
    progress: { completedBytes: number; readonly totalBytes: number }
  ): Promise<PreparedPackage | null> {
    const packageId = getHocpkgPackageId(manifest.identity);
    const revision = await getContentRevision(manifest);
    const previousRevision = this.catalog.packages[packageId]?.currentRevision;
    if (previousRevision === revision) return null;
    if (previousRevision) {
      const current = await this.readStoredManifestNow(packageId);
      const comparison = compareHocpkgPackages(
        { manifest: current, contentDigest: previousRevision },
        { manifest, contentDigest: revision }
      );
      if (comparison.relation === "downgrade" && !options.allowDowngrade) {
        throw new ContentPackageConflictError(`拒绝降级内容包：${packageId}`);
      }
      if (comparison.relation === "same-version-different-content" && !options.allowSameVersionReplacement) {
        throw new ContentPackageConflictError(comparison.warning ?? `拒绝同版本覆盖：${packageId}`);
      }
    }

    const root = revisionRoot(packageId, revision);
    if (this.catalog.archives?.[`${packageId}/${revision}`]) {
      await this.verifyStoredPackage(root, manifest, options);
      return { packageId, revision, manifest, root, previousRevision };
    }
    await this.host.fileSystem.remove(root);
    await this.host.fileSystem.write(`${root}/${PENDING_FILE}`, encodeText(this.now()));
    await this.host.fileSystem.write(`${root}/${MANIFEST_FILE}`, encodeText(stableJson(canonicalManifest(manifest))));
    if (source.receipt) await this.host.fileSystem.write(`${root}/${RECEIPT_FILE}`, encodeText(stableJson(source.receipt)));

    const declared = new Map(manifest.files.map((file) => [file.path, file]));
    const observed = new Set<string>();
    const references: { entry: ContentFileEntry & { source: ContentFileSource }; expected: HocpkgManifest["files"][number] }[] = [];
    const copied = (path: string, expected: HocpkgManifest["files"][number], digest: { bytes: number; sha256: string }) => {
      if (digest.bytes !== expected.bytes) throw new ContentPackageIntegrityError(`文件大小不符：${path}`);
      if (digest.sha256 !== expected.sha256) throw new ContentPackageIntegrityError(`文件摘要不符：${path}`);
      progress.completedBytes += digest.bytes;
      options.onProgress?.({ packageId, path, completedBytes: progress.completedBytes, totalBytes: progress.totalBytes });
    };
    try {
      for await (const entry of source.files()) {
        const path = HocpkgPortablePathSchema.parse(entry.path);
        if (observed.has(path)) throw new ContentPackageIntegrityError(`候选包包含重复文件：${path}`);
        const expected = declared.get(path);
        if (!expected) throw new ContentPackageIntegrityError(`候选包包含未声明文件：${path}`);
        observed.add(path);
        if (entry.source && this.host.fileSystem.copyMany) references.push({ entry: { path, source: entry.source }, expected });
        else copied(path, expected, await copyFile(this.host.fileSystem, entry, `${root}/${path}`, { signal: options.signal, onProgress: options.onIoProgress }));
      }
      const missing = [...declared.keys()].filter((path) => !observed.has(path));
      if (missing.length > 0) throw new ContentPackageIntegrityError(`候选包缺少文件：${missing.join(", ")}`);
      if (references.length) {
        const digests = await this.host.fileSystem.copyMany!(references.map(({ entry }) => ({ source: entry.source, destination: `${root}/${entry.path}` })), { signal: options.signal, onProgress: options.onIoProgress });
        if (digests.length !== references.length) throw new ContentPackageIntegrityError("复制返回的文件数量不符。");
        for (const [index, { entry, expected }] of references.entries()) copied(entry.path, expected, digests[index]!);
      }
      await this.verifyStoredPackage(root, manifest, options);
      await this.host.fileSystem.remove(`${root}/${PENDING_FILE}`);
      return { packageId, revision, manifest, root, previousRevision };
    } catch (error) {
      await this.host.fileSystem.remove(root).catch(() => undefined);
      throw error;
    }
  }

  private async verifyStoredPackage(root: string, manifest: HocpkgManifest, options?: ContentInstallOptions): Promise<void> {
    const digests = await inspectFiles(this.host.fileSystem, manifest.files.map(file => `${root}/${file.path}`), { signal: options?.signal, onProgress: options?.onIoProgress });
    for (const [index, file] of manifest.files.entries()) {
      const digest = digests[index]!;
      if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) throw new ContentPackageIntegrityError(`落盘文件复验失败：${file.path}`);
    }
  }

  private async cleanupUnreferencedRevisions(): Promise<void> {
    const files = await this.host.fileSystem.list(`${CONTENT_ROOT}/revisions`);
    const referenced = new Set(Object.entries(this.catalog.packages).map(([id, state]) => revisionRoot(id, state.currentRevision)));
    for (const entry of Object.values(this.catalog.archives ?? {})) referenced.add(revisionRoot(entry.packageId, entry.currentRevision));
    const roots = new Set<string>();
    for (const path of files) {
      const relative = path.slice(`${CONTENT_ROOT}/revisions/`.length);
      const [authorId, packageName, revision] = relative.split("/");
      if (authorId && packageName && revision) roots.add(`${CONTENT_ROOT}/revisions/${authorId}/${packageName}/${revision}`);
    }
    for (const root of roots) if (!referenced.has(root)) await this.host.fileSystem.remove(root);
  }
}
