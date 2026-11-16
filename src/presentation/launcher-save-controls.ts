import { applyFeedbackPreference } from "./ui-feedback";
import { confirmGameDialog } from "../game-dialog";
import { createPersistenceService } from "../persistence/factory";
import { downloadRawSave, downloadSaveImage, downloadSaveJson, importSaveTransfer } from "../persistence/json";
import { replaceTransferredSave } from "../persistence/save-transfer";
import { RESET_LONG_TERM_CONFIRM_MESSAGE } from "../persistence/long-term-recovery";
import { SaveValidationError } from "../persistence/schema";
import type { SaveRepository, CheckpointSaveRepository } from "../persistence/repository";
import { DEFAULT_SAVE_COVER_URL } from "../runtime/save-cover";

export function launcherSaveMarkup(): string {
  return `<section class="launcher-settings-section" aria-labelledby="launcher-save-title"><h3 id="launcher-save-title">存档</h3><label class="save-export-format"><span>导出格式</span><select data-launcher-export-format aria-label="存档导出格式"><option value="image">图片存档（推荐）</option><option value="json">JSON 文件</option></select></label><div class="save-actions"><button type="button" class="secondary-button" data-launcher-export-save>导出存档</button><button type="button" class="secondary-button" data-launcher-import-save>导入存档</button><button type="button" class="danger-button" data-launcher-reset-save>清空长期存档</button><button type="button" class="secondary-button" data-launcher-export-original hidden>导出原始存档</button></div><input type="file" data-launcher-save-file accept="image/png,.png,application/json,.json" hidden><p class="status-line" data-launcher-save-status role="status" aria-live="polite"></p></section>`;
}

interface LauncherSaveOptions {
  readonly beforeOperation?: () => Promise<void>;
  readonly repository?: () => SaveRepository & CheckpointSaveRepository;
}

/** The launcher never creates an empty save or loads third-party code just to transfer progress. */
export function mountLauncherSaveControls(dialog: HTMLDialogElement, options: LauncherSaveOptions = {}): () => void {
  const events = new AbortController();
  const status = dialog.querySelector<HTMLElement>("[data-launcher-save-status]")!;
  const input = dialog.querySelector<HTMLInputElement>("[data-launcher-save-file]")!;
  const original = dialog.querySelector<HTMLButtonElement>("[data-launcher-export-original]")!;
  let busy = false, raw: unknown;
  const report = (message: string) => { if (!events.signal.aborted) status.textContent = message; };
  const run = async (action: (repository: SaveRepository & CheckpointSaveRepository) => Promise<void>) => {
    if (busy) return;
    busy = true;
    const disabled = new Map([...dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")].map(node => [node, node.disabled]));
    disabled.forEach((_, node) => { node.disabled = true; });
    const guard = (event: Event) => event.preventDefault();
    dialog.addEventListener("cancel", guard);
    try {
      await options.beforeOperation?.();
      await action((options.repository ?? createPersistenceService)());
    } catch (error) {
      if (error instanceof SaveValidationError && error.kind === "long-term") {
        raw = error.input; original.hidden = false;
        report("无法识别这份存档。当前存档未被替换，可导出原件留底。");
      } else report(error instanceof Error ? error.message : "存档操作失败，请重试。");
    } finally {
      dialog.removeEventListener("cancel", guard);
      disabled.forEach((value, node) => { node.disabled = value; });
      input.value = ""; busy = false;
    }
  };
  dialog.querySelector("[data-launcher-export-save]")!.addEventListener("click", () => void run(async repository => {
    report("正在读取最新存档…");
    const save = await repository.loadLongTerm();
    if (!save) { report("尚无长期存档，请先开始游戏或导入存档。"); return; }
    const format = dialog.querySelector<HTMLSelectElement>("[data-launcher-export-format]")!.value;
    const { story, notebook } = await repository.readSnapshot();
    const method = format === "json" ? await downloadSaveJson(save, undefined, undefined, story, notebook) : await downloadSaveImage(save, DEFAULT_SAVE_COVER_URL, undefined, undefined, story, notebook);
    report(method === "native-share" ? "已打开系统分享面板。" : method === "file-system-access" ? "存档已写入。" : "已开始下载存档。");
  }), { signal: events.signal });
  dialog.querySelector("[data-launcher-import-save]")!.addEventListener("click", () => { if (!busy) input.click(); }, { signal: events.signal });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    void run(async repository => {
      report("正在校验存档…");
      const transfer = await importSaveTransfer(file), next = transfer.longTerm;
      if (!await confirmGameDialog("导入存档", "将替换本机长期存档，并舍弃尚未完成的牌局。资源包和播放集不会改变。是否继续？", "导入并替换")) {
        report("已取消导入，当前存档未被替换。"); return;
      }
      report("正在保存…");
      // Durable progress and the old unfinished game change in one storage snapshot.
      await replaceTransferredSave(repository, transfer);
      applyFeedbackPreference(next.settings.reducedMotion);
      raw = undefined; original.hidden = true;
      report(next.recovery ? "存档已导入，已保留恢复记录和原件。" : "存档已导入，下次开始游戏时使用。");
    });
  }, { signal: events.signal });
  dialog.querySelector("[data-launcher-reset-save]")!.addEventListener("click", () => void run(async repository => {
    if (!await confirmGameDialog("清空长期存档", `${RESET_LONG_TERM_CONFIRM_MESSAGE}\n剧情进度和人物记录也会清空。此操作无法撤销，建议先导出存档。`, "清空")) {
      report("已取消清空，当前存档未被修改。"); return;
    }
    report("正在清空长期存档…");
    await repository.deleteLongTerm();
    applyFeedbackPreference(false);
    raw = undefined; original.hidden = true;
    report("长期存档已清空，下次开始游戏时重新建立。");
  }), { signal: events.signal });
  original.addEventListener("click", () => void run(async () => {
    await downloadRawSave(raw); report("已导出原始存档。");
  }), { signal: events.signal });
  return () => events.abort();
}
