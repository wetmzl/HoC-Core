import { z } from "zod";
import { migratePlaylistLibrary } from "./migrations";
import { HocpkgSemverSchema } from "../packages/schema";
import { CONTENT_ROOT } from "../storage/catalog";
import type { ContentFileSystem } from "../storage/contracts";
import { decodeText, encodeText, sha256Json, stableJson } from "../storage/encoding";

const packageId = z.string().regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/);
const name = z.string().trim().max(80);
const packages = z.array(z.object({ packageId, version: HocpkgSemverSchema.optional() }).strict()).max(1000)
  .superRefine((entries, ctx) => {
    if (new Set(entries.map((entry) => entry.packageId)).size !== entries.length) {
      ctx.addIssue({ code: "custom", message: "播放集包含重复的内容包。" });
    }
  });

export const PlaylistDocumentSchema = z.object({
  format: z.literal("house-of-chances-playlist"),
  formatVersion: z.literal(2),
  name,
  packages,
  pluginOrder: z.array(packageId).max(1000).refine((ids) => new Set(ids).size === ids.length, "插件顺序包含重复内容包。")
}).strict();
export type PlaylistDocument = z.infer<typeof PlaylistDocumentSchema>;
export type PlaylistEntry = PlaylistDocument["packages"][number];
export interface SavedPlaylist { readonly id: string; readonly document: PlaylistDocument; }

const slots = [`${CONTENT_ROOT}/playlists-a.json`, `${CONTENT_ROOT}/playlists-b.json`] as const;
const bodySchema = z.object({ format: z.literal("house-of-chances-playlist-library"), formatVersion: z.literal(2), currentId: z.string().uuid().nullable(),
  generation: z.number().int().nonnegative(), state: z.enum(["prepared", "committed"]),
  playlists: z.array(z.object({ id: z.string().uuid(), document: PlaylistDocumentSchema }).strict()).superRefine((entries, ctx) => {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      new Set(entries.map((entry) => entry.document.name)).size !== entries.length) {
      ctx.addIssue({ code: "custom", message: "播放集库包含重复的 ID 或名称。" });
    }
  }) }).strict();
const envelopeSchema = bodySchema.extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) });
type Envelope = z.infer<typeof envelopeSchema>;

export function playlistDocument(nameValue: string, entries: readonly PlaylistEntry[], pluginOrder: readonly string[] = []): PlaylistDocument {
  return PlaylistDocumentSchema.parse({ format: "house-of-chances-playlist", formatVersion: 2, name: nameValue, packages: entries, pluginOrder });
}

