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

  it("selects the first capable injected provider without platform enums", async () => {
    const unavailable: ContentHostProvider = { id: "unavailable", probe: async () => false, open: async () => { throw new Error("unused"); } };
    const selected = new MemoryContentHostProvider();
    const fallback = new MemoryContentHostProvider();
    await expect(resolveContentHost([unavailable, selected, fallback])).resolves.toBe(selected.host);
    await expect(resolveContentHost([unavailable])).resolves.toBeNull();
  });
});
