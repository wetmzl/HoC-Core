import "./styles.css";
import "./presentation/ui-feedback.css";
import { installUiFeedback, applyFeedbackPreference } from "./presentation/ui-feedback";
import { createPersistenceService } from "./persistence/factory";
import { ApplicationController } from "./application-controller";
import { LauncherView } from "./launcher";
import { retireLegacyResourcePackCache } from "./resources/legacy-cache";
import { App } from "@capacitor/app";
import { confirmGameDialog, alertGameDialog } from "./game-dialog";
import { installBackNavigation, registerBackHandler } from "./platform/back-navigation";
import { installBackOverlays } from "./presentation/back-overlays";
import { installAbortSignalAny } from "./platform/abort-signal-compat";
import { startBrowserSession } from "./platform/browser-session";

installAbortSignalAny();

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("App root is missing");

void startBrowserSession(root, async () => {
  const readOnlyEmbedded = import.meta.env.DEV
    && (globalThis as typeof globalThis & { __BLACKJACK_E2E_EMBEDDED__?: boolean }).__BLACKJACK_E2E_EMBEDDED__ === true;
  installUiFeedback();
  // Read only the preference: do not recover or rewrite saves just to render the launcher.
  const reducedMotion = await createPersistenceService().readReducedMotion().catch(() => true);
  applyFeedbackPreference(reducedMotion);
  let launcher!: LauncherView;
  const controller = new ApplicationController({
    readOnlyEmbedded,
    onProgress: (progress) => launcher?.reportProgress(progress),
    onRuntimeStopped: () => launcher.mount()
  });
  launcher = new LauncherView(root, controller);

  installBackOverlays();
  registerBackHandler({
    priority: 90, enabled: () => Boolean(document.querySelector(".skill-draw-backdrop")), handle: () => {}
  });
  // Loading and durable shutdown consume Back until their owner finishes.
  registerBackHandler({
    priority: 10,
    enabled: () => controller.state === "starting" || controller.state === "stopping",
    handle: () => {}
  });
  await installBackNavigation({
    onNativeRoot: async () => {
      if (await confirmGameDialog("退出游戏", "是否退出命运牌桌？", "退出")) await App.exitApp();
    },
    onError: error => { void alertGameDialog("返回失败", error instanceof Error ? error.message : "返回失败，请重试。"); }
  }).catch(error => { console.warn("返回处理器初始化失败", error); }).then(() => launcher.mount()).then(async () => {
    if (!readOnlyEmbedded) await retireLegacyResourcePackCache();
  });
});
