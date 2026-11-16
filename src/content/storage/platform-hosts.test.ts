import { describe, expect, it, vi } from "vitest";
import { Directory } from "@capacitor/filesystem";
import { CapacitorContentAssetResolver, CapacitorContentFileSystem, type CapacitorFilesystemPort } from "./capacitor-host";
import { resolveContentHost, type ContentHostProvider } from "./contracts";
import { MemoryContentHostProvider } from "./memory-host";
import { OpfsContentAssetResolver, OpfsContentFileSystem } from "./opfs-host";

class FakeFileHandle {
  readonly kind = "file" as const;
  bytes = new Uint8Array();

  async getFile(): Promise<File> { return new File([this.bytes], "file"); }
  async createWritable() {
    return {
      write: async (value: BufferSource | Blob | string) => {
        if (typeof value === "string") this.bytes = new TextEncoder().encode(value);
        else if (value instanceof Blob) this.bytes = new Uint8Array(await value.arrayBuffer());
        else this.bytes = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      },
      close: async () => undefined
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const current = this.children.get(name);
    if (current instanceof FakeDirectoryHandle) return current;
    if (current || !options?.create) throw new DOMException("missing", "NotFoundError");
    const directory = new FakeDirectoryHandle();
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const current = this.children.get(name);
    if (current instanceof FakeFileHandle) return current;
    if (current || !options?.create) throw new DOMException("missing", "NotFoundError");
    const file = new FakeFileHandle();
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException("missing", "NotFoundError");
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    yield* this.children.entries();
  }
}

class FakeCapacitorFiles implements CapacitorFilesystemPort {
  readonly entries = new Map<string, Uint8Array>();

  async readFile({ path }: { path: string; directory: Directory }): Promise<{ data: string }> {
    const bytes = this.entries.get(path);
    if (!bytes) throw Object.assign(new Error("not found"), { code: "OS-PLUG-FILE-0008" });
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { data: btoa(binary) };
  }

  async writeFile({ path, data }: { path: string; data: string; directory: Directory; recursive: boolean }): Promise<void> {
    const binary = atob(data);
    this.entries.set(path, Uint8Array.from(binary, (value) => value.charCodeAt(0)));
  }

  async readdir({ path }: { path: string; directory: Directory }) {
    const prefix = `${path}/`;
    const children = new Map<string, "file" | "directory">();
    for (const entry of this.entries.keys()) {
      if (!entry.startsWith(prefix)) continue;
      const rest = entry.slice(prefix.length);
      const [name, tail] = rest.split(/\/(.*)/s);
      if (name) children.set(name, tail ? "directory" : "file");
    }
    if (children.size === 0 && ![...this.entries.keys()].some((entry) => entry.startsWith(prefix))) {
      throw Object.assign(new Error("not found"), { code: "OS-PLUG-FILE-0008" });
    }
    return { files: [...children].map(([name, type]) => ({ name, type })) };
  }

  async stat({ path }: { path: string; directory: Directory }): Promise<{ type: "file" | "directory" }> {
    if (this.entries.has(path)) return { type: "file" };
    if ([...this.entries.keys()].some((entry) => entry.startsWith(`${path}/`))) return { type: "directory" };
    throw Object.assign(new Error("not found"), { code: "OS-PLUG-FILE-0008" });
  }

