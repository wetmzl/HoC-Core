import { afterEach, describe, expect, it, vi } from "vitest";
import { isTutorialContextVisible } from "./tutorial-context";

interface FakeNode {
  parent?: FakeNode;
  isConnected: boolean;
  open: boolean;
  ownerDocument?: Document;
  contains(other: FakeNode): boolean;
}
function node(parent?: FakeNode): FakeNode {
  const result: FakeNode = { parent, isConnected: true, open: true,
    contains(other) { for (let item: FakeNode | undefined = other; item; item = item.parent) if (item === result) return true; return false; } };
  return result;
}
function fixture(modals: FakeNode[], focused: FakeNode | null = null, hit: FakeNode | null = null) {
  const owner = { activeElement: focused, defaultView: { innerWidth: 400, innerHeight: 800 },
    querySelectorAll: vi.fn(() => modals), elementFromPoint: vi.fn(() => hit) } as unknown as Document;
  for (const modal of modals) modal.ownerDocument = owner;
  vi.stubGlobal("document", owner);
  return owner;
}
const element = (value: FakeNode) => value as unknown as HTMLElement;
const dialog = (value: FakeNode) => value as unknown as HTMLDialogElement;
afterEach(() => vi.unstubAllGlobals());

describe("tutorial native-dialog context", () => {
  it("allows ordinary hints only without a modal, and rejects missing or detached targets", () => {
    fixture([]);
    expect(isTutorialContextVisible()).toBe(true);
    expect(isTutorialContextVisible(element(node()))).toBe(true);
    expect(isTutorialContextVisible(null)).toBe(false);
    expect(isTutorialContextVisible(element({ ...node(), isConnected: false }))).toBe(false);
  });

  it("blocks app-root hints when a body-sibling confirmation is open", () => {
    const app = node(), confirmation = node(), focus = node(confirmation);
    fixture([confirmation], focus);
    expect(isTutorialContextVisible()).toBe(false);
    expect(isTutorialContextVisible(element(app))).toBe(false);
    expect(isTutorialContextVisible(element(confirmation))).toBe(true);
  });

  it("uses current focus rather than DOM order when an earlier dialog is reopened", () => {
    const first = node(), last = node();
    fixture([first, last], node(first));
    expect(isTutorialContextVisible(element(first))).toBe(true);
    expect(isTutorialContextVisible(element(last))).toBe(false);
  });

  it("requires the innermost active modal when dialogs are nested", () => {
    const parent = node(), child = node(parent), content = node(child);
    fixture([parent, child], content);
    expect(isTutorialContextVisible(element(parent))).toBe(false);
    expect(isTutorialContextVisible(element(child))).toBe(true);
    expect(isTutorialContextVisible(element(content))).toBe(true);
  });

  it("uses hit testing when the focused control was removed", () => {
    const covered = node(), top = node();
    const owner = fixture([covered, top], null, node(top));
    expect(isTutorialContextVisible(element(top))).toBe(true);
    expect(isTutorialContextVisible(element(covered))).toBe(false);
    expect(owner.elementFromPoint).toHaveBeenCalledWith(200, 400);
  });

  it("defers an ambiguous multi-modal context instead of guessing from sibling order", () => {
    const first = node(), second = node();
    fixture([first, second]);
    expect(isTutorialContextVisible(element(first))).toBe(false);
    expect(isTutorialContextVisible(element(second))).toBe(false);
  });

  it("can ignore the current tutorial's own modal but still respects other dialogs", () => {
    const tutorial = node();
    fixture([tutorial], node(tutorial));
    expect(isTutorialContextVisible(undefined, dialog(tutorial))).toBe(true);
    const settings = node();
    fixture([settings, tutorial], node(tutorial));
    expect(isTutorialContextVisible(undefined, dialog(tutorial))).toBe(false);
    expect(isTutorialContextVisible(element(settings), dialog(tutorial))).toBe(true);
  });

  it("ignores closed or detached modal nodes and safely falls back without :modal support", () => {
    const closed = { ...node(), open: false }, detached = { ...node(), isConnected: false };
    fixture([closed, detached]);
    expect(isTutorialContextVisible()).toBe(true);
    const modal = node();
    const owner = fixture([modal], node(modal));
    vi.mocked(owner.querySelectorAll).mockImplementation(selector => {
      if (selector === "dialog:modal") throw new DOMException("Unsupported selector", "SyntaxError");
      return [modal] as unknown as NodeListOf<Element>;
    });
    expect(isTutorialContextVisible()).toBe(false);
    expect(isTutorialContextVisible(element(modal))).toBe(true);
  });
});
