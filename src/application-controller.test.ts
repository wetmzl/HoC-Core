import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ABILITY_DEFINITIONS } from "./core/abilities/registry";
import { CHARACTER_CATALOG } from "./content/characters/catalog";
import { EmbeddedContentSource } from "./content/packages/content-source";
import { MemoryContentHostProvider } from "./content/storage/memory-host";
import { FileContentRepository } from "./content/storage/repository";
import * as pluginModules from "./content/packages/plugin-modules";
import { PlaylistStore, playlistDocument } from "./content/playlists/store";
import { ApplicationController, ApplicationControllerBusyError } from "./application-controller";

const publicRoot = resolve(import.meta.dirname, "../public");
const fileFetch: typeof fetch = async (input) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "https://game.test");
  try {
    const body = readFileSync(resolve(publicRoot, `.${url.pathname}`));
    return new Response(body, { status: 200, headers: { "content-type": url.pathname.endsWith(".json") ? "application/json" : "application/octet-stream" } });
  } catch {
    return new Response("missing", { status: 404 });
  }
};

async function setup() {
  const provider = new MemoryContentHostProvider();
  const embedded = new EmbeddedContentSource({ fetch: fileFetch });
  const characterPackage = (await embedded.packages()).find((entry) => entry.packageId === "hoc-core/chatgpt");
  if (!characterPackage) throw new Error("missing characterPackage fixture");
  await new FileContentRepository(provider.host).install(characterPackage);
  let disposeCount = 0;
  const controller = new ApplicationController({
    providers: [provider],
    embedded: { fetch: fileFetch },
    mountRuntime: async () => ({ dispose: async () => { disposeCount += 1; } })
  });
  return { provider, controller, disposeCount: () => disposeCount };
}

