import { createBrowserDirectoryResolver } from "./browser-directories";

/** Directory handles are reused only while one readonly worker operation is active. */
export function createBrowserStoredFileReader(root: FileSystemDirectoryHandle, check: () => void): (path: string) => Promise<File> {
  const directory = createBrowserDirectoryResolver(root, check);

  return async (path) => {
    check();
    const parts = path.split("/");
    if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) throw new Error("非法内容路径。");
    const parent = await directory(parts.slice(0, -1), false);
    check();
    const handle = await parent.getFileHandle(parts.at(-1)!);
    check();
    const file = await handle.getFile();
    check();
    return file;
  };
}
