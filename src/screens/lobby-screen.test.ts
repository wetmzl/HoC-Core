import { describe, expect, it, vi } from "vitest";
import { LobbyScreen, type LobbyScreenDependencies } from "./lobby-screen";
import type { CharacterDefinition } from "../content/characters";
const pending = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../content/characters", async importOriginal => ({ ...await importOriginal<typeof import("../content/characters")>(), loadCharacter: pending.load }));

describe("lobby profile loading", () => {
  it("does not render or select a profile whose load finishes after disposal", async () => {
    let finish!: (character: CharacterDefinition) => void;
    pending.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const querySelector = vi.fn();
    const screen = new LobbyScreen({ root: { querySelector } } as unknown as LobbyScreenDependencies);
    const selected = screen.selectedCharacterId;
    const open = screen.openProfile(selected);
    screen.dispose();
    finish({ id: "stale-character" } as CharacterDefinition);
    await open;
    expect(screen.selectedCharacterId).toBe(selected);
    expect(querySelector).not.toHaveBeenCalled();
  });
  it("ignores a profile request after another lobby destination is chosen", async () => {
    let finish!: (character: CharacterDefinition) => void;
    pending.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const querySelector = vi.fn();
    const screen = new LobbyScreen({ root: { querySelector }, navigateScreen: async () => undefined } as unknown as LobbyScreenDependencies);
    const selected = screen.selectedCharacterId;
    const open = screen.openProfile(selected);
    await screen.renderLobby("menu");
    finish({ id: "stale-character" } as CharacterDefinition);
    await open;
    expect(screen.selectedCharacterId).toBe(selected);
    expect(querySelector).not.toHaveBeenCalled();
  });
});
