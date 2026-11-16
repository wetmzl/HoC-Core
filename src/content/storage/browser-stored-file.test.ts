import { describe, expect, it, vi } from "vitest";
import { createBrowserStoredFileReader } from "./browser-stored-file";

class Directory {
  readonly directories = new Map<string, Directory>();
  readonly files = new Map<string, File>();
  readonly getDirectoryHandle = vi.fn(async (name: string): Promise<Directory> => {
    const directory = this.directories.get(name);
    if (!directory) throw new DOMException("missing", "NotFoundError");
    return directory;
  });
  readonly getFileHandle = vi.fn(async (name: string) => {
    const file = this.files.get(name);
    if (!file) throw new DOMException("missing", "NotFoundError");
    return { getFile: async () => file };
  });

  child(name: string): Directory {
    const directory = new Directory();
    this.directories.set(name, directory);
    return directory;
  }
}

const reader = (root: Directory, check = () => {}) => createBrowserStoredFileReader(root as unknown as FileSystemDirectoryHandle, check);

describe("browser stored file reads", () => {
  it("reads distinct bytes while sharing directory lookups, including concurrent paths", async () => {
    const root = new Directory();
    const content = root.child("content");
    const revision = content.child("revision");
    const images = revision.child("images");
    const audio = revision.child("audio");
    images.files.set("first.bin", new File([Uint8Array.of(0, 255)], "first.bin"));
    images.files.set("second.bin", new File([Uint8Array.of(127, 128)], "second.bin"));
    audio.files.set("third.bin", new File([Uint8Array.of(1, 2, 3)], "third.bin"));

    const read = reader(root);
    const files = await Promise.all([
      read("content/revision/images/first.bin"),
      read("content/revision/images/second.bin"),
      read("content/revision/audio/third.bin")
    ]);
    expect(await Promise.all(files.map(async file => [...new Uint8Array(await file.arrayBuffer())]))).toEqual([[0, 255], [127, 128], [1, 2, 3]]);
    expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
    expect(content.getDirectoryHandle).toHaveBeenCalledTimes(1);
    expect(revision.getDirectoryHandle).toHaveBeenCalledTimes(2);
    expect(images.getFileHandle).toHaveBeenCalledTimes(2);
    expect(audio.getFileHandle).toHaveBeenCalledTimes(1);
  });

  it("refreshes handles for a new operation after a directory is replaced", async () => {
    const root = new Directory();
    root.child("revision").files.set("image.bin", new File([Uint8Array.of(1)], "image.bin"));
    const first = await reader(root)("revision/image.bin");
    root.child("revision").files.set("image.bin", new File([Uint8Array.of(2)], "image.bin"));
    const second = await reader(root)("revision/image.bin");
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([1]);
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([2]);
    expect(root.getDirectoryHandle).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe paths before traversal and reports missing directories and files", async () => {
    const root = new Directory();
    root.child("revision");
    const read = reader(root);
    for (const path of ["", "/image.bin", "revision/../image.bin", "revision/./image.bin", "revision//image.bin", "revision/image%2f.bin"]) {
      await expect(read(path)).rejects.toThrow("非法内容路径");
    }
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
    await expect(read("missing/image.bin")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(read("revision/missing.bin")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("honors cancellation after a pending directory lookup before reading any file", async () => {
    const root = new Directory();
    const revision = root.child("revision");
    let finish!: (directory: Directory) => void;
    root.getDirectoryHandle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const result = reader(root, () => controller.signal.throwIfAborted())("revision/image.bin");
    const cancelled = expect(result).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    finish(revision);
    await cancelled;
    expect(revision.getFileHandle).not.toHaveBeenCalled();
  });
});
