import { createSkinCharacterPackageDraft } from "../authoring-api";
import type { CharacterPresentation } from "../content/packages/character-presentation";
import { sha256 } from "../content/storage/encoding";
import type { HocpkgManifest } from "../content/packages/schema";
import type { ContentPackageAccess } from "../content/packages/content-source";

/** Neutral data-only fixture. Browser tests supply real images separately. */
export async function skinCharacterFixture() {
  const draft = createSkinCharacterPackageDraft("sample", "中性角色");
  const bodies = Object.fromEntries(Object.entries(draft.files).map(([path, text]) => [path, JSON.parse(text)]));
  const presentation = bodies["resources/appearance.json"] as CharacterPresentation;
  presentation.skins = [{ id: "default", name: "原装" }, { id: "b", name: "晚礼服" }, { id: "c", name: "旅行装" }];
  for (const [key, resource] of Object.entries(presentation.resources)) {
    if (key.startsWith("pool:")) resource.variants[0].value = ["继续这一轮。"];
  }
  const portrait = presentation.resources["portrait:relaxed"];
  portrait.variants.push({ skinId: "b", value: { image: "alternate.png", scale: 1.2, anchorY: .82, revolverPlacement: { top: 30, left: 100 } } });
  presentation.resources["image:cover"].variants.push({ skinId: "b", value: "alternate-cover.png" });
  presentation.resources["focus:cover"] = { type: "data", variants: [{ skinId: "default", value: { x: .5, y: .35 } }, { skinId: "b", value: { x: .48, y: .4 } }] };
  bodies["resources/character.json"].metadata.previewFocus = { presentationRef: "focus:cover" };
  presentation.resources["text:description"].variants.push({ skinId: "b", value: "B 的简介以 image.png 结尾。" });
  presentation.resources["music"] = { type: "audio", variants: [{ skinId: "default", value: "base.ogg" }, { skinId: "c", value: "travel.ogg" }] };
  bodies["resources/character.json"].metadata.matchMusic = { presentationRef: "music" };
  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  const rebuild = async () => {
    for (const [path, body] of Object.entries(bodies)) files[path] = encoder.encode(JSON.stringify(body));
    for (const path of ["cover.png", "relaxed.png", "conflicted.png", "mocking.png", "threatened.png", "unconscious.png", "alternate.png", "alternate-cover.png", "base.ogg", "travel.ogg"]) files[path] ??= new Uint8Array([1, 2, 3]);
    const manifest: HocpkgManifest = { ...draft.manifest, files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".ogg") ? "audio/ogg" : "image/png" }))) };
    return manifest;
  };
  const manifest = await rebuild();
  const access: ContentPackageAccess = { packageId: "creator/sample", manifest, async *files() {}, readFile: async path => files[path], readJson: async path => bodies[path], resolveAsset: async path => ({ url: `blob:sample/${path}` }) };
  return { draft, bodies, presentation, files, manifest, rebuild, access };
}
