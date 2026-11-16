import { describe, expect, it } from "vitest";
import { createStoryBindingResourceHandler, createStorySceneResourceHandler, prepareStoryContent } from "./stories";
import { HocpkgManifestSchema } from "./schema";
import type { ExtensionResource, ResourceHandlerContext } from "./resources";
import type { StoryScene } from "../../core/story/types";
import { encodeText, sha256 } from "../storage/encoding";
import { advanceStory, createStoryRun } from "../../core/story/engine";
import { StoryRunSchema, StorySceneSchema } from "../../core/story/schema";

function fixture() {
  const scene: StoryScene = { entry: "show", actors: { guide: { name: "向导", image: "guide.png" } }, nodes: [
    { id: "show", type: "present", action: { type: "parallel", actions: [{ type: "stage", background: "hall.png", actors: [{ id: "guide", x: 25 }] }, { type: "audio", channel: "sound", operation: "play", src: "bell.ogg" }] }, next: "end" }, { id: "end", type: "end" }
  ] };
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1, identity: { authorId: "example", packageName: "stories", version: "1.2.3" }, metadata: { title: "中性剧情", description: "剧情测试", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "intro", type: "story.scene", apiVersion: 1, entry: "intro.json", requires: [] }, { id: "trigger", type: "story.binding", apiVersion: 1, entry: "trigger.json", requires: ["intro"] }],
    files: ["intro.json", "trigger.json", "guide.png", "hall.png", "bell.ogg"].map(path => ({ path, bytes: 1, sha256: "a".repeat(64), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".png") ? "image/png" : "audio/ogg" })), extensions: {} });
  const resolved: string[] = [];
  const context: ResourceHandlerContext = { manifest, descriptor: manifest.resources[0], dependencies: new Map(), packageBaseUrl: "memory:/", resolvePath: path => { resolved.push(path); return `memory:/${path}`; } };
  const resource: ExtensionResource = { packageId: "example/stories", packageManifest: manifest, descriptor: manifest.resources[0], value: scene, resolvePath: path => `memory:/${path}` };
  return { scene, manifest, context, resolved, resource };
}

