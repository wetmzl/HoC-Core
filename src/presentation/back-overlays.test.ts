import { afterEach, describe, expect, it, vi } from "vitest";
import { installBackOverlays } from "./back-overlays";

interface Handler { priority?: number; enabled?: () => boolean; handle(): void }
const registrations = vi.hoisted(() => [] as { handler: Handler; release: ReturnType<typeof vi.fn> }[]);
vi.mock("../platform/back-navigation", () => ({
  registerBackHandler: (handler: Handler) => {
    const release = vi.fn();
    registrations.push({ handler, release });
    return release;
  }
}));

class Dialog extends EventTarget {
  classList = { contains: () => false };
  open = true;
  isConnected = true;
  ownerDocument!: Document;
  contains(other: unknown): boolean { return other === this; }
  close = vi.fn(() => { this.open = false; });
}

function fixture(dialogs: Dialog[] = [], focused: Dialog | null = null) {
  const custom = new Map<string, unknown>();
  const owner = {
    activeElement: focused,
    querySelectorAll: () => dialogs.filter(dialog => dialog.open && dialog.isConnected),
    querySelector: (selector: string) => selector === "dialog[open]" ? dialogs.find(dialog => dialog.open) : custom.get(selector),
    elementFromPoint: () => null,
    defaultView: { innerWidth: 400, innerHeight: 800 }
  };
  dialogs.forEach(dialog => { dialog.ownerDocument = owner as unknown as Document; });
  vi.stubGlobal("document", owner);
  installBackOverlays();
  return { owner, custom };
}
const native = () => registrations.find(({ handler }) => handler.priority === 100)!.handler;
afterEach(() => { registrations.length = 0; vi.unstubAllGlobals(); });

describe("shared overlay Back handling", () => {
  it("cancels the focused top dialog even when it precedes a covered sibling", () => {
    const top = new Dialog(), covered = new Dialog();
    fixture([top, covered], top);
    const cancelled = vi.fn();
    top.addEventListener("cancel", cancelled);
    native().handle();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(top.close).toHaveBeenCalledOnce();
    expect(covered.close).not.toHaveBeenCalled();
  });

  it("honors preventDefault so save and import guards can consume Back", () => {
    const dialog = new Dialog();
    fixture([dialog], dialog);
    dialog.addEventListener("cancel", event => event.preventDefault());
    native().handle();
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("does not close a covered dialog after its cancel listener opens another modal", () => {
    const dialog = new Dialog(), replacement = new Dialog();
    const dialogs = [dialog];
    const { owner } = fixture(dialogs, dialog);
    replacement.ownerDocument = owner as unknown as Document;
    dialog.addEventListener("cancel", () => { dialogs.push(replacement); owner.activeElement = replacement; });
    native().handle();
    expect(dialog.close).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("consumes ambiguous modal stacks without guessing from DOM order", () => {
    const first = new Dialog(), second = new Dialog();
    fixture([first, second]);
    expect(native().enabled?.()).toBe(true);
    native().handle();
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });

  it("uses custom gates' and debug panel's existing cancellation controls", () => {
    const { custom } = fixture();
    const cancel = { click: vi.fn() }, debug = { click: vi.fn() };
    custom.set(".third-party-content-warning-backdrop", {});
    custom.set(".third-party-content-warning-backdrop [data-cancel-third-party-content]", cancel);
    custom.set("#debug-engine-panel:not([hidden]) [data-debug-close]", debug);
    const thirdParty = registrations[1].handler, adult = registrations[2].handler, debugHandler = registrations[3].handler;
    expect(thirdParty.enabled?.()).toBe(true);
    thirdParty.handle();
    expect(cancel.click).toHaveBeenCalledOnce();
    custom.set(".adult-content-warning-backdrop", {});
    expect(adult.enabled?.()).toBe(true);
    adult.handle();
    expect(cancel.click).toHaveBeenCalledOnce();
    expect(debugHandler.enabled?.()).toBe(true);
    debugHandler.handle();
    expect(debug.click).toHaveBeenCalledOnce();
  });

  it("releases every handler on disposal", () => {
    fixture();
    const dispose = installBackOverlays();
    const added = registrations.slice(4);
    dispose();
    added.forEach(({ release }) => expect(release).toHaveBeenCalledOnce());
  });
});
