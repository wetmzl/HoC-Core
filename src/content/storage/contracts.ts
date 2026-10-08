import type { HocpkgManifest } from "../packages/schema";

export type ContentFileSource = { readonly kind: "stored"; readonly path: string }
  | { readonly kind: "asset"; readonly path: string }
  | { readonly kind: "blob"; readonly blob: Blob };

export type ContentFileEntry = { readonly path: string } & (
  { readonly bytes: Uint8Array; readonly source?: never }
  | { readonly source: ContentFileSource; readonly bytes?: never }
);

export interface ContentDigest { readonly bytes: number; readonly sha256: string; }
export interface ContentOperationProgress {
  readonly phase: "extracting" | "verifying" | "copying" | "committing";
  readonly path: string;
  readonly completedBytes: number;
  readonly totalBytes: number;
}
export interface ContentOperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ContentOperationProgress) => void;
}
export interface ContentArchiveEntry {
  readonly path: string;
  readonly bytes: number;
  readonly compressedBytes: number;
}
export interface ContentArchive {
  readonly entries: readonly ContentArchiveEntry[];
  extract(path: string, destination: string, options?: ContentOperationOptions): Promise<ContentDigest>;
  extractMany?(files: readonly { readonly path: string; readonly destination: string }[], options?: ContentOperationOptions): Promise<readonly ContentDigest[]>;
  close(): Promise<void>;
}
export interface ContentImportFile {
  readonly name: string;
  readonly size: number;
  readonly source: ContentFileSource;
}

export interface ContentPackageSource {
  readonly manifest: unknown;
  readonly receipt?: Readonly<Record<string, unknown>>;
  files(): AsyncIterable<ContentFileEntry>;
}

export interface ContentFileSystem {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  inspect?(paths: readonly string[], options?: ContentOperationOptions): Promise<readonly ContentDigest[]>;
  copy?(source: ContentFileSource, destination: string, options?: ContentOperationOptions): Promise<ContentDigest>;
  copyMany?(files: readonly { readonly source: ContentFileSource; readonly destination: string }[], options?: ContentOperationOptions): Promise<readonly ContentDigest[]>;
  openArchive?(source: ContentFileSource, options?: ContentOperationOptions): Promise<ContentArchive>;
  assetSource?(url: string): ContentFileSource | undefined;
  pickFile?(options?: ContentOperationOptions): Promise<ContentImportFile | null>;
}

export interface ResolvedContentAsset {
  readonly url: string;
  release?(): void;
}

export interface ContentAssetResolver {
  resolve(path: string, mediaType: string): Promise<ResolvedContentAsset>;
}

export interface ContentStorageCapabilities {
  readonly persistent: boolean;
  readonly canEstimateSpace: boolean;
  readonly canRequestPersistence: boolean;
  estimateAvailableBytes?(): Promise<number | null>;
  requestPersistence?(): Promise<boolean>;
}

export const CONTENT_PERSISTENCE_REFUSED_WARNING = "浏览器拒绝提供持久化存储，你的存档和数据可能被浏览器静默清理";

export interface ContentHost {
  readonly fileSystem: ContentFileSystem;
  readonly assetResolver: ContentAssetResolver;
  readonly capabilities: ContentStorageCapabilities;
}

export interface ContentHostProvider {
  readonly id: string;
  probe(): Promise<boolean>;
  open(): Promise<ContentHost>;
}

export interface InstalledContentPackage {
  readonly packageId: string;
  readonly currentRevision: string;
  readonly enabled: boolean;
}

export interface ContentInstallOptions {
  readonly signal?: AbortSignal;
  readonly onCommit?: () => void;
  readonly onIoProgress?: (progress: ContentOperationProgress) => void;
  readonly allowDowngrade?: boolean;
  readonly allowSameVersionReplacement?: boolean;
  readonly newPackagesEnabled?: boolean;
  readonly onProgress?: (progress: ContentInstallProgress) => void;
}

export interface ContentInstallProgress {
  readonly packageId: string;
  readonly path: string;
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface ContentInstallResult {
  readonly packages: readonly InstalledContentPackage[];
  readonly changed: boolean;
  readonly cleanup: "complete" | "deferred";
}

export interface ContentPackageMutationResult {
  readonly packages: readonly InstalledContentPackage[];
  readonly changed: boolean;
  readonly cleanup: "complete" | "deferred";
}

export interface ContentRepository {
  open(): Promise<void>;
  isEmpty(): Promise<boolean>;
  listPackages(): Promise<readonly InstalledContentPackage[]>;
  listPluginOrder(): Promise<readonly string[]>;
  setPluginOrder(order: readonly string[]): Promise<void>;
  readManifest(packageId: string): Promise<HocpkgManifest>;
  readFile(packageId: string, path: string): Promise<Uint8Array>;
  resolveAsset(packageId: string, path: string): Promise<ResolvedContentAsset>;
  verifyPackage(packageId: string, onProgress?: (progress: ContentInstallProgress) => void): Promise<void>;
  disablePackage(packageId: string): Promise<ContentPackageMutationResult>;
  enablePackage(packageId: string): Promise<ContentPackageMutationResult>;
  setEnabledPackages(packageIds: readonly string[]): Promise<ContentPackageMutationResult>;
  removePackage(packageId: string): Promise<ContentPackageMutationResult>;
  install(source: ContentPackageSource, options?: ContentInstallOptions): Promise<ContentInstallResult>;
  installBatch(sources: readonly ContentPackageSource[], options?: ContentInstallOptions): Promise<ContentInstallResult>;
}

export async function resolveContentHost(
  providers: readonly ContentHostProvider[]
): Promise<ContentHost | null> {
  for (const provider of providers) {
    if (await provider.probe()) return provider.open();
  }
  return null;
}
