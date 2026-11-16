import { reducedUiMotion, motionNumber } from "./ui-motion";

const closing = new WeakMap<HTMLDialogElement, { cancel: () => void; done: Promise<void> }>();

/** Use for host dialogs; native close() remains available for immediate teardown. */
export function openUiDialog(dialog: HTMLDialogElement | null | undefined, options: { readonly restore?: boolean } = {}): void {
  if (!dialog) return;
  const pending = closing.get(dialog);
  pending?.cancel();
  dialog.classList.add("ui-dialog");
  if (!dialog.open || pending) dialog.classList.toggle("ui-dialog-restored", options.restore === true);
  if (!dialog.open) dialog.showModal();
}

/** Keep native modal isolation until the exit finishes. Repeated close is idempotent. */
export function closeUiDialog(dialog: HTMLDialogElement | null | undefined, value?: string): Promise<void> {
  if (!dialog?.open) return Promise.resolve();
  const pending = closing.get(dialog);
  if (pending) return pending.done;
  if (!dialog.classList.contains("ui-dialog") || reducedUiMotion() || document.hidden) {
    dialog.close(value);
    return Promise.resolve();
  }
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const wasInert = dialog.inert;
  let timer = 0;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    dialog.removeEventListener("animationend", onEnd);
    dialog.removeEventListener("close", onClose);
    dialog.classList.remove("ui-dialog-closing");
    dialog.inert = wasInert;
    closing.delete(dialog);
    complete();
  };
  const finish = () => {
    if (settled) return;
    cleanup();
    if (dialog.open) dialog.close(value);
  };
  const onEnd = (event: AnimationEvent) => {
    if (event.target === dialog && event.animationName === "ui-dialog-exit" && !event.pseudoElement) finish();
  };
  // Native close events are queued: one from before a synchronous reopen must
  // not cancel the new exit and strand an open modal without its timer.
  const onClose = () => { if (!dialog.open) cleanup(); };
  closing.set(dialog, { cancel: cleanup, done });
  dialog.inert = true;
  dialog.classList.add("ui-dialog-closing");
  dialog.addEventListener("animationend", onEnd);
  dialog.addEventListener("close", onClose);
  // Also completes after a cancelled animation, a hidden tab, or a detached node.
  timer = window.setTimeout(finish, motionNumber(dialog, "--ui-dialog-exit-ms", 150) + 50);
  return done;
}
