import { confirmGameDialog } from "../game-dialog";
import { resetSave } from "./boot";
import { downloadRawSave } from "./json";
import type { SaveRepository } from "./repository";
import { SaveValidationError } from "./schema";

export const RESET_LONG_TERM_CONFIRM_MESSAGE = "删除长期存档将清除战绩、历史、角色与技能解锁及设置，但不会删除未完成牌局。确定继续吗？";

/** Resolves incompatible durable data before any third-party code can execute. */
export async function ensureLongTermSaveReady(root: HTMLDivElement, repository: SaveRepository): Promise<boolean> {
  let invalid: unknown;
  try { await repository.loadLongTerm(); return true; }
  catch (error) {
    if (!(error instanceof SaveValidationError) || error.kind !== "long-term") throw error;
    invalid = error.input;
  }
  root.innerHTML = `<main class="error-shell"><p class="kicker">牌桌暂时离线</p><h1>无法读取<br><em>长期存档</em></h1><p>这份长期存档不符合当前版本支持的格式，无法转换。你仍可导出原件留底，或确认删除后重新开始。</p><div class="error-actions"><button class="danger-button" data-reset-invalid-save>删除长期存档并重新开始</button><button class="secondary-button" data-export-invalid-save>导出原始存档</button><button class="secondary-button" data-retry>重新检查</button><button class="secondary-button" data-return-launcher>返回资源管理</button></div><p class="status-line" role="status" data-error-status></p></main>`;
  const status = root.querySelector<HTMLElement>("[data-error-status]")!;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
  const events = new AbortController();
  let busy = false;
  try {
    return await new Promise<boolean>((resolve) => {
      const perform = async (action: () => Promise<void>) => {
        if (busy) return;
        busy = true;
        buttons.forEach((button) => { button.disabled = true; });
        try { await action(); }
        catch { status.textContent = "操作失败，原存档未被覆盖。请重试或先导出原件。"; }
        finally { busy = false; buttons.forEach((button) => { button.disabled = false; }); }
      };
      root.querySelector("[data-return-launcher]")!.addEventListener("click", () => { if (!busy) resolve(false); }, { signal: events.signal });
      root.querySelector("[data-export-invalid-save]")!.addEventListener("click", () => void perform(async () => {
        await downloadRawSave(invalid);
        status.textContent = "原始存档已导出。";
      }), { signal: events.signal });
      root.querySelector("[data-reset-invalid-save]")!.addEventListener("click", () => void perform(async () => {
        if (!await confirmGameDialog("删除长期存档", RESET_LONG_TERM_CONFIRM_MESSAGE, "删除")) return;
        // One atomic write resets durable progress while preserving the runtime snapshot.
        await repository.saveLongTerm(resetSave());
        resolve(true);
      }), { signal: events.signal });
      root.querySelector("[data-retry]")!.addEventListener("click", () => void perform(async () => {
        try { await repository.loadLongTerm(); resolve(true); }
        catch (error) {
          if (!(error instanceof SaveValidationError) || error.kind !== "long-term") throw error;
          invalid = error.input;
          status.textContent = "这份长期存档仍不符合支持的格式。原存档未被修改。";
        }
      }), { signal: events.signal });
    });
  } finally { events.abort(); }
}
