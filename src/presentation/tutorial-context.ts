/**
 * A tutorial belongs to the currently interactive native-dialog layer. Dialogs
 * mounted beside the app root count too (confirmations, password entry, plugins).
 * The caller may ignore its own modal tutorial while checking an active request.
 */
export function isTutorialContextVisible(
  container?: HTMLElement | null,
  ignoredDialog?: HTMLDialogElement | null
): boolean {
  if (container === null || (container && !container.isConnected)) return false;
  const owner = container?.ownerDocument ?? document;
  let dialogs: HTMLDialogElement[];
  try {
    dialogs = [...owner.querySelectorAll<HTMLDialogElement>("dialog:modal")];
  } catch {
    // Older engines without :modal must conservatively treat open dialogs as
    // blockers instead of letting instructions appear beneath an unknown layer.
    dialogs = [...owner.querySelectorAll<HTMLDialogElement>("dialog[open]")];
  }
  const modals = dialogs.filter(dialog => dialog !== ignoredDialog && dialog.isConnected && dialog.open);
  if (!modals.length) return true;
  if (!container) return false;

  // Focus is moved into the newest native modal by showModal(). DOM order alone
  // cannot identify that layer: an earlier sibling can be reopened on top.
  const containingModal = (element: Element | null): HTMLDialogElement | undefined => {
    if (!element) return undefined;
    const containing = modals.filter(dialog => dialog === element || dialog.contains(element));
    return containing.find(dialog => !containing.some(other => other !== dialog && dialog.contains(other)));
  };
  let top = containingModal(owner.activeElement);
  if (!top && typeof owner.elementFromPoint === "function") {
    // Focus can briefly be on body after a focused control is replaced. Native
    // modal backdrops participate in hit testing, so use the actual visible layer.
    const view = owner.defaultView;
    top = containingModal(owner.elementFromPoint(Math.max(0, (view?.innerWidth ?? 1) / 2), Math.max(0, (view?.innerHeight ?? 1) / 2)));
  }
  if (!top && modals.length === 1) top = modals[0];
  // With several layers and neither focus nor hit-test evidence, defer the hint.
  return Boolean(top && (top === container || top.contains(container)));
}
