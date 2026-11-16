/** Device-local import credentials, deliberately separate from game saves/content. */
export const PASSWORD_BOOK_KEY = "hoc.import-passwords.v1";
export const MAX_PASSWORDS = 128;
export const MAX_PASSWORD_LENGTH = 1024;
export const BUILTIN_IMPORT_PASSWORDS: readonly string[] = Object.freeze(["welcome2hoc"]);

/** Defaults apply to existing installations too, without rewriting personal entries. */
export function importPasswordCandidates(personal: readonly string[] = []): string[] {
  return [...new Set([...personal, ...BUILTIN_IMPORT_PASSWORDS])];
}

export class PasswordBook {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}
  list(): string[] {
    const raw = this.storage.getItem(PASSWORD_BOOK_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_PASSWORDS || parsed.some(item => typeof item !== "string" || !item.length || item.length > MAX_PASSWORD_LENGTH)) throw new Error("密码本无法读取，可清空后重新添加。");
    return [...new Set(parsed as string[])];
  }
  add(password: string): void {
    if (!password.length || password.length > MAX_PASSWORD_LENGTH) throw new Error("密码长度须为 1–1024 个字符。");
    const values = this.list();
    if (values.includes(password)) return;
    if (values.length >= MAX_PASSWORDS) throw new Error("密码本已满，请先删除部分密码。");
    this.storage.setItem(PASSWORD_BOOK_KEY, JSON.stringify([...values, password]));
  }
  remove(index: number): void { this.storage.setItem(PASSWORD_BOOK_KEY, JSON.stringify(this.list().filter((_, i) => i !== index))); }
  clear(): void { this.storage.removeItem(PASSWORD_BOOK_KEY); }
}
