import { openUiDialog, closeUiDialog } from "../presentation/dialog-motion";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { chooseGameDialog } from "../game-dialog";
import { latestReleaseNotes } from "./release-notes";

export type AutoDownload = "always" | "wifi" | "never";
export type UpdateChannel = "stable" | "latest";
export interface UpdateOptions { readonly channel?: UpdateChannel; }
export interface CoreRelease {
  readonly prerelease?: boolean;
  readonly version: string;
  readonly tag: string;
  readonly notes: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface CoreUpdateStatus {
  readonly supported: boolean;
  readonly currentVersion: string;
  readonly currentVersionCode: number;
  readonly canInstall: boolean;
  readonly ready?: CoreRelease;
}
export interface CoreUpdateProgress {
  readonly phase: "downloading" | "verifying";
  readonly completedBytes: number;
  readonly totalBytes: number;
}
export interface CoreUpdatePort {
  networkStatus?(): Promise<{ connected: boolean; wifi: boolean }>;
  getStatus(options?: UpdateOptions): Promise<CoreUpdateStatus>;
  check(options?: UpdateOptions): Promise<{ readonly state: "no-release" | "current" | "available"; readonly release?: CoreRelease }>;
  releaseNotes?(): Promise<{ readonly feed: string }>;
  download(options: { tag: string } & UpdateOptions): Promise<CoreRelease>;
  cancel(): Promise<void>;
  install(options?: UpdateOptions): Promise<{ readonly state: "permission" | "installer" | "restart" | "manual"; readonly message?: string }>;
  addListener(event: "progress", listener: (progress: CoreUpdateProgress) => void): Promise<PluginListenerHandle>;
}
declare global { interface Window { readonly hocCoreUpdate?: CoreUpdatePort; } }
export function supportsCoreUpdates(): boolean {
  return Capacitor.getPlatform() === "android" || (typeof window !== "undefined" && Boolean(window.hocCoreUpdate));
}
const nativeUpdater = registerPlugin<CoreUpdatePort>("CoreUpdate");
const CHECK_KEY = "hoc.core-update.last-check.v2";
const CHANNEL_KEY = "hoc.core-update.channel.v1";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL = 60 * 60 * 1000;
function availableStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export interface CoreUpdateUI {
  offer(release: CoreRelease, current: string): Promise<"update" | "skip" | "later">;
  notice(title: string, message: string): Promise<void>;
  install(release: CoreRelease, port: CoreUpdatePort, downloaded: boolean): Promise<void>;
}

/** One update operation at a time. Automatic checks never block startup or interrupt a game. */
export class CoreUpdater {
  private busy = false;
  private restoredCheck = false;
  private pending?: CoreRelease;
  private readonly downloadRetry = new Map<string, number>();
  private policy: AutoDownload = "wifi";
  private readonly preferences = new Map<string, string>();
  private readonly deadlines = new Map<UpdateChannel, number>();
  private channel: UpdateChannel = "stable";
  private generation = 0;
  constructor(
    private readonly port: CoreUpdatePort = (typeof window !== "undefined" && window.hocCoreUpdate) || nativeUpdater,
    private readonly ui: CoreUpdateUI = updateUI,
    private readonly supported = supportsCoreUpdates(),
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined = availableStorage(),
    private readonly now: () => number = Date.now
  ) {
    try { const policy = storage?.getItem("hoc.core-update.auto-download.v1"); if (policy === "always" || policy === "never") this.policy = policy; } catch { /* Default to Wi-Fi. */ }
    try { if (storage?.getItem(CHANNEL_KEY) === "latest") this.channel = "latest"; } catch { /* Default to stable. */ }
  }

