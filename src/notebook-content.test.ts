import { describe, expect, it } from "vitest";
import { loadCharacter } from "./content/characters/loader";
import type { CharacterDefinition } from "./content/characters/types";
import { notebookDialogueLines, notebookEndings, notebookPortraits } from "./notebook-content";

const original = await loadCharacter("llama");
const character = (data: Partial<CharacterDefinition>): CharacterDefinition => ({ ...original, ...data });

describe("notebook character material projection", () => {
  it("lists authored dialogue from every pool without evaluating conditions or repeating identical lines", () => {
    const entry = character({ dialogue: { ...original.dialogue, pools: { basic: ["First", "Shared"], extension: ["Shared", "Added", " "] } } });
    expect(notebookDialogueLines(entry)).toEqual(["First", "Shared", "Added"]);
  });

  it("collects package table calibration and dialogue portrait overrides without exposing a profile cover", () => {
    const entry = character({
      assets: { ...original.assets, cover: "cover.png", relaxed: "relaxed.png", conflicted: "conflicted.png", mocking: "mocking.png", threatened: "threatened.png", unconscious: "unconscious.png", defeatedSummary: "ending-only.png" },
      tablePortrait: { anchorY: 1, images: [{ image: "relaxed.png", anchorY: 1 }, { image: "extra-table.png", anchorY: 1 }] },
      dialogue: { ...original.dialogue, poolPortraits: { extra: { image: "pool.png" } }, rules: original.dialogue.rules.slice(0, 1).map(rule => ({ ...rule, portrait: { image: "rule.png" } })) }
    });
    expect(notebookPortraits(entry).map(art => art.image)).toEqual(["relaxed.png", "conflicted.png", "mocking.png", "threatened.png", "unconscious.png", "extra-table.png", "pool.png", "rule.png"]);
    expect(notebookPortraits(entry).map(art => art.label)).toContain("常态");
  });

  it("keeps unencountered endings free of prose and image references while sharing actual summary artwork", () => {
    const entry = character({ assets: { ...original.assets, defeatedSummary: "victory.png", relaxed: "defeat.png", conflicted: "escape.png" }, matchSummary: { playerVictory: "Won", playerDefeat: "Lost", escaped: "Left" } });
    expect(notebookEndings(entry, ["playerDefeat"])).toEqual([
      { id: "playerVictory", label: "策展人胜利", unlocked: false },
      { id: "playerDefeat", label: "策展人落败", unlocked: true, image: "defeat.png", text: "Lost" },
      { id: "escaped", label: "策展人离席", unlocked: false }
    ]);
    expect(notebookEndings(entry, ["playerVictory", "escaped"]).filter(ending => ending.unlocked).map(ending => ending.image)).toEqual(["victory.png", "escape.png"]);
    expect(notebookEndings(character({ assets: { ...entry.assets, defeatedSummary: undefined } }), ["playerVictory"])[0].image).toBe(entry.assets.unconscious);
  });
});
