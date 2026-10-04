import "./styles.css";
import { ApplicationController } from "./application-controller";
import { LauncherView } from "./launcher";
import { retireLegacyResourcePackCache } from "./resources/legacy-cache";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("App root is missing");

const readOnlyEmbedded = import.meta.env.DEV
  && (globalThis as typeof globalThis & { __BLACKJACK_E2E_EMBEDDED__?: boolean }).__BLACKJACK_E2E_EMBEDDED__ === true;
let launcher!: LauncherView;
const controller = new ApplicationController({
  readOnlyEmbedded,
  onProgress: (progress) => launcher?.reportProgress(progress),
  onRuntimeStopped: () => launcher.mount()
});
launcher = new LauncherView(root, controller);

void launcher.mount().then(async () => {
  if (!readOnlyEmbedded) await retireLegacyResourcePackCache();
});