export class PlaylistStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly fs: ContentFileSystem, private readonly fallbackOrder: readonly string[] = []) {}

  private async readSlots(): Promise<{ path: typeof slots[number]; envelope: Envelope }[]> {
    const found: { path: typeof slots[number]; envelope: Envelope }[] = [];
    let occupied = 0;
    for (const path of slots) {
      const bytes = await this.fs.read(path);
      if (!bytes) continue;
      occupied += 1;
      try {
        const raw = JSON.parse(decodeText(bytes));
        const { checksum, ...body } = raw;
        if (raw.state === "committed" && checksum === await sha256Json(body)) found.push({ path, envelope: envelopeSchema.parse(migratePlaylistLibrary(raw, this.fallbackOrder)) });
      } catch { /* The other committed slot may still be intact. */ }
    }
    // A first write may have stopped after its prepared slot; no library was committed yet.
    if (!found.length && occupied) {
      const prepared = await Promise.all(slots.map(async (path) => {
        const bytes = await this.fs.read(path);
        if (!bytes) return false;
        try {
          const envelope = envelopeSchema.parse(JSON.parse(decodeText(bytes)));
          const { checksum, ...body } = envelope;
          return envelope.state === "prepared" && checksum === await sha256Json(body);
        } catch { return false; }
      }));
      if (!prepared.some(Boolean) || occupied !== 1) throw new Error("播放集存储已损坏，未覆盖原有数据。");
    }
    return found.sort((a, b) => b.envelope.generation - a.envelope.generation);
  }

  async list(): Promise<readonly SavedPlaylist[]> {
    await this.queue.catch(() => undefined);
    return (await this.readSlots())[0]?.envelope.playlists ?? [];
  }

  private async write(path: typeof slots[number], body: z.infer<typeof bodySchema>): Promise<void> {
    const value = { ...body, checksum: await sha256Json(body) };
    await this.fs.write(path, encodeText(stableJson(value)));
    const stored = await this.fs.read(path);
    if (!stored || decodeText(stored) !== stableJson(value)) throw new Error("播放集写入复验失败。");
  }

  private async commit(next: readonly SavedPlaylist[], currentId: string | null): Promise<void> {
    const current = (await this.readSlots())[0];
    const first = current?.path === slots[0] ? slots[1] : slots[0];
    const second = first === slots[0] ? slots[1] : slots[0];
    const generation = current?.envelope.generation ?? 0;
    const body = (offset: number, state: "prepared" | "committed") => bodySchema.parse({
      format: "house-of-chances-playlist-library", formatVersion: 2, currentId, generation: generation + offset, state, playlists: next
    });
    await this.write(first, body(1, "prepared"));
    await this.write(second, body(2, "committed"));
    await this.write(first, body(3, "committed")).catch(() => undefined);
  }

  private mutate<T>(fn: (entries: readonly SavedPlaylist[], currentId: string | null) => { next: readonly SavedPlaylist[]; result: T; currentId?: string | null }): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const current = (await this.readSlots())[0]?.envelope;
      const { next, result, currentId } = fn(current?.playlists ?? [], current?.currentId ?? null);
      await this.commit(next, currentId === undefined ? current?.currentId ?? next[0]?.id ?? null : currentId);
      return result;
    });
    this.queue = operation;
    return operation;
  }

  save(document: PlaylistDocument): Promise<SavedPlaylist> {
    const parsed = PlaylistDocumentSchema.parse(document);
    return this.mutate((entries) => {
      const used = new Set(entries.map((entry) => entry.document.name));
      let title = parsed.name;
      if (!title) {
        let suffix = 1;
        while (used.has(`未命名播放集（${suffix}）`)) suffix += 1;
        title = `未命名播放集（${suffix}）`;
      }
      const existing = entries.find((entry) => entry.document.name === title);
      const saved = { id: existing?.id ?? crypto.randomUUID(), document: playlistDocument(title, parsed.packages, parsed.pluginOrder) };
      return { next: existing ? entries.map((entry) => entry.id === existing.id ? saved : entry) : [...entries, saved], result: saved };
    });
  }

  importBatch(documents: readonly PlaylistDocument[]): Promise<readonly SavedPlaylist[]> {
    if (!documents.length) throw new Error("没有可导入的播放集。");
    const parsed = documents.map((document) => PlaylistDocumentSchema.parse(document));
    return this.mutate((entries) => {
      const used = new Set(entries.map((entry) => entry.document.name));
      const imported = parsed.map((document) => {
        let title = document.name;
        if (!title) {
          let suffix = 1;
          while (used.has(`未命名播放集（${suffix}）`)) suffix += 1;
          title = `未命名播放集（${suffix}）`;
        } else if (used.has(title)) {
          let suffix = 1;
          const copyName = (index: number) => {
            const ending = `（副本 ${index}）`;
            return `${document.name.slice(0, 80 - ending.length)}${ending}`;
          };
          do { title = copyName(suffix++); } while (used.has(title));
        }
        used.add(title);
        return { id: crypto.randomUUID(), document: playlistDocument(title, document.packages, document.pluginOrder) };
      });
      return { next: [...entries, ...imported], result: imported };
    });
  }

  rename(id: string, value: string): Promise<SavedPlaylist> {
    const title = name.parse(value);
    if (!title) throw new Error("播放集名称不能为空。");
    return this.mutate((entries) => {
      const current = entries.find((entry) => entry.id === id);
      if (!current) throw new Error("播放集不存在。");
      if (entries.some((entry) => entry.id !== id && entry.document.name === title)) throw new Error("播放集名称已被占用。");
      const saved = { ...current, document: playlistDocument(title, current.document.packages, current.document.pluginOrder) };
      return { next: entries.map((entry) => entry.id === id ? saved : entry), result: saved };
    });
  }

  copy(id: string): Promise<SavedPlaylist> {
    return this.mutate((entries) => {
      const current = entries.find((entry) => entry.id === id);
      if (!current) throw new Error("播放集不存在。");
      const used = new Set(entries.map((entry) => entry.document.name));
      let suffix = 1;
      const makeTitle = (index: number) => {
        const ending = `（副本 ${index}）`;
        return `${current.document.name.slice(0, 80 - ending.length)}${ending}`;
      };
      let title = makeTitle(suffix);
      while (used.has(title)) title = makeTitle(++suffix);
      const saved = { id: crypto.randomUUID(), document: playlistDocument(title, current.document.packages, current.document.pluginOrder) };
      return { next: [...entries, saved], result: saved };
    });
  }


  async currentId(): Promise<string | null> {
    await this.queue.catch(() => undefined);
    return (await this.readSlots())[0]?.envelope.currentId ?? null;
  }

  initialize(entries: readonly PlaylistEntry[], pluginOrder: readonly string[]): Promise<SavedPlaylist> {
    return this.mutate((saved, currentId) => {
      const current = saved.find((item) => item.id === currentId);
      if (current) return { next: saved, result: current };
      let name = "默认播放集";
      for (let index = 2; saved.some((item) => item.document.name === name); index++) name = `默认播放集（${index}）`;
      const created = { id: crypto.randomUUID(), document: playlistDocument(name, entries, pluginOrder) };
      return { next: [...saved, created], currentId: created.id, result: created };
    });
  }

  select(id: string): Promise<SavedPlaylist> {
    return this.mutate((entries) => {
      const selected = entries.find((item) => item.id === id);
      if (!selected) throw new Error("播放集不存在。");
      return { next: entries, currentId: id, result: selected };
    });
  }

  updateCurrent(document: PlaylistDocument): Promise<SavedPlaylist> {
    const parsed = PlaylistDocumentSchema.parse(document);
    return this.mutate((entries, currentId) => {
      const current = entries.find((item) => item.id === currentId);
      if (!current) throw new Error("当前播放集不存在。");
      const updated = { ...current, document: playlistDocument(current.document.name, parsed.packages, parsed.pluginOrder) };
      return { next: entries.map((item) => item.id === current.id ? updated : item), result: updated };
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((entries, currentId) => {
      if (!entries.some((entry) => entry.id === id)) throw new Error("播放集不存在。");
      if (id === currentId) throw new Error("当前播放集不能删除，请先切换。");
      return { next: entries.filter((entry) => entry.id !== id), result: undefined };
    });
  }
}
