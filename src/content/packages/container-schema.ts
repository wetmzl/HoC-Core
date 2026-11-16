import { z } from "zod";
import { boundedContentJson } from "./json-budget";
import { HOCPKG_FORMAT, HOCPKG_FORMAT_VERSION, HocpkgDigestSchema, HocpkgPortablePathSchema, HocpkgSemverSchema } from "./schema";

const requiredText = z.string().min(1);
const strings = z.array(z.string()).max(4096);
const identity = z.object({
  authorId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  packageName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  version: HocpkgSemverSchema
}).passthrough();

/** Storage envelope only. Content contracts are checked when starting the game. */
export const HocpkgContainerManifestSchema = boundedContentJson(z.object({
  $schema: z.string().optional(),
  format: z.literal(HOCPKG_FORMAT),
  formatVersion: z.literal(HOCPKG_FORMAT_VERSION),
  identity,
  metadata: z.object({
    title: requiredText,
    license: z.string().optional(),
    description: z.string(),
    coverImage: HocpkgPortablePathSchema.optional(),
    tags: strings,
    creators: z.array(z.object({ displayName: z.string(), roles: strings, url: z.string().optional() }).passthrough()).max(4096)
  }).passthrough(),
  resources: z.array(z.object({
    id: requiredText, type: requiredText, apiVersion: z.number().int().positive(),
    entry: HocpkgPortablePathSchema, requires: strings
  }).passthrough()).min(1).max(4096),
  files: z.array(z.object({
    path: HocpkgPortablePathSchema,
    bytes: z.number().int().nonnegative(),
    sha256: HocpkgDigestSchema,
    mediaType: requiredText
  }).passthrough()).min(1).max(4096),
  extensions: z.record(z.string(), z.unknown())
}).passthrough().superRefine((manifest, ctx) => {
  const paths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: `文件路径重复：${file.path}` });
    paths.add(file.path);
  }
  for (const [index, resource] of manifest.resources.entries()) {
    if (!paths.has(resource.entry)) ctx.addIssue({ code: "custom", path: ["resources", index, "entry"], message: `资源入口未在 files 中声明：${resource.entry}` });
  }
  if (manifest.metadata.coverImage && !paths.has(manifest.metadata.coverImage)) {
    ctx.addIssue({ code: "custom", path: ["metadata", "coverImage"], message: "包封面未在 files 中声明" });
  }
}));
