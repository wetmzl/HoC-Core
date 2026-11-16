import { describe, expect, it } from "vitest";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { decodeText } from "../storage/encoding";
import { EMBEDDED_DEFAULT_PLAYLIST_ID } from "./embedded-default";
import { PlaylistStore, playlistDocument } from "./store";

const template = (ids: readonly string[], version = "1.0.0") => playlistDocument("官方播放集", ids.map(packageId => ({ packageId, version })), [...ids]);

describe("readonly official playlist ownership", () => {
  it("selects the fixed official identity only for a new playlist library", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const current = await store.synchronizeEmbeddedDefault(template(["example/one"]));
    expect(current.id).toBe(EMBEDDED_DEFAULT_PLAYLIST_ID);
    expect(await store.currentId()).toBe(current.id);
    expect(current.document).toEqual(template(["example/one"]));
    const library = JSON.parse(decodeText((await fileSystem.read("content/v1/playlists-a.json"))!));
    expect(library.formatVersion).toBe(2);
    expect(Object.keys(library.playlists[0]).sort()).toEqual(["document", "id"]);
    expect(await fileSystem.list("content/v1")).not.toContain("content/v1/embedded-default-a.json");
  });

  it("preserves a legacy current list and never mistakes a user-created matching title for ownership", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const legacy = await store.initialize([{ packageId: "old/hero" }], ["old/hero"]);
    const named = await store.save(template(["user/selection"]));
    await store.select(named.id);
    const official = await store.synchronizeEmbeddedDefault(template(["example/new"]));
    expect(official.id).toBe(EMBEDDED_DEFAULT_PLAYLIST_ID);
    expect(official.document.name).toBe("官方播放集（2）");
    expect(await store.currentId()).toBe(named.id);
    expect((await store.list()).find(entry => entry.id === legacy.id)).toEqual(legacy);
    expect((await store.list()).find(entry => entry.id === named.id)).toEqual(named);
  });

  it("replaces the official document exactly with each template, including removals and ordering", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    await store.synchronizeEmbeddedDefault(template(["example/one", "example/two"]));
    const next = template(["example/new", "example/one"], "2.0.0");
    expect((await store.synchronizeEmbeddedDefault(next)).document).toEqual(next);
    expect((await new PlaylistStore(fileSystem).synchronizeEmbeddedDefault(next)).document).toEqual(next);
  });

  it("rejects direct edits and deletion of the official entry without changing its document", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const official = await store.synchronizeEmbeddedDefault(template(["example/one"]));
    expect(() => store.rename(official.id, "改名")).toThrow("只读");
    expect(() => store.setMode(official.id, "incremental")).toThrow("只读");
    expect(() => store.remove(official.id)).toThrow("只读");
    await expect(store.updateCurrent(template([]))).rejects.toThrow("只读");
    expect(await store.list()).toEqual([official]);
    expect(await store.currentId()).toBe(official.id);
    const copy = await store.copy(official.id, true);
    expect(() => store.remove(official.id)).toThrow("只读");
    expect(await store.currentId()).toBe(copy.id);
  });

  it("copies and imports ordinary snapshots which remain editable and independent of official updates", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const official = await store.synchronizeEmbeddedDefault(template(["example/one"]));
    const copy = await store.copy(official.id, true);
    expect(copy.id).not.toBe(official.id);
    expect(copy.document.name).toBe("官方播放集（副本 1）");
    expect(await store.currentId()).toBe(copy.id);
    await store.rename(copy.id, "我的组合");
    await store.updateCurrent(template([]));
    await store.setMode(copy.id, "incremental");
    const [imported] = await store.importBatch([official.document]);
    const snapshot = (await store.list()).find(entry => entry.id === copy.id)!;
    await store.synchronizeEmbeddedDefault(template(["example/one", "example/new"]));
    expect((await store.list()).find(entry => entry.id === copy.id)).toEqual(snapshot);
    expect((await store.list()).find(entry => entry.id === imported!.id)).toEqual(imported);
    expect(await store.currentId()).toBe(copy.id);
    await store.select(official.id);
    await store.remove(copy.id);
    expect((await store.list()).find(entry => entry.id === copy.id)).toBeUndefined();
  });

  it("saves an official-name document as a unique ordinary copy instead of overwriting the official entry", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const official = await store.synchronizeEmbeddedDefault(template(["example/one"]));
    const first = await store.save(template(["user/first"]));
    const second = await store.save(template(["user/second"]));
    expect(first.id).not.toBe(official.id); expect(second.id).not.toBe(first.id);
    expect(first.document.name).toBe("官方播放集（副本 1）");
    expect(second.document.name).toBe("官方播放集（副本 2）");
    expect((await store.list()).find(entry => entry.id === official.id)).toEqual(official);
  });

  it("commits copy creation and current selection together, preserving both after a failed write", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const official = await store.synchronizeEmbeddedDefault(template(["example/one"]));
    fileSystem.failNext("write", /playlists-[ab]\.json$/, 1);
    await expect(store.copy(official.id, true)).rejects.toThrow("injected write failure");
    const reopened = new PlaylistStore(fileSystem);
    expect(await reopened.list()).toEqual([official]);
    expect(await reopened.currentId()).toBe(official.id);
    const copy = await reopened.copy(official.id, true);
    expect(await reopened.currentId()).toBe(copy.id);
    expect(await reopened.list()).toEqual([official, copy]);
  });

  it("keeps the previous selected library through a failed official update and retries", async () => {
    const { fileSystem } = new MemoryContentHostProvider(), store = new PlaylistStore(fileSystem);
    const official = await store.synchronizeEmbeddedDefault(template(["example/one"]));
    const copy = await store.copy(official.id, true);
    fileSystem.failNext("write", /playlists-[ab]\.json$/, 1);
    await expect(store.synchronizeEmbeddedDefault(template(["example/one", "example/new"]))).rejects.toThrow("injected write failure");
    const reopened = new PlaylistStore(fileSystem);
    expect(await reopened.list()).toEqual([official, copy]);
    expect(await reopened.currentId()).toBe(copy.id);
    const updated = await reopened.synchronizeEmbeddedDefault(template(["example/one", "example/new"]));
    expect(updated.document.packages).toHaveLength(2);
    expect(await reopened.currentId()).toBe(copy.id);
  });
});
