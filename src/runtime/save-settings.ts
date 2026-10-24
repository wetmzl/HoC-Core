import { haptics } from "../presentation/haptic-service";
import { presentationStore } from "../persistence/presentation";
import { resetSave } from "../persistence/boot";
import { downloadRawSave, downloadSaveImage, downloadSaveJson, importSave } from "../persistence/json";
import { SaveValidationError, type LongTermSave } from "../persistence/schema";
import { gameAudio } from "../audio/game-audio";
import { resourceLoader } from "../resources/resource-loader";
import { selectSaveCoverImage } from "./save-cover";
import { confirmGameDialog } from "../game-dialog";
import { RESET_CONFIRM_MESSAGE, uiError } from "../presentation/view-helpers";
export interface SettingsControllerDependencies {
    clearActiveMatch: () => void;
    deckQueue: {
        get: () => import("../core/skills/deck").SkillDeck;
        subscribe(listener: (deck: import("../core/skills/deck").SkillDeck, status: import("../presentation/deck-save-queue").DeckSaveStatus) => void): () => void;
        update(next: import("../core/skills/deck").SkillDeck): Promise<void>;
        flush: () => Promise<void>;
    } | undefined;
    readonly autosave: import("../runtime/session-ports").ActiveMatchPersistence | null;
    repository: import("../persistence/save-service").PersistenceService;
    save: import("../persistence/schema").LongTermSave;
    pluginSettingsSession: import("../content/packages/plugin-settings").PluginSettingsSession | undefined;
    clearAiSchedule: () => void;
    renderLobby: (layer?: import("../lobby-screen-module").LobbyLayer) => Promise<void>;
    lobbyLayer: import("../lobby-screen-module").LobbyLayer;
    root: HTMLDivElement;
    runtimeContributions: readonly import("../content/packages/plugin-contracts").PluginRuntimeContribution[];
}
export class SettingsController {
    constructor(private readonly deps: SettingsControllerDependencies) { }
    pendingImportedSave: unknown;
    resetCurrentData = async (): Promise<void> => {
        await this.deps.deckQueue?.flush();
        const abandoned = this.deps.autosave?.getState().id;
        if (abandoned)
            presentationStore().clearMatch(abandoned);
        presentationStore().clearAll();
        await this.deps.repository.deleteLongTerm();
        this.deps.deckQueue = undefined;
        this.deps.save = resetSave();
        this.deps.pluginSettingsSession?.sync({});
        this.deps.clearActiveMatch();
        this.deps.clearAiSchedule();
        gameAudio.stopHeartbeat();
        document.body.classList.remove("reduced-motion");
        gameAudio.configure(this.deps.save.settings.soundEnabled);
        haptics.configure(!this.deps.save.settings.reducedMotion);
        await this.deps.repository.saveLongTerm(this.deps.save);
        await this.deps.renderLobby(this.deps.lobbyLayer);
    };
    confirmResetCurrentData = (): Promise<boolean> => { return confirmGameDialog("删除长期存档", RESET_CONFIRM_MESSAGE, "删除"); };
    private pluginWriteQueue: Promise<void> = Promise.resolve();
    flushPluginSettings = (): Promise<void> => this.pluginWriteQueue.catch(() => undefined);
    writePluginSettings = (packageId: string, values: Readonly<Record<string, import("../content/packages/plugin-declarations").PluginSettingValue>>): Promise<void> => {
        const write = this.pluginWriteQueue.catch(() => {}).then(async () => {
            await this.deps.deckQueue?.flush();
            const session = this.deps.pluginSettingsSession;
            if (!session) throw new Error("插件设置不可用");
            const current = this.deps.autosave?.getSave() ?? this.deps.save;
            const pluginSettings = session.updated(current.settings.pluginSettings ?? {}, packageId, { ...session.values(packageId), ...values });
            const next = { ...current, settings: { ...current.settings, pluginSettings }, updatedAt: new Date().toISOString() };
            if (this.deps.autosave) { this.deps.autosave.updateSave(next); await this.deps.autosave.flush(); }
            else await this.deps.repository.saveLongTerm(next);
            this.deps.save = this.deps.autosave?.getSave() ?? next;
            session.sync(this.deps.save.settings.pluginSettings ?? {});
        });
        this.pluginWriteQueue = write;
        return write;
    };
    updateSettings = async (event: Event): Promise<void> => {
        await this.deps.deckQueue?.flush();
        const input = event.target as HTMLInputElement;
        const setting = input.dataset.setting;
        if (setting !== "reducedMotion" && setting !== "soundEnabled" && setting !== "autoSkipAfterStand") return;
        this.deps.save = { ...this.deps.save, settings: { ...this.deps.save.settings, [setting]: input.checked }, updatedAt: new Date().toISOString() };
        document.body.classList.toggle("reduced-motion", this.deps.save.settings.reducedMotion);
        haptics.configure(!this.deps.save.settings.reducedMotion);
        if (setting === "soundEnabled") {
            gameAudio.unlock();
            gameAudio.configure(input.checked);
        }
        const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
        if (status)
            status.textContent = "设置已保存。";
        await this.deps.repository.saveLongTerm(this.deps.save);
    };
    saveCoverImage = async (currentSave: LongTermSave): Promise<string> => {
        return selectSaveCoverImage({
            loadFeatureCandidates: async () => (await Promise.all(this.deps.runtimeContributions.map((contribution) => contribution.saveCoverCandidates?.(currentSave) ?? []))).flat(),
            isAvailable: async (url) => Boolean((await resourceLoader.enqueue([url], "visible"))[0])
        });
    };
    exportStatus = (method: "file-system-access" | "blob-download" | "native-share"): string => {
        if (method === "file-system-access")
            return "存档已写入。";
        if (method === "native-share")
            return "已打开系统分享面板。";
        return "已开始下载存档。";
    };
    exportSave = async (): Promise<void> => {
        const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
        try {
            const currentSave = this.deps.autosave?.getSave() ?? this.deps.save;
            const format = this.deps.root.querySelector<HTMLSelectElement>("[data-export-format]")?.value ?? "image";
            const method = format === "json"
                ? await downloadSaveJson(currentSave)
                : await downloadSaveImage(currentSave, await this.saveCoverImage(currentSave));
            if (status)
                status.textContent = this.exportStatus(method);
        }
        catch (error) {
            if (status)
                status.textContent = uiError(error, "导出失败。");
        }
    };
    applyImportedSave = async (next: LongTermSave): Promise<void> => { await this.deps.deckQueue?.flush(); this.deps.deckQueue = undefined; await this.deps.repository.saveLongTerm(next); this.deps.save = next; this.deps.pluginSettingsSession?.sync(this.deps.save.settings.pluginSettings ?? {}); document.body.classList.toggle("reduced-motion", this.deps.save.settings.reducedMotion); gameAudio.configure(this.deps.save.settings.soundEnabled); haptics.configure(!this.deps.save.settings.reducedMotion); this.pendingImportedSave = undefined; await this.deps.renderLobby(this.deps.lobbyLayer); };
    showUnsupportedImportPrompt = (error: SaveValidationError): void => {
        this.pendingImportedSave = error.input;
        const dialog = this.deps.root.querySelector<HTMLDialogElement>("#save-import-error");
        const copy = dialog?.querySelector<HTMLParagraphElement>("#save-import-error-copy");
        const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
        if (copy)
            copy.textContent = "这份文件无法识别或不符合支持的存档格式，无法转换。原件仍可导出留底，当前存档未被修改。";
        if (status)
            status.textContent = "导入失败：请导出原件留底或暂不处理。";
        dialog?.showModal();
    };
    handleImportFailure = (error: unknown): void => {
        if (error instanceof SaveValidationError && error.kind === "long-term") {
            this.showUnsupportedImportPrompt(error);
            return;
        }
        const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
        if (status)
            status.textContent = uiError(error, "导入失败。");
    };
    exportFailedImport = async (): Promise<void> => {
        const status = this.deps.root.querySelector<HTMLElement>("[data-import-error-status]");
        try {
            const method = await downloadRawSave(this.pendingImportedSave);
            if (status)
                status.textContent = this.exportStatus(method);
        }
        catch (error) {
            if (status)
                status.textContent = uiError(error, "原始存档导出失败。");
        }
    };
    importFile = (event: Event): void => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file)
            return;
        void importSave(file).then(this.applyImportedSave).catch(this.handleImportFailure).finally(() => { input.value = ""; });
    };
    requestImport = (): void => { this.deps.root.querySelector<HTMLInputElement>("#save-file")?.click(); };
}
