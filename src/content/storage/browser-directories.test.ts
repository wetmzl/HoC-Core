import { describe, expect, it, vi } from "vitest";
import { createBrowserDirectoryResolver } from "./browser-directories";

function directory() {
  const getDirectoryHandle = vi.fn<(name: string, options?: FileSystemGetDirectoryOptions) => Promise<FileSystemDirectoryHandle>>();
  return { getDirectoryHandle, handle: { getDirectoryHandle } as unknown as FileSystemDirectoryHandle };
}

describe("browser directory handles", () => {
  it("shares in-flight parent lookups across parallel files and sibling directories", async () => {
    const root = directory(), shared = directory(), left = directory(), right = directory();
    root.getDirectoryHandle.mockResolvedValue(shared.handle);
    shared.getDirectoryHandle.mockImplementation(async name => name === "left" ? left.handle : right.handle);
    const resolve = createBrowserDirectoryResolver(root.handle);
    expect(await Promise.all([resolve(["shared", "left"], true), resolve(["shared", "right"], true), resolve(["shared", "left"], true)]))
      .toEqual([left.handle, right.handle, left.handle]);
    expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
    expect(shared.getDirectoryHandle).toHaveBeenCalledTimes(2);
    expect(await resolve([], false)).toBe(root.handle);
  });

  it("preserves missing-directory errors, read/create semantics and retry after failure", async () => {
    const root = directory(), created = directory();
    const missing = new DOMException("missing", "NotFoundError");
    root.getDirectoryHandle.mockRejectedValueOnce(missing).mockResolvedValue(created.handle);
    const resolve = createBrowserDirectoryResolver(root.handle);
    await expect(resolve(["new"], false)).rejects.toBe(missing);
    expect(root.getDirectoryHandle).toHaveBeenLastCalledWith("new", { create: false });
    expect(await resolve(["new"], true)).toBe(created.handle);
    expect(root.getDirectoryHandle).toHaveBeenLastCalledWith("new", { create: true });
    expect(await resolve(["new"], false)).toBe(created.handle);
    expect(root.getDirectoryHandle).toHaveBeenLastCalledWith("new", { create: false });
    expect(root.getDirectoryHandle).toHaveBeenCalledTimes(3);
  });

  it("reopens a replaced directory in the next operation instead of retaining a stale handle", async () => {
    const root = directory(), old = directory(), replacement = directory();
    root.getDirectoryHandle.mockResolvedValueOnce(old.handle).mockResolvedValueOnce(replacement.handle);
    expect(await createBrowserDirectoryResolver(root.handle)(["revision"], true)).toBe(old.handle);
    expect(await createBrowserDirectoryResolver(root.handle)(["revision"], true)).toBe(replacement.handle);
  });
});