  getAutoDownload(): AutoDownload { return this.policy; }
  setAutoDownload(policy: AutoDownload): boolean {
    if (!["always", "wifi", "never"].includes(policy)) return false;
    this.policy = policy;
    return this.save("hoc.core-update.auto-download.v1", policy);
  }
  private read(key: string): string | undefined {
    try { return this.preferences.get(key) ?? this.storage?.getItem(key) ?? undefined; } catch { return this.preferences.get(key); }
  }
  private save(key: string, value: string): boolean {
    this.preferences.set(key, value);
    try { this.storage?.setItem(key, value); return Boolean(this.storage); } catch { return false; }
  }
  private async autoDownloadAllowed(): Promise<boolean> {
    if (this.policy === "never") return false;
    const network = this.port.networkStatus ? await this.port.networkStatus() : { connected: globalThis.navigator?.onLine !== false, wifi: false };
    return network.connected && (this.policy === "always" || network.wifi);
  }
  async download(): Promise<void> { await this.check(true, () => true, "download"); }
  async install(): Promise<void> { await this.check(true, () => true, "install"); }
  getChannel(): UpdateChannel { return this.channel; }
  setChannel(channel: UpdateChannel): boolean {
    if (channel !== "stable" && channel !== "latest") return false;
    if (channel !== this.channel) { this.channel = channel; this.pending = undefined; this.generation++; }
    try { this.storage?.setItem(CHANNEL_KEY, channel); return Boolean(this.storage); }
    catch { return false; }
  }
  private scopedPort(channel: UpdateChannel): CoreUpdatePort {
    return {
      getStatus: () => this.port.getStatus({ channel }), check: () => this.port.check({ channel }),
      download: options => this.port.download({ ...options, channel }),
      install: () => this.port.install({ channel }), cancel: () => this.port.cancel(),
      addListener: (event, listener) => this.port.addListener(event, listener)
    };
  }