  async deleteFile({ path }: { path: string; directory: Directory }): Promise<void> { this.entries.delete(path); }
  async rmdir({ path }: { path: string; directory: Directory; recursive: boolean }): Promise<void> {
    for (const entry of this.entries.keys()) if (entry.startsWith(`${path}/`)) this.entries.delete(entry);
  }
  async getUri({ path }: { path: string; directory: Directory }): Promise<{ uri: string }> { return { uri: `file:///data/${path}` }; }
}

describe("content host providers", () => {
  it("lists immediate directories without visiting their descendants on both native hosts", async () => {
    const root = new FakeDirectoryHandle();
    const files = new FakeCapacitorFiles();
    const opfs = new OpfsContentFileSystem(root as unknown as FileSystemDirectoryHandle);
    const capacitor = new CapacitorContentFileSystem(files);
    for (const fs of [opfs, capacitor]) {
      await fs.write("imports/first/media/deep/image.bin", Uint8Array.of(1));
      await fs.write("imports/second/session.json", Uint8Array.of(2));
      await fs.write("imports/unrelated.json", Uint8Array.of(3));
    }
    const first = await (await root.getDirectoryHandle("imports")).getDirectoryHandle("first");
    const nested = vi.spyOn(first, "entries");
    const readdir = vi.spyOn(files, "readdir");
    await expect(opfs.listDirectories("imports")).resolves.toEqual(["imports/first", "imports/second"]);
    expect(nested).not.toHaveBeenCalled();
    await expect(capacitor.listDirectories("imports")).resolves.toEqual(["imports/first", "imports/second"]);
    expect(readdir.mock.calls).toEqual([[{ path: "imports", directory: Directory.Data }]]);
    await expect(opfs.listDirectories("missing")).resolves.toEqual([]);
    await expect(capacitor.listDirectories("missing")).resolves.toEqual([]);
    await expect(opfs.listDirectories("../imports")).rejects.toThrow("非法内容存储路径");
    await expect(capacitor.listDirectories("../imports")).rejects.toThrow("非法内容存储路径");
  });

  it("persists, lists, resolves, and removes OPFS content", async () => {
    const root = new FakeDirectoryHandle();
    const fileSystem = new OpfsContentFileSystem(root as unknown as FileSystemDirectoryHandle);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-content");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      await fileSystem.write("content/v1/revisions/a/b/file.bin", Uint8Array.of(1, 2, 3));
      await expect(fileSystem.read("content/v1/revisions/a/b/file.bin")).resolves.toEqual(Uint8Array.of(1, 2, 3));
      await expect(fileSystem.list("content/v1/revisions")).resolves.toEqual(["content/v1/revisions/a/b/file.bin"]);
      const resolver = new OpfsContentAssetResolver(fileSystem);
      const asset = await resolver.resolve("content/v1/revisions/a/b/file.bin", "application/octet-stream");
      expect(asset.url).toBe("blob:test-content");
      asset.release?.();
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-content");
      await fileSystem.remove("content/v1/revisions/a");
      await expect(fileSystem.list("content/v1/revisions")).resolves.toEqual([]);
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it("persists binary files through the Capacitor base64 boundary", async () => {
    const files = new FakeCapacitorFiles();
    const fileSystem = new CapacitorContentFileSystem(files);
    await fileSystem.write("content/v1/revisions/a/b/file.bin", Uint8Array.of(0, 127, 255));
    await expect(fileSystem.read("content/v1/revisions/a/b/file.bin")).resolves.toEqual(Uint8Array.of(0, 127, 255));
    await expect(fileSystem.list("content/v1/revisions")).resolves.toEqual(["content/v1/revisions/a/b/file.bin"]);
    const asset = await new CapacitorContentAssetResolver(files).resolve("content/v1/revisions/a/b/file.bin", "application/octet-stream");
    expect(asset.url).toBe("file:///data/content/v1/revisions/a/b/file.bin");
    await fileSystem.remove("content/v1/revisions/a");
    await expect(fileSystem.list("content/v1/revisions")).resolves.toEqual([]);
  });

  it("resolves OPFS media without reading its bytes and retains URLs until released", async () => {
    const root = new FakeDirectoryHandle();
    const fileSystem = new OpfsContentFileSystem(root as unknown as FileSystemDirectoryHandle);
    const bytes = Uint8Array.of(0, 127, 255, 2);
    await fileSystem.write("revision/image.bin", bytes);
    const read = vi.spyOn(fileSystem, "read");
    const arrayBuffer = vi.spyOn(File.prototype, "arrayBuffer");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const resolver = new OpfsContentAssetResolver(fileSystem);
    try {
      const first = await resolver.resolve("revision/image.bin", "image/png");
      const second = await resolver.resolve("revision/image.bin", "application/octet-stream");
      expect(read).not.toHaveBeenCalled();
      expect(arrayBuffer).not.toHaveBeenCalled();
      const response = await fetch(first.url);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      first.release?.();
      first.release?.();
      expect(revoke).toHaveBeenCalledExactlyOnceWith(first.url);
      await expect(fetch(first.url)).rejects.toThrow();
      expect(new Uint8Array(await (await fetch(second.url)).arrayBuffer())).toEqual(bytes);
      resolver.releaseAll();
      resolver.releaseAll();
      second.release?.();
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenLastCalledWith(second.url);
      await expect(fetch(second.url)).rejects.toThrow();
    } finally {
      resolver.releaseAll();
      read.mockRestore();
      arrayBuffer.mockRestore();
      revoke.mockRestore();
    }
  });

  it("reports missing OPFS assets and still supports byte-only injected hosts", async () => {
    const fileSystem = new OpfsContentFileSystem(new FakeDirectoryHandle() as unknown as FileSystemDirectoryHandle);
    await expect(fileSystem.readBlob("missing/image.bin")).resolves.toBeNull();
    await expect(fileSystem.read("missing/image.bin")).resolves.toBeNull();
    await expect(fileSystem.readBlob("../image.bin")).rejects.toThrow("非法内容存储路径");
    await expect(new OpfsContentAssetResolver(fileSystem).resolve("missing/image.bin", "image/png")).rejects.toThrow("内容资源不存在");

    const memory = new MemoryContentHostProvider().host.fileSystem;
    await memory.write("image.bin", Uint8Array.of(9, 0, 255));
    const resolver = new OpfsContentAssetResolver(memory);
    const asset = await resolver.resolve("image.bin", "image/png");
    try {
      const response = await fetch(asset.url);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(9, 0, 255));
      await expect(resolver.resolve("missing.bin", "image/png")).rejects.toThrow("内容资源不存在");
    } finally {
      resolver.releaseAll();
    }
  });

  it("selects the first capable injected provider without platform enums", async () => {
    const unavailable: ContentHostProvider = { id: "unavailable", probe: async () => false, open: async () => { throw new Error("unused"); } };
    const selected = new MemoryContentHostProvider();
    const fallback = new MemoryContentHostProvider();
    await expect(resolveContentHost([unavailable, selected, fallback])).resolves.toBe(selected.host);
    await expect(resolveContentHost([unavailable])).resolves.toBeNull();
  });
});
