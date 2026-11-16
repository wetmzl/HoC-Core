import { StoryBindingSchema, StorySceneSchema } from "../../core/story/schema";
import { visitStoryActions } from "../../core/story/extensions";
import type { StoryAction, StoryBinding, StoryScene } from "../../core/story/types";
import { HocpkgPortablePathSchema, type HocpkgManifest } from "./schema";
import type { ExtensionResource, HocpkgResourceHandler, ResourceHandlerContext } from "./resources";

export { StoryBindingSchema, StorySceneSchema };
function mediaReferences(scene: StoryScene): readonly { path: string; kind: "image" | "audio" }[] {
  const paths: { path: string; kind: "image" | "audio" }[] = [];
  if (scene.cover) paths.push({ path: scene.cover, kind: "image" });
  for (const actor of Object.values(scene.actors ?? {})) {
    if (actor.image) paths.push({ path: actor.image, kind: "image" });
    for (const image of Object.values(actor.images ?? {})) paths.push({ path: image, kind: "image" });
  }
  for (const node of scene.nodes) if (node.type === "present") visitStoryActions(node.action, action => {
    if (action.type === "stage") {
      if (action.background) paths.push({ path: action.background, kind: "image" });
      for (const actor of action.actors ?? []) if (actor.image) paths.push({ path: actor.image, kind: "image" });
    }
    if (action.type === "audio" && action.src) paths.push({ path: action.src, kind: "audio" });
  });
  return paths;
}
function requireLocalScene(id: string, context: ResourceHandlerContext): void {
  if (id.includes("#")) return; // Cross-package references are checked against the complete activated snapshot.
  const descriptor = context.manifest.resources.find(resource => resource.id === id);
  if (descriptor?.type !== "story.scene") throw new Error(`剧情引用必须指向 story.scene：${id}`);
  if (!context.descriptor.requires.includes(id) || !context.dependencies.has(id)) throw new Error(`剧情资源必须声明已激活依赖：${id}`);
}
export function createStorySceneResourceHandler(): HocpkgResourceHandler<StoryScene> {
  return { type: "story.scene", apiVersions: [1], async parse(payload, context) {
    const scene = StorySceneSchema.parse(payload);
    for (const reference of mediaReferences(scene)) {
      HocpkgPortablePathSchema.parse(reference.path);
      const file = context.manifest.files.find(file => file.path === reference.path);
      if (!file?.mediaType.startsWith(`${reference.kind}/`)) throw new Error(`剧情媒体必须引用同包已声明的${reference.kind === "image" ? "图片" : "音频"}：${reference.path}`);
      await context.resolvePath(reference.path);
    }
    for (const node of scene.nodes) if (node.type === "call" && node.sceneId !== context.descriptor.id) requireLocalScene(node.sceneId, context);
    return scene;
  } };
}
export function createStoryBindingResourceHandler(): HocpkgResourceHandler<StoryBinding> {
  return { type: "story.binding", apiVersions: [1], parse(payload, context) {
    const binding = StoryBindingSchema.parse(payload);
    requireLocalScene(binding.sceneId, context);
    return binding;
  } };
}
export interface StoryArchiveMetadata { readonly title: string; readonly description: string; readonly cover?: string }
export interface InstalledStoryScene { readonly archive: StoryArchiveMetadata; readonly id: string; readonly packageId: string; readonly version: string; readonly digest: string; readonly definition: StoryScene; resolvePath(path: string): string }
export interface InstalledStoryBinding { readonly id: string; readonly packageId: string; readonly version: string; readonly digest: string; readonly definition: StoryBinding }
export interface PreparedStoryContent { readonly scenes: readonly InstalledStoryScene[]; readonly bindings: readonly InstalledStoryBinding[]; readonly diagnostics: readonly string[]; resolveScene(id: string): StoryScene | undefined; resolveAsset(sceneId: string, path: string): string }
const qualify = (packageId: string, reference: string): string => reference.includes("#") ? reference : `${packageId}#${reference}`;
function qualifyAction(action: StoryAction, packageId: string): StoryAction {
  const media = (path: string) => `${packageId}#${path}`;
  if (action.type === "sequence" || action.type === "parallel") return { ...action, actions: action.actions.map(child => qualifyAction(child, packageId)) };
  if (action.type === "stage") return { ...action, background: action.background ? media(action.background) : action.background, actors: action.actors?.map(actor => actor.image ? { ...actor, image: media(actor.image) } : actor) };
  if (action.type === "audio" && action.src) return { ...action, src: media(action.src) };
  return action;
}
const fingerprints = new WeakMap<HocpkgManifest, string>();
const SHA256_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
const rotate = (value: number, bits: number): number => value >>> bits | value << 32 - bits;
/** Synchronous SHA-256 keeps construction of the already-verified content snapshot synchronous. */
function fingerprint(manifest: HocpkgManifest): string {
  const previous = fingerprints.get(manifest);
  if (previous) return previous;
  const sortBy = <T>(items: readonly T[], key: (value: T) => string) => [...items].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
  const source = JSON.stringify({ identity: manifest.identity,
    resources: sortBy(manifest.resources, item => item.id).map(item => [item.id, item.type, item.apiVersion, item.entry, [...item.requires].sort()]),
    files: sortBy(manifest.files, item => item.path).map(item => [item.path, item.bytes, item.sha256, item.mediaType]) });
  const input = new TextEncoder().encode(source), padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input); padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(input.length * 8 / 0x1_0000_0000)); view.setUint32(padded.length - 4, input.length * 8 >>> 0);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], words = new Uint32Array(64);
  for (let start = 0; start < padded.length; start += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(start + index * 4);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15], right = words[index - 2];
      words[index] = (rotate(left, 7) ^ rotate(left, 18) ^ left >>> 3) + words[index - 16] + (rotate(right, 17) ^ rotate(right, 19) ^ right >>> 10) + words[index - 7];
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const first = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + SHA256_K[index] + words[index];
      const second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c);
      h = g; g = f; f = e; e = d + first >>> 0; d = c; c = b; b = a; a = first + second >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = hash[index] + value >>> 0; });
  }
  const digest = hash.map(word => word.toString(16).padStart(8, "0")).join("");
  fingerprints.set(manifest, digest); return digest;
}
export function prepareStoryContent(resources: readonly ExtensionResource[]): PreparedStoryContent {
  const diagnostics: string[] = [];
  const identity = (resource: ExtensionResource) => ({ id: `${resource.packageId}#${resource.descriptor.id}`, packageId: resource.packageId, version: resource.packageManifest.identity.version,
    digest: fingerprint(resource.packageManifest) });
  const scenes: InstalledStoryScene[] = resources.filter(resource => resource.descriptor.type === "story.scene").map(resource => {
    const scene = StorySceneSchema.parse(resource.value);
    const cover = scene.cover ?? resource.packageManifest.metadata.coverImage;
    const archive: StoryArchiveMetadata = { title: scene.title?.trim() || resource.packageManifest.metadata.title,
      description: scene.description?.trim() || resource.packageManifest.metadata.description || "暂无剧情简介。",
      ...(cover ? { cover: resource.resolvePath(cover) } : {}) };
    return { ...identity(resource), archive, definition: { ...scene,
      actors: scene.actors ? Object.fromEntries(Object.entries(scene.actors).map(([id, actor]) => [id, { ...actor,
        image: actor.image ? `${resource.packageId}#${actor.image}` : undefined,
        images: actor.images ? Object.fromEntries(Object.entries(actor.images).map(([name, path]) => [name, `${resource.packageId}#${path}`])) : undefined }])) : undefined,
      nodes: scene.nodes.map(node => node.type === "call" ? { ...node, sceneId: qualify(resource.packageId, node.sceneId) } : node.type === "present" ? { ...node, action: qualifyAction(node.action, resource.packageId) } : node) }, resolvePath: resource.resolvePath };
  });
  const byId = new Map(scenes.map(scene => [scene.id, scene]));
  const bindings: InstalledStoryBinding[] = resources.filter(resource => resource.descriptor.type === "story.binding").map(resource => {
    const binding = StoryBindingSchema.parse(resource.value);
    return { ...identity(resource), definition: { ...binding, sceneId: qualify(resource.packageId, binding.sceneId) } };
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const scene of byId.values()) for (const node of scene.definition.nodes) if (node.type === "call") {
      const called = byId.get(node.sceneId);
      const error = !called ? `剧情 ${scene.id} 引用未激活剧情：${node.sceneId}`
        : node.entry && !called.definition.nodes.some(candidate => candidate.id === node.entry) ? `剧情调用入口不存在：${node.sceneId}#${node.entry}` : undefined;
      if (error) { diagnostics.push(error); byId.delete(scene.id); changed = true; break; }
    }
  }
  const availableBindings = bindings.filter(binding => {
    if (byId.has(binding.definition.sceneId)) return true;
    diagnostics.push(`剧情绑定 ${binding.id} 引用未激活剧情：${binding.definition.sceneId}`); return false;
  });
  const packages = new Map(resources.map(resource => [resource.packageId, resource]));
  return { scenes: scenes.filter(scene => byId.has(scene.id)), bindings: availableBindings, diagnostics, resolveScene: id => byId.get(id)?.definition, resolveAsset(sceneId, path) {
    const hash = path.indexOf("#");
    if (hash !== -1) {
      const owner = packages.get(path.slice(0, hash));
      if (!owner) throw new Error(`剧情媒体所属内容包未激活：${path.slice(0, hash)}`);
      return owner.resolvePath(HocpkgPortablePathSchema.parse(path.slice(hash + 1)));
    }
    const owner = byId.get(sceneId);
    if (!owner) throw new Error(`剧情资源不存在：${sceneId}`);
    return owner.resolvePath(HocpkgPortablePathSchema.parse(path));
  } };
}