describe("story package resources", () => {
  it("validates declared media types and resolves each image and audio while installing", async () => {
    const data = fixture();
    await expect(createStorySceneResourceHandler().parse(data.scene, data.context)).resolves.toEqual(data.scene);
    expect(new Set(data.resolved)).toEqual(new Set(["guide.png", "hall.png", "bell.ogg"]));
    const wrongMime = { ...data.context, manifest: { ...data.manifest, files: data.manifest.files.map(file => file.path === "bell.ogg" ? { ...file, mediaType: "image/png" } : file) } };
    await expect(createStorySceneResourceHandler().parse(data.scene, wrongMime)).rejects.toThrow("音频");
    await expect(createStorySceneResourceHandler().parse(data.scene, { ...data.context, resolvePath: () => { throw new Error("missing bytes"); } })).rejects.toThrow("missing bytes");
  });

  it("validates an archive cover as package-owned declared image media", async () => {
    const data = fixture();
    const scene = { ...data.scene, title: "档案标题", description: "独立简介", cover: "hall.png" };
    await expect(createStorySceneResourceHandler().parse(scene, data.context)).resolves.toEqual(scene);
    expect(data.resolved).toContain("hall.png");
    await expect(createStorySceneResourceHandler().parse({ ...scene, cover: "bell.ogg" }, data.context)).rejects.toThrow("图片");
    await expect(createStorySceneResourceHandler().parse({ ...scene, cover: "missing.png" }, data.context)).rejects.toThrow("同包已声明");
    for (const cover of ["../hall.png", "/hall.png", "https://example.org/hall.png", "other/stories#hall.png"]) {
      expect(StorySceneSchema.safeParse({ ...scene, cover }).success).toBe(false);
    }
  });

  it("projects per-scene archive metadata and resolves each package's own cover", () => {
    const data = fixture();
    const first = { ...data.resource, value: { ...data.scene, title: "序章", description: "相识的故事", cover: "hall.png" } };
    const other = { ...data.resource, packageId: "other/story", resolvePath: (path: string) => `other:/${path}`,
      value: { ...data.scene, title: "后记", description: "重逢的故事", cover: "hall.png" } };
    const prepared = prepareStoryContent([first, other]);
    expect(prepared.scenes.map(scene => scene.archive)).toEqual([
      { title: "序章", description: "相识的故事", cover: "memory:/hall.png" },
      { title: "后记", description: "重逢的故事", cover: "other:/hall.png" }
    ]);
    expect(prepared.scenes[0].definition.cover).toBe("hall.png");
  });

  it("keeps old scenes valid and falls back to package metadata without inventing an image", () => {
    const data = fixture();
    expect(StorySceneSchema.safeParse(data.scene).success).toBe(true);
    const covered = { ...data.resource, packageManifest: { ...data.manifest, metadata: { ...data.manifest.metadata, coverImage: "guide.png" } } };
    expect(prepareStoryContent([covered]).scenes[0].archive).toEqual({ title: "中性剧情", description: "剧情测试", cover: "memory:/guide.png" });
    const noCover = prepareStoryContent([{ ...data.resource, value: { ...data.scene, title: "   ", description: " " } }]);
    expect(noCover.scenes[0].archive).toEqual({ title: "中性剧情", description: "剧情测试" });
  });

  it("requires active local scene dependencies for bindings and verifies cross-package calls against activated content", async () => {
    const data = fixture();
    const validBinding = { sceneId: "intro", trigger: {}, frequency: "game" };
    const bindingContext = { ...data.context, descriptor: data.manifest.resources[1] };
    expect(() => createStoryBindingResourceHandler().parse(validBinding, bindingContext)).toThrow("已激活依赖");
    expect(createStoryBindingResourceHandler().parse(validBinding, { ...bindingContext, dependencies: new Map([["intro", data.scene]]) })).toEqual(validBinding);
    const prepared = prepareStoryContent([data.resource, { ...data.resource, descriptor: data.manifest.resources[1], value: validBinding }]);
    expect(prepared.scenes[0]).toMatchObject({ id: "example/stories#intro", packageId: "example/stories", version: "1.2.3" });
    expect(prepared.scenes[0].digest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.bindings[0].definition.sceneId).toBe("example/stories#intro");
    expect(prepared.resolveAsset("example/stories#intro", "guide.png")).toBe("memory:/guide.png");
    const caller = { ...data.resource, value: { entry: "call", nodes: [{ id: "call", type: "call", sceneId: "other/scenes#missing", next: "end" }, { id: "end", type: "end" }] } };
    const unavailable = prepareStoryContent([caller]);
    expect(unavailable.scenes).toEqual([]);
    expect(unavailable.diagnostics[0]).toContain("未激活剧情");
  });

  it("qualifies local calls and validates an explicit called entry", () => {
    const data = fixture();
    const caller = { ...data.resource, descriptor: { ...data.resource.descriptor, id: "caller" }, value: { entry: "call", nodes: [{ id: "call", type: "call", sceneId: "intro", entry: "end", next: "end" }, { id: "end", type: "end" }] } };
    const prepared = prepareStoryContent([data.resource, caller]);
    expect(prepared.resolveScene("example/stories#caller")?.nodes[0]).toMatchObject({ sceneId: "example/stories#intro", entry: "end" });
    const unavailable = prepareStoryContent([data.resource, { ...caller, value: { entry: "call", nodes: [{ id: "call", type: "call", sceneId: "intro", entry: "absent", next: "end" }, { id: "end", type: "end" }] } }]);
    expect(unavailable.scenes.map(scene => scene.id)).toEqual(["example/stories#intro"]);
    expect(unavailable.diagnostics[0]).toContain("调用入口不存在");
  });

  it("pins package version, resource contracts and all media checksums with SHA-256", async () => {
    const data = fixture();
    const source = JSON.stringify({ identity: data.manifest.identity,
      resources: [...data.manifest.resources].sort((left, right) => left.id < right.id ? -1 : 1).map(item => [item.id, item.type, item.apiVersion, item.entry, [...item.requires].sort()]),
      files: [...data.manifest.files].sort((left, right) => left.path < right.path ? -1 : 1).map(item => [item.path, item.bytes, item.sha256, item.mediaType]) });
    const digest = prepareStoryContent([data.resource]).scenes[0].digest;
    expect(digest).toBe(await sha256(encodeText(source)));
    const changed = { ...data.resource, packageManifest: { ...data.manifest, files: data.manifest.files.map(file => file.path === "guide.png" ? { ...file, sha256: "b".repeat(64) } : file) } };
    expect(prepareStoryContent([changed]).scenes[0].digest).not.toBe(digest);
    const versioned = { ...data.resource, packageManifest: { ...data.manifest, identity: { ...data.manifest.identity, version: "1.2.4" } } };
    expect(prepareStoryContent([versioned]).scenes[0].digest).not.toBe(digest);
  });

  it("preserves media ownership across calls, returns, shared filenames and serialized checkpoints", () => {
    const data = fixture();
    const parent: ExtensionResource = { ...data.resource, resolvePath: path => `parent:/${path}`, value: { entry: "show", actors: { home: { name: "主人", image: "guide.png" } }, nodes: [
      { id: "show", type: "present", action: { type: "stage", background: "hall.png", actors: [{ id: "home" }] }, next: "call" },
      { id: "call", type: "call", sceneId: "other/scenes#sub", next: "line" }, { id: "line", type: "say", segments: [{ text: "回到主片段" }], next: "end" }, { id: "end", type: "end" }
    ] } };
    const child: ExtensionResource = { ...data.resource, packageId: "other/scenes", descriptor: { ...data.resource.descriptor, id: "sub" }, resolvePath: path => `child:/${path}`, value: { entry: "show", actors: { visitor: { name: "客人", image: "guide.png" } }, nodes: [
      { id: "show", type: "present", action: { type: "sequence", actions: [{ type: "stage", background: "hall.png", actors: [{ id: "visitor" }] }, { type: "audio", channel: "sound", operation: "play", src: "bell.ogg" }] }, next: "end" }, { id: "end", type: "end" }
    ] } };
    const prepared = prepareStoryContent([parent, child]);
    const host = { resolveScene: prepared.resolveScene };
    const initial = createStoryRun("example/stories#intro", host);
    const called = advanceStory(initial, host);
    expect(called.sceneId).toBe("other/scenes#sub");
    expect(StoryRunSchema.safeParse(JSON.parse(JSON.stringify(called))).success).toBe(true);
    const returned = advanceStory(called, host);
    expect(returned.sceneId).toBe("example/stories#intro");
    expect(returned.stage.actors.home.image).toBe("example/stories#guide.png");
    expect(returned.stage.actors.visitor.image).toBe("other/scenes#guide.png");
    expect(prepared.resolveAsset(returned.sceneId, returned.stage.actors.home.image!)).toBe("parent:/guide.png");
    expect(prepared.resolveAsset(returned.sceneId, returned.stage.actors.visitor.image!)).toBe("child:/guide.png");
    expect(prepared.resolveAsset(returned.sceneId, returned.stage.background!)).toBe("child:/hall.png");
    expect(StoryRunSchema.safeParse(JSON.parse(JSON.stringify(returned))).success).toBe(true);
    expect(StorySceneSchema.safeParse(prepared.resolveScene("other/scenes#sub")).success).toBe(false);
  });

  it("isolates callers with missing dependencies while preserving independent scenes", () => {
    const data = fixture();
    const bad: ExtensionResource = { ...data.resource, descriptor: { ...data.resource.descriptor, id: "bad" }, value: { entry: "call", nodes: [{ id: "call", type: "call", sceneId: "missing", next: "end" }, { id: "end", type: "end" }] } };
    const caller: ExtensionResource = { ...bad, descriptor: { ...bad.descriptor, id: "caller" }, value: { entry: "call", nodes: [{ id: "call", type: "call", sceneId: "bad", next: "end" }, { id: "end", type: "end" }] } };
    const binding: ExtensionResource = { ...data.resource, descriptor: data.manifest.resources[1], value: { sceneId: "caller", trigger: {} } };
    const prepared = prepareStoryContent([data.resource, bad, caller, binding]);
    expect(prepared.scenes.map(scene => scene.id)).toEqual(["example/stories#intro"]);
    expect(prepared.bindings).toEqual([]);
    expect(prepared.diagnostics).toHaveLength(3);
  });
});
