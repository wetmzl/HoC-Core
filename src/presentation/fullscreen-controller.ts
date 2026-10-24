export interface FullscreenControllerDependencies {
    syncAbilityNoticePosition: () => void;
    root: HTMLDivElement;
    detachAbilityNoticePositionListener: () => void;
    attachAbilityNoticePositionListener: () => void;
    enqueueNotification: (text: string) => void;
}
export class FullscreenController {
    constructor(private readonly deps: FullscreenControllerDependencies) { }
    fullscreenChangeAttached: boolean = false;
    syncFullscreenButton = (): void => {
        this.deps.syncAbilityNoticePosition();
        const button = this.deps.root.querySelector<HTMLButtonElement>("[data-fullscreen]");
        if (!button)
            return;
        const active = Boolean(document.fullscreenElement);
        button.textContent = active ? "⛶" : "⛶";
        button.setAttribute("aria-label", active ? "退出全屏" : "进入全屏");
        button.title = active ? "退出全屏" : "进入全屏";
    };
    dispose = (): void => this.detachFullscreenListener();
    detachFullscreenListener = (): void => {
        if (!this.fullscreenChangeAttached)
            return;
        document.removeEventListener("fullscreenchange", this.syncFullscreenButton);
        this.fullscreenChangeAttached = false;
        this.deps.detachAbilityNoticePositionListener();
    };
    attachFullscreenListener = (): void => {
        if (this.fullscreenChangeAttached)
            return;
        document.addEventListener("fullscreenchange", this.syncFullscreenButton);
        this.fullscreenChangeAttached = true;
        this.deps.attachAbilityNoticePositionListener();
    };
    toggleFullscreen = (): void => {
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => this.deps.enqueueNotification("无法退出全屏。"));
            return;
        }
        if (!document.documentElement.requestFullscreen) {
            this.deps.enqueueNotification("当前环境不支持全屏。");
            return;
        }
        void document.documentElement.requestFullscreen().catch(() => this.deps.enqueueNotification("全屏请求未获允许。"));
    };
}
