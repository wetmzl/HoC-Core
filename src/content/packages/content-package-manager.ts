import { pluginCompatibilityError } from "./plugin-version";
import type { ContentInstallOptions, ContentRepository, InstalledContentPackage } from "../storage/contracts";
import { decodeText } from "../storage/encoding";
import type { HocpkgManifest } from "./schema";
import type { ContentPackageAccess, ContentSource } from "./content-source";
import { PlaylistDocumentSchema, type PlaylistDocument } from "../playlists/store";
import {
  loadPackagePresentation,
  packagePresentationFallback,
  type ManagedContentPackagePresentation
} from "./package-presentation";

export type ManagedContentPackageState = "enabled" | "disabled" | "not-installed" | "broken";

export interface ManagedContentPackage {
  readonly packageId: string;
  readonly state: ManagedContentPackageState;
  readonly currentRevision?: string;
  readonly enabled?: boolean;
  readonly manifest?: HocpkgManifest;
  readonly embeddedManifest?: HocpkgManifest;
  readonly bytes: number;
  readonly source: "embedded" | "external";
  readonly presentation: ManagedContentPackagePresentation;
  readonly error?: string;
  readonly pluginPriority?: number;
}

export class ContentPackageOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentPackageOperationError";
  }
}

function declaredBytes(manifest: HocpkgManifest | undefined): number {
  return manifest?.files.reduce((total, file) => total + file.bytes, 0) ?? 0;
}

export class ContentPackageManager {
  constructor(
    private readonly repository: ContentRepository,
    private readonly embedded: ContentSource
  ) {}

  async listPackages(): Promise<readonly ManagedContentPackage[]> {
    await this.repository.open();
    const [installed, embeddedPackages, savedOrder] = await Promise.all([
      this.repository.listPackages(),
      this.embedded.packages(),
      this.repository.listPluginOrder()
    ]);
    const installedById = new Map(installed.map((entry) => [entry.packageId, entry]));
    const embeddedById = new Map(embeddedPackages.map((entry) => [entry.packageId, entry]));
    const ids = [...new Set([...installedById.keys(), ...embeddedById.keys()])].sort();
    const described = await Promise.all(ids.map((packageId) => this.describePackage(packageId, installedById.get(packageId), embeddedById.get(packageId))));
    const pluginIds = described.filter((entry) => (entry.manifest ?? entry.embeddedManifest)?.resources.some((resource) => resource.type === "plugin.module")).map((entry) => entry.packageId);
    const order = [...savedOrder.filter((id) => pluginIds.includes(id)), ...pluginIds.filter((id) => !savedOrder.includes(id))];
    return described.map((entry) => ({ ...entry, error: entry.error ?? (entry.manifest ? pluginCompatibilityError(entry.manifest) : undefined), pluginPriority: order.includes(entry.packageId) ? order.indexOf(entry.packageId) : undefined }));
  }

  async setPluginOrder(order: readonly string[]): Promise<void> {
    const plugins = (await this.listPackages()).filter((entry) => entry.pluginPriority !== undefined && entry.currentRevision !== undefined).map((entry) => entry.packageId);
    if (order.length !== plugins.length || new Set(order).size !== order.length || order.some((id) => !plugins.includes(id))) throw new ContentPackageOperationError("插件排序与当前已安装插件不一致。");
    await this.repository.setPluginOrder(order);
  }

  async disablePackage(packageId: string): Promise<void> {
    const installed = await this.repository.listPackages();
    const target = installed.find((entry) => entry.packageId === packageId);
    if (!target) throw new ContentPackageOperationError(`内容包尚未安装：${packageId}`);
    if (!target.enabled) return;
    const manifest = await this.repository.readManifest(packageId).catch(() => undefined);
    const disablesCharacter = manifest?.resources.some((resource) => resource.type === "game.character-match") ?? false;
    if (disablesCharacter) {
      const alternatives = installed.filter((entry) => entry.enabled && entry.packageId !== packageId);
      const hasAlternative = (await Promise.all(alternatives.map(async (entry) => {
        const candidate = await this.repository.readManifest(entry.packageId).catch(() => undefined);
        return candidate?.resources.some((resource) => resource.type === "game.character-match") ?? false;
      }))).some(Boolean);
      if (!hasAlternative) throw new ContentPackageOperationError("至少需要保留一个启用的角色包。");
    }
    await this.repository.disablePackage(packageId);
  }

