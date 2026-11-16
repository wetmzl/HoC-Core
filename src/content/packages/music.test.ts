import { expect, it, vi } from "vitest";
import { createHocpkgResourceHandlers, mergeResourceHandlers } from "./resources";
import { loadHocpkgResources } from "./loader";
import { HocpkgManifestSchema } from "./schema";
import { MusicResourceSchema, prepareMusicResources } from "./music";
import { buildContentRegistry } from "./content-registry";

function fixture() {
  const body = { tracks: { theme: { path: "bgm/theme.opus", name: "主题" } }, rules: [{ id: "lobby", scene: "lobby", track: "theme", priority: "override" }] };
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "music", version: "1.0.0" },
    metadata: { title: "音乐包", description: "测试", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "main", type: "presentation.music", apiVersion: 1, entry: "music.json", requires: [] }],
    files: [{ path: "music.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" }, { path: "bgm/theme.opus", bytes: 1, sha256: "0".repeat(64), mediaType: "audio/ogg" }], extensions: {} });
  const resolvePath = vi.fn(async (path: string) => `blob:${path}`);
  const load = () => loadHocpkgResources(manifest, { handlers: createHocpkgResourceHandlers(), readJson: async () => body, resolvePath });
  return { body, manifest, resolvePath, load };
}

it("loads a standalone music package without a plugin or character, preserving ownership and URL lifecycle", async () => {
  const { manifest, load, resolvePath } = fixture(); const results = await load();
  expect(results[0].state).toBe("active"); expect(resolvePath).toHaveBeenCalledWith("bgm/theme.opus");
  const registry = buildContentRegistry([{ manifest, resources: results, resolvePath: path => `blob:${path}` }]);
  expect(prepareMusicResources(registry.extensions["presentation.music"])[0]).toMatchObject({ packageId: "example/music", resourceId: "main", title: "音乐包", tracks: { theme: { url: "blob:bgm/theme.opus", name: "主题" } } });
});

it.each(["../escape.opus", "https://example.org/music.mp3", "bgm/missing.opus", "image.png"])("rejects unsafe or undeclared music: %s", async path => {
  const { body, load } = fixture(); body.tracks.theme.path = path; expect((await load())[0].state).toBe("invalid");
});

it("rejects non-audio MIME, duplicate rule IDs, unknown tracks and numeric priority escalation", async () => {
  const { manifest, load, body } = fixture(); manifest.files[1].mediaType = "image/png";
  expect((await load())[0].state).toBe("invalid");
  expect(MusicResourceSchema.safeParse({ ...body, rules: [body.rules[0], body.rules[0]] }).success).toBe(false);
  expect(MusicResourceSchema.safeParse({ ...body, rules: [{ ...body.rules[0], track: "missing" }] }).success).toBe(false);
  expect(MusicResourceSchema.safeParse({ ...body, rules: [{ ...body.rules[0], priority: 999 }] }).success).toBe(false);
  expect(() => mergeResourceHandlers(createHocpkgResourceHandlers(), [{ type: "presentation.music", apiVersions: [1], parse: p => p }])).toThrow("核心资源类型");
});

it("keeps an unreadable optional track declared so playback can diagnose and fall through", async () => {
  const { manifest, load, resolvePath } = fixture(); resolvePath.mockRejectedValue(new Error("read failed"));
  const results = await load(); expect(results[0].state).toBe("active");
  const registry = buildContentRegistry([{ manifest, resources: results, resolvePath() { throw new Error("unavailable"); } }]);
  expect(prepareMusicResources(registry.extensions["presentation.music"])[0].tracks.theme.url).toBeUndefined();
});
