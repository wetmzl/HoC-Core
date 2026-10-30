import { describe, expect, it, vi } from "vitest";
import { ProfileController } from "./profile-controller";
import type { CharacterDefinition } from "../content/characters";
const pending = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../content/characters", async importOriginal => ({ ...await importOriginal<typeof import("../content/characters")>(), loadCharacter: pending.load }));

describe("shared profile lifecycle", () => {
  it.each(["navigation", "replaced dialog"])("ignores a late profile after %s", async reason => {
    let finish!: (character: CharacterDefinition) => void;
    pending.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const dialog = { isConnected: true, querySelector: vi.fn() };
    const selected = vi.fn(), invitation = vi.fn(), report = vi.fn();
    const profile = new ProfileController({ root: { querySelector: () => dialog } as unknown as HTMLDivElement, selected, invitation, report });
    const opening = profile.open("llama");
    if (reason === "navigation") profile.invalidate(); else dialog.isConnected = false;
    finish({ id: "llama" } as CharacterDefinition);
    await opening;
    expect(selected).not.toHaveBeenCalled(); expect(invitation).not.toHaveBeenCalled();
    expect(dialog.querySelector).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
  });
  it("checks flow identity after the character has loaded", async () => {
    const dialog = { isConnected: true, querySelector: vi.fn() };
    pending.load.mockResolvedValue({ id: "llama" });
    const selected = vi.fn();
    const profile = new ProfileController({ root: { querySelector: () => dialog } as unknown as HTMLDivElement, selected, invitation: vi.fn(), report: vi.fn() });
    await profile.open("llama", vi.fn(), () => false);
    expect(selected).not.toHaveBeenCalled(); expect(dialog.querySelector).not.toHaveBeenCalled();
  });
});
