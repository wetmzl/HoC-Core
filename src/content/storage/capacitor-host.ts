import { nativeIo } from "./native-io";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type {
  ContentAssetResolver,
  ContentFileSystem,
  ContentHost,
  ContentHostProvider,
  ResolvedContentAsset
} from "./contracts";

interface CapacitorFileInfo {
  readonly name: string;
  readonly type: "file" | "directory";
}

export interface CapacitorFilesystemPort {
  readFile(options: { readonly path: string; readonly directory: Directory }): Promise<{ readonly data: string | Blob }>;
  writeFile(options: { readonly path: string; readonly data: string; readonly directory: Directory; readonly recursive: boolean }): Promise<unknown>;
  readdir(options: { readonly path: string; readonly directory: Directory }): Promise<{ readonly files: readonly CapacitorFileInfo[] }>;
  stat(options: { readonly path: string; readonly directory: Directory }): Promise<{ readonly type: "file" | "directory" }>;
  deleteFile(options: { readonly path: string; readonly directory: Directory }): Promise<void>;
  rmdir(options: { readonly path: string; readonly directory: Directory; readonly recursive: boolean }): Promise<void>;
  getUri(options: { readonly path: string; readonly directory: Directory }): Promise<{ readonly uri: string }>;
}

function validatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length === 0 || parts.some((value) => !value || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value))) {
    throw new Error(`非法内容存储路径：${path}`);
  }
  return parts.join("/");
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return candidate.code === "OS-PLUG-FILE-0008"
    || (typeof candidate.message === "string" && /not found|does not exist|no such file/i.test(candidate.message));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class CapacitorContentFileSystem implements ContentFileSystem {
  constructor(private readonly files: CapacitorFilesystemPort = Filesystem) {}

  inspect = nativeIo.inspect;
  copy = nativeIo.copy;
  copyMany = nativeIo.copyMany;
  openArchive = nativeIo.openArchive;
  pickFile = nativeIo.pickFile;
  assetSource(url: string) { return url.startsWith("/") ? { kind: "asset" as const, path: url } : undefined; }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      const result = await this.files.readFile({ path: validatePath(path), directory: Directory.Data });
      if (typeof result.data !== "string") return new Uint8Array(await result.data.arrayBuffer());
      return base64ToBytes(result.data);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.files.writeFile({
      path: validatePath(path),
      data: bytesToBase64(bytes),
      directory: Directory.Data,
      recursive: true
    });
  }

  async list(prefix: string): Promise<readonly string[]> {
    const root = validatePath(prefix);
    const files: string[] = [];
    const visit = async (path: string): Promise<void> => {
      let entries: readonly CapacitorFileInfo[];
      try {
        entries = (await this.files.readdir({ path, directory: Directory.Data })).files;
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const child = `${path}/${entry.name}`;
        if (entry.type === "file") files.push(child);
        else await visit(child);
      }
    };
    await visit(root);
    return files.sort();
  }

  async remove(path: string): Promise<void> {
    const safePath = validatePath(path);
    try {
      const info = await this.files.stat({ path: safePath, directory: Directory.Data });
      if (info.type === "directory") await this.files.rmdir({ path: safePath, directory: Directory.Data, recursive: true });
      else await this.files.deleteFile({ path: safePath, directory: Directory.Data });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export class CapacitorContentAssetResolver implements ContentAssetResolver {
  constructor(private readonly files: CapacitorFilesystemPort = Filesystem) {}

  async resolve(path: string, _mediaType: string): Promise<ResolvedContentAsset> {
    const result = await this.files.getUri({ path: validatePath(path), directory: Directory.Data });
    return { url: Capacitor.convertFileSrc(result.uri) };
  }
}

export class CapacitorContentHostProvider implements ContentHostProvider {
  readonly id = "capacitor-filesystem";

  constructor(private readonly files: CapacitorFilesystemPort = Filesystem) {}

  async probe(): Promise<boolean> {
    return Capacitor.isNativePlatform();
  }

  async open(): Promise<ContentHost> {
    if (!await this.probe()) throw new Error("当前宿主不是 Capacitor 原生环境。");
    return {
      fileSystem: new CapacitorContentFileSystem(this.files),
      assetResolver: new CapacitorContentAssetResolver(this.files),
      capabilities: {
        persistent: true,
        canEstimateSpace: false,
        canRequestPersistence: false
      }
    };
  }
}
