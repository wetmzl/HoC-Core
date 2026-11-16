import { openUiDialog, closeUiDialog } from "./presentation/dialog-motion";
import type { ArchivePasswordRequest } from "./content/storage/contracts";
import { MAX_PASSWORD_LENGTH, PasswordBook } from "./content/storage/password-book";

const passwordEyeIcon = (visible: boolean) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${visible ? '<path d="m3 3 18 18"/>' : ""}</svg>`;
const passwordTrashIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>`;

export function requestImportPassword(request: ArchivePasswordRequest, signal?: AbortSignal): Promise<{ password: string; remember: boolean } | null> {
  signal?.throwIfAborted();
  const dialog = document.createElement("dialog");
  dialog.className = "modal game-dialog import-password-dialog";
  dialog.setAttribute("aria-label", "解锁加密 ZIP");
  dialog.innerHTML = `<h2>解锁加密 ZIP</h2><p data-password-source></p><p data-password-entry></p><p role="status"></p><form><label>密码<input type="password" name="password" autocomplete="off" required maxlength="${MAX_PASSWORD_LENGTH}" autofocus></label><label><input type="checkbox" name="remember">保存到本机密码本</label><div class="game-dialog-actions"><button type="submit" class="primary-button">解锁</button><button type="button" class="secondary-button" data-password-skip>跳过此包</button><button type="button" class="secondary-button" data-password-cancel>取消整个导入</button></div></form>`;
  dialog.querySelector("[data-password-source]")!.textContent = request.source;
  dialog.querySelector("[data-password-entry]")!.textContent = `文件：${request.entry}`;
  dialog.querySelector('[role="status"]')!.textContent = request.failed ? "已有密码均未能解锁。请重试；若密码确认无误，文件可能已损坏。" : "密码本中没有可用密码，请输入此包的密码。";
  document.body.append(dialog);
  return new Promise((resolve, reject) => {
    let answer: { password: string; remember: boolean } | null = null;
    let cancelled = false;
    const abort = () => { cancelled = true; dialog.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    dialog.querySelector("form")!.addEventListener("submit", event => {
      event.preventDefault();
      answer = { password: dialog.querySelector<HTMLInputElement>('[name="password"]')!.value, remember: dialog.querySelector<HTMLInputElement>('[name="remember"]')!.checked };
      void closeUiDialog(dialog);
    });
    dialog.querySelector("[data-password-skip]")!.addEventListener("click", () => { void closeUiDialog(dialog); });
    dialog.querySelector("[data-password-cancel]")!.addEventListener("click", abort);
    dialog.addEventListener("cancel", event => { event.preventDefault(); abort(); });
    dialog.addEventListener("close", () => {
      signal?.removeEventListener("abort", abort);
      dialog.querySelector<HTMLInputElement>('[name="password"]')!.value = "";
      dialog.remove();
      if (cancelled) reject(new DOMException("导入已取消。", "AbortError"));
      else resolve(answer);
    }, { once: true });
    openUiDialog(dialog);
  });
}

export function managePasswordBook(book: PasswordBook): void {
  const dialog = document.createElement("dialog");
  dialog.className = "modal game-dialog password-book-dialog";
  dialog.setAttribute("aria-label", "密码本");
  dialog.innerHTML = `<button type="button" class="modal-close" aria-label="关闭密码本">×</button><h2>密码本</h2><p>导入加密包时会依次尝试个人密码本的密码。密码仅保存在当前浏览器或应用本机，不随游戏存档导出。</p><div data-password-list></div><form><label>添加密码<input type="password" name="password" required autocomplete="off" maxlength="${MAX_PASSWORD_LENGTH}"></label><button class="primary-button" type="submit">添加</button></form><footer class="password-book-footer"><p role="status"></p><button type="button" class="secondary-button" data-password-clear>清空密码本</button></footer>`;
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const render = () => {
    const list = dialog.querySelector("[data-password-list]")!;
    list.replaceChildren();
    try {
      const values = book.list();
      if (!values.length) list.textContent = "个人密码本为空。";
      values.forEach((password, index) => {
        const row = document.createElement("p");
        row.className = "password-book-row";
        const copy = document.createElement("span");
        copy.className = "password-book-copy";
        const label = document.createElement("span");
        label.textContent = `密码 ${index + 1} ·`;
        const value = document.createElement("span");
        value.className = "password-book-value";
        copy.append(label, value);
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "secondary-button password-book-action";
        const updateVisibility = (visible: boolean) => {
          value.textContent = visible ? password : "•".repeat(Array.from(password).length);
          const action = `${visible ? "隐藏" : "显示"}密码 ${index + 1}`;
          reveal.setAttribute("aria-label", action);
          reveal.setAttribute("aria-pressed", String(visible));
          reveal.title = action;
          reveal.innerHTML = passwordEyeIcon(visible);
        };
        updateVisibility(false);
        reveal.addEventListener("click", () => updateVisibility(reveal.getAttribute("aria-pressed") !== "true"));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary-button password-book-action";
        remove.setAttribute("aria-label", `删除密码 ${index + 1}`);
        remove.title = `删除密码 ${index + 1}`;
        remove.innerHTML = passwordTrashIcon;
        remove.addEventListener("click", () => { try { book.remove(index); render(); } catch { status.textContent = "删除失败，请重试。"; } });
        row.append(copy, reveal, remove); list.append(row);
      });
    } catch { status.textContent = "密码本无法读取，可清空后重新添加。"; }
  };
  dialog.querySelector("form")!.addEventListener("submit", event => {
    event.preventDefault();
    const input = dialog.querySelector<HTMLInputElement>('[name="password"]')!;
    try { book.add(input.value); input.value = ""; status.textContent = "已保存。"; render(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : "保存失败。"; }
  });
  dialog.querySelector("[data-password-clear]")!.addEventListener("click", () => {
    try { book.clear(); status.textContent = "个人密码本已清空。"; render(); } catch { status.textContent = "清空失败，请重试。"; }
  });
  dialog.querySelector(".modal-close")!.addEventListener("click", () => { void closeUiDialog(dialog); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  render(); document.body.append(dialog); openUiDialog(dialog);
}
