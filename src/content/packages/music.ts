import { z } from "zod";
import { HocpkgPortablePathSchema } from "./schema";
import { boundedContentJson } from "./json-budget";
import type { ExtensionResource, HocpkgResourceHandler } from "./resources";

const id = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/).max(80);
export const MusicPackageOrderSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/)).max(1024)
  .refine(value => new Set(value).size === value.length, "音乐包排序不得重复");
export const MusicResourceSchema = boundedContentJson(z.object({
  tracks: z.record(id, z.object({
    path: HocpkgPortablePathSchema.refine(path => /\.(?:ogg|opus|mp3|wav|m4a)$/i.test(path), "音乐必须是包内音频路径"),
    name: z.string().trim().min(1).max(120).optional()
  }).strict()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 256, "音乐曲目须为1至256首"),
  rules: z.array(z.object({
    id, scene: z.enum(["lobby", "match"]), track: id,
    priority: z.enum(["background", "override"]),
    transitionMs: z.number().int().min(0).max(10000).optional()
  }).strict()).max(256).default([])
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: "音乐规则 ID 重复" });
    ids.add(rule.id);
    if (!Object.hasOwn(value.tracks, rule.track)) ctx.addIssue({ code: "custom", path: ["rules", index, "track"], message: "音乐曲目不存在" });
  });
}));
export type MusicResource = z.infer<typeof MusicResourceSchema>;
export interface InstalledMusicResource {
  readonly packageId: string;
  readonly resourceId: string;
  readonly title: string;
  readonly tracks: Readonly<Record<string, { readonly url?: string; readonly name: string }>>;
  readonly rules: MusicResource["rules"];
}
export function createMusicResourceHandler(): HocpkgResourceHandler<MusicResource> {
  return { type: "presentation.music", apiVersions: [1], async parse(payload, context) {
    const music = MusicResourceSchema.parse(payload);
    for (const track of Object.values(music.tracks)) {
      if (!context.manifest.files.some(file => file.path === track.path && file.mediaType.startsWith("audio/"))) throw new Error(`音乐必须引用同包已声明的音频：${track.path}`);
      try { await context.resolvePath(track.path); } catch { /* An optional bad track falls through at runtime. */ }
    }
    return music;
  } };
}
export function prepareMusicResources(resources: readonly ExtensionResource[]): readonly InstalledMusicResource[] {
  return resources.map(resource => {
    const value = resource.value as MusicResource;
    return {
      packageId: resource.packageId, resourceId: resource.descriptor.id, title: resource.packageManifest.metadata.title,
      tracks: Object.fromEntries(Object.entries(value.tracks).map(([id, track]) => {
        let url: string | undefined;
        try { url = resource.resolvePath(track.path); } catch { /* Kept for diagnostics and request validation. */ }
        return [id, { url, name: track.name ?? id }];
      })), rules: value.rules
    };
  });
}
