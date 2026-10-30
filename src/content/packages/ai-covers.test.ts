import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { resolvePresentation } from "./character-presentation";
import { CharacterMatchResourceSchema } from "./resources";
import { validateCharacterPackage } from "../../authoring-api";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { CharacterDialogueResourceSchema } from "../../dialogue/schema";

const reviewed = {
  chatgpt: "4314707f22d7cbfa044ed0f640acd42ee8d8614633b786c195f5d1f040a3525d",
  claude: "f87678806edbfe5c37375f216d7a0a1cdf113835c3e5c690dfa7677703d45f63",
  deepseek: "db30ec4154ce09826b6b3ee8d8f23da440b570a68ba4a59f783df6d994539189",
  gemini: "277fd9cdfe8ff6d8f5ad1f6479eb5cc2a1094dabcb78ccbc93efe493c1b939eb",
  llama: "e97f1407ffdd5dbaab2307693b6e1db7593ea401f1c14fbfa9bde4cbd512ad14"
};

for (const [id, sha256] of Object.entries(reviewed)) it(`${id} ships its reviewed native cover as a skin resource`, async () => {
  const root = new URL(`../../../public/characters/${id}/`, import.meta.url);
  const json = async (file: string) => JSON.parse(await readFile(new URL(file, root), "utf8"));
  const manifest = await json("hocpkg-info.json");
  const source = await json("resources/character-match.json");
  const appearance = await json("resources/appearance.json");
  expect(manifest.resources.find((resource: { type: string }) => resource.type === "presentation.character").apiVersion).toBe(2);
  expect(appearance.skins[0].unlock).toBeUndefined();
  expect(appearance.skins.slice(1).map((skin: { unlock: unknown }) => skin.unlock)).toEqual([{ type: "defeat-character", count: 1 }]);
  expect(source.metadata.previewImage).toEqual(source.definition.assets.cover);
  expect(source.metadata.previewImage).toEqual({ presentationRef: "image:cover" });
  expect(source.metadata.previewFocus).toEqual({ presentationRef: "focus:cover" });
  const current = CharacterMatchResourceSchema.parse(resolvePresentation(source, appearance));
  expect(current.metadata.previewImage).toBe("cover.png");
  expect((current.definition.assets as { cover: string }).cover).toBe("cover.png");
  expect(manifest.resources.find((resource: { type: string }) => resource.type === "game.character-match").apiVersion).toBe(13);
  expect(manifest.metadata.coverImage).toBe("cover.png");
  await validateCharacterPackage({ manifest, readFile: async file => new Uint8Array(await readFile(new URL(file, root))) });
  const cover = await readFile(new URL("cover.png", root));
  expect(createHash("sha256").update(cover).digest("hex")).toBe(sha256);
  const metadata = await sharp(cover).metadata();
  expect([metadata.width, metadata.height, metadata.format]).toEqual([1254, 1254, "png"]);
  expect((await sharp(cover).stats()).isOpaque).toBe(true);
  expect(getCharacterMetadata(id)?.previewImage).toBe(`/characters/${id}/cover.png`);
  expect((await loadCharacter(id)).assets.cover).toBe(`/characters/${id}/cover.png`);
});

for (const id of Object.keys(reviewed)) it(`${id} changes every outfit portrait and cover while keeping rules and dialogue`, async () => {
  const root = new URL(`../../../public/characters/${id}/`, import.meta.url);
  const json = async (file: string) => JSON.parse(await readFile(new URL(file, root), "utf8"));
  const manifest = await json("hocpkg-info.json");
  const source = await json("resources/character-match.json");
  const dialogue = await json("resources/dialogue.json");
  const appearance = await json("resources/appearance.json");
  expect(appearance.skins).toHaveLength(2);
  const skinId = appearance.skins[1].id;
  const base = CharacterMatchResourceSchema.parse(resolvePresentation(source, appearance));
  const selected = CharacterMatchResourceSchema.parse(resolvePresentation(source, appearance, { skinId }));
  expect(selected.definition.ai).toEqual(base.definition.ai);
  expect(selected.aiSkills).toEqual(base.aiSkills);
  expect(selected.rewardSkillResourceIds).toEqual(base.rewardSkillResourceIds);
  expect(selected.metadata.encounter).toEqual(base.metadata.encounter);
  expect(selected.metadata.previewImage).toBe(`skins/${skinId}/cover.png`);
  for (const [slot, file] of Object.entries({ relaxed: "relaxed", conflicted: "conflicted", mocking: "mocking", threatened: "threatened", unconscious: "unconscious-reclined", tap: "tap" })) {
    const portrait = resolvePresentation({ presentationRef: `portrait:${slot}` }, appearance, { skinId }) as { image: string };
    expect(portrait.image).toBe(`skins/${skinId}/${file}.png`);
    expect(manifest.files.find((entry: { path: string }) => entry.path === portrait.image)?.mediaType).toBe("image/png");
  }
  const baseDialogue = CharacterDialogueResourceSchema.parse(resolvePresentation(dialogue, appearance));
  const skinDialogue = CharacterDialogueResourceSchema.parse(resolvePresentation(dialogue, appearance, { skinId }));
  expect(skinDialogue.pools).toEqual(baseDialogue.pools);
  expect(skinDialogue.rules.map(({ portrait, ...rule }) => rule)).toEqual(baseDialogue.rules.map(({ portrait, ...rule }) => rule));
  expect(skinDialogue.rules.find(rule => rule.id === "character-tap")?.portrait?.image).toBe(`skins/${skinId}/tap.png`);
  const cover = await sharp(await readFile(new URL(`skins/${skinId}/cover.png`, root))).metadata();
  expect([cover.width, cover.height]).toEqual([1254, 1254]);
});
