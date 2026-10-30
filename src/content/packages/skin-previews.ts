import type { ContentSource } from "./content-source";
import type { ResolvedContentAsset } from "../storage/contracts";
import { CharacterPresentationSchema, createPresentationResolver, isPresentationReference } from "./character-presentation";
import { DialoguePortraitSchema } from "../../dialogue/schema";

export interface SkinPreview { readonly id: string; readonly name: string; readonly image?: string; readonly cover?: string; readonly error?: string }
export interface SkinPreviews { readonly items: readonly SkinPreview[]; release(): void }

/** The picker borrows skin covers and fallback-pool portraits with its own media leases. */
export async function loadSkinPreviews(source: ContentSource, characterKey: string, signal: AbortSignal): Promise<SkinPreviews> {
  const [packageId, matchId] = characterKey.split("#");
  const access = (await source.packages()).find(access => access.packageId === packageId);
  const descriptor = access?.manifest.resources.find(resource => resource.id === matchId && resource.type === "game.character-match");
  if (!access || !descriptor) throw new Error("角色包不可用。");
  const match = await access.readJson(descriptor.entry) as {
    presentationResourceId: string; dialogueResourceId: string;
    definition?: { assets?: { cover?: unknown } };
  };
  const presentationDescriptor = access.manifest.resources.find(resource => resource.id === match.presentationResourceId && resource.type === "presentation.character");
  const dialogueDescriptor = access.manifest.resources.find(resource => resource.id === match.dialogueResourceId && resource.type === "game.character-dialogue");
  if (!presentationDescriptor || !dialogueDescriptor) throw new Error("角色缺少皮肤或对白声明。");
  const presentation = CharacterPresentationSchema.parse(await access.readJson(presentationDescriptor.entry));
  const dialogue = await access.readJson(dialogueDescriptor.entry) as { fallbackPoolId: string; poolPortraits: unknown };
  const assets = new Map<string, Promise<ResolvedContentAsset>>();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", release);
    for (const pending of assets.values()) void pending.then(asset => asset.release?.(), () => {});
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  const assetFor = (path: string): Promise<ResolvedContentAsset> => {
    if (released) return Promise.reject(new Error("换装窗口已关闭。"));
    if (!access.manifest.files.some(file => file.path === path && file.mediaType.startsWith("image/"))) return Promise.reject(new Error("皮肤预览未声明为图片。"));
    let asset = assets.get(path);
    if (!asset) { asset = access.resolveAsset(path); assets.set(path, asset); }
    return asset;
  };
  try {
    const items = await Promise.all(presentation.skins.map(async skin => {
      try {
        const resolve = createPresentationResolver(presentation, { skinId: skin.id }, { resolvePath: async path => (await assetFor(path)).url });
        const portraitValue = isPresentationReference(dialogue.poolPortraits)
          ? (await resolve(dialogue.poolPortraits) as Record<string, unknown>)?.[dialogue.fallbackPoolId]
          : await resolve((dialogue.poolPortraits as Record<string, unknown> | undefined)?.[dialogue.fallbackPoolId]);
        const portrait = DialoguePortraitSchema.parse(portraitValue);
        const asset = await assetFor(portrait.image);
        let cover: string | undefined;
        try {
          const coverPath = await resolve(match.definition?.assets?.cover);
          if (typeof coverPath === "string") cover = (await assetFor(coverPath)).url;
        } catch { /* An optional cover must not prevent choosing a valid portrait. */ }
        return { ...skin, image: asset.url, cover };
      } catch { return { ...skin, error: "立绘暂时不可用" }; }
    }));
    if (released) throw new Error("换装窗口已关闭。");
    return { items, release };
  } catch (error) { release(); throw error; }
}
