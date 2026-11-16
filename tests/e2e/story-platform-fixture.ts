import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import type { StoryScene } from "../../src/core/story/types";
import type { Page } from "@playwright/test";

export const STORY_FIXTURE_TEXT = "你好，访客。这里是中性剧情平台的演示。";

/** Use the real screen reading area, away from the protected toolbar. */
export async function tapStory(page: Page): Promise<void> {
  const player = (await page.locator("[data-story-player]").boundingBox())!;
  const controls = (await page.locator(".story-player-controls").boundingBox())!;
  await page.mouse.click(player.x + 5, controls.y + controls.height + 24);
}

/** Confirm the real skip UI so callers also cover the confirmation boundary. */
export async function skipStory(page: Page): Promise<void> {
  const player = page.locator("[data-story-player]");
  await player.getByRole("button", { name: "跳过", exact: true }).click();
  await player.locator('[aria-label="跳过剧情确认"]').getByRole("button", { name: "跳过剧情", exact: true }).click();
}

/** Read effective rendered opacity and geometry, including ancestor composition effects. */
export async function readStoryComposition(page: Page) {
  return page.locator("[data-story-player] .story-stage-actors").evaluate(stage => {
    const round = (value: number) => Math.round(value * 100) / 100;
    const bounds = stage.getBoundingClientRect();
    return {
      mode: stage.getAttribute("data-composition"), width: round(bounds.width), height: round(bounds.height),
      actors: [...stage.querySelectorAll<HTMLImageElement>(".story-actor")].map(image => {
        const box = image.getBoundingClientRect(), style = getComputedStyle(image);
        const transform = new DOMMatrixReadOnly(style.transform);
        let opacity = 1;
        for (let element: HTMLElement | null = image; element && !element.matches("[data-story-player]"); element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity);
        return { id: image.dataset.storyActor!, visible: !image.hidden && style.visibility !== "hidden" && style.display !== "none",
          x: round(box.x - bounds.x), y: round(box.y - bounds.y), width: round(box.width), height: round(box.height), opacity: round(opacity),
          scale: round(Math.hypot(transform.a, transform.b)), layoutHeight: image.offsetHeight, layer: Number(style.zIndex),
          focused: image.dataset.focused === "true", foreground: image.dataset.foreground === "true", brightness: Number(style.filter.match(/brightness\(([\d.]+)\)/)?.[1] ?? 1),
          naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, fit: style.objectFit };
      })
    };
  });
}

