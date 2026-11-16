import type { ContentArchive, ContentImportOptions, ContentOperationOptions } from "./contracts";
import { checkCancelled } from "./file-operations";

export const PASSWORD_REQUIRED = "ZIP_PASSWORD_REQUIRED";
export const INVALID_PASSWORD = "ZIP_INVALID_PASSWORD";
export function passwordError(code: string): Error & { code: string } {
  return Object.assign(new Error(code === PASSWORD_REQUIRED ? "此 ZIP 需要密码。" : "密码不匹配，或加密内容已损坏。"), { code });
}
function isPasswordError(error: unknown): boolean {
  return error instanceof Error && [PASSWORD_REQUIRED, INVALID_PASSWORD].includes((error as Error & { code?: string }).code ?? "");
}

/** One session: credentials never enter the persisted candidate/session records. */
export function archiveUnlocker(options: ContentImportOptions) {
  const accepted = new Set<string>();
  const remembered = new Set<string>();
  return (archive: ContentArchive, source: string): ContentArchive => {
    const passwords = new Map<string, string>();
    const extract: ContentArchive["extract"] = async (path, destination, ioOptions) => {
      const entry = archive.entries.find(item => item.path === path);
      if (!entry?.encrypted) return archive.extract(path, destination, ioOptions);
      const candidates = [...new Set([...(passwords.has(path) ? [passwords.get(path)!] : []), ...accepted, ...(options.passwords ?? [])])];
      let failed = false;
      const attempt = async (password: string, remember = false) => {
        checkCancelled(options);
        const result = await archive.extract(path, destination, { ...ioOptions, password });
        checkCancelled(options);
        passwords.set(path, password);
        accepted.add(password);
        if (remember && !remembered.has(password)) { options.rememberPassword?.(password); remembered.add(password); }
        return result;
      };
      for (const [index, password] of candidates.entries()) {
        options.onProgress?.({ phase: "unlocking", path: source, completedBytes: index + 1, totalBytes: candidates.length });
        try { return await attempt(password); }
        catch (error) { checkCancelled(options); if (!isPasswordError(error)) throw error; failed = true; }
      }
      while (true) {
        checkCancelled(options);
        if (!options.requestPassword) throw passwordError(failed ? INVALID_PASSWORD : PASSWORD_REQUIRED);
        const answer = await options.requestPassword({ source, entry: path, failed });
        checkCancelled(options);
        if (!answer) throw new Error("已跳过加密包，未安装其中内容。");
        try { return await attempt(answer.password, answer.remember); }
        catch (error) { checkCancelled(options); if (!isPasswordError(error)) throw error; failed = true; }
      }
    };
    return { entries: archive.entries, extract,
      async extractMany(files, ioOptions?: ContentOperationOptions) {
        const results = [];
        // Preserve the native batch path for ordinary archives.
        if (!archive.entries.some(entry => entry.encrypted) && archive.extractMany) return archive.extractMany(files, ioOptions);
        for (const file of files) results.push(await extract(file.path, file.destination, ioOptions));
        return results;
      }, close: () => archive.close() };
  };
}
