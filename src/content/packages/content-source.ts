import type { ContentFileSource, ContentPackageSource, ContentRepository, ResolvedContentAsset } from "../storage/contracts";
import { decodeText, sha256Json } from "../storage/encoding";
import { getHocpkgPackageId } from "./package-state";
import { BuiltinPackageIndexSchema, HocpkgManifestSchema, type BuiltinPackageIndex, type HocpkgManifest } from "./schema";
import { z } from "zod";
import { encodeText, sha256 } from "../storage/encoding";
import { boundedContentJson } from "./json-budget";

const embeddedDescriptorSchema = z.object({
  identity: z.unknown(), metadata: z.unknown(), resources: z.unknown(), files: z.unknown(), extensions: z.record(z.string(), z.unknown()),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  base: z.string().regex(/^\/embedded\/[a-f0-9]{64}\/$/),
  startup: z.record(z.string(), z.string())
}).strict();
const embeddedDocumentSchema = boundedContentJson(z.object({
  format: z.literal("house-of-chances-embedded-content"), formatVersion: z.literal(1),
  abilityCatalogVersion: z.string(), defaultCharacterId: z.string(), playerSkillOrder: z.array(z.string()),
  defaultEnabled: z.array(z.string()).optional(),
  packages: z.array(embeddedDescriptorSchema).max(4096)
}).strict());

export interface ContentPackageAccess extends ContentPackageSource {
  readonly manifest: HocpkgManifest;
  readonly packageId: string;
  readJson(path: string): Promise<unknown>;
  readFile?(path: string): Promise<Uint8Array>;
  resolveAsset(path: string): Promise<ResolvedContentAsset>;
}

export interface ContentSource {
  packages(): Promise<readonly ContentPackageAccess[]>;
}

