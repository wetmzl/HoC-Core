import { browserIo, openBrowserArchive } from "./browser-io";
import type { ContentFileSource, ContentOperationOptions, ContentDigest } from "./contracts";
import type {
  ContentAssetResolver,
  ContentFileSystem,
  ContentHost,
  ContentHostProvider,
  ContentStorageCapabilities,
  ResolvedContentAsset
} from "./contracts";

function segments(path: string): readonly string[] {
  const values = path.split("/");
  if (values.length === 0 || values.some((value) => !value || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value))) {
    throw new Error(`非法内容存储路径：${path}`);
  }
  return values;
}

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

export class OpfsContentFileSystem implements ContentFileSystem {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  assetSource(url: string) { return url.startsWith("/") ? { kind: "asset" as const, path: url } : undefined; }

  inspect(paths: readonly string[], options?: ContentOperationOptions): Promise<readonly ContentDigest[]> {
    return browserIo({ action: "inspect", paths }, options);
  }

  copy(source: ContentFileSource, destination: string, options?: ContentOperationOptions): Promise<ContentDigest> {
    return browserIo({ action: "copy", source, destination }, options);
  }

  copyMany(files: readonly { readonly source: ContentFileSource; readonly destination: string }[], options?: ContentOperationOptions): Promise<readonly ContentDigest[]> {
    return browserIo({ action: "copyMany", files }, options);
  }

  openArchive(source: ContentFileSource, options?: ContentOperationOptions) {
    return openBrowserArchive(this, source, options, true);
  }

  private async directory(path: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let current = this.root;
    for (const part of path) current = await current.getDirectoryHandle(part, { create });
    return current;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const parts = segments(path);
    try {
      const parent = await this.directory(parts.slice(0, -1), false);
      const handle = await parent.getFileHandle(parts.at(-1)!, { create: false });
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const parts = segments(path);
    const parent = await this.directory(parts.slice(0, -1), true);
    const handle = await parent.getFileHandle(parts.at(-1)!, { create: true });
    const writable = await handle.createWritable();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await writable.write(copy);
    await writable.close();
  }

  async list(prefix: string): Promise<readonly string[]> {
    const parts = segments(prefix);
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await this.directory(parts, false);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const files: string[] = [];
    const visit = async (current: FileSystemDirectoryHandle, path: string): Promise<void> => {
      const entries = (current as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries();
      for await (const [name, handle] of entries) {
        const child = `${path}/${name}`;
        if (handle.kind === "file") files.push(child);
        else await visit(handle as FileSystemDirectoryHandle, child);
      }
    };
    await visit(directory, parts.join("/"));
    return files.sort();
  }

  async remove(path: string): Promise<void> {
    const parts = segments(path);
    try {
      const parent = await this.directory(parts.slice(0, -1), false);
      await parent.removeEntry(parts.at(-1)!, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export class OpfsContentAssetResolver implements ContentAssetResolver {
  private readonly urls = new Set<string>();

  constructor(private readonly fileSystem: ContentFileSystem) {}

  async resolve(path: string, mediaType: string): Promise<ResolvedContentAsset> {
    const bytes = await this.fileSystem.read(path);
    if (!bytes) throw new Error(`内容资源不存在：${path}`);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: mediaType }));
    this.urls.add(url);
    return {
      url,
      release: () => {
        if (!this.urls.delete(url)) return;
        URL.revokeObjectURL(url);
      }
    };
  }

  releaseAll(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

function capabilities(storage: StorageManager): ContentStorageCapabilities {
  return {
    persistent: true,
    canEstimateSpace: typeof storage.estimate === "function",
    canRequestPersistence: typeof storage.persist === "function",
    estimateAvailableBytes: typeof storage.estimate === "function" ? async () => {
      const estimate = await storage.estimate();
      return estimate.quota === undefined ? null : Math.max(0, estimate.quota - (estimate.usage ?? 0));
    } : undefined,
    requestPersistence: typeof storage.persist === "function" ? () => storage.persist() : undefined
  };
}

export class OpfsContentHostProvider implements ContentHostProvider {
  readonly id = "opfs";

  async probe(): Promise<boolean> {
    return typeof navigator !== "undefined"
      && globalThis.isSecureContext !== false
      && typeof navigator.storage?.getDirectory === "function";
  }

  async open(): Promise<ContentHost> {
    if (!await this.probe()) throw new Error("当前宿主不支持 OPFS 内容存储。");
    const fileSystem = new OpfsContentFileSystem(await navigator.storage.getDirectory());
    return {
      fileSystem,
      assetResolver: new OpfsContentAssetResolver(fileSystem),
      capabilities: capabilities(navigator.storage)
    };
  }
}