/** A generated, neutral package exercises the public package boundary end to end. */
export function storyPlatformPackage(startup = false): Buffer {
  const scenes: Record<string, StoryScene> = {
    main: {
      title: "剧情平台验证", entry: "stage", variables: { visitor: "访客" }, actors: { guide: { name: "引导员", image: "guide.png" } },
      nodes: [
        { id: "stage", type: "present", action: { type: "sequence", actions: [
          { type: "stage", overlay: 0.3, actors: [{ id: "guide", x: 30, y: 85, scale: 0.7 }] },
          { type: "parallel", actions: [
            { type: "animate", actor: "guide", durationMs: 250, keyframes: [{ x: 30 }, { x: 70 }] },
            { type: "animate", actor: "guide", durationMs: 250, keyframes: [{ opacity: 0.2 }, { opacity: 1 }] }
          ] }
        ] }, next: "intro" },
        { id: "intro", type: "say", speaker: "guide", speed: 8, segments: [{ text: "你好，{{visitor}}。" }, { pauseMs: 1500 }, { text: "这里是中性剧情平台的演示。" }], next: "route" },
        { id: "route", type: "choice", prompt: "请选择演示路径", required: true, options: [
          { id: "earn", text: "解锁测试服装", next: "reward" },
          { id: "leave", text: "结束演示", next: "end" },
          { id: "locked", text: "尚不可用", disabledReason: "需要先满足测试条件", enabledWhen: { type: "compare", operator: "eq", left: { type: "literal", value: true }, right: { type: "literal", value: false } }, next: "end" }
        ] },
        { id: "reward", type: "command", command: { type: "core.skin.unlock", apiVersion: 1, args: { characterId: "llama", skinId: "cloud-traveler" } }, next: "after" },
        { id: "after", type: "say", segments: [{ text: "解锁已完成，跳过时不会显示本句。" }], next: "end" },
        { id: "end", type: "end", result: "finished" }
      ]
    },
    speed: { entry: "first", nodes: [
      { id: "first", type: "say", speed: 10, segments: [{ text: "倍速只改变阅读和演出节奏，不会跳过任何对白或自动作出选项。".repeat(4) }], next: "end" },
      { id: "end", type: "end" }
    ] },
    auto: { entry: "first", nodes: [
      { id: "first", type: "say", segments: [{ text: "自动播放第一句。" }], next: "second" },
      { id: "second", type: "say", segments: [{ text: "自动播放第二句。" }], next: "end" },
      { id: "end", type: "end" }
    ] },
    long: { entry: "say", nodes: [
      { id: "say", type: "say", segments: [{ text: '<img src=x onerror="window.__storyInjection=true">中性内容 & 引号。'.repeat(24) }], next: "end" },
      { id: "end", type: "end" }
    ] },
    composition: { entry: "stage", actors: {
      guide: { name: "共同名", image: "guide.png", scale: 0.65 }, guest: { name: "访客", image: "guide.png", scale: 0.9 },
      twin: { name: "共同名", image: "guide.png" }, hidden: { name: "隐身演员", image: "guide.png" },
      collision: { name: "guest", image: "guide.png" }
    }, nodes: [
      { id: "stage", type: "present", action: { type: "sequence", actions: [{ type: "stage", actors: [
        { id: "guide", opacity: 0.8, layer: -2 }, { id: "guest", scale: 0.8, layer: 1000 },
        { id: "twin", visible: false }, { id: "hidden", visible: false }, { id: "collision", visible: false }
      ] }, { type: "wait", durationMs: 500 }] }, next: "narration" },
      { id: "narration", type: "say", segments: [{ text: "两位演员正在候场。" }], next: "key" },
      { id: "key", type: "say", speaker: "guide", segments: [{ text: "用演员键发言。" }], next: "after-key" },
      { id: "after-key", type: "say", segments: [{ text: "引导员说完，大家安静了一会儿。" }], next: "offscreen" },
      { id: "offscreen", type: "say", speaker: "策展人", segments: [{ text: "让我想一想。" }], next: "expression" },
      { id: "expression", type: "present", action: { type: "sequence", actions: [
        { type: "stage", actors: [{ id: "guide", image: "guide.png" }] }, { type: "wait", durationMs: 1500 }
      ] }, next: "name" },
      { id: "name", type: "say", speaker: "访客", segments: [{ text: "用显示名发言。" }], next: "hidden-name" },
      { id: "hidden-name", type: "say", speaker: "隐身演员", segments: [{ text: "隐藏演员没有登场。" }], next: "collision-key" },
      { id: "collision-key", type: "say", speaker: "collision", segments: [{ text: "隐藏演员键不能借名登场。" }], next: "hide-guest" },
      { id: "hide-guest", type: "present", action: { type: "stage", actors: [{ id: "guest", visible: false }] }, next: "guest-away" },
      { id: "guest-away", type: "say", segments: [{ text: "访客暂时离开了舞台。" }], next: "show-twin" },
      { id: "show-twin", type: "present", action: { type: "stage", actors: [{ id: "twin", visible: true }, { id: "guest", visible: true }] }, next: "ambiguous" },
      { id: "ambiguous", type: "say", speaker: "共同名", segments: [{ text: "同名不能替演员选边。" }], next: "shared-key" },
      { id: "shared-key", type: "say", speaker: "guide", segments: [{ text: "同名时演员键仍然明确。" }], next: "leave-guests" },
      { id: "leave-guests", type: "present", action: { type: "stage", remove: ["guest", "twin"] }, next: "alone" },
      { id: "alone", type: "say", speaker: "guide", segments: [{ text: "宾客离开后回到中央。" }], next: "choice" },
      { id: "choice", type: "choice", prompt: "请选择。", required: true, options: [{ id: "end", text: "结束布局检查", next: "end" }] },
      { id: "end", type: "end" }
    ] },
    timing: { entry: "first", actors: { guide: { name: "时钟测试", image: "guide.png" } }, nodes: [
      { id: "first", type: "say", segments: [{ text: "点击后立即进入下一句。" }], next: "stage" },
      { id: "stage", type: "present", action: { type: "stage", actors: [{ id: "guide", x: 0 }] }, next: "move" },
      { id: "move", type: "present", action: { type: "sequence", actions: [
        { type: "wait", durationMs: 60000 },
        { type: "parallel", actions: [
          { type: "animate", actor: "guide", delayMs: 60000, durationMs: 60000, keyframes: [{ x: 0 }, { x: 100 }] },
          { type: "wait", durationMs: 60000 }
        ] }
      ] }, next: "say" },
      { id: "say", type: "say", segments: [{ text: "计时" }, { pauseMs: 60000 }, { text: "完成。" }], next: "choice" },
      { id: "choice", type: "choice", required: true, prompt: "请选择。", options: [{ id: "end", text: "完成检查", next: "end" }] },
      { id: "end", type: "end" }
    ] }
  };
  const files: Record<string, Uint8Array> = {
    "guide.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=", "base64"),
    "module.json": Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [] })),
    "plugin.css": Buffer.from("/* Neutral story fixture. */"),
    "plugin.js": Buffer.from(`export function register() { return { handlers: [], createRuntime() { return { mountRuntime(context, signal) {
      const probe = { context, signal, results: [], errors: [],
        play(id) { void context.stories.play(id).then(result => probe.results.push(result), error => probe.errors.push(String(error))); },
        state() { return context.stories.getState(); }, cancel() { return context.stories.cancel(); }
      }; window.__storyProbe = probe;
      signal.addEventListener('abort', () => { probe.disposed = true; }, { once: true });
    } }; } }; }`)
  };
  const resources: { id: string; type: string; apiVersion: number; entry: string; requires: string[] }[] = [];
  for (const [id, scene] of Object.entries(scenes)) {
    files[`${id}.json`] = Buffer.from(JSON.stringify(scene));
    resources.push({ id, type: "story.scene", apiVersion: 1, entry: `${id}.json`, requires: [] });
  }
  if (startup) {
    files["binding.json"] = Buffer.from(JSON.stringify({ sceneId: "main", trigger: { on: ["core.game-started"] }, frequency: "save", scope: "global" }));
    resources.push({ id: "welcome", type: "story.binding", apiVersion: 1, entry: "binding.json", requires: ["main"] });
  }
  resources.push({ id: "module", type: "plugin.module", apiVersion: 13, entry: "module.json", requires: [] });
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: "story-platform", version: "1.0.0" },
    metadata: { title: "剧情平台测试", description: "中性声明式剧情测试包", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources, extensions: {},
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: path.endsWith(".png") ? "image/png" : path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "application/json" }))
  };
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) }));
}
