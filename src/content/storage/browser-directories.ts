/** One I/O request owns this cache; later requests must reopen paths after cleanup. */
export function createBrowserDirectoryResolver(root: FileSystemDirectoryHandle, check: () => void = () => {}) {
  const handles = new Map<string, Promise<FileSystemDirectoryHandle>>();
  return async (parts: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> => {
    let parent = root;
    let path = "";
    for (const part of parts) {
      check();
      path += `/${part}`;
      // A read must never create a missing directory, even after a failed write.
      const key = `${create}:${path}`;
      let pending = handles.get(key);
      if (!pending) {
        pending = parent.getDirectoryHandle(part, { create });
        handles.set(key, pending);
      }
      try { parent = await pending; check(); }
      catch (error) {
        if (handles.get(key) === pending) handles.delete(key);
        throw error;
      }
    }
    return parent;
  };
}

export type BrowserDirectoryResolver = ReturnType<typeof createBrowserDirectoryResolver>;