describe("ApplicationController", () => {
  it("waits for third-party acknowledgement before plugin loading and returns idle on cancellation", async () => {
    const provider = new MemoryContentHostProvider();
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const base = (await embedded.packages()).find((entry) => entry.packageId === "hoc-core/chatgpt")!;
    await new FileContentRepository(provider.host).install({ ...base, manifest: { ...base.manifest, identity: { ...base.manifest.identity, authorId: "example" } } });
    let answer!: (accepted: boolean) => void;
    const acknowledge = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const mountRuntime = vi.fn(async () => ({ dispose: async () => {} }));
    const plugins = vi.spyOn(pluginModules, "loadPluginModules");
    const controller = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch }, acknowledgeThirdPartyContent: acknowledge, mountRuntime });
    try {
      const start = controller.startGame({} as HTMLDivElement);
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
      expect(controller.state).toBe("starting");
      expect(plugins).not.toHaveBeenCalled();
      expect(mountRuntime).not.toHaveBeenCalled();
      answer(false);
      expect(await start).toBe(false);
      expect(controller.state).toBe("idle");
      expect(plugins).not.toHaveBeenCalled();
      const retry = controller.startGame({} as HTMLDivElement);
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
      answer(true);
      expect(await retry).toBe(true);
      expect(plugins).toHaveBeenCalledOnce();
      expect(mountRuntime).toHaveBeenCalledOnce();
      await controller.stopGame();
    } finally { plugins.mockRestore(); }
  });

  it("does not request acknowledgement for official or disabled third-party packages", async () => {
    const provider = new MemoryContentHostProvider();
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const base = (await embedded.packages()).find((entry) => entry.packageId === "hoc-core/chatgpt")!;
    const repository = new FileContentRepository(provider.host);
    await repository.install(base);
    await repository.install({ ...base, manifest: { ...base.manifest, identity: { ...base.manifest.identity, authorId: "example" } } }, { newPackagesEnabled: false });
    const acknowledge = vi.fn(async () => true);
    const controller = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch }, acknowledgeThirdPartyContent: acknowledge, mountRuntime: async () => ({ dispose: async () => {} }) });
    expect(await controller.startGame({} as HTMLDivElement)).toBe(true);
    expect(acknowledge).not.toHaveBeenCalled();
    await controller.stopGame();
  });

  it("migrates old builtin identities and saved playlists while preserving disable state and installed resources", async () => {
    const provider = new MemoryContentHostProvider();
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const bases = (await embedded.packages()).filter((entry) => ["hoc-core/chatgpt", "hoc-core/claude"].includes(entry.packageId));
    const repository = new FileContentRepository(provider.host);
    for (const base of bases) await repository.install({ ...base, manifest: { ...base.manifest, identity: { ...base.manifest.identity, authorId: "hoc-art" } } });
    await repository.disablePackage("hoc-art/claude");
    const before = await repository.readFile("hoc-art/chatgpt", "resources/character-match.json");
    const store = new PlaylistStore(provider.fileSystem);
    const saved = await store.save(playlistDocument("旧播放集", [{ packageId: "hoc-art/chatgpt", version: "1.0.4" }]));
    await store.copy(saved.id);
    const controller = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch } });
    await controller.initialize();
    const migrated = new FileContentRepository(provider.host);
    expect((await migrated.listPackages()).map(({ packageId, enabled }) => ({ packageId, enabled }))).toEqual([
      { packageId: "hoc-core/chatgpt", enabled: true }, { packageId: "hoc-core/claude", enabled: false }
    ]);
    expect(await migrated.readFile("hoc-core/chatgpt", "resources/character-match.json")).toEqual(before);
    expect((await migrated.readManifest("hoc-core/chatgpt")).metadata.creators).toEqual([{ displayName: "HoC-core", roles: ["maintainer"] }]);
    expect((await controller.listPlaylists()).every((entry) => entry.document.packages[0]?.packageId === "hoc-core/chatgpt")).toBe(true);
    expect(await controller.currentPlaylistId()).toBe(saved.id);
    const restarted = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch } });
    await restarted.initialize();
    expect((await migrated.listPackages()).map((entry) => entry.packageId)).toEqual(["hoc-core/chatgpt", "hoc-core/claude"]);
  });

  it("keeps resource management available when legacy and canonical identities collide", async () => {
    const provider = new MemoryContentHostProvider();
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const base = (await embedded.packages()).find((entry) => entry.packageId === "hoc-core/chatgpt")!;
    const repository = new FileContentRepository(provider.host);
    await repository.install(base);
    await repository.install({ ...base, manifest: { ...base.manifest, identity: { ...base.manifest.identity, authorId: "hoc-art" } } });
    const controller = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch } });
    await expect(controller.listPackages()).resolves.toHaveLength(8);
    expect(controller.warnings).toEqual([expect.stringContaining("同时存在")]);
    await controller.removePackage("hoc-art/chatgpt");
    expect((await new FileContentRepository(provider.host).listPackages()).map((entry) => entry.packageId)).toEqual(["hoc-core/chatgpt"]);
  });

  it("keeps the active saved playlist in sync with package changes and restores it after switching", async () => {
    const provider = new MemoryContentHostProvider();
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const characters = (await embedded.packages()).filter((entry) => ["hoc-core/chatgpt", "hoc-core/claude"].includes(entry.packageId));
    const repository = new FileContentRepository(provider.host);
    await repository.installBatch(characters);
    const controller = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch } });
    await controller.listPackages();
    const original = (await controller.listPlaylists())[0]!;
    expect(await controller.currentPlaylistId()).toBe(original.id);
    const copy = await controller.copyPlaylist(original.id);
    await controller.selectPlaylist(copy.id);
    await controller.disablePackage("hoc-core/claude");
    expect((await controller.listPlaylists()).find((item) => item.id === copy.id)?.document.packages.map((item) => item.packageId)).toEqual(["hoc-core/chatgpt"]);
    await controller.selectPlaylist(original.id);
    expect((await controller.listPackages()).find((item) => item.packageId === "hoc-core/claude")?.enabled).toBe(true);
    const restored = new ApplicationController({ providers: [provider], embedded: { fetch: fileFetch } });
    expect(await restored.currentPlaylistId()).toBe(original.id);
    expect((await restored.listPlaylists()).find((item) => item.id === copy.id)?.document.packages).toHaveLength(1);
  });

  it("continues with a visible warning when persistent storage is refused", async () => {
    const provider = new MemoryContentHostProvider();
    const refusingProvider = {
      id: "refusing",
      async probe() { return true; },
      async open() {
        return {
          ...provider.host,
          capabilities: { ...provider.host.capabilities, canRequestPersistence: true, requestPersistence: async () => false }
        };
      }
    };
    const controller = new ApplicationController({ providers: [refusingProvider], embedded: { fetch: fileFetch } });

    const packages = await controller.listPackages();

    expect(packages).toHaveLength(7);
    expect(controller.warnings).toEqual(["浏览器拒绝提供持久化存储，你的存档和数据可能被浏览器静默清理"]);
    expect(await new FileContentRepository(provider.host).isEmpty()).toBe(false);
  });

  it("serializes package operations around a repeatable game runtime", async () => {
    const { controller, disposeCount } = await setup();
    const root = {} as HTMLDivElement;

    const firstStart = controller.startGame(root);
    await expect(controller.startGame(root)).rejects.toBeInstanceOf(ApplicationControllerBusyError);
    await firstStart;
    expect(controller.state).toBe("running");
    expect(CHARACTER_CATALOG.map((entry) => entry.id)).toEqual(["chatgpt"]);
    await expect(controller.disablePackage("hoc-core/chatgpt")).rejects.toBeInstanceOf(ApplicationControllerBusyError);
    await controller.stopGame();
    expect(controller.state).toBe("idle");
    expect(disposeCount()).toBe(1);
    expect(CHARACTER_CATALOG).toEqual([]);
    expect(ABILITY_DEFINITIONS).toEqual([]);

    await controller.startGame(root);
    await controller.stopGame();
    expect(disposeCount()).toBe(2);
  });

  it("leaves no installed globals after package verification fails", async () => {
    const { provider, controller } = await setup();
    const file = [...provider.fileSystem.entries.keys()].find((path) => path.endsWith("resources/character-match.json"));
    if (!file) throw new Error("missing character resource fixture");
    provider.fileSystem.entries.set(file, new TextEncoder().encode("corrupt"));

    await expect(controller.startGame({} as HTMLDivElement)).rejects.toThrow(/文件大小不符|文件摘要不符/);
    expect(controller.state).toBe("idle");
    expect(CHARACTER_CATALOG).toEqual([]);
    expect(ABILITY_DEFINITIONS).toEqual([]);
  });
});
