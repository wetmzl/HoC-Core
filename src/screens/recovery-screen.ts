import { presentationStore } from "../persistence/presentation";
import { downloadRawSave } from "../persistence/json";
import { SaveValidationError } from "../persistence/schema";
import { confirmGameDialog } from "../game-dialog";
import { RESET_RUNTIME_CONFIRM_MESSAGE, escapeHtml, uiError } from "../presentation/view-helpers";
export interface RecoveryScreenDependencies {
    discardActiveTutorial: () => void;
    clearAiSchedule: () => void;
    clearAbilityNoticeQueue: () => void;
    detachFullscreenListener: () => void;
    root: HTMLDivElement;
    boot: () => Promise<void>;
    confirmResetCurrentData: () => Promise<boolean>;
    repository: import("../persistence/save-service").PersistenceService;
    exportStatus: (method: "file-system-access" | "blob-download" | "native-share") => string;
}
export class RecoveryScreen {
    constructor(private readonly deps: RecoveryScreenDependencies) { }
    renderError = (error: unknown): void => {
        this.deps.discardActiveTutorial();
        this.deps.clearAiSchedule();
        this.deps.clearAbilityNoticeQueue();
        this.deps.detachFullscreenListener();
        const incompatibleLongTerm = error instanceof SaveValidationError && error.kind === "long-term";
        const incompatibleRuntime = error instanceof SaveValidationError && error.kind === "runtime";
        const invalidLongTermInput = incompatibleLongTerm ? error.input : undefined;
        const action = incompatibleLongTerm
            ? `<div class="error-actions"><button class="danger-button" data-reset-invalid-save>删除长期存档并重新开始</button><button class="secondary-button" data-export-invalid-save ${invalidLongTermInput === undefined ? "disabled" : ""}>导出原始存档</button><button class="secondary-button" data-retry>重新检查</button></div><p class="status-line" data-error-status></p>`
            : incompatibleRuntime
                ? `<button class="primary-button" data-reset-invalid-runtime>舍弃未完成牌局</button><button class="secondary-button" data-retry>重新检查</button>`
                : `<button class="primary-button" data-retry>重试</button>`;
        const message = incompatibleLongTerm
            ? "这份长期存档不符合当前版本支持的格式，无法转换。你仍可导出原件留底，或手动删除并确认清除战绩与解锁。"
            : incompatibleRuntime
                ? "未完成牌局与当前版本不兼容。舍弃它不会影响长期战绩与解锁。"
                : uiError(error, "游戏无法启动。");
        const heading = incompatibleLongTerm ? "需要清理<br><em>长期存档</em>" : incompatibleRuntime ? "无法恢复<br><em>未完成牌局</em>" : "出现了<br><em>意外回合</em>";
        this.deps.root.innerHTML = `<main class="error-shell"><p class="kicker">牌桌暂时离线</p><h1>${heading}</h1><p>${escapeHtml(message)}</p>${action}</main>`;
        this.deps.root.querySelector("[data-retry]")?.addEventListener("click", () => void this.deps.boot());
        this.deps.root.querySelector("[data-reset-invalid-save]")?.addEventListener("click", () => {
            void this.deps.confirmResetCurrentData().then((confirmed) => {
                if (confirmed)
                    return this.deps.repository.deleteLongTerm().then(() => this.deps.boot());
            }).catch(this.renderError);
        });
        this.deps.root.querySelector("[data-export-invalid-save]")?.addEventListener("click", () => {
            const status = this.deps.root.querySelector<HTMLElement>("[data-error-status]");
            void downloadRawSave(invalidLongTermInput).then((method) => {
                if (status)
                    status.textContent = this.deps.exportStatus(method);
            }).catch((exportError: unknown) => {
                if (status)
                    status.textContent = uiError(exportError, "原始存档导出失败。");
            });
        });
        this.deps.root.querySelector("[data-reset-invalid-runtime]")?.addEventListener("click", () => {
            void confirmGameDialog("无法恢复未完成牌局", RESET_RUNTIME_CONFIRM_MESSAGE, "舍弃这局牌").then((confirmed) => {
                if (confirmed)
                    return Promise.resolve(presentationStore().clearAll()).then(() => this.deps.repository.deleteRuntime()).then(() => this.deps.boot());
            }).catch(this.renderError);
        });
    };
}
