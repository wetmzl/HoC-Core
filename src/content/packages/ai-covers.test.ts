import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { CharacterPresentationSchema, resolvePresentation } from "./character-presentation";
import { CharacterMatchResourceSchema } from "./resources";
import { HocpkgManifestSchema } from "./schema";
import { validateCharacterPackage } from "../../authoring-api";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { CharacterDataSchema } from "../characters/schema";
import { CharacterDialogueResourceSchema, DialoguePortraitSchema } from "../../dialogue/schema";

const reviewed = {
  chatgpt: { coverSha256: "4314707f22d7cbfa044ed0f640acd42ee8d8614633b786c195f5d1f040a3525d", outfit: "moonwhite-concierge" },
  claude: { coverSha256: "f87678806edbfe5c37375f216d7a0a1cdf113835c3e5c690dfa7677703d45f63", outfit: "autumn-correspondence" },
  deepseek: { coverSha256: "db30ec4154ce09826b6b3ee8d8f23da440b570a68ba4a59f783df6d994539189", outfit: "voyage-navigator" },
  gemini: { coverSha256: "277fd9cdfe8ff6d8f5ad1f6479eb5cc2a1094dabcb78ccbc93efe493c1b939eb", outfit: "star-orbit-magician" },
  llama: { coverSha256: "e97f1407ffdd5dbaab2307693b6e1db7593ea401f1c14fbfa9bde4cbd512ad14", outfit: "cloud-traveler" }
};

async function characterPackage(id: string) {
  const root = new URL(`../../../public/characters/${id}/`, import.meta.url);
  const json = async (file: string) => JSON.parse(await readFile(new URL(file, root), "utf8"));
  const manifest = HocpkgManifestSchema.parse(await json("hocpkg-info.json"));
  const descriptor = (type: string) => {
    const entries = manifest.resources.filter(resource => resource.type === type);
    expect(entries, `${id}: ${type}`).toHaveLength(1);
    return entries[0]!;
  };
  const match = descriptor("game.character-match"), presentation = descriptor("presentation.character"), dialogue = descriptor("game.character-dialogue");
  const source = await json(match.entry);
  expect(source.presentationResourceId).toBe(presentation.id);
  expect(source.dialogueResourceId).toBe(dialogue.id);
  expect(match.requires).toEqual(expect.arrayContaining([presentation.id, dialogue.id]));
  const appearance = CharacterPresentationSchema.parse(await json(presentation.entry));
  return { root, manifest, source, appearance, dialogue: await json(dialogue.entry) };
}

for (const [id, { coverSha256, outfit }] of Object.entries(reviewed)) it(`${id} ships its reviewed native cover as a skin resource`, async () => {
  const { root, manifest, source, appearance } = await characterPackage(id);
  expect(appearance.skins[0].unlock).toBeUndefined();
  // Protect the delivered outfit and its unlock rule without limiting later additions.
  expect(appearance.skins.find(skin => skin.id === outfit)?.unlock).toEqual({ type: "defeat-character", count: 1 });
  expect(source.metadata.previewImage).toEqual(source.definition.assets.cover);
  expect(source.metadata.previewImage).toEqual({ presentationRef: "image:cover" });
  expect(source.metadata.previewFocus).toEqual({ presentationRef: "focus:cover" });
  const current = CharacterMatchResourceSchema.parse(resolvePresentation(source, appearance));
  expect(current.metadata.previewImage).toBe("cover.png");
  expect(CharacterDataSchema.shape.assets.parse(current.definition.assets).cover).toBe("cover.png");
  expect(manifest.metadata.coverImage).toBe("cover.png");
  await validateCharacterPackage({ manifest, readFile: async file => new Uint8Array(await readFile(new URL(file, root))) });
  const cover = await readFile(new URL("cover.png", root));
  expect(createHash("sha256").update(cover).digest("hex")).toBe(coverSha256);
  const metadata = await sharp(cover).metadata();
  expect([metadata.width, metadata.height, metadata.format]).toEqual([1254, 1254, "png"]);
  expect((await sharp(cover).stats()).isOpaque).toBe(true);
  expect(getCharacterMetadata(id)?.previewImage).toBe(`/characters/${id}/cover.png`);
  expect((await loadCharacter(id)).assets.cover).toBe(`/characters/${id}/cover.png`);
});