async function responseBytes(requestFetch: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await requestFetch(url, { cache: "no-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`内容读取失败：${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function responseJson(requestFetch: typeof fetch, url: string): Promise<unknown> {
  const response = await requestFetch(url, { cache: "no-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`内容读取失败：${url} (${response.status})`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) throw new Error(`内容响应格式无效：${url}`);
  return response.json() as Promise<unknown>;
}

function directoryUrl(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1);
}

function resolveUrl(base: string, path: string): string {
  const resolved = new URL(path, new URL(base, "https://content.invalid/"));
  const baseUrl = new URL(base, "https://content.invalid/");
  if (resolved.origin !== baseUrl.origin || !resolved.pathname.startsWith(baseUrl.pathname)) throw new Error(`资源路径越出内容包：${path}`);
  return base.startsWith("/") ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href;
}

export interface EmbeddedContentSourceOptions {
  readonly indexUrl?: string;
  readonly fetch?: typeof fetch;
}

export class EmbeddedContentSource implements ContentSource {
  assetSource?: (url: string) => ContentFileSource | undefined;
  /** Reuse verified archived bytes without activating archived definitions. */
  assetFallback?: (packageId: string, file: HocpkgManifest["files"][number], url: string) => Promise<ResolvedContentAsset | undefined>;
  private indexPromise?: Promise<BuiltinPackageIndex>;
  private packagePromise?: Promise<readonly ContentPackageAccess[]>;
  private document?: z.infer<typeof embeddedDocumentSchema>;

  constructor(private readonly options: EmbeddedContentSourceOptions = {}) {}

  loadIndex(): Promise<BuiltinPackageIndex> {
    if (!this.indexPromise) {
      const requestFetch = this.options.fetch ?? globalThis.fetch.bind(globalThis);
      this.indexPromise = (async () => {
        const indexUrl = this.options.indexUrl ?? "/embedded/content.json";
        let response = await requestFetch(indexUrl, { credentials: "same-origin" });
        // Development/test authoring inputs are not shipped as the runtime distribution.
        if (response.status === 404 && !this.options.indexUrl && (import.meta.env.DEV || import.meta.env.MODE === "test")) {
          response = await requestFetch("/characters/packages.json");
        }
        if (!response.ok) throw new Error(`内容索引读取失败 (${response.status})`);
        const value = await response.json();
        if (value.format !== "house-of-chances-embedded-content") return BuiltinPackageIndexSchema.parse(value);
        this.document = embeddedDocumentSchema.parse(value);
        return BuiltinPackageIndexSchema.parse({
          ...value, format: "house-of-chances-builtin-package-index", formatVersion: 2,
          packages: this.document.packages.map(entry => ({
            packageId: getHocpkgPackageId(this.manifestFor(entry).identity), version: this.manifestFor(entry).identity.version,
            manifest: `${entry.contentDigest}/hocpkg-info.json`, contentDigest: entry.contentDigest,
            bytes: this.manifestFor(entry).files.reduce((total, file) => total + file.bytes, 0)
          }))
        });
      })().catch(error => { this.indexPromise = undefined; this.document = undefined; throw error; });
    }
    return this.indexPromise;
  }

  private manifestFor(entry: z.infer<typeof embeddedDescriptorSchema>): HocpkgManifest {
    return HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
      identity: entry.identity, metadata: entry.metadata, resources: entry.resources, files: entry.files, extensions: entry.extensions });
  }

  packages(): Promise<readonly ContentPackageAccess[]> {
    return this.packagePromise ??= this.loadPackages().catch(error => { this.packagePromise = undefined; throw error; });
  }

  private async loadPackages(): Promise<readonly ContentPackageAccess[]> {
    const owner = this;
    const requestFetch = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const assetSource = this.assetSource;
    const indexUrl = this.options.indexUrl ?? "/characters/packages.json";
    const index = await this.loadIndex();
    if (this.document) return Promise.all(this.document.packages.map(async entry => {
      const { base: _base, startup: _startup, contentDigest, ...descriptor } = entry;
      if (await sha256Json(descriptor) !== contentDigest || entry.base !== `/embedded/${contentDigest}/`) throw new Error("内嵌描述摘要不一致。");
      const manifest = this.manifestFor(entry), packageId = getHocpkgPackageId(manifest.identity);
      const readFile = async (path: string) => {
        const file = manifest.files.find(file => file.path === path);
        if (!file) throw new Error(`未声明内容文件：${packageId}#${path}`);
        const bytes = Object.hasOwn(entry.startup, path) ? encodeText(entry.startup[path]!) : await responseBytes(requestFetch, resolveUrl(entry.base, path));
        if (bytes.length !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error(`内嵌文件校验失败：${packageId}#${path}`);
        return bytes;
      };
      return { packageId, manifest, receipt: { source: "embedded" }, readFile,
        readJson: async (path: string) => JSON.parse(decodeText(await readFile(path))),
        async *files() { for (const file of manifest.files) yield { path: file.path, bytes: await readFile(file.path) }; },
        async resolveAsset(path: string) {
          const file = manifest.files.find(file => file.path === path);
          if (!file) throw new Error(`未声明内容文件：${packageId}#${path}`);
          const url = resolveUrl(entry.base, path);
          return await owner.assetFallback?.(packageId, file, url) ?? { url };
        }
      } satisfies ContentPackageAccess;
    }));
    const indexBase = directoryUrl(indexUrl);
    return Promise.all(index.packages.map(async (entry) => {
      const manifestUrl = resolveUrl(indexBase, entry.manifest);
      const packageBaseUrl = directoryUrl(manifestUrl);
      const manifest = HocpkgManifestSchema.parse(await responseJson(requestFetch, manifestUrl));
      const packageId = getHocpkgPackageId(manifest.identity);
      if (packageId !== entry.packageId || manifest.identity.version !== entry.version) throw new Error(`内嵌索引与 Manifest 不一致：${entry.packageId}`);
      const revision = await sha256Json({ ...manifest, files: [...manifest.files].sort((left, right) => left.path.localeCompare(right.path)) });
      if (revision !== entry.contentDigest) throw new Error(`内嵌索引摘要与 Manifest 不一致：${entry.packageId}`);
      return {
        packageId,
        manifest,
        receipt: { source: "embedded" },
        async *files() {
          for (const file of manifest.files) {
            const url = resolveUrl(packageBaseUrl, file.path);
            const source = assetSource?.(url);
            if (source) yield { path: file.path, source };
            else yield { path: file.path, bytes: await responseBytes(requestFetch, url) };
          }
        },
        readJson: (path: string) => responseJson(requestFetch, resolveUrl(packageBaseUrl, path)),
        readFile: (path: string) => responseBytes(requestFetch, resolveUrl(packageBaseUrl, path)),
        async resolveAsset(path: string) { return { url: resolveUrl(packageBaseUrl, path) }; }
      } satisfies ContentPackageAccess;
    }));
  }
}

export class RepositoryContentSource implements ContentSource {
  constructor(private readonly repository: ContentRepository) {}

  async packages(): Promise<readonly ContentPackageAccess[]> {
    await this.repository.open();
    const installed = (await this.repository.listPackages()).filter((entry) => entry.enabled);
    return Promise.all(installed.map(async ({ packageId }) => {
      const repository = this.repository;
      const manifest = await this.repository.readManifest(packageId);
      return {
        packageId,
        manifest,
        async *files() {
          for (const file of manifest.files) yield { path: file.path, bytes: await repository.readFile(packageId, file.path) };
        },
        async readJson(path: string) {
          return JSON.parse(decodeText(await repository.readFile(packageId, path))) as unknown;
        },
        readFile: (path: string) => repository.readFile(packageId, path),
        resolveAsset: (path: string) => repository.resolveAsset(packageId, path)
      } satisfies ContentPackageAccess;
    }));
  }
}
