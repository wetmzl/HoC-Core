import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import sharp from "sharp";
import { validateCharacterPackage } from "../../authoring-api";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { HocpkgManifestSchema } from "./schema";
import { createMatch } from "../../core/match/reducer";
import { DialogueEngine } from "../../dialogue/engine";
import { DialoguePrimitiveRegistry } from "../../dialogue/registry";
import { DialogueEventRegistry } from "../../dialogue/events";
// @ts-expect-error The standalone plugin module is plain JavaScript.
import { register } from "../../../public/characters/character-tap/module.js";

const read = (id: string, path: string) => readFile(new URL(`../../../public/characters/${id}/${path}`, import.meta.url));
const json = async (id: string, path: string) => JSON.parse((await read(id, path)).toString());
const pluginId = "hoc-core/character-tap";

for (const id of ["glm", "grok", "qwen"]) {
  it(`${id} validates as an independently importable package with its declared skills and rewards`, async () => {
    const manifest = HocpkgManifestSchema.parse(await json(id, "hocpkg-info.json"));
    await validateCharacterPackage({ manifest, readFile: async path => new Uint8Array(await read(id, path)) });
    const aiSkillIds = id === "glm" ? ["glm-not-secrets", "glm-aliyun-oss"] : id === "qwen" ? ["qwen-takeaway-and-milk-tea"] : ["grok-is-it-true", "grok-go-anywhere"];
    expect(manifest.resources.map(resource => resource.type).sort()).toEqual(["game.character-dialogue", "game.character-match", "presentation.character", ...aiSkillIds.map(() => "game.ai-skill"), "game.player-skill", ...(id === "qwen" ? ["game.status"] : [])].sort());
    const character = await loadCharacter(id);
    expect(getCharacterMetadata(id)?.faction).toBe(getCharacterMetadata("deepseek")?.faction);
    expect(character.aiSkills.map(skill => skill.definitionId)).toEqual(aiSkillIds);
    const match = await json(id, "resources/character-match.json");
    expect(match.rewardSkillResourceIds).toEqual(id === "grok" ? ["reward:grok-player"] : id === "qwen" ? ["player:qwen-takeaway-player"] : ["player:glm-aliyun-oss-player"]);
    expect(match.metadata.encounter).toEqual(getCharacterMetadata("deepseek")?.encounter);
    const state = createMatch(`new-role-${id}`, { opponentId: id, aiProfile: character.ai, opponentAiSkills: character.aiSkills, skillDeckIds: [] });
    expect(state.opponentId).toBe(id);
    expect(Object.keys(character.dialogue.pools).sort()).toEqual(Object.keys((await loadCharacter("deepseek")).dialogue.pools).sort());
    for (const lines of Object.values(character.dialogue.pools)) expect(lines.length).toBeGreaterThan(0);
    for (const value of Object.values(character.matchSummary)) expect(value.length).toBeGreaterThan(0);
  });

  it(`${id} matches DeepSeek media dimensions and ships distinct transparent state PNGs`, async () => {
    const hashes = new Set<string>();
    for (const state of ["cover", "relaxed", "conflicted", "mocking", "threatened", "unconscious-reclined", "tap"]) {
      const bytes = await read(id, `${state}.png`);
      const reference = await sharp(await read("deepseek", `${state}.png`)).metadata();
      const metadata = await sharp(bytes).metadata();
      expect([metadata.width, metadata.height, metadata.format]).toEqual([reference.width, reference.height, "png"]);
      if (state !== "cover") {
        expect(metadata.hasAlpha).toBe(true);
        expect((await sharp(bytes).stats()).isOpaque).toBe(false);
      }
      const { createHash } = await import("node:crypto");
      hashes.add(createHash("sha256").update(bytes).digest("hex"));
      expect(bytes.equals(await read("deepseek", `${state}.png`))).toBe(false);
    }
    expect(hashes.size).toBe(7);
  });

  it(`${id} switches ordinary tap art, retains roulette art and keeps defeated art after a loss`, async () => {
    const character = await loadCharacter(id);
    const payload = await json("character-tap", "resources.json");
    const registry = new DialoguePrimitiveRegistry();
    registry.registerPackage(pluginId, payload.dialoguePrimitives, register().dialoguePrimitives);
    const events = new DialogueEventRegistry();
    events.registerPackage(pluginId, payload.dialogueEvents);
    const base = createMatch(`tap-${id}`, { opponentId: id, opponentAiSkills: [] });
    const tap = { id: "tap", type: `${pluginId}#tap`, apiVersion: 1, data: { actor: "opponent", x: .5, y: .5, region: "full-portrait" } };
    const normal = new DialogueEngine(character.dialogue, id, registry, events).accept(base, tap);
    expect(normal.poolId).toBe("CHARACTER_TAP");
    expect(normal.portrait?.image).toBe(`/characters/${id}/tap.png`);
    const pending = { ...base, round: { ...base.round, phase: "roulette-trigger" as const, currentActor: null, outcome: { winner: "player" as const, reason: "comparison" as const, penaltyTarget: "opponent" as const, bulletsAdded: 1 } } };
    const engine = new DialogueEngine(character.dialogue, id, registry, events);
    const before = engine.accept(pending, { id: "ready", type: "core.trigger-ready", apiVersion: 1, data: { actor: "opponent" } });
    engine.commit(before);
    const during = engine.accept(pending, tap);
    expect(during.poolId).toBe("CHARACTER_TAP_ROULETTE");
    expect(during.portrait).toEqual(before.portrait);
    const lost = { ...base, round: { ...base.round, phase: "roulette-result" as const, currentActor: null }, history: [...base.history, { type: "TRIGGER_PULLED" as const, actor: "opponent" as const, probability: 1, baseProbability: 1, misfireChance: 0, result: "fired" as const, fired: true }] };
    const defeated = new DialogueEngine(character.dialogue, id, registry, events).accept(lost, tap);
    expect(defeated.poolId).toBe("CHARACTER_TAP_DEFEATED");
    expect(defeated.portrait?.image).toBe(`/characters/${id}/unconscious-reclined.png`);
  });
}
