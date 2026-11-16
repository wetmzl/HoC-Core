import { openUiDialog } from "../presentation/dialog-motion";
import { MusicPackageOrderSchema } from "../content/packages/music";
import { haptics } from "../presentation/haptic-service";
import { hapticPreferences } from "../presentation/haptic-preferences";
import { presentationStore } from "../persistence/presentation";
import { resetSave } from "../persistence/boot";
import { downloadRawSave, downloadSaveImage, downloadSaveJson, importSaveTransfer, type SaveTransfer } from "../persistence/json";
import { replaceTransferredSave } from "../persistence/save-transfer";
import { SaveValidationError, type LongTermSave } from "../persistence/schema";
import { gameAudio } from "../audio/game-audio";
import { DEFAULT_MUSIC_VOLUME } from "../audio/music-volume";
import { resourceLoader } from "../resources/resource-loader";
import { selectSaveCoverImage } from "./save-cover";
import { confirmGameDialog } from "../game-dialog";
import { RESET_CONFIRM_MESSAGE, uiError } from "../presentation/view-helpers";
import { loadingIndicatorMarkup } from "../presentation/loading-indicator";
export interface SettingsControllerDependencies {
    clearActiveMatch: () => void;
    flushEncounters?: () => Promise<void>;
    saveReplaced?: () => void;
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
    private importingSave = false;
    resetCurrentData = async (): Promise<void> => {
        await this.flushPluginSettings();
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
        gameAudio.configure(this.deps.save.settings.soundEnabled, this.deps.save.settings.musicVolume ?? DEFAULT_MUSIC_VOLUME);
        gameAudio.musicDirector.setOrder(this.deps.save.settings.musicPackageOrder ?? []);
        haptics.configure(!this.deps.save.settings.reducedMotion);
        await this.deps.repository.saveLongTerm(this.deps.save);
        await this.deps.renderLobby(this.deps.lobbyLayer);
    };
    confirmResetCurrentData = (): Promise<boolean> => { return confirmGameDialog("删除长期存档", RESET_CONFIRM_MESSAGE, "删除"); };
    private settingsWriteQueue: Promise<void> = Promise.resolve();
    flushPluginSettings = (): Promise<void> => this.settingsWriteQueue.catch(() => undefined);
    /** Skin progress shares the settings queue so neither feature overwrites a stale snapshot. */
    writeCharacterSkinUnlocks = (update: (save: LongTermSave) => LongTermSave): Promise<void> => {
        const write = this.settingsWriteQueue.catch(() => {}).then(async () => {
            await this.deps.deckQueue?.flush();
            const active = this.deps.autosave;
            if (active?.updateProgress) {
                await active.updateProgress(update);
                this.deps.save = active.getSave();
                return;
            }
            await this.deps.autosave?.flush();
            const current = this.deps.autosave?.getSave() ?? this.deps.save;
            const next = update(current);
            if (next === current) return;
            await this.deps.repository.saveLongTerm(next);
            this.deps.autosave?.updateSave(next);
            this.deps.save = next;
        });
        this.settingsWriteQueue = write;
        return write;
    };
    writePluginSettings = (packageId: string, values: Readonly<Record<string, import("../content/packages/plugin-declarations").PluginSettingValue>>): Promise<void> => {
        const write = this.settingsWriteQueue.catch(() => {}).then(async () => {
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
        this.settingsWriteQueue = write;
        return write;
    };
    writeMusicOrder = (order: readonly string[]): Promise<void> => {
        const requested = MusicPackageOrderSchema.parse(order);
        const write = this.settingsWriteQueue.catch(() => {}).then(async () => {
            await this.deps.deckQueue?.flush();
            const current = this.deps.autosave?.getSave() ?? this.deps.save;
            // Preserve preferences for temporarily absent packages.
            const complete = [...requested, ...(current.settings.musicPackageOrder ?? []).filter(id => !requested.includes(id))];
            const next = { ...current, settings: { ...current.settings, musicPackageOrder: complete }, updatedAt: new Date().toISOString() };
            await this.deps.repository.saveLongTerm(next);
            this.deps.autosave?.updateSave(next); this.deps.save = next;
            gameAudio.musicDirector.setOrder(complete);
        });
        this.settingsWriteQueue = write;
        return write;
    };
    updateSettings = (event: Event): Promise<void> => {
        const input = event.target as HTMLInputElement;
        const setting = input.dataset.setting;
        if (setting === "hapticsEnabled" || setting === "outputHapticsEnabled") {
            const persisted = hapticPreferences.update(setting === "hapticsEnabled" ? { enabled: input.checked } : { output: input.checked });
            if (!input.checked) void haptics.stop();
            const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
            if (status) status.textContent = persisted ? "设备震动设置已保存。" : "震动设置已应用；设备存储不可用，本次会话有效。";
            return Promise.resolve();
        }
        if (setting !== "reducedMotion" && setting !== "soundEnabled" && setting !== "autoSkipAfterStand" && setting !== "musicVolume") return Promise.resolve();
        const value = setting === "musicVolume" ? input.valueAsNumber : input.checked;
        if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || value > 1)) return Promise.resolve();
        // Match the plugin form's dialog-wide lock so saves cannot restore stale disabled states.
        const dialog = input.closest?.("dialog");
        const disabled = new Map([...(dialog?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select") ?? [input])].map(node => [node, node.disabled]));
        disabled.forEach((_, node) => { node.disabled = true; });
        if (setting === "musicVolume") gameAudio.setMusicVolume(Number(value));
        const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
        if (status) status.textContent = "正在保存设置…";
        const write = this.settingsWriteQueue.catch(() => {}).then(async () => {
            await this.deps.deckQueue?.flush();
            const current = this.deps.autosave?.getSave() ?? this.deps.save;
            const next = { ...current, settings: { ...current.settings, [setting]: value }, updatedAt: new Date().toISOString() };
            await this.deps.repository.saveLongTerm(next);
            this.deps.autosave?.updateSave(next);
            this.deps.save = next;
            document.body.classList.toggle("reduced-motion", next.settings.reducedMotion);
            haptics.configure(!next.settings.reducedMotion);
            if (setting === "soundEnabled") {
                gameAudio.unlock();
                gameAudio.configure(next.settings.soundEnabled, next.settings.musicVolume ?? DEFAULT_MUSIC_VOLUME);
            }
            if (status) status.textContent = "设置已保存。";
        });
        this.settingsWriteQueue = write;
        return write.catch(error => {
            if (setting === "musicVolume") {
                const volume = this.deps.save.settings.musicVolume ?? DEFAULT_MUSIC_VOLUME;
                input.value = String(volume);
                const readout = this.deps.root.querySelector<HTMLElement>("[data-music-volume-value]");
                if (readout) readout.textContent = `${Math.round(volume * 100)}%`;
                gameAudio.setMusicVolume(volume);
            } else input.checked = this.deps.save.settings[setting] ?? true;
            if (status) status.textContent = uiError(error, "设置保存失败，请重试。");
        }).finally(() => { disabled.forEach((value, node) => { node.disabled = value; }); });
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
            await this.flushPluginSettings();
            await this.deps.flushEncounters?.();
            await this.deps.autosave?.flush();
            const snapshot = await this.deps.repository.readSnapshot();
            const currentSave = snapshot.longTerm as LongTermSave ?? this.deps.save;
            const story = snapshot.story;
            const format = this.deps.root.querySelector<HTMLSelectElement>("[data-export-format]")?.value ?? "image";
            const method = format === "json"
                ? await downloadSaveJson(currentSave, undefined, undefined, story, snapshot.notebook)
                : await downloadSaveImage(currentSave, await this.saveCoverImage(currentSave), undefined, undefined, story, snapshot.notebook);
            if (status)
                status.textContent = this.exportStatus(method);
        }
        catch (error) {
            if (status)
                status.textContent = uiError(error, "导出失败。");
        }
    };
    applyImportedSave = async (next: LongTermSave, story: SaveTransfer["story"] = null, notebook: SaveTransfer["notebook"] = null): Promise<void> => {
        await this.flushPluginSettings();
        await this.deps.deckQueue?.flush();
        await this.deps.flushEncounters?.();
        await this.deps.autosave?.flush();
        await replaceTransferredSave(this.deps.repository, { longTerm: next, story, notebook });
        this.deps.deckQueue = undefined;
        this.deps.saveReplaced?.();
        this.deps.clearActiveMatch();
        this.deps.save = next;
        this.deps.pluginSettingsSession?.sync(next.settings.pluginSettings ?? {});
        document.body.classList.toggle("reduced-motion", next.settings.reducedMotion);
        gameAudio.configure(next.settings.soundEnabled, next.settings.musicVolume ?? DEFAULT_MUSIC_VOLUME);
        gameAudio.musicDirector.setOrder(next.settings.musicPackageOrder ?? []);
        haptics.configure(!next.settings.reducedMotion);
        this.pendingImportedSave = undefined;
        await this.deps.renderLobby(this.deps.lobbyLayer);
    };
    showUnsupportedImportPrompt = (error: SaveValidationError): void => {
        this.pendingImportedSave = error.input;
        const dialog = this.deps.root.querySelector<HTMLDialogElement>("#save-import-error");
        const copy = dialog?.querySelector<HTMLParagraphElement>("#save-import-error-copy");
        const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
        if (copy)
            copy.textContent = "这份文件无法识别或不符合支持的存档格式，无法转换。原件仍可导出留底，当前存档未被修改。";
        if (status)
            status.textContent = "导入失败：请导出原件留底或暂不处理。";
        openUiDialog(dialog);
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
        if (this.importingSave) return;
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file)
            return;
        this.importingSave = true;
        const settings = input.closest("dialog");
        const disabled = new Map([...(settings?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select") ?? [input])].map(node => [node, node.disabled]));
        const loading = document.createElement("dialog");
        loading.className = "import-review-dialog is-loading";
        loading.setAttribute("aria-label", "导入存档");
        loading.innerHTML = `<div class="import-review-body">${loadingIndicatorMarkup({ label: "导入存档" })}</div>`;
        loading.addEventListener("cancel", event => event.preventDefault());
        const run = async (): Promise<void> => {
            try {
                disabled.forEach((_, node) => { node.disabled = true; });
                this.deps.root.append(loading);
                openUiDialog(loading);
                const transfer = await importSaveTransfer(file);
                await this.applyImportedSave(transfer.longTerm, transfer.story, transfer.notebook);
            } finally {
                if (loading.open) loading.close();
                loading.remove();
                disabled.forEach((value, node) => { node.disabled = value; });
                input.value = "";
                this.importingSave = false;
            }
        };
        void run().catch(this.handleImportFailure);
    };
    requestImport = (): void => { if (!this.importingSave) this.deps.root.querySelector<HTMLInputElement>("#save-file")?.click(); };
}
