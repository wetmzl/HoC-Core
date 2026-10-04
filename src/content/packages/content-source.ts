import type { ContentPackageSource, ContentRepository, ResolvedContentAsset } from "../storage/contracts";
import { decodeText, sha256Json } from "../storage/encoding";
import { getHocpkgPackageId } from "./package-state";
import { BuiltinPackageIndexSchema, HocpkgManifestSchema, type BuiltinPackageIndex, type HocpkgManifest } from "./schema";

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
  private indexPromise?: Promise<BuiltinPackageIndex>;

  constructor(private readonly options: EmbeddedContentSourceOptions = {}) {}

  loadIndex(): Promise<BuiltinPackageIndex> {
    if (!this.indexPromise) {
      const requestFetch = this.options.fetch ?? globalThis.fetch.bind(globalThis);
      const indexUrl = this.options.indexUrl ?? "/characters/packages.json";
      this.indexPromise = responseJson(requestFetch, indexUrl).then((value) => BuiltinPackageIndexSchema.parse(value));
    }
    return this.indexPromise;
  }

  async packages(): Promise<readonly ContentPackageAccess[]> {
    const requestFetch = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const indexUrl = this.options.indexUrl ?? "/characters/packages.json";
    const index = await this.loadIndex();
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
          for (const file of manifest.files) yield { path: file.path, bytes: await responseBytes(requestFetch, resolveUrl(packageBaseUrl, file.path)) };
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