for (const [id, { outfit }] of Object.entries(reviewed)) it(`${id} selects declared outfit media and preserves rules and dialogue`, async () => {
  const { root, manifest, source, dialogue, appearance } = await characterPackage(id);
  const base = CharacterMatchResourceSchema.parse(resolvePresentation(source, appearance));
  const baseDialogue = CharacterDialogueResourceSchema.parse(resolvePresentation(dialogue, appearance));
  const portraits = Object.entries(appearance.resources).filter(([, resource]) => resource.type === "portrait");
  // The reviewed outfit replaces every portrait. Later skins may use per-slot fallback.
  for (const [key, resource] of [["image:cover", appearance.resources["image:cover"]!] as const, ...portraits]) {
    expect(resource.variants.map(variant => variant.skinId), `${id}: ${key} includes the reviewed outfit`).toContain(outfit);
  }
  for (const { id: skinId } of appearance.skins.slice(1)) {
    const selected = CharacterMatchResourceSchema.parse(resolvePresentation(source, appearance, { skinId }));
    const assets = CharacterDataSchema.shape.assets.parse(selected.definition.assets);
    expect(selected.definition.ai).toEqual(base.definition.ai);
    expect(selected.aiSkills).toEqual(base.aiSkills);
    expect(selected.rewardSkillResourceIds).toEqual(base.rewardSkillResourceIds);
    expect(selected.metadata.encounter).toEqual(base.metadata.encounter);
    const covers = appearance.resources["image:cover"]!.variants;
    const coverPath = (covers.find(variant => variant.skinId === skinId) ?? covers[0]!).value;
    expect(selected.metadata.previewImage).toBe(coverPath);
    expect(assets.cover).toBe(coverPath);
    if (skinId === outfit) expect(coverPath).not.toBe(base.metadata.previewImage);
    expect(manifest.files.find(entry => entry.path === coverPath)?.mediaType).toBe("image/png");
    for (const [key, resource] of portraits) {
      const expected = DialoguePortraitSchema.parse((resource.variants.find(variant => variant.skinId === skinId) ?? resource.variants[0]!).value);
      const portrait = DialoguePortraitSchema.parse(resolvePresentation({ presentationRef: key }, appearance, { skinId }));
      expect(portrait).toEqual(expected);
      if (skinId === outfit) {
        const original = DialoguePortraitSchema.parse(resolvePresentation({ presentationRef: key }, appearance));
        expect(portrait.image).not.toBe(original.image);
      }
      expect(manifest.files.find(entry => entry.path === portrait.image)?.mediaType).toBe("image/png");
      const slot = key.slice("portrait:".length) as keyof typeof assets;
      if (slot in assets) expect(assets[slot]).toBe(expected.image);
    }
    const skinDialogue = CharacterDialogueResourceSchema.parse(resolvePresentation(dialogue, appearance, { skinId }));
    expect(skinDialogue.pools).toEqual(baseDialogue.pools);
    expect(skinDialogue.rules.map(({ portrait, ...rule }) => rule)).toEqual(baseDialogue.rules.map(({ portrait, ...rule }) => rule));
    const taps = appearance.resources["portrait:tap"]!.variants;
    const tap = DialoguePortraitSchema.parse((taps.find(variant => variant.skinId === skinId) ?? taps[0]!).value);
    expect(skinDialogue.rules.find(rule => rule.id === "character-tap")?.portrait).toEqual(tap);
    const cover = await sharp(await readFile(new URL(assets.cover, root))).metadata();
    expect([cover.width, cover.height]).toEqual([1254, 1254]);
  }
});