  async check(manual: boolean, canPrompt: () => boolean = () => true, action: "check" | "download" | "install" = "check"): Promise<void> {
    if (!this.supported || (!manual && !canPrompt())) return;
    if (this.busy) {
      if (manual) await this.ui.notice("应用更新", "后台更新操作正在进行，请稍候再试。");
      return;
    }
    this.busy = true;
    const channel = this.channel, generation = this.generation;
    const port = this.scopedPort(channel);
    try {
      const status = await port.getStatus();
      if (generation !== this.generation) return;
      if (!status.supported) {
        if (manual) await this.ui.notice("应用更新", "此安装包使用独立应用身份或开发模式，不适用公开版本更新。");
        return;
      }
      if (!manual && this.due(channel)) this.pending = undefined;
      let release = manual ? undefined : this.pending;
      if (!release) {
        if (!manual && !this.due(channel) && (!status.ready || this.restoredCheck)) return;
        // Reconfirm a restored package once after startup, even inside the metadata cooldown.
        this.restoredCheck = true;
        // Back off on failures too, so a broken connection cannot trigger a request on every render.
        this.remember(channel, RETRY_INTERVAL);
        let result: Awaited<ReturnType<CoreUpdatePort["check"]>>;
        try { result = await port.check(); }
        catch (error) {
          if (manual && error instanceof Error && error.message.includes("GitHub 暂时限制了检查频率") && this.port.releaseNotes) {
            try {
              const { feed } = await this.port.releaseNotes();
              const notes = latestReleaseNotes(feed);
              if (generation !== this.generation) return;
              if (notes) {
                await this.ui.notice(`最近发布日志 · ${notes.tag}`, `GitHub API 暂时限流，无法确认所选通道的更新。以下为公开发布日志，仅供查看。\n\n${notes.notes || "本次发布未提供更新说明。"}`);
                return;
              }
            } catch { /* 保留检查更新时的原始错误。 */ }
          }
          throw error;
        }
        this.remember(channel, CHECK_INTERVAL);
        if (generation !== this.generation) return;
        release = result.release;
        if (result.state !== "available" || !release) {
          if (manual) await this.ui.notice("应用更新", result.state === "no-release"
            ? channel === "stable" ? "当前更新源暂无稳定版发布，保留当前版本。可在启动器设置中选择“最新版”以接收预发布版本。" : "当前更新源暂无可用发布，保留当前版本。"
            : "当前已是所选通道的最新版本，或比该通道版本更新。");
          return;
        }
        this.pending = release;
      }
      const identity = `${release.tag}:${release.sha256}`;
      const skipKey = `hoc.core-update.skip.${channel}`;
      const laterKey = `hoc.core-update.later.${channel}.${identity}`;
      if (manual && action === "check") {
        await this.ui.notice("应用更新", `发现新版本 ${release.version}。${status.ready?.sha256 === release.sha256 && status.ready.tag === release.tag ? "更新已下载并通过校验，可点击“手动更新”。" : "可点击“手动下载更新”下载安装包。"}`);
        return;
      }
      if (manual && action === "install") {
        if (status.ready?.tag === release.tag && status.ready.sha256 === release.sha256) await this.ui.install(status.ready, port, true);
        else await this.ui.notice("应用更新", "最新版本尚未下载完成，请先点击“手动下载更新”。");
        return;
      }
      if (!manual && this.read(skipKey) === identity) return;
      let ready = status.ready;
      if (ready?.tag !== release.tag || ready.sha256 !== release.sha256) {
        if (!manual && ((this.downloadRetry.get(identity) ?? 0) > this.now() || !await this.autoDownloadAllowed())) return;
        // The native port resolves only after download, digest and platform validation.
        this.remember(channel, RETRY_INTERVAL);
        this.downloadRetry.set(identity, this.now() + RETRY_INTERVAL);
        const monitor = !manual ? setInterval(() => {
          void this.autoDownloadAllowed().then(allowed => { if (!allowed) void port.cancel(); }).catch(() => { void port.cancel(); });
        }, 5000) : undefined;
        try { await port.download({ tag: release.tag }); }
        finally { if (monitor) clearInterval(monitor); }
        ready = (await port.getStatus()).ready;
        if (ready?.tag !== release.tag || ready.sha256 !== release.sha256) throw new Error("最新版本尚未完成下载或校验，请重试。");
      }
      if (generation !== this.generation) return;
      if (manual) {
        await this.ui.notice("下载完成", `版本 ${ready.version} 已下载并通过校验，点击“手动更新”启动系统更新。`);
        return;
      }
      if (!canPrompt() || Number(this.read(laterKey)) > this.now()) return;
      const choice = await this.ui.offer(ready, status.currentVersion);
      if (generation !== this.generation) return;
      if (choice === "skip") this.save(skipKey, identity);
      else if (choice === "update") { this.save(laterKey, String(this.now() + CHECK_INTERVAL)); await this.ui.install(ready, port, true); }
      else this.save(laterKey, String(this.now() + CHECK_INTERVAL));
    } catch (error) {
      if (manual && generation === this.generation) await this.ui.notice("更新未完成", error instanceof Error ? error.message : "请检查网络后重试。");
    } finally { this.busy = false; }
  }
  private due(channel: UpdateChannel): boolean {
    let deadline = this.deadlines.get(channel) ?? 0;
    try { deadline = Math.max(deadline, Number(this.storage?.getItem(`${CHECK_KEY}.${channel}`)) || 0); } catch { /* Storage refusal must not block the game. */ }
    // Ignore timestamps from an incorrectly set clock.
    return deadline <= this.now() || deadline > this.now() + CHECK_INTERVAL;
  }
  private remember(channel: UpdateChannel, delay: number): void {
    const deadline = this.now() + delay;
    this.deadlines.set(channel, deadline);
    try { this.storage?.setItem(`${CHECK_KEY}.${channel}`, String(deadline)); } catch { /* Keep the in-memory throttle. */ }
  }
}

function size(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
const updateUI: CoreUpdateUI = {
  async offer(release, current) {
    return await chooseGameDialog("Core 更新已就绪", `当前版本：${current}\n新版本：${release.version}${release.prerelease ? "（预发布版）" : ""}\n下载大小：${size(release.bytes)}\n\n${release.notes || "本次发布未提供更新说明。"}\n\n最新版本已下载并通过校验，是否现在更新？`, [
      { value: "skip", label: "跳过此版本", style: "secondary" },
      { value: "later", label: "暂缓", style: "secondary" },
      { value: "update", label: "更新", style: "primary" }
    ]) as "update" | "skip" | "later";
  },
  async notice(title, message) { await chooseGameDialog(title, message, [{ value: "ok", label: "知道了", style: "primary" }]); },
  install: showInstallDialog
};

async function showInstallDialog(release: CoreRelease, port: CoreUpdatePort, downloaded: boolean): Promise<void> {
  const dialog = document.createElement("dialog");
  dialog.className = "modal game-dialog core-update-dialog";
  dialog.dataset.coreUpdateDialog = "";
  dialog.setAttribute("aria-label", "Core 应用更新");
  dialog.innerHTML = `<h2>Core 应用更新</h2><p data-update-version></p><p data-update-status role="status" aria-live="polite"></p><progress data-update-progress max="1" value="0" aria-label="更新下载进度"></progress><div class="game-dialog-actions"><button type="button" class="primary-button" data-update-install hidden>继续安装</button><button type="button" class="secondary-button" data-update-close>取消下载</button></div>`;
  dialog.querySelector<HTMLElement>("[data-update-version]")!.textContent = `v${release.version} · ${size(release.bytes)}`;
  const status = dialog.querySelector<HTMLElement>("[data-update-status]")!;
  const progress = dialog.querySelector<HTMLProgressElement>("[data-update-progress]")!;
  const install = dialog.querySelector<HTMLButtonElement>("[data-update-install]")!;
  const close = dialog.querySelector<HTMLButtonElement>("[data-update-close]")!;
  let downloading = !downloaded, cancelling = false, installing = false, finished = false;
  let progressListener: PluginListenerHandle | undefined, appListener: PluginListenerHandle | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const requestClose = async () => {
    if (installing || cancelling) return;
    if (downloading) {
      cancelling = true; close.disabled = true; status.textContent = "正在取消下载……";
      try { await port.cancel(); } catch { /* The download promise still owns cleanup. */ }
    } else await closeUiDialog(dialog);
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); void requestClose(); });
  dialog.addEventListener("close", () => { finished = true; resolveClosed(); }, { once: true });
  close.onclick = () => void requestClose();
  const launchInstall = async () => {
    if (installing || finished) return;
    installing = true; install.disabled = true; close.disabled = true;
    status.textContent = "正在复核安装包……";
    try {
      const result = await port.install();
      status.textContent = result.message ?? (result.state === "permission"
        ? "请在系统设置中允许安装此来源的应用，返回后点击“继续安装”。"
        : "系统安装器已打开，请确认更新。如果取消安装，可以点击“继续安装”重试。");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "无法打开安装器，请重试。";
    } finally { installing = false; install.disabled = false; close.disabled = false; }
  };
  install.onclick = () => void launchInstall();
  document.body.append(dialog); openUiDialog(dialog);
  try {
    if (Capacitor.getPlatform() === "android") appListener = await App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive || finished || downloading || installing) return;
      void port.getStatus().then(result => {
        if (finished) return;
        if (result.canInstall) status.textContent = "安装包已就绪，点击“继续安装”完成更新。";
      }).catch(() => { /* The explicit retry button remains available. */ });
    });
    if (downloading) {
      status.textContent = "正在准备更新下载……";
      progressListener = await port.addListener("progress", event => {
        if (cancelling) return;
        progress.max = Math.max(1, event.totalBytes); progress.value = event.completedBytes;
        status.textContent = event.phase === "verifying" ? "下载完成，正在校验安装包……" : `正在下载 ${size(event.completedBytes)} / ${size(event.totalBytes)}`;
      });
      if (cancelling) { downloading = false; dialog.close(); return; }
      await port.download({ tag: release.tag });
      downloading = false;
      if (cancelling) { dialog.close(); return; }
    }
    downloading = false; progress.hidden = true; install.hidden = false;
    close.textContent = "稍后安装";
    status.textContent = "安装包已下载并通过校验，正在启动系统更新……";
    await launchInstall();
    await closed;
  } catch (error) {
    downloading = false; progress.hidden = true;
    if (cancelling) { dialog.close(); return; }
    status.textContent = error instanceof Error ? error.message : "下载失败，请检查网络后重试。";
    close.disabled = false; close.textContent = "关闭";
    await closed;
  } finally {
    try { await progressListener?.remove(); } catch { /* Already disconnected after installation. */ }
    try { await appListener?.remove(); } catch { /* Already disconnected after installation. */ }
    dialog.remove();
  }
}
