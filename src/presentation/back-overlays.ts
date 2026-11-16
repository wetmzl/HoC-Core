import { closeUiDialog } from "./dialog-motion";
import { registerBackHandler } from "../platform/back-navigation";
import { isTutorialContextVisible } from "./tutorial-context";

/** Use the same cancellation path as Escape, including save/gesture guards. */
function cancelTopDialog(): void {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")]
    .filter(dialog => dialog.isConnected && dialog.open && isTutorialContextVisible(dialog));
  // Focus and hit testing may briefly be unavailable during a redraw. Never
  // guess from DOM order and accidentally dismiss a covered modal.
  if (dialogs.length !== 1) return;
  const dialog = dialogs[0];
  const cancelled = !dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  // A cancel listener may close this dialog, replace it, or open another modal.
  if (!cancelled && dialog.isConnected && dialog.open && isTutorialContextVisible(dialog)) void closeUiDialog(dialog);
}

/** Install once at the app host, so launcher and runtime overlays share Back. */
export function installBackOverlays(): () => void {
  const releases = [
    registerBackHandler({
      priority: 100,
      enabled: () => Boolean(document.querySelector("dialog[open]")),
      handle: cancelTopDialog
    }),
    registerBackHandler({
      priority: 99,
      enabled: () => Boolean(document.querySelector(".third-party-content-warning-backdrop")),
      handle: () => {
        // Disabled while saving: the gate consumes Back without skipping it.
        document.querySelector<HTMLButtonElement>(".third-party-content-warning-backdrop [data-cancel-third-party-content]")?.click();
      }
    }),
    registerBackHandler({
      priority: 99,
      enabled: () => Boolean(document.querySelector(".adult-content-warning-backdrop")),
      // Acknowledgement requires an explicit choice and a successful save.
      handle: () => {}
    }),
    registerBackHandler({
      priority: 96,
      enabled: () => Boolean(document.querySelector("#debug-engine-panel:not([hidden]) [data-debug-close]")),
      handle: () => {
        // The plugin owns its pause, inert and focus state. Let it release them.
        document.querySelector<HTMLButtonElement>("#debug-engine-panel:not([hidden]) [data-debug-close]")?.click();
      }
    })
  ];
  return () => { releases.reverse().forEach(release => release()); };
}
