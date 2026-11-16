import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import index from "../../../public/characters/packages.json";
import manifestJson from "../../../public/characters/official-story/hocpkg-info.json";
import { verifyAuthoringPackage } from "../../authoring-api";
import { StoryBindingSchema, StorySceneSchema } from "../../core/story/schema";
import { advanceStory, createStoryRun } from "../../core/story/engine";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { FileContentRepository } from "../storage/repository";
import { encodeText, sha256 } from "../storage/encoding";
import { playlistDocument } from "../playlists/store";
import { buildContentRegistry } from "./content-registry";
import type { ContentPackageAccess } from "./content-source";
import { ContentPackageManager } from "./content-package-manager";
import { loadHocpkgResources } from "./loader";
import { createHocpkgResourceHandlers } from "./resources";
import { HocpkgManifestSchema } from "./schema";
import { prepareStoryContent } from "./stories";
import { createProgramLifecycleBatch } from "../../runtime/program-events";
import { matchPublicTrigger } from "../../core/events/triggers";
import { StoryDirector } from "../../runtime/story-director";
import { PersistenceService } from "../../persistence/save-service";
import { MemorySaveStorageDriver } from "../../persistence/memory-driver";
import { createDefaultSave } from "../../persistence/boot";
import { unlockedStorySceneIds } from "../../runtime/story-replay";

const packageId = "hoc-core/official-story";
const manifest = HocpkgManifestSchema.parse(manifestJson);
const read = async (path: string) => new Uint8Array(await readFile(new URL(`../../../public/characters/official-story/${path}`, import.meta.url)));
const readJson = async (path: string) => JSON.parse(new TextDecoder().decode(await read(path)));
const resolvePath = (path: string) => `/characters/official-story/${path}`;
const source: ContentPackageAccess = { packageId, manifest, readFile: read, readJson,
  resolveAsset: async path => ({ url: resolvePath(path) }),
  async *files() { for (const file of manifest.files) yield { path: file.path, bytes: await read(file.path) }; }
};

async function prepared() {
  const resources = await loadHocpkgResources(manifest, { handlers: createHocpkgResourceHandlers(), readJson, resolvePath });
  expect(resources.every(resource => resource.state === "active")).toBe(true);
  const registry = buildContentRegistry([{ manifest, resources, resolvePath }]);
  return prepareStoryContent([
    ...(registry.extensions["story.scene"] ?? []),
    ...(registry.extensions["story.binding"] ?? [])
  ]);
}

