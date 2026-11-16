import { Capacitor } from "@capacitor/core";

/** Hold before opening any local storage, including the launcher's content catalog.
 * The browser releases this lock when the document dies. Returning to the launcher
 * or hiding the tab must not let another document overwrite this one's snapshots.
 */
async function acquireBrowserSession(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return true;
  if (!navigator.locks) throw new Error("Browser session locking is unavailable");
  return new Promise<boolean>((resolve, reject) => {
    void navigator.locks.request("hoc.browser-session.v1", { mode: "exclusive", ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      // Keep ownership even if startup fails partway through. Only destroying this
      // document can guarantee that no queued or delayed writer will resume.
      return new Promise<void>(() => {});
    }).catch(reject);
  });
}

function showBlockedSession(root: HTMLDivElement, occupied: boolean): void {
  root.innerHTML = `<main class="launcher-shell" data-browser-session-blocked><section class="launcher-hero"><p class="eyebrow">House of Chances</p><h1>${occupied ? "游戏已在其他页面打开" : "暂时无法打开游戏"}</h1><p class="launcher-description">${occupied ? "为保护本地进度，请先关闭其他游戏页面，再重新尝试。" : "当前浏览器无法保护本地进度，请更新浏览器后重试。"}</p></section><section class="launcher-actions"><button type="button" class="primary-button" data-retry-browser-session>重新尝试</button></section></main>`;
  // A fresh document must re-read storage; never reuse an old runtime on takeover.
  root.querySelector<HTMLButtonElement>("[data-retry-browser-session]")!.onclick = () => location.reload();
}

export async function startBrowserSession(root: HTMLDivElement, start: () => Promise<void>): Promise<void> {
  let acquired: boolean;
  try { acquired = await acquireBrowserSession(); }
  catch { showBlockedSession(root, false); return; }
  if (!acquired) { showBlockedSession(root, true); return; }
  await start();
}
