import { expect, it, vi } from "vitest";
import { PluginCreditsDeclarationSchema, assertPluginCreditsVersion } from "./plugin-declarations";
import { collectPluginCredits } from "./plugin-credits";
import { readPluginAuthoring } from "../../authoring-api";
import { loadPluginModules } from "./plugin-modules";
import { HocpkgManifestSchema } from "./schema";
import { sha256 } from "../storage/encoding";
import { createDefaultSave } from "../../persistence/boot";
import { renderLobbyMarkup } from "../../lobby-screen-module";

const credits = { paragraphs: [[{ text: "示例贡献者", href: "https://example.com/profile" }, { text: "：测试与反馈。" }]] };

it("validates nonempty text paragraphs and HTTP links without accepting markup fields", () => {
  expect(PluginCreditsDeclarationSchema.parse(credits)).toEqual(credits);
  expect(PluginCreditsDeclarationSchema.parse({ paragraphs: [[{ text: "本地说明", href: "http://example.com" }]] })).toBeDefined();
  for (const value of [
    { paragraphs: [] }, { paragraphs: [[]] }, { paragraphs: [[{ text: "" }]] },
    { paragraphs: [[{ text: "bad", href: "javascript:alert(1)" }]] },
    { paragraphs: [[{ text: "bad", href: "not a URL" }]] },
    { paragraphs: [[{ text: "bad", html: "<b>raw</b>" }]] }
  ]) expect(PluginCreditsDeclarationSchema.safeParse(value).success).toBe(false);
  for (const version of [2, 3, 4, 5, 6]) expect(() => assertPluginCreditsVersion(version, credits)).toThrow("API 7");
  expect(() => assertPluginCreditsVersion(7, credits)).not.toThrow();
  expect(() => assertPluginCreditsVersion(2, undefined)).not.toThrow();
});

it("merges modules by host package identity and follows plugin order with stable unranked entries", () => {
  const modules = [
    { packageId: "test/a", title: "同名", credits },
    { packageId: "test/b", title: "同名", credits },
    { packageId: "test/a", title: "同名", credits: { paragraphs: [[{ text: "第二模块" }]] } },
    { packageId: "test/c", title: "其他", credits },
    { packageId: "test/empty", title: "无致谢" }
  ];
  const sections = collectPluginCredits(modules, ["test/b", "test/a"]);
  expect(sections.map(s => s.packageId)).toEqual(["test/b", "test/a", "test/c"]);
  expect(sections[1].paragraphs).toEqual([...credits.paragraphs, [{ text: "第二模块" }]]);
  expect(credits.paragraphs).toHaveLength(1);
  expect(collectPluginCredits([], [])).toEqual([]);
});

it("appends escaped plugin sections after the complete built-in credits only", () => {
  const markup = renderLobbyMarkup({ menuActions: [], save: createDefaultSave(), layer: "menu", guests: [], defeated: [], visibleDefeated: [], defeatedRemaining: 0,
    pluginCredits: [{ packageId: "test/credits", title: "<b>示例</b>", paragraphs: [[{ text: '<img src=x onerror="alert(1)">' }, { text: "链接", href: 'https://example.com/?a=1&b=2' }]] }]
  });
  expect(markup).toContain("&lt;b&gt;示例&lt;/b&gt;");
  expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(markup).toContain('href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"');
  expect(markup.indexOf('data-plugin-credits="test/credits"')).toBeGreaterThan(markup.indexOf("谢谢你们让HoC项目继续运转！"));
  expect(markup.match(/data-plugin-credits=/g)).toHaveLength(1);
});

async function packageFixture(apiVersion: number, declaration: unknown = credits) {
  const files: Record<string, Uint8Array> = {
    "module.json": new TextEncoder().encode(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [], credits: declaration })),
    "plugin.js": new TextEncoder().encode("export function register(){return {handlers:[],createRuntime(){return {};}}}"),
    "plugin.css": new TextEncoder().encode("/* neutral */")
  };
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: "credits", version: "1.0.0" },
    metadata: { title: "中性致谢", description: "公开契约验证", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion, entry: "module.json", requires: [] }],
    files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" }))), extensions: {}
  });
  return { manifest, readFile: vi.fn(async (path: string) => files[path]), packageId: "test/credits", files: async function* () {}, readJson: vi.fn(), resolveAsset: vi.fn() };
}

it("exposes API 7 credits through the DOM-free authoring contract", async () => {
  expect((await readPluginAuthoring(await packageFixture(7))).modules[0].credits).toEqual(credits);
  await expect(readPluginAuthoring(await packageFixture(6))).rejects.toThrow("API 7");
  await expect(readPluginAuthoring(await packageFixture(7, { paragraphs: [[]] }))).rejects.toThrow();
});

it("rejects a declaration on an old API before executing code or exposing credits", async () => {
  const access = await packageFixture(6);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const plugins = await loadPluginModules({ packages: async () => [access] });
    expect(plugins.registrations).toEqual([]);
    expect(access.readFile.mock.calls.map(([path]) => path)).toEqual(["module.json"]);
    plugins.release();
  } finally { warn.mockRestore(); }
});