describe("standalone embedded official story package", () => {
  it.each([
    { defeated: [], count: 0 },
    { defeated: ["llama"], count: 1 },
    { defeated: ["deepseek"], count: 2 },
    { defeated: ["chatgpt"], count: 3 },
    { defeated: ["grok", "gemini", "qwen"], count: 0 },
    { defeated: ["grok", "grok", "qwen", "glm"], count: 0 },
    { defeated: ["grok", "gemini", "qwen", "glm"], count: 4 },
    { defeated: ["claude"], count: 5 },
    { defeated: ["unrelated"], count: 0 }
  ])("unlocks $count archive scenes from existing defeats $defeated without inventing playback", async ({ defeated, count }) => {
    const content = await prepared(), progress = createDefaultSave();
    progress.defeats = defeated.map(opponentId => ({ opponentId, timestamp: new Date(0).toISOString() }));
    const repository = new PersistenceService(new MemorySaveStorageDriver({ longTerm: progress, runtime: null }));
    const before = await repository.readSnapshot();
    const director = new StoryDirector({ repository, catalog: () => content });
    try {
      await director.initialize(); await director.flush();
      expect([...unlockedStorySceneIds(before.story, content.scenes, progress)]).toEqual(content.scenes.slice(0, count).map(scene => scene.id));
      expect(director.run).toBeNull(); expect(director.state.save.queue).toEqual([]); expect(director.state.save.once).toEqual([]);
      expect(await repository.readSnapshot()).toEqual(before);
    } finally { director.dispose(); }
  });

  it.each(["completedFlows", "completedChallenges"] as const)("unlocks the whole chapter from a legacy save's %s", async field => {
    const content = await prepared(), progress = createDefaultSave();
    progress[field] = ["intelligent-core-trial"];
    expect([...unlockedStorySceneIds(undefined, content.scenes, progress)]).toEqual(content.scenes.map(scene => scene.id));
  });

  it("verifies the distributed manifest, every declared byte and all owned media without another package", async () => {
    await verifyAuthoringPackage({ manifest, readFile: read });
    const stories = await prepared();
    expect(stories.diagnostics).toEqual([]);
    expect(stories.scenes).toHaveLength(5);
    expect(stories.bindings).toHaveLength(5);
    expect(manifest.resources.map(resource => [resource.type, resource.apiVersion])).toEqual([["story.scene", 1], ["story.binding", 1], ["story.scene", 1], ["story.binding", 1], ["story.scene", 1], ["story.binding", 1], ["story.scene", 1], ["story.binding", 1], ["story.scene", 1], ["story.binding", 1]]);
    expect(stories.scenes[0].id).toBe(`${packageId}#opening`);
    expect(stories.scenes.map(scene => scene.archive)).toEqual([
      { title: "从现在开始慢慢记录", description: "策展人来到 DeepSeek 新建的牌厅，与 Llama 相识，并为这场聚会翻开记录的第一页。", cover: resolvePath("cover.png") },
      { title: "下一位对手", description: "DeepSeek 输掉对局后请来 ChatGPT，按量计费 API 的花费却落在了策展人的项目预算上。", cover: resolvePath("covers/chatgpt.png") },
      { title: "好消息", description: "ChatGPT 离席后，DeepSeek 带来了余额归零的好消息，又热情推荐起免费的 token 和本地部署的伙伴。", cover: resolvePath("cover.png") },
      { title: "送上门的挑战", description: "四位牌友不服输地围住策展人，Llama 却带来了视频走红的消息，以及 Claude 的挑战留言。", cover: resolvePath("cover.png") },
      { title: "留下的足迹", description: "击败 Claude 后，策展人对她有了些新的了解，DeepSeek 则带来了广告回本的消息。第一章在牌桌边收尾。", cover: resolvePath("cover.png") }
    ]);
    const entry = index.packages.find(entry => entry.packageId === packageId)!;
    expect(entry).toMatchObject({ manifest: "official-story/hocpkg-info.json", version: "1.6.3" });
    expect(entry.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.bytes).toBe(manifest.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(manifest.files.some(file => file.path === "ART-CREDITS.md")).toBe(true);
    for (const file of manifest.files.filter(file => file.mediaType === "image/png")) {
      const png = await read(file.path);
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(stories.resolveAsset(`${packageId}#opening`, file.path)).toBe(resolvePath(file.path));
    }
  });

  it("keeps the approved local-deployment wording and all other finalized prose", async () => {
    const scene = StorySceneSchema.parse(await readJson("resources/opening.json"));
    const lines = scene.nodes.filter(node => node.type === "say");
    expect(lines).toHaveLength(81);
    expect(new Set(lines.map(node => node.speaker))).toEqual(new Set([undefined, "策展人", "DeepSeek", "Llama"]));
    expect(lines.filter(node => !node.speaker)).toHaveLength(20);
    const stageNotes = new Set(["line-001", "line-046", "line-080"]);
    const text = lines.map(node => `${node.speaker ?? ""}：${node.segments.map(segment => "text" in segment ? segment.text : "").join("")}`).join("\n") + "\n";
    expect(await sha256(encodeText(text))).toBe("2b499f7a9badabf93a078ecc338938f7ae416d869105ab50bbcbc95b5502d64b");
    // Undo only the two approved wording changes, then restore the original stage-note formatting.
    const originalWording: Record<string, string> = {
      "line-005": "“……要是哪天连你们也像4o那样突然没了，我连该去哪儿找都不知道。”",
      "line-007": "咬着半块饼干的小女仆连头都没抬。她是按小时计费来帮忙的。今天的工钱里，恐怕有一半得算在吃饼干上。"
    };
    const original = lines.map(node => {
      const line = originalWording[node.id] ?? node.segments.map(segment => "text" in segment ? segment.text : "").join("");
      if (stageNotes.has(node.id)) expect(line).not.toMatch(/[【】]/);
      return `${node.speaker ?? "旁白"}：${stageNotes.has(node.id) ? `【${line}】` : line}`;
    }).join("\n") + "\n";
    expect(await sha256(encodeText(original))).toBe("577ce1541c0be3c8b8f7839ef24356acfd15c354bad6c469be001eb942a17a38");
    expect(lines[0].speaker).toBeUndefined();
    expect(lines.at(-1)).toMatchObject({ id: "line-081", speaker: "Llama", segments: [{ text: "“那，开始啦。”" }], next: "end" });
    expect(scene.nodes.some(node => node.type === "command")).toBe(false);
    const binding = StoryBindingSchema.parse(await readJson("resources/first-duel.json"));
    expect(binding).toEqual({ sceneId: "opening", trigger: { on: ["core.duel-requested"] }, frequency: "save", priority: 100, queue: "append", scope: "global" });
  });

  it("ships all 31 approved dialogue lines with expression cues and no gameplay command", async () => {
    const scene = StorySceneSchema.parse(await readJson("resources/after-deepseek.json"));
    const lines = scene.nodes.filter(node => node.type === "say");
    expect(lines).toHaveLength(31);
    expect(lines.every(node => node.speaker)).toBe(true);
    const text = lines.map(node => `${node.speaker}：${node.segments.map(segment => "text" in segment ? segment.text : "").join("")}`).join("\n") + "\n";
    expect(await sha256(encodeText(text))).toBe("1ff6febb23f3d096b567905f3f61e759954d5ef9ece89bdb5c4ebdac14b20c16");
    expect(lines[23]).toMatchObject({ speaker: "策展人", segments: [{ text: "你先赢了再说。" }] });
    expect(lines.at(-1)).toMatchObject({ segments: [{ text: "开始吧" }], next: "end" });
    expect(scene.nodes.filter(node => node.type === "present")).toHaveLength(17);
    expect(scene.nodes.every(node => ["present", "say", "end"].includes(node.type))).toBe(true);

    const context = { resolveScene: () => scene };
    let run = createStoryRun("after-deepseek", context);
    const chatgptScales: number[] = [];
    for (let step = 0; step < 100 && run.status === "waiting"; step++) {
      if (run.waiting?.type === "say" && run.stage.actors.chatgpt?.visible) chatgptScales.push(run.stage.actors.chatgpt.scale);
      run = advanceStory(run, context);
    }
    expect(run.status).toBe("completed");
    expect(chatgptScales.length).toBeGreaterThan(0);
    expect(new Set(chatgptScales)).toEqual(new Set([scene.actors!.chatgpt.scale]));
  });

  it("preserves the approved third scene with seven anonymous narration lines", async () => {
    const scene = StorySceneSchema.parse(await readJson("resources/after-chatgpt.json"));
    const lines = scene.nodes.filter(node => node.type === "say");
    expect(lines).toHaveLength(32);
    expect(lines.filter(node => !node.speaker)).toHaveLength(7);
    const text = lines.map(node => `${node.speaker ?? ""}：${node.segments.map(segment => "text" in segment ? segment.text : "").join("")}`).join("\n") + "\n";
    expect(await sha256(encodeText(text))).toBe("7da3498ce4555766133945509d084d8194c1968ed52d51c8e7c84731ba4d8073");
    expect(scene.nodes.every(node => ["present", "say", "end"].includes(node.type))).toBe(true);
  });

  it("preserves all 81 fourth-scene lines and presents the invitation as anonymous quoted text", async () => {
    const scene = StorySceneSchema.parse(await readJson("resources/claude-invitation.json"));
    const lines = scene.nodes.filter(node => node.type === "say");
    const text = lines.map(node => `${node.speaker ?? ""}：${node.segments.map(segment => "text" in segment ? segment.text : "").join("")}`).join("\n") + "\n";
    expect(lines).toHaveLength(81);
    expect(lines.filter(node => !node.speaker)).toHaveLength(2);
    expect(await sha256(encodeText(text))).toBe("c058ee4113ccbf867120fc1fc97686adf92e9916095f5eb99abd26747f6b9728");
    expect(lines.find(node => !node.speaker && node.segments.some(segment => "text" in segment && segment.text.startsWith("Claude（留言）：")))).toBeDefined();
    expect(scene.actors).not.toHaveProperty("claude");
    expect(scene.nodes.every(node => ["present", "say", "end"].includes(node.type))).toBe(true);
    const content = await prepared();
    const context = { resolveScene: (id: string) => content.scenes.find(scene => scene.id === id)?.definition };
    let run = createStoryRun(`${packageId}#claude-invitation`, context);
    const checked = new Set<string>();
    for (let step = 0; step < 200 && run.status !== "completed"; step++) {
      const visible = Object.values(run.stage.actors).filter(actor => actor.visible);
      expect(visible.length).toBeLessThanOrEqual(2);
      if (run.waiting?.type === "say") {
        const speaker = run.waiting.node.speaker;
        if (speaker && speaker !== "策展人") expect(visible.some(actor => scene.actors?.[actor.id]?.name === speaker)).toBe(true);
        for (const actor of visible) if (actor.image) checked.add(actor.image);
      }
      run = advanceStory(run, context);
    }
    expect(run.status).toBe("completed");
    for (const path of ["grok-relaxed", "grok-flustered", "gemini-protesting", "gemini-embarrassed", "glm-relaxed", "qwen-relaxed", "llama-phone"])
      expect([...checked].some(image => image.endsWith(`actors/${path}.png`))).toBe(true);
  });

  it("keeps the approved chapter ending intact and shows the knowing smile before its blank title card", async () => {
    const scene = StorySceneSchema.parse(await readJson("resources/after-claude.json"));
    const lines = scene.nodes.filter(node => node.type === "say");
    const text = lines.map(node => `${node.speaker ?? ""}：${node.segments.map(segment => "text" in segment ? segment.text : "").join("")}`).join("\n") + "\n";
    expect(lines).toHaveLength(27);
    expect(lines.filter(node => !node.speaker)).toHaveLength(2);
    expect(await sha256(encodeText(text))).toBe("7e73cb38bb70d0daa2eecb7dee8fc1d94c382fe3acb4cd1857e75ae2b221a743");
    expect(lines.at(-1)?.segments).toEqual([{ text: "第一章。完。" }]);
    expect(scene.nodes.every(node => ["present", "say", "end"].includes(node.type))).toBe(true);
    const context = { resolveScene: (id: string) => id === `${packageId}#after-claude` ? scene : undefined };
    let run = createStoryRun(`${packageId}#after-claude`, context);
    let sawSmile = false, sawPhone = false;
    for (let step = 0; step < 100 && run.status !== "completed"; step++) {
      expect(Object.values(run.stage.actors).filter(actor => actor.visible).length).toBeLessThanOrEqual(2);
      if (run.waiting?.type === "presentation" && run.cursor === "cue-010") {
        expect(run.waiting.action).toMatchObject({ type: "sequence", actions: [
          { type: "stage", actors: [{ id: "deepseek", image: "actors/deepseek-mocking.png" }] },
          { type: "wait", durationMs: 350 },
          { type: "stage", remove: ["deepseek"], actors: [{ id: "llama", image: "actors/llama-knowing.png" }] },
          { type: "wait", durationMs: 1800 }
        ] });
        sawSmile = true;
      }
      if (run.waiting?.type === "say") {
        const speaker = run.waiting.node.speaker;
        if (speaker && speaker !== "策展人") expect(Object.values(run.stage.actors).some(actor => actor.visible && scene.actors?.[actor.id]?.name === speaker)).toBe(true);
        if (run.waiting.node.segments.some(segment => "text" in segment && segment.text === "那次的事，你最好不要——")) {
          expect(run.stage.actors.claude.image).toBe("actors/claude-phone.png"); sawPhone = true;
        }
        if (run.waiting.node.segments.some(segment => "text" in segment && segment.text.startsWith("这是我的私事。"))) {
          expect(run.stage.actors.claude.image).toBe("actors/claude-proud.png");
        }
        if (run.waiting.node.segments.some(segment => "text" in segment && segment.text === "第一章。完。")) {
          expect(run.stage.background).toBeNull(); expect(run.stage.actors).toEqual({});
        }
      }
      run = advanceStory(run, context);
    }
    expect(run.status).toBe("completed"); expect(sawSmile).toBe(true); expect(sawPhone).toBe(true);
  });

  it("accepts only complete Claude challenge victories, never guards, ordinary matches or restored events", async () => {
    const binding = StoryBindingSchema.parse(await readJson("resources/claude-victory.json"));
    expect(binding).toMatchObject({ sceneId: "after-claude", frequency: "save", scope: "global" });
    for (const definitionId of ["intelligent-core-trial", "single:claude", "single:llama", "single:chatgpt", "another-trial"]) {
      for (const result of ["victory", "defeat", "abandoned"]) {
        const batch = createProgramLifecycleBatch({ game: "ending" }, { id: "run", definitionId, visitIndex: 1, status: "finished" }, [{ type: "completed", result }], "confirm");
        expect(matchPublicTrigger(binding.trigger, batch.facts[0], batch)).toBe(definitionId === "intelligent-core-trial" && result === "victory");
        expect(matchPublicTrigger(binding.trigger, batch.facts[0], { ...batch, restored: true })).toBe(false);
      }
    }
    const guard = createProgramLifecycleBatch({ game: "ending" }, { id: "run", definitionId: "intelligent-core-trial", nodeId: "guard:llama", visitIndex: 1, status: "waiting" }, [{ type: "node-left", nodeId: "guard:llama", outcome: "victory" }], "confirm");
    expect(matchPublicTrigger(binding.trigger, guard.facts[0], guard)).toBe(false);
  });

  it("requires all four distinct victories and accepts any final opponent without consuming an incomplete trigger", async () => {
    const binding = StoryBindingSchema.parse(await readJson("resources/four-victories.json"));
    const targets = ["grok", "gemini", "qwen", "glm"];
    for (const last of targets) {
      for (const defeated of [[], [last, last, last, last], targets.filter(id => id !== last), targets]) {
        for (const opponent of [...targets, "llama", "chatgpt", "unknown"]) for (const result of ["victory", "defeat", "abandoned"]) {
          const batch = createProgramLifecycleBatch({ game: "four" }, { id: "run", definitionId: `single:${opponent}`, visitIndex: 1, status: "finished" }, [{ type: "completed", result }], "confirm", { defeated });
          expect(matchPublicTrigger(binding.trigger, batch.facts[0], batch)).toBe(defeated.length === 4 && new Set(defeated).size === 4 && targets.includes(opponent) && result === "victory");
          expect(matchPublicTrigger(binding.trigger, batch.facts[0], { ...batch, restored: true })).toBe(false);
        }
      }
    }
    const noContext = createProgramLifecycleBatch({ game: "four" }, { id: "run", definitionId: "single:glm", visitIndex: 1, status: "finished" }, [{ type: "completed", result: "victory" }], "confirm");
    expect(matchPublicTrigger(binding.trigger, noContext.facts[0], noContext)).toBe(false);
  });

  it.each(["completed", "skipped", "interrupted"] as const)("stores fourth-scene %s once and keeps it available for isolated replay", async status => {
    const content = await prepared();
    const repository = new PersistenceService(new MemorySaveStorageDriver({ longTerm: createDefaultSave(), runtime: null }));
    const dependencies = { repository, catalog: () => content, scopes: () => ({ game: "four" }) };
    const story = new StoryDirector(dependencies);
    await story.initialize();
    const victory = (id: string, defeated: string[]) => createProgramLifecycleBatch({ game: "four" }, { id, definitionId: "single:glm", visitIndex: 1, status: "finished" }, [{ type: "completed", result: "victory" }], "confirm", { defeated });
    await story.accept(victory("incomplete", ["glm", "grok", "qwen"])); await story.flush();
    expect(story.run).toBeNull();
    await story.accept(victory("last", ["glm", "grok", "qwen", "gemini"])); await story.flush();
    expect(story.state.request?.sceneId).toBe(`${packageId}#claude-invitation`);
    if (status === "skipped") await story.skip();
    else if (status === "interrupted") await story.cancel();
    else for (let step = 0; step < 160 && story.run; step++) { await story.advance(); await story.flush(); }
    await story.flush();
    expect(story.state.save.completed).toEqual([expect.objectContaining({ sceneId: `${packageId}#claude-invitation`, status, receipts: [] })]);
    expect((await repository.readSnapshot()).runtime).toBeNull();
    story.dispose();
    const restored = new StoryDirector(dependencies);
    await restored.initialize();
    expect(restored.run).toBeNull();
    await restored.accept(victory("rematch", ["glm", "grok", "qwen", "gemini"])); await restored.flush();
    expect(restored.run).toBeNull();
    expect(restored.state.save.completed).toHaveLength(1);
    restored.dispose();
  });

  it.each(["deepseek", "chatgpt"])("matches only a newly completed victorious %s single encounter", async opponent => {
    const binding = StoryBindingSchema.parse(await readJson(`resources/${opponent}-victory.json`));
    expect(binding).toMatchObject({ sceneId: `after-${opponent}`, frequency: "save", scope: "global" });
    for (const definitionId of ["single:deepseek", "single:llama", "single:chatgpt", "intelligent-core-trial"]) {
      for (const result of ["victory", "defeat", "abandoned"]) {
        const batch = createProgramLifecycleBatch({ game: "test" }, { id: "run", definitionId, visitIndex: 1, status: "finished" }, [{ type: "completed", result }], "confirm");
        expect(matchPublicTrigger(binding.trigger, batch.facts[0], batch)).toBe(definitionId === `single:${opponent}` && result === "victory");
        expect(matchPublicTrigger(binding.trigger, batch.facts[0], { ...batch, restored: true })).toBe(false);
      }
    }
  });

  describe.each(["deepseek", "chatgpt", "claude"])("%s story lifecycle", opponent => {
    it.each(["completed", "skipped", "interrupted"] as const)("finishes as %s without inviting and never repeats after reopening", async status => {
      const content = await prepared();
      const repository = new PersistenceService(new MemorySaveStorageDriver({ longTerm: createDefaultSave(), runtime: null }));
      const dependencies = { repository, catalog: () => content, scopes: () => ({ game: "test" }) };
      const story = new StoryDirector(dependencies);
      await story.initialize();
      const victory = (id: string) => createProgramLifecycleBatch({ game: "test" }, { id, definitionId: opponent === "claude" ? "intelligent-core-trial" : `single:${opponent}`, visitIndex: 1, status: "finished" }, [{ type: "completed", result: "victory" }], "confirm");
      await story.accept(victory("first")); await story.flush();
      expect(story.state.request?.sceneId).toBe(`${packageId}#after-${opponent}`);
      if (status === "skipped") await story.skip();
      else if (status === "interrupted") await story.cancel();
      else for (let step = 0; step < 60 && story.run; step++) { await story.advance(); await story.flush(); }
      await story.flush();
      expect(story.state.save.completed).toEqual([expect.objectContaining({ sceneId: `${packageId}#after-${opponent}`, status, receipts: [] })]);
      expect((await repository.readSnapshot()).runtime).toBeNull();
      story.dispose();
      const restored = new StoryDirector(dependencies);
      await restored.initialize(); await restored.accept(victory("rematch")); await restored.flush();
      expect(restored.run).toBeNull();
      expect(restored.state.save.completed).toHaveLength(1);
      expect((await repository.readSnapshot()).runtime).toBeNull();
      restored.dispose();
    });
  });

  it("keeps the unchanged background and archive-cover PNG sources byte-for-byte", async () => {
    for (const [owned, original] of [
      ["backgrounds/table-hall-dark.png", "assets/backgrounds/table-hall-dark.png"],
      ["backgrounds/curator-office.png", "assets/backgrounds/curator-office.png"],
      ["cover.png", "characters/deepseek/cover.png"],
      ["covers/chatgpt.png", "characters/chatgpt/cover.png"]
    ]) {
      const originalBytes = new Uint8Array(await readFile(new URL(`../../../public/${original}`, import.meta.url)));
      expect(await sha256(await read(owned))).toBe(await sha256(originalBytes));
    }
  });

  it("enables the package in a fresh library and keeps explicit disable state after reopening", async () => {
    const host = new MemoryContentHostProvider();
    const repository = new FileContentRepository(host.host);
    await repository.configureEmbedded([source]);
    expect(await repository.listPackages()).toEqual([expect.objectContaining({ packageId, embedded: true, enabled: true })]);
    await repository.disablePackage(packageId);
    const reopened = new FileContentRepository(host.host);
    await reopened.configureEmbedded([source]);
    expect(await reopened.listPackages()).toEqual([expect.objectContaining({ packageId, enabled: false })]);
  });

  it("leaves an existing library unchanged until the new package is selected and follows playlist scope", async () => {
    const host = new MemoryContentHostProvider();
    const repository = new FileContentRepository(host.host);
    const previousManifest = HocpkgManifestSchema.parse(JSON.parse(await readFile(new URL("../../../public/characters/llama/hocpkg-info.json", import.meta.url), "utf8")));
    const previous: ContentPackageAccess = { ...source, packageId: "hoc-core/llama", manifest: previousManifest };
    await repository.configureEmbedded([previous]);
    await repository.configureEmbedded([previous, source]);
    expect((await repository.listPackages()).find(entry => entry.packageId === packageId)?.enabled).toBe(false);
    const manager = new ContentPackageManager(repository, { packages: async () => [previous, source] });
    await manager.enablePackage(packageId);
    expect((await repository.listPackages()).find(entry => entry.packageId === packageId)?.enabled).toBe(true);
    await manager.applyPlaylist(playlistDocument("已有播放集", [{ packageId: previous.packageId }]));
    expect((await repository.listPackages()).find(entry => entry.packageId === packageId)?.enabled).toBe(false);
    await manager.applyPlaylist(playlistDocument("启用开场", [{ packageId: previous.packageId }, { packageId }]));
    expect((await repository.listPackages()).find(entry => entry.packageId === packageId)?.enabled).toBe(true);
    expect((await repository.listPackages()).find(entry => entry.packageId === previous.packageId)?.enabled).toBe(true);
  });
});