  async enablePackage(packageId: string): Promise<void> {
    const installed = await this.repository.listPackages();
    const target = installed.find((entry) => entry.packageId === packageId);
    if (!target) throw new ContentPackageOperationError(`内容包尚未安装：${packageId}`);
    if (target.enabled) return;
    await this.repository.enablePackage(packageId);
  }

  async applyPlaylist(input: PlaylistDocument): Promise<{ readonly missing: readonly string[]; readonly versionMismatch: readonly string[] }> {
    const document = PlaylistDocumentSchema.parse(input);
    const installed = new Map((await this.repository.listPackages()).map((entry) => [entry.packageId, entry]));
    const selected = document.packages.filter((entry) => installed.has(entry.packageId));
    const mismatch: string[] = [];
    for (const entry of selected) {
      if (!entry.version) continue;
      const manifest = await this.repository.readManifest(entry.packageId).catch(() => undefined);
      if (!manifest || manifest.identity.version !== entry.version) mismatch.push(entry.packageId);
    }
    await this.repository.setEnabledPackages(selected.map((entry) => entry.packageId));
    return { missing: document.packages.filter((entry) => !installed.has(entry.packageId)).map((entry) => entry.packageId), versionMismatch: mismatch };
  }

  async removePackage(packageId: string): Promise<void> {
    const installed = await this.repository.listPackages();
    const target = installed.find((entry) => entry.packageId === packageId);
    if (!target) return;
    const manifest = await this.repository.readManifest(packageId).catch(() => undefined);
    const removesEnabledCharacter = target.enabled
      && (manifest?.resources.some((resource) => resource.type === "game.character-match") ?? false);
    if (removesEnabledCharacter) {
      const alternatives = installed.filter((entry) => entry.enabled && entry.packageId !== packageId);
      const hasAlternative = (await Promise.all(alternatives.map(async (entry) => {
        const candidate = await this.repository.readManifest(entry.packageId).catch(() => undefined);
        return candidate?.resources.some((resource) => resource.type === "game.character-match") ?? false;
      }))).some(Boolean);
      if (!hasAlternative) throw new ContentPackageOperationError("至少需要保留一个启用的角色包。");
    }
    await this.repository.removePackage(packageId);
  }

  async restoreEmbeddedPackage(packageId: string, options: ContentInstallOptions = {}): Promise<void> {
    const installed = await this.repository.listPackages();
    if (installed.some((entry) => entry.packageId === packageId)) {
      throw new ContentPackageOperationError(`内容包已经安装：${packageId}`);
    }
    const source = (await this.embedded.packages()).find((entry) => entry.packageId === packageId);
    if (!source) throw new ContentPackageOperationError(`没有可恢复的内嵌内容包：${packageId}`);
    await this.repository.install(source, options);
  }

  private async describePackage(
    packageId: string,
    installed: InstalledContentPackage | undefined,
    embedded: ContentPackageAccess | undefined
  ): Promise<ManagedContentPackage> {
    if (!installed) {
      return {
        packageId,
        state: "not-installed",
        embeddedManifest: embedded?.manifest,
        bytes: declaredBytes(embedded?.manifest),
        source: "embedded",
        presentation: embedded ? await loadPackagePresentation(embedded) : packagePresentationFallback(undefined)
      };
    }
    try {
      const manifest = await this.repository.readManifest(packageId);
      const presentation = await loadPackagePresentation({
        manifest,
        readJson: async (path) => JSON.parse(decodeText(await this.repository.readFile(packageId, path))) as unknown,
        resolveAsset: (path) => this.repository.resolveAsset(packageId, path)
      });
      return {
        packageId,
        state: installed.enabled ? "enabled" : "disabled",
        currentRevision: installed.currentRevision,
        enabled: installed.enabled,
        manifest,
        embeddedManifest: embedded?.manifest,
        bytes: declaredBytes(manifest),
        source: embedded ? "embedded" : "external",
        presentation
      };
    } catch (error) {
      return {
        packageId,
        state: "broken",
        currentRevision: installed.currentRevision,
        enabled: installed.enabled,
        embeddedManifest: embedded?.manifest,
        bytes: declaredBytes(embedded?.manifest),
        source: embedded ? "embedded" : "external",
        presentation: packagePresentationFallback(embedded?.manifest),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
